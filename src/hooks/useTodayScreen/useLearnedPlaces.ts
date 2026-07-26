/**
 * useLearnedPlaces — KAN-230 / KAN-240
 *
 * Fetches the user's per-place visit counters
 * (`/users/{uid}/learnedPlaceCounts`, kept current by setTaskDone's
 * transaction — KAN-240) once per uid and computes the on-device
 * learned-place ranking (learnedPlaces.ts). One-shot fetch, not a listener
 * (repo rule: no persistent onSnapshot for this kind of derived,
 * infrequently-changing state) — call `refresh()` after a task completes
 * with a known place so the ranking picks up the new brush.
 *
 * A monotonic request token guards against two races:
 *   - overlapping refresh() calls resolving out of order (an older response
 *     arriving after a newer one would otherwise overwrite fresher state)
 *   - a uid change while a fetch for the *previous* uid is still in flight —
 *     that response is discarded, and the ranking is cleared synchronously
 *     on the uid change itself so a shared device never shows one account's
 *     learned places while the next account's fetch is still pending.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getLearnedPlaceCounts } from '../../services/firestore';
import { computeLearnedPlaces } from '../../services/learnedPlaces';
import type { LearnedBrand } from '../../services/learnedPlaces';

export interface LearnedPlacesState {
  learnedPlaces: LearnedBrand[];
  /** Re-fetches history and recomputes the ranking — call after a brush at a known place. */
  refresh: () => Promise<void>;
}

export function useLearnedPlaces(uid: string | undefined): LearnedPlacesState {
  const [learnedPlaces, setLearnedPlaces] = useState<LearnedBrand[]>([]);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!uid) {
      setLearnedPlaces([]);
      return;
    }
    try {
      const counts = await getLearnedPlaceCounts(uid);
      if (requestId !== requestIdRef.current) { return; } // superseded — discard
      setLearnedPlaces(computeLearnedPlaces(counts));
    } catch (err) {
      if (requestId === requestIdRef.current) {
        console.warn('[useLearnedPlaces] refresh failed', err);
      }
    }
  }, [uid]);

  // Only re-runs on mount and on an actual uid change — `refresh` only
  // changes identity when `uid` does (its useCallback dep), so a manual
  // `refresh()` call elsewhere (e.g. after a same-uid task completion)
  // does not re-trigger this effect or the synchronous clear below.
  useEffect(() => {
    requestIdRef.current += 1; // discard anything still in flight for the previous uid
    setLearnedPlaces([]);
    void refresh();
  }, [refresh]);

  return { learnedPlaces, refresh };
}
