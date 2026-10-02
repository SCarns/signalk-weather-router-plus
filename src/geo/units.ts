/**
 * The one place a unit or a geodetic constant is defined. Everything in
 * memory is SI (metres, seconds, m/s, kelvin, pascal, ratios; angles in
 * degrees where a name says so); display units come from the Signal K
 * user's preferences on the page, never from here.
 *
 * The knot factor is the exact definition (1 nautical mile = 1852 m per
 * hour), also where the code was ported from Python that used a rounded
 * value (docs/plans/structural-cleanup.md, decision F).
 */

/** IUGG mean Earth radius, metres (the routing engine this is ported from uses the same). */
export const R_EARTH_M = 6371008.8;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
/** Metres per degree of latitude (and of longitude at the equator) on the R_EARTH_M sphere. */
export const M_PER_DEG = R_EARTH_M * DEG;

export const NM_M = 1852;
export const KTS_TO_MS = 1852 / 3600;

export const MINUTE_S = 60;
export const HOUR_S = 3600;
export const DAY_S = 86400;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3600_000;
export const DAY_MS = 86_400_000;

/** Precipitation rate: mm/h → m/s. */
export const MMH_TO_MS = 1 / 3_600_000;
export const HPA_TO_PA = 100;
export const KELVIN_OFFSET = 273.15;
