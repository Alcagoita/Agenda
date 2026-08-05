// React 19 + react-test-renderer's uncaught-error reporting path calls
// window.dispatchEvent, which the RN Jest preset's global `window` doesn't
// implement — so a component that throws during render/layout-effect gets
// its real error masked by a second, unrelated "window.dispatchEvent is not
// a function" crash. A no-op keeps the real error visible instead.
if (typeof window !== 'undefined' && typeof window.dispatchEvent !== 'function') {
  window.dispatchEvent = () => true;
}

// Global RNFB mocks — @react-native-firebase/app has no usable Jest (node)
// environment: it either falls back to the 'firebase' web SDK's ESM build
// (which Jest can't parse) or tries to reach a native module that doesn't
// exist under Jest, depending on which sub-package loads it first. Any test
// file that pulls in the src/services/firestore barrel transitively requires
// @react-native-firebase/auth and @react-native-firebase/analytics, so both
// are mocked here once instead of in every test file.
//
// Individual test files can still override these with their own
// jest.mock('@react-native-firebase/auth', ...) calls when they need
// specific currentUser/analytics behavior — a local jest.mock() takes
// precedence over this file for that test file.

// Shared instance — @react-native-firebase/auth and its /lib/modular
// subpath both export getAuth, and the app imports from either depending
// on the call site. Delegating both mocks to one jest.fn() keeps auth
// state consistent regardless of which import path is used.
const mockGetAuth = jest.fn(() => ({ currentUser: null }));

jest.mock('@react-native-firebase/auth', () => ({
  getAuth: (...args) => mockGetAuth(...args),
  GoogleAuthProvider: { credential: jest.fn() },
  OAuthProvider: jest.fn().mockImplementation(() => ({ credential: jest.fn() })),
}));

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: (...args) => mockGetAuth(...args),
  connectAuthEmulator: jest.fn(),
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signOut: jest.fn(),
  signInWithCredential: jest.fn(),
  updateProfile: jest.fn(),
}));

jest.mock('@react-native-firebase/analytics', () => ({
  __esModule: true,
  default: jest.fn(() => ({ logEvent: jest.fn(() => Promise.resolve()) })),
}));

// @react-native-firebase/functions registers a native event emitter as an
// import side effect (before firebase.ts's own getFunctions() call ever
// runs), so any test file that transitively imports placesFunctions.ts,
// rewardFunctions.ts, or cloudflarePoiFunctions.ts without mocking that
// specific barrel module crashes here — same class of problem as auth
// above, just triggered by a different file. httpsCallable resolves to an
// empty object by default; tests that care about a specific response mock
// the relevant src/services/*Functions.ts barrel directly, same as today.
jest.mock('@react-native-firebase/functions', () => ({
  getFunctions: jest.fn(() => ({})),
  connectFunctionsEmulator: jest.fn(),
  httpsCallable: jest.fn(() => jest.fn().mockResolvedValue({ data: {} })),
}));

// src/services/firebase.ts is the central Firebase init point — it imports
// @react-native-firebase/app, /firestore, /messaging and /storage at its own
// module top-level (in addition to auth/functions, already mocked above), so
// any test file that reaches it (even transitively, e.g. via
// rewardFunctions.ts's `functionsService` import) needs all four mocked or
// it crashes the same way auth used to. Kept minimal — just enough for
// firebase.ts's own module-level calls (initializeFirestore, getFirestore,
// getApp, etc.) to run without throwing.
jest.mock('@react-native-firebase/app', () => ({
  getApp: jest.fn(() => ({})),
}));

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  initializeFirestore: jest.fn(),
  connectFirestoreEmulator: jest.fn(),
  collection: jest.fn(),
  getDocs: jest.fn().mockResolvedValue({ docs: [] }),
  query: jest.fn(),
  limit: jest.fn(),
  CACHE_SIZE_UNLIMITED: -1,
}));

jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: jest.fn(() => ({})),
}));

jest.mock('@react-native-firebase/storage', () => ({
  getStorage: jest.fn(() => ({})),
}));

jest.mock('@react-native-firebase/app-check', () => ({
  initializeAppCheck: jest.fn().mockResolvedValue(undefined),
  ReactNativeFirebaseAppCheckProvider: jest.fn().mockImplementation(() => ({
    configure: jest.fn(),
  })),
}));

// expo-sqlite ships an ESM build Jest's default transform can't parse
// ("Unexpected token 'export'"), and it's a native module besides — any test
// file whose import graph reaches reverseGeocodeCache.ts or habitatCache.ts
// (both SQLite-backed) crashes here unless mocked. A no-op stub is enough
// for files that don't care about DB behavior; files that DO
// (habitatCache.test.ts, reverseGeocode.test.ts) already define their own
// richer local jest.mock('expo-sqlite', ...), which takes precedence over
// this one, same as every other mock in this file.
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => ({
    execSync: jest.fn(),
    runSync: jest.fn(),
    getAllSync: jest.fn(() => []),
    getFirstSync: jest.fn(() => null),
    withTransactionSync: jest.fn((task) => task()),
  })),
}));

// @react-native-community/netinfo has no native module under Jest either —
// same story, different package. The library ships its own official Jest
// mock; many test files already wire it in individually
// (jest.mock('@react-native-community/netinfo', () => require('.../netinfo-mock'))),
// so this just closes the gap for files whose import graph reaches it
// (e.g. via tripDownload.ts) without expecting to.
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

