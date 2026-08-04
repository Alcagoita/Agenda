// Pure, dependency-free — deliberately its own module rather than living in
// maps.ts. osmPlaces.ts needs this (for OsmPlace.distanceMeters) and maps.ts
// now needs osmPlaces.ts (KAN-342's OSM failsafe in searchNearbyPlaces) —
// keeping this here, with maps.ts re-exporting it, avoids a circular import
// between the two (maps.ts -> osmPlaces.ts -> maps.ts) that would otherwise
// exist if this stayed defined in maps.ts itself.

const DEG_TO_RAD = Math.PI / 180;

/**
 * Returns the great-circle distance in metres between two lat/lng pairs.
 * Accurate enough for geofence radii of 50–75 m.
 */
export function getDistanceMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000; // Earth radius in metres
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
