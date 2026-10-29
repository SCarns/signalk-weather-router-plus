/**
 * While the first forecast loads, map and point requests are answered at
 * once (503, the loading progress, Retry-After) instead of queueing behind
 * the decode until the query timeout; the coastline does not wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerApi, type ApiDeps } from './api';

type Handler = (req: unknown, res: unknown) => unknown;
interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function api(
  wait: (() => { error: string; loading: unknown } | null) | undefined
): (route: string, req: Record<string, unknown>) => Promise<Answer> {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (p: string | string[], h: Handler) => {
    for (const x of Array.isArray(p) ? p : [p]) routes.set(`${m} ${x}`, h);
  };
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  // A tile service that answers every tile from "disk" at once.
  const service = { get: async () => ({ gz: Buffer.from([]), cached: true }) };
  registerApi(
    router as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: '/nonexistent',
      tiles: () => service,
      notReady: () => 'starting',
      noteTileRequest: () => {},
      forecastWait: wait,
    } as unknown as ApiDeps
  );
  return async (route, req) => {
    const h = routes.get(`GET ${route}`)!;
    const out: Answer = { status: 200, body: {}, headers: {} };
    const res = {
      status(c: number) {
        out.status = c;
        return res;
      },
      json(b: Record<string, unknown>) {
        out.body = b;
        return res;
      },
      setHeader(k: string, v: string) {
        out.headers[k] = v;
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
      writableFinished: true,
    };
    await h({ query: {}, ...req }, res);
    return out;
  };
}

const LOADING = { phase: 'decoding', why: 'redecode', cycle: '2026-10-04T06:00:00.000Z', done: 12, total: 37 };

test('while the forecast loads: tiles, fields and conditions answer 503 at once with the progress and Retry-After', async () => {
  const call = api(() => ({ error: 'loading the forecast: decoding the 06Z cycle, step 12 of 37', loading: LOADING }));
  for (const [route, req] of [
    ['/api/tile/:layer/:z/:x/:y', { params: { layer: 'seas', z: '6', x: '3', y: '37' } }],
    ['/api/tile/:layer/:z/:x/:y.png', { params: { layer: 'wind', z: '6', x: '3', y: '37' } }],
    ['/api/field', { query: { layer: 'wind', bbox: '-10,-10,10,10' } }],
    ['/api/conditions', { query: { lon: '1', lat: '2' } }],
  ] as const) {
    const a = await call(route, req);
    assert.equal(a.status, 503, route);
    assert.equal(a.headers['Retry-After'], '10', route);
    assert.deepEqual(a.body.loading, LOADING, route);
    assert.match(String(a.body.error), /step 12 of 37/, route);
  }
  // The coastline does not wait for the forecast.
  const land = await call('/api/tile/:layer/:z/:x/:y', { params: { layer: 'land', z: '6', x: '3', y: '37' } });
  assert.equal(land.status, 200);
});

test('with a forecast loaded (or no wait function), requests go through', async () => {
  for (const wait of [() => null, undefined]) {
    const a = await api(wait)('/api/tile/:layer/:z/:x/:y', { params: { layer: 'seas', z: '6', x: '3', y: '37' } });
    assert.equal(a.status, 200);
  }
});
