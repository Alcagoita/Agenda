import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPilotSql,
  eligibleOdivelasMarkers,
  encodeGeohash,
  multibancoSourceId,
  pointInPolygon,
} from './multibancoOdivelasPilot.mjs';

const square = { type: 'Polygon', coordinates: [[
  [0, 0], [2, 0], [2, 2], [0, 2], [0, 0],
]] };

test('keeps only valid markers inside the municipality and suppresses exact provider duplicates', () => {
  const result = eligibleOdivelasMarkers([
    { name: 'MULTIBANCO', address: 'Rua Árvore', lat: '1', lng: '1' },
    { name: 'MULTIBANCO', address: 'Rua Árvore', lat: '1', lng: '1' },
    { name: 'MULTIBANCO', address: 'Outside', lat: '3', lng: '3' },
    { name: 'MULTIBANCO', address: 'Broken', lat: 'nope', lng: '1' },
  ], square);

  assert.equal(result.records.length, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.outsideBoundary, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.records[0].id, multibancoSourceId('MULTIBANCO', 'Rua Árvore', 1, 1));
});

test('uses the standard geohash encoding and preserves source provenance in generated SQL', () => {
  assert.equal(encodeGeohash(38.792331, -9.171947), 'eyckxmc');
  assert.equal(pointInPolygon(1, 1, square), true);
  assert.equal(pointInPolygon(3, 3, square), false);

  const id = multibancoSourceId('MULTIBANCO', 'Metro - Odivelas', 38.792331, -9.171947);
  const sql = buildPilotSql({
    fetchedAt: '2026-09-02T12:00:00.000Z',
    sourceUrl: 'https://example.test/locator',
    records: [{
      id,
      name: 'MULTIBANCO',
      address: 'Metro - Odivelas',
      lat: 38.792331,
      lng: -9.171947,
      raw: { name: 'MULTIBANCO' },
    }],
  });

  assert.match(sql, /multibanco_import_staging/);
  assert.match(sql, /'multibanco'/);
  assert.match(sql, /'atm'/);
  assert.match(sql, /'multibanco-import'/);
  assert.match(sql, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
