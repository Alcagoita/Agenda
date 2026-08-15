import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const rulesPath = resolve(root, 'firestore.rules');
const dictionaryPath = resolve(root, 'src/constants/brandDictionary.json');
const generatorPath = resolve(root, 'scripts/generate-firestore-brand-rules.mjs');

function quotedRuleValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

describe('generated Firestore POI brand allowlist', () => {
  it('matches every canonical Gym, Bank, and Store brand in the dictionary', () => {
    expect(() => execFileSync(process.execPath, [generatorPath, '--check'], {
      cwd: root,
      stdio: 'pipe',
    })).not.toThrow();

    const rules = readFileSync(rulesPath, 'utf8');
    const generatedBlock = rules.slice(
      rules.indexOf('// BEGIN GENERATED POI BRAND ALLOWLIST'),
      rules.indexOf('// END GENERATED POI BRAND ALLOWLIST'),
    );
    const dictionary = JSON.parse(readFileSync(dictionaryPath, 'utf8')) as Record<string, Array<{ name: string }>>;

    for (const poiType of ['gym', 'bank', 'store']) {
      for (const { name } of dictionary[poiType]) {
        expect(generatedBlock).toContain(quotedRuleValue(name));
      }
    }
    expect(generatedBlock).toContain("'Darty'");
    expect(generatedBlock).not.toContain("'MediaMarkt'");
  });
});
