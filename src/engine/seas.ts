/**
 * The sea as the boat meets it: the angle between the boat's course and the
 * direction the waves come from, the sector that angle falls in, and the
 * sea-state index adjusted for it (the "encounter index").
 *
 * The sea-state index (plugin/conditions.ts roughnessIndex) describes the
 * water at a point: wind against current, swell steepened by an opposing
 * current. It knows nothing of the boat. Heading into the waves is harder
 * than running with them (the boat slams and the motion is short and hard;
 * running before them the motion is long and easier), so the encounter index
 * weights the index by the angle: ENCOUNTER_HEAD on the bow, 1.05 abeam,
 * ENCOUNTER_FOLLOWING from astern, smoothly between (a cosine). The weights
 * are a judgement, not derived from physics; they are here so they can be
 * tuned in one place.
 */

/** Weight of the sea-state index with the waves dead ahead. */
export const ENCOUNTER_HEAD = 1.3;
/** Weight with the waves from dead astern. */
export const ENCOUNTER_FOLLOWING = 0.8;

export type SeaSector = 'head' | 'bow' | 'beam' | 'quarter' | 'following';

/**
 * The angle between the course and the direction the waves come FROM, 0..180°:
 * 0 = head seas (the waves come from where the boat is going), 180 =
 * following seas. `side`: the side the waves come from (null dead ahead or
 * astern).
 */
export function seaAngle(courseDeg: number, wavesFromDeg: number): { angle: number; side: 'port' | 'starboard' | null } {
  const rel = (((wavesFromDeg - courseDeg) % 360) + 360) % 360; // 0..360, clockwise from the bow
  const angle = rel <= 180 ? rel : 360 - rel;
  const side = angle < 0.5 || angle > 179.5 ? null : rel < 180 ? 'starboard' : 'port';
  return { angle, side };
}

/** The sector: head (0–30°), bow (30–60°), beam (60–120°), quarter (120–150°), following (150–180°). */
export function seaSector(angle: number): SeaSector {
  return angle < 30 ? 'head' : angle < 60 ? 'bow' : angle <= 120 ? 'beam' : angle <= 150 ? 'quarter' : 'following';
}

/** The weight for an angle (0 = head seas): ENCOUNTER_HEAD … ENCOUNTER_FOLLOWING, a cosine between. */
export function encounterFactor(angle: number): number {
  const mid = (ENCOUNTER_HEAD + ENCOUNTER_FOLLOWING) / 2;
  const amp = (ENCOUNTER_HEAD - ENCOUNTER_FOLLOWING) / 2;
  return mid + amp * Math.cos((angle * Math.PI) / 180);
}

/** The sea-state index as the boat meets it on this course. */
export function encounterIndex(seaIndex: number, courseDeg: number, wavesFromDeg: number): number {
  if (!Number.isFinite(seaIndex) || !Number.isFinite(courseDeg) || !Number.isFinite(wavesFromDeg)) return seaIndex;
  return seaIndex * encounterFactor(seaAngle(courseDeg, wavesFromDeg).angle);
}

/**
 * The comfort cost (routing option): on top of its real time, each second
 * sailed in rough water counts extra, so the search prefers calmer water at
 * some cost in time. Free up to COMFORT_FREE_INDEX of encounter index (the
 * top of the "slight" band: with no current the index's wind term alone is
 * 50, and head seas weight that to 65, which is no reason to avoid
 * anything); above it each second costs weight × (index − free) /
 * COMFORT_SCALE extra seconds, at most COMFORT_MAX_RATE: with weight 1,
 * choppy water at 100 adds 25 %, rough at 125 adds 50 %, extreme at 200
 * adds 125 %. The route's times stay real; only the search's choices use
 * the cost.
 */
export const COMFORT_FREE_INDEX = 75;
export const COMFORT_SCALE = 100;
export const COMFORT_MAX_RATE = 2;

/** Extra seconds per second sailed at this encounter index (0 in calm water). */
export function comfortRate(encounter: number, weight: number): number {
  if (!(weight > 0) || !Number.isFinite(encounter) || encounter <= COMFORT_FREE_INDEX) return 0;
  return weight * Math.min(COMFORT_MAX_RATE, (encounter - COMFORT_FREE_INDEX) / COMFORT_SCALE);
}
