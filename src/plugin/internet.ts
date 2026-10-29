/**
 * The connection state published by the signalk-internet plugin
 * (vessels.self network.internet.state). While it says the link costs
 * money per byte (metered), carries no traffic (offline) or is caught by a
 * sign-in page (captive), nothing here downloads on its own: the forecast
 * and current refresh rounds use what is on disk, the coastline and the
 * chart meshes wait, and work of theirs under way stops. What the owner
 * starts (Refresh, Download coastline, the mesh panel's buttons, a route)
 * still downloads.
 *
 * The state comes from one subscription, from start to stop: no lookups,
 * no waits, no timers. The server sends the last value when the
 * subscription starts, so a start beside a running signalk-internet knows
 * it at once. Without signalk-internet nothing is ever delivered: nothing
 * is held and nothing waits. (Signal K keeps a value after the plugin that
 * published it stops; clearing it is signalk-internet's to do on stop.)
 */

export const INTERNET_STATE_PATH = 'network.internet.state';

const HOLDING_STATES: ReadonlySet<string> = new Set(['metered', 'offline', 'captive']);

/** Why background downloads wait for this state value, or null when they may run. */
export function internetHold(value: unknown): string | null {
  if (typeof value !== 'string' || !HOLDING_STATES.has(value)) return null;
  return `the internet connection is ${value} (${INTERNET_STATE_PATH})`;
}

interface StateDelta {
  updates?: { values?: { path?: string; value?: unknown }[] }[];
}

export interface InternetApp {
  subscriptionmanager?: {
    subscribe: (
      subscription: { context: string; subscribe: { path: string; policy: string }[] },
      unsubscribes: (() => void)[],
      onError: (err: unknown) => void,
      onDelta: (delta: StateDelta) => void
    ) => void;
  };
}

/** What held background work asks (coastline.ts, meshes.ts). */
export interface InternetHold {
  /** Why background downloads wait now, or null. */
  hold(): string | null;
  /** Call `fn` whenever `hold()` changes; answers the unsubscribe. */
  onChange(fn: () => void): () => void;
  /** Resolves once `hold()` is null (at once when it is) or `signal` aborts. */
  whenClear(signal: AbortSignal): Promise<void>;
}

/** signalk-internet's state, as its last delta gave it. */
export class InternetState implements InternetHold {
  private value: unknown = undefined;
  private unsubscribes: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly app: InternetApp,
    private readonly log: (m: string) => void = () => undefined
  ) {}

  /** Subscribe (plugin start). A server without a subscription manager has nothing to follow. */
  start(): void {
    this.stop();
    try {
      this.app.subscriptionmanager?.subscribe(
        { context: 'vessels.self', subscribe: [{ path: INTERNET_STATE_PATH, policy: 'instant' }] },
        this.unsubscribes,
        err => this.log(`subscription: ${err instanceof Error ? err.message : String(err)}`),
        delta => this.onDelta(delta)
      );
    } catch (err) {
      this.log(`subscription: ${(err as Error).message}`);
    }
  }

  /** Unsubscribe (plugin stop): the value is forgotten, the next start gets it again with its subscription. */
  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.value = undefined;
  }

  hold(): string | null {
    return internetHold(this.value);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  whenClear(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted || !this.hold()) {
        resolve();
        return;
      }
      const done = (): void => {
        off();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const off = this.onChange(() => {
        if (!this.hold()) done();
      });
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private onDelta(delta: StateDelta): void {
    for (const u of delta.updates ?? []) for (const v of u.values ?? []) if (v.path === INTERNET_STATE_PATH) this.set(v.value);
  }

  private set(value: unknown): void {
    const before = this.hold();
    this.value = value;
    if (this.hold() === before) return;
    // A listener that throws must not keep the others from hearing it.
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (err) {
        this.log(`a listener failed: ${(err as Error).message}`);
      }
    }
  }
}
