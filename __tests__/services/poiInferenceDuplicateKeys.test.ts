import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * KAN-412 — the duplicate-key guard.
 *
 * A JavaScript object literal keeps the LAST value for a repeated key, and
 * TypeScript does not flag it inside a `Record<string, T>`. So a duplicate
 * silently overrides an existing mapping with no error anywhere.
 *
 * It has happened twice:
 *
 *   KAN-411  a second `chá` moved a common Portuguese task from 23,853
 *            cafés to 638 tea rooms. Caught in review, not by tooling.
 *   KAN-412  a second `playground` meant the new playground type was dead
 *            on arrival — the pre-existing `playground: 'park'` won.
 *
 * Both were invisible to tsc, to the linter and to every existing test.
 * This reads the source rather than the imported object, because by the
 * time it is an object the duplicate is already gone.
 */
const SOURCE = join(__dirname, '..', '..', 'src', 'services', 'poiInference.ts');

/**
 * Brace-depth parse, not a regex. A regex that stops at the first `  },`
 * silently reports "no duplicates" for a block that contains one — which is
 * exactly what the first version of this check did.
 */
function dictionaryBlocks(source: string): Map<string, string[]> {
  const lines = source.slice(source.indexOf('const SEED_DICTIONARY')).split('\n');
  const blocks = new Map<string, string[]>();
  let depth = 0;
  let lang: string | null = null;
  let current: string[] = [];

  for (const line of lines) {
    const opener = line.match(/^\s*'?([\w-]+)'?:\s*\{\s*$/);
    if (opener && depth === 1) {
      lang = opener[1];
      current = [];
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (lang && depth >= 2) { current.push(line); }
    if (lang && depth === 1 && current.length) {
      blocks.set(lang, current);
      lang = null;
      current = [];
    }
    if (depth === 0 && blocks.size) { break; }
  }
  return blocks;
}

function keysOf(lines: string[]): string[] {
  const keys: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/(?:^|,)\s*'([^']+)'\s*:|(?:^|,)\s*([A-Za-z_][\w]*)\s*:/g)) {
      keys.push(match[1] ?? match[2]);
    }
  }
  return keys;
}

describe('KAN-412 poiInference dictionary keys', () => {
  const blocks = dictionaryBlocks(readFileSync(SOURCE, 'utf8'));

  it('finds both language blocks', () => {
    // If the parser stops finding them, every assertion below passes
    // vacuously — which is how the first version of this check reported a
    // clean bill of health on a file containing a duplicate.
    expect([...blocks.keys()].sort()).toEqual(['en', 'pt-PT']);
    for (const lines of blocks.values()) {
      expect(keysOf(lines).length).toBeGreaterThan(50);
    }
  });

  for (const lang of ['en', 'pt-PT']) {
    it(`has no duplicate keys in ${lang}`, () => {
      const keys = keysOf(blocks.get(lang) ?? []);
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const key of keys) {
        if (seen.has(key)) { duplicates.add(key); }
        seen.add(key);
      }
      expect([...duplicates].sort()).toEqual([]);
    });
  }

  it('detects a duplicate when one is present', () => {
    // Mutation check. Without this the suite above could pass because the
    // key extraction is broken rather than because the file is clean.
    const keys = keysOf(["    coffee: 'cafe', tea: 'cafe',", "    coffee: 'bar',"]);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(duplicates).toEqual(['coffee']);
  });
});
