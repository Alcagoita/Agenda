/**
 * taughtPlaces.ts — brands the user explicitly taught the app (KAN-304).
 *
 * A taught place is the same shape as a learned brand — a (POI type, name)
 * preference — but declared by the user rather than inferred from brushes.
 * Taught brands sort above learned ones on the Places screen and can be
 * removed ("forgotten") individually.
 *
 * One-shot reads/writes only (repo rule: no persistent onSnapshot for this
 * kind of small, user-managed list).
 */
import { getDocs, addDoc, deleteDoc, Timestamp } from '@react-native-firebase/firestore';
import { taughtPlacesRef, taughtPlaceRef } from './refs';
import { mapSnapshotDocs } from './snapshot';

export interface TaughtPlace {
  id: string;
  /** POI type (drives the row icon), e.g. 'cafe', 'supermarket'. */
  poiType: string;
  /** Brand name, e.g. "Whole Foods". */
  name: string;
  createdAt: Timestamp;
}

/** Adds a taught brand and returns its new id. */
export async function addTaughtPlace(uid: string, place: { poiType: string; name: string }): Promise<string> {
  const ref = await addDoc(taughtPlacesRef(uid), {
    poiType: place.poiType,
    name: place.name,
    createdAt: Timestamp.now(),
  });
  return ref.id;
}

/** Every taught brand for the user, newest first. */
export async function getTaughtPlaces(uid: string): Promise<TaughtPlace[]> {
  const snap = await getDocs(taughtPlacesRef(uid));
  const places = mapSnapshotDocs<TaughtPlace>(snap);
  return places.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
}

/** Removes ("forgets") a taught brand. */
export async function removeTaughtPlace(uid: string, id: string): Promise<void> {
  await deleteDoc(taughtPlaceRef(uid, id));
}
