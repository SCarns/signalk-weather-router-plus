/**
 * The colour overlay layers as PNG image tiles, for chartplotters that draw
 * image tiles (Freeboard-SK's chart layers, which also give a time scrubber
 * when the chart resource carries a `time` block). Each tile is the picture
 * the web app paints in the browser from the data tile (public/rp-layers.js,
 * _paintTile): 256 × 256 pixels, pixel centres on the Web Mercator grid, a
 * null-aware bilinear sample of the field lattice, the legend's colour ramp,
 * the 256 × 256 land mask, the same alpha. Rendered on demand from the data
 * tiles the TileService already keeps on disk, and kept in a small
 * in-memory cache.
 *
 * Not rendered here: `msl` (isobars are lines), barbs and arrows (glyphs),
 * and the tide layer's page-wide auto-scale (the tide uses its fixed ±3 m
 * legend scale).
 */

import { encodePng } from './png';
import { latOfMercY, mercY } from '../geo/mercator';
import { lonOffset } from '../geo/angles';
import type { FieldGridResponse } from './overlays';
import {
  CURRENT_STOPS,
  PRECIP_STOPS,
  SEA_STATE_STOPS,
  SST_STOPS,
  TEMP_STOPS,
  TIDE_STOPS,
  WAVE_STOPS,
  WIND_STOPS,
  PRECIP_FADE_BELOW,
} from './legends';
import { tileBBox, tileGroup, type TileService } from './tiles';

export const PNG_LAYERS = ['wind', 'waves', 'current', 'sea_state', 'precip', 'temperature', 'sst', 'tide'] as const;
export type PngLayer = (typeof PNG_LAYERS)[number];

export interface PngLayerSpec {
  /** The grid field painted. */
  field: string;
  stops: [number, string][];
  /** Pixels on land are left transparent. */
  maskLand: boolean;
  /** A 0..1 field that scales the alpha (sea state: the signal strength). */
  alphaField?: string;
  /** Alpha ramps up from 0 to this value (precipitation: 0.5 mm/h). */
  fadeBelow?: number;
  /** Water without data is hatched instead of left blank. */
  hatch?: boolean;
  /** Chart resource id (Signal K requires 8+ of [A-Za-z0-9_-]) and name. */
  chartId: string;
  name: string;
  description: string;
}

export const PNG_LAYER_SPECS: Record<PngLayer, PngLayerSpec> = {
  wind: {
    field: 'speed_ms',
    stops: WIND_STOPS,
    maskLand: false,
    chartId: 'wrp-wind-speed',
    name: 'Wind speed',
    description: 'Wind speed at 10 m, ECMWF forecast, by the hour.',
  },
  waves: {
    field: 'swh',
    stops: WAVE_STOPS,
    maskLand: true,
    chartId: 'wrp-wave-height',
    name: 'Wave height',
    description: 'Significant wave height, ECMWF forecast, by the hour.',
  },
  current: {
    field: 'speed_ms',
    stops: CURRENT_STOPS,
    maskLand: true,
    hatch: true,
    chartId: 'wrp-current-speed',
    name: 'Current speed',
    description: 'Surface current speed (Copernicus Marine, NOAA RTOFS, tidal harmonics), by the hour. Hatched: no model data.',
  },
  sea_state: {
    field: 'index',
    stops: SEA_STATE_STOPS,
    maskLand: true,
    alphaField: 'signal',
    chartId: 'wrp-sea-state',
    name: 'Sea state',
    description: 'Wind-against-current sea state index, by the hour.',
  },
  precip: {
    field: 'rate',
    stops: PRECIP_STOPS,
    maskLand: true,
    fadeBelow: PRECIP_FADE_BELOW,
    chartId: 'wrp-precipitation',
    name: 'Precipitation',
    description: 'Precipitation rate, ECMWF forecast, by the hour.',
  },
  temperature: {
    field: 't2m',
    stops: TEMP_STOPS,
    maskLand: false,
    chartId: 'wrp-air-temperature',
    name: 'Air temperature',
    description: 'Air temperature at 2 m, ECMWF forecast, by the hour.',
  },
  sst: {
    field: 'skt',
    stops: SST_STOPS,
    maskLand: true,
    chartId: 'wrp-sea-temperature',
    name: 'Sea temperature',
    description: 'Sea surface temperature, ECMWF forecast, by the hour.',
  },
  tide: {
    field: 'tide_m',
    stops: TIDE_STOPS,
    maskLand: true,
    hatch: true,
    chartId: 'wrp-tide-height',
    name: 'Tide height',
    description: 'Tide height relative to mean sea level (not chart datum), Copernicus Marine, by the hour. Hatched: no model data.',
  },
};

export function isPngLayer(s: string): s is PngLayer {
  return (PNG_LAYERS as readonly string[]).includes(s);
}

export const TILE_PX = 256;
const BASE_ALPHA = 0.55;
const HATCH_RGBA = [96, 96, 96, 150];
const LUT_SIZE = 256;

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** 256 RGB entries, linear between the stops over [first stop, last stop] (as the page's _rampLut). */
export function rampLut(stops: [number, string][]): Uint8Array {
  const lut = new Uint8Array(LUT_SIZE * 3);
  const v0 = stops[0][0];
  const v1 = stops[stops.length - 1][0];
  for (let i = 0; i < LUT_SIZE; i++) {
    const v = v0 + ((v1 - v0) * i) / (LUT_SIZE - 1);
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [a, ca] = stops[k];
    const [b, cb] = stops[k + 1];
    const t = b > a ? Math.min(1, Math.max(0, (v - a) / (b - a))) : 0;
    const ra = hexRgb(ca);
    const rb = hexRgb(cb);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(ra[c] + (rb[c] - ra[c]) * t);
  }
  return lut;
}

const lutCache = new Map<string, Uint8Array>();
function lutFor(layer: PngLayer): Uint8Array {
  let lut = lutCache.get(layer);
  if (!lut) {
    lut = rampLut(PNG_LAYER_SPECS[layer].stops);
    lutCache.set(layer, lut);
  }
  return lut;
}

/**
 * Null-aware bilinear sample of a grid at (lon, lat), as the page's
 * _gridSampler: linear in degrees from the grid's first column/row; more
 * than half a cell outside the lattice is null; null corners drop out and
 * the rest renormalise, null when the remaining weight is ≤ 0.25.
 */
export function sampleGrid(
  grid: Pick<FieldGridResponse, 'lons' | 'lats' | 'res'>,
  values: (number | null)[][],
  lon: number,
  lat: number
): number | null {
  const nx = grid.lons.length;
  const ny = grid.lats.length;
  if (!nx || !ny) return null;
  // Offset east of the grid's first column in [0, 360): a grid may span more
  // than 180° (a zoom 0 or 1 tile), so a ±180 wrap would lose its eastern
  // half. A point just west of the first column reads as a small negative
  // offset (the same rule as the web app's sampler).
  let d = lonOffset(lon, grid.lons[0]);
  if (d > 360 - grid.res / 2) d -= 360;
  const fx = d / grid.res;
  const fy = (lat - grid.lats[0]) / grid.res;
  if (fx < -0.5 || fx > nx - 0.5 || fy < -0.5 || fy > ny - 0.5) return null;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const tx = fx - i0;
  const ty = fy - j0;
  let sum = 0;
  let wsum = 0;
  const take = (i: number, j: number, w: number): void => {
    if (w <= 0 || i < 0 || j < 0 || i >= nx || j >= ny) return;
    const v = values[j][i];
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    sum += v * w;
    wsum += w;
  };
  take(i0, j0, (1 - tx) * (1 - ty));
  take(i0 + 1, j0, tx * (1 - ty));
  take(i0, j0 + 1, (1 - tx) * ty);
  take(i0 + 1, j0 + 1, tx * ty);
  return wsum <= 0.25 ? null : sum / wsum;
}

/**
 * Paint one tile. `land` is the 256 × 256 land mask tile (1 = land, row 0
 * north) when the layer masks land, else null; without it the grid's own
 * coarse land flags are sampled instead.
 */
export function renderFieldPng(layer: PngLayer, z: number, x: number, y: number, grid: FieldGridResponse, land: Uint8Array | null): Buffer {
  const spec = PNG_LAYER_SPECS[layer];
  const lut = lutFor(layer);
  const v0 = spec.stops[0][0];
  const v1 = spec.stops[spec.stops.length - 1][0];
  const values = grid.fields[spec.field];
  const alphaValues = spec.alphaField ? grid.fields[spec.alphaField] : undefined;
  const box = tileBBox(z, x, y);
  const yN = mercY(box.north);
  const yS = mercY(box.south);
  const dLon = (box.east - box.west) / TILE_PX;
  const gx0 = x * TILE_PX;
  const gy0 = y * TILE_PX;
  const rgba = new Uint8Array(TILE_PX * TILE_PX * 4);
  if (!values) return encodePng(TILE_PX, TILE_PX, rgba);
  const useMask = spec.maskLand && land !== null && land.length === TILE_PX * TILE_PX;
  for (let py = 0; py < TILE_PX; py++) {
    const my = yN - ((py + 0.5) / TILE_PX) * (yN - yS);
    const lat = latOfMercY(my);
    for (let px = 0; px < TILE_PX; px++) {
      const o = (py * TILE_PX + px) * 4;
      if (useMask) {
        if (land![py * TILE_PX + px]) continue;
      }
      const lon = box.west + (px + 0.5) * dLon;
      if (spec.maskLand && !useMask) {
        const l = sampleGrid(grid, grid.land, lon, lat);
        if (l !== null && l > 0.5) continue;
      }
      const v = sampleGrid(grid, values, lon, lat);
      if (v === null) {
        if (spec.hatch && useMask && (gx0 + px + gy0 + py) % 7 < 1) {
          rgba[o] = HATCH_RGBA[0];
          rgba[o + 1] = HATCH_RGBA[1];
          rgba[o + 2] = HATCH_RGBA[2];
          rgba[o + 3] = HATCH_RGBA[3];
        }
        continue;
      }
      let a = BASE_ALPHA;
      if (alphaValues) {
        const s = sampleGrid(grid, alphaValues, lon, lat);
        a *= Math.min(1, Math.max(0, s ?? 0));
      }
      if (spec.fadeBelow) a *= Math.min(1, v / spec.fadeBelow);
      if (a <= 0.002) continue;
      const idx = Math.min(LUT_SIZE - 1, Math.max(0, Math.round(((v - v0) / (v1 - v0)) * (LUT_SIZE - 1))));
      rgba[o] = lut[idx * 3];
      rgba[o + 1] = lut[idx * 3 + 1];
      rgba[o + 2] = lut[idx * 3 + 2];
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(TILE_PX, TILE_PX, rgba);
}

/** Rendered tiles, most recently used kept, bounded by bytes. */
export class PngCache {
  private readonly map = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  get(key: string): Buffer | undefined {
    const b = this.map.get(key);
    if (!b) return undefined;
    this.map.delete(key);
    this.map.set(key, b);
    return b;
  }
  set(key: string, b: Buffer): void {
    const old = this.map.get(key);
    if (old) {
      this.map.delete(key);
      this.bytes -= old.length;
    }
    this.map.set(key, b);
    this.bytes += b.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
  get size(): number {
    return this.map.size;
  }
}

/** The PNG for one tile: from the cache, or rendered from the data tiles (field grid, land mask). */
export async function renderTilePng(
  service: TileService,
  cache: PngCache,
  layer: PngLayer,
  z: number,
  x: number,
  y: number,
  hourMs: number,
  signal?: AbortSignal
): Promise<{ png: Buffer; cached: boolean }> {
  const key = `${layer}/${z}/${x}/${y}/${hourMs}/${service.store.generation(tileGroup(layer))}`;
  const hit = cache.get(key);
  if (hit) return { png: hit, cached: true };
  const spec = PNG_LAYER_SPECS[layer];
  const [grid, land] = await Promise.all([
    service.decoded({ layer, z, x, y, hourMs }, signal) as Promise<FieldGridResponse>,
    spec.maskLand ? (service.decoded({ layer: 'land', z, x, y, hourMs: 0 }, signal) as Promise<Uint8Array>) : Promise.resolve(null),
  ]);
  const png = renderFieldPng(layer, z, x, y, grid, land);
  cache.set(key, png);
  return { png, cached: false };
}
