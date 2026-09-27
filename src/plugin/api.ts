/**
 * HTTP API mounted by Signal K at /plugins/signalk-weather-router-plus.
 *
 *   GET  /ui                    test page (GET / is reserved by Signal K)
 *   GET  /api/status            plugin, forecast and queue status
 *   GET  /api/forecast          resident forecast metadata (+ sample at ?lat=&lon=)
 *   POST /api/forecast/refresh  re-check ECMWF for a newer cycle
 *   POST /api/routes            submit a route job → 202 {id, status, links}
 *   GET  /api/routes            list jobs
 *   GET  /api/routes/:id        job status
 *   GET  /api/routes/:id/events SSE stream (honours Last-Event-ID)
 *   GET  /api/routes/:id/result GeoJSON FeatureCollection
 *   GET  /api/routes/:id/signalk Signal K Route resource body
 *   POST /api/routes/:id/cancel
 *   POST /api/routes/:id/publish save to the Resources API
 *   DELETE /api/routes/:id
 *   GET  /api/openapi.json
 *
 * Reads are opened to readonly users and writes to readwrite users when
 * the server supports `router.access()` (Signal K ≥ 2.31); on older
 * servers every route is admin-only, which is the server's default.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IRouter, Request, Response } from 'express';
import type { JobManager } from './jobs';
import type { RouteRequest } from './protocol';
import { openApiDocument } from './openapi';

export interface ApiDeps {
  pluginId: string;
  basePath: string;
  jobs: JobManager;
  status: () => Record<string, unknown>;
  forecastInfo: (lat?: number, lon?: number) => Record<string, unknown>;
  refreshForecast: (force: boolean) => void;
  cancelRunning: (id: string) => void;
  publish: (id: string) => Promise<string>;
  publicDir: string;
}

type AccessRouter = IRouter & { access?: (level: 'readonly' | 'readwrite') => IRouter };

export function registerApi(router: IRouter, deps: ApiDeps): void {
  const r = router as AccessRouter;
  const ro: IRouter = typeof r.access === 'function' ? r.access('readonly') : router;
  const rw: IRouter = typeof r.access === 'function' ? r.access('readwrite') : router;

  const json = (res: Response, code: number, body: unknown): void => {
    res.status(code).json(body);
  };

  // Signal K reserves GET /plugins/<id> for plugin metadata, so the test
  // page lives at /ui.
  router.get(['/ui', '/ui/'], (_req: Request, res: Response) => {
    const file = path.join(deps.publicDir, 'index.html');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) {
        res.status(500).send(`test page missing: ${err.message}`);
        return;
      }
      res.send(html.replace(/__BASE_PATH__/g, deps.basePath));
    });
  });

  ro.get('/api/status', (_req: Request, res: Response) => json(res, 200, deps.status()));

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
      json(res, 400, { error: (err as Error).message });
    }
  });

  rw.post('/api/forecast/refresh', (req: Request, res: Response) => {
    deps.refreshForecast(req.query.force === 'true' || req.query.force === '1');
    json(res, 202, { status: 'refresh requested' });
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
      json(res, 502, { error: (err as Error).message });
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
  return null;
}
