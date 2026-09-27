/** Vessel parameters. SI throughout (metres, m/s, seconds). */

export interface VesselParams {
  name: string;
  /** Draught, metres. */
  draught: number;
  /** Mast height above the waterline, metres. */
  airDraft: number;
  /** Length overall, metres. */
  loa: number;
  beam: number;
  /** Safety margin under the keel, metres. */
  underKeelClearance: number;
  /** Safety margin above the mast, metres. */
  overheadClearance: number;
  /** Cruising speed under power, m/s. */
  motorSpeedMs: number;
  /** Maximum acceptable significant wave height, metres (informational in this version). */
  maxSwh?: number;
  tackPenaltySeconds: number;
}

/** Minimum water depth the vessel needs: draught plus under-keel clearance. */
export function vesselMinDepth(v: VesselParams): number {
  return v.draught + v.underKeelClearance;
}

export function vesselMaxAirDraft(v: VesselParams): number {
  return v.airDraft + v.overheadClearance;
}

export const DEFAULT_VESSEL: VesselParams = {
  name: 'Vessel',
  draught: 1.8,
  airDraft: 16,
  loa: 11,
  beam: 3.7,
  underKeelClearance: 0.5,
  overheadClearance: 1.0,
  motorSpeedMs: 3.09,
  tackPenaltySeconds: 30,
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
  check('draught', 0, 30);
  check('airDraft', 0, 100);
  check('loa', 0.1, 500);
  check('beam', 0.1, 100);
  check('underKeelClearance', 0, 20);
  check('overheadClearance', 0, 20);
  check('motorSpeedMs', 0.01, 50);
  check('tackPenaltySeconds', 0, 3600);
  if (v.maxSwh !== undefined) check('maxSwh', 0, 30);
  return v;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, val] of Object.entries(o)) {
    if (val !== undefined && val !== null) (out as Record<string, unknown>)[k] = val;
  }
  return out;
}
