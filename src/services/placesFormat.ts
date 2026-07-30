/**
 * placesFormat.ts — small display helpers for the Places screen (KAN-304).
 * Pure and dependency-light so the UI components stay presentational.
 */
import { COPY } from '../constants/copy';
import { formatDateShort } from '../utils/date';
import { isCatalogPoiType, poiCatalogLabel } from '../types';
import type { Trip } from '../types';
import { parseRestaurantFoodTypeFavouriteName, restaurantFoodTypeDisplayLabel } from './restaurantFoodTypes';

/**
 * Lower-cased display label for a POI type. Safe for custom (non-catalog) POI
 * strings — falls back to the raw value instead of casting a free-text POI to
 * a catalog key and looking up an undefined label.
 */
export function typeLabel(poiType: string): string {
  return (isCatalogPoiType(poiType) ? poiCatalogLabel(poiType) : poiType).toLowerCase();
}

export function placeEntryTitle(name: string, language?: string): string {
  const foodType = parseRestaurantFoodTypeFavouriteName(name);
  return foodType ? restaurantFoodTypeDisplayLabel(foodType, language) : name;
}

export function placeEntryTypeLabel(poiType: string, name: string): string {
  return parseRestaurantFoodTypeFavouriteName(name) ? COPY.places.teachFoodType : typeLabel(poiType);
}

/** "12 Aug – 18 Aug" when dated, else the no-dates line. */
export function tripDates(trip: Trip): string {
  return trip.startDate && trip.endDate
    ? COPY.tripPlanner.tripRowDates(formatDateShort(trip.startDate), formatDateShort(trip.endDate))
    : COPY.tripPlanner.tripRowNoDates;
}
