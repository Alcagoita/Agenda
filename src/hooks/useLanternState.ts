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
import { getLastKnownPosition, getPositionLowAccuracy } from '../services/geolocation';
import { getCachedAreaName } from '../services/habitatCache';
import { NEARBY_RADIUS } from '../services/proximity';
import { useOfflineCoverage } from './useOfflineCoverage';
import { resolveLanternState, resolveHomeProximity, type LanternState } from '../utils/lantern';
import { todayISO } from '../utils/date';

export interface LanternCoords { lat: number; lng: number; }

/** Once locating shows, keep it visible this long so a fast fix can't flash it. */
export const LOCATING_MIN_MS = 400;
/**
 * How long we keep saying "Looking around…" AFTER the position call has
 * actually failed, before admitting we can't find the user (KAN-377).
 *
 * This is a budget measured from the first rejection, never from when we
 * started looking. A pending fix is not a failed one: online or offline,
 * "Can't find you" must mean we gave up, not that we're still trying — the
 * old 10 s timer claimed failure while `getPositionLowAccuracy` was still
 * running, which offline is the normal case, not the exception.
 */
export const LOCATING_CEILING_MS = 10_000;
/**
 * The same budget while offline. A cold GPS fix with no assistance data
 * (which arrives over the network) routinely takes far longer, and retries
 * fail until the satellites are acquired.
 *
 * PROVISIONAL — KAN-377 AC2 requires a real cold-start TTFF measurement,
 * outdoors and indoors, with the radio off. Set this from that number.
 */
export const LOCATING_CEILING_OFFLINE_MS = 90_000;
/** Gap between position retries while we have no fix at all. */
export const FIX_RETRY_MS = 5_000;

export function useLanternState(
  placeContext: PlaceContext | null,
  coords: LanternCoords | null,
  permissionGranted: boolean,
): LanternState {
  const wasHomeRef = useRef(false);
  const [cityName, setCityName] = useState<string | null>(null);
  /** A fix this hook obtained live. */
  const [seedCoords, setSeedCoords] = useState<LanternCoords | null>(null);
  /**
   * The OS's cached fix, held apart from `seedCoords` on purpose: it must not
   * appear in the seed effect's dependencies. When it did, arriving cached
   * coords changed `effectiveCoords`, which re-ran that effect, which tore down
   * the live request still in flight — so the app kept a five-minute-old
   * position and never took the fresh one. A head start must not cancel the
   * race it started.
   */
  const [cachedSeed, setCachedSeed] = useState<LanternCoords | null>(null);

  // Engine coords first (a moving user with POI tasks stays freshest), then our
  // own live fix, then the cached one. Later sources never displace earlier.
  const effectiveCoords = coords ?? seedCoords ?? cachedSeed;

  const { offline } = useOfflineCoverage();

  /**
   * When the position call first REJECTED, or null while it has never failed
   * (including while one is still in flight). The failure claim is measured
   * from here — see LOCATING_CEILING_MS.
   */
  const [fixRejectedAt, setFixRejectedAt] = useState<number | null>(null);

  // Position seed — only when we have no fix at all and permission is granted.
  // Stops the moment a fix exists, so it can never become a watcher on a
  // located user.
  //
  // It retries (KAN-377). Before, a single rejection ended it: the effect's
  // deps couldn't change without a fix, so one failed cold attempt left the app
  // with no position until the user backgrounded and reopened it. Offline, that
  // first attempt failing is the ordinary case — the satellites simply aren't
  // acquired yet — so giving up on it read as the app having stopped.
  useEffect(() => {
    if (coords || seedCoords || !permissionGranted) { return; }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    // The OS's cached fix first — it answers now, costs nothing, and offline
    // it is the difference between "Looking around…" for a minute and the
    // Lantern resolving immediately. Only ever a head start: the live attempt
    // below runs regardless and overwrites this the moment it lands.
    getLastKnownPosition()
      .then(pos => {
        if (cancelled || !pos) { return; }
        setCachedSeed({ lat: pos.lat, lng: pos.lng });
      })
      .catch(() => { /* no cached fix — the live attempt is already running */ });

    const attempt = (): void => {
      getPositionLowAccuracy()
        .then(pos => {
          if (cancelled || !pos) { return; }
          setSeedCoords({ lat: pos.lat, lng: pos.lng });
          setFixRejectedAt(null);
        })
        .catch(() => {
          if (cancelled) { return; }
          // Keep the FIRST rejection's timestamp: the budget runs from when we
          // started failing, not from the latest retry.
          setFixRejectedAt(prev => prev ?? Date.now());
          retry = setTimeout(attempt, FIX_RETRY_MS);
        });
    };
    attempt();

    return () => { cancelled = true; if (retry) { clearTimeout(retry); } };
  }, [coords, seedCoords, permissionGranted]);

  // Re-seed on foreground. The seed above runs once and then holds forever, so
  // without this a no-POI-task user (whom the engine never supplies coords for)
  // would keep yesterday's fix after reopening the app. Clearing seedCoords on
  // a background→active transition lets the effect above take exactly one fresh
  // read — still no watcher, no interval (KAN-231). A no-op when the engine has
  // coords: effectiveCoords stays non-null, so the seed effect early-returns.
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') { setSeedCoords(null); setCachedSeed(null); }
    });
    return () => sub.remove();
  }, []);

  const home = getHomeLocation();
  const homeSet = home != null;
  // null = position not known yet → the resolver holds `locating` (never Outside).
  const homeDistanceM: number | null =
    homeSet && effectiveCoords ? distanceFromHome(effectiveCoords) : null;

  const state = resolveLanternState({
    placeContext,
    todayIso: todayISO(),
    homeSet,
    homeDistanceM,
    wasHome: wasHomeRef.current,
    cityName,
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

  const ceilingMs = offline ? LOCATING_CEILING_OFFLINE_MS : LOCATING_CEILING_MS;

  useEffect(() => {
    if (waiting) {
      if (locatingStartRef.current == null) { locatingStartRef.current = Date.now(); }
      setWaitPhase('locating');
      // Still trying — the call hasn't failed, so there is nothing to admit.
      // This is what stops "Can't find you" appearing over a fix that is
      // simply slow, which offline is most of them (KAN-377).
      if (fixRejectedAt == null) { return; }
      const remaining = fixRejectedAt + ceilingMs - Date.now();
      if (remaining <= 0) { setWaitPhase('unavailable'); return; }
      const ceiling = setTimeout(() => setWaitPhase('unavailable'), remaining);
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
  }, [waiting, fixRejectedAt, ceilingMs]);

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
  const wantCity = state.kind === 'outside' && effectiveCoords != null;

  useEffect(() => {
    if (!wantCity || !effectiveCoords) { setCityName(null); return; }
    // Clear the previous name before resolving the replacement so a move to a
    // new area never briefly shows the old area's name (it reads "Outside"
    // until the new one lands).
    setCityName(null);
    let cancelled = false;

    // KAN-377 — two sources, in order of precision. The reverse geocode is the
    // fast path (and is itself cache-backed, so it often costs no request); the
    // settlement name stored with the POIs cached around this position is the
    // broad fallback. The stored name is why an offline user one street over
    // from where they last stood still sees where they are: name coverage now
    // matches POI coverage instead of the ~100 m cells they walked through.
    //
    // No Nominatim call is added by any of this (AC6) — offline we never reach
    // reverseGeocode at all, and the fallback is a local SQLite read.
    const nameFromCache = (): void => {
      if (cancelled) { return; }
      setCityName(getCachedAreaName(effectiveCoords.lat, effectiveCoords.lng, NEARBY_RADIUS));
    };

    if (offline) { nameFromCache(); return () => { cancelled = true; }; }

    reverseGeocode(effectiveCoords.lat, effectiveCoords.lng)
      .then(name => {
        if (cancelled) { return; }
        if (name) { setCityName(name); } else { nameFromCache(); }
      })
      .catch(nameFromCache);

    return () => { cancelled = true; };
  }, [wantCity, effectiveCoords, offline]);

  return display;
}
