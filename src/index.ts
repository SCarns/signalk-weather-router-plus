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

import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IRouter } from 'express';
import { CONFIG_SCHEMA, resolveConfig, type LegacyPluginConfig, type PluginConfig, type ResolvedConfig } from './plugin/config';
import { mergeSettings, reloadsFor, settingsSchema, SettingsStore, SettingsValidationError } from './plugin/settings';
import { checkDecodeResources } from './plugin/memguard';
import { JobManager, type Job } from './plugin/jobs';
import { registerApi } from './plugin/api';
import { openApiDocument } from './plugin/openapi';
import { makeWeatherProvider, startMsOf, type WeatherData } from './plugin/weather';
import type {
  DataStatus, ForecastMemory, ForecastRunInfo, MainToWorker, QueryArgs, QueryKind, TideSeriesResult, VesselPosition, WorkerRole, WorkerToMain,
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

interface WorkerHandle {
  role: WorkerRole;
  worker: Worker | null;
  ready: boolean;
}

export = function plugin(app: SkApp): SignalKPlugin {
  let config: ResolvedConfig | null = null;
  const workers: Record<WorkerRole, WorkerHandle> = {
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
  const pendingQueries = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  const log = (msg: string): void => app.debug(msg);

  function post(role: WorkerRole, msg: MainToWorker): void {
    workers[role].worker?.postMessage(msg);
  }

  function query<K extends QueryKind>(kind: K, args: QueryArgs[K]): Promise<unknown> {
    const h = workers.data;
    if (!h.worker || !h.ready) return Promise.reject(new Error('data worker not ready'));
    const id = ++queryId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingQueries.delete(id);
        reject(new Error('query timed out'));
      }, QUERY_TIMEOUT_MS);
      pendingQueries.set(id, { resolve, reject, timer });
      post('data', { type: 'query', id, kind, args });
    });
  }

  /** Own-vessel position from Signal K (navigation.position), or null. */
  function vesselPosition(): VesselPosition | null {
    try {
      const raw = app.getSelfPath?.('navigation.position') as { value?: unknown; latitude?: unknown; longitude?: unknown } | undefined;
      const p = (raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw) as { latitude?: unknown; longitude?: unknown } | undefined;
      if (!p || typeof p.latitude !== 'number' || typeof p.longitude !== 'number') return null;
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) return null;
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
      const cur = dataStatus?.currents.length ? `, currents ${dataStatus.currents.map((c) => c.name).join('/')}` : ', no currents';
      app.setPluginStatus(`global forecast ${new Date(ix.cycleTimeMs).toISOString().slice(0, 13)}Z to ${b.toISOString().slice(0, 13)}Z (${ix.steps.length} steps, ${(ix.bytes / 1e6).toFixed(0)} MB decoded on disk)${cur}; ${jobsSummary()}${forecastError ? `; reload refused: ${forecastError}` : ''}`);
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
        updates: [{ values: [{ path: `notifications.weatherRouterPlus.${job.id}`, value: { state, method: [], message, timestamp: new Date().toISOString() } }] }],
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
      throw new Error(`Resources API rejected the route: ${msg} (is a routes provider such as resources-provider enabled?)`);
    }
  }

  function onWorkerMessage(role: WorkerRole, msg: WorkerToMain): void {
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
        forecastError = null;
        if (failedRefreshTimer) {
          clearTimeout(failedRefreshTimer);
          failedRefreshTimer = null;
        }
        registerWeather();
        // The route worker reads route areas from the same run on disk.
        post('route', { type: 'forecast', run: msg.run });
        log(`forecast ${new Date(msg.run.index.cycleTimeMs).toISOString().slice(0, 13)}Z ready: decoded run ${msg.run.dir} (${(msg.run.index.bytes / 1e6).toFixed(1)} MB on disk; nothing resident)`);
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
          log(`currents: ${msg.status.length ? msg.status.map((c) => `${c.name} (p${c.priority})`).join(', ') : 'none'}`);
          // New RTOFS on disk (new run or region): the route worker reloads its copy from the cache.
          const key = `${msg.status.map((c) => c.name).join('+')}|${msg.rtofsRun ?? ''}`;
          if (key !== currentsKey) {
            const first = currentsKey === '';
            currentsKey = key;
            if (!first || msg.rtofsRun) post('route', { type: 'refresh', force: false });
          }
        }
        return;
      case 'harmonic':
        if (role === 'data') {
          // Shared constituent blocks: the route worker adopts the same memory.
          harmonicShared = msg.sources;
          post('route', { type: 'harmonic', sources: msg.sources });
        }
        return;
      case 'smoc':
        if (role === 'data') {
          // SharedArrayBuffer views: the route worker gets the same memory.
          smocShared = msg.smoc;
          post('route', { type: 'smoc', smoc: msg.smoc });
        }
        return;
      case 'data-status':
        if (role === 'data') {
          dataStatus = msg.status;
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
          notify(job, 'normal', `route ready: ${(msg.summary.total_distance_m / 1852).toFixed(1)} nm, ${(msg.summary.total_time_s / 3600).toFixed(1)} h`);
          const wantPublish = job.request.publish ?? config?.publish.toResources ?? false;
          if (wantPublish) publish(job.id).catch((err) => app.error((err as Error).message));
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
          p.resolve(msg.result);
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

  function startWorker(role: WorkerRole): void {
    if (!cancelFlag) cancelFlag = new Int32Array(new SharedArrayBuffer(4));
    const isTs = __filename.endsWith('.ts');
    const workerPath = path.join(__dirname, 'plugin', isTs ? 'worker.ts' : 'worker.js');
    const worker = new Worker(workerPath, {
      workerData: { cancelFlag: cancelFlag.buffer, role },
      execArgv: isTs ? ['--import', 'tsx'] : [],
    });
    workers[role] = { role, worker, ready: false };
    worker.on('message', (m: WorkerToMain) => onWorkerMessage(role, m));
    worker.on('error', (err) => {
      app.error(`${role} worker error: ${err.message}`);
      if (role === 'route') jobs?.failRunning(`worker crashed: ${err.message}`);
    });
    worker.on('exit', (code) => {
      workers[role] = { role, worker: null, ready: false };
      if (role === 'data') {
        for (const [id, p] of pendingQueries) {
          clearTimeout(p.timer);
          p.reject(new Error('data worker exited'));
          pendingQueries.delete(id);
        }
      }
      if (!stopped) {
        app.error(`${role} worker exited with code ${code}; restarting in 5 s`);
        if (role === 'route') jobs?.failRunning(`worker exited with code ${code}`);
        setTimeout(() => {
          if (!stopped && config) {
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
        return await query('tide_series', { lat, lon, fromMs, hours }) as TideSeriesResult;
      };
      // Point forecasts are read by the data worker from the decoded run (this thread holds no forecast).
      const points = async (position: { latitude: number; longitude: number }, options?: { startDate?: string; maxCount?: number }): Promise<WeatherData[]> => {
        if (!forecastRun) throw new Error('no forecast loaded yet');
        return await query('weather_point', { lat: position.latitude, lon: position.longitude, startMs: startMsOf(options), maxCount: options?.maxCount ?? null }) as WeatherData[];
      };
      app.registerWeatherProvider(makeWeatherProvider(points, PLUGIN_ID, tideSeries, (m) => log(m)));
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
  function applySettings(changed: string[]): { forecast: boolean; currents: boolean; tides: boolean; refresh_timer: boolean; jobs: boolean } {
    const kinds = reloadsFor(changed);
    const out = { forecast: kinds.has('forecast'), currents: kinds.has('currents'), tides: kinds.has('tides'), refresh_timer: kinds.has('refresh_timer'), jobs: kinds.has('jobs') };
    if (stopped || !settings || changed.length === 0) return { forecast: false, currents: false, tides: false, refresh_timer: false, jobs: false };
    config = resolveConfig(pluginOptions, settings.values);
    if (out.currents) smocShared = null;
    post('data', { type: 'config', config, reload: { forecast: out.forecast, currents: out.currents, tides: out.tides }, position: vesselPosition() });
    post('route', { type: 'config', config, reload: { forecast: false, currents: out.currents } });
    if (out.refresh_timer) {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => requestRefresh(false), config.forecast.refreshMinutes * 60_000);
    }
    if (out.jobs) jobs?.setKeepJobs(config.routing.keepJobs);
    log(`settings changed: ${changed.join(', ')}${out.forecast ? '; reloading the forecast' : ''}${out.currents ? '; reloading currents' : ''}${out.tides ? '; reloading tides' : ''}`);
    updateStatus();
    return out;
  }

  async function start(options: PluginConfig): Promise<void> {
    stopped = false;
    pluginOptions = options;
    try {
      settings = new SettingsStore(app.getDataDirPath());
      // First start with settings.json absent: migrate the old plugin-config keys.
      const loaded = settings.load(options as LegacyPluginConfig);
      if (loaded.created) log(`settings.json created; migrated from the plugin config: ${loaded.migrated.length ? loaded.migrated.join(', ') : 'nothing set'}`);
      for (const p of loaded.problems) app.error(`settings: ${p}`);
      config = resolveConfig(options, settings.values);
    } catch (err) {
      app.setPluginError((err as Error).message);
      throw err;
    }
    if (config.landShapefiles.length === 0) {
      app.setPluginError('configure at least one coastline shapefile (landShapefiles)');
      return;
    }
    const dataDir = app.getDataDirPath();
    jobs = new JobManager(dataDir, config.routing.keepJobs, BASE_PATH);
    jobs.on('start', (job: Job) => {
      post('route', { type: 'route', id: job.id, request: job.request });
      updateStatus();
    });
    for (const role of ['data', 'route'] as WorkerRole[]) {
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
    if (refreshTimer) clearInterval(refreshTimer);
    if (failedRefreshTimer) clearTimeout(failedRefreshTimer);
    refreshTimer = failedRefreshTimer = null;
    for (const role of ['data', 'route'] as WorkerRole[]) {
      const h = workers[role];
      if (h.worker) {
        post(role, { type: 'shutdown' });
        const w = h.worker;
        setTimeout(() => void w.terminate(), 2000);
      }
      workers[role] = { role, worker: null, ready: false };
    }
    jobs?.failRunning('plugin stopped');
    jobs = null;
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
        if (!jobs) throw new Error('plugin not started');
        return jobs;
      },
      status: () => ({
        plugin: PLUGIN_ID,
        started: !stopped,
        workers: { data: workers.data.ready, route: workers.route.ready },
        forecast: forecastRun
          ? {
            cycle: new Date(forecastRun.index.cycleTimeMs).toISOString(),
            valid_from: new Date(forecastRun.index.steps[0].validMs).toISOString(),
            valid_to: new Date(forecastRun.index.steps[forecastRun.index.steps.length - 1].validMs).toISOString(),
            steps: forecastRun.index.steps.length, params: forecastRun.index.request.params, coverage: 'global',
            storage: 'decoded-on-disk',
            loaded_at: new Date(forecastRun.loadedAtMs).toISOString(),
            has_waves: dataStatus?.forecast?.hasWaves ?? forecastRun.index.steps.every((s) => ['swh', 'mwp', 'mwd'].every((p) => s.params.includes(p))),
            // 'disk': a complete decoded run was found on disk (no decode); 'grib': decoded from the GRIB cache / download.
            source: forecastRun.source, ready_ms: forecastRun.readyMs, fields_downloaded: forecastRun.downloaded,
            decoded_dir: forecastRun.dir, decoded_bytes: forecastRun.index.bytes, decoded_at: forecastRun.index.decodedAt, decode_ms: forecastRun.index.decodeMs,
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
        weather_provider_registered: weatherRegistered,
        jobs: jobs ? { running: jobs.runningId, queued: jobs.queueLength, total: jobs.list(500).length } : null,
        vessel: config?.vessel,
        polar: config?.polarFile,
        land: config?.landShapefiles,
        harmonic_dir: config?.currents.harmonicDir,
        extra_fields: config?.forecast.extraFields,
      }),
      forecastInfo: async (lat, lon) => {
        if (!forecastRun) throw new Error(forecastError ? `forecast unavailable: ${forecastError}` : 'forecast not loaded yet');
        const ix = forecastRun.index;
        const out: Record<string, unknown> = {
          cycle: new Date(ix.cycleTimeMs).toISOString(), valid_from: new Date(ix.steps[0].validMs).toISOString(),
          valid_to: new Date(ix.steps[ix.steps.length - 1].validMs).toISOString(),
          steps: ix.stepHours, params: ix.request.params, coverage: 'global',
        };
        if (lat !== undefined && lon !== undefined) out.samples = await query('forecast_info', { lat, lon });
        return out;
      },
      refreshForecast: (force) => requestRefresh(force),
      cancelRunning: () => {
        if (cancelFlag) Atomics.store(cancelFlag, 0, 1);
      },
      publish,
      query,
      publicDir: path.join(__dirname, '..', 'public'),
      polarLibrary: () => (config ? { polarFile: config.polarFile, polarsDir: config.polarsDir } : null),
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
        if (prospective.changed.some((k) => k === 'forecast.horizon' || k === 'forecast.extraFields' || k === 'forecast.memoryHeadroom')) {
          const f = prospective.values.forecast;
          const mem = checkDecodeResources(f.horizon / 3600, f.extraFields, f.memoryHeadroom, app.getDataDirPath());
          if (!mem.ok) {
            const key = prospective.changed.find((k) => k.startsWith('forecast.')) ?? 'forecast.horizon';
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
