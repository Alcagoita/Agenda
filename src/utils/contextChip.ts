/**
 * contextChip.ts — trip date predicates (KAN-242).
 *
 * The header ContextChip this file was named for is gone: KAN-301 replaced it
 * with the Lantern and KAN-349 deleted the component, its view type and its
 * resolver. What survives is the pure trip-date logic those screens still ask
 * for — isTodayWithinTripDates (utils/lantern), isTripPast and
 * isPastMemorableTrip (CalendarScreen, useWhereWeveBeen, usePlaces). The file
 * keeps its name so those imports stay put.
 */
import type { Trip } from '../types';

/** True when today falls within the trip's dates. A dateless trip (user skipped both) has no date constraint. */
export function isTodayWithinTripDates(trip: Trip, todayIso: string): boolean {
  if (!trip.startDate && !trip.endDate) { return true; }
  if (trip.startDate && todayIso < trip.startDate) { return false; }
  if (trip.endDate && todayIso > trip.endDate) { return false; }
  return true;
}

/**
 * KAN-257 — true when a trip is over: it has an endDate and that date is
 * before today. A dateless trip (endDate never set) is never "past" — there's
 * nothing to remember it by yet. Off-grid trips (kind:'offgrid') are a
 * separate concept entirely (KAN-246) and must be filtered by the caller —
 * this helper doesn't know about kind, deliberately, since past-ness is a
 * pure date question independent of what kind of trip it is.
 */
export function isTripPast(trip: Trip, todayIso: string): boolean {
  return !!trip.endDate && trip.endDate < todayIso;
}

/**
 * KAN-257 — a trip worth remembering on "Where we've been": past (per
 * isTripPast) AND not an off-grid window (KAN-246 — a Tuesday hike isn't a
 * trip memory). Both useWhereWeveBeen and CalendarScreen need exactly this
 * combined check; kept here rather than duplicated at each call site.
 */
export function isPastMemorableTrip(trip: Trip, todayIso: string): boolean {
  return trip.kind !== 'offgrid' && isTripPast(trip, todayIso);
}
