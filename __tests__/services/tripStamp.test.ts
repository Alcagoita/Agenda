/**
 * tripStamp.ts — KAN-304 AC12. Stamp the active trip id on a task only when it
 * is being marked done inside a trip context.
 */
import { completedTripIdFor } from '../../src/services/tripStamp';
import type { PlaceContext } from '../../src/services/proximity';

const tripCtx = { kind: 'trip', trip: { id: 'trip-42' } } as unknown as PlaceContext;
const mallCtx = { kind: 'mall', snapshot: { name: 'Colombo' } } as unknown as PlaceContext;

describe('completedTripIdFor', () => {
  it('returns the trip id when marking done inside a trip', () => {
    expect(completedTripIdFor(tripCtx, true)).toBe('trip-42');
  });

  it('returns undefined for a mall context', () => {
    expect(completedTripIdFor(mallCtx, true)).toBeUndefined();
  });

  it('returns undefined when there is no place context', () => {
    expect(completedTripIdFor(null, true)).toBeUndefined();
  });

  it('returns undefined when un-completing a task, even inside a trip', () => {
    expect(completedTripIdFor(tripCtx, false)).toBeUndefined();
  });
});
