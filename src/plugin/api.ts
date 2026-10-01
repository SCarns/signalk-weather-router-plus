/**
 * HTTP API mounted by Signal K at /plugins/signalk-weather-router-plus.
 *
 *   GET  /ui                        webapp (GET / is reserved by Signal K)
 *   GET  /api/status                plugin, forecast, currents and queue status
 *   GET  /api/settings              web-app settings {values, schema} (SI)
 *   PUT  /api/settings              partial update → validated, saved, applied live
 *   GET  /api/forecast              forecast metadata (+ series at ?lat=&lon=)
 *   POST /api/forecast/refresh      re-check ECMWF / NOMADS
 *   GET  /api/polars                polar library (default polar, library, user polars)
 *   GET  /api/polar-angles?path=    best VMG angles per TWS
 *   GET  /api/polars/table?path=    polar table in m/s
 *   POST /api/polar-from-specs      generate a polar from boat specs (physics calculator) into the user polar directory
 *   GET  /api/legends               colour ramps (SI stops) for every layer
 *   GET  /api/field?layer=&bbox=&time=&res=     JSON grid for a heatmap/streamline layer (layer=tide: tide_m)
 *   GET  /api/wind-points?bbox=&time=&res=      wind barb points (speed_ms, dir_deg FROM)
 *   GET  /api/currents?bbox=&time=&res=         current arrow points (dir_deg TO)
 *   GET  /api/pressure?bbox=&time=&interval=    isobars + H/L GeoJSON
 *   GET  /api/conditions?lon=&lat=&from=&hours=&step_h=   point series (+ tide fields and high/low waters)
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { IRouter, Request, Response } from 'express';
import type { JobManager } from './jobs';
import type { QueryArgs, QueryKind, RouteRequest } from './protocol';
import { openApiDocument } from './openapi';
import { buildLegends } from './legends';
import { listPolars, loadPolarCached, PolarNotFoundError, polarAngles, polarFromSpecs, polarTable, resolvePolarPath } from './polars';
import type { BBox } from '../geo/geodesy';
import { SettingsValidationError, type AppSettings, type SettingsGroup, type SettingSpec } from './settings';
import { validateLegOptions } from '../engine/multileg';
import { checkTile, roundHour, TILE_LAYERS, type TileLayer, type TileService } from './tiles';
import { joinField, joinLandMask, joinPoints, joinPressure, type TileGetter } from './tilejoin';
import { isPngLayer, PNG_LAYERS, PngCache, renderTilePng } from './pngtiles';
import { GLYPH_LAYERS, isGlyphLayer, renderGlyphTilePng } from './glyphtiles';
import type { FieldLayer } from './overlays';

export interface ApiDeps {
  pluginId: string;
  basePath: string;
  jobs: JobManager;
  status: () => Record<string, unknown>;
  forecastInfo: (lat?: number, lon?: number) => Promise<Record<string, unknown>>;
  refreshForecast: (force: boolean) => void;
  cancelRunning: (id: string) => void;
  publish: (id: string) => Promise<string>;
  query: <K extends QueryKind>(kind: K, args: QueryArgs[K], signal?: AbortSignal) => Promise<unknown>;
  /** Map overlay tiles (null before the plugin has started). */
  tiles: () => TileService | null;
  /** Why the plugin is not answering yet ("starting: downloading the coastline (40 %)"), for 503 answers. */
  notReady: () => string;
  /** Start (or retry now) the GSHHG coastline download; progress in /api/status `coastline`. */
  downloadCoastline: () => void;
  /** The page asked for this tile (the prebuilder follows the view). */
  noteTileRequest: (z: number, x: number, y: number) => void;
  publicDir: string;
  /** Polar library configuration (null before the plugin has started). */
  polarLibrary: () => { polarFile: string | null; polarsDir: string | null; userDir?: string | null } | null;
  /** Web-app settings; throws when the plugin is not started. */
  getSettings: () => {
    values: AppSettings;
    schema: { groups: { id: SettingsGroup; label: string; help: string }[]; settings: readonly SettingSpec[] };
  };
  /** Validate, persist and apply a partial settings update. */
  updateSettings: (partial: unknown) => {
    values: AppSettings;
    changed: string[];
    reloaded: { forecast: boolean; currents: boolean; tides: boolean; refresh_timer: boolean; jobs: boolean };
  };
}

type AccessRouter = IRouter & { access?: (level: 'readonly' | 'readwrite') => IRouter };

function parseBBox(s: unknown): BBox {
  const parts = String(s ?? '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) throw new Error('bbox must be w,s,e,n');
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
  /** The job manager, or null after answering 503 when the plugin is not started. */
  const jobsOr503 = (res: Response): JobManager | null => {
    try {
      return deps.jobs;
    } catch (err) {
      json(res, 503, { error: (err as Error).message });
      return null;
    }
  };
  const fail = (res: Response, err: unknown, code = 400): void => {
    if (res.headersSent || res.destroyed) return; // client gone (cancelled query)
    json(res, err instanceof PolarNotFoundError ? 404 : code, { error: (err as Error).message });
  };

  // The page's own scripts and styles are referenced with ?v=<tag>, where
  // the tag changes whenever any public file changes, so browsers and
  // proxies in front of Signal K (e.g. Cloudflare) never run a stale
  // script after an update. The versioned files can then be cached hard.
  const publicVersion = (): string => {
    let h = 0;
    try {
      for (const f of fs.readdirSync(deps.publicDir).sort()) {
        const st = fs.statSync(path.join(deps.publicDir, f));
        const s = `${f}:${st.size}:${Math.floor(st.mtimeMs)}`;
        for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
      }
    } catch {
      /* fall back to a constant tag */
    }
    return (h >>> 0).toString(36);
  };
  const servePublic = (rel: string, req: Request, res: Response): void => {
    const file = path.join(deps.publicDir, rel);
    if (!file.startsWith(deps.publicDir)) {
      res.status(404).end();
      return;
    }
    if (rel === 'index.html') {
      try {
        const v = publicVersion();
        const html = fs
          .readFileSync(file, 'utf8')
          .replace(/(<(?:script|link)[^>]+(?:src|href)=")((?:ol|rp-[a-z]+)\.(?:js|css))"/g, `$1$2?v=${v}"`);
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(html);
      } catch {
        res.status(404).send(`not found: ${req.path}`);
      }
      return;
    }
    // Versioned requests (from the page) can be cached; bare ones revalidate.
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.sendFile(file, (err?: Error) => {
      if (err && !res.headersSent) res.status(404).send(`not found: ${req.path}`);
    });
  };
  // Registered through `ro`: on Signal K >= 2.31 a route registered on the
  // bare router stays admin-only.
  ro.get('/ui', (req: Request, res: Response) => servePublic('index.html', req, res));
  ro.get('/ui/', (req: Request, res: Response) => servePublic('index.html', req, res));
  ro.get('/ui/:file', (req: Request, res: Response) => servePublic(path.basename(req.params.file), req, res));

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

  ro.get('/api/forecast', async (req: Request, res: Response) => {
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
    const lon = req.query.lon !== undefined ? Number(req.query.lon) : undefined;
    if ((lat !== undefined && !Number.isFinite(lat)) || (lon !== undefined && !Number.isFinite(lon))) {
      json(res, 400, { error: 'lat and lon must be numbers' });
      return;
    }
    try {
      json(res, 200, await deps.forecastInfo(lat, lon));
    } catch (err) {
      fail(res, err);
    }
  });

  // The config panel's Download coastline button (works before the plugin has a coastline).
  rw.post('/api/coastline/download', (_req: Request, res: Response) => {
    deps.downloadCoastline();
    json(res, 202, { status: 'download requested; see /api/status coastline' });
  });

  rw.post('/api/forecast/refresh', (req: Request, res: Response) => {
    deps.refreshForecast(req.query.force === 'true' || req.query.force === '1');
    json(res, 202, { status: 'refresh requested' });
  });

  const polarLib = (): { polarFile: string | null; polarsDir: string | null; userDir?: string | null } => {
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

  /** Aborts when the client goes away before the answer is sent (its query then leaves the worker's queue). */
  const clientGone = (res: Response): AbortSignal => {
    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ctrl.abort();
    });
    return ctrl.signal;
  };

  /** The shared tile store, or null after answering 503 when the plugin is not started. */
  const tilesOr503 = (res: Response): TileService | null => {
    const t = deps.tiles();
    if (!t) json(res, 503, { error: deps.notReady() });
    return t;
  };
  /**
   * Decoded tiles for a request (cancelled with it). Every map request also
   * tells the prebuilder where a view is (not the coastline or pressure
   * tiles: they are read at other zooms than the view's).
   */
  const getter =
    (service: TileService, signal: AbortSignal): TileGetter =>
    t => {
      if (t.layer !== 'land' && t.layer !== 'msl') deps.noteTileRequest(t.z, t.x, t.y);
      return service.decoded(t, signal);
    };

  const cacheHeaders = (res: Response, t: Date): void => {
    res.setHeader('Cache-Control', t.getTime() < Date.now() - 3600_000 ? 'public, max-age=86400' : 'public, max-age=1800');
  };

  ro.get('/api/field', async (req: Request, res: Response) => {
    try {
      const layer = String(req.query.layer ?? '');
      if (!['wind', 'waves', 'msl', 'temperature', 'sst', 'precip', 'sea_state', 'current', 'tide'].includes(layer))
        throw new Error('layer must be one of wind, waves, msl, temperature, sst, precip, sea_state, current, tide');
      const bbox = parseBBox(req.query.bbox);
      const time = parseTime(req.query.time);
      const resDeg = num(req.query.res, 0.25, 0.002, 2, 'res');
      const service = tilesOr503(res);
      if (!service) return;
      const hour = roundHour(time.getTime());
      const out = await joinField(getter(service, clientGone(res)), layer as FieldLayer, bbox, hour, resDeg);
      cacheHeaders(res, new Date(hour));
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  // Land mask at screen resolution for clipping drawn layers to the coast.
  // Raw bytes (1 = land), row 0 north, gzip-compressed: a mask is mostly
  // long runs, so a 1024×1024 view is typically a few kB on the wire.
  ro.get('/api/land-mask', async (req: Request, res: Response) => {
    try {
      const bbox = parseBBox(req.query.bbox);
      const w = Math.round(num(req.query.w, 1024, 16, 2048, 'w'));
      const h = Math.round(num(req.query.h, 1024, 16, 2048, 'h'));
      const service = tilesOr503(res);
      if (!service) return;
      const out = await joinLandMask(getter(service, clientGone(res)), bbox, w, h);
      const body = zlib.gzipSync(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('X-Mask-Width', String(w));
      res.setHeader('X-Mask-Height', String(h));
      res.setHeader('Access-Control-Expose-Headers', 'X-Mask-Width, X-Mask-Height');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.status(200).end(body);
    } catch (err) {
      fail(res, err);
    }
  });

  ro.get('/api/wind-points', async (req: Request, res: Response) => {
    try {
      const bbox = parseBBox(req.query.bbox);
      const time = parseTime(req.query.time);
      const resDeg = num(req.query.res, 0.5, 0.02, 5, 'res');
      const service = tilesOr503(res);
      if (!service) return;
      const hour = roundHour(time.getTime());
      const out = await joinPoints(getter(service, clientGone(res)), 'barbs', bbox, hour, resDeg);
      cacheHeaders(res, new Date(hour));
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
      const service = tilesOr503(res);
      if (!service) return;
      const hour = roundHour(time.getTime());
      const out = await joinPoints(getter(service, clientGone(res)), 'arrows', bbox, hour, resDeg);
      cacheHeaders(res, new Date(hour));
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  // The colour overlays as PNG image tiles (pngtiles.ts), for chartplotters
  // that draw image tiles (Freeboard-SK's chart layers): the picture the web
  // app paints from the data tile, rendered on demand from the data tiles
  // below and kept in memory. Registered before the data-tile route, whose
  // `:y` would otherwise swallow "5.png".
  const pngCache = new PngCache(48e6);
  ro.get('/api/tile/:layer/:z/:x/:y.png', async (req: Request, res: Response) => {
    try {
      const service = deps.tiles();
      if (!service) {
        json(res, 503, { error: deps.notReady() });
        return;
      }
      const layer = String(req.params.layer);
      if (!isPngLayer(layer) && !isGlyphLayer(layer))
        throw new Error(`layer must be one of ${[...PNG_LAYERS, ...GLYPH_LAYERS].join(', ')}`);
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      checkTile(z, x, y);
      const hourMs = roundHour(parseTime(req.query.time).getTime());
      deps.noteTileRequest(z, x, y);
      const { png, cached } = isGlyphLayer(layer)
        ? await renderGlyphTilePng(service, pngCache, layer, z, x, y, hourMs, clientGone(res))
        : await renderTilePng(service, pngCache, layer, z, x, y, hourMs, clientGone(res));
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Tile-Cache', cached ? 'hit' : 'miss');
      res.setHeader('Access-Control-Expose-Headers', 'X-Tile-Cache');
      cacheHeaders(res, new Date(hourMs));
      res.status(200).end(png);
    } catch (err) {
      fail(res, err);
    }
  });

  // Fixed web-map tiles at whole hours (tiles.ts): answered from disk when
  // saved, else computed by the data worker and saved. Body gzip JSON
  // (colour layers: as /api/field; barbs: as /api/wind-points; arrows:
  // as /api/currents), or for `land` gzip bytes 256 × 256, 1 = land, row
  // 0 north, rows evenly spaced in Web Mercator y.
  ro.get('/api/tile/:layer/:z/:x/:y', async (req: Request, res: Response) => {
    try {
      const service = deps.tiles();
      if (!service) {
        json(res, 503, { error: deps.notReady() });
        return;
      }
      const layer = String(req.params.layer) as TileLayer;
      if (!(TILE_LAYERS as readonly string[]).includes(layer)) throw new Error(`layer must be one of ${TILE_LAYERS.join(', ')}`);
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      checkTile(z, x, y);
      const time = parseTime(req.query.time);
      const hourMs = layer === 'land' ? 0 : roundHour(time.getTime());
      if (layer !== 'land') deps.noteTileRequest(z, x, y);
      const { gz, cached } = await service.get({ layer, z, x, y, hourMs }, clientGone(res));
      if (res.destroyed) return;
      res.setHeader('Content-Type', layer === 'land' ? 'application/octet-stream' : 'application/json');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('X-Tile-Cache', cached ? 'hit' : 'miss');
      res.setHeader('Access-Control-Expose-Headers', 'X-Tile-Cache');
      if (layer === 'land') res.setHeader('Cache-Control', 'public, max-age=86400');
      else cacheHeaders(res, new Date(hourMs));
      res.status(200).end(gz);
    } catch (err) {
      fail(res, err);
    }
  });

  ro.get('/api/pressure', async (req: Request, res: Response) => {
    try {
      const bbox = parseBBox(req.query.bbox);
      const time = parseTime(req.query.time);
      const interval = num(req.query.interval, 4, 1, 20, 'interval');
      const service = tilesOr503(res);
      if (!service) return;
      const hour = roundHour(time.getTime());
      const out = await joinPressure(getter(service, clientGone(res)), bbox, hour, interval);
      cacheHeaders(res, new Date(hour));
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  ro.get('/api/conditions', async (req: Request, res: Response) => {
    try {
      const lon = Number(req.query.lon);
      const lat = Number(req.query.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90 || lon < -180 || lon > 360)
        throw new Error('lon and lat are required numbers');
      const from =
        req.query.from !== undefined && req.query.from !== ''
          ? parseTime(req.query.from)
          : new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
      const hours = num(req.query.hours, 72, 1, 240, 'hours');
      const stepH = num(req.query.step_h, 1, 1, 24, 'step_h');
      const service = tilesOr503(res);
      if (!service) return;
      const out = await service.point('conditions', { lon, lat, fromMs: from.getTime(), hours, stepH }, clientGone(res));
      json(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  rw.post('/api/routes', (req: Request, res: Response) => {
    const jobs = jobsOr503(res);
    if (!jobs) return;
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
    if (jobs.queueLength >= 16) {
      json(res, 429, { error: 'job queue is full' });
      return;
    }
    const job = jobs.submit(body);
    res.setHeader('Location', jobs.links(job.id).self);
    json(res, 202, { id: job.id, status: job.status, links: jobs.links(job.id) });
  });

  ro.get('/api/routes', (req: Request, res: Response) => {
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50) || 50));
    json(
      res,
      200,
      jobs.list(limit).map(j => jobs.toPublic(j))
    );
  });

  ro.get('/api/routes/:id', (req: Request, res: Response) => {
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const job = jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    json(res, 200, jobs.toPublic(job));
  });

  ro.get('/api/routes/:id/result', (req: Request, res: Response) => {
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const job = jobs.get(req.params.id);
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
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const job = jobs.get(req.params.id);
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
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const job = jobs.get(req.params.id);
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
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const job = jobs.get(req.params.id);
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
      jobs.off('event', listener);
    };
    jobs.on('event', listener);
    req.on('close', cleanup);
  });

  rw.post('/api/routes/:id/cancel', (req: Request, res: Response) => {
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const job = jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    const what = jobs.cancel(job.id);
    if (what === 'running') deps.cancelRunning(job.id);
    json(res, 202, { id: job.id, status: what ? 'cancelling' : job.status });
  });

  rw.post('/api/routes/:id/publish', async (req: Request, res: Response) => {
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const job = jobs.get(req.params.id);
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
    const jobs = jobsOr503(res);
    if (!jobs) return;
    const job = jobs.get(req.params.id);
    if (!job) {
      json(res, 404, { error: 'job not found' });
      return;
    }
    if (job.status === 'running') {
      json(res, 409, { error: 'cancel the running job before deleting it' });
      return;
    }
    jobs.delete(job.id);
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
  const legErr = validateLegOptions(b.precision, b.arrival_radius_m, b.waypoints);
  if (legErr) return legErr;
  if (b.mode !== undefined && !['sail_max', 'fastest', 'motor'].includes(b.mode)) return 'mode must be sail_max, fastest or motor';
  if (b.departure !== undefined && b.departure !== '' && Number.isNaN(Date.parse(b.departure))) return 'departure must be ISO 8601';
  if (b.stages !== undefined && (typeof b.stages !== 'number' || b.stages < 4 || b.stages > 200)) return 'stages must be 4..200';
  if (b.sail_thresh_ms !== undefined && (typeof b.sail_thresh_ms !== 'number' || b.sail_thresh_ms < 0))
    return 'sail_thresh_ms must be >= 0';
  if (b.simplify_m !== undefined && (typeof b.simplify_m !== 'number' || !(b.simplify_m >= 0 && b.simplify_m <= 5000)))
    return 'simplify_m must be 0..5000';
  if (b.smoother !== undefined && typeof b.smoother !== 'boolean') return 'smoother must be true or false';
  if (
    b.smoother_tolerance !== undefined &&
    (typeof b.smoother_tolerance !== 'number' || !(b.smoother_tolerance >= 0 && b.smoother_tolerance <= 0.5))
  )
    return 'smoother_tolerance must be 0..0.5';
  if (b.name !== undefined && typeof b.name !== 'string') return 'name must be a string';
  if (b.vessel !== undefined && (b.vessel === null || typeof b.vessel !== 'object')) return 'vessel must be an object';
  if (
    b.vessel?.polar_performance !== undefined &&
    (typeof b.vessel.polar_performance !== 'number' || !(b.vessel.polar_performance >= 0.3 && b.vessel.polar_performance <= 1.2))
  )
    return 'vessel.polar_performance must be 0.3..1.2';
  if (b.vessel?.polar !== undefined && (typeof b.vessel.polar !== 'string' || b.vessel.polar.length > 200))
    return 'vessel.polar must be a polar token from /api/polars';
  return null;
}
