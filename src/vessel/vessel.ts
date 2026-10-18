/** Vessel parameters. SI throughout (metres, m/s, seconds). */

export interface VesselParams {
  /** Cruising speed under power, m/s. */
  motorSpeedMs: number;
  /**
   * Polar performance: the fraction of the polar's boat speeds the vessel
   * achieves under sail (1 = the polar as written). Motor speed is not
   * affected.
   */
  polarPerformance: number;
  /** Draught, m; null = unknown (the chart mesh is then not used). */
  draughtM: number | null;
  /** Air draft (height above the waterline), m; null = unknown (the chart mesh is then not used). */
  airDraftM: number | null;
  /**
   * Water kept under the keel, m. Charted depth must be at least draught + this
   * (the plugin's earlier fixed 0.5 m is the default).
   */
  underKeelClearanceM: number;
  /** Headroom kept above the mast, m. Charted clearance must be at least the air draft + this (default 2 m). */
  overheadClearanceM: number;
}

/**
 * The clearances' defaults and the ranges a vessel may set, m: the one place for them (the settings, the route
 * request's validation and the mesh rules all read these).
 */
export const DEFAULT_UKC_M = 0.5;
export const UKC_M_RANGE: readonly [number, number] = [0, 3];
export const DEFAULT_OVERHEAD_M = 2;
export const OVERHEAD_M_RANGE: readonly [number, number] = [0, 10];

export const DEFAULT_VESSEL: VesselParams = {
  motorSpeedMs: 3.09,
  polarPerformance: 1,
  draughtM: null,
  airDraftM: null,
  underKeelClearanceM: DEFAULT_UKC_M,
  overheadClearanceM: DEFAULT_OVERHEAD_M,
};

/** Merge a partial override onto defaults, validating ranges. */
/** The bounds makeVessel enforces on the drafts; Signal K self-data outside them reads as unknown (plugin/config.ts selfDesignValue). */
export const DRAUGHT_M_RANGE: readonly [number, number] = [0.1, 30];
export const AIR_DRAFT_M_RANGE: readonly [number, number] = [0.5, 100];

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
  if (v.draughtM !== null) check('draughtM', ...DRAUGHT_M_RANGE);
  if (v.airDraftM !== null) check('airDraftM', ...AIR_DRAFT_M_RANGE);
  check('underKeelClearanceM', ...UKC_M_RANGE);
  check('overheadClearanceM', ...OVERHEAD_M_RANGE);
  return v;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, val] of Object.entries(o)) {
    if (val !== undefined && val !== null) (out as Record<string, unknown>)[k] = val;
  }
  return out;
}
