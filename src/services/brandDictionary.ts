import type { PoiType } from '../types';
import { normalize } from './poiInference';

export type BrandDefinition = {
  /** Canonical value persisted in tasks and in D1's poi.brand column. */
  name: string;
  /** Recognised source/title variants. They always resolve to `name`. */
  aliases: string[];
};

const BRAND_DICTIONARY = require('../constants/brandDictionary.json') as Partial<Record<PoiType, BrandDefinition[]>>;

export const BRAND_SUGGESTION_LIMIT = 6;

function definitionsForType(poiType: string | null | undefined): BrandDefinition[] {
  if (!poiType) { return []; }
  return BRAND_DICTIONARY[poiType as PoiType] ?? [];
}

/** Canonical persisted/display values, in the curated order from the shared JSON. */
export function brandsForType(poiType: string | null | undefined): string[] {
  return definitionsForType(poiType).map(brand => brand.name);
}

function compact(value: string): string {
  return normalize(value).replace(/\s/g, '');
}

function matchScore(value: string, query: string): number | null {
  const normalizedValue = normalize(value);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) { return 0; }

  const compactValue = compact(value);
  const compactQuery = compact(query);
  const words = normalizedValue.split(' ');

  if (normalizedValue === normalizedQuery || compactValue === compactQuery) { return 0; }
  if (words.some(word => word.startsWith(normalizedQuery))) { return 1; }
  if (normalizedValue.startsWith(normalizedQuery) || compactValue.startsWith(compactQuery)) { return 2; }
  if (words.some(word => word.includes(normalizedQuery))) { return 3; }
  if (normalizedValue.includes(normalizedQuery) || compactValue.includes(compactQuery)) { return 4; }
  return null;
}

export function getBrandSuggestions(
  poiType: string | null | undefined,
  query: string,
  limit: number = BRAND_SUGGESTION_LIMIT,
): string[] {
  const brands = brandsForType(poiType);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) { return brands.slice(0, limit); }

  return brands
    .map((brand, index) => ({ brand, index, score: matchScore(brand, query) }))
    .filter((match): match is { brand: string; index: number; score: number } => match.score != null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(match => match.brand)
    .slice(0, limit);
}

export function getCanonicalBrand(
  poiType: string | null | undefined,
  value: string,
): string | null {
  const normalizedValue = normalize(value);
  if (!normalizedValue) { return null; }
  const compactValue = compact(value);
  return definitionsForType(poiType).find(brand =>
    [brand.name, ...brand.aliases].some(candidate => (
      normalize(candidate) === normalizedValue || compact(candidate) === compactValue
    )),
  )?.name ?? null;
}

/** True only for a canonical value valid for this exact POI type. */
export function isCanonicalBrandForType(
  poiType: string | null | undefined,
  value: string | null | undefined,
): boolean {
  return typeof value === 'string' && definitionsForType(poiType).some(brand => brand.name === value);
}

/**
 * Resolves a canonical brand when one of its explicit aliases occurs as a
 * whole word/phrase in human text. Longest match wins so a full legal bank
 * name is never shadowed by a short abbreviation.
 */
export function findBrandInText(
  poiType: string | null | undefined,
  text: string,
): string | null {
  const normalizedText = normalize(text);
  if (!normalizedText) { return null; }
  const haystack = ` ${normalizedText} `;
  let best: { name: string; length: number } | null = null;
  for (const brand of definitionsForType(poiType)) {
    for (const candidate of [brand.name, ...brand.aliases]) {
      const normalizedCandidate = normalize(candidate);
      if (!normalizedCandidate || !haystack.includes(` ${normalizedCandidate} `)) { continue; }
      if (!best || normalizedCandidate.length > best.length) {
        best = { name: brand.name, length: normalizedCandidate.length };
      }
    }
  }
  return best?.name ?? null;
}

/** The two task kinds that require a canonical chain instead of generic nearby results. */
export function poiTypeRequiresBrand(poiType: string | null | undefined): poiType is 'gym' | 'bank' {
  return poiType === 'gym' || poiType === 'bank';
}

/** Detects a Gym/Bank brand title and returns both the type and canonical value. */
export function findRequiredBrandInText(text: string): { poiType: 'gym' | 'bank'; brand: string } | null {
  for (const poiType of ['gym', 'bank'] as const) {
    const brand = findBrandInText(poiType, text);
    if (brand) return { poiType, brand };
  }
  return null;
}

type BrandTaskLike = { poi?: string | null; poiBrand?: string | null };
type BrandPlaceLike = { brand?: string | null };

/** Uses the canonical value already returned by the Worker; never guesses from a place name. */
export function brandTaskMatchesPlace(task: BrandTaskLike, place: BrandPlaceLike): boolean {
  if (!poiTypeRequiresBrand(task.poi)) { return true; }
  return typeof task.poiBrand === 'string' && task.poiBrand.length > 0 && task.poiBrand === place.brand;
}

export function filterBrandPlacesForTasks<T extends BrandPlaceLike>(
  poiType: string,
  places: T[],
  tasks: readonly BrandTaskLike[],
): T[] {
  if (!poiTypeRequiresBrand(poiType)) { return places; }
  const relevantTasks = tasks.filter(task => task.poi === poiType);
  return places.filter(place => relevantTasks.some(task => brandTaskMatchesPlace(task, place)));
}
