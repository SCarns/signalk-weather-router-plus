/**
 * Wind, waves and current at each waypoint's position and time.
 *
 * Part of the isochrone search (docs/plans/structural-cleanup.md, phase
 * 2.1): the body of OceanPropagator.computeRoute, section by section, with
 * the shared state in a SearchContext instead of closure variables. The
 * arithmetic is unchanged; the golden routes hold that.
 */

import { norm360 } from '../../geo/angles';
import type { CurrentSource, WindSource } from '../environment';
import type { Waypoint } from '../route';

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
