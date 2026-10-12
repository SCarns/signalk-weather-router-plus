/**
 * The final depth check in the child process (childtask.ts task
 * 'mesh-check', engine/mesh/check.ts): the finished route walked through
 * the chart meshes, so the tiles it reads go back to the operating system
 * with the process, never staying in the route worker.
 */

import { checkRouteOnMeshes, type CheckRules, type RouteDepthCheck } from '../engine/mesh/check';
import { MeshStore } from '../engine/mesh/store';

export interface MeshCheckTask {
  task: 'mesh-check';
  /** The mesh folders (one per cluster), in the order the route worker opens them. */
  dirs: string[];
  /** The route, [lon, lat] in route order. */
  path: [number, number][];
  /** The leg of each segment (path[k] → path[k + 1]). */
  legOf: number[];
  legCount: number;
  rules: CheckRules;
}

export function runMeshCheckTask(t: MeshCheckTask): RouteDepthCheck {
  const stores = t.dirs.map(d => MeshStore.open(d));
  return checkRouteOnMeshes(stores, t.path, t.legOf, t.legCount, t.rules);
}
