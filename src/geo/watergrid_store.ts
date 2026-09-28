/**
 * Finding the water grid to use: the shipped file (data/ in the package)
 * or one the plugin rebuilt into its data directory, whichever was built
 * from the configured coastline shapefiles (by content fingerprint). When
 * none matches, the best available grid is still returned (a grid from a
 * different edition of the coastline is a sound corridor guide; the route
 * raster check keeps routes consistent with the configured data) and a
 * rebuild is requested.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sourceFingerprints, WaterGrid, WG_FILE_NAME, type WaterGridSource } from './watergrid';

/** Path of the grid shipped with the package. */
export function shippedWaterGridPath(): string {
  // dist/geo/ (compiled) or src/geo/ (tsx) → package root.
  return path.join(__dirname, '..', '..', 'data', WG_FILE_NAME);
}

export interface WaterGridChoice {
  grid: WaterGrid | null;
  file: string | null;
  /** Built from exactly the configured shapefiles. */
  matches: boolean;
  /** No matching grid: build one into `rebuildPath`. */
  needsRebuild: boolean;
  rebuildPath: string;
  sources: WaterGridSource[];
  /** Human-readable notes (what was loaded, why a rebuild is needed). */
  notes: string[];
}

export function chooseWaterGrid(shapefiles: string[], dataDir: string | null, shipped = shippedWaterGridPath()): WaterGridChoice {
  const notes: string[] = [];
  const rebuildPath = dataDir ? path.join(dataDir, WG_FILE_NAME) : path.join(path.dirname(shipped), `rebuilt-${WG_FILE_NAME}`);
  let sources: WaterGridSource[] = [];
  try {
    sources = sourceFingerprints(shapefiles);
  } catch (err) {
    notes.push(`cannot read the coastline shapefiles for fingerprinting: ${(err as Error).message}`);
  }
  let fallback: { grid: WaterGrid; file: string } | null = null;
  const candidates = [...new Set([rebuildPath, shipped])];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let grid: WaterGrid;
    try {
      grid = WaterGrid.load(file);
    } catch (err) {
      notes.push(`${file}: unreadable (${(err as Error).message})`);
      continue;
    }
    if (grid.header.stats?.partial) {
      notes.push(`${file}: a partial (regional) build; ignored`);
      continue;
    }
    if (sources.length && grid.matchesSources(sources)) {
      notes.push(`${file}: built ${grid.header.builtAt} from ${grid.header.sources.map((s) => s.name).join(', ')} (matches the configured coastline)`);
      return { grid, file, matches: true, needsRebuild: false, rebuildPath, sources, notes };
    }
    notes.push(`${file}: built from ${grid.header.sources.map((s) => `${s.name} (${s.size} bytes)`).join(', ')}, not the configured ${sources.map((s) => `${s.name} (${s.size} bytes)`).join(', ') || 'coastline'}`);
    if (!fallback) fallback = { grid, file };
  }
  return {
    grid: fallback?.grid ?? null,
    file: fallback?.file ?? null,
    matches: false,
    needsRebuild: sources.length > 0,
    rebuildPath,
    sources,
    notes,
  };
}
