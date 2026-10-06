/**
 * The glyph overlays as PNG image tiles: wind barbs, current arrows,
 * isobars, sea state arrows and wave arrows, drawn as the web app draws
 * them (public/rp-layers.js: the barb SVG, the arrow SVG and its colour
 * classes, the isobar strokes, the seas and wave glyph SVGs). Barbs and
 * the arrows come from the point data tiles of this tile and its eight
 * neighbours, so a glyph straddling a tile edge is complete on both
 * sides; isobars come from the joined 0.25° pressure field around the
 * tile (tilejoin.ts). Without a font, isobar labels are not drawn and the
 * highs and lows are marked with a filled dot (blue high, red low).
 */

import { encodePng } from './png';
import { clampMercLat, mercY } from '../geo/mercator';
import { lonOffset } from '../geo/angles';
import { KTS_TO_MS } from '../geo/units';
import { Canvas, hexRgba, type Rgba } from './raster';
import { PngCache, TILE_PX } from './pngtiles';
import { tileBBox, tileGroup, type TileId, type TileService } from './tiles';
import { joinPressure, type TileGetter } from './tilejoin';
import type { CurrentPoint, SeaPoint, WindPoint } from './overlays';
import { seaBandGlyphColour, waveGlyphColour } from './legends';
import type { IsobarFeature } from './isobars';

export const GLYPH_LAYERS = ['barbs', 'arrows', 'isobars', 'seas', 'wave_arrows'] as const;
export type GlyphLayer = (typeof GLYPH_LAYERS)[number];

export interface GlyphLayerSpec {
  chartId: string;
  name: string;
  description: string;
}

export const GLYPH_LAYER_SPECS: Record<GlyphLayer, GlyphLayerSpec> = {
  barbs: {
    chartId: 'wrp-wind-barbs',
    name: 'Wind barbs',
    description: 'Wind barbs (direction from, feathers 5/10/50 kt), ECMWF forecast, by the hour.',
  },
  arrows: {
    chartId: 'wrp-current-arrows',
    name: 'Current arrows',
    description: 'Surface current arrows (direction to, size and colour by speed), by the hour.',
  },
  isobars: {
    chartId: 'wrp-isobars',
    name: 'Isobars',
    description: 'Mean sea-level pressure every 4 hPa (bold every 20 hPa), highs blue, lows red; ECMWF forecast, by the hour.',
  },
  seas: {
    chartId: 'wrp-sea-state-arrows',
    name: 'Current against the waves',
    description:
      'What the current does to the waves: arrows along the way the waves travel, coloured by the sea state there; heads meeting where the current opposes the waves (larger the more it steepens them), a double chevron where it runs with them. By the hour.',
  },
  wave_arrows: {
    chartId: 'wrp-wave-arrows',
    name: 'Wave arrows',
    description:
      'Arrows along the way the waves travel, coloured by significant wave height, longer for a longer mean period (swell long, chop short); ECMWF forecast, by the hour.',
  },
};

export function isGlyphLayer(s: string): s is GlyphLayer {
  return (GLYPH_LAYERS as readonly string[]).includes(s);
}

const GLYPH_MARGIN = 48; // px beyond the tile within which a neighbour's glyph can still touch it

/** lon/lat → pixel in this tile (Web Mercator rows), may be outside 0..255. */
function projector(z: number, x: number, y: number): (lon: number, lat: number) => [number, number] {
  const box = tileBBox(z, x, y);
  const yN = mercY(box.north);
  const yS = mercY(box.south);
  const width = box.east - box.west;
  // Degrees of the margin west of the tile from which a glyph may still reach in.
  const marginDeg = (GLYPH_MARGIN / TILE_PX) * width;
  return (lon, lat) => {
    // Offset east of the tile's west edge in [0, 360): a tile may be wider
    // than 180° (zoom 0 or 1); only a point within the margin west of the
    // tile is taken as a negative offset.
    let d = lonOffset(lon, box.west);
    if (d > 360 - marginDeg) d -= 360;
    const my = mercY(clampMercLat(lat));
    return [(d / width) * TILE_PX, ((yN - my) / (yN - yS)) * TILE_PX];
  };
}

/** A local glyph point (x right, y down, origin at the anchor) rotated clockwise by `rad` and scaled, placed at (ax, ay). */
function place(ax: number, ay: number, rad: number, scale: number, lx: number, ly: number): [number, number] {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [ax + (lx * c - ly * s) * scale, ay + (lx * s + ly * c) * scale];
}

/**
 * Class bounds in knots: wind barbs are a glyph drawn in 5-kt steps by
 * meteorological convention, and the current-arrow classes follow the
 * same table as the web app. The only knots in the plugin's rendering.
 */
const WIND_BARB_CLASSES: [number, string][] = [
  [0, '#90CAF9'],
  [5, '#4FC3F7'],
  [10, '#00897B'],
  [15, '#43A047'],
  [20, '#F9A825'],
  [25, '#E64A19'],
  [30, '#C62828'],
];
function windColour(kts: number): Rgba {
  let c = WIND_BARB_CLASSES[0][1];
  for (const [lo, colour] of WIND_BARB_CLASSES) if (kts >= lo) c = colour;
  return hexRgba(c);
}

/** One barb at pixel (ax, ay): the web app's 28 × 44 SVG, plot point (14, 38), staff up to (14, 4), feathers to the left. */
export function drawBarb(cv: Canvas, ax: number, ay: number, speedMs: number, dirFromDeg: number): void {
  const kts = speedMs / KTS_TO_MS;
  const colour = windColour(kts);
  const rad = (Math.round(dirFromDeg / 5) * 5 * Math.PI) / 180;
  const P = (lx: number, ly: number): [number, number] => place(ax, ay, rad, 1, lx - 14, ly - 38);
  if (kts < 2.5) {
    const [cx, cy] = P(14, 34);
    cv.circle(cx, cy, 4, 1.5, colour);
    return;
  }
  let remain = Math.round(kts / 5) * 5;
  const [sx0, sy0] = P(14, 38);
  const [sx1, sy1] = P(14, 4);
  cv.line(sx0, sy0, sx1, sy1, 1.8, colour);
  let yy = 4;
  const STEP = 4;
  const LEN = 10;
  const HALF = 5;
  while (remain >= 50) {
    cv.polygon([P(14, yy), P(14, yy + STEP), P(14 - LEN, yy + STEP / 2)], colour);
    yy += STEP + 1;
    remain -= 50;
  }
  while (remain >= 10) {
    const [x0, y0] = P(14, yy);
    const [x1, y1] = P(14 - LEN, yy + 3);
    cv.line(x0, y0, x1, y1, 1.8, colour);
    yy += STEP;
    remain -= 10;
  }
  if (remain >= 5) {
    if (yy === 4) yy += STEP;
    const [x0, y0] = P(14, yy);
    const [x1, y1] = P(14 - HALF, yy + 1.5);
    cv.line(x0, y0, x1, y1, 1.8, colour);
  }
}

// Current arrows: colour classes by knots, rgba (public/rp-layers.js CURRENT_ARROW_CLASSES).
const CURRENT_ARROW_CLASSES: [number, Rgba][] = [
  [0, [0, 200, 140, 217]],
  [0.5, [180, 180, 0, 217]],
  [1.0, [220, 140, 0, 217]],
  [1.5, [220, 40, 40, 230]],
];
const SLACK_KT = 0.05;

/** One arrow at pixel (ax, ay): the web app's 16 × 32 SVG centred at (8, 16), pointing up, rotated to the direction the current flows to. */
export function drawArrow(cv: Canvas, ax: number, ay: number, speedMs: number, dirToDeg: number): void {
  const kts = speedMs / KTS_TO_MS;
  let colour = CURRENT_ARROW_CLASSES[0][1];
  for (const [lo, c] of CURRENT_ARROW_CLASSES) if (kts >= lo) colour = c;
  if (kts < SLACK_KT) {
    // The pause symbol: two bars 2.5 × 10 of a 16 × 16 icon at scale 0.7.
    const s = 0.7;
    for (const bx of [4, 9.5]) {
      cv.polygon(
        [
          [ax + (bx - 8) * s, ay + (3 - 8) * s],
          [ax + (bx + 2.5 - 8) * s, ay + (3 - 8) * s],
          [ax + (bx + 2.5 - 8) * s, ay + (13 - 8) * s],
          [ax + (bx - 8) * s, ay + (13 - 8) * s],
        ],
        colour
      );
    }
    return;
  }
  const rad = (Math.round(dirToDeg / 5) * 5 * Math.PI) / 180;
  const scale = Math.max(0.4, Math.min(0.8, kts * 0.7 + 0.27));
  const P = (lx: number, ly: number): [number, number] => place(ax, ay, rad, scale, lx - 8, ly - 16);
  cv.polygon([P(6, 12), P(10, 12), P(10, 32), P(6, 32)], colour);
  cv.polygon([P(8, 0), P(1, 14), P(8, 10), P(15, 14)], colour);
}

/** Outline drawn under the seas and wave glyphs (the web app's SEA_GLYPH_OUTLINE). */
const GLYPH_OUTLINE = hexRgba('#0f172a');
const OUTLINE_EXTRA = 1.6;

/**
 * One sea state glyph at pixel (ax, ay): the web app's 22 × 22 SVG
 * (_seasGlyphSvg), centred, pointing up, rotated to the way the waves
 * travel; scaled by the steepening where the current opposes them.
 */
export function drawSeaGlyph(cv: Canvas, ax: number, ay: number, p: SeaPoint): void {
  const colour = hexRgba(seaBandGlyphColour(p.idx));
  const big = p.rel === 'opposing' ? Math.min(1.6, Math.max(1, p.steepen || 1)) : 1;
  const rad = (Math.round(p.to_deg / 5) * 5 * Math.PI) / 180;
  const P = (lx: number, ly: number): [number, number] => place(ax, ay, rad, big, lx - 11, ly - 11);
  // Strokes as [points, width] in the SVG's units.
  const strokes: [[number, number][], number][] =
    p.rel === 'opposing'
      ? [
          [
            [
              [11, 1],
              [11, 8],
            ],
            2.4,
          ],
          [
            [
              [6, 6],
              [11, 11],
              [16, 6],
            ],
            2.6,
          ],
          [
            [
              [11, 21],
              [11, 14],
            ],
            2.4,
          ],
          [
            [
              [6, 16],
              [11, 11],
              [16, 16],
            ],
            2.6,
          ],
        ]
      : p.rel === 'following'
        ? [
            [
              [
                [11, 21],
                [11, 4],
              ],
              2,
            ],
            [
              [
                [6, 8],
                [11, 3],
                [16, 8],
              ],
              2,
            ],
            [
              [
                [6, 13],
                [11, 8],
                [16, 13],
              ],
              2,
            ],
          ]
        : [
            [
              [
                [11, 21],
                [11, 4],
              ],
              1.5,
            ],
            [
              [
                [7, 8],
                [11, 3],
                [15, 8],
              ],
              1.5,
            ],
          ];
  for (const [extra, c] of [
    [OUTLINE_EXTRA, GLYPH_OUTLINE],
    [0, colour],
  ] as const)
    for (const [pts, w] of strokes)
      cv.polyline(
        pts.map(([x, y]) => P(x, y)),
        (w + extra) * big,
        c
      );
}

/** Wave arrow length (px) for a mean period (the web app's _waveArrowLength): 12 px at 4 s and below to 34 px at 16 s; 20 px without one. */
export function waveArrowLength(mwp: number | null): number {
  if (mwp == null || !Number.isFinite(mwp)) return 20;
  const t = Math.max(0, Math.min(1, (mwp - 4) / (16 - 4)));
  return Math.round(12 + t * (34 - 12));
}

/** One wave arrow at pixel (ax, ay): the web app's 14 × (len + 4) SVG (_waveArrowSvg), centred, pointing the way the waves travel. */
export function drawWaveArrow(cv: Canvas, ax: number, ay: number, p: SeaPoint): void {
  const colour = hexRgba(waveGlyphColour(p.swh_m));
  const len = Math.round(waveArrowLength(p.mwp_s) / 2) * 2;
  const h = len + 4;
  const top = 2;
  const bot = h - 2;
  const rad = (Math.round(p.to_deg / 5) * 5 * Math.PI) / 180;
  const P = (lx: number, ly: number): [number, number] => place(ax, ay, rad, 1, lx - 7, ly - h / 2);
  const strokes: [number, number][][] = [
    [
      [7, bot],
      [7, top + 1],
    ],
    [
      [3, top + 5],
      [7, top],
      [11, top + 5],
    ],
  ];
  for (const [extra, c] of [
    [OUTLINE_EXTRA, GLYPH_OUTLINE],
    [0, colour],
  ] as const)
    for (const pts of strokes)
      cv.polyline(
        pts.map(([x, y]) => P(x, y)),
        2 + extra,
        c
      );
}

/** The point glyph tile: each point within reach of the tile drawn with `draw`. */
function renderPointsPng<T extends { lon: number; lat: number }>(
  z: number,
  x: number,
  y: number,
  points: T[],
  draw: (cv: Canvas, px: number, py: number, p: T) => void
): Buffer {
  const cv = new Canvas(TILE_PX, TILE_PX);
  const proj = projector(z, x, y);
  for (const p of points) {
    const [px, py] = proj(p.lon, p.lat);
    if (px < -GLYPH_MARGIN || px > TILE_PX + GLYPH_MARGIN || py < -GLYPH_MARGIN || py > TILE_PX + GLYPH_MARGIN) continue;
    draw(cv, px, py, p);
  }
  return encodePng(TILE_PX, TILE_PX, cv.data);
}

export function renderSeasPng(z: number, x: number, y: number, points: SeaPoint[]): Buffer {
  return renderPointsPng(z, x, y, points, drawSeaGlyph);
}

export function renderWaveArrowsPng(z: number, x: number, y: number, points: SeaPoint[]): Buffer {
  return renderPointsPng(z, x, y, points, drawWaveArrow);
}

export function renderBarbsPng(z: number, x: number, y: number, points: WindPoint[]): Buffer {
  const cv = new Canvas(TILE_PX, TILE_PX);
  const proj = projector(z, x, y);
  for (const p of points) {
    const [px, py] = proj(p.lon, p.lat);
    if (px < -GLYPH_MARGIN || px > TILE_PX + GLYPH_MARGIN || py < -GLYPH_MARGIN || py > TILE_PX + GLYPH_MARGIN) continue;
    drawBarb(cv, px, py, p.speed_ms, p.dir_deg);
  }
  return encodePng(TILE_PX, TILE_PX, cv.data);
}

export function renderArrowsPng(z: number, x: number, y: number, points: CurrentPoint[]): Buffer {
  const cv = new Canvas(TILE_PX, TILE_PX);
  const proj = projector(z, x, y);
  for (const p of points) {
    const [px, py] = proj(p.lon, p.lat);
    if (px < -GLYPH_MARGIN || px > TILE_PX + GLYPH_MARGIN || py < -GLYPH_MARGIN || py > TILE_PX + GLYPH_MARGIN) continue;
    drawArrow(cv, px, py, p.speed_ms, p.dir_deg);
  }
  return encodePng(TILE_PX, TILE_PX, cv.data);
}

const ISOBAR_BOLD = hexRgba('#000000');
const ISOBAR_THIN = hexRgba('#555555');
const HIGH = hexRgba('#1565C0');
const LOW = hexRgba('#C62828');
const WHITE = hexRgba('#ffffff');

export function renderIsobarsPng(z: number, x: number, y: number, features: IsobarFeature[]): Buffer {
  const cv = new Canvas(TILE_PX, TILE_PX);
  const proj = projector(z, x, y);
  for (const f of features) {
    if (f.geometry.type === 'LineString' && f.properties.kind === 'isobar') {
      const pts = f.geometry.coordinates.map(([lon, lat]) => proj(lon, lat));
      cv.polyline(pts, f.properties.bold ? 1.6 : 1.0, f.properties.bold ? ISOBAR_BOLD : ISOBAR_THIN);
    }
  }
  for (const f of features) {
    if (f.geometry.type === 'Point' && (f.properties.kind === 'high' || f.properties.kind === 'low')) {
      const [px, py] = proj(f.geometry.coordinates[0], f.geometry.coordinates[1]);
      if (px < -8 || px > TILE_PX + 8 || py < -8 || py > TILE_PX + 8) continue;
      cv.circle(px, py, 5, 2.5, WHITE);
      cv.circle(px, py, 5, 1.5, f.properties.kind === 'high' ? HIGH : LOW);
    }
  }
  return encodePng(TILE_PX, TILE_PX, cv.data);
}

/** The point tiles of (x, y) and its eight neighbours at zoom z, longitude wrapped, latitude rows clamped. */
function neighbourhood(z: number, x: number, y: number): { x: number; y: number }[] {
  const n = 2 ** z;
  const out: { x: number; y: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= n) continue;
    for (let dx = -1; dx <= 1; dx++) out.push({ x: (((x + dx) % n) + n) % n, y: yy });
  }
  return out;
}

/** The PNG for one glyph tile: from the cache, or rendered from the data tiles. */
export async function renderGlyphTilePng(
  service: TileService,
  cache: PngCache,
  layer: GlyphLayer,
  z: number,
  x: number,
  y: number,
  hourMs: number,
  signal?: AbortSignal
): Promise<{ png: Buffer; cached: boolean }> {
  // The data tile layer each glyph layer is drawn from (both seas glyphs from the 'seas' points).
  const dataLayer = layer === 'isobars' ? 'msl' : layer === 'wave_arrows' ? 'seas' : layer;
  const key = `${layer}/${z}/${x}/${y}/${hourMs}/${service.store.generation(tileGroup(dataLayer))}`;
  const hit = cache.get(key);
  if (hit) return { png: hit, cached: true };
  let png: Buffer;
  if (layer === 'isobars') {
    const box = tileBBox(z, x, y);
    const pad = Math.max(0.5, (box.east - box.west) * 0.1);
    const get: TileGetter = (t: TileId) => service.decoded(t, signal);
    const out = await joinPressure(
      get,
      { west: box.west - pad, south: Math.max(-85, box.south - pad), east: box.east + pad, north: Math.min(85, box.north + pad) },
      hourMs,
      4
    );
    png = renderIsobarsPng(z, x, y, out.features);
  } else {
    const tiles = await Promise.all(
      neighbourhood(z, x, y).map(t => service.decoded({ layer: dataLayer, z, x: t.x, y: t.y, hourMs }, signal))
    );
    const points = ([] as unknown[]).concat(...(tiles as unknown[][]));
    png =
      layer === 'barbs'
        ? renderBarbsPng(z, x, y, points as WindPoint[])
        : layer === 'seas'
          ? renderSeasPng(z, x, y, points as SeaPoint[])
          : layer === 'wave_arrows'
            ? renderWaveArrowsPng(z, x, y, points as SeaPoint[])
            : renderArrowsPng(z, x, y, points as CurrentPoint[]);
  }
  cache.set(key, png);
  return { png, cached: false };
}
