# Offline / airplane-mode behavior — KAN-227

Verification pass over what already works offline, what doesn't, and what's deliberately deferred. This is a snapshot, not a living doc — re-verify before relying on it if the underlying code has moved on.

## What already works offline (no new plumbing needed)

Firestore offline persistence is enabled with an unlimited on-device cache (`src/services/firebase.ts`, `cacheSizeBytes: CACHE_SIZE_UNLIMITED`), which lets any write commit locally and sync later regardless of timestamp strategy. Task writes specifically (`addTask`, `setTaskDone`, `rolloverIncompleteTasks`) go one step further and use `Timestamp.now()` instead of `serverTimestamp()`, so the value is readable immediately rather than resolving only after the server round-trip — verified in `__tests__/services/offlineFirst.test.ts`. This `Timestamp.now()` pattern is specific to the task flows; most other write paths (achievements, points, challenges, sharing, social, user profile) use `serverTimestamp()` and still rely on offline persistence alone, not on this immediate-read timestamp trick.

- **Task create / edit / brush (mark done) / delete** — work fully offline and sync automatically once connectivity returns, per Firestore's own offline-persistence guarantees (see below) and the timestamp behavior already verified in `__tests__/services/offlineFirst.test.ts`.
- **Progress ring / streak** — derived from local task state, updates immediately offline.
- **Outdoor proximity search queueing** — if `searchNearbyPlaces` fails while offline, the search is queued (`src/services/proximity.ts`, KAN-205) and flushed automatically on reconnect via a `NetInfo` listener. Covered by `__tests__/services/proximityOfflineQueue.test.ts`.

## What breaks offline

| Feature | File | What happens |
|---|---|---|
| **Initial sign-in** | `src/screens/LoginScreen.tsx` (Firebase Auth) | Auth itself requires a network round-trip. A user who has never signed in before cannot get into the app offline. Once signed in at least once, the session persists and subsequent app launches work offline. |
| **Task import (Google Tasks / Calendar)** | `src/services/import.ts` | `googleFetch()` calls straight to Google's API with an OAuth bearer token — no offline queueing. Offline, the request fails and the import flow times out (30s hard timeout, KAN-92). |
| **Free-text POI type search** | `src/services/functions.ts`, `searchPlaceTypes()` | Falls back to `confidence: 'low'` when the API is unreachable rather than failing hard — degrades gracefully, but the suggestion quality drops. |
| **Nearby-zone / hero card on cold start offline** | `src/services/proximity.ts` | If the app is launched fresh while offline (no prior search this session), `runProximitySearch` has nothing cached to show — the hero/nearby card simply doesn't appear until a search succeeds. This is the gap flagged during KAN-227 review. **Deliberately not fixed here** — the real fix is a local POI cache (KAN-228, "habitat POI cache") feeding a cache-backed proximity check (KAN-229), both later in the Sprint 16 queue by design (cache before proximity surgery). |
| **Challenges / social notifications** | `src/services/challenges.ts`, `src/services/firestore/social.ts` | The Firestore writes themselves work offline (challenge created, follow request created locally). The server-side Cloud Functions that fire the *notification* to the other party (`onChallengeNotifications`, `onFollowRequest`, `onSharedTaskCreated`) only run once the write reaches the server — so the other user won't be notified until the device reconnects. Not a data-loss risk, just delayed delivery. |

## E2E / Detox — explicitly out of scope

A Detox airplane-mode E2E suite was attempted for this ticket, then dropped by team decision: getting it running would have required wiring native Detox instrumentation into both iOS and Android from scratch (neither platform has it — no `androidTest` module/`testInstrumentationRunner` on Android, no Detox Podfile entry or built app on iOS), which is real native-project work with no existing foundation to build on, not something achievable as part of this ticket. The offline behavior itself is still verified — via the source-level audit above, plus the existing unit test suite (`offlineFirst.test.ts`, `proximityOfflineQueue.test.ts`) — just not via an automated UI-driven E2E run. "Full offline flow green in CI" is not literally satisfied by this ticket; treat the audit above as the substitute deliverable.
