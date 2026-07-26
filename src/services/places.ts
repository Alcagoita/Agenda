/**
 * places.ts — the brand lists for the Places tab (KAN-304).
 *
 * Splits the brands the user explicitly taught (taughtPlaces.ts, "Favourites")
 * from the ones inferred from brushes (learnedPlaces.ts, "Your usuals"). The two
 * are NEVER merged into one list: Favourites are what the user told us, usuals
 * are what we inferred. A brand that is both taught and learned belongs to
 * Favourites only (explicit beats inferred).
 *
 * Pure and synchronous so the split and dedup are unit-testable without
 * Firestore. No caps — both lists grow without limit and the screen scrolls.
 */
import type { LearnedBrand } from './learnedPlaces';
import type { TaughtPlace } from './firestore/taughtPlaces';
import type { Trip } from '../types';

export interface PlaceEntry {
  poiType: string;
  name: string;
  /** True when the user taught this brand (Favourites) vs. inferred (Your usuals). */
  taught: boolean;
  /** The taught-place doc id, for removal — present only on taught entries. */
  id?: string;
}

export interface SplitPlaces {
  favourites: PlaceEntry[];
  usuals: PlaceEntry[];
}

/** Case/space-insensitive brand identity within a POI type. */
function brandKey(poiType: string, name: string): string {
  return `${poiType} ${name.trim().toLowerCase()}`;
}

/**
 * Favourites (taught) and Your usuals (learned, minus any brand already taught).
 * Neither list is capped; order within each is preserved from the input.
 */
export function splitPlaces(taught: TaughtPlace[], learned: LearnedBrand[]): SplitPlaces {
  const favourites: PlaceEntry[] = [];
  const taughtKeys = new Set<string>();

  for (const t of taught) {
    const key = brandKey(t.poiType, t.name);
    if (taughtKeys.has(key)) { continue; }
    taughtKeys.add(key);
    favourites.push({ poiType: t.poiType, name: t.name, taught: true, id: t.id });
  }

  const usuals: PlaceEntry[] = [];
  const seenUsual = new Set<string>();
  for (const l of learned) {
    const key = brandKey(l.poiType, l.name);
    if (taughtKeys.has(key) || seenUsual.has(key)) { continue; }
    seenUsual.add(key);
    usuals.push({ poiType: l.poiType, name: l.name, taught: false });
  }

  return { favourites, usuals };
}

/**
 * The id of the single planned trip that gets the "Next up" treatment: the one
 * with the earliest start date (trips without a start date sort last). Returns
 * null for an empty list. Exactly one trip is ever chosen (AC9).
 */
export function nextUpTripId(trips: Trip[]): string | null {
  if (trips.length === 0) { return null; }
  const sorted = [...trips].sort((a, b) => (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999'));
  return sorted[0].id;
}
