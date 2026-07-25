/**
 * useTodayScreen — KAN-59 / KAN-214
 *
 * ViewModel-layer hook for TodayScreen. Composes four focused sub-hooks:
 *   - useTodayScreenData    — Firestore fetch, loading/error, task/points state
 *   - useProximityEngine    — location permission, outdoor/indoor proximity,
 *                             Store fine tuning
 *   - useTaskCompletion     — task-done toggle + achievements/challenges
 *   - useLearnedPlaces      — on-device learned-place ranking (KAN-230),
 *                             fed into the proximity engine and refreshed
 *                             after every completion
 *
 * Also feeds the user's custom category place types into the proximity
 * engine's habitat-cache prefetch (KAN-238) — the built-in 16 types don't
 * need wiring here (proximity.ts already knows ALL_POI_TYPES), only the
 * per-user custom ones, which live in Firestore via useTodayScreenData.
 *
 * No JSX — independently testable with renderHook.
 */

import { useCallback, useEffect } from 'react';
import type { NearbyPlace } from '../../services/maps';
import { setLearnedPlaces, setCustomCategoryPoiTypes } from '../../services/proximity';
import type { PlacesMap, PlaceContext } from '../../services/proximity';
import type { Category, Task } from '../../types';
import { useTodayScreenData } from './useTodayScreenData';
import { useProximityEngine } from './useProximityEngine';
import { useTaskCompletion } from './useTaskCompletion';
import { useLearnedPlaces } from './useLearnedPlaces';
import { useErrandBundle } from '../useErrandBundle';
import type { ErrandBundle } from '../../services/errandBundles';
import type { ClusterLeisureSuggestion } from '../../services/clusterLeisure';
import { useFirstSessionGate } from './useFirstSessionGate';
import { useTripSuggestion } from './useTripSuggestion';
import type { CalendarSuggestion } from '../../services/tripSuggestions';
import { useOffGridWelcomeBack } from '../useOffGridWelcomeBack';

export interface TodayScreenState {
  /** Today's tasks. Empty while loading. */
  tasks:            Task[];
  /** True while the initial data fetch is in-flight. */
  isLoading:        boolean;
  /** True while an explicit data refresh is in-flight. */
  isRefreshing:     boolean;
  /** Non-null when the fetch failed. Cleared on next successful fetch. */
  error:            string | null;
  /** Call to re-run the full data fetch (error retry, focus refresh, or after task creation). Awaitable. */
  refresh:          () => Promise<void>;
  /** Active nearby POI type from the proximity engine. Null when none nearby. */
  nearbyPoiType:    string | null;
  nearbyPlace:      NearbyPlace | null;
  /** Nearest known place per POI type — drives NearbyCard "Also close" rows. */
  poiPlaces:        PlacesMap;
  /** Mall/trip context for the last position fix (KAN-242) — feeds the header ContextChip. */
  placeContext:     PlaceContext;
  storeTuningActive:        boolean;
  showStoreTuningPrompt:    boolean;
  onStoreTuningTurnOn:      () => void;
  onStoreTuningNotNow:      () => void;
  /** Custom categories from Firestore — passed to NewTaskSheet. */
  customCategories: Category[];
  totalTasks:   number;
  doneTasks:    number;
  progress:     number;
  nearbyCount:  number;
  /** Total gamification points for the header badge. */
  totalPoints:  number;
  /** Count of pending shared tasks for the inbox bell badge. */
  inboxCount:   number;
  /** Count of unread social inbox entries (follow notifications) for the people icon badge. */
  socialUnreadCount: number;
  /** Task-done toggle — updates local state immediately, persists to Firestore. */
  handleToggle: (taskId: string, done: boolean) => Promise<void>;
  /** True when location permission has been granted. */
  permissionGranted: boolean;
  /** True once the Nearby list reflects a real, settled outcome — see
   *  ProximityEngine.nearbyReady. Anything derived from poiPlaces (far-away
   *  arrows, "one trip for all of these") must gate on this. */
  nearbyReady: boolean;
  /** Re-runs the proximity search immediately — useful for a manual "refresh location" tap. */
  refreshProximity: () => Promise<boolean>;
  /** True when the last proximity search failed because the device GPS toggle is off. */
  locationUnavailable: boolean;
  /** Top-ranked errand bundle (KAN-235), or null when none exists / all are dismissed for today. */
  errandBundle: ErrandBundle | null;
  /** KAN-293 — a leisure place among the current bundle's stops, or null. */
  errandBundleLeisure: ClusterLeisureSuggestion | null;
  /** Hides the current errandBundle for the rest of the day. */
  dismissErrandBundle: () => void;
  /** Contextual trip suggestion (KAN-245 calendar signal), or null when none qualifies / already dismissed / first session. */
  tripSuggestion: CalendarSuggestion | null;
  /** Permanently dismisses the current tripSuggestion. */
  dismissTripSuggestion: () => void;
}

export function useTodayScreen(uid: string | undefined): TodayScreenState {
  const data = useTodayScreenData(uid);
  const proximity = useProximityEngine(
    uid,
    data.tasks,
    data.latestTasksRef,
    data.lowBatteryPausePref,
    data.storeTuningEnabled,
  );
  const { handleToggle: handleToggleInner } = useTaskCompletion(
    uid,
    data.setTasks,
    data.latestTasksRef,
    proximity.nearbyPoiTypeRef,
    data.setTotalPoints,
    proximity.nearbyPlaceRef,
  );

  const { learnedPlaces, refresh: refreshLearnedPlaces } = useLearnedPlaces(uid);

  const isFirstSession = useFirstSessionGate(uid);
  const { suggestion: tripSuggestion, dismiss: dismissTripSuggestion } =
    useTripSuggestion(isFirstSession, data.trips, data.mallSnapshot);

  // KAN-246 — "welcome back" payoff moment + auto-expiry cleanup, checked
  // on every Today mount/refresh (the trips list is already loaded here).
  useOffGridWelcomeBack(uid, data.tasks, data.trips);

  // Pure computation over data useProximityEngine already holds each tick
  // (KAN-235) — no new timer, no new location subscription.
  const {
    bundle: errandBundle,
    leisure: errandBundleLeisure,
    dismiss: dismissErrandBundle,
  } = useErrandBundle(data.tasks, proximity.poiPlaces);

  useEffect(() => {
    setLearnedPlaces(learnedPlaces);
  }, [learnedPlaces]);

  useEffect(() => {
    setCustomCategoryPoiTypes(
      data.customCategories.map(c => c.poi).filter((poi): poi is string => !!poi),
    );
  }, [data.customCategories]);

  // setActiveTrips/setMallSnapshot (KAN-237) are fed synchronously from
  // useTodayScreenData's loadData, not from an effect here — see that file
  // for why (ordering vs. useProximityEngine's own effect below).

  // A toggle in either direction changes the completedPlaceId brush history
  // the ranking is derived from: `done: true` adds a data point, `done:
  // false` deletes the previous completion's completedPlace* fields
  // (setTaskDone) — refresh after both so the ranking never drifts from
  // what's actually in Firestore.
  const handleToggle = useCallback(async (taskId: string, done: boolean) => {
    await handleToggleInner(taskId, done);
    refreshLearnedPlaces().catch(() => undefined);
  }, [handleToggleInner, refreshLearnedPlaces]);

  // Birthday tasks (KAN-248) are unscored — excluded from the ring/progress
  // count entirely so they can never affect day-state, only shown in the
  // task list itself.
  const scorableTasks = data.tasks.filter(t => t.kind !== 'birthday');
  const totalTasks  = scorableTasks.length;
  const doneTasks   = scorableTasks.filter(t => t.done).length;
  const progress    = totalTasks > 0 ? doneTasks / totalTasks : 0;
  // KAN-287 — "N Nearby" in the ring caption counts tasks the user could
  // actually act on right now: still open, AND their POI type resolved at
  // least one place this tick. It previously counted every task carrying a
  // POI type, done or not, resolved or not — so for a user whose tasks are
  // all location-tagged it simply mirrored the total.
  //
  // The `poiPlaces[...]` test is deliberately the same one TaskRow uses for
  // its `isFar` flag, so the caption can never disagree with the rows
  // underneath it: a task counted here is exactly a task not shown as far.
  const nearbyCount = data.tasks.filter(
    t => !t.done && !!t.poi && (proximity.poiPlaces[t.poi]?.length ?? 0) > 0,
  ).length;

  return {
    tasks: data.tasks,
    isLoading: data.isLoading,
    isRefreshing: data.isRefreshing,
    error: data.error,
    refresh: data.refresh,
    nearbyPoiType: proximity.nearbyPoiType,
    nearbyPlace: proximity.nearbyPlace,
    poiPlaces: proximity.poiPlaces,
    placeContext: proximity.placeContext,
    storeTuningActive:     proximity.storeTuningActive,
    showStoreTuningPrompt: proximity.showStoreTuningPrompt,
    onStoreTuningTurnOn: proximity.onStoreTuningTurnOn,
    onStoreTuningNotNow: proximity.onStoreTuningNotNow,
    customCategories: data.customCategories,
    totalTasks,
    doneTasks,
    progress,
    nearbyCount,
    totalPoints: data.totalPoints,
    inboxCount: data.inboxCount,
    socialUnreadCount: data.socialUnreadCount,
    handleToggle,
    permissionGranted: proximity.permissionGranted,
    nearbyReady: proximity.nearbyReady,
    refreshProximity: proximity.refreshProximity,
    locationUnavailable: proximity.locationUnavailable,
    errandBundle,
    errandBundleLeisure,
    dismissErrandBundle,
    tripSuggestion,
    dismissTripSuggestion,
  };
}
