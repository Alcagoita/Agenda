import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import { COPY } from '../constants/copy';
import type { StoreSubtype } from '../services/storeSubtypes';
import type { RestaurantFoodType } from '../services/restaurantFoodTypes';

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Branded type — prevents accidental use of arbitrary strings as dates. */
export type DateString = string & { readonly __brand: 'DateString' };

export function toDateString(value: string): DateString {
  return value as DateString;
}

// ─── Store fine tuning (KAN-74) ──────────────────────────────────────────────

/**
 * Session-level state for the Store fine tuning feature.
 *
 *   off           — not active; prompt has not been shown (or was shown and dismissed)
 *   prompt_shown  — the bottom-sheet prompt is visible / pending user response
 *   active        — user tapped "Turn on"; indoor proximity radius = 10 m
 */
export type StoreTuningState = 'off' | 'prompt_shown' | 'active';

// ─── User ─────────────────────────────────────────────────────────────────────

/** /users/{uid} */
export interface User {
  uid: string;
  email: string;
  displayName: string;
  darkMode: boolean;
  /** UI language (KAN-252) — defaults to the device's system language until
   *  explicitly set. 'en' | 'pt-PT' (never pt-BR). */
  language?: 'en' | 'pt-PT';
  createdAt: FirebaseFirestoreTypes.Timestamp;
  /**
   * Unique handle chosen at sign-up (KAN-97).
   * Stored lowercase without the `@` prefix (e.g. `alice`).
   * Display as `@${username}` in the UI.
   * Case-insensitive — `alice` and `Alice` map to the same document.
   */
  username?: string;
  /** When the username was last set — enforces the 30-day change cooldown (KAN-97). */
  usernameUpdatedAt?: FirebaseFirestoreTypes.Timestamp;
  /** Denormalized count of users this user follows (KAN-98). */
  followingCount?: number;
  /** Denormalized count of users following this user (KAN-98). */
  followersCount?: number;
  /** Sum of points from all earned achievements (KAN-129). */
  totalPoints?: number;
  /** Current consecutive-day task streak. Updated by streak logic. */
  currentStreak?: number;
  /** Distinct POI types at which the user has brushed at least one task (KAN-150). */
  brushedPoiTypes?: string[];
  /**
   * Achievement progress and earn state, keyed by AchievementType (KAN-129).
   * Embedded on the user doc — replaces the old achievements subcollection.
   */
  achievements?: AchievementsMap;
  /**
   * User-controlled feature preferences stored on the root user document.
   * Using a nested object keeps the root document flat for other flags.
   */
  /** Set to true once the user completes the guided first-run onboarding (KAN-140). */
  onboardingDone?: boolean;
  /**
   * Stamped the first time the Today screen mounts with no prior value
   * (KAN-245) — marks "the user has now had one full session to learn the
   * core app before any contextual suggestion is allowed to appear."
   * Never overwritten once set.
   */
  firstSessionSeenAt?: FirebaseFirestoreTypes.Timestamp;
  /**
   * Set to true once this user's historical `completedPlaceId` brush data has
   * been tallied into `/users/{uid}/learnedPlaceCounts/{placeId}` (KAN-240).
   * Gates `backfillLearnedPlaceCounts` so the one-time full-history scan never
   * repeats on subsequent boots.
   */
  learnedPlaceCountsBackfilled?: boolean;
  poiPreferences?: {
    /**
     * When true, geofence monitoring is paused whenever battery drops below
     * LOW_BATTERY_THRESHOLD (20%). Default: false (opt-in). KAN-52.
     */
    lowBatteryPause?: boolean;
    /**
     * Store fine tuning preference (KAN-74).
     *
     *   absent / undefined — user has never interacted; prompt is shown on first
     *                        indoor_mapped detection each session.
     *   true               — user has activated via prompt or settings toggle;
     *                        mode auto-activates silently on indoor_mapped.
     *   false              — user has explicitly disabled via settings toggle;
     *                        prompt is suppressed permanently.
     */
    storeTuningEnabled?: boolean;
  };
  /**
   * Explicit home anchor (KAN-247) — set by the user in Settings, never
   * inferred. Optional; absent when the user hasn't set (or has cleared) it.
   * Never used server-side.
   */
  home?: {
    address: string;
    lat: number;
    lng: number;
    updatedAt: FirebaseFirestoreTypes.Timestamp;
  };
}

// ─── POI ──────────────────────────────────────────────────────────────────────

export type PoiType =
  | 'atm' | 'cafe' | 'supermarket' | 'pharmacy'
  | 'gas' | 'gym' | 'bank' | 'restaurant' | 'park'
  | 'library' | 'post' | 'store' | 'clinic' | 'salon'
  | 'bus' | 'school' | 'bakery' | 'florist' | 'bar'
  | 'currency_exchange' | 'money_transfer';

/** All built-in POI types, in catalog display order. */
export const POI_CATALOG: { type: PoiType }[] = [
  { type: 'supermarket' }, { type: 'pharmacy' }, { type: 'atm' }, { type: 'cafe' },
  { type: 'restaurant' }, { type: 'store' }, { type: 'florist' }, { type: 'bakery' },
  { type: 'park' }, { type: 'gym' }, { type: 'bar' }, { type: 'library' }, { type: 'bank' },
  // Retained for existing documents and free-text lookup, but intentionally
  // outside the curated quick-actionable list below.
  { type: 'gas' }, { type: 'post' }, { type: 'clinic' },
  { type: 'salon' }, { type: 'bus' }, { type: 'school' },
  { type: 'currency_exchange' }, { type: 'money_transfer' },
];

/**
 * The only built-in POI types offered in quick task creation. Both creation
 * carousels and their automatic quick suggestion use this single list.
 */
export const QUICK_ACTIONABLE_POI_TYPES: readonly PoiType[] = [
  'supermarket', 'pharmacy', 'atm', 'cafe', 'restaurant', 'store',
  'florist', 'bakery', 'park', 'gym', 'bar', 'library',
];

export function isQuickActionablePoiType(value: string | null | undefined): value is PoiType {
  return value != null && QUICK_ACTIONABLE_POI_TYPES.includes(value as PoiType);
}

/**
 * Display label for a built-in POI type — reads live from COPY (KAN-252)
 * rather than a static field on POI_CATALOG, so it stays language-aware.
 */
export function poiCatalogLabel(type: PoiType): string {
  return COPY.poiCatalog[type];
}

/** Is `value` one of the built-in catalog types (vs. a free-text POI)? */
export function isCatalogPoiType(value: string | null | undefined): value is PoiType {
  return value != null && POI_CATALOG.some(item => item.type === value);
}

/**
 * All built-in POI types, derived from POI_CATALOG. Used by the habitat
 * cache's prefetch (KAN-238) to warm the cache for every type regardless of
 * open tasks — a task created after caching (e.g. "buy aspirin" while
 * offline) must still find pharmacy candidates even though no pharmacy task
 * existed when the area was last refreshed online.
 */
export const ALL_POI_TYPES: PoiType[] = POI_CATALOG.map(c => c.type);

/**
 * POI types worth teaching a *brand* for (KAN-304): places that come as
 * multiple, chain-able stores where naming a favourite makes sense — a café,
 * a market, a gym. Excludes one-off/utility types (ATM, park, post, bus…)
 * where a brand name carries no signal. May grow later.
 */
export const TEACHABLE_POI_TYPES: PoiType[] = [
  'cafe', 'supermarket', 'gas', 'gym', 'restaurant', 'salon',
];

/** /users/{uid}/pois/{poiType} */
export interface PoiPreference {
  /**
   * Google Places primary type string. Built-in categories use one of the
   * PoiType values; custom categories may use any Places type (e.g. "gym").
   */
  type: string;
  /** Geofence radius in metres. */
  radiusMeters: number;
}

// ─── Task ─────────────────────────────────────────────────────────────────────

export type CategoryKey = 'work' | 'health' | 'errands' | 'personal';

/** /users/{uid}/tasks/{taskId} */
export interface Task {
  id: string;
  title: string;
  /** Built-in CategoryKey or a Firestore custom category ID (KAN-61). */
  category: string;
  done: boolean;
  /** Free-text description — optional, added in KAN-12. */
  description?: string;
  /** Scheduled time in "HH:MM" format — optional. */
  time?: string;
  /**
   * The external source this task was imported from (KAN-84 / KAN-85).
   * Undefined for tasks created natively inside the app.
   */
  source?: 'google_tasks' | 'google_calendar' | 'eventkit_reminders' | 'eventkit_calendar';
  /**
   * Google Places primary type string this task is associated with — optional.
   * For built-in categories this is one of the four PoiType values; for custom
   * categories it may be any Google Places type (e.g. "gym", "restaurant").
   */
  poi?: string;
  /** Optional store subtype selected by the user for store tasks (KAN-315). */
  storeSubtype?: StoreSubtype;
  /** Optional cuisine preference selected for restaurant tasks. */
  restaurantFoodType?: RestaurantFoodType;
  /** Canonical Gym/Bank brand required for actionable nearby matching (KAN-364). */
  poiBrand?: string;
  /**
   * Google Places ID of the hero/nearby place the user was next to when this
   * task was brushed away — undefined when no matching place was known at
   * brush time (KAN-226). Prerequisite data for learned places (KAN-230).
   */
  completedPlaceId?: string;
  /** Human-readable name of `completedPlaceId`, snapshotted at brush time. */
  completedPlaceName?: string;
  /** POI type of `completedPlaceId`, snapshotted at brush time. */
  completedPoiType?: string;
  /**
   * KAN-304 — the id of the trip whose area the user was inside when this task
   * was brushed, if any (live `PlaceContext.kind === 'trip'` at brush time).
   * Groundwork for later "things to do where you've been" — stored, never yet
   * surfaced.
   */
  completedTripId?: string;
  /**
   * The date (YYYY-MM-DD) on which a geofence-entry notification was last
   * fired for this task. Suppresses repeat alerts on the same day (KAN-24).
   */
  poiAlertSeenDate?: string;
  /**
   * The date (YYYY-MM-DD) on which a geofence-exit prompt was last fired for
   * this task. Suppresses repeat exit prompts on the same day (KAN-119).
   */
  exitPromptSeenDate?: string;
  createdAt: FirebaseFirestoreTypes.Timestamp;
  completedAt?: FirebaseFirestoreTypes.Timestamp;
  /**
   * Legacy daily-list date. New code must not use this field to decide whether
   * a task is active: every pre-KAN-363 task has one, even when the user never
   * chose a date. It is retained so existing documents are not destructively
   * migrated and a future history view can still read their original data.
   */
  date?: string;
  /**
   * An explicit, optional local calendar date chosen by the user, in canonical
   * YYYY-MM-DD form. A task with
   * no scheduledDate remains active until it is brushed or deleted. Once this
   * date has passed, the task simply leaves the active list; it is never
   * deleted or moved automatically.
   */
  scheduledDate?: string;
  /** The first explicitly selected YYYY-MM-DD date, retained when “Tomorrow instead” moves a task. */
  originalScheduledDate?: string;
  /**
   * The latest explicit end-of-day decision. Its YYYY-MM-DD date identifies the handoff
   * it belongs to, so absence for a passed scheduled date truthfully means the
   * user did not answer rather than chose "Forget it".
   */
  dateHandoff?: {
    date: string;
    outcome: 'forgotten' | 'tomorrow';
    resolvedAt: FirebaseFirestoreTypes.Timestamp;
  };
  /**
   * Legacy original date retained from the former rollover model. New code
   * does not write it; Calendar compatibility may read it for old documents.
   */
  originDate?: string;
  /** True when this task has a local write not yet confirmed by the server (KAN-198). */
  pendingSync?: boolean;
  /**
   * KAN-248 — marks a date-bound, unscored task imported from a calendar
   * birthday event (or retroactively flagged via the edit-screen toggle).
   * It is a semantic task kind, not a POI type; birthdays have no place and
   * never earn points. Undefined for every other task.
   */
  kind?: 'birthday';
}

// ─── Category ─────────────────────────────────────────────────────────────────

/**
 * A task category — either one of the 4 built-in design-system categories
 * or a user-created custom category stored in Firestore.
 *
 * /users/{uid}/categories/{id}  (custom categories only — built-ins are derived
 * from design tokens and never written to Firestore)
 */
export interface Category {
  /** 'work' | 'health' | 'errands' | 'personal' for built-ins; Firestore ID for custom. */
  id: string;
  name: string;
  /** Hex colour string, e.g. one from `categories` or `categoryHues` in theme/tokens.ts. */
  color: string;
  // A category carries no place type. It used to (`poi`), and the Add Category
  // sheet asked for one, but a category is a colour and a name — where a task
  // happens belongs to the task (KAN-371). Documents written before this may
  // still hold a stale `poi`; nothing reads it.
  /** Built-in categories cannot be renamed, recoloured, or deleted. */
  isBuiltIn: boolean;
}

// ─── POI / category mapping constants ─────────────────────────────────────────

/** Which POI types can appear on tasks of each category. */
export const CATEGORY_POI_MAP: Record<CategoryKey, PoiType[]> = {
  errands:  ['supermarket', 'atm', 'pharmacy', 'bank', 'currency_exchange', 'money_transfer', 'post', 'store', 'bakery', 'florist'],
  health:   ['pharmacy', 'clinic', 'gym'],
  personal: ['cafe', 'restaurant', 'bar', 'park', 'salon'],
  work:     ['library', 'school'],
};

/** Maps the legacy Google fallback's supported PoiTypes to a Places type.
 *
 * Currency exchange and money transfer intentionally have no Google fallback:
 * Google exposes neither as a distinct searchable type, and mapping either to
 * Bank would return the wrong places. The Brush POI API remains authoritative.
 */
export const POI_GOOGLE_TYPES: Partial<Record<PoiType, string>> = {
  atm:         'atm',
  cafe:         'cafe',
  supermarket:  'supermarket',
  pharmacy:     'pharmacy',
  gas:          'gas_station',
  gym:          'gym',
  bank:         'bank',
  restaurant:   'restaurant',
  park:         'park',
  library:      'library',
  post:         'post_office',
  store:        'store',
  clinic:       'doctor',
  salon:        'hair_care',
  bus:          'bus_station',
  school:       'school',
  bakery:       'bakery',
  florist:      'florist',
  bar:          'bar',
};

/**
 * Maps our PoiType to the corresponding OpenStreetMap tag (key=value) used to
 * query the Overpass API for the offline habitat cache (KAN-228). Google
 * Places' ToS forbids long-term caching of coordinates, so the offline cache
 * is sourced from OSM instead — this is the OSM equivalent of
 * POI_GOOGLE_TYPES above.
 */
export const POI_OSM_TAGS: Record<PoiType, { key: string; value: string }> = {
  atm:         { key: 'amenity', value: 'atm' },
  cafe:        { key: 'amenity', value: 'cafe' },
  supermarket: { key: 'shop',    value: 'supermarket' },
  pharmacy:    { key: 'amenity', value: 'pharmacy' },
  gas:         { key: 'amenity', value: 'fuel' },
  gym:         { key: 'leisure', value: 'fitness_centre' },
  bank:        { key: 'amenity', value: 'bank' },
  currency_exchange: { key: 'amenity', value: 'bureau_de_change' },
  money_transfer: { key: 'amenity', value: 'money_transfer' },
  restaurant:  { key: 'amenity', value: 'restaurant' },
  park:        { key: 'leisure', value: 'park' },
  library:     { key: 'amenity', value: 'library' },
  post:        { key: 'amenity', value: 'post_office' },
  store:       { key: 'shop',    value: 'convenience' },
  clinic:      { key: 'amenity', value: 'clinic' },
  salon:       { key: 'shop',    value: 'hairdresser' },
  bus:         { key: 'highway', value: 'bus_stop' },
  school:      { key: 'amenity', value: 'school' },
  bakery:      { key: 'shop',    value: 'bakery' },
  florist:     { key: 'shop',    value: 'florist' },
  bar:         { key: 'amenity', value: 'bar' },
};

/**
 * OSM tags for internal/supplementary search types that aren't user-facing
 * task categories (so they can't live in POI_OSM_TAGS, which is keyed to
 * the PoiType catalog) but still need offline OSM-backed caching — e.g.
 * shopping_mall for KAN-282's "One trip for all of these" mall detection,
 * which must work fully offline against the habitat cache the same way
 * every catalog type does, not just from a live Google search.
 */
export const SUPPLEMENTARY_OSM_TAGS: Record<string, { key: string; value: string }> = {
  shopping_mall: { key: 'shop', value: 'mall' },
  // KAN-293 — leisure/cultural draws for the cluster box's companion line.
  // `park` is absent here on purpose: it's already a PoiType in
  // POI_OSM_TAGS, so it rides the normal prefetch without duplication.
  museum:     { key: 'tourism', value: 'museum' },
  attraction: { key: 'tourism', value: 'attraction' },
  aquarium:   { key: 'tourism', value: 'aquarium' },
};

/**
 * Place types the errand-cluster box may mention as a leisure companion
 * ("Central Park is right there — fancy a walk?", KAN-293).
 *
 * COMMERCIAL NEUTRALITY: this list is a fixed, hand-authored set of OSM tag
 * types. It takes no partner, sponsor or revenue input of any kind, and
 * nothing may ever be added to it in exchange for payment. A place surfaces
 * here for exactly one reason — it is physically near the user's errands.
 * Monetization, if it ever arrives, attaches to the fulfilment action (the
 * ticket link) and never to detection, ranking or copy. See KAN-239.
 */
// Notable leisure / cultural places worth naming as you pass them on a trip
// (clusterLeisure). historical_landmark + tourist_attraction added so heritage
// sites — monasteries, castles, monuments — can surface too; they were a blind
// spot (e.g. Mosteiro de Alcobaça sits metres from a stop but is typed
// historical_landmark). Both are already prefetched into the habitat cache.
export const CLUSTER_LEISURE_TYPES = ['park', 'museum', 'attraction', 'aquarium', 'historical_landmark', 'tourist_attraction'] as const;

export type ClusterLeisureType = typeof CLUSTER_LEISURE_TYPES[number];

/** Default geofence radius in metres per POI type. */
export const POI_GEOFENCE_RADIUS: Record<PoiType, number> = {
  atm:         50,
  pharmacy:    50,
  cafe:        75,
  supermarket: 75,
  gas:         75,
  gym:         100,
  bank:        50,
  currency_exchange: 50,
  money_transfer: 50,
  restaurant:  75,
  park:        150,
  library:     75,
  post:        50,
  store:       75,
  clinic:      75,
  salon:       50,
  bus:         100,
  school:      100,
  bakery:      75,
  florist:     75,
  bar:         75,
};

// ─── Points & Achievements ────────────────────────────────────────────────────

/**
 * All valid reasons a point can be awarded (KAN-63).
 * Add new literals here; create a dedicated awardPoint* function in
 * firestore.ts for each — do NOT repurpose existing function signatures.
 */
export type PointsReason =
  | 'task_completed'       // 1 point per completed task (KAN-31)
  | 'achievement_bonus'    // bonus when an achievement is unlocked
  | 'daily_complete_bonus' // bonus for completing the full daily list
  | 'streak_bonus'         // extra point for consecutive days
  | 'onboarding_bonus';    // Day-1 first-brush reward (KAN-140)

/**
 * All achievement types the app can award.
 *
 * Naming convention:
 *   - Global (awarded once ever):  '<name>'             e.g. 'first_task'
 *   - Date-scoped (once per day):  '<name>'  — the doc ID carries the date
 *                                              e.g. 'daily_complete_2026-05-29'
 */
/**
 * V1 achievement types — KAN-129.
 * `challenge_winner` is kept for the social challenge flow (KAN-104).
 */
export type AchievementType =
  // ── Tin tier — KAN-150 ────────────────────────────────────────────────────
  | 'first_task'       // Add your first task
  | 'first_brush'      // Brush away your first task
  | 'right_place'      // Brush a task while near its POI type
  | 'worth_wait'       // Brush a task that waited at least 3 days
  | 'custom_cat'       // Create a custom category
  | 'out_about'        // Brush tasks at 3 distinct POI types
  // ── Legacy V1 (kept for existing user data) ───────────────────────────────
  | 'early_bird'       // Brush a task away before 9 AM
  | 'day_complete'     // Brush away every task in a single day
  | 'on_a_roll'        // 3-day brushing streak
  | 'explorer'         // Brush away 10 location-based tasks
  | 'centurion'        // Reach 100 achievement points (meta-achievement)
  | 'challenge_winner'; // Won a challenge against friends (KAN-104)

/**
 * Entry inside the `users/{uid}.achievements` map (KAN-129).
 * The map key is the AchievementType string.
 */
export interface AchievementEntry {
  /** Timestamp of first earn. Null / absent = not yet earned. */
  earnedAt: FirebaseFirestoreTypes.Timestamp | null;
  /** How many times this achievement has been earned (0 = not earned). */
  earnCount: number;
  /** Current progress toward the unlock condition. */
  progress: number;
  /** Condition threshold (e.g. 10 for Explorer, 100 for Centurion). */
  target: number;
}

/** The full achievements map embedded on the user document. */
export type AchievementsMap = Partial<Record<AchievementType, AchievementEntry>>;

/**
 * /users/{uid}/pointsHistory/{id}
 *
 * One document per point awarded. Used for the points history screen (KAN-33)
 * and as the source of truth if `totalPoints` ever needs to be recomputed.
 */
export interface PointsHistoryEntry {
  /** Firestore document ID (auto-generated). */
  id: string;
  /** The task that earned the point. */
  taskId: string;
  /** Snapshot of the task title at completion time. */
  taskTitle: string;
  awardedAt: FirebaseFirestoreTypes.Timestamp;
  /** Points awarded — always 1 in v1; kept for future multi-point awards. */
  points: number;
  /**
   * Why the point was awarded — discriminated union for future extensibility.
   * New types added in KAN-63:
   *   'achievement_bonus'     — bonus when an achievement is unlocked
   *   'daily_complete_bonus'  — bonus for completing the full daily list
   *   'streak_bonus'          — extra point for consecutive days
   */
  reason: PointsReason;
}

/**
 * /users/{uid}/achievements/{achievementId}
 *
 * Document ID rules:
 *   - Global achievements  →  achievementId = type  (e.g. 'first_task')
 *   - Date-scoped ones     →  achievementId = `${type}_${YYYY-MM-DD}`
 *                              (e.g. 'daily_complete_2026-05-29')
 *
 * Using the ID as the natural key makes writes idempotent — awarding the same
 * achievement twice simply overwrites with identical data.
 */
// ─── Notification / User Preferences (KAN-120 / Track B) ─────────────────────

/**
 * Firestore: users/{uid}/userPreferences/prefs
 *
 * Single document that stores all per-user notification toggles and related
 * metadata. Merged-write safe — use `setDoc(..., { merge: true })`.
 */
export interface UserPreferences {
  // ── Three notification channels (KAN-303) ──
  // "When I'm out": proximity alerts (notif_nearby_enabled) + the exit prompt.
  exitPrompt:               boolean;                             // KAN-119
  /** Whether to fire local proximity alerts when near a POI type with pending tasks. KAN-142. */
  notif_nearby_enabled:     boolean;
  // "Daily": the morning check-in, with its user-set reminder time.
  eodReminder:              { enabled: boolean; time: string };  // KAN-120 — morning
  // "From people": shared tasks from friends. KAN-303 — default on.
  sharedTasks:              boolean;

  // Friend-activity pushes — gated server-side (onFriendActivity), not on the
  // notifications screen. KAN-125.
  friendActivity:           boolean;
  /** Updated on every app foreground. */
  lastOpenedAt?:            FirebaseFirestoreTypes.Timestamp;
  /**
   * Per-actor last-nudge timestamps for friend activity (KAN-125).
   * Key = actor UID; value = last time a friend-activity nudge was sent from that actor.
   * Written by the onFriendActivity Cloud Function — not read by the RN app.
   */
  lastFriendNudgeFrom?: Record<string, FirebaseFirestoreTypes.Timestamp>;
}

/** Sensible defaults applied before a user has ever saved preferences. */
export const DEFAULT_USER_PREFERENCES: Omit<
  UserPreferences,
  | 'lastOpenedAt'
  | 'lastFriendNudgeFrom'
> = {
  exitPrompt:            true,
  notif_nearby_enabled:  true,
  eodReminder:           { enabled: true, time: '08:00' },
  sharedTasks:           true,
  friendActivity:        true,
};

export interface Achievement {
  /**
   * Firestore document ID.
   * Equals `type` for global achievements; `${type}_${date}` for date-scoped.
   */
  id: string;
  type: AchievementType;
  earnedAt: FirebaseFirestoreTypes.Timestamp;
  /** Optional contextual data — e.g. `{ date: '2026-05-29' }` for daily_complete. */
  metadata?: Record<string, unknown>;
}

// ─── Task import (KAN-83 / KAN-84 / KAN-85) ──────────────────────────────────

/**
 * Result returned by every import connector.
 * Connectors live in src/services/import.ts; the UI (ImportTasksSection) only
 * depends on this shape.
 */
export interface ImportResult {
  /** Number of tasks written to Firestore. */
  imported: number;
  /** Tasks skipped because an identical title already existed (case-insensitive). */
  skipped: number;
  /** Tasks that failed to write. */
  failed: number;
  /** User actively declined the OAuth scope prompt — not an error, no retry needed. */
  cancelled: number;
}

// ─── Screen UiState types (KAN-57) ───────────────────────────────────────────
//
// Discriminated unions that replace separate loading-flag + data-array state.
// Each union covers all three cases: loading, success, and error.
//
// Pattern (NowInAndroid / TypeScript):
//   | { status: 'loading' }                    — data in flight
//   | { status: 'success'; <payload> }         — data available
//   | { status: 'error';   message: string }   — retrieval failed, show feedback
//
// Kept in types/index.ts so KAN-59's custom hooks can import them without
// a dependency cycle.

/** UiState for a list of today's tasks (TodayScreen). */
export type TasksUiState =
  | { status: 'loading' }
  | { status: 'success'; tasks: Task[] }
  | { status: 'error';   message: string };

/** UiState for the custom categories list (CategoriesScreen). */
export type CategoriesUiState =
  | { status: 'loading' }
  | { status: 'success'; categories: Category[] }
  | { status: 'error';   message: string };

/** UiState for a month's tasks (CalendarScreen). */
export type MonthTasksUiState =
  | { status: 'loading' }
  | { status: 'success'; tasks: Task[] }
  | { status: 'error';   message: string };

// ─── Legacy calendar types (kept for backward compatibility) ──────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  date: DateString;
  startTime: string;
  endTime: string;
  color: string;
}

/** @deprecated Use CalendarEvent. */
export type Event = CalendarEvent;

export type MarkedDates = Record<DateString, { marked: boolean; dotColor: string }>;

// ─── Challenges (KAN-102) ────────────────────────────────────────────────────

export interface ChallengeParticipant {
  username:       string;
  displayName:    string;
  status:         'pending' | 'accepted' | 'declined';
  completedCount: number;
  won:            boolean;
}

/**
 * /challenges/{challengeId}
 *
 * participants is a map of uid → ChallengeParticipant so any party can be
 * looked up in O(1) without a subcollection query.
 */
export interface Challenge {
  id:           string;
  type:         'goal' | 'time';
  goalCount?:   number;
  deadline?:    FirebaseFirestoreTypes.Timestamp;
  createdBy:    string;           // uid of the challenger
  participants: Record<string, ChallengeParticipant>;
  status:       'pending' | 'active' | 'completed';
  createdAt:    FirebaseFirestoreTypes.Timestamp;
  message?:     string;
}

// ─── Follow system (KAN-98) ───────────────────────────────────────────────────

/**
 * One entry in users/{uid}/following/{followedUid}
 * or         users/{uid}/followers/{followerUid}.
 *
 * The `uid` field is the Firestore document ID (the other user's UID).
 */
export interface FollowEntry {
  uid:         string;
  username:    string;
  displayName: string;
  followedAt:  FirebaseFirestoreTypes.Timestamp;
}

// ─── Task sharing (KAN-86 / KAN-87) ──────────────────────────────────────────

/**
 * A shared task record written to sharedTasks/{recipientUid}/incoming/{id}
 * when a user sends a task to another Brush user.
 */
export interface SharedTask {
  id:              string;
  taskId:          string;
  title:           string;
  category:        string;
  poi?:            PoiType;
  sentBy:          string;       // sender uid
  sentByName:      string;       // sender display name
  sentByUsername?: string;       // sender @username (KAN-97)
  sentAt:          FirebaseFirestoreTypes.Timestamp;
  status:          'pending' | 'accepted' | 'declined';
}

/**
 * A pending-notification record written to
 * pendingNotifications/{recipientUid}/items/{id} at send time.
 *
 * The recipient device (KAN-87) subscribes to this collection and triggers
 * a local notifee notification when a new item arrives.
 *
 * NOTE: This is the client-side notification delivery mechanism.
 * A future Firebase Cloud Function can replace/supplement this with
 * true FCM push (for delivery when the app is backgrounded/killed).
 */
export interface PendingNotification {
  id:          string;
  type:        'shared_task' | 'follow';
  title:       string;       // notification title
  body:        string;       // notification body
  data?:       Record<string, string>;
  createdAt:   FirebaseFirestoreTypes.Timestamp;
}

// ─── Social Inbox (KAN-212) ───────────────────────────────────────────────────

/**
 * One entry in /users/{uid}/inbox/{entryId}.
 * Currently only follow_request — discriminated union for future types.
 */
export interface InboxEntry {
  id:              string;
  type:            'follow_request';
  fromUid:         string;
  fromUsername:    string;
  fromDisplayName: string;
  read:            boolean;
  createdAt:       FirebaseFirestoreTypes.Timestamp;
}

// ─── Trip (KAN-234) ───────────────────────────────────────────────────────────

/** The 3 area-size presets offered in the Trip Planner flow. */
export type TripRadiusPreset = 'town' | 'town_and_around' | 'region';

/**
 * /users/{uid}/trips/{tripId} — a manually-downloaded offline area for
 * travel. First-class entity (not just a cache region) so it can carry
 * dates, appear on the Calendar, and serve as the extension point for a
 * future Vacation Planner (KAN-239) — do not collapse this into the habitat
 * cache's SQLite table.
 */
export interface Trip {
  id: string;
  /** Free-text destination label as typed/selected, e.g. "Faro, Portugal". */
  destination: string;
  /** Google Place ID the destination resolved to. */
  placeRef: string;
  /**
   * Center coordinates snapshotted at download time — this is the trip's own
   * datum (a destination the user chose), not a re-cached POI, so Google
   * Places' no-long-term-coordinate-caching ToS (see maps.ts/habitatCache.ts)
   * doesn't apply to it the way it does to individual POI rows.
   */
  centerLat: number;
  centerLng: number;
  /** YYYY-MM-DD — optional; the flow encourages but doesn't require dates. */
  startDate?: string;
  endDate?: string;
  /** Meters — one of tripDownload.ts's TRIP_RADIUS_PRESETS values. */
  areaRadius: number;
  /** Joins to habitatCache's habitat_places.cache_area_id. */
  cacheAreaId: string;
  /** Epoch ms this trip's cached rows are considered valid until. */
  expiresAt: number;
  /** Set once the day-before-departure pre-refresh has run, so it isn't repeated every app open during the trip window. */
  preRefreshedAt?: number;
  /**
   * KAN-246 — absent (undefined) for a regular future/destination trip.
   * `'offgrid'` marks a now + duration connectivity window instead (center =
   * current location or a chosen override, startDate = today, expiresAt =
   * precise end time, no day-level grace margin). Off-grid trips never
   * appear on the Calendar and are excluded from "Where we've been" — a
   * Tuesday hike is not a trip memory.
   */
  kind?: 'offgrid';
  createdAt: FirebaseFirestoreTypes.Timestamp;
}

/**
 * /users/{uid}/mallSnapshot/current — the single currently-active mall
 * snapshot, if any (KAN-237). Singleton (not a collection like Trip) since
 * only one mall can be "learned" at a time via the Profile toggle.
 */
export interface MallSnapshot {
  placeId: string;
  name: string;
  centerLat: number;
  centerLng: number;
  /** Meters — MALL_SEARCH_RADIUS_M, reused from indoorDetection.ts. */
  radius: number;
  /** Joins to habitatCache's habitat_places.cache_area_id — fixed constant, see mallSnapshots.ts. */
  cacheAreaId: string;
  /** Epoch ms — short-term per Google Places ToS (session/visit scale). */
  expiresAt: number;
  createdAt: FirebaseFirestoreTypes.Timestamp;
}
