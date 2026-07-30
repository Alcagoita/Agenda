/**
 * refs.ts — Firestore document/collection reference builders shared across
 * the firestore/ domain modules. All paths are scoped to /users/{uid}/...
 */

import { getFirestore, collection, doc } from '@react-native-firebase/firestore';
import type { SupportedLang } from '../poiInference';
import { normalize } from '../poiInference';

export function tasksRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'tasks');
}

export function taskRef(uid: string, taskId: string) {
  return doc(getFirestore(), 'users', uid, 'tasks', taskId);
}

export function userRef(uid: string) {
  return doc(getFirestore(), 'users', uid);
}

/** users/{uid}/userPreferences/prefs — single preferences document. */
export function userPrefsRef(uid: string) {
  return doc(getFirestore(), 'users', uid, 'userPreferences', 'prefs');
}

export function poisRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'pois');
}

export function poiRef(uid: string, poiType: string) {
  return doc(getFirestore(), 'users', uid, 'pois', poiType);
}

export function categoriesRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'categories');
}

export function categoryRef(uid: string, categoryId: string) {
  return doc(getFirestore(), 'users', uid, 'categories', categoryId);
}

export function pointsHistoryRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'pointsHistory');
}

export function achievementsRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'achievements');
}

export function achievementRef(uid: string, achievementId: string) {
  return doc(getFirestore(), 'users', uid, 'achievements', achievementId);
}

export function usernameIndexRef(username: string) {
  return doc(getFirestore(), 'usernames', username);
}

export function followingRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'following');
}

export function followingEntryRef(uid: string, followedUid: string) {
  return doc(getFirestore(), 'users', uid, 'following', followedUid);
}

export function followersEntryRef(uid: string, followerUid: string) {
  return doc(getFirestore(), 'users', uid, 'followers', followerUid);
}

export function followersRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'followers');
}

export function inboxRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'inbox');
}

export function learnedKeywordsRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'learnedPoiKeywords');
}

/** users/{uid}/poiInferenceMisses/{id} — low-confidence POI parse phrases for dictionary review. */
export function poiInferenceMissesRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'poiInferenceMisses');
}

/** users/{uid}/learnedPlaceCounts/{placeId} — per-place visit tally (KAN-240). */
export function learnedPlaceCountsRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'learnedPlaceCounts');
}

export function learnedPlaceCountRef(uid: string, placeId: string) {
  return doc(getFirestore(), 'users', uid, 'learnedPlaceCounts', placeId);
}

/** Stable doc id for a learned keyword: "<lang>:<normalized keyword>". */
export function learnedKeywordId(keyword: string, lang: SupportedLang): string {
  return `${lang}:${normalize(keyword)}`;
}

/** users/{uid}/places/{id} — brands the user explicitly taught the app (KAN-304). */
export function taughtPlacesRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'places');
}

export function taughtPlaceRef(uid: string, id: string) {
  return doc(getFirestore(), 'users', uid, 'places', id);
}

/** users/{uid}/trips/{tripId} — manually-downloaded offline travel areas (KAN-234). */
export function tripsRef(uid: string) {
  return collection(getFirestore(), 'users', uid, 'trips');
}

export function tripRef(uid: string, tripId: string) {
  return doc(getFirestore(), 'users', uid, 'trips', tripId);
}

/** users/{uid}/mallSnapshot/current — the single currently-active mall snapshot, if any (KAN-237). */
export function mallSnapshotRef(uid: string) {
  return doc(getFirestore(), 'users', uid, 'mallSnapshot', 'current');
}
