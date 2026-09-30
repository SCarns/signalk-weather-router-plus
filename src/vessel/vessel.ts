/** Vessel parameters. SI throughout (metres, m/s, seconds). */

export interface VesselParams {
  name: string;
  /** Cruising speed under power, m/s. */
  motorSpeedMs: number;
  /**
   * Polar performance: the fraction of the polar's boat speeds the vessel
   * achieves under sail (1 = the polar as written). Motor speed is not
   * affected.
   */
  polarPerformance: number;
}

export const DEFAULT_VESSEL: VesselParams = {
  name: 'Vessel',
  motorSpeedMs: 3.09,
  polarPerformance: 1,
};

/** Merge a partial override onto defaults, validating ranges. */
export function makeVessel(partial: Partial<VesselParams>): VesselParams {
  const v: VesselParams = { ...DEFAULT_VESSEL, ...stripUndefined(partial) };
  const check = (name: keyof VesselParams, min: number, max: number): void => {
    const x = v[name];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
      throw new Error(`vessel.${name} must be a number in [${min}, ${max}] (got ${String(x)})`);
    }
  };
  check('motorSpeedMs', 0.01, 50);
  check('polarPerformance', 0.3, 1.2);
  return v;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, val] of Object.entries(o)) {
    if (val !== undefined && val !== null) (out as Record<string, unknown>)[k] = val;
  }
  return out;
}
