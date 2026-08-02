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

/** Cell size in metres at a given geohash precision (approx, for radius→precision selection). */
const CELL_SIZE_M: Record<number, number> = {
  5: 4900_00 / 100, // ~4.9km x 4.9km cells
  6: 1200,          // ~1.2km x 0.6km
  7: 153,           // ~153m x 153m
  8: 38,
};

/** Picks the coarsest geohash precision whose cell is still smaller than the radius. */
export function precisionForRadius(radiusMeters: number): number {
  if (radiusMeters > 2000) return 5;
  if (radiusMeters > 300) return 6;
  return 7;
}

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
 * radius search can straddle a cell boundary.
 */
export function neighborPrefixes(lat: number, lng: number, precision: number): string[] {
  const cell = CELL_SIZE_M[precision] ?? 153;
  const degLat = cell / 111_195;
  const degLng = cell / (111_195 * Math.cos((lat * Math.PI) / 180));

  const prefixes = new Set<string>();
  for (const dLat of [-1, 0, 1]) {
    for (const dLng of [-1, 0, 1]) {
      prefixes.add(encodeGeohash(lat + dLat * degLat, lng + dLng * degLng, precision));
    }
  }
  return [...prefixes];
}
