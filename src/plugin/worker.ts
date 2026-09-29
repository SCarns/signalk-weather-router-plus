/**
 * Worker thread. Two instances run with different roles (protocol.ts):
 *  - data:  refreshes ECMWF, CMEMS SMOC and RTOFS from the network,
 *           decodes each new ECMWF run to disk one step at a time
 *           (decoded.ts; nothing of it stays in memory), loads the SMOC
 *           resident area (SharedArrayBuffers), keeps the current stack
 *           and the on-demand overlay land masks, and answers overlay /
 *           conditions / Weather API queries by reading the grid cells
 *           and steps each one needs from the decoded run into a store
 *           dropped after the answer (loading SMOC on demand first when
 *           the query box is outside what is resident);
 *  - route: before a route, reads the route area (corridor box plus a
 *           margin, the fields the engine uses, every step) of the
 *           decoded run into one block and drops it when the route ends;
 *           uses the SMOC resident memory (relayed by the main thread,
 *           not copied), with RTOFS loaded from the disk cache; before a
 *           route whose box the SMOC resident area does not cover it
 *           loads that area itself (disk cache, else network) and drops
 *           it after the route, so a long route never delays an overlay
 *           query.
 * The data worker also holds the Copernicus Marine sea level (tides):
 * point series for conditions / Weather API queries (geoChunked, on
 * demand) and the tide-height map field (a resident area around the
 * vessel plus on-demand areas). The route worker does not use tides.
 * The route worker also holds the global water grid (corridor search):
 * the shipped grid, or one rebuilt into the data directory by a builder
 * thread when the configured coastline differs from the shipped grid's.
 * Cancellation of the running route is a shared Int32 flag.
 */

import { parentPort, workerData, Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EcmwfClient, ECMWF_MIRRORS, availableSteps, latestExpectedCycle, cycleFor, type Cycle } from '../data/ecmwf';
import { ForecastStore } from '../data/forecast';
import { decodeForecastToDisk, loadForecastForBBox, requestedParams, resolveCycle, type ResolvedCycle } from '../data/loader';
import {
  cycleName, DECODED_DIR, DecodedRun, DecodedRunWriter, dirBytes, openDecodedRun, pruneDecodedRuns, listDecodedRuns, type WindowOptions,
} from '../data/decoded';
import { checkDecodeResources, checkRouteForecastMemory, checkWaterGridBuildMemory } from './memguard';
import { bboxFromLonLat, bboxWidth, bboxHeight, type BBox } from '../geo/geodesy';
import { LandMask } from '../geo/landmask';
import { OnDemandLand } from '../geo/landcache';
import { releaseMemory } from '../util/gc';
import { NoCurrent, type CurrentSource } from '../engine/environment';
import { OceanPropagator, RouteCancelled, ViasNotCrossedError } from '../engine/propagator';
import { CorridorError, mergeVias, planCorridor, type Corridor } from '../engine/corridor';
import { DEFAULT_PRECISION, routeMultiLeg, validateLegOptions, type LegPlan, type Stop } from '../engine/multileg';
import { WaterGrid } from '../geo/watergrid';
import { chooseWaterGrid } from '../geo/watergrid_store';
import type { GridBuilderData, GridBuilderMessage } from './gridbuilder';
import { routeToGeoJSON, routeToSignalKRoute, skeletonToGeoJSON, type Route } from '../engine/route';
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
import { type ConditionsTide } from './overlays';
import { conditionsSeries, currentPoints, fieldGrid, pressureFeatures, windPoints, type FieldLayer, type OverlaySources, landMaskImage } from './overlays';
import { pointForecasts, POINT_FORECAST_PARAMS } from './weather';
import { routeVessel, type ResolvedConfig } from './config';
import type {
  DataStatus, ForecastMemory, ForecastRunInfo, MainToWorker, QueryArgs, RouteRequest, RouteSummary, TideSeriesResult, VesselPosition, WorkerRole, WorkerToMain,
} from './protocol';

if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;
const cancelFlag = new Int32Array(workerData.cancelFlag as SharedArrayBuffer);
const role: WorkerRole = workerData.role as WorkerRole;

/** ECMWF open-data short names; 2 m dew point is `2d` in the index files. */
const EXTRA_ATM = ['2t', 'tprate', 'skt', '2d', 'ptype'];

let config: ResolvedConfig | null = null;
let client: EcmwfClient | null = null;
let rtofsClient: RtofsClient | null = null;
/** The decoded run in use (on disk; only its index is in memory). */
let run: DecodedRun | null = null;
/** How it became current (status). */
let runInfo: ForecastRunInfo | null = null;
/** Forecast memory this thread holds (query windows, the route's corridor store). */
const forecastMemory: ForecastMemory = { heldBytes: 0, last: null };
/** Last streaming decode (status). */
let lastDecode: DataStatus['lastDecode'] = null;
/** One-step block size while a decode runs. */
let decodingBlockBytes: number | null = null;
/** Bytes of the decoded runs and GRIB cache on disk, refreshed after each forecast check. */
let diskBytes = { decoded: 0, grib: 0 };
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
/** Global water grid (route worker). */
let waterGrid: WaterGrid | null = null;
/** Builder thread while a rebuild runs. */
let gridBuilder: Worker | null = null;

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
  if (landCache && landCache.key === key) {
    // Local refinements belong to the route that made them; each route adds its own.
    landCache.mask.clearPatches();
    return landCache.mask;
  }
  const t = Date.now();
  const mask = LandMask.fromShapefiles(shapefiles, bbox, { resolutionDeg: res });
  log('info', `land mask: ${mask.shapes.length} polygons, ${mask.nx}x${mask.ny} cells at ${res}° (${((mask.nx * mask.ny) / 1e6).toFixed(1)}M), ${Date.now() - t} ms`);
  landCache = { key, mask };
  return mask;
}

/**
 * Route worker: load the water grid built from the configured coastline
 * (shipped or rebuilt), else the best available one while a builder
 * thread rebuilds it into the data directory.
 */
function prepareWaterGrid(cfg: ResolvedConfig): void {
  const t = Date.now();
  const choice = chooseWaterGrid(cfg.landShapefiles, cacheRoot);
  for (const n of choice.notes) log('info', `water grid: ${n}`);
  waterGrid = choice.grid;
  if (waterGrid) {
    log('info', `water grid: loaded ${choice.file} in ${Date.now() - t} ms, ${(waterGrid.bytes() / 1e6).toFixed(1)} MB resident, ${waterGrid.chokepoints.length} narrow passages, ${waterGrid.splits.length} split cells`);
  } else {
    log('error', 'water grid: none available; routes use the per-route skeleton (limited to the box around start, end and waypoints) until one is built');
  }
  if (choice.needsRebuild) startGridRebuild(cfg, choice.rebuildPath);
}

function startGridRebuild(cfg: ResolvedConfig, outFile: string): void {
  if (gridBuilder) return;
  const mem = checkWaterGridBuildMemory(cfg.forecast.memoryHeadroomBytes);
  if (!mem.ok) {
    log('error', `water grid: ${mem.message} [${mem.source}]`);
    return;
  }
  log('info', `water grid: rebuilding from ${cfg.landShapefiles.join(', ')} into ${outFile} (${mem.message}); this takes a few minutes`);
  const data: GridBuilderData = { shapefiles: cfg.landShapefiles, outFile };
  const w = new Worker(path.join(__dirname, 'gridbuilder.js'), { workerData: data });
  gridBuilder = w;
  w.on('message', (m: GridBuilderMessage) => {
    if (m.type === 'progress') log('debug', `water grid rebuild: ${m.done}/${m.total} tiles (${m.message})`);
    else if (m.type === 'error') log('error', `water grid rebuild failed: ${m.message}`);
    else if (m.type === 'done') {
      try {
        const g = WaterGrid.load(m.file);
        g.setCanalsAllowed(waterGrid?.canalsAreAllowed ?? false);
        waterGrid = g;
        log('info', `water grid: rebuilt in ${m.seconds.toFixed(0)} s, ${(m.bytes / 1e6).toFixed(2)} MB on disk, now in use (${(g.bytes() / 1e6).toFixed(1)} MB resident; process peak RSS ${(m.peakRssBytes / 1e6).toFixed(0)} MB)`);
      } catch (err) {
        log('error', `water grid: cannot load the rebuilt grid: ${(err as Error).message}`);
      }
    }
  });
  w.on('error', (err) => log('error', `water grid rebuild crashed: ${err.message}`));
  w.on('exit', () => {
    gridBuilder = null;
  });
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
      log('info', `currents: ${s.name}: ${s.constituents.length} constituents${s.dropped.length ? ` (dropped ${s.dropped.join(', ')})` : ''}, ${s.lats.length}×${s.lons.length} grid, priority ${s.priority}, ${(s.blockBytes() / 1e6).toFixed(1)} MB shared, ${Date.now() - t} ms`);
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

/** Parameters the configured forecast holds (atmosphere + waves), in store order. */
function wantedParams(cfg: ResolvedConfig): string[] {
  return requestedParams({ extraAtmParams: extraParams(cfg) });
}

/** Was this decoded run made for the configured horizon and field set? */
function runFitsConfig(r: DecodedRun, cfg: ResolvedConfig): boolean {
  const want = wantedParams(cfg);
  const have = r.index.request.params;
  const steps = availableSteps(cycleFor(r.cycleTime).atmStream, cfg.forecast.horizonHours);
  return want.length === have.length && want.every((p, i) => p === have[i])
    && steps.length === r.index.stepHours.length && steps.every((h, i) => h === r.index.stepHours[i]);
}

/** Is the run in use this cycle (or newer) and made for the current settings? */
function runMatches(cfg: ResolvedConfig, c: Cycle): boolean {
  return !!run && run.index.cycleTimeMs >= c.time.getTime() && runFitsConfig(run, cfg);
}

function decodedRoot(): string {
  return path.join(cacheRoot, DECODED_DIR);
}

/** A complete decoded run of `c` on disk made for the current settings, or null. */
function decodedRunOnDisk(cfg: ResolvedConfig, c: Cycle): DecodedRun | null {
  const dir = path.join(decodedRoot(), cycleName(c.time));
  if (!fs.existsSync(dir)) return null;
  const { run: r, problem } = openDecodedRun(dir);
  if (!r) {
    log('info', `forecast: decoded run ${dir} not usable (${problem}); decoding again`);
    return null;
  }
  if (!runFitsConfig(r, cfg)) {
    log('info', `forecast: decoded run ${path.basename(dir)} was made for other settings (${r.index.request.horizonHours} h, ${r.index.request.params.join('/')}); decoding again`);
    return null;
  }
  return r;
}

/** Newest complete decoded run on disk for the current settings (offline fallback), or null. */
function newestDecodedRun(cfg: ResolvedConfig): DecodedRun | null {
  for (const name of listDecodedRuns(decodedRoot())) {
    const { run: r } = openDecodedRun(path.join(decodedRoot(), name));
    if (r && runFitsConfig(r, cfg)) return r;
  }
  return null;
}

function refreshDiskBytes(): void {
  diskBytes = { decoded: dirBytes(decodedRoot()), grib: client ? dirBytes(client.cacheDir) : 0 };
}

/** Make `r` the run in use and tell the main thread (which relays it to the route worker). */
function adoptRun(r: DecodedRun, source: 'disk' | 'grib', readyMs: number, downloaded: number): void {
  run = r;
  runInfo = { dir: r.dir, index: r.index, loadedAtMs: Date.now(), source, readyMs, downloaded };
  const c = r.cycleTime;
  log('info', `forecast global: cycle ${c.toISOString().slice(0, 10).replace(/-/g, '')} ${c.toISOString().slice(11, 13)}z${source === 'disk' ? ' (decoded run on disk)' : downloaded === 0 ? ' (from disk cache)' : ''}, ${r.index.steps.length} steps, ${r.index.request.params.join('/')}, ${(r.index.bytes / 1e6).toFixed(1)} MB decoded on disk, 0 MB resident, ${(readyMs / 1000).toFixed(1)} s`);
  send({ type: 'forecast', run: runInfo });
}

function pruneForecastCaches(cfg: ResolvedConfig, cl: EcmwfClient, current: Cycle): void {
  const keep = keepCycles(current, cfg.forecast.keepCycles);
  try {
    cl.pruneCache(keep);
  } catch (err) {
    log('error', `cache prune failed: ${(err as Error).message}`);
  }
  try {
    const names = keep.map((c) => cycleName(c.time));
    if (run) names.push(path.basename(run.dir));
    const removed = pruneDecodedRuns(decodedRoot(), names);
    if (removed.length) log('info', `forecast: removed decoded run(s) ${removed.join(', ')}`);
  } catch (err) {
    log('error', `decoded run prune failed: ${(err as Error).message}`);
  }
  refreshDiskBytes();
}

/**
 * Refresh RTOFS (both roles) and, in the data worker, the forecast and
 * CMEMS SMOC. The route worker never decodes a forecast or loads the SMOC
 * resident area itself: it reads the data worker's decoded run from disk
 * (location relayed by the main thread) and adopts its SMOC memory.
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

/**
 * Data worker: make the newest cycle's decoded run current.
 *  1. The run in use already is that cycle (for the current settings): nothing to do.
 *  2. A complete decoded run of that cycle is on disk (a restart): adopt it, no decode.
 *  3. Otherwise decode it from the GRIB cache (downloading what is missing)
 *     straight to disk, one step at a time, then adopt it.
 * `force` skips 1 and 2: the run is decoded again from the GRIB cache.
 * The run in use keeps answering until the new one is complete; memory
 * during the decode is one step (streamingDecodeBytes), not a store.
 */
async function refreshForecast(force: boolean): Promise<void> {
  const { config: cfg, client: cl } = requireInit();
  const horizon = cfg.forecast.horizonHours;
  const t = Date.now();
  const expected = latestExpectedCycle(new Date(), horizon);
  if (!force && runMatches(cfg, expected)) {
    send({ type: 'forecast-unchanged', cycleTimeMs: run!.index.cycleTimeMs });
    return;
  }
  if (!force) {
    const onDisk = decodedRunOnDisk(cfg, expected);
    if (onDisk) {
      adoptRun(onDisk, 'disk', Date.now() - t, 0);
      pruneForecastCaches(cfg, cl, expected);
      return;
    }
  }
  let resolved: ResolvedCycle;
  try {
    resolved = await resolveCycle(cl, horizon, { extraAtmParams: extraParams(cfg), log: (m) => log('info', `forecast: ${m}`) });
  } catch (err) {
    // Offline with no complete GRIB cycle: a decoded run on disk still serves.
    const fallback = !run ? newestDecodedRun(cfg) : null;
    if (fallback) {
      log('info', `forecast: ${(err as Error).message}; using the decoded run ${path.basename(fallback.dir)} on disk`);
      adoptRun(fallback, 'disk', Date.now() - t, 0);
      return;
    }
    send({ type: 'refresh-error', message: (err as Error).message });
    return;
  }
  const cycle = resolved.cycle;
  if (!force && runMatches(cfg, cycle)) {
    send({ type: 'forecast-unchanged', cycleTimeMs: run!.index.cycleTimeMs });
    return;
  }
  if (!force && cycle.time.getTime() !== expected.time.getTime()) {
    const onDisk = decodedRunOnDisk(cfg, cycle);
    if (onDisk) {
      adoptRun(onDisk, 'disk', Date.now() - t, 0);
      pruneForecastCaches(cfg, cl, cycle);
      return;
    }
  }
  // Guard: memory for one step of decoding, disk for the whole run.
  fs.mkdirSync(decodedRoot(), { recursive: true });
  const res = checkDecodeResources(horizon, cfg.forecast.extraFields, cfg.forecast.memoryHeadroomBytes, decodedRoot());
  if (!res.ok) {
    log('error', `forecast: ${res.message} [${res.source}]`);
    send({ type: 'refresh-error', message: res.message });
    return;
  }
  log('debug', `forecast: resource check ok: ${res.message} [${res.source}]`);
  let writer: DecodedRunWriter | null = null;
  try {
    writer = new DecodedRunWriter(decodedRoot(), cycleName(cycle.time));
    decodingBlockBytes = res.needBytes;
    const out = await decodeForecastToDisk(cl, writer, {
      horizonHours: horizon, cycle, extraAtmParams: extraParams(cfg),
      log: (m) => log('debug', `forecast: ${m}`),
      onStep: (done, total) => {
        if (done === 1 || done % 5 === 0 || done === total) log('debug', `forecast: decoded and wrote step ${done}/${total}`);
      },
    });
    const opened = openDecodedRun(writer.finalDir);
    if (!opened.run) throw new Error(`the decoded run just written is not usable: ${opened.problem}`);
    lastDecode = {
      at: new Date().toISOString(), cycle: out.index.cycle, ms: out.index.decodeMs, stepBlockBytes: out.stepBlockBytes, writtenBytes: out.index.bytes, downloaded: out.downloaded,
    };
    decodingBlockBytes = null;
    // Let the one-step block and the decode buffers go now.
    releaseMemory();
    adoptRun(opened.run, 'grib', Date.now() - t, out.downloaded);
    pruneForecastCaches(cfg, cl, cycle);
  } catch (err) {
    decodingBlockBytes = null;
    writer?.abort();
    releaseMemory();
    send({ type: 'refresh-error', message: (err as Error).message });
  }
}

function keepCycles(current: Cycle, n: number): Cycle[] {
  const out: Cycle[] = [];
  for (let i = 0; i < n; i++) out.push(cycleFor(new Date(current.time.getTime() - i * 6 * 3600_000)));
  return out;
}

/**
 * Read a window of the decoded run, noting the memory it holds while in
 * use. A run replaced (and pruned) between choosing it and reading it is
 * retried once with the run now current.
 */
async function readWindow(what: string, opts: WindowOptions): Promise<ForecastStore> {
  const r = run;
  if (!r) throw new Error('no forecast loaded');
  const t = Date.now();
  let store: ForecastStore;
  try {
    store = await r.window(opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && run && run !== r) store = await run.window(opts);
    else throw err;
  }
  const bytes = store.bytes();
  forecastMemory.heldBytes += bytes;
  if (!forecastMemory.last || bytes >= forecastMemory.last.bytes || Date.now() - Date.parse(forecastMemory.last.at) > 600_000) {
    forecastMemory.last = { what, bytes, readMs: Date.now() - t, at: new Date().toISOString() };
  }
  return store;
}

function releaseWindow(store: ForecastStore | null): void {
  if (!store) return;
  forecastMemory.heldBytes = Math.max(0, forecastMemory.heldBytes - store.bytes());
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
  const legErr = validateLegOptions(r.precision, r.arrival_radius_m, r.waypoints);
  if (legErr) throw new Error(legErr);
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
    // Waypoints are leg ends (engine/multileg.ts): each leg is its own route.
    const stops: Stop[] = [
      { lon: start[0], lat: start[1] },
      ...(request.waypoints ?? []).map((w) => ({ lon: w.lon, lat: w.lat, radiusM: w.radius_m })),
      { lon: end[0], lat: end[1] },
    ];
    const multi = stops.length > 2;
    const stages = request.stages ?? cfg.routing.stages;

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
    const departureMs = request.departure ? Date.parse(request.departure) : Date.now();
    const useForecast = !request.no_forecast && request.mode !== 'motor';
    if (request.mode !== 'motor' && request.no_forecast) progress(0, 0, 'no_forecast set: routing with calm wind');
    let wind: ForecastStore | null = null;
    let cycleLabel: string | undefined;

    // Forecast area and SMOC area for a box, held until releaseAreas().
    const loadAreas = async (bbox: BBox, what: string): Promise<void> => {
      if (useForecast) {
        // The route area of the forecast: the corridor box plus a margin, the
        // fields the engine reads, every step. Held only while this route runs.
        const area = expandBBox(bbox, ROUTE_FORECAST_MARGIN_DEG);
        if (run) {
          const opts: WindowOptions = { bbox: area, params: ROUTE_PARAMS, marginCells: 1 };
          const need = run.windowBytes(opts);
          const mem = checkRouteForecastMemory(need, cfg.forecast.memoryHeadroomBytes);
          if (!mem.ok) throw new Error(mem.message);
          const t0 = Date.now();
          const store = await readWindow(`job ${id} ${what}`, opts);
          routeWindow = store;
          send({ type: 'forecast-memory', memory: { ...forecastMemory } });
          progress(0, 0, `forecast: read the ${what} (${bboxWidth(area).toFixed(1)}° × ${bboxHeight(area).toFixed(1)}°, ${store.steps.length} steps, ${store.meta.params.join('/')}) from the decoded run: ${(store.bytes() / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms`);
          wind = store;
        } else {
          // No decoded run yet (first boot, the data worker is still decoding).
          progress(0, 0, 'no decoded forecast run yet; decoding a route-specific forecast crop from the GRIB disk cache');
          const cycle = (await resolveCycle(cl, cfg.forecast.horizonHours, { extraAtmParams: extraParams(cfg), log: (m) => log('info', `job ${id} forecast: ${m}`) })).cycle;
          const store = await loadForecastForBBox(cl, area, {
            horizonHours: cfg.forecast.horizonHours, cycle, extraAtmParams: extraParams(cfg), shouldCancel, log: (m) => log('debug', `job ${id} forecast: ${m}`),
          });
          forecastMemory.heldBytes += store.bytes();
          routeWindow = store;
          send({ type: 'forecast-memory', memory: { ...forecastMemory } });
          wind = store;
        }
        cycleLabel = wind.meta.cycleTime.toISOString();
      }
      if (smoc && !request.no_currents) {
        // SMOC for the box over the currents window from departure, if the resident area does not cover it.
        const src = smoc;
        const steps = src.stepsBetween(departureMs, Math.max(departureMs, Date.now() + src.settings.horizonHours * 3600_000));
        if (steps.length) {
          progress(0, 0, `currents: checking CMEMS SMOC coverage of the ${what}`);
          try {
            await src.ensure(bbox, steps, { reason: `job ${id} ${what}`, shouldCancel });
          } catch (err) {
            if (shouldCancel()) throw new RouteCancelled();
            progress(0, 0, `WARNING: CMEMS SMOC not loaded for the ${what} (${(err as Error).message}); lower-priority current sources are used there`);
          }
          rebuildStack();
        }
      }
      if (shouldCancel()) throw new RouteCancelled();
    };
    const releaseAreas = (): void => {
      if (routeWindow) {
        releaseWindow(routeWindow);
        routeWindow = null;
      }
      wind = null;
      if (smoc) smoc.trimOnDemand(0);
      rebuildStack();
      releaseMemory();
      send({ type: 'forecast-memory', memory: { ...forecastMemory } });
    };

    const legOne = async (plan: LegPlan, legStart: [number, number], legDeparture: Date): Promise<Route> => {
      try {
        return await legRoute(plan, legStart, legDeparture);
      } catch (err) {
        if (multi && err instanceof Error && !(err instanceof RouteCancelled) && !shouldCancel()) err.message = `leg ${plan.index + 1}/${plan.count}: ${err.message}`;
        throw err;
      }
    };
    const legRoute = async (plan: LegPlan, legStart: [number, number], legDeparture: Date): Promise<Route> => {
      const legEnd = plan.end;
      const chain: [number, number][] = [legStart, legEnd];
      const tag = multi ? `leg ${plan.index + 1}/${plan.count} ` : '';
      // Corridor from the global water grid: its box (not the endpoints') sets
      // the land raster, SMOC area and forecast crop.
      let corridor: Corridor | null = null;
      if (waterGrid) {
        waterGrid.setCanalsAllowed(cfg.routing.allowCanals);
        progress(0, 0, `${tag}corridor: searching the global 0.02° water grid (canals ${cfg.routing.allowCanals ? 'allowed' : 'blocked'})`);
        try {
          corridor = planCorridor(waterGrid, chain, {
            landFor: (b) => landMaskFor(b, cfg.routing.landRasterMaxCells, cfg.landShapefiles),
            stages, onProgress: (m) => progress(0, 0, `${tag}corridor: ${m}`), shouldCancel,
          });
          const st = corridor.stats;
          progress(0, 0, `${tag}corridor: ${(corridor.lengthM / 1852).toFixed(1)} nm, A* ${st.astarMs} ms (${st.expanded} cells), ${st.refines} local refinement(s), ${st.reroutes} re-route(s)`);
          for (const v of corridor.autoVias) progress(0, 0, `${tag}corridor: auto via at ${v.name}, width ${(v.widthM / 1000).toFixed(1)} km`);
        } catch (err) {
          if (shouldCancel()) throw new RouteCancelled();
          if (!(err instanceof CorridorError) || err.fatal) throw err;
          progress(0, 0, `WARNING: ${tag}corridor search failed (${err.message}); using the per-route skeleton inside the box around ${multi ? 'the leg\'s ends' : 'start and end'}`);
          corridor = null;
        }
      }
      let bbox: BBox;
      if (corridor) {
        bbox = corridor.bbox;
      } else {
        bbox = bboxFromLonLat(chain.map((p) => p[0]), chain.map((p) => p[1]), 1.0);
        if (bboxWidth(bbox) > 120 || bboxHeight(bbox) > 90) throw new Error('route bounding box is too large (max 120° × 90°)');
      }
      const land = corridor ? corridor.land : landMaskFor(bbox, cfg.routing.landRasterMaxCells, cfg.landShapefiles);
      if (shouldCancel()) throw new RouteCancelled();
      // Forecast and SMOC areas per leg (measured on brain: the same time as
      // one area for all legs, and at most the same memory).
      await loadAreas(bbox, multi ? `${tag}area` : 'route area');
      const current: CurrentSource = request.no_currents || stack.isEmpty ? new NoCurrent() : stack;
      if (!stack.isEmpty && !request.no_currents && plan.index === 0) progress(0, 0, `currents: ${stack.sources.map((s) => s.name).join(' > ')}`);

      const prop = new OceanPropagator(land, {
        stages, subsectors: cfg.routing.subsectors, headings: cfg.routing.headings, headingIncrementDeg: cfg.routing.headingIncrementDeg,
      });
      const t = Date.now();
      const autoVias = corridor ? mergeVias([], corridor.autoVias) : [];
      const legWind: ForecastStore | null = wind;
      const legArgs = {
        start: legStart, end: legEnd, departureTime: legDeparture, vessel, polar: routePolar,
        wind: legWind ?? undefined, current,
        modePolicy: request.mode ?? 'sail_max',
        sailThreshMs: request.sail_thresh_ms ?? cfg.routing.sailThreshMs,
        simStepM: cfg.routing.simStepM,
        vias: autoVias.length ? autoVias : undefined,
        corridor: corridor ? { skeleton: corridor.skeleton, widthM: corridor.widthM } : undefined,
        arrivalRadiusM: plan.arrivalRadiusM,
        snapToExact: plan.snapToExact,
        onProgress: multi ? (st: number, tot: number, m: string) => progress(st, tot, `${tag}${m}`) : progress, shouldCancel,
      };
      let r: Route;
      try {
        r = prop.computeRoute(legArgs);
      } catch (err) {
        // The corridor's automatic vias are only guidance: when the search
        // finds another passage (e.g. The Race instead of the gap past
        // Gardiners Island) no branch crosses them. Retry without them.
        if (!(err instanceof ViasNotCrossedError) || !autoVias.length) throw err;
        progress(0, 0, `${tag}no branch went through the auto via(s) at ${autoVias.map((v) => v.name ?? 'a narrow passage').join(', ')}; routing again without them`);
        r = prop.computeRoute({ ...legArgs, vias: undefined });
      }
      if (legWind) {
        const lastValid = legWind.validRange[1].getTime();
        const arrival = r.waypoints[r.waypoints.length - 1].time.getTime();
        if (arrival > lastValid) {
          r.forecastHorizonExceededS = (arrival - lastValid) / 1000;
          progress(0, 0, `WARNING: ${multi ? `leg ${plan.index + 1} ` : ''}arrival is ${((arrival - lastValid) / 3600_000).toFixed(1)} h after the last forecast step; conditions beyond it are held constant`);
        }
      }
      if (current instanceof CurrentStack) r.currentSources = current.sources.map((s) => s.name);
      if (multi) log('info', `job ${id}: ${tag}${r.waypoints.length} waypoints, ${(r.totalDistanceM / 1852).toFixed(1)} nm, ${(r.totalTimeS / 3600).toFixed(1)} h, ${Date.now() - t} ms`);
      if (multi) releaseAreas();
      return r;
    };

    const t = Date.now();
    const result = await routeMultiLeg({
      stops, departureTime: new Date(departureMs),
      precision: request.precision, arrivalRadiusM: request.arrival_radius_m,
      runLeg: legOne,
      onProgress: (m) => progress(0, 0, m),
    });
    if (cycleLabel) result.forecastCycle = cycleLabel;
    if (!request.no_currents && !stack.isEmpty) result.currentSources = stack.sources.map((s) => s.name);
    const name = request.name && request.name.trim()
      ? request.name.trim()
      : `${cfg.publish.routeNamePrefix} ${request.start.lat.toFixed(2)},${request.start.lon.toFixed(2)} → ${request.end.lat.toFixed(2)},${request.end.lon.toFixed(2)}`;
    const wps = result.waypoints;
    const summary: RouteSummary = {
      total_distance_m: result.totalDistanceM, total_time_s: result.totalTimeS, sailing_time_s: result.sailingTimeS, motoring_time_s: result.motoringTimeS,
      waypoint_count: wps.length, warnings: result.warnings?.length ?? 0,
      departure: wps[0].time.toISOString(), arrival: wps[wps.length - 1].time.toISOString(),
      forecast_cycle: cycleLabel, current_sources: result.currentSources, polar: polarLabel,
      auto_vias: result.autoVias?.map((v) => ({ name: v.name, width_m: Math.round(v.widthM) })),
    };
    if (multi) {
      summary.legs = stops.length - 1;
      summary.precision = request.precision ?? DEFAULT_PRECISION;
    }
    log('info', `job ${id}: ${wps.length} waypoints, ${(result.totalDistanceM / 1852).toFixed(1)} nm, ${(result.totalTimeS / 3600).toFixed(1)} h, ${Date.now() - t} ms`);
    send({ type: 'done', id, geojson: routeToGeoJSON(result), skRoute: routeToSignalKRoute(result, name), skeleton: skeletonToGeoJSON(result), summary });
  } catch (err) {
    if (err instanceof RouteCancelled || shouldCancel()) send({ type: 'error', id, message: 'cancelled', cancelled: true });
    else send({ type: 'error', id, message: (err as Error).message });
  } finally {
    // The route's forecast area and its SMOC on-demand areas go with the route.
    if (routeWindow) {
      releaseWindow(routeWindow);
      routeWindow = null;
    }
    if (smoc) smoc.trimOnDemand(0);
    rebuildStack();
    releaseMemory();
    send({ type: 'forecast-memory', memory: { ...forecastMemory } });
  }
}

/** The running route's forecast area (released when the route ends). */
let routeWindow: ForecastStore | null = null;

/** Fields the engine samples: wind (at, atMany) and waves (wavesAt). */
const ROUTE_PARAMS = ['10u', '10v', 'swh', 'mwp', 'mwd'];
/**
 * Degrees added around the corridor box for the route's forecast area.
 * The engine can sample outside the land raster's box (outside it is
 * water to the land test); inside this margin every sample is exactly
 * the global forecast's value, beyond it the value of the area's edge.
 */
const ROUTE_FORECAST_MARGIN_DEG = 5;

function expandBBox(b: BBox, d: number): BBox {
  const width = bboxWidth(b);
  if (width + 2 * d >= 360) return { west: -180, east: 180, south: Math.max(-90, b.south - d), north: Math.min(90, b.north + d) };
  return { west: b.west - d, east: b.west + width + d, south: Math.max(-90, b.south - d), north: Math.min(90, b.north + d) };
}

function overlaySources(forecast: ForecastStore | null): OverlaySources {
  return { forecast, currents: stack.isEmpty ? null : stack, land: overlayLand, tides };
}

/** Parameters each forecast map layer reads (none: the layer does not use the forecast). */
const LAYER_PARAMS: Record<string, string[]> = {
  wind: ['10u', '10v'], waves: ['swh', 'mwp', 'mwd'], msl: ['msl'], temperature: ['2t'], sst: ['skt'], precip: ['tprate', 'ptype'],
  sea_state: ['10u', '10v', 'swh', 'mwp', 'mwd'], current: [], tide: [],
};
/** Every parameter conditionsSeries samples. */
const CONDITIONS_PARAMS = ['10u', '10v', 'swh', 'mwp', 'mwd', 'msl', '2t', 'skt', 'tprate', '2d', 'ptype'];
const INFO_PARAMS = ['10u', '10v', 'msl', 'swh', 'mwp', 'mwd'];

/** A small box around a point: its bilinear (and nearest) neighbours are inside with the default margin. */
function pointBox(lon: number, lat: number): BBox {
  return { west: lon, east: lon, south: lat, north: lat };
}

/**
 * The part of the decoded run a query needs, or null when it needs none:
 * map layers read the view (plus margin) at the two steps around the map
 * time; point queries read a few cells around the point for every step.
 */
async function queryWindow(kind: string, args: QueryArgs[keyof QueryArgs]): Promise<ForecastStore | null> {
  if (!run) return null;
  switch (kind) {
    case 'field': {
      const a = args as QueryArgs['field'];
      const params = LAYER_PARAMS[a.layer] ?? [];
      if (!params.length) return null;
      return readWindow(`${a.layer} map`, { bbox: a.bbox, params, steps: run.bracket(a.timeMs), marginCells: 2 });
    }
    case 'wind_points': {
      const a = args as QueryArgs['wind_points'];
      return readWindow('wind arrows', { bbox: a.bbox, params: ['10u', '10v'], steps: run.bracket(a.timeMs), marginCells: 2 });
    }
    case 'pressure': {
      const a = args as QueryArgs['pressure'];
      // pressureFeatures pads by one cell and draws at least 8 × 8 cells (2°).
      return readWindow('isobars', { bbox: a.bbox, params: ['msl'], steps: run.bracket(a.timeMs), marginCells: 10 });
    }
    case 'conditions': {
      const a = args as QueryArgs['conditions'];
      return readWindow('conditions', { bbox: pointBox(a.lon, a.lat), params: CONDITIONS_PARAMS, marginCells: 2 });
    }
    case 'weather_point': {
      const a = args as QueryArgs['weather_point'];
      return readWindow('Weather API point', { bbox: pointBox(a.lon, a.lat), params: [...POINT_FORECAST_PARAMS], marginCells: 2 });
    }
    case 'forecast_info': {
      const a = args as QueryArgs['forecast_info'];
      return readWindow('forecast samples', { bbox: pointBox(a.lon, a.lat), params: INFO_PARAMS, marginCells: 2 });
    }
    default:
      return null;
  }
}

/** Largest on-demand SMOC / tide area set the data worker keeps between queries (see README, Data). */
const QUERY_AREA_RETAIN_BYTES = 16 * 1024 * 1024;

async function query(id: number, kind: string, args: QueryArgs[keyof QueryArgs]): Promise<void> {
  let win: ForecastStore | null = null;
  try {
    await prepareSmocForQuery(kind, args);
    await prepareTidesForQuery(kind, args);
    const tide = kind === 'conditions' ? await conditionsTide(args as QueryArgs['conditions']) : null;
    win = await queryWindow(kind, args);
    const src = overlaySources(win);
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
      case 'weather_point': {
        const a = args as QueryArgs['weather_point'];
        if (!win) throw new Error('no forecast loaded yet');
        result = pointForecasts(win, a.lon, a.lat, a.startMs, a.maxCount);
        break;
      }
      case 'forecast_info': {
        const a = args as QueryArgs['forecast_info'];
        if (!win) throw new Error('no forecast loaded yet');
        const f = win;
        if (!f.covers(a.lon, a.lat)) throw new Error('position outside the forecast');
        result = f.steps.map((s) => {
          const t = new Date(s.validMs);
          const [ws, wd] = f.at(a.lon, a.lat, t);
          const wave = f.wavesAt(a.lon, a.lat, t);
          const msl = f.mslAt(a.lon, a.lat, t);
          return { time: t.toISOString(), wind_ms: ws, wind_dir_deg: wd, msl_pa: Number.isFinite(msl) ? msl : null, swh_m: wave?.swh ?? null, mwp_s: wave?.mwp ?? null, mwd_deg: wave?.mwd ?? null };
        });
        break;
      }
      default:
        throw new Error(`unknown query kind ${kind}`);
    }
    releaseWindow(win);
    win = null;
    // On-demand SMOC / tide areas loaded for this query: keep at most a small set.
    smoc?.trimOnDemand(QUERY_AREA_RETAIN_BYTES);
    tides?.trimOnDemand(QUERY_AREA_RETAIN_BYTES);
    send({ type: 'query-result', id, result });
    // A new overlay land raster was built: refresh the status the main thread reports.
    // …or SMOC loaded an on-demand area.
    const smocRev = smoc ? smoc.revision : -1;
    const tidesRev = tides ? tides.revision : -1;
    if ((overlayLand && overlayLand.builds !== reportedLandBuilds) || smocRev !== reportedSmocRev || tidesRev !== reportedTidesRev || kind === 'conditions' || kind === 'tide_series' || kind === 'field' || kind === 'weather_point') {
      reportedLandBuilds = overlayLand ? overlayLand.builds : 0;
      send({ type: 'data-status', status: dataStatus() });
    }
  } catch (err) {
    releaseWindow(win);
    send({ type: 'query-error', id, message: (err as Error).message });
  }
}

function dataStatus(): DataStatus {
  reportedSmocRev = smoc ? smoc.revision : -1;
  reportedTidesRev = tides ? tides.revision : -1;
  const r = run;
  return {
    forecast: r && runInfo ? {
      cycle: r.cycleTime.toISOString(), validFrom: r.validRange[0].toISOString(), validTo: r.validRange[1].toISOString(),
      steps: r.index.steps.length, params: r.index.request.params, hasWaves: r.hasWaves, loadedAt: new Date(runInfo.loadedAtMs).toISOString(),
      source: runInfo.source, readyMs: runInfo.readyMs, decodedDir: r.dir, decodedBytes: r.index.bytes,
      decodedDiskBytes: diskBytes.decoded, gribCacheBytes: diskBytes.grib,
    } : null,
    lastDecode,
    decodingBlockBytes,
    forecastMemory: { ...forecastMemory },
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
      // The data worker loads the tidal-harmonic files once and relays the
      // shared constituent blocks; the route worker adopts them ('harmonic').
      if (role === 'data') {
        loadHarmonic(config.currents.harmonicDir);
        send({ type: 'harmonic', sources: harmonic.map((s) => s.serialize()) });
      } else harmonic = [];
      rebuildStack();
      if (role === 'route') {
        try {
          prepareWaterGrid(config);
        } catch (err) {
          waterGrid = null;
          log('error', `water grid: ${(err as Error).message}`);
        }
      }
      send({ type: 'ready', role });
      return;
    }
    case 'refresh':
      if (msg.position !== undefined) vesselPos = msg.position;
      await refresh(msg.force ?? false);
      send({ type: 'data-status', status: dataStatus() });
      return;
    case 'forecast': {
      // Route worker: where the current decoded run is (nothing is read until a route needs it).
      if (role !== 'route') return;
      run = msg.run ? new DecodedRun(msg.run.dir, msg.run.index) : null;
      runInfo = msg.run;
      if (run) log('info', `forecast: routes read from the decoded run ${run.dir} (cycle ${run.cycleTime.toISOString().slice(0, 13)}Z, ${run.index.steps.length} steps, ${(run.index.bytes / 1e6).toFixed(1)} MB on disk)`);
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
      await route(msg.id, msg.request);
      sendCurrents();
      return;
    case 'query':
      await query(msg.id, msg.kind, msg.args);
      return;
    case 'harmonic': {
      // Route worker: the data worker's tidal-harmonic sources (shared constituent blocks).
      if (role !== 'route') return;
      harmonic = msg.sources.map((s) => new HarmonicCurrentSource(s));
      rebuildStack();
      sendCurrents();
      log('info', `currents: adopted ${harmonic.length} tidal-harmonic source(s) from the data worker (${(harmonic.reduce((a, s) => a + s.blockBytes(), 0) / 1e6).toFixed(1)} MB shared, no copy)`);
      return;
    }
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
      if (gridBuilder) await gridBuilder.terminate();
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
