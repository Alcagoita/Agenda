import { describe, expect, it, vi } from 'vitest';

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
}

interface Tables {
  poi: PoiRow[];
  osm_poi: PoiRow[];
  curated_poi: PoiRow[];
  poi_type: Array<{ fsq_place_id: string; poi_type: string }>;
  poi_attribute: Array<{ fsq_place_id: string; dimension: string; value: string }>;
  poi_suppression: Array<{ source: string; source_id: string; reason: string; name: string }>;
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
          tables.poi_suppression.push({ source: args[0] as string, source_id: args[1] as string, reason: args[2] as string, name: args[4] as string });
        }
        if (trimmed.startsWith('UPDATE poi_removal_submission')) {
          const row = tables.removals.find(entry => entry.submission_id === args[2] && entry.status === 'pending');
          if (row) { row.status = trimmed.includes("'rejected'") ? 'rejected' : 'approved'; row.reviewed_by = args[1]; }
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
            if (row.status === 'active' && isSuppressed('community', row.id)) row.status = 'removed';
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
