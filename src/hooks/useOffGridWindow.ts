/**
 * useOffGridWindow — KAN-246
 *
 * State/logic for the off-grid setup flow: pick a duration (defaults area
 * to current location), optionally override the area with a chosen
 * destination (reuses Trip Planner's destination autocomplete), confirm →
 * downloads the area (same downloadTripArea machinery as Trip Planner) and
 * writes a `kind: 'offgrid'` Trip. No JSX — independently testable, same
 * split as useTripPlanner.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import { searchDestinationAutocomplete } from '../services/maps';
import type { PlaceAutocompleteSuggestion } from '../services/maps';
import { addTrip } from '../services/firestore';
import { downloadTripArea } from '../services/tripDownload';
import { deleteTripAreaPlaces } from '../services/habitatCache';
import { computeOffGridExpiresAt, OFFGRID_AREA_RADIUS_M } from '../services/offGrid';
import type { OffGridDurationKey } from '../services/offGrid';
import { getCurrentPosition } from '../services/geolocation';
import { useToastStore } from '../store/toastStore';
import { todayISO, formatLocalTime } from '../utils/date';
import { COPY } from '../constants/copy';

const AUTOCOMPLETE_DEBOUNCE_MS = 300;

export interface ResolvedOffGridDestination {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
}

export interface OffGridWindowState {
  duration: OffGridDurationKey | null;
  setDuration: (d: OffGridDurationKey) => void;
  pickedTime: number | undefined;
  setPickedTime: (ms: number | undefined) => void;

  /** "Somewhere else?" override — null means "use my current location" (the default). */
  destinationOverride: ResolvedOffGridDestination | null;
  destinationQuery: string;
  setDestinationQuery: (q: string) => void;
  destinationSuggestions: PlaceAutocompleteSuggestion[];
  destinationSearching: boolean;
  selectDestinationOverride: (s: PlaceAutocompleteSuggestion) => Promise<void>;
  clearDestinationOverride: () => void;

  confirming: boolean;
  error: string | null;
  canConfirm: boolean;
  confirm: () => Promise<void>;
}

export function useOffGridWindow(onDone: () => void): OffGridWindowState {
  const uid = getAuth().currentUser?.uid ?? '';

  const [duration, setDuration] = useState<OffGridDurationKey | null>(null);
  const [pickedTime, setPickedTime] = useState<number | undefined>(undefined);

  const [destinationOverride, setDestinationOverride] = useState<ResolvedOffGridDestination | null>(null);
  const [destinationQuery, setDestinationQuery] = useState('');
  const [destinationSuggestions, setDestinationSuggestions] = useState<PlaceAutocompleteSuggestion[]>([]);
  const [destinationSearching, setDestinationSearching] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const justSelectedRef = useRef(false);

  useEffect(() => {
    if (justSelectedRef.current) { justSelectedRef.current = false; return; }
    if (!destinationQuery.trim()) { setDestinationSuggestions([]); setDestinationSearching(false); return; }

    const timer = setTimeout(() => {
      setDestinationSearching(true);
      searchDestinationAutocomplete(destinationQuery.trim())
        .then(setDestinationSuggestions)
        .catch(() => setDestinationSuggestions([]))
        .finally(() => setDestinationSearching(false));
    }, AUTOCOMPLETE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [destinationQuery]);

  const selectDestinationOverride = useCallback(async (s: PlaceAutocompleteSuggestion) => {
    justSelectedRef.current = true;
    setDestinationQuery(s.name);
    setDestinationSuggestions([]);

    if (s.lat == null || s.lng == null) { return; }
    setDestinationOverride({ placeId: s.placeId, name: s.name, lat: s.lat, lng: s.lng });
  }, []);

  const clearDestinationOverride = useCallback(() => {
    setDestinationOverride(null);
    setDestinationQuery('');
    setDestinationSuggestions([]);
  }, []);

  const canConfirm = duration !== null && !!uid && !confirming;

  const confirm = useCallback(async () => {
    if (!duration || !uid || confirming) { return; }

    setConfirming(true);
    setError(null);

    let cacheAreaId: string | null = null;
    try {
      const center = destinationOverride
        ? { lat: destinationOverride.lat, lng: destinationOverride.lng }
        : await getCurrentPosition().then(c => ({ lat: c.lat, lng: c.lng }));

      const expiresAt = computeOffGridExpiresAt(duration, pickedTime);
      cacheAreaId = `og_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await downloadTripArea(center, OFFGRID_AREA_RADIUS_M, cacheAreaId, expiresAt);

      await addTrip(uid, {
        destination: destinationOverride?.name ?? COPY.offGrid.currentAreaLabel,
        placeRef:    destinationOverride?.placeId ?? '',
        centerLat:   center.lat,
        centerLng:   center.lng,
        // startDate only, no endDate — an off-grid window is hours-long, not
        // day-level like a trip's dates. This also keeps it off the Calendar
        // for free: CalendarScreen's datedTrips filter requires both fields,
        // and off-grid never should appear there ("nobody plans 'now' on a
        // calendar" — KAN-246).
        startDate:   todayISO(),
        areaRadius:  OFFGRID_AREA_RADIUS_M,
        cacheAreaId,
        expiresAt,
        kind:        'offgrid',
      });

      useToastStore.getState().showToast(COPY.offGrid.confirmToast(formatLocalTime(expiresAt)));
      onDone();
    } catch (err) {
      console.warn('[useOffGridWindow] confirm failed', err);
      if (cacheAreaId) { deleteTripAreaPlaces(cacheAreaId); } // sync, never throws — see habitatCache.ts
      setError(COPY.offGrid.errorToast);
    } finally {
      setConfirming(false);
    }
  }, [duration, uid, confirming, destinationOverride, pickedTime, onDone]);

  return {
    duration, setDuration,
    pickedTime, setPickedTime,
    destinationOverride, destinationQuery, setDestinationQuery,
    destinationSuggestions, destinationSearching, selectDestinationOverride, clearDestinationOverride,
    confirming, error, canConfirm, confirm,
  };
}
