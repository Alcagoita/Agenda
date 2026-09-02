import { describe, it, expect, vi } from 'vitest';

// index.ts imports getContainer/Container at module load (KAN-354) — mock so
// importing the handler doesn't need a Container runtime.
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import worker, { type Env } from '../index';

/**
 * KAN-344 end-to-end (Worker layer): a structured POST /poi/nearby request
 * with a group cuisine (pizza/asian) must return only that group's matches,
 * while a generic restaurant request returns the broad bucket. Hand-rolled
 * fake D1 answers exactly the queries queryNearbyPoiDb issues (type_relation +
 * one SELECT per source) — brittle to a query-text change by design, the
 * tradeoff for exercising the real handler without SQLite.
 *
 * KAN-438 moved the base source from Foursquare to Overture and inverted the
 * suppression order, so several of these assert the opposite of what they
 * used to. Measured against two malls' published tenant lists, Foursquare
 * scored 46% and 48% precision, Overture 60% and 70%, OSM 74% and 92% — a
 * stale Foursquare row was suppressing a correct OSM one 20 m away.
 */
interface FakePoi {
  overture_id: string;
  name: string;
  food_cuisine?: string[];
  financial_service_kind?: string[];
  primary_poi_type?: string;
  brand?: string | null;
}

interface FakeCuratedPoi {
  poi_id: string;
  name: string;
  primary_poi_type: string;
  food_cuisine?: string[];
}

interface FakeOsmPoi {
  osm_element_id: string;
  name: string;
  primary_poi_type: string;
  food_cuisine?: string[];
}

interface FakeMultibancoPoi {
  source_id: string;
  name: string;
  primary_poi_type: string;
  is_demo_zone?: number;
}

interface FakeSourceCorrection {
  source: 'overture' | 'openstreetmap';
  source_id: string;
  visible: number;
  name_override?: string | null;
  dedupe_name_override?: string | null;
}

const LAT = 38.72;
const LNG = -9.14;

function fakeDb(
  pois: FakePoi[], curatedPois: FakeCuratedPoi[] = [], osmPois: FakeOsmPoi[] = [],
  sourceCorrections: FakeSourceCorrection[] = [], multibancoPois: FakeMultibancoPoi[] = [],
): Env['REGISTRY_DB'] {
  const prepare = (sql: string) => {
    const trimmed = sql.trim();
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      async all() {
        if (trimmed.startsWith('SELECT search_type, include_type FROM type_relation')) {
          return { results: [] };
        }
        // KAN-377 — /poi/nearby resolves the settlement alongside the POI
        // query so the client can name the area offline. These fixtures are
        // about POI matching, so no place row: placeName comes back null.
        if (trimmed.startsWith('SELECT * FROM place WHERE min_lat IS NOT NULL')) {
          return { results: [] };
        }
        if (trimmed.startsWith('SELECT overture_poi.overture_id')) {
          const results: unknown[] = [];
          for (const p of pois) {
            const correction = sourceCorrections.find(candidate => candidate.source === 'overture' && candidate.source_id === p.overture_id);
            const base = {
              overture_id: p.overture_id, dedupe_name: p.name.toLowerCase(), name: p.name, lat: LAT, lng: LNG,
              primary_poi_type: p.primary_poi_type ?? 'restaurant', brand: p.brand ?? null,
              address: null, floor: null, open_min: null, close_min: null,
              matched_type: p.primary_poi_type ?? 'restaurant',
              correction_visible: correction?.visible ?? null,
              correction_name_override: correction?.name_override ?? null,
              correction_dedupe_name_override: correction?.dedupe_name_override ?? null,
            };
            const attributes = [
              ...(p.food_cuisine ?? []).map(value => ({ dimension: 'food_cuisine', value })),
              ...(p.financial_service_kind ?? []).map(value => ({ dimension: 'financial_service_kind', value })),
            ];
            if (attributes.length === 0) {
              results.push({ ...base, attribute_dimension: null, attribute_value: null });
            } else {
              for (const attribute of attributes) {
                results.push({ ...base, attribute_dimension: attribute.dimension, attribute_value: attribute.value });
              }
            }
          }
          return { results };
        }
        if (trimmed.startsWith('SELECT curated_poi.poi_id')) {
          const results: unknown[] = [];
          for (const p of curatedPois) {
            const base = {
              poi_id: p.poi_id, dedupe_name: p.name.toLowerCase(), name: p.name, lat: LAT, lng: LNG,
              primary_poi_type: p.primary_poi_type, address: null, floor: null,
            };
            const cuisines = p.food_cuisine ?? [];
            if (cuisines.length === 0) {
              results.push({ ...base, attribute_dimension: null, attribute_value: null });
            } else {
              for (const value of cuisines) {
                results.push({ ...base, attribute_dimension: 'food_cuisine', attribute_value: value });
              }
            }
          }
          return { results };
        }
        if (trimmed.startsWith('SELECT osm_poi.osm_element_id')) {
          const results: unknown[] = [];
          for (const p of osmPois) {
            const correction = sourceCorrections.find(candidate => candidate.source === 'openstreetmap' && candidate.source_id === p.osm_element_id);
            const base = {
              osm_element_id: p.osm_element_id, dedupe_name: p.name.toLowerCase(), name: p.name, lat: LAT, lng: LNG,
              primary_poi_type: p.primary_poi_type, brand: null, address: null,
              open_min: null, close_min: null, matched_type: p.primary_poi_type,
              correction_visible: correction?.visible ?? null,
              correction_name_override: correction?.name_override ?? null,
              correction_dedupe_name_override: correction?.dedupe_name_override ?? null,
            };
            const cuisines = p.food_cuisine ?? [];
            if (cuisines.length === 0) {
              results.push({ ...base, attribute_dimension: null, attribute_value: null });
            } else {
              for (const value of cuisines) {
                results.push({ ...base, attribute_dimension: 'food_cuisine', attribute_value: value });
              }
            }
          }
          return { results };
        }
        if (trimmed.startsWith('SELECT source_id, dedupe_name, name, lat, lng, primary_poi_type, address, is_demo_zone')) {
          return { results: multibancoPois.map(p => ({
            ...p, dedupe_name: p.name.toLowerCase(), lat: LAT, lng: LNG, address: 'Odivelas', is_demo_zone: p.is_demo_zone ?? 0,
          })) };
        }
        throw new Error(`fake D1 unhandled all(): ${trimmed}`);
      },
    };
    return stmt;
  };
  return { prepare } as unknown as Env['REGISTRY_DB'];
}

const POIS: FakePoi[] = [
  // Every cuisine is a classified value now. Overture's categories map onto
  // the app's 87 cuisines one-to-one, so there is no label path to fall back
  // to and none is needed.
  { overture_id: 'pz', name: 'Tutto Pizza', food_cuisine: ['pizza'] },
  { overture_id: 'su', name: 'Aron Sushi', food_cuisine: ['sushi'] },
  { overture_id: 'pt', name: 'Portugália', food_cuisine: ['portuguese'] },
];

function nearbyRequest(requests: unknown[]) {
  return new Request('https://poi-api.test/poi/nearby', {
    method: 'POST',
    headers: { 'X-Api-Key': 'test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: LAT, lng: LNG, radius: 1000, requests, limitPerRequest: 20 }),
  });
}

function env(
  pois: FakePoi[] = POIS, curatedPois: FakeCuratedPoi[] = [], osmPois: FakeOsmPoi[] = [],
  sourceCorrections: FakeSourceCorrection[] = [], multibancoPois: FakeMultibancoPoi[] = [],
): Env {
  return { API_KEY: 'test-key', REGISTRY_DB: fakeDb(pois, curatedPois, osmPois, sourceCorrections, multibancoPois) } as unknown as Env;
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const names = (bucket: Array<{ name: string }> | undefined) => (bucket ?? []).map(p => p.name).sort();

describe('POST /poi/nearby — KAN-344 cuisine groups end-to-end', () => {
  it('uses the official MULTIBANCO ATM and suppresses the matching Odivelas source row', async () => {
    const res = await worker.fetch(nearbyRequest([{ key: 'atm', type: 'atm' }]), env([
      { fsq_place_id: 'stale-atm', name: 'ATM', raw_category_labels: '', category_label: '', primary_poi_type: 'atm' },
    ], [], [], [], [
      { source_id: 'multibanco:odivelas', name: 'MULTIBANCO', primary_poi_type: 'atm', is_demo_zone: 1 },
    ]), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; source: string }>> };
    expect(body.results.atm).toEqual([
      expect.objectContaining({ poi_id: 'multibanco:odivelas', source: 'multibanco' }),
    ]);
  });

  it('does not suppress a non-demo-zone ATM source', async () => {
    const res = await worker.fetch(nearbyRequest([{ key: 'atm', type: 'atm' }]), env([
      { fsq_place_id: 'existing-atm', name: 'ATM', raw_category_labels: '', category_label: '', primary_poi_type: 'atm' },
    ], [], [], [], [
      { source_id: 'multibanco:outside', name: 'MULTIBANCO', primary_poi_type: 'atm' },
    ]), CTX);
    const body = await res.json() as { results: Record<string, Array<{ source: string }>> };
    expect(body.results.atm.map(p => p.source).sort()).toEqual(['foursquare', 'multibanco']);
  });

  it('returns an OSM-only POI through the same nearby response', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
    ]), env([], [], [{ osm_element_id: 'node/5335674113', name: 'Santo Amaro', primary_poi_type: 'restaurant' }]), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; fsq_place_id: string | null; source: string }>> };
    expect(body.results.restaurant).toEqual([
      expect.objectContaining({ poi_id: 'node/5335674113', fsq_place_id: null, source: 'openstreetmap' }),
    ]);
  });

  it('keeps the OSM record when it duplicates an Overture row', async () => {
    // The inversion. This asserted the Foursquare row won; OSM measured 74%
    // and 92% precision against two malls' tenant lists against Overture's
    // 60% and 70%, so the more accurate source is the one the user sees.
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
    ]), env([
      { overture_id: 'ovt-santo-amaro', name: 'Santo Amaro' },
    ], [], [
      { osm_element_id: 'node/5335674113', name: 'Santo Amaro', primary_poi_type: 'restaurant' },
    ]), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; source: string }>> };
    expect(body.results.restaurant).toEqual([
      expect.objectContaining({ poi_id: 'node/5335674113', source: 'openstreetmap' }),
    ]);
  });

  it('a curated row outranks both, because a mall operator is the authority', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
    ]), env([
      { overture_id: 'ovt-h3', name: 'H3' },
    ], [
      { poi_id: 'mall:way-1', name: 'H3', primary_poi_type: 'restaurant' },
    ], [
      { osm_element_id: 'node/9', name: 'H3', primary_poi_type: 'restaurant' },
    ]), CTX);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; source: string }>> };
    expect(body.results.restaurant).toEqual([
      expect.objectContaining({ poi_id: 'mall:way-1', source: 'community' }),
    ]);
  });

  it('uses a reviewed OSM replacement instead of its suppressed Overture source', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
    ]), env([
      { overture_id: 'stale-lagar', name: 'Lagar Restaurante' },
    ], [], [
      { osm_element_id: 'way/lagar', name: 'O Lagar', primary_poi_type: 'restaurant' },
    ], [
      { source: 'overture', source_id: 'stale-lagar', visible: 0 },
      { source: 'openstreetmap', source_id: 'way/lagar', visible: 1, name_override: 'Lagar', dedupe_name_override: 'lagar' },
    ]), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string; source: string }>> };
    expect(body.results.restaurant).toEqual([
      expect.objectContaining({ name: 'Lagar', source: 'openstreetmap' }),
    ]);
  });

  it('hides a reviewed duplicate OSM element and keeps its Overture original', async () => {
    // KAN-392's whole mechanism, in the opposite direction to the test above:
    // there the Overture row was the stale one, here the OSM element is the
    // duplicate. 182 PT elements are retired exactly this way.
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
    ]), env([
      { overture_id: 'ovt-martins', name: 'O Martins' },
    ], [], [
      { osm_element_id: 'node/6441622817', name: 'Restaurante Martins', primary_poi_type: 'restaurant' },
    ], [
      { source: 'openstreetmap', source_id: 'node/6441622817', visible: 0 },
    ]), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string; source: string }>> };
    expect(body.results.restaurant).toEqual([
      expect.objectContaining({ name: 'O Martins', source: 'overture' }),
    ]);
  });

  it('returns only pizza matches for a pizza subtype request, all for the broad bucket', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
      { key: 'restaurant:food_cuisine:pizza', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['pizza'] } },
    ]), env(), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string }>> };
    expect(names(body.results.restaurant)).toEqual(['Aron Sushi', 'Portugália', 'Tutto Pizza']);
    // Pizza is its own cuisine and does not drag in Italian: the old group was
    // ['Pizzeria', 'Italian Restaurant'], which made Telepizza Italian.
    expect(names(body.results['restaurant:food_cuisine:pizza'])).toEqual(['Tutto Pizza']);
  });

  it('returns the whole Asian hierarchy for an asian request (umbrella)', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant:food_cuisine:asian', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['asian'] } },
    ]), env(), CTX);
    const body = await res.json() as { results: Record<string, Array<{ name: string }>> };
    // `sushi` is one of the cuisines the asian umbrella covers; `pizza` and
    // `portuguese` are not.
    expect(names(body.results['restaurant:food_cuisine:asian'])).toEqual(['Aron Sushi']);
  });

  it('rejects an unsupported cuisine value before it reaches the grouping', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant:food_cuisine:ramen', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['ramen'] } },
    ]), env(), CTX);
    expect(res.status).toBe(400);
  });

  it('accepts only the requested canonical Gym brand', async () => {
    const gyms: FakePoi[] = [
      { overture_id: 'solinca', name: 'Solinca Coimbra', primary_poi_type: 'gym', brand: 'Solinca' },
      { overture_id: 'fitness-hut', name: 'Fitness Hut Coimbra', primary_poi_type: 'gym', brand: 'Fitness Hut' },
    ];
    const res = await worker.fetch(nearbyRequest([
      { key: 'gym:brand:Solinca', type: 'gym', brand: 'Solinca' },
    ]), env(gyms), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string; brand: string | null }>> };
    expect(body.results['gym:brand:Solinca']).toEqual([
      expect.objectContaining({ name: 'Solinca Coimbra', brand: 'Solinca' }),
    ]);
  });

  it('accepts only the requested optional Store brand', async () => {
    const stores: FakePoi[] = [
      { overture_id: 'worten', name: 'Worten Coimbra', primary_poi_type: 'store', brand: 'Worten' },
      { overture_id: 'fnac', name: 'Fnac Coimbra', primary_poi_type: 'store', brand: 'Fnac' },
    ];
    const res = await worker.fetch(nearbyRequest([
      { key: 'store:brand:Worten', type: 'store', brand: 'Worten' },
    ]), env(stores), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string; brand: string | null }>> };
    expect(body.results['store:brand:Worten']).toEqual([
      expect.objectContaining({ name: 'Worten Coimbra', brand: 'Worten' }),
    ]);
  });

  it('rejects an unknown brand and a brand on an unsupported POI type', async () => {
    const unknown = await worker.fetch(nearbyRequest([
      { key: 'gym:brand:nope', type: 'gym', brand: 'Nope Gym' },
    ]), env(), CTX);
    expect(unknown.status).toBe(400);
    const wrongType = await worker.fetch(nearbyRequest([
      { key: 'cafe:brand:Solinca', type: 'cafe', brand: 'Solinca' },
    ]), env(), CTX);
    expect(wrongType.status).toBe(400);
  });

  it('returns an approved community POI with its own identity, never a fabricated id from another source', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant:food_cuisine:sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['sushi'] } },
    ]), env([], [{ poi_id: 'community:123', name: 'The Sushi Soul', primary_poi_type: 'restaurant', food_cuisine: ['sushi'] }]), CTX);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; fsq_place_id: string | null; source: string }>> };
    expect(body.results['restaurant:food_cuisine:sushi']).toEqual([expect.objectContaining({ poi_id: 'community:123', fsq_place_id: null, source: 'community' })]);
  });

  it('returns only the requested Financial service kind', async () => {
    const services: FakePoi[] = [
      { overture_id: 'credit', name: 'Cofidis', primary_poi_type: 'financial_service', financial_service_kind: ['consumer_credit'] },
      { overture_id: 'insurance', name: 'Fidelidade', primary_poi_type: 'financial_service', financial_service_kind: ['insurance'] },
    ];
    const res = await worker.fetch(nearbyRequest([
      { key: 'financial_service', type: 'financial_service' },
      { key: 'financial_service:financial_service_kind:consumer_credit', type: 'financial_service', attribute: { dimension: 'financial_service_kind', values: ['consumer_credit'] } },
    ]), env(services), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string; attributes: Record<string, string[]> }>> };
    expect(names(body.results.financial_service)).toEqual(['Cofidis', 'Fidelidade']);
    expect(body.results['financial_service:financial_service_kind:consumer_credit']).toEqual([
      expect.objectContaining({ name: 'Cofidis', attributes: { financial_service_kind: ['consumer_credit'] } }),
    ]);
  });
});
