import {
  filterStorePlacesForTasks,
  groupStorePlaceCandidates,
  inferStoreSubtype,
  inferStoreSubtypeForPoiInference,
  storePlaceMatchesSubtype,
  storeSubtypeSuggestions,
  storeTaskMatchesAnyPlace,
} from '../../src/services/storeSubtypes';

describe('storeSubtypes', () => {
  it('infers store subtype intent from English and pt-PT task text', () => {
    expect(inferStoreSubtype('Buy a t-shirt')).toBe('clothing');
    expect(inferStoreSubtype('Comprar ténis')).toBe('shoes');
    expect(inferStoreSubtype('Comprar carregador')).toBe('electronics');
  });

  it('requires shopping context before promoting subtype intent to store POI inference', () => {
    expect(inferStoreSubtypeForPoiInference('buy a t-shirt')).toBe('clothing');
    expect(inferStoreSubtypeForPoiInference('organize clothes')).toBeNull();
  });

  it('suggests store types by visible label correspondence', () => {
    expect(storeSubtypeSuggestions('Cl')).toEqual(['clothing']);
    expect(storeSubtypeSuggestions('El')).toEqual(['electronics']);
    expect(storeSubtypeSuggestions('Sh')).toEqual(['shoes']);
    expect(storeSubtypeSuggestions('Sap', 'pt-PT')).toEqual(['shoes']);
  });

  it('matches nearby store names against the bundled subtype list', () => {
    expect(storePlaceMatchesSubtype('Zara Colombo', 'clothing')).toBe(true);
    expect(storePlaceMatchesSubtype('Aquaplante', 'clothing')).toBe(false);
  });

  it('filters store places only when a store task has subtype intent', () => {
    const places = [
      { name: 'Aquaplante', distanceMeters: 30 },
      { name: 'Zara', distanceMeters: 70 },
    ];

    expect(filterStorePlacesForTasks('store', places, [
      { title: 'Buy a t-shirt', poi: 'store' },
    ])).toEqual([places[1]]);

    expect(filterStorePlacesForTasks('store', places, [
      { title: 'Buy something', poi: 'store' },
    ])).toEqual(places);
  });

  it('keeps store tasks with subtype intent uncovered by unrelated store places', () => {
    expect(storeTaskMatchesAnyPlace(
      { title: 'Buy a t-shirt', poi: 'store' },
      [{ name: 'Aquaplante' }],
    )).toBe(false);
  });

  it('groups simultaneous store subtype intents by matching task', () => {
    const places = [
      { placeId: 's1', name: 'Zara', distanceMeters: 30 },
      { placeId: 's2', name: 'Worten', distanceMeters: 80 },
    ];

    expect(groupStorePlaceCandidates('store', places, [
      { id: 'clothing', title: 'Buy a t-shirt', poi: 'store' },
      { id: 'electronics', title: 'Buy a charger', poi: 'store' },
    ])).toEqual([
      { task: { id: 'clothing', title: 'Buy a t-shirt', poi: 'store' }, places: [places[0]] },
      { task: { id: 'electronics', title: 'Buy a charger', poi: 'store' }, places: [places[1]] },
    ]);
  });
});
