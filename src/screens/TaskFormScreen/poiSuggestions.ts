import { searchPlaceTypesLocal } from '../../services/poiTypeCache';
import { poiCatalogLabel } from '../../types';
import { normalize } from '../../services/poiInference';
import { inferStoreSubtype } from '../../services/storeSubtypes';

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
  const suggestions = searchPlaceTypesLocal(trimmed);

  if (!shouldOfferStore || suggestions.some(suggestion => suggestion.type === 'store')) {
    return suggestions;
  }

  return [{ type: 'store', label: poiCatalogLabel('store') }, ...suggestions];
}
