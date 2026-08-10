/**
 * date.ts — Shared date utilities.
 */

/**
 * Returns `date` as a YYYY-MM-DD string using its device-local calendar day
 * — never `date.toISOString().slice(0, 10)`, which reads the UTC day and
 * silently drifts by one near local midnight (e.g. 11pm local in a
 * negative-UTC-offset timezone is already "tomorrow" in UTC).
 */
export function localDateISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Returns today's date as a YYYY-MM-DD string in the device's local timezone. */
export function todayISO(): string {
  return localDateISO(new Date());
}

/** Advance a YYYY-MM-DD value by whole local calendar days without UTC drift. */
export function addLocalDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDateISO(date);
}

/** "18:00" — 24h local time, no seconds. Not COPY (numeric, not language-dependent). */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "May 22" — short month + day, locale-aware. Not COPY (relies on the device locale's Intl formatting, not the app's two-language dictionary). */
export function formatDateShort(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return new Date(2000, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Returns the Monday 00:00:00.000 and Sunday 23:59:59.999 boundaries of the
 * current local calendar week (ISO week: Mon–Sun).
 */
export function getCurrentWeekBoundaries(): { monday: Date; sunday: Date } {
  const now       = new Date();
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay(); // 1 (Mon) – 7 (Sun)

  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek - 1));
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { monday, sunday };
}

/**
 * Returns true if `date` falls within the current Mon–Sun calendar week.
 */
export function isThisWeek(date: Date): boolean {
  const { monday, sunday } = getCurrentWeekBoundaries();
  return date >= monday && date <= sunday;
}

/**
 * Safely coerce a Firestore Timestamp — or any of its serialized/plain-object
 * shapes seen across this codebase (`{toDate()}`, `{toMillis()}`, `{_seconds}`,
 * `{seconds}`), or an already-native `Date` — into a `Date`.
 * Returns `null` for anything else (including missing/undefined).
 *
 * Consolidates the `(ts as any).toDate?.() ?? new Date((ts as any)._seconds * 1000)`
 * pattern that was duplicated across several screens (KAN-215).
 */
export function toDateSafe(ts: unknown): Date | null {
  if (!ts) { return null; }
  if (ts instanceof Date) { return ts; }
  const maybeTimestamp = ts as {
    toDate?:   () => Date;
    toMillis?: () => number;
    _seconds?: number;
    seconds?:  number;
  };
  if (typeof maybeTimestamp.toDate   === 'function') { return maybeTimestamp.toDate(); }
  if (typeof maybeTimestamp.toMillis === 'function') { return new Date(maybeTimestamp.toMillis()); }
  if (typeof maybeTimestamp._seconds === 'number')   { return new Date(maybeTimestamp._seconds * 1000); }
  if (typeof maybeTimestamp.seconds  === 'number')   { return new Date(maybeTimestamp.seconds * 1000); }
  return null;
}

/**
 * "3m ago" / "2h ago" / "5d ago" relative-time label for a Firestore Timestamp
 * (or anything toDateSafe accepts). Returns '' when ts can't be coerced.
 */
export function relativeTime(ts: unknown): string {
  const date = toDateSafe(ts);
  if (!date) { return ''; }
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  { return `${hrs}h ago`; }
  return `${Math.floor(hrs / 24)}d ago`;
}
