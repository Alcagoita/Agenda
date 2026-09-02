import {
  markMultibancoViewportComplete,
  MULTIBANCO_LOCATOR_URL,
  MULTIBANCO_REFRESH_INTERVAL_MS,
  MULTIBANCO_SOURCE,
  multibancoSourceId,
  multibancoViewportId,
  nextMultibancoRequestAllowedAt,
  nextUnfinishedMultibancoViewport,
  shouldRefreshMultibancoSource,
  stageMultibancoMarkers,
  validateNationalMultibancoCount,
} from '../../src/services/multibancoStaging';

const request = {
  bounds: { northEastLat: 38.718, northEastLng: -9.137, southWestLat: 38.7158, southWestLng: -9.141 },
  zoom: 18,
};

const marker = {
  name: 'MULTIBANCO',
  address: 'Inatel-Calcada Santana',
  parish: null,
  lat: '38.7176410',
  lng: '-9.1389320',
  store_type: null,
  campaign: null,
};

describe('MULTIBANCO staging', () => {
  it('keeps source provenance and suppresses duplicate records in a viewport', () => {
    const result = stageMultibancoMarkers([marker, { ...marker, campaign: 'new campaign' }], request, '2026-09-02T12:00:00.000Z');

    expect(result.duplicates).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(result.records).toEqual([expect.objectContaining({
      id: multibancoSourceId('MULTIBANCO', 'Inatel-Calcada Santana', 38.717641, -9.138932),
      source: MULTIBANCO_SOURCE,
      sourceUrl: MULTIBANCO_LOCATOR_URL,
      request,
      raw: marker,
      normalized: expect.objectContaining({ lat: 38.717641, lng: -9.138932 }),
    })]);
  });

  it('rejects malformed locator records rather than inventing identities', () => {
    const result = stageMultibancoMarkers([
      { ...marker, address: '  ' },
      { ...marker, lat: 'not-a-coordinate' },
      { ...marker, name: null },
      { ...marker, lat: null },
    ], request, '2026-09-02T12:00:00.000Z');

    expect(result.records).toEqual([]);
    expect(result.rejected.map(rejected => rejected.reason)).toEqual([
      'missing-address', 'invalid-coordinate', 'missing-name', 'invalid-coordinate',
    ]);
  });

  it('uses a deterministic viewport key and validates malformed bounds', () => {
    expect(multibancoViewportId(request.bounds, request.zoom)).toBe('18:38.71580:-9.14100:38.71800:-9.13700');
    expect(() => multibancoViewportId({ ...request.bounds, northEastLat: 38.7 }, 18)).toThrow('viewport');
  });

  it('resumes from the first incomplete viewport without duplicating a checkpoint entry', () => {
    const first = '12:one';
    const second = '12:two';
    const checkpoint = markMultibancoViewportComplete({
      source: MULTIBANCO_SOURCE,
      runId: 'run-1',
      completedViewportIds: [],
      lastSuccessfulAt: null,
    }, first, '2026-09-02T12:00:00.000Z');

    expect(nextUnfinishedMultibancoViewport([first, second], checkpoint)).toBe(second);
    expect(markMultibancoViewportComplete(checkpoint, first, '2026-09-02T12:01:00.000Z').completedViewportIds).toEqual([first]);
  });

  it('paces requests and refreshes only after the scheduled interval', () => {
    expect(nextMultibancoRequestAllowedAt(null)).toBe(0);
    expect(nextMultibancoRequestAllowedAt(10_000)).toBe(10_750);
    expect(shouldRefreshMultibancoSource(10_000, 10_000 + MULTIBANCO_REFRESH_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRefreshMultibancoSource(10_000, 10_000 + MULTIBANCO_REFRESH_INTERVAL_MS)).toBe(true);
  });

  it('flags a national count outside the broad review range', () => {
    expect(validateNationalMultibancoCount(13_700)).toEqual(expect.objectContaining({ withinExpectedRange: true }));
    expect(validateNationalMultibancoCount(5_000)).toEqual(expect.objectContaining({ withinExpectedRange: false }));
  });
});
