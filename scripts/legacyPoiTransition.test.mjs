import assert from 'node:assert/strict';
import { LEGACY_TYPES, copyTypeSql, deleteBatchSql } from './legacyPoiTransition.mjs';

assert(LEGACY_TYPES.includes('historical_landmark'));
assert(LEGACY_TYPES.includes('bank'));
assert(!LEGACY_TYPES.includes('atm'));
assert(!LEGACY_TYPES.includes('restaurant'));
assert.match(copyTypeSql('museum'), /poi_backup_20260829/);
assert.match(copyTypeSql('museum'), /visible = 0/);
assert.throws(() => copyTypeSql('atm'));
assert.equal(deleteBatchSql('poi', 'fsq_place_id', 500), 'DELETE FROM poi WHERE rowid IN (SELECT rowid FROM poi LIMIT 500);');
