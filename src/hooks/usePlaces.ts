/**
 * usePlaces — the Places screen's data (KAN-304).
 *
 * Composes the three sections behind the Lantern pill:
 *   1. Places I know — taught brands + learned brands, merged (mergePlaces).
 *   2. Trips         — current/upcoming trips (destination + dates).
 *   3. Places I've been — past trips.
 *
 * One-shot fetches (repo rule: no persistent onSnapshot). Exposes teach/forget
 * actions that refresh the affected list.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import {
  getTaughtPlaces, addTaughtPlace, removeTaughtPlace,
  getLearnedPlaceCounts, removeLearnedBrand, getTrips, Timestamp,
} from '../services/firestore';
import { taughtPlaceId, type TaughtPlace } from '../services/firestore/taughtPlaces';
import { computeLearnedPlaces } from '../services/learnedPlaces';
import { splitPlaces, type PlaceEntry } from '../services/places';
import { forgetTrip as forgetTripAction } from '../services/tripActions';
import { refreshTripArea } from '../services/tripDownload';
import { groupTripsByYear, type TripYearGroup } from './useWhereWeveBeen';
import { isTripPast, isPastMemorableTrip } from '../utils/contextChip';
import { todayISO } from '../utils/date';
import type { Trip } from '../types';

export interface PlacesState {
  loading: boolean;
  /** Brands the user taught ("Favourites"). */
  favourites: PlaceEntry[];
  /** Brands inferred from brushes ("Your usuals"), excluding any already taught. */
  usuals: PlaceEntry[];
  /** Current/upcoming trips (destination + dates). */
  activeTrips: Trip[];
  /** Past trips, grouped by year. */
  pastTripGroups: TripYearGroup[];
  addPlace: (poiType: string, name: string) => void;
  /** Remove a taught favourite by its doc id. */
  removePlace: (id: string) => void;
  /** Forget a learned "usual" brand (deletes its visit tallies). */
  removeUsual: (poiType: string, name: string) => void;
  forgetTrip: (trip: Trip) => void;
  /** Re-download a planned trip's area. */
  refreshTrip: (trip: Trip) => void;
  /** Trip id currently re-downloading, or null. */
  refreshingTripId: string | null;
  refresh: () => Promise<void>;
}

export function usePlaces(): PlacesState {
  const uid = getAuth().currentUser?.uid ?? '';
  const uidRef = useRef(uid);
  uidRef.current = uid;

  const [loading, setLoading] = useState(true);
  const hasLoadedRef = useRef(false);
  const [taught, setTaught] = useState<TaughtPlace[]>([]);
  const [learned, setLearned] = useState<ReturnType<typeof computeLearnedPlaces>>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [refreshingTripId, setRefreshingTripId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!uid) {
      // Signed out — drop the previous account's data so it never lingers.
      setTaught([]);
      setLearned([]);
      setTrips([]);
      setLoading(false);
      return;
    }
    if (!hasLoadedRef.current) { setLoading(true); } // spinner only on first load, not on every focus refetch
    // Settle each read independently: one collection failing (e.g. a rules gap)
    // must not blank the other lists.
    const [taughtRes, countsRes, tripsRes] = await Promise.allSettled([
      getTaughtPlaces(uid),
      getLearnedPlaceCounts(uid),
      getTrips(uid),
    ]);
    if (uidRef.current !== uid) { return; }
    if (taughtRes.status === 'fulfilled') { setTaught(taughtRes.value); }
    else { console.warn('[usePlaces] taught places load failed', taughtRes.reason); }
    if (countsRes.status === 'fulfilled') { setLearned(computeLearnedPlaces(countsRes.value)); }
    else { console.warn('[usePlaces] learned places load failed', countsRes.reason); }
    if (tripsRes.status === 'fulfilled') { setTrips(tripsRes.value); }
    else { console.warn('[usePlaces] trips load failed', tripsRes.reason); }
    hasLoadedRef.current = true;
    setLoading(false);
  }, [uid]);

  // Refetch on focus, not just mount — returning from TripPlanner (a new trip)
  // or HomeAddress must show the updated lists.
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const { favourites, usuals } = useMemo(() => splitPlaces(taught, learned), [taught, learned]);

  const today = todayISO();
  const activeTrips = useMemo(
    () => trips
      .filter(t => t.kind !== 'offgrid' && !isTripPast(t, today))
      // Closest first; trips without a start date sort last.
      .sort((a, b) => (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999')),
    [trips, today],
  );
  const pastTripGroups = useMemo(
    () => groupTripsByYear(trips.filter(t => isPastMemorableTrip(t, today))),
    [trips, today],
  );

  // All three actions are LOCAL-FIRST: update state now so it works fully
  // offline, then fire the Firestore write and let it sync when there's a
  // connection. We never await the write before updating the UI — offline,
  // addDoc/deleteDoc promises stay pending until reconnect, so awaiting would
  // freeze the list. Firestore's offline cache persists the change across
  // restarts and replays it to the server on reconnect.
  const addPlace = useCallback((poiType: string, name: string) => {
    if (!uid) { return; }
    // Deterministic id: the optimistic row uses the SAME id the real doc will
    // get, so a remove issued before the write lands cancels the right doc (no
    // resurrection), and re-teaching overwrites instead of duplicating.
    const id = taughtPlaceId(poiType, name);
    const optimistic: TaughtPlace = { id, poiType, name, createdAt: Timestamp.now() };
    setTaught(prev => (prev.some(p => p.id === id) ? prev : [optimistic, ...prev]));
    // Fire-and-forget; DON'T roll back on rejection. RN Firebase rejects writes
    // while offline even though the mutation is queued in the local cache and
    // will replay on reconnect — rolling back would make the row vanish ~1s
    // after it appeared. A later focus refetch reconciles with the cached doc.
    addTaughtPlace(uid, { poiType, name }).catch(err => console.warn('[usePlaces] addPlace queued/failed', err));
  }, [uid]);

  const removePlace = useCallback((id: string) => {
    if (!uid) { return; }
    setTaught(prev => prev.filter(p => p.id !== id)); // local first
    removeTaughtPlace(uid, id).catch(err => console.warn('[usePlaces] removePlace failed', err));
  }, [uid]);

  const removeUsual = useCallback((poiType: string, name: string) => {
    if (!uid) { return; }
    setLearned(prev => prev.filter(b => !(b.poiType === poiType && b.name === name))); // local first
    removeLearnedBrand(uid, poiType, name).catch(err => console.warn('[usePlaces] removeUsual failed', err));
  }, [uid]);

  const forgetTrip = useCallback((trip: Trip) => {
    if (!uid) { return; }
    setTrips(prev => prev.filter(t => t.id !== trip.id)); // local first
    forgetTripAction(uid, trip).catch(err => console.warn('[usePlaces] forgetTrip failed', err));
  }, [uid]);

  const refreshTrip = useCallback((trip: Trip) => {
    if (!uid) { return; }
    setRefreshingTripId(trip.id);
    refreshTripArea(uid, trip)
      .catch(err => console.warn('[usePlaces] refreshTrip failed', err))
      .finally(() => { if (uidRef.current === uid) { setRefreshingTripId(null); } });
  }, [uid]);

  return {
    loading, favourites, usuals, activeTrips, pastTripGroups,
    addPlace, removePlace, removeUsual, forgetTrip, refreshTrip, refreshingTripId, refresh,
  };
}
