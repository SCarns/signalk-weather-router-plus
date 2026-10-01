/**
 * Web Mercator (EPSG:3857) as the tile layers use it: tile numbering,
 * tile boxes in degrees, and the projected y of a latitude for pixel
 * rows. One definition each; the arithmetic is the one the renderers
 * used inline, operation for operation, so tiles are bit-identical.
 */

import type { BBox } from './geodesy';
import { wrapLon } from './angles';

/** Latitude limit of the projection, degrees. */
export const MERC_MAX_LAT = 85.0511;

export function clampMercLat(lat: number): number {
  return Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat));
}

/** Projected y of a latitude (the projection's own radians): ln tan(π/4 + φ/2). */
export function mercY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
}

/** Latitude (degrees) of a projected y: the inverse of mercY. */
export function latOfMercY(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

/** Latitude (degrees) at a fraction of the world's height from the north edge (tile row edges). */
export function latOfTileYFrac(yFrac: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * yFrac))) * 180) / Math.PI;
}

/** Fraction of the world's height from the north edge for a latitude (clamped). */
export function tileYFrac(latDeg: number): number {
  const r = (clampMercLat(latDeg) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

/** Fraction of the world's width from the west edge for a longitude already in [-180, 180). */
export function tileXFrac(lonWrapped: number): number {
  return (lonWrapped + 180) / 360;
}

/** A web-map tile's box in degrees. */
export function tileBBox(z: number, x: number, y: number): BBox {
  const n = 2 ** z;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: latOfTileYFrac(y / n),
    south: latOfTileYFrac((y + 1) / n),
  };
}

/** Tile x/y containing a point at zoom z. */
export function tileAt(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.floor(tileXFrac(wrapLon(lon)) * n));
  const y = Math.min(n - 1, Math.max(0, Math.floor(tileYFrac(lat) * n)));
  return { x, y };
}
