/**
 * Velocity-prediction program (VPP) interface: a boat's specs (hull
 * dimensions, rig, sails) in, a polar diagram (TWA x TWS -> boat speed)
 * out. Port of the routing server's `routing/vessel/vpp.py`.
 *
 * `BoatSpecs` carries the fields sailboatdata.com exposes on a typical
 * boat page. `validateSpecs` throws `SpecsError` (the Python raises
 * ValueError) for values the VPP cannot use and returns warnings for
 * values outside the empirical model's validated range. Messages are
 * formatted exactly as the Python f-strings produce them.
 */

export const RIG_TYPES = ['sloop', 'cutter', 'ketch', 'yawl', 'cat'] as const;
export const KEEL_TYPES = ['fin', 'bulb', 'wing', 'full', 'centerboard', 'swing'] as const;
export const HULL_TYPES = ['monohull', 'catamaran', 'trimaran'] as const;
export type RigType = (typeof RIG_TYPES)[number];
export type KeelType = (typeof KEEL_TYPES)[number];
export type HullType = (typeof HULL_TYPES)[number];

export interface BoatSpecs {
  // Hull
  loa_m: number;
  lwl_m: number;
  beam_m: number;
  draft_m: number;
  displacement_kg: number;
  ballast_kg?: number | null;
  // Rig + sails
  /** Main + 100% jib. */
  sail_area_upwind_m2: number;
  /** Main + spinnaker/genoa. Used only by the empirical VPP (0 = 1.5x upwind); the physics calculator, which the polar generator uses, ignores it (no spinnaker). */
  sail_area_downwind_m2?: number;
  mast_height_m?: number | null;
  // Categorical
  rig_type?: RigType;
  keel_type?: KeelType;
  hull_type?: HullType;
}

/** A spec value the VPP cannot work with (Python: ValueError from validate()). */
export class SpecsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecsError';
  }
}

/** The VPP implementation cannot model this hull type (e.g. a catamaran). */
export class UnsupportedHull extends SpecsError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedHull';
  }
}

/**
 * Python `str(float)` / f"{x}" for a float: shortest round-trip digits,
 * fixed notation for 1e-4 <= |x| < 1e16, otherwise `d.ddde+XX`; integral
 * values keep a trailing `.0`.
 */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const exp = x.toExponential(); // shortest round-trip digits, e.g. "1.097e+1"
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exp);
  if (!m) return String(x);
  const sign = m[1];
  const digits = m[2] + (m[3] ?? '');
  const e = Number(m[4]);
  if (e >= -4 && e < 16) {
    let s: string;
    if (e < 0) s = '0.' + '0'.repeat(-e - 1) + digits;
    else if (digits.length <= e + 1) s = digits + '0'.repeat(e + 1 - digits.length) + '.0';
    else s = digits.slice(0, e + 1) + '.' + digits.slice(e + 1);
    return sign + s;
  }
  const mant = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
  const es = Math.abs(e) < 10 ? '0' + Math.abs(e) : String(Math.abs(e));
  return `${sign}${mant}e${e < 0 ? '-' : '+'}${es}`;
}

/**
 * Python `f"{x:.{d}f}"`: rounds the exact binary value, ties to even.
 * (JS toFixed breaks exact ties upward, e.g. 0.125 -> "0.13" where
 * Python prints "0.12".)
 */
export function pyFixed(x: number, d: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  let s = x.toFixed(d);
  if (Math.abs(x) < 1e21) {
    const exact = Math.abs(x).toFixed(100); // exact decimal expansion of the double
    const dot = exact.indexOf('.');
    const tail = exact.slice(dot + 1 + d);
    if (/^50*$/.test(tail)) {
      // Exact tie: toFixed rounded away from zero; Python rounds to even.
      const keep = exact.slice(0, dot + 1 + d).replace('.', '');
      const last = Number(keep[keep.length - 1]);
      if (last % 2 === 0) {
        const intPart = exact.slice(0, dot);
        const frac = exact.slice(dot + 1, dot + 1 + d);
        s = (x < 0 ? '-' : '') + intPart + (d > 0 ? '.' + frac : '');
      }
    }
  }
  // Python keeps the sign of a negative value that rounds to zero ("-0.00").
  if (x < 0 && !s.startsWith('-')) s = '-' + s;
  return s;
}

/**
 * Warnings for specs outside the empirical VPP's validated range; throws
 * SpecsError for specs it cannot use. Same checks, order and messages as
 * `BoatSpecs.validate()`.
 */
export function validateSpecs(specs: BoatSpecs, opts: { downwindDefault?: boolean } = {}): string[] {
  const downwindDefault = opts.downwindDefault ?? true;
  const warnings: string[] = [];
  const f = pyFloatRepr;
  const inRange = (v: number, lo: number, hi: number): boolean => lo <= v && v <= hi;
  const sa_up = specs.sail_area_upwind_m2;
  const sa_dn = specs.sail_area_downwind_m2 ?? 0;

  if (!inRange(specs.loa_m, 3.0, 50.0)) throw new SpecsError(`LOA ${f(specs.loa_m)} m outside 3-50 m`);
  if (!inRange(specs.lwl_m, 2.0, 50.0)) throw new SpecsError(`LWL ${f(specs.lwl_m)} m outside 2-50 m`);
  if (specs.lwl_m > specs.loa_m + 0.01) throw new SpecsError(`LWL ${f(specs.lwl_m)} > LOA ${f(specs.loa_m)} — swap?`);
  if (!inRange(specs.beam_m, 0.5, 15.0)) throw new SpecsError(`Beam ${f(specs.beam_m)} m outside 0.5-15 m`);
  if (!inRange(specs.draft_m, 0.1, 8.0)) throw new SpecsError(`Draft ${f(specs.draft_m)} m outside 0.1-8 m`);
  if (!inRange(specs.displacement_kg, 50.0, 500_000.0)) {
    throw new SpecsError(`Displacement ${f(specs.displacement_kg)} kg outside 50-500000 kg`);
  }
  if (sa_up <= 0.0) throw new SpecsError('Upwind sail area must be > 0 for the VPP to do anything');
  if (downwindDefault && sa_dn <= 0.0) {
    // Downwind SA defaults to 1.5x upwind at compute time (empirical VPP only).
    warnings.push('Downwind sail area not set; using 1.5× upwind SA as default.');
  }

  // Displacement-length ratio (long tons / (0.01 x LWL_ft)^3), typical 50-400.
  const disp_lt = specs.displacement_kg / 1016.047;
  const lwl_ft = specs.lwl_m * 3.2808;
  const dlr = disp_lt / (0.01 * lwl_ft) ** 3;
  if (!(dlr >= 50 && dlr <= 400)) {
    warnings.push(`Displacement-length ratio ${pyFixed(dlr, 0)} outside typical range 50-400 — polar may be inaccurate.`);
  }

  // Sail-area / displacement ratio, SA / (disp/1025)^(2/3), typical 8-30.
  const sa_d = sa_up / (specs.displacement_kg / 1025.0) ** (2 / 3);
  if (!(sa_d >= 8 && sa_d <= 30)) {
    warnings.push(`SA/D ratio ${pyFixed(sa_d, 1)} outside typical range 8-30 — polar may be inaccurate.`);
  }
  return warnings;
}

/** Python `_slugify` from routing/routers/vpp.py. */
export function slugifyPolarName(name: string): string {
  let s = name.trim().toLowerCase().replace(/ /g, '_');
  s = s.replace(/[^a-z0-9_-]+/g, '');
  s = s.replace(/^[_-]+|[_-]+$/g, '');
  return s;
}
