/**
 * Plugin configuration.
 *
 * Two sources, merged into one ResolvedConfig (SI in memory):
 *  - the Signal K plugin config (admin UI, CONFIG_SCHEMA below): only
 *    server / installation settings — file paths, the download mirror
 *    and Weather API registration;
 *  - the web-app settings (settings.ts, stored in the plugin data dir as
 *    settings.json, edited in the page's Settings tab): vessel, forecast
 *    horizon and extras, currents, routing engine and publishing.
 *
 * Older versions kept everything in the plugin config; those keys are
 * described by LegacyPluginConfig and read once, to migrate them into
 * settings.json (settings.ts migrateLegacy). After that they are ignored.
 */

import { makeVessel, type VesselParams } from '../vessel/vessel';
import type { AppSettings } from './settings';
import type { RouteRequest } from './protocol';

/** What the Signal K plugin config holds now. */
export interface PluginConfig {
  landShapefiles?: string;
  polarFile?: string;
  polarsDir?: string;
  forecast?: {
    mirror?: 'ecmwf' | 'aws' | 'google';
  };
  currents?: {
    harmonicDir?: string;
  };
  weatherProvider?: {
    enabled?: boolean;
  };
}

/** Plugin-config keys of earlier versions, read only by the settings migration. */
export interface LegacyPluginConfig {
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
    keepCycles?: number;
    extraFields?: boolean;
  };
  currents?: {
    rtofsEnabled?: boolean;
    rtofsRegion?: string;
    rtofsHorizonHours?: number;
    rtofsStepHours?: number;
  };
  routing?: {
    stages?: number;
    subsectors?: number;
    headings?: number;
    headingIncrementDeg?: number;
    sailThresholdKts?: number;
    simStepM?: number;
    landRasterMaxCells?: number;
    keepJobs?: number;
  };
  publish?: {
    toResources?: boolean;
    routeNamePrefix?: string;
    notifications?: boolean;
  };
}

export interface ResolvedConfig {
  landShapefiles: string[];
  polarFile: string | null;
  polarsDir: string | null;
  vessel: VesselParams;
  forecast: {
    horizonHours: number;
    refreshMinutes: number;
    mirror: 'ecmwf' | 'aws' | 'google';
    keepCycles: number;
    /** Also fetch 2t, tprate, skt, 2d, ptype (temperature, precipitation, SST, humidity, precip type). */
    extraFields: boolean;
    /** Memory guard: bytes that must remain free after a forecast load. */
    memoryHeadroomBytes: number;
  };
  currents: {
    harmonicDir: string | null;
    smocEnabled: boolean;
    smocHorizonHours: number;
    smocStepHours: number;
    smocHalfWidthDeg: number;
    rtofsEnabled: boolean;
    rtofsRegion: string;
    rtofsHorizonHours: number;
    rtofsStepHours: number;
  };
  tides: {
    /** Copernicus Marine hourly sea level (tide height, water level, surge; tide map layer). */
    enabled: boolean;
    halfWidthDeg: number;
    horizonHours: number;
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

export const MIRRORS = ['ecmwf', 'aws', 'google'] as const;

export const CONFIG_SCHEMA = {
  type: 'object',
  description:
    'Server and installation settings only. Vessel, forecast horizon, currents, routing and publishing are set in the ' +
    'web app (Weather Router Plus → Settings tab) and shared by every client.',
  required: ['landShapefiles'],
  properties: {
    landShapefiles: {
      type: 'string',
      title: 'Coastline shapefile(s)',
      description: 'Absolute path(s) to polygon land shapefiles, comma-separated. GSHHG GSHHS_f_L1.shp is recommended (add GSHHS_f_L6.shp for Antarctica).',
    },
    polarFile: {
      type: 'string',
      title: 'Default polar file (.csv or .pol)',
      description: 'Boat speed table in knots. Blank = motor-only routes unless a route picks a polar from the library.',
    },
    polarsDir: {
      type: 'string',
      title: 'Polar library directory',
      description: 'Directory of .pol/.csv polars offered in the web app\'s vessel picker.',
    },
    currents: {
      type: 'object',
      title: 'Currents',
      properties: {
        harmonicDir: {
          type: 'string',
          title: 'Tidal harmonics directory (.npz)',
          description: 'Directory of FES2014 / NECOFS .npz extracts; every *.npz in it is loaded.',
        },
      },
    },
    forecast: {
      type: 'object',
      title: 'Forecast download',
      properties: {
        mirror: { type: 'string', title: 'ECMWF open-data mirror', enum: [...MIRRORS], default: 'ecmwf' },
      },
    },
    weatherProvider: {
      type: 'object',
      title: 'Weather API',
      properties: {
        enabled: { type: 'boolean', title: 'Register as a Signal K Weather API provider', default: true },
      },
    },
  },
};

/**
 * Merge the plugin config (installation) with the web-app settings (SI)
 * into the engine's ResolvedConfig. `settings` must already be valid
 * (SettingsStore validates on load and on every update).
 */
export function resolveConfig(raw: PluginConfig | undefined, settings: AppSettings): ResolvedConfig {
  const c = raw ?? {};
  const land = (c.landShapefiles ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const mirror = c.forecast?.mirror ?? 'ecmwf';
  if (!(MIRRORS as readonly string[]).includes(mirror)) throw new Error(`config forecast.mirror: ${String(mirror)} is not one of ${MIRRORS.join(', ')}`);
  const harmonicDir = c.currents?.harmonicDir;
  const v = settings.vessel;
  const f = settings.forecast;
  const cu = settings.currents;
  const r = settings.routing;
  const p = settings.publish;
  return {
    landShapefiles: land,
    polarFile: c.polarFile && c.polarFile.trim() ? c.polarFile.trim() : null,
    polarsDir: c.polarsDir && c.polarsDir.trim() ? c.polarsDir.trim() : null,
    vessel: makeVessel({
      name: v.name,
      draught: v.draught,
      airDraft: v.airDraft,
      loa: v.loa,
      beam: v.beam,
      underKeelClearance: v.underKeelClearance,
      overheadClearance: v.overheadClearance,
      motorSpeedMs: v.motorSpeed,
      maxSwh: v.maxSwh ?? undefined,
      tackPenaltySeconds: v.tackPenalty,
    }),
    forecast: {
      horizonHours: f.horizon / 3600,
      refreshMinutes: f.refreshInterval / 60,
      mirror,
      keepCycles: f.keepCycles,
      extraFields: f.extraFields,
      memoryHeadroomBytes: f.memoryHeadroom,
    },
    currents: {
      harmonicDir: harmonicDir && harmonicDir.trim() ? harmonicDir.trim() : null,
      smocEnabled: cu.smocEnabled,
      smocHorizonHours: cu.smocHorizon / 3600,
      smocStepHours: cu.smocStep / 3600,
      smocHalfWidthDeg: cu.smocHalfWidth,
      rtofsEnabled: cu.rtofsEnabled,
      rtofsRegion: cu.rtofsRegion,
      rtofsHorizonHours: cu.rtofsHorizon / 3600,
      rtofsStepHours: cu.rtofsStep / 3600,
    },
    tides: {
      enabled: settings.tides.enabled,
      halfWidthDeg: settings.tides.halfWidth,
      horizonHours: settings.tides.horizon / 3600,
    },
    routing: {
      stages: r.stages,
      subsectors: r.subsectors,
      headings: r.headings,
      headingIncrementDeg: r.headingIncrement,
      sailThreshMs: r.sailThreshold,
      simStepM: r.simStep,
      landRasterMaxCells: r.landRasterMaxCells,
      keepJobs: r.keepJobs,
    },
    publish: {
      toResources: p.toResources,
      routeNamePrefix: p.routeNamePrefix,
      notifications: p.notifications,
    },
    weatherProvider: {
      enabled: c.weatherProvider?.enabled ?? true,
    },
  };
}

/**
 * The vessel for one route: values in the request take precedence; the
 * rest come from the vessel settings (never the built-in defaults).
 */
export function routeVessel(cfg: ResolvedConfig, rv: RouteRequest['vessel']): VesselParams {
  return makeVessel({
    ...cfg.vessel,
    name: rv?.name ?? cfg.vessel.name,
    draught: rv?.draught ?? cfg.vessel.draught,
    airDraft: rv?.air_draft ?? cfg.vessel.airDraft,
    loa: rv?.loa ?? cfg.vessel.loa,
    beam: rv?.beam ?? cfg.vessel.beam,
    motorSpeedMs: rv?.motor_speed_ms ?? cfg.vessel.motorSpeedMs,
    underKeelClearance: rv?.under_keel_clearance ?? cfg.vessel.underKeelClearance,
    tackPenaltySeconds: rv?.tack_penalty_s ?? cfg.vessel.tackPenaltySeconds,
  });
}
