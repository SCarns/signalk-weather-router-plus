/**
 * Wind, waves and current at each waypoint's position and time.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { norm360 } from '../../geo/angles';
import { haversineBearing, haversineDistanceM, projectAlongBearing } from '../../geo/geodesy';
import { HOUR_S } from '../../geo/units';
import type { CurrentSource, WindSource } from '../environment';
import type { Route, Waypoint } from '../route';

/** Wind, waves and current at each waypoint's position and time. */
export function enrichWaypoints(wps: Waypoint[], wind: WindSource, current: CurrentSource): void {
  for (const wp of wps) {
    const [ws, wd] = wind.at(wp.lon, wp.lat, wp.time);
    if (Number.isFinite(ws)) {
      wp.windMs = ws;
      wp.windDirDeg = wd;
    }
    if (wind.hasWaves) {
      const wv = wind.wavesAt(wp.lon, wp.lat, wp.time);
      if (wv) {
        wp.swhM = wv.swh;
        wp.mwpS = wv.mwp;
        wp.mwdDeg = wv.mwd;
      }
    }
    const [cu, cv] = current.at(wp.lon, wp.lat, wp.time);
    if (Number.isFinite(cu) && Number.isFinite(cv)) {
      wp.currentUMs = cu;
      wp.currentVMs = cv;
      const sp = Math.hypot(cu, cv);
      wp.currentMs = sp;
      if (sp > 1e-9) wp.currentDirDeg = norm360(90 - (Math.atan2(cv, cu) * 180) / Math.PI);
    }
  }
}

/**
 * Wind and wave range along each leg, on the waypoint the leg departs
 * from: the leg is sampled about once per hour (both ends included, at
 * most 25 samples) along its constant-bearing line with each sample at
 * its own clock, and the extremes recorded. The shortcut smoother can
 * merge many hours into one leg, and a single end-of-leg sample then
 * reads as the whole leg's conditions; the range is what a briefing
 * card should show beside it.
 */
export function enrichLegRanges(route: Route, wind: WindSource): void {
  const wps = route.waypoints;
  for (let k = 0; k + 1 < wps.length; k++) {
    const a = wps[k];
    const b = wps[k + 1];
    const dtS = (b.time.getTime() - a.time.getTime()) / 1000;
    if (dtS <= 0) continue;
    const distM = haversineDistanceM(a.lon, a.lat, b.lon, b.lat);
    const bearing = distM > 0 ? haversineBearing(a.lon, a.lat, b.lon, b.lat) : 0;
    const n = Math.min(24, Math.max(1, Math.round(dtS / HOUR_S)));
    let wMin = Infinity;
    let wMax = -Infinity;
    let sMin = Infinity;
    let sMax = -Infinity;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const [lon, lat] = distM > 0 ? projectAlongBearing(a.lon, a.lat, bearing, distM * f) : [a.lon, a.lat];
      const time = new Date(a.time.getTime() + dtS * f * 1000);
      const [ws] = wind.at(lon, lat, time);
      if (Number.isFinite(ws)) {
        if (ws < wMin) wMin = ws;
        if (ws > wMax) wMax = ws;
      }
      if (wind.hasWaves) {
        const wv = wind.wavesAt(lon, lat, time);
        if (wv && Number.isFinite(wv.swh)) {
          if (wv.swh < sMin) sMin = wv.swh;
          if (wv.swh > sMax) sMax = wv.swh;
        }
      }
    }
    if (Number.isFinite(wMin)) {
      a.windMinMs = wMin;
      a.windMaxMs = wMax;
    }
    if (wind.hasWaves && Number.isFinite(sMin)) {
      a.swhMinM = sMin;
      a.swhMaxM = sMax;
    }
  }
}
