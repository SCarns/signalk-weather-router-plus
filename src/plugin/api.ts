/**
 * HTTP API mounted by Signal K at /plugins/signalk-weather-router-plus.
 *
 *   GET  /ui                        webapp (GET / is reserved by Signal K)
 *   GET  /api/status                plugin, forecast, currents and queue status
 *   GET  /api/settings              web-app settings {values, schema} (SI)
 *   PUT  /api/settings              partial update → validated, saved, applied live
 *   GET  /api/forecast              resident forecast metadata (+ series at ?lat=&lon=)
 *   POST /api/forecast/refresh      re-check ECMWF / NOMADS
 *   GET  /api/polars                polar library (default + polarsDir)
 *   GET  /api/polar-angles?path=    best VMG angles per TWS
 *   GET  /api/polars/table?path=    polar table in m/s
 *   POST /api/polar-from-specs      generate a polar from boat specs (EmpiricalVPP) into polarsDir/user/
 *   GET  /api/legends               colour ramps (SI stops) for every layer
 *   GET  /api/field?layer=&bbox=&time=&res=     JSON grid for a heatmap/streamline layer
 *   GET  /api/wind-points?bbox=&time=&res=      wind barb points (speed_ms, dir_deg FROM)
 *   GET  /api/currents?bbox=&time=&res=         current arrow points (dir_deg TO)
 *   GET  /api/pressure?bbox=&time=&interval=    isobars + H/L GeoJSON
 *   GET  /api/conditions?lon=&lat=&from=&hours=&step_h=   point series
 *   GET  /api/conditions-tile/:z/:x/:y?t=   current-hour conditions sample points for one XYZ tile
 *   POST /api/routes                submit a route job → 202 {id, status, links}
 *   GET  /api/routes                list jobs
 *   GET  /api/routes/:id            job status
 *   GET  /api/routes/:id/events     SSE stream (honours Last-Event-ID)
 *   GET  /api/routes/:id/result     GeoJSON FeatureCollection
 *   GET  /api/routes/:id/skeleton   coarse A* skeleton GeoJSON
 *   GET  /api/routes/:id/signalk    Signal K Route resource body
 *   POST /api/routes/:id/cancel
 *   POST /api/routes/:id/publish    save to the Resources API
 *   DELETE /api/routes/:id
 *   GET  /api/openapi.json
 *
 * Reads are opened to readonly users and writes to readwrite users when
 * the server supports `router.access()` (Signal K ≥ 2.31); on older
 * servers every route is admin-only, which is the server's default.
 */

import * as path from 'node:path';
import type { IRouter, Request, Response } from 'express';
import type { JobManager } from './jobs';
import type { QueryArgs, QueryKind, RouteRequest } from './protocol';
import { openApiDocument } from './openapi';
import { buildLegends } from './legends';
import { listPolars, loadPolarCached, PolarNotFoundError, polarAngles, polarFromSpecs, polarTable, resolvePolarPath } from './polars';
import type { BBox } from '../geo/geodesy';
import { SettingsValidationError, type AppSettings, type SettingsGroup, type SettingSpec } from './settings';

export interface ApiDeps {
  pluginId: string;
  basePath: string;
  jobs: JobManager;
  status: () => Record<string, unknown>;
  forecastInfo: (lat?: number, lon?: number) => Record<string, unknown>;
  refreshForecast: (force: boolean) => void;
  cancelRunning: (id: string) => void;
  publish: (id: string) => Promise<string>;
  query: <K extends QueryKind>(kind: K, args: QueryArgs[K]) => Promise<unknown>;
  publicDir: string;
  /** Polar library configuration (null before the plugin has started). */
  polarLibrary: () => { polarFile: string | null; polarsDir: string | null } | null;
  /** Web-app settings; throws when the plugin is not started. */
  getSettings: () => { values: AppSettings; schema: { groups: { id: SettingsGroup; label: string; help: string }[]; settings: readonly SettingSpec[] } };
  /** Validate, persist and apply a partial settings update. */
  updateSettings: (partial: unknown) => { values: AppSettings; changed: string[]; reloaded: { forecast: boolean; currents: boolean; refresh_timer: boolean; jobs: boolean } };
}

type AccessRouter = IRouter & { access?: (level: 'readonly' | 'readwrite') => IRouter };

function parseBBox(s: unknown): BBox {
  const parts = String(s ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) throw new Error('bbox must be w,s,e,n');
  const [west, south, east, north] = parts;
  if (south >= north || south < -90 || north > 90) throw new Error('bbox latitudes invalid');
  if (west < -180 || west > 360 || east < -180 || east > 360) throw new Error('bbox longitudes must be in [-180, 360]');
  if (east - west > 360) throw new Error('bbox longitude span exceeds 360°');
  return { west, south, east, north };
}

function parseTime(s: unknown): Date {
  if (s === undefined || s === '') return new Date();
  const d = new Date(String(s));
  if (Number.isNaN(d.getTime())) throw new Error(`time "${String(s)}" is not ISO 8601`);
  return d;
}

const HOUR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})(?::([0-5]\d))?(?::([0-5]\d))?Z?$/;

/**
 * Hour-truncated UTC ISO time, `YYYY-MM-DDTHH[:MM[:SS]][Z]` with zero
 * minutes and seconds (the routing server's `round_t_to_hour`).
 */
export function parseHourT(s: unknown): Date {
  const t = typeof s === 'string' ? s : '';
  if (!t) throw new Error('t is required');
  const m = HOUR_RE.exec(t);
  if (!m) throw new Error(`t must be hour-truncated ISO (YYYY-MM-DDTHH[:00[:00]][Z]); got '${t}'`);
  if (m[2] !== undefined && Number(m[2]) !== 0) throw new Error(`t must be truncated to the hour; got minute=${m[2]}`);
  if (m[3] !== undefined && Number(m[3]) !== 0) throw new Error(`t must be truncated to the hour; got second=${m[3]}`);
  const d = new Date(`${m[1]}:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 13) !== m[1]) throw new Error(`Bad t: ${t}`);
  return d;
}

function num(s: unknown, def: number, min: number, max: number, name: string): number {
  if (s === undefined || s === '') return def;
  const v = Number(s);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number in [${min}, ${max}]`);
  return v;
}

export function registerApi(router: IRouter, deps: ApiDeps): void {
  const r = router as AccessRouter;
  const ro: IRouter = typeof r.access === 'function' ? r.access('readonly') : router;
  const rw: IRouter = typeof r.access === 'function' ? r.access('readwrite') : router;

  const json = (res: Response, code: number, body: unknown): void => {
    res.status(code).json(body);
  };
  const fail = (res: Response, err: unknown, code = 400): void => {
    json(res, err instanceof PolarNotFoundError ? 404 : code, { error: (err as Error).message });
  };

  const servePublic = (rel: string, req: Request, res: Response): void => {
    const file = path.join(deps.publicDir, rel);
    if (!file.startsWith(deps.publicDir)) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file, (err?: Error) => {
      if (err && !res.headersSent) res.status(404).send(`not found: ${req.path}`);
    });
  };
  router.get(['/ui', '/ui/'], (req: Request, res: Response) => servePublic('index.html', req, res));
  router.get('/ui/:file', (req: Request, res: Response) => servePublic(path.basename(req.params.file), req, res));

  ro.get('/api/status', (_req: Request, res: Response) => json(res, 200, deps.status()));

  ro.get('/api/settings', (_req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      json(res, 200, deps.getSettings());
    } catch (err) {
      fail(res, err, 503);
    }
  });

  // Partial update: {group: {key: value}} in SI. All-or-nothing: any
  // invalid key → 400 {error, errors: {"group.key": message}}, nothing saved.
  rw.put('/api/settings', (req: Request, res: Response) => {
    try {
      json(res, 200, deps.updateSettings(req.body));
    } catch (err) {
      if (err instanceof SettingsValidationError) json(res, 400, { error: err.message, errors: err.errors });
      else fail(res, err, /not started/.test((err as Error).message) ? 503 : 500);
    }
  });

  ro.get('/api/forecast', (req: Request, res: Response) => {
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
    const lon = req.query.lon !== undefined ? Number(req.query.lon) : undefined;
    if ((lat !== undefined && !Number.isFinite(lat)) || (lon !== undefined && !Number.isFinite(lon))) {
      json(res, 400, { error: 'lat and lon must be numbers' });
      return;
    }
    try {
      json(res, 200, deps.forecastInfo(lat, lon));
    } catch (err) {
      fail(res, err);
    }
  });

  rw.post('/api/forecast/refresh', (req: Request, res: Response) => {
    deps.refreshForecast(req.query.force === 'true' || req.query.force === '1');
    json(res, 202, { status: 'refresh requested' });
  });

  const polarLib = (): { polarFile: string | null; polarsDir: string | null } => {
    const lib = deps.polarLibrary();
    if (!lib) throw new Error('plugin not started');
    return lib;
  };
  ro.get('/api/polars', (_req: Request, res: Response) => {
    try {
      json(res, 200, listPolars(polarLib()));
    } catch (err) {
      fail(res, err);
    }
  });
  ro.get('/api/polar-angles', (req: Request, res: Response) => {
    try {
      const file = resolvePolarPath(polarLib(), String(req.query.path ?? ''));
      if (!file) throw new Error('no polar configured');
      json(res, 200, polarAngles(loadPolarCached(file)));
    } catch (err) {
      fail(res, err);
    }
  });
  ro.get('/api/polars/table', (req: Request, res: Response) => {
    try {
      const token = req.query.path === undefined || req.query.path === '' ? 'default' : String(req.query.path);
      const file = resolvePolarPath(polarLib(), token === 'default' ? '' : token);
      if (!file) throw new Error('no polar configured');
      json(res, 200, { path: token, ...polarTable(loadPolarCached(file)) });
    } catch (err) {
      fail(res, err);
    }
  });

  rw.post('/api/polar-from-specs', (req: Request, res: Response) => {
    try {
      const out = polarFromSpecs(polarLib(), req.body);
      json(res, out.status, out.body);
    } catch (err) {
      fail(res, err, 500);
    }
  });

  ro.get('/api/legends', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    json(res, 200, buildLegends());
  });

  const cacheHeaders = (res: Response, t: Date): void => {
    res.setHeader('Cache-Control', t.getTime() < Date.now() - 3600_000 ? 'public, max-age=86400' : 'public, max-age=1800');
  };

  ro.get('/api/field', async (req: Request, res: Response) => {
    try {
      const layer = String(req.query.layer ?? '');
      if (!['wind', 'waves', 'msl', 'temperature', 'sst', 'precip', 'sea_state', 'current'].includes(layer)) throw new Error('layer must be one of wind, waves, msl, temperature, sst, precip, sea_state, current');
      const bbox = parseBBox(req.query.bbox);
      const time = parseTime(req.query.time);
      const resDeg = num(req.query.res, 0.25, 0.02, 2, 'res');
      const out = await deps.query('field', { layer, bbox, timeMs: time.getTime(), res: resDeg });
      cacheHeaders(res, time);
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  ro.get('/api/wind-points', async (req: Request, res: Response) => {
    try {
      const bbox = parseBBox(req.query.bbox);
      const time = parseTime(req.query.time);
      const resDeg = num(req.query.res, 0.5, 0.02, 5, 'res');
      const out = await deps.query('wind_points', { bbox, timeMs: time.getTime(), res: resDeg });
      cacheHeaders(res, time);
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  ro.get('/api/currents', async (req: Request, res: Response) => {
    try {
      const bbox = parseBBox(req.query.bbox);
      const time = parseTime(req.query.time);
      const resDeg = num(req.query.res, 0.05, 0.005, 5, 'res');
      const out = await deps.query('currents', { bbox, timeMs: time.getTime(), res: resDeg });
      cacheHeaders(res, time);
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  ro.get('/api/pressure', async (req: Request, res: Response) => {
    try {
      const bbox = parseBBox(req.query.bbox);
      const time = parseTime(req.query.time);
      const interval = num(req.query.interval, 4, 1, 20, 'interval');
      const out = await deps.query('pressure', { bbox, timeMs: time.getTime(), intervalHpa: interval });
      cacheHeaders(res, time);
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  ro.get('/api/conditions', async (req: Request, res: Response) => {
    try {
      const lon = Number(req.query.lon);
      const lat = Number(req.query.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90 || lon < -180 || lon > 360) throw new Error('lon and lat are required numbers');
      const from = req.query.from !== undefined && req.query.from !== '' ? parseTime(req.query.from) : new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
      const hours = num(req.query.hours, 72, 1, 240, 'hours');
      const stepH = num(req.query.step_h, 1, 1, 24, 'step_h');
      const out = await deps.query('conditions', { lon, lat, fromMs: from.getTime(), hours, stepH });
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  // Conditions sample tile: every ConditionsRow field at the wind-barb
  // sample positions of one XYZ tile for hour `t`, land points dropped.
  // `/api/conditions-tile/{z}/{x}/{y}` (a `.json` suffix on y is accepted).
  ro.get('/api/conditions-tile/:z/:x/:y', async (req: Request, res: Response) => {
    const zs = String(req.params.z);
    const xs = String(req.params.x);
    const ym = /^(\d+)(?:\.json)?$/.exec(String(req.params.y));
    if (!/^\d+$/.test(zs) || !/^\d+$/.test(xs) || !ym) {
      json(res, 404, { error: 'tile not found' });
      return;
    }
    const z = Number(zs);
    const x = Number(xs);
    const y = Number(ym[1]);
    let t: Date;
    try {
      t = parseHourT(req.query.t);
    } catch (err) {
      fail(res, err);
      return;
    }
    if (z < 5) {
      cacheHeaders(res, t);
      json(res, 200, []);
      return;
    }
    const n = 2 ** z;
    if (z > 30 || x >= n || y >= n) {
      json(res, 404, { error: 'tile not found' });
      return;
    }
    try {
      const out = await deps.query('conditions_tile', { z, x, y, timeMs: t.getTime() });
      cacheHeaders(res, t);
      json(res, 200, out);
    } catch (err) {
      const msg = (err as Error).message;
      fail(res, err, /no forecast data loaded/.test(msg) ? 503 : 500);
    }
  });

  rw.post('/api/routes', (req: Request, res: Response) => {
    const body = req.body as RouteRequest | undefined;
    if (!body || typeof body !== 'object') {
      json(res, 400, { error: 'JSON body required: {start:{lat,lon}, end:{lat,lon}, ...}' });
      return;
    }
    const err = validateRequestShape(body);
    if (err) {
      json(res, 400, { error: err });
      return;
    }
    if (deps.jobs.queueLength >= 16) {
      json(res, 429, { error: 'job queue is full' });
      return;
    }
    const job = deps.jobs.submit(body);
    res.setHeader('Location', deps.jobs.links(job.id).self);
    json(res, 202, { id: job.id, status: job.status, links: deps.jobs.links(job.id) });
  });

  ro.get('/api/routes', (req: Request, res: Response) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50) || 50));
    json(res, 200, deps.jobs.list(limit).map((j) => deps.jobs.toPublic(j)));
  });

  ro.get('/api/routes/:id', (req: Request, res: Response) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    json(res, 200, deps.jobs.toPublic(job));
  });

  ro.get('/api/routes/:id/result', (req: Request, res: Response) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    if (job.status !== 'done' || !job.geojson) {
      json(res, 409, { error: `job is ${job.status}`, status: job.status, message: job.error });
      return;
    }
    json(res, 200, job.geojson);
  });

  ro.get('/api/routes/:id/skeleton', (req: Request, res: Response) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    if (!job.skeleton) {
      json(res, 404, { error: 'no skeleton for this job' });
      return;
    }
    json(res, 200, job.skeleton);
  });

  ro.get('/api/routes/:id/signalk', (req: Request, res: Response) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    if (job.status !== 'done' || !job.skRoute) {
      json(res, 409, { error: `job is ${job.status}` });
      return;
    }
    json(res, 200, job.skRoute);
  });

  ro.get('/api/routes/:id/events', (req: Request, res: Response) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const lastIdHeader = req.headers['last-event-id'];
    const lastId = lastIdHeader ? Number(Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader) : 0;
    const write = (ev: { id: number; event: string; data: unknown }): void => {
      res.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    };
    for (const ev of job.events) if (ev.id > lastId) write(ev);
    const terminal = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
    if (terminal) {
      res.end();
      return;
    }
    const listener = (id: string, ev: { id: number; event: string; data: unknown }): void => {
      if (id !== job.id) return;
      write(ev);
      if (ev.event === 'done' || ev.event === 'error') {
        cleanup();
        res.end();
      }
    };
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
    const cleanup = (): void => {
      clearInterval(keepalive);
      deps.jobs.off('event', listener);
    };
    deps.jobs.on('event', listener);
    req.on('close', cleanup);
  });

  rw.post('/api/routes/:id/cancel', (req: Request, res: Response) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    const what = deps.jobs.cancel(job.id);
    if (what === 'running') deps.cancelRunning(job.id);
    json(res, 202, { id: job.id, status: what ? 'cancelling' : job.status });
  });

  rw.post('/api/routes/:id/publish', async (req: Request, res: Response) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    if (job.status !== 'done') {
      json(res, 409, { error: `job is ${job.status}` });
      return;
    }
    try {
      const resourceId = await deps.publish(job.id);
      json(res, 200, { id: job.id, resource_id: resourceId, href: `/signalk/v2/api/resources/routes/${resourceId}` });
    } catch (err) {
      fail(res, err, 502);
    }
  });

  rw.delete('/api/routes/:id', (req: Request, res: Response) => {
    const job = deps.jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    if (job.status === 'running') {
      json(res, 409, { error: 'cancel the running job before deleting it' });
      return;
    }
    deps.jobs.delete(job.id);
    res.status(204).end();
  });

  ro.get('/api/openapi.json', (_req: Request, res: Response) => json(res, 200, openApiDocument(deps.basePath)));
}

function validateRequestShape(b: RouteRequest): string | null {
  const isPt = (p: unknown): p is { lat: number; lon: number } =>
    !!p && typeof p === 'object' && typeof (p as { lat: unknown }).lat === 'number' && typeof (p as { lon: unknown }).lon === 'number';
  if (!isPt(b.start)) return 'start must be {lat, lon}';
  if (!isPt(b.end)) return 'end must be {lat, lon}';
  if (b.waypoints !== undefined) {
    if (!Array.isArray(b.waypoints) || !b.waypoints.every(isPt)) return 'waypoints must be an array of {lat, lon}';
    if (b.waypoints.length > 20) return 'at most 20 waypoints';
  }
  if (b.mode !== undefined && !['sail_max', 'fastest', 'motor'].includes(b.mode)) return 'mode must be sail_max, fastest or motor';
  if (b.departure !== undefined && b.departure !== '' && Number.isNaN(Date.parse(b.departure))) return 'departure must be ISO 8601';
  if (b.stages !== undefined && (typeof b.stages !== 'number' || b.stages < 4 || b.stages > 200)) return 'stages must be 4..200';
  if (b.sail_thresh_ms !== undefined && (typeof b.sail_thresh_ms !== 'number' || b.sail_thresh_ms < 0)) return 'sail_thresh_ms must be >= 0';
  if (b.name !== undefined && typeof b.name !== 'string') return 'name must be a string';
  if (b.vessel !== undefined && (b.vessel === null || typeof b.vessel !== 'object')) return 'vessel must be an object';
  if (b.vessel?.tack_penalty_s !== undefined && (typeof b.vessel.tack_penalty_s !== 'number' || b.vessel.tack_penalty_s < 0 || b.vessel.tack_penalty_s > 600)) return 'vessel.tack_penalty_s must be 0..600';
  if (b.vessel?.polar !== undefined && (typeof b.vessel.polar !== 'string' || b.vessel.polar.length > 200)) return 'vessel.polar must be a polar token from /api/polars';
  return null;
}
