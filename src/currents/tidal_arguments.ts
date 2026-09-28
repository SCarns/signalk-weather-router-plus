/**
 * Tidal equilibrium arguments and nodal corrections (FES convention).
 *
 * This is a line-by-line TypeScript port of pyTMD 3.0.5 (Tyler Sutterley et al.,
 * https://github.com/pyTMD/pyTMD, MIT licence):
 *
 *   - `pyTMD.constituents.arguments(MJD, constituents, corrections="FES")`
 *   - `pyTMD.constituents.coefficients_table(constituents, corrections="FES")`
 *   - `pyTMD.constituents.nodal_modulation(n, p, constituents, corrections="FES")`
 *   - `pyTMD.astro.mean_longitudes(MJD, method="ASTRO5")`
 *   - `pyTMD.astro.schureman_arguments(P, N)`
 *   - `pyTMD.astro.polynomial_sum`, `pyTMD.math.normalize_angle`
 *
 * Only the FES branch of the Python is ported (`corrections="FES"`, `deltat=0`,
 * `climate_solar_perigee=False`); OTIS/ATLAS/TMD3/netcdf/perth3/GOT/"group"
 * branches are deliberately absent. The `M1` keyword is exposed as an option
 * (default `"perth5"`, as in pyTMD).
 *
 * Numerical notes (so results agree with the Python to round-off):
 *   - Evaluation order of every expression is preserved.
 *   - `np.mod` semantics (result takes the sign of the divisor) are reproduced
 *     in `npMod` rather than using `((x % m) + m) % m`.
 *   - `ndarray ** 2` (numpy "square" fast path) is written as `x * x`; other
 *     integer powers and `np.power(x, 2.0)` etc. use `Math.pow`, matching
 *     numpy's call to libm `pow`.
 *   - Python `c in ("l2'")` / `c in ("2k2")` / `("tk1")` / `("2oop1")` /
 *     `("oq2")` / `("2oq1")` / `("ko2")` / `("kjq1")` are *substring* tests
 *     (single string, not a tuple). They are ported as substring tests via
 *     `pyIn` so behaviour is identical; under FES the only table entry this
 *     affects besides the named constituents is `o2`, which pyTMD treats
 *     through the `"ko2"` branch (u = u(o1) + u(k1), f = f(o1) f(k1)).
 *   - `G` is the raw dot product (degrees) and is NOT wrapped to [0, 360),
 *     exactly as pyTMD returns it.
 *
 * Unknown constituent names throw `Error("Unsupported constituent: <name>")`,
 * mirroring the `ValueError` raised by `coefficients_table`.
 */

import { DOODSON, type DoodsonRow } from './doodson';

/** Modified Julian Day of 2000-01-01T12:00:00 (pyTMD `_mjd_j2000`). */
const MJD_J2000 = 51544.5;
/** Days per Julian century (pyTMD `_century`). */
const CENTURY = 36525.0;
/** numpy `np.radians` multiplies by this constant. */
const DEG2RAD = Math.PI / 180.0;

export type M1Coefficients = 'Doodson' | 'Ray' | 'Schureman' | 'perth5';

export interface TidalArgumentOptions {
  /** Coefficients to use for the M1 tides (pyTMD `M1` keyword). Default `"perth5"`. */
  M1?: M1Coefficients;
}

export interface MeanLongitudes {
  /** Mean longitude of the moon (degrees, [0, 360)). */
  s: number;
  /** Mean longitude of the sun (degrees). */
  h: number;
  /** Mean longitude of the lunar perigee (degrees). */
  p: number;
  /** Mean longitude of the ascending lunar node (degrees). Decreasing with time. */
  n: number;
  /** Longitude of the solar perigee (degrees). */
  pp: number;
}

export interface TidalArguments {
  /** Nodal correction angle u (radians), one per constituent. */
  pu: Float64Array;
  /** Nodal modulation factor f (dimensionless), one per constituent. */
  pf: Float64Array;
  /** Equilibrium argument G (degrees, unwrapped), one per constituent. */
  G: Float64Array;
}

/** numpy `np.mod(a, b)` for floats: fmod, then shift into the divisor's sign. */
function npMod(a: number, b: number): number {
  let mod = a % b;
  if (mod !== 0) {
    if ((b < 0) !== (mod < 0)) mod += b;
  } else {
    // numpy returns copysign(0, b)
    mod = b < 0 ? -0 : 0;
  }
  return mod;
}

/** numpy `a ** i` for a float array and a Python int exponent. */
function npIntPow(a: number, i: number): number {
  if (i === 0) return 1.0;
  if (i === 1) return a;
  if (i === 2) return a * a; // numpy square fast path
  return Math.pow(a, i);
}

/**
 * pyTMD `polynomial_sum`: `np.sum([c * (t**i) for i, c in enumerate(coefficients)], axis=0)`.
 * Despite its docstring this is a plain (non-Horner) power series summed in
 * increasing order; that order is reproduced here.
 */
function polynomialSum(coefficients: readonly number[], t: number): number {
  let acc = 0.0;
  for (let i = 0; i < coefficients.length; i++) {
    acc += coefficients[i] * npIntPow(t, i);
  }
  return acc;
}

/**
 * pyTMD `astro.mean_longitudes(MJD, method="ASTRO5")`.
 * Meeus Astronomical Algorithms coefficients as used in ASTRO5; returns
 * degrees normalised to [0, 360).
 */
export function meanLongitudesAstro5(mjd: number): MeanLongitudes {
  // centuries relative to 2000-01-01T12:00:00
  const T = (mjd - MJD_J2000) / CENTURY;
  // mean longitude of moon (p. 338)
  const lunarLongitude = [218.3164477, 481267.88123421, -1.5786e-3, 1.855835e-6, -1.53388e-8];
  const S = polynomialSum(lunarLongitude, T);
  // mean longitude of sun (p. 338): moon minus mean elongation, subtracted term-wise first
  const lunarElongation = [297.8501921, 445267.1114034, -1.8819e-3, 1.83195e-6, -8.8445e-9];
  const solar = lunarLongitude.map((c, i) => c - lunarElongation[i]);
  const H = polynomialSum(solar, T);
  // mean longitude of lunar perigee (p. 343)
  const lunarPerigee = [83.3532465, 4069.0137287, -1.032e-2, -1.249172e-5];
  const P = polynomialSum(lunarPerigee, T);
  // mean longitude of ascending lunar node (p. 144)
  const lunarNode = [125.04452, -1934.136261, 2.0708e-3, 2.22222e-6];
  const N = polynomialSum(lunarNode, T);
  // mean longitude of solar perigee (Simon et al., 1994)
  const Ps = 282.94 + 1.7192 * T;
  return {
    s: npMod(S, 360.0),
    h: npMod(H, 360.0),
    p: npMod(P, 360.0),
    n: npMod(N, 360.0),
    pp: npMod(Ps, 360.0),
  };
}

/** Whether `name` is a constituent in the Doodson table (i.e. accepted by `tidalArguments`). */
export function isSupportedConstituent(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DOODSON, name);
}

function coefficientsFor(c: string): DoodsonRow {
  if (!isSupportedConstituent(c)) {
    throw new Error(`Unsupported constituent: ${c}`);
  }
  return DOODSON[c];
}

/** Python `c in "<string>"` (substring membership), see header notes. */
function pyIn(c: string, s: string): boolean {
  return s.includes(c);
}

/** Trigonometric factors shared by every constituent for one epoch. */
interface NodalContext {
  N: number; // node, radians
  P: number; // perigee, radians
  sinn: number;
  cosn: number;
  sin2n: number;
  cos2n: number;
  sin3n: number;
  sinp: number;
  cosp: number;
  sin2p: number;
  cos2p: number;
  // Schureman (1958) additional angles
  II: number;
  xi: number;
  nu: number;
  Qa: number;
  Qu: number;
  Ra: number;
  Ru: number;
  nuPrime: number;
  nuSec: number;
  M1: M1Coefficients;
}

/**
 * pyTMD `astro.schureman_arguments(P, N)`: I, xi, nu, Qa, Qu, Ra, Ru, nu', nu''.
 * P and N in radians.
 */
function schuremanArguments(P: number, N: number): Pick<NodalContext, 'II' | 'xi' | 'nu' | 'Qa' | 'Qu' | 'Ra' | 'Ru' | 'nuPrime' | 'nuSec'> {
  // inclination of the moon's orbit to Earth's equator (Schureman p. 156)
  const I = Math.acos(0.913694997 - 0.035692561 * Math.cos(N));
  // longitude in the moon's orbit of lunar intersection
  const at1 = Math.atan(1.01883 * Math.tan(N / 2.0));
  const at2 = Math.atan(0.64412 * Math.tan(N / 2.0));
  let xi = -at1 - at2 + N;
  xi = Math.atan2(Math.sin(xi), Math.cos(xi));
  // right ascension of lunar intersection
  const nu = at1 - at2;
  // mean longitude of lunar perigee reckoned from the lunar intersection (p. 41)
  const p = P - xi;
  // equation 202 (p. 42)
  const Q = Math.atan(((5.0 * Math.cos(I) - 1.0) * Math.tan(p)) / (7.0 * Math.cos(I) + 1.0));
  // equation 197 (p. 41)
  const Qa = Math.pow(2.31 + 1.435 * Math.cos(2.0 * p), -0.5);
  // equation 204 (p. 42)
  const Qu = p - Q;
  // equation 214 (p. 44)
  const P_R = Math.sin(2.0 * p);
  const Q_R = Math.pow(Math.tan(I / 2.0), -2.0) / 6.0 - Math.cos(2.0 * p);
  const Ru = Math.atan(P_R / Q_R);
  // equation 213 (p. 44); Ra is used as an inverse
  const term1 = 12.0 * Math.pow(Math.tan(I / 2.0), 2.0) * Math.cos(2.0 * p);
  const term2 = 36.0 * Math.pow(Math.tan(I / 2.0), 4.0);
  const Ra = Math.pow(1.0 - term1 + term2, -0.5);
  // equation 224 (p. 45)
  const P_prime = Math.sin(2.0 * I) * Math.sin(nu);
  const Q_prime = Math.sin(2.0 * I) * Math.cos(nu) + 0.3347;
  const nuPrime = Math.atan(P_prime / Q_prime);
  // equation 232 (p. 46)
  const sinI = Math.sin(I);
  const P_sec = sinI * sinI * Math.sin(2.0 * nu);
  const Q_sec = sinI * sinI * Math.cos(2.0 * nu) + 0.0727;
  const nuSec = 0.5 * Math.atan(P_sec / Q_sec);
  return { II: I, xi, nu, Qa, Qu, Ra, Ru, nuPrime, nuSec };
}

function makeNodalContext(nDeg: number, pDeg: number, M1: M1Coefficients): NodalContext {
  const N = nDeg * DEG2RAD;
  const P = pDeg * DEG2RAD;
  const sch = schuremanArguments(P, N);
  return {
    N,
    P,
    sinn: Math.sin(N),
    cosn: Math.cos(N),
    sin2n: Math.sin(2.0 * N),
    cos2n: Math.cos(2.0 * N),
    sin3n: Math.sin(3.0 * N),
    sinp: Math.sin(P),
    cosp: Math.cos(P),
    sin2p: Math.sin(2.0 * P),
    cos2p: Math.cos(2.0 * P),
    ...sch,
    M1,
  };
}

/** Result of one constituent: [u (radians), f]. */
type UF = [number, number];

/** Linear-tide closure: f = sqrt(t1² + t2²), u = atan2(t1, t2). */
function linear(term1: number, term2: number): UF {
  return [Math.atan2(term1, term2), Math.sqrt(term1 * term1 + term2 * term2)];
}

/** Compound tide from parents: f = Π f_k^a_k, u = Σ b_k u_k (products/sums in the Python order). */
function compound(ctx: NodalContext, parents: readonly string[], combine: (u: number[], f: number[]) => UF): UF {
  const us: number[] = [];
  const fs: number[] = [];
  for (const parent of parents) {
    const [u, f] = nodalUF(parent, ctx);
    us.push(u);
    fs.push(f);
  }
  return combine(us, fs);
}

/**
 * pyTMD `nodal_modulation` for a single constituent under `corrections="FES"`.
 * The if/elif chain below preserves the order of the Python source; branches
 * that can only be reached with OTIS/perth3 corrections, or that are shadowed
 * for FES by an earlier FES-specific branch, are omitted.
 */
function nodalUF(c: string, ctx: NodalContext): UF {
  const { sinn, cosn, sin2n, cos2n, sin3n, sinp, cosp, sin2p, cos2p, N, P, II, xi, nu, Qa, Qu, Ra, Ru, nuPrime, nuSec } = ctx;
  const sinII = Math.sin(II);
  const cosHalfII = Math.cos(II / 2.0);

  if (c === 'p1' || c === 's2') {
    // Schureman: Table 2, Pages 165-166
    return linear(0.0, 1.0);
  } else if (c === 'mm' || c === 'msm') {
    // Schureman: Page 164 Table 2; Page 25 Eq. 73
    const term2 = (2.0 / 3.0 - Math.pow(sinII, 2.0)) / 0.5021;
    return linear(0.0, term2);
  } else if (c === 'mf' || c === 'msqm' || c === 'msp' || c === 'mq' || c === 'mt' || c === 'mtm') {
    // Schureman: Table 2 Page 164; Page 25 Eq. 74
    return [-2.0 * xi, Math.pow(sinII, 2.0) / 0.1578];
  } else if (c === 'msf') {
    // Schureman: Table 2 Page 165; Page 25 Eq. 78 (f from m2, u = -u(m2))
    return [-(2.0 * xi - 2.0 * nu), Math.pow(cosHalfII, 4.0) / 0.9154];
  } else if (c === 'mst') {
    const term1 = -0.380 * sin2p - 0.413 * sinn - 0.037 * sin2n;
    const term2 = 1.0 + 0.380 * cos2p + 0.413 * cosn + 0.037 * cos2n;
    return linear(term1, term2);
  } else if (c === 'o1' || c === 'so3' || c === 'op2' || c === '2q1' || c === 'q1' || c === 'rho1' || c === 'sigma1') {
    // Schureman: Table 2 Page 164; Page 25 Eq. 75
    return [2.0 * xi - nu, (sinII * Math.pow(cosHalfII, 2)) / 0.38];
  } else if (c === 'tau1') {
    return linear(0.219 * sinn, 1.0 - 0.219 * cosn);
  } else if (c === 'beta1') {
    return linear(0.226 * sinn, 1.0 + 0.226 * cosn);
  } else if ((c === 'm1' || c === 'm1a' || c === 'm1b') && ctx.M1 === 'Doodson') {
    // A. T. Doodson's coefficients for M1 tides
    const term1 = sinp + 0.2 * Math.sin(P - N);
    const term2 = 2.0 * cosp + 0.4 * Math.cos(P - N);
    return linear(term1, term2);
  } else if ((c === 'm1' || c === 'm1a' || c === 'm1b') && ctx.M1 === 'Ray') {
    // R. Ray's coefficients for M1 tides (perth3)
    const term1 = 0.64 * sinp + 0.135 * Math.sin(P - N);
    const term2 = 1.36 * cosp + 0.267 * Math.cos(P - N);
    return linear(term1, term2);
  } else if ((c === 'm1' || c === 'm1a' || c === 'm1b') && ctx.M1 === 'Schureman') {
    // Schureman: Table 2 Page 165; Page 43 Eq. 206
    return [-nu - Qu, (sinII * Math.pow(cosHalfII, 2)) / (0.38 * Qa)];
  } else if ((c === 'm1' || c === 'm1a' || c === 'm1b') && ctx.M1 === 'perth5') {
    // assumes M1 argument includes p
    const term1 = -0.2294 * sinn - 0.3594 * sin2p - 0.0664 * Math.sin(2.0 * P - N);
    const term2 = 1.0 + 0.1722 * cosn + 0.3594 * cos2p + 0.0664 * Math.cos(2.0 * P - N);
    return linear(term1, term2);
  } else if (c === 'chi1' || c === 'theta1' || c === 'j1') {
    // Schureman: Table 2 Page 164; Page 25 Eq. 76
    return [-nu, Math.sin(2.0 * II) / 0.7214];
  } else if (c === 'k1' || c === 'sk3' || c === '2sk5') {
    // Schureman: Table 2 Page 165; Page 45 Eq. 227
    const temp1 = 0.8965 * Math.pow(Math.sin(2.0 * II), 2.0);
    const temp2 = 0.6001 * Math.sin(2.0 * II) * Math.cos(nu);
    return [-nuPrime, Math.sqrt(temp1 + temp2 + 0.1006)];
  } else if (c === 'oo1' || c === 'ups1') {
    // Schureman: Table 2 Page 164; Page 25 Eq. 77
    return [-2.0 * xi - nu, (sinII * Math.pow(Math.sin(II / 2.0), 2.0)) / 0.01640];
  } else if (
    c === 'm2' || c === '2n2' || c === 'mu2' || c === 'n2' || c === 'nu2' || c === 'lambda2' || c === 'ms4' ||
    c === 'eps2' || c === '2sm6' || c === '2sn6' || c === 'mp1' || c === 'mp3' || c === 'sn4'
  ) {
    // Schureman: Table 2 Page 165; Page 25 Eq. 78
    return [2.0 * xi - 2.0 * nu, Math.pow(cosHalfII, 4.0) / 0.9154];
  } else if (c === 'l2' || c === 'sl4') {
    // Schureman: Table 2 Page 165; Page 44 Eq. 215
    return [2.0 * xi - 2.0 * nu - Ru, Math.pow(cosHalfII, 4.0) / (0.9154 * Ra)];
  } else if (c === 'l2b') {
    // for when l2 is split into two constituents
    return linear(0.441 * sinn, 1.0 + 0.441 * cosn);
  } else if (c === 'k2' || c === 'sk4' || c === '2sk6' || c === 'kp1') {
    // Schureman: Table 2 Page 166; Page 46 Eq. 235
    const term1 = 19.0444 * Math.pow(sinII, 4.0);
    const term2 = 2.7702 * Math.pow(sinII, 2.0) * Math.cos(2.0 * nu);
    return [-2.0 * nuSec, Math.sqrt(term1 + term2 + 0.0981)];
  } else if (c === 'gamma2') {
    const term1 = 0.147 * Math.sin(2.0 * (N - P));
    const term2 = 1.0 + 0.147 * Math.cos(2.0 * (N - P));
    return linear(term1, term2);
  } else if (c === 'delta2') {
    const term1 = 0.505 * sin2p + 0.505 * sinn - 0.165 * sin2n;
    const term2 = 1.0 - 0.505 * cos2p - 0.505 * cosn + 0.165 * cos2n;
    return linear(term1, term2);
  } else if (c === 'eta2' || c === 'zeta2') {
    // Schureman: Table 2 Page 165; Page 25 Eq. 79
    return [-2.0 * nu, Math.pow(sinII, 2.0) / 0.1565];
  } else if (c === "m1'") {
    // Linear 3rd degree terms
    return linear(-0.01815 * sinn, 1.0 - 0.27837 * cosn);
  } else if (c === "q1'") {
    const term1 = 0.3915 * sinn + 0.033 * sin2n + 0.061 * sin2p;
    const term2 = 1.0 + 0.3915 * cosn + 0.033 * cos2n + 0.06 * cos2p;
    return linear(term1, term2);
  } else if (c === "j1'") {
    const term1 = -0.438 * sinn - 0.033 * sin2n;
    const term2 = 1.0 + 0.372 * cosn + 0.033 * cos2n;
    return linear(term1, term2);
  } else if (c === "2n2'") {
    return linear(0.166 * sinn, 1.0 + 0.166 * cosn);
  } else if (c === "n2'") {
    const term1 = 0.1705 * sinn - 0.0035 * sin2n - 0.0176 * sin2p;
    const term2 = 1.0 + 0.1705 * cosn - 0.0035 * cos2n - 0.0176 * cos2p;
    return linear(term1, term2);
  } else if (pyIn(c, "l2'")) {
    // Python: `c in ("l2'")` -- substring test
    return linear(-0.2495 * sinn, 1.0 + 0.1315 * cosn);
  } else if (c === 'm3') {
    // Schureman: Table 2 Page 166; Page 36 Eq. 149
    return [3.0 * xi - 3.0 * nu, Math.pow(cosHalfII, 6.0) / 0.8758];
  } else if (c === 'e3') {
    // Linear 3rd degree terms (m3 is caught above for FES)
    return linear(-0.05644 * sinn, 1.0 - 0.05644 * cosn);
  } else if (c === 'j3' || c === 'f3') {
    const term1 = -0.464 * sinn - 0.052 * sin2n;
    const term2 = 1.0 + 0.387 * cosn + 0.052 * cos2n;
    return linear(term1, term2);
  } else if (c === 'l3') {
    const term1 = -0.373 * sin2p - 0.164 * Math.sin(2.0 * P - N);
    const term2 = 1.0 - 0.373 * cos2p - 0.164 * Math.cos(2.0 * P - N);
    return linear(term1, term2);
  } else if (c === 'mfdw') {
    // special test of Doodson-Warburg formula
    return [(-23.7 * sinn + 2.7 * sin2n - 0.4 * sin3n) * DEG2RAD, 1.043 + 0.414 * cosn];
  }

  // ---- compound tides calculated using recursion ----
  if (c === 'so1' || c === '2so3' || c === '2po1') {
    return compound(ctx, ['o1'], (u, f) => [-u[0], f[0]]);
  } else if (c === 'o3') {
    return compound(ctx, ['o1'], (u, f) => [3.0 * u[0], npIntPow(f[0], 3)]);
  } else if (pyIn(c, '2k2')) {
    return compound(ctx, ['k1'], (u, f) => [2.0 * u[0], npIntPow(f[0], 2)]);
  } else if (pyIn(c, 'tk1')) {
    return compound(ctx, ['k1'], (u, f) => [-u[0], f[0]]);
  } else if (pyIn(c, '2oop1')) {
    return compound(ctx, ['oo1'], (u, f) => [2.0 * u[0], npIntPow(f[0], 2)]);
  } else if (pyIn(c, 'oq2')) {
    return compound(ctx, ['o1', 'q1'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (pyIn(c, '2oq1')) {
    return compound(ctx, ['o1', 'q1'], (u, f) => [2.0 * u[0] - u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (pyIn(c, 'ko2')) {
    return compound(ctx, ['o1', 'k1'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (c === 'opk1') {
    return compound(ctx, ['o1', 'k1'], (u, f) => [u[0] - u[1], f[0] * f[1]]);
  } else if (c === '2ook1') {
    return compound(ctx, ['oo1', 'k1'], (u, f) => [2.0 * u[0] - u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === 'kj2') {
    return compound(ctx, ['k1', 'j1'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (pyIn(c, 'kjq1')) {
    return compound(ctx, ['k1', 'j1', 'q1'], (u, f) => [u[0] + u[1] - u[2], f[0] * f[1] * f[2]]);
  } else if (c === 'k3') {
    return compound(ctx, ['k1', 'k2'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (
    c === 'm4' || c === 'mn4' || c === 'mns2' || c === '2ms2' || c === 'mnus2' || c === 'mmus2' || c === '2ns2' ||
    c === 'n4' || c === 'mnu4' || c === 'mmu4' || c === '2mt6' || c === '2ms6' || c === 'msn6' || c === 'mns6' ||
    c === '2mr6' || c === 'msmu6' || c === '2mp3' || c === '2ms3' || c === '2mp5' || c === '2msp7' ||
    c === '2(ms)8' || c === '2ms8'
  ) {
    return compound(ctx, ['m2'], (u, f) => [2.0 * u[0], npIntPow(f[0], 2)]);
  } else if (c === 'msn2' || c === 'snm2' || c === 'nsm2') {
    return compound(ctx, ['m2'], (_u, f) => [0.0, npIntPow(f[0], 2)]);
  } else if (c === 'mmun2' || c === '2mn2') {
    return compound(ctx, ['m2'], (u, f) => [u[0], npIntPow(f[0], 3)]);
  } else if (c === '2sm2') {
    return compound(ctx, ['m2'], (u, f) => [-u[0], f[0]]);
  } else if (
    c === 'm6' || c === '2mn6' || c === '2mnu6' || c === '2mmu6' || c === '2nm6' || c === 'mnnu6' || c === 'mnmu6' ||
    c === '3ms8' || c === '3mp7' || c === '2msn8' || c === '3ms5' || c === '3mp5' || c === '3ms4' || c === '3m2s2' ||
    c === '3m2s10' || c === '2mn2s2'
  ) {
    return compound(ctx, ['m2'], (u, f) => [3.0 * u[0], npIntPow(f[0], 3)]);
  } else if (
    c === 'm8' || c === 'ma8' || c === '3mn8' || c === '3mnu8' || c === '3mmu8' || c === '2mn8' || c === '2(mn):8' ||
    c === '3msn10' || c === '4ms10' || c === '2(mn)S10' || c === '4m2s12'
  ) {
    return compound(ctx, ['m2'], (u, f) => [4.0 * u[0], npIntPow(f[0], 4)]);
  } else if (c === 'm10' || c === '4mn10' || c === '5ms12' || c === '4msn12' || c === '4mns12') {
    return compound(ctx, ['m2'], (u, f) => [5.0 * u[0], npIntPow(f[0], 5)]);
  } else if (c === 'm12' || c === '5mn12' || c === '6ms14' || c === '5msn14') {
    return compound(ctx, ['m2'], (u, f) => [6.0 * u[0], npIntPow(f[0], 6)]);
  } else if (c === 'm14') {
    return compound(ctx, ['m2'], (u, f) => [7.0 * u[0], npIntPow(f[0], 7)]);
  } else if (c === 'mo3' || c === 'no3' || c === 'mso5') {
    return compound(ctx, ['m2', 'o1'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (c === 'no1' || c === 'nso3') {
    return compound(ctx, ['m2', 'o1'], (u, f) => [u[0] - u[1], f[0] * f[1]]);
  } else if (c === 'mq3' || c === 'nq3') {
    return compound(ctx, ['m2', 'q1'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (c === '2mq3') {
    return compound(ctx, ['m2', 'q1'], (u, f) => [2.0 * u[0] - u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === '2no3') {
    return compound(ctx, ['m2', 'o1'], (u, f) => [2.0 * u[0] - u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === '2mo5' || c === '2no5' || c === 'mno5' || c === '2mso7' || c === '2(ms):o9') {
    return compound(ctx, ['m2', 'o1'], (u, f) => [2.0 * u[0] + u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === '2mno7' || c === '3mo7') {
    return compound(ctx, ['m2', 'o1'], (u, f) => [3.0 * u[0] + u[1], npIntPow(f[0], 3) * f[1]]);
  } else if (c === 'mk3' || c === 'nk3' || c === 'msk5' || c === 'nsk5') {
    return compound(ctx, ['m2', 'k1'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (c === 'mnk5' || c === '2mk5' || c === '2nk5' || c === '2msk7') {
    return compound(ctx, ['m2', 'k1'], (u, f) => [2.0 * u[0] + u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === '2mk3') {
    return compound(ctx, ['m2', 'k1'], (u, f) => [2.0 * u[0] - u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === '3mk7' || c === '2mnk7' || c === '2nmk7' || c === '3nk7' || c === '3msk9') {
    return compound(ctx, ['m2', 'k1'], (u, f) => [3.0 * u[0] + u[1], npIntPow(f[0], 3) * f[1]]);
  } else if (c === '3msk7') {
    return compound(ctx, ['m2', 'k1'], (u, f) => [3.0 * u[0] - u[1], npIntPow(f[0], 3) * f[1]]);
  } else if (c === '4mk9' || c === '3mnk9' || c === '2m2nk9' || c === '2(mn):k9' || c === '3nmk9' || c === '4msk11') {
    return compound(ctx, ['m2', 'k1'], (u, f) => [4.0 * u[0] + u[1], npIntPow(f[0], 4) * f[1]]);
  } else if (c === '3km5') {
    return compound(ctx, ['m2', 'k1'], (u, f) => [u[0] + 3.0 * u[1], f[0] * npIntPow(f[1], 3)]);
  } else if (c === 'mk4' || c === 'nk4' || c === 'mks2') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (c === 'msk2' || c === '2smk4' || c === 'msk6' || c === 'snk6') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [u[0] - u[1], f[0] * f[1]]);
  } else if (c === 'mnk6' || c === '2mk6' || c === '2msk8' || c === 'msnk8') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [2.0 * u[0] + u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === 'mnk2' || c === '2mk2') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [2.0 * u[0] - u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === 'mkn2' || c === 'nkm2') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === 'skm2') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [-u[0] + u[1], f[0] * f[1]]);
  } else if (c === '3mk8' || c === '2mnk8') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [3.0 * u[0] + u[1], npIntPow(f[0], 3) * f[1]]);
  } else if (c === 'm2(ks)2') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [u[0] + 2.0 * u[1], f[0] * npIntPow(f[1], 2)]);
  } else if (c === '2ms2k2') {
    return compound(ctx, ['m2', 'k2'], (u, f) => [2.0 * u[0] - 2.0 * u[1], npIntPow(f[0], 2) * npIntPow(f[1], 2)]);
  } else if (c === 'mko5' || c === 'msko7') {
    return compound(ctx, ['m2', 'k2', 'o1'], (u, f) => [u[0] + u[1] + u[2], f[0] * f[1] * f[2]]);
  } else if (c === 'ml4' || c === 'msl6') {
    return compound(ctx, ['m2', 'l2'], (u, f) => [u[0] + u[1], f[0] * f[1]]);
  } else if (c === '2ml2') {
    return compound(ctx, ['m2', 'l2'], (u, f) => [2.0 * u[0] - u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === '2ml6' || c === '2ml2s2' || c === '2mls4' || c === '2msl8') {
    return compound(ctx, ['m2', 'l2'], (u, f) => [2.0 * u[0] + u[1], npIntPow(f[0], 2) * f[1]]);
  } else if (c === '2nmls6' || c === '3mls6' || c === '2mnls6' || c === '3ml8' || c === '2mnl8' || c === '3msl10') {
    return compound(ctx, ['m2', 'l2'], (u, f) => [3.0 * u[0] + u[1], npIntPow(f[0], 3) * f[1]]);
  } else if (c === '4msl12') {
    return compound(ctx, ['m2', 'l2'], (u, f) => [4.0 * u[0] + u[1], npIntPow(f[0], 4) * f[1]]);
  }

  // default for linear tides: no nodal modulation
  return linear(0.0, 1.0);
}

/**
 * pyTMD `constituents.arguments(np.array([mjd]), constituents, corrections="FES")`
 * for a single Modified Julian Day (deltat = 0).
 *
 * @returns pu (radians), pf (dimensionless), G (degrees, unwrapped), each
 *          indexed like `constituents`.
 * @throws Error `Unsupported constituent: <name>` for a name not in the
 *         Doodson table (checked for every name before anything is computed).
 */
export function tidalArguments(mjd: number, constituents: readonly string[], options: TidalArgumentOptions = {}): TidalArguments {
  const M1: M1Coefficients = options.M1 ?? 'perth5';
  // validate all names first (pyTMD's coefficients_table raises before nodal_modulation runs)
  const coefs: DoodsonRow[] = constituents.map(coefficientsFor);

  // astronomical mean longitudes (ASTRO5 for non-OTIS corrections)
  const { s, h, p, n, pp } = meanLongitudesAstro5(mjd);
  // hours into the day, then mean lunar time in degrees
  const hour = 24.0 * npMod(mjd, 1);
  const tau = 15.0 * hour - s + h;
  // multiples of 90 degrees (Ray technical note 2017)
  const k = 90.0;

  const nc = constituents.length;
  const pu = new Float64Array(nc);
  const pf = new Float64Array(nc);
  const G = new Float64Array(nc);

  // equilibrium arguments: dot([tau, s, h, p, n, pp, k], coef)
  for (let i = 0; i < nc; i++) {
    const cf = coefs[i];
    G[i] = tau * cf[0] + s * cf[1] + h * cf[2] + p * cf[3] + n * cf[4] + pp * cf[5] + k * cf[6];
  }

  // nodal corrections f and u
  const ctx = makeNodalContext(n, p, M1);
  for (let i = 0; i < nc; i++) {
    const [u, f] = nodalUF(constituents[i], ctx);
    pu[i] = u;
    pf[i] = f;
  }

  return { pu, pf, G };
}
