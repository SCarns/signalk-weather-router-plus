/**
 * The child task 'mesh-waters' (childtask.ts): a leg's way across the limits of the charts (engine/mesh/waters.ts,
 * docs/drafts/mesh-no-gshhg-design.md part 5): whether one mesh holds the leg, and otherwise the waters it goes
 * through, the crossings between them, and every mesh's water as cells the coastline search must treat as land. It
 * opens every mesh meeting the leg's area with its rough cut and its joins to the others (meshcoarse.ts), and builds
 * the coastline search's own land raster for the area (the same polygons, resolution and land buffer the worker's
 * landMaskFor and withBuffer give) only when one mesh does not hold the leg. Mesh tiles never enter the route worker.
 */

import type { BBox } from '../geo/geodesy';
import { type CellMask, LandMask } from '../geo/landmask';
import type { MeshRules } from '../engine/mesh/route';
import { MeshStore } from '../engine/mesh/store';
import { planWaters, type WaterMesh, type WaterStretch } from '../engine/mesh/waters';
import { boundaryFile, coarseRulesOf, joinsFile, readBoundary, readCoarseMap, readJoins } from './meshcoarse';

export interface MeshWatersTask {
  task: 'mesh-waters';
  /** Every mesh meeting the leg's area, each with its rough-cut map file for the route's rules (null without rules). */
  meshes: { dir: string; mapFile: string | null; name: string }[];
  /** The leg's rules, or null when the boat's draught or air draft is not set (`why`). */
  rules: MeshRules | null;
  why: string;
  start: [number, number];
  end: [number, number];
  names: { start: string; end: string };
  /** The coastline search's land for the leg's area: its polygons, box, cell budget and land buffer. */
  land: { shapefiles: string[]; bbox: BBox; maxCells: number; bufferM: number };
}

export type MeshWatersTaskResult =
  | { ok: true; kind: 'one-mesh'; mesh: number; ms: number }
  | { ok: true; kind: 'open'; mask: CellMask; ms: number }
  | {
      ok: true;
      kind: 'chain';
      stretches: WaterStretch[];
      mask: CellMask | null;
      changes: number;
      transfers: number;
      ways: number;
      ms: number;
    }
  | { ok: false; reason: string };

export function runMeshWatersTask(t: MeshWatersTask): MeshWatersTaskResult {
  const t0 = Date.now();
  const meshes: WaterMesh[] = [];
  for (const m of t.meshes) {
    const store = MeshStore.open(m.dir);
    if (!t.rules || !m.mapFile) {
      meshes.push({ store, map: null, boundary: null, joins: [], name: m.name });
      continue;
    }
    const map = readCoarseMap(m.mapFile, store, coarseRulesOf(t.rules), m.name);
    if (typeof map === 'string') return { ok: false, reason: map };
    meshes.push({ store, map, boundary: readBoundary(boundaryFile(m.mapFile)), joins: [], name: m.name });
  }
  // Each mesh's joins to the others of the list it meets (the worker made sure they are built).
  if (t.rules)
    t.meshes.forEach((m, i) => {
      t.meshes.forEach((o, j) => {
        if (i === j) return;
        const data = readJoins(joinsFile(m.mapFile!, o.dir));
        if (data) meshes[i].joins.push({ to: j, data });
      });
    });
  const landFor = (): LandMask =>
    LandMask.fromShapefiles(t.land.shapefiles, t.land.bbox, {
      resolutionDeg: LandMask.chooseResolution(t.land.bbox, t.land.maxCells),
    }).withBuffer(t.land.bufferM);
  const r = planWaters(meshes, t.rules, t.why, landFor, t.start, t.end, t.names);
  return r.ok ? { ...r, ms: Date.now() - t0 } : r;
}
