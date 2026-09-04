import {
  filterRestaurantPlacesForTasks,
  groupRestaurantPlaceCandidates,
  inferRestaurantFoodType,
  inferRestaurantFoodTypeForPoiInference,
  listRestaurantFoodTypes,
  restaurantFoodTypeSuggestions,
  restaurantPlaceMatchesFoodType,
  restaurantTaskMatchesAnyPlace,
} from '../../src/services/restaurantFoodTypes';

describe('restaurantFoodTypes', () => {
  it('infers food type intent from English and pt-PT task text', () => {
    expect(inferRestaurantFoodType('Go out to sushi')).toBe('sushi');
    expect(inferRestaurantFoodType('Jantar vegetariano')).toBe('vegetarian');
    expect(inferRestaurantFoodType('Jantar sem glúten')).toBe('gluten_free');
    expect(inferRestaurantFoodType('Fondue no inverno')).toBe('fondue');
    expect(inferRestaurantFoodType('Comer comida portuguesa')).toBe('portuguese');
  });

  it('does not promote ambiguous food words without restaurant context', () => {
    expect(inferRestaurantFoodTypeForPoiInference('buy pasta')).toBeNull();
    expect(inferRestaurantFoodTypeForPoiInference('buy meat')).toBeNull();
    expect(inferRestaurantFoodTypeForPoiInference('make salad')).toBeNull();
    expect(inferRestaurantFoodTypeForPoiInference('go out for pasta')).toBe('italian');
  });

  it('matches nearby restaurant names against the bundled food-type list', () => {
    expect(restaurantPlaceMatchesFoodType('Yakuza by Olivier Lisboa', 'sushi')).toBe(true);
    expect(restaurantPlaceMatchesFoodType('SushiCafe Amoreiras', 'sushi')).toBe(true);
    expect(restaurantPlaceMatchesFoodType('Portugália', 'sushi')).toBe(false);
  });

  it('matches cached restaurants by stored food type before falling back to name', () => {
    expect(restaurantPlaceMatchesFoodType({ name: 'restaurant', restaurantFoodType: 'sushi' }, 'sushi')).toBe(true);
    expect(restaurantPlaceMatchesFoodType({ name: 'Portugália', restaurantFoodType: 'sushi' }, 'sushi')).toBe(true);
    expect(restaurantPlaceMatchesFoodType({ name: 'restaurant', restaurantFoodType: 'portuguese' }, 'sushi')).toBe(false);
    expect(restaurantPlaceMatchesFoodType({ name: 'restaurant', restaurantFoodTypes: ['italian', 'vegetarian'] }, 'vegetarian')).toBe(true);
  });

  it('suggests food types by visible label correspondence, not hidden aliases', () => {
    expect(restaurantFoodTypeSuggestions('Po')).toEqual(['portuguese']);
    // 'It' matches 'Italian' as a prefix (ranked first) and 'Mediterranean'
    // as a mid-word substring (med-IT-erranean) — both are visible-label
    // matches, which is exactly what this test guards.
    expect(restaurantFoodTypeSuggestions('It')).toEqual(['italian', 'mediterranean']);
    expect(restaurantFoodTypeSuggestions('Su')).toEqual(['sushi']);
  });

  it('filters restaurant places only when a restaurant task has food intent', () => {
    const places = [
      { name: 'Portugália', distanceMeters: 30 },
      { name: 'Yakuza by Olivier', distanceMeters: 70 },
    ];

    expect(filterRestaurantPlacesForTasks('restaurant', places, [
      { title: 'Go out to sushi', poi: 'restaurant' },
    ])).toEqual([places[1]]);

    expect(filterRestaurantPlacesForTasks('restaurant', [
      { name: 'restaurant', restaurantFoodType: 'sushi', distanceMeters: 30 },
      { name: 'restaurant', restaurantFoodType: 'portuguese', distanceMeters: 70 },
    ], [
      { title: 'Go out to sushi', poi: 'restaurant' },
    ])).toEqual([{ name: 'restaurant', restaurantFoodType: 'sushi', distanceMeters: 30 }]);

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

  it('groups simultaneous restaurant food intents by matching task', () => {
    const places = [
      { placeId: 'r1', name: 'Portugália', distanceMeters: 30 },
      { placeId: 'r2', name: 'Yakuza by Olivier', distanceMeters: 80 },
    ];

    expect(groupRestaurantPlaceCandidates('restaurant', places, [
      { id: 'sushi', title: 'Go out to sushi', poi: 'restaurant' },
      { id: 'portuguese', title: 'Comer comida portuguesa', poi: 'restaurant' },
    ])).toEqual([
      { task: { id: 'sushi', title: 'Go out to sushi', poi: 'restaurant' }, places: [places[1]] },
      { task: { id: 'portuguese', title: 'Comer comida portuguesa', poi: 'restaurant' }, places: [places[0]] },
    ]);
  });

  it('infers the new KAN-344 subtypes from task text (dictionary-driven)', () => {
    expect(inferRestaurantFoodType('I want pizza')).toBe('pizza');
    expect(inferRestaurantFoodType('Jantar chinês')).toBe('asian');
    expect(inferRestaurantFoodType('Comer marisco')).toBe('seafood');
    expect(inferRestaurantFoodType('Churrasco no domingo')).toBe('bbq');
    expect(inferRestaurantFoodType('Comida brasileira')).toBe('brazilian');
    expect(inferRestaurantFoodType('Mediterranean lunch')).toBe('mediterranean');
    expect(inferRestaurantFoodType('Jantar mediterrâneo')).toBe('mediterranean');
  });

  it('routes pizza intent to pizza, not italian, after moving the alias', () => {
    expect(inferRestaurantFoodType('I want pizza')).toBe('pizza');
    // italian keeps pasta
    expect(inferRestaurantFoodTypeForPoiInference('go out for pasta')).toBe('italian');
  });

  it('lists the new subtypes as selectable food types', () => {
    const types = listRestaurantFoodTypes();
    for (const t of ['pizza', 'seafood', 'bbq', 'brazilian', 'mediterranean', 'asian', 'gluten_free', 'fondue']) {
      expect(types).toContain(t);
    }
  });

  it('matches new-subtype places by bundled brand name', () => {
    expect(restaurantPlaceMatchesFoodType('Telepizza Benfica', 'pizza')).toBe(true);
    expect(restaurantPlaceMatchesFoodType('Cervejaria Ramiro', 'seafood')).toBe(true);
    expect(restaurantPlaceMatchesFoodType('Portugália', 'pizza')).toBe(false);
  });
});
