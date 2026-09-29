/**
 * Polar diagram: boat speed as a function of true wind angle and true
 * wind speed. Files store knots; memory is m/s.
 *
 * Formats:
 *  - `.csv`: header `twa/tws,4,6,8,...` (TWS knots), rows `twa,s1,s2,...`
 *  - `.pol`: same layout, tab-delimited, header `TWA\TWS<tab>...`
 *
 * Interpolation is bilinear with linear extrapolation beyond the table
 * edges (scipy RegularGridInterpolator, method="linear",
 * fill_value=None semantics), clamped at zero, with a per-wind-speed
 * no-go floor: below the tightest TWA that carries any speed at that
 * wind speed the boat is in irons and speed is 0.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { KTS_TO_MS } from '../geo/geodesy';

export class PolarDiagram {
  /** Ascending TWA in degrees. */
  readonly twa: Float64Array;
  /** TWS in m/s, in file order (may be descending). */
  readonly tws: Float64Array;
  /** speeds[i * nTws + k] in m/s for twa[i], tws[k]. */
  readonly speeds: Float64Array;
  private readonly floorByTws: Float64Array;

  constructor(twaDeg: ArrayLike<number>, twsMs: ArrayLike<number>, speedsMs: ArrayLike<number>) {
    const nT = twaDeg.length;
    const nW = twsMs.length;
    if (nT < 2 || nW < 1) throw new Error('polar needs at least two TWA rows and one TWS column');
    if (speedsMs.length !== nT * nW) throw new Error('polar speeds table has the wrong size');
    for (let i = 1; i < nT; i++) {
      if (!(twaDeg[i] > twaDeg[i - 1])) throw new Error('polar TWA rows must be strictly ascending');
    }
    this.twa = Float64Array.from(twaDeg);
    this.tws = Float64Array.from(twsMs);
    this.speeds = Float64Array.from(speedsMs);

    // Per-column no-go floor: first TWA with any speed in that column.
    const rowHasSpeed = new Array<boolean>(nT).fill(false);
    for (let i = 0; i < nT; i++) {
      for (let k = 0; k < nW; k++) if (this.speeds[i * nW + k] > 0) rowHasSpeed[i] = true;
    }
    const worstIdx = rowHasSpeed.indexOf(true);
    let worst = worstIdx >= 0 ? this.twa[worstIdx] : 0;
    const floors = new Float64Array(nW);
    const colHas = new Array<boolean>(nW).fill(false);
    for (let k = 0; k < nW; k++) {
      let first = -1;
      for (let i = 0; i < nT; i++) {
        if (this.speeds[i * nW + k] > 0) {
          first = i;
          break;
        }
      }
      colHas[k] = first >= 0;
      floors[k] = first >= 0 ? this.twa[first] : worst;
    }
    if (nW) {
      worst = Math.max(...floors);
      for (let k = 0; k < nW; k++) if (!colHas[k]) floors[k] = worst;
    }
    this.floorByTws = floors;
  }

  /** Tightest sailable TWA at a wind speed (linear across columns, clamped). */
  noGoFloor(twsMs: number): number {
    const n = this.tws.length;
    if (n === 0) return 0;
    if (n === 1) return this.floorByTws[0];
    // np.interp needs ascending x; flip if the table is descending.
    const asc = this.tws[0] <= this.tws[n - 1];
    const x = (k: number): number => (asc ? this.tws[k] : this.tws[n - 1 - k]);
    const y = (k: number): number => (asc ? this.floorByTws[k] : this.floorByTws[n - 1 - k]);
    if (twsMs <= x(0)) return y(0);
    if (twsMs >= x(n - 1)) return y(n - 1);
    let k = 0;
    while (k + 1 < n && x(k + 1) < twsMs) k++;
    const t = (twsMs - x(k)) / (x(k + 1) - x(k));
    return y(k) + t * (y(k + 1) - y(k));
  }

  /**
   * Boat speed (m/s) for a true wind angle (degrees, mirrored into
   * [0, 180]) and true wind speed (m/s, clamped at 0).
   */
  boatSpeed(twaDeg: number, twsMs: number): number {
    let twa = Math.abs(twaDeg) % 360;
    if (twa > 180) twa = 360 - twa;
    const tws = Math.max(0, twsMs);
    if (twa < this.noGoFloor(tws)) return 0;
    return Math.max(0, this.interp(twa, tws));
  }

  /** Bilinear interpolation with linear extrapolation on both axes. */
  private interp(twa: number, tws: number): number {
    const nT = this.twa.length;
    const nW = this.tws.length;
    // TWA axis (ascending).
    let i = 0;
    while (i + 1 < nT - 1 && this.twa[i + 1] <= twa) i++;
    const ta = (twa - this.twa[i]) / (this.twa[i + 1] - this.twa[i]);
    // TWS axis (either direction).
    if (nW === 1) {
      const a = this.speeds[i * nW];
      const b = this.speeds[(i + 1) * nW];
      return a + ta * (b - a);
    }
    const asc = this.tws[0] <= this.tws[nW - 1];
    let k = 0;
    if (asc) {
      while (k + 1 < nW - 1 && this.tws[k + 1] <= tws) k++;
    } else {
      while (k + 1 < nW - 1 && this.tws[k + 1] >= tws) k++;
    }
    const tw = (tws - this.tws[k]) / (this.tws[k + 1] - this.tws[k]);
    const s00 = this.speeds[i * nW + k];
    const s01 = this.speeds[i * nW + k + 1];
    const s10 = this.speeds[(i + 1) * nW + k];
    const s11 = this.speeds[(i + 1) * nW + k + 1];
    const s0 = s00 + tw * (s01 - s00);
    const s1 = s10 + tw * (s11 - s10);
    return s0 + ta * (s1 - s0);
  }

  /**
   * This polar with every boat speed multiplied by `factor` (the vessel's
   * polar performance, a ratio). Zero cells stay zero, so the no-go floor
   * is unchanged.
   */
  scaled(factor: number): PolarDiagram {
    if (factor === 1) return this;
    return new PolarDiagram(this.twa, this.tws, this.speeds.map((s) => s * factor));
  }

  static load(filePath: string): PolarDiagram {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pol') return PolarDiagram.fromDelimited(filePath, '\t');
    if (ext === '.csv') return PolarDiagram.fromDelimited(filePath, ',');
    throw new Error(`unknown polar format ${ext} for ${filePath} (expected .csv or .pol)`);
  }

  static fromDelimited(filePath: string, delimiter: string): PolarDiagram {
    const text = fs.readFileSync(filePath, 'utf8');
    return PolarDiagram.parse(text, delimiter, filePath);
  }

  static parse(text: string, delimiter: string, label = 'polar'): PolarDiagram {
    const lines = text.split(/\r?\n/);
    let headerIdx = 0;
    while (headerIdx < lines.length && lines[headerIdx].trim() === '') headerIdx++;
    if (headerIdx >= lines.length) throw new Error(`${label} is empty`);
    const header = splitRow(lines[headerIdx], delimiter);
    if (header.length < 2) throw new Error(`${label} has no TWS columns in header: ${lines[headerIdx]}`);
    const twsKts = header.slice(1).map((s) => parseNum(s, `${label} header`));
    const nW = twsKts.length;
    const twa: number[] = [];
    const speeds: number[] = [];
    for (let r = headerIdx + 1; r < lines.length; r++) {
      const line = lines[r];
      if (line.trim() === '') continue;
      const row = splitRow(line, delimiter);
      if (row.length - 1 !== nW) {
        throw new Error(`${label}, row ${r + 1}: expected ${nW} boat-speed columns, got ${row.length - 1}`);
      }
      twa.push(parseNum(row[0], `${label} row ${r + 1}`));
      for (let k = 1; k <= nW; k++) speeds.push(parseNum(row[k], `${label} row ${r + 1}`) * KTS_TO_MS);
    }
    if (twa.length === 0) throw new Error(`${label} has no data rows`);
    return new PolarDiagram(twa, twsKts.map((k) => k * KTS_TO_MS), speeds);
  }
}

function splitRow(line: string, delimiter: string): string[] {
  const parts = delimiter === '\t' ? line.split(/\t+/) : line.split(delimiter);
  return parts.map((s) => s.trim()).filter((s, idx, arr) => !(idx === arr.length - 1 && s === ''));
}

function parseNum(s: string, where: string): number {
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`${where}: "${s}" is not a number`);
  return v;
}
