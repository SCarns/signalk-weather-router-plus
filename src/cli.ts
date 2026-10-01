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
 * Waypoints: `--via "lat,lon[@radius_m];lat,lon"`; each waypoint ends one
 * leg and starts the next. `--precision precise|approximate` (default
 * precise: each leg ends exactly on its waypoint; approximate: one search
 * through the waypoint circles), `--radius <m>` the circle (default 200; @radius overrides
 * it per waypoint).
 * The corridor comes from the global water grid (data/water-grid-0.02.bin.gz
 * by default; `--water-grid <file>` for another, `--no-water-grid` for the
 * old per-route skeleton); `--allow-canals` opens known canals.
 */

import * as fs from 'node:fs';
import { NM_M, KTS_TO_MS, HOUR_S, HOUR_MS } from './geo/units';
import { loadForecastForBBox, resolveCycle } from './data/loader';
import { EcmwfClient, ECMWF_MIRRORS } from './data/ecmwf';
import { bboxFromLonLat } from './geo/geodesy';
import { LandMask } from './geo/landmask';
import { OceanPropagator } from './engine/propagator';
import { legLabel, routeMultiLeg, validateLegOptions, type LegPlan, type Precision, type Stop } from './engine/multileg';
import { CorridorError, mergeVias, planCorridor, type Corridor } from './engine/corridor';
import { WaterGrid } from './geo/watergrid';
import { chooseWaterGrid } from './geo/watergrid_store';
import { routeToGeoJSON, type Route } from './engine/route';
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
  if (parts.length !== 2 || parts.some(v => !Number.isFinite(v))) throw new Error(`${what}: expected lat,lon (got "${s}")`);
  return [parts[1], parts[0]];
}

async function main(): Promise<void> {
  const start = parseLatLon(arg('start') ?? '', '--start');
  const end = parseLatLon(arg('end') ?? '', '--end');
  const landArg = arg('land');
  if (!landArg) throw new Error('--land <shapefile>[,<shapefile>...] is required');
  const land = landArg.split(',');
  const polarPath = arg('polar');
  const mode = arg('mode', 'sail_max') as ModePolicy;
  const hours = Number(arg('hours', '72'));
  const departure = new Date(arg('departure') ?? Date.now());
  const out = arg('o', 'route.geojson')!;
  const cacheDir = arg('cache', './ecmwf-cache')!;
  const stages = Number(arg('stages', '20'));
  const motorKts = Number(arg('motor-kts', '6'));
  const viasArg = arg('via');
  const vias: Stop[] | undefined = viasArg
    ? viasArg.split(';').map(v => {
        const [ll, r] = v.split('@');
        const [lon, lat] = parseLatLon(ll, '--via');
        return r !== undefined ? { lon, lat, radiusM: Number(r) } : { lon, lat };
      })
    : undefined;

  const log = (m: string): void => console.log(m);
  const tAll = Date.now();
  const precisionArg = arg('precision', 'precise');
  if (precisionArg !== 'precise' && precisionArg !== 'approximate') throw new Error('--precision must be precise or approximate');
  const precision: Precision = precisionArg;
  const radiusArg = arg('radius');
  const arrivalRadiusM = radiusArg !== undefined ? Number(radiusArg) : undefined;
  const legErr = validateLegOptions(
    precision,
    arrivalRadiusM,
    (vias ?? []).map(v => ({ radius_m: v.radiusM }))
  );
  if (legErr) throw new Error(legErr);
  const stops: Stop[] = [{ lon: start[0], lat: start[1] }, ...(vias ?? []), { lon: end[0], lat: end[1] }];
  const multi = stops.length > 2;
  let t = Date.now();
  let grid: WaterGrid | null = null;
  if (!flag('no-water-grid')) {
    const gridArg = arg('water-grid');
    if (gridArg) {
      grid = WaterGrid.load(gridArg);
      log(`water grid: ${gridArg}, built ${grid.header.builtAt} from ${grid.header.sources.map(s => s.name).join(', ')}`);
    } else {
      const choice = chooseWaterGrid(land, null);
      grid = choice.grid;
      for (const n of choice.notes) log(`water grid: ${n}`);
      if (!grid) log('water grid: none available; using the per-route skeleton (build one with npm run build:water-grid)');
    }
    if (grid) {
      grid.setCanalsAllowed(flag('allow-canals'));
      log(
        `water grid: loaded in ${Date.now() - t} ms, ${(grid.bytes() / 1e6).toFixed(1)} MB resident, canals ${flag('allow-canals') ? 'allowed' : 'blocked'}`
      );
    }
  }
  const landFor = (b: ReturnType<typeof bboxFromLonLat>): LandMask => {
    const t1 = Date.now();
    const r = LandMask.chooseResolution(b);
    const m = LandMask.fromShapefiles(land, b, { resolutionDeg: r });
    log(
      `land mask: box W${b.west.toFixed(2)} S${b.south.toFixed(2)} E${b.east.toFixed(2)} N${b.north.toFixed(2)}, ${m.shapes.length} polygons, ${m.nx}x${m.ny} cells at ${r}°, ${Date.now() - t1} ms`
    );
    return m;
  };

  const polar = polarPath ? PolarDiagram.load(polarPath) : null;
  const vessel = makeVessel({ motorSpeedMs: motorKts * KTS_TO_MS });
  const client = flag('no-forecast')
    ? null
    : new EcmwfClient({
        cacheDir,
        baseUrl: arg('mirror') ? (ECMWF_MIRRORS[arg('mirror')!] ?? arg('mirror')) : undefined,
        log: m => log(`  ecmwf: ${m}`),
      });
  const cycle = client ? (await resolveCycle(client, hours * HOUR_S, { log: m => log(`  forecast: ${m}`) })).cycle : null;
  let cycleLabel: string | undefined;

  // Waypoints are leg ends (engine/multileg.ts); each leg is its own route.
  const runLeg = async (plan: LegPlan, legStart: [number, number], legDeparture: Date): Promise<Route> => {
    const tag = multi ? `${legLabel(plan)} ` : '';
    // A collapsed approximate run passes through its waypoint circles (plan.vias).
    const chain: [number, number][] = [legStart, ...plan.vias.map(v => [v.lon, v.lat] as [number, number]), plan.end];
    let corridor: Corridor | null = null;
    if (grid) {
      t = Date.now();
      try {
        corridor = planCorridor(grid, chain, { landFor, stages, onProgress: m => log(`  ${tag}corridor: ${m}`) });
        const st = corridor.stats;
        log(
          `${tag}corridor: ${(corridor.lengthM / 1000).toFixed(1)} km, A* ${st.astarMs} ms (${st.expanded} cells expanded, window ≤ ${st.windowCells} cells), verify ${st.verifyMs} ms, ${st.refines} refinement(s), ${st.reroutes} re-route(s), total ${Date.now() - t} ms`
        );
        for (const v of corridor.autoVias)
          log(
            `${tag}corridor: auto via at ${v.name}, width ${(v.widthM / 1000).toFixed(1)} km (${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}, radius ${(v.radiusM / 1000).toFixed(1)} km)`
          );
      } catch (err) {
        if (!(err instanceof CorridorError) || err.fatal) throw err;
        log(`WARNING: ${tag}corridor failed (${err.message}); falling back to the per-route skeleton`);
        corridor = null;
      }
    }
    let lm: LandMask;
    let bbox;
    if (corridor) {
      lm = corridor.land;
      bbox = corridor.bbox;
    } else {
      bbox = bboxFromLonLat(
        chain.map(p => p[0]),
        chain.map(p => p[1]),
        1.0
      );
      lm = landFor(bbox);
    }
    log(`${tag}bbox W${bbox.west.toFixed(2)} S${bbox.south.toFixed(2)} E${bbox.east.toFixed(2)} N${bbox.north.toFixed(2)}`);

    let wind;
    if (client && cycle) {
      t = Date.now();
      wind = await loadForecastForBBox(client, bbox, { horizonS: hours * HOUR_S, cycle, log: m => log(`  forecast: ${m}`) });
      log(`${tag}forecast: ${wind.steps.length} steps, ${(wind.bytes() / 1024).toFixed(0)} kB resident, ${Date.now() - t} ms`);
      cycleLabel = wind.meta.cycleTime.toISOString();
    }

    const prop = new OceanPropagator(lm, { stages });
    const vias = corridor ? mergeVias(plan.vias, corridor.autoVias) : plan.vias;
    const r = prop.computeRoute({
      start: legStart,
      end: plan.end,
      departureTime: legDeparture,
      vessel,
      polar,
      wind,
      modePolicy: mode,
      vias: vias.length ? vias : undefined,
      corridor: corridor ? { skeleton: corridor.skeleton, widthM: corridor.widthM } : undefined,
      arrivalRadiusM: plan.arrivalRadiusM,
      snapToExact: plan.snapToExact,
      onProgress: (s, K, msg) => log(`  ${tag}[${s}/${K}] ${msg}`),
    });
    if (wind) {
      const lastValid = wind.validRange[1].getTime();
      const arrival = r.waypoints[r.waypoints.length - 1].time.getTime();
      if (arrival > lastValid) {
        r.forecastHorizonExceededS = (arrival - lastValid) / 1000;
        log(
          `WARNING: ${tag}arrival is ${((arrival - lastValid) / HOUR_MS).toFixed(1)} h after the last forecast step; conditions beyond it are held constant`
        );
      }
    }
    return r;
  };
  const routeT0 = Date.now();
  const route = await routeMultiLeg({ stops, departureTime: departure, precision, arrivalRadiusM, runLeg, onProgress: log });
  if (cycleLabel) route.forecastCycle = cycleLabel;
  log(
    `route: ${route.waypoints.length} waypoints, ${(route.totalDistanceM / NM_M).toFixed(1)} nm, ${(route.totalTimeS / HOUR_S).toFixed(1)} h (sail ${(route.sailingTimeS / HOUR_S).toFixed(1)} h, motor ${(route.motoringTimeS / HOUR_S).toFixed(1)} h), warnings ${route.warnings?.length ?? 0}, ${Date.now() - routeT0} ms`
  );
  fs.writeFileSync(out, JSON.stringify(routeToGeoJSON(route), null, 1));
  log(`wrote ${out}; total ${((Date.now() - tAll) / 1000).toFixed(1)} s`);
}

main().catch(err => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
