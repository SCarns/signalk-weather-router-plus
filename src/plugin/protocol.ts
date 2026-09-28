/**
 * Message protocol between the plugin (main thread) and its two
 * workers. Both workers run the same code; `role` decides what they do:
 *  - `data`: loads the resident global forecast, the current sources
 *    and the on-demand overlay land masks; answers overlay/conditions
 *    queries; refreshes from the network.
 *  - `route`: computes routes, so a running route never blocks an
 *    overlay query. It uses the data worker's forecast, relayed by the
 *    main thread: the field arrays live in SharedArrayBuffers, so the
 *    relay shares one copy between all three threads. Current sources
 *    are its own copies, loaded from the disk cache (never the network).
 * Everything crossing the boundary is structured-cloneable.
 */

import type { ResolvedConfig } from './config';
import type { ModePolicy } from '../engine/legsim';
import type { BBox } from '../geo/geodesy';
import type { SerializedForecast } from '../data/forecast';
import type { SerializedRtofs } from '../currents/rtofs';

export type WorkerRole = 'data' | 'route';

export interface RouteRequest {
  start: { lat: number; lon: number };
  end: { lat: number; lon: number };
  waypoints?: { lat: number; lon: number; radius_m?: number }[];
  departure?: string;
  mode?: ModePolicy;
  sail_thresh_ms?: number;
  name?: string;
  stages?: number;
  no_forecast?: boolean;
  no_currents?: boolean;
  publish?: boolean;
  vessel?: {
    name?: string;
    draught?: number;
    air_draft?: number;
    loa?: number;
    beam?: number;
    motor_speed_ms?: number;
    under_keel_clearance?: number;
    /** Time lost per tack or gybe, seconds (default from plugin config). */
    tack_penalty_s?: number;
    /** Polar token from GET /api/polars (`default` or a library file name). */
    polar?: string;
  };
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobProgress {
  time: string;
  stage: number;
  total: number;
  message: string;
}

export interface RouteSummary {
  total_distance_m: number;
  total_time_s: number;
  sailing_time_s: number;
  motoring_time_s: number;
  waypoint_count: number;
  warnings: number;
  departure: string;
  arrival: string;
  forecast_cycle?: string;
  current_sources?: string[];
  /** Label of the polar the route was computed with, or null when motor-only. */
  polar?: string | null;
}

export type QueryKind = 'field' | 'currents' | 'wind_points' | 'conditions' | 'conditions_tile' | 'pressure';

export interface QueryArgs {
  field: { layer: string; bbox: BBox; timeMs: number; res: number };
  currents: { bbox: BBox; timeMs: number; res: number };
  wind_points: { bbox: BBox; timeMs: number; res: number };
  conditions: { lon: number; lat: number; fromMs: number; hours: number; stepH: number };
  /** Current-hour conditions sample points for one XYZ tile. */
  conditions_tile: { z: number; x: number; y: number; timeMs: number };
  pressure: { bbox: BBox; timeMs: number; intervalHpa: number };
}

export interface LandCacheStatus {
  entries: number;
  cells: number;
  bytes: number;
  index_bytes: number;
  builds: number;
  hits: number;
  last_build_ms: number;
}

export interface DataStatus {
  forecast: { cycle: string; validFrom: string; validTo: string; steps: number; params: string[]; global: boolean; bytes: number; shared: boolean; hasWaves: boolean; loadedAt: string } | null;
  currents: { name: string; priority: number; resolutionM: number; bbox: { south: number; west: number; north: number; east: number }; validFrom?: string; validTo?: string }[];
  rtofsRun: string | null;
  /** On-demand overlay land rasters (LRU). */
  land: LandCacheStatus | null;
}

export type MainToWorker =
  | { type: 'init'; role: WorkerRole; config: ResolvedConfig; cacheDir: string }
  /** data worker: check ECMWF/NOMADS and reload the forecast and currents; route worker: reload currents from the disk cache. */
  | { type: 'refresh'; force?: boolean }
  /** Adopt a resident forecast loaded by another thread (shared memory, no copy). */
  | { type: 'forecast'; forecast: SerializedForecast }
  /** Settings changed: new config; reload what `reload` names (data worker: forecast and currents; route worker: currents from disk). */
  | { type: 'config'; config: ResolvedConfig; reload: { forecast: boolean; currents: boolean } }
  | { type: 'route'; id: string; request: RouteRequest }
  | { type: 'query'; id: number; kind: QueryKind; args: QueryArgs[QueryKind] }
  | { type: 'shutdown' };

export type WorkerToMain =
  | { type: 'ready'; role: WorkerRole }
  | { type: 'log'; level: 'debug' | 'info' | 'error'; message: string }
  | { type: 'forecast'; forecast: SerializedForecast }
  | { type: 'forecast-unchanged'; cycleTimeMs: number }
  | { type: 'refresh-error'; message: string }
  | { type: 'currents'; status: DataStatus['currents']; rtofsRun: string | null; rtofs: SerializedRtofs | null }
  | { type: 'data-status'; status: DataStatus }
  | { type: 'progress'; id: string; stage: number; total: number; message: string }
  | { type: 'done'; id: string; geojson: Record<string, unknown>; skRoute: Record<string, unknown>; skeleton: Record<string, unknown> | null; summary: RouteSummary }
  | { type: 'error'; id: string; message: string; cancelled?: boolean }
  | { type: 'query-result'; id: number; result: unknown }
  | { type: 'query-error'; id: number; message: string };
