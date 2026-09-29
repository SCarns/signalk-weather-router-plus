/**
 * Known ship canals, as cut lines across each canal. The water grid build
 * records every open coarse edge a cut crosses; those edges are closed at
 * load time unless "allow canals" is on. A cut spans the canal where it
 * runs through land, well away from natural water, so closing it never
 * closes a natural passage.
 *
 * Whether a canal is open in the grid at all depends on the coastline
 * data: with GSHHG full resolution (L1) at the grid's 0.005° fine
 * sampling, only canals wide enough to leave water at fine cell centres
 * appear (see README, "Canals", for the list measured on the shipped
 * grid). A canal with no open edge simply records none.
 */

export interface CanalDef {
  name: string;
  /** Cut segments, [[lat, lon], [lat, lon]]. */
  cuts: [[number, number], [number, number]][];
}

export const CANALS: readonly CanalDef[] = [
  // Across the canal at mid-isthmus (canal runs NW–SE, 37.94 N 22.96 E → 37.92 N 23.00 E).
  {
    name: 'Corinth Canal',
    cuts: [
      [
        [37.921, 22.972],
        [37.939, 22.988],
      ],
    ],
  },
  // Between the Bourne and Sagamore bridges (canal runs WSW–ENE).
  {
    name: 'Cape Cod Canal',
    cuts: [
      [
        [41.772, -70.577],
        [41.748, -70.555],
      ],
    ],
  },
  // North–south across the canal near Summit (canal runs west–east at ~39.54 N).
  {
    name: 'Chesapeake and Delaware Canal',
    cuts: [
      [
        [39.515, -75.7],
        [39.575, -75.7],
      ],
    ],
  },
  // North–south across the canal between Rendsburg and Kiel.
  {
    name: 'Kiel Canal',
    cuts: [
      [
        [54.28, 9.9],
        [54.37, 9.9],
      ],
    ],
  },
  // West–east across both channels north of Ismailia (canal runs north–south).
  {
    name: 'Suez Canal',
    cuts: [
      [
        [30.8, 32.2],
        [30.8, 32.42],
      ],
    ],
  },
  // West–east across the Pacific approach at Miraflores and the Atlantic approach at Gatun.
  {
    name: 'Panama Canal',
    cuts: [
      [
        [9.0, -79.64],
        [9.0, -79.55],
      ],
      [
        [9.27, -79.97],
        [9.27, -79.88],
      ],
    ],
  },
];
