/**
 * The map layers and the forecast parameters each one reads, described
 * once (docs/plans/structural-cleanup.md, phase 4.2): the colour layers
 * (`GET /api/field`, the colour tiles), the glyph layers, and the land
 * mask tile.
 */

/** Colour layers (GET /api/field layers). */
export const FIELD_LAYERS = ['wind', 'waves', 'msl', 'temperature', 'sst', 'precip', 'sea_state', 'current', 'tide'] as const;
export type FieldLayer = (typeof FIELD_LAYERS)[number];

/** Forecast parameters a layer reads; empty when the layer does not use the forecast (currents, tides, the coastline). */
export const LAYER_PARAMS: Record<string, readonly string[]> = {
  wind: ['10u', '10v'],
  barbs: ['10u', '10v'],
  waves: ['swh', 'mwp', 'mwd'],
  msl: ['msl'],
  isobars: ['msl'],
  temperature: ['2t'],
  sst: ['skt'],
  precip: ['tprate', 'ptype'],
  sea_state: ['10u', '10v', 'swh', 'mwp', 'mwd'],
  current: [],
  arrows: [],
  tide: [],
  land: [],
};

export function isFieldLayer(s: string): s is FieldLayer {
  return (FIELD_LAYERS as readonly string[]).includes(s);
}
