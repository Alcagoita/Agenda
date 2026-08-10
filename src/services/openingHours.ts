/**
 * openingHours.ts — KAN-318: is a place open right now?
 *
 * The backend bakes a default open/close window per POI into `open_min` /
 * `close_min` (minutes from local midnight) — keyed on the Foursquare category,
 * with OSM `opening_hours` as a later refinement. The app does only this
 * trivial check and hides closed places from the Nearby suggestion.
 *
 * A missing window means "always open" — which also stands in for 24h and for
 * "unknown". We never hide a place on absence of data (the app never lies /
 * never hides on a guess). Windows are same-day (open < close), local time.
 */
import type { NearbyPlace } from './maps';

type WithWindow = Pick<NearbyPlace, 'openMin' | 'closeMin'>;

/**
 * POI types whose search results are treated as open 24h regardless of the
 * row's stored window. An ATM search also returns bank branches
 * (type_relation atm -> [atm, bank], KAN-337): the branch itself closes around
 * 15:00, but the ATM it houses runs 24h — so any place surfaced *as an ATM*
 * must never be hidden on the bank's hours. The window still applies when the
 * same bank is surfaced for a `bank` search.
 */
export const ALWAYS_OPEN_WHEN_SEARCHED: ReadonlySet<string> = new Set(['atm']);

/** Minutes since local midnight for `now`. */
function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * True when the place is open at `now` (default: current time) for a search of
 * `searchType`. Always true when the search type is 24h-by-nature (ATM) or when
 * no valid window is known — closed is only ever asserted on real data.
 */
export function isOpenNow(place: WithWindow, now: Date = new Date(), searchType?: string): boolean {
  if (searchType != null && ALWAYS_OPEN_WHEN_SEARCHED.has(searchType)) { return true; }
  const { openMin, closeMin } = place;
  if (openMin == null || closeMin == null) { return true; }
  if (!Number.isFinite(openMin) || !Number.isFinite(closeMin) || closeMin <= openMin) { return true; }
  const m = minutesOfDay(now);
  return m >= openMin && m < closeMin;
}
