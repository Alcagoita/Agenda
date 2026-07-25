/**
 * useLanternState — KAN-301
 *
 * Wires the pure Lantern resolver (utils/lantern) to live inputs: the proximity
 * engine's mall/trip context, the last-known position, connectivity, the stored
 * home anchor (services/home, KAN-247), and a reverse-geocoded city name for
 * the Outside state.
 *
 * Position, POI-independent (KAN-301 review): the Lantern's home/outside
 * resolution must not depend on POI tasks existing — a user standing in their
 * own kitchen with nothing to brush still needs to read "Home". The proximity
 * engine only searches (and thus only reports `coords`) when there are open POI
 * tasks, so this hook takes its OWN one-shot low-accuracy fix when `coords` is
 * null and permission is granted. One read, no watcher, no interval (KAN-231);
 * it never fires again once any position is known. Until a fix exists the
 * resolver holds `locating` rather than guessing Outside.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { PlaceContext } from '../services/proximity';
import { distanceFromHome, getHomeLocation } from '../services/home';
import { reverseGeocode } from '../services/maps';
import { getPositionLowAccuracy } from '../services/geolocation';
import { useOfflineCoverage } from './useOfflineCoverage';
import { resolveLanternState, HOME_ENTER_M, type LanternState } from '../utils/lantern';
import { todayISO } from '../utils/date';

export interface LanternCoords { lat: number; lng: number; }

export function useLanternState(
  placeContext: PlaceContext | null,
  coords: LanternCoords | null,
  permissionGranted: boolean,
): LanternState {
  const { offline } = useOfflineCoverage();
  const wasHomeRef = useRef(false);
  const [cityName, setCityName] = useState<string | null>(null);
  const [seedCoords, setSeedCoords] = useState<LanternCoords | null>(null);

  // The engine's search coords when it has them (POI tasks present); otherwise
  // our own one-shot seed. Engine coords win so a moving user stays fresh.
  const effectiveCoords = coords ?? seedCoords;

  // One-shot position seed — only when we have no fix at all and permission is
  // granted. Re-runs when those change but early-returns once a fix exists, so
  // it can never become a watcher or a poll.
  useEffect(() => {
    if (effectiveCoords || !permissionGranted) { return; }
    let cancelled = false;
    getPositionLowAccuracy()
      .then(pos => { if (!cancelled && pos) { setSeedCoords({ lat: pos.lat, lng: pos.lng }); } })
      .catch(() => { /* no fix — resolver stays in `locating` */ });
    return () => { cancelled = true; };
  }, [effectiveCoords, permissionGranted]);

  // Re-seed on foreground. The seed above runs once and then holds forever, so
  // without this a no-POI-task user (whom the engine never supplies coords for)
  // would keep yesterday's fix after reopening the app. Clearing seedCoords on
  // a background→active transition lets the effect above take exactly one fresh
  // read — still no watcher, no interval (KAN-231). A no-op when the engine has
  // coords: effectiveCoords stays non-null, so the seed effect early-returns.
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') { setSeedCoords(null); }
    });
    return () => sub.remove();
  }, []);

  const home = getHomeLocation();
  const homeSet = home != null;
  // null = position not known yet → the resolver holds `locating` (never Outside).
  const homeDistanceM: number | null =
    homeSet && effectiveCoords ? distanceFromHome(effectiveCoords) : null;

  // Fetch a city name only when it will actually be shown: online, a real fix,
  // no mall/trip context, home set, and beyond the home-enter radius.
  const wantCity =
    !offline && effectiveCoords != null && placeContext == null && homeSet &&
    homeDistanceM != null && homeDistanceM > HOME_ENTER_M;

  useEffect(() => {
    if (!wantCity || !effectiveCoords) { setCityName(null); return; }
    let cancelled = false;
    reverseGeocode(effectiveCoords.lat, effectiveCoords.lng).then(name => {
      if (!cancelled) { setCityName(name); }
    });
    return () => { cancelled = true; };
  }, [wantCity, effectiveCoords]);

  const state = resolveLanternState({
    placeContext,
    todayIso: todayISO(),
    homeSet,
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
