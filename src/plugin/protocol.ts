/**
 * Message protocol between the plugin (main thread) and the routing
 * worker. Everything crossing the boundary is structured-cloneable.
 */

import type { ResolvedConfig } from './config';
import type { ModePolicy } from '../engine/legsim';
import type { BBox } from '../geo/geodesy';

export interface RouteRequest {
  start: { lat: number; lon: number };
  end: { lat: number; lon: number };
  /** Intermediate pass-through points, in order. */
  waypoints?: { lat: number; lon: number; radius_m?: number }[];
  /** ISO 8601 departure; empty or absent = now. */
  departure?: string;
  mode?: ModePolicy;
  sail_thresh_ms?: number;
  /** Route name for the Resources API record. */
  name?: string;
  stages?: number;
  /** Override: run with calm wind (motor timing). */
  no_forecast?: boolean;
  publish?: boolean;
  vessel?: {
    name?: string;
    draught?: number;
    air_draft?: number;
    loa?: number;
    beam?: number;
    motor_speed_ms?: number;
    under_keel_clearance?: number;
  };
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobProgress {
  time: string;
  stage: number;
  total: number;
  message: string;
}

import type { SerializedForecast } from '../data/forecast';

export type MainToWorker =
  | { type: 'init'; config: ResolvedConfig; cacheDir: string }
  | { type: 'refresh'; region: BBox | null; force?: boolean }
  | { type: 'route'; id: string; request: RouteRequest; region: BBox | null }
  | { type: 'shutdown' };

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'log'; level: 'debug' | 'info' | 'error'; message: string }
  | { type: 'forecast'; forecast: SerializedForecast }
  | { type: 'forecast-unchanged'; cycleTimeMs: number }
  | { type: 'refresh-error'; message: string }
  | { type: 'progress'; id: string; stage: number; total: number; message: string }
  | { type: 'done'; id: string; geojson: Record<string, unknown>; skRoute: Record<string, unknown>; summary: RouteSummary }
  | { type: 'error'; id: string; message: string; cancelled?: boolean };

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
}
