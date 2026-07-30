/**
 * useTripPlanner — KAN-234
 *
 * State/logic for the Trip Planner flow: destination search → optional
 * dates → radius + size estimate → download. No JSX — independently
 * testable, matching the rest of this codebase's screen/hook split.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import {
  searchDestinationAutocomplete,
  getPlaceDetails,
  buildStaticMapPreviewUrl,
} from '../services/maps';
import type { PlaceAutocompleteSuggestion } from '../services/maps';
import { addTrip, getCategories, getTrip, updateTrip } from '../services/firestore';
import {
  downloadTripArea,
  computeTripExpiresAt,
  estimateTripDownloadBytes,
  getAreaDownloadPoiTypes,
  TRIP_RADIUS_PRESETS,
} from '../services/tripDownload';
import { deleteTripAreaPlaces } from '../services/habitatCache';
import type { TripRadiusPreset } from '../types';
import { useToastStore } from '../store/toastStore';
import { COPY } from '../constants/copy';
import type { Trip } from '../types';

export type TripPlannerStep = 'destination' | 'dates' | 'radius' | 'downloading';

/** Route params are an input boundary — validates a YYYY-MM-DD string (format + real calendar date) before it ever reaches DateTimePicker/formatters. */
function isValidIsoDate(iso: string | undefined): iso is string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) { return false; }
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

const AUTOCOMPLETE_DEBOUNCE_MS = 300;

/** Static map preview frame size — exported so the screen's circle overlay can size itself to match (see maps.ts's buildStaticMapPreviewUrl, which zooms the map to keep the circle at a fixed fraction of this frame regardless of which radius preset is selected). */
export const TRIP_PREVIEW_WIDTH = 320;
export const TRIP_PREVIEW_HEIGHT = 200;
const PREVIEW_WIDTH = TRIP_PREVIEW_WIDTH;
const PREVIEW_HEIGHT = TRIP_PREVIEW_HEIGHT;

export interface ResolvedDestination {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
}

export interface TripPlannerEditOptions {
  editTripId: string;
  initialStep: 'dates' | 'radius';
}

export interface TripPlannerState {
  step: TripPlannerStep;

  query: string;
  setQuery: (q: string) => void;
  suggestions: PlaceAutocompleteSuggestion[];
  selectDestination: (s: PlaceAutocompleteSuggestion) => Promise<void>;
  destination: ResolvedDestination | null;

  startDate: string | undefined;
  endDate: string | undefined;
  setStartDate: (d: string | undefined) => void;
  setEndDate: (d: string | undefined) => void;
  goToRadius: () => void;
  skipDates: () => void;

  radiusKey: TripRadiusPreset;
  setRadiusKey: (k: TripRadiusPreset) => void;
  estimatedBytes: number;
  previewUrl: string;

  confirmDownload: () => Promise<void>;
  error: string | null;
  goBack: () => void;
  isEditing: boolean;
  editInitialStep: 'dates' | 'radius' | null;
}

export function useTripPlanner(
  onDone: () => void,
  initialStartDate?: string,
  initialDestinationQuery?: string,
  editOptions?: TripPlannerEditOptions,
): TripPlannerState {
  const uid = getAuth().currentUser?.uid ?? '';
  const editTripId = editOptions?.editTripId;
  const editInitialStep = editOptions?.initialStep;
  const isEditing = !!editTripId && !!editInitialStep;

  const [step, setStep] = useState<TripPlannerStep>(editInitialStep ?? 'destination');
  // KAN-245 — pre-filled from the calendar signal's free-text event location.
  // Only ever a search-box seed, never a resolved place: the calendar signal
  // deliberately never geocodes (on-device text match only), so there are no
  // coordinates to hand the destination step directly — the user still picks
  // from the resulting autocomplete suggestions, same as typing it manually.
  const [query, setQuery] = useState(initialDestinationQuery?.trim() ?? '');
  const [suggestions, setSuggestions] = useState<PlaceAutocompleteSuggestion[]>([]);
  const [destination, setDestination] = useState<ResolvedDestination | null>(null);
  // Pre-filled when opened from a future Calendar day (KAN-243) — still just
  // the dates step's normal state, so the user can change or clear it same
  // as any other trip.
  const [startDate, setStartDate] = useState<string | undefined>(
    isValidIsoDate(initialStartDate) ? initialStartDate : undefined,
  );
  const [endDate, setEndDate] = useState<string | undefined>(undefined);
  const [radiusKey, setRadiusKey] = useState<TripRadiusPreset>('town_and_around');
  const [error, setError] = useState<string | null>(null);
  const [customCategoryPoiTypes, setCustomCategoryPoiTypes] = useState<string[]>([]);
  const [editingTrip, setEditingTrip] = useState<Trip | null>(null);

  // Set right before selectDestination or edit-mode hydration changes `query`
  // itself, so the debounced effect below can tell those controlled changes
  // apart from "user is typing".
  const justSelectedRef = useRef(false);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!uid) { return; }
    getCategories(uid)
      .then(categories => setCustomCategoryPoiTypes(categories.map(c => c.poi).filter((p): p is string => !!p)))
      .catch(err => console.warn('[useTripPlanner] getCategories failed', err));
  }, [uid]);

  // Debounced destination autocomplete.
  useEffect(() => {
    if (justSelectedRef.current) { justSelectedRef.current = false; return; }
    if (!query.trim()) { setSuggestions([]); return; }

    const timer = setTimeout(() => {
      searchDestinationAutocomplete(query)
        .then(setSuggestions)
        .catch(err => console.warn('[useTripPlanner] searchDestinationAutocomplete failed', err));
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!editTripId || !editInitialStep || !uid) { return; }

    let cancelled = false;
    setError(null);
    setStep(editInitialStep);
    getTrip(uid, editTripId)
      .then(trip => {
        if (cancelled) { return; }
        if (!trip) {
          setError(COPY.tripPlanner.downloadErrorToast);
          useToastStore.getState().showToast(COPY.tripPlanner.downloadErrorToast);
          onDoneRef.current();
          return;
        }
        justSelectedRef.current = true;
        setEditingTrip(trip);
        setQuery(trip.destination);
        setDestination({
          placeId: trip.placeRef,
          name:    trip.destination,
          lat:     trip.centerLat,
          lng:     trip.centerLng,
        });
        setStartDate(trip.startDate);
        setEndDate(trip.endDate);
        setRadiusKey(radiusPresetForMeters(trip.areaRadius));
        setStep(editInitialStep);
      })
      .catch(err => {
        console.warn('[useTripPlanner] getTrip failed', err);
        if (cancelled) { return; }
        setError(COPY.tripPlanner.downloadErrorToast);
        useToastStore.getState().showToast(COPY.tripPlanner.downloadErrorToast);
        onDoneRef.current();
      });

    return () => { cancelled = true; };
  }, [editTripId, editInitialStep, uid]);

  const selectDestination = useCallback(async (suggestion: PlaceAutocompleteSuggestion) => {
    justSelectedRef.current = true;
    setQuery(suggestion.name);
    setSuggestions([]);
    try {
      const details = await getPlaceDetails(suggestion.placeId);
      if (!details) {
        setError(COPY.tripPlanner.downloadErrorToast);
        return;
      }
      setDestination({ placeId: suggestion.placeId, name: details.name, lat: details.lat, lng: details.lng });
      setError(null);
      setStep('dates');
    } catch (err) {
      console.warn('[useTripPlanner] getPlaceDetails failed', err);
      setError(COPY.tripPlanner.downloadErrorToast);
    }
  }, []);

  const goToRadius = useCallback(() => setStep('radius'), []);
  const skipDates = useCallback(() => {
    setStartDate(undefined);
    setEndDate(undefined);
    setStep('radius');
  }, []);

  const preset = TRIP_RADIUS_PRESETS.find(p => p.key === radiusKey) ?? TRIP_RADIUS_PRESETS[1];
  // Matches downloadTripArea's exact allowlist semantics, so the size
  // estimate can't drift from what's actually downloaded.
  const poiTypeCount = getAreaDownloadPoiTypes(customCategoryPoiTypes).length;
  const estimatedBytes = estimateTripDownloadBytes(preset.radiusMeters, poiTypeCount);
  const previewUrl = destination
    ? buildStaticMapPreviewUrl(destination.lat, destination.lng, preset.radiusMeters, PREVIEW_WIDTH, PREVIEW_HEIGHT)
    : '';

  const confirmDownload = useCallback(async () => {
    if (isEditing) {
      if (!editingTrip || !uid) { return; }
      setError(null);

      const expiresAt = computeTripExpiresAt(endDate);
      try {
        if (editInitialStep === 'dates') {
          await updateTrip(uid, editingTrip.id, { startDate, endDate, expiresAt });
          setEditingTrip({ ...editingTrip, startDate, endDate, expiresAt });
          useToastStore.getState().showToast(COPY.tripPlanner.editDatesSuccessToast(editingTrip.destination));
          onDone();
          return;
        }

        const grewArea = preset.radiusMeters > editingTrip.areaRadius;
        const isOnline = (await NetInfo.fetch()).isConnected !== false;

        if (grewArea && isOnline) {
          await downloadTripArea(
            { lat: editingTrip.centerLat, lng: editingTrip.centerLng },
            preset.radiusMeters,
            editingTrip.cacheAreaId,
            expiresAt,
            customCategoryPoiTypes,
          );
          const preRefreshedAt = Date.now();
          await updateTrip(uid, editingTrip.id, {
            areaRadius: preset.radiusMeters,
            expiresAt,
            preRefreshedAt,
          });
          setEditingTrip({ ...editingTrip, areaRadius: preset.radiusMeters, expiresAt, preRefreshedAt });
        } else if (grewArea) {
          await updateTrip(uid, editingTrip.id, { expiresAt });
          setEditingTrip({ ...editingTrip, expiresAt });
        } else {
          await updateTrip(uid, editingTrip.id, { areaRadius: preset.radiusMeters, expiresAt });
          setEditingTrip({ ...editingTrip, areaRadius: preset.radiusMeters, expiresAt });
        }
        useToastStore.getState().showToast(COPY.tripPlanner.editRadiusSuccessToast(editingTrip.destination));
        onDone();
      } catch (err) {
        console.warn('[useTripPlanner] edit failed', err);
        setError(COPY.tripPlanner.downloadErrorToast);
        setStep(editInitialStep ?? 'radius');
      }
      return;
    }

    if (!destination || !uid) { return; }
    setStep('downloading');
    setError(null);

    const cacheAreaId = `ta_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = computeTripExpiresAt(endDate);

    try {
      await downloadTripArea(
        { lat: destination.lat, lng: destination.lng },
        preset.radiusMeters,
        cacheAreaId,
        expiresAt,
        customCategoryPoiTypes,
      );
      try {
        await addTrip(uid, {
          destination: destination.name,
          placeRef: destination.placeId,
          centerLat: destination.lat,
          centerLng: destination.lng,
          startDate,
          endDate,
          areaRadius: preset.radiusMeters,
          cacheAreaId,
          expiresAt,
        });
      } catch (err) {
        // The habitat rows were already written under cacheAreaId — without
        // this rollback they'd be orphaned (never surfaced in "Places I
        // know", never cleaned up, since deletion is normally driven by the
        // Trip doc this addTrip call just failed to create).
        deleteTripAreaPlaces(cacheAreaId);
        throw err;
      }
      useToastStore.getState().showToast(COPY.tripPlanner.downloadSuccessToast(destination.name));
      onDone();
    } catch (err) {
      console.warn('[useTripPlanner] download failed', err);
      setError(COPY.tripPlanner.downloadErrorToast);
      setStep('radius');
    }
  }, [
    isEditing, editingTrip, uid, endDate, startDate, preset.radiusMeters,
    editInitialStep, customCategoryPoiTypes, onDone, destination,
  ]);

  const goBack = useCallback(() => {
    setError(null);
    setStep(prev => {
      if (prev === 'radius') { return 'dates'; }
      if (isEditing && prev === 'dates') { return prev; }
      if (prev === 'dates') { return 'destination'; }
      return prev;
    });
  }, [isEditing]);

  return {
    step,
    query, setQuery, suggestions, selectDestination, destination,
    startDate, endDate, setStartDate, setEndDate, goToRadius, skipDates,
    radiusKey, setRadiusKey, estimatedBytes, previewUrl,
    confirmDownload, error, goBack,
    isEditing, editInitialStep: editInitialStep ?? null,
  };
}

function radiusPresetForMeters(radiusMeters: number): TripRadiusPreset {
  return TRIP_RADIUS_PRESETS.find(p => p.radiusMeters === radiusMeters)?.key ?? 'town_and_around';
}
