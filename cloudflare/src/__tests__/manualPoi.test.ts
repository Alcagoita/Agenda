import { describe, expect, it } from 'vitest';
import { normalizePoiName, parseManualPoiInput } from '../manualPoi';

const validSubmission = {
  name: 'The Sushi Soul',
  lat: 39.54600992794788,
  lng: -8.974655205202168,
  poiType: 'restaurant',
  attributes: [{ dimension: 'food_cuisine', value: 'sushi' }],
  idempotencyKey: '4b28143c-7ea0-4c03-9152-c083fa522d8e',
  turnstileToken: 'turnstile-token',
};

describe('manual community POI input', () => {
  it('normalizes accents and punctuation the same way as imported POIs', () => {
    expect(normalizePoiName('A Padaria Portuguêsa!')).toBe('a padaria portuguesa');
  });

  it('accepts a valid typed suggestion and deduplicates repeated attributes', () => {
    const parsed = parseManualPoiInput({
      ...validSubmission,
      attributes: [
        { dimension: 'food_cuisine', value: 'sushi' },
        { dimension: 'food_cuisine', value: 'sushi' },
      ],
    });
    expect(parsed).toMatchObject({ name: 'The Sushi Soul', poiType: 'restaurant' });
    expect('error' in parsed).toBe(false);
    if (!('error' in parsed)) expect(parsed.attributes).toEqual([{ dimension: 'food_cuisine', value: 'sushi' }]);
  });

  it('rejects a subtype that does not belong to the selected POI type', () => {
    expect(parseManualPoiInput({
      ...validSubmission,
      poiType: 'store',
      attributes: [{ dimension: 'food_cuisine', value: 'sushi' }],
    })).toEqual({ error: 'attribute is not a supported subtype for this POI type' });
  });

  it('requires a non-empty Turnstile token and a safe retry key', () => {
    expect(parseManualPoiInput({ ...validSubmission, turnstileToken: '' }))
      .toEqual({ error: 'turnstileToken is invalid' });
    expect(parseManualPoiInput({ ...validSubmission, idempotencyKey: 'short' }))
      .toEqual({ error: 'idempotencyKey is invalid' });
  });

  it.each([
    [null, 'body must be an object'],
    [[], 'body must be an object'],
    ['not an object', 'body must be an object'],
  ])('rejects a non-object body (%p)', (body, error) => {
    expect(parseManualPoiInput(body)).toEqual({ error });
  });

  it.each([
    ['', 'name must contain text and be at most 160 characters'],
    ['---', 'name must contain text and be at most 160 characters'],
    ['x'.repeat(161), 'name must contain text and be at most 160 characters'],
  ])('rejects an empty-after-normalization or overlong name', (name, error) => {
    expect(parseManualPoiInput({ ...validSubmission, name })).toEqual({ error });
  });

  it.each([
    [{ lat: 91 }, 'lat must be a finite number between -90 and 90'],
    [{ lat: Number.NaN }, 'lat must be a finite number between -90 and 90'],
    [{ lng: 181 }, 'lng must be a finite number between -180 and 180'],
    [{ lng: Number.POSITIVE_INFINITY }, 'lng must be a finite number between -180 and 180'],
  ])('rejects invalid coordinates', (override, error) => {
    expect(parseManualPoiInput({ ...validSubmission, ...override })).toEqual({ error });
  });

  it('rejects unsupported types, too many attributes, and overlong optional text', () => {
    expect(parseManualPoiInput({ ...validSubmission, poiType: 'not-a-type' }))
      .toEqual({ error: 'poiType must be a supported POI type' });
    expect(parseManualPoiInput({
      ...validSubmission,
      attributes: Array.from({ length: 9 }, () => ({ dimension: 'food_cuisine', value: 'sushi' })),
    })).toEqual({ error: 'attributes must contain at most 8 entries' });
    expect(parseManualPoiInput({ ...validSubmission, address: 'a'.repeat(301) }))
      .toEqual({ error: 'address must be at most 300 characters' });
    expect(parseManualPoiInput({ ...validSubmission, contributorNote: 'n'.repeat(601) }))
      .toEqual({ error: 'contributorNote must be at most 600 characters' });
  });
});
