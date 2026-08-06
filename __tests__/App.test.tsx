/**
 * @format
 *
 * Smoke test — verifies the App component tree renders without throwing.
 * Mocks all external services and hooks so no real Firebase/native code loads.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock top-level hooks so Firebase is never initialised during the test.
jest.mock('../src/hooks/useAuth', () => ({
  useAuth: () => ({ user: null, initialising: false }),
}));

jest.mock('../src/hooks/useFCM', () => ({
  useFCM: () => {},
}));

jest.mock('../src/services/crashlytics', () => ({
  setCrashlyticsUser: jest.fn(),
  logBreadcrumb:      jest.fn(),
}));

// Mock the entire navigator so no screen-level Firebase calls happen.
jest.mock('../src/navigation/AppNavigator', () => {
  const { View } = require('react-native');
  return () => <View testID="app-navigator" />;
});

jest.mock('../src/navigation/navigationRef', () => ({
  navigationRef: { current: null },
  navigateTo:    jest.fn(),
}));

jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: jest.fn(),
  onMessage:    jest.fn(() => jest.fn()),
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    onForegroundEvent:   jest.fn(() => jest.fn()),
    onBackgroundEvent:   jest.fn(),
    displayNotification: jest.fn(),
    requestPermission:   jest.fn(),
  },
  EventType: { PRESS: 1, ACTION_PRESS: 2, DISMISSED: 3 },
}));

jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({ children }: { children: React.ReactNode }) => children,
  createNavigationContainerRef: () => ({ current: null, navigate: jest.fn() }),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({
    palette: { bg: '#fff', text: '#000', surface2: '#eee', line: '#ddd', accent: '#e8a86a', muted: '#999' },
    dark: false,
    setDark: jest.fn(),
  }),
}));

jest.mock('../src/components/ErrorBoundary', () => {
  const React = require('react');
  return ({ children }: { children: React.ReactNode }) => children;
});

jest.mock('../src/screens/LoginScreen', () => {
  const { View } = require('react-native');
  return () => <View testID="login-screen" />;
});

jest.mock('../src/screens/UsernameSetupScreen', () => {
  const { View } = require('react-native');
  return () => <View testID="username-setup-screen" />;
});

// OnboardingScreen and SplashScreen each have their own dedicated test file
// (OnboardingScreen.test.tsx, SplashScreen.test.tsx) — not under test here.
// Both transitively reach expo-location (via proximity.ts/geolocation.ts),
// an ESM native module Jest can't parse, so stub at the screen boundary
// rather than trying to mock every native module in between.
jest.mock('../src/screens/OnboardingScreen', () => {
  const { View } = require('react-native');
  return () => <View testID="onboarding-screen" />;
});
jest.mock('../src/screens/SplashScreen', () => {
  const { View } = require('react-native');
  return () => <View testID="splash-screen" />;
});

jest.mock('../src/services/firestore', () => ({
  getUser:               jest.fn().mockResolvedValue(null),
  markLastOpenedAt:      jest.fn().mockResolvedValue(undefined),
  setTaskDone:           jest.fn().mockResolvedValue(undefined),
  getUserPreferences:    jest.fn().mockResolvedValue({}),
  backfillUserDocument:  jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/sharing', () => ({
  subscribeToSharedTaskNotifications: jest.fn(() => jest.fn()),
}));

jest.mock('../src/services/appCheck', () => ({
  ensureAppCheckInitialized: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/achievements', () => ({
  migratePointsToAchievementDerived: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/notifications', () => ({
  EXIT_ACTION_MARK_DONE:      'MARK_DONE',
  registerExitPromptCategory: jest.fn().mockResolvedValue(undefined),
}));

// App.tsx imports these two directly (updateExitPromptPref /
// updateIndoorExitPromptPref) — both transitively reach expo-location, an
// ESM native module Jest can't parse.
jest.mock('../src/services/proximity', () => ({
  updateExitPromptPref: jest.fn(),
}));

jest.mock('../src/services/indoorProximity', () => ({
  updateIndoorExitPromptPref: jest.fn(),
}));

jest.mock('react-native-share-menu', () => ({
  __esModule: true,
  default: {
    getInitialShare: jest.fn(),
    addNewShareListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

// ─── Test ─────────────────────────────────────────────────────────────────────

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
