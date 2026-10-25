/**
 * The connection state published by the signalk-internet plugin
 * (vessels.self network.internet.state). While it says the link costs
 * money per byte (metered), carries no traffic (offline) or is caught by a
 * sign-in page (captive), nothing here downloads on its own: the forecast
 * and current refresh rounds use what is on disk, the coastline and the
 * chart meshes wait. What the owner starts (Refresh, Download coastline,
 * the mesh panel's buttons, a route) still downloads.
 *
 * The state counts only while signalk-internet is enabled: Signal K keeps
 * the last value a disabled plugin published until it restarts. Without
 * the plugin, or with any other state, downloads run as they always did.
 */

import { MINUTE_MS } from '../geo/units';

export const INTERNET_STATE_PATH = 'network.internet.state';
export const INTERNET_PLUGIN_ID = 'signalk-internet';

/** Held work (the coastline download, the meshes' pass) looks at the state again after this long. */
export const INTERNET_HOLD_RETRY_MS = 15 * MINUTE_MS;
/** Whether signalk-internet is enabled is looked up again when the answer is older than this. */
export const PLUGIN_CHECK_MS = 30_000;
/** At start, how long to wait for signalk-internet's first state before the first downloads. */
export const FIRST_STATE_WAIT_MS = 30_000;
const FIRST_STATE_STEP_MS = 1000;

const HOLDING_STATES: ReadonlySet<string> = new Set(['metered', 'offline', 'captive']);

/** The state's value: `getSelfPath` answers the leaf (`{ value, $source, timestamp }`); a bare value is taken too. */
export function internetState(getSelfPath: ((path: string) => unknown) | undefined): unknown {
  let node: unknown;
  try {
    node = getSelfPath?.(INTERNET_STATE_PATH);
  } catch {
    return undefined;
  }
  return node !== null && typeof node === 'object' ? (node as { value?: unknown }).value : node;
}

/** Why background downloads wait for this state, or null when they may run. */
export function internetHold(getSelfPath: ((path: string) => unknown) | undefined): string | null {
  const value = internetState(getSelfPath);
  if (typeof value !== 'string' || !HOLDING_STATES.has(value)) return null;
  return `the internet connection is ${value} (${INTERNET_STATE_PATH})`;
}

export interface InternetApp {
  getSelfPath?: (path: string) => unknown;
  getFeatures?: (onlyEnabled?: boolean) => Promise<{ plugins: { id: string; enabled: boolean }[] }>;
}

/** What held background work asks (coastline.ts, meshes.ts). */
export interface DownloadHold {
  /** signalk-internet is enabled (at the last lookup): without it nothing is held or watched. */
  readonly active: boolean;
  /** Why background downloads wait now, or null, with the lookup renewed first. */
  holdNow(): Promise<string | null>;
}

/** The state, read only while signalk-internet is enabled. */
export class InternetGate implements DownloadHold {
  private enabled = false;
  private checkedAt = 0;
  /** The lookup in flight, and the reset generation it belongs to. */
  private checking: { gen: number; done: Promise<void> } | null = null;
  private gen = 0;
  private firstState: Promise<void> | null = null;
  private firstStateDone = false;
  private round = 0;
  /** At start: waiting for signalk-internet's first state (notStartedReason). */
  settling = false;

  constructor(private readonly app: InternetApp) {}

  get active(): boolean {
    return this.enabled;
  }

  /** Look up whether signalk-internet is enabled (a server without getFeatures has no answer: not enabled). */
  check(): Promise<void> {
    if (this.checking?.gen === this.gen) return this.checking.done;
    const gen = this.gen;
    const done = (async () => {
      let enabled: boolean;
      try {
        const f = await this.app.getFeatures?.(true);
        enabled = !!f?.plugins.some(p => p.id === INTERNET_PLUGIN_ID && p.enabled);
      } catch {
        enabled = false;
      }
      // A lookup from before a reset speaks for the stopped start, not this one.
      if (gen !== this.gen) return;
      this.enabled = enabled;
      this.checkedAt = Date.now();
    })().finally(() => {
      if (this.checking?.done === done) this.checking = null;
    });
    this.checking = { gen, done };
    return done;
  }

  /** The first-state wait has not finished yet, the lookup included (a route then asks for its forecast itself). */
  get pending(): boolean {
    return this.firstState !== null && !this.firstStateDone;
  }

  /** Why background downloads wait now, or null. Sync: an old lookup is renewed for the next call. */
  hold(): string | null {
    if (Date.now() - this.checkedAt > PLUGIN_CHECK_MS) void this.check();
    return this.enabled ? internetHold(p => this.app.getSelfPath?.(p)) : null;
  }

  /** As `hold`, with the lookup renewed first (work that waited minutes). */
  async holdNow(): Promise<string | null> {
    await this.check();
    return this.hold();
  }

  /**
   * Before the first downloads: with signalk-internet enabled but no state
   * published yet (it starts beside this plugin), wait for one, up to
   * FIRST_STATE_WAIT_MS. One wait serves every caller; later calls return
   * at once. False when `current` is false by then.
   */
  async settle(current: () => boolean, waitMs = FIRST_STATE_WAIT_MS, stepMs = FIRST_STATE_STEP_MS): Promise<boolean> {
    if (!this.firstState) {
      const round = ++this.round;
      this.firstStateDone = false;
      this.firstState = this.waitFirstState(round, waitMs, stepMs).finally(() => {
        if (round === this.round) this.firstStateDone = true;
      });
    }
    await this.firstState;
    return current();
  }

  /** Stop: the next start waits for a first state again (signalk-internet may have been enabled meanwhile). */
  reset(): void {
    this.firstState = null;
    this.firstStateDone = false;
    this.round++;
    this.settling = false;
    this.gen++;
    this.checking = null;
    this.checkedAt = 0;
  }

  /** `round`: a reset since ends this wait, so it no longer speaks for `settling`. */
  private async waitFirstState(round: number, waitMs: number, stepMs: number): Promise<void> {
    await this.check();
    const until = Date.now() + waitMs;
    const mine = (): boolean => round === this.round;
    const missing = (): boolean => internetState(p => this.app.getSelfPath?.(p)) == null;
    if (!mine()) return;
    this.settling = this.enabled && missing();
    try {
      while (this.settling && Date.now() < until) {
        await new Promise(r => setTimeout(r, stepMs));
        if (!mine()) return;
        this.settling = missing();
      }
    } finally {
      if (mine()) this.settling = false;
    }
  }
}
