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

function relations(): Map<string, Set<string>> {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'type_relation_schema.sql'), 'utf8'));
  const rows = db.prepare('SELECT search_type, include_type FROM type_relation')
    .all() as { search_type: string; include_type: string }[];
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!map.has(row.search_type)) map.set(row.search_type, new Set());
    map.get(row.search_type)!.add(row.include_type);
  }
  return map;
}

describe('KAN-398 classifier vocabulary bridges', () => {
  it('gives the four dead catalog types something to match', () => {
    const map = relations();
    expect(map.get('gas')).toEqual(new Set(['gas', 'gas_station']));
    expect(map.get('post')).toEqual(new Set(['post', 'post_office']));
    expect(map.get('clinic')).toEqual(new Set(['clinic', 'doctor']));
    expect(map.get('bus')).toEqual(new Set(['bus', 'bus_station']));
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

  it('applies the same rows whether the schema or the migration is used', () => {
    // schema.sql is the canonical shape; the migration is how production
    // gets there. They drifting apart is how a fresh database and a
    // migrated one stop behaving the same way.
    const migrated = new DatabaseSync(':memory:');
    migrated.exec(readFileSync(join(ROOT, 'type_relation_schema.sql'), 'utf8'));
    migrated.exec(readFileSync(join(ROOT, 'migrations', '0022_bridge_classifier_vocabulary.sql'), 'utf8'));
    const after = migrated.prepare('SELECT COUNT(*) AS c FROM type_relation').get() as { c: number };
    const rows = [...relations().values()].reduce((total, set) => total + set.size, 0);
    expect(after.c).toBe(rows);
  });
});
