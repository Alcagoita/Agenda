import { buildNearbySearchRequests } from '../../src/services/nearbySearchRequests';

describe('buildNearbySearchRequests', () => {
  it('requests only selected restaurant cuisines, each with its own key', () => {
    expect(buildNearbySearchRequests([
      { poi: 'restaurant', title: 'Dinner', restaurantFoodType: 'sushi' },
      { poi: 'restaurant', title: 'Vegetarian lunch', restaurantFoodType: 'vegetarian' },
    ])).toEqual([
      { key: 'restaurant:food_cuisine:sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['sushi'] } },
      { key: 'restaurant:food_cuisine:vegetarian', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['vegetarian'] } },
    ]);
  });

  it('keeps a broad bucket only when a generic task actually exists', () => {
    expect(buildNearbySearchRequests([
      { poi: 'restaurant', title: 'Somewhere for dinner' },
      { poi: 'restaurant', title: 'Sushi', restaurantFoodType: 'sushi' },
      { poi: 'store', title: 'Any shop', storeSubtype: 'any' },
      { poi: 'store', title: 'Clothes', storeSubtype: 'clothing' },
      { poi: 'pharmacy', title: 'Pick up prescription' },
    ])).toEqual([
      { key: 'restaurant', type: 'restaurant' },
      { key: 'restaurant:food_cuisine:sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['sushi'] } },
      { key: 'store', type: 'store' },
      { key: 'store:store_kind:clothing', type: 'store', attribute: { dimension: 'store_kind', values: ['clothing'] } },
      { key: 'pharmacy', type: 'pharmacy' },
    ]);
  });

  it('uses the persisted restaurant subtype before inferring from the task title', () => {
    expect(buildNearbySearchRequests([
      { poi: 'restaurant', title: 'Book an Italian table', restaurantFoodType: 'sushi' },
    ])).toEqual([
      { key: 'restaurant:food_cuisine:sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['sushi'] } },
    ]);
  });

  it('produces a structured pizza subtype request inferred from the task title (KAN-344)', () => {
    expect(buildNearbySearchRequests([
      { poi: 'restaurant', title: 'I want pizza' },
    ])).toEqual([
      { key: 'restaurant:food_cuisine:pizza', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['pizza'] } },
    ]);
  });

  it('keeps the broad restaurant bucket alongside a pizza subtype request', () => {
    expect(buildNearbySearchRequests([
      { poi: 'restaurant', title: 'Somewhere for dinner' },
      { poi: 'restaurant', title: 'I want pizza' },
    ])).toEqual([
      { key: 'restaurant', type: 'restaurant' },
      { key: 'restaurant:food_cuisine:pizza', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['pizza'] } },
    ]);
  });

  it('creates separate canonical Gym/Bank brand requests and skips legacy generic tasks', () => {
    expect(buildNearbySearchRequests([
      { poi: 'gym', title: 'Train at Solinca', poiBrand: 'Solinca' },
      { poi: 'gym', title: 'Old generic gym task' },
      { poi: 'bank', title: 'Go to Caixa', poiBrand: 'Caixa Geral de Depósitos' },
    ])).toEqual([
      { key: 'gym:brand:Solinca', type: 'gym', brand: 'Solinca' },
      { key: 'bank:brand:Caixa Geral de Depósitos', type: 'bank', brand: 'Caixa Geral de Depósitos' },
    ]);
  });
});
