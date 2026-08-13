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
import { getLastPoiSearchState, NEARBY_RADIUS } from '../services/proximity';
import { distanceFromHome, getHomeLocation } from '../services/home';
import { reverseGeocode } from '../services/maps';
import { getPositionLowAccuracy } from '../services/geolocation';
import { useOfflineCoverage } from './useOfflineCoverage';
import { resolveLanternState, resolveHomeProximity, resolveOfflineDot, type LanternState } from '../utils/lantern';
import { todayISO } from '../utils/date';

export interface LanternCoords { lat: number; lng: number; }

/** Once locating shows, keep it visible this long so a fast fix can't flash it. */
export const LOCATING_MIN_MS = 400;
/** No fix within this long → fall through from `locating` to `unavailable`. */
export const LOCATING_CEILING_MS = 10_000;

export function useLanternState(
  placeContext: PlaceContext | null,
  coords: LanternCoords | null,
  permissionGranted: boolean,
): LanternState {
  const wasHomeRef = useRef(false);
  const [cityName, setCityName] = useState<string | null>(null);
  const [seedCoords, setSeedCoords] = useState<LanternCoords | null>(null);

  // The engine's search coords when it has them (POI tasks present); otherwise
  // our own one-shot seed. Engine coords win so a moving user stays fresh.
  const effectiveCoords = coords ?? seedCoords;

  // KAN-316 — `knowsHere` asks the cache about THIS position, within the same
  // radius the Nearby list uses, so the dot means "there is cached ground where
  // you're standing", not "the cache has something, somewhere".
  const { offline, knowsHere } = useOfflineCoverage(effectiveCoords, NEARBY_RADIUS);

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

  // The last search's own verdict on this location — read at render, not
  // stored: this hook re-runs whenever the Today screen re-renders (a search
  // tick, a connectivity change, a new fix), so a plain read stays in step with
  // it without a watcher, an interval or a subscription (KAN-231). Only its
  // refusals matter here — see resolveOfflineDot.
  const { source, coverageStatus } = getLastPoiSearchState();
  const offlineDot = resolveOfflineDot({ offline, knowsHere, source, coverageStatus });

  const state = resolveLanternState({
    placeContext,
    todayIso: todayISO(),
    homeSet,
    homeDistanceM,
    wasHome: wasHomeRef.current,
    cityName,
    offline,
    offlineDot,
  });

  // ── Locating / unavailable timing (KAN-301 review) ──────────────────────────
  // The resolver returns `locating` while home is set but no fix exists. We
  // never render an empty block, but we also don't want to flash "Looking
  // around…" for a warm start (coords already present → `state` is a real state,
  // so we're never waiting). While genuinely waiting for the FIRST fix:
  //   • hold `locating` at least LOCATING_MIN_MS so a fast fix can't flash it,
  //   • fall through to `unavailable` after LOCATING_CEILING_MS,
  //   • never regress once any real state has resolved (a later coord loss holds
  //     the last resolved state instead of blinking back to locating).
  const resolvedOnceRef = useRef(false);
  const lastRealRef = useRef<LanternState | null>(null);
  const locatingStartRef = useRef<number | null>(null);
  const isReal = state.kind !== 'locating';
  if (isReal) { resolvedOnceRef.current = true; lastRealRef.current = state; }
  const waiting = !isReal && !resolvedOnceRef.current;

  const [waitPhase, setWaitPhase] = useState<'none' | 'locating' | 'unavailable'>(
    () => (state.kind === 'locating' ? 'locating' : 'none'),
  );

  useEffect(() => {
    if (waiting) {
      if (locatingStartRef.current == null) { locatingStartRef.current = Date.now(); }
      setWaitPhase('locating');
      const ceiling = setTimeout(() => setWaitPhase('unavailable'), LOCATING_CEILING_MS);
      return () => clearTimeout(ceiling);
    }
    // Not waiting (a real fix arrived, or we never waited). If locating was on
    // screen, keep it until the min-visible floor elapses; otherwise drop it now.
    if (locatingStartRef.current != null) {
      const remaining = LOCATING_MIN_MS - (Date.now() - locatingStartRef.current);
      locatingStartRef.current = null;
      if (remaining > 0) {
        const floor = setTimeout(() => setWaitPhase('none'), remaining);
        return () => clearTimeout(floor);
      }
    }
    setWaitPhase('none');
  }, [waiting]);

  const display: LanternState =
    waitPhase === 'unavailable' ? { kind: 'unavailable' }
      : waitPhase === 'locating' ? { kind: 'locating' }
        : isReal ? state
          : (lastRealRef.current ?? { kind: 'locating' });

  // Track the RAW home-proximity buffer independently of the rendered state
  // (KAN-301 review): a mall/trip override must not clear it, or leaving that
  // context while still inside the 200 m leave threshold would wrongly flip to
  // Outside. When the position is unknown, hold the previous value.
  const homeProximity = homeDistanceM != null
    ? resolveHomeProximity(homeDistanceM, wasHomeRef.current)
    : wasHomeRef.current;
  useEffect(() => {
    wasHomeRef.current = homeProximity;
  });

  // Fetch a city name only when the resolved state is actually Outside — this
  // respects the hysteresis band (no wasted geocode while the buffer still
  // reads Home) and skips it entirely for mall/trip/home/locating/unset.
  const wantCity = state.kind === 'outside' && !offline && effectiveCoords != null;

  useEffect(() => {
    if (!wantCity || !effectiveCoords) { setCityName(null); return; }
    // Clear the previous city before the replacement request so a move to a new
    // area never briefly shows the old area's name (it reads "Outside" until the
    // new lookup lands).
    setCityName(null);
    let cancelled = false;
    reverseGeocode(effectiveCoords.lat, effectiveCoords.lng).then(name => {
      if (!cancelled) { setCityName(name); }
    });
    return () => { cancelled = true; };
  }, [wantCity, effectiveCoords]);

  return display;
}
