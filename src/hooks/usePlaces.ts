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
  getLearnedPlaceCounts, getTrips, Timestamp,
} from '../services/firestore';
import type { TaughtPlace } from '../services/firestore/taughtPlaces';
import { computeLearnedPlaces } from '../services/learnedPlaces';
import { splitPlaces, type PlaceEntry } from '../services/places';
import { forgetTrip as forgetTripAction } from '../services/tripActions';
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
  addPlace: (poiType: string, name: string) => Promise<void>;
  removePlace: (id: string) => Promise<void>;
  forgetTrip: (trip: Trip) => Promise<void>;
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
    try {
      const [taughtPlaces, counts, allTrips] = await Promise.all([
        getTaughtPlaces(uid),
        getLearnedPlaceCounts(uid),
        getTrips(uid),
      ]);
      if (uidRef.current !== uid) { return; }
      setTaught(taughtPlaces);
      setLearned(computeLearnedPlaces(counts));
      setTrips(allTrips);
    } catch (err) {
      if (uidRef.current === uid) { console.warn('[usePlaces] refresh failed', err); }
    } finally {
      if (uidRef.current === uid) { hasLoadedRef.current = true; setLoading(false); }
    }
  }, [uid]);

  // Refetch on focus, not just mount — returning from TripPlanner (a new trip)
  // or HomeAddress must show the updated lists.
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const { favourites, usuals } = useMemo(() => splitPlaces(taught, learned), [taught, learned]);

  const today = todayISO();
  const activeTrips = useMemo(
    () => trips.filter(t => t.kind !== 'offgrid' && !isTripPast(t, today)),
    [trips, today],
  );
  const pastTripGroups = useMemo(
    () => groupTripsByYear(trips.filter(t => isPastMemorableTrip(t, today))),
    [trips, today],
  );

  const addPlace = useCallback(async (poiType: string, name: string) => {
    if (!uid) { return; }
    // Optimistic — show the favourite immediately, then persist + reconcile.
    const tempId = `temp_${Date.now()}`;
    const optimistic: TaughtPlace = { id: tempId, poiType, name, createdAt: Timestamp.now() };
    setTaught(prev => [optimistic, ...prev]);
    try {
      await addTaughtPlace(uid, { poiType, name });
      await refresh(); // swap the temp row for the real persisted one
    } catch (err) {
      setTaught(prev => prev.filter(p => p.id !== tempId)); // roll back on failure
      console.warn('[usePlaces] addPlace failed', err);
    }
  }, [uid, refresh]);

  const removePlace = useCallback(async (id: string) => {
    if (!uid) { return; }
    try {
      await removeTaughtPlace(uid, id);
      setTaught(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      console.warn('[usePlaces] removePlace failed', err);
    }
  }, [uid]);

  const forgetTrip = useCallback(async (trip: Trip) => {
    if (!uid) { return; }
    try {
      await forgetTripAction(uid, trip);
      setTrips(prev => prev.filter(t => t.id !== trip.id));
    } catch (err) {
      console.warn('[usePlaces] forgetTrip failed', err);
    }
  }, [uid]);

  return { loading, favourites, usuals, activeTrips, pastTripGroups, addPlace, removePlace, forgetTrip, refresh };
}
