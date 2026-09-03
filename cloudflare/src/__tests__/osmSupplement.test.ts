import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import worker, { type Env } from '../index';

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe('KAN-442 OSM supplement retirement', () => {
  it('rejects attempts to start a new country-wide OSM supplement', async () => {
    const request = new Request('https://poi-api.test/internal/osm-supplement/queue', {
      method: 'POST',
      headers: { 'X-Build-Secret': 'secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode: 'PT' }),
    });
    const response = await worker.fetch(request, {
      BUILD_TRIGGER_SECRET: 'secret',
      REGISTRY_DB: {} as D1Database,
    } as Env, CTX);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: expect.stringContaining('retired'),
    }));
  });
});
