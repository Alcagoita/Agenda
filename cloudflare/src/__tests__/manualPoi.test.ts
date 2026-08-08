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
});
