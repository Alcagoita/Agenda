import { Dimensions } from 'react-native';
import { categories } from '../../theme/tokens';
import { COPY } from '../../constants/copy';
import type { NudgeMessage } from '../../components/ScrRotatingNudge';

// ─── Layout constants ─────────────────────────────────────────────────────────

export const SCREEN_W = Dimensions.get('window').width;

export const RING_REST      = 184;
export const RING_COLLAPSED = 112;
export const STROKE_REST      = 11;
export const RING_LEFT_REST      = (SCREEN_W - RING_REST) / 2;
export const RING_LEFT_COLLAPSED = 22;

export const SECTION_H_REST      = 240;
export const SECTION_H_COLLAPSED = 150;
export const SCROLL_RANGE = SECTION_H_REST - SECTION_H_COLLAPSED;
export const RING_TOP_REST      = (SECTION_H_REST      - RING_REST)      / 2;
export const RING_TOP_COLLAPSED = (SECTION_H_COLLAPSED - RING_COLLAPSED) / 2;

// ── 2-state collapse (KAN-157) ──────────────────────────────────────────────────
// Two positions only: rest (scroll 0 → 60%) and collapsed (60 → 100%). A single
// `collapseT` (0↔1) animates between them on the UI thread; everything is a
// composite-only transform/opacity interpolation of it.
export const COLLAPSE_THRESHOLD = 0.6; // fraction of SCROLL_RANGE that triggers collapse

/**
 * DEBUG bisect toggles for the Today scroll block. Add parts back one at a time
 * to isolate what locks the screen. Restore by setting all three true.
 */
export const DEBUG_SHOW_LIST    = true;  // the FlatList of TaskRows
export const DEBUG_SHOW_NEARBY  = true;  // the NearbyCard (list header)
export const DEBUG_SHOW_RING    = true;  // the collapsible ring overlay
export const DEBUG_SIMPLE_ROWS  = false; // render dumb <Text> rows instead of <TaskRow>
export const DEBUG_MINIMAL = !DEBUG_SHOW_LIST && !DEBUG_SHOW_RING;

// ─── Empty-state message set (KAN-139) ───────────────────────────────────────
//
// Built by a function called inside the component instead of a module-scope
// constant — COPY/categories are language-dynamic (KAN-252) and a
// module-scope read would freeze the text in whatever language was active on
// first import.

const EMPTY_MESSAGE_META: { poi?: string; color?: string }[] = [
  {},
  { poi: 'supermarket', color: categories.errands.color },
  { poi: 'cafe',        color: categories.personal.color },
  { poi: 'atm',         color: categories.errands.color },
  { poi: 'pharmacy',    color: categories.health.color },
  { poi: 'supermarket', color: categories.errands.color },
  {},
  {},
  {}, // "Going somewhere soon?" (KAN-245) — tap target wired by the caller, not an icon
];

/**
 * onGoingSomewherePress (KAN-245) taps the last rotation slot ("Going
 * somewhere soon?") into the trip flow — the only message in this rotation
 * that's ever tappable. Optional so callers that don't need it (none today,
 * but keeps this function safe to call without a navigation context) still
 * get the full message set, just non-interactive.
 */
export function buildEmptyMessages(onGoingSomewherePress?: () => void): NudgeMessage[] {
  const lastIndex = COPY.today.emptyMessages.length - 1;
  return COPY.today.emptyMessages.map((text, i) => ({
    text,
    ...EMPTY_MESSAGE_META[i],
    onPress: i === lastIndex ? onGoingSomewherePress : undefined,
  }));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
// Also read live (see buildEmptyMessages above) rather than module-scope.

export function getWeekdays(): string[] { return COPY.today.weekdays; }
export function getMonths(): string[] { return COPY.today.months; }
