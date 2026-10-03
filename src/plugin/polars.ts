/**
 * Polar library: the configured default polar plus every `.pol`/`.csv`
 * in the configured polars directory, listed for the UI picker and
 * selectable per route (`vessel.polar` in the route request).
 *
 * Paths handed to clients are opaque tokens: `default` for the
 * configured file, or a file name relative to the polars directory.
 * Resolution refuses anything outside those two, so a request can never
 * read an arbitrary file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PolarDiagram } from '../vessel/polar';
import { KTS_TO_MS } from '../geo/geodesy';
import {
  HULL_TYPES,
  KEEL_TYPES,
  RIG_TYPES,
  slugifyPolarName,
  SpecsError,
  UnsupportedHull,
  validateSpecs,
  type BoatSpecs,
} from '../vessel/vpp';
import { polarCsv, type VppTable } from '../vessel/vpp_empirical';
import { computePhysicsTable } from '../vessel/vpp_physics';

export interface PolarEntry {
  path: string;
  label: string;
  source: 'default' | 'library';
}

export interface PolarLibraryConfig {
  polarFile: string | null;
  polarsDir: string | null;
  /**
   * Where `user/…` polars live (generated ones are written there).
   * Default `<polarsDir>/user`; with the bundled library it is in the
   * plugin data directory, so an update of the package never removes them.
   */
  userDir?: string | null;
}

/** The polar library shipped with the package (weather_routing_pi, GPL-3.0) and its default polar. */
export const BUNDLED_POLARS_DIR = path.join(__dirname, '..', '..', 'data', 'polars');
export const BUNDLED_DEFAULT_POLAR = path.join(BUNDLED_POLARS_DIR, 'catalina36.csv');

function userDirOf(cfg: PolarLibraryConfig): string | null {
  if (cfg.userDir) return cfg.userDir;
  return cfg.polarsDir ? path.join(cfg.polarsDir, 'user') : null;
}

const EXT = new Set(['.pol', '.csv']);

function label(file: string): string {
  return path.basename(file, path.extname(file)).replace(/_/g, ' ');
}

export function listPolars(cfg: PolarLibraryConfig): PolarEntry[] {
  const out: PolarEntry[] = [];
  const seen = new Set<string>();
  if (cfg.polarFile) {
    out.push({ path: 'default', label: `${label(cfg.polarFile)} (default)`, source: 'default' });
    try {
      seen.add(fs.realpathSync(cfg.polarFile));
    } catch {
      /* listed anyway; load will report */
    }
  }
  if (cfg.polarsDir) {
    const dir = cfg.polarsDir;
    const userDir = userDirOf(cfg);
    // A path under `user` lives in the user directory; anything else in the library.
    const pathOf = (rel: string): string | null =>
      rel === 'user' || rel.startsWith('user/') ? (userDir ? path.join(userDir, rel.slice(5)) : null) : path.join(dir, rel);
    const fileOf = (token: string): string => pathOf(token) ?? path.join(dir, token);
    const addDir = (rel: string, labelPrefix: string): void => {
      let names: string[];
      try {
        const p = pathOf(rel);
        names = p ? fs.readdirSync(p) : [];
      } catch {
        names = [];
      }
      for (const n of names.sort((a, b) => a.localeCompare(b))) {
        if (n.startsWith('.') || !EXT.has(path.extname(n).toLowerCase())) continue;
        const token = rel ? `${rel}/${n}` : n;
        try {
          const real = fs.realpathSync(fileOf(token));
          if (!fs.statSync(real).isFile() || seen.has(real)) continue;
          seen.add(real);
        } catch {
          continue;
        }
        out.push({ path: token, label: labelPrefix + label(n), source: 'library' });
      }
    };
    // The bundled library first, then user-generated polars in user/
    // (legacy flat files) and user/<slug>/ (per-account).
    addDir('', '');
    addDir('user', 'user: ');
    let users: string[];
    try {
      users = userDir ? fs.readdirSync(userDir).filter(u => !u.startsWith('.')) : [];
    } catch {
      users = [];
    }
    for (const u of users.sort()) {
      try {
        if (!userDir || !fs.statSync(path.join(userDir, u)).isDirectory()) continue;
      } catch {
        continue;
      }
      addDir(`user/${u}`, `${u.replace(/_/g, ' ')}: `);
    }
  }
  return out;
}

/** Thrown when a client token does not name a polar in the library. */
export class PolarNotFoundError extends Error {
  constructor(message = 'polar not found') {
    super(message);
    this.name = 'PolarNotFoundError';
  }
}

/** Absolute file for a client token, or throws when it is not in the library. */
export function resolvePolarPath(cfg: PolarLibraryConfig, token: string | undefined | null): string | null {
  if (token === undefined || token === null || token === '') return cfg.polarFile;
  if (token === 'default') {
    if (!cfg.polarFile) throw new Error('no default polar is configured');
    return cfg.polarFile;
  }
  if (!cfg.polarsDir) throw new PolarNotFoundError('polar not found: no polars directory is configured');
  const segs = token.split('/');
  const okSeg = (s: string): boolean => s.length > 0 && !s.startsWith('.') && !s.includes('\\');
  if (segs.length > 3 || !segs.every(okSeg) || !EXT.has(path.extname(token).toLowerCase())) throw new PolarNotFoundError();
  if (segs.length > 1 && segs[0] !== 'user') throw new PolarNotFoundError();
  const userDir = userDirOf(cfg);
  const inUser = segs[0] === 'user' && segs.length > 1;
  const base = inUser ? userDir : cfg.polarsDir;
  if (!base) throw new PolarNotFoundError();
  let real: string;
  let dirReal: string;
  try {
    real = fs.realpathSync(path.join(base, ...(inUser ? segs.slice(1) : segs)));
    dirReal = fs.realpathSync(base);
  } catch {
    throw new PolarNotFoundError();
  }
  if (!real.startsWith(dirReal + path.sep) || !fs.statSync(real).isFile()) throw new PolarNotFoundError();
  return real;
}

const cache = new Map<string, { mtimeMs: number; polar: PolarDiagram }>();

/** Load with an mtime-checked cache, so per-route selection does not re-parse. */
export function loadPolarCached(file: string): PolarDiagram {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.polar;
  const polar = PolarDiagram.load(file);
  cache.set(file, { mtimeMs: st.mtimeMs, polar });
  return polar;
}

/**
 * Per-TWS beat (best upwind VMG) and run (best downwind VMG) angles,
 * from a 1° scan of the polar.
 */
export function polarAngles(polar: PolarDiagram): { tws_ms: number[]; beat_deg: number[]; run_deg: number[] } {
  const beat: number[] = [];
  const run: number[] = [];
  for (const tws of polar.tws) {
    let bestB = -1;
    let bestBTwa = 45;
    let bestR = -1;
    let bestRTwa = 150;
    for (let twa = 20; twa < 90; twa += 1) {
      const v = polar.boatSpeed(twa, tws) * Math.cos((twa * Math.PI) / 180);
      if (v > bestB) {
        bestB = v;
        bestBTwa = twa;
      }
    }
    for (let twa = 90; twa < 180; twa += 1) {
      const v = -polar.boatSpeed(twa, tws) * Math.cos((twa * Math.PI) / 180);
      if (v > bestR) {
        bestR = v;
        bestRTwa = twa;
      }
    }
    beat.push(bestBTwa);
    run.push(bestRTwa);
  }
  return { tws_ms: Array.from(polar.tws), beat_deg: beat, run_deg: run };
}

/** The raw table in SI (m/s) for drawing a polar diagram. */
export function polarTable(polar: PolarDiagram): { twa_deg: number[]; tws_ms: number[]; speeds_ms: number[][] } {
  const nW = polar.tws.length;
  const rows: number[][] = [];
  for (let i = 0; i < polar.twa.length; i++) {
    const r: number[] = [];
    for (let k = 0; k < nW; k++) r.push(Math.round(polar.speeds[i * nW + k] * 1e4) / 1e4);
    rows.push(r);
  }
  return { twa_deg: Array.from(polar.twa), tws_ms: Array.from(polar.tws), speeds_ms: rows };
}

// ─────────── POST /api/polar-from-specs (physics calculator) ───────────

/** Result of a polar-from-specs request: an HTTP status and its JSON body. */
export interface PolarFromSpecsResult {
  status: number;
  body: Record<string, unknown>;
}

const NAME_MAX = 60;

/** Shape check of the request body; returns the parsed specs or an error string. */
function parseSpecsRequest(raw: unknown): { name: string; specs: BoatSpecs; overwrite: boolean } | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'JSON body required: {name, specs:{...}, overwrite?}';
  const b = raw as Record<string, unknown>;
  if (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > NAME_MAX)
    return `name must be a string of 1-${NAME_MAX} characters`;
  if (b.overwrite !== undefined && typeof b.overwrite !== 'boolean') return 'overwrite must be a boolean';
  const s = b.specs;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'specs must be an object';
  const o = s as Record<string, unknown>;
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  for (const k of ['loa_m', 'lwl_m', 'beam_m', 'draft_m', 'displacement_kg', 'sail_area_upwind_m2']) {
    if (!isNum(o[k])) return `specs.${k} is required and must be a number`;
  }
  for (const k of ['ballast_kg', 'mast_height_m']) {
    if (o[k] !== undefined && o[k] !== null && !isNum(o[k])) return `specs.${k} must be a number or null`;
  }
  if (o.sail_area_downwind_m2 !== undefined && !isNum(o.sail_area_downwind_m2)) return 'specs.sail_area_downwind_m2 must be a number';
  const oneOf = (k: string, allowed: readonly string[]): string | null =>
    o[k] === undefined || (typeof o[k] === 'string' && allowed.includes(o[k] as string))
      ? null
      : `specs.${k} must be one of ${allowed.join(', ')}`;
  const enumErr = oneOf('rig_type', RIG_TYPES) ?? oneOf('keel_type', KEEL_TYPES) ?? oneOf('hull_type', HULL_TYPES);
  if (enumErr) return enumErr;
  const specs: BoatSpecs = {
    loa_m: o.loa_m as number,
    lwl_m: o.lwl_m as number,
    beam_m: o.beam_m as number,
    draft_m: o.draft_m as number,
    displacement_kg: o.displacement_kg as number,
    ballast_kg: (o.ballast_kg as number | null | undefined) ?? null,
    sail_area_upwind_m2: o.sail_area_upwind_m2 as number,
    sail_area_downwind_m2: (o.sail_area_downwind_m2 as number | undefined) ?? 0,
    mast_height_m: (o.mast_height_m as number | null | undefined) ?? null,
    rig_type: (o.rig_type as BoatSpecs['rig_type']) ?? 'sloop',
    keel_type: (o.keel_type as BoatSpecs['keel_type']) ?? 'fin',
    hull_type: (o.hull_type as BoatSpecs['hull_type']) ?? 'monohull',
  };
  return { name: b.name, specs, overwrite: b.overwrite === true };
}

/**
 * Generate a polar from boat specs with the physics calculator
 * (vessel/vpp_physics.ts) and write it to
 * `<polarsDir>/user/<slug>.csv` in the library's CSV layout (knots on
 * disk, see vessel/vpp_empirical.ts polarCsv). POST /api/polar-from-specs:
 * 400 invalid specs or name, 409 exists without overwrite, 422 unsupported hull.
 * Responds with the library token (accepted by resolvePolarPath), the
 * picker label, validation warnings and the table in SI.
 */
export function polarFromSpecs(cfg: PolarLibraryConfig, raw: unknown): PolarFromSpecsResult {
  const userBase = userDirOf(cfg);
  if (!userBase) return { status: 400, body: { error: 'no polars directory is configured (set polarsDir in the plugin settings)' } };
  const req = parseSpecsRequest(raw);
  if (typeof req === 'string') return { status: 400, body: { error: req } };
  let warnings: string[];
  try {
    warnings = validateSpecs(req.specs, { downwindDefault: false });
    if ((req.specs.sail_area_downwind_m2 ?? 0) > 0) warnings.push('Downwind sail area is not used: the calculator assumes no spinnaker.');
  } catch (err) {
    // The message for API clients, plus the field and limits in SI (SpecsError.detail) for the web app to word in its user's units.
    const detail = err instanceof SpecsError ? err.detail : undefined;
    return { status: 400, body: { error: (err as Error).message, ...detail } };
  }
  const slug = slugifyPolarName(req.name);
  if (!slug) return { status: 400, body: { error: 'Name must contain at least one alphanumeric character' } };

  const userDir = userBase;
  const token = `user/${slug}.csv`;
  const outPath = path.join(userDir, `${slug}.csv`);
  if (fs.existsSync(outPath) && !req.overwrite) {
    return { status: 409, body: { error: `Polar '${slug}' already exists. Pass overwrite=true to replace.` } };
  }
  let table: VppTable;
  try {
    table = computePhysicsTable(req.specs);
  } catch (err) {
    if (err instanceof UnsupportedHull) return { status: 422, body: { error: err.message } };
    return { status: 500, body: { error: `VPP failed: ${(err as Error).message}` } };
  }
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${outPath}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, polarCsv(table, slug));
  fs.renameSync(tmp, outPath);
  // Read back through the library path so the response is exactly what
  // GET /api/polars/table will serve for this token.
  const file = resolvePolarPath(cfg, token);
  if (!file) return { status: 500, body: { error: 'written polar could not be resolved' } };
  cache.delete(file);
  const polar = PolarDiagram.load(file);
  return {
    status: 200,
    body: { path: token, label: `user: ${label(token)}`, warnings, polar: { path: token, ...polarTable(polar) } },
  };
}

export { KTS_TO_MS };
