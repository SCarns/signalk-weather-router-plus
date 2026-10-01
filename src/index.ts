/**
 * signalk-weather-router-plus — Signal K plugin entry point.
 *
 * Standalone weather routing: ECMWF open-data forecasts, Copernicus
 * Marine SMOC and NOAA RTOFS currents decoded in-process, harmonic tidal
 * currents, Copernicus Marine hourly sea level (tide height, water level,
 * surge), GSHHG coastline
 * avoidance, vessel polars, isochrone propagation. Two worker threads:
 * `data` (forecast, currents, overlay queries) and `route` (engine).
 * Routes are exposed through the plugin's REST/SSE API, saved to the
 * Resources API, and the forecast is offered through the Weather API.
 * The decoded forecast lives on disk (data/decoded.ts); this thread holds
 * none of it: forecast reads happen in the workers.
 */

import { detectManagedPolar, selectManagedPolar } from './plugin/managedpolar';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IRouter } from 'express';
import { CONFIG_SCHEMA, resolveConfig, type LegacyPluginConfig, type PluginConfig, type ResolvedConfig } from './plugin/config';
import { mergeSettings, reloadsFor, settingsSchema, SettingsStore, SettingsValidationError } from './plugin/settings';
import { checkDecodeResources } from './plugin/memguard';
import { JobManager, type Job } from './plugin/jobs';
import { registerApi } from './plugin/api';
import { TileService, TileStore, type TileGroup, type TileLayer } from './plugin/tiles';
import { TilePrebuilder } from './plugin/prebuild';
import { runLastMs, type ArcoRun } from './data/arco';
import { ensureGshhg, gshhgInstalled, unreadableCoastlines } from './geo/gshhg';
import { BUNDLED_DEFAULT_POLAR, BUNDLED_POLARS_DIR } from './plugin/polars';
import { openApiDocument } from './plugin/openapi';
import { makeWeatherProvider, startMsOf, type WeatherData } from './plugin/weather';
import type {
  DataStatus,
  ForecastMemory,
  ForecastRunInfo,
  MainToWorker,
  QueryArgs,
  QueryKind,
  TideSeriesResult,
  VesselPosition,
  WorkerRole,
  WorkerToMain,
} from './plugin/protocol';
import type { SerializedSmoc } from './currents/smoc';
import type { SerializedHarmonic } from './currents/harmonic';

const PLUGIN_ID = 'signalk-weather-router-plus';
const BASE_PATH = `/plugins/${PLUGIN_ID}`;
const QUERY_TIMEOUT_MS = 120_000;

interface SkApp {
  debug: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  setPluginStatus: (s: string) => void;
  setPluginError: (s: string) => void;
  getDataDirPath: () => string;
  getSelfPath?: (path: string) => unknown;
  handleMessage?: (id: string, delta: unknown) => void;
  registerWeatherProvider?: (provider: unknown) => void;
  resourcesApi?: {
    getResource?: (type: string, id: string) => Promise<unknown>;
    setResource: (type: string, id: string, data: Record<string, unknown>, providerId?: string) => Promise<void>;
  };
}

interface SignalKPlugin {
  id: string;
  name: string;
  description: string;
  schema: () => Record<string, unknown>;
  start: (options: PluginConfig, restartPlugin: () => void) => void | Promise<void>;
  stop: () => void | Promise<void>;
  registerWithRouter?: (router: IRouter) => void;
  getOpenApi?: () => Record<string, unknown>;
}

/** Roles of the two workers this file runs (tiles workers: prebuild.ts). */
type MainRole = Exclude<WorkerRole, 'tiles'>;

interface WorkerHandle {
  role: MainRole;
  worker: Worker | null;
  ready: boolean;
}

export = function plugin(app: SkApp): SignalKPlugin {
  let config: ResolvedConfig | null = null;
  const workers: Record<MainRole, WorkerHandle> = {
    data: { role: 'data', worker: null, ready: false },
    route: { role: 'route', worker: null, ready: false },
  };
  let cancelFlag: Int32Array | null = null;
  let jobs: JobManager | null = null;
  /** The decoded run in use (where it is on disk and its index), relayed to the route worker. */
  let forecastRun: ForecastRunInfo | null = null;
  /** Forecast memory the route worker holds (its corridor store while a route runs). */
  let routeForecastMemory: ForecastMemory | null = null;
  /** The data worker's CMEMS SMOC run + resident area (shared memory), relayed to the route worker. */
  let smocShared: SerializedSmoc | null = null;
  /** The data worker's tidal-harmonic sources (shared constituent blocks), relayed to the route worker. */
  let harmonicShared: SerializedHarmonic[] | null = null;
  /** Raw Signal K plugin options from start(). */
  let pluginOptions: PluginConfig | undefined;
  let settings: SettingsStore | null = null;
  /** Current sources last reported by the data worker (name list + RTOFS run), to tell the route worker to reload. */
  let currentsKey = '';
  let forecastError: string | null = null;
  let dataStatus: DataStatus | null = null;
  /** The route worker's own current sources (its SMOC on-demand areas and memory). */
  let routeCurrents: DataStatus['currents'] | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let failedRefreshTimer: NodeJS.Timeout | null = null;
  let weatherRegistered = false;
  let stopped = true;
  let pendingRefresh: { force: boolean } | null = null;
  let queryId = 0;
  const pendingQueries = new Map<
    number,
    { resolve: (v: { result: unknown; complete: boolean }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  /** Map overlay tiles on disk (null before start). */
  let tiles: TileService | null = null;
  /** Bumped by settings changes that reload forecast, currents or tides (tile generations). */
  let dataSettingsRev = 0;
  /** Tiles built ahead of time (null before start or when off). */
  let prebuilder: TilePrebuilder | null = null;
  /** The data worker's tide run (relayed to the tiles workers). */
  let tidesRun: ArcoRun | null = null;
  /** Downloaded GSHHG coastline, used when the plugin config names none (geo/gshhg.ts). */
  let autoCoastline: string | null = null;
  /** Bumped by every start/stop, so a start still downloading the coastline does not carry on after a stop. */
  let startGen = 0;
  /** Cancels the coastline download (and its retry wait) on stop. */
  let coastlineCtrl: AbortController | null = null;
  /** A route started before the first forecast was ready: sent to the route worker when it is (see startServices). */
  let waitingForForecast: Job | null = null;
  let resolvingPolarJob: string | null = null;

  /** Why the services are not up yet, for API answers and the status (`starting`). */
  function notStartedReason(): string {
    if (stopped) return 'plugin not started';
    if (coastline.downloading) {
      const m = (coastline.message ?? '').replace(/^coastline:\s*/, '');
      return `starting: downloading the coastline${m ? ` (${m})` : ' (GSHHG, 149 MB, once)'}`;
    }
    if (coastline.error)
      return `starting: the coastline download failed (${coastline.error}); it is tried again every 10 minutes, or press Download coastline in the plugin configuration`;
    return 'starting';
  }

  /** Send a job waiting for the first forecast to the route worker. */
  function releaseWaitingJob(note: string): void {
    const job = waitingForForecast;
    if (!job) return;
    waitingForForecast = null;
    // It may have failed meanwhile (route worker crash/exit: failRunning).
    if (!jobs || jobs.runningId !== job.id || jobs.get(job.id)?.status !== 'running') return;
    jobs.onProgress(job.id, 0, 0, note);
    void dispatchRoute(job);
  }

  /** Provider I/O stays on the main thread; a route receives a fixed, cloneable snapshot. */
  async function dispatchRoute(job: Job): Promise<void> {
    const gen = startGen;
    const manager = jobs;
    try {
      resolvingPolarJob = job.id;
      const managedPolar =
        config && job.request.mode !== 'motor' ? await selectManagedPolar(app, config.polarSource, job.request.vessel?.polar) : undefined;
      if (stopped || gen !== startGen || jobs !== manager || manager?.get(job.id)?.status !== 'running') return;
      post('route', { type: 'route', id: job.id, request: job.request, managedPolar });
    } catch (err) {
      if (!stopped && gen === startGen && jobs === manager && manager?.get(job.id)?.status === 'running')
        manager.onError(job.id, `Polar source: ${(err as Error).message}`);
    } finally {
      if (resolvingPolarJob === job.id) resolvingPolarJob = null;
    }
  }

  /** Downloaded-coastline state (status `coastline`, config panel). */
  const coastline: {
    downloading: boolean;
    message: string | null;
    error: string | null;
    path: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  } = { downloading: false, message: null, error: null, path: null, startedAt: null, finishedAt: null };
  /** The download running, if any (one at a time), with the signal that cancels it. */
  let coastlineRun: { promise: Promise<string | null>; signal: AbortSignal } | null = null;
  /** Wakes a start waiting to retry the download. */
  let coastlineWake: (() => void) | null = null;
  /** Cancels a download started from the config panel, on stop. */
  let coastlineManualCtrl: AbortController | null = null;
  /** A failed coastline download is tried again after this long. */
  const COASTLINE_RETRY_MS = 10 * 60_000;

  /**
   * No coastline configured: download GSHHG (geo/gshhg.ts), trying again
   * every 10 minutes after a failure, until it is in place or the plugin
   * stops. True when the coastline is ready and this start is still current.
   */
  async function downloadCoastline(gen: number, dataDir: string): Promise<boolean> {
    const ctrl = new AbortController();
    coastlineCtrl = ctrl;
    const current = (): boolean => gen === startGen && !stopped && !ctrl.signal.aborted;
    app.setPluginStatus('no coastline configured: downloading GSHHG (149 MB, once)');
    for (;;) {
      const shp = await fetchCoastline(dataDir, ctrl.signal, m => {
        if (current()) app.setPluginStatus(m);
      });
      if (!current()) return false; // stopped
      if (shp) {
        autoCoastline = shp;
        return true;
      }
      const at = new Date(Date.now() + COASTLINE_RETRY_MS).toISOString().slice(11, 16);
      app.setPluginError(
        `coastline download failed: ${coastline.error}; trying again at ${at} UTC (or press Download coastline in the plugin config, or set a coastline shapefile)`
      );
      // Wait for the retry time, a Download press (wakes it) or a stop.
      const ok = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => done(true), COASTLINE_RETRY_MS);
        const done = (v: boolean): void => {
          clearTimeout(timer);
          coastlineWake = null;
          resolve(v);
        };
        coastlineWake = () => done(true);
        ctrl.signal.addEventListener('abort', () => done(false));
      });
      if (!ok || !current()) return false;
    }
  }

  /**
   * One GSHHG download (geo/gshhg.ts) with its state for the status and
   * the config panel. Resolves the .shp, or null on failure (the error is
   * in `coastline.error`); a download already running is joined.
   */
  function fetchCoastline(dataDir: string, signal: AbortSignal, onProgress: (m: string) => void = () => undefined): Promise<string | null> {
    // An aborted run (stopped) is not joined: a new start downloads afresh.
    if (coastlineRun && !coastlineRun.signal.aborted) return coastlineRun.promise;
    // This run's token: a stale run's late callbacks must not touch a newer run's state.
    const run: { promise: Promise<string | null>; signal: AbortSignal } = { promise: Promise.resolve(null), signal };
    const isCurrent = (): boolean => coastlineRun === run;
    coastlineRun = run;
    coastline.downloading = true;
    coastline.error = null;
    coastline.path = null;
    coastline.startedAt = new Date().toISOString();
    run.promise = ensureGshhg(
      dataDir,
      m => {
        log(m);
        if (isCurrent()) coastline.message = m;
        onProgress(m);
      },
      { signal }
    )
      .then(
        shp => {
          if (isCurrent()) {
            coastline.path = shp;
            coastline.message = `ready: ${shp}`;
          }
          return shp;
        },
        (err: Error) => {
          if (isCurrent()) coastline.error = err.message;
          return null;
        }
      )
      .finally(() => {
        if (!isCurrent()) return;
        coastline.downloading = false;
        coastline.finishedAt = new Date().toISOString();
        coastlineRun = null;
      });
    return run.promise;
  }

  /**
   * Download pressed in the config panel: wake a start waiting to retry,
   * or download now (also while a coastline is configured: the panel then
   * offers to switch to it).
   */
  function requestCoastlineDownload(): void {
    if (coastlineRun && !coastlineRun.signal.aborted) return;
    if (coastlineWake) {
      coastlineWake();
      return;
    }
    const ctrl = new AbortController();
    coastlineManualCtrl = ctrl;
    void fetchCoastline(app.getDataDirPath(), ctrl.signal);
  }

  /** The resolved config, with the downloaded coastline when none is configured. */
  function resolve(options: PluginConfig | undefined, values: SettingsStore['values']): ResolvedConfig {
    const c = resolveConfig(options, values);
    if (c.landShapefiles.length === 0 && autoCoastline) c.landShapefiles = [autoCoastline];
    // Polars: the bundled library and default polar unless configured. With the
    // bundled library, user polars live in the data directory (an update of the
    // package replaces its own files, never these).
    if (!c.polarsDir) {
      c.polarsDir = BUNDLED_POLARS_DIR;
      c.polarUserDir = path.join(app.getDataDirPath(), 'polars', 'user');
    } else c.polarUserDir = path.join(c.polarsDir, 'user');
    if (!c.polarFile) c.polarFile = BUNDLED_DEFAULT_POLAR;
    return c;
  }

  const log = (msg: string): void => app.debug(msg);

  function rejectPendingQueries(reason: string): void {
    for (const [id, p] of pendingQueries) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pendingQueries.delete(id);
    }
  }

  function post(role: MainRole, msg: MainToWorker): void {
    workers[role].worker?.postMessage(msg);
  }

  /**
   * A data-worker query. `signal`: when it aborts before the worker has
   * started the query, the query is dropped (it then rejects with
   * "cancelled"); one already running completes. `complete` is false when
   * an on-demand current / tide load was late or failed.
   */
  function queryFull<K extends QueryKind>(
    kind: K,
    args: QueryArgs[K],
    signal?: AbortSignal
  ): Promise<{ result: unknown; complete: boolean }> {
    const h = workers.data;
    if (!h.worker || !h.ready) return Promise.reject(new Error('data worker not ready'));
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    const id = ++queryId;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (pendingQueries.has(id)) post('data', { type: 'query-cancel', id });
      };
      const done = (): void => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        pendingQueries.delete(id);
        done();
        reject(new Error('query timed out'));
      }, QUERY_TIMEOUT_MS);
      pendingQueries.set(id, {
        resolve: v => {
          done();
          resolve(v);
        },
        reject: e => {
          done();
          reject(e);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      post('data', { type: 'query', id, kind, args });
    });
  }

  function query<K extends QueryKind>(kind: K, args: QueryArgs[K], signal?: AbortSignal): Promise<unknown> {
    return queryFull(kind, args, signal).then(r => r.result);
  }

  /** A point query through the shared store (tiles.ts TileService.point). */
  function pointQuery<K extends QueryKind>(kind: K, args: QueryArgs[K]): Promise<unknown> {
    return tiles ? tiles.point(kind, args) : query(kind, args);
  }

  /**
   * Tile generations: what each group of overlay layers is computed
   * from. A change removes that group's saved tiles (tiles.ts).
   */
  function updateTileGenerations(): void {
    if (!tiles || !config) return;
    const cfg = config;
    const coast = `${cfg.landShapefiles.join('|')}`;
    const wx = forecastRun
      ? `${coast}|${forecastRun.index.cycleTimeMs}|${forecastRun.index.request.params.join(',')}|${dataSettingsRev}`
      : null;
    const smoc = smocShared ? `${smocShared.run.key}|${smocShared.run.settled}` : 'off';
    const cur = wx && dataStatus ? `${wx}|${currentsKey}|${smoc}|${cfg.currents.harmonicDir ?? ''}` : null;
    const t = dataStatus?.tides;
    const tide = !cfg.tides.enabled ? `${coast}|off` : t ? `${coast}|${t.run}|${t.settled}|${dataSettingsRev}` : null;
    // Point answers (conditions, Weather API) read forecast, currents and tides.
    // POINT_ANSWER_REV: bumped when the answer's content changes for the same
    // data (2: current_ms null where no current source has data), so answers
    // saved by an older version are not served.
    const POINT_ANSWER_REV = 2;
    const pt = cur && tide ? `${cur}|${tide}|rev${POINT_ANSWER_REV}` : null;
    const g: Record<TileGroup, string | null> = { wx, cur, tide, land: coast, pt };
    tiles.store.setGenerations(g);
  }

  /** Own-vessel position from Signal K (navigation.position), or null. */
  function vesselPosition(): VesselPosition | null {
    try {
      const raw = app.getSelfPath?.('navigation.position') as { value?: unknown; latitude?: unknown; longitude?: unknown } | undefined;
      const p = (raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw) as
        { latitude?: unknown; longitude?: unknown } | undefined;
      if (!p || typeof p.latitude !== 'number' || typeof p.longitude !== 'number') return null;
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180)
        return null;
      return { lat: p.latitude, lon: p.longitude };
    } catch {
      return null;
    }
  }

  function requestRefresh(force: boolean): void {
    if (!workers.data.ready) {
      pendingRefresh = { force: (pendingRefresh?.force ?? false) || force };
      return;
    }
    post('data', { type: 'refresh', force, position: vesselPosition() });
  }

  function jobsSummary(): string {
    if (!jobs) return 'no jobs';
    return `${jobs.runningId ? 1 : 0} running, ${jobs.queueLength} queued`;
  }

  function updateStatus(): void {
    if (stopped) return;
    if (forecastRun) {
      const ix = forecastRun.index;
      const b = new Date(ix.steps[ix.steps.length - 1].validMs);
      const cur = dataStatus?.currents.length ? `, currents ${dataStatus.currents.map(c => c.name).join('/')}` : ', no currents';
      app.setPluginStatus(
        `global forecast ${new Date(ix.cycleTimeMs).toISOString().slice(0, 13)}Z to ${b.toISOString().slice(0, 13)}Z (${ix.steps.length} steps, ${(ix.bytes / 1e6).toFixed(0)} MB decoded on disk)${cur}; ${jobsSummary()}${forecastError ? `; reload refused: ${forecastError}` : ''}`
      );
    } else if (forecastError) {
      app.setPluginError(`forecast unavailable: ${forecastError}`);
    } else {
      app.setPluginStatus(`loading forecast; ${jobsSummary()}`);
    }
  }

  function notify(job: Job, state: 'normal' | 'alert' | 'warn', message: string): void {
    if (!config?.publish.notifications || !app.handleMessage) return;
    try {
      app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            values: [
              {
                path: `notifications.weatherRouterPlus.${job.id}`,
                value: { state, method: [], message, timestamp: new Date().toISOString() },
              },
            ],
          },
        ],
      });
    } catch (err) {
      app.error(`notification failed: ${(err as Error).message}`);
    }
  }

  async function publish(id: string): Promise<string> {
    if (!jobs) throw new Error('plugin not started');
    const job = jobs.get(id);
    if (!job || !job.skRoute) throw new Error('job has no route');
    if (!app.resourcesApi?.setResource) throw new Error('this Signal K server has no Resources API');
    try {
      await app.resourcesApi.setResource('routes', job.id, job.skRoute);
      jobs.setPublished(job.id, job.id);
      log(`job ${job.id} published as route resource ${job.id}`);
      return job.id;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      jobs.setPublished(job.id, null, msg);
      throw new Error(`Resources API rejected the route: ${msg} (is a routes provider such as resources-provider enabled?)`, {
        cause: err,
      });
    }
  }

  function onWorkerMessage(role: MainRole, msg: WorkerToMain): void {
    switch (msg.type) {
      case 'ready':
        workers[role].ready = true;
        log(`${role} worker ready`);
        // A (re)started route worker learns where the decoded run is.
        if (role === 'route' && forecastRun) post('route', { type: 'forecast', run: forecastRun });
        if (role === 'route' && smocShared) post('route', { type: 'smoc', smoc: smocShared });
        if (role === 'route' && harmonicShared) post('route', { type: 'harmonic', sources: harmonicShared });
        if (role === 'data' && pendingRefresh) {
          const f = pendingRefresh.force;
          pendingRefresh = null;
          requestRefresh(f);
        }
        if (role === 'route') post('route', { type: 'refresh', force: false });
        return;
      case 'log':
        if (msg.level === 'error') app.error(msg.message);
        else log(msg.message);
        return;
      case 'forecast':
        if (role !== 'data') return;
        forecastRun = msg.run;
        updateTileGenerations();
        forecastError = null;
        if (failedRefreshTimer) {
          clearTimeout(failedRefreshTimer);
          failedRefreshTimer = null;
        }
        registerWeather();
        // The route and tiles workers read from the same run on disk.
        post('route', { type: 'forecast', run: msg.run });
        prebuilder?.broadcast({ type: 'forecast', run: msg.run });
        releaseWaitingJob('first forecast ready');
        log(
          `forecast ${new Date(msg.run.index.cycleTimeMs).toISOString().slice(0, 13)}Z ready: decoded run ${msg.run.dir} (${(msg.run.index.bytes / 1e6).toFixed(1)} MB on disk; nothing resident)`
        );
        updateStatus();
        return;
      case 'forecast-memory':
        if (role === 'route') routeForecastMemory = msg.memory;
        return;
      case 'forecast-unchanged':
        if (role === 'data') updateStatus();
        return;
      case 'refresh-error':
        if (role !== 'data') return;
        forecastError = msg.message;
        app.error(`forecast refresh failed: ${msg.message}${forecastRun ? ' (keeping the decoded run in use)' : ''}`);
        releaseWaitingJob(`the first forecast failed (${msg.message}); computing with what can be loaded`);
        if (!failedRefreshTimer) {
          failedRefreshTimer = setTimeout(() => {
            failedRefreshTimer = null;
            if (!stopped) requestRefresh(false);
          }, 10 * 60_000);
        }
        updateStatus();
        return;
      case 'currents':
        if (role === 'route') routeCurrents = msg.status;
        if (role === 'data') {
          log(`currents: ${msg.status.length ? msg.status.map(c => `${c.name} (p${c.priority})`).join(', ') : 'none'}`);
          // New RTOFS on disk (new run or region): the route worker reloads its copy from the cache.
          const key = `${msg.status.map(c => c.name).join('+')}|${msg.rtofsRun ?? ''}`;
          if (key !== currentsKey) {
            const first = currentsKey === '';
            currentsKey = key;
            updateTileGenerations();
            if (!first || msg.rtofsRun) {
              post('route', { type: 'refresh', force: false });
              prebuilder?.broadcast({ type: 'refresh', force: false });
            }
          }
        }
        return;
      case 'harmonic':
        if (role === 'data') {
          // Shared constituent blocks: the route worker adopts the same memory.
          harmonicShared = msg.sources;
          post('route', { type: 'harmonic', sources: msg.sources });
          prebuilder?.broadcast({ type: 'harmonic', sources: msg.sources });
        }
        return;
      case 'smoc':
        if (role === 'data') {
          // SharedArrayBuffer views: the route worker gets the same memory.
          smocShared = msg.smoc;
          post('route', { type: 'smoc', smoc: msg.smoc });
          prebuilder?.broadcast({ type: 'smoc', smoc: msg.smoc });
          updateTileGenerations();
        }
        return;
      case 'tides-run':
        if (role === 'data') {
          tidesRun = msg.run;
          prebuilder?.broadcast({ type: 'tides-run', run: msg.run });
        }
        return;
      case 'data-status':
        if (role === 'data') {
          dataStatus = msg.status;
          updateTileGenerations();
          updateStatus();
        }
        return;
      case 'progress':
        jobs?.onProgress(msg.id, msg.stage, msg.total, msg.message);
        return;
      case 'done': {
        jobs?.onDone(msg.id, msg.geojson, msg.skRoute, msg.summary, msg.skeleton);
        const job = jobs?.get(msg.id);
        if (job) {
          notify(
            job,
            'normal',
            `route ready: ${(msg.summary.total_distance_m / 1852).toFixed(1)} nm, ${(msg.summary.total_time_s / 3600).toFixed(1)} h`
          );
          const wantPublish = job.request.publish ?? config?.publish.toResources ?? false;
          if (wantPublish) publish(job.id).catch(err => app.error((err as Error).message));
        }
        updateStatus();
        return;
      }
      case 'error': {
        jobs?.onError(msg.id, msg.message, msg.cancelled);
        const job = jobs?.get(msg.id);
        if (job && !msg.cancelled) notify(job, 'alert', `route failed: ${msg.message}`);
        updateStatus();
        return;
      }
      case 'query-result': {
        const p = pendingQueries.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pendingQueries.delete(msg.id);
          p.resolve({ result: msg.result, complete: msg.complete });
        }
        return;
      }
      case 'query-error': {
        const p = pendingQueries.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pendingQueries.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        return;
      }
    }
  }

  function startWorker(role: MainRole): void {
    if (!cancelFlag) cancelFlag = new Int32Array(new SharedArrayBuffer(4));
    const isTs = __filename.endsWith('.ts');
    const workerPath = path.join(__dirname, 'plugin', isTs ? 'worker.ts' : 'worker.js');
    const worker = new Worker(workerPath, {
      workerData: { cancelFlag: cancelFlag.buffer, role },
      execArgv: isTs ? ['--import', 'tsx'] : [],
    });
    workers[role] = { role, worker, ready: false };
    // After a restart (stop() then start()) the old worker is still shutting
    // down; its late events must not touch the new worker's slot, queries
    // or jobs. Only the worker currently in workers[role] is acted on.
    const isCurrent = (): boolean => workers[role].worker === worker;
    worker.on('message', (m: WorkerToMain) => {
      if (isCurrent()) onWorkerMessage(role, m);
    });
    worker.on('error', err => {
      app.error(`${role} worker error: ${err.message}${isCurrent() ? '' : ' (worker already replaced)'}`);
      if (isCurrent() && role === 'route') jobs?.failRunning(`worker crashed: ${err.message}`);
    });
    worker.on('exit', code => {
      if (!isCurrent()) return;
      workers[role] = { role, worker: null, ready: false };
      if (role === 'data') rejectPendingQueries('data worker exited');
      if (!stopped) {
        app.error(`${role} worker exited with code ${code}; restarting in 5 s`);
        if (role === 'route') jobs?.failRunning(`worker exited with code ${code}`);
        setTimeout(() => {
          if (!stopped && config && !workers[role].worker) {
            startWorker(role);
            post(role, { type: 'init', role, config, cacheDir: app.getDataDirPath() });
            if (role === 'data') requestRefresh(false);
            else {
              if (forecastRun) post('route', { type: 'forecast', run: forecastRun });
              if (smocShared) post('route', { type: 'smoc', smoc: smocShared });
              if (harmonicShared) post('route', { type: 'harmonic', sources: harmonicShared });
            }
          }
        }, 5000);
      }
    });
  }

  function registerWeather(): void {
    if (weatherRegistered || !config?.weatherProvider.enabled) return;
    if (typeof app.registerWeatherProvider !== 'function') {
      log('Weather API not available on this server; provider not registered');
      return;
    }
    try {
      // Water level for point forecasts comes from the data worker's tide point series (on demand).
      const tideSeries = async (lat: number, lon: number, fromMs: number, hours: number): Promise<TideSeriesResult | null> => {
        if (!config?.tides.enabled) return null;
        return (await pointQuery('tide_series', { lat, lon, fromMs, hours })) as TideSeriesResult;
      };
      // Point forecasts are read by the data worker from the decoded run (this thread holds no forecast).
      const points = async (
        position: { latitude: number; longitude: number },
        options?: { startDate?: string; maxCount?: number }
      ): Promise<WeatherData[]> => {
        if (!forecastRun) throw new Error('no forecast loaded yet');
        return (await pointQuery('weather_point', {
          lat: position.latitude,
          lon: position.longitude,
          // No start given: from the start of this hour (not this millisecond), so the answer can be kept for the hour.
          startMs: startMsOf(options) ?? Math.floor(Date.now() / 3600_000) * 3600_000,
          maxCount: options?.maxCount ?? null,
        })) as WeatherData[];
      };
      app.registerWeatherProvider(makeWeatherProvider(points, PLUGIN_ID, tideSeries, m => log(m)));
      weatherRegistered = true;
      log('registered as a Weather API provider');
    } catch (err) {
      app.error(`Weather API registration failed: ${(err as Error).message}`);
    }
  }

  /**
   * Apply a settings change live: every thread gets the new config (the
   * next route uses it); the forecast reloads only for a new horizon or
   * field set, RTOFS only for RTOFS changes.
   */
  function applySettings(changed: string[]): {
    forecast: boolean;
    currents: boolean;
    tides: boolean;
    refresh_timer: boolean;
    jobs: boolean;
  } {
    const kinds = reloadsFor(changed);
    const out = {
      forecast: kinds.has('forecast'),
      currents: kinds.has('currents'),
      tides: kinds.has('tides'),
      refresh_timer: kinds.has('refresh_timer'),
      jobs: kinds.has('jobs'),
    };
    if (stopped || !settings || changed.length === 0)
      return { forecast: false, currents: false, tides: false, refresh_timer: false, jobs: false };
    config = resolve(pluginOptions, settings.values);
    if (out.currents) smocShared = null;
    if (out.forecast || out.currents || out.tides) {
      dataSettingsRev++;
      updateTileGenerations();
    }
    post('data', {
      type: 'config',
      config,
      reload: { forecast: out.forecast, currents: out.currents, tides: out.tides },
      position: vesselPosition(),
    });
    post('route', { type: 'config', config, reload: { forecast: false, currents: out.currents } });
    prebuilder?.broadcast({ type: 'config', config, reload: { forecast: false, currents: out.currents, tides: out.tides } });
    if (out.refresh_timer) {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => requestRefresh(false), config.forecast.refreshMinutes * 60_000);
    }
    if (out.jobs) jobs?.setKeepJobs(config.routing.keepJobs);
    log(
      `settings changed: ${changed.join(', ')}${out.forecast ? '; reloading the forecast' : ''}${out.currents ? '; reloading currents' : ''}${out.tides ? '; reloading tides' : ''}`
    );
    updateStatus();
    return out;
  }

  /** Forecast parameters each prebuilt layer needs. */
  const LAYER_NEEDS: Partial<Record<TileLayer, string[]>> = {
    wind: ['10u', '10v'],
    barbs: ['10u', '10v'],
    waves: ['swh', 'mwp', 'mwd'],
    sea_state: ['10u', '10v', 'swh', 'mwp', 'mwd'],
    precip: ['tprate', 'ptype'],
    temperature: ['2t'],
    sst: ['skt'],
    msl: ['msl'],
  };

  function startPrebuilder(dataDir: string): void {
    if (!config || !tiles) return;
    const isTs = __filename.endsWith('.ts');
    const oc = config.overlayCache;
    const store = tiles.store;
    prebuilder = new TilePrebuilder(
      {
        enabled: oc.enabled,
        radiusM: oc.radiusM,
        windowS: oc.windowS,
        maxZoom: oc.maxZoom,
        workers: oc.workers,
        followView: oc.followView,
      },
      {
        store,
        dataDir,
        workerPath: path.join(__dirname, 'plugin', isTs ? 'worker.ts' : 'worker.js'),
        execArgv: isTs ? ['--import', 'tsx'] : [],
        // Its own flag: route cancellation must not reach the tiles workers.
        cancelFlag: new SharedArrayBuffer(4),
        initMessage: () => ({ type: 'init', role: 'tiles', config: config as ResolvedConfig, cacheDir: dataDir }),
        replayMessages: () => {
          const m: MainToWorker[] = [];
          if (forecastRun) m.push({ type: 'forecast', run: forecastRun });
          if (smocShared) m.push({ type: 'smoc', smoc: smocShared });
          if (harmonicShared) m.push({ type: 'harmonic', sources: harmonicShared });
          m.push({ type: 'tides-run', run: tidesRun });
          m.push({ type: 'refresh', force: false });
          return m;
        },
        vesselPosition,
        lastHourMs: layer => {
          if (layer === 'tide') return tidesRun ? runLastMs(tidesRun) : null;
          if (!forecastRun) return null;
          return forecastRun.index.steps[forecastRun.index.steps.length - 1].validMs;
        },
        layerAvailable: layer => {
          if (!forecastRun) return false;
          if (layer === 'tide') return !!config?.tides.enabled && !!tidesRun;
          if (layer === 'current' || layer === 'arrows') return (dataStatus?.currents.length ?? 0) > 0;
          if ((layer === 'waves' || layer === 'sea_state') && dataStatus?.forecast && !dataStatus.forecast.hasWaves) return false;
          const params = forecastRun.index.request.params;
          return (LAYER_NEEDS[layer] ?? []).every(p => params.includes(p));
        },
        busy: () => !!jobs?.runningId || pendingQueries.size > 0,
        log,
        error: m => app.error(m),
      }
    );
    prebuilder.start();
  }

  async function start(options: PluginConfig): Promise<void> {
    stopped = false;
    pluginOptions = options;
    try {
      settings = new SettingsStore(app.getDataDirPath());
      // First start with settings.json absent: migrate the old plugin-config keys.
      const loaded = settings.load(options as LegacyPluginConfig);
      if (loaded.created)
        log(
          `settings.json created; migrated from the plugin config: ${loaded.migrated.length ? loaded.migrated.join(', ') : 'nothing set'}`
        );
      for (const p of loaded.problems) app.error(`settings: ${p}`);
      config = resolve(options, settings.values);
    } catch (err) {
      app.setPluginError((err as Error).message);
      throw err;
    }
    const gen = ++startGen;
    const dataDir = app.getDataDirPath();
    if (config.landShapefiles.length > 0) {
      // A configured coastline must be there: it is never replaced by a download.
      const bad = unreadableCoastlines(config.landShapefiles);
      if (bad.length) {
        app.setPluginError(
          `coastline shapefile ${bad.join(', ')}: fix the path in the plugin config (Coastline shapefile(s)), or clear it to download GSHHG`
        );
        return;
      }
      startServices(dataDir);
      return;
    }
    // None configured: download GSHHG (minutes), then start. Not awaited, so the server's start-up is not held up.
    void downloadCoastline(gen, dataDir).then(ok => {
      if (!ok || !settings || gen !== startGen || stopped) return;
      config = resolve(options, settings.values);
      startServices(dataDir);
    });
  }

  /** Workers, jobs, tiles and timers, once the coastline is known. */
  function startServices(dataDir: string): void {
    if (!config) return;
    tiles = new TileService(
      new TileStore({ root: path.join(dataDir, 'overlay-tiles'), capBytes: config.overlayCache.diskCapBytes, log }),
      queryFull
    );
    updateTileGenerations();
    startPrebuilder(dataDir);
    jobs = new JobManager(dataDir, config.routing.keepJobs, BASE_PATH);
    jobs.on('start', (job: Job) => {
      // First start: the first forecast is still downloading. The route waits for it
      // rather than downloading its own copy of the same fields alongside.
      if (!forecastRun && !forecastError) {
        waitingForForecast = job;
        jobs?.onProgress(job.id, 0, 0, 'waiting for the first forecast (downloading and decoding; a few minutes on a first start)');
        updateStatus();
        return;
      }
      void dispatchRoute(job);
      updateStatus();
    });
    for (const role of ['data', 'route'] as MainRole[]) {
      startWorker(role);
      post(role, { type: 'init', role, config, cacheDir: dataDir });
    }
    requestRefresh(false);
    refreshTimer = setInterval(() => requestRefresh(false), config.forecast.refreshMinutes * 60_000);
    updateStatus();
    log(`${PLUGIN_ID} started; data dir ${dataDir}`);
  }

  function stop(): void {
    stopped = true;
    startGen++;
    coastlineCtrl?.abort();
    coastlineCtrl = null;
    coastlineManualCtrl?.abort();
    coastlineManualCtrl = null;
    if (refreshTimer) clearInterval(refreshTimer);
    if (failedRefreshTimer) clearTimeout(failedRefreshTimer);
    refreshTimer = failedRefreshTimer = null;
    for (const role of ['data', 'route'] as MainRole[]) {
      const h = workers[role];
      if (h.worker) {
        post(role, { type: 'shutdown' });
        const w = h.worker;
        setTimeout(() => void w.terminate(), 2000);
      }
      workers[role] = { role, worker: null, ready: false };
    }
    rejectPendingQueries('plugin stopped');
    jobs?.failRunning('plugin stopped');
    waitingForForecast = null;
    jobs = null;
    prebuilder?.stop();
    prebuilder = null;
    tidesRun = null;
    tiles = null;
    forecastRun = null;
    routeForecastMemory = null;
    smocShared = null;
    harmonicShared = null;
    routeCurrents = null;
    currentsKey = '';
    dataStatus = null;
    config = null;
    log(`${PLUGIN_ID} stopped`);
  }

  function registerWithRouter(router: IRouter): void {
    registerApi(router, {
      pluginId: PLUGIN_ID,
      basePath: BASE_PATH,
      get jobs(): JobManager {
        if (!jobs) throw new Error(notStartedReason());
        return jobs;
      },
      notReady: notStartedReason,
      status: () => ({
        plugin: PLUGIN_ID,
        started: !stopped,
        workers: { data: workers.data.ready, route: workers.route.ready },
        forecast: forecastRun
          ? {
              cycle: new Date(forecastRun.index.cycleTimeMs).toISOString(),
              valid_from: new Date(forecastRun.index.steps[0].validMs).toISOString(),
              valid_to: new Date(forecastRun.index.steps[forecastRun.index.steps.length - 1].validMs).toISOString(),
              steps: forecastRun.index.steps.length,
              params: forecastRun.index.request.params,
              coverage: 'global',
              storage: 'decoded-on-disk',
              loaded_at: new Date(forecastRun.loadedAtMs).toISOString(),
              has_waves:
                dataStatus?.forecast?.hasWaves ??
                forecastRun.index.steps.every(s => ['swh', 'mwp', 'mwd'].every(p => s.params.includes(p))),
              // 'disk': a complete decoded run was found on disk (no decode); 'grib': decoded from the GRIB cache / download.
              source: forecastRun.source,
              ready_ms: forecastRun.readyMs,
              fields_downloaded: forecastRun.downloaded,
              decoded_dir: forecastRun.dir,
              decoded_bytes: forecastRun.index.bytes,
              decoded_at: forecastRun.index.decodedAt,
              decode_ms: forecastRun.index.decodeMs,
              decoded_disk_bytes: dataStatus?.forecast?.decodedDiskBytes ?? null,
              grib_cache_bytes: dataStatus?.forecast?.gribCacheBytes ?? null,
              last_decode: dataStatus?.lastDecode ?? null,
              memory: {
                // Forecast memory actually held now; the decoded run itself is never resident.
                data_worker_held_bytes: dataStatus?.forecastMemory.heldBytes ?? 0,
                data_worker_largest_recent_window: dataStatus?.forecastMemory.last ?? null,
                route_worker_held_bytes: routeForecastMemory?.heldBytes ?? 0,
                route_worker_largest_recent_window: routeForecastMemory?.last ?? null,
                decoding_block_bytes: dataStatus?.decodingBlockBytes ?? null,
              },
            }
          : null,
        process_rss_bytes: process.memoryUsage().rss,
        forecast_error: forecastError,
        currents: dataStatus?.currents ?? [],
        currents_route_worker: routeCurrents ?? [],
        rtofs_run: dataStatus?.rtofsRun ?? null,
        tides: config?.tides.enabled ? (dataStatus?.tides ?? null) : null,
        tides_enabled: config?.tides.enabled ?? null,
        tides_error: dataStatus?.tidesError ?? null,
        overlay_land: dataStatus?.land ?? null,
        overlay_tiles: tiles ? { ...tiles.store.stats(), inflight: tiles.inflightCount } : null,
        overlay_prebuild: prebuilder ? prebuilder.status() : null,
        starting: !jobs && !stopped ? notStartedReason() : null,
        coastline: {
          configured: pluginOptions?.landShapefiles?.trim() ? pluginOptions.landShapefiles : null,
          in_use: config?.landShapefiles ?? null,
          downloaded: gshhgInstalled(app.getDataDirPath()),
          ...coastline,
        },
        weather_provider_registered: weatherRegistered,
        jobs: jobs ? { running: jobs.runningId, queued: jobs.queueLength, total: jobs.list(500).length } : null,
        vessel: config?.vessel,
        polar_source: config?.polarSource,
        polar: config?.polarFile,
        managed_polar: app.getSelfPath?.('polars.activePolar'),
        land: config?.landShapefiles,
        harmonic_dir: config?.currents.harmonicDir,
        extra_fields: config?.forecast.extraFields,
      }),
      forecastInfo: async (lat, lon) => {
        if (!forecastRun) throw new Error(forecastError ? `forecast unavailable: ${forecastError}` : 'forecast not loaded yet');
        const ix = forecastRun.index;
        const out: Record<string, unknown> = {
          cycle: new Date(ix.cycleTimeMs).toISOString(),
          valid_from: new Date(ix.steps[0].validMs).toISOString(),
          valid_to: new Date(ix.steps[ix.steps.length - 1].validMs).toISOString(),
          steps: ix.stepHours,
          params: ix.request.params,
          coverage: 'global',
        };
        if (lat !== undefined && lon !== undefined) out.samples = await pointQuery('forecast_info', { lat, lon });
        return out;
      },
      refreshForecast: force => requestRefresh(force),
      cancelRunning: (id: string) => {
        if (resolvingPolarJob === id) {
          resolvingPolarJob = null;
          jobs?.onError(id, 'cancelled', true);
          return;
        }
        // Still waiting for the first forecast: nothing was sent to the worker.
        if (waitingForForecast && waitingForForecast.id === id) {
          waitingForForecast = null;
          jobs?.onError(id, 'cancelled', true);
          return;
        }
        if (cancelFlag) Atomics.store(cancelFlag, 0, 1);
      },
      publish,
      query,
      tiles: () => tiles,
      downloadCoastline: requestCoastlineDownload,
      noteTileRequest: (z, x, y) => prebuilder?.noteRequest(z, x, y),
      publicDir: path.join(__dirname, '..', 'public'),
      polarLibrary: () => (config ? { polarFile: config.polarFile, polarsDir: config.polarsDir, userDir: config.polarUserDir } : null),
      managedPolar: () => detectManagedPolar(app),
      getSettings: () => {
        if (!settings || stopped) throw new Error('plugin not started');
        return { values: settings.values, schema: settingsSchema() };
      },
      updateSettings: (partial: unknown) => {
        if (!settings || stopped) throw new Error('plugin not started');
        // Resource guard: refuse a forecast change the device cannot do
        // (memory for one decode step, disk for the decoded run), before
        // saving, so the running forecast and settings stay as they are.
        const prospective = mergeSettings(settings.values, partial);
        if (prospective.changed.some(k => k === 'forecast.horizon' || k === 'forecast.extraFields' || k === 'forecast.memoryHeadroom')) {
          const f = prospective.values.forecast;
          const mem = checkDecodeResources(f.horizon / 3600, f.extraFields, f.memoryHeadroom, app.getDataDirPath());
          if (!mem.ok) {
            const key = prospective.changed.find(k => k.startsWith('forecast.')) ?? 'forecast.horizon';
            throw new SettingsValidationError({ [key]: mem.message });
          }
        }
        const { values, changed } = settings.update(partial);
        const reloaded = applySettings(changed);
        return { values, changed, reloaded };
      },
    });
  }

  return {
    id: PLUGIN_ID,
    name: 'Weather Router Plus',
    description:
      'Standalone weather routing: ECMWF open-data forecasts, Copernicus Marine SMOC and NOAA RTOFS currents and Copernicus Marine hourly sea level (tides) decoded in-process, harmonic tidal currents, GSHHG coastline avoidance, vessel polars. ' +
      'Routes via its own API at /plugins/signalk-weather-router-plus, saved to the Resources API, forecast offered through the Weather API.',
    schema: () => CONFIG_SCHEMA,
    start,
    stop,
    registerWithRouter,
    getOpenApi: () => openApiDocument(BASE_PATH),
  };
};
