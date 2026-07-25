/**
 * useTodayScreenData — KAN-59 / KAN-214
 *
 * Owns the one-shot Firestore fetch (or SplashScreen boot-data fast path),
 * loading/error state, and the derived data (tasks, categories, points,
 * inbox/social counts) consumed by the rest of the Today screen.
 *
 * Data strategy: one-shot fetch on mount (no real-time subscriptions).
 * Pull-to-refresh or onTaskAdded re-runs the full fetch. Writes update local
 * state immediately and persist to Firestore in the background; on failure,
 * local state reverts (see useTaskCompletion).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCategories,
  getTasksForDate,
  getUserPreferences,
  getPoiPreferencesMap,
  getUser,
  getTotalPoints,
  getInboxUnreadCount,
  getTrips,
} from '../../services/firestore';
import { getMallSnapshot } from '../../services/mallSnapshots';
import { getIncomingSharedTasksCount } from '../../services/sharing';
import { setHomeLocation } from '../../services/home';
import { updateNotifNearbyEnabled, updateProximityPoiPreferences, setActiveTrips, setMallSnapshot as setProximityMallSnapshot } from '../../services/proximity';
import { updateExitPromptPref } from '../../services/proximity';
import { updateIndoorExitPromptPref } from '../../services/indoorProximity';
import { syncTasksToWatch } from '../../services/wearSync';
import type { Category, MallSnapshot, Task, Trip } from '../../types';
import { todayISO } from '../../utils/date';
import { useAppStore } from '../../store/appStore';
import { DEBUG_DISABLE_BACKGROUND } from './debugFlags';

const DATA_FETCH_TIMEOUT_MS = 5_000;
const TASKS_LOAD_ERROR = 'Could not load tasks. Check your connection.';

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} fetch timed out`)), DATA_FETCH_TIMEOUT_MS),
    ),
  ]);
}

function logFetchFailure(label: string, result: PromiseSettledResult<unknown>) {
  if (result.status === 'rejected') {
    console.warn(`[useTodayScreenData] ${label} fetch failed`, result.reason);
  }
}

export interface TodayScreenData {
  tasks:             Task[];
  setTasks:          React.Dispatch<React.SetStateAction<Task[]>>;
  isLoading:         boolean;
  isRefreshing:      boolean;
  error:             string | null;
  /** Re-runs the full fetch. Returns the in-flight promise so callers that
   *  need to know when the data has actually landed can await it — firing and
   *  forgetting made a refresh look instantaneous. */
  refresh:           () => Promise<void>;
  customCategories:  Category[];
  totalPoints:       number;
  setTotalPoints:    React.Dispatch<React.SetStateAction<number>>;
  inboxCount:        number;
  socialUnreadCount: number;
  lowBatteryPausePref: boolean;
  storeTuningEnabled:  boolean | undefined;
  /** Active trip areas + current mall snapshot (KAN-237) — fed into the
   *  proximity engine's cache-first check. Refetched on every load (boot
   *  fast path, initial non-boot fetch, and refresh) so cache-first coverage
   *  doesn't go stale after the boot path is consumed. */
  trips:               Trip[];
  mallSnapshot:        MallSnapshot | null;
  /** Always-current tasks array, readable from stable callbacks without
   *  needing `tasks` in their dependency array (avoids identity churn). */
  latestTasksRef:    React.RefObject<Task[]>;
}

export function useTodayScreenData(uid: string | undefined): TodayScreenData {
  const [tasks,           setTasks]           = useState<Task[]>([]);
  const [isLoading,       setIsLoading]       = useState(() => {
    if (!uid) { return false; }
    const { bootData } = useAppStore.getState();
    return !(bootData !== null && bootData.ownerUid === uid);
  });
  const [isRefreshing,    setIsRefreshing]    = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [customCategories, setCustomCategories] = useState<Category[]>([]);
  const [totalPoints,     setTotalPoints]     = useState(0);
  const [inboxCount,      setInboxCount]      = useState(0);
  const [socialUnreadCount, setSocialUnreadCount] = useState(0);
  const [lowBatteryPausePref, setLowBatteryPausePref] = useState(false);
  const [storeTuningEnabled, setStoreTuningEnabled]  = useState<boolean | undefined>(undefined);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [mallSnapshot, setMallSnapshot] = useState<MallSnapshot | null>(null);

  const latestTasksRef = useRef<Task[]>([]);
  useEffect(() => { latestTasksRef.current = tasks; }, [tasks]);

  const latestDataRef = useRef({
    customCategories: [] as Category[],
    totalPoints: 0,
    inboxCount: 0,
    socialUnreadCount: 0,
    lowBatteryPausePref: false,
    storeTuningEnabled: undefined as boolean | undefined,
    trips: [] as Trip[],
    mallSnapshot: null as MallSnapshot | null,
  });
  useEffect(() => {
    latestDataRef.current = {
      customCategories,
      totalPoints,
      inboxCount,
      socialUnreadCount,
      lowBatteryPausePref,
      storeTuningEnabled,
      trips,
      mallSnapshot,
    };
  }, [
    customCategories,
    totalPoints,
    inboxCount,
    socialUnreadCount,
    lowBatteryPausePref,
    storeTuningEnabled,
    trips,
    mallSnapshot,
  ]);

  // ── One-shot data fetch ────────────────────────────────────────────────────
  //
  // No background watchers. Called once on mount and again on error retry,
  // focus refresh, or when onTaskAdded fires after a new task is created.
  //
  // requestIdRef guards against overlapping calls (e.g. a fast refocus refresh
  // firing while the initial fetch is still in flight) — only the most recent
  // call is allowed to commit state.

  const requestIdRef = useRef(0);

  const loadData = useCallback(async (isRefresh: boolean = false) => {
    const myRequestId = ++requestIdRef.current;
    const isStale = () => requestIdRef.current !== myRequestId;

    if (!uid) {
      setTasks([]);
      setCustomCategories([]);
      setTotalPoints(0);
      setInboxCount(0);
      setSocialUnreadCount(0);
      setLowBatteryPausePref(false);
      setStoreTuningEnabled(undefined);
      setTrips([]);
      setMallSnapshot(null);
      setActiveTrips(null);
      setProximityMallSnapshot(null);
      setHomeLocation(null);
      setIsLoading(false);
      return;
    }

    // Fast path — use data pre-loaded by SplashScreen (initial mount only).
    if (!isRefresh) {
      const { bootData, clearBootData } = useAppStore.getState();
      if (bootData && bootData.ownerUid !== uid) {
        clearBootData();
      } else if (bootData) {
        if (!isStale()) {
          setTasks(bootData.tasks);
          setCustomCategories(bootData.customCategories.filter(c => !c.isBuiltIn));
          setTotalPoints(bootData.totalPoints);
          setInboxCount(bootData.inboxCount);
          setSocialUnreadCount(bootData.socialUnreadCount ?? 0);
          if (bootData.userData) {
            setLowBatteryPausePref(bootData.userData.poiPreferences?.lowBatteryPause ?? false);
            setStoreTuningEnabled(bootData.userData.poiPreferences?.storeTuningEnabled);
          }
          setTrips(bootData.trips);
          setMallSnapshot(bootData.mallSnapshot);
          // Feed the proximity engine synchronously here (not via a separate
          // effect in useTodayScreen/index.ts) so cache-first coverage is
          // installed before useProximityEngine's own effect runs its first
          // search — avoids one extra live API call at startup (KAN-237
          // review fix).
          setActiveTrips(bootData.trips);
          setProximityMallSnapshot(bootData.mallSnapshot);
          setHomeLocation(bootData.userData?.home ?? null);
          updateNotifNearbyEnabled(bootData.userPrefs.notif_nearby_enabled ?? true);
          updateExitPromptPref(bootData.userPrefs.exitPrompt ?? true);
          updateIndoorExitPromptPref(bootData.userPrefs.exitPrompt ?? true);
          updateProximityPoiPreferences(bootData.poiPrefsMap);
          setIsLoading(false);
        }
        clearBootData();
        return;
      }
    }

    if (isRefresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      const [
        fetchedTasksResult,
        userDataResult,
        userPrefsResult,
        poiPrefsMapResult,
        categoriesResult,
        pointsResult,
        inboxResult,
        socialUnreadResult,
        fetchedTripsResult,
        fetchedMallSnapshotResult,
      ] = await Promise.allSettled([
        withTimeout(getTasksForDate(uid, todayISO()), 'tasks'),
        withTimeout(getUser(uid), 'user'),
        withTimeout(getUserPreferences(uid), 'userPrefs'),
        withTimeout(getPoiPreferencesMap(uid), 'poiPrefs'),
        withTimeout(getCategories(uid), 'categories'),
        withTimeout(getTotalPoints(uid), 'points'),
        withTimeout(getIncomingSharedTasksCount(uid), 'sharedInbox'),
        withTimeout(getInboxUnreadCount(uid), 'socialInbox'),
        withTimeout(getTrips(uid), 'trips'),
        withTimeout(getMallSnapshot(uid), 'mallSnapshot'),
      ]);

      if (isStale()) { return; }

      logFetchFailure('tasks', fetchedTasksResult);
      logFetchFailure('user', userDataResult);
      logFetchFailure('userPrefs', userPrefsResult);
      logFetchFailure('poiPrefs', poiPrefsMapResult);
      logFetchFailure('categories', categoriesResult);
      logFetchFailure('points', pointsResult);
      logFetchFailure('sharedInbox', inboxResult);
      logFetchFailure('socialInbox', socialUnreadResult);
      logFetchFailure('trips', fetchedTripsResult);
      logFetchFailure('mallSnapshot', fetchedMallSnapshotResult);

      const cachedTasks = latestTasksRef.current;
      setTasks(
        fetchedTasksResult.status === 'fulfilled'
          ? fetchedTasksResult.value
          : cachedTasks,
      );
      if (fetchedTasksResult.status === 'rejected' && cachedTasks.length === 0) {
        setError(TASKS_LOAD_ERROR);
      }

      const categories = categoriesResult.status === 'fulfilled'
        ? categoriesResult.value
        : latestDataRef.current.customCategories;
      setCustomCategories(categories.filter(c => !c.isBuiltIn));

      setTotalPoints(
        pointsResult.status === 'fulfilled'
          ? pointsResult.value
          : latestDataRef.current.totalPoints,
      );
      setInboxCount(
        inboxResult.status === 'fulfilled'
          ? inboxResult.value
          : latestDataRef.current.inboxCount,
      );
      setSocialUnreadCount(
        socialUnreadResult.status === 'fulfilled'
          ? socialUnreadResult.value
          : latestDataRef.current.socialUnreadCount,
      );

      const fetchedTrips = fetchedTripsResult.status === 'fulfilled'
        ? fetchedTripsResult.value
        : latestDataRef.current.trips;
      setTrips(fetchedTrips);
      setActiveTrips(fetchedTrips);

      const fetchedMallSnapshot = fetchedMallSnapshotResult.status === 'fulfilled'
        ? fetchedMallSnapshotResult.value
        : latestDataRef.current.mallSnapshot;
      setMallSnapshot(fetchedMallSnapshot);
      setProximityMallSnapshot(fetchedMallSnapshot);

      if (userDataResult.status === 'fulfilled') {
        const userData = userDataResult.value;
        setHomeLocation(userData?.home ?? null);
        setLowBatteryPausePref(userData?.poiPreferences?.lowBatteryPause ?? false);
        setStoreTuningEnabled(userData?.poiPreferences?.storeTuningEnabled);
      }

      if (userPrefsResult.status === 'fulfilled') {
        const userPrefs = userPrefsResult.value;
        updateNotifNearbyEnabled(userPrefs.notif_nearby_enabled ?? true);
        updateExitPromptPref(userPrefs.exitPrompt ?? true);
        updateIndoorExitPromptPref(userPrefs.exitPrompt ?? true);
      }

      if (poiPrefsMapResult.status === 'fulfilled') {
        updateProximityPoiPreferences(poiPrefsMapResult.value);
      }
    } catch (err) {
      if (!isStale()) {
        console.warn('[useTodayScreenData] loadData failed', err);
        setError(TASKS_LOAD_ERROR);
      }
    } finally {
      if (!isStale()) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [uid]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const refresh = useCallback(() => loadData(true), [loadData]);

  // ── Wear OS sync (KAN-35) ──────────────────────────────────────────────────

  useEffect(() => {
    if (DEBUG_DISABLE_BACKGROUND) { return; }
    syncTasksToWatch(tasks);
  }, [tasks]);

  return {
    tasks,
    setTasks,
    isLoading,
    isRefreshing,
    error,
    refresh,
    customCategories,
    totalPoints,
    setTotalPoints,
    inboxCount,
    socialUnreadCount,
    lowBatteryPausePref,
    storeTuningEnabled,
    trips,
    mallSnapshot,
    latestTasksRef,
  };
}
