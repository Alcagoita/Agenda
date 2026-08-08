# Brush

A location-aware to-do app for iOS and Android built with React Native.  
When you're near a Point of Interest tied to one of your tasks, the app surfaces a hero alert and offers a one-tap "Open in Maps" route.

> **We're not another planner — we're a reminder of what you need to do.**

---

## Tech Stack

| Layer | Library |
|---|---|
| Framework | React Native 0.85.3 |
| Expo SDK | ~56 (modules only — not Expo Go) |
| Auth | Firebase Authentication (email/password, Google, Apple) |
| Database | Firebase Firestore |
| Push notifications | Firebase Cloud Messaging + Notifee |
| Geolocation | expo-location + expo-task-manager |
| Calendar access | expo-calendar |
| Maps / Places | Native map handoff + Cloudflare POI API with OSM fallback |
| Font | Geist |

---

## Getting Started

### Prerequisites

- Node >= 22.11.0
- Ruby (for CocoaPods)
- Xcode 15+ (iOS builds)
- Android Studio (Android builds)
- [React Native environment setup](https://reactnative.dev/docs/set-up-your-environment)

### Install dependencies

```sh
npm install
```

### iOS — install native deps

```sh
bundle install
bundle exec pod install
```

### Run

```sh
# iOS
npm run ios

# Android
npm run android

# Metro bundler (separate terminal)
npm start
```

---

## Firebase Setup

### Android

Place `google-services.json` in `android/app/`.

Android `release` builds also require a dedicated upload keystore. Copy
`android/keystore.properties.example` to `android/keystore.properties`, then set:

- `BRUSH_UPLOAD_STORE_FILE`
- `BRUSH_UPLOAD_STORE_PASSWORD`
- `BRUSH_UPLOAD_KEY_ALIAS`
- `BRUSH_UPLOAD_KEY_PASSWORD`

Those same four values can be supplied in CI or EAS as environment variables or
Gradle properties instead of a local `android/keystore.properties` file.

For internal test APKs only, you can intentionally keep the `release` build type
but sign it with `debug.keystore` by setting
`BRUSH_ALLOW_DEBUG_RELEASE_SIGNING=true`. Production and store builds should use
the dedicated upload keystore instead.

### iOS

Place `GoogleService-Info.plist` in `ios/Brush/`.

---

## Authentication Setup

### Email / Password

Enable in Firebase Console → Authentication → Sign-in method → Email/Password.

### Google Sign-In

**Firebase Console**
1. Authentication → Sign-in method → Google → Enable
2. Copy the **Web client ID** and set it as `webClientId` in `src/services/auth.ts`

**Android** — no extra steps; `google-services.json` contains the OAuth config.

**iOS**
1. Open `ios/Brush.xcworkspace` in Xcode
2. Add the **reversed client ID** from `GoogleService-Info.plist` as a URL scheme:  
   Project → Info → URL Types → `+` → paste `REVERSED_CLIENT_ID` value

### Apple Sign-In (iOS only)

**Apple Developer Account**
1. Certificates, Identifiers & Profiles → Identifiers → select your App ID
2. Enable **Sign in with Apple** → Save

**Xcode**
1. Open `ios/Brush.xcworkspace`
2. Target → Signing & Capabilities → `+` → Sign in with Apple

**Firebase Console**  
Authentication → Sign-in method → Apple → Enable

> Apple Sign-In is required for App Store submissions that include third-party social sign-in. The button is hidden on Android automatically.

---

## Project Structure

```
src/
  screens/
    TodayScreen/                  — main task list + proximity hero
    LoginScreen.tsx
    OnboardingScreen.tsx
    ProfileScreen.tsx
    PublicProfileScreen.tsx       — shareable profile via brushaway.app/u/:username
    AchievementsScreen.tsx
    PointsHistoryScreen.tsx
    SocialHubScreen.tsx
    CreateChallengeScreen.tsx
    ChallengeDetailScreen.tsx
    CompareAchievementsScreen.tsx
    SharedTaskInboxScreen.tsx
    ContactSuggestionsScreen.tsx
    ShareReceiveScreen.tsx        — handles share-extension imports
    ShareToDoScreen.tsx
    CalendarScreen.tsx
    TaskFormScreen/
    CategoriesScreen.tsx
    SettingsScreen.tsx
    NotificationPreferencesScreen.tsx
    UsernameSetupScreen.tsx
    SplashScreen.tsx
    DevToolsScreen.tsx
    HomeAddressScreen.tsx         — set/edit home base for off-grid + errand logic
    PlacesIKnowScreen.tsx         — user-learned places
    OffGridScreen.tsx             — off-grid window management
    TripPlannerScreen.tsx
    WhereWeveBeenScreen.tsx

  components/
    NearbyCard.tsx                — hero proximity card
    TaskRow.tsx
    ProgressRing.tsx
    PoiChip.tsx
    Header.tsx
    Avatar.tsx
    AppIcon/
    ShareProfileSheet.tsx
    ShareTaskSheet.tsx
    ErrandBundleCard.tsx
    TripSuggestionCard.tsx
    TierLadder.tsx / TierMedal.tsx
    EventCard.tsx / MiniCalendar.tsx / CalendarRing.tsx
    ErrorBoundary.tsx / Toast.tsx
    …

  services/
    firebase.ts                   — Firebase init
    appCheck.ts                   — App Check abuse controls
    auth.ts                       — email, Google, Apple sign-in
    firestore/                    — Firestore helpers + points
    proximity.ts                  — Cloudflare/OSM POI search + distance logic
    indoorProximity.ts            — GPS accuracy-based indoor detection
    indoorDetection.ts
    geolocation.ts                — background location via expo-location
    maps.ts                       — Cloudflare POI routing, OSM geocoding, map handoff
    osmPlaces.ts                  — OpenStreetMap fallback places source
    mallSnapshots.ts              — indoor mall/venue snapshot caching
    poiTypeCache.ts / poiInference.ts — POI classification + local keyword dictionary
    learnedPlaces.ts              — user-specific learned place memory
    habitatCache.ts               — cached routine/habitat area data
    errandBundles.ts              — grouped errand suggestions
    tripDownload.ts / tripSuggestions.ts — offline trip planning
    offGrid.ts                    — off-grid window logic
    home.ts                       — home address handling
    functions.ts                  — on-device task parsing (no AI cost)
    rewardFunctions.ts            — points/rewards Cloud Function calls
    sharing.ts                    — friend task send/receive
    achievements.ts
    challenges.ts
    notifications.ts
    calendar.ts                   — expo-calendar import
    import.ts
    contacts.ts
    events.ts
    birthday.ts
    wearSync.ts                   — Wear OS companion bridge
    battery.ts
    storeTuning.ts
    crashlytics.ts
    analytics.ts
    deviceLocale.ts
    poiLlm.ts

  hooks/
    useAuth.ts
    useTodayScreen/
    useFCM.ts
    useEvents.ts
    useCategoriesScreen.ts
    useHomeAddress.ts
    useOffGridWindow.ts / useOffGridWelcomeBack.ts
    useOfflineCoverage.ts
    useTripPlanner.ts
    usePlacesIKnow.ts
    useWhereWeveBeen.ts
    useErrandBundle.ts
    useMallSnapshotToggle.ts

  theme/
    tokens.ts                     — color, spacing, radius constants
    ThemeContext.tsx               — useTheme() hook (light / dark)

  constants/
    copy.ts                       — all user-facing strings
    tiers.ts                      — points tier data + deriveTierStanding()
    googlePlaceTypes.ts
    poiDictionary.en.json / poiDictionary.pt-PT.json

  types/
    index.ts                      — Task, User, PoiType, etc.

  native/
    WearNotificationModule.ts     — Wear OS native bridge
    WearSyncModule.ts

functions/
  src/
    index.ts
    parseMessageToTask.ts         — rate-limited AI task parsing
    places.ts                     — Places API proxy with abuse controls
    rewards.ts
    onSharedTaskCreated.ts / onFriendActivity.ts / onFollowRequest.ts
    onChallengeNotifications.ts
    onUserInactive.ts / onUserLapsed.ts
    rolloverIncompleteTasks.ts
    sweepPoiInferenceMisses.ts

__tests__/                        — Jest + @testing-library/react-native
docs/
  design/                         — design handoff files
```

---

## Features

- **Proximity alerts** — Places API search within 400 m; hero card at < 100 m; silent notification on geofence entry
- **Indoor detection** — GPS accuracy heuristic for indoor proximity matching, with mall/venue snapshot caching
- **Learned places & habitats** — remembers user-specific places and routine areas over time
- **Errand bundles** — groups nearby errands into a single suggested trip
- **Trip planner & offline coverage** — plan trips and check offline map coverage ahead of time
- **Off-grid mode** — scheduled windows where location tracking and alerts pause
- **Points + tiers** — earn points on task completion; Tin → Vibranium ladder
- **Achievements** — badge system tied to task and proximity streaks
- **Social** — friend list, task sharing (send/receive), public profiles, challenges
- **Deep links** — `brushaway.app/u/:username` opens public profiles in-app
- **Calendar import** — pull tasks from device calendar via expo-calendar
- **Wear OS companion** — proximity alerts forwarded to paired watch, hardened message service
- **Dark / light theme** — stored in Firestore + system `Appearance` API
- **Share extension** — import text shared from other apps as tasks
- **Backend abuse controls** — App Check enforcement, rate-limited Cloud Functions, Places API proxy limits

---

## Branching (Gitflow)

| Branch type | Cut from | Merges into | Naming |
|---|---|---|---|
| Feature | `develop` | `develop` | `KAN-XX-short-description` |
| Release | `develop` | `main` + `develop` | `release/X.Y.Z` |
| Hotfix | `main` | `main` + `develop` | `hotfix/short-description` |

All feature and bugfix branches use the `KAN-XX-` prefix.

---

## Troubleshooting

- **Metro cache**: `npm start -- --reset-cache`
- **iOS build errors**: `bundle exec pod install --repo-update`
- **Android build errors**: `cd android && ./gradlew clean`
- **Expo modules out of sync**: `npx expo prebuild --clean` (iOS only, don't commit the generated files)
