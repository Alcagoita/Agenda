import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import worker, { type Env } from '../index';
import { d1Binding } from './d1TestDb';

/**
 * KAN-404 — `poi_candidate` must be invisible to nearby search.
 *
 * It is invisible today because matching goes through `poi_type` and a
 * candidate has no `poi_type` row. That is a property of the schema, not a
 * promise anyone made, and the table is about to hold ~170k unreviewed
 * rows — including roads, housing developments and company registrations.
 * If a later change ever reads candidates on the hot path, this is what
 * fails.
 *
 * Deliberately end-to-end through the real handler against real SQLite
 * carrying the project's own schema files, rather than a fake that answers
 * the queries the handler is expected to issue: a fake proves the handler
 * asks what we think it asks, and the question here is what the database
 * hands back when it asks.
 */
const ROOT = join(__dirname, '..', '..');
const LAT = 38.7223;
const LNG = -9.1393;

function dbWithCandidate(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of [
    'country_schema.sql', 'place_schema.sql', 'schema.sql',
    'poi_type_schema.sql', 'poi_attribute_schema.sql', 'type_relation_schema.sql',
  ]) {
    db.exec(readFileSync(join(ROOT, file), 'utf8'));
  }
  // curated_poi lives in a migration rather than a schema file; nearby
  // queries all three sources, so all three must exist for the handler to
  // run at all.
  for (const migration of [
    '0008_moderated_manual_pois.sql',
    '0010_brand_aware_nearby.sql',
    '0026_poi_candidate.sql',
  ]) {
    db.exec(readFileSync(join(ROOT, 'migrations', migration), 'utf8'));
  }
  // curated_poi.floor comes from migration 0030, which nearby now selects.
  // Only this one column is taken rather than the whole migration: 0030 also
  // adds overture_poi.floor, and schema.sql already declares that, so
  // replaying the file here fails on a duplicate column.
  db.exec('ALTER TABLE curated_poi ADD COLUMN floor TEXT;');

  // A candidate sitting exactly where the search is pointed, carrying a
  // category we do map, with a name that reads like a real errand. If
  // anything is going to leak, this is the row that leaks.
  db.prepare(
    `INSERT INTO poi_candidate
       (fsq_place_id, name, lat, lng, address, locality,
        raw_category_ids, raw_category_labels, imported_at)
     VALUES ('cand-1', 'Talho Central', ?, ?, 'Rua A', 'Lisboa',
             '52f2ab2ebcbc57f1066b8b38',
             'Business and Professional Services > Lottery Retailer', 't')`,
  ).run(LAT, LNG);
  return db;
}

function nearbyRequest(types: string[]) {
  return new Request('https://poi-api.test/poi/nearby', {
    method: 'POST',
    headers: { 'X-Api-Key': 'test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: LAT, lng: LNG, radius: 1000, limitPerRequest: 20,
      requests: types.map(type => ({ key: type, type })),
    }),
  });
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function nearby(db: DatabaseSync, types: string[]) {
  const env = { API_KEY: 'test-key', REGISTRY_DB: d1Binding(db) } as unknown as Env;
  const res = await worker.fetch(nearbyRequest(types), env, CTX);
  return { status: res.status, body: JSON.stringify(await res.json()) };
}

describe('KAN-404 poi_candidate is invisible to nearby search', () => {
  it('never returns a candidate row', async () => {
    const db = dbWithCandidate();
    const { status, body } = await nearby(db, ['store', 'restaurant', 'cafe']);
    expect(status).toBe(200);
    expect(body).not.toContain('Talho Central');
    expect(body).not.toContain('cand-1');
  });

  it('stays invisible even when a promoted-looking status is set', async () => {
    // promotion_status is a note to humans, not a switch that publishes a
    // row. Promotion is a copy into a serving table, and nothing else.
    const db = dbWithCandidate();
    db.exec("UPDATE poi_candidate SET promotion_status = 'promoted'");
    const { body } = await nearby(db, ['store']);
    expect(body).not.toContain('Talho Central');
  });

  it('returns a real poi from the same spot, so the search itself works', async () => {
    // Without this the first two assertions would pass on a broken query
    // that returns nothing at all.
    const db = dbWithCandidate();
    db.prepare(
      `INSERT INTO overture_poi (overture_id, name, lat, lng, geohash, primary_poi_type,
                                 dedupe_name, imported_at, updated_at)
       VALUES ('real-1', 'Mercearia Boa', ?, ?, ?, 'store', 'merceariaboa', 't', 't')`,
    ).run(LAT, LNG, 'eycs0');
    db.prepare("INSERT INTO overture_poi_type (overture_id, poi_type, rank) VALUES ('real-1','store',0)").run();
    const { body } = await nearby(db, ['store']);
    expect(body).toContain('Mercearia Boa');
    expect(body).not.toContain('Talho Central');
  });

  it('is not referenced anywhere in the Worker', () => {
    // The read path is one file. A candidate table that nothing in the
    // Worker can name cannot be queried by it, however the SQL is built.
    const worker = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
    expect(worker).not.toContain('poi_candidate');
  });
});
