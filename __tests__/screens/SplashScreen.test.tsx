/**
 * SplashScreen unit tests — KAN-151
 *
 * Tests focus on the data-loading and store-population logic.
 * The Reanimated animation cycle is mocked (it cannot run in Jest).
 */

jest.mock('react-native-reanimated', () =>
  require('react-native-reanimated/mock'),
);

jest.mock('../../src/hooks/useAuth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../src/services/firestore', () => ({
  getTasksForDate:            jest.fn(),
  getUser:                    jest.fn(),
  getUserPreferences:         jest.fn(),
  getPoiPreferencesMap:       jest.fn(),
  getCategories:              jest.fn(),
  getTotalPoints:             jest.fn(),
  getInboxUnreadCount:        jest.fn(),
  getTrips:                   jest.fn(),
  loadLearnedKeywords:        jest.fn(),
  rolloverIncompleteTasks:    jest.fn(),
  backfillLearnedPlaceCounts: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/sharing', () => ({
  getIncomingSharedTasksCount: jest.fn(),
}));

const mockCheckAndRunTripPreRefresh = jest.fn();
jest.mock('../../src/services/tripDownload', () => ({
  checkAndRunTripPreRefresh: (...args: unknown[]) => mockCheckAndRunTripPreRefresh(...args),
  // getAreaDownloadPoiTypes is a pure function (ALL_POI_TYPES ∪
  // SUPPORTED_GOOGLE_PLACE_TYPES) — use the real one rather than reinventing
  // its output here, so this test doesn't drift from it independently.
  getAreaDownloadPoiTypes: jest.requireActual('../../src/services/tripDownload').getAreaDownloadPoiTypes,
}));

const mockDeleteExpiredTripPlaces = jest.fn();
const mockRefreshHabitatCacheIfStale = jest.fn();
jest.mock('../../src/services/habitatCache', () => ({
  deleteExpiredTripPlaces: (...args: unknown[]) => mockDeleteExpiredTripPlaces(...args),
  refreshHabitatCacheIfStale: (...args: unknown[]) => mockRefreshHabitatCacheIfStale(...args),
}));

const mockGetMallSnapshot = jest.fn();
jest.mock('../../src/services/mallSnapshots', () => ({
  getMallSnapshot: (...args: unknown[]) => mockGetMallSnapshot(...args),
}));

const mockSetHomeLocation = jest.fn();
jest.mock('../../src/services/home', () => ({
  setHomeLocation: (...args: unknown[]) => mockSetHomeLocation(...args),
}));

jest.mock('../../src/utils/date', () => ({
  todayISO: () => '2026-06-15',
}));

jest.mock('react-native-svg', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children }: any) => React.createElement('svg', null, children),
    Path: () => null,
  };
});

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { useAuth } from '../../src/hooks/useAuth';
import {
  getTasksForDate,
  getUser,
  getUserPreferences,
  getPoiPreferencesMap,
  getCategories,
  getTotalPoints,
  getInboxUnreadCount,
  getTrips,
  loadLearnedKeywords,
  rolloverIncompleteTasks,
} from '../../src/services/firestore';
import { getIncomingSharedTasksCount } from '../../src/services/sharing';
import { useAppStore } from '../../src/store/appStore';
import SplashScreen from '../../src/screens/SplashScreen';

const mockUseAuth = useAuth as jest.Mock;
const mockGetTasksForDate      = getTasksForDate      as jest.Mock;
const mockGetUser              = getUser              as jest.Mock;
const mockGetUserPreferences   = getUserPreferences   as jest.Mock;
const mockGetPoiPreferencesMap = getPoiPreferencesMap as jest.Mock;
const mockGetCategories        = getCategories        as jest.Mock;
const mockGetTotalPoints       = getTotalPoints       as jest.Mock;
const mockGetIncomingCount     = getIncomingSharedTasksCount as jest.Mock;
const mockGetInboxUnreadCount  = getInboxUnreadCount  as jest.Mock;
const mockGetTrips             = getTrips             as jest.Mock;
const mockLoadLearnedKeywords  = loadLearnedKeywords  as jest.Mock;
const mockRolloverIncompleteTasks = rolloverIncompleteTasks as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  useAppStore.setState({ bootData: null });

  mockGetTasksForDate.mockResolvedValue([]);
  mockGetUser.mockResolvedValue({ uid: 'u1', username: 'alice', onboardingDone: true });
  mockGetUserPreferences.mockResolvedValue({});
  mockGetPoiPreferencesMap.mockResolvedValue({});
  mockGetCategories.mockResolvedValue([]);
  mockGetTotalPoints.mockResolvedValue(5);
  mockGetIncomingCount.mockResolvedValue(2);
  mockGetInboxUnreadCount.mockResolvedValue(0);
  mockGetTrips.mockResolvedValue([]);
  mockGetMallSnapshot.mockResolvedValue(null);
  mockLoadLearnedKeywords.mockResolvedValue(undefined);
  mockRolloverIncompleteTasks.mockResolvedValue(undefined);
  mockCheckAndRunTripPreRefresh.mockResolvedValue(undefined);
  mockDeleteExpiredTripPlaces.mockReturnValue(undefined);
  mockRefreshHabitatCacheIfStale.mockResolvedValue(undefined);
  mockSetHomeLocation.mockClear();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('SplashScreen', () => {
  describe('when user is authenticated', () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        user:    { uid: 'u1' },
        loading: false,
      });
    });

    it('populates the Zustand store with all 7 Firestore responses', async () => {
      const onExit = jest.fn();
      render(<SplashScreen onExit={onExit} />);

      await act(async () => { await Promise.resolve(); });

      const boot = useAppStore.getState().bootData;
      expect(boot).not.toBeNull();
      expect(boot?.ownerUid).toBe('u1');
      expect(boot?.totalPoints).toBe(5);
      expect(boot?.inboxCount).toBe(2);
      expect(boot?.userData?.username).toBe('alice');
    });

    it('fetches tasks for today\'s date', async () => {
      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); });

      expect(mockGetTasksForDate).toHaveBeenCalledWith('u1', '2026-06-15');
    });

    it('rolls over incomplete tasks before fetching today\'s task list (KAN-146)', async () => {
      const callOrder: string[] = [];
      mockRolloverIncompleteTasks.mockImplementation(async () => { callOrder.push('rollover'); });
      mockGetTasksForDate.mockImplementation(async () => { callOrder.push('getTasksForDate'); return []; });

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(mockRolloverIncompleteTasks).toHaveBeenCalledWith('u1');
      expect(callOrder).toEqual(['rollover', 'getTasksForDate']);
    });

    it('still loads today\'s data when rollover fails (non-fatal)', async () => {
      mockRolloverIncompleteTasks.mockRejectedValue(new Error('rollover boom'));

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(mockGetTasksForDate).toHaveBeenCalledWith('u1', '2026-06-15');
      expect(useAppStore.getState().bootData).not.toBeNull();
    });

    it('stores partial boot data when an auxiliary offline read fails', async () => {
      mockGetTasksForDate.mockResolvedValue([{ id: 'task-1', title: 'Cached', category: 'errands', done: false, date: '2026-06-15', createdAt: {} }]);
      mockGetCategories.mockRejectedValue(new Error('offline'));

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(useAppStore.getState().bootData?.tasks).toEqual([
        { id: 'task-1', title: 'Cached', category: 'errands', done: false, date: '2026-06-15', createdAt: {} },
      ]);
      expect(useAppStore.getState().bootData?.customCategories).toEqual([]);
    });

    it('calls onExit after the abort timer when rest phase is not reached', async () => {
      const onExit = jest.fn();
      render(<SplashScreen onExit={onExit} />);

      await act(async () => { await Promise.resolve(); });

      // Abort timer fires 4 s after data is ready
      act(() => { jest.advanceTimersByTime(4_100); });
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('stores boot data even when all services succeed with empty results', async () => {
      mockGetTotalPoints.mockResolvedValue(0);
      mockGetIncomingCount.mockResolvedValue(0);

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); });

      expect(useAppStore.getState().bootData?.totalPoints).toBe(0);
    });

    // ── Trip areas boot wiring (KAN-234) ──
    it('stores trips in boot data and runs the pre-refresh check with the custom-category POI union', async () => {
      const trip = {
        id: 'trip-1', destination: 'Faro', placeRef: 'p1', centerLat: 1, centerLng: 2,
        startDate: '2026-06-20', endDate: '2026-06-25', areaRadius: 15_000,
        cacheAreaId: 'ta_1', expiresAt: 0, createdAt: {},
      };
      mockGetTrips.mockResolvedValue([trip]);
      mockGetCategories.mockResolvedValue([{ id: 'c1', name: 'Custom', poi: 'library' }]);

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(useAppStore.getState().bootData?.trips).toEqual([trip]);
      expect(mockCheckAndRunTripPreRefresh).toHaveBeenCalledWith('u1', [trip]);
      expect(mockDeleteExpiredTripPlaces).toHaveBeenCalled();
    });

    it('still marks the store ready when checkAndRunTripPreRefresh fails (non-fatal)', async () => {
      mockCheckAndRunTripPreRefresh.mockRejectedValue(new Error('offline'));

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(useAppStore.getState().bootData).not.toBeNull();
    });

    // ── Mall snapshot boot wiring (KAN-237) ──
    it('stores the mall snapshot in boot data when one exists', async () => {
      const snapshot = {
        placeId: 'mall-1', name: 'Test Mall', centerLat: 1, centerLng: 2, radius: 300,
        cacheAreaId: 'mall_snapshot', expiresAt: 0, createdAt: {},
      };
      mockGetMallSnapshot.mockResolvedValue(snapshot);

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(useAppStore.getState().bootData?.mallSnapshot).toEqual(snapshot);
    });

    it('stores a null mall snapshot when the user has none', async () => {
      mockGetMallSnapshot.mockResolvedValue(null);

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(useAppStore.getState().bootData?.mallSnapshot).toBeNull();
    });

    // ── Home anchor habitat prefetch (KAN-247) ──
    describe('home anchor habitat prefetch', () => {
      it('feeds home.ts during boot before exiting so Lantern never sees home as unset (KAN-307)', async () => {
        const home = { address: '221B Baker Street', lat: 51.5, lng: -0.1 };
        const onExit = jest.fn();
        mockGetUser.mockResolvedValue({
          uid: 'u1', username: 'alice', onboardingDone: true, home,
        });

        render(<SplashScreen onExit={onExit} />);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        act(() => { jest.advanceTimersByTime(4_100); });

        expect(mockSetHomeLocation).toHaveBeenCalledWith(home);
        expect(onExit).toHaveBeenCalledTimes(1);
        expect(mockSetHomeLocation.mock.invocationCallOrder[0]).toBeLessThan(
          onExit.mock.invocationCallOrder[0],
        );
      });

      it('prefetches the habitat cache around home when a home anchor is set', async () => {
        mockGetUser.mockResolvedValue({
          uid: 'u1', username: 'alice', onboardingDone: true,
          home: { address: '221B Baker Street', lat: 51.5, lng: -0.1 },
        });
        mockGetCategories.mockResolvedValue([{ id: 'c1', name: 'Custom', poi: 'library' }]);

        render(<SplashScreen onExit={jest.fn()} />);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(mockRefreshHabitatCacheIfStale).toHaveBeenCalledTimes(1);
        const [lat, lng, prefetchTypes] = mockRefreshHabitatCacheIfStale.mock.calls[0];
        expect(lat).toBe(51.5);
        expect(lng).toBe(-0.1);
        expect(prefetchTypes).toEqual(expect.arrayContaining(['library']));
      });

      it('does not prefetch when no home anchor is set', async () => {
        render(<SplashScreen onExit={jest.fn()} />);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(mockRefreshHabitatCacheIfStale).not.toHaveBeenCalled();
      });

      it('still marks the store ready when the home prefetch fails (non-fatal)', async () => {
        mockGetUser.mockResolvedValue({
          uid: 'u1', username: 'alice', onboardingDone: true,
          home: { address: '221B Baker Street', lat: 51.5, lng: -0.1 },
        });
        mockRefreshHabitatCacheIfStale.mockRejectedValue(new Error('offline'));

        render(<SplashScreen onExit={jest.fn()} />);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(useAppStore.getState().bootData).not.toBeNull();
      });
    });
  });

  describe('when user is not authenticated', () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({ user: null, loading: false });
    });

    it('does not call any Firestore service', async () => {
      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); });

      expect(mockGetTasksForDate).not.toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockGetUserPreferences).not.toHaveBeenCalled();
      expect(mockGetPoiPreferencesMap).not.toHaveBeenCalled();
      expect(mockGetCategories).not.toHaveBeenCalled();
      expect(mockGetTotalPoints).not.toHaveBeenCalled();
      expect(mockGetIncomingCount).not.toHaveBeenCalled();
      expect(mockGetInboxUnreadCount).not.toHaveBeenCalled();
      expect(mockGetTrips).not.toHaveBeenCalled();
      expect(mockGetMallSnapshot).not.toHaveBeenCalled();
      expect(mockLoadLearnedKeywords).not.toHaveBeenCalled();
      expect(mockRolloverIncompleteTasks).not.toHaveBeenCalled();
      expect(mockCheckAndRunTripPreRefresh).not.toHaveBeenCalled();
      expect(mockRefreshHabitatCacheIfStale).not.toHaveBeenCalled();
    });

    it('does not populate the store', async () => {
      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); });

      expect(useAppStore.getState().bootData).toBeNull();
    });

    it('clears the in-memory home anchor', async () => {
      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); });

      expect(mockSetHomeLocation).toHaveBeenCalledWith(null);
    });

    it('calls onExit after the abort timer', async () => {
      const onExit = jest.fn();
      render(<SplashScreen onExit={onExit} />);

      await act(async () => { await Promise.resolve(); });
      act(() => { jest.advanceTimersByTime(4_100); });

      expect(onExit).toHaveBeenCalledTimes(1);
    });
  });

  describe('when auth is still loading', () => {
    it('does not call any Firestore service while loading', async () => {
      mockUseAuth.mockReturnValue({ user: null, loading: true });

      render(<SplashScreen onExit={jest.fn()} />);
      await act(async () => { await Promise.resolve(); });

      expect(mockGetTasksForDate).not.toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockGetUserPreferences).not.toHaveBeenCalled();
      expect(mockGetPoiPreferencesMap).not.toHaveBeenCalled();
      expect(mockGetCategories).not.toHaveBeenCalled();
      expect(mockGetTotalPoints).not.toHaveBeenCalled();
      expect(mockGetIncomingCount).not.toHaveBeenCalled();
      expect(mockGetInboxUnreadCount).not.toHaveBeenCalled();
      expect(mockGetTrips).not.toHaveBeenCalled();
      expect(mockGetMallSnapshot).not.toHaveBeenCalled();
      expect(mockLoadLearnedKeywords).not.toHaveBeenCalled();
      expect(mockRolloverIncompleteTasks).not.toHaveBeenCalled();
      expect(mockCheckAndRunTripPreRefresh).not.toHaveBeenCalled();
      expect(mockRefreshHabitatCacheIfStale).not.toHaveBeenCalled();
    });
  });

  describe('when Firestore fetch fails', () => {
    it('calls onExit via abort timer even on error', async () => {
      mockUseAuth.mockReturnValue({ user: { uid: 'u1' }, loading: false });
      mockGetTasksForDate.mockRejectedValue(new Error('network'));

      const onExit = jest.fn();
      render(<SplashScreen onExit={onExit} />);
      await act(async () => { await Promise.resolve(); });

      act(() => { jest.advanceTimersByTime(4_100); });
      expect(onExit).toHaveBeenCalledTimes(1);
    });
  });
});
