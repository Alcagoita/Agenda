/**
 * trips.ts — CRUD for /users/{uid}/trips/{tripId} (KAN-234).
 *
 * Firestore-only — this module never touches the on-device habitat cache.
 * Callers (screens/hooks) are responsible for gluing the two together: a
 * deleteTrip caller must also call habitatCache.deleteTripAreaPlaces(trip.cacheAreaId),
 * same cloud/on-device separation the rest of the codebase already keeps.
 */

import { getDocs, getDoc, addDoc, updateDoc, deleteDoc, deleteField, Timestamp } from '@react-native-firebase/firestore';
import type { Trip } from '../../types';
import { tripsRef, tripRef } from './refs';
import { mapSnapshotDocs } from './snapshot';

/** Creates a new trip. Returns the auto-generated Firestore document ID. */
export async function addTrip(
  uid: string,
  data: Omit<Trip, 'id' | 'createdAt'>,
): Promise<string> {
  const ref = await addDoc(tripsRef(uid), { ...data, createdAt: Timestamp.now() });
  return ref.id;
}

/** Fetches every trip for the user. No ordering guarantee beyond Firestore's default. */
export async function getTrips(uid: string): Promise<Trip[]> {
  const snap = await getDocs(tripsRef(uid));
  return mapSnapshotDocs<Trip>(snap);
}

/** Fetches a single trip by id. */
export async function getTrip(uid: string, tripId: string): Promise<Trip | null> {
  const snap = await getDoc(tripRef(uid, tripId));
  if (!snap.exists()) { return null; }
  return { id: snap.id, ...snap.data() } as Trip;
}

type TripUpdate = Partial<Pick<
  Trip,
  'startDate' | 'endDate' | 'areaRadius' | 'expiresAt' | 'preRefreshedAt' | 'cloudflareExport'
>>;

/** Updates mutable trip metadata after user edits or a (re)download. */
export async function updateTrip(
  uid: string,
  tripId: string,
  data: TripUpdate,
): Promise<void> {
  const patch: Record<string, unknown> = { ...data };
  if ('startDate' in data && data.startDate === undefined) { patch.startDate = deleteField(); }
  if ('endDate' in data && data.endDate === undefined) { patch.endDate = deleteField(); }
  if ('preRefreshedAt' in data && data.preRefreshedAt === undefined) { patch.preRefreshedAt = deleteField(); }
  await updateDoc(tripRef(uid, tripId), patch);
}

/** Deletes the trip document. Caller must also delete its habitat_places rows via deleteTripAreaPlaces(trip.cacheAreaId). */
export async function deleteTrip(uid: string, tripId: string): Promise<void> {
  await deleteDoc(tripRef(uid, tripId));
}
