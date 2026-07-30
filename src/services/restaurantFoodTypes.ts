import type { Task } from '../types';
import { normalize } from './poiInference';

type RestaurantFoodDictionary = Record<string, {
  label: string;
  aliases: string[];
  restaurants: string[];
}>;

const RESTAURANT_FOOD_DICTIONARY = require('../constants/restaurantFoodDictionary.json') as RestaurantFoodDictionary;

export type RestaurantFoodType = keyof typeof RESTAURANT_FOOD_DICTIONARY & string;

function compact(value: string): string {
  return normalize(value).replace(/\s/g, '');
}

function termMatches(normalizedHaystack: string, normalizedTerm: string): boolean {
  return ` ${normalizedHaystack} `.includes(` ${normalizedTerm} `);
}

export function inferRestaurantFoodType(text: string): RestaurantFoodType | null {
  const normalized = normalize(text);
  if (!normalized) { return null; }

  let best: { key: RestaurantFoodType; alias: string } | null = null;
  for (const [key, entry] of Object.entries(RESTAURANT_FOOD_DICTIONARY)) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalize(alias);
      if (!normalizedAlias || !termMatches(normalized, normalizedAlias)) { continue; }
      if (!best || normalizedAlias.length > best.alias.length) {
        best = { key: key as RestaurantFoodType, alias: normalizedAlias };
      }
    }
  }
  return best?.key ?? null;
}

export function restaurantFoodTypeLabel(foodType: RestaurantFoodType): string {
  return RESTAURANT_FOOD_DICTIONARY[foodType]?.label ?? foodType;
}

export function restaurantPlaceMatchesFoodType(
  placeName: string,
  foodType: RestaurantFoodType | null,
): boolean {
  if (!foodType) { return true; }
  const entry = RESTAURANT_FOOD_DICTIONARY[foodType];
  if (!entry) { return false; }

  const normalizedPlace = normalize(placeName);
  const compactPlace = compact(placeName);
  if (!normalizedPlace) { return false; }

  return entry.restaurants.some(restaurant => {
    const normalizedRestaurant = normalize(restaurant);
    const compactRestaurant = compact(restaurant);
    return (
      normalizedPlace.includes(normalizedRestaurant) ||
      normalizedRestaurant.includes(normalizedPlace) ||
      compactPlace.includes(compactRestaurant) ||
      compactRestaurant.includes(compactPlace)
    );
  });
}

export function restaurantTaskFoodType(task: Pick<Task, 'poi' | 'title'>): RestaurantFoodType | null {
  return task.poi === 'restaurant' ? inferRestaurantFoodType(task.title) : null;
}

export function restaurantTaskMatchesPlaceName(
  task: Pick<Task, 'poi' | 'title'>,
  placeName: string,
): boolean {
  if (task.poi !== 'restaurant') { return true; }
  return restaurantPlaceMatchesFoodType(placeName, restaurantTaskFoodType(task));
}

export function restaurantTaskMatchesAnyPlace(
  task: Pick<Task, 'poi' | 'title'>,
  places: Array<{ name: string }>,
): boolean {
  if (task.poi !== 'restaurant') { return true; }
  const foodType = restaurantTaskFoodType(task);
  return foodType == null || places.some(place => restaurantPlaceMatchesFoodType(place.name, foodType));
}

export function filterRestaurantPlacesForTasks<T extends { name: string }>(
  poiType: string,
  places: T[],
  tasks: Array<Pick<Task, 'poi' | 'title'>>,
): T[] {
  if (poiType !== 'restaurant') { return places; }

  const restaurantTasks = tasks.filter(task => task.poi === 'restaurant');
  const hasFoodIntent = restaurantTasks.some(task => restaurantTaskFoodType(task) != null);
  if (!hasFoodIntent) { return places; }

  return places.filter(place =>
    restaurantTasks.some(task => restaurantTaskMatchesPlaceName(task, place.name)),
  );
}
