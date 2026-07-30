/**
 * firestore/ — Firestore CRUD helpers for the Brush data model, split by
 * domain (KAN-214). All reads/writes are scoped to /users/{uid}/... — never
 * touches another user's data (enforced here and in Firestore security rules).
 *
 * Collections:
 *   /users/{uid}                — user profile + preferences
 *   /users/{uid}/tasks/{id}     — to-do tasks
 *   /users/{uid}/pois/{poiType} — per-POI geofence radius preferences
 *
 * This index re-exports every domain module at the original `services/firestore`
 * import path so existing call sites are unaffected by the split.
 */

export * from './users';
export * from './tasks';
export * from './poiPreferences';
export * from './categories';
export * from './points';
export * from './preferences';
export * from './usernames';
export * from './social';
export * from './learnedKeywords';
export * from './poiInferenceMisses';
export * from './trips';
export * from './taughtPlaces';

// ─── Re-exports for convenience ───────────────────────────────────────────────

export { Timestamp, serverTimestamp } from '@react-native-firebase/firestore';
export type { CategoryKey, PoiType } from '../../types';
