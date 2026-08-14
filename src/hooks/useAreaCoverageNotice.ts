/**
 * useAreaCoverageNotice — KAN-349.
 *
 * Owns the Lantern zone's "I don't know this place yet" line and, inseparably,
 * the refresh that makes the line's promise true. Both approved strings end in
 * a commitment ("I'll have more soon", "I'll top it up when I can"), so the
 * loop is not an enhancement of the copy — it is the copy's precondition. If
 * this hook is ever removed, the second sentence of both lines goes with it.
 *
 * ── What re-checks, and what deliberately does not ──
 * Re-checks fire on exactly three triggers:
 *   • the server's own `retryAfterSeconds` (falling back to RETRY_FALLBACK_MS
 *     when it offers none),
 *   • app foreground,
 *   • an explicit manual refresh.
 *
 * Position updates are NOT a trigger (KAN-349 AC6). The proximity engine
 * already moves on its own 200 m / 3-minute cadence, so keying re-checks to it
 * would turn a walk down a street into a stream of coverage calls — the exact
 * "never poll on location updates" rule. `coords` is therefore read through a
 * ref and never appears in an effect's dependencies.
 *
 * ── Clearing ──
 * The line clears when the USER'S radius is served, not when the wider area
 * finishes: a successful re-check runs the proximity search again, and the line
 * disappears only once that search reports a non-`osm` source for where the
 * user actually is (AC7, AC8).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { checkAreaCoverage } from '../services/maps';
import type { PoiCoverageStatus } from '../services/maps';
import { getLastPoiSearchState } from '../services/proximity';
import { resolveAreaNotice, type AreaNotice } from '../utils/lantern';

/** Used when the server offers no `retryAfterSeconds` of its own. */
export const RETRY_FALLBACK_MS = 60_000;

export interface AreaCoverageNotice {
  /** The line to show, or null for the calm empty zone. */
  notice: AreaNotice | null;
  /** Manual refresh — the third trigger. Safe to call when no line is showing (it no-ops). */
  recheck: () => void;
}

export function useAreaCoverageNotice(
  coords: { lat: number; lng: number } | null,
  refreshProximity: () => Promise<boolean>,
): AreaCoverageNotice {
  const [coverageStatus, setCoverageStatus] = useState<PoiCoverageStatus | undefined>(undefined);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | undefined>(undefined);
  /**
   * Incremented after every completed check, and the timer effect's real
   * dependency. Without it the loop stops after one retry: a second identical
   * answer ('building' again, same backoff) sets state to the values it already
   * holds, React bails out of the re-render, the effect never re-runs and no
   * further timer is ever scheduled — the line would sit there promising a
   * refresh that had quietly stopped happening.
   */
  const [checkSeq, setCheckSeq] = useState(0);

  // Read at render like KAN-316's gate: the engine's last settled answer, in
  // step with every re-render the Today screen already does.
  const { source } = getLastPoiSearchState();
  const notice = resolveAreaNotice({ source, coverageStatus });

  // Refs so the effects below never take coords or the refresh callback as
  // dependencies — see the header on why position must not drive re-checks.
  const coordsRef = useRef(coords);
  coordsRef.current = coords;
  const refreshRef = useRef(refreshProximity);
  refreshRef.current = refreshProximity;
  const inFlightRef = useRef(false);

  /**
   * One coverage check for wherever the user is now. On `ready` it re-runs the
   * proximity search so the places arrive without the user doing anything; the
   * line then clears on its own, because `source` stops being `osm`.
   */
  const runCheck = useCallback(async () => {
    const at = coordsRef.current;
    if (!at || inFlightRef.current) { return; }
    inFlightRef.current = true;
    try {
      const answer = await checkAreaCoverage(at.lat, at.lng);
      // A failed check leaves the current line exactly as it was — "we still
      // don't know" is not news, and flipping the copy on a transport blip
      // would make the zone twitch.
      if (!answer) { return; }
      setCoverageStatus(answer.coverageStatus);
      setRetryAfterSeconds(answer.retryAfterSeconds);
      if (answer.coverageStatus === 'ready') {
        // A failed refresh must not reject out of here: this runs detached from
        // every caller (timer, foreground, manual), so a rejection would be an
        // unhandled one. The next backoff tick retries anyway.
        await refreshRef.current().catch(() => {});
      }
    } finally {
      inFlightRef.current = false;
      setCheckSeq(n => n + 1); // schedules the next backoff — see checkSeq above
    }
  }, []);

  // First check on entering a notice state. `hasNotice` (a boolean), not the
  // notice itself, is the dependency: a building→degraded flip must not count
  // as a fresh entry and restart the cycle.
  const hasNotice = notice != null;

  useEffect(() => {
    if (!hasNotice) {
      setCoverageStatus(undefined);
      setRetryAfterSeconds(undefined);
      return;
    }
    void runCheck();
  }, [hasNotice, runCheck]);

  // Backoff timer — the server's own basis when it gives one.
  useEffect(() => {
    if (!hasNotice) { return; }
    const delay = retryAfterSeconds != null ? retryAfterSeconds * 1_000 : RETRY_FALLBACK_MS;
    const timer = setTimeout(() => { void runCheck(); }, delay);
    return () => clearTimeout(timer);
  }, [hasNotice, retryAfterSeconds, checkSeq, runCheck]);

  // Foreground.
  useEffect(() => {
    if (!hasNotice) { return; }
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') { void runCheck(); }
    });
    return () => sub.remove();
  }, [hasNotice, runCheck]);

  const recheck = useCallback(() => { void runCheck(); }, [runCheck]);

  return { notice, recheck };
}
