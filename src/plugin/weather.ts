/**
 * Signal K Weather API provider backed by the resident global forecast.
 * Point forecasts only (one WeatherData per forecast step); daily
 * summaries, observations and warnings are not provided.
 *
 * Every value is in the Signal K unit for its field: m/s, rad, Pa, K,
 * m, s, and relative humidity as a ratio. The extra fields (temperature,
 * dew point, humidity, water temperature) appear only when the plugin is
 * configured to fetch them. Precipitation volume is not provided: the
 * store holds only ECMWF's instantaneous `tprate`, not an accumulated
 * field or an interval-mean rate, so no interval depth can be derived.
 *
 * Water level (when tides are enabled): `water.level` is the total water
 * level (tide + surge) in metres relative to local MEAN SEA LEVEL (not
 * chart datum) from the Copernicus Marine hourly sea level at the
 * position, and `water.levelTendency` its tendency at that time
 * (Signal K TendencyKind: increasing / decreasing, steady within
 * ±2 cm/h, from the central difference of the hourly series). The point
 * series is fetched on demand (the provider methods are async); when it
 * is unavailable the two fields are left out.
 */

import type { ForecastStore } from '../data/forecast';
import { relativeHumidity } from '../engine/conditions';
import { sampleSeries, signalKTendency, slopeAt, type RegularSeries } from '../tides/tidecalc';

export interface SkPosition {
  latitude: number;
  longitude: number;
}

export interface WeatherReqParams {
  maxCount?: number;
  startDate?: string;
  custom?: Record<string, unknown>;
}

export interface WeatherData {
  description?: string;
  date: string;
  type: 'point' | 'daily' | 'observation';
  outside?: {
    pressure?: number;
    temperature?: number;
    dewPointTemperature?: number;
    /** Ratio 0..1. */
    relativeHumidity?: number;
    /** Depth in m accumulated over the interval ending at `date`. */
    precipitationVolume?: number;
  };
  water?: {
    temperature?: number;
    /** Total water level relative to local mean sea level, m. */
    level?: number;
    levelTendency?: 'steady' | 'decreasing' | 'increasing' | 'not available';
    waveSignificantHeight?: number;
    wavePeriod?: number;
    waveDirection?: number;
  };
  wind?: { speedTrue?: number; directionTrue?: number };
}

export interface WeatherProviderLike {
  name: string;
  methods: {
    pluginId?: string;
    getObservations: (position: SkPosition, options?: WeatherReqParams) => Promise<WeatherData[]>;
    getForecasts: (position: SkPosition, type: 'point' | 'daily', options?: WeatherReqParams) => Promise<WeatherData[]>;
    getWarnings: (position: SkPosition) => Promise<unknown[]>;
  };
}

/** Hourly water level at a point (m above local mean sea level, NaN = none), or null when tides are off. */
export interface TideSeriesLike {
  t0Ms: number;
  stepMs: number;
  waterLevel: ArrayLike<number>;
  run?: string | null;
  error: string | null;
}

export type TideSeriesFn = (lat: number, lon: number, fromMs: number, hours: number) => Promise<TideSeriesLike | null>;

/** Add water.level / water.levelTendency to point forecasts from an hourly water-level series. */
export function applyWaterLevel(items: WeatherData[], s: TideSeriesLike): number {
  const wl: RegularSeries = { t0Ms: s.t0Ms, stepMs: s.stepMs, values: s.waterLevel };
  let n = 0;
  for (const item of items) {
    const t = Date.parse(item.date);
    const level = sampleSeries(wl, t);
    if (level === null) continue;
    item.water = { ...(item.water ?? {}), level, levelTendency: signalKTendency(slopeAt(wl, t)) };
    n++;
  }
  return n;
}

export function makeWeatherProvider(getStore: () => ForecastStore | null, pluginId: string, tideSeries?: TideSeriesFn, log: (m: string) => void = () => undefined): WeatherProviderLike {
  let lastTideError = '';
  const withWaterLevel = async (position: SkPosition, items: WeatherData[]): Promise<WeatherData[]> => {
    if (!tideSeries || items.length === 0) return items;
    const times = items.map((i) => Date.parse(i.date));
    // One step either side for the tendency's central difference.
    const fromMs = Math.min(...times) - 3600_000;
    const hours = Math.ceil((Math.max(...times) - fromMs) / 3600_000) + 1;
    try {
      const s = await tideSeries(position.latitude, position.longitude, fromMs, Math.min(hours, 400));
      if (!s) return items;
      if (s.error) throw new Error(s.error);
      applyWaterLevel(items, s);
      lastTideError = '';
    } catch (err) {
      const m = (err as Error).message;
      if (m !== lastTideError) log(`Weather API: water level unavailable at ${position.latitude.toFixed(3)}, ${position.longitude.toFixed(3)}: ${m}`);
      lastTideError = m;
    }
    return items;
  };
  const pointForecasts = (position: SkPosition, options?: WeatherReqParams): WeatherData[] => {
    const store = getStore();
    if (!store) throw new Error('no forecast loaded yet');
    const lon = position.longitude;
    const lat = position.latitude;
    if (!store.covers(lon, lat)) {
      throw new Error(`position ${lat.toFixed(3)}, ${lon.toFixed(3)} is outside the resident forecast`);
    }
    let fromMs = Date.now();
    if (options?.startDate) {
      const d = Date.parse(options.startDate);
      if (!Number.isNaN(d)) fromMs = d;
    }
    const finiteOr = (v: number): number | undefined => (Number.isFinite(v) ? v : undefined);
    const has2t = store.has('2t');
    const hasD2m = store.has('2d');
    const hasSkt = store.has('skt');
    const out: WeatherData[] = [];
    for (let i = 0; i < store.steps.length; i++) {
      const step = store.steps[i];
      if (step.validMs + 3 * 3600_000 <= fromMs) continue; // step already fully in the past
      const t = new Date(step.validMs);
      const [ws, wd] = store.at(lon, lat, t);
      const wave = store.wavesAt(lon, lat, t);
      const msl = store.mslAt(lon, lat, t);
      const item: WeatherData = {
        description: `ECMWF IFS 0.25° open data, cycle ${store.meta.cycleTime.toISOString()}, +${step.stepHours} h`,
        date: t.toISOString(),
        type: 'point',
        wind: { speedTrue: ws, directionTrue: (wd * Math.PI) / 180 },
      };
      const outside: NonNullable<WeatherData['outside']> = {};
      if (Number.isFinite(msl)) outside.pressure = msl;
      const t2m = has2t ? finiteOr(store.paramAt('2t', lon, lat, t)) : undefined;
      const d2m = hasD2m ? finiteOr(store.paramAt('2d', lon, lat, t)) : undefined;
      if (t2m !== undefined) outside.temperature = t2m;
      if (d2m !== undefined) outside.dewPointTemperature = d2m;
      const rh = relativeHumidity(t2m ?? null, d2m ?? null);
      if (rh !== null) outside.relativeHumidity = rh;
      if (Object.keys(outside).length > 0) item.outside = outside;
      const water: NonNullable<WeatherData['water']> = {};
      const skt = hasSkt ? finiteOr(store.paramAt('skt', lon, lat, t)) : undefined;
      if (skt !== undefined) water.temperature = skt;
      if (wave && Number.isFinite(wave.swh)) {
        water.waveSignificantHeight = wave.swh;
        water.wavePeriod = wave.mwp;
        water.waveDirection = (wave.mwd * Math.PI) / 180;
      }
      if (Object.keys(water).length > 0) item.water = water;
      out.push(item);
      if (options?.maxCount && out.length >= options.maxCount) break;
    }
    return out;
  };

  return {
    name: 'Weather Router Plus (ECMWF open data)',
    methods: {
      pluginId,
      getObservations: async () => [],
      getForecasts: async (position, type, options) => {
        if (type !== 'point') return [];
        return withWaterLevel(position, pointForecasts(position, options));
      },
      getWarnings: async () => [],
    },
  };
}
