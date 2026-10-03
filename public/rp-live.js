// Live mode's re-plan triggers, without the map or the DOM (rp-plan.js
// wires them to Signal K and the job API; src/plugin/live.test.ts sails
// them along a course). Positions are [lon, lat] in degrees, distances
// metres, speeds m/s, times ms.

export const VESSEL_STALE_MS = 30000;
export const MIN_SOG_MS = 0.25;    // below this COG is noise; gate triggers
export const REPLAN_COOLDOWN_MS = 15000;

// Longitude difference b − a in (−180, 180]: the short way, across the antimeridian.
function _dLon(a, b) { return ((b - a + 540) % 360) - 180; }

export function haversineM(a, b) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Perpendicular distance (m) from point P to the segment A-B.
export function perpendicularM(p, a, b) {
  const cosLat = Math.cos(a[1] * Math.PI / 180);
  const mPerDegLon = 111320 * cosLat;
  const mPerDegLat = 110540;
  const ax = 0, ay = 0;
  const bx = _dLon(a[0], b[0]) * mPerDegLon, by = (b[1] - a[1]) * mPerDegLat;
  const px = _dLon(a[0], p[0]) * mPerDegLon, py = (p[1] - a[1]) * mPerDegLat;
  const segLen2 = bx * bx + by * by;
  if (segLen2 === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / segLen2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * bx, qy = ay + t * by;
  return Math.hypot(px - qx, py - qy);
}

export const viaKey = c => c[0].toFixed(6) + ',' + c[1].toFixed(6);

// Index of the route leg (points[i] → points[i + 1]) nearest the vessel,
// or -1 with fewer than two points. `points`: the route's points in route
// order, [{ lonLat, via }]. The leg, not the nearest point: a waypoint is
// a route point, so near it the waypoint itself is the nearest point.
export function nearestLegIdx(points, vesselLonLat) {
  let nearestIdx = -1, nearestD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = perpendicularM(vesselLonLat, points[i].lonLat, points[i + 1].lonLat);
    if (d < nearestD) { nearestD = d; nearestIdx = i; }
  }
  return nearestIdx;
}

// The user's waypoints (role "via") at the end of the vessel's leg and
// after it, in route order, without the ones in `reached` (viaKey strings).
export function remainingVias(points, vesselLonLat, reached) {
  const legIdx = nearestLegIdx(points, vesselLonLat);
  return points
    .filter((p, i) => i > legIdx && p.via && !(reached && reached.has(viaKey(p.lonLat))))
    .map(p => p.lonLat);
}

// Cross-track distance from the route (min perpendicular distance across
// all legs, flat-earth metres), or null with fewer than two points.
export function xteM(points, lonLat) {
  if (points.length < 2) return null;
  let minD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = perpendicularM(lonLat, points[i].lonLat, points[i + 1].lonLat);
    if (d < minD) minD = d;
  }
  return minD;
}

// The trigger state across polls: the off-course timer, the cooldown and
// the waypoints already reached (each fires once and is then left out of
// later re-plans). check() returns null or the re-plan to start:
// { kind: 'waypoint' | 'off_course', distM, start, vias }: distM the
// proximity radius or the cross-track distance (m; the page words it in
// the user's unit), vias in route order.
export function createLiveTriggers() {
  let xteSustainStart = null;
  let lastReplanAt = -Infinity;
  const reached = new Set();

  function fire(now, vesselLonLat, points, kind, distM) {
    lastReplanAt = now;
    xteSustainStart = null;
    return { kind, distM, start: vesselLonLat, vias: remainingVias(points, vesselLonLat, reached) };
  }

  return {
    reset() { xteSustainStart = null; lastReplanAt = -Infinity; reached.clear(); },
    // snap: { lat, lon, sog_ms, updated_at (s) }; opts: { points, now (ms),
    // blocked (a re-plan running, a proposal open, a route computing),
    // proxM, xteThreshM, xteSustainMs }.
    check(snap, opts) {
      const { points, now, blocked, proxM, xteThreshM, xteSustainMs } = opts;
      if (snap.lat == null || snap.lon == null) return null;
      const age = snap.updated_at ? (now / 1000 - snap.updated_at) : 9999;
      if (age * 1000 > VESSEL_STALE_MS) return null;              // stale data
      if ((snap.sog_ms ?? 0) < MIN_SOG_MS) { xteSustainStart = null; return null; }
      if (blocked) return null;

      const vesselLonLat = [snap.lon, snap.lat];

      // Proximity trigger: within proxM of the next waypoint not yet reached.
      // No cooldown: each waypoint fires once.
      const nextVia = remainingVias(points, vesselLonLat, reached)[0];
      if (nextVia && haversineM(vesselLonLat, nextVia) <= proxM) {
        reached.add(viaKey(nextVia));
        return fire(now, vesselLonLat, points, 'waypoint', proxM);
      }
      if (now - lastReplanAt < REPLAN_COOLDOWN_MS) return null;

      // Cross-track trigger: sustained XTE > threshold.
      const xte = xteM(points, vesselLonLat);
      if (xte != null && xte > xteThreshM) {
        if (xteSustainStart == null) xteSustainStart = now;
        if (now - xteSustainStart >= xteSustainMs) return fire(now, vesselLonLat, points, 'off_course', xte);
      } else {
        xteSustainStart = null;
      }
      return null;
    },
  };
}

// Initial great-circle bearing a → b, degrees true in [0, 360).
export function bearingDeg(a, b) {
  const toRad = x => x * Math.PI / 180;
  const la1 = toRad(a[1]), la2 = toRad(b[1]), dl = toRad(_dLon(a[0], b[0]));
  const y = Math.sin(dl) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360;
}

// A simulated boat for trying Live mode ashore (SIMULATE). It replays the
// route's own timeline (each point's `time`, ms: the speeds the route was
// computed with for the selected vessel) `factor` times faster than real
// time from wall time `t0`, and stops at the last point. at(now, pushDeg)
// is a Signal K-like snapshot plus `route_time` (ms). With pushDeg (degrees,
// positive to starboard, negative to port) the boat steers that far off the
// route's course and drifts away from it at its speed × sin(pushDeg), more
// the longer it stays pushed; pushDeg 0 puts it back on the route. A
// waypoint passed since the previous snapshot is returned first, and so are
// the moment the drift crosses `thresholdM` and the moment `sustainMs`
// (route time) later, so the triggers see each at any factor.
// setFactor(now, f) changes the factor without moving the boat (0 holds it:
// Stop, or a pause for a re-plan; held, its speed reads 0); rewind(now)
// puts it back at the route's start.
export function createRouteSimulator(points, factor, t0) {
  const times = points.map(p => p.time);
  if (points.length < 2 || times.some(t => !Number.isFinite(t))) throw new Error('the route has no point times');
  const start = times[0], end = times[times.length - 1];
  const viaTimes = points.filter(p => p.via).map(p => p.time);
  let base = start, wall0 = t0;   // route time `base` at wall time `wall0`
  let shown = start;              // route time of the previous snapshot
  let offsetM = 0;                // distance off the route, m (positive = starboard)
  let crossAt = null;             // route time the drift crossed the off-course threshold
  const routeTime = now => Math.min(end, Math.max(start, base + (now - wall0) * factor));
  // The route's speed on the leg sailed at route time t, m/s.
  const legSog = t => {
    let i = 0;
    while (i < points.length - 2 && times[i + 1] <= t) i++;
    const dt = times[i + 1] - times[i];
    return t >= end || dt <= 0 ? 0 : haversineM(points[i].lonLat, points[i + 1].lonLat) / (dt / 1000);
  };
  return {
    points,
    get factor() { return factor; },
    setFactor(now, f) { base = routeTime(now); wall0 = now; factor = f; },
    rewind(now) { base = start; wall0 = now; shown = start; offsetM = 0; crossAt = null; },
    // Hold at route time tau (a snapshot already returned): a re-plan starts
    // from that position, so the boat must not sail on until it is decided.
    holdAt(tau, now) { base = Math.min(end, Math.max(start, tau)); wall0 = now; factor = 0; },
    at(now, pushDeg = 0, { thresholdM = Infinity, sustainMs = 0 } = {}) {
      let tau = routeTime(now);
      const stops = [];
      const v = viaTimes.find(t => t > shown && t < tau);
      if (v !== undefined) stops.push(v);
      const rate = pushDeg ? legSog(shown) * Math.sin(pushDeg * Math.PI / 180) : 0;   // m/s off the route
      if (rate) {
        // When the drift reaches just past the threshold on the side it is
        // going; only before it has crossed (after, the remainder is rounding
        // and stopping on it again would hold the boat there for good).
        const target = thresholdM + 1;
        const toGo = rate > 0 ? target - offsetM : target + offsetM;
        if (crossAt === null && Number.isFinite(toGo) && toGo > 0) {
          const tc = shown + (toGo / Math.abs(rate)) * 1000;
          if (tc < tau) stops.push(tc);
        }
        if (crossAt !== null) {
          const ts = crossAt + sustainMs + 1;
          if (ts > shown && ts < tau) stops.push(ts);
        }
      }
      if (stops.length) tau = Math.min(...stops);
      let i = 0;
      while (i < points.length - 2 && times[i + 1] <= tau) i++;
      const a = points[i].lonLat, b = points[i + 1].lonLat;
      const dt = times[i + 1] - times[i];
      const sog = tau >= end || dt <= 0 ? 0 : haversineM(a, b) / (dt / 1000);
      // Drift since the previous snapshot at the pushed angle; back on the route when not pushed.
      offsetM = pushDeg ? offsetM + rate * ((tau - shown) / 1000) : 0;
      if (Math.abs(offsetM) > thresholdM) {
        if (crossAt === null) crossAt = tau;
      } else crossAt = null;
      shown = tau;
      const f = dt > 0 ? Math.min(1, (tau - times[i]) / dt) : 1;
      const cog = bearingDeg(a, b);
      // Along the leg (flat earth over one leg), then offsetM to starboard.
      const cosLat = Math.cos(a[1] * Math.PI / 180);
      const s = (cog + 90) * Math.PI / 180;
      let lon = a[0] + _dLon(a[0], b[0]) * f + offsetM * Math.sin(s) / (111320 * cosLat);
      const lat = a[1] + (b[1] - a[1]) * f + offsetM * Math.cos(s) / 110540;
      lon = ((lon + 540) % 360) - 180;
      const heading = (((cog + pushDeg) % 360) + 360) % 360;
      return {
        lat, lon,
        // The leg's speed on the route, not multiplied by the factor; 0 while held.
        sog_ms: factor ? sog : 0,
        cog_deg: heading,
        heading_deg: heading,
        twa_deg: null, tws_ms: null,
        updated_at: now / 1000,
        route_time: tau,
      };
    },
  };
}

// The sailed track, thinned as it is recorded: a point is kept where the
// line from the last kept point to the boat would pass more than
// `epsilonM` from a position in between (streaming Douglas-Peucker), so a
// straight run is one segment and every turn keeps its corner. points()
// is the kept points plus the boat's latest position.
export function createTrackRecorder(epsilonM = 20, maxBuffer = 500) {
  const kept = [];
  let buf = [];     // positions since the last kept point
  return {
    add(lonLat) {
      if (!kept.length) { kept.push(lonLat); return; }
      const a = kept[kept.length - 1];
      if (buf.length >= maxBuffer || buf.some(p => perpendicularM(p, a, lonLat) > epsilonM)) {
        kept.push(buf[buf.length - 1]);
        buf = [];
      }
      buf.push(lonLat);
    },
    points() { return buf.length ? kept.concat([buf[buf.length - 1]]) : kept.slice(); },
    get keptCount() { return kept.length; },
  };
}
