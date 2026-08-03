// Minimal geohash encode + neighbor expansion. D1 has no R-tree/spatial index
// (confirmed unsupported), so radius search is done by querying every geohash
// prefix cell that could intersect the search radius, then filtering the
// candidates by real haversine distance in JS.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lng: number, precision = 7): string {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = '';
  let bit = 0, ch = 0, evenBit = true;

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch |= (1 << (4 - bit)); lngMin = mid; } else { lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch |= (1 << (4 - bit)); latMin = mid; } else { latMax = mid; }
    }
    evenBit = !evenBit;
    if (bit < 4) { bit++; } else { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

/**
 * Real geohash cell dimensions (lng x lat metres, at the equator), derived
 * from the bit layout: encoding alternates lng/lat bits starting with lng,
 * so odd precisions (5, 7, ...) split bits evenly between axes -> ~square
 * cells; even precisions (6, 8, ...) give lng one more bit than lat ->
 * lng cells are exactly 2x wider than lat cells, NOT square. Using a single
 * shared dimension for both axes (the previous version of this file) means
 * the narrower axis's neighbor-offset step is up to 2x too large, which can
 * skip the true adjacent cell near a boundary. Values match the standard
 * published geohash precision table.
 */
const CELL_SIZE_M: Record<number, { lng: number; lat: number }> = {
  5: { lng: 4890, lat: 4890 },
  6: { lng: 1220, lat: 610 },
  7: { lng: 153,  lat: 152 },
};

/**
 * Coarsest geohash precision whose 3x3 neighbor window can still safely
 * cover the requested radius. Safe radius per precision = the *smaller* of
 * its two cell dimensions (conservative — the query point could sit right
 * at the edge of its own cell, so the window only guarantees one full cell
 * width of margin in the tighter axis). No precision below 5 is defined, so
 * radii beyond precision 5's safe bound must be rejected by the caller
 * (see MAX_RADIUS_METERS) rather than silently under-covered.
 */
export function precisionForRadius(radiusMeters: number): number {
  if (radiusMeters <= 150) return 7;
  if (radiusMeters <= 600) return 6;
  return 5;
}

/** Largest radius precision 5's 3x3 window can safely cover — see precisionForRadius. Callers must reject/clamp requests beyond this. */
export const MAX_RADIUS_METERS = 4500;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Geohash prefixes for the 3x3 grid of cells centered on (lat, lng) at the
 * given precision — covers the search point plus its 8 neighbors, since a
 * radius search can straddle a cell boundary. Uses separate lng/lat cell
 * dimensions (see CELL_SIZE_M) — a shared single dimension under-steps the
 * wider axis or over-steps the narrower one, either skipping real neighbors
 * or (harmlessly, just wastefully) double-counting cells.
 */
export function neighborPrefixes(lat: number, lng: number, precision: number): string[] {
  const cell = CELL_SIZE_M[precision] ?? CELL_SIZE_M[7];
  const degLat = cell.lat / 111_195;
  const degLng = cell.lng / (111_195 * Math.cos((lat * Math.PI) / 180));

  const prefixes = new Set<string>();
  for (const dLat of [-1, 0, 1]) {
    for (const dLng of [-1, 0, 1]) {
      prefixes.add(encodeGeohash(lat + dLat * degLat, lng + dLng * degLng, precision));
    }
  }
  return [...prefixes];
}
