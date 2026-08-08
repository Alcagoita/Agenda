import type { Task } from '../types';
import type { NearbySearchRequest } from './maps';
import { restaurantTaskFoodType } from './restaurantFoodTypes';
import { storeTaskSubtype } from './storeSubtypes';

/**
 * Converts open tasks into the smallest useful set of API nearby requests.
 * A broad restaurant/store request is only needed for a genuinely generic
 * task; subtype requests have independent result limits on the server.
 */
export function buildNearbySearchRequests(tasks: readonly Pick<Task, 'poi' | 'title' | 'restaurantFoodType' | 'storeSubtype'>[]): NearbySearchRequest[] {
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
      const subtypes = new Set(typeTasks.map(storeTaskSubtype).filter((value): value is NonNullable<typeof value> => value != null && value !== 'any'));
      const hasGenericTask = typeTasks.some(task => {
        const subtype = storeTaskSubtype(task);
        return subtype == null || subtype === 'any';
      });
      if (hasGenericTask) requests.push({ key: type, type });
      for (const value of subtypes) {
        requests.push({ key: `${type}:store_kind:${value}`, type, attribute: { dimension: 'store_kind', values: [value] } });
      }
      continue;
    }
    requests.push({ key: type, type });
  }
  return requests;
}
