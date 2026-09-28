/**
 * Worker thread. Two instances run with different roles (protocol.ts):
 *  - data:  refreshes ECMWF + RTOFS from the network, loads the global
 *           resident forecast (SharedArrayBuffer fields), keeps the
 *           current stack and the on-demand overlay land masks, and
 *           answers overlay / conditions queries;
 *  - route: runs the propagator on the same forecast memory (relayed by
 *           the main thread, not copied), with its own current stack
 *           loaded from the disk cache (no network), so a long route
 *           never delays an overlay query.
 * Cancellation of the running route is a shared Int32 flag.
 */

import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ATM_PARAMS, EcmwfClient, ECMWF_MIRRORS, WAVE_PARAMS, availableSteps, latestExpectedCycle, cycleFor, type Cycle } from '../data/ecmwf';
import { ForecastStore } from '../data/forecast';
import { loadForecastForBBox, loadGlobalForecast, resolveCycle, type ResolvedCycle } from '../data/loader';
import { bboxFromLonLat, bboxWidth, bboxHeight, type BBox } from '../geo/geodesy';
import { LandMask } from '../geo/landmask';
import { OnDemandLand } from '../geo/landcache';
import { releaseMemory } from '../util/gc';
import { NoCurrent, NoWind, type CurrentSource } from '../engine/environment';
import { OceanPropagator, RouteCancelled } from '../engine/propagator';
import { routeToGeoJSON, routeToSignalKRoute, skeletonToGeoJSON } from '../engine/route';
import { PolarDiagram } from '../vessel/polar';
import { loadPolarCached, resolvePolarPath } from './polars';
import { HarmonicCurrentSource } from '../currents/harmonic';
import { CurrentStack } from '../currents/stack';
import { RtofsClient, RtofsCurrentSource, loadRtofsSteps, rtofsRunFor, type RtofsRun } from '../currents/rtofs';
import type { CurrentSourceLike } from '../currents/types';
import { conditionsSeries, conditionsTilePoints, currentPoints, fieldGrid, pressureFeatures, windPoints, type FieldLayer, type OverlaySources } from './overlays';
import { routeVessel, type ResolvedConfig } from './config';
import type { DataStatus, MainToWorker, QueryArgs, RouteRequest, RouteSummary, WorkerRole, WorkerToMain } from './protocol';

if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;
const cancelFlag = new Int32Array(workerData.cancelFlag as SharedArrayBuffer);
const role: WorkerRole = workerData.role as WorkerRole;

/** ECMWF open-data short names; 2 m dew point is `2d` in the index files. */
const EXTRA_ATM = ['2t', 'tprate', 'skt', '2d', 'ptype'];

let config: ResolvedConfig | null = null;
let client: EcmwfClient | null = null;
let rtofsClient: RtofsClient | null = null;
/** Resident global forecast (shared memory; loaded here in the data worker, adopted in the route worker). */
let store: ForecastStore | null = null;
/** On-demand overlay land rasters (data worker). */
let overlayLand: OnDemandLand | null = null;
let polar: PolarDiagram | null = null;
let landCache: { key: string; mask: LandMask } | null = null;
let harmonic: HarmonicCurrentSource[] = [];
let rtofs: RtofsCurrentSource | null = null;
let stack: CurrentStack = new CurrentStack([]);
/** overlayLand.builds when data-status was last sent. */
let reportedLandBuilds = 0;
/** Plugin data directory (cache root). */
let cacheRoot = '';

const send = (m: WorkerToMain): void => port.postMessage(m);
const log = (level: 'debug' | 'info' | 'error', message: string): void => send({ type: 'log', level, message: `[${role}] ${message}` });

function requireInit(): { config: ResolvedConfig; client: EcmwfClient } {
  if (!config || !client) throw new Error('worker not initialised');
  return { config, client };
}

function extraParams(cfg: ResolvedConfig): string[] {
  return cfg.forecast.extraFields ? EXTRA_ATM : [];
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

function rebuildStack(): void {
  const sources: CurrentSourceLike[] = [...harmonic];
  if (rtofs) sources.push(rtofs);
  stack = new CurrentStack(sources);
}

function currentsStatus(): DataStatus['currents'] {
  return stack.sources.map((s) => ({
    name: s.name, priority: s.priority, resolutionM: s.resolutionM, bbox: s.bbox,
    validFrom: s instanceof RtofsCurrentSource ? s.validRange[0].toISOString() : undefined,
    validTo: s instanceof RtofsCurrentSource ? s.validRange[1].toISOString() : undefined,
  }));
}

function sendCurrents(): void {
  send({ type: 'currents', status: currentsStatus(), rtofsRun: rtofs ? new Date(rtofs.runMs).toISOString().slice(0, 10) : null, rtofs: null });
}

function loadHarmonic(dir: string | null): void {
  harmonic = [];
  if (!dir) return;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.npz')).sort();
  } catch (err) {
    log('error', `currents: cannot read harmonic directory ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const t = Date.now();
      const s = new HarmonicCurrentSource(p);
      harmonic.push(s);
      log('info', `currents: ${s.name}: ${s.constituents.length} constituents${s.dropped.length ? ` (dropped ${s.dropped.join(', ')})` : ''}, ${s.lats.length}×${s.lons.length} grid, priority ${s.priority}, ${Date.now() - t} ms`);
    } catch (err) {
      log('error', `currents: failed to load ${p}: ${(err as Error).message}`);
    }
  }
}

async function refreshRtofs(networkAllowed: boolean): Promise<void> {
  const { config: cfg } = requireInit();
  if (!cfg.currents.rtofsEnabled || !rtofsClient) return;
  const horizon = cfg.currents.rtofsHorizonHours;
  let run: RtofsRun | null = null;
  const cachedRuns = rtofsClient.cachedRuns().filter((r) => rtofsClient!.runFullyCached(r, horizon));
  if (networkAllowed) {
    // Fresh enough already? The daily run appears during the morning;
    // if today's run is cached there is nothing to do.
    const today = rtofsRunFor(new Date());
    if (rtofsClient.runFullyCached(today, horizon)) run = today;
    else {
      try {
        run = await rtofsClient.findLatestRun(horizon);
      } catch (err) {
        log('error', `rtofs: ${(err as Error).message}`);
        run = cachedRuns[0] ?? null;
      }
    }
  } else {
    run = cachedRuns[0] ?? null;
  }
  if (!run) {
    if (rtofs) log('info', 'rtofs: keeping the resident run');
    return;
  }
  if (rtofs && rtofs.runMs === run.time.getTime()) return;
  try {
    const t = Date.now();
    // The whole configured RTOFS product (cfg.currents.rtofsRegion), uncropped.
    const steps = await loadRtofsSteps(rtofsClient, run, null, horizon, cfg.currents.rtofsStepHours, { log: (m) => log('debug', m) });
    if (steps.length === 0) throw new Error(`run ${run.yyyymmdd} has no steps in product ${rtofsClient.region}`);
    const g = steps[0].u;
    const extent = { south: g.lat0, west: g.lon0, north: g.lat0 + (g.nLat - 1) * g.dLat, east: g.lon0 + (g.nLon - 1) * g.dLon };
    rtofs = new RtofsCurrentSource(`RTOFS-${rtofsClient.region}`, run.time.getTime(), extent, steps);
    rebuildStack();
    log('info', `rtofs: run ${run.yyyymmdd}, ${steps.length} steps, ${(rtofs.bytes() / 1e6).toFixed(1)} MB resident, ${((Date.now() - t) / 1000).toFixed(1)} s`);
    if (networkAllowed) rtofsClient.pruneCache([run, ...cachedRuns.slice(0, 1)]);
  } catch (err) {
    log('error', `rtofs: load failed: ${(err as Error).message}`);
  }
}

/** Parameters the configured forecast holds (atmosphere + waves). */
function wantedParams(cfg: ResolvedConfig): string[] {
  return [...ATM_PARAMS, ...extraParams(cfg), ...WAVE_PARAMS];
}

/** Is the resident store this cycle (or newer), with the configured horizon and field set? */
function residentMatches(cfg: ResolvedConfig, c: Cycle): boolean {
  if (!store || !store.global) return false;
  const steps = availableSteps(cycleFor(store.meta.cycleTime).atmStream, cfg.forecast.horizonHours).length;
  const want = new Set(wantedParams(cfg));
  const have = new Set(store.meta.params);
  const sameParams = want.size === have.size && [...want].every((p) => have.has(p));
  return store.meta.cycleTime.getTime() >= c.time.getTime() && store.steps.length === steps && sameParams;
}

/**
 * Refresh currents (both roles) and, in the data worker, the global
 * forecast. The route worker never loads a forecast itself: the main
 * thread relays the data worker's (shared memory).
 */
async function refresh(force: boolean): Promise<void> {
  const networkAllowed = role === 'data';
  await refreshRtofs(networkAllowed);
  sendCurrents();
  if (role === 'data') await refreshForecast(force);
}

async function refreshForecast(force: boolean): Promise<void> {
  const { config: cfg, client: cl } = requireInit();
  const horizon = cfg.forecast.horizonHours;
  const expected = latestExpectedCycle(new Date(), horizon);
  if (!force && residentMatches(cfg, expected)) {
    send({ type: 'forecast-unchanged', cycleTimeMs: store!.meta.cycleTime.getTime() });
    return;
  }
  let resolved: ResolvedCycle;
  try {
    resolved = await resolveCycle(cl, horizon, { extraAtmParams: extraParams(cfg), log: (m) => log('info', `forecast: ${m}`) });
  } catch (err) {
    send({ type: 'refresh-error', message: (err as Error).message });
    return;
  }
  const cycle = resolved.cycle;
  if (!force && residentMatches(cfg, cycle)) {
    send({ type: 'forecast-unchanged', cycleTimeMs: store!.meta.cycleTime.getTime() });
    return;
  }
  const t = Date.now();
  try {
    // The previous store stays resident (and serving queries) until the
    // new one is complete, so peak memory during a reload is two stores.
    const next = await loadGlobalForecast(cl, {
      horizonHours: horizon, cycle, extraAtmParams: extraParams(cfg),
      log: (m) => log('debug', `forecast: ${m}`),
      onStep: (done, total) => {
        if (done === 1 || done % 5 === 0 || done === total) log('debug', `forecast: decoded step ${done}/${total}`);
      },
    });
    store = next;
    // Drop the previous store (and the decode buffers) in this isolate now.
    const gcMs = releaseMemory();
    if (gcMs !== null) log('debug', `forecast: previous store released (gc ${gcMs} ms)`);
    log('info', `forecast global: cycle ${cycle.yyyymmdd} ${cycle.hh}z${resolved.fromCache ? ' (from disk cache)' : ''}, ${next.steps.length} steps, ${next.meta.params.join('/')}, ${(next.bytes() / 1e6).toFixed(1)} MB resident${next.shared ? ' (shared)' : ''}, ${((Date.now() - t) / 1000).toFixed(1)} s`);
    send({ type: 'forecast', forecast: next.serialize() });
    try {
      cl.pruneCache(keepCycles(cycle, cfg.forecast.keepCycles));
    } catch (err) {
      log('error', `cache prune failed: ${(err as Error).message}`);
    }
  } catch (err) {
    send({ type: 'refresh-error', message: (err as Error).message });
  }
}

function keepCycles(current: Cycle, n: number): Cycle[] {
  const out: Cycle[] = [];
  for (let i = 0; i < n; i++) out.push(cycleFor(new Date(current.time.getTime() - i * 6 * 3600_000)));
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

async function route(id: string, request: RouteRequest): Promise<void> {
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

    const vessel = routeVessel(cfg, request.vessel);
    // Per-route polar: a library token from GET /api/polars, else the configured default.
    let routePolar: PolarDiagram | null = polar;
    let polarLabel: string | null = cfg.polarFile ? path.basename(cfg.polarFile) : null;
    if (request.vessel?.polar) {
      const file = resolvePolarPath({ polarFile: cfg.polarFile, polarsDir: cfg.polarsDir }, request.vessel.polar);
      if (file) {
        routePolar = loadPolarCached(file);
        polarLabel = path.basename(file);
        log('info', `job ${id}: polar ${polarLabel} (${routePolar.twa.length} TWA × ${routePolar.tws.length} TWS)`);
      }
    }

    const land = landMaskFor(bbox, cfg.routing.landRasterMaxCells, cfg.landShapefiles);
    if (shouldCancel()) throw new RouteCancelled();

    let wind: ForecastStore | NoWind = new NoWind();
    let cycleLabel: string | undefined;
    if (!request.no_forecast && request.mode !== 'motor') {
      if (store) {
        // The shared global resident forecast covers any route.
        wind = store;
      } else {
        // First boot: the data worker has not finished loading yet.
        progress(0, 0, 'resident forecast not loaded yet; decoding a route-specific forecast crop from the disk cache');
        const cycle = (await resolveCycle(cl, cfg.forecast.horizonHours, { extraAtmParams: extraParams(cfg), log: (m) => log('info', `job ${id} forecast: ${m}`) })).cycle;
        wind = await loadForecastForBBox(cl, bbox, {
          horizonHours: cfg.forecast.horizonHours, cycle, extraAtmParams: extraParams(cfg), shouldCancel, log: (m) => log('debug', `job ${id} forecast: ${m}`),
        });
      }
      cycleLabel = (wind as ForecastStore).meta.cycleTime.toISOString();
    } else if (request.mode !== 'motor' && request.no_forecast) {
      progress(0, 0, 'no_forecast set: routing with calm wind');
    }
    const current: CurrentSource = request.no_currents || stack.isEmpty ? new NoCurrent() : stack;
    if (!stack.isEmpty && !request.no_currents) progress(0, 0, `currents: ${stack.sources.map((s) => s.name).join(' > ')}`);

    const departure = request.departure ? new Date(request.departure) : new Date();
    const prop = new OceanPropagator(land, {
      stages: request.stages ?? cfg.routing.stages, subsectors: cfg.routing.subsectors, headings: cfg.routing.headings, headingIncrementDeg: cfg.routing.headingIncrementDeg,
    });
    const t = Date.now();
    const result = prop.computeRoute({
      start, end, departureTime: departure, vessel, polar: routePolar,
      wind: wind instanceof NoWind ? undefined : wind, current,
      modePolicy: request.mode ?? 'sail_max',
      sailThreshMs: request.sail_thresh_ms ?? cfg.routing.sailThreshMs,
      simStepM: cfg.routing.simStepM,
      vias: vias.length ? vias : undefined,
      onProgress: progress, shouldCancel,
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
    if (current instanceof CurrentStack) result.currentSources = current.sources.map((s) => s.name);
    const name = request.name && request.name.trim()
      ? request.name.trim()
      : `${cfg.publish.routeNamePrefix} ${request.start.lat.toFixed(2)},${request.start.lon.toFixed(2)} → ${request.end.lat.toFixed(2)},${request.end.lon.toFixed(2)}`;
    const wps = result.waypoints;
    const summary: RouteSummary = {
      total_distance_m: result.totalDistanceM, total_time_s: result.totalTimeS, sailing_time_s: result.sailingTimeS, motoring_time_s: result.motoringTimeS,
      waypoint_count: wps.length, warnings: result.warnings?.length ?? 0,
      departure: wps[0].time.toISOString(), arrival: wps[wps.length - 1].time.toISOString(),
      forecast_cycle: cycleLabel, current_sources: result.currentSources, polar: polarLabel,
    };
    log('info', `job ${id}: ${wps.length} waypoints, ${(result.totalDistanceM / 1852).toFixed(1)} nm, ${(result.totalTimeS / 3600).toFixed(1)} h, ${Date.now() - t} ms`);
    send({ type: 'done', id, geojson: routeToGeoJSON(result), skRoute: routeToSignalKRoute(result, name), skeleton: skeletonToGeoJSON(result), summary });
  } catch (err) {
    if (err instanceof RouteCancelled || shouldCancel()) send({ type: 'error', id, message: 'cancelled', cancelled: true });
    else send({ type: 'error', id, message: (err as Error).message });
  }
}

function overlaySources(): OverlaySources {
  return { forecast: store, currents: stack.isEmpty ? null : stack, land: overlayLand };
}

function query(id: number, kind: string, args: QueryArgs[keyof QueryArgs]): void {
  try {
    const src = overlaySources();
    let result: unknown;
    switch (kind) {
      case 'field': {
        const a = args as QueryArgs['field'];
        result = fieldGrid(src, a.layer as FieldLayer, a.bbox, new Date(a.timeMs), a.res);
        break;
      }
      case 'currents': {
        const a = args as QueryArgs['currents'];
        result = currentPoints(src, a.bbox, new Date(a.timeMs), a.res);
        break;
      }
      case 'wind_points': {
        const a = args as QueryArgs['wind_points'];
        result = windPoints(src, a.bbox, new Date(a.timeMs), a.res);
        break;
      }
      case 'conditions': {
        const a = args as QueryArgs['conditions'];
        result = conditionsSeries(src, a.lon, a.lat, new Date(a.fromMs), a.hours, a.stepH);
        break;
      }
      case 'conditions_tile': {
        const a = args as QueryArgs['conditions_tile'];
        result = conditionsTilePoints(src, a.z, a.x, a.y, new Date(a.timeMs));
        break;
      }
      case 'pressure': {
        const a = args as QueryArgs['pressure'];
        result = pressureFeatures(src, a.bbox, new Date(a.timeMs), a.intervalHpa);
        break;
      }
      default:
        throw new Error(`unknown query kind ${kind}`);
    }
    send({ type: 'query-result', id, result });
    // A new overlay land raster was built: refresh the status the main thread reports.
    if (overlayLand && overlayLand.builds !== reportedLandBuilds) {
      reportedLandBuilds = overlayLand.builds;
      send({ type: 'data-status', status: dataStatus() });
    }
  } catch (err) {
    send({ type: 'query-error', id, message: (err as Error).message });
  }
}

function dataStatus(): DataStatus {
  return {
    forecast: store ? {
      cycle: store.meta.cycleTime.toISOString(), validFrom: store.validRange[0].toISOString(), validTo: store.validRange[1].toISOString(),
      steps: store.steps.length, params: store.meta.params, global: store.global, bytes: store.bytes(), shared: store.shared, hasWaves: store.hasWaves, loadedAt: store.meta.loadedAt.toISOString(),
    } : null,
    currents: currentsStatus(),
    rtofsRun: rtofs ? new Date(rtofs.runMs).toISOString().slice(0, 10) : null,
    land: overlayLand ? overlayLand.stats() : null,
  };
}

async function handle(msg: MainToWorker): Promise<void> {
  switch (msg.type) {
    case 'init': {
      config = msg.config;
      cacheRoot = msg.cacheDir;
      client = new EcmwfClient({
        baseUrl: ECMWF_MIRRORS[config.forecast.mirror] ?? ECMWF_MIRRORS.ecmwf,
        cacheDir: path.join(msg.cacheDir, 'ecmwf'),
        log: (m) => log('debug', `ecmwf: ${m}`),
      });
      rtofsClient = config.currents.rtofsEnabled
        ? new RtofsClient({ cacheDir: path.join(msg.cacheDir, 'rtofs'), region: config.currents.rtofsRegion, log: (m) => log('debug', m) })
        : null;
      polar = null;
      if (config.polarFile) {
        polar = PolarDiagram.load(config.polarFile);
        if (role === 'route') log('info', `polar loaded: ${config.polarFile} (${polar.twa.length} TWA rows × ${polar.tws.length} TWS columns)`);
      } else if (role === 'route') {
        log('info', 'no polar configured: routes will be motor-only');
      }
      if (config.landShapefiles.length === 0) throw new Error('no land shapefile configured');
      overlayLand = role === 'data' ? new OnDemandLand(config.landShapefiles, { log: (m) => log('debug', m) }) : null;
      loadHarmonic(config.currents.harmonicDir);
      rebuildStack();
      send({ type: 'ready', role });
      return;
    }
    case 'refresh':
      await refresh(msg.force ?? false);
      send({ type: 'data-status', status: dataStatus() });
      return;
    case 'forecast': {
      store = ForecastStore.deserialize(msg.forecast);
      // Release this isolate's hold on the previous store (a running
      // route keeps its own reference until it finishes; see route()).
      releaseMemory();
      log('info', `adopted the resident forecast: cycle ${store.meta.cycleTime.toISOString().slice(0, 13)}Z, ${store.steps.length} steps, ${(store.bytes() / 1e6).toFixed(1)} MB ${store.shared ? 'shared (no copy)' : 'copied'}`);
      if (role === 'data') send({ type: 'data-status', status: dataStatus() });
      return;
    }
    case 'config': {
      const prev = requireInit().config;
      config = msg.config;
      if (msg.reload.currents) {
        rtofsClient = config.currents.rtofsEnabled
          ? new RtofsClient({ cacheDir: rtofsClient?.cacheDir ?? path.join(cacheRoot, 'rtofs'), region: config.currents.rtofsRegion, log: (m) => log('debug', m) })
          : null;
        rtofs = null;
        rebuildStack();
        await refreshRtofs(role === 'data');
        sendCurrents();
        log('info', `currents reloaded for the new settings (RTOFS ${config.currents.rtofsEnabled ? config.currents.rtofsRegion : 'off'})`);
      }
      if (msg.reload.forecast && role === 'data') {
        log('info', `forecast settings changed (horizon ${prev.forecast.horizonHours} → ${config.forecast.horizonHours} h, extra fields ${prev.forecast.extraFields} → ${config.forecast.extraFields}); reloading`);
        await refreshForecast(false);
      }
      if (role === 'data') send({ type: 'data-status', status: dataStatus() });
      return;
    }
    case 'route':
      if (role !== 'route') {
        send({ type: 'error', id: msg.id, message: 'route sent to the data worker' });
        return;
      }
      {
        const before = store;
        await route(msg.id, msg.request);
        // A new forecast arrived while the route ran on the previous one:
        // the route's reference is gone now, so let that store go.
        if (before && before !== store) releaseMemory();
      }
      return;
    case 'query':
      query(msg.id, msg.kind, msg.args);
      return;
    case 'shutdown':
      process.exit(0);
  }
}

let chain: Promise<void> = Promise.resolve();
port.on('message', (msg: MainToWorker) => {
  chain = chain.then(() => handle(msg)).catch((err) => {
    log('error', `worker: ${(err as Error).stack ?? (err as Error).message}`);
    if (msg.type === 'route') send({ type: 'error', id: msg.id, message: (err as Error).message });
    if (msg.type === 'refresh') send({ type: 'refresh-error', message: (err as Error).message });
    if (msg.type === 'query') send({ type: 'query-error', id: msg.id, message: (err as Error).message });
  });
});
