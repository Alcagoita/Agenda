/**
 * poiApi.ts — direct authenticated transport to Brush's Cloudflare POI
 * Worker (KAN-367).
 *
 * Replaces the three Firebase callables that used to stand between the app
 * and poi-api.brushaway.app. They existed to hold the Worker's X-Api-Key,
 * which the client must never carry; the Worker now verifies the app's
 * Firebase ID token itself, so there is nothing left for the hop to do.
 * Identity is still Firebase Auth — only the request path changed.
 *
 * Every request carries a fresh-enough ID token. getIdToken() serves the
 * cached token until it is close to expiry and refreshes transparently
 * otherwise, so this is not a network round trip per call.
 */

import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';

export const POI_API_BASE_URL = 'https://poi-api.brushaway.app';

/**
 * Matches the timeout the retired Firebase proxy applied to its own upstream
 * call — the app's ceiling for a POI request is unchanged by removing the hop.
 */
const POI_API_TIMEOUT_MS = 8_000;
/** Exports are multi-megabyte SQLite files, so they need a longer transport budget than a JSON search. */
const POI_EXPORT_TIMEOUT_MS = 60_000;

/** Thrown for any non-2xx response, so callers can tell HTTP failure from a transport error. */
export class PoiApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'PoiApiError';
  }
}

async function authHeader(): Promise<string> {
  const user = getAuth().currentUser;
  if (!user) {
    throw new Error('POI API request requires a signed-in user');
  }
  return `Bearer ${await user.getIdToken()}`;
}

async function request<T>(path: string, init: { method: 'GET' } | { method: 'POST'; body: unknown }): Promise<T> {
  const authorization = await authHeader();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POI_API_TIMEOUT_MS);

  try {
    const response = await fetch(`${POI_API_BASE_URL}${path}`, {
      method: init.method,
      headers: init.method === 'POST'
        ? { Authorization: authorization, 'Content-Type': 'application/json' }
        : { Authorization: authorization },
      body: init.method === 'POST' ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      // Body is read for the log only — the Worker's error JSON is for
      // diagnosis, never for the user (callers map failures to their own
      // copy).
      //
      // The route is logged without its query string: on these endpoints the
      // query IS the user's coordinates, and neither a console log nor a
      // thrown Error message (which can reach a crash reporter) is a place
      // for someone's position. The route alone is what diagnosis needs.
      const text = await response.text().catch(() => '');
      const route = path.split('?')[0];
      console.warn('[poiApi] request failed', route, response.status, text.slice(0, 200));
      throw new PoiApiError(response.status, `POI API ${route} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function poiApiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

export function poiApiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body });
}

/** Fetches an authenticated binary POI export. The Worker streams its R2 body;
 * this deliberately bypasses the JSON-only request helper above. */
export async function poiApiGetBinary(path: string): Promise<Uint8Array> {
  const authorization = await authHeader();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POI_EXPORT_TIMEOUT_MS);
  try {
    const response = await fetch(`${POI_API_BASE_URL}${path}`, {
      headers: { Authorization: authorization },
      signal: controller.signal,
    });
    if (!response.ok) {
      const route = path.split('?')[0];
      const text = await response.text().catch(() => '');
      console.warn('[poiApi] binary request failed', route, response.status, text.slice(0, 200));
      throw new PoiApiError(response.status, `POI API ${route} failed with ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
