/**
 * tokens.ts — Single source of truth for all design tokens.
 *
 * Rules:
 *  - Never hardcode a color, font size, spacing value or radius anywhere else.
 *  - Always consume via useTheme() so light/dark switching works automatically.
 */

import type { TextStyle } from 'react-native';
import { COPY } from '../constants/copy';

// ─── Color palettes ───────────────────────────────────────────────────────────

export const lightPalette = {
  bg:         '#fdfcfa',
  surface:    '#f4f2ed',
  surface2:   '#ece9e2',
  line:       'rgba(40,33,20,0.08)',
  text:       '#1f1c16',
  muted:      '#8b857a',
  faint:      '#c1bbac',
  ringTrack:  'rgba(20,20,18,0.08)',
  ringFill:   '#db9657',   // oklch(0.73 0.115 62) soft peach
  accent:     '#e8a86a',   // oklch(0.66 0.13 65)
  pullRefreshIndicator: '#e8a86a',
  pullRefreshOverlay:   'rgba(0,0,0,0.12)',
  nearTint:   '#fdf7f0',   // oklch(0.97 0.028 65)
  nearTint2:  '#f9ede0',   // oklch(0.94 0.05 65)
  nearBorder: '#e8c9a0',   // oklch(0.85 0.09 65)
  nearText:   '#7a4a20',   // oklch(0.42 0.13 65)
  // Lantern halo tints (KAN-301) — the soft circular glow behind the header
  // icon, rendered as a low-opacity View fill (never an SVG). Home reuses the
  // peach ringFill hue; the "away" states (outside/mall/trip) use accent; the
  // unset state is neutral. Dark mode gets its own brighter values (see
  // darkPalette) so the halo doesn't vanish on OLED black at .10–.16 opacity.
  haloHome:   '#db9657',   // = ringFill (warm, steady)
  haloPlace:  '#e8a86a',   // = accent (outside / mall / trip)
  haloUnset:  '#8b857a',   // = muted (no home set)
  success:    '#4caf7d',   // accepted / positive status
  danger:     '#e05252',   // declined / error status
  onAccent:   '#ffffff',   // text/icons shown on an accent-coloured surface
  scrim:      'rgba(0,0,0,0.25)', // modal/loading-overlay backdrop dim
  scrimLight: 'rgba(0,0,0,0.12)', // lighter dim for the pull-refresh overlay (KAN-288) — present but not heavy
  selectedRingTrack: 'rgba(255,255,255,0.20)', // CalendarRing inside a selected cell (bg = palette.text) — opposite tone of the theme
  selectedRingArc:   'rgba(255,255,255,0.88)',
  separatorStrong:   'rgba(20,20,18,0.14)',    // NearbyCard row divider — stronger than the default `line` token
} as const;

export const darkPalette = {
  bg:         '#0e0e0c',
  surface:    '#232321',   // oklch(0.19 0.004 95) — bg→surface≥1.2:1, the only elevation cue with shadows banned
  surface2:   '#2c2c2a',   // oklch(0.22 0.004 95) — continues the surface→surface2 luminance ladder
  line:       'rgba(255,255,255,0.13)',
  text:       '#f6f5f2',
  muted:      '#96968f',   // oklch(0.63 0.006 95) — keeps ≥4.5:1 on surface2, the tightest of the three surfaces
  faint:      '#6e6e69',   // oklch(0.47 0.006 95) — ≥3:1 on bg
  ringTrack:  'rgba(255,255,255,0.12)',
  ringFill:   '#f6f5f2',
  accent:     '#d4955a',   // oklch(0.72 0.14 65)
  pullRefreshIndicator: '#d4955a',
  pullRefreshOverlay:   'rgba(255,255,255,0.14)',
  nearTint:   '#2a1e12',   // oklch(0.22 0.045 65)
  nearTint2:  '#362514',   // oklch(0.27 0.06 65)
  nearBorder: '#a06f40',   // oklch(0.52 0.10 65) — ≥3:1 vs both nearTint and nearTint2
  nearText:   '#dba87a',   // oklch(0.86 0.10 65)
  // Lantern halo tints (KAN-301) — dedicated dark values, NOT a dimmed
  // light-mode ramp: luminance can't be pushed lower on #0e0e0c without the
  // halo disappearing, so these are pitched brighter to stay visible at
  // .10–.16 opacity over the near-black background.
  haloHome:   '#f0b878',   // warm amber, brighter than dark accent
  haloPlace:  '#e8a86a',   // brighter accent for outside / mall / trip
  haloUnset:  '#9c9c94',   // brighter than dark muted so the unset halo reads
  success:    '#5fc090',   // accepted / positive status (brighter for dark bg)
  danger:     '#f06a6a',   // declined / error status (brighter for dark bg)
  onAccent:   '#ffffff',   // text/icons shown on an accent-coloured surface
  scrim:      'rgba(0,0,0,0.25)', // modal/loading-overlay backdrop dim
  scrimLight: 'rgba(0,0,0,0.12)', // lighter dim for the pull-refresh overlay (KAN-288)
  selectedRingTrack: 'rgba(0,0,0,0.16)',       // CalendarRing inside a selected cell (bg = palette.text) — opposite tone of the theme
  selectedRingArc:   'rgba(20,18,14,0.82)',
  separatorStrong:   'rgba(255,255,255,0.14)', // NearbyCard row divider — stronger than the default `line` token
} as const;

export type Palette = {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  text: string;
  muted: string;
  faint: string;
  ringTrack: string;
  ringFill: string;
  accent: string;
  pullRefreshIndicator: string;
  pullRefreshOverlay: string;
  nearTint: string;
  nearTint2: string;
  nearBorder: string;
  nearText: string;
  haloHome: string;
  haloPlace: string;
  haloUnset: string;
  success: string;
  danger: string;
  onAccent: string;
  scrim: string;
  scrimLight: string;
  selectedRingTrack: string;
  selectedRingArc: string;
  separatorStrong: string;
};

// ─── Category colors ──────────────────────────────────────────────────────────

// Getters (KAN-252) instead of plain object literals — `label` reads live
// from COPY on every access, so every existing `categories.work.label` /
// `categories[key].label` call site across the app stays language-aware
// without any change at the call site.
export const categories = {
  get work()     { return { label: COPY.categories.work,     color: '#5b7fd4' }; }, // oklch(0.62 0.12 250) soft blue
  get health()   { return { label: COPY.categories.health,   color: '#5ba87a' }; }, // oklch(0.62 0.12 165) sage
  get errands()  { return { label: COPY.categories.errands,  color: '#8b6bc4' }; }, // oklch(0.62 0.12 305) muted purple
  get personal() { return { label: COPY.categories.personal, color: '#e8a86a' }; }, // oklch(0.66 0.13 70)  peach
};

export type CategoryKey = keyof typeof categories;

/**
 * Achievement tier badge colors (KAN-217). Fixed swatch set like `categories`
 * above — tier identity colors don't vary between light/dark mode.
 */
export const tierColors = {
  tin:        '#9b9690',
  bronze:     '#b3793f',
  silver:     '#7d93a4',
  gold:       '#c0972d',
  adamantium: '#5e788c',
  vibranium:  '#7256a6',
} as const;

/**
 * Fixed swatch set offered when a user creates a custom category (KAN-217).
 * Unlike the themed palette, these represent user-chosen category identity
 * colors — they don't vary between light/dark mode, same as `categories` above.
 */
export const categoryHues = [
  '#d4855a', // oklch(0.66 0.13 30)
  '#e8a86a', // oklch(0.66 0.13 70) — accent
  '#8ab84a', // oklch(0.62 0.12 130)
  '#5ba87a', // oklch(0.62 0.12 165)
  '#5b8fa4', // oklch(0.62 0.12 215)
  '#5b7fd4', // oklch(0.62 0.12 250)
  '#8b6bc4', // oklch(0.62 0.12 305)
  '#c45b7a', // oklch(0.62 0.12 350)
] as const;

/**
 * 18-swatch grid offered by CategoriesScreen's colour picker (KAN-259).
 * Same rationale as `categoryHues` above — fixed identity colours the user
 * picks from, not app-theme colours, so they don't vary between light/dark.
 */
export const categoryPickerColors = [
  // Row 1 — blues & purples
  '#5b7fd4', // Work — soft blue (legacy)
  '#4f9ee8', // sky blue
  '#3b78e8', // bright blue
  '#8b6bc4', // Errands — muted purple (legacy)
  '#a06ed4', // lavender
  '#c47aa0', // mauve
  // Row 2 — greens, yellows, warm
  '#5ba87a', // Health — sage (legacy)
  '#3da890', // teal
  '#4dc880', // mint
  '#8ab84a', // olive
  '#d4c84a', // yellow
  '#e8a86a', // Personal — peach (legacy)
  // Row 3 — warm spectrum + neutrals
  '#e87a4a', // orange
  '#e05252', // red
  '#e05294', // hot pink
  '#c45294', // magenta
  '#8a9ab4', // slate
  '#7a7a7a', // gray
] as const;

/**
 * Selection ring drawn over an already-vivid swatch (CategoriesScreen colour
 * grid, KAN-259). Darkens whatever saturated colour is underneath it, which
 * is independent of app theme — same value in both palettes, like `onAccent`.
 */
export const swatchSelectedRing = 'rgba(0,0,0,0.28)';

/**
 * Warm-tinted modal scrim used only by the light-mode-only OnboardingScreen
 * (KAN-140 — "All tokens are hardcoded to the light palette per spec").
 * Matches `lightPalette.text` at low opacity; kept separate from the
 * app-wide `scrim` token since Onboarding never renders in dark mode.
 */
export const onboardingScrim = 'rgba(31,28,22,0.34)';

/**
 * Fallback identity color for tasks whose category ID doesn't match any
 * known category (TaskRow.tsx, CalendarScreen.tsx — KAN-259). Fixed like
 * `categoryHues` — an identity color, not theme-dependent.
 */
export const fallbackCategoryColor = '#8a8a85';

// ─── Typography ───────────────────────────────────────────────────────────────

export const fonts = {
  family: 'Geist',
  fallback: 'System',
  weights: {
    regular:  '400' as const,
    medium:   '500' as const,
    semibold: '600' as const,
  },
  /** Single shared source of the per-weight linked font names — reference
   *  these instead of a hard-coded 'Geist-Weight' string literal in a
   *  component. Falls back to `fallback` (the platform's system font) if the
   *  named font fails to load, same as any other RN fontFamily. */
  families: {
    regular:  'Geist-Regular',
    medium:   'Geist-Medium',
    semibold: 'Geist-SemiBold',
  },
  /** Reusable font sizes — add to this instead of a raw literal in a component. */
  sizes: {
    /** Secondary/quiet row label (e.g. Calendar's "Going somewhere?" entry row). */
    label: 13.5,
  },
};

// ─── Spacing ──────────────────────────────────────────────────────────────────

/** Base unit: 4. Horizontal page margin: 22. */
export const spacing = {
  1:  4,
  2:  8,
  3:  12,
  4:  16,
  5:  20,
  6:  24,
  page: 22,   // horizontal page margin
} as const;

// ─── Border radius ────────────────────────────────────────────────────────────

export const radius = {
  avatar:   9999,
  chip:     9999,
  card:     16,
  heroIcon: 14,
  listIcon: 10,
  ctaBtn:   12,
  /** Small selection controls (KAN-283) — the existing radii all round an
   *  18px box into a pill; a checkbox needs to still read as square. */
  checkbox: 6,
} as const;

// ─── Reusable text styles ─────────────────────────────────────────────────────

/**
 * Uppercase-ish section heading used above list groups (the "SHARED TASKS" /
 * "FOLLOWING" / "Favourites" / "Where you're going" headers). Matches the
 * Social hub so every screen's sections read the same. Apply a colour
 * (usually `palette.muted`) at the call site.
 */
export const sectionTitleStyle: TextStyle = {
  fontSize: 11,
  fontWeight: '600',
  fontFamily: 'Geist-SemiBold',
  letterSpacing: 0.8,
  marginTop: 20,
  marginBottom: 10,
};

// ─── Shadows ──────────────────────────────────────────────────────────────────

/**
 * No drop shadows anywhere — per design spec.
 * Elevation 0 for all components; use 1px border lines instead.
 */
export const elevation = 0;
