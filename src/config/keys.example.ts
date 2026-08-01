/**
 * keys.example.ts — API key template.
 *
 * How to set up:
 *   1. Copy this file to src/config/keys.ts
 *   2. Replace the placeholder values below with your real app-restricted keys.
 *   3. keys.ts is gitignored — it will never be committed.
 *
 * Google Places Web Service key:
 *   1. Go to https://console.cloud.google.com/apis/credentials
 *   2. Create a new API key under the "Agenda" project.
 *   3. Restrict the key to "Places API (New)" only.
 *   4. Store it as the Firebase Functions secret `GOOGLE_PLACES_API_KEY`.
 *
 * Enabled APIs (must be active in the Cloud Console for the key to work):
 *   - Places API (New)  →  https://console.cloud.google.com/apis/library/places.googleapis.com
 *
 * The Trip Planner's radius preview (KAN-321) uses react-native-maps instead
 * of a Google Static Maps key — see app.json's react-native-maps plugin
 * entry for the Android Maps SDK key (Android has no non-Google native map
 * provider; iOS uses Apple Maps by default, no key needed).
 */

/** Google OAuth web client ID — from google-services.json / GoogleService-Info.plist. */
export const GOOGLE_OAUTH_WEB_CLIENT_ID = 'YOUR_GOOGLE_OAUTH_WEB_CLIENT_ID';
