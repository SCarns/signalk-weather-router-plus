/** Adapter for the Signal K polars Resource Provider contract. No provider files or HTTP needed. */
import { PolarDiagram } from '../vessel/polar';

export const ACTIVE_POLAR_TOKEN = 'signalk-active';

/** Structured-cloneable, unscaled routing table captured before dispatch to the worker. */
export interface ManagedPolar {
  label: string;
  twa: number[];
  tws: number[];
  speeds: number[];
  performanceFactor: number;
}

export interface PolarProviderApp {
  getSelfPath?: (path: string) => unknown;
  resourcesApi?: { getResource?: (type: string, id: string) => Promise<unknown> };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid polar resource: expected object');
  return value as Record<string, unknown>;
}

/** getSelfPath returns a Signal K value node; accept a direct value too. */
function pathValue(value: unknown): unknown {
  return value && typeof value === 'object' && 'value' in value ? (value as { value: unknown }).value : value;
}

export function activePolarId(value: unknown): string {
  const href = object(pathValue(value)).href;
  const match = typeof href === 'string' ? /^\/resources\/polars\/([^/]+)$/.exec(href) : null;
  if (!match) throw new Error('No valid polars.activePolar: select an active polar in Polar Management');
  return match[1];
}

/** Canonical matrix is [TWS][TWA]; PolarDiagram stores [TWA][TWS]. SI speeds stay unchanged. */
export function adaptManagedPolar(resource: unknown, id: string, performanceFactor: unknown): ManagedPolar {
  const doc = object(resource);
  const units = object(doc.units);
  if (doc.kind !== 'polarTable' || doc.schemaVersion !== '1.0.0' || units.twa !== 'rad' || units.tws !== 'm/s' || units.boatSpeed !== 'm/s')
    throw new Error('Unsupported polar: expected canonical polarTable 1.0.0 with rad/m/s units');
  if (object(doc.symmetry).portStarboardSymmetric !== true) throw new Error('Routing requires a port/starboard symmetric polar');
  const axes = object(doc.axes);
  const axis = (value: unknown, min: number, max: number, count: number): number[] => {
    if (
      !Array.isArray(value) ||
      value.length < count ||
      value.some((v, i) => typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (i > 0 && v <= value[i - 1]))
    )
      throw new Error('Invalid polar axes: expected finite, strictly ascending values in range');
    return value as number[];
  };
  const twa = axis(axes.twa, 0, Math.PI, 2).map(a => (a * 180) / Math.PI);
  const tws = axis(axes.tws, 0, Infinity, 1);
  const matrix = object(doc.values).boatSpeedMatrix;
  if (
    !Array.isArray(matrix) ||
    matrix.length !== tws.length ||
    matrix.some(
      row => !Array.isArray(row) || row.length !== twa.length || row.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    )
  )
    throw new Error('Invalid polar matrix: expected a complete nonnegative [TWS][TWA] speed table');
  const factor = performanceFactor === undefined || performanceFactor === null ? 1 : performanceFactor;
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor > 1)
    throw new Error('Invalid polars.performanceFactor: expected a ratio from 0 to 1');
  const speeds = twa.flatMap((_, i) => tws.map((_, k) => (matrix[k] as number[])[i]));
  return { label: typeof doc.name === 'string' && doc.name ? doc.name : id, twa, tws: [...tws], speeds, performanceFactor: factor };
}

export function managedDiagram(polar: ManagedPolar): PolarDiagram {
  return new PolarDiagram(polar.twa, polar.tws, polar.speeds);
}

/** Resolve on demand so edits to the active table (even under the same id) take effect on the next request. */
export async function loadManagedPolar(app: PolarProviderApp): Promise<ManagedPolar> {
  if (!app.resourcesApi?.getResource) throw new Error('Signal K polar source requires the Resources API and a polar provider');
  const active = app.getSelfPath?.('polars.activePolar');
  if (pathValue(active) == null) throw new Error('No active polar: select one in Polar Management');
  const id = activePolarId(active);
  const factor = pathValue(app.getSelfPath?.('polars.performanceFactor'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resource: unknown;
  try {
    resource = await Promise.race([
      app.resourcesApi.getResource('polars', id),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Polar provider timed out; retry the request')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  // Do not dispatch a stale selection if it changed while the resource was loading.
  if (activePolarId(app.getSelfPath?.('polars.activePolar')) !== id)
    throw new Error('Active polar changed while loading; retry the request');
  return adaptManagedPolar(resource, id, factor);
}

/** Automatic detection is optional: local fallback remains usable without a provider. */
export async function detectManagedPolar(app: PolarProviderApp): Promise<ManagedPolar | null> {
  try {
    return await loadManagedPolar(app);
  } catch {
    return null;
  }
}

/** Explicit local tokens always win. Explicit managed selection must not silently change boats. */
export async function selectManagedPolar(
  app: PolarProviderApp,
  source: 'auto' | 'files' | 'signalk',
  token?: string
): Promise<ManagedPolar | undefined> {
  if (token === ACTIVE_POLAR_TOKEN) return loadManagedPolar(app);
  if (token && token !== 'auto') return undefined;
  if (!token && source === 'files') return undefined;
  return (await detectManagedPolar(app)) ?? undefined;
}
