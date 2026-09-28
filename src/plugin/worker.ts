/**
 * Worker thread. Two instances run with different roles (protocol.ts):
 *  - data:  refreshes ECMWF, CMEMS SMOC and RTOFS from the network, loads
 *           the global resident forecast and the SMOC resident area
 *           (SharedArrayBuffers), keeps the current stack and the
 *           on-demand overlay land masks, and answers overlay /
 *           conditions queries (loading SMOC on demand first when the
 *           query box is outside what is resident);
 *  - route: runs the propagator on the same forecast and SMOC resident
 *           memory (relayed by the main thread, not copied), with RTOFS
 *           loaded from the disk cache; before a route whose box the
 *           SMOC resident area does not cover it loads that area itself
 *           (disk cache, else network), so a long route never delays an
 *           overlay query.
 * The data worker also holds the Copernicus Marine sea level (tides):
 * point series for conditions / Weather API queries (geoChunked, on
 * demand) and the tide-height map field (a resident area around the
 * vessel plus on-demand areas). The route worker does not use tides.
 * Cancellation of the running route is a shared Int32 flag.
 */

import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ATM_PARAMS, EcmwfClient, ECMWF_MIRRORS, WAVE_PARAMS, availableSteps, latestExpectedCycle, cycleFor, type Cycle } from '../data/ecmwf';
import { ForecastStore } from '../data/forecast';
import { loadForecastForBBox, loadGlobalForecast, resolveCycle, type ResolvedCycle } from '../data/loader';
import { checkForecastMemory } from './memguard';
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
import {
  alignedSteps, loadResident, residentStale, SMOC_DEFAULT_BUDGET_BYTES, SmocClient, SmocCurrentSource, type SmocRun, type SmocSettings,
} from '../currents/smoc';
import { loadTideResident, SeaLevelClient, TIDE_DEFAULT_BUDGET_BYTES, TideSource, type TideSettings } from '../tides/sealevel';
import type { ArcoRun } from '../data/arco';
import { tileLatLonBounds, type ConditionsTide } from './overlays';
import { conditionsSeries, conditionsTilePoints, currentPoints, fieldGrid, pressureFeatures, windPoints, type FieldLayer, type OverlaySources, landMaskImage } from './overlays';
import { routeVessel, type ResolvedConfig } from './config';
import type { DataStatus, MainToWorker, QueryArgs, RouteRequest, RouteSummary, TideSeriesResult, VesselPosition, WorkerRole, WorkerToMain } from './protocol';

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
let smocClient: SmocClient | null = null;
let smoc: SmocCurrentSource | null = null;
/** Last vessel position from the main thread (SMOC resident area centre). */
let vesselPos: VesselPosition | null = null;
/** Overlay / conditions queries wait at most this long for an on-demand SMOC load. */
const SMOC_QUERY_DEADLINE_MS = 60_000;
let stack: CurrentStack = new CurrentStack([]);
/** overlayLand.builds when data-status was last sent. */
let reportedLandBuilds = 0;
/** SMOC revision when data-status was last sent. */
let reportedSmocRev = -1;
/** Plugin data directory (cache root). */
let cacheRoot = '';
/** Copernicus Marine sea level (data worker only). */
let seaLevelClient: SeaLevelClient | null = null;
let tides: TideSource | null = null;
/** Last tide probe / load error (status). */
let tidesError: string | null = null;
/** Tide revision when data-status was last sent. */
let reportedTidesRev = -1;
/** Map / conditions queries wait at most this long for a tide download. */
const TIDE_QUERY_DEADLINE_MS = 60_000;

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
  if (smoc) sources.push(smoc);
  if (rtofs) sources.push(rtofs);
  stack = new CurrentStack(sources);
}

function currentsStatus(): DataStatus['currents'] {
  return stack.sources.map((s) => {
    if (s instanceof SmocCurrentSource) {
      const st = s.status();
      return {
        name: s.name, priority: s.priority, resolutionM: s.resolutionM, bbox: st.resident ? st.resident.bbox : s.bbox,
        validFrom: st.resident?.valid_from ?? undefined, validTo: st.resident?.valid_to ?? undefined, smoc: st,
      };
    }
    return {
      name: s.name, priority: s.priority, resolutionM: s.resolutionM, bbox: s.bbox,
      validFrom: s instanceof RtofsCurrentSource ? s.validRange[0].toISOString() : undefined,
      validTo: s instanceof RtofsCurrentSource ? s.validRange[1].toISOString() : undefined,
    };
  });
}

function sendCurrents(): void {
  send({ type: 'currents', status: currentsStatus(), rtofsRun: rtofs ? new Date(rtofs.runMs).toISOString().slice(0, 10) : null, rtofs: null });
}

function smocSettings(cfg: ResolvedConfig): SmocSettings {
  return { stepHours: cfg.currents.smocStepHours, horizonHours: cfg.currents.smocHorizonHours, halfWidthDeg: cfg.currents.smocHalfWidthDeg, budgetBytes: SMOC_DEFAULT_BUDGET_BYTES };
}

function makeSmocClient(cfg: ResolvedConfig): SmocClient | null {
  if (!cfg.currents.smocEnabled) return null;
  return new SmocClient({ cacheDir: path.join(cacheRoot, 'smoc'), log: (m) => log('debug', m) });
}

/** data worker → main → route worker: the run and the resident area (shared memory). */
function sendSmoc(): void {
  if (role === 'data') send({ type: 'smoc', smoc: smoc ? smoc.serialize() : null });
}

/**
 * Data worker: check the store for a new daily run (cheap: .zmetadata +
 * STAC), load the resident area around the vessel for the current
 * window when the run, the window or the position changed, and prune
 * superseded cached runs. Offline, the newest cached run is used.
 */
async function refreshSmoc(): Promise<void> {
  const { config: cfg } = requireInit();
  if (!cfg.currents.smocEnabled || !smocClient) {
    if (smoc) {
      smoc = null;
      rebuildStack();
      sendSmoc();
    }
    return;
  }
  const settings = smocSettings(cfg);
  let run: SmocRun | null = null;
  try {
    const probed = await smocClient.probe(smoc?.run ?? null);
    if (probed.settled || !smoc) {
      run = probed;
      if (!probed.settled) log('info', `smoc: the store update is still being written (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); using run ${probed.key} provisionally`);
    } else {
      log('info', `smoc: store update in progress (STAC updated ${probed.stacUpdated ?? '?'}, metadata ${probed.metadataModified ?? '?'}); keeping run ${smoc.run.key}`);
      run = smoc.run;
    }
  } catch (err) {
    log('error', `smoc: cannot reach the Copernicus Marine store: ${(err as Error).message}`);
    run = smoc?.run ?? smocClient.cachedRuns()[0] ?? null;
    if (run && !smoc) log('info', `smoc: using cached run ${run.key} (offline)`);
  }
  if (!run) return;
  // A run first loaded while its update was still being written is
  // reloaded from scratch once the update has finished (its cached
  // chunks may predate the update).
  const provisionalReplaced = !!smoc && smoc.run.key === run.key && !smoc.run.settled && run.settled;
  const newRun = !smoc || smoc.run.key !== run.key || provisionalReplaced;
  const now = Date.now();
  const steps = alignedSteps(run, now, now + settings.horizonHours * 3600_000, settings.stepHours);
  const src = newRun ? new SmocCurrentSource(run, settings, smocClient, (m) => log('info', m)) : smoc!;
  if (!newRun) src.expire(now);
  if (provisionalReplaced) smocClient.dropRun(run.key);
  if (newRun) smocClient.saveRun(run);
  const pos = vesselPos;
  let changed = newRun;
  if (pos && (newRun || residentStale(src, pos, steps))) {
    try {
      const t = Date.now();
      const res = await loadResident(smocClient, run, settings, pos, steps, { log: (m) => log('info', m) });
      if (res) {
        src.setResident(res.area, pos);
        src.noteDownload('resident area', res.stats);
        changed = true;
        log('info', `smoc: run ${run.key}: resident ${res.area.nRows}×${res.area.nCols} cells × ${steps.length} steps, ${(src.memoryBytes() / 1e6).toFixed(1)} MB resident, downloaded ${(res.stats.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      }
    } catch (err) {
      log('error', `smoc: resident area load failed: ${(err as Error).message}`);
      if (newRun && smoc) return; // keep serving the previous run
    }
  } else if (newRun && !pos) {
    log('info', `smoc: run ${run.key}: no vessel position; nothing resident, areas load on demand`);
  }
  if (newRun) {
    smoc = src;
    const removed = smocClient.pruneRuns([run.key]);
    if (removed.length) log('info', `smoc: removed superseded cached run(s) ${removed.join(', ')}`);
  }
  if (changed || newRun) {
    rebuildStack();
    sendSmoc();
  }
}

function tideSettings(cfg: ResolvedConfig): TideSettings {
  return { halfWidthDeg: cfg.tides.halfWidthDeg, horizonHours: cfg.tides.horizonHours, budgetBytes: TIDE_DEFAULT_BUDGET_BYTES };
}

function makeSeaLevelClient(cfg: ResolvedConfig): SeaLevelClient | null {
  if (role !== 'data' || !cfg.tides.enabled) return null;
  return new SeaLevelClient({ cacheDir: path.join(cacheRoot, 'sealevel'), log: (m) => log('debug', m) });
}

/**
 * Data worker: check the sea-level store for a new daily run (same
 * pattern as SMOC: .zmetadata + STAC; a run still being written is used
 * provisionally only when there is nothing else), rebuild the resident
 * tide map area when the run, the 6-hour-aligned window or the vessel
 * position changed, prune superseded cached runs. Offline, the newest
 * cached run is used.
 */
async function refreshTides(): Promise<void> {
  const { config: cfg } = requireInit();
  if (!cfg.tides.enabled || !seaLevelClient) {
    tides = null;
    tidesError = null;
    return;
  }
  const settings = tideSettings(cfg);
  let run: ArcoRun | null = null;
  try {
    const probed = await seaLevelClient.probe(tides?.run ?? null);
    if (probed.settled || !tides) {
      run = probed;
      if (!probed.settled) log('info', `tides: the store update is still being written (STAC updated ${probed.stacUpdated ?? '?'}); using run ${probed.key} provisionally`);
    } else {
      log('info', `tides: store update in progress (STAC updated ${probed.stacUpdated ?? '?'}); keeping run ${tides.run.key}`);
      run = tides.run;
    }
    tidesError = null;
  } catch (err) {
    tidesError = `cannot reach the Copernicus Marine sea-level store: ${(err as Error).message}`;
    log('error', `tides: ${tidesError}`);
    run = tides?.run ?? seaLevelClient.cachedRuns()[0] ?? null;
    if (run && !tides) log('info', `tides: using cached run ${run.key} (offline)`);
  }
  if (!run) return;
  const provisionalReplaced = !!tides && tides.run.key === run.key && !tides.run.settled && run.settled;
  const newRun = !tides || tides.run.key !== run.key || provisionalReplaced;
  const now = Date.now();
  const src = newRun ? new TideSource(run, settings, seaLevelClient, (m) => log('info', m)) : tides!;
  if (!newRun) src.expire(now);
  if (provisionalReplaced) seaLevelClient.dropRun(run.key);
  if (newRun) seaLevelClient.saveRun(run);
  const steps = src.windowSteps(now);
  const pos = vesselPos;
  if (pos && (newRun || src.residentStale(pos, steps))) {
    try {
      const t = Date.now();
      const res = await loadTideResident(seaLevelClient, run, settings, pos, steps, { log: (m) => log('info', m) });
      if (res) {
        src.setResident(res.area, pos);
        src.noteDownload('resident tide area', res.stats);
        log('info', `tides: run ${run.key}: resident ${res.area.nRows}×${res.area.nCols} cells × ${steps.length} hourly steps, ${(src.memoryBytes() / 1e6).toFixed(1)} MB, downloaded ${(res.stats.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      }
    } catch (err) {
      tidesError = `resident tide area load failed: ${(err as Error).message}`;
      log('error', `tides: ${tidesError}`);
      if (newRun && tides) return; // keep serving the previous run
    }
  } else if (newRun && !pos) {
    log('info', `tides: run ${run.key}: no vessel position; nothing resident, map areas load on demand`);
  }
  if (newRun) {
    tides = src;
    const removed = seaLevelClient.pruneRuns([run.key]);
    if (removed.length) log('info', `tides: removed superseded cached run(s) ${removed.join(', ')}`);
  }
}

/** Before a tide map query: load the view's hour on demand when not resident (bounded wait). */
async function prepareTidesForQuery(kind: string, args: QueryArgs[keyof QueryArgs]): Promise<void> {
  if (!tides || kind !== 'field') return;
  const a = args as QueryArgs['field'];
  if (a.layer !== 'tide') return;
  const steps = tides.bracketSteps(a.timeMs);
  if (!steps.length) return;
  try {
    await tides.ensure(a.bbox, steps, { reason: 'tide map query', deadlineMs: TIDE_QUERY_DEADLINE_MS, coarseOk: a.res >= 0.25 });
  } catch (err) {
    log('error', (err as Error).message);
  }
}

/** A promise with a deadline: rejects with `message` when it takes longer (the work itself continues). */
function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const d = new Promise<never>((_r, rej) => {
    timer = setTimeout(() => rej(new Error(message)), ms);
  });
  return Promise.race([p, d]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Tide point series for a conditions query (null when tides are off). */
async function conditionsTide(a: QueryArgs['conditions']): Promise<ConditionsTide | null> {
  if (!config?.tides.enabled) return null;
  if (!tides) return { series: null, error: tidesError ?? 'tide data not loaded yet' };
  try {
    const p = tides.pointSeries(a.lat, a.lon, a.fromMs, a.fromMs + a.hours * 3600_000, { reason: 'conditions query' });
    p.catch(() => undefined);
    const series = await withDeadline(p, TIDE_QUERY_DEADLINE_MS, 'tide series still downloading; try again shortly');
    return { series, error: series ? null : 'outside the sea-level grid or its time range' };
  } catch (err) {
    log('error', `tides: conditions query: ${(err as Error).message}`);
    return { series: null, error: (err as Error).message };
  }
}

/** Point series for the Weather API (structured-cloneable). */
async function tideSeriesQuery(a: QueryArgs['tide_series']): Promise<TideSeriesResult> {
  const empty = (error: string): TideSeriesResult => ({ run: null, t0Ms: 0, stepMs: 3600_000, waterLevel: new Float64Array(0), tide: new Float64Array(0), surge: new Float64Array(0), error });
  if (!config?.tides.enabled) return empty('tides are turned off');
  if (!tides) return empty(tidesError ?? 'tide data not loaded yet');
  const p = tides.pointSeries(a.lat, a.lon, a.fromMs, a.fromMs + a.hours * 3600_000, { reason: 'Weather API' });
  p.catch(() => undefined);
  const s = await withDeadline(p, TIDE_QUERY_DEADLINE_MS, 'tide series still downloading; try again shortly');
  if (!s) return empty('outside the sea-level grid or its time range');
  return { run: s.run, t0Ms: s.t0Ms, stepMs: s.stepMs, waterLevel: s.waterLevel, tide: s.tide, surge: s.surge, error: null };
}

/**
 * Before an overlay / conditions query: load SMOC for the query box on
 * demand when it is not resident (bounded wait; see ensure()).
 */
async function prepareSmocForQuery(kind: string, args: QueryArgs[keyof QueryArgs]): Promise<void> {
  if (!smoc || !config?.currents.smocEnabled) return;
  const src = smoc;
  let bbox: BBox | null = null;
  let steps: number[] = [];
  let coarseOk = false;
  switch (kind) {
    case 'field': {
      const a = args as QueryArgs['field'];
      if (a.layer !== 'current' && a.layer !== 'sea_state') return;
      bbox = a.bbox;
      steps = src.bracketSteps(a.timeMs);
      coarseOk = a.res >= 0.25;
      break;
    }
    case 'currents': {
      const a = args as QueryArgs['currents'];
      bbox = a.bbox;
      steps = src.bracketSteps(a.timeMs);
      coarseOk = a.res >= 0.25;
      break;
    }
    case 'conditions': {
      const a = args as QueryArgs['conditions'];
      bbox = { west: a.lon - 0.05, east: a.lon + 0.05, south: a.lat - 0.05, north: a.lat + 0.05 };
      const end = Math.min(a.fromMs + a.hours * 3600_000, Date.now() + src.settings.horizonHours * 3600_000);
      steps = src.stepsBetween(a.fromMs, Math.max(a.fromMs, end));
      break;
    }
    case 'conditions_tile': {
      const a = args as QueryArgs['conditions_tile'];
      if (a.z < 5) return;
      const [w, so, e, n] = tileLatLonBounds(a.z, a.x, a.y);
      bbox = { west: w, south: so, east: e, north: n };
      steps = src.bracketSteps(a.timeMs);
      break;
    }
    default:
      return;
  }
  if (!bbox || steps.length === 0) return;
  try {
    await src.ensure(bbox, steps, { reason: `${kind} query`, deadlineMs: SMOC_QUERY_DEADLINE_MS, coarseOk });
  } catch (err) {
    log('error', (err as Error).message);
  }
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
 * Refresh RTOFS (both roles) and, in the data worker, the global
 * forecast and CMEMS SMOC. The route worker never loads a forecast or
 * the SMOC resident area itself: the main thread relays the data
 * worker's (shared memory).
 */
async function refresh(force: boolean): Promise<void> {
  const networkAllowed = role === 'data';
  await refreshRtofs(networkAllowed);
  sendCurrents();
  if (role === 'data') {
    await refreshForecast(force);
    // After the forecast, so a first boot is not held up by the SMOC resident download.
    await refreshSmoc();
    sendCurrents();
    await refreshTides();
  }
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
  // Memory guard: the new store must fit in what is available now (the
  // store in use is already counted as used) with the headroom to spare.
  const mem = checkForecastMemory(horizon, cfg.forecast.extraFields, cfg.forecast.memoryHeadroomBytes);
  if (!mem.ok) {
    log('error', `forecast: ${mem.message} [${mem.source}]`);
    send({ type: 'refresh-error', message: mem.message });
    return;
  }
  log('debug', `forecast: memory check ok: ${mem.message} [${mem.source}]`);
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
    const departureMs = request.departure ? Date.parse(request.departure) : Date.now();
    if (smoc && !request.no_currents) {
      // SMOC for the route box over the currents window from departure, if the resident area does not cover it.
      const src = smoc;
      const steps = src.stepsBetween(departureMs, Math.max(departureMs, Date.now() + src.settings.horizonHours * 3600_000));
      if (steps.length) {
        progress(0, 0, 'currents: checking CMEMS SMOC coverage of the route area');
        try {
          await src.ensure(bbox, steps, { reason: `job ${id} route area`, shouldCancel });
        } catch (err) {
          if (shouldCancel()) throw new RouteCancelled();
          progress(0, 0, `WARNING: CMEMS SMOC not loaded for the route area (${(err as Error).message}); lower-priority current sources are used there`);
        }
        rebuildStack();
      }
    }
    if (shouldCancel()) throw new RouteCancelled();
    const current: CurrentSource = request.no_currents || stack.isEmpty ? new NoCurrent() : stack;
    if (!stack.isEmpty && !request.no_currents) progress(0, 0, `currents: ${stack.sources.map((s) => s.name).join(' > ')}`);

    const departure = new Date(departureMs);
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
  return { forecast: store, currents: stack.isEmpty ? null : stack, land: overlayLand, tides };
}

async function query(id: number, kind: string, args: QueryArgs[keyof QueryArgs]): Promise<void> {
  try {
    await prepareSmocForQuery(kind, args);
    await prepareTidesForQuery(kind, args);
    const tide = kind === 'conditions' ? await conditionsTide(args as QueryArgs['conditions']) : null;
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
        result = conditionsSeries(src, a.lon, a.lat, new Date(a.fromMs), a.hours, a.stepH, tide);
        break;
      }
      case 'tide_series': {
        result = await tideSeriesQuery(args as QueryArgs['tide_series']);
        break;
      }
      case 'conditions_tile': {
        const a = args as QueryArgs['conditions_tile'];
        result = conditionsTilePoints(src, a.z, a.x, a.y, new Date(a.timeMs));
        break;
      }
      case 'land_mask': {
        const a = args as QueryArgs['land_mask'];
        result = landMaskImage(src, a.bbox, a.w, a.h);
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
    // …or SMOC loaded an on-demand area.
    const smocRev = smoc ? smoc.revision : -1;
    const tidesRev = tides ? tides.revision : -1;
    if ((overlayLand && overlayLand.builds !== reportedLandBuilds) || smocRev !== reportedSmocRev || tidesRev !== reportedTidesRev || kind === 'conditions' || kind === 'tide_series') {
      reportedLandBuilds = overlayLand ? overlayLand.builds : 0;
      send({ type: 'data-status', status: dataStatus() });
    }
  } catch (err) {
    send({ type: 'query-error', id, message: (err as Error).message });
  }
}

function dataStatus(): DataStatus {
  reportedSmocRev = smoc ? smoc.revision : -1;
  reportedTidesRev = tides ? tides.revision : -1;
  return {
    forecast: store ? {
      cycle: store.meta.cycleTime.toISOString(), validFrom: store.validRange[0].toISOString(), validTo: store.validRange[1].toISOString(),
      steps: store.steps.length, params: store.meta.params, global: store.global, bytes: store.bytes(), shared: store.shared, hasWaves: store.hasWaves, loadedAt: store.meta.loadedAt.toISOString(),
    } : null,
    currents: currentsStatus(),
    rtofsRun: rtofs ? new Date(rtofs.runMs).toISOString().slice(0, 10) : null,
    land: overlayLand ? overlayLand.stats() : null,
    tides: tides ? tides.status() : null,
    tidesError,
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
      smocClient = makeSmocClient(config);
      smoc = null;
      seaLevelClient = makeSeaLevelClient(config);
      tides = null;
      tidesError = null;
      loadHarmonic(config.currents.harmonicDir);
      rebuildStack();
      send({ type: 'ready', role });
      return;
    }
    case 'refresh':
      if (msg.position !== undefined) vesselPos = msg.position;
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
        smocClient = makeSmocClient(config);
        smoc = null;
        rebuildStack();
        if (msg.position !== undefined) vesselPos = msg.position;
        // Route worker: SMOC comes back from the data worker (relayed 'smoc').
        if (role === 'data') {
          sendSmoc();
          await refreshSmoc();
        }
        await refreshRtofs(role === 'data');
        sendCurrents();
        log('info', `currents reloaded for the new settings (SMOC ${config.currents.smocEnabled ? `${config.currents.smocStepHours} h steps, ${config.currents.smocHorizonHours} h, ±${config.currents.smocHalfWidthDeg}°` : 'off'}; RTOFS ${config.currents.rtofsEnabled ? config.currents.rtofsRegion : 'off'})`);
      }
      if (msg.reload.tides && role === 'data') {
        if (msg.position !== undefined) vesselPos = msg.position;
        // A provisional run's cached chunks may predate its update: drop them with the old client.
        if (tides && seaLevelClient && !tides.run.settled) seaLevelClient.dropRun(tides.run.key);
        seaLevelClient = makeSeaLevelClient(config);
        tides = null;
        tidesError = null;
        await refreshTides();
        log('info', `tides reloaded for the new settings (${config.tides.enabled ? `map area ±${config.tides.halfWidthDeg}°, ${config.tides.horizonHours} h` : 'off'})`);
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
        sendCurrents();
        // A new forecast arrived while the route ran on the previous one:
        // the route's reference is gone now, so let that store go.
        if (before && before !== store) releaseMemory();
      }
      return;
    case 'query':
      await query(msg.id, msg.kind, msg.args);
      return;
    case 'smoc': {
      // Route worker: the data worker's run and resident area (shared memory).
      if (role !== 'route') return;
      const s = msg.smoc;
      const cfgNow = requireInit().config;
      if (!s || !cfgNow.currents.smocEnabled) smoc = null;
      else if (smoc && smoc.run.key === s.run.key && smoc.run.settled === s.run.settled && JSON.stringify(smoc.settings) === JSON.stringify(s.settings)) smoc.setResident(s.resident, s.centre);
      else smoc = SmocCurrentSource.fromSerialized(s, smocClient, (m) => log('info', m));
      rebuildStack();
      sendCurrents();
      if (smoc) log('debug', `smoc: adopted run ${smoc.run.key}${smoc.resident ? `, resident ${(smoc.memoryBytes() / 1e6).toFixed(1)} MB ${smoc.resident.u.buffer instanceof SharedArrayBuffer ? 'shared (no copy)' : 'copied'}` : ', nothing resident'}`);
      return;
    }
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
