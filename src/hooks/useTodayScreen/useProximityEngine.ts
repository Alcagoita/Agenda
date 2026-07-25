/**
 * useProximityEngine — KAN-59 / KAN-214
 *
 * Owns every location-driven engine on the Today screen: location permission,
 * battery-aware refresh on foreground, outdoor proximity search (KAN-24/53),
 * indoor detection + Store fine tuning (KAN-73/74/75), and the resulting
 * "nearby" state (poiType/place/places) that either engine may produce.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { setStoreTuningPref } from '../../services/firestore';
import { requestLocationPermission } from '../../services/geolocation';
import type { LocationContext } from '../../services/geolocation';
import {
  runProximitySearch,
  runProximitySearchOrReuseSnapshot,
  getLastSearchCoords,
  setLocationTap,
  setPlaceContextTap,
  setNavigateToTripPlanner,
} from '../../services/proximity';
import type { PlacesMap, PlaceContext } from '../../services/proximity';
import { navigateTo } from '../../navigation/navigationRef';
import { getDistanceMeters } from '../../services/maps';
import type { NearbyPlace } from '../../services/maps';
import {
  startIndoorProximityMonitoring,
  stopIndoorProximityMonitoring,
  updateIndoorTasks,
} from '../../services/indoorProximity';
import { startIndoorDetection, feedLocation } from '../../services/indoorDetection';
import {
  startStoreTuning,
  onLocationContextChange,
  activateStoreTuning,
  dismissStoreTuning,
} from '../../services/storeTuning';
import { getBatteryLevel, useBatteryLevel } from '../../services/battery';
import type { StoreTuningState, Task } from '../../types';
import { DEBUG_DISABLE_BACKGROUND } from './debugFlags';

export interface ProximityEngine {
  permissionGranted:  boolean;
  /** True once the Nearby list reflects a real, settled outcome — either a
   *  proximity search has completed (success or failure), or there was
   *  never going to be one (no POI tasks, permission denied, Store tuning
   *  active). False while a first search is genuinely in flight. Anything
   *  derived from poiPlaces (far-away arrows, "one trip for all of these")
   *  must gate on this — showing it against the {} default before the real
   *  list lands means it can vanish moments later with no explanation. */
  nearbyReady:        boolean;
  nearbyPoiType:      string | null;
  /** Mirror of nearbyPoiType for stable callbacks (e.g. useTaskCompletion). */
  nearbyPoiTypeRef:   React.RefObject<string | null>;
  nearbyPlace:        NearbyPlace | null;
  /** Mirror of nearbyPlace for stable callbacks (e.g. useTaskCompletion, KAN-226). */
  nearbyPlaceRef:     React.RefObject<NearbyPlace | null>;
  poiPlaces:          PlacesMap;
  /** Mall/trip context for the last position fix (KAN-242) — feeds the header ContextChip / Lantern. */
  placeContext:       PlaceContext;
  /** Last settled-search position (KAN-301) — feeds the Lantern's home/outside
   *  resolution. Reuses the existing 200 m / 3-min search cadence, so it costs
   *  no new location watcher; seeded once on permission grant for users with no
   *  POI tasks (who never trigger a proximity search). Null before any fix. */
  coords:             { lat: number; lng: number } | null;
  locationUnavailable: boolean;
  storeTuningActive:      boolean;
  showStoreTuningPrompt:  boolean;
  onStoreTuningTurnOn:    () => void;
  onStoreTuningNotNow:    () => void;
  refreshProximity:   () => Promise<boolean>;
}

export function useProximityEngine(
  uid: string | undefined,
  tasks: Task[],
  latestTasksRef: React.RefObject<Task[]>,
  lowBatteryPausePref: boolean,
  storeTuningEnabled: boolean | undefined,
): ProximityEngine {
  const [permissionGranted, setPermissionGranted] = useState(false);
  const permissionGrantedRef = useRef(false);
  useEffect(() => { permissionGrantedRef.current = permissionGranted; }, [permissionGranted]);

  // Mirrors for the AppState handler below (empty-deps effect — can't close
  // over current values directly). KAN-285 follow-up: app foreground/resume
  // (including an emulator/OS process restart after a low-memory kill, which
  // looks identical to a normal background→foreground transition) must go
  // through the same 500m/POI-type-set gate as every other automatic check,
  // not call the raw unconditional search.
  const uidRef               = useRef<string | undefined>(uid);
  const hasPOITasksRef       = useRef(false);
  const isStoreTuningActiveRef = useRef(false);
  useEffect(() => { uidRef.current = uid; }, [uid]);

  // ── Nearby-list readiness (see ProximityEngine.nearbyReady doc) ────────────
  const [permissionChecked, setPermissionChecked] = useState(DEBUG_DISABLE_BACKGROUND);
  const [hasCompletedScan,  setHasCompletedScan]  = useState(false);

  /** True while a proximity search Promise is in-flight. */
  const isSearchingRef    = useRef(false);

  const [nearbyPoiType,       setNearbyPoiType]       = useState<string | null>(null);
  const nearbyPoiTypeRef = useRef<string | null>(null);
  const [nearbyPlace,         setNearbyPlace]         = useState<NearbyPlace | null>(null);
  const nearbyPlaceRef = useRef<NearbyPlace | null>(null);
  const [poiPlaces,           setPoiPlaces]           = useState<PlacesMap>({});
  const [placeContext,        setPlaceContext]        = useState<PlaceContext>(null);
  const [coords,              setCoords]              = useState<{ lat: number; lng: number } | null>(null);
  const [locationUnavailable, setLocationUnavailable] = useState(false);

  // ── Battery level (KAN-52) — read on foreground only; not used for pausing ──

  const hookBatteryLevel = useBatteryLevel();
  const [batteryLevel, setBatteryLevel] = useState(hookBatteryLevel);
  useEffect(() => { setBatteryLevel(hookBatteryLevel); }, [hookBatteryLevel]);
  useEffect(() => {
    if (DEBUG_DISABLE_BACKGROUND) { return; }
    const sub = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active') {
        setBatteryLevel(await getBatteryLevel());
        if (permissionGrantedRef.current) {
          // Foregrounding (including an OS-level process resume after a
          // low-memory kill, which fires this exact same 'active' event —
          // not a fresh cold start the snapshot-reuse gate wouldn't see)
          // must go through the same gate as every other automatic check:
          // reuse the persisted snapshot unless the position moved >500m or
          // the POI-type set changed. The user's own "refresh location" tap
          // (NearbyCard's onRefreshLocation, wired straight to the
          // refreshProximity this hook returns) is unaffected — that's an
          // explicit request, always real, never routed through this gate.
          const uidNow = uidRef.current;
          if (uidNow && hasPOITasksRef.current && !isStoreTuningActiveRef.current) {
            runProximitySearchOrReuseSnapshot(uidNow, latestTasksRef.current, onNearbyUpdateRef.current)
              .catch(() => setLocationUnavailable(true));
          }
        } else {
          // Re-check in case the user granted permission in Settings while away.
          requestLocationPermission()
            .then(status => { if (status === 'granted') { setPermissionGranted(true); } })
            .catch(() => {});
        }
      }
    });
    return () => sub.remove();
  }, []);

  // ── Store fine tuning (KAN-74 / KAN-75) ────────────────────────────────────

  const [storeTuningState,   setStoreTuningState]    = useState<StoreTuningState>('off');
  const [locationContext,    setLocationContext]      = useState<LocationContext>('outdoor');

  const isIndoorMonitoringRef   = useRef(false);
  const stopIndoorMonitoringRef = useRef<(() => void) | null>(null);
  const positionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Location permission (KAN-53) ──────────────────────────────────────────

  useEffect(() => {
    if (DEBUG_DISABLE_BACKGROUND) { return; }
    if (!uid) { return; }
    requestLocationPermission().then(status => {
      if (status === 'granted') { setPermissionGranted(true); }
    }).catch(err => {
      console.warn('[useTodayScreen] location permission error', err);
    }).finally(() => setPermissionChecked(true));
  }, [uid]);

  // ── Indoor detection + store tuning (KAN-73 / KAN-74) ─────────────────────

  useEffect(() => {
    if (!uid || !permissionGranted) { return; }

    const stopDetection = startIndoorDetection((ctx) => {
      setLocationContext(ctx);
    });

    const stopTuning = startStoreTuning({
      onStateChange: setStoreTuningState,
      onLowBatterySuppress: () => {},
    });

    setLocationTap((lat, lng, accuracy) => { feedLocation(lat, lng, accuracy); });
    setPlaceContextTap(setPlaceContext);
    setNavigateToTripPlanner(() => navigateTo('TripPlanner'));

    return () => {
      setLocationTap(null);
      setPlaceContextTap(null);
      setNavigateToTripPlanner(null);
      stopTuning();
      stopDetection();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, permissionGranted]);

  useEffect(() => {
    if (!uid || !permissionGranted) { return; }
    onLocationContextChange(
      locationContext,
      storeTuningEnabled,
      lowBatteryPausePref,
      batteryLevel,
    );
  }, [uid, permissionGranted, locationContext, storeTuningEnabled, lowBatteryPausePref, batteryLevel]);

  // ── Derived: are there any undone POI tasks? ───────────────────────────────

  const hasPOITasks = useMemo(
    () => tasks.some(t => !t.done && t.poi),
    [tasks],
  );
  useEffect(() => { hasPOITasksRef.current = hasPOITasks; }, [hasPOITasks]);

  const isStoreTuningActive = storeTuningState === 'active';
  useEffect(() => { isStoreTuningActiveRef.current = isStoreTuningActive; }, [isStoreTuningActive]);

  // ── Stable onUpdate callback ───────────────────────────────────────────────

  const onNearbyUpdate = useCallback(
    (poiType: string | null, place: NearbyPlace | null, allPlaces: PlacesMap) => {
      nearbyPoiTypeRef.current = poiType;
      setNearbyPoiType(poiType);
      nearbyPlaceRef.current = place;
      setNearbyPlace(place);
      setPoiPlaces(allPlaces);
      setLocationUnavailable(false);
      setHasCompletedScan(true);
      // KAN-301 — capture the position this scan ran against for the Lantern's
      // home/outside resolution. getLastSearchCoords() is set by the search
      // that just fired this callback, so it's the fresh fix.
      const searchCoords = getLastSearchCoords();
      if (searchCoords) { setCoords(searchCoords); }
    },
    [],
  );
  const onNearbyUpdateRef = useRef(onNearbyUpdate);
  useEffect(() => { onNearbyUpdateRef.current = onNearbyUpdate; }, [onNearbyUpdate]);

  // ── Outdoor proximity lifecycle (KAN-24 / KAN-53) ─────────────────────────

  useEffect(() => {
    if (!uid || !permissionGranted || !hasPOITasks || isStoreTuningActive) {
      if (!hasPOITasks || isStoreTuningActive) {
        nearbyPoiTypeRef.current = null;
        setNearbyPoiType(null);
        nearbyPlaceRef.current = null;
        setNearbyPlace(null);
        setPoiPlaces({});
        // Otherwise the header ContextChip keeps showing a mall/trip context
        // from the last tick before the engine stopped searching (KAN-242
        // review fix) — e.g. the user's last POI task got completed while
        // inside a mall, and the chip would freeze there indefinitely.
        setPlaceContext(null);
        // No POI tasks (or Store tuning owns the nearby state instead) means
        // there was never a search to wait for — {} is already the settled,
        // correct answer.
        setHasCompletedScan(true);
      }
      return;
    }

    const onSearchError = () => { setLocationUnavailable(true); setHasCompletedScan(true); };

    // A fresh check is starting for this uid/permission/POI-tasks
    // combination — the readiness flag from any previous combination (e.g.
    // "no POI tasks" settling to ready=true) no longer applies. This is the
    // automatic entry point (mount / permission just granted / POI tasks
    // just appeared) — KAN-285: reuse a persisted snapshot instead of
    // re-hitting the Places API when the position hasn't moved and the POI
    // type set hasn't changed since the last time this ran.
    setHasCompletedScan(false);
    runProximitySearchOrReuseSnapshot(uid, latestTasksRef.current, onNearbyUpdate).catch(onSearchError);

    positionTimerRef.current = setInterval(async () => {
      try {
        const fix = await (await import('../../services/geolocation')).getPositionLowAccuracy();
        const last = getLastSearchCoords();
        if (!last) {
          runProximitySearch(uid, latestTasksRef.current, onNearbyUpdate).catch(onSearchError);
          return;
        }
        const moved = getDistanceMeters(fix.lat, fix.lng, last.lat, last.lng);
        if (moved >= 200) {
          runProximitySearch(uid, latestTasksRef.current, onNearbyUpdate).catch(onSearchError);
        }
      } catch { setLocationUnavailable(true); }
    }, 3 * 60 * 1_000);

    return () => {
      if (positionTimerRef.current) {
        clearInterval(positionTimerRef.current);
        positionTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, permissionGranted, hasPOITasks, isStoreTuningActive, onNearbyUpdate]);

  // ── Re-check when tasks actually change (KAN-285 follow-up) ────────────────
  //
  // `tasks` only gets a new array reference when TodayScreen's focus effect
  // decided a real mutation happened somewhere (taskMutationSignal) and
  // called refresh() — reacting to its identity here is a reliable "did
  // something change" signal, not a guess, and it fires for ANY kind of
  // change (added, removed, completed, or a task's POI type edited — e.g.
  // on CalendarScreen), not just a count increase.
  //
  // Delegates the "is a real Places API call actually needed" decision to
  // runProximitySearchOrReuseSnapshot's own POI-type-set/500m gate rather
  // than re-deriving that here — a previous version of this effect only
  // compared undone-POI counts, which missed a same-count POI-type swap
  // entirely (e.g. changing a task's category from pharmacy to cafe left
  // the Nearby zone searching for the wrong type until the next unrelated
  // recheck).
  const isFirstTasksIdentityRef = useRef(true);
  useEffect(() => {
    if (isFirstTasksIdentityRef.current) { isFirstTasksIdentityRef.current = false; return; }
    if (!uid || !permissionGranted || !hasPOITasks || isStoreTuningActive) { return; }
    setHasCompletedScan(false);
    runProximitySearchOrReuseSnapshot(uid, tasks, onNearbyUpdate).catch(() => setLocationUnavailable(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // ── Indoor proximity engine lifecycle (KAN-75) ─────────────────────────────

  useEffect(() => {
    if (!uid || !permissionGranted) { return; }

    if (!isStoreTuningActive) {
      if (isIndoorMonitoringRef.current) {
        stopIndoorMonitoringRef.current?.();
        stopIndoorMonitoringRef.current = null;
        stopIndoorProximityMonitoring();
        isIndoorMonitoringRef.current = false;
      }
      return;
    }

    if (!isIndoorMonitoringRef.current) {
      const stop = startIndoorProximityMonitoring(
        uid,
        tasks,
        (task, place) => {
          nearbyPoiTypeRef.current = task?.poi ?? null;
          setNearbyPoiType(task?.poi ?? null);
          nearbyPlaceRef.current = place;
          setNearbyPlace(place);
          // Populate poiPlaces so NearbyCard heroEntries computation can find
          // the indoor match (it derives hero cards from poiPlaces, not nearbyPlace).
          setPoiPlaces(task?.poi && place ? { [task.poi]: [place] } : {});
        },
      );
      isIndoorMonitoringRef.current   = true;
      stopIndoorMonitoringRef.current = stop;
    }

    return () => {
      stopIndoorMonitoringRef.current?.();
      stopIndoorMonitoringRef.current = null;
      isIndoorMonitoringRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, permissionGranted, isStoreTuningActive]);

  useEffect(() => {
    if (!isIndoorMonitoringRef.current) { return; }
    updateIndoorTasks(tasks);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // ── Store tuning handlers ───────────────────────────────────────────────────

  const onStoreTuningTurnOn = useCallback(() => {
    activateStoreTuning();
    if (uid) {
      setStoreTuningPref(uid, true).catch(() => {});
    }
  }, [uid]);

  const onStoreTuningNotNow = useCallback(() => { dismissStoreTuning(); }, []);

  // ── Manual proximity refresh ────────────────────────────────────────────────

  const refreshProximity = useCallback(async (): Promise<boolean> => {
    if (!uid || !permissionGranted || !hasPOITasks || isStoreTuningActive) { return false; }
    try {
      await runProximitySearch(uid, latestTasksRef.current, onNearbyUpdate);
      return true;
    } catch {
      setLocationUnavailable(true);
      return false;
    }
  }, [uid, permissionGranted, hasPOITasks, isStoreTuningActive, onNearbyUpdate]);

  // KAN-301 — seed the Lantern's position once on permission grant. A user with
  // no POI tasks never triggers a proximity search (the outdoor lifecycle above
  // is gated on hasPOITasks), so onNearbyUpdate would never fire and `coords`
  // would stay null forever, leaving the Lantern unable to tell Home from
  // Outside. One low-accuracy fix, no watcher, no polling (KAN-231).
  useEffect(() => {
    if (DEBUG_DISABLE_BACKGROUND) { return; }
    if (!permissionGranted) { return; }
    let cancelled = false;
    (async () => {
      try {
        const { getPositionLowAccuracy } = await import('../../services/geolocation');
        const pos = await getPositionLowAccuracy();
        if (!cancelled && pos) { setCoords(prev => prev ?? { lat: pos.lat, lng: pos.lng }); }
      } catch { /* no fix — the Lantern falls back to its home-set/unset default */ }
    })();
    return () => { cancelled = true; };
  }, [permissionGranted]);

  // Settled once permission is known AND either nothing was ever going to
  // search (no permission, no POI tasks, Store tuning owns it instead) or a
  // real search attempt has completed.
  const nearbyReady = permissionChecked && (!permissionGranted || !hasPOITasks || isStoreTuningActive || hasCompletedScan);

  return {
    permissionGranted,
    nearbyReady,
    nearbyPoiType,
    nearbyPoiTypeRef,
    nearbyPlace,
    nearbyPlaceRef,
    poiPlaces,
    placeContext,
    coords,
    locationUnavailable,
    storeTuningActive: isStoreTuningActive,
    showStoreTuningPrompt: storeTuningState === 'prompt_shown',
    onStoreTuningTurnOn,
    onStoreTuningNotNow,
    refreshProximity,
  };
}
