import type { PoiType } from '../types';
import { normalize } from './poiInference';

const BRAND_DICTIONARY = require('../constants/brandDictionary.json') as Partial<Record<PoiType, string[]>>;

export const BRAND_SUGGESTION_LIMIT = 6;

function brandsForType(poiType: string | null | undefined): string[] {
  if (!poiType) { return []; }
  return BRAND_DICTIONARY[poiType as PoiType] ?? [];
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
  return brandsForType(poiType).find(brand => (
    normalize(brand) === normalizedValue ||
    compact(brand) === compactValue
  )) ?? null;
}
