/**
 * GET /api/routes/:id/meteogram says whether its rows are complete: false when
 * the forecast, a regional run, the currents or the tides changed while they
 * were read (the answer is not kept, and the web app says so). Its query names
 * the regional runs, so a new run is a fresh answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerApi, type ApiDeps } from './api';
import type { QueryArgs } from './protocol';
import { TileService, TileStore } from './tiles';

type Handler = (req: unknown, res: unknown) => unknown;
type TrackArgs = QueryArgs['track_conditions'];

const T0 = Date.UTC(2026, 10, 2, 0);
const H = 3600_000;
const point = (lon: number, h: number) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, 38] },
  properties: { time: new Date(T0 + h * H).toISOString(), mode: 'sailing', sog_ms: 3 },
});
const JOB = { id: 'j1', status: 'done', geojson: { type: 'FeatureCollection', features: [point(-9, 0), point(-10, 2)] }, summary: {} };

const answer = (a: { points: unknown[] }) => ({
  cycle: '2026-11-01T12:00:00.000Z',
  validTo: '2026-11-11T12:00:00.000Z',
  regional: [],
  regionalMissing: [],
  rows: a.points.map(() => ({ wind_ms: 5, wind_dir_deg: 270, wind_source: 'ECMWF' })),
});

/** The endpoint for job `j1` with these dependencies: call it to get its answer. */
function endpoint(deps: Partial<ApiDeps>, job: unknown = JOB): () => Promise<{ status: number; body: Record<string, unknown> }> {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (p: string | string[], h: Handler) => {
    for (const x of Array.isArray(p) ? p : [p]) routes.set(`${m} ${x}`, h);
  };
  registerApi(
    { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') } as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: '/nonexistent',
      // As JobManager: the API looks a job up with full(), which reads a departure window's results back from disk.
      jobs: { full: (id: string) => (id === 'j1' ? job : undefined) },
      regionalRuns: () => [],
      notReady: () => 'starting',
      ...deps,
    } as unknown as ApiDeps
  );
  return async () => {
    const out = { status: 200, body: {} as Record<string, unknown> };
    // The handler runs on without being awaited (withJob): the answer is there once json() is called.
    let answered!: () => void;
    const done = new Promise<void>(r => (answered = r));
    const res = {
      status(c: number) {
        out.status = c;
        return res;
      },
      json(b: Record<string, unknown>) {
        out.body = b;
        answered();
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
    await done;
    return out;
  };
}

/** The endpoint, with the tile service's track query answered `complete`. */
function meteogram(complete: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  // As TileService: point() the answer alone, pointWithStatus() with its status.
  const service = {
    point: async (_kind: string, a: { points: unknown[] }) => answer(a),
    pointWithStatus: async (_kind: string, a: { points: unknown[] }) => ({ result: answer(a), complete }),
  };
  return endpoint({ tiles: () => service as unknown as TileService })();
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

test("GET /api/routes/:id/meteogram: the query names the route's regional runs, so a new run is a fresh answer (PR #50 review)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-meteogram-api-'));
  try {
    const store = new TileStore({ root, capBytes: 1e9 });
    store.setGenerations({ wx: 'a', cur: 'a', tide: 'a', land: 'coast', pt: 'a' });
    const asked: TrackArgs[] = [];
    const service = new TileService(store, async (_kind, a) => {
      asked.push(a as TrackArgs);
      return { result: answer(a as TrackArgs), complete: true };
    });
    const regional_wind = [
      { name: 'AROME', run: '2026-11-02T00:00:00.000Z', share: 0.4 },
      { name: 'ICON-EU', run: '2026-11-02T00:00:00.000Z', share: 0.1 },
    ];
    let decoded: { name: string; cycle: string | null }[] = [
      { name: 'AROME', cycle: '2026110206' },
      { name: 'GFS', cycle: '2026110200' },
    ];
    const get = endpoint({ tiles: () => service, regionalRuns: () => decoded }, { ...JOB, summary: { regional_wind } });

    const first = await get();
    assert.equal(first.status, 200);
    assert.equal(asked.length, 1);
    assert.deepEqual(
      asked[0].regional,
      [
        { name: 'AROME', cycle: '2026110206' },
        { name: 'ICON-EU', cycle: null },
      ],
      "the route's models, each with its decoded run (none for ICON-EU); GFS was not used by the route"
    );
    const again = await get();
    assert.equal(asked.length, 1, 'the same runs: the saved answer');
    assert.deepEqual(again.body, first.body);

    decoded = [{ name: 'AROME', cycle: '2026110212' }];
    await get();
    assert.equal(asked.length, 2, 'a new AROME run: asked again');
    assert.deepEqual(asked[1].regional, [
      { name: 'AROME', cycle: '2026110212' },
      { name: 'ICON-EU', cycle: null },
    ]);
    await get();
    assert.equal(asked.length, 2, 'and saved under the new run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
