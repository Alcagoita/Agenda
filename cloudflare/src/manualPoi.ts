import poiTypeCategories from './poiTypeCategories.json';

export const MANUAL_POI_TYPES = Object.freeze(Object.keys(poiTypeCategories));

export const MANUAL_SUBTYPE_FILTERS: Readonly<Record<string, {
  dimension: 'food_cuisine' | 'store_kind';
  values: readonly string[];
}>> = Object.freeze({
  restaurant: {
    dimension: 'food_cuisine',
    values: ['asian', 'bbq', 'brazilian', 'burger', 'healthy', 'indian', 'italian', 'mediterranean', 'mexican', 'pizza', 'portuguese', 'seafood', 'steak', 'sushi', 'thai', 'vegetarian'],
  },
  store: {
    dimension: 'store_kind',
    values: ['beauty', 'bicycle', 'books', 'clothing', 'electronics', 'furniture', 'hardware', 'home', 'jewelry', 'pet', 'shoes', 'sports', 'toys'],
  },
});

export interface ManualPoiAttribute {
  dimension: 'food_cuisine' | 'store_kind';
  value: string;
}

export interface ManualPoiInput {
  name: string;
  lat: number;
  lng: number;
  poiType: string;
  attributes: ManualPoiAttribute[];
  address: string | null;
  contributorNote: string | null;
  idempotencyKey: string;
  turnstileToken: string;
}

const MAX_NAME_LENGTH = 160;
const MAX_ADDRESS_LENGTH = 300;
const MAX_NOTE_LENGTH = 600;
const MAX_TURNSTILE_TOKEN_LENGTH = 2_048;

/** Must stay in sync with classify_and_load.py's canonical identity normalizer. */
export function normalizePoiName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : undefined;
}

/**
 * Validates the public request before any anti-abuse or D1 work.  The return
 * is intentionally data-only so it can be tested without a Worker runtime.
 */
export function parseManualPoiInput(value: unknown): ManualPoiInput | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'body must be an object' };
  const body = value as Record<string, unknown>;
  if (typeof body.name !== 'string') return { error: 'name is required' };
  const name = body.name.trim();
  const dedupeName = normalizePoiName(name);
  if (!dedupeName || name.length > MAX_NAME_LENGTH) return { error: `name must contain text and be at most ${MAX_NAME_LENGTH} characters` };
  if (typeof body.lat !== 'number' || !Number.isFinite(body.lat) || body.lat < -90 || body.lat > 90) return { error: 'lat must be a finite number between -90 and 90' };
  if (typeof body.lng !== 'number' || !Number.isFinite(body.lng) || body.lng < -180 || body.lng > 180) return { error: 'lng must be a finite number between -180 and 180' };
  if (typeof body.poiType !== 'string' || !MANUAL_POI_TYPES.includes(body.poiType)) return { error: 'poiType must be a supported POI type' };
  if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.idempotencyKey)) return { error: 'idempotencyKey is invalid' };
  if (typeof body.turnstileToken !== 'string' || body.turnstileToken.length === 0 || body.turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH) return { error: 'turnstileToken is invalid' };

  if (!Array.isArray(body.attributes) || body.attributes.length > 8) return { error: 'attributes must contain at most 8 entries' };
  const seenAttributes = new Set<string>();
  const attributes: ManualPoiAttribute[] = [];
  for (const rawAttribute of body.attributes) {
    if (!rawAttribute || typeof rawAttribute !== 'object' || Array.isArray(rawAttribute)) return { error: 'each attribute must be an object' };
    const attribute = rawAttribute as Record<string, unknown>;
    const allowed = MANUAL_SUBTYPE_FILTERS[body.poiType];
    if (!allowed || attribute.dimension !== allowed.dimension || typeof attribute.value !== 'string' || !allowed.values.includes(attribute.value)) {
      return { error: 'attribute is not a supported subtype for this POI type' };
    }
    const key = `${allowed.dimension}:${attribute.value}`;
    if (!seenAttributes.has(key)) {
      seenAttributes.add(key);
      attributes.push({ dimension: allowed.dimension, value: attribute.value });
    }
  }

  const address = optionalText(body.address, MAX_ADDRESS_LENGTH);
  if (address === undefined) return { error: `address must be at most ${MAX_ADDRESS_LENGTH} characters` };
  const contributorNote = optionalText(body.contributorNote, MAX_NOTE_LENGTH);
  if (contributorNote === undefined) return { error: `contributorNote must be at most ${MAX_NOTE_LENGTH} characters` };
  return { name, lat: body.lat, lng: body.lng, poiType: body.poiType, attributes, address, contributorNote, idempotencyKey: body.idempotencyKey, turnstileToken: body.turnstileToken };
}

export function isManualPoiInput(value: ManualPoiInput | { error: string }): value is ManualPoiInput {
  return !('error' in value);
}
