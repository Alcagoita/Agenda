/**
 * useLanternState — KAN-301
 *
 * Wires the pure Lantern resolver (utils/lantern) to live inputs: the proximity
 * engine's mall/trip context, the last-known position, connectivity, the stored
 * home anchor (services/home, KAN-247), and a reverse-geocoded city name for
 * the Outside state.
 *
 * No new location watchers (KAN-231): `coords` is the proximity engine's own
 * settled-search position, already gated behind its 200 m / 3-minute recompute
 * rule, so the home-boundary hysteresis and the city lookup ride that cadence
 * for free. The city lookup is further gated to fire ONLY when the resolved
 * state will actually be Outside-with-a-name — every other state shows a fixed
 * word, so a geocode there would be a wasted request.
 */
import { useEffect, useRef, useState } from 'react';
import type { PlaceContext } from '../services/proximity';
import { distanceFromHome, getHomeLocation } from '../services/home';
import { reverseGeocode } from '../services/maps';
import { useOfflineCoverage } from './useOfflineCoverage';
import { resolveLanternState, HOME_ENTER_M, type LanternState } from '../utils/lantern';
import { todayISO } from '../utils/date';

export interface LanternCoords { lat: number; lng: number; }

export function useLanternState(
  placeContext: PlaceContext,
  coords: LanternCoords | null,
): LanternState {
  const { offline } = useOfflineCoverage();
  const wasHomeRef = useRef(false);
  const [cityName, setCityName] = useState<string | null>(null);

  const home = getHomeLocation();
  // No home stored → unset. Home stored but no fix yet → Infinity, so we read
  // as Outside (never falsely "Where's home?"). Otherwise the real distance.
  const homeDistanceM: number | null =
    home == null ? null : (coords == null ? Infinity : distanceFromHome(coords));

  // Fetch a city name only when it will actually be shown: online, a real fix,
  // no mall/trip context, home set, and beyond the home-enter radius.
  const wantCity =
    !offline && coords != null && placeContext == null && home != null &&
    (homeDistanceM as number) > HOME_ENTER_M;

  useEffect(() => {
    if (!wantCity || !coords) { setCityName(null); return; }
    let cancelled = false;
    reverseGeocode(coords.lat, coords.lng).then(name => {
      if (!cancelled) { setCityName(name); }
    });
    return () => { cancelled = true; };
  }, [wantCity, coords]);

  const state = resolveLanternState({
    placeContext,
    todayIso: todayISO(),
    homeDistanceM,
    wasHome: wasHomeRef.current,
    cityName,
    offline,
  });

  // Feed this render's outcome back into the hysteresis buffer for the next one.
  useEffect(() => {
    wasHomeRef.current = state.kind === 'home';
  });

  return state;
}
