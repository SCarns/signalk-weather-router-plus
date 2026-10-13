/**
 * The child task 'mesh-exit' (childtask.ts): where a leg with one end in a chart mesh and the other outside every
 * mesh leaves the mesh (engine/mesh/exit.ts, docs/drafts/mesh-no-gshhg-design.md part 5). It builds the coastline
 * search's own land raster for the leg's area (the same polygons, resolution and land buffer the worker's
 * landMaskFor and withBuffer give), reads the mesh tiles there, and answers with the exit and the mesh's water as a
 * cell mask for the coastline part. Mesh tiles never enter the route worker.
 */

import type { BBox } from '../geo/geodesy';
import { type CellMask, LandMask } from '../geo/landmask';
import { findMeshExit } from '../engine/mesh/exit';
import type { MeshRules } from '../engine/mesh/route';
import { MeshStore } from '../engine/mesh/store';
import { boundaryFile, coarseRulesOf, readBoundary, readCoarseMap } from './meshcoarse';

export interface MeshExitTask {
  task: 'mesh-exit';
  /** The mesh folder, and its rough cut for the route's rules (which water connects to the stop; its boundary record seeds the buffer). */
  dir: string;
  mapFile: string;
  rules: MeshRules;
  inside: [number, number];
  outside: [number, number];
  names: { inside: string; outside: string };
  /** The coastline search's land for the leg's area: its polygons, box, cell budget and land buffer. */
  land: { shapefiles: string[]; bbox: BBox; maxCells: number; bufferM: number };
}

export type MeshExitTaskResult =
  { ok: true; exit: [number, number]; exits: number; mask: CellMask; ms: number } | { ok: false; reason: string };

export function runMeshExitTask(t: MeshExitTask): MeshExitTaskResult {
  const t0 = Date.now();
  const res = LandMask.chooseResolution(t.land.bbox, t.land.maxCells);
  const land = LandMask.fromShapefiles(t.land.shapefiles, t.land.bbox, { resolutionDeg: res }).withBuffer(t.land.bufferM);
  const store = MeshStore.open(t.dir);
  const map = readCoarseMap(t.mapFile, store, coarseRulesOf(t.rules), 'the mesh');
  if (typeof map === 'string') return { ok: false, reason: map };
  const r = findMeshExit(store, t.rules, readBoundary(boundaryFile(t.mapFile)), map, land, t.inside, t.outside, t.names);
  return r.ok ? { ...r, ms: Date.now() - t0 } : r;
}
