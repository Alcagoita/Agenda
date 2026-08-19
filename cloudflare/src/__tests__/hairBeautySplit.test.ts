import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * KAN-401 — the corrective half of the hair/beauty split.
 *
 * KAN-391's backfill wrote `salon` onto every record whose name said
 * cabeleireiro or barbearia. Under the four-way split those are hairdressers
 * and barbershops, not full-service salons, so the migration reassigns them
 * by the same name that produced the mistake. This is a correction to
 * shipped data, so it is tested rather than trusted.
 */
const ROOT = join(__dirname, '..', '..');
const MIGRATION = readFileSync(join(ROOT, 'migrations', '0025_split_hair_and_beauty.sql'), 'utf8');

function seeded(times = 1) {
  const db = new DatabaseSync(':memory:');
  for (const file of ['country_schema.sql', 'place_schema.sql', 'schema.sql', 'poi_type_schema.sql']) {
    db.exec(readFileSync(join(ROOT, file), 'utf8'));
  }
  db.exec(readFileSync(join(ROOT, 'type_relation_schema.sql'), 'utf8').split('INSERT OR IGNORE')[0]);

  const poi = (id: string, name: string, primary: string) =>
    db.prepare(
      `INSERT INTO poi (fsq_place_id, name, lat, lng, geohash, primary_poi_type, dedupe_name, date_refreshed)
       VALUES (?, ?, 0, 0, 'x', ?, ?, 't')`,
    ).run(id, name, primary, id);
  const type = (id: string, poiType: string, rank: number) =>
    db.prepare('INSERT INTO poi_type (fsq_place_id, poi_type, rank) VALUES (?, ?, ?)').run(id, poiType, rank);

  poi('barbearia', 'Barbearia Candeias', 'salon');
  type('barbearia', 'salon', 0);
  poi('cabeleireiro', 'Lucy - Cabeleireiro Unisexo', 'salon');
  type('cabeleireiro', 'salon', 0);
  type('cabeleireiro', 'nail_salon', 1);
  poi('beauty', 'Espaço Beleza', 'beauty_salon');
  type('beauty', 'beauty_salon', 0);

  db.prepare(
    `INSERT INTO osm_poi (osm_element_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, imported_at, updated_at)
     VALUES ('node/1', 'Barbearia 31 Tatuagem', 'x', 0, 0, 'g', 'salon', 't', 't')`,
  ).run();
  db.prepare("INSERT INTO osm_poi_type VALUES ('node/1', 'salon', 0)").run();

  for (let i = 0; i < times; i += 1) db.exec(MIGRATION);
  return db;
}

const typesOf = (db: DatabaseSync, id: string) =>
  new Set((db.prepare('SELECT poi_type FROM poi_type WHERE fsq_place_id = ?').all(id) as { poi_type: string }[])
    .map(r => r.poi_type));

describe('KAN-401 hair and beauty split', () => {
  it('sends a barbearia to barber and a cabeleireiro to hairdresser', () => {
    const db = seeded();
    expect(typesOf(db, 'barbearia')).toEqual(new Set(['barber']));
    expect(typesOf(db, 'cabeleireiro')).toEqual(new Set(['hairdresser', 'nail_salon']));
  });

  it('keeps a place that does hair AND nails as both', () => {
    // 152 real POIs carry more than one of these. That combination answers
    // more tasks than either type alone and must survive the correction.
    expect(typesOf(seeded(), 'cabeleireiro').size).toBe(2);
  });

  it('moves primary_poi_type off the wrong type', () => {
    const db = seeded();
    const rows = db.prepare('SELECT fsq_place_id, primary_poi_type FROM poi ORDER BY fsq_place_id')
      .all() as { fsq_place_id: string; primary_poi_type: string }[];
    expect(Object.fromEntries(rows.map(r => [r.fsq_place_id, r.primary_poi_type]))).toEqual({
      barbearia: 'barber',
      beauty: 'beauty_salon',
      cabeleireiro: 'hairdresser',
    });
  });

  it('leaves no stored salon rows behind', () => {
    // `salon` becomes purely the app's word for beauty_salon, resolved
    // through type_relation. A leftover row would mean a hairdresser still
    // answering a full-service search.
    const db = seeded();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM poi_type WHERE poi_type = 'salon'").get() as { c: number };
    const osm = db.prepare("SELECT COUNT(*) AS c FROM osm_poi_type WHERE poi_type = 'salon'").get() as { c: number };
    expect(remaining.c).toBe(0);
    expect(osm.c).toBe(0);
  });

  it('does not touch a genuine beauty_salon', () => {
    expect(typesOf(seeded(), 'beauty')).toEqual(new Set(['beauty_salon']));
  });

  it('corrects the OSM side by the same rule', () => {
    const db = seeded();
    const rows = db.prepare('SELECT poi_type FROM osm_poi_type').all() as { poi_type: string }[];
    expect(rows.map(r => r.poi_type)).toEqual(['barber']);
    const primary = db.prepare('SELECT primary_poi_type FROM osm_poi').get() as { primary_poi_type: string };
    expect(primary.primary_poi_type).toBe('barber');
  });

  it('is idempotent', () => {
    const once = seeded(1).prepare('SELECT COUNT(*) AS c FROM poi_type').get() as { c: number };
    const twice = seeded(2).prepare('SELECT COUNT(*) AS c FROM poi_type').get() as { c: number };
    expect(twice.c).toBe(once.c);
  });
});
