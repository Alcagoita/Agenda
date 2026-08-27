import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import worker, { type Env } from '../index';

const LISBON = { lat: 38.7223, lng: -9.1393 };

interface PoiRow {
  id: string;
  name: string;
  dedupe_name: string;
  lat: number;
  lng: number;
  primary_poi_type: string;
  address: string | null;
  date_refreshed?: string;
  status?: 'active' | 'removed';
  removed_at?: string | null;
  removed_by?: string | null;
  removal_reason?: string | null;
}

interface Tables {
  poi: PoiRow[];
  osm_poi: PoiRow[];
  curated_poi: PoiRow[];
  poi_type: Array<{ fsq_place_id: string; poi_type: string }>;
  poi_attribute: Array<{ fsq_place_id: string; dimension: string; value: string }>;
  poi_suppression: Array<{
    source: string;
    source_id: string;
    reason: string;
    name: string;
    suppressed_at?: string;
    suppressed_by?: string;
  }>;
  removals: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
}

function emptyTables(): Tables {
  return { poi: [], osm_poi: [], curated_poi: [], poi_type: [], poi_attribute: [], poi_suppression: [], removals: [], audit: [] };
}

/** Matches a `dedupe_name LIKE 'term%'` bind against the fake rows. */
function likePrefix(rows: PoiRow[], pattern: string): PoiRow[] {
  const prefix = pattern.replace(/%$/, '');
  return rows.filter(row => row.dedupe_name.startsWith(prefix));
}

function project(rows: PoiRow[]) {
  return rows.map(row => ({
    poi_id: row.id, name: row.name, lat: row.lat, lng: row.lng,
    primary_poi_type: row.primary_poi_type, address: row.address,
  }));
}

function fakeDb(tables: Tables): Env['REGISTRY_DB'] {
  const prepare = (sql: string) => {
    const trimmed = sql.trim().replace(/\s+/g, ' ');
    let args: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) { args = next; return statement; },

      async first() {
        if (trimmed.startsWith('SELECT submission_id, status FROM poi_removal_submission WHERE idempotency_key')) {
          return tables.removals.find(row => row.idempotency_key === args[0]) ?? null;
        }
        if (trimmed.startsWith('SELECT submission_id FROM poi_removal_submission WHERE target_source')) {
          return tables.removals.find(row => row.target_source === args[0] && row.target_id === args[1] && row.status === 'pending') ?? null;
        }
        if (trimmed.startsWith('SELECT * FROM poi_removal_submission WHERE submission_id')) {
          return tables.removals.find(row => row.submission_id === args[0]) ?? null;
        }
        if (trimmed.startsWith('SELECT name, primary_poi_type, address FROM poi WHERE')) {
          return tables.poi.find(row => row.id === args[0]) ?? null;
        }
        if (trimmed.startsWith('SELECT name, primary_poi_type, address FROM osm_poi WHERE')) {
          return tables.osm_poi.find(row => row.id === args[0]) ?? null;
        }
        if (trimmed.startsWith('SELECT name, primary_poi_type, address FROM curated_poi WHERE')) {
          return tables.curated_poi.find(row => row.id === args[0] && row.status === 'active') ?? null;
        }
        if (trimmed.startsWith('SELECT date_refreshed FROM poi WHERE')) {
          const row = tables.poi.find(entry => entry.id === args[0]);
          return row ? { date_refreshed: row.date_refreshed ?? null } : null;
        }
        throw new Error(`unhandled first(): ${trimmed}`);
      },

      async all() {
        const suppressed = (source: string, id: string) =>
          tables.poi_suppression.some(row => row.source === source && row.source_id === id);
        if (trimmed.startsWith('SELECT fsq_place_id AS poi_id')) {
          return { results: project(likePrefix(tables.poi, args[0] as string).filter(row => !suppressed('foursquare', row.id))) };
        }
        if (trimmed.startsWith('SELECT osm_element_id AS poi_id')) {
          return { results: project(likePrefix(tables.osm_poi, args[0] as string).filter(row => !suppressed('openstreetmap', row.id))) };
        }
        if (trimmed.startsWith('SELECT poi_id, name, lat, lng, primary_poi_type, address FROM curated_poi')) {
          return { results: project(likePrefix(tables.curated_poi, args[0] as string).filter(row => row.status === 'active' && !suppressed('community', row.id))) };
        }
        if (trimmed.startsWith('SELECT submission_id, target_source, target_id')) {
          return { results: tables.removals.filter(row => row.status === args[0]) };
        }
        if (trimmed.startsWith('SELECT fsq_place_id, date_refreshed FROM poi WHERE fsq_place_id IN')) {
          return {
            results: tables.poi
              .filter(row => (args as string[]).includes(row.id))
              .map(row => ({ fsq_place_id: row.id, date_refreshed: row.date_refreshed ?? null })),
          };
        }
        throw new Error(`unhandled all(): ${trimmed}`);
      },

      async run() {
        if (trimmed.startsWith('DELETE FROM manual_poi_rate_limit')) return { meta: { changes: 0 } };
        if (trimmed.startsWith('INSERT INTO manual_poi_rate_limit')) return { meta: { changes: 1 } };
        if (trimmed.startsWith('INSERT INTO poi_removal_submission')) {
          const [submission_id, idempotency_key, target_source, target_id, target_name, target_poi_type, target_address, reason, contributor_note] = args;
          if (tables.removals.some(row => row.target_source === target_source && row.target_id === target_id && row.status === 'pending')) {
            throw new Error('UNIQUE constraint failed: idx_poi_removal_submission_pending_target');
          }
          tables.removals.push({
            submission_id, idempotency_key, target_source, target_id, target_name, target_poi_type,
            target_address, reason, contributor_note, status: 'pending', submitted_at: '2026-08-27T00:00:00.000Z',
            reviewed_at: null, reviewed_by: null, rejection_reason: null,
          });
        }
        if (trimmed.startsWith('INSERT INTO manual_poi_audit')) {
          tables.audit.push({ target_kind: args[1], target_id: args[2], action: args[3], actor: args[4] });
        }
        if (trimmed.startsWith('INSERT INTO poi_suppression')) {
          tables.poi_suppression.push({
            source: args[0] as string, source_id: args[1] as string, reason: args[2] as string,
            name: args[4] as string, suppressed_at: args[5] as string, suppressed_by: args[6] as string,
          });
        }
        if (trimmed.startsWith('UPDATE poi_removal_submission')) {
          // Reject binds (reviewedAt, reviewer, reason, submissionId); approve
          // has no reason and binds (reviewedAt, reviewer, submissionId).
          const rejecting = trimmed.includes("'rejected'");
          const submissionId = rejecting ? args[3] : args[2];
          const row = tables.removals.find(entry => entry.submission_id === submissionId && entry.status === 'pending');
          if (row) {
            row.status = rejecting ? 'rejected' : 'approved';
            row.reviewed_by = args[1];
            if (rejecting) row.rejection_reason = args[2];
          }
        }
        const isSuppressed = (source: string, id: string) => tables.poi_suppression.some(row => row.source === source && row.source_id === id);
        if (trimmed.startsWith('DELETE FROM poi_type WHERE fsq_place_id IN')) {
          tables.poi_type = tables.poi_type.filter(row => !isSuppressed('foursquare', row.fsq_place_id));
        }
        if (trimmed.startsWith('DELETE FROM poi_attribute WHERE fsq_place_id IN')) {
          tables.poi_attribute = tables.poi_attribute.filter(row => !isSuppressed('foursquare', row.fsq_place_id));
        }
        if (trimmed.startsWith('DELETE FROM poi WHERE fsq_place_id IN')) {
          tables.poi = tables.poi.filter(row => !isSuppressed('foursquare', row.id));
        }
        if (trimmed.startsWith('DELETE FROM osm_poi WHERE osm_element_id IN')) {
          tables.osm_poi = tables.osm_poi.filter(row => !isSuppressed('openstreetmap', row.id));
        }
        if (trimmed.startsWith('UPDATE curated_poi SET status = \'removed\'')) {
          for (const row of tables.curated_poi) {
            const tombstone = tables.poi_suppression.find(
              entry => entry.source === 'community' && entry.source_id === row.id,
            );
            if (row.status === 'active' && tombstone) {
              row.status = 'removed';
              // The correlated subqueries in the real statement copy these
              // across from the tombstone.
              row.removed_at = tombstone.suppressed_at ?? null;
              row.removed_by = tombstone.suppressed_by ?? null;
              row.removal_reason = tombstone.reason;
            }
          }
        }
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  };

  return {
    prepare,
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  } as unknown as Env['REGISTRY_DB'];
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function poi(overrides: Partial<PoiRow> & { id: string; name: string; dedupe_name: string }): PoiRow {
  return {
    lat: LISBON.lat, lng: LISBON.lng, primary_poi_type: 'store', address: null,
    date_refreshed: '2026-08-01T00:00:00.000Z', ...overrides,
  };
}

function publicEnv(tables: Tables): Env {
  return { API_KEY: 'not-used', TURNSTILE_SECRET: 'test-secret', REGISTRY_DB: fakeDb(tables) } as unknown as Env;
}

function reviewerEnv(tables: Tables): Env {
  return {
    API_KEY: 'not-used',
    ACCESS_TEAM_DOMAIN: 'brushaway.cloudflareaccess.com',
    ACCESS_REVIEW_AUD: 'review-audience',
    MANUAL_POI_ADMIN_EMAILS: 'reviewer@brushaway.app',
    REGISTRY_DB: fakeDb(tables),
  } as unknown as Env;
}

const searchUrl = (name: string) =>
  `https://poi-api.brushaway.app/manual-poi/search?name=${encodeURIComponent(name)}&lat=${LISBON.lat}&lng=${LISBON.lng}`;

describe('GET /manual-poi/search', () => {
  it('returns what we hold across all three sources, nearest first', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central', address: 'Rua A' }));
    tables.osm_poi.push(poi({ id: 'osm-1', name: 'Padaria Central Norte', dedupe_name: 'padaria central norte', lat: 38.7300, lng: -9.1393 }));
    tables.curated_poi.push(poi({ id: 'community:1', name: 'Padaria Central Sul', dedupe_name: 'padaria central sul', lat: 38.7250, lng: -9.1393, status: 'active' }));

    const response = await worker.fetch(new Request(searchUrl('Padaria Central'), {
      headers: { Origin: 'https://brushaway.app' },
    }), publicEnv(tables), CTX);

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://brushaway.app');
    const body = await response.json() as { matches: Array<{ source: string; id: string; distanceMeters: number }> };
    expect(body.matches.map(match => match.source)).toEqual(['foursquare', 'community', 'openstreetmap']);
    expect(body.matches[0]).toMatchObject({ id: 'fsq-1', distanceMeters: 0 });
    expect(body.matches[1].distanceMeters).toBeLessThan(body.matches[2].distanceMeters);
  });

  it('answers a place we do not hold with an empty list, not an error', async () => {
    const response = await worker.fetch(new Request(searchUrl('Nowhere Bakery')), publicEnv(emptyTables()), CTX);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ matches: [] });
  });

  it('leaves out records that are already suppressed', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central' }));
    tables.poi_suppression.push({ source: 'foursquare', source_id: 'fsq-1', reason: 'closed', name: 'Padaria Central' });

    const response = await worker.fetch(new Request(searchUrl('Padaria')), publicEnv(tables), CTX);
    await expect(response.json()).resolves.toEqual({ matches: [] });
  });

  it('drops a same-named record in another city', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-far', name: 'Padaria Central', dedupe_name: 'padaria central', lat: 41.1579, lng: -8.6291 }));

    const response = await worker.fetch(new Request(searchUrl('Padaria')), publicEnv(tables), CTX);
    await expect(response.json()).resolves.toEqual({ matches: [] });
  });

  it('requires a term long enough not to be a bulk listing', async () => {
    const response = await worker.fetch(new Request(searchUrl('pa')), publicEnv(emptyTables()), CTX);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'name must be at least 3 characters' });
  });
});

describe('POST /manual-poi/removals', () => {
  const removal = {
    targetSource: 'foursquare', targetId: 'fsq-1', reason: 'closed',
    idempotencyKey: '4b28143c-7ea0-4c03-9152-c083fa522d8e', turnstileToken: 'fresh-token',
  };
  // Every test here stubs global fetch. Without this the stub leaks into the
  // next test, which would then verify a Turnstile token or an Access
  // assertion against whatever the previous test happened to return.
  afterEach(() => vi.unstubAllGlobals());

  const request = (body: unknown = removal) => new Request('https://poi-api.brushaway.app/manual-poi/removals', {
    method: 'POST',
    headers: { Origin: 'https://brushaway.app', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  function verifiedTurnstile() {
    // A Response body reads once, so each call needs its own — sharing one
    // makes the second verify throw and fail closed, which looks exactly
    // like a rejected token.
    const siteverify = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      success: true, action: 'manual_poi_submit', hostname: 'brushaway.app',
    }))));
    vi.stubGlobal('fetch', siteverify);
    return siteverify;
  }

  it('stages a report as pending and never suppresses anything itself', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central', address: 'Rua A' }));
    verifiedTurnstile();
    const env = publicEnv(tables);

    const response = await worker.fetch(request(), env, CTX);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: 'pending' });
    expect(tables.removals).toHaveLength(1);
    // The snapshot is our data, not what the browser posted.
    expect(tables.removals[0]).toMatchObject({ target_name: 'Padaria Central', target_poi_type: 'store', target_address: 'Rua A' });
    expect(tables.poi_suppression).toHaveLength(0);
    expect(tables.poi).toHaveLength(1);
    expect(tables.audit).toContainEqual(expect.objectContaining({ target_kind: 'removal', action: 'submitted', actor: 'public' }));
  });

  it('makes a lost-response retry idempotent without spending a second token', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central' }));
    const siteverify = verifiedTurnstile();
    const env = publicEnv(tables);

    const first = await worker.fetch(request(), env, CTX);
    const firstBody = await first.json() as { submissionId: string };
    const retry = await worker.fetch(request(), env, CTX);

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ submissionId: firstBody.submissionId, status: 'pending', idempotent: true });
    expect(siteverify).toHaveBeenCalledTimes(1);
    expect(tables.removals).toHaveLength(1);
  });

  it('refuses a target we do not hold', async () => {
    verifiedTurnstile();
    const response = await worker.fetch(request(), publicEnv(emptyTables()), CTX);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'that place is not one I know' });
  });

  it('folds a second report of the same record into the one already waiting', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central' }));
    verifiedTurnstile();
    const env = publicEnv(tables);

    await worker.fetch(request(), env, CTX);
    const second = await worker.fetch(request({ ...removal, idempotencyKey: 'a-different-key-000000' }), env, CTX);

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ status: 'pending', alreadyReported: true });
    expect(tables.removals).toHaveLength(1);
  });

  it('fails closed when Turnstile does not bind the token to this form', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, action: 'other_form', hostname: 'brushaway.app' }))));

    const response = await worker.fetch(request(), publicEnv(tables), CTX);
    expect(response.status).toBe(400);
    expect(tables.removals).toHaveLength(0);
  });
});

describe('suppression sweep on /internal/build-complete', () => {
  function buildCompleteEnv(tables: Tables): Env {
    return {
      API_KEY: 'not-used',
      BUILD_TRIGGER_SECRET: 'build-secret',
      REGISTRY_DB: fakeDb(tables),
    } as unknown as Env;
  }

  const buildComplete = () => new Request('https://poi-api.brushaway.app/internal/build-complete', {
    method: 'POST',
    headers: { 'X-Build-Secret': 'build-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ cityId: 'lisboa', buildId: 'build-1' }),
  });

  it('takes a suppressed POI, and its child rows, back out after a load resurrects it', async () => {
    const tables = emptyTables();
    // The state right after a load: the loader's ON CONFLICT DO UPDATE has
    // put the removed record straight back.
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central' }));
    tables.poi_type.push({ fsq_place_id: 'fsq-1', poi_type: 'bakery' });
    tables.poi_attribute.push({ fsq_place_id: 'fsq-1', dimension: 'store_kind', value: 'books' });
    tables.poi_suppression.push({ source: 'foursquare', source_id: 'fsq-1', reason: 'closed', name: 'Padaria Central' });

    const response = await worker.fetch(buildComplete(), buildCompleteEnv(tables), CTX);

    expect(response.status).toBe(200);
    expect(tables.poi).toHaveLength(0);
    expect(tables.poi_type).toHaveLength(0);
    expect(tables.poi_attribute).toHaveLength(0);
  });

  it('leaves everything that is not suppressed alone', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-keep', name: 'Padaria Nova', dedupe_name: 'padaria nova' }));
    tables.poi_type.push({ fsq_place_id: 'fsq-keep', poi_type: 'bakery' });

    await worker.fetch(buildComplete(), buildCompleteEnv(tables), CTX);

    expect(tables.poi).toHaveLength(1);
    expect(tables.poi_type).toHaveLength(1);
  });

  it('marks a suppressed community record removed rather than deleting its row', async () => {
    const tables = emptyTables();
    tables.curated_poi.push(poi({ id: 'community:1', name: 'Padaria Central', dedupe_name: 'padaria central', status: 'active' }));
    tables.poi_suppression.push({ source: 'community', source_id: 'community:1', reason: 'closed', name: 'Padaria Central' });

    await worker.fetch(buildComplete(), buildCompleteEnv(tables), CTX);

    // The row is the audit trail for a community contribution — it stays.
    expect(tables.curated_poi).toHaveLength(1);
    expect(tables.curated_poi[0].status).toBe('removed');
  });

  it('drops a suppressed OpenStreetMap record', async () => {
    const tables = emptyTables();
    tables.osm_poi.push(poi({ id: 'node/42', name: 'Padaria Central', dedupe_name: 'padaria central' }));
    tables.poi_suppression.push({ source: 'openstreetmap', source_id: 'node/42', reason: 'never_existed', name: 'Padaria Central' });

    await worker.fetch(buildComplete(), buildCompleteEnv(tables), CTX);

    expect(tables.osm_poi).toHaveLength(0);
  });
});

/**
 * A real RS256 Access assertion plus the JWKS the Worker will fetch to verify
 * it. verifyManualPoiAdmin checks the signature rather than trusting a header,
 * so exercising the approve path at all means signing a genuine token.
 *
 * One key pair for the whole file: the Worker caches JWKS for five minutes in
 * module scope, so a second key would be verified against the first one's
 * cached copy.
 */
const accessKeys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
) as CryptoKeyPair;
const ACCESS_KID = 'test-key';

function base64url(bytes: ArrayBuffer | string): string {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  return buffer.toString('base64url');
}

async function accessAssertion(email = 'reviewer@brushaway.app'): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const signingInput = [
    base64url(JSON.stringify({ alg: 'RS256', kid: ACCESS_KID })),
    base64url(JSON.stringify({ aud: ['review-audience'], email, exp: now + 600, nbf: now - 10 })),
  ].join('.');
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    accessKeys.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(signature)}`;
}

async function stubAccessJwks() {
  const jwk = await crypto.subtle.exportKey('jwk', accessKeys.publicKey);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify({ keys: [{ ...jwk, kid: ACCESS_KID, kty: 'RSA', alg: 'RS256' }] })),
  )));
}

describe('reviewer removal routes, authenticated', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function pendingRemoval(tables: Tables, overrides: Partial<Record<string, unknown>> = {}) {
    tables.removals.push({
      submission_id: 'removal-1', idempotency_key: 'key-1', target_source: 'foursquare',
      target_id: 'fsq-1', target_name: 'Padaria Central', target_poi_type: 'bakery',
      target_address: 'Rua A', reason: 'closed', contributor_note: 'shut last winter',
      status: 'pending', submitted_at: '2026-08-27T00:00:00.000Z',
      reviewed_at: null, reviewed_by: null, rejection_reason: null, ...overrides,
    });
  }

  it('approving writes the tombstone, sweeps the record and its children, and audits it', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central' }));
    tables.poi_type.push({ fsq_place_id: 'fsq-1', poi_type: 'bakery' });
    tables.poi_attribute.push({ fsq_place_id: 'fsq-1', dimension: 'store_kind', value: 'books' });
    await pendingRemoval(tables);
    await stubAccessJwks();

    const response = await worker.fetch(new Request('https://brushaway.app/manual-poi/review/api/removals/removal-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': await accessAssertion() },
      body: JSON.stringify({ action: 'approve' }),
    }), reviewerEnv(tables), CTX);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      submissionId: 'removal-1', status: 'approved',
      suppressed: { source: 'foursquare', id: 'fsq-1' },
    });

    expect(tables.poi_suppression).toEqual([expect.objectContaining({
      source: 'foursquare', source_id: 'fsq-1', reason: 'closed',
      name: 'Padaria Central', suppressed_by: 'reviewer@brushaway.app',
    })]);
    expect(tables.removals[0].status).toBe('approved');
    expect(tables.removals[0].reviewed_by).toBe('reviewer@brushaway.app');
    // The sweep runs on approval, not only at the next build.
    expect(tables.poi).toHaveLength(0);
    expect(tables.poi_type).toHaveLength(0);
    expect(tables.poi_attribute).toHaveLength(0);
    expect(tables.audit).toContainEqual(expect.objectContaining({
      target_kind: 'removal', target_id: 'removal-1', action: 'approved', actor: 'reviewer@brushaway.app',
    }));
  });

  it('approving a community record marks it removed and records who and why', async () => {
    const tables = emptyTables();
    tables.curated_poi.push(poi({
      id: 'community:1', name: 'Padaria Central', dedupe_name: 'padaria central', status: 'active',
    }));
    await pendingRemoval(tables, { target_source: 'community', target_id: 'community:1', reason: 'duplicate' });
    await stubAccessJwks();

    await worker.fetch(new Request('https://brushaway.app/manual-poi/review/api/removals/removal-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': await accessAssertion() },
      body: JSON.stringify({ action: 'approve' }),
    }), reviewerEnv(tables), CTX);

    // The row survives — it is the audit trail for a community contribution.
    expect(tables.curated_poi).toHaveLength(1);
    expect(tables.curated_poi[0]).toMatchObject({
      status: 'removed', removed_by: 'reviewer@brushaway.app', removal_reason: 'duplicate',
    });
    expect(tables.curated_poi[0].removed_at).toBeTruthy();
  });

  it('rejecting leaves the record in place and suppresses nothing', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({ id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central' }));
    await pendingRemoval(tables);
    await stubAccessJwks();

    const response = await worker.fetch(new Request('https://brushaway.app/manual-poi/review/api/removals/removal-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': await accessAssertion() },
      body: JSON.stringify({ action: 'reject', reason: 'still open, I walked past it' }),
    }), reviewerEnv(tables), CTX);

    expect(response.status).toBe(200);
    expect(tables.poi_suppression).toHaveLength(0);
    expect(tables.poi).toHaveLength(1);
    expect(tables.removals[0].status).toBe('rejected');
  });

  it('refuses to review the same removal twice', async () => {
    const tables = emptyTables();
    await pendingRemoval(tables, { status: 'approved' });
    await stubAccessJwks();

    const response = await worker.fetch(new Request('https://brushaway.app/manual-poi/review/api/removals/removal-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': await accessAssertion() },
      body: JSON.stringify({ action: 'approve' }),
    }), reviewerEnv(tables), CTX);

    expect(response.status).toBe(409);
    expect(tables.poi_suppression).toHaveLength(0);
  });

  it('reports staleness so a bad record can be told from a stale build', async () => {
    const tables = emptyTables();
    tables.poi.push(poi({
      id: 'fsq-1', name: 'Padaria Central', dedupe_name: 'padaria central',
      date_refreshed: '2026-08-20T00:00:00.000Z',
    }));
    await pendingRemoval(tables);
    // A second report whose target is already gone from the registry.
    await pendingRemoval(tables, { submission_id: 'removal-2', idempotency_key: 'key-2', target_id: 'fsq-vanished' });
    await stubAccessJwks();

    const response = await worker.fetch(new Request('https://brushaway.app/manual-poi/review/api/removals?status=pending', {
      headers: { 'Cf-Access-Jwt-Assertion': await accessAssertion() },
    }), reviewerEnv(tables), CTX);

    expect(response.status).toBe(200);
    const body = await response.json() as { removals: Array<{ target: { dateRefreshed: string | null; stillPresent: boolean | null } }> };
    expect(body.removals[0].target).toMatchObject({
      dateRefreshed: '2026-08-20T00:00:00.000Z', stillPresent: true,
    });
    expect(body.removals[1].target).toMatchObject({ dateRefreshed: null, stillPresent: false });
  });

  it('denies a signed assertion from an email outside the allowlist', async () => {
    const tables = emptyTables();
    await pendingRemoval(tables);
    await stubAccessJwks();

    const response = await worker.fetch(new Request('https://brushaway.app/manual-poi/review/api/removals/removal-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': await accessAssertion('outsider@example.com') },
      body: JSON.stringify({ action: 'approve' }),
    }), reviewerEnv(tables), CTX);

    expect(response.status).toBe(403);
    expect(tables.poi_suppression).toHaveLength(0);
  });
});

describe('reviewer removal routes', () => {
  it('denies both routes without an Access assertion', async () => {
    const env = reviewerEnv(emptyTables());
    const requests = [
      new Request('https://brushaway.app/manual-poi/review/api/removals'),
      new Request('https://brushaway.app/manual-poi/review/api/removals/removal-1', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
      }),
    ];
    for (const request of requests) {
      const response = await worker.fetch(request, env, CTX);
      // A 401 here would mean the alias missed and fell into the normal API.
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
    }
  });
});
