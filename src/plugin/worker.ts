/**
 * Routing worker thread. Owns the ECMWF client, decodes forecasts,
 * builds land masks and runs the propagator, so the Signal K event loop
 * never blocks on CPU work. Talks to the plugin through the messages in
 * protocol.ts. Cancellation of the running job is signalled through a
 * shared Int32 flag handed over in workerData.
 */

import { parentPort, workerData } from 'node:worker_threads';
import * as path from 'node:path';
import { EcmwfClient, ECMWF_MIRRORS, availableSteps, latestExpectedCycle, type Cycle } from '../data/ecmwf';
import { ForecastStore } from '../data/forecast';
import { loadForecastForBBox, resolveCycle, type ResolvedCycle } from '../data/loader';
import { bboxFromLonLat, bboxWidth, bboxHeight, type BBox } from '../geo/geodesy';
import { LandMask } from '../geo/landmask';
import { NoWind } from '../engine/environment';
import { OceanPropagator, RouteCancelled } from '../engine/propagator';
import { routeToGeoJSON, routeToSignalKRoute } from '../engine/route';
import { PolarDiagram } from '../vessel/polar';
import { makeVessel } from '../vessel/vessel';
import type { ResolvedConfig } from './config';
import type { MainToWorker, RouteRequest, RouteSummary, WorkerToMain } from './protocol';

if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;
const cancelFlag = new Int32Array(workerData.cancelFlag as SharedArrayBuffer);

let config: ResolvedConfig | null = null;
let client: EcmwfClient | null = null;
let regionStore: ForecastStore | null = null;
let regionBBox: BBox | null = null;
let polar: PolarDiagram | null = null;
let landCache: { key: string; mask: LandMask } | null = null;

const send = (m: WorkerToMain): void => port.postMessage(m);
const log = (level: 'debug' | 'info' | 'error', message: string): void => send({ type: 'log', level, message });

function requireInit(): { config: ResolvedConfig; client: EcmwfClient } {
  if (!config || !client) throw new Error('worker not initialised');
  return { config, client };
}

function landMaskFor(bbox: BBox, maxCells: number, shapefiles: string[]): LandMask {
  const res = LandMask.chooseResolution(bbox, maxCells);
  const key = `${shapefiles.join('|')}|${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}|${res}`;
  if (landCache && landCache.key === key) return landCache.mask;
  const t = Date.now();
  const mask = LandMask.fromShapefiles(shapefiles, bbox, { resolutionDeg: res });
  log('info', `land mask: ${mask.shapes.length} polygons, ${mask.nx}x${mask.ny} cells at ${res}° (${((mask.nx * mask.ny) / 1e6).toFixed(1)}M), ${Date.now() - t} ms`);
  landCache = { key, mask };
  return mask;
}

async function refresh(region: BBox | null, force: boolean): Promise<void> {
  const { config: cfg, client: cl } = requireInit();
  const bbox = region;
  if (!bbox) {
    send({ type: 'refresh-error', message: 'no forecast region available yet (no vessel position and no explicit region configured)' });
    return;
  }
  const horizon = cfg.forecast.horizonHours;
  const sameRegion = !!regionBBox && Math.abs(regionBBox.west - bbox.west) < 1e-9 && Math.abs(regionBBox.east - bbox.east) < 1e-9
    && Math.abs(regionBBox.south - bbox.south) < 1e-9 && Math.abs(regionBBox.north - bbox.north) < 1e-9;
  const residentSteps = availableSteps(regionStore ? cycleFromTime(regionStore.meta.cycleTime).atmStream : 'oper', horizon).length;
  const residentCurrent = (c: Cycle): boolean =>
    !!regionStore && sameRegion && regionStore.meta.cycleTime.getTime() >= c.time.getTime() && regionStore.steps.length >= residentSteps;

  // 1. Wall-clock rule (as the planner): if the resident forecast is
  //    already from the cycle that should be the newest published one,
  //    do nothing and make no request.
  const expected = latestExpectedCycle(new Date(), horizon);
  if (!force && residentCurrent(expected)) {
    send({ type: 'forecast-unchanged', cycleTimeMs: regionStore!.meta.cycleTime.getTime() });
    return;
  }

  // 2. Pick the cycle: fully cached expected cycle → no network; else ask
  //    the server; else the newest fully cached cycle.
  let resolved: ResolvedCycle;
  try {
    resolved = await resolveCycle(cl, horizon, { log: (m) => log('info', `forecast: ${m}`) });
  } catch (err) {
    send({ type: 'refresh-error', message: (err as Error).message });
    return;
  }
  const cycle = resolved.cycle;
  if (!force && residentCurrent(cycle)) {
    send({ type: 'forecast-unchanged', cycleTimeMs: regionStore!.meta.cycleTime.getTime() });
    return;
  }

  const t = Date.now();
  try {
    const store = await loadForecastForBBox(cl, bbox, {
      horizonHours: horizon,
      cycle,
      log: (m) => log('debug', `forecast: ${m}`),
      onStep: (done, total) => {
        if (done === 1 || done % 5 === 0 || done === total) log('debug', `forecast: decoded step ${done}/${total}`);
      },
    });
    regionStore = store;
    regionBBox = bbox;
    log('info', `forecast region ${bbox.west.toFixed(1)}..${bbox.east.toFixed(1)} × ${bbox.south.toFixed(1)}..${bbox.north.toFixed(1)}: cycle ${cycle.yyyymmdd} ${cycle.hh}z${resolved.fromCache ? ' (from disk cache)' : ''}, ${store.steps.length} steps, ${(store.bytes() / 1024).toFixed(0)} kB resident, ${((Date.now() - t) / 1000).toFixed(1)} s`);
    send({ type: 'forecast', forecast: store.serialize() });
    try {
      cl.pruneCache(keepCycles(cycle, cfg.forecast.keepCycles));
    } catch (err) {
      log('error', `cache prune failed: ${(err as Error).message}`);
    }
  } catch (err) {
    send({ type: 'refresh-error', message: (err as Error).message });
  }
}

/** The current cycle plus the preceding (n-1) six-hourly cycles. */
function keepCycles(current: Cycle, n: number): Cycle[] {
  const out: Cycle[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(current.time.getTime() - i * 6 * 3600_000);
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const yyyymmdd = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
    const main = hh === '00' || hh === '12';
    out.push({ time: t, yyyymmdd, hh, atmStream: main ? 'oper' : 'scda', waveStream: main ? 'wave' : 'scwv' });
  }
  return out;
}

function validateRequest(r: RouteRequest): void {
  const pt = (p: { lat: number; lon: number } | undefined, name: string): void => {
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      throw new Error(`${name} must be {lat, lon} numbers`);
    }
    if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 360) throw new Error(`${name} out of range`);
  };
  pt(r.start, 'start');
  pt(r.end, 'end');
  (r.waypoints ?? []).forEach((w, i) => pt(w, `waypoints[${i}]`));
  if (r.mode && !['sail_max', 'fastest', 'motor'].includes(r.mode)) throw new Error(`mode must be sail_max, fastest or motor (got ${r.mode})`);
  if (r.departure && Number.isNaN(Date.parse(r.departure))) throw new Error(`departure "${r.departure}" is not an ISO 8601 date`);
}

async function route(id: string, request: RouteRequest, region: BBox | null): Promise<void> {
  const { config: cfg, client: cl } = requireInit();
  Atomics.store(cancelFlag, 0, 0);
  const shouldCancel = (): boolean => Atomics.load(cancelFlag, 0) === 1;
  const progress = (stage: number, total: number, message: string): void => send({ type: 'progress', id, stage, total, message });
  try {
    validateRequest(request);
    const start: [number, number] = [request.start.lon, request.start.lat];
    const end: [number, number] = [request.end.lon, request.end.lat];
    const vias = (request.waypoints ?? []).map((w) => ({ lon: w.lon, lat: w.lat, radiusM: w.radius_m ?? 500 }));
    const pts = [start, end, ...vias.map((v) => [v.lon, v.lat] as [number, number])];
    const bbox = bboxFromLonLat(pts.map((p) => p[0]), pts.map((p) => p[1]), 1.0);
    if (bboxWidth(bbox) > 120 || bboxHeight(bbox) > 90) throw new Error('route bounding box is too large (max 120° × 90°)');

    const vessel = makeVessel({
      ...cfg.vessel,
      name: request.vessel?.name ?? cfg.vessel.name,
      draught: request.vessel?.draught,
      airDraft: request.vessel?.air_draft,
      loa: request.vessel?.loa,
      beam: request.vessel?.beam,
      motorSpeedMs: request.vessel?.motor_speed_ms,
      underKeelClearance: request.vessel?.under_keel_clearance,
    });

    const land = landMaskFor(bbox, cfg.routing.landRasterMaxCells, cfg.landShapefiles);
    if (shouldCancel()) throw new RouteCancelled();

    // Forecast: reuse the resident region store when it covers the
    // route, otherwise decode a route-specific crop from the disk cache.
    let wind: ForecastStore | NoWind = new NoWind();
    let cycleLabel: string | undefined;
    if (!request.no_forecast && request.mode !== 'motor') {
      if (regionStore && regionStore.coversBBox(bbox)) {
        wind = regionStore;
      } else {
        progress(0, 0, 'route extends beyond the resident forecast region; decoding a route-specific forecast crop');
        const cycle = regionStore
          ? cycleFromTime(regionStore.meta.cycleTime)
          : (await resolveCycle(cl, cfg.forecast.horizonHours, { log: (m) => log('info', `job ${id} forecast: ${m}`) })).cycle;
        wind = await loadForecastForBBox(cl, bbox, {
          horizonHours: cfg.forecast.horizonHours,
          cycle,
          shouldCancel,
          log: (m) => log('debug', `job ${id} forecast: ${m}`),
        });
      }
      cycleLabel = (wind as ForecastStore).meta.cycleTime.toISOString();
    } else if (request.mode !== 'motor' && request.no_forecast) {
      progress(0, 0, 'no_forecast set: routing with calm wind');
    }
    if (region === null && !(wind instanceof NoWind)) {
      // nothing else to do; region only matters for reuse
    }

    const departure = request.departure ? new Date(request.departure) : new Date();
    const prop = new OceanPropagator(land, {
      stages: request.stages ?? cfg.routing.stages,
      subsectors: cfg.routing.subsectors,
      headings: cfg.routing.headings,
      headingIncrementDeg: cfg.routing.headingIncrementDeg,
    });
    const t = Date.now();
    const result = prop.computeRoute({
      start, end, departureTime: departure, vessel, polar,
      wind: wind instanceof NoWind ? undefined : wind,
      modePolicy: request.mode ?? 'sail_max',
      sailThreshMs: request.sail_thresh_ms ?? cfg.routing.sailThreshMs,
      simStepM: cfg.routing.simStepM,
      vias: vias.length ? vias : undefined,
      onProgress: progress,
      shouldCancel,
    });
    if (wind instanceof ForecastStore) {
      const lastValid = wind.validRange[1].getTime();
      const arrival = result.waypoints[result.waypoints.length - 1].time.getTime();
      if (arrival > lastValid) {
        result.forecastHorizonExceededS = (arrival - lastValid) / 1000;
        progress(0, 0, `WARNING: arrival is ${((arrival - lastValid) / 3600_000).toFixed(1)} h after the last forecast step; conditions beyond it are held constant`);
      }
      result.forecastCycle = cycleLabel;
    }
    const name = request.name && request.name.trim()
      ? request.name.trim()
      : `${cfg.publish.routeNamePrefix} ${request.start.lat.toFixed(2)},${request.start.lon.toFixed(2)} → ${request.end.lat.toFixed(2)},${request.end.lon.toFixed(2)}`;
    const wps = result.waypoints;
    const summary: RouteSummary = {
      total_distance_m: result.totalDistanceM,
      total_time_s: result.totalTimeS,
      sailing_time_s: result.sailingTimeS,
      motoring_time_s: result.motoringTimeS,
      waypoint_count: wps.length,
      warnings: result.warnings?.length ?? 0,
      departure: wps[0].time.toISOString(),
      arrival: wps[wps.length - 1].time.toISOString(),
      forecast_cycle: cycleLabel,
    };
    log('info', `job ${id}: ${wps.length} waypoints, ${(result.totalDistanceM / 1852).toFixed(1)} nm, ${(result.totalTimeS / 3600).toFixed(1)} h, ${Date.now() - t} ms`);
    send({ type: 'done', id, geojson: routeToGeoJSON(result), skRoute: routeToSignalKRoute(result, name), summary });
  } catch (err) {
    if (err instanceof RouteCancelled || shouldCancel()) {
      send({ type: 'error', id, message: 'cancelled', cancelled: true });
    } else {
      send({ type: 'error', id, message: (err as Error).message });
    }
  }
}

function cycleFromTime(t: Date): Cycle {
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const yyyymmdd = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
  const main = hh === '00' || hh === '12';
  return { time: t, yyyymmdd, hh, atmStream: main ? 'oper' : 'scda', waveStream: main ? 'wave' : 'scwv' };
}

async function handle(msg: MainToWorker): Promise<void> {
  switch (msg.type) {
    case 'init': {
      config = msg.config;
      client = new EcmwfClient({
        baseUrl: ECMWF_MIRRORS[config.forecast.mirror] ?? ECMWF_MIRRORS.ecmwf,
        cacheDir: path.join(msg.cacheDir, 'ecmwf'),
        log: (m) => log('debug', `ecmwf: ${m}`),
      });
      polar = null;
      if (config.polarFile) {
        polar = PolarDiagram.load(config.polarFile);
        log('info', `polar loaded: ${config.polarFile} (${polar.twa.length} TWA rows × ${polar.tws.length} TWS columns)`);
      } else {
        log('info', 'no polar configured: routes will be motor-only');
      }
      if (config.landShapefiles.length === 0) throw new Error('no land shapefile configured');
      send({ type: 'ready' });
      return;
    }
    case 'refresh':
      await refresh(msg.region, msg.force ?? false);
      return;
    case 'route':
      await route(msg.id, msg.request, msg.region);
      return;
    case 'shutdown':
      process.exit(0);
  }
}

// Serialise message handling so one job runs at a time.
let chain: Promise<void> = Promise.resolve();
port.on('message', (msg: MainToWorker) => {
  chain = chain.then(() => handle(msg)).catch((err) => {
    log('error', `worker: ${(err as Error).stack ?? (err as Error).message}`);
    if (msg.type === 'route') send({ type: 'error', id: msg.id, message: (err as Error).message });
    if (msg.type === 'refresh') send({ type: 'refresh-error', message: (err as Error).message });
  });
});
