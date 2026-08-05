/**
 * Unit tests for the logout() function — KAN-20
 *
 * Covers:
 *   - resetProximityState is called before signOut
 *   - firebaseSignOut is called
 *   - Rejects if firebaseSignOut throws
 */

import { logout } from '../../src/services/auth';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockResetProximityState = jest.fn();
const mockFirebaseSignOut     = jest.fn();

// Mock the proximity module (dynamic import inside logout())
jest.mock('../../src/services/proximity', () => ({
  resetProximityState: (...args: unknown[]) => mockResetProximityState(...args),
}));

// Mock Firebase Auth — signOut is the bare `signOut` export from auth/lib/modular
jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth:      () => ({}),
  signOut:      (...args: unknown[]) => mockFirebaseSignOut(...args),
  // other exports not needed for these tests
  signInWithEmailAndPassword:    jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  GoogleAuthProvider:            { credential: jest.fn() },
  OAuthProvider:                 jest.fn(),
  signInWithCredential:          jest.fn(),
}));

// Stub out native modules pulled in by auth.ts at module load
jest.mock('@react-native-firebase/auth', () => ({}));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(), signIn: jest.fn() },
}));
jest.mock('@invertase/react-native-apple-authentication', () => ({
  appleAuth: { performRequest: jest.fn(), Operation: {}, Scope: {} },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockFirebaseSignOut.mockResolvedValue(undefined);
});

describe('logout()', () => {
  it('calls resetProximityState', async () => {
    await logout();
    expect(mockResetProximityState).toHaveBeenCalledTimes(1);
  });

  it('calls firebaseSignOut', async () => {
    await logout();
    expect(mockFirebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('calls resetProximityState before firebaseSignOut', async () => {
    const order: string[] = [];
    mockResetProximityState.mockImplementation(() => order.push('stop'));
    mockFirebaseSignOut.mockImplementation(async () => order.push('signOut'));

    await logout();

    expect(order).toEqual(['stop', 'signOut']);
  });

  it('rejects if firebaseSignOut throws', async () => {
    mockFirebaseSignOut.mockRejectedValueOnce(new Error('network error'));
    await expect(logout()).rejects.toThrow('network error');
  });
});
