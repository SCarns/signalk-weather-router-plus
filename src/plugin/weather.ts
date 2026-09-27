/**
 * Signal K Weather API provider backed by the resident forecast region.
 * Point forecasts only (one WeatherData per forecast step); daily
 * summaries, observations and warnings are not provided.
 */

import type { ForecastStore } from '../data/forecast';

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
  outside?: { pressure?: number; temperature?: number; precipitationVolume?: number };
  water?: { waveSignificantHeight?: number; wavePeriod?: number; waveDirection?: number };
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

export function makeWeatherProvider(getStore: () => ForecastStore | null, pluginId: string): WeatherProviderLike {
  const pointForecasts = (position: SkPosition, options?: WeatherReqParams): WeatherData[] => {
    const store = getStore();
    if (!store) throw new Error('no forecast loaded yet');
    const lon = position.longitude;
    const lat = position.latitude;
    if (!store.covers(lon, lat)) {
      throw new Error(`position ${lat.toFixed(3)}, ${lon.toFixed(3)} is outside the resident forecast region`);
    }
    let fromMs = Date.now();
    if (options?.startDate) {
      const d = Date.parse(options.startDate);
      if (!Number.isNaN(d)) fromMs = d;
    }
    const out: WeatherData[] = [];
    for (const step of store.steps) {
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
      if (Number.isFinite(msl)) item.outside = { pressure: msl };
      if (wave && Number.isFinite(wave.swh)) {
        item.water = { waveSignificantHeight: wave.swh, wavePeriod: wave.mwp, waveDirection: (wave.mwd * Math.PI) / 180 };
      }
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
        return pointForecasts(position, options);
      },
      getWarnings: async () => [],
    },
  };
}
