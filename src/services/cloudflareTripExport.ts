/**
 * KAN-343 — imports a covered destination's authenticated Cloudflare SQLite
 * export into the existing trip habitat cache. The downloaded database exists
 * only in memory; `writeTripAreaPlaces` is the durable, queryable cache.
 */
import * as SQLite from 'expo-sqlite';
import { getDistanceMeters } from './geoDistance';
import { cloudflareExportProxy } from './cloudflarePoiFunctions';
import { writeTripAreaPlaces } from './habitatCache';
import type { PlaceCandidate } from './habitatCache';

type ExportRow = {
  fsq_place_id: string;
  name: string;
  lat: number;
  lng: number;
  poi_type: string;
};

function bounds(center: { lat: number; lng: number }, radiusMeters: number) {
  const latDelta = radiusMeters / 111_320;
  const lngDelta = radiusMeters / (111_320 * Math.max(Math.cos(center.lat * Math.PI / 180), 0.01));
  return { minLat: center.lat - latDelta, maxLat: center.lat + latDelta, minLng: center.lng - lngDelta, maxLng: center.lng + lngDelta };
}

/** Downloads then fully validates the export before replacing a trip area. */
export async function importCloudflareTripExport(
  placeId: string,
  center: { lat: number; lng: number },
  radiusMeters: number,
  cacheAreaId: string,
  expiresAt: number,
  poiTypes: string[],
): Promise<number> {
  const data = await cloudflareExportProxy(placeId);
  const database = await SQLite.deserializeDatabaseAsync(data);
  try {
    const box = bounds(center, radiusMeters);
    const placeholders = poiTypes.map(() => '?').join(',');
    const rows = await database.getAllAsync<ExportRow>(
      `SELECT p.fsq_place_id, p.name, p.lat, p.lng, pt.poi_type
       FROM poi p JOIN poi_type pt ON pt.fsq_place_id = p.fsq_place_id
       WHERE p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?
         AND pt.poi_type IN (${placeholders})`,
      [box.minLat, box.maxLat, box.minLng, box.maxLng, ...poiTypes],
    );
    const places: PlaceCandidate[] = rows
      .filter(row => getDistanceMeters(center.lat, center.lng, row.lat, row.lng) <= radiusMeters)
      .map(row => ({
        poiType: row.poi_type,
        name: row.name,
        lat: row.lat,
        lng: row.lng,
        source: { fsq: row.fsq_place_id },
      }));
    if (places.length === 0) throw new Error('Cloudflare export returned no places for this trip area');
    return writeTripAreaPlaces(cacheAreaId, expiresAt, places);
  } finally {
    await database.closeAsync();
  }
}
