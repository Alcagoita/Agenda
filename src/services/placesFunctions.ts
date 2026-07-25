import { httpsCallable } from '@react-native-firebase/functions';
import { functionsService } from './firebase';

type AutocompleteMode = 'establishment' | 'cities' | 'address';

interface NearbySearchResponse {
  places?: Array<{
    id: string;
    displayName?: { text: string; languageCode?: string };
    location?: { latitude: number; longitude: number };
    types?: string[];
  }>;
}

interface PlacesAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }>;
}

interface PlaceDetailsResponse {
  location?: { latitude?: number; longitude?: number };
  displayName?: { text?: string };
}

export interface GeocodeAddressComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

export interface ReverseGeocodeResponse {
  status?: string;
  results?: Array<{ address_components?: GeocodeAddressComponent[] }>;
}

export async function searchNearbyPlacesProxy(
  lat: number,
  lng: number,
  poiTypes: string[],
  radiusMeters: number,
): Promise<NearbySearchResponse> {
  const callable = httpsCallable<
    { lat: number; lng: number; poiTypes: string[]; radiusMeters: number },
    NearbySearchResponse
  >(functionsService, 'searchNearbyPlacesProxy');
  const result = await callable({ lat, lng, poiTypes, radiusMeters });
  return result.data;
}

export async function placesAutocompleteProxy(
  query: string,
  mode: AutocompleteMode,
  lat?: number,
  lng?: number,
): Promise<PlacesAutocompleteResponse> {
  const callable = httpsCallable<
    { query: string; mode: AutocompleteMode; lat?: number; lng?: number },
    PlacesAutocompleteResponse
  >(functionsService, 'placesAutocompleteProxy');
  const result = await callable({ query, mode, lat, lng });
  return result.data;
}

export async function getPlaceDetailsProxy(placeId: string): Promise<PlaceDetailsResponse> {
  const callable = httpsCallable<{ placeId: string }, PlaceDetailsResponse>(
    functionsService,
    'getPlaceDetailsProxy',
  );
  const result = await callable({ placeId });
  return result.data;
}

export async function reverseGeocodeProxy(lat: number, lng: number): Promise<ReverseGeocodeResponse> {
  const callable = httpsCallable<{ lat: number; lng: number }, ReverseGeocodeResponse>(
    functionsService,
    'reverseGeocodeProxy',
  );
  const result = await callable({ lat, lng });
  return result.data;
}
