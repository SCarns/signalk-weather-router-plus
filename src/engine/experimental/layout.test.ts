/**
 * The refined router's layout of a fixed polyline under sail_max (propagator.ts sailPolyline): light-air motoring
 * below a positive threshold is the policy's own and is kept; a course into the no-go angle is tacked, not motored.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearAlongByHalving, type LandTest } from '../../geo/landmask';
import { haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import { NoCurrent, type WindSource } from '../environment';
import { PolarDiagram } from '../../vessel/polar';
import { makeVessel } from '../../vessel/vessel';
import { ConvexPolar } from '../../vessel/convexpolar';
import { ExperimentalPropagator } from './propagator';

const POLAR = PolarDiagram.parse(
  `twa/tws,4,6,8,10,12,14,16,20,25
0,0,0,0,0,0,0,0,0,0
30,1.5,2.5,3.3,4.0,4.3,4.5,4.6,4.7,4.7
45,2.5,3.6,4.5,5.1,5.5,5.7,5.8,5.9,5.9
60,3.0,4.2,5.1,5.7,6.1,6.3,6.4,6.5,6.5
90,3.2,4.5,5.5,6.1,6.5,6.7,6.8,6.9,6.9
120,3.0,4.3,5.3,6.0,6.4,6.7,6.9,7.1,7.2
150,2.4,3.6,4.6,5.4,6.0,6.4,6.7,7.0,7.3
180,2.0,3.0,4.0,4.8,5.5,6.0,6.4,6.8,7.1`,
  ','
);
const VESSEL = makeVessel({ motorSpeedMs: 3 });
const T0 = new Date('2026-01-01T00:00:00Z');
/** Open water everywhere. */
const OPEN: LandTest = {
  isLand: () => false,
  isLandExact: () => false,
  legCrossesLandExact: () => false,
  legsCrossLandBulk: la => new Uint8Array(la.length),
  clearAlong: (lon, lat, b, maxM) => ({ m: maxM, end: projectAlongBearing(lon, lat, b, maxM) }),
};
/** Wind from `dir` at `kn` everywhere. */
function wind(kn: number, dir: number): WindSource {
  const ms = kn * 0.5144444444;
  return {
    hasWaves: false,
    at: () => [ms, dir],
    atMany: lons => ({ speed: new Float64Array(lons.length).fill(ms), dir: new Float64Array(lons.length).fill(dir) }),
    wavesAt: () => null,
  };
}
const lay = (w: WindSource, path: [number, number][], sailThreshMs: number) =>
  new ExperimentalPropagator(OPEN, { stages: 10 }).sailPolyline(path, T0, {
    vessel: VESSEL,
    polar: POLAR,
    wind: w,
    current: new NoCurrent(),
    sim: { modePolicy: 'sail_max', sailThreshMs, simStepM: 200 },
    who: 'test',
    advice: 'none',
  });

test('sailPolyline under sail_max: a light-air reach below the threshold is motored, as the policy says, not refused', () => {
  // Due east with 4 kn from the north: the polar gives about 1.6 m/s on the beam, under a 2.5 m/s threshold.
  const r = lay(
    wind(4, 0),
    [
      [0, 0],
      [0.1, 0],
    ],
    2.5
  );
  assert.ok(r.motoringTimeS > 0, 'motored');
  assert.equal(r.sailingTimeS, 0);
});

test('sailPolyline under sail_max: a course dead into the wind is tacked, not motored, above a positive threshold', () => {
  // Due north into 12 kn from the north: the beat is sailed on two headings with a tack.
  const r = lay(
    wind(12, 0),
    [
      [0, 0],
      [0, 0.1],
    ],
    2.5
  );
  assert.ok(
    r.waypoints.some(w => w.tack),
    'tacked'
  );
  assert.equal(r.motoringTimeS, 0, 'nothing motored');
});

test('sailPolyline under sail only: a beat up a channel narrower than any fixed tack is laid out in short tacks inside it', () => {
  // A channel 150 m wide running north (|x| < 75 m), water nowhere else; 1 km dead into 12 kn from the north.
  const half = 75 / 111320;
  const inside = (lon: number): boolean => Math.abs(lon) < half;
  const channel: LandTest = {
    isLand: lon => !inside(lon),
    isLandExact: lon => !inside(lon),
    // The channel is a strip: a straight move stays in it when both its ends do.
    legCrossesLandExact: (la, _pa, lb) => !inside(la) || !inside(lb),
    legsCrossLandBulk: (la, _pa, lb) => Uint8Array.from({ length: la.length }, (_v, k) => (!inside(la[k]) || !inside(lb[k]) ? 1 : 0)),
    clearAlong: (lon, lat, b, maxM) => clearAlongByHalving(channel, lon, lat, b, maxM, 1),
  };
  const r = new ExperimentalPropagator(channel, { stages: 10 }).sailPolyline(
    [
      [0, 0],
      [0, 0.009],
    ],
    T0,
    {
      vessel: VESSEL,
      polar: POLAR,
      wind: wind(12, 0),
      current: new NoCurrent(),
      sim: { modePolicy: 'sail_max', sailThreshMs: 0, simStepM: 200 },
      who: 'test',
      advice: 'none',
    }
  );
  const tacks = r.waypoints.filter(w => w.tack).length;
  assert.ok(tacks >= 4, `${tacks} tacks`);
  assert.ok(
    r.waypoints.every(w => inside(w.lon)),
    'every waypoint in the channel'
  );
  assert.equal(r.motoringTimeS, 0, 'nothing motored');
  const last = r.waypoints[r.waypoints.length - 1];
  assert.ok(Math.abs(last.lat - 0.009) < 1e-9 && Math.abs(last.lon) < 1e-9, 'ends on the point');
});

test('sailPolyline under sail only: a beat round a right-angle bend in a narrow channel never ends a tack boxed into the bend', () => {
  // An L of water 150 m wide: north 600 m from the origin, then east 600 m along the top; dead upwind both ways
  // means a northeasterly, so both arms are beats. A move is clear when every metre of it is in the L.
  const m = 1 / 111320;
  const inL = (lon: number, lat: number): boolean =>
    (Math.abs(lon) <= 75 * m && lat >= 0 && lat <= 675 * m) || (lat >= 525 * m && lat <= 675 * m && lon >= -75 * m && lon <= 600 * m);
  const clearMove = (la: number, pa: number, lb: number, pb: number): boolean => {
    const n = Math.max(1, Math.ceil(Math.hypot(lb - la, pb - pa) / m));
    for (let k = 0; k <= n; k++) if (!inL(la + ((lb - la) * k) / n, pa + ((pb - pa) * k) / n)) return false;
    return true;
  };
  const bend: LandTest = {
    isLand: (lon, lat) => !inL(lon, lat),
    isLandExact: (lon, lat) => !inL(lon, lat),
    legCrossesLandExact: (la, pa, lb, pb) => !clearMove(la, pa, lb, pb),
    legsCrossLandBulk: (la, pa, lb, pb) =>
      Uint8Array.from({ length: la.length }, (_v, k) => (clearMove(la[k], pa[k], lb[k], pb[k]) ? 0 : 1)),
    clearAlong: (lon, lat, b, maxM) => clearAlongByHalving(bend, lon, lat, b, maxM, 1),
  };
  const r = new ExperimentalPropagator(bend, { stages: 10 }).sailPolyline(
    [
      [0, 0],
      [0, 600 * m],
      [550 * m, 600 * m],
    ],
    T0,
    {
      vessel: VESSEL,
      polar: POLAR,
      wind: wind(12, 45),
      current: new NoCurrent(),
      sim: { modePolicy: 'sail_max', sailThreshMs: 0, simStepM: 200 },
      who: 'test',
      advice: 'none',
    }
  );
  assert.ok(
    r.waypoints.every(w => inL(w.lon, w.lat)),
    'every waypoint in the channel'
  );
  for (let i = 1; i < r.waypoints.length; i++)
    assert.ok(clearMove(r.waypoints[i - 1].lon, r.waypoints[i - 1].lat, r.waypoints[i].lon, r.waypoints[i].lat), `leg ${i} in the channel`);
  const last = r.waypoints[r.waypoints.length - 1];
  assert.ok(Math.abs(last.lat - 600 * m) < 1e-9 && Math.abs(last.lon - 550 * m) < 1e-9, 'ends on the point');
  assert.equal(r.motoringTimeS, 0);
});

test('sailPolyline under sail_max: a beat whose tacks lead into a pocket is motored above a positive threshold, and fails at 0', () => {
  // Water is three lines (no width): the course itself, 1 km north into 12 kn from the north; an arm 100 m up the
  // first tack's heading from the start; and a stub 20 m up the second tack's heading from the arm's end. The first
  // tack runs up the arm (the next heading has room: the stub), the second up the stub, and there neither heading has
  // room and the end cannot be reached straight: a pocket (the Cape Cod Canal's west approach, 2026-10-13).
  const cp = new ConvexPolar(POLAR);
  const ms = 12 * 0.5144444444;
  const mix = cp.mixFor(0, ms)!;
  const [h1, h2] = mix.a1 >= mix.a2 ? [mix.a1, mix.a2] : [mix.a2, mix.a1];
  const B: [number, number] = [0, 0.009];
  const P1 = projectAlongBearing(0, 0, (h1 + 360) % 360, 100);
  const P2 = projectAlongBearing(P1[0], P1[1], (h2 + 360) % 360, 20);
  const segs: [number, number, number, number][] = [
    [0, 0, B[0], B[1]],
    [0, 0, P1[0], P1[1]],
    [P1[0], P1[1], P2[0], P2[1]],
  ];
  const onSeg = (lon: number, lat: number, [ax, ay, bx, by]: [number, number, number, number]): boolean => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((lon - ax) * dx + (lat - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(lon - (ax + t * dx), lat - (ay + t * dy)) < 1e-9;
  };
  const clear = (la: number, pa: number, lb: number, pb: number): boolean => segs.some(g => onSeg(la, pa, g) && onSeg(lb, pb, g));
  const pocket: LandTest = {
    isLand: (lon, lat) => !segs.some(g => onSeg(lon, lat, g)),
    isLandExact: (lon, lat) => !segs.some(g => onSeg(lon, lat, g)),
    legCrossesLandExact: (la, pa, lb, pb) => !clear(la, pa, lb, pb),
    legsCrossLandBulk: (la, pa, lb, pb) => Uint8Array.from({ length: la.length }, (_v, k) => (clear(la[k], pa[k], lb[k], pb[k]) ? 0 : 1)),
    // Exact, as the mesh walk is: along a line of water the room runs to its end; off its direction there is none.
    clearAlong: (lon, lat, b, maxM) => {
      let best = { m: 0, end: [lon, lat] as [number, number] };
      for (const g of segs) {
        if (!onSeg(lon, lat, g)) continue;
        const [ax, ay, bx, by] = g;
        for (const [ex, ey] of [
          [bx, by],
          [ax, ay],
        ]) {
          const d = haversineDistanceM(lon, lat, ex, ey);
          if (!(d > 0) || Math.abs(((haversineBearing(lon, lat, ex, ey) - b + 540) % 360) - 180) > 1e-6) continue;
          const m = Math.min(d, maxM);
          if (m > best.m) best = { m, end: m < d ? projectAlongBearing(lon, lat, b, m) : [ex, ey] };
        }
      }
      return best;
    },
  };
  const run = (sailThreshMs: number) =>
    new ExperimentalPropagator(pocket, { stages: 10 }).sailPolyline([[0, 0], B], T0, {
      vessel: VESSEL,
      polar: POLAR,
      wind: wind(12, 0),
      current: new NoCurrent(),
      sim: { modePolicy: 'sail_max', sailThreshMs, simStepM: 200 },
      who: 'test',
      advice: 'none',
    });
  // Sail-mostly (threshold 2.5 m/s): the whole beat motored straight up the course, as the standard router times it.
  const r = run(2.5);
  assert.deepEqual(
    r.waypoints.map(w => [w.lon, w.lat]),
    [[0, 0], B]
  );
  assert.ok(r.motoringTimeS > 0 && r.sailingTimeS === 0, 'motored');
  // Sail only (threshold 0): no motoring allowed, so it fails as before.
  assert.throws(() => run(0), /cannot be tacked/);
});
