import {
  filterRestaurantPlacesForTasks,
  inferRestaurantFoodType,
  restaurantPlaceMatchesFoodType,
  restaurantTaskMatchesAnyPlace,
} from '../../src/services/restaurantFoodTypes';

describe('restaurantFoodTypes', () => {
  it('infers food type intent from English and pt-PT task text', () => {
    expect(inferRestaurantFoodType('Go out to sushi')).toBe('sushi');
    expect(inferRestaurantFoodType('Jantar vegetariano')).toBe('vegetarian');
    expect(inferRestaurantFoodType('Comer comida portuguesa')).toBe('portuguese');
  });

  it('matches nearby restaurant names against the bundled food-type list', () => {
    expect(restaurantPlaceMatchesFoodType('Yakuza by Olivier Lisboa', 'sushi')).toBe(true);
    expect(restaurantPlaceMatchesFoodType('SushiCafe Amoreiras', 'sushi')).toBe(true);
    expect(restaurantPlaceMatchesFoodType('Portugália', 'sushi')).toBe(false);
  });

  it('filters restaurant places only when a restaurant task has food intent', () => {
    const places = [
      { name: 'Portugália', distanceMeters: 30 },
      { name: 'Yakuza by Olivier', distanceMeters: 70 },
    ];

    expect(filterRestaurantPlacesForTasks('restaurant', places, [
      { title: 'Go out to sushi', poi: 'restaurant' },
    ])).toEqual([places[1]]);

    expect(filterRestaurantPlacesForTasks('restaurant', places, [
      { title: 'Book dinner', poi: 'restaurant' },
    ])).toEqual(places);
  });

  it('keeps restaurant tasks with food intent uncovered by unrelated restaurant places', () => {
    expect(restaurantTaskMatchesAnyPlace(
      { title: 'Go out to sushi', poi: 'restaurant' },
      [{ name: 'Portugália' }],
    )).toBe(false);
  });
});
