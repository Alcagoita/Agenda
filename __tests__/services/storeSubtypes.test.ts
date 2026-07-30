import {
  filterStorePlacesForTasks,
  groupStorePlaceCandidates,
  inferStoreSubtype,
  inferStoreSubtypeForPoiInference,
  storePlaceMatchesSubtype,
  storeSubtypeSuggestions,
  storeTaskSubtype,
  storeTaskMatchesAnyPlace,
} from '../../src/services/storeSubtypes';

describe('storeSubtypes', () => {
  it('infers store subtype intent from English and pt-PT task text', () => {
    expect(inferStoreSubtype('Buy a t-shirt')).toBe('clothing');
    expect(inferStoreSubtype('Comprar ténis')).toBe('shoes');
    expect(inferStoreSubtype('Comprar carregador')).toBe('electronics');
    expect(inferStoreSubtype('Buy computer parts')).toBe('electronics');
    expect(inferStoreSubtype('Comprar peças de computador')).toBe('electronics');
    expect(inferStoreSubtype('Buy a sofa')).toBe('furniture');
    expect(inferStoreSubtype('Buy screws')).toBe('hardware');
    expect(inferStoreSubtype('Buy a bicycle helmet')).toBe('bicycle');
    expect(inferStoreSubtype('Buy a necklace')).toBe('jewelry');
  });

  it('requires shopping context before promoting subtype intent to store POI inference', () => {
    expect(inferStoreSubtypeForPoiInference('buy a t-shirt')).toBe('clothing');
    expect(inferStoreSubtypeForPoiInference('organize clothes')).toBeNull();
  });

  it('does not compact-match aliases inside larger words', () => {
    expect(inferStoreSubtype('Comprar prato')).toBeNull();
    expect(inferStoreSubtypeForPoiInference('Comprar prato')).toBeNull();
    expect(filterStorePlacesForTasks('store', [{ name: 'Worten' }], [
      { title: 'Comprar prato', poi: 'store' },
    ])).toEqual([{ name: 'Worten' }]);
  });

  it('suggests store types by visible label correspondence', () => {
    expect(storeSubtypeSuggestions('')).toContain('any');
    expect(storeSubtypeSuggestions('Cl')).toEqual(['clothing']);
    expect(storeSubtypeSuggestions('El')).toEqual(['electronics']);
    expect(storeSubtypeSuggestions('Fu')).toEqual(['furniture']);
    expect(storeSubtypeSuggestions('Ha')).toEqual(['hardware']);
    expect(storeSubtypeSuggestions('Bi')).toEqual(['bicycle']);
    expect(storeSubtypeSuggestions('Je')).toEqual(['jewelry']);
    expect(storeSubtypeSuggestions('Sh')).toEqual(['shoes']);
    expect(storeSubtypeSuggestions('Sap', 'pt-PT')).toEqual(['shoes']);
  });

  it('matches nearby store names against the bundled subtype list', () => {
    expect(storePlaceMatchesSubtype('Aquaplante', 'any')).toBe(true);
    expect(storePlaceMatchesSubtype('Zara Colombo', 'clothing')).toBe(true);
    expect(storePlaceMatchesSubtype('Aquaplante', 'clothing')).toBe(false);
  });

  it('matches cached stores by stored subtype before falling back to name', () => {
    expect(storePlaceMatchesSubtype({ name: 'store', storeSubtype: 'clothing' }, 'clothing')).toBe(true);
    expect(storePlaceMatchesSubtype({ name: 'Zara', storeSubtype: 'pet' }, 'clothing')).toBe(false);
    expect(storePlaceMatchesSubtype({ name: 'store', storeSubtype: 'pet' }, 'clothing')).toBe(false);
  });

  it('filters store places only when a store task has subtype intent', () => {
    const places = [
      { name: 'Aquaplante', distanceMeters: 30 },
      { name: 'Zara', distanceMeters: 70 },
    ];

    expect(filterStorePlacesForTasks('store', places, [
      { title: 'Buy a t-shirt', poi: 'store' },
    ])).toEqual([places[1]]);

    expect(filterStorePlacesForTasks('store', [
      { name: 'store', storeSubtype: 'clothing', distanceMeters: 30 },
      { name: 'store', storeSubtype: 'pet', distanceMeters: 70 },
    ], [
      { title: 'Buy a t-shirt', poi: 'store' },
    ])).toEqual([{ name: 'store', storeSubtype: 'clothing', distanceMeters: 30 }]);

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

  it('prefers an explicit task store subtype before title inference', () => {
    expect(storeTaskSubtype({
      title: 'Buy a t-shirt',
      poi: 'store',
      storeSubtype: 'electronics',
    })).toBe('electronics');
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
