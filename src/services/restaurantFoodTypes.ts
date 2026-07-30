import { normalize } from './poiInference';

type RestaurantFoodDictionary = Record<string, {
  label: string;
  labelPt?: string;
  aliases: string[];
  restaurants: string[];
}>;
type RestaurantTaskLike = { poi?: string | null; title: string };
type RestaurantTaskWithId = RestaurantTaskLike & { id: string };

const RESTAURANT_FOOD_DICTIONARY = require('../constants/restaurantFoodDictionary.json') as RestaurantFoodDictionary;

export type RestaurantFoodType = keyof typeof RESTAURANT_FOOD_DICTIONARY & string;

type RestaurantFoodMatch = { key: RestaurantFoodType; alias: string };
const FOOD_TYPE_FAVOURITE_PREFIX = '__food_type__:';

const RESTAURANT_CONTEXT_TERMS = [
  'eat',
  'eating',
  'dinner',
  'lunch',
  'brunch',
  'meal',
  'restaurant',
  'restaurants',
  'reserve',
  'reservation',
  'book',
  'order',
  'takeout',
  'takeaway',
  'go out',
  'comer',
  'jantar',
  'almoçar',
  'almocar',
  'restaurante',
  'restaurantes',
  'reservar',
  'encomendar',
];

const AMBIGUOUS_FOOD_ALIASES = new Set([
  'pasta',
  'pizza',
  'meat',
  'carne',
  'bife',
  'bifes',
  'salad',
  'salads',
  'salada',
  'saladas',
  'burger',
  'burgers',
  'hamburger',
  'hamburguer',
  'hamburgueres',
]);

function compact(value: string): string {
  return normalize(value).replace(/\s/g, '');
}

function termMatches(normalizedHaystack: string, normalizedTerm: string): boolean {
  return ` ${normalizedHaystack} `.includes(` ${normalizedTerm} `);
}

function findRestaurantFoodTypeMatch(text: string): RestaurantFoodMatch | null {
  const normalized = normalize(text);
  if (!normalized) { return null; }

  let best: RestaurantFoodMatch | null = null;
  for (const [key, entry] of Object.entries(RESTAURANT_FOOD_DICTIONARY)) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalize(alias);
      if (!normalizedAlias || !termMatches(normalized, normalizedAlias)) { continue; }
      if (!best || normalizedAlias.length > best.alias.length) {
        best = { key: key as RestaurantFoodType, alias: normalizedAlias };
      }
    }
  }
  return best;
}

function hasRestaurantContext(text: string): boolean {
  const normalized = normalize(text);
  return RESTAURANT_CONTEXT_TERMS.some(term => termMatches(normalized, normalize(term)));
}

export function inferRestaurantFoodType(text: string): RestaurantFoodType | null {
  return findRestaurantFoodTypeMatch(text)?.key ?? null;
}

export function inferRestaurantFoodTypeForPoiInference(text: string): RestaurantFoodType | null {
  const match = findRestaurantFoodTypeMatch(text);
  if (!match) { return null; }
  if (!AMBIGUOUS_FOOD_ALIASES.has(match.alias)) { return match.key; }
  return hasRestaurantContext(text) ? match.key : null;
}

export function restaurantFoodTypeLabel(foodType: RestaurantFoodType): string {
  return RESTAURANT_FOOD_DICTIONARY[foodType]?.label ?? foodType;
}

export function restaurantFoodTypeDisplayLabel(foodType: RestaurantFoodType, language?: string): string {
  const entry = RESTAURANT_FOOD_DICTIONARY[foodType];
  if (!entry) { return foodType; }
  return language === 'pt-PT' ? entry.labelPt ?? entry.label : entry.label;
}

export function listRestaurantFoodTypes(): RestaurantFoodType[] {
  return Object.keys(RESTAURANT_FOOD_DICTIONARY) as RestaurantFoodType[];
}

export function restaurantFoodTypeFavouriteName(foodType: RestaurantFoodType): string {
  return `${FOOD_TYPE_FAVOURITE_PREFIX}${foodType}`;
}

export function parseRestaurantFoodTypeFavouriteName(name: string): RestaurantFoodType | null {
  if (!name.startsWith(FOOD_TYPE_FAVOURITE_PREFIX)) { return null; }
  const foodType = name.slice(FOOD_TYPE_FAVOURITE_PREFIX.length) as RestaurantFoodType;
  return RESTAURANT_FOOD_DICTIONARY[foodType] ? foodType : null;
}

export function restaurantFoodTypeSuggestions(query: string): RestaurantFoodType[] {
  const normalized = normalize(query);
  if (!normalized) { return listRestaurantFoodTypes(); }

  return listRestaurantFoodTypes().filter(foodType => {
    const entry = RESTAURANT_FOOD_DICTIONARY[foodType];
    return (
      normalize(entry.label).includes(normalized) ||
      normalize(entry.labelPt ?? '').includes(normalized) ||
      entry.aliases.some(alias => normalize(alias).includes(normalized))
    );
  });
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

export function restaurantTaskFoodType(task: RestaurantTaskLike): RestaurantFoodType | null {
  return task.poi === 'restaurant' ? inferRestaurantFoodType(task.title) : null;
}

export function restaurantTaskMatchesPlaceName(
  task: RestaurantTaskLike,
  placeName: string,
): boolean {
  if (task.poi !== 'restaurant') { return true; }
  return restaurantPlaceMatchesFoodType(placeName, restaurantTaskFoodType(task));
}

export function restaurantTaskMatchesAnyPlace(
  task: RestaurantTaskLike,
  places: Array<{ name: string }>,
): boolean {
  if (task.poi !== 'restaurant') { return true; }
  const foodType = restaurantTaskFoodType(task);
  return foodType == null || places.some(place => restaurantPlaceMatchesFoodType(place.name, foodType));
}

export function restaurantPlacesForTask<T extends { name: string }>(
  task: RestaurantTaskLike,
  places: T[],
): T[] {
  if (task.poi !== 'restaurant') { return places; }
  const foodType = restaurantTaskFoodType(task);
  return foodType == null
    ? places
    : places.filter(place => restaurantPlaceMatchesFoodType(place.name, foodType));
}

export function groupRestaurantPlaceCandidates<T extends { name: string }>(
  poiType: string,
  places: T[],
  tasks: RestaurantTaskWithId[],
): Array<{ task: RestaurantTaskWithId; places: T[] }> {
  if (poiType !== 'restaurant') { return []; }

  return tasks
    .filter(task => task.poi === 'restaurant')
    .map(task => ({ task, places: restaurantPlacesForTask(task, places) }))
    .filter(group => group.places.length > 0);
}

export function mergeRestaurantPlaceCandidates<T extends { placeId: string; name: string }>(
  groups: Array<{ places: T[] }>,
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const group of groups) {
    for (const place of group.places) {
      const key = place.placeId || place.name;
      if (seen.has(key)) { continue; }
      seen.add(key);
      merged.push(place);
    }
  }
  return merged.sort((a, b) => {
    const da = 'distanceMeters' in a && typeof a.distanceMeters === 'number' ? a.distanceMeters : 0;
    const db = 'distanceMeters' in b && typeof b.distanceMeters === 'number' ? b.distanceMeters : 0;
    return da - db;
  });
}

export function filterRestaurantPlacesForTasks<T extends { name: string }>(
  poiType: string,
  places: T[],
  tasks: RestaurantTaskLike[],
): T[] {
  if (poiType !== 'restaurant') { return places; }

  const restaurantTasks = tasks.filter(task => task.poi === 'restaurant');
  const hasFoodIntent = restaurantTasks.some(task => restaurantTaskFoodType(task) != null);
  if (!hasFoodIntent) { return places; }

  return places.filter(place =>
    restaurantTasks.some(task => restaurantTaskMatchesPlaceName(task, place.name)),
  );
}
