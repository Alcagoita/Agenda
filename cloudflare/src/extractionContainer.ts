import { Container } from '@cloudflare/containers';
import type { Env } from './index';

/**
 * KAN-354 — the extraction pipeline (Python + DuckDB, cloudflare/extraction/)
 * as a Cloudflare Container instead of a separate GCP service. Same
 * account, same `wrangler deploy`, no second cloud bill (see
 * cloudflare/deploy/README.md — this replaced an earlier GCP Cloud Run Job design
 * once the actual cost/complexity of running two platforms for one
 * pipeline was weighed against just using what Workers Paid already
 * includes).
 *
 * Batch job, not a web server — `run_job.py` runs to completion and exits,
 * so this class never sets `defaultPort` and the Worker always calls
 * `.start()` (fire-and-forget), never `.fetch()`/`startAndWaitForPorts()`.
 *
 * `sleepAfter` is generous (country mode can run up to ~an hour, no latency
 * target per docs/poi-coverage-model.md) — this bounds how long an
 * unexpectedly-hung process gets before Cloudflare kills the instance, not
 * a normal-case timeout.
 */
export class ExtractionContainer extends Container<Env> {
  sleepAfter = '90m';
  enableInternet = true; // must reach the Foursquare Iceberg catalog + Nominatim
}

/**
 * Lets the container's Python code reach D1 and R2 through the Worker's own
 * bindings (a plain HTTP request to a fake hostname, translated here)
 * instead of holding a separate Cloudflare API token or R2 S3 access keys —
 * see cloudflare/extraction/d1_client.py / r2_client.py. Runs inside the
 * Workers runtime, not the container sandbox — env is this Worker's own
 * env, the same REGISTRY_DB/POI_EXPORTS bindings index.ts uses.
 *
 * Assigned here, NOT as a `static outboundByHost = {...}` class field on
 * ExtractionContainer above — `outboundByHost` on the base Container class
 * is a getter/setter pair, and with this project's `target: ES2022`
 * (TypeScript defaults `useDefineForClassFields` to true at that target), a
 * static class field of the same name creates its own shadowing property
 * instead of invoking the inherited setter. The handlers silently never
 * registered: the container's request to `http://d1.internal/` fell
 * through to real DNS (which doesn't resolve) instead of being intercepted,
 * surfacing as an opaque Cloudflare 530 at the HTTP layer — confirmed live
 * via `wrangler tail` before this fix, not guessed.
 */
ExtractionContainer.outboundByHost = {
  // POST http://d1.internal/ { sql, mode? }. The ordinary pipeline writes via
  // .run(); KAN-383's OSM supplementation does a bounded identity scan with
  // mode='all'. The container is the only caller of this hostname.
  'd1.internal': async (request: Request, env: Env): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ success: false, error: 'method not allowed' }), { status: 405 });
    }
    let body: { sql?: unknown; mode?: unknown };
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'invalid JSON body' }), { status: 400 });
    }
    if (typeof body.sql !== 'string' || !body.sql.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'sql must be a non-empty string' }), { status: 400 });
    }
    if (body.mode !== undefined && body.mode !== 'all') {
      return new Response(JSON.stringify({ success: false, error: 'mode must be all when supplied' }), { status: 400 });
    }
    if (body.mode === 'all' && !/^\s*(SELECT|WITH)\b/i.test(body.sql)) {
      return new Response(JSON.stringify({ success: false, error: 'read mode accepts SELECT statements only' }), { status: 400 });
    }
    try {
      if (body.mode === 'all') {
        const result = await env.REGISTRY_DB.prepare(body.sql).all();
        return new Response(JSON.stringify({ success: true, results: result.results }), { status: 200 });
      }
      const result = await env.REGISTRY_DB.prepare(body.sql).run();
      return new Response(JSON.stringify({ success: true, meta: result.meta }), { status: 200 });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500 });
    }
  },

  // PUT/GET http://r2.internal/<percent-encoded key>. Jobs upload extracts
  // here; country recovery reads the already-uploaded source back instead of
  // asking Foursquare to download the country again.
  'r2.internal': async (request: Request, env: Env): Promise<Response> => {
    if (request.method !== 'PUT' && request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 });
    }
    let key: string;
    try {
      key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    } catch {
      return new Response('key is not validly percent-encoded', { status: 400 });
    }
    if (!key) {
      return new Response('key is required', { status: 400 });
    }
    if (request.method === 'GET') {
      const object = await env.POI_EXPORTS.get(key);
      if (!object) return new Response('not found', { status: 404 });
      return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream' } });
    }
    await env.POI_EXPORTS.put(key, request.body);
    return new Response('ok', { status: 200 });
  },
};
