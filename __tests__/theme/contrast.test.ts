/**
 * WCAG contrast-ratio regression test for src/theme/tokens.ts.
 *
 * Locks in the ratios fixed by KAN-258 so a future palette edit can't
 * silently regress dark-mode elevation/readability. Light palette is
 * intentionally softer by design (KAN-258 note) — its thresholds are set
 * to the palette's current baseline, not full AA, so this only guards
 * against further erosion.
 */

import { lightPalette, darkPalette } from '../../src/theme/tokens';

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Flattens an opaque hex color at a given alpha onto an opaque hex background. */
function blendHexOntoBg(hex: string, alpha: number, bgHex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const [br, bg, bb] = hexToRgb(bgHex);
  const blend = (fg: number, bgChannel: number) => Math.round(fg * alpha + bgChannel * (1 - alpha));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(blend(r, br))}${toHex(blend(g, bg))}${toHex(blend(b, bb))}`;
}

/** Flattens an rgba(...) string onto an opaque hex background. */
function blendOntoBg(rgba: string, bgHex: string): string {
  const match = rgba.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
  if (!match) throw new Error(`Unparseable color: ${rgba}`);
  const [, r, g, b, a] = match.map(Number);
  const [br, bgG, bb] = hexToRgb(bgHex);
  const blend = (fg: number, bgChannel: number) => Math.round(fg * a + bgChannel * (1 - a));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(blend(r, br))}${toHex(blend(g, bgG))}${toHex(blend(b, bb))}`;
}

describe('darkPalette contrast (KAN-258)', () => {
  const p = darkPalette;

  it('text and nearText read at ≥4.5:1 on every surface they appear on', () => {
    expect(contrastRatio(p.text, p.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.text, p.surface2)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.nearText, p.nearTint)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.nearText, p.nearTint2)).toBeGreaterThanOrEqual(4.5);
  });

  it('muted reads at ≥4.5:1 on bg, surface, and surface2', () => {
    expect(contrastRatio(p.muted, p.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.muted, p.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.muted, p.surface2)).toBeGreaterThanOrEqual(4.5);
  });

  it('faint reads at ≥3:1 on bg', () => {
    expect(contrastRatio(p.faint, p.bg)).toBeGreaterThanOrEqual(3);
  });

  it('nearBorder (interactive border) reads at ≥3:1 vs its adjacent surfaces', () => {
    expect(contrastRatio(p.nearBorder, p.nearTint)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(p.nearBorder, p.nearTint2)).toBeGreaterThanOrEqual(3);
  });

  it('surface is distinguishable from bg (only elevation cue with shadows banned)', () => {
    expect(contrastRatio(p.surface, p.bg)).toBeGreaterThanOrEqual(1.2);
  });

  it('line is visibly present on both bg and surface', () => {
    expect(contrastRatio(blendOntoBg(p.line, p.bg), p.bg)).toBeGreaterThan(1.3);
    expect(contrastRatio(blendOntoBg(p.line, p.surface), p.surface)).toBeGreaterThan(1.3);
  });

  it('ringTrack renders visibly on bg, including on OLED-black', () => {
    expect(contrastRatio(blendOntoBg(p.ringTrack, p.bg), p.bg)).toBeGreaterThan(1.3);
  });
});

describe('lightPalette contrast (baseline, unchanged by KAN-258)', () => {
  const p = lightPalette;

  it('text and nearText stay at ≥4.5:1', () => {
    expect(contrastRatio(p.text, p.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.text, p.surface2)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.nearText, p.nearTint)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.nearText, p.nearTint2)).toBeGreaterThanOrEqual(4.5);
  });

  it('muted stays at its current (intentionally soft) baseline, no further erosion', () => {
    expect(contrastRatio(p.muted, p.bg)).toBeGreaterThanOrEqual(3.5);
    expect(contrastRatio(p.muted, p.surface)).toBeGreaterThanOrEqual(3.2);
    expect(contrastRatio(p.muted, p.surface2)).toBeGreaterThanOrEqual(3);
  });
});

// KAN-301 — the Lantern halo is a low-opacity View fill behind the header icon.
// The icon (palette.text, or palette.muted in the unset state) is drawn on top
// of the halo, which is itself over bg. Two things must hold in both themes:
//   1. the icon stays readable over the halo-blended background, and
//   2. the halo is actually visible against bg (it's a decorative glow — subtle
//      is fine, invisible is a bug, which is exactly the dark-mode risk this
//      ticket's dedicated dark tokens exist to prevent).
// Resting opacities match the visual spec: .16 for the lit states, .10 unset.
describe.each([
  ['darkPalette', darkPalette],
  ['lightPalette', lightPalette],
])('%s Lantern halo tokens (KAN-301)', (_name, p) => {
  const HALO_LIT_OPACITY = 0.16;
  const HALO_UNSET_OPACITY = 0.10;

  it('the icon stays readable over the lit halos (home / place)', () => {
    for (const halo of [p.haloHome, p.haloPlace]) {
      const behindIcon = blendHexOntoBg(halo, HALO_LIT_OPACITY, p.bg);
      expect(contrastRatio(p.text, behindIcon)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the muted icon stays readable over the unset halo', () => {
    const behindIcon = blendHexOntoBg(p.haloUnset, HALO_UNSET_OPACITY, p.bg);
    expect(contrastRatio(p.muted, behindIcon)).toBeGreaterThanOrEqual(3);
  });

  it('every halo is visibly present on bg (not swallowed by the background)', () => {
    expect(contrastRatio(blendHexOntoBg(p.haloHome, HALO_LIT_OPACITY, p.bg), p.bg)).toBeGreaterThan(1.05);
    expect(contrastRatio(blendHexOntoBg(p.haloPlace, HALO_LIT_OPACITY, p.bg), p.bg)).toBeGreaterThan(1.05);
    expect(contrastRatio(blendHexOntoBg(p.haloUnset, HALO_UNSET_OPACITY, p.bg), p.bg)).toBeGreaterThan(1.02);
  });
});
