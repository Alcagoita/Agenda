#!/usr/bin/env node
/**
 * KAN-441 — emits bounded, idempotent SQL for the KAN-438 production repair.
 *
 * Run one emitted statement at a time with `wrangler d1 execute`; inspect the
 * legacy counts before proceeding from copy to deletion. This deliberately
 * never connects to production or executes SQL by itself.
 */

export const LEGACY_TYPES = Object.freeze([
  'bank', 'amusement_park', 'aquarium', 'art_gallery', 'beach', 'botanical_garden',
  'bridge', 'campground', 'cemetery', 'church', 'cultural_center', 'golf_course',
  'hiking_area', 'historical_landmark', 'hot_spring', 'island', 'lake', 'lighthouse',
  'marina', 'mountain', 'movie_theater', 'museum', 'music_venue', 'nature_preserve',
  'park', 'plaza', 'river', 'surf_spot', 'theatre', 'tourist_attraction', 'viewpoint',
  'water_park', 'waterfall', 'winery', 'zoo',
]);

const quote = value => `'${value.replace(/'/g, "''")}'`;

export function copyTypeSql(type) {
  if (!LEGACY_TYPES.includes(type)) throw new Error(`Unsupported legacy type: ${type}`);
  const allowed = LEGACY_TYPES.map(quote).join(', ');
  const selected = quote(type);
  return `INSERT OR IGNORE INTO legacy_poi
  (source_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, address, imported_at)
SELECT p.fsq_place_id, p.name, p.dedupe_name, p.lat, p.lng, p.geohash, ${selected}, p.address, CURRENT_TIMESTAMP
FROM poi_backup_20260829 p
JOIN poi_type_backup_20260829 t ON t.fsq_place_id = p.fsq_place_id
WHERE t.poi_type = ${selected}
  AND NOT EXISTS (SELECT 1 FROM poi_type_backup_20260829 earlier
                  WHERE earlier.fsq_place_id = t.fsq_place_id
                    AND earlier.poi_type IN (${allowed}) AND earlier.rank < t.rank)
  AND NOT EXISTS (SELECT 1 FROM poi_source_correction c
                  WHERE c.source = 'foursquare' AND c.source_id = p.fsq_place_id AND c.visible = 0);
INSERT OR IGNORE INTO legacy_poi_type (source_id, poi_type, rank)
SELECT t.fsq_place_id, t.poi_type, t.rank
FROM poi_type_backup_20260829 t JOIN legacy_poi l ON l.source_id = t.fsq_place_id
WHERE t.poi_type = ${selected};`;
}

export function deleteBatchSql(table, key, size = 1000) {
  if (!Number.isInteger(size) || size < 1 || size > 5000) throw new Error('batch size must be 1–5000');
  return `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ${size});`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  if (process.argv[2] !== '--sql') throw new Error('Usage: node scripts/legacyPoiTransition.mjs --sql');
  for (const type of LEGACY_TYPES) console.log(copyTypeSql(type));
  console.log('-- Verify legacy_poi counts before running any DELETE batches.');
  for (const [table, key] of [['poi_attribute', 'fsq_place_id'], ['poi_type', 'fsq_place_id'], ['poi', 'fsq_place_id'], ['poi_candidate', 'candidate_id'], ['osm_poi_attribute', 'osm_element_id'], ['osm_poi_type', 'osm_element_id'], ['osm_poi', 'osm_element_id']]) {
    console.log(deleteBatchSql(table, key));
  }
}
