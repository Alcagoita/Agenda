/**
 * KAN-247 — home.ts: explicit home anchor, no inference.
 *
 * Covers the ticket's AC directly:
 *   - distanceFromHome / isNearHome return null when home is unset
 *   - correct distances/near-ness once a home point is fed in
 *   - isNearHome's default radius vs. a caller-supplied radius
 */

import {
  setHomeLocation,
  distanceFromHome,
  isNearHome,
  getHomeLocation,
  HOME_RADIUS_M,
  __resetHomeLocation,
} from '../../src/services/home';

beforeEach(() => {
  __resetHomeLocation();
});

describe('graceful unset paths', () => {
  it('distanceFromHome returns null when home was never set', () => {
    expect(distanceFromHome({ lat: 0, lng: 0 })).toBeNull();
  });

  it('isNearHome returns null when home was never set', () => {
    expect(isNearHome({ lat: 0, lng: 0 })).toBeNull();
  });

  it('getHomeLocation returns null when unset', () => {
    expect(getHomeLocation()).toBeNull();
  });

  it('setHomeLocation(null) clears a previously-set home', () => {
    setHomeLocation({ address: '221B Baker Street', lat: 51.5, lng: -0.1 });
    expect(getHomeLocation()).not.toBeNull();

    setHomeLocation(null);
    expect(getHomeLocation()).toBeNull();
    expect(distanceFromHome({ lat: 51.5, lng: -0.1 })).toBeNull();
    expect(isNearHome({ lat: 51.5, lng: -0.1 })).toBeNull();
  });
});

describe('with home set', () => {
  const home = { address: 'Mercado da Vila', lat: 0, lng: 0 };

  beforeEach(() => {
    setHomeLocation(home);
  });

  it('getHomeLocation returns the fed-in point', () => {
    expect(getHomeLocation()).toEqual(home);
  });

  it('distanceFromHome returns 0 at the exact home point', () => {
    expect(distanceFromHome({ lat: 0, lng: 0 })).toBe(0);
  });

  it('distanceFromHome returns a positive distance elsewhere', () => {
    // ~0.001 deg lat ≈ 111 m at the equator.
    const dist = distanceFromHome({ lat: 0.001, lng: 0 });
    expect(dist).not.toBeNull();
    expect(dist as number).toBeGreaterThan(100);
    expect(dist as number).toBeLessThan(120);
  });

  it('isNearHome is true within the default HOME_RADIUS_M', () => {
    // ~0.005 deg lat ≈ 555 m — well within the 1000 m default.
    expect(isNearHome({ lat: 0.005, lng: 0 })).toBe(true);
  });

  it('isNearHome is false just outside the default HOME_RADIUS_M', () => {
    // ~0.02 deg lat ≈ 2222 m — outside 1000 m.
    expect(isNearHome({ lat: 0.02, lng: 0 })).toBe(false);
  });

  it('isNearHome respects a caller-supplied radius', () => {
    const farCoords = { lat: 0.02, lng: 0 }; // ~2222 m away
    expect(isNearHome(farCoords, HOME_RADIUS_M)).toBe(false);
    expect(isNearHome(farCoords, 3000)).toBe(true);
  });
});
