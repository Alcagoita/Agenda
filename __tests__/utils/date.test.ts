import { addLocalDays, toDateSafe, relativeTime, localDateISO } from '../../src/utils/date';

describe('localDateISO', () => {
  it('formats a plain local date as YYYY-MM-DD', () => {
    expect(localDateISO(new Date(2026, 6, 15))).toBe('2026-07-15');
  });

  it('pads single-digit month and day', () => {
    expect(localDateISO(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  // Changing process.env.TZ mid-test doesn't reliably repropagate to Date
  // in Node/Jest (the timezone table is cached at process start), so these
  // simulate a timezone boundary directly via the local-getter methods
  // localDateISO reads, rather than relying on the runner's real TZ.
  it('reads the local calendar day even when it differs from the UTC day (behind UTC)', () => {
    // e.g. 2026-07-16T02:30 UTC is 2026-07-15 22:30 in New York (UTC-4,
    // July DST) — a naive `date.toISOString().slice(0, 10)` would read
    // '2026-07-16', the UTC day, not the local one.
    const utcLate = new Date('2026-07-16T02:30:00.000Z');
    jest.spyOn(utcLate, 'getFullYear').mockReturnValue(2026);
    jest.spyOn(utcLate, 'getMonth').mockReturnValue(6); // July (0-indexed)
    jest.spyOn(utcLate, 'getDate').mockReturnValue(15);

    expect(localDateISO(utcLate)).toBe('2026-07-15');
    expect(utcLate.toISOString().slice(0, 10)).toBe('2026-07-16'); // the bug this guards against
  });

  it('reads the local calendar day even when it differs from the UTC day (ahead of UTC)', () => {
    // e.g. 2026-07-15T23:30 UTC is 2026-07-16 01:30 in a UTC+2 zone.
    const utcEarly = new Date('2026-07-15T23:30:00.000Z');
    jest.spyOn(utcEarly, 'getFullYear').mockReturnValue(2026);
    jest.spyOn(utcEarly, 'getMonth').mockReturnValue(6);
    jest.spyOn(utcEarly, 'getDate').mockReturnValue(16);

    expect(localDateISO(utcEarly)).toBe('2026-07-16');
    expect(utcEarly.toISOString().slice(0, 10)).toBe('2026-07-15'); // the bug this guards against
  });
});

describe('addLocalDays', () => {
  it.each([
    ['2026-01-31', '2026-02-01'],
    ['2026-02-28', '2026-03-01'],
    ['2024-02-28', '2024-02-29'],
    ['2024-02-29', '2024-03-01'],
    ['2026-12-31', '2027-01-01'],
  ])('moves %s forward one local calendar day to %s', (input, expected) => {
    expect(addLocalDays(input, 1)).toBe(expected);
  });

  it.each(['2026-02-29', '2026-13-01', '2026-04-31', 'not-a-date'])('returns null for an invalid calendar date: %s', input => {
    expect(addLocalDays(input, 1)).toBeNull();
  });
});

describe('toDateSafe', () => {
  it('returns null for null/undefined', () => {
    expect(toDateSafe(null)).toBeNull();
    expect(toDateSafe(undefined)).toBeNull();
  });

  it('passes through a native Date unchanged', () => {
    const d = new Date('2026-05-01T12:00:00.000Z');
    expect(toDateSafe(d)).toBe(d);
  });

  it('coerces a Firestore-Timestamp-like object via toDate()', () => {
    const date = new Date('2026-05-01T12:00:00.000Z');
    const ts = { toDate: () => date };
    expect(toDateSafe(ts)).toBe(date);
  });

  it('falls back to a plain {_seconds} object', () => {
    const seconds = 1_800_000_000;
    const result = toDateSafe({ _seconds: seconds });
    expect(result).toEqual(new Date(seconds * 1000));
  });

  it('coerces a {toMillis()} object (e.g. achievements.ts createdAt shape)', () => {
    const ms = 1_800_000_000_000;
    expect(toDateSafe({ toMillis: () => ms })).toEqual(new Date(ms));
  });

  it('falls back to a plain {seconds} object (e.g. PublicProfileScreen shape)', () => {
    const seconds = 1_800_000_000;
    expect(toDateSafe({ seconds })).toEqual(new Date(seconds * 1000));
  });

  it('returns null for an object with none of the recognized shapes', () => {
    expect(toDateSafe({ foo: 'bar' })).toBeNull();
  });

  it('returns null for a primitive that is not a Date', () => {
    expect(toDateSafe('2026-05-01')).toBeNull();
    expect(toDateSafe(12345)).toBeNull();
  });
});

describe('relativeTime', () => {
  const NOW = new Date('2026-05-01T12:00:00.000Z').getTime();

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an empty string when the timestamp cannot be coerced', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime({})).toBe('');
  });

  it('returns "just now" for under a minute', () => {
    const ts = { toDate: () => new Date(NOW - 30_000) };
    expect(relativeTime(ts)).toBe('just now');
  });

  it('returns minutes for under an hour', () => {
    const ts = { toDate: () => new Date(NOW - 5 * 60_000) };
    expect(relativeTime(ts)).toBe('5m ago');
  });

  it('returns hours for under a day', () => {
    const ts = { toDate: () => new Date(NOW - 3 * 60 * 60_000) };
    expect(relativeTime(ts)).toBe('3h ago');
  });

  it('returns days for a day or more', () => {
    const ts = { toDate: () => new Date(NOW - 2 * 24 * 60 * 60_000) };
    expect(relativeTime(ts)).toBe('2d ago');
  });
});
