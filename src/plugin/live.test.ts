// Live mode's re-plan triggers (public/rp-live.js), sailed along a long
// course: a vessel polled every 5 s along a 60-point route, as the web
// app's Signal K poll feeds them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveTriggers,
  createRouteSimulator,
  haversineM,
  MIN_SOG_MS,
  REPLAN_COOLDOWN_MS,
  viaKey,
  xteM,
} from '../../public/rp-live.js';

type LonLat = [number, number];
interface RoutePoint {
  lonLat: LonLat;
  via: boolean;
  /** The route's time at the point, ms (the boat at SPEED_MS from T0). */
  time: number;
}
interface Replan {
  kind: 'waypoint' | 'off_course';
  distM: number;
  start: LonLat;
  vias: LonLat[];
}

const POLL_MS = 5000;
const SPEED_MS = 3; // about 5.8 kn
const OPTS = { proxM: 200, xteThreshM: 500, xteSustainMs: 30_000 };
const T0 = Date.parse('2026-10-03T00:00:00Z');

/**
 * A zigzag course of `n` points from `start`, legs of `legM` metres on
 * alternating headings round `bearingDeg`, with the user's waypoints at
 * `viaIdx`, timed for a boat at SPEED_MS from T0. Flat-earth steps; fine
 * for legs of a few km.
 */
function course(start: LonLat, n: number, legM: number, bearingDeg: number, viaIdx: number[]): RoutePoint[] {
  const pts: RoutePoint[] = [];
  let [lon, lat] = start;
  for (let i = 0; i < n; i++) {
    const here: LonLat = [lon > 180 ? lon - 360 : lon, lat];
    const time = i === 0 ? T0 : pts[i - 1].time + (haversineM(pts[i - 1].lonLat, here) / SPEED_MS) * 1000;
    pts.push({ lonLat: here, via: viaIdx.includes(i), time });
    const b = ((bearingDeg + (i % 2 ? 25 : -25)) * Math.PI) / 180;
    lat += (legM * Math.cos(b)) / 110540;
    lon += (legM * Math.sin(b)) / (111320 * Math.cos((lat * Math.PI) / 180));
  }
  return pts;
}

/**
 * Sail the course at SPEED_MS, one poll every POLL_MS, `offsetM(i, t)`
 * metres to starboard of the track; returns every re-plan the triggers
 * asked for, with its poll time. `blocked(t)` stands for a re-plan running
 * or a proposal open.
 */
function sail(
  pts: RoutePoint[],
  offsetM: (t: number) => number = () => 0,
  blocked: (t: number) => boolean = () => false
): { at: number; r: Replan }[] {
  const triggers = createLiveTriggers();
  const out: { at: number; r: Replan }[] = [];
  let t = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i].lonLat;
    const b = pts[i + 1].lonLat;
    const legM = haversineM(a, b);
    let dLon = b[0] - a[0];
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    // Unit vector to starboard of the leg, in degrees per metre.
    const cosLat = Math.cos((a[1] * Math.PI) / 180);
    const ex = dLon * 111320 * cosLat;
    const ey = (b[1] - a[1]) * 110540;
    const len = Math.hypot(ex, ey);
    const sx = ey / len / (111320 * cosLat);
    const sy = -ex / len / 110540;
    for (let s = 0; s < legM; s += SPEED_MS * (POLL_MS / 1000)) {
      const f = s / legM;
      const off = offsetM(t);
      let lon = a[0] + dLon * f + sx * off;
      if (lon > 180) lon -= 360;
      else if (lon < -180) lon += 360;
      const lat = a[1] + (b[1] - a[1]) * f + sy * off;
      const r = triggers.check(
        { lat, lon, sog_ms: SPEED_MS, updated_at: t / 1000 },
        { points: pts, now: t, blocked: blocked(t), ...OPTS }
      ) as Replan | null;
      if (r) out.push({ at: t, r });
      t += POLL_MS;
    }
  }
  return out;
}

const VIAS = [12, 25, 38, 51];
// 60 points, 59 legs of 9 km: about 530 km (290 nm) east-north-east off New England.
const LONG = course([-69.5, 41.0], 60, 9000, 70, VIAS);

test('a long course on track: each waypoint fires once, in order, and nothing goes off course', () => {
  const fired = sail(LONG);
  assert.equal(fired.length, VIAS.length, fired.map(f => f.r.kind).join('; '));
  fired.forEach((f, k) => {
    assert.equal(f.r.kind, 'waypoint');
    assert.equal(f.r.distM, OPTS.proxM);
    // The waypoint it fired for is the k-th, and is within 200 m of the boat.
    assert.ok(haversineM(f.r.start, LONG[VIAS[k]].lonLat) <= OPTS.proxM);
    // The re-plan goes through the waypoints after it, in route order.
    assert.deepEqual(
      f.r.vias.map(viaKey),
      VIAS.slice(k + 1).map(i => viaKey(LONG[i].lonLat))
    );
  });
});

test('a long course with the points in route order beyond the 9 the map keeps in order', () => {
  // The map's spatial index returned route points out of order from 10
  // points on; the triggers take the route's own order. 60 points here.
  assert.ok(LONG.length > 9);
  const fired = sail(LONG);
  const firedAt = fired.map(f => VIAS.findIndex(i => haversineM(f.r.start, LONG[i].lonLat) <= OPTS.proxM));
  assert.deepEqual(firedAt, [0, 1, 2, 3]);
});

test('off course for a stretch: one re-plan once the sustain time has passed, none on track', () => {
  // 1 km to starboard between 10¼ h and 12¼ h, on track otherwise. Legs
  // take about 50 min, so 10¼ h is mid-leg: at a corner a point 1 km off
  // one leg can be within 500 m of the next.
  const from = 10.25 * 3600e3;
  const to = 12.25 * 3600e3;
  const fired = sail(LONG, t => (t >= from && t < to ? 1000 : 0));
  const off = fired.filter(f => f.r.kind === 'off_course');
  assert.ok(off.length >= 1, 'fires while off course');
  // The first one exactly after the sustain time (polls are 5 s apart).
  assert.equal(off[0].at, from + OPTS.xteSustainMs);
  // Every off-course re-plan falls inside the off-course stretch, at least
  // the sustain time apart (the timer restarts after each).
  for (const f of off) assert.ok(f.at >= from && f.at < to, `at ${f.at}`);
  for (let k = 1; k < off.length; k++) assert.ok(off[k].at - off[k - 1].at >= Math.max(OPTS.xteSustainMs, REPLAN_COOLDOWN_MS));
  // The re-plan sends the waypoints still ahead of the boat, in order.
  const ahead = off[0].r.vias.map(viaKey);
  const allVias = VIAS.map(i => viaKey(LONG[i].lonLat));
  assert.deepEqual(ahead, allVias.slice(allVias.length - ahead.length));
});

test('nothing fires while a re-plan runs or a proposal is open, and a waypoint passed then is not fired late', () => {
  const t12 = sail(LONG).find(f => f.r.kind === 'waypoint')!.at;
  // Blocked for 30 min round the first waypoint.
  const fired = sail(
    LONG,
    () => 0,
    t => t > t12 - 15 * 60e3 && t < t12 + 15 * 60e3
  );
  for (const f of fired) assert.ok(!(f.at > t12 - 15 * 60e3 && f.at < t12 + 15 * 60e3));
  assert.equal(fired.length, VIAS.length - 1, 'the first waypoint went by while blocked');
  assert.ok(haversineM(fired[0].r.start, LONG[VIAS[1]].lonLat) <= OPTS.proxM);
});

test('stopped or slow: no triggers below the minimum speed', () => {
  const triggers = createLiveTriggers();
  const at = LONG[VIAS[0]].lonLat;
  const r = triggers.check(
    { lat: at[1], lon: at[0], sog_ms: MIN_SOG_MS / 2, updated_at: 1 },
    { points: LONG, now: 1000, blocked: false, ...OPTS }
  );
  assert.equal(r, null);
});

test('a long course across the antimeridian on track: waypoints in order, nothing off course', () => {
  // From 178° E heading east into the western hemisphere.
  const pts = course([178.0, -17.0], 60, 9000, 80, VIAS);
  assert.ok(pts.some(p => p.lonLat[0] < 0) && pts.some(p => p.lonLat[0] > 0), 'crosses 180°');
  const fired = sail(pts);
  assert.deepEqual(
    fired.map(f => f.r.kind),
    VIAS.map(() => 'waypoint')
  );
});

// The simulated boat behind SIMULATE: the route's own timeline, sped up.
const FACTOR = 600;
const routeEndWall = (pts: RoutePoint[]): number => (pts[pts.length - 1].time - pts[0].time) / FACTOR;

test('simulator: replays the route timeline sped up, at the route speeds, and stops at the last point', () => {
  const sim = createRouteSimulator(LONG, FACTOR, 0);
  const at0 = sim.at(0);
  assert.ok(haversineM([at0.lon, at0.lat], LONG[0].lonLat) < 1);
  assert.equal(at0.route_time, T0);
  // 100 s of wall time at ×600: 60 000 s of route time, 180 km along at 3 m/s.
  // Waypoint 1 (108 km) is passed on the way: the simulator stops on it first.
  const stop = sim.at(100e3);
  assert.equal(stop.route_time, LONG[VIAS[0]].time);
  const p = sim.at(100e3);
  assert.equal(p.route_time, T0 + 60_000e3);
  assert.ok((xteM(LONG, [p.lon, p.lat]) as number) < 5, 'on the track');
  // The speed shown is the route's (the vessel's), not multiplied.
  assert.ok(Math.abs(p.sog_ms - SPEED_MS) < 1e-6, `sog ${p.sog_ms}`);
  // Past the end: first a stop on each of the 3 waypoints left, then the last point.
  for (const k of [1, 2, 3]) assert.equal(sim.at(routeEndWall(LONG) + 60e3).route_time, LONG[VIAS[k]].time);
  const end = sim.at(routeEndWall(LONG) + 60e3);
  assert.ok(haversineM([end.lon, end.lat], LONG[LONG.length - 1].lonLat) < 1);
  assert.equal(end.sog_ms, 0);
});

test('simulator: pushed off course by an angle, the boat drifts off at speed × sin(angle); released, it is back on the route', () => {
  // Factor 1, first leg (course 45°, 3 m/s, about 3000 s long).
  const sim = createRouteSimulator(LONG, 1, 0);
  const on = sim.at(500e3);
  assert.ok((xteM(LONG, [on.lon, on.lat]) as number) < 1);
  // 1000 s pushed 20° to starboard: 3 m/s × sin 20° × 1000 s off, heading 65°.
  const off = sim.at(1500e3, 20);
  const want = SPEED_MS * Math.sin((20 * Math.PI) / 180) * 1000;
  assert.ok(Math.abs((xteM(LONG, [off.lon, off.lat]) as number) - want) < 0.02 * want, `xte ${xteM(LONG, [off.lon, off.lat])} vs ${want}`);
  assert.ok(Math.abs(off.cog_deg - 65) < 0.5, `heading ${off.cog_deg}`);
  const track = createRouteSimulator(LONG, 1, 0).at(1500e3);
  assert.ok(off.lat < track.lat && off.lon > track.lon, 'starboard of a course of 45° is south-east');
  // Released: back on the route.
  const back = sim.at(1600e3);
  assert.ok((xteM(LONG, [back.lon, back.lat]) as number) < 1);
});

test('simulator: a negative push angle drifts to port', () => {
  const sim = createRouteSimulator(LONG, 1, 0);
  sim.at(500e3);
  const off = sim.at(1500e3, -20);
  const track = createRouteSimulator(LONG, 1, 0).at(1500e3);
  assert.ok(off.lat > track.lat && off.lon < track.lon, 'port of a course of 45° is north-west');
  assert.ok(Math.abs(off.cog_deg - 25) < 0.5, `heading ${off.cog_deg}`);
});

test('simulator across the antimeridian: longitudes stay in [-180, 180] and on the track', () => {
  const pts = course([178.0, -17.0], 60, 9000, 80, VIAS);
  const sim = createRouteSimulator(pts, FACTOR, 0);
  for (let t = 0; t < routeEndWall(pts); t += 1000) {
    const p = sim.at(t);
    assert.ok(p.lon >= -180 && p.lon <= 180, `lon ${p.lon}`);
    assert.ok((xteM(pts, [p.lon, p.lat]) as number) < 5, `on track at ${t}`);
  }
});

for (const factor of [60, 600, 3600]) {
  test(`simulator into the triggers at ×${factor}, as the page wires them (1 s updates): every waypoint once, in order`, () => {
    // At ×600 the boat moves 1.8 km between updates, ×3600 10.8 km: far past
    // the 200 m radius, so the simulator stops on each waypoint once.
    const sim = createRouteSimulator(LONG, factor, 0);
    const triggers = createLiveTriggers();
    const fired: LonLat[] = [];
    const endWall = (LONG[LONG.length - 1].time - T0) / factor;
    for (let t = 0; t <= endWall + 2000; t += 1000) {
      const r = triggers.check(sim.at(t), { points: LONG, now: t, blocked: false, ...OPTS }) as Replan | null;
      if (r) {
        assert.equal(r.kind, 'waypoint');
        fired.push(r.start);
      }
    }
    assert.equal(fired.length, VIAS.length);
    fired.forEach((at, k) => assert.ok(haversineM(at, LONG[VIAS[k]].lonLat) <= OPTS.proxM, `waypoint ${k}`));
  });
}

test('simulator: a factor change keeps the boat where it is and goes on at the new factor', () => {
  const sim = createRouteSimulator(LONG, 600, 0);
  const before = sim.at(10e3);
  sim.setFactor(10e3, 60);
  const same = sim.at(10e3);
  assert.equal(same.route_time, before.route_time);
  assert.ok(haversineM([before.lon, before.lat], [same.lon, same.lat]) < 0.01);
  assert.equal(sim.at(20e3).route_time, before.route_time + 10e3 * 60);
});

test('simulator: a route without point times is refused', () => {
  assert.throws(
    () =>
      createRouteSimulator(
        LONG.map(p => ({ ...p, time: NaN })),
        600,
        0
      ),
    /no point times/
  );
});

test('simulator: factor 0 holds the boat (the page pauses it for a re-plan), then it sails on', () => {
  const sim = createRouteSimulator(LONG, 600, 0);
  const before = sim.at(10e3);
  sim.setFactor(10e3, 0);
  assert.equal(sim.at(70e3).route_time, before.route_time);
  sim.setFactor(70e3, 600);
  assert.equal(sim.at(80e3).route_time, before.route_time + 10e3 * 600);
});

for (const factor of [60, 600, 3600]) {
  for (const push of [20, -43]) {
    test(`simulator pushed ${push}° at ×${factor} (1 s updates, triggers on the simulated clock): off course just past the threshold`, () => {
      // The boat drifts off at SPEED_MS × sin(push); the re-plan must come once
      // it has been past the threshold for the sustain time, not hundreds of
      // km later because an update moved it far (brain 2026-10-03: 362 km at ×3500).
      const sim = createRouteSimulator(LONG, factor, 0);
      const triggers = createLiveTriggers();
      const opts = { thresholdM: OPTS.xteThreshM, sustainMs: OPTS.xteSustainMs };
      let first: Replan | null = null;
      for (let t = 0; t < 600e3 && !first; t += 1000) {
        const snap = sim.at(t, push, opts);
        const r = triggers.check(
          { ...snap, updated_at: snap.route_time / 1000 },
          { points: LONG, now: snap.route_time, blocked: false, ...OPTS }
        ) as Replan | null;
        if (r && r.kind === 'off_course') first = r;
      }
      assert.ok(first, 'an off-course re-plan fired');
      const drift = SPEED_MS * Math.abs(Math.sin((push * Math.PI) / 180)) * (OPTS.xteSustainMs / 1000);
      assert.ok(first.distM > OPTS.xteThreshM, `fired at ${first.distM} m, past the ${OPTS.xteThreshM} m threshold`);
      assert.ok(first.distM <= OPTS.xteThreshM + drift + 5, `fired at ${first.distM} m, at most ${OPTS.xteThreshM + drift} m`);
    });
  }
}

test('simulator: pushed off course, the boat never stops moving (no repeated stop at the threshold)', () => {
  // brain 2026-10-03: pushed -43° the clock froze where the drift crossed
  // the threshold (a rounding remainder rescheduled the same stop forever).
  for (const thresholdM of [100, 150, 333, 500, 1000]) {
    for (const push of [-90, -43, -20, 7, 20, 43, 90]) {
      for (const factor of [60, 600, 3600]) {
        const sim = createRouteSimulator(LONG, factor, 0);
        const opts = { thresholdM, sustainMs: OPTS.xteSustainMs };
        let prev = sim.at(0, 0, opts).route_time;
        let still = 0;
        for (let t = 1000; t <= 40e3; t += 1000) {
          const rt = sim.at(t, push, opts).route_time;
          still = rt > prev ? 0 : still + 1;
          assert.ok(still < 3, `stuck at ${rt} (threshold ${thresholdM} m, push ${push}°, ×${factor})`);
          prev = rt;
        }
      }
    }
  }
});
