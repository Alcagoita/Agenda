/**
 * tripActions.ts — KAN-304
 *
 * One shared "forget a trip" so usePlaces and useWhereWeveBeen can never drift
 * on what forgetting does: remove the trip doc and drop its downloaded area
 * places. Callers update their own local list afterwards.
 */
import { deleteTrip as deleteTripDoc } from './firestore';
import { deleteTripAreaPlaces } from './habitatCache';
import type { Trip } from '../types';

export async function forgetTrip(uid: string, trip: Trip): Promise<void> {
  await deleteTripDoc(uid, trip.id);
  deleteTripAreaPlaces(trip.cacheAreaId); // sync, never throws — see habitatCache.ts
}
