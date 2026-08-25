import { resolvePoiIconType } from '../../src/components/AppIcon/poi';

describe('resolvePoiIconType', () => {
  it('maps police to the official building icon family', () => {
    expect(resolvePoiIconType('police')).toBe('bank');
    expect(resolvePoiIconType('neighborhood_police_station')).toBe('bank');
  });

  it('keeps existing built-in poi keys unchanged', () => {
    expect(resolvePoiIconType('atm')).toBe('atm');
    expect(resolvePoiIconType('supermarket')).toBe('supermarket');
    expect(resolvePoiIconType('financial_service')).toBe('financial_service');
  });

  it('maps common API families with suffix rules', () => {
    expect(resolvePoiIconType('portuguese_restaurant')).toBe('restaurant');
    expect(resolvePoiIconType('candy_store')).toBe('store');
    expect(resolvePoiIconType('dog_park')).toBe('park');
    expect(resolvePoiIconType('bus_stop')).toBe('bus');
    expect(resolvePoiIconType('general_hospital')).toBe('clinic');
    expect(resolvePoiIconType('hair_salon')).toBe('hairdresser');
    // KAN-408 drew church its own icon; it no longer borrows the library's.
    // The other assertions here still exercise the suffix rules.
    expect(resolvePoiIconType('church')).toBe('church');
    expect(resolvePoiIconType('parking_garage')).toBe('gas');
  });

  it('maps broader leisure and building families away from the fallback pin', () => {
    // `movie_theater` used to borrow the library icon because it had none of
    // its own. KAN-412 drew it a clapperboard and made it a real PoiType, so
    // it now keeps itself — `concert_hall` below still exercises the
    // borrowing this test is about.
    expect(resolvePoiIconType('movie_theater')).toBe('movie_theater');
    expect(resolvePoiIconType('concert_hall')).toBe('park');
    expect(resolvePoiIconType('fitness_center')).toBe('gym');
    expect(resolvePoiIconType('apartment_building')).toBe('store');
    expect(resolvePoiIconType('travel_agency')).toBe('bank');
    // Likewise brewery — a real type since KAN-408, not a cafe.
    expect(resolvePoiIconType('brewery')).toBe('brewery');
  });
});
