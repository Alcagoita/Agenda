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
      { poi: 'store', title: 'Clothes', storeSubtype: 'clothing' },
      { poi: 'pharmacy', title: 'Pick up prescription' },
    ])).toEqual([
      { key: 'restaurant', type: 'restaurant' },
      { key: 'restaurant:food_cuisine:sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['sushi'] } },
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
});
