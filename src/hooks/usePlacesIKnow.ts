/**
 * usePlacesIKnow — KAN-234
 *
 * "Places I know" list: the always-on habitat area + every downloaded
 * trip, each refreshable/deletable. No JSX — independently testable.
 */

import { useCallback, useEffect, useState } from 'react';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import { getTrips, deleteTrip as deleteTripDoc } from '../services/firestore';
import { estimateHabitatAreaSizeBytes, deleteTripAreaPlaces } from '../services/habitatCache';
import { refreshTripArea } from '../services/tripDownload';
import type { Trip } from '../types';

export interface PlacesIKnowState {
  loading: boolean;
  habitatSizeBytes: number;
  trips: Trip[];
  refresh: () => Promise<void>;
  refreshingTripId: string | null;
  refreshTrip: (trip: Trip) => Promise<void>;
  deleteTrip: (trip: Trip) => Promise<void>;
}

export function usePlacesIKnow(): PlacesIKnowState {
  const uid = getAuth().currentUser?.uid ?? '';

  const [loading, setLoading] = useState(true);
  const [habitatSizeBytes, setHabitatSizeBytes] = useState(0);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [refreshingTripId, setRefreshingTripId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!uid) { setLoading(false); return; }
    setLoading(true);
    try {
      const fetchedTrips = await getTrips(uid);
      // Trip docs outlive their downloaded data (SplashScreen's
      // deleteExpiredTripPlaces purges only the on-device place cache, never
      // the doc — CalendarScreen still reads the full list for its
      // underline/"used to know" label). Here, an expired trip has nothing
      // left to refresh or delete, so it's dropped from this screen's list.
      const now = Date.now();
      setTrips(fetchedTrips.filter(t => t.expiresAt > now));
      setHabitatSizeBytes(estimateHabitatAreaSizeBytes());
    } catch (err) {
      console.warn('[usePlacesIKnow] refresh failed', err);
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => { void refresh(); }, [refresh]);

  const refreshTrip = useCallback(async (trip: Trip) => {
    if (!uid) { return; }
    setRefreshingTripId(trip.id);
    try {
      await refreshTripArea(uid, trip);
      await refresh();
    } catch (err) {
      console.warn('[usePlacesIKnow] refreshTrip failed', err);
    } finally {
      setRefreshingTripId(null);
    }
  }, [uid, refresh]);

  const deleteTrip = useCallback(async (trip: Trip) => {
    if (!uid) { return; }
    try {
      await deleteTripDoc(uid, trip.id);
      deleteTripAreaPlaces(trip.cacheAreaId);
      setTrips(prev => prev.filter(t => t.id !== trip.id));
    } catch (err) {
      console.warn('[usePlacesIKnow] deleteTrip failed', err);
    }
  }, [uid]);

  return { loading, habitatSizeBytes, trips, refresh, refreshingTripId, refreshTrip, deleteTrip };
}
