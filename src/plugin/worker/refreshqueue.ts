/**
 * The data worker's refresh requests, queued behind its other network work
 * (worker.ts): a refresh asked for while one waits to start joins it (force
 * if either asked; the owner's if either was: a round the owner asked for
 * downloads whatever the internet state); one asked for while one runs is
 * done once after it.
 *
 * The vessel position a refresh was sent with is taken at once (queries see
 * it) and put back when the refresh starts: a settings change queued ahead
 * of it sets the position it was sent with, which is older, and the refresh
 * must not run on that one (PR #68 review: RTOFS chose the product for where
 * the vessel had been, until the next round).
 */

import type { VesselPosition } from '../protocol';

export interface RefreshRequest {
  force?: boolean;
  position?: VesselPosition | null;
  /** The owner asked (Refresh, a route). */
  user?: boolean;
}

interface Queued {
  force: boolean;
  position?: VesselPosition | null;
  user: boolean;
}

export function refreshQueue(deps: {
  /** Run `fn` after the network work already queued. */
  inBackground: (fn: () => Promise<void>) => void;
  setPosition: (pos: VesselPosition | null) => void;
  /** One refresh round. */
  run: (force: boolean, user: boolean) => Promise<void>;
}): (msg: RefreshRequest) => void {
  let queued: Queued | null = null;
  return msg => {
    if (msg.position !== undefined) deps.setPosition(msg.position);
    if (queued) {
      queued.force ||= msg.force ?? false;
      if (msg.position !== undefined) queued.position = msg.position;
      queued.user ||= msg.user ?? false;
      return;
    }
    const q: Queued = { force: msg.force ?? false, position: msg.position, user: msg.user ?? false };
    queued = q;
    deps.inBackground(async () => {
      queued = null;
      if (q.position !== undefined) deps.setPosition(q.position);
      await deps.run(q.force, q.user);
    });
  };
}
