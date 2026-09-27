#!/usr/bin/env node
/**
 * Command-line route computation, independent of Signal K. Useful for
 * testing the engine and data layer on a workstation.
 *
 *   wrp-route --start 41.47,-71.34 --end 41.25,-69.95 \
 *       --land /path/GSHHS_f_L1.shp --polar catalina36.csv \
 *       --cache ./ecmwf-cache --mode sail_max --hours 72 \
 *       --departure 2026-09-28T12:00:00Z -o route.geojson
 *
 * `--no-forecast` runs with calm wind (motor timing only).
 */

import * as fs from 'node:fs';
import { loadForecastForBBox } from './data/loader';
import { EcmwfClient } from './data/ecmwf';
import { bboxFromLonLat } from './geo/geodesy';
import { LandMask } from './geo/landmask';
import { OceanPropagator } from './engine/propagator';
import { routeToGeoJSON } from './engine/route';
import type { ModePolicy } from './engine/legsim';
import { PolarDiagram } from './vessel/polar';
import { makeVessel } from './vessel/vessel';

function arg(name: string, def?: string): string | undefined {
  // Accept --name and, for single-letter names, -name as well.
  const flags = name.length === 1 ? [`-${name}`, `--${name}`] : [`--${name}`];
  for (const f of flags) {
    const i = process.argv.indexOf(f);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return def;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function parseLatLon(s: string, what: string): [number, number] {
  const parts = s.split(',').map(Number);
  if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) throw new Error(`${what}: expected lat,lon (got "${s}")`);
  return [parts[1], parts[0]];
}

async function main(): Promise<void> {
  const start = parseLatLon(arg('start') ?? '', '--start');
  const end = parseLatLon(arg('end') ?? '', '--end');
  const landArg = arg('land');
  if (!landArg) throw new Error('--land <shapefile>[,<shapefile>...] is required');
  const land = landArg.split(',');
  const polarPath = arg('polar');
  const mode = (arg('mode', 'sail_max') as ModePolicy);
  const hours = Number(arg('hours', '72'));
  const departure = new Date(arg('departure') ?? Date.now());
  const out = arg('o', 'route.geojson')!;
  const cacheDir = arg('cache', './ecmwf-cache')!;
  const stages = Number(arg('stages', '20'));
  const motorKts = Number(arg('motor-kts', '6'));
  const viasArg = arg('via');
  const vias = viasArg
    ? viasArg.split(';').map((v) => {
      const [ll, r] = v.split('@');
      const [lon, lat] = parseLatLon(ll, '--via');
      return { lon, lat, radiusM: Number(r ?? '500') };
    })
    : undefined;

  const log = (m: string): void => console.log(m);
  const pts = [start, end, ...(vias ?? []).map((v) => [v.lon, v.lat] as [number, number])];
  const bbox = bboxFromLonLat(pts.map((p) => p[0]), pts.map((p) => p[1]), 1.0);
  log(`bbox W${bbox.west.toFixed(2)} S${bbox.south.toFixed(2)} E${bbox.east.toFixed(2)} N${bbox.north.toFixed(2)}`);

  let t = Date.now();
  const res = LandMask.chooseResolution(bbox);
  const lm = LandMask.fromShapefiles(land, bbox, { resolutionDeg: res });
  log(`land mask: ${lm.shapes.length} polygons, ${lm.nx}x${lm.ny} cells at ${res}°, ${Date.now() - t} ms`);

  const polar = polarPath ? PolarDiagram.load(polarPath) : null;
  const vessel = makeVessel({ motorSpeedMs: motorKts * 1852 / 3600 });

  let wind;
  if (!flag('no-forecast')) {
    t = Date.now();
    const client = new EcmwfClient({ cacheDir, log: (m) => log(`  ecmwf: ${m}`) });
    wind = await loadForecastForBBox(client, bbox, { horizonHours: hours, log: (m) => log(`  forecast: ${m}`) });
    log(`forecast: ${wind.steps.length} steps, ${(wind.bytes() / 1024).toFixed(0)} kB resident, ${Date.now() - t} ms`);
  }

  const prop = new OceanPropagator(lm, { stages });
  t = Date.now();
  const route = prop.computeRoute({
    start, end, departureTime: departure, vessel, polar, wind, modePolicy: mode, vias,
    onProgress: (s, K, msg) => log(`  [${s}/${K}] ${msg}`),
  });
  log(`route: ${route.waypoints.length} waypoints, ${(route.totalDistanceM / 1852).toFixed(1)} nm, ${(route.totalTimeS / 3600).toFixed(1)} h (sail ${(route.sailingTimeS / 3600).toFixed(1)} h, motor ${(route.motoringTimeS / 3600).toFixed(1)} h), warnings ${route.warnings?.length ?? 0}, ${Date.now() - t} ms`);
  fs.writeFileSync(out, JSON.stringify(routeToGeoJSON(route), null, 1));
  log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
