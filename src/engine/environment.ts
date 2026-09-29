/** Environmental data interfaces the engine samples, plus calm defaults. */

export interface WaveConditions {
  /** Significant wave height, metres. */
  swh: number;
  /** Mean wave period, seconds. */
  mwp: number;
  /** Mean wave direction FROM, degrees true. */
  mwd: number;
}

export interface WindSource {
  /** Returns [speed m/s, direction FROM degrees]. NaN speed = no data. */
  at(lon: number, lat: number, time: Date): [number, number];
  atMany(lons: Float64Array, lats: Float64Array, time: Date): { speed: Float64Array; dir: Float64Array };
  readonly hasWaves: boolean;
  wavesAt(lon: number, lat: number, time: Date): WaveConditions | null;
}

export interface CurrentSource {
  /** Returns [u east m/s, v north m/s]. */
  at(lon: number, lat: number, time: Date): [number, number];
  atMany(lons: Float64Array, lats: Float64Array, time: Date): { u: Float64Array; v: Float64Array };
}

export class NoWind implements WindSource {
  readonly hasWaves = false;
  at(): [number, number] {
    return [0, 0];
  }
  atMany(lons: Float64Array): { speed: Float64Array; dir: Float64Array } {
    return { speed: new Float64Array(lons.length), dir: new Float64Array(lons.length) };
  }
  wavesAt(): null {
    return null;
  }
}

export class NoCurrent implements CurrentSource {
  at(): [number, number] {
    return [0, 0];
  }
  atMany(lons: Float64Array): { u: Float64Array; v: Float64Array } {
    return { u: new Float64Array(lons.length), v: new Float64Array(lons.length) };
  }
}

/** Constant wind everywhere (tests). */
export class ConstantWind implements WindSource {
  readonly hasWaves = false;
  constructor(
    private readonly speedMs: number,
    private readonly dirFromDeg: number
  ) {}
  at(): [number, number] {
    return [this.speedMs, this.dirFromDeg];
  }
  atMany(lons: Float64Array): { speed: Float64Array; dir: Float64Array } {
    return { speed: new Float64Array(lons.length).fill(this.speedMs), dir: new Float64Array(lons.length).fill(this.dirFromDeg) };
  }
  wavesAt(): null {
    return null;
  }
}
