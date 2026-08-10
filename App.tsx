import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  StyleSheet,
  View,
  StatusBar,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { getMessaging, onMessage } from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import { useAuth } from './src/hooks/useAuth';
import { useFCM } from './src/hooks/useFCM';
import { logBreadcrumb } from './src/services/crashlytics';
import LoginScreen from './src/screens/LoginScreen';
import UsernameSetupScreen from './src/screens/UsernameSetupScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import Toast from './src/components/Toast';
import ErrorBoundary from './src/components/ErrorBoundary';
import { ensureAppCheckInitialized } from './src/services/appCheck';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import { navigationRef, navigateTo } from './src/navigation/navigationRef';
import type { RootStackParamList } from './src/navigation/AppNavigator';
import { getUser, markLastOpenedAt, setTaskDone, getUserPreferences, backfillUserDocument } from './src/services/firestore';
import SplashScreen from './src/screens/SplashScreen';
import { useAppStore } from './src/store/appStore';
import { migratePointsToAchievementDerived } from './src/services/achievements';
import { subscribeToSharedTaskNotifications } from './src/services/sharing';
import { EXIT_ACTION_MARK_DONE, registerExitPromptCategory, cancelRetiredNotifications } from './src/services/notifications';
import { updateExitPromptPref } from './src/services/proximity';
import { updateIndoorExitPromptPref } from './src/services/indoorProximity';
import notifeeApp, { AndroidImportance as AppAndroidImportance } from '@notifee/react-native';
import ShareMenu from 'react-native-share-menu';

// Deep link config (KAN-97 / KAN-87).
const LINKING_CONFIG = {
  prefixes: ['https://brushaway.app', 'brushaway://'],
  config: {
    screens: {
      PublicProfile:   'u/:username',
      SharedTaskInbox: 'inbox',
    } as Record<keyof RootStackParamList, unknown>,
  },
};

// Screens reachable from a social notification tap. Anything outside this set
// falls back to SharedTaskInbox so Firestore data can't drive navigation to
// unexpected screens.
const SOCIAL_NOTIF_SCREENS = new Set<keyof RootStackParamList>([
  'SharedTaskInbox',
  'ChallengeDetail',
  'PublicProfile',
  'SocialHub',
]);

const TRANSITION_MS = 220;

function AppShell() {
  const [splashDone, setSplashDone] = useState(false);

  const { user, loading } = useAuth();
  const { palette, dark } = useTheme();

  // Tracks the auth state actually rendered — lags behind `user` by one animation cycle
  // so the fade-out completes before we swap login ↔ app.
  const [displayUser, setDisplayUser] = useState(user);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  // True once the first onAuthStateChanged result has been applied. Used to
  // skip the fade animation on cold-start so a persisted session never flashes
  // the login screen before navigating to the app.
  const hasResolved = useRef(false);

  useEffect(() => {
    if (loading) return;

    // First resolution — apply immediately with no animation so a silently
    // restored session never shows the login screen, even for a frame.
    if (!hasResolved.current) {
      hasResolved.current = true;
      setDisplayUser(user);
      return;
    }

    if (user === displayUser) return;

    // Subsequent changes (explicit sign-in / sign-out) — animate the transition.
    Animated.timing(fadeAnim, { toValue: 0, duration: TRANSITION_MS, useNativeDriver: true })
      .start(() => {
        setDisplayUser(user);
        Animated.timing(fadeAnim, { toValue: 1, duration: TRANSITION_MS, useNativeDriver: true }).start();
      });
  }, [user, loading, displayUser]);

  // ── Username + onboarding check (KAN-97 / KAN-140) ──────────────────────
  // null = still loading, false = needs setup, true = ready
  const [hasUsername,    setHasUsername]    = useState<boolean | null>(null);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);

  useEffect(() => {
    if (!displayUser) { setHasUsername(null); setOnboardingDone(null); return; }

    // Fast path: SplashScreen already fetched the user doc — use it directly.
    const { bootData } = useAppStore.getState();
    if (bootData?.userData && bootData.ownerUid === displayUser.uid) {
      setHasUsername(!!bootData.userData.username);
      setOnboardingDone(!!bootData.userData.onboardingDone);
      return;
    }

    let cancelled = false;
    getUser(displayUser.uid)
      .then(userData => {
        if (!cancelled) {
          setHasUsername(!!userData?.username);
          setOnboardingDone(!!userData?.onboardingDone);
        }
      })
      .catch(() => {
        if (!cancelled) { setHasUsername(false); setOnboardingDone(false); }
      });
    return () => { cancelled = true; };
  }, [displayUser]);

  // KAN-129: recompute totalPoints from achievements map on every login.
  // Fixes legacy accounts that accumulated per-task points before KAN-129.
  useEffect(() => {
    if (!displayUser) { return; }
    migratePointsToAchievementDerived(displayUser.uid).catch(err =>
      console.warn('[App] migratePointsToAchievementDerived failed (non-critical)', err),
    );
    backfillUserDocument(displayUser.uid, displayUser.email ?? null, displayUser.displayName ?? null).catch(err =>
      console.warn('[App] backfillUserDocument failed (non-critical)', err),
    );
  }, [displayUser]);

  // ── Shared-task notification subscription (KAN-87) ───────────────────────
  // Fires a local notifee notification when a new pendingNotification arrives.
  // Subscribe to all social pending notifications (shared tasks, challenges, follows).
  // data.screen is set per-type at write time so deep-links route correctly.
  useEffect(() => {
    if (!displayUser) { return; }
    const uid = displayUser.uid;
    return subscribeToSharedTaskNotifications(uid, async n => {
      try {
        await notifeeApp.createChannel({
          id: 'social', name: 'Social', importance: AppAndroidImportance.HIGH,
        });
        const rawScreen = (n.data as Record<string, string> | undefined)?.screen;
        const screen: keyof RootStackParamList =
          rawScreen && SOCIAL_NOTIF_SCREENS.has(rawScreen as keyof RootStackParamList)
            ? (rawScreen as keyof RootStackParamList)
            : 'SharedTaskInbox';
        await notifeeApp.displayNotification({
          title: n.title,
          body:  n.body,
          data:  { ...n.data, screen },
          android: { channelId: 'social', importance: AppAndroidImportance.HIGH, pressAction: { id: 'default' } },
        });
      } catch (e) {
        console.warn('[AppShell] social notification failed', e);
      }
    });
  }, [displayUser]);

  // Persist the FCM device token whenever a user is signed in.
  useFCM(user?.uid ?? null);

  // Log a Crashlytics breadcrumb on auth changes. User identifier is set in useAuth.
  useEffect(() => {
    if (!loading) {
      logBreadcrumb(user ? 'User signed in' : 'User signed out');
    }
  }, [user, loading]);

  // Foreground FCM handler — show an Alert while the app is active.
  useEffect(() => {
    const unsubscribe = onMessage(getMessaging(), async remoteMessage => {
      const title = remoteMessage.notification?.title ?? 'New notification';
      const body = remoteMessage.notification?.body ?? '';
      Alert.alert(title, body);
    });
    return unsubscribe;
  }, []);

  // Notifee foreground press + action handler (KAN-28 / KAN-103 / KAN-119).
  // Navigates to the screen specified in data.screen, forwarding any extra
  // params (e.g. challengeId for ChallengeDetail).
  // Also handles the "Yes, brushed ✓" quick-action from the exit prompt.
  useEffect(() => {
    return notifee.onForegroundEvent(({ type, detail }) => {
      const data = detail.notification?.data ?? {};
      if (type === EventType.ACTION_PRESS) {
        // Exit prompt quick-action: mark task done directly from notification.
        if (detail.pressAction?.id === EXIT_ACTION_MARK_DONE && data.taskId && displayUser) {
          setTaskDone(displayUser.uid, data.taskId as string, true).catch(err =>
            console.warn('[App] exit action: failed to mark task done', err),
          );
        }
        return;
      }
      if (type === EventType.PRESS) {
        const screen = (data.screen as keyof RootStackParamList) ?? 'Today';
        const params = data.challengeId
          ? { challengeId: data.challengeId as string }
          : data.achievementId
            ? { achievementId: data.achievementId as string }
            : undefined;
        navigateTo(screen, params as any);
      }
    });
  }, [displayUser]);

  // Fetch exitPrompt preference once on login and propagate to proximity engines.
  useEffect(() => {
    if (!displayUser) { return; }
    let cancelled = false;
    const activeUid = displayUser.uid;
    getUserPreferences(activeUid).then(prefs => {
      if (cancelled) { return; }
      const enabled = prefs.exitPrompt ?? true;
      updateExitPromptPref(enabled);
      updateIndoorExitPromptPref(enabled);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [displayUser]);

  // Register iOS notification categories once at startup (KAN-119).
  // Idempotent — safe to call on every launch. Must run before any exit prompt fires.
  useEffect(() => {
    registerExitPromptCategory().catch(err =>
      console.warn('[App] registerExitPromptCategory failed', err),
    );
  }, []);

  // KAN-303: cancel any streak / weekly recap notifications still scheduled
  // on-device for users who had those (now-removed) types enabled, so nothing
  // keeps firing after the channels were cut. Idempotent, best-effort.
  useEffect(() => {
    cancelRetiredNotifications().catch(err =>
      console.warn('[App] cancelRetiredNotifications failed', err),
    );
  }, []);

  // Initial notification handler (KAN-28 / KAN-103).
  useEffect(() => {
    notifee.getInitialNotification().then(initial => {
      if (initial?.notification?.data?.screen) {
        const data   = initial.notification.data;
        const screen = data.screen as keyof RootStackParamList;
        const params = data.challengeId
          ? { challengeId: data.challengeId as string }
          : data.achievementId
            ? { achievementId: data.achievementId as string }
            : undefined;
        setTimeout(() => navigateTo(screen, params as any), 300);
      }
    });
  }, []);

  // Stamp lastOpenedAt on every foreground event (KAN-124 dependency).
  // Debounced to 10s to prevent rapid double-fires from Android AppState on launch.
  const lastOpenedStampRef = useRef<number>(0);
  useEffect(() => {
    if (!displayUser) {
      lastOpenedStampRef.current = 0;
      return;
    }
    const uid = displayUser.uid;
    const stamp = () => {
      const now = Date.now();
      if (now - lastOpenedStampRef.current < 10_000) { return; }
      lastOpenedStampRef.current = now;
      markLastOpenedAt(uid).catch(() => {});
    };
    stamp();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { stamp(); }
    });
    return () => sub.remove();
  }, [displayUser]);

  // ── Android Share Intent (KAN-90) ────────────────────────────────────────
  // Only active once the user is fully logged in and the navigation container
  // is ready (displayUser set, username confirmed). This ensures navigateTo()
  // has a ready NavigationContainer to dispatch to.
  useEffect(() => {
    if (!displayUser || hasUsername !== true) { return; }

    type SharedItem = { mimeType: string; data: string };

    const handleShare = (item: SharedItem | null) => {
      if (!item) { return; }
      const text = typeof item.data === 'string' ? item.data.trim() : '';
      if (!text || item.mimeType !== 'text/plain') { return; }
      // Small delay so the NavigationContainer finishes mounting on cold-start.
      setTimeout(() => navigateTo('ShareReceive', { sharedText: text }), 300);
    };

    // Handles the case where the app was launched via a share intent.
    ShareMenu.getInitialShare(handleShare);

    // Handles the case where a share arrives while the app is already open.
    const sub = ShareMenu.addNewShareListener(handleShare);
    return () => sub.remove();
  }, [displayUser, hasUsername]);

  // Show SplashScreen until auth + Today data are pre-loaded.
  // All hooks above still run normally; only the rendered UI changes.
  if (!splashDone) {
    return <SplashScreen onExit={() => setSplashDone(true)} />;
  }

  if (loading) {
    return (
      <View style={[styles.splash, { backgroundColor: palette.bg }]}>
        <ActivityIndicator size="large" color={palette.accent} />
      </View>
    );
  }

  return (
    <>
      <StatusBar
        barStyle={dark ? 'light-content' : 'dark-content'}
        backgroundColor={palette.bg}
      />
      <Toast />
      <Animated.View style={[styles.fill, { opacity: fadeAnim }]}>
        {displayUser ? (
          hasUsername === null || onboardingDone === null ? (
            // Still resolving user state — hold on the spinner.
            <View style={[styles.splash, { backgroundColor: palette.bg }]}>
              <ActivityIndicator size="large" color={palette.accent} />
            </View>
          ) : !hasUsername ? (
            // New user (or user without a username) — collect it before entering the app.
            <UsernameSetupScreen onComplete={() => setHasUsername(true)} />
          ) : !onboardingDone ? (
            // First-run: guided onboarding before landing on Today (KAN-140).
            <OnboardingScreen
              uid={displayUser.uid}
              onComplete={() => setOnboardingDone(true)}
            />
          ) : (
            <NavigationContainer ref={navigationRef} linking={LINKING_CONFIG}>
              <AppNavigator />
            </NavigationContainer>
          )
        ) : (
          <LoginScreen />
        )}
      </Animated.View>
    </>
  );
}

export default function App() {
  useEffect(() => {
    ensureAppCheckInitialized()
      .catch(error => {
        console.warn('[AppCheck] initialization failed', error);
      });
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppShell />
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8f9fb',
  },
  fill: {
    flex: 1,
  },
});
