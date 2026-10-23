/**
 * The connection state published by the signalk-internet plugin
 * (vessels.self network.internet.state). While it says the link costs
 * money per byte (metered), carries no traffic (offline) or is caught by a
 * sign-in page (captive), nothing here downloads on its own: the forecast
 * and current refresh rounds use what is on disk, the coastline and the
 * chart meshes wait. What the owner starts (Refresh, Download coastline,
 * the mesh panel's buttons, a route) still downloads. Without the plugin,
 * or with any other state, downloads run as they always did.
 */

import { MINUTE_MS } from '../geo/units';

export const INTERNET_STATE_PATH = 'network.internet.state';

/** Held work (the coastline download, the meshes' pass) looks at the state again after this long. */
export const INTERNET_HOLD_RETRY_MS = 15 * MINUTE_MS;

const HOLDING_STATES: ReadonlySet<string> = new Set(['metered', 'offline', 'captive']);

/**
 * Why background downloads wait now, or null when they may run.
 * `getSelfPath` answers the leaf (`{ value, $source, timestamp }`) on a
 * Signal K server; a bare value is taken too.
 */
export function internetHold(getSelfPath: ((path: string) => unknown) | undefined): string | null {
  let node: unknown;
  try {
    node = getSelfPath?.(INTERNET_STATE_PATH);
  } catch {
    return null;
  }
  const value = node !== null && typeof node === 'object' ? (node as { value?: unknown }).value : node;
  if (typeof value !== 'string' || !HOLDING_STATES.has(value)) return null;
  return `the internet connection is ${value} (${INTERNET_STATE_PATH})`;
}
