import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { schemaDb } from './d1TestDb';

/**
 * KAN-392 — the 184 confirmed duplicate pairs from the first full Portugal
 * OSM import, retired as reviewed source corrections.
 *
 * A generated migration is exactly the kind of file nobody reads line by
 * line, so the shape is asserted rather than trusted: only OSM elements,
 * only suppression, no name rewriting smuggled in, and applying it twice
 * changes nothing.
 */
const MIGRATION = join(__dirname, '..', '..', 'migrations', '0021_reviewed_pt_osm_duplicates.sql');

function applied(times = 1) {
  const db = schemaDb();
  const sql = readFileSync(MIGRATION, 'utf8');
  for (let i = 0; i < times; i += 1) db.exec(sql);
  return db;
}

describe('KAN-392 reviewed PT OSM duplicates', () => {
  it('retires 182 OSM elements and nothing else', () => {
    const db = applied();
    const rows = db.prepare('SELECT source, source_id, visible FROM poi_source_correction')
      .all() as { source: string; source_id: string; visible: number }[];

    expect(rows).toHaveLength(182);
    // 184 reviewed pairs, but two OSM elements each matched two Foursquare
    // rows — those are Foursquare-internal duplicates, out of scope here.
    expect(new Set(rows.map(r => r.source_id)).size).toBe(182);
    expect(rows.every(r => r.source === 'openstreetmap')).toBe(true);
    expect(rows.every(r => r.visible === 0)).toBe(true);
    expect(rows.every(r => /^(node|way|relation)\/\d+$/.test(r.source_id))).toBe(true);
  });

  it('suppresses only — it never rewrites a name', () => {
    // Name freshness is triage work for KAN-390. A migration that quietly
    // renamed venues would be a much bigger change than it looks.
    const db = applied();
    const overrides = db.prepare(
      'SELECT COUNT(*) AS c FROM poi_source_correction WHERE name_override IS NOT NULL OR dedupe_name_override IS NOT NULL',
    ).get() as { c: number };
    expect(overrides.c).toBe(0);
  });

  it('records why each element was retired', () => {
    const db = applied();
    const notes = db.prepare('SELECT review_note FROM poi_source_correction').all() as { review_note: string }[];
    expect(notes.every(n => n.review_note.startsWith('Duplicate of retained Foursquare '))).toBe(true);
    const martins = db.prepare(
      "SELECT review_note FROM poi_source_correction WHERE source_id = 'node/6441622817'",
    ).get() as { review_note: string };
    expect(martins.review_note).toContain('O Martins');
    expect(martins.review_note).toContain('Restaurante Martins');
  });

  it('is idempotent', () => {
    const once = applied(1).prepare('SELECT COUNT(*) AS c FROM poi_source_correction').get() as { c: number };
    const twice = applied(2).prepare('SELECT COUNT(*) AS c FROM poi_source_correction').get() as { c: number };
    expect(twice.c).toBe(once.c);
    expect(twice.c).toBe(182);
  });

  it('leaves the surviving Foursquare rows alone', () => {
    // The survivor rule keeps Foursquare, so no correction may target it —
    // suppressing both sides would erase the venue entirely.
    const db = applied();
    const foursquare = db.prepare(
      "SELECT COUNT(*) AS c FROM poi_source_correction WHERE source = 'foursquare'",
    ).get() as { c: number };
    expect(foursquare.c).toBe(0);
  });
});
