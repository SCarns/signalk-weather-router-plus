import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_REQUEST_FIELDS, routeRequestSchema, validateRouteRequest } from './request_schema';
import { SETTINGS_SPEC } from './settings';
import type { RouteRequest } from './protocol';

const ok: RouteRequest = { start: { lat: 40.5, lon: -73.9 }, end: { lat: 40.4, lon: -73.6 } };

test('route request: ranges come from the settings they override, and the OpenAPI schema lists every field', () => {
  const spec = (k: string) => SETTINGS_SPEC.find(s => s.key === k)!;
  for (const [field, key] of [
    ['stages', 'routing.stages'],
    ['max_wind_ms', 'routing.maxWind'],
    ['max_swh_m', 'routing.maxSwh'],
    ['simplify_m', 'routing.simplify'],
    ['smoother_tolerance', 'routing.smootherTolerance'],
  ] as const) {
    const f = ROUTE_REQUEST_FIELDS[field];
    assert.equal(f.type, 'number');
    if (f.type === 'number') assert.deepEqual([f.min, f.max], [spec(key).min, spec(key).max], field);
  }
  const schema = routeRequestSchema() as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties), ['start', 'end', 'waypoints', ...Object.keys(ROUTE_REQUEST_FIELDS), 'vessel']);
});

test('route request: valid bodies pass, each bad field names itself', () => {
  assert.equal(validateRouteRequest(ok), null);
  assert.equal(
    validateRouteRequest({ ...ok, stages: 50, mode: 'motor', smoother: false, departure: '', vessel: { polar_performance: 0.9 } }),
    null
  );
  assert.equal(validateRouteRequest({ ...ok, start: { lat: 'x', lon: 1 } } as unknown as RouteRequest), 'start must be {lat, lon}');
  assert.equal(validateRouteRequest({ ...ok, end: { lat: 95, lon: 1 } }), 'end out of range');
  assert.equal(validateRouteRequest({ ...ok, waypoints: new Array(21).fill({ lat: 40, lon: -73 }) }), 'at most 20 waypoints');
  assert.equal(validateRouteRequest({ ...ok, stages: 3 }), 'stages must be 4..200');
  assert.equal(validateRouteRequest({ ...ok, max_wind_ms: 120 }), 'max_wind_ms must be 0..100');
  assert.equal(validateRouteRequest({ ...ok, sail_thresh_ms: -1 }), 'sail_thresh_ms must be >= 0');
  assert.equal(
    validateRouteRequest({ ...ok, mode: 'drift' as unknown as RouteRequest['mode'] }),
    'mode must be sail_max, fastest or motor'
  );
  assert.equal(validateRouteRequest({ ...ok, departure: 'yesterday' }), 'departure must be ISO 8601');
  assert.equal(validateRouteRequest({ ...ok, smoother: 'yes' as unknown as boolean }), 'smoother must be true or false');
  assert.equal(
    validateRouteRequest({ ...ok, precision: 'approximate', arrival_radius_m: 0 }),
    'arrival_radius_m must be > 0 when precision is "approximate" (use "precise" for exact waypoints)'
  );
  assert.equal(validateRouteRequest({ ...ok, vessel: { polar_performance: 2 } }), 'vessel.polar_performance must be 0.3..1.2');
  assert.equal(validateRouteRequest({ ...ok, vessel: { polar: 'x'.repeat(201) } }), 'vessel.polar must be a polar token from /api/polars');
  assert.equal(validateRouteRequest({ ...ok, vessel: null as unknown as RouteRequest['vessel'] }), 'vessel must be an object');
});
