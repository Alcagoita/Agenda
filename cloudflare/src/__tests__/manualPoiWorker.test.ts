import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import worker, { type Env } from '../index';

interface StoredSubmission {
  submission_id: string;
  status: 'pending';
  approved_poi_id: null;
}

function submissionDb() {
  const submissions = new Map<string, StoredSubmission>();
  const prepare = (sql: string) => {
    const trimmed = sql.trim();
    let args: unknown[] = [];
    const statement = {
      bind(...nextArgs: unknown[]) {
        args = nextArgs;
        return statement;
      },
      async first() {
        if (trimmed.startsWith('SELECT submission_id, status, approved_poi_id FROM manual_poi_submission')) {
          return submissions.get(args[0] as string) ?? null;
        }
        throw new Error(`unhandled first(): ${trimmed}`);
      },
      async all() {
        if (trimmed.startsWith('SELECT fsq_place_id AS poi_id')) return { results: [] };
        if (trimmed.startsWith('SELECT poi_id, name, lat, lng FROM curated_poi')) return { results: [] };
        throw new Error(`unhandled all(): ${trimmed}`);
      },
      async run() {
        if (trimmed.startsWith('INSERT INTO manual_poi_rate_limit')) return { meta: { changes: 1 } };
        if (trimmed.startsWith('INSERT INTO manual_poi_submission')) {
          submissions.set(args[1] as string, { submission_id: args[0] as string, status: 'pending', approved_poi_id: null });
        }
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      await Promise.all(statements.map(statement => statement.run()));
    },
  } as unknown as Env['REGISTRY_DB'];
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const submission = {
  name: 'The Sushi Soul', lat: 39.546, lng: -8.974, poiType: 'restaurant',
  attributes: [{ dimension: 'food_cuisine', value: 'sushi' }],
  idempotencyKey: '4b28143c-7ea0-4c03-9152-c083fa522d8e', turnstileToken: 'fresh-token',
};

describe('POST /manual-poi/submissions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores a verified suggestion as pending and makes a lost-response retry idempotent', async () => {
    const siteverify = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, action: 'manual_poi_submit', hostname: 'brushaway.app',
    })));
    vi.stubGlobal('fetch', siteverify);
    const env = { API_KEY: 'not-used', TURNSTILE_SECRET: 'test-secret', REGISTRY_DB: submissionDb() } as unknown as Env;
    const request = () => new Request('https://poi-api.brushaway.app/manual-poi/submissions', {
      method: 'POST', headers: { Origin: 'https://brushaway.app', 'Content-Type': 'application/json' }, body: JSON.stringify(submission),
    });

    const first = await worker.fetch(request(), env, CTX);
    expect(first.status).toBe(202);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe('https://brushaway.app');
    const firstBody = await first.json() as { submissionId: string; status: string };
    expect(firstBody.status).toBe('pending');

    const retry = await worker.fetch(request(), env, CTX);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ submissionId: firstBody.submissionId, status: 'pending', idempotent: true });
    expect(siteverify).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Turnstile does not bind the token to this form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, action: 'other_form', hostname: 'brushaway.app' }))));
    const env = { API_KEY: 'not-used', TURNSTILE_SECRET: 'test-secret', REGISTRY_DB: submissionDb() } as unknown as Env;
    const response = await worker.fetch(new Request('https://poi-api.brushaway.app/manual-poi/submissions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission),
    }), env, CTX);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'verification failed; please try again' });
  });
});
