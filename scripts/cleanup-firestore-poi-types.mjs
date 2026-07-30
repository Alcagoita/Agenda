#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const typesPath = path.join(repoRoot, 'src/constants/googlePlaceTypes.ts');
const packagePath = path.join(repoRoot, 'package.json');

const PROJECT_ID = process.env.FIREBASE_PROJECT || 'brush-away';
const DATABASE_ID = process.env.FIRESTORE_DATABASE || '(default)';
const WRITE = process.argv.includes('--write');
const MAX_EXAMPLES = 20;

const BUILT_IN_POI_TYPES = [
  'atm', 'cafe', 'supermarket', 'pharmacy',
  'gas', 'gym', 'bank', 'restaurant', 'park',
  'library', 'post', 'store', 'clinic', 'salon',
  'bus', 'school',
];

const DIRECT_ALIASES = {
  bar_and_grill: 'bar',
  barber_shop: 'salon',
  breakfast_restaurant: 'restaurant',
  brunch_restaurant: 'restaurant',
  buffet_restaurant: 'restaurant',
  cafeteria: 'cafe',
  cat_cafe: 'cafe',
  coffee_roastery: 'coffee_shop',
  coffee_stand: 'coffee_shop',
  deli: 'restaurant',
  dog_cafe: 'cafe',
  food_court: 'restaurant',
  food_store: 'grocery_store',
  general_hospital: 'hospital',
  hair_salon: 'salon',
  hypermarket: 'supermarket',
  internet_cafe: 'cafe',
  local_government_office: 'local_government_office',
  meal_delivery: 'restaurant',
  meal_takeaway: 'restaurant',
  medical_center: 'clinic',
  medical_clinic: 'clinic',
  parking_garage: 'parking',
  parking_lot: 'parking',
  pizza_delivery: 'restaurant',
  preschool: 'school',
  secondary_school: 'school',
  shoe_store: 'store',
  toy_store: 'store',
  womens_clothing_store: 'clothing_store',
};

const STORE_SUFFIX_ALIASES = [
  'shop',
  'store',
  'market',
];

const FOOD_TO_RESTAURANT_ALIASES = [
  'bistro',
  'diner',
  'gastropub',
  'restaurant',
  'steak_house',
];

function extractQuotedValues(source, exportName) {
  const marker = `export const ${exportName}`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Cannot find ${exportName} in ${typesPath}`);
  }
  const open = source.indexOf('[', start);
  const close = source.indexOf('];', open);
  if (open === -1 || close === -1) {
    throw new Error(`Cannot parse ${exportName} in ${typesPath}`);
  }
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

function getAccessToken() {
  const firebaseCli = process.env.FIREBASE_CLI || 'firebase';
  const result = spawnSync(firebaseCli, ['login:list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const login = parseFirstJsonObject(result.stdout);
  const token = login.result?.[0]?.tokens?.access_token;
  if (!token) {
    throw new Error(`No Firebase CLI access token found. Run \`firebase login\` first. ${result.stderr.trim()}`);
  }
  return token;
}

function parseFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('Firebase CLI did not return JSON.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) { continue; }
    if (char === '{') { depth += 1; }
    if (char === '}') { depth -= 1; }
    if (depth === 0) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }

  throw new Error('Firebase CLI returned incomplete JSON.');
}

function firestoreUrl(suffix) {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents${suffix}`;
}

async function firestoreRequest(token, url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function runCollectionGroupQuery(token, collectionId) {
  const body = {
    structuredQuery: {
      from: [{ collectionId, allDescendants: true }],
    },
  };
  const rows = await firestoreRequest(token, firestoreUrl(':runQuery'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return rows.filter(row => row.document).map(row => row.document);
}

function readStringField(fields, field) {
  const value = fields?.[field];
  return typeof value?.stringValue === 'string' ? value.stringValue : null;
}

function documentPath(documentName) {
  const marker = `/databases/${DATABASE_ID}/documents/`;
  const index = documentName.indexOf(marker);
  return index === -1 ? documentName : documentName.slice(index + marker.length);
}

function normalizePoiType(type) {
  if (type == null || supportedPoiTypes.has(type)) {
    return { action: 'keep', next: type };
  }

  const direct = DIRECT_ALIASES[type];
  if (direct && supportedPoiTypes.has(direct)) {
    return { action: 'update', next: direct };
  }

  if (FOOD_TO_RESTAURANT_ALIASES.some(alias => type === alias || type.endsWith(`_${alias}`))) {
    return { action: 'update', next: 'restaurant' };
  }

  if (STORE_SUFFIX_ALIASES.some(alias => type === alias || type.endsWith(`_${alias}`))) {
    return { action: 'update', next: 'store' };
  }

  return { action: 'clear', next: null };
}

function fieldPatch(field, next) {
  return next == null
    ? { [field]: { nullValue: null } }
    : { [field]: { stringValue: next } };
}

function summarizeAction(action) {
  if (action.kind === 'delete') {
    return `DELETE ${action.path}`;
  }
  if (action.next == null) {
    return `${action.path} ${action.field}: ${action.prev} -> null`;
  }
  return `${action.path} ${action.field}: ${action.prev} -> ${action.next}`;
}

function addAction(actions, action) {
  actions.push(action);
}

async function scanCollection(token, collectionId, fields, options = {}) {
  const docs = await runCollectionGroupQuery(token, collectionId);
  const actions = [];

  for (const document of docs) {
    const pathName = documentPath(document.name);
    const data = document.fields ?? {};
    for (const field of fields) {
      const prev = readStringField(data, field);
      if (prev == null) { continue; }
      const normalized = normalizePoiType(prev);
      if (normalized.action === 'keep') { continue; }
      if (normalized.next == null && options.deleteOnClear) {
        addAction(actions, { kind: 'delete', name: document.name, path: pathName, prev });
        continue;
      }
      addAction(actions, {
        kind: 'patch',
        name: document.name,
        path: pathName,
        field,
        prev,
        next: normalized.next,
      });
    }
  }

  return actions;
}

async function scanPoiPreferences(token) {
  const docs = await runCollectionGroupQuery(token, 'pois');
  const actions = [];

  for (const document of docs) {
    const pathName = documentPath(document.name);
    const data = document.fields ?? {};
    const prev = readStringField(data, 'type') ?? pathName.split('/').at(-1) ?? null;
    if (!prev) { continue; }
    const normalized = normalizePoiType(prev);
    if (normalized.action === 'keep') { continue; }

    if (normalized.next == null) {
      addAction(actions, { kind: 'delete', name: document.name, path: pathName, prev });
      continue;
    }

    const targetName = `${document.name.split('/pois/')[0]}/pois/${normalized.next}`;
    addAction(actions, {
      kind: 'move-poi-pref',
      name: document.name,
      targetName,
      path: pathName,
      targetPath: documentPath(targetName),
      prev,
      next: normalized.next,
      radiusMeters: data.radiusMeters,
    });
  }

  return actions;
}

async function applyActions(token, actions) {
  for (const action of actions) {
    if (action.kind === 'patch') {
      await firestoreRequest(token, firestoreUrl(`/${documentPath(action.name)}?updateMask.fieldPaths=${action.field}`), {
        method: 'PATCH',
        body: JSON.stringify({ fields: fieldPatch(action.field, action.next) }),
      });
    } else if (action.kind === 'delete') {
      await firestoreRequest(token, firestoreUrl(`/${documentPath(action.name)}`), { method: 'DELETE' });
    } else if (action.kind === 'move-poi-pref') {
      await firestoreRequest(token, firestoreUrl(`/${documentPath(action.targetName)}`), {
        method: 'PATCH',
        body: JSON.stringify({
          fields: {
            type: { stringValue: action.next },
            radiusMeters: action.radiusMeters ?? { integerValue: '75' },
          },
        }),
      });
      await firestoreRequest(token, firestoreUrl(`/${documentPath(action.name)}`), { method: 'DELETE' });
    }
  }
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (Number.parseInt(process.versions.node.split('.')[0], 10) < 18) {
  throw new Error(`${packageJson.name ?? 'Brush'} cleanup requires Node 18+ for fetch().`);
}

const supported = extractQuotedValues(fs.readFileSync(typesPath, 'utf8'), 'SUPPORTED_GOOGLE_PLACE_TYPES');
const supportedPoiTypes = new Set([...BUILT_IN_POI_TYPES, ...supported]);
const token = getAccessToken();

const actions = [
  ...(await scanCollection(token, 'tasks', ['poi', 'completedPoiType'])),
  ...(await scanCollection(token, 'categories', ['poi'])),
  ...(await scanCollection(token, 'learnedPoiKeywords', ['poi'], { deleteOnClear: true })),
  ...(await scanCollection(token, 'places', ['poiType'], { deleteOnClear: true })),
  ...(await scanCollection(token, 'learnedPlaceCounts', ['poiType'], { deleteOnClear: true })),
  ...(await scanCollection(token, 'incoming', ['poi'])),
  ...(await scanPoiPreferences(token)),
];

const grouped = actions.reduce((map, action) => {
  const key = action.kind === 'delete'
    ? `delete:${action.prev}`
    : `${action.prev}->${action.next ?? 'null'}`;
  map.set(key, (map.get(key) ?? 0) + 1);
  return map;
}, new Map());

console.log(`${WRITE ? 'WRITE' : 'DRY RUN'} Firestore POI cleanup for project ${PROJECT_ID}, database ${DATABASE_ID}`);
console.log(`Supported POI values: ${supportedPoiTypes.size}`);
console.log(`Pending changes: ${actions.length}`);
for (const [key, count] of [...grouped.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${key}: ${count}`);
}
if (actions.length) {
  console.log('\nExamples:');
  for (const action of actions.slice(0, MAX_EXAMPLES)) {
    console.log(`  - ${summarizeAction(action)}`);
  }
}

if (WRITE) {
  await applyActions(token, actions);
  console.log(`\nApplied ${actions.length} Firestore POI cleanup change(s).`);
} else {
  console.log('\nNo writes made. Re-run with --write to apply.');
}
