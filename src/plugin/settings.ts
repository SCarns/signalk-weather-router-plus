/**
 * Web-app settings: everything a user tunes (vessel, forecast horizon
 * and extras, currents, routing engine, publishing), kept out of the
 * Signal K plugin config and stored server-side in the plugin data
 * directory (settings.json) so every client shares them.
 *
 * Values are SI on the wire and on disk: metres, m/s, seconds (degrees
 * for the heading increment, as everywhere in this plugin's API). The
 * page converts for display with its unit presets.
 *
 * SETTINGS_SPEC is the single source of truth: defaults, ranges, enums,
 * labels and help text for GET /api/settings, validation for PUT, and
 * what a change needs re-done (`reload`). The ranges are the ones the
 * plugin config enforced before (resolveConfig, makeVessel), converted
 * to SI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { KTS_TO_MS } from '../geo/geodesy';
import { RTOFS_REGIONS } from '../currents/rtofs';
import type { LegacyPluginConfig } from './config';

export interface AppSettings {
  vessel: {
    name: string;
    draught: number;
    airDraft: number;
    loa: number;
    beam: number;
    underKeelClearance: number;
    overheadClearance: number;
    motorSpeed: number;
    maxSwh: number | null;
    tackPenalty: number;
  };
  forecast: {
    horizon: number;
    refreshInterval: number;
    keepCycles: number;
    extraFields: boolean;
    /** Bytes that must stay free after the forecast loads (memory guard). */
    memoryHeadroom: number;
  };
  currents: {
    smocEnabled: boolean;
    smocHorizon: number;
    smocStep: number;
    smocHalfWidth: number;
    rtofsEnabled: boolean;
    rtofsRegion: string;
    rtofsHorizon: number;
    rtofsStep: number;
  };
  tides: {
    enabled: boolean;
    /** Half-width of the resident tide-height map area around the vessel, degrees. */
    halfWidth: number;
    /** How far ahead the resident tide-height map area reaches, s. */
    horizon: number;
  };
  routing: {
    stages: number;
    subsectors: number;
    headings: number;
    headingIncrement: number;
    sailThreshold: number;
    simStep: number;
    landRasterMaxCells: number;
    keepJobs: number;
  };
  publish: {
    toResources: boolean;
    routeNamePrefix: string;
    notifications: boolean;
  };
}

export type SettingsGroup = keyof AppSettings;

/**
 * What must be re-done when a setting changes:
 *  - forecast: reload the resident forecast (new horizon or field set);
 *  - currents: reload the current sources (CMEMS SMOC, RTOFS);
 *  - tides: reload the Copernicus Marine sea-level source only;
 *  - refresh_timer: restart the cycle-check timer;
 *  - jobs: re-trim the finished-job list;
 *  - next_job: nothing now; the next route uses it;
 *  - cache: used at the next cache prune.
 */
export type ReloadKind = 'forecast' | 'currents' | 'tides' | 'refresh_timer' | 'jobs' | 'next_job' | 'cache';

/**
 * Display quantity, for the page's unit conversion: speed / depth /
 * wave_height / short_distance follow the user's unit preset; hours,
 * minutes and seconds are fixed displays of a value stored in seconds.
 */
export type Quantity = 'speed' | 'depth' | 'wave_height' | 'short_distance' | 'megabytes' | 'hours' | 'minutes' | 'seconds' | 'angle' | 'count';

export interface SettingSpec {
  key: string;
  group: SettingsGroup;
  label: string;
  type: 'number' | 'integer' | 'boolean' | 'string' | 'enum';
  /** SI unit of the stored value ('m', 'm/s', 's', 'deg'), absent for dimensionless values. */
  unit?: string;
  quantity?: Quantity;
  min?: number;
  max?: number;
  /** Value must be a whole multiple of this (e.g. 3600 s = whole hours). */
  multipleOf?: number;
  /** Value must be one of these (SI), e.g. [3600, 10800] for a 1 h or 3 h step. */
  oneOf?: readonly number[];
  default: number | boolean | string | null;
  nullable?: boolean;
  enum?: readonly string[];
  maxLength?: number;
  help: string;
  reload: ReloadKind;
}

export const SETTINGS_GROUPS: { id: SettingsGroup; label: string; help: string }[] = [
  { id: 'vessel', label: 'Vessel', help: 'Defaults for every route. A route request\'s own vessel values take precedence.' },
  { id: 'forecast', label: 'Forecast', help: 'ECMWF open-data IFS 0.25°, held for the whole globe.' },
  { id: 'currents', label: 'Currents', help: 'Copernicus Marine SMOC (worldwide 1/12° surface currents including tides and Stokes drift; primary) and NOAA Global RTOFS (regional; backup). Tidal harmonics come from the directory set in the Signal K plugin config and take precedence where they cover.' },
  { id: 'tides', label: 'Tides', help: 'Copernicus Marine hourly sea level (worldwide 1/12°): tide height, total water level and surge in the conditions popup and the Weather API, and the tide-height map layer. Heights are relative to mean sea level, not chart datum; not for under-keel clearance. Generated using E.U. Copernicus Marine Service Information.' },
  { id: 'routing', label: 'Routing engine', help: 'Isochrone solver defaults. A route request\'s stages and sail threshold take precedence.' },
  { id: 'publish', label: 'Publishing', help: 'What happens with a finished route.' },
];

const H = 3600;

export const SETTINGS_SPEC: readonly SettingSpec[] = [
  { key: 'vessel.name', group: 'vessel', label: 'Name', type: 'string', default: 'Vessel', maxLength: 60, help: 'Shown in route names and the status line.', reload: 'next_job' },
  { key: 'vessel.draught', group: 'vessel', label: 'Draught', type: 'number', unit: 'm', quantity: 'depth', min: 0, max: 30, default: 1.8, help: 'Depth of the keel below the waterline.', reload: 'next_job' },
  { key: 'vessel.airDraft', group: 'vessel', label: 'Air draft', type: 'number', unit: 'm', quantity: 'depth', min: 0, max: 100, default: 16, help: 'Mast height above the waterline.', reload: 'next_job' },
  { key: 'vessel.loa', group: 'vessel', label: 'Length overall', type: 'number', unit: 'm', quantity: 'depth', min: 0.1, max: 500, default: 11, help: 'LOA.', reload: 'next_job' },
  { key: 'vessel.beam', group: 'vessel', label: 'Beam', type: 'number', unit: 'm', quantity: 'depth', min: 0.1, max: 100, default: 3.7, help: 'Maximum width.', reload: 'next_job' },
  { key: 'vessel.underKeelClearance', group: 'vessel', label: 'Under-keel margin', type: 'number', unit: 'm', quantity: 'depth', min: 0, max: 20, default: 0.5, help: 'Safety margin kept below the keel.', reload: 'next_job' },
  { key: 'vessel.overheadClearance', group: 'vessel', label: 'Overhead margin', type: 'number', unit: 'm', quantity: 'depth', min: 0, max: 20, default: 1, help: 'Safety margin kept above the mast.', reload: 'next_job' },
  { key: 'vessel.motorSpeed', group: 'vessel', label: 'Speed under power', type: 'number', unit: 'm/s', quantity: 'speed', min: 0.01, max: 50, default: 6 * KTS_TO_MS, help: 'Cruising speed when motoring.', reload: 'next_job' },
  { key: 'vessel.maxSwh', group: 'vessel', label: 'Maximum wave height', type: 'number', unit: 'm', quantity: 'wave_height', min: 0, max: 30, default: null, nullable: true, help: 'Significant wave height limit (informational). Empty = none.', reload: 'next_job' },
  { key: 'vessel.tackPenalty', group: 'vessel', label: 'Tack penalty', type: 'number', unit: 's', quantity: 'seconds', min: 0, max: 3600, default: 30, help: 'Time lost per tack or gybe.', reload: 'next_job' },

  { key: 'forecast.horizon', group: 'forecast', label: 'Forecast horizon', type: 'number', unit: 's', quantity: 'hours', min: 3 * H, max: 240 * H, multipleOf: H, default: 72 * H, help: 'How far ahead the resident forecast reaches. Changing it reloads the forecast; memory grows with it.', reload: 'forecast' },
  { key: 'forecast.refreshInterval', group: 'forecast', label: 'Check for a new cycle every', type: 'number', unit: 's', quantity: 'minutes', min: 600, max: 24 * H, multipleOf: 60, default: H, help: 'How often ECMWF is checked for a newer cycle.', reload: 'refresh_timer' },
  { key: 'forecast.keepCycles', group: 'forecast', label: 'Cached cycles kept on disk', type: 'integer', min: 1, max: 10, default: 2, help: 'Older downloaded cycles are deleted beyond this.', reload: 'cache' },
  { key: 'forecast.extraFields', group: 'forecast', label: 'Temperature, precipitation, SST, humidity', type: 'boolean', default: true, help: 'Also fetch 2t, tprate, skt, 2d and ptype (the temperature, SST and precipitation layers and the full conditions). Changing it reloads the forecast.', reload: 'forecast' },
  { key: 'forecast.memoryHeadroom', group: 'forecast', label: 'Memory kept free', type: 'number', unit: 'B', quantity: 'megabytes', min: 0, max: 64e9, multipleOf: 1e6, default: 1e9, help: 'The forecast only loads if at least this much memory stays free afterwards for Signal K, the OS and other plugins. If it does not fit, the plugin says what to change instead of loading.', reload: 'forecast' },

  { key: 'currents.smocEnabled', group: 'currents', label: 'Use Copernicus Marine SMOC currents', type: 'boolean', default: true, help: 'Worldwide hourly surface currents (circulation + tides + Stokes drift) from Copernicus Marine, downloaded anonymously; takes precedence over RTOFS. Generated using E.U. Copernicus Marine Service Information.', reload: 'currents' },
  { key: 'currents.smocHorizon', group: 'currents', label: 'SMOC horizon', type: 'number', unit: 's', quantity: 'hours', min: 6 * H, max: 240 * H, multipleOf: H, default: 72 * H, help: 'How far ahead SMOC is held (the product reaches about 10 days).', reload: 'currents' },
  { key: 'currents.smocStep', group: 'currents', label: 'SMOC time step kept', type: 'number', unit: 's', quantity: 'hours', min: 1 * H, max: 3 * H, multipleOf: H, oneOf: [1 * H, 3 * H], default: 3 * H, help: '1 h or 3 h. 1 h triples the download and memory.', reload: 'currents' },
  { key: 'currents.smocHalfWidth', group: 'currents', label: 'SMOC area around the vessel', type: 'number', unit: 'deg', quantity: 'angle', min: 2, max: 30, default: 15, help: 'Half-width of the area kept in memory around the vessel position (about 27 MB at 15° with 3 h steps over 72 h; grows with the square of the half-width). Routes and map views elsewhere load their own area on demand.', reload: 'currents' },
  { key: 'currents.rtofsEnabled', group: 'currents', label: 'Use RTOFS ocean currents', type: 'boolean', default: true, help: 'Download NOAA Global RTOFS from NOMADS (used where SMOC has no data).', reload: 'currents' },
  { key: 'currents.rtofsRegion', group: 'currents', label: 'RTOFS regional product', type: 'enum', enum: RTOFS_REGIONS, default: 'west_atl', help: 'Which regional RTOFS product to download.', reload: 'currents' },
  { key: 'currents.rtofsHorizon', group: 'currents', label: 'RTOFS horizon', type: 'number', unit: 's', quantity: 'hours', min: 24 * H, max: 144 * H, multipleOf: H, default: 72 * H, help: 'How far ahead RTOFS is loaded.', reload: 'currents' },
  { key: 'currents.rtofsStep', group: 'currents', label: 'RTOFS time step kept', type: 'number', unit: 's', quantity: 'hours', min: 1 * H, max: 6 * H, multipleOf: H, default: 3 * H, help: 'Spacing of the RTOFS steps held in memory.', reload: 'currents' },

  { key: 'tides.enabled', group: 'tides', label: 'Use Copernicus Marine sea level', type: 'boolean', default: true, help: 'Tide height, total water level and surge (relative to mean sea level) for the conditions popup, the Weather API (water.level) and the tide-height map layer, downloaded anonymously from Copernicus Marine. About 1–4 MB per new place for a point series.', reload: 'tides' },
  { key: 'tides.halfWidth', group: 'tides', label: 'Tide map area around the vessel', type: 'number', unit: 'deg', quantity: 'angle', min: 1, max: 30, default: 15, help: 'Half-width of the tide-height map area kept in memory around the vessel position (hourly steps; about 17 MB at 15° over 24 h, growing with the square of the half-width and with the horizon). Map views elsewhere load their own hour on demand.', reload: 'tides' },
  { key: 'tides.horizon', group: 'tides', label: 'Tide map horizon', type: 'number', unit: 's', quantity: 'hours', min: 6 * H, max: 240 * H, multipleOf: H, default: 24 * H, help: 'How far ahead the resident tide-height map area reaches (hourly steps; each hour of a 30° area downloads about 1–3 MB per new daily run). Map times beyond it load on demand. The conditions popup and Weather API are not limited by this.', reload: 'tides' },

  { key: 'routing.stages', group: 'routing', label: 'Isochrone stages', type: 'integer', min: 4, max: 200, default: 20, help: 'Propagation stages between start and end.', reload: 'next_job' },
  { key: 'routing.subsectors', group: 'routing', label: 'Subsectors', type: 'integer', min: 4, max: 200, default: 30, help: 'Angular sectors each isochrone is pruned to.', reload: 'next_job' },
  { key: 'routing.headings', group: 'routing', label: 'Headings each side', type: 'integer', min: 4, max: 180, default: 30, help: 'Headings tried either side of the course.', reload: 'next_job' },
  { key: 'routing.headingIncrement', group: 'routing', label: 'Heading increment', type: 'number', unit: 'deg', quantity: 'angle', min: 0.25, max: 10, default: 1, help: 'Spacing of the tried headings.', reload: 'next_job' },
  { key: 'routing.sailThreshold', group: 'routing', label: 'Sail when boat speed exceeds', type: 'number', unit: 'm/s', quantity: 'speed', min: 0, max: 50 * KTS_TO_MS, default: 4.9 * KTS_TO_MS, help: 'Below this polar speed the route motors (sail_max mode).', reload: 'next_job' },
  { key: 'routing.simStep', group: 'routing', label: 'Leg simulation step', type: 'number', unit: 'm', quantity: 'short_distance', min: 50, max: 5000, default: 200, help: 'Distance between samples along each leg.', reload: 'next_job' },
  { key: 'routing.landRasterMaxCells', group: 'routing', label: 'Land raster cell budget', type: 'integer', min: 1_000_000, max: 1_000_000_000, default: 25_000_000, help: 'Upper bound on the per-route land raster (1 byte per cell). Lower it on small machines.', reload: 'next_job' },
  { key: 'routing.keepJobs', group: 'routing', label: 'Finished routes kept', type: 'integer', min: 1, max: 500, default: 50, help: 'Older finished route jobs are deleted beyond this.', reload: 'jobs' },

  { key: 'publish.toResources', group: 'publish', label: 'Save finished routes to Signal K', type: 'boolean', default: true, help: 'Write each finished route to the Resources API (routes).', reload: 'next_job' },
  { key: 'publish.routeNamePrefix', group: 'publish', label: 'Route name prefix', type: 'string', default: 'WRP', maxLength: 40, help: 'Prefix for routes submitted without a name.', reload: 'next_job' },
  { key: 'publish.notifications', group: 'publish', label: 'Notifications', type: 'boolean', default: true, help: 'Emit notifications.weatherRouterPlus.<jobId> when a route finishes or fails.', reload: 'next_job' },
];

const SPEC_BY_KEY = new Map(SETTINGS_SPEC.map((s) => [s.key, s]));

export class SettingsValidationError extends Error {
  readonly errors: Record<string, string>;
  constructor(errors: Record<string, string>) {
    super(`invalid settings: ${Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    this.name = 'SettingsValidationError';
    this.errors = errors;
  }
}

export function defaultSettings(): AppSettings {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of SETTINGS_SPEC) {
    const [g, k] = s.key.split('.');
    (out[g] ??= {})[k] = s.default;
  }
  return out as unknown as AppSettings;
}

function cloneSettings(s: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(s)) as AppSettings;
}

/** Check one value against its spec; returns the normalised value or throws with a message. */
export function validateValue(spec: SettingSpec, raw: unknown): number | boolean | string | null {
  switch (spec.type) {
    case 'boolean':
      if (typeof raw !== 'boolean') throw new Error('must be true or false');
      return raw;
    case 'string': {
      if (typeof raw !== 'string') throw new Error('must be a string');
      const t = raw.trim();
      if (!t) return spec.default as string;
      if (spec.maxLength !== undefined && t.length > spec.maxLength) throw new Error(`must be at most ${spec.maxLength} characters`);
      return t;
    }
    case 'enum': {
      if (typeof raw !== 'string' || !spec.enum!.includes(raw)) throw new Error(`must be one of ${spec.enum!.join(', ')}`);
      return raw;
    }
    case 'number':
    case 'integer': {
      if (raw === null || raw === '') {
        if (spec.nullable) return null;
        throw new Error('is required');
      }
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('must be a number');
      if (spec.type === 'integer' && !Number.isInteger(raw)) throw new Error('must be a whole number');
      if ((spec.min !== undefined && raw < spec.min - 1e-9) || (spec.max !== undefined && raw > spec.max + 1e-9)) {
        throw new Error(`must be in [${spec.min}, ${spec.max}]${spec.unit ? ` ${spec.unit}` : ''}`);
      }
      let out = raw;
      if (spec.multipleOf !== undefined) {
        const q = raw / spec.multipleOf;
        if (Math.abs(q - Math.round(q)) > 1e-6) throw new Error(`must be a whole multiple of ${spec.multipleOf}${spec.unit ? ` ${spec.unit}` : ''}`);
        out = Math.round(q) * spec.multipleOf;
      }
      if (spec.oneOf && !spec.oneOf.some((x) => Math.abs(x - out) < 1e-9)) throw new Error(`must be one of ${spec.oneOf.join(', ')}${spec.unit ? ` ${spec.unit}` : ''}`);
      return out;
    }
  }
}

/**
 * Validate a partial update (nested: `{vessel: {draught: 2}}`) against
 * `base`, returning the merged settings and the dotted keys whose value
 * changed. Every problem is collected; any problem throws
 * SettingsValidationError and nothing is merged.
 */
export function mergeSettings(base: AppSettings, partial: unknown): { values: AppSettings; changed: string[] } {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new SettingsValidationError({ '': 'body must be an object of setting groups, e.g. {"vessel": {"draught": 1.9}}' });
  }
  const errors: Record<string, string> = {};
  const out = cloneSettings(base);
  const changed: string[] = [];
  for (const [g, groupVal] of Object.entries(partial as Record<string, unknown>)) {
    if (!SETTINGS_GROUPS.some((x) => x.id === g)) {
      errors[g] = 'unknown settings group';
      continue;
    }
    if (groupVal === null || typeof groupVal !== 'object' || Array.isArray(groupVal)) {
      errors[g] = 'must be an object';
      continue;
    }
    for (const [k, raw] of Object.entries(groupVal as Record<string, unknown>)) {
      const key = `${g}.${k}`;
      const spec = SPEC_BY_KEY.get(key);
      if (!spec) {
        errors[key] = 'unknown setting';
        continue;
      }
      try {
        const v = validateValue(spec, raw);
        const grp = (out as unknown as Record<string, Record<string, unknown>>)[g];
        if (grp[k] !== v) {
          grp[k] = v;
          changed.push(key);
        }
      } catch (err) {
        errors[key] = (err as Error).message;
      }
    }
  }
  if (Object.keys(errors).length) throw new SettingsValidationError(errors);
  return { values: out, changed };
}

/** Settings from a stored object, key by key; invalid or missing keys fall back to defaults and are reported. */
export function settingsFromStored(stored: unknown): { values: AppSettings; problems: string[] } {
  const values = defaultSettings();
  const problems: string[] = [];
  const obj = stored && typeof stored === 'object' ? (stored as Record<string, Record<string, unknown>>) : {};
  for (const spec of SETTINGS_SPEC) {
    const [g, k] = spec.key.split('.');
    const grp = obj[g];
    if (!grp || typeof grp !== 'object' || !(k in grp)) continue;
    try {
      (values as unknown as Record<string, Record<string, unknown>>)[g][k] = validateValue(spec, grp[k]);
    } catch (err) {
      problems.push(`${spec.key}: ${(err as Error).message} (using the default)`);
    }
  }
  return { values, problems };
}

/**
 * Settings from the plugin config of earlier versions: every key that
 * was set is converted to SI (knots → m/s, hours / minutes → s) and
 * validated on its own; one that fails is skipped (default kept) and
 * reported rather than blocking the rest.
 */
export function migrateLegacy(legacy: LegacyPluginConfig | undefined): { values: AppSettings; migrated: string[]; skipped: string[] } {
  const l = legacy ?? {};
  const set = (o: Record<string, unknown>, key: string, v: unknown): void => {
    if (v === undefined || v === null || v === '') return;
    o[key] = v;
  };
  const src: Record<string, Record<string, unknown>> = { vessel: {}, forecast: {}, currents: {}, tides: {}, routing: {}, publish: {} };
  const num = (v: unknown, k = 1): unknown => (v === undefined || v === null || v === '' ? undefined : typeof v === 'number' ? v * k : Number.isFinite(Number(v)) ? Number(v) * k : v);
  const v = l.vessel ?? {};
  set(src.vessel, 'name', v.name);
  set(src.vessel, 'draught', num(v.draughtM));
  set(src.vessel, 'airDraft', num(v.airDraftM));
  set(src.vessel, 'loa', num(v.loaM));
  set(src.vessel, 'beam', num(v.beamM));
  set(src.vessel, 'underKeelClearance', num(v.underKeelClearanceM));
  set(src.vessel, 'overheadClearance', num(v.overheadClearanceM));
  set(src.vessel, 'motorSpeed', num(v.motorSpeedKts, KTS_TO_MS));
  set(src.vessel, 'maxSwh', num(v.maxSwhM));
  set(src.vessel, 'tackPenalty', num(v.tackPenaltySeconds));
  const f = l.forecast ?? {};
  set(src.forecast, 'horizon', num(f.horizonHours, H));
  set(src.forecast, 'refreshInterval', num(f.refreshMinutes, 60));
  set(src.forecast, 'keepCycles', num(f.keepCycles));
  set(src.forecast, 'extraFields', f.extraFields);
  const c = l.currents ?? {};
  set(src.currents, 'rtofsEnabled', c.rtofsEnabled);
  set(src.currents, 'rtofsRegion', typeof c.rtofsRegion === 'string' ? c.rtofsRegion.trim() : c.rtofsRegion);
  set(src.currents, 'rtofsHorizon', num(c.rtofsHorizonHours, H));
  set(src.currents, 'rtofsStep', num(c.rtofsStepHours, H));
  const r = l.routing ?? {};
  set(src.routing, 'stages', num(r.stages));
  set(src.routing, 'subsectors', num(r.subsectors));
  set(src.routing, 'headings', num(r.headings));
  set(src.routing, 'headingIncrement', num(r.headingIncrementDeg));
  set(src.routing, 'sailThreshold', num(r.sailThresholdKts, KTS_TO_MS));
  set(src.routing, 'simStep', num(r.simStepM));
  set(src.routing, 'landRasterMaxCells', num(r.landRasterMaxCells));
  set(src.routing, 'keepJobs', num(r.keepJobs));
  const p = l.publish ?? {};
  set(src.publish, 'toResources', p.toResources);
  set(src.publish, 'routeNamePrefix', p.routeNamePrefix);
  set(src.publish, 'notifications', p.notifications);

  const values = defaultSettings();
  const migrated: string[] = [];
  const skipped: string[] = [];
  for (const [g, grp] of Object.entries(src)) {
    for (const [k, raw] of Object.entries(grp)) {
      const key = `${g}.${k}`;
      const spec = SPEC_BY_KEY.get(key)!;
      try {
        (values as unknown as Record<string, Record<string, unknown>>)[g][k] = validateValue(spec, raw);
        migrated.push(key);
      } catch (err) {
        skipped.push(`${key}: ${String(raw)} ${(err as Error).message}`);
      }
    }
  }
  return { values, migrated, skipped };
}

interface SettingsFile {
  version: 1;
  /** 'plugin-config' when the file was first written by the migration. */
  migratedFrom?: string;
  updatedAt: string;
  values: AppSettings;
}

/** settings.json in the plugin data directory. */
export class SettingsStore {
  readonly file: string;
  private current: AppSettings = defaultSettings();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
  }

  /**
   * Load settings.json, or create it by migrating `legacy` (the old
   * plugin config) when it does not exist yet. The Signal K config file
   * is never modified. Returns what happened, for the log.
   */
  load(legacy: LegacyPluginConfig | undefined): { created: boolean; migrated: string[]; problems: string[] } {
    let text: string | null = null;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== null) {
      let parsed: Partial<SettingsFile> | null = null;
      try {
        parsed = JSON.parse(text) as Partial<SettingsFile>;
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object') {
        const { values, problems } = settingsFromStored(parsed.values);
        this.current = values;
        return { created: false, migrated: [], problems };
      }
      // Unreadable: keep it aside and start again from the legacy config.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, aside);
      const m = migrateLegacy(legacy);
      this.current = m.values;
      this.write('plugin-config');
      return { created: true, migrated: m.migrated, problems: [`settings.json was not valid JSON; moved to ${path.basename(aside)}`, ...m.skipped] };
    }
    const m = migrateLegacy(legacy);
    this.current = m.values;
    this.write('plugin-config');
    return { created: true, migrated: m.migrated, problems: m.skipped };
  }

  get values(): AppSettings {
    return cloneSettings(this.current);
  }

  /** Validate and persist a partial update. Throws SettingsValidationError (nothing saved) on any invalid key. */
  update(partial: unknown): { values: AppSettings; changed: string[] } {
    const { values, changed } = mergeSettings(this.current, partial);
    if (changed.length) {
      const prev = this.current;
      this.current = values;
      try {
        this.write();
      } catch (err) {
        this.current = prev;
        throw err;
      }
    }
    return { values: cloneSettings(values), changed };
  }

  private write(migratedFrom?: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let prevMigrated: string | undefined;
    try {
      prevMigrated = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SettingsFile>).migratedFrom;
    } catch {
      prevMigrated = undefined;
    }
    const body: SettingsFile = { version: 1, migratedFrom: migratedFrom ?? prevMigrated, updatedAt: new Date().toISOString(), values: this.current };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/** Reload kinds implied by a set of changed keys. */
export function reloadsFor(changed: string[]): Set<ReloadKind> {
  const out = new Set<ReloadKind>();
  for (const k of changed) {
    const s = SPEC_BY_KEY.get(k);
    if (s) out.add(s.reload);
  }
  return out;
}

/** GET /api/settings schema. */
export function settingsSchema(): { groups: typeof SETTINGS_GROUPS; settings: readonly SettingSpec[] } {
  return { groups: SETTINGS_GROUPS, settings: SETTINGS_SPEC };
}
