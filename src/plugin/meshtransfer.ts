/**
 * The child task 'mesh-transfer' (childtask.ts): where a leg from one chart mesh to another changes meshes
 * (engine/mesh/transfer.ts, docs/drafts/mesh-no-gshhg-design.md part 5 step 2): in their overlap, on water both call
 * usable; where they do not connect there, across the water between them on the coastline search, from the first
 * mesh's exit to the second's entry, for which it builds the coastline search's own land raster for the leg's area
 * (the same polygons, resolution and land buffer the worker's landMaskFor and withBuffer give). It opens both meshes
 * and their rough cuts; mesh tiles never enter the route worker.
 */

import type { BBox } from '../geo/geodesy';
import { type CellMask, LandMask } from '../geo/landmask';
import { CoastTiles } from '../geo/coasttiles';
import type { MeshRules } from '../engine/mesh/route';
import { MeshStore } from '../engine/mesh/store';
import { findMeshGap, findMeshTransfer, type TransferMesh } from '../engine/mesh/transfer';
import { boundaryFile, coarseRulesOf, readBoundary, readCoarseMap } from './meshcoarse';

export interface MeshTransferTask {
  task: 'mesh-transfer';
  /** The start's mesh and the end's, each with its rough cut for the route's rules. */
  from: { dir: string; mapFile: string; name: string };
  to: { dir: string; mapFile: string; name: string };
  rules: MeshRules;
  start: [number, number];
  end: [number, number];
  names: { start: string; end: string };
  /** The coastline search's land for the leg's area, for a leg across the water between the meshes. */
  land: { shapefiles: string[]; tilesRoot: string; bbox: BBox; maxCells: number; bufferM: number };
}

export type MeshTransferTaskResult =
  | {
      ok: true;
      kind: 'transfer';
      point: [number, number];
      sharedTiles: number;
      candidateTiles: number;
      tested: number;
      transfers: number;
      ms: number;
    }
  | {
      ok: true;
      kind: 'gap';
      exit: [number, number];
      entry: [number, number];
      exits: number;
      entries: number;
      mask: CellMask;
      /** Why the leg could not change meshes in their overlap. */
      overlap: string;
      ms: number;
    }
  | { ok: false; reason: string };

export function runMeshTransferTask(t: MeshTransferTask): MeshTransferTaskResult {
  const t0 = Date.now();
  const r = coarseRulesOf(t.rules);
  /** A mesh and its rough cut, or why the rough cut cannot be used. */
  const open = (m: MeshTransferTask['from']): TransferMesh | string => {
    const store = MeshStore.open(m.dir);
    const map = readCoarseMap(m.mapFile, store, r, m.name);
    return typeof map === 'string' ? map : { store, boundary: readBoundary(boundaryFile(m.mapFile)), map, name: m.name };
  };
  const from = open(t.from);
  if (typeof from === 'string') return { ok: false, reason: from };
  const to = open(t.to);
  if (typeof to === 'string') return { ok: false, reason: to };
  const x = findMeshTransfer(from, to, t.rules, t.start, t.end, t.names);
  if (x.ok)
    return {
      ok: true,
      kind: 'transfer',
      point: x.point,
      sharedTiles: x.sharedTiles,
      candidateTiles: x.candidateTiles,
      tested: x.tested,
      transfers: x.transfers,
      ms: Date.now() - t0,
    };
  const res = LandMask.chooseResolution(t.land.bbox, t.land.maxCells);
  const land = LandMask.fromCoastline(CoastTiles.open(t.land.shapefiles, t.land.tilesRoot), t.land.bbox, { resolutionDeg: res }).withBuffer(
    t.land.bufferM
  );
  const g = findMeshGap(from, to, t.rules, land, t.start, t.end, t.names);
  if (!g.ok) return { ok: false, reason: `in their overlap, ${x.reason}; across the water between them, ${g.reason}` };
  return { ...g, kind: 'gap', overlap: x.reason, ms: Date.now() - t0 };
}
