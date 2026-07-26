/**
 * places.ts — the unified "Places I know" list (KAN-304).
 *
 * Combines the brands the user explicitly taught (taughtPlaces.ts) with the
 * ones inferred from brushes (learnedPlaces.ts) into one ranked list of brand
 * entries. Taught brands come first — explicit beats inferred — and carry a
 * marker so the user can tell which are theirs to remove. A brand that is both
 * taught and learned appears once, as taught.
 *
 * Pure and synchronous so the capping, ordering and dedup are unit-testable
 * without Firestore.
 */
import type { LearnedBrand } from './learnedPlaces';
import type { TaughtPlace } from './firestore/taughtPlaces';

/** Max rows the Places-I-know section shows before an overflow row (AC5). */
export const PLACES_SECTION_CAP = 5;

export interface PlaceEntry {
  poiType: string;
  name: string;
  /** True when the user taught this brand (vs. inferred from brushes). */
  taught: boolean;
  /** The taught-place doc id, for removal — present only on taught entries. */
  id?: string;
}

/** Case/space-insensitive brand identity within a POI type. */
function brandKey(poiType: string, name: string): string {
  return `${poiType} ${name.trim().toLowerCase()}`;
}

/**
 * Taught brands first (in the order given — newest first), then learned brands
 * that aren't already taught. Never two entries for the same (POI type, name).
 */
export function mergePlaces(taught: TaughtPlace[], learned: LearnedBrand[]): PlaceEntry[] {
  const seen = new Set<string>();
  const entries: PlaceEntry[] = [];

  for (const t of taught) {
    const key = brandKey(t.poiType, t.name);
    if (seen.has(key)) { continue; }
    seen.add(key);
    entries.push({ poiType: t.poiType, name: t.name, taught: true, id: t.id });
  }

  for (const l of learned) {
    const key = brandKey(l.poiType, l.name);
    if (seen.has(key)) { continue; }
    seen.add(key);
    entries.push({ poiType: l.poiType, name: l.name, taught: false });
  }

  return entries;
}

export interface CappedPlaces {
  /** The rows to render in the section (at most `cap`). */
  visible: PlaceEntry[];
  /** Total number of places — shown in the overflow row ("All N places"). */
  total: number;
  /** True when there are more than `cap` places (render the overflow row). */
  hasOverflow: boolean;
}

/** Caps the section list, reporting whether an overflow row is needed (AC5). */
export function capPlaces(places: PlaceEntry[], cap: number = PLACES_SECTION_CAP): CappedPlaces {
  return {
    visible: places.slice(0, cap),
    total: places.length,
    hasOverflow: places.length > cap,
  };
}
