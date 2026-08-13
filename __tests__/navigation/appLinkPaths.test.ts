/**
 * KAN-374 — the Android App Link filter must claim only the paths the app routes.
 *
 * The manifest used to claim the whole brushaway.app host. Every other URL on
 * that domain — the public "suggest a missing place" page among them — then
 * resolved back into this singleTask activity, matched nothing in the
 * navigator's linking config, and simply never opened.
 *
 * These tests read the manifest as text rather than rendering anything: the
 * regression lives in XML, and nothing else in the suite would catch it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MANIFEST = readFileSync(
  join(__dirname, '../../android/app/src/main/AndroidManifest.xml'),
  'utf8',
);

/** The <data> elements inside the autoVerify (App Links) intent filter. */
function appLinkDataElements(): string[] {
  const filter = MANIFEST.match(/<intent-filter android:autoVerify="true">([\s\S]*?)<\/intent-filter>/);
  if (!filter) { throw new Error('no autoVerify intent-filter in AndroidManifest.xml'); }
  return filter[1].match(/<data[^>]*\/>/g) ?? [];
}

describe('Android App Links — claimed paths (KAN-374)', () => {
  it('never claims the bare brushaway.app host', () => {
    for (const data of appLinkDataElements()) {
      expect(data).toMatch(/android:(path|pathPrefix|pathPattern)=/);
    }
  });

  it('claims the two routed paths', () => {
    const data = appLinkDataElements().join('\n');
    expect(data).toContain('android:pathPrefix="/u/"');
    expect(data).toContain('android:path="/inbox"');
  });

  it('does not claim the public suggestion page', () => {
    const claimed = appLinkDataElements()
      .map(data => data.match(/android:(?:path|pathPrefix)="([^"]+)"/)?.[1])
      .filter((path): path is string => !!path);

    expect(claimed.some(path => '/manual-poi'.startsWith(path))).toBe(false);
  });
});
