import { httpsCallable } from '@react-native-firebase/functions';
import { functionsService } from './firebase';

interface CoverageResponse {
  status: 'none' | 'building' | 'ready';
  cityId: string | null;
  buildId?: string | null;
}

interface PoiAllResponse {
  covered: boolean;
  cityId?: string;
  /** Only present when `covered` is false — the Worker's own city.status ('none' | 'building' | 'ready'), defaulted to 'none' server-side when no city row exists at all. Lets the caller distinguish "no city built here yet" from "a build is in progress" without a second round-trip to /coverage. */
  status?: 'none' | 'building' | 'ready';
  results: Array<{
    fsq_place_id: string;
    name: string;
    lat: number;
    lng: number;
    primary_poi_type: string;
    brand: string | null;
    category_label: string | null;
    address: string | null;
    distanceMeters: number;
  }>;
}

export async function cloudflareCoverageProxy(lat: number, lng: number): Promise<CoverageResponse> {
  const callable = httpsCallable<{ lat: number; lng: number }, CoverageResponse>(
    functionsService,
    'cloudflareCoverageProxy',
  );
  const result = await callable({ lat, lng });
  return result.data;
}

export async function cloudflarePoiAllProxy(lat: number, lng: number, radiusMeters: number): Promise<PoiAllResponse> {
  const callable = httpsCallable<{ lat: number; lng: number; radiusMeters: number }, PoiAllResponse>(
    functionsService,
    'cloudflarePoiAllProxy',
  );
  const result = await callable({ lat, lng, radiusMeters });
  return result.data;
}
