/**
 * Text with unit tokens ({<Signal K unit category>:<value in its base
 * unit>}) for clients that do not read tokens (notifications, the Signal K
 * admin status, the server log): each value with its category's Signal K
 * base unit, for the client to convert.
 */

const UNIT_TOKEN = /\{([A-Za-z]+):([-0-9.e+]+)\}/g;

/** Signal K's base unit per category (unitpreferences/categories.json, categoryToBaseUnit). */
const BASE_UNIT: Record<string, string> = {
  speed: 'm/s',
  distance: 'm',
  depth: 'm',
  length: 'm',
  angle: 'rad',
  time: 's',
  dataSize: 'B',
  percentage: 'ratio',
};

export function siText(text: string): string {
  // A category not in the map keeps its token, so the value's kind is still readable.
  return text.replace(UNIT_TOKEN, (m: string, cat: string, v: string) => (BASE_UNIT[cat] ? `${Number(v)} ${BASE_UNIT[cat]}` : m));
}
