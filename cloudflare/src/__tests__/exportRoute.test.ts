import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import worker, { type Env } from '../index';

const API_KEY = 'test-api-key';
const READY_PLACE = {
  place_id: 'place-1', status: 'mapped', build_id: 'build-1',
};

function makeEnv(r2Object: { body: ReadableStream<Uint8Array> } | null): Env {
  const first = vi.fn().mockResolvedValue(READY_PLACE);
  const get = vi.fn().mockResolvedValue(r2Object);
  return {
    API_KEY,
    REGISTRY_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) } as unknown as Env['REGISTRY_DB'],
    POI_EXPORTS: { get } as unknown as Env['POI_EXPORTS'],
    EXTRACTION_CONTAINER: {} as Env['EXTRACTION_CONTAINER'],
  };
}

function exportRequest(path = '/export/place-1'): Request {
  return new Request(`https://poi-api.brushaway.app${path}`, { headers: { 'X-Api-Key': API_KEY } });
}

function binaryObject(bytes: Uint8Array): { body: ReadableStream<Uint8Array> } {
  return {
    body: new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }),
  };
}

describe('GET /export/:placeId', () => {
  it('streams the ready D1 build from R2 with the binary response headers', async () => {
    const bytes = new Uint8Array([83, 81, 76, 105, 116, 101]);
    const env = makeEnv(binaryObject(bytes));

    const response = await worker.fetch(exportRequest(), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="place-1-build-1.sqlite"');
    expect(response.headers.get('X-Build-Id')).toBe('build-1');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(env.REGISTRY_DB.prepare).toHaveBeenCalledWith('SELECT * FROM place WHERE place_id = ?');
    expect(env.POI_EXPORTS.get).toHaveBeenCalledWith('exports/place-1/build-1.sqlite');
  });

  it('returns a 400 JSON error for malformed percent encoding', async () => {
    const response = await worker.fetch(exportRequest('/export/%ZZ'), makeEnv(null));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'placeId is not validly percent-encoded' });
  });

  it('returns a 404 JSON error when the ready R2 export object is absent', async () => {
    const response = await worker.fetch(exportRequest(), makeEnv(null));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "export not found for place 'place-1' build 'build-1'" });
  });
});
