/**
 * signalk-weather-router-plus — Signal K plugin entry point.
 *
 * Standalone open-water weather routing: ECMWF open-data forecasts
 * (decoded in-process), GSHHG coastline avoidance, vessel polars,
 * isochrone propagation in a worker thread. Routes are exposed through
 * the plugin's own REST/SSE API, saved to the Signal K Resources API,
 * and the resident forecast is offered through the Weather API.
 */

import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IRouter } from 'express';
import { CONFIG_SCHEMA, resolveConfig, type PluginConfig, type ResolvedConfig } from './plugin/config';
import { JobManager, type Job } from './plugin/jobs';
import { registerApi } from './plugin/api';
import { openApiDocument } from './plugin/openapi';
import { makeWeatherProvider } from './plugin/weather';
import type { MainToWorker, WorkerToMain } from './plugin/protocol';
import { ForecastStore } from './data/forecast';
import type { BBox } from './geo/geodesy';

const PLUGIN_ID = 'signalk-weather-router-plus';
const BASE_PATH = `/plugins/${PLUGIN_ID}`;

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

export = function plugin(app: SkApp): SignalKPlugin {
  let config: ResolvedConfig | null = null;
  let worker: Worker | null = null;
  let workerReady = false;
  let cancelFlag: Int32Array | null = null;
  let jobs: JobManager | null = null;
  let forecast: ForecastStore | null = null;
  let forecastError: string | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let regionRetryTimer: NodeJS.Timeout | null = null;
  let failedRefreshTimer: NodeJS.Timeout | null = null;
  let weatherRegistered = false;
  let stopped = true;
  const pendingRefresh = { requested: false, force: false };

  const log = (msg: string): void => app.debug(msg);

  function region(): BBox | null {
    if (!config) return null;
    if (config.forecast.region) return config.forecast.region;
    const pos = app.getSelfPath?.('navigation.position') as { value?: { latitude?: number; longitude?: number } } | { latitude?: number; longitude?: number } | undefined;
    const v = (pos && 'value' in pos ? pos.value : pos) as { latitude?: number; longitude?: number } | undefined;
    if (v && typeof v.latitude === 'number' && typeof v.longitude === 'number') {
      const half = config.forecast.regionFromVesselDeg;
      const lat = v.latitude;
      const lon = v.longitude;
      const south = Math.max(-90, Math.floor((lat - half) * 4) / 4);
      const north = Math.min(90, Math.ceil((lat + half) * 4) / 4);
      const west = ((Math.floor((lon - half) * 4) / 4 + 540) % 360) - 180;
      const east = ((Math.ceil((lon + half) * 4) / 4 + 540) % 360) - 180;
      return { west, south, east, north };
    }
    return null;
  }

  function post(msg: MainToWorker): void {
    if (!worker) return;
    worker.postMessage(msg);
  }

  function requestRefresh(force: boolean): void {
    if (!worker || !workerReady) {
      pendingRefresh.requested = true;
      pendingRefresh.force = pendingRefresh.force || force;
      return;
    }
    const reg = region();
    if (!reg) {
      // At plugin start the position delta usually has not arrived yet.
      // Retry every minute until a position (or explicit region) exists.
      forecastError = 'no forecast region yet: waiting for a vessel position (or set forecast.region in the plugin config)';
      app.setPluginStatus(`waiting for a vessel position or region (${jobsSummary()})`);
      if (!regionRetryTimer) {
        regionRetryTimer = setTimeout(() => {
          regionRetryTimer = null;
          if (!stopped) requestRefresh(force);
        }, 60_000);
      }
      return;
    }
    post({ type: 'refresh', region: reg, force });
  }

  function jobsSummary(): string {
    if (!jobs) return 'no jobs';
    const running = jobs.runningId ? 1 : 0;
    return `${running} running, ${jobs.queueLength} queued`;
  }

  function updateStatus(): void {
    if (stopped) return;
    if (forecast) {
      const [a, b] = forecast.validRange;
      app.setPluginStatus(`forecast ${forecast.meta.cycleTime.toISOString().slice(0, 13)}Z, valid to ${b.toISOString().slice(0, 13)}Z (${forecast.steps.length} steps); ${jobsSummary()}${a ? '' : ''}`);
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
        updates: [{
          values: [{
            path: `notifications.weatherRouterPlus.${job.id}`,
            value: { state, method: [], message, timestamp: new Date().toISOString() },
          }],
        }],
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

  function onWorkerMessage(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'ready':
        workerReady = true;
        log('worker ready');
        if (pendingRefresh.requested) {
          pendingRefresh.requested = false;
          requestRefresh(pendingRefresh.force);
          pendingRefresh.force = false;
        }
        return;
      case 'log':
        if (msg.level === 'error') app.error(msg.message);
        else log(msg.message);
        return;
      case 'forecast':
        forecast = ForecastStore.deserialize(msg.forecast);
        forecastError = null;
        if (failedRefreshTimer) {
          clearTimeout(failedRefreshTimer);
          failedRefreshTimer = null;
        }
        registerWeather();
        updateStatus();
        return;
      case 'forecast-unchanged':
        updateStatus();
        return;
      case 'refresh-error':
        forecastError = msg.message;
        app.error(`forecast refresh failed: ${msg.message}${forecast ? ' (keeping the resident forecast)' : ''}`);
        // Planner cadence: re-check in 10 minutes rather than waiting for
        // the hourly timer.
        if (!failedRefreshTimer) {
          failedRefreshTimer = setTimeout(() => {
            failedRefreshTimer = null;
            if (!stopped) requestRefresh(false);
          }, 10 * 60_000);
        }
        updateStatus();
        return;
      case 'progress':
        jobs?.onProgress(msg.id, msg.stage, msg.total, msg.message);
        return;
      case 'done': {
        jobs?.onDone(msg.id, msg.geojson, msg.skRoute, msg.summary);
        const job = jobs?.get(msg.id);
        if (job) {
          notify(job, 'normal', `route ready: ${(msg.summary.total_distance_m / 1852).toFixed(1)} nm, ${(msg.summary.total_time_s / 3600).toFixed(1)} h`);
          const wantPublish = job.request.publish ?? config?.publish.toResources ?? false;
          if (wantPublish) {
            publish(job.id).catch((err) => app.error((err as Error).message));
          }
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
    }
  }

  function startWorker(): void {
    const sab = new SharedArrayBuffer(4);
    cancelFlag = new Int32Array(sab);
    const isTs = __filename.endsWith('.ts');
    const workerPath = path.join(__dirname, 'plugin', isTs ? 'worker.ts' : 'worker.js');
    worker = new Worker(workerPath, {
      workerData: { cancelFlag: sab },
      execArgv: isTs ? ['--import', 'tsx'] : [],
    });
    workerReady = false;
    worker.on('message', (m: WorkerToMain) => onWorkerMessage(m));
    worker.on('error', (err) => {
      app.error(`worker error: ${err.message}`);
      jobs?.failRunning(`worker crashed: ${err.message}`);
    });
    worker.on('exit', (code) => {
      worker = null;
      workerReady = false;
      if (!stopped) {
        app.error(`worker exited with code ${code}; restarting in 5 s`);
        jobs?.failRunning(`worker exited with code ${code}`);
        setTimeout(() => {
          if (!stopped && config) {
            startWorker();
            post({ type: 'init', config, cacheDir: app.getDataDirPath() });
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
      app.registerWeatherProvider(makeWeatherProvider(() => forecast, PLUGIN_ID));
      weatherRegistered = true;
      log('registered as a Weather API provider');
    } catch (err) {
      app.error(`Weather API registration failed: ${(err as Error).message}`);
    }
  }

  async function start(options: PluginConfig): Promise<void> {
    stopped = false;
    try {
      config = resolveConfig(options);
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
      post({ type: 'route', id: job.id, request: job.request, region: region() });
      updateStatus();
    });
    startWorker();
    post({ type: 'init', config, cacheDir: dataDir });
    requestRefresh(false);
    refreshTimer = setInterval(() => requestRefresh(false), config.forecast.refreshMinutes * 60_000);
    updateStatus();
    log(`${PLUGIN_ID} started; data dir ${dataDir}`);
  }

  function stop(): void {
    stopped = true;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (regionRetryTimer) {
      clearTimeout(regionRetryTimer);
      regionRetryTimer = null;
    }
    if (failedRefreshTimer) {
      clearTimeout(failedRefreshTimer);
      failedRefreshTimer = null;
    }
    if (worker) {
      post({ type: 'shutdown' });
      const w = worker;
      setTimeout(() => void w.terminate(), 2000);
      worker = null;
    }
    workerReady = false;
    jobs?.failRunning('plugin stopped');
    jobs = null;
    forecast = null;
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
        worker_ready: workerReady,
        forecast: forecast
          ? {
            cycle: forecast.meta.cycleTime.toISOString(),
            valid_from: forecast.validRange[0].toISOString(),
            valid_to: forecast.validRange[1].toISOString(),
            steps: forecast.steps.length,
            params: forecast.meta.params,
            region: forecast.meta.bbox,
            resident_bytes: forecast.bytes(),
            loaded_at: forecast.meta.loadedAt.toISOString(),
            has_waves: forecast.hasWaves,
          }
          : null,
        forecast_error: forecastError,
        weather_provider_registered: weatherRegistered,
        jobs: jobs ? { running: jobs.runningId, queued: jobs.queueLength, total: jobs.list(500).length } : null,
        vessel: config?.vessel,
        polar: config?.polarFile,
        land: config?.landShapefiles,
      }),
      forecastInfo: (lat, lon) => {
        if (!forecast) throw new Error(forecastError ? `forecast unavailable: ${forecastError}` : 'forecast not loaded yet');
        const out: Record<string, unknown> = {
          cycle: forecast.meta.cycleTime.toISOString(),
          valid_from: forecast.validRange[0].toISOString(),
          valid_to: forecast.validRange[1].toISOString(),
          steps: forecast.meta.steps,
          region: forecast.meta.bbox,
        };
        if (lat !== undefined && lon !== undefined) {
          if (!forecast.covers(lon, lat)) throw new Error('position outside the resident forecast region');
          out.samples = forecast.steps.map((s) => {
            const t = new Date(s.validMs);
            const [ws, wd] = forecast!.at(lon, lat, t);
            const wave = forecast!.wavesAt(lon, lat, t);
            const msl = forecast!.mslAt(lon, lat, t);
            return {
              time: t.toISOString(), wind_ms: ws, wind_dir_deg: wd, msl_pa: Number.isFinite(msl) ? msl : null,
              swh_m: wave?.swh ?? null, mwp_s: wave?.mwp ?? null, mwd_deg: wave?.mwd ?? null,
            };
          });
        }
        return out;
      },
      refreshForecast: (force) => requestRefresh(force),
      cancelRunning: () => {
        if (cancelFlag) Atomics.store(cancelFlag, 0, 1);
      },
      publish,
      publicDir: path.join(__dirname, '..', 'public'),
    });
  }

  return {
    id: PLUGIN_ID,
    name: 'Weather Router Plus',
    description:
      'Standalone open-water weather routing: ECMWF open-data forecasts decoded in-process, GSHHG coastline avoidance, vessel polars. ' +
      'Routes via its own API at /plugins/signalk-weather-router-plus, saved to the Resources API, forecast offered through the Weather API.',
    schema: () => CONFIG_SCHEMA,
    start,
    stop,
    registerWithRouter,
    getOpenApi: () => openApiDocument(BASE_PATH),
  };
};
