import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * KAN-398 — the merge rules are data, so the data is what gets tested.
 *
 * `gas`, `post`, `clinic` and `bus` are in POI_CATALOG and were offered to
 * users while matching literally zero rows, because the classifier stores
 * Google Places names and the app queries its own shorter words. These
 * assertions are the guard against that reappearing — and against the
 * opposite mistake of merging two types that are genuinely different
 * errands.
 */
const ROOT = join(__dirname, '..', '..');

const SCHEMA = readFileSync(join(ROOT, 'type_relation_schema.sql'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'migrations', '0022_bridge_classifier_vocabulary.sql'), 'utf8');
const ICE_CREAM_MIGRATION = readFileSync(join(ROOT, 'migrations', '0023_ice_cream_poi_type.sql'), 'utf8');
/** The table definition alone, without the rows the schema seeds. */
const CREATE_TABLE = SCHEMA.split('INSERT OR IGNORE')[0];

function mapOf(db: DatabaseSync): Map<string, Set<string>> {
  const rows = db.prepare('SELECT search_type, include_type FROM type_relation')
    .all() as { search_type: string; include_type: string }[];
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!map.has(row.search_type)) map.set(row.search_type, new Set());
    map.get(row.search_type)!.add(row.include_type);
  }
  return map;
}

/** The full canonical shape: what a database created from scratch has. */
function relations(): Map<string, Set<string>> {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return mapOf(db);
}

/**
 * The migration applied to an empty table, so what it writes is measured on
 * its own. Running it over a schema that already contains its rows proves
 * nothing — INSERT OR IGNORE makes that a no-op whatever the file says.
 */
function migrationOnly(sql: string = MIGRATION, times = 1): Map<string, Set<string>> {
  const db = new DatabaseSync(':memory:');
  db.exec(CREATE_TABLE);
  for (let i = 0; i < times; i += 1) db.exec(sql);
  return mapOf(db);
}

describe('KAN-398 classifier vocabulary bridges', () => {
  it('gives the four dead catalog types something to match', () => {
    const map = relations();
    expect(map.get('gas')).toEqual(new Set(['gas', 'gas_station']));
    expect(map.get('post')).toEqual(new Set(['post', 'post_office']));
    expect(map.get('clinic')).toEqual(new Set(['clinic', 'doctor']));
    expect(map.get('bus')).toEqual(new Set(['bus', 'bus_station']));
  });

  it('lets an ice cream search reach the shops already classified', () => {
    // 1,369 rows carried ice_cream_shop while the app had no such type, so
    // nobody could reach any of them (KAN-399).
    const map = relations();
    expect(map.get('ice_cream')).toEqual(new Set(['ice_cream', 'ice_cream_shop']));
    expect(map.get('ice_cream_shop')).toEqual(new Set(['ice_cream_shop', 'ice_cream']));
  });

  it('reaches the same ice cream mapping through the migration, twice over', () => {
    // Production gets here by running the migration, not by seeding the
    // schema, so the migration is exercised on its own — and applied twice,
    // since an operator re-running it must not be able to break anything.
    const expected = new Map([
      ['ice_cream', new Set(['ice_cream', 'ice_cream_shop'])],
      ['ice_cream_shop', new Set(['ice_cream_shop', 'ice_cream'])],
    ]);
    expect(migrationOnly(ICE_CREAM_MIGRATION)).toEqual(expected);
    expect(migrationOnly(ICE_CREAM_MIGRATION, 2)).toEqual(expected);
  });

  it('lets cafe reach the coffee shops it was missing', () => {
    expect(relations().get('cafe')).toEqual(new Set(['cafe', 'coffee_shop']));
  });

  it('never drops its own type when a search type gains a partner', () => {
    // The failure mode this guards is silent: a search_type with rows but
    // no self-row stops matching itself entirely, because loadTypeRelations
    // only falls back to [poiType] when there are no rows at all.
    for (const [searchType, includes] of relations()) {
      expect(includes.has(searchType)).toBe(true);
    }
  });

  it('keeps genuinely different errands apart', () => {
    const map = relations();
    // A dentist, a hospital and a physiotherapist are searched for by name,
    // not stumbled upon. Answering "find a dentist" with a physiotherapist
    // is worse than answering with nothing.
    for (const unrelated of ['dentist', 'hospital', 'medical_lab', 'physiotherapist']) {
      expect(map.get('clinic')?.has(unrelated)).toBeFalsy();
    }
    // A metro station is a different mode of transport, not another word
    // for a bus stop.
    for (const otherMode of ['train_station', 'subway_station', 'transit_station']) {
      expect(map.get('bus')?.has(otherMode)).toBeFalsy();
    }
    // Documented as deliberately isolated when this table was created:
    // a quick top-up is a different intent from the weekly grocery run.
    expect(map.has('convenience_store')).toBe(false);
    // Hair, full-service beauty and nails are three errands, not one.
    // KAN-401 splits them properly; nothing here may pre-empt it.
    expect(map.has('salon')).toBe(false);
  });

  it('leaves the pre-existing merges untouched', () => {
    const map = relations();
    expect(map.get('atm')).toEqual(new Set(['atm', 'bank']));
    expect(map.get('supermarket')).toEqual(new Set(['supermarket', 'grocery_store']));
    expect(map.get('gym')).toEqual(new Set(['gym', 'fitness_center']));
    expect(map.get('bar')).toEqual(new Set(['bar', 'pub']));
    expect(map.get('lodging')).toEqual(new Set(['lodging', 'hotel']));
    // atm -> bank is containment, deliberately one-way: a bank search must
    // not surface standalone cash machines.
    expect(map.get('bank')).toBeUndefined();
  });

  it('writes exactly the bridges it claims to, in both directions', () => {
    // Measured on an empty table, so this is the migration's own content
    // rather than whatever the schema already happened to contain.
    expect(migrationOnly()).toEqual(new Map([
      ['gas', new Set(['gas', 'gas_station'])],
      ['gas_station', new Set(['gas_station', 'gas'])],
      ['post', new Set(['post', 'post_office'])],
      ['post_office', new Set(['post_office', 'post'])],
      ['cafe', new Set(['cafe', 'coffee_shop'])],
      ['coffee_shop', new Set(['coffee_shop', 'cafe'])],
      ['clinic', new Set(['clinic', 'doctor'])],
      ['doctor', new Set(['doctor', 'clinic'])],
      ['bus', new Set(['bus', 'bus_station'])],
      ['bus_station', new Set(['bus_station', 'bus'])],
    ]));
  });

  it('reaches every bridge from the classifier side too', () => {
    // The reverse rows are what let a search arriving as the classifier's
    // own word still find the app's. Asserted explicitly because writing
    // one direction and forgetting the other is silent.
    const map = relations();
    expect(map.get('gas_station')).toEqual(new Set(['gas_station', 'gas']));
    expect(map.get('post_office')).toEqual(new Set(['post_office', 'post']));
    expect(map.get('coffee_shop')).toEqual(new Set(['coffee_shop', 'cafe']));
    expect(map.get('doctor')).toEqual(new Set(['doctor', 'clinic']));
    expect(map.get('bus_station')).toEqual(new Set(['bus_station', 'bus']));
  });

  it('keeps the schema and the migration in step', () => {
    // The schema is what a fresh database gets; the migration is how an
    // existing one catches up. If they drift, the two stop behaving alike.
    const schema = relations();
    for (const [searchType, includes] of new Map([...migrationOnly(), ...migrationOnly(ICE_CREAM_MIGRATION)])) {
      for (const include of includes) {
        expect(schema.get(searchType)?.has(include)).toBe(true);
      }
    }
  });
});
