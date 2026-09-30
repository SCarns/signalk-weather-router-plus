/**
 * The per-box map endpoints answered from saved tiles (tiles.ts), so
 * every client uses the same cache as the page.
 *
 * A request is served by the tiles covering its box at the zoom whose
 * sample spacing is nearest the requested resolution. At one zoom every
 * tile samples the same global lattice (multiples of the spacing), so a
 * value grid or point set for any box is copied from the tiles, not
 * resampled. The answer reports the spacing used (`res`), which is the
 * tile spacing nearest the one asked for (at most √2 × finer or coarser);
 * the time is rounded to the hour. Latitudes beyond ±85.05° (the web-map
 * limit) have no tiles and answer null.
 *
 * Isobars are drawn by the main thread from the joined pressure grid,
 * sampled at 0.25° as before. The land mask is read from the coastline
 * tiles at the nearest pixel size.
 */

import { bboxWidth, type BBox } from '../geo/geodesy';
import { buildIsobarFeatures, type IsobarFeature } from '../engine/isobars';
import type { FieldGridResponse, FieldLayer } from './overlays';
import { ARROWS_PER_TILE, BARBS_PER_TILE, FIELD_SAMPLES_PER_TILE, LAND_TILE_PX, TILE_MAX_ZOOM, tileAt, type TileId } from './tiles';

/** Pressure-tile spacing asked for by joinPressure (just finer than the 0.25° it samples). */
export const PRESSURE_TILE_RES = 0.2;
/** The zoom joinPressure reads for boxes up to 400,000 samples (tile spacing 0.176°). */
export const PRESSURE_TILE_ZOOM = 5;

/** A tile's decoded answer. */
export type TileGetter = (t: TileId) => Promise<unknown>;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Sample spacing of a tile layer at zoom z (as tileQuery). */
export function tileSpacing(layer: 'field' | 'barbs' | 'arrows', z: number): number {
  const width = 360 / 2 ** z;
  if (layer === 'barbs') return clamp(width / BARBS_PER_TILE, 0.02, 5);
  if (layer === 'arrows') return clamp(width / ARROWS_PER_TILE, 0.005, 5);
  return clamp(width / FIELD_SAMPLES_PER_TILE, 0.002, 2);
}

function latticeCount(bbox: BBox, r: number): number {
  return (Math.ceil(bboxWidth(bbox) / r) + 1) * (Math.ceil((bbox.north - bbox.south) / r) + 1);
}

/** The zoom whose spacing is nearest `res` (log scale), coarsened until the box has at most `maxCells` samples. */
export function zoomFor(layer: 'field' | 'barbs' | 'arrows', bbox: BBox, res: number, maxCells: number): number {
  let best = 0;
  let bestErr = Infinity;
  for (let z = 0; z <= TILE_MAX_ZOOM; z++) {
    const err = Math.abs(Math.log(tileSpacing(layer, z) / res));
    if (err < bestErr - 1e-9) {
      bestErr = err;
      best = z;
    }
  }
  while (best > 0 && latticeCount(bbox, tileSpacing(layer, best)) > maxCells) best--;
  return best;
}

function normLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Tiles at zoom z covering the box (x wraps at the date line). */
export function tilesCovering(bbox: BBox, z: number): { x: number; y: number }[] {
  const n = 2 ** z;
  const nw = tileAt(bbox.west, Math.min(85.0511, bbox.north), z);
  const se = tileAt(bbox.east, Math.max(-85.0511, bbox.south), z);
  let span = se.x - nw.x;
  if (span < 0 || (span === 0 && bboxWidth(bbox) > 180)) span += n;
  span = Math.min(span, n - 1);
  const out: { x: number; y: number }[] = [];
  for (let y = nw.y; y <= se.y; y++) for (let i = 0; i <= span; i++) out.push({ x: (nw.x + i) % n, y });
  return out;
}

/** The global lattice of spacing r inside the box (as overlays.ts lattice()). */
function lattice(bbox: BBox, r: number): { lons: number[]; lats: number[] } {
  const width = bboxWidth(bbox);
  const lons: number[] = [];
  const lats: number[] = [];
  const lonStart = Math.ceil(bbox.west / r) * r;
  for (let x = lonStart; x <= bbox.west + width + 1e-9; x += r) lons.push(Math.round(normLon(x) * 1e6) / 1e6);
  const latStart = Math.ceil(bbox.south / r) * r;
  for (let y = latStart; y <= bbox.north + 1e-9; y += r) lats.push(Math.round(y * 1e6) / 1e6);
  return { lons, lats };
}

/** A value grid for any box, joined from the colour-layer tiles. */
export async function joinField(
  get: TileGetter,
  layer: FieldLayer,
  bbox: BBox,
  hourMs: number,
  res: number,
  maxCells = 40_000
): Promise<FieldGridResponse> {
  const z = zoomFor('field', bbox, res, maxCells);
  const r = tileSpacing('field', z);
  const { lons, lats } = lattice(bbox, r);
  // Which tile answers each sample, and each tile once.
  const need = new Map<string, { x: number; y: number }>();
  const tileOf = (lon: number, lat: number): string => {
    const t = tileAt(lon, lat, z);
    const k = `${t.x}/${t.y}`;
    if (!need.has(k)) need.set(k, t);
    return k;
  };
  const cellTile: string[][] = lats.map(lat => lons.map(lon => tileOf(lon, lat)));
  const grids = new Map<string, FieldGridResponse>();
  await Promise.all(
    [...need].map(async ([k, t]) => {
      grids.set(k, (await get({ layer, z, x: t.x, y: t.y, hourMs })) as FieldGridResponse);
    })
  );
  // Tile samples by global lattice index.
  const idx = new Map<string, { col: Map<number, number>; row: Map<number, number> }>();
  for (const [k, g] of grids) {
    const col = new Map<number, number>();
    const row = new Map<number, number>();
    g.lons.forEach((lon, i) => col.set(Math.round(normLon(lon) / g.res), i));
    g.lats.forEach((lat, j) => row.set(Math.round(lat / g.res), j));
    idx.set(k, { col, row });
  }
  // Every field any tile answered (completion order is arbitrary, and a tile may answer none).
  const names = [...new Set([...grids.values()].flatMap(g => Object.keys(g.fields)))];
  const units: Record<string, string> = {};
  for (const g of grids.values()) for (const [k, u] of Object.entries(g.units ?? {})) units[k] ??= u;
  const fields: Record<string, (number | null)[][]> = {};
  for (const n of names) fields[n] = [];
  const land: number[][] = [];
  const lonKeys = lons.map(lon => Math.round(normLon(lon) / r));
  lats.forEach((lat, j) => {
    const latKey = Math.round(lat / r);
    const rows: Record<string, (number | null)[]> = {};
    for (const n of names) rows[n] = [];
    const lrow: number[] = [];
    lons.forEach((_lon, i) => {
      const k = cellTile[j][i];
      const g = grids.get(k);
      const ix = idx.get(k);
      const ci = ix?.col.get(lonKeys[i]);
      const ri = ix?.row.get(latKey);
      const ok = g && ci !== undefined && ri !== undefined && Math.abs(g.res - r) <= r * 1e-9;
      for (const n of names) rows[n].push(ok ? (g.fields[n]?.[ri as number]?.[ci as number] ?? null) : null);
      lrow.push(ok ? (g.land[ri as number]?.[ci as number] ?? 0) : 0);
    });
    for (const n of names) fields[n].push(rows[n]);
    land.push(lrow);
  });
  return {
    layer,
    time: new Date(hourMs).toISOString(),
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
    res: r,
    lons,
    lats,
    fields,
    land,
    units,
  };
}

function inBox(bbox: BBox, lon: number, lat: number): boolean {
  if (lat < bbox.south - 1e-9 || lat > bbox.north + 1e-9) return false;
  const dx = (((lon - bbox.west) % 360) + 360) % 360;
  return dx <= bboxWidth(bbox) + 1e-9 || dx >= 360 - 1e-9;
}

/** Wind-barb or current-arrow points for any box, joined from the point tiles. */
export async function joinPoints<P extends { lon: number; lat: number }>(
  get: TileGetter,
  layer: 'barbs' | 'arrows',
  bbox: BBox,
  hourMs: number,
  res: number
): Promise<P[]> {
  const z = zoomFor(layer, bbox, res, 20_000);
  const tiles = tilesCovering(bbox, z);
  const parts = await Promise.all(tiles.map(t => get({ layer, z, x: t.x, y: t.y, hourMs }) as Promise<P[]>));
  const out: P[] = [];
  for (const pts of parts) for (const p of pts) if (inBox(bbox, p.lon, p.lat)) out.push(p);
  return out;
}

/** Land mask w × h (rows evenly spaced in latitude, as /api/land-mask), read from the coastline tiles at the nearest pixel size. */
export async function joinLandMask(get: TileGetter, bbox: BBox, w: number, h: number): Promise<Uint8Array> {
  const width = bboxWidth(bbox);
  const dx = width / w;
  const dy = (bbox.north - bbox.south) / h;
  let z = clamp(Math.round(Math.log2(360 / (LAND_TILE_PX * dx))), 0, TILE_MAX_ZOOM);
  while (z > 0 && tilesCovering(bbox, z).length > 256) z--;
  const n = 2 ** z;
  const px = n * LAND_TILE_PX;
  const tiles = new Map<string, Uint8Array>();
  await Promise.all(
    tilesCovering(bbox, z).map(async t => {
      tiles.set(`${t.x}/${t.y}`, (await get({ layer: 'land', z, x: t.x, y: t.y, hourMs: 0 })) as Uint8Array);
    })
  );
  const out = new Uint8Array(w * h);
  const gxOf = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const lon = normLon(bbox.west + (x + 0.5) * dx);
    gxOf[x] = Math.min(px - 1, Math.floor(((lon + 180) / 360) * px));
  }
  for (let y = 0; y < h; y++) {
    const lat = clamp(bbox.north - (y + 0.5) * dy, -85.0511, 85.0511);
    const rad = (lat * Math.PI) / 180;
    const gy = Math.min(px - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * px)));
    const ty = Math.floor(gy / LAND_TILE_PX);
    const py = gy % LAND_TILE_PX;
    for (let x = 0; x < w; x++) {
      const gx = gxOf[x];
      const t = tiles.get(`${Math.floor(gx / LAND_TILE_PX)}/${ty}`);
      if (t && t[py * LAND_TILE_PX + (gx % LAND_TILE_PX)]) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * Isobars for a box from the joined pressure tiles: the pressure is
 * sampled at 0.25° over the box plus one cell (at least 8 × 8 cells, at
 * most 600 × 600), as before, then contoured.
 */
export async function joinPressure(
  get: TileGetter,
  bbox: BBox,
  hourMs: number,
  intervalHpa: number
): Promise<{ type: 'FeatureCollection'; features: IsobarFeature[] }> {
  const GRID = 0.25;
  const pad = GRID;
  const west = Math.floor((bbox.west - pad) / GRID) * GRID;
  const south = Math.max(-90, Math.floor((bbox.south - pad) / GRID) * GRID);
  const north = Math.min(90, Math.ceil((bbox.north + pad) / GRID) * GRID);
  const east = west + Math.ceil((bboxWidth(bbox) + 2 * pad) / GRID) * GRID;
  const nx = Math.max(8, Math.min(600, Math.round((east - west) / GRID) + 1));
  const ny = Math.max(8, Math.min(600, Math.round((north - south) / GRID) + 1));
  const lons = new Float64Array(nx);
  const lats = new Float64Array(ny);
  for (let i = 0; i < nx; i++) lons[i] = west + i * GRID;
  for (let j = 0; j < ny; j++) lats[j] = south + j * GRID;
  // Joined pressure at the tile spacing just finer than 0.25°, over the sampled area.
  const area: BBox = {
    west: lons[0] - GRID,
    east: lons[nx - 1] + GRID,
    south: Math.max(-90, lats[0] - GRID),
    north: Math.min(90, lats[ny - 1] + GRID),
  };
  const g = await joinField(get, 'msl', area, hourMs, PRESSURE_TILE_RES, 400_000);
  const rows = g.fields.msl ?? [];
  const at = (lon: number, lat: number): number => {
    let dxl = (((lon - g.lons[0]) % 360) + 360) % 360;
    if (dxl > 360 - g.res / 2) dxl -= 360;
    const fx = dxl / g.res;
    const fy = (lat - g.lats[0]) / g.res;
    const i0 = clamp(Math.floor(fx), 0, g.lons.length - 1);
    const j0 = clamp(Math.floor(fy), 0, g.lats.length - 1);
    const i1 = Math.min(g.lons.length - 1, i0 + 1);
    const j1 = Math.min(g.lats.length - 1, j0 + 1);
    const tx = clamp(fx - i0, 0, 1);
    const ty = clamp(fy - j0, 0, 1);
    let sum = 0;
    let wsum = 0;
    const add = (v: number | null | undefined, w: number): void => {
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        sum += v * w;
        wsum += w;
      }
    };
    add(rows[j0]?.[i0], (1 - tx) * (1 - ty));
    add(rows[j0]?.[i1], tx * (1 - ty));
    add(rows[j1]?.[i0], (1 - tx) * ty);
    add(rows[j1]?.[i1], tx * ty);
    return wsum > 0 ? sum / wsum : NaN;
  };
  const field = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) field[j * nx + i] = at(lons[i], lats[j]) * 0.01;
  return { type: 'FeatureCollection', features: buildIsobarFeatures(field, lons, lats, intervalHpa) };
}
