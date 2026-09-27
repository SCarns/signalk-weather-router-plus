/**
 * Minimal ESRI shapefile (.shp) reader for polygon land masks such as
 * GSHHG (`GSHHS_?_L1.shp`) or the OSM land-polygons export.
 *
 * Reads shape types 5 (Polygon), 15 (PolygonZ) and 25 (PolygonM). Each
 * record becomes one `ShapePolygon` with its rings; ring orientation is
 * not interpreted (the rasteriser uses even-odd filling, which is
 * orientation-independent and handles holes correctly).
 *
 * Only records whose bounding box intersects the requested box are
 * decoded, so scanning the 161 MB full-resolution GSHHG file for a
 * regional route costs one sequential read and very little memory.
 *
 * Format reference: ESRI Shapefile Technical Description (July 1998).
 * Byte layout below follows that document; offsets are byte offsets.
 */

import * as fs from 'node:fs';
import type { BBox } from './geodesy';
import { bboxWidth, lonOffsetFromWest } from './geodesy';

export interface Ring {
  /** Flat [lon0, lat0, lon1, lat1, ...]. First and last vertex coincide. */
  coords: Float64Array;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface ShapePolygon {
  recordNumber: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  rings: Ring[];
}

export class ShapefileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapefileError';
  }
}

const SHAPE_NULL = 0;
const SHAPE_POLYGON = 5;
const SHAPE_POLYGON_Z = 15;
const SHAPE_POLYGON_M = 25;

/**
 * Does an axis-aligned lon/lat box (in plain -180..180 coordinates)
 * intersect the possibly antimeridian-crossing `BBox`?
 */
function boxIntersects(b: BBox, minLon: number, minLat: number, maxLon: number, maxLat: number): boolean {
  if (maxLat < b.south || minLat > b.north) return false;
  const width = bboxWidth(b);
  if (width >= 360) return true;
  // Express both record-box edges as offsets east of b.west, in [0, 360).
  const o1 = lonOffsetFromWest(b, minLon);
  const o2 = lonOffsetFromWest(b, maxLon);
  // o1 > o2 means the record box straddles b.west itself, so it touches
  // offset 0, which is inside the clip box. Otherwise the record box is
  // [o1, o2] and intersects [0, width] iff o1 <= width (o1 is never < 0).
  return o1 > o2 || o1 <= width;
}

/**
 * Read polygons whose bounding box intersects `clip` (or all polygons
 * when `clip` is undefined). Returns them in file order.
 */
export function readShapefilePolygons(shpPath: string, clip?: BBox): ShapePolygon[] {
  const fd = fs.openSync(shpPath, 'r');
  try {
    const header = Buffer.alloc(100);
    if (fs.readSync(fd, header, 0, 100, 0) !== 100) {
      throw new ShapefileError(`${shpPath}: too short for a shapefile header`);
    }
    const fileCode = header.readInt32BE(0);
    if (fileCode !== 9994) throw new ShapefileError(`${shpPath}: bad file code ${fileCode}`);
    const fileLengthBytes = header.readInt32BE(24) * 2;
    const shapeType = header.readInt32LE(32);
    if (![SHAPE_POLYGON, SHAPE_POLYGON_Z, SHAPE_POLYGON_M].includes(shapeType)) {
      throw new ShapefileError(`${shpPath}: shape type ${shapeType} is not a polygon type`);
    }

    const out: ShapePolygon[] = [];
    const recHeader = Buffer.alloc(8);
    let pos = 100;
    // Reusable buffer for record contents, grown on demand.
    let content = Buffer.alloc(1 << 20);

    while (pos + 8 <= fileLengthBytes) {
      if (fs.readSync(fd, recHeader, 0, 8, pos) !== 8) break;
      const recordNumber = recHeader.readInt32BE(0);
      const contentLen = recHeader.readInt32BE(4) * 2;
      pos += 8;
      if (contentLen < 4) throw new ShapefileError(`${shpPath}: record ${recordNumber} has length ${contentLen}`);
      if (contentLen > content.length) content = Buffer.alloc(contentLen);
      if (fs.readSync(fd, content, 0, contentLen, pos) !== contentLen) {
        throw new ShapefileError(`${shpPath}: truncated record ${recordNumber}`);
      }
      pos += contentLen;

      const type = content.readInt32LE(0);
      if (type === SHAPE_NULL) continue;
      if (type !== shapeType) {
        throw new ShapefileError(`${shpPath}: record ${recordNumber} has shape type ${type}, file says ${shapeType}`);
      }
      const minLon = content.readDoubleLE(4);
      const minLat = content.readDoubleLE(12);
      const maxLon = content.readDoubleLE(20);
      const maxLat = content.readDoubleLE(28);
      if (clip && !boxIntersects(clip, minLon, minLat, maxLon, maxLat)) continue;

      const numParts = content.readInt32LE(36);
      const numPoints = content.readInt32LE(40);
      const partsOff = 44;
      const pointsOff = partsOff + 4 * numParts;
      const needed = pointsOff + 16 * numPoints;
      if (needed > contentLen) {
        throw new ShapefileError(`${shpPath}: record ${recordNumber} declares ${numPoints} points but has ${contentLen} bytes`);
      }
      const rings: Ring[] = [];
      for (let p = 0; p < numParts; p++) {
        const start = content.readInt32LE(partsOff + 4 * p);
        const end = p + 1 < numParts ? content.readInt32LE(partsOff + 4 * (p + 1)) : numPoints;
        if (end < start || end > numPoints) {
          throw new ShapefileError(`${shpPath}: record ${recordNumber} part ${p} range ${start}..${end} invalid`);
        }
        const n = end - start;
        if (n < 3) continue;
        const coords = new Float64Array(2 * n);
        let rMinLon = Infinity;
        let rMinLat = Infinity;
        let rMaxLon = -Infinity;
        let rMaxLat = -Infinity;
        for (let i = 0; i < n; i++) {
          const o = pointsOff + 16 * (start + i);
          const x = content.readDoubleLE(o);
          const y = content.readDoubleLE(o + 8);
          coords[2 * i] = x;
          coords[2 * i + 1] = y;
          if (x < rMinLon) rMinLon = x;
          if (x > rMaxLon) rMaxLon = x;
          if (y < rMinLat) rMinLat = y;
          if (y > rMaxLat) rMaxLat = y;
        }
        rings.push({ coords, minLon: rMinLon, minLat: rMinLat, maxLon: rMaxLon, maxLat: rMaxLat });
      }
      if (rings.length) out.push({ recordNumber, minLon, minLat, maxLon, maxLat, rings });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Even-odd point-in-polygon over all rings of a shape. Holes are rings
 * too, so a point inside a lake inside land returns false.
 */
export function pointInShape(shape: ShapePolygon, lon: number, lat: number): boolean {
  if (lon < shape.minLon || lon > shape.maxLon || lat < shape.minLat || lat > shape.maxLat) return false;
  let inside = false;
  for (const ring of shape.rings) {
    if (lon < ring.minLon || lon > ring.maxLon || lat < ring.minLat || lat > ring.maxLat) continue;
    const c = ring.coords;
    const n = c.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = c[2 * i];
      const yi = c[2 * i + 1];
      const xj = c[2 * j];
      const yj = c[2 * j + 1];
      if ((yi > lat) !== (yj > lat)) {
        const xCross = xj + ((lat - yj) * (xi - xj)) / (yi - yj);
        if (lon < xCross) inside = !inside;
      }
    }
  }
  return inside;
}
