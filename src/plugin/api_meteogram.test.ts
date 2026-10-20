/**
 * GET /api/routes/:id/meteogram says whether its rows are complete: false when
 * the forecast, a regional run, the currents or the tides changed while they
 * were read (the answer is not kept, and the web app says so).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerApi, type ApiDeps } from './api';

type Handler = (req: unknown, res: unknown) => unknown;

const T0 = Date.UTC(2026, 10, 2, 0);
const H = 3600_000;
const point = (lon: number, h: number) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, 38] },
  properties: { time: new Date(T0 + h * H).toISOString(), mode: 'sailing', sog_ms: 3 },
});
const JOB = { id: 'j1', status: 'done', geojson: { type: 'FeatureCollection', features: [point(-9, 0), point(-10, 2)] }, summary: {} };

/** The endpoint, with the tile service's track query answered `complete`. */
async function meteogram(complete: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (p: string | string[], h: Handler) => {
    for (const x of Array.isArray(p) ? p : [p]) routes.set(`${m} ${x}`, h);
  };
  const answer = (a: { points: unknown[] }) => ({
    cycle: '2026-11-01T12:00:00.000Z',
    validTo: '2026-11-11T12:00:00.000Z',
    regional: [],
    regionalMissing: [],
    rows: a.points.map(() => ({ wind_ms: 5, wind_dir_deg: 270, wind_source: 'ECMWF' })),
  });
  // As TileService: point() the answer alone, pointWithStatus() with its status.
  const service = {
    point: async (_kind: string, a: { points: unknown[] }) => answer(a),
    pointWithStatus: async (_kind: string, a: { points: unknown[] }) => ({ result: answer(a), complete }),
  };
  registerApi(
    { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') } as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: '/nonexistent',
      jobs: { get: (id: string) => (id === 'j1' ? JOB : undefined) },
      tiles: () => service,
      notReady: () => 'starting',
    } as unknown as ApiDeps
  );
  const out = { status: 200, body: {} as Record<string, unknown> };
  const res = {
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: Record<string, unknown>) {
      out.body = b;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
    on() {
      return res;
    },
    headersSent: false,
    destroyed: false,
  };
  await routes.get('GET /api/routes/:id/meteogram')!({ query: {}, params: { id: 'j1' }, headers: {}, on() {} }, res);
  return out;
}

test('GET /api/routes/:id/meteogram: complete says whether the rows were read on unchanged data', async () => {
  const done = await meteogram(true);
  assert.equal(done.status, 200);
  assert.equal(done.body.complete, true);
  assert.equal((done.body.rows as unknown[]).length, 3, 'hours 0, 1 and 2');
  const changed = await meteogram(false);
  assert.equal(changed.status, 200, 'still answered');
  assert.equal(changed.body.complete, false);
  assert.equal((changed.body.rows as unknown[]).length, 3);
});
