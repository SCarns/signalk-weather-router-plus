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
  /** As atMany with one time per point (ms since epoch). Optional: the stack then calls `at` per point. */
  atManyAt?(lons: Float64Array, lats: Float64Array, timesMs: Float64Array): { u: Float64Array; v: Float64Array };
  /**
   * Display value for the overlay layers only: like `at`, but gridded
   * model sources extend their field up to FILL_RADIUS_CELLS cells
   * towards the coast (coastfill.ts). Absent = same as `at`.
   */
  atDisplay?(lon: number, lat: number, time: Date): [number, number];
  /**
   * Changes whenever the data the source answers with changes (new run,
   * new resident or on-demand area), for caches keyed on the source set.
   * Absent = the name identifies the data.
   */
  readonly revision?: number;
}

export function bboxContains(b: SourceBBox, lon: number, lat: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** Modified Julian Day of a UTC Date (days since 1858-11-17T00:00Z). */
export function dateToMjd(t: Date): number {
  return (t.getTime() - Date.UTC(1858, 10, 17)) / 86_400_000;
}
