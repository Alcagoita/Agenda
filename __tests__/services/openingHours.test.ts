import { isOpenNow } from '../../src/services/openingHours';

/** A local-time Date at HH:MM on a fixed day. */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 0, 1, hour, minute, 0, 0);
}

describe('isOpenNow (KAN-318)', () => {
  const store = { openMin: 540, closeMin: 1140 }; // 09:00–19:00

  it('is open inside the window', () => {
    expect(isOpenNow(store, at(12))).toBe(true);
  });

  it('is open at exactly the opening minute (inclusive)', () => {
    expect(isOpenNow(store, at(9, 0))).toBe(true);
  });

  it('is closed before opening', () => {
    expect(isOpenNow(store, at(8, 59))).toBe(false);
  });

  it('is closed at exactly the closing minute (exclusive)', () => {
    expect(isOpenNow(store, at(19, 0))).toBe(false);
  });

  it('is closed after closing', () => {
    expect(isOpenNow(store, at(22))).toBe(false);
  });

  it('treats a null window as always open (24h / unknown)', () => {
    expect(isOpenNow({ openMin: null, closeMin: null }, at(3))).toBe(true);
    expect(isOpenNow({}, at(3))).toBe(true);
    expect(isOpenNow({ openMin: 540, closeMin: null }, at(3))).toBe(true);
  });

  it('treats a malformed window (close <= open) as always open, never hiding on bad data', () => {
    expect(isOpenNow({ openMin: 1200, closeMin: 600 }, at(3))).toBe(true);
  });
});
