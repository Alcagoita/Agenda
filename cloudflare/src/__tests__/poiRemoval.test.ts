import { describe, expect, it } from 'vitest';

import { isPoiRemovalInput, parsePoiRemovalInput } from '../poiRemoval';

const valid = {
  targetSource: 'foursquare',
  targetId: '5172f417e4b09098be765a21',
  reason: 'closed',
  idempotencyKey: '4b28143c-7ea0-4c03-9152-c083fa522d8e',
  turnstileToken: 'fresh-token',
};

describe('parsePoiRemovalInput', () => {
  it('accepts a proposal that names one record and a reason', () => {
    const parsed = parsePoiRemovalInput({ ...valid, contributorNote: '  shut last winter  ' });
    expect(isPoiRemovalInput(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      targetSource: 'foursquare',
      targetId: '5172f417e4b09098be765a21',
      reason: 'closed',
      contributorNote: 'shut last winter',
    });
  });

  it('defaults an absent note to null rather than an empty string', () => {
    const parsed = parsePoiRemovalInput(valid);
    expect(isPoiRemovalInput(parsed) && parsed.contributorNote).toBeNull();
  });

  it('treats a whitespace-only note as no note at all', () => {
    // '' would reach the column as an empty string and make the reviewer UI
    // render a blank "Contributor note" block.
    const parsed = parsePoiRemovalInput({ ...valid, contributorNote: '   \n\t ' });
    expect(isPoiRemovalInput(parsed) && parsed.contributorNote).toBeNull();
  });

  it.each([
    ['google', 'targetSource must be foursquare, openstreetmap, or community'],
  ])('rejects %s as a source', (targetSource, error) => {
    expect(parsePoiRemovalInput({ ...valid, targetSource })).toEqual({ error });
  });

  it('rejects a reason outside the removal vocabulary', () => {
    // wrong_type is a correction, not a removal — accepting it here would let
    // a reviewer delete a record the contributor only wanted retyped.
    expect(parsePoiRemovalInput({ ...valid, reason: 'wrong_type' }))
      .toEqual({ error: 'reason must be closed, never_existed, or duplicate' });
  });

  it('rejects a blank or oversized target id', () => {
    expect(parsePoiRemovalInput({ ...valid, targetId: '   ' }))
      .toEqual({ error: 'targetId must contain text and be at most 200 characters' });
    expect(parsePoiRemovalInput({ ...valid, targetId: 'x'.repeat(201) }))
      .toEqual({ error: 'targetId must contain text and be at most 200 characters' });
  });

  it('rejects a note longer than the stored column allows', () => {
    expect(parsePoiRemovalInput({ ...valid, contributorNote: 'x'.repeat(601) }))
      .toEqual({ error: 'contributorNote must be at most 600 characters' });
  });

  it('rejects a malformed idempotency key and a missing Turnstile token', () => {
    expect(parsePoiRemovalInput({ ...valid, idempotencyKey: 'short' })).toEqual({ error: 'idempotencyKey is invalid' });
    expect(parsePoiRemovalInput({ ...valid, turnstileToken: '' })).toEqual({ error: 'turnstileToken is invalid' });
  });

  it('rejects a body that is not an object', () => {
    expect(parsePoiRemovalInput(['nope'])).toEqual({ error: 'body must be an object' });
    expect(parsePoiRemovalInput(null)).toEqual({ error: 'body must be an object' });
  });
});
