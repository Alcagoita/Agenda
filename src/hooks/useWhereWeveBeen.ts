/**
 * useWhereWeveBeen — KAN-257
 *
 * "Where we've been" timeline: every past, non-off-grid trip, grouped by
 * year (most recent year first, trips within a year most-recent-first).
 * Only destination + dates are shown — no place data, no re-download
 * action, matching the ticket's privacy-positive framing (the detail is
 * genuinely gone; the memory remains). No JSX — independently testable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import { getTrips } from '../services/firestore';
import { forgetTrip as forgetTripAction } from '../services/tripActions';
import { isPastMemorableTrip } from '../utils/contextChip';
import { todayISO } from '../utils/date';
import type { Trip } from '../types';

export interface TripYearGroup {
  year: string;
  trips: Trip[];
}

export interface WhereWeveBeenState {
  loading: boolean;
  yearGroups: TripYearGroup[];
  forgetTrip: (trip: Trip) => Promise<void>;
}

/** Groups past trips by the year of their endDate, most recent year and most recent trip first. Trips without an endDate are dropped — nothing to group them by. */
export function groupTripsByYear(trips: Trip[]): TripYearGroup[] {
  const byYear = new Map<string, Trip[]>();
  for (const trip of trips) {
    if (!trip.endDate) { continue; }
    const year = trip.endDate.slice(0, 4);
    if (!byYear.has(year)) { byYear.set(year, []); }
    byYear.get(year)!.push(trip);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, yearTrips]) => ({
      year,
      trips: [...yearTrips].sort((a, b) => b.endDate!.localeCompare(a.endDate!)),
    }));
}

export function useWhereWeveBeen(): WhereWeveBeenState {
  const uid = getAuth().currentUser?.uid ?? '';

  const [loading, setLoading] = useState(true);
  const [trips, setTrips] = useState<Trip[]>([]);

  // Guards against a stale getTrips response landing after uid has already
  // changed (sign-out/sign-in while this screen is mounted) — without this,
  // a slow fetch for the old user could overwrite state with the wrong
  // user's trips after the new user's fetch already resolved.
  const uidRef = useRef(uid);
  uidRef.current = uid;

  const refresh = useCallback(async () => {
    if (!uid) { setLoading(false); return; }
    setLoading(true);
    try {
      const today = todayISO();
      const fetched = await getTrips(uid);
      if (uidRef.current !== uid) { return; }
      setTrips(fetched.filter(t => isPastMemorableTrip(t, today)));
    } catch (err) {
      if (uidRef.current !== uid) { return; }
      console.warn('[useWhereWeveBeen] refresh failed', err);
    } finally {
      if (uidRef.current === uid) { setLoading(false); }
    }
  }, [uid]);

  useEffect(() => { void refresh(); }, [refresh]);

  const forgetTrip = useCallback(async (trip: Trip) => {
    if (!uid) { return; }
    try {
      await forgetTripAction(uid, trip);
      setTrips(prev => prev.filter(t => t.id !== trip.id));
    } catch (err) {
      console.warn('[useWhereWeveBeen] forgetTrip failed', err);
    }
  }, [uid]);

  const yearGroups = useMemo(() => groupTripsByYear(trips), [trips]);

  return { loading, yearGroups, forgetTrip };
}
