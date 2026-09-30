/**
 * Names for well-known narrow passages, used to label the chokepoints
 * the water grid build detects ("auto via at Strait of Gibraltar"). A
 * chokepoint takes the name of the nearest entry within `radiusKm` of its
 * position; others are described by position.
 */

import { haversineDistanceM } from './geodesy';

export interface NamedStrait {
  name: string;
  lat: number;
  lon: number;
  /** Match radius, km. */
  radiusKm: number;
}

export const NAMED_STRAITS: readonly NamedStrait[] = [
  { name: 'Strait of Gibraltar', lat: 35.95, lon: -5.6, radiusKm: 45 },
  { name: 'Strait of Messina', lat: 38.2, lon: 15.63, radiusKm: 25 },
  { name: 'Strait of Bonifacio', lat: 41.3, lon: 9.2, radiusKm: 25 },
  { name: 'Piombino Channel', lat: 42.88, lon: 10.45, radiusKm: 15 },
  { name: 'Strait of Dover', lat: 51.0, lon: 1.45, radiusKm: 40 },
  { name: 'Dardanelles', lat: 40.2, lon: 26.4, radiusKm: 45 },
  { name: 'Bosphorus', lat: 41.12, lon: 29.06, radiusKm: 25 },
  { name: 'Kerch Strait', lat: 45.3, lon: 36.55, radiusKm: 30 },
  { name: 'Øresund', lat: 55.9, lon: 12.7, radiusKm: 45 },
  { name: 'Great Belt', lat: 55.35, lon: 11.0, radiusKm: 35 },
  { name: 'Little Belt', lat: 55.45, lon: 9.75, radiusKm: 25 },
  { name: 'Kalmar Strait', lat: 56.65, lon: 16.4, radiusKm: 25 },
  { name: 'Euripus Strait', lat: 38.46, lon: 23.59, radiusKm: 12 },
  { name: 'Mycale Strait', lat: 37.7, lon: 26.95, radiusKm: 10 },
  { name: 'Strait of Otranto', lat: 40.2, lon: 18.9, radiusKm: 40 },
  { name: 'Menai Strait', lat: 53.2, lon: -4.2, radiusKm: 15 },
  { name: 'Pentland Firth', lat: 58.7, lon: -3.1, radiusKm: 20 },
  { name: 'North Channel', lat: 55.2, lon: -5.7, radiusKm: 30 },
  { name: 'Hurst Narrows (the Solent)', lat: 50.71, lon: -1.55, radiusKm: 8 },
  { name: 'Bab-el-Mandeb', lat: 12.6, lon: 43.35, radiusKm: 45 },
  { name: 'Strait of Tiran', lat: 27.97, lon: 34.45, radiusKm: 15 },
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.4, radiusKm: 60 },
  { name: 'Singapore Strait', lat: 1.2, lon: 103.9, radiusKm: 45 },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.3, radiusKm: 80 },
  { name: 'Sunda Strait', lat: -6.0, lon: 105.8, radiusKm: 40 },
  { name: 'Lombok Strait', lat: -8.5, lon: 115.7, radiusKm: 40 },
  { name: 'Torres Strait', lat: -10.5, lon: 142.3, radiusKm: 80 },
  { name: 'Palk Strait', lat: 9.9, lon: 79.5, radiusKm: 50 },
  { name: 'Tsugaru Strait', lat: 41.5, lon: 140.5, radiusKm: 35 },
  { name: 'Kanmon Strait', lat: 33.95, lon: 130.95, radiusKm: 12 },
  { name: 'La Pérouse Strait', lat: 45.7, lon: 142.0, radiusKm: 35 },
  { name: 'Cook Strait', lat: -41.2, lon: 174.4, radiusKm: 40 },
  { name: 'Foveaux Strait', lat: -46.7, lon: 168.0, radiusKm: 35 },
  { name: 'Bass Strait (Port Phillip Heads)', lat: -38.29, lon: 144.63, radiusKm: 8 },
  { name: 'Strait of Magellan', lat: -53.2, lon: -70.6, radiusKm: 150 },
  { name: 'Beagle Channel', lat: -54.87, lon: -68.3, radiusKm: 60 },
  { name: 'Strait of Juan de Fuca', lat: 48.3, lon: -123.6, radiusKm: 60 },
  { name: 'Seymour Narrows', lat: 50.13, lon: -125.35, radiusKm: 10 },
  { name: 'Johnstone Strait', lat: 50.45, lon: -126.2, radiusKm: 40 },
  { name: 'Golden Gate', lat: 37.81, lon: -122.48, radiusKm: 8 },
  { name: 'Hell Gate', lat: 40.78, lon: -73.93, radiusKm: 6 },
  { name: 'The Race', lat: 41.23, lon: -72.05, radiusKm: 12 },
  { name: 'Verrazzano Narrows', lat: 40.6, lon: -74.04, radiusKm: 6 },
  { name: 'Strait of Canso', lat: 45.64, lon: -61.41, radiusKm: 12 },
  { name: 'Strait of Belle Isle', lat: 51.5, lon: -56.6, radiusKm: 50 },
  { name: 'Faial–Pico Channel', lat: 38.5, lon: -28.55, radiusKm: 12 },
];

/** Name of the nearest named strait within its radius, or null. */
export function straitName(lat: number, lon: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const s of NAMED_STRAITS) {
    const d = haversineDistanceM(lon, lat, s.lon, s.lat);
    if (d <= s.radiusKm * 1000 && d < bestD) {
      bestD = d;
      best = s.name;
    }
  }
  return best;
}

/** "Strait of Gibraltar" or "narrow passage 36.00N 5.60W". */
export function describePassage(lat: number, lon: number): string {
  return (
    straitName(lat, lon) ??
    `narrow passage ${Math.abs(lat).toFixed(2)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}${lon >= 0 ? 'E' : 'W'}`
  );
}
