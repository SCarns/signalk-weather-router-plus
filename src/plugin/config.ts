/**
 * Plugin configuration: the shape stored by Signal K, its JSON schema
 * for the admin UI, and normalisation into SI engine settings.
 *
 * Configuration values are entered in sailors' units (knots) where
 * noted; everything is converted to SI here and stays SI in memory.
 */

import { KTS_TO_MS } from '../geo/geodesy';
import type { BBox } from '../geo/geodesy';
import { makeVessel, type VesselParams } from '../vessel/vessel';

export interface RegionConfig {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface PluginConfig {
  landShapefiles?: string;
  polarFile?: string;
  vessel?: {
    name?: string;
    draughtM?: number;
    airDraftM?: number;
    loaM?: number;
    beamM?: number;
    underKeelClearanceM?: number;
    overheadClearanceM?: number;
    motorSpeedKts?: number;
    maxSwhM?: number;
    tackPenaltySeconds?: number;
  };
  forecast?: {
    horizonHours?: number;
    refreshMinutes?: number;
    mirror?: 'ecmwf' | 'aws' | 'google';
    region?: Partial<RegionConfig>;
    regionFromVesselDeg?: number;
    keepCycles?: number;
  };
  routing?: {
    stages?: number;
    subsectors?: number;
    headings?: number;
    headingIncrementDeg?: number;
    sailThresholdKts?: number;
    simStepM?: number;
    landRasterMaxCells?: number;
    maxConcurrentJobs?: number;
    keepJobs?: number;
  };
  publish?: {
    toResources?: boolean;
    routeNamePrefix?: string;
    notifications?: boolean;
  };
  weatherProvider?: {
    enabled?: boolean;
  };
}

export interface ResolvedConfig {
  landShapefiles: string[];
  polarFile: string | null;
  vessel: VesselParams;
  forecast: {
    horizonHours: number;
    refreshMinutes: number;
    mirror: 'ecmwf' | 'aws' | 'google';
    region: BBox | null;
    regionFromVesselDeg: number;
    keepCycles: number;
  };
  routing: {
    stages: number;
    subsectors: number;
    headings: number;
    headingIncrementDeg: number;
    sailThreshMs: number;
    simStepM: number;
    landRasterMaxCells: number;
    keepJobs: number;
  };
  publish: {
    toResources: boolean;
    routeNamePrefix: string;
    notifications: boolean;
  };
  weatherProvider: {
    enabled: boolean;
  };
}

export const CONFIG_SCHEMA = {
  type: 'object',
  required: ['landShapefiles'],
  properties: {
    landShapefiles: {
      type: 'string',
      title: 'Coastline shapefile(s)',
      description:
        'Absolute path(s) to polygon land shapefiles, comma-separated. GSHHG "GSHHS_f_L1.shp" (full resolution) is recommended; ' +
        'add "GSHHS_f_L6.shp" for Antarctica. OSM land-polygons-split-4326 also works.',
    },
    polarFile: {
      type: 'string',
      title: 'Polar file (.csv or .pol)',
      description: 'Boat speed table in knots: header "twa/tws,4,6,8,...", rows "twa,speed,...". Leave blank to route under motor only.',
    },
    vessel: {
      type: 'object',
      title: 'Vessel',
      properties: {
        name: { type: 'string', title: 'Name', default: 'Vessel' },
        draughtM: { type: 'number', title: 'Draught (m)', default: 1.8 },
        airDraftM: { type: 'number', title: 'Air draft (m)', default: 16 },
        loaM: { type: 'number', title: 'Length overall (m)', default: 11 },
        beamM: { type: 'number', title: 'Beam (m)', default: 3.7 },
        underKeelClearanceM: { type: 'number', title: 'Under-keel safety margin (m)', default: 0.5 },
        overheadClearanceM: { type: 'number', title: 'Overhead safety margin (m)', default: 1.0 },
        motorSpeedKts: { type: 'number', title: 'Cruising speed under power (kt)', default: 6 },
        maxSwhM: { type: 'number', title: 'Maximum significant wave height (m, informational)' },
        tackPenaltySeconds: { type: 'number', title: 'Tack penalty (s)', default: 30 },
      },
    },
    forecast: {
      type: 'object',
      title: 'Forecast (ECMWF open data, IFS 0.25°)',
      properties: {
        horizonHours: { type: 'number', title: 'Forecast horizon (h)', default: 72, minimum: 3, maximum: 240 },
        refreshMinutes: { type: 'number', title: 'Check for a new cycle every (min)', default: 60, minimum: 10 },
        mirror: { type: 'string', title: 'Download mirror', enum: ['ecmwf', 'aws', 'google'], default: 'ecmwf' },
        regionFromVesselDeg: {
          type: 'number',
          title: 'Region half-width around the vessel (°)',
          description: 'When no explicit region is set, the resident forecast covers this many degrees around the vessel position.',
          default: 10,
          minimum: 1,
          maximum: 60,
        },
        region: {
          type: 'object',
          title: 'Explicit region (overrides vessel-centred region)',
          properties: {
            west: { type: 'number', title: 'West (°)' },
            south: { type: 'number', title: 'South (°)' },
            east: { type: 'number', title: 'East (°)' },
            north: { type: 'number', title: 'North (°)' },
          },
        },
        keepCycles: { type: 'number', title: 'Cached cycles to keep on disk', default: 2, minimum: 1, maximum: 10 },
      },
    },
    routing: {
      type: 'object',
      title: 'Routing engine',
      properties: {
        stages: { type: 'number', title: 'Isochrone stages', default: 20, minimum: 4, maximum: 200 },
        subsectors: { type: 'number', title: 'Subsectors (k)', default: 30, minimum: 4, maximum: 200 },
        headings: { type: 'number', title: 'Headings each side (m)', default: 30, minimum: 4, maximum: 180 },
        headingIncrementDeg: { type: 'number', title: 'Heading increment (°)', default: 1, minimum: 0.25, maximum: 10 },
        sailThresholdKts: { type: 'number', title: 'Sail when boat speed exceeds (kt)', default: 4.9, minimum: 0 },
        simStepM: { type: 'number', title: 'Leg simulation step (m)', default: 200, minimum: 50, maximum: 5000 },
        landRasterMaxCells: { type: 'number', title: 'Land raster cell budget', default: 25000000, minimum: 1000000 },
        keepJobs: { type: 'number', title: 'Finished jobs to keep', default: 50, minimum: 1, maximum: 500 },
      },
    },
    publish: {
      type: 'object',
      title: 'Publishing',
      properties: {
        toResources: { type: 'boolean', title: 'Save finished routes to the Resources API (routes)', default: true },
        routeNamePrefix: { type: 'string', title: 'Route name prefix', default: 'WRP' },
        notifications: { type: 'boolean', title: 'Emit notifications.weatherRouterPlus.<jobId>', default: true },
      },
    },
    weatherProvider: {
      type: 'object',
      title: 'Weather API',
      properties: {
        enabled: { type: 'boolean', title: 'Register as a Weather API provider (point forecasts from the resident region)', default: true },
      },
    },
  },
};

function num(v: unknown, def: number, min: number, max: number, name: string): number {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`config ${name}: ${String(v)} is outside [${min}, ${max}]`);
  return n;
}

export function resolveConfig(raw: PluginConfig | undefined): ResolvedConfig {
  const c = raw ?? {};
  const land = (c.landShapefiles ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const v = c.vessel ?? {};
  const f = c.forecast ?? {};
  const r = c.routing ?? {};
  const p = c.publish ?? {};
  const w = c.weatherProvider ?? {};

  let region: BBox | null = null;
  const reg = f.region ?? {};
  const regionVals = [reg.west, reg.south, reg.east, reg.north];
  if (regionVals.some((x) => x !== undefined && x !== null && (x as unknown) !== '')) {
    if (regionVals.some((x) => x === undefined || x === null || !Number.isFinite(Number(x)))) {
      throw new Error('config forecast.region: all four of west/south/east/north are required');
    }
    region = { west: Number(reg.west), south: Number(reg.south), east: Number(reg.east), north: Number(reg.north) };
    if (region.south >= region.north) throw new Error('config forecast.region: south must be < north');
  }

  return {
    landShapefiles: land,
    polarFile: c.polarFile && c.polarFile.trim() ? c.polarFile.trim() : null,
    vessel: makeVessel({
      name: v.name && v.name.trim() ? v.name.trim() : undefined,
      draught: v.draughtM,
      airDraft: v.airDraftM,
      loa: v.loaM,
      beam: v.beamM,
      underKeelClearance: v.underKeelClearanceM,
      overheadClearance: v.overheadClearanceM,
      motorSpeedMs: v.motorSpeedKts !== undefined && v.motorSpeedKts !== null ? Number(v.motorSpeedKts) * KTS_TO_MS : undefined,
      maxSwh: v.maxSwhM !== undefined && v.maxSwhM !== null && (v.maxSwhM as unknown) !== '' ? Number(v.maxSwhM) : undefined,
      tackPenaltySeconds: v.tackPenaltySeconds,
    }),
    forecast: {
      horizonHours: num(f.horizonHours, 72, 3, 240, 'forecast.horizonHours'),
      refreshMinutes: num(f.refreshMinutes, 60, 10, 24 * 60, 'forecast.refreshMinutes'),
      mirror: (f.mirror as ResolvedConfig['forecast']['mirror']) ?? 'ecmwf',
      region,
      regionFromVesselDeg: num(f.regionFromVesselDeg, 10, 1, 60, 'forecast.regionFromVesselDeg'),
      keepCycles: num(f.keepCycles, 2, 1, 10, 'forecast.keepCycles'),
    },
    routing: {
      stages: num(r.stages, 20, 4, 200, 'routing.stages'),
      subsectors: num(r.subsectors, 30, 4, 200, 'routing.subsectors'),
      headings: num(r.headings, 30, 4, 180, 'routing.headings'),
      headingIncrementDeg: num(r.headingIncrementDeg, 1, 0.25, 10, 'routing.headingIncrementDeg'),
      sailThreshMs: num(r.sailThresholdKts, 4.9, 0, 50, 'routing.sailThresholdKts') * KTS_TO_MS,
      simStepM: num(r.simStepM, 200, 50, 5000, 'routing.simStepM'),
      landRasterMaxCells: num(r.landRasterMaxCells, 25_000_000, 1_000_000, 1_000_000_000, 'routing.landRasterMaxCells'),
      keepJobs: num(r.keepJobs, 50, 1, 500, 'routing.keepJobs'),
    },
    publish: {
      toResources: p.toResources ?? true,
      routeNamePrefix: p.routeNamePrefix && p.routeNamePrefix.trim() ? p.routeNamePrefix.trim() : 'WRP',
      notifications: p.notifications ?? true,
    },
    weatherProvider: {
      enabled: w.enabled ?? true,
    },
  };
}
