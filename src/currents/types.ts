/** Common shape of every current source in the stack. SI: m/s, u east, v north. */

export interface SourceBBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface CurrentSourceLike {
  readonly name: string;
  /** Higher wins where sources overlap. */
  readonly priority: number;
  readonly resolutionM: number;
  readonly bbox: SourceBBox;
  contains(lon: number, lat: number): boolean;
  /** (u, v) in m/s; exactly (0, 0) means "no data here". */
  at(lon: number, lat: number, time: Date): [number, number];
  atMany(lons: Float64Array, lats: Float64Array, time: Date): { u: Float64Array; v: Float64Array };
}

export function bboxContains(b: SourceBBox, lon: number, lat: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** Modified Julian Day of a UTC Date (days since 1858-11-17T00:00Z). */
export function dateToMjd(t: Date): number {
  return (t.getTime() - Date.UTC(1858, 10, 17)) / 86_400_000;
}
