/**
 * osmPlaces.ts — OpenStreetMap / Overpass API integration (KAN-228).
 *
 * Google Places' ToS forbids long-term caching of place coordinates (place
 * IDs only) — see maps.ts for the online live path (autocomplete, pinning,
 * live search), which stays on Google. This file is the OSM-backed source
 * for the offline habitat cache (habitatCache.ts): OpenStreetMap data is
 * ODbL-licensed and safe to persist on-device (attribution shown in
 * SettingsScreen).
 *
 * API reference: https://wiki.openstreetmap.org/wiki/Overpass_API
 *
 * Queries `node`, `way`, AND `relation` elements (`nwr` selector) — most
 * small POI types (pharmacy, cafe, bank, ATM, ...) are mapped as nodes in
 * OSM, but large venues (shopping malls especially — KAN-282, 2026-07-19)
 * are typically mapped as a building-footprint `way`, or a `relation` for a
 * multi-building complex, never a plain point. A `node`-only query made real
 * malls (Centro Comercial Colombo, Strada Outlet, UBBO — all `way`/
 * `relation` in OSM, confirmed via Nominatim) structurally invisible to
 * offline discovery, no matter the radius or tag. `out center bb;` (rather
 * than bare `out;`) makes Overpass return a bounding box for way/relation
 * results — from which we derive both a representative center point (they
 * have no `lat`/`lon` of their own) AND a footprint-area estimate, the
 * factual big-vs-small signal used to filter destination malls from small
 * ones (KAN-282 — see OsmPlace.footprintAreaM2 / mallRoute.ts).
 */

import type { PoiType } from '../types';
import { POI_OSM_TAGS, SUPPLEMENTARY_OSM_TAGS, osmTagValues, poiCatalogLabel } from '../types';
import type { OsmTagSelector } from '../types';
import { getDistanceMeters } from './geoDistance';
import { getCanonicalBrand } from './brandDictionary';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OsmPlace {
  /** OSM element id (use for cross-source identity resolution, never as a display value). */
  osmId: string;
  /** Human-readable place name — falls back to the POI type label if OSM has no name tag. */
  name: string;
  /**
   * True when `name` is the generic tag-value fallback (OSM had no `name`
   * tag), not a real identifying name. habitatCache's identity matching
   * treats generic names as much weaker match evidence — see its docs.
   */
  isGenericName: boolean;
  lat: number;
  lng: number;
  /** Straight-line distance from the search origin in metres. */
  distanceMeters: number;
  /** Approximate building-footprint area in m², from the element's bounding
   *  box (KAN-282). Always a number: the real area for way/relation elements
   *  (a mapped physical footprint), and exactly `0` for node elements, which
   *  are bare points with no area. `0` is meaningful, not missing — it says
   *  "we fetched this with geometry and it genuinely has no footprint",
   *  distinct from a cache row whose area is NULL because it predates this
   *  field (see habitatCache's backfill). Used to tell a real destination
   *  shopping mall (a big building) from a small strip mall or a store
   *  mistagged as one — see mallRoute.ts's size threshold. */
  footprintAreaM2: number;
  /** The place's own site, from the OSM `website` tag (KAN-293). Already in
   *  the Overpass response — `out center bb;` returns every tag — so reading
   *  it costs no extra request. Undefined when OSM has no such tag; we never
   *  go looking for one. */
  website?: string;
  /** Canonical chain inferred from OSM's explicit `brand` tag, when it is in
   * the local catalogue. This is intentionally not guessed from the name. */
  brand?: string;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  /** Only present on way/relation elements, and only when the query uses `out center;` — a computed representative point, since ways/relations have no `lat`/`lon` of their own. */
  center?: { lat: number; lon: number };
  /** Only present on way/relation elements, and only when the query uses `out bb;` — the element's bounding box. */
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

// ─── Fetch with timeout ────────────────────────────────────────────────────────
// Mirrors maps.ts's fetchWithTimeout — not shared across files since it's a
// 5-line wrapper, not worth a cross-file dependency for.

const FETCH_TIMEOUT_MS = 8_000;
const OVERPASS_CLAUSES_PER_REQUEST = 25;

// Overpass's usage policy asks every client to identify itself — unlabeled
// traffic risks being rate-limited or blocked. https://wiki.openstreetmap.org/wiki/Overpass_API#Rules
const USER_AGENT = `BrushApp/${require('../../package.json').version}`;

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ─── Overpass API — Nearby Search ─────────────────────────────────────────────

/**
 * Public Overpass instances, tried in order until one answers (KAN-282). The
 * canonical instance is volunteer-run and genuinely flaky under load — it
 * was observed returning 200, then 504, then 406 within the same minute
 * while testing — and it is now the sole source for mall discovery, so a
 * single-endpoint dependency meant the feature silently had no data.
 *
 * Every entry MUST be a full-planet instance. Region-limited mirrors (e.g.
 * overpass.osm.ch, Switzerland-only) are deliberately excluded: they answer
 * 200 with zero elements outside their region, which is indistinguishable
 * from a legitimate "nothing here" and would poison the empty-result
 * cooldown in habitatCache's refresh.
 */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const METRES_PER_DEGREE_LAT = 111_195;
const DEG_TO_RAD = Math.PI / 180;

/** Bounded — 1 initial attempt + this many retries, per endpoint. Not unlimited: a hung/consistently-erroring endpoint must give up and move on, not retry forever inside the shared timeout budget. */
const MAX_RETRIES_PER_ENDPOINT = 2;
/** Exponential backoff base — 500ms, 1000ms, 2000ms, ... between retries of the SAME endpoint. */
const RETRY_BACKOFF_BASE_MS = 500;

/** 5xx and 408 (timeout) are transient — worth a retry. Anything else (400, 404, ...) means the request itself is wrong and retrying won't help. 429 is handled separately, never here — it's a stop signal, not a retry-with-backoff case (see fetchOverpass). */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Thrown when Overpass returns 429 — a distinct type (not a plain Error) so fetchOverpass's retry loop can recognize it and stop immediately, never caught-and-retried like a transient failure. */
export class OverpassRateLimitedError extends Error {}

/**
 * POSTs `query` to each OVERPASS_ENDPOINTS entry in turn, with bounded
 * exponential-backoff retries per endpoint for transient failures (timeout,
 * network error, 5xx) — returns the first successful response. Throws the
 * last error only if every endpoint's every attempt fails — preserving the
 * contract searchOsmPlacesStrict depends on (a real failure must stay
 * distinguishable from a legitimately empty result, so a trip download can
 * surface an error instead of silently persisting an empty area).
 *
 * A 429 (rate limited) is NOT retried, on this or any other endpoint —
 * Overpass enforces its usage policy by blocking on User-Agent (the same
 * wall already hit with Nominatim), so a 429 means WE are blocked, not
 * "this one endpoint is down." Retrying — even a different endpoint, even
 * after a delay — can't fix a User-Agent block and risks compounding it.
 * Stops the whole call immediately and throws OverpassRateLimitedError.
 *
 * `timeoutMs` is a SHARED deadline across every endpoint AND every retry,
 * not a per-attempt budget (KAN-282 review): trip/mall downloads pass 20s,
 * so a per-attempt timeout would let a foreground spinner run far longer
 * than that before failing. Each attempt gets whatever is left; once the
 * deadline passes, no further attempts are made.
 */
async function fetchOverpass(query: string, timeoutMs: number): Promise<OverpassResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error('Overpass: no endpoint attempted');

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_ENDPOINT; attempt++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) { throw lastError; }

      try {
        const response = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':   USER_AGENT,
          },
          body: `data=${encodeURIComponent(query)}`,
        }, remainingMs);

        if (response.status === 429) {
          throw new OverpassRateLimitedError(`Overpass: rate limited (429) at ${endpoint}`);
        }
        if (response.ok) {
          return (await response.json()) as OverpassResponse;
        }
        lastError = new Error(`Overpass request failed: ${response.status}`);
        if (!isRetryableStatus(response.status)) { break; } // non-retryable — try the next endpoint, not another attempt here
      } catch (err) {
        if (err instanceof OverpassRateLimitedError) { throw err; }
        lastError = err;
        // network error / timeout — treated as retryable, falls through to backoff below
      }

      const hasMoreRetries = attempt < MAX_RETRIES_PER_ENDPOINT;
      if (hasMoreRetries) {
        const backoffMs = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, deadline - Date.now());
        if (backoffMs > 0) { await sleep(backoffMs); }
      }
    }
  }
  throw lastError;
}

/** Rough area (m²) of an OSM bounding box — good enough to tell a big mall
 *  from a small one (KAN-282), not a precise polygon area. Longitude degrees
 *  shrink toward the poles, corrected by cos(latitude). */
function boundingBoxAreaM2(b: { minlat: number; minlon: number; maxlat: number; maxlon: number }): number {
  const latMid = (b.minlat + b.maxlat) / 2;
  const heightM = (b.maxlat - b.minlat) * METRES_PER_DEGREE_LAT;
  const widthM = (b.maxlon - b.minlon) * METRES_PER_DEGREE_LAT * Math.cos(latMid * DEG_TO_RAD);
  return Math.abs(heightM * widthM);
}

/**
 * Search OpenStreetMap for places of all given POI types within
 * `radiusMeters` of `lat`/`lng`, in a single Overpass API call.
 *
 * `poiTypes` accepts our internal PoiType keys (mapped via POI_OSM_TAGS).
 * Unrecognized keys (no OSM tag mapping) are silently skipped.
 *
 * Returns a map keyed by the original poiType, each entry sorted ascending
 * by straight-line distance.
 *
 * Never throws — network error, timeout (8 s by default), or a non-200/
 * malformed response all resolve to an empty result, since this must never
 * block the app (same contract as searchNearbyPlaces).
 *
 * `timeoutMs` defaults to the opportunistic-refresh case's 8s (unchanged
 * behavior). KAN-234's trip downloads pass a longer value — a 40km/16+ type
 * combined query is a meaningfully bigger request than anything the default
 * opportunistic 5km refresh has ever needed to handle, and unlike that
 * silent background refresh, a trip download is a foreground, visible,
 * retryable user action, so it can afford to wait longer before giving up.
 */
export async function searchOsmPlaces(
  lat: number,
  lng: number,
  poiTypes: string[],
  radiusMeters: number,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Record<string, OsmPlace[]>> {
  try {
    return await fetchOsmPlaces(lat, lng, poiTypes, radiusMeters, timeoutMs, true);
  } catch {
    const result: Record<string, OsmPlace[]> = {};
    for (const poiType of poiTypes) { result[poiType] = []; }
    return result;
  }
}

/**
 * Same query as searchOsmPlaces, but throws on timeout/network error/non-200
 * instead of collapsing failure into an empty result (KAN-234). Trip
 * downloads are a foreground, user-initiated, visible-progress action —
 * unlike the silent opportunistic refresh, a failed download must surface as
 * an error/retry, not look identical to "this area genuinely has no POIs".
 */
export async function searchOsmPlacesStrict(
  lat: number,
  lng: number,
  poiTypes: string[],
  radiusMeters: number,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Record<string, OsmPlace[]>> {
  return fetchOsmPlaces(lat, lng, poiTypes, radiusMeters, timeoutMs, false);
}

async function fetchOsmPlaces(
  lat: number,
  lng: number,
  poiTypes: string[],
  radiusMeters: number,
  timeoutMs: number,
  keepPartialResults: boolean,
): Promise<Record<string, OsmPlace[]>> {
  const result: Record<string, OsmPlace[]> = {};
  for (const poiType of poiTypes) { result[poiType] = []; }
  if (poiTypes.length === 0) { return result; }

  // Build one nwr[...] clause per recognized type (node+way+relation in one
  // selector) — skip anything without an OSM tag mapping (e.g. arbitrary
  // custom-category Google Places strings).
  const tagByType: Record<string, OsmTagSelector> = {};
  const clauseEntries: { poiType: string; clause: string }[] = [];
  for (const poiType of poiTypes) {
    const tag = POI_OSM_TAGS[poiType as PoiType] ?? SUPPLEMENTARY_OSM_TAGS[poiType];
    if (!tag) { continue; }
    tagByType[poiType] = tag;
    // A multi-value selector becomes a regex alternation. Some concepts have
    // no single tag value — "a historic place" is castle OR monument OR ruins
    // — and picking one of them would silently drop the others (KAN-406).
    const values = osmTagValues(tag);
    const selector = (values.length === 1
      ? `["${tag.key}"="${values[0]}"]`
      : `["${tag.key}"~"^(${values.join('|')})$"]`)
      // A companion tag narrows the selector rather than replacing it, so
      // Overpass never returns the elements we would only discard.
      + (tag.where ? `["${tag.where.key}"="${tag.where.value}"]` : '');
    clauseEntries.push({ poiType, clause: `nwr${selector}(around:${radiusMeters},${lat},${lng});` });
  }
  if (clauseEntries.length === 0) { return result; }

  for (let i = 0; i < clauseEntries.length; i += OVERPASS_CLAUSES_PER_REQUEST) {
    const chunk = clauseEntries.slice(i, i + OVERPASS_CLAUSES_PER_REQUEST);
    const chunkTypes = new Set(chunk.map(entry => entry.poiType));
    // `out center bb;` — nodes keep their own lat/lon; way/relation elements
    // get a bounding box (bb) instead, from which we derive both a
    // representative center point AND a footprint-area estimate (KAN-282).
    const query = `[out:json][timeout:25];(${chunk.map(entry => entry.clause).join('')});out center bb;`;

    let data: OverpassResponse;
    try {
      data = await fetchOverpass(query, timeoutMs);
    } catch (err) {
      if (keepPartialResults) { continue; }
      throw err;
    }

    for (const el of data.elements ?? []) {
      // Nodes carry lat/lon directly; way/relation elements have no point of
      // their own — derive one from the bounding box midpoint (`center` is
      // requested too as a fallback for any element type that reports it).
      const elLat = el.lat ?? el.center?.lat ?? (el.bounds ? (el.bounds.minlat + el.bounds.maxlat) / 2 : undefined);
      const elLon = el.lon ?? el.center?.lon ?? (el.bounds ? (el.bounds.minlon + el.bounds.maxlon) / 2 : undefined);
      if (elLat == null || elLon == null || !el.tags) { continue; }
      // 0 (not undefined) for bare nodes — see OsmPlace.footprintAreaM2: it
      // records "fetched, genuinely has no footprint", which is what lets the
      // habitat cache tell those apart from rows never fetched with geometry.
      const footprintAreaM2 = el.bounds ? boundingBoxAreaM2(el.bounds) : 0;

      // Assign to the first requested type in this chunk whose tag matches this element.
      for (const poiType of poiTypes) {
        if (!chunkTypes.has(poiType)) { continue; }
        const tag = tagByType[poiType];
        // Same accepted set the clause was built from. Comparing against
        // `tag.value` alone would discard every element the alternation above
        // deliberately asked for.
        if (!tag) { continue; }
        const elementValue = el.tags[tag.key];
        if (elementValue == null || !osmTagValues(tag).includes(elementValue)) { continue; }
        // Same companion the clause was built with — filtering without it
        // would accept every pitch the query happened to return.
        if (tag.where && el.tags[tag.where.key] !== tag.where.value) { continue; }

        result[poiType].push({
          osmId:          `${el.type}/${el.id}`,
          // Raw OSM tag values are lowercase, underscore-separated keys (e.g.
          // "atm") — never leak the tag itself as a display name. Uses
          // poiCatalogLabel directly (not maps.ts's placeTypeLabel, which
          // would create a circular import — see geoDistance.ts) — poiType
          // here is always one of our own internal PoiType keys (this
          // function's own poiTypes param is typed that way), so the
          // Google-type-string-specific middle tier placeTypeLabel adds on
          // top of poiCatalogLabel never applied to OSM callers anyway.
          name:           el.tags.name ?? poiCatalogLabel(poiType as PoiType) ?? poiType,
          isGenericName:  el.tags.name == null,
          lat:            elLat,
          lng:            elLon,
          footprintAreaM2,
          // `contact:website` is the other common OSM spelling for the same thing.
          website:        el.tags.website ?? el.tags['contact:website'],
          brand:          getCanonicalBrand(poiType, el.tags.brand ?? '') ?? undefined,
          distanceMeters: getDistanceMeters(lat, lng, elLat, elLon),
        });
        break;
      }
    }
  }

  for (const poiType of poiTypes) {
    result[poiType].sort((a, b) => a.distanceMeters - b.distanceMeters);
  }

  return result;
}
