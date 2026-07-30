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

export function getBrandSuggestions(
  poiType: string | null | undefined,
  query: string,
  limit: number = BRAND_SUGGESTION_LIMIT,
): string[] {
  const brands = brandsForType(poiType);
  const normalizedQuery = normalize(query);
  const compactQuery = compact(query);
  const matches = normalizedQuery
    ? brands.filter(brand => (
      normalize(brand).includes(normalizedQuery) ||
      (compactQuery.length > 0 && compact(brand).includes(compactQuery))
    ))
    : brands;
  return matches.slice(0, limit);
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
