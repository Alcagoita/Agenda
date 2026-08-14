import type { Task } from '../types';
import type { NearbySearchRequest } from './maps';
import { restaurantTaskFoodType } from './restaurantFoodTypes';
import { storeTaskSubtype } from './storeSubtypes';
import { poiTypeRequiresBrand } from './brandDictionary';
import { financialServiceTaskKind } from './financialServiceKinds';

/**
 * Converts open tasks into the smallest useful set of API nearby requests.
 * A broad restaurant/store request is only needed for a genuinely generic
 * task; subtype requests have independent result limits on the server.
 */
export function buildNearbySearchRequests(tasks: readonly Pick<Task, 'poi' | 'title' | 'restaurantFoodType' | 'storeSubtype' | 'financialServiceKind' | 'poiBrand'>[]): NearbySearchRequest[] {
  const byType = new Map<string, typeof tasks>();
  for (const task of tasks) {
    if (!task.poi) continue;
    byType.set(task.poi, [...(byType.get(task.poi) ?? []), task]);
  }

  const requests: NearbySearchRequest[] = [];
  for (const [type, typeTasks] of byType) {
    if (type === 'restaurant') {
      const foodTypes = new Set(typeTasks.map(restaurantTaskFoodType).filter((value): value is NonNullable<typeof value> => value != null));
      const hasGenericTask = typeTasks.some(task => restaurantTaskFoodType(task) == null);
      if (hasGenericTask) requests.push({ key: type, type });
      for (const value of foodTypes) {
        requests.push({ key: `${type}:food_cuisine:${value}`, type, attribute: { dimension: 'food_cuisine', values: [value] } });
      }
      continue;
    }
    if (type === 'store') {
      const brands = new Set(typeTasks.map(task => task.poiBrand).filter((brand): brand is string => typeof brand === 'string' && brand.length > 0));
      const subtypes = new Set(typeTasks
        .filter(task => !(typeof task.poiBrand === 'string' && task.poiBrand.length > 0))
        .map(storeTaskSubtype)
        .filter((value): value is NonNullable<typeof value> => value != null && value !== 'any'));
      const hasGenericTask = typeTasks.some(task => {
        if (typeof task.poiBrand === 'string' && task.poiBrand.length > 0) return false;
        const subtype = storeTaskSubtype(task);
        return subtype == null || subtype === 'any';
      });
      if (hasGenericTask) requests.push({ key: type, type });
      for (const value of subtypes) {
        requests.push({ key: `${type}:store_kind:${value}`, type, attribute: { dimension: 'store_kind', values: [value] } });
      }
      for (const brand of brands) {
        requests.push({ key: `${type}:brand:${brand}`, type, brand });
      }
      continue;
    }
    if (type === 'financial_service') {
      const kinds = new Set(typeTasks.map(financialServiceTaskKind).filter((value): value is NonNullable<typeof value> => value != null));
      const hasGenericTask = typeTasks.some(task => financialServiceTaskKind(task) == null);
      if (hasGenericTask) requests.push({ key: type, type });
      for (const value of kinds) {
        requests.push({ key: `${type}:financial_service_kind:${value}`, type, attribute: { dimension: 'financial_service_kind', values: [value] } });
      }
      continue;
    }
    if (poiTypeRequiresBrand(type)) {
      // Legacy generic Gym/Bank tasks remain readable, but cannot receive a
      // generic nearby recommendation. They become actionable once edited
      // with one of the curated canonical brands.
      const brands = new Set(typeTasks.map(task => task.poiBrand).filter((brand): brand is string => typeof brand === 'string' && brand.length > 0));
      for (const brand of brands) {
        requests.push({ key: `${type}:brand:${brand}`, type, brand });
      }
      continue;
    }
    requests.push({ key: type, type });
  }
  return requests;
}
