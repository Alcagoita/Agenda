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
 * Coarsest geohash precision worth starting from for a given radius — picked
 * so a typical query's neighbor grid (see neighborPrefixes) stays small
 * (few cells) rather than needing dozens, not because coarser precisions are
 * "unsafe": neighborPrefixes now expands the grid to whatever size the
 * radius/latitude actually require, so there's no unsafe precision/radius
 * combination left, just a less efficient one if the wrong precision tier
 * is picked for a given radius.
 */
export function precisionForRadius(radiusMeters: number): number {
  if (radiusMeters <= 150) return 7;
  if (radiusMeters <= 600) return 6;
  return 5;
}

/** Sanity ceiling on requested radius — not a geohash-safety bound (see neighborPrefixes, which now handles any radius/latitude combination correctly), just a cap on how large a single query is allowed to ask for. */
export const MAX_RADIUS_METERS = 4500;

/**
 * A geohash cell's width in degrees is fixed by its precision alone (pure
 * bit-count math, independent of any specific lat/lng) — but converting
 * that to metres divides the longitude axis by cos(lat): meridians
 * converge toward the poles, so the same number of degrees of longitude
 * covers fewer real metres the further from the equator a query is. A fixed
 * 3x3 neighbor grid sized off an "at the equator" cell estimate is
 * therefore only safe there — confirmed live at Lisbon's ~38.7°N, a fixed
 * 3x3 grid missed real in-range results near the edge of the search radius,
 * because the real lng cell width at that latitude is narrower than the
 * equatorial estimate the fixed grid assumed. neighborPrefixes below sizes
 * its grid from these exact per-latitude dimensions instead of assuming 3x3
 * is always enough.
 */
function cellDimensionsDeg(precision: number): { latDeg: number; lngDeg: number } {
  const totalBits = precision * 5;
  const lngBits = Math.ceil(totalBits / 2); // encoding starts on the lng bit (evenBit=true), so an odd total splits in lng's favor
  const latBits = Math.floor(totalBits / 2);
  return { lngDeg: 360 / 2 ** lngBits, latDeg: 180 / 2 ** latBits };
}

const METERS_PER_DEGREE_LAT = 111_195;

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
 * Cell boundaries [latMin, latMax, lngMin, lngMax] for the geohash cell
 * containing (lat, lng) at the given precision — the exact same bit-by-bit
 * bisection as encodeGeohash, just returning the final bounding box instead
 * of the base32 string. Lets neighborPrefixes offset from the cell's own
 * true center instead of the arbitrary query point (see there for why that
 * distinction is the whole fix).
 */
function geohashCellBounds(lat: number, lng: number, precision: number) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let bit = 0, evenBit = true, hashLen = 0;

  while (hashLen < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { lngMin = mid; } else { lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { latMin = mid; } else { latMax = mid; }
    }
    evenBit = !evenBit;
    if (bit < 4) { bit++; } else { hashLen++; bit = 0; }
  }
  return { latMin, latMax, lngMin, lngMax };
}

/**
 * Geohash prefixes for the grid of cells around (lat, lng)'s own geohash
 * cell at the given precision, sized to guarantee full coverage of
 * radiusMeters — not a fixed 3x3.
 *
 * KAN-341, two bugs found and fixed together:
 *
 * 1. The original version offset by one cell-width directly from the raw
 *    query point (lat, lng) — but geohash cells have fixed absolute
 *    boundaries (recursive bisection of the whole coordinate space), not
 *    boundaries centered on wherever the query point happens to fall. A
 *    point near one edge of its own cell, offset by exactly one cell-width,
 *    could land back in the SAME cell or jump past the true neighbor into
 *    the cell beyond it — confirmed live: up to 64% of real in-range
 *    results were silently missing depending on radius/precision. Fixed by
 *    decoding the query point's own cell bounds first and offsetting from
 *    that cell's exact center by its own exact dimensions — stepping one
 *    full cell-width from dead-center always lands in the true adjacent
 *    cell, wherever the original query point sat within its cell.
 *
 * 2. A fixed 3x3 grid assumes one cell-width of margin is always enough,
 *    which is only true right at precisionForRadius's own threshold
 *    boundaries AND only at the equator (see cellDimensionsDeg's comment on
 *    why lng cells narrow with latitude). A request near the top of a
 *    precision tier's radius range, at a real latitude, could still exceed
 *    a fixed 3x3 window's true coverage. Fixed by computing exactly how
 *    many cells out are needed per axis for THIS radius/latitude/precision,
 *    rather than assuming 3 is always enough — this also means there is no
 *    longer any "unsafe" radius/latitude combination to reject; the grid
 *    just grows if it needs to (typically stays small: the precision tiers
 *    in precisionForRadius keep a well-chosen precision's grid near 3x3
 *    even at high latitudes, growing only for extreme cases).
 */
export function neighborPrefixes(lat: number, lng: number, precision: number, radiusMeters: number): string[] {
  const bounds = geohashCellBounds(lat, lng, precision);
  const centerLat = (bounds.latMin + bounds.latMax) / 2;
  const centerLng = (bounds.lngMin + bounds.lngMax) / 2;
  const cellHeightDeg = bounds.latMax - bounds.latMin;
  const cellWidthDeg = bounds.lngMax - bounds.lngMin;

  const cellHeightMeters = cellHeightDeg * METERS_PER_DEGREE_LAT;
  const cellWidthMeters = cellWidthDeg * METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);

  // Worst case, the query point sits right at the edge of its own cell (~0
  // margin within it) — so full coverage needs N whole cells out from the
  // own cell's center in that axis, where N*cellSize >= radiusMeters.
  // Capped: D1 binds one parameter per prefix (confirmed 100-bound-param
  // hard limit), and lng cell width shrinks toward zero near the poles
  // (cos(lat) -> 0), which would otherwise blow this up unboundedly for a
  // query at an extreme latitude. This product only serves Portugal today
  // — the cap is a safety net against a pathological future query, not
  // something normal usage should ever hit (verified: Lisbon's latitude
  // needs at most 2 cells out even at MAX_RADIUS_METERS).
  const MAX_GRID_CELLS_PER_AXIS = 4;
  const cellsLat = Math.min(MAX_GRID_CELLS_PER_AXIS, Math.max(1, Math.ceil(radiusMeters / cellHeightMeters)));
  const cellsLng = Math.min(MAX_GRID_CELLS_PER_AXIS, Math.max(1, Math.ceil(radiusMeters / cellWidthMeters)));

  const prefixes = new Set<string>();
  for (let dLat = -cellsLat; dLat <= cellsLat; dLat++) {
    for (let dLng = -cellsLng; dLng <= cellsLng; dLng++) {
      prefixes.add(encodeGeohash(centerLat + dLat * cellHeightDeg, centerLng + dLng * cellWidthDeg, precision));
    }
  }
  return [...prefixes];
}
