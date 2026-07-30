/**
 * tripStamp.ts — KAN-304 groundwork.
 *
 * Decides the trip id to stamp on a task at brush time: when a task is marked
 * done while the live place context resolves to a trip, we record that trip's
 * id on the task (completedTripId) so a future feature can recommend things to
 * do where the user has already been. Stored, never yet surfaced.
 *
 * Pure so the decision is unit-testable without the proximity engine.
 */
import type { PlaceContext } from './proximity';

export function completedTripIdFor(placeContext: PlaceContext, done: boolean): string | undefined {
  if (!done) { return undefined; }
  return placeContext?.kind === 'trip' ? placeContext.trip.id : undefined;
}
