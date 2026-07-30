import { normalize } from './poiInference';

type StoreSubtypeDictionary = Record<string, {
  label: string;
  labelPt?: string;
  aliases: string[];
  stores: string[];
}>;
type StoreTaskLike = { poi?: string | null; title: string };
type StoreTaskWithId = StoreTaskLike & { id: string };
type StoreSubtypeMatch = { key: StoreSubtype; alias: string };

const STORE_SUBTYPE_DICTIONARY = require('../constants/storeSubtypeDictionary.json') as StoreSubtypeDictionary;
const STORE_SUBTYPE_FAVOURITE_PREFIX = '__store_subtype__:';

const STORE_CONTEXT_TERMS = [
  'buy',
  'get',
  'shop',
  'shopping',
  'purchase',
  'pick up',
  'comprar',
  'compra',
  'compras',
  'buscar',
  'loja',
];

export type StoreSubtype = keyof typeof STORE_SUBTYPE_DICTIONARY & string;

function compact(value: string): string {
  return normalize(value).replace(/\s/g, '');
}

function findSubtypeMatch(title: string): StoreSubtypeMatch | null {
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) { return null; }
  const haystack = ` ${normalizedTitle} `;
  const compactTitle = compact(title);
  let best: StoreSubtypeMatch | null = null;

  for (const [key, entry] of Object.entries(STORE_SUBTYPE_DICTIONARY) as Array<[StoreSubtype, StoreSubtypeDictionary[string]]>) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalize(alias);
      if (!normalizedAlias) { continue; }
      const compactAlias = compact(alias);
      const matched = normalizedAlias.includes(' ')
        ? haystack.includes(` ${normalizedAlias} `)
        : haystack.includes(` ${normalizedAlias} `) || compactTitle.includes(compactAlias);
      if (!matched) { continue; }
      if (!best || normalizedAlias.length > normalize(best.alias).length) {
        best = { key, alias };
      }
    }
  }

  return best;
}

function hasStoreContext(title: string): boolean {
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) { return false; }
  const haystack = ` ${normalizedTitle} `;
  return STORE_CONTEXT_TERMS.some(term => haystack.includes(` ${normalize(term)} `));
}

export function inferStoreSubtype(title: string): StoreSubtype | null {
  return findSubtypeMatch(title)?.key ?? null;
}

export function inferStoreSubtypeForPoiInference(title: string): StoreSubtype | null {
  const match = findSubtypeMatch(title);
  if (!match) { return null; }
  return hasStoreContext(title) ? match.key : null;
}

export function listStoreSubtypes(): StoreSubtype[] {
  return Object.keys(STORE_SUBTYPE_DICTIONARY) as StoreSubtype[];
}

export function storeSubtypeDisplayLabel(subtype: StoreSubtype, language?: string): string {
  const entry = STORE_SUBTYPE_DICTIONARY[subtype];
  return language === 'pt-PT' && entry.labelPt ? entry.labelPt : entry.label;
}

export function storeSubtypeFavouriteName(subtype: StoreSubtype): string {
  return `${STORE_SUBTYPE_FAVOURITE_PREFIX}${subtype}`;
}

export function parseStoreSubtypeFavouriteName(name: string): StoreSubtype | null {
  if (!name.startsWith(STORE_SUBTYPE_FAVOURITE_PREFIX)) { return null; }
  const subtype = name.slice(STORE_SUBTYPE_FAVOURITE_PREFIX.length) as StoreSubtype;
  return STORE_SUBTYPE_DICTIONARY[subtype] ? subtype : null;
}

export function storeSubtypeSuggestions(query: string, language?: string): StoreSubtype[] {
  const normalized = normalize(query);
  if (!normalized) { return listStoreSubtypes(); }

  return listStoreSubtypes().map((subtype, index) => {
    const entry = STORE_SUBTYPE_DICTIONARY[subtype];
    const labels = language === 'pt-PT' ? [entry.labelPt ?? entry.label] : [entry.label];
    const score = labels
      .map(label => visibleLabelMatchScore(label, normalized))
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)[0] ?? null;
    return { subtype, index, score };
  })
    .filter((match): match is { subtype: StoreSubtype; index: number; score: number } => match.score != null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(match => match.subtype);
}

function visibleLabelMatchScore(label: string, normalizedQuery: string): number | null {
  const normalizedLabel = normalize(label);
  if (!normalizedLabel) { return null; }
  const words = normalizedLabel.split(' ');

  if (normalizedLabel === normalizedQuery) { return 0; }
  if (words.some(word => word.startsWith(normalizedQuery))) { return 1; }
  if (normalizedLabel.startsWith(normalizedQuery)) { return 2; }
  if (words.some(word => word.includes(normalizedQuery))) { return 3; }
  if (normalizedLabel.includes(normalizedQuery)) { return 4; }
  return null;
}

export function storePlaceMatchesSubtype(
  placeName: string,
  subtype: StoreSubtype | null,
): boolean {
  if (!subtype) { return true; }
  const entry = STORE_SUBTYPE_DICTIONARY[subtype];
  if (!entry) { return false; }

  const normalizedPlace = normalize(placeName);
  const compactPlace = compact(placeName);
  if (!normalizedPlace) { return false; }

  return entry.stores.some(store => {
    const normalizedStore = normalize(store);
    const compactStore = compact(store);
    return (
      normalizedPlace.includes(normalizedStore) ||
      normalizedStore.includes(normalizedPlace) ||
      compactPlace.includes(compactStore) ||
      compactStore.includes(compactPlace)
    );
  });
}

export function storeTaskSubtype(task: StoreTaskLike): StoreSubtype | null {
  return task.poi === 'store' ? inferStoreSubtype(task.title) : null;
}

export function storeTaskMatchesPlaceName(
  task: StoreTaskLike,
  placeName: string,
): boolean {
  if (task.poi !== 'store') { return true; }
  return storePlaceMatchesSubtype(placeName, storeTaskSubtype(task));
}

export function storeTaskMatchesAnyPlace(
  task: StoreTaskLike,
  places: Array<{ name: string }>,
): boolean {
  if (task.poi !== 'store') { return true; }
  const subtype = storeTaskSubtype(task);
  return subtype == null || places.some(place => storePlaceMatchesSubtype(place.name, subtype));
}

export function storePlacesForTask<T extends { name: string }>(
  task: StoreTaskLike,
  places: T[],
): T[] {
  if (task.poi !== 'store') { return places; }
  const subtype = storeTaskSubtype(task);
  return subtype == null
    ? places
    : places.filter(place => storePlaceMatchesSubtype(place.name, subtype));
}

export function groupStorePlaceCandidates<T extends { name: string }>(
  poiType: string,
  places: T[],
  tasks: StoreTaskWithId[],
): Array<{ task: StoreTaskWithId; places: T[] }> {
  if (poiType !== 'store') { return []; }

  return tasks
    .filter(task => task.poi === 'store')
    .map(task => ({ task, places: storePlacesForTask(task, places) }))
    .filter(group => group.places.length > 0);
}

export function mergeStorePlaceCandidates<T extends { placeId: string; name: string }>(
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

export function filterStorePlacesForTasks<T extends { name: string }>(
  poiType: string,
  places: T[],
  tasks: StoreTaskLike[],
): T[] {
  if (poiType !== 'store') { return places; }

  const storeTasks = tasks.filter(task => task.poi === 'store');
  const hasSubtypeIntent = storeTasks.some(task => storeTaskSubtype(task) != null);
  if (!hasSubtypeIntent) { return places; }

  return places.filter(place =>
    storeTasks.some(task => storeTaskMatchesPlaceName(task, place.name)),
  );
}
