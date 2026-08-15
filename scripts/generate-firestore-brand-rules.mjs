#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RULES_PATH = resolve(ROOT, 'firestore.rules');
const DICTIONARY_PATH = resolve(ROOT, 'src/constants/brandDictionary.json');
const START = '    // BEGIN GENERATED POI BRAND ALLOWLIST';
const END = '    // END GENERATED POI BRAND ALLOWLIST';
const BRAND_TYPES = ['gym', 'bank', 'store'];

function quoteRuleString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function renderList(values, indent) {
  return values
    .map(quoteRuleString)
    .reduce((lines, value, index) => {
      const line = Math.floor(index / 5);
      lines[line] = `${lines[line] ?? ''}${lines[line] ? ', ' : ''}${value}`;
      return lines;
    }, [])
    .map(line => `${indent}${line}`)
    .join(',\n');
}

export function renderPoiBrandRules(dictionary) {
  const predicates = BRAND_TYPES.map(type => {
    const brands = dictionary[type];
    if (!Array.isArray(brands) || brands.length === 0) {
      throw new Error(`Expected a non-empty ${type} brand catalogue`);
    }
    const names = brands.map(brand => brand.name);
    if (names.some(name => typeof name !== 'string' || !name)) {
      throw new Error(`Invalid canonical ${type} brand`);
    }
    return `(poi == '${type}' && brand in [\n${renderList(names, '        ')}\n      ])`;
  });

  return [
    START,
    '    // Source: src/constants/brandDictionary.json. Run npm run rules:brands after editing it.',
    '    function validPoiBrand(poi, brand) {',
    `      return ${predicates.join(' ||\n        ')};`,
    '    }',
    END,
  ].join('\n');
}

function replaceGeneratedBlock(rules, block) {
  const start = rules.indexOf(START);
  const end = rules.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('Generated POI brand allowlist markers are missing or malformed');
  }
  const afterEnd = end + END.length;
  return `${rules.slice(0, start)}${block}${rules.slice(afterEnd)}`;
}

const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) {
  throw new Error('Usage: node scripts/generate-firestore-brand-rules.mjs [--check|--write]');
}

const dictionary = JSON.parse(readFileSync(DICTIONARY_PATH, 'utf8'));
const rules = readFileSync(RULES_PATH, 'utf8');
const expected = replaceGeneratedBlock(rules, renderPoiBrandRules(dictionary));

if (mode === '--write') {
  writeFileSync(RULES_PATH, expected);
} else if (rules !== expected) {
  throw new Error('firestore.rules is out of sync with brandDictionary.json; run npm run rules:brands');
}
