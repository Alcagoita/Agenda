import { searchPlaceTypesLocal } from '../../services/poiTypeCache';
import { poiCatalogLabel } from '../../types';
import { normalize } from '../../services/poiInference';
import { inferStoreSubtype } from '../../services/storeSubtypes';

const STORE_SUBTYPE_POI_TYPES = new Set([
  'bicycle_store',
  'book_store',
  'clothing_store',
  'electronics_store',
  'furniture_store',
  'hardware_store',
  'home_goods_store',
  'jewelry_store',
  'pet_store',
  'shoe_store',
  'sporting_goods_store',
]);

export function getTypeSuggestions(q: string): { type: string; label: string }[] {
  const trimmed = q.trim();
  if (!trimmed) { return []; }

  const normalized = normalize(trimmed);
  const haystack = ` ${normalized} `;
  const shouldOfferStore = normalized === 'store'
    || normalized === 'shop'
    || haystack.includes(' store ')
    || haystack.includes(' shop ')
    || inferStoreSubtype(trimmed) != null;
  const suggestions = searchPlaceTypesLocal(trimmed)
    .filter(suggestion => !STORE_SUBTYPE_POI_TYPES.has(suggestion.type));

  if (!shouldOfferStore || suggestions.some(suggestion => suggestion.type === 'store')) {
    return suggestions;
  }

  return [{ type: 'store', label: poiCatalogLabel('store') }, ...suggestions];
}
