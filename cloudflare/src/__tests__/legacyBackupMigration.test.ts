import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { schemaDb } from './d1TestDb';

const MIGRATION = readFileSync(join(__dirname, '..', '..', 'migrations', '0032_preserve_selected_backup_pois.sql'), 'utf8');

function preparedDb() {
  const db = schemaDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS poi_type (fsq_place_id TEXT, poi_type TEXT, rank INTEGER);
    CREATE TABLE IF NOT EXISTS poi_attribute (fsq_place_id TEXT);
    CREATE TABLE IF NOT EXISTS poi_candidate (id TEXT);
    CREATE TABLE IF NOT EXISTS osm_poi (osm_element_id TEXT);
    CREATE TABLE IF NOT EXISTS osm_poi_type (osm_element_id TEXT);
    CREATE TABLE IF NOT EXISTS osm_poi_attribute (osm_element_id TEXT);
    CREATE TABLE IF NOT EXISTS poi_source_correction (source TEXT, source_id TEXT, visible INTEGER);
    CREATE TABLE poi_backup_20260829 (
      fsq_place_id TEXT PRIMARY KEY, name TEXT, dedupe_name TEXT, lat REAL, lng REAL,
      geohash TEXT, primary_poi_type TEXT, address TEXT, date_refreshed TEXT
    );
    CREATE TABLE poi_type_backup_20260829 (fsq_place_id TEXT, poi_type TEXT, rank INTEGER);
    INSERT INTO poi_backup_20260829 (fsq_place_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, date_refreshed)
    VALUES ('museum-1', 'Museu', 'museu', 38.7, -9.1, 'eycsx', 'museum', '2026-08-29'),
           ('bank-1', 'Banco', 'banco', 38.7, -9.1, 'eycsx', 'bank', '2026-08-29'),
           ('hidden-1', 'Fechado', 'fechado', 38.7, -9.1, 'eycsx', 'museum', '2026-08-29'),
           ('cafe-1', 'Café', 'cafe', 38.7, -9.1, 'eycsx', 'cafe', '2026-08-29'),
           ('atm-1', 'ATM', 'atm', 38.7, -9.1, 'eycsx', 'atm', '2026-08-29');
    INSERT INTO poi_type_backup_20260829 (fsq_place_id, poi_type, rank)
    VALUES ('museum-1', 'historical_landmark', 0), ('museum-1', 'museum', 1),
           ('bank-1', 'bank', 0), ('hidden-1', 'museum', 0),
           ('cafe-1', 'cafe', 0), ('atm-1', 'atm', 0);
    INSERT INTO poi_source_correction (source, source_id, visible, review_note)
    VALUES ('foursquare', 'hidden-1', 0, 'source retired');
  `);
  return db;
}

describe('KAN-438 selected backup preservation', () => {
  it('retains only agreed Outings types and leaves the immutable backups intact', () => {
    const db = preparedDb();
    db.exec(MIGRATION);
    expect(db.prepare('SELECT source_id, primary_poi_type FROM legacy_poi ORDER BY source_id').all()).toEqual([
      { source_id: 'bank-1', primary_poi_type: 'bank' },
      { source_id: 'museum-1', primary_poi_type: 'historical_landmark' },
    ]);
    expect(db.prepare("SELECT poi_type, rank FROM legacy_poi_type WHERE source_id = 'museum-1' ORDER BY rank").all()).toEqual([
      { poi_type: 'historical_landmark', rank: 0 },
      { poi_type: 'museum', rank: 1 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM poi_backup_20260829').get()).toEqual({ c: 5 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM poi').get()).toEqual({ c: 0 });
  });
});
