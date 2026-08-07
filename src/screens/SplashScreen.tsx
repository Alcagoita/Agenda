/**
 * SplashScreen — KAN-151
 *
 * Brand moment + app data gate.
 *
 * Responsibilities:
 *   1. Play the animated wordmark (brus + custom-h SVG + amber dot + paint stroke loop)
 *   2. Resolve Firebase auth and pre-load all Today screen data into Zustand
 *   3. Exit cleanly during the stroke rest phase so Today renders instantly with no
 *      loading state of its own.
 *
 * Light mode only — no dark variant.
 * SPLASH_DUR_MS = 3000 exposed for easy timing tuning.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Image,
  LayoutChangeEvent,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useAuth } from '../hooks/useAuth';
import { useAppStore } from '../store/appStore';
import {
  backfillLearnedPlaceCounts,
  getCategories,
  getInboxUnreadCount,
  getPoiPreferencesMap,
  ensureCurrentDay,
  getTotalPoints,
  getTrips,
  getUser,
  getUserPreferences,
  loadLearnedKeywords,
} from '../services/firestore';
import { getIncomingSharedTasksCount } from '../services/sharing';
import { checkAndRunTripPreRefresh, getAreaDownloadPoiTypes } from '../services/tripDownload';
import { deleteExpiredTripPlaces, refreshHabitatCacheIfStale } from '../services/habitatCache';
import { getMallSnapshot } from '../services/mallSnapshots';
import { setHomeLocation } from '../services/home';
import { CLUSTER_LEISURE_TYPES } from '../types';
import { lightPalette } from '../theme/tokens';

// ─── Timing constants ─────────────────────────────────────────────────────────

export const SPLASH_DUR_MS = 3000;

const PAINT_DUR_MS      = Math.round(SPLASH_DUR_MS * 0.38); // 1140ms — 0-38%
const HOLD_DUR_MS       = Math.round(SPLASH_DUR_MS * 0.22); // 660ms  — 38-60%
const LIFT_DUR_MS       = Math.round(SPLASH_DUR_MS * 0.16); // 480ms  — 60-76%
const LIFT_START_MS     = PAINT_DUR_MS + HOLD_DUR_MS;       // 1800ms
const REST_START_MS     = LIFT_START_MS + LIFT_DUR_MS;      // 2280ms — 76-100%
const DOT_POP_START_MS  = Math.round(SPLASH_DUR_MS * 0.72); // 2160ms — 72%
const DOT_POP_DUR_MS    = Math.round(SPLASH_DUR_MS * 0.08); // 240ms  — 72-80%
const DOT_SETTLE_DUR_MS = Math.round(SPLASH_DUR_MS * 0.10); // 300ms  — 80-90%
const ENTRANCE_DUR_MS   = 650;
/** Maximum time to wait for a rest phase after data is ready before forcing exit. */
const MAX_WAIT_AFTER_READY_MS = 4_000;

/**
 * Absolute upper bound on boot. The KAN-146 rollover + Firestore fetch run
 * before `markReady`; if either stalls (offline, large batch write) the splash
 * would otherwise cycle forever. After this deadline we mark ready regardless —
 * the Today screen does its own fetch and shows an error/retry if needed.
 */
const BOOT_HARD_TIMEOUT_MS = 8_000;

// ─── Easings ──────────────────────────────────────────────────────────────────

const PAINT_EASING    = Easing.bezier(0.5, 0.05, 0.2, 1);
const LIFT_EASING     = Easing.bezier(0.4, 0.0,  0.6, 1);
const POP_IN_EASING   = Easing.bezier(0.2, 0.7,  0.3, 1);
const POP_OUT_EASING  = Easing.bezier(0.3, 0.6,  0.4, 1);
const ENTRANCE_EASING = Easing.bezier(0.2, 0.7,  0.3, 1);

// ─── Design tokens (light only) ───────────────────────────────────────────────

// Splash always renders in light mode — it appears before the user's theme
// preference loads, matching the native (light) launch screen. Sourced from
// lightPalette directly so it can't silently drift from the design tokens.
const SPLASH_BG     = lightPalette.bg;
const SPLASH_TEXT   = lightPalette.text;
const SPLASH_ACCENT = lightPalette.accent;

// ─── Layout ───────────────────────────────────────────────────────────────────
// The iOS launch screen places content at screen.height * 1/3 from the top.
// paddingBottom shifts the flex-center point upward to match that position.
const VERTICAL_OFFSET = 120;

// ─── Logo constants ───────────────────────────────────────────────────────────

const LOGO_SIZE = 62;
const DOT_DIAM  = Math.round(LOGO_SIZE * 0.115); // 7px

// ─── CustomH SVG ─────────────────────────────────────────────────────────────
// Identical paths to LoginScreen — the standard Geist "h" replaced by a glyph
// whose right leg lifts off the baseline, evoking a brush being raised.

function CustomH() {
  const sw = LOGO_SIZE * 0.153; // strokeWidth ≈ 9.5px
  return (
    <Svg
      width={LOGO_SIZE * 0.64}
      height={LOGO_SIZE}
      viewBox="0 0 72 100"
      style={{ overflow: 'visible', marginLeft: -(LOGO_SIZE * 0.085) }}>
      {/* Left stem */}
      <Path
        d="M 9 6 L 9 76"
        stroke={SPLASH_TEXT}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Shoulder + lifting right leg */}
      <Path
        d="M 9 40 C 9 30 18 24 30 24 C 42 24 49 31 49 42 L 49 68 C 49 74.5 53.5 77 60 74 C 64 72 66.5 68.5 68 64"
        stroke={SPLASH_TEXT}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

// ─── SplashScreen ─────────────────────────────────────────────────────────────

interface SplashScreenProps {
  onExit: () => void;
}

export default function SplashScreen({ onExit }: SplashScreenProps) {
  const { user, loading: authLoading } = useAuth();

  // Stable ref — timers capture this so they always call the latest onExit.
  const onExitRef = useRef(onExit);
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);

  // ── Reduced motion ─────────────────────────────────────────────────────────

  const [reducedMotion, setReducedMotion] = useState(false);

  // ── Stroke geometry (computed after wordmark layout is measured) ───────────

  type StrokeGeom = { fullW: number; h: number; left: number; top: number };
  const [strokeGeom, setStrokeGeom] = useState<StrokeGeom | null>(null);

  // ── Control refs ───────────────────────────────────────────────────────────

  const isReadyRef      = useRef(false);
  const navigatingRef   = useRef(false);
  const cycleStartedRef = useRef(false);
  const restTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Reanimated shared values ───────────────────────────────────────────────

  const wordmarkTY     = useSharedValue(14);
  const containerFullW = useSharedValue(0);
  const revealProgress = useSharedValue(0);
  const strokeOpacity  = useSharedValue(0);
  const strokeTX       = useSharedValue(0);
  const strokeTY       = useSharedValue(0);
  const strokeRot      = useSharedValue(0);
  const dotScale       = useSharedValue(1);

  // ── Animated styles ────────────────────────────────────────────────────────

  const wordmarkStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: wordmarkTY.value }],
  }));

  const strokeContainerStyle = useAnimatedStyle(() => ({
    opacity: strokeOpacity.value,
    transform: [
      { translateX: strokeTX.value },
      { translateY: strokeTY.value },
      { rotate: `${strokeRot.value}deg` },
    ],
  }));

  // L→R paint reveal via a composite transform ONLY — a background-coloured mask
  // that slides right to uncover the stroke. Never animate `width` (a layout
  // prop): on Fabric that forces a Yoga layout + ShadowTree commit every frame,
  // saturating the JS thread and freezing the app (KAN-157). translateX is a
  // GPU composite — zero layout, zero JS per frame.
  const revealMaskStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: revealProgress.value * containerFullW.value }],
  }));

  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: dotScale.value }],
  }));

  // ── Navigation ─────────────────────────────────────────────────────────────

  const doNavigate = useCallback(() => {
    if (navigatingRef.current) { return; }
    navigatingRef.current = true;
    if (restTimerRef.current  !== null) { clearTimeout(restTimerRef.current);  }
    if (abortTimerRef.current !== null) { clearTimeout(abortTimerRef.current); }
    onExitRef.current();
  }, []);

  // ── Mark data ready + start abort safety timer ────────────────────────────

  const markReady = useCallback(() => {
    if (isReadyRef.current) { return; }
    isReadyRef.current = true;
    abortTimerRef.current = setTimeout(doNavigate, MAX_WAIT_AFTER_READY_MS);
  }, [doNavigate]);

  // ── Animation cycle ────────────────────────────────────────────────────────

  const runCycle = useCallback(() => {
    if (navigatingRef.current) { return; }

    // Reset to start-of-cycle values
    revealProgress.value = 0;
    strokeOpacity.value  = 1;
    strokeTX.value       = 0;
    strokeTY.value       = 0;
    strokeRot.value      = 0;
    dotScale.value       = 1;

    // Phase 1 — Paint in (0 → 1140ms): reveal stroke left to right
    revealProgress.value = withTiming(1, {
      duration: PAINT_DUR_MS,
      easing:   PAINT_EASING,
    });

    // Phase 3 — Lift away (1800 → 2280ms): fade + translate + rotate
    strokeOpacity.value = withDelay(
      LIFT_START_MS,
      withTiming(0, { duration: LIFT_DUR_MS, easing: LIFT_EASING }),
    );
    strokeTX.value = withDelay(
      LIFT_START_MS,
      withTiming(18, { duration: LIFT_DUR_MS, easing: LIFT_EASING }),
    );
    strokeTY.value = withDelay(
      LIFT_START_MS,
      withTiming(-12, { duration: LIFT_DUR_MS, easing: LIFT_EASING }),
    );
    strokeRot.value = withDelay(
      LIFT_START_MS,
      withTiming(-2, { duration: LIFT_DUR_MS, easing: LIFT_EASING }),
    );

    // Dot pop (2160 → 2700ms): scale 1 → 1.5 → 1
    dotScale.value = withDelay(
      DOT_POP_START_MS,
      withSequence(
        withTiming(1.5, { duration: DOT_POP_DUR_MS,    easing: POP_IN_EASING  }),
        withTiming(1.0, { duration: DOT_SETTLE_DUR_MS, easing: POP_OUT_EASING }),
      ),
    );

    // Navigate at rest phase start (76%) if data is ready
    restTimerRef.current = setTimeout(() => {
      if (isReadyRef.current) {
        doNavigate();
      }
    }, REST_START_MS);

    // NOTE: run ONCE — do not self-reschedule. On Fabric, every animation frame
    // commits through the ShadowTree (Yoga + RawProps), so a perpetually looping
    // splash animation pegs the JS thread. While pegged, the boot promises and
    // `markReady`/`doNavigate` timers can't run — so the splash would loop
    // forever and the app would never appear (the KAN-146 rollover made boot slow
    // enough to fall into this deadlock). With a single cycle the thread frees
    // after ~3s; boot callbacks then run and exit is driven by `restTimerRef`
    // (fast path) or `markReady`'s abort timer (slow path). KAN-157 lesson:
    // never animate per frame longer than necessary on Fabric.
  }, [
    revealProgress, strokeOpacity, strokeTX, strokeTY, strokeRot, dotScale,
    doNavigate,
  ]);

  // ── Wordmark layout → stroke geometry → start cycle ───────────────────────

  const handleWordmarkLayout = useCallback((e: LayoutChangeEvent) => {
    if (cycleStartedRef.current || reducedMotion) { return; }

    const { width, height } = e.nativeEvent.layout;
    const fullW = width  * 1.40;
    const h     = fullW  * (283 / 829); // amber-stroke.png aspect ratio

    containerFullW.value = fullW;
    setStrokeGeom({
      fullW,
      h,
      left: -(width * 0.20),
      top:  height * 0.63 - h / 2, // translateY(-50%) at 63% height
    });

    cycleStartedRef.current = true;
    runCycle();
  }, [reducedMotion, containerFullW, runCycle]);

  // ── Entrance animation + reduced motion check ─────────────────────────────

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
      setReducedMotion(enabled);
      if (enabled) {
        wordmarkTY.value = 0;
      } else {
        wordmarkTY.value = withTiming(0, {
          duration: ENTRANCE_DUR_MS,
          easing:   ENTRANCE_EASING,
        });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Data loading ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (authLoading) { return; }

    let cancelled = false;

    if (!user) {
      setHomeLocation(null);
      markReady();
      return () => { cancelled = true; };
    }

    const uid = user.uid;
    // Rehydrate the POI inference learned layer (LLM/user-confirmed keywords)
    // from Firestore on boot (KAN-196). Non-fatal — inference falls back to the
    // seed dictionary if this fails. (Custom-category terms are rehydrated
    // separately by getCategories below.)
    loadLearnedKeywords(uid)
      .catch(err => console.warn('[SplashScreen] loadLearnedKeywords failed (non-critical)', err));
    // One-time migration (KAN-240) for users who brushed tasks before the
    // learnedPlaceCounts counter existed — no-ops after the first successful
    // run (gated by a flag on the user doc). Non-fatal: worst case is the
    // learned-places ranking is missing historical visits until next boot.
    backfillLearnedPlaceCounts(uid)
      .catch(err => console.warn('[SplashScreen] backfillLearnedPlaceCounts failed (non-critical)', err));
    // Resolve stale tasks into today's in-memory list before loading the
    // screen, but do not make splash navigation wait for their Firestore
    // write. ensureCurrentDay keeps the per-device local-day behaviour and
    // retries naturally on the next active/focus refresh if persistence fails.
    Promise.allSettled([
        ensureCurrentDay(uid).then(({ tasks, persistence }) => {
          persistence.catch(err => console.warn('[SplashScreen] current-day persistence failed (non-critical)', err));
          return tasks;
        }),
        getUser(uid),
        getUserPreferences(uid),
        getPoiPreferencesMap(uid),
        getCategories(uid),
        getTotalPoints(uid),
        getIncomingSharedTasksCount(uid),
        getInboxUnreadCount(uid),
        getTrips(uid),
        getMallSnapshot(uid),
      ])
      .then(([
        tasksResult,
        userDataResult,
        userPrefsResult,
        poiPrefsMapResult,
        categoriesResult,
        totalPointsResult,
        inboxCountResult,
        socialUnreadCountResult,
        tripsResult,
        mallSnapshotResult,
      ]) => {
        if (cancelled) { return; }

        if (tasksResult.status === 'rejected') { console.warn('[SplashScreen] ensureCurrentDay failed (non-critical)', tasksResult.reason); }
        if (userDataResult.status === 'rejected') { console.warn('[SplashScreen] getUser failed (non-critical)', userDataResult.reason); }
        if (userPrefsResult.status === 'rejected') { console.warn('[SplashScreen] getUserPreferences failed (non-critical)', userPrefsResult.reason); }
        if (poiPrefsMapResult.status === 'rejected') { console.warn('[SplashScreen] getPoiPreferencesMap failed (non-critical)', poiPrefsMapResult.reason); }
        if (categoriesResult.status === 'rejected') { console.warn('[SplashScreen] getCategories failed (non-critical)', categoriesResult.reason); }
        if (totalPointsResult.status === 'rejected') { console.warn('[SplashScreen] getTotalPoints failed (non-critical)', totalPointsResult.reason); }
        if (inboxCountResult.status === 'rejected') { console.warn('[SplashScreen] getIncomingSharedTasksCount failed (non-critical)', inboxCountResult.reason); }
        if (socialUnreadCountResult.status === 'rejected') { console.warn('[SplashScreen] getInboxUnreadCount failed (non-critical)', socialUnreadCountResult.reason); }
        if (tripsResult.status === 'rejected') { console.warn('[SplashScreen] getTrips failed (non-critical)', tripsResult.reason); }
        if (mallSnapshotResult.status === 'rejected') { console.warn('[SplashScreen] getMallSnapshot failed (non-critical)', mallSnapshotResult.reason); }

        const tasks = tasksResult.status === 'fulfilled' ? tasksResult.value : [];
        const userData = userDataResult.status === 'fulfilled' ? userDataResult.value : null;
        const userPrefs = userPrefsResult.status === 'fulfilled' ? userPrefsResult.value : {};
        const poiPrefsMap = poiPrefsMapResult.status === 'fulfilled' ? poiPrefsMapResult.value : {};
        const categories = categoriesResult.status === 'fulfilled' ? categoriesResult.value : [];
        const totalPoints = totalPointsResult.status === 'fulfilled' ? totalPointsResult.value : 0;
        const inboxCount = inboxCountResult.status === 'fulfilled' ? inboxCountResult.value : 0;
        const socialUnreadCount = socialUnreadCountResult.status === 'fulfilled' ? socialUnreadCountResult.value : 0;
        const trips = tripsResult.status === 'fulfilled' ? tripsResult.value : [];
        const mallSnapshot = mallSnapshotResult.status === 'fulfilled' ? mallSnapshotResult.value : null;
        setHomeLocation(userData?.home ?? null);

        useAppStore.getState().setBootData({
          ownerUid: uid,
          tasks,
          userData,
          customCategories: categories,
          totalPoints,
          inboxCount,
          socialUnreadCount,
          userPrefs,
          poiPrefsMap,
          trips,
          mallSnapshot,
        });
        markReady();

        // Trip areas (KAN-234): app is foreground-only (KAN-231), so the
        // day-before-departure refresh has no native scheduler to run on —
        // piggyback on this boot path instead, same "non-fatal, best effort,
        // once per boot" shape as rolloverIncompleteTasks above.
        checkAndRunTripPreRefresh(uid, trips)
          .catch(err => console.warn('[SplashScreen] checkAndRunTripPreRefresh failed (non-critical)', err));
        try { deleteExpiredTripPlaces(); } catch (err) { console.warn('[SplashScreen] deleteExpiredTripPlaces failed (non-critical)', err); }

        // Home anchor (KAN-247): a guaranteed prefetch point alongside the
        // opportunistic habitat pool — same "non-fatal, best effort, once per
        // boot" shape as the trip pre-refresh above. No-ops when unset.
        if (userData?.home) {
          const prefetchTypes = [...new Set([
            ...getAreaDownloadPoiTypes(), ...CLUSTER_LEISURE_TYPES,
          ])];
          refreshHabitatCacheIfStale(userData.home.lat, userData.home.lng, prefetchTypes)
            .catch(err => console.warn('[SplashScreen] home habitat prefetch failed (non-critical)', err));
        }
      })
      .catch(() => {
        if (cancelled) { return; }
        // Data failed — proceed anyway; Today screen will retry its own fetch.
        markReady();
      });
    return () => { cancelled = true; };
  }, [authLoading, user, markReady]);

  // ── Boot safety net ────────────────────────────────────────────────────────
  // Guarantee the splash exits even if rollover/fetch never resolves.
  useEffect(() => {
    const t = setTimeout(markReady, BOOT_HARD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [markReady]);

  // ── Timer cleanup ─────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
        if (restTimerRef.current  !== null) { clearTimeout(restTimerRef.current);  }
      if (abortTimerRef.current !== null) { clearTimeout(abortTimerRef.current); }
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={SPLASH_BG} />

      <Animated.View style={wordmarkStyle}>
        {/*
          Wordmark container — measured via onLayout.
          Dot and stroke are absolutely positioned relative to this view.
          alignSelf: 'flex-start' ensures the container hugs the wordmark
          width so the measured size equals the wordmark bounding box.
        */}
        <View
          onLayout={handleWordmarkLayout}
          style={styles.wordmarkContainer}
        >
          {/* "brus" + custom-h row */}
          <View style={styles.wordmarkRow}>
            <Text style={styles.brusText}>brus</Text>
            <CustomH />
          </View>

          {/* Amber dot — floats where the lifted h-leg points */}
          <Animated.View
            style={[styles.dot, dotStyle]}
            accessible={false}
          />

          {/* Paint stroke overlay — revealed left to right, then lifted away */}
          {strokeGeom !== null && !reducedMotion && (
            <Animated.View
              style={[
                strokeContainerStyle,
                {
                  position: 'absolute',
                  left:   strokeGeom.left,
                  top:    strokeGeom.top,
                  width:  strokeGeom.fullW,
                  height: strokeGeom.h,
                },
              ]}
              accessible={false}
              pointerEvents="none"
            >
              {/* Static full stroke, revealed L→R by a sliding bg-coloured mask.
                  overflow:hidden keeps the mask clipped to the stroke bounds. */}
              <View style={{ width: strokeGeom.fullW, height: strokeGeom.h, overflow: 'hidden' }}>
                <Image
                  source={require('../../assets/amber-stroke.png')}
                  style={{
                    width:  strokeGeom.fullW,
                    height: strokeGeom.h,
                    transform: [{ scaleY: 1.18 }],
                  }}
                  resizeMode="stretch"
                  accessible={false}
                />
                {/* Mask: covers the stroke at progress 0 (translateX 0), slides
                    fully off the right edge at progress 1 (translateX fullW). */}
                <Animated.View
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: SPLASH_BG },
                    revealMaskStyle,
                  ]}
                  pointerEvents="none"
                />
              </View>
            </Animated.View>
          )}
        </View>
      </Animated.View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    position:        'absolute',
    top:             0,
    left:            0,
    right:           0,
    bottom:          0,
    backgroundColor: SPLASH_BG,
    alignItems:      'center',
    justifyContent:  'center',
    paddingBottom:   VERTICAL_OFFSET,
    zIndex:          999,
  },
  wordmarkContainer: {
    alignSelf: 'flex-start',
  },
  wordmarkRow: {
    flexDirection: 'row',
    alignItems:    'flex-end',
  },
  brusText: {
    fontFamily:         'Geist-SemiBold',
    fontSize:           LOGO_SIZE,
    fontWeight:         '600',
    letterSpacing:      LOGO_SIZE * -0.06,
    lineHeight:         LOGO_SIZE * 1.1, // prevent clipping on Android
    color:              SPLASH_TEXT,
    includeFontPadding: false,
  },
  dot: {
    position:        'absolute',
    right:           -(LOGO_SIZE * 0.05),
    top:             LOGO_SIZE * 0.30,
    width:           DOT_DIAM,
    height:          DOT_DIAM,
    borderRadius:    DOT_DIAM / 2,
    backgroundColor: SPLASH_ACCENT,
  },
});
