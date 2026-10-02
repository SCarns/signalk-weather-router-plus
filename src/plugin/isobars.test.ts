import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIsobarFeatures, contourLines } from './isobars';

test('isobars: a synthetic low yields closed contours, labels and an L', () => {
  const nx = 41;
  const ny = 33;
  const lons = new Float64Array(nx);
  const lats = new Float64Array(ny);
  for (let i = 0; i < nx; i++) lons[i] = -75 + i * 0.25;
  for (let j = 0; j < ny; j++) lats[j] = 36 + j * 0.25;
  const field = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const dx = (lons[i] + 70) / 2;
      const dy = (lats[j] - 40) / 2;
      field[j * nx + i] = 1016 - 20 * Math.exp(-(dx * dx + dy * dy));
    }
  }
  const lines = contourLines(field, lons, lats, 1004);
  assert.ok(lines.length >= 1);
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
  const first = longest[0];
  const last = longest[longest.length - 1];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6, 'contour around the low should close');
  const feats = buildIsobarFeatures(field, lons, lats, 4);
  const kinds = new Set(feats.map(f => f.properties.kind));
  assert.ok(kinds.has('isobar') && kinds.has('label') && kinds.has('low'), `kinds ${[...kinds].join(',')}`);
  const low = feats.find(f => f.properties.kind === 'low')!;
  const [lon, lat] = (low.geometry as { coordinates: [number, number] }).coordinates;
  assert.ok(Math.abs(lon + 70) <= 0.26 && Math.abs(lat - 40) <= 0.26, `low at ${lon},${lat}`);
  assert.ok(feats.some(f => f.properties.kind === 'isobar' && f.properties.hpa === 1000 && f.properties.bold === true));
  for (const f of feats)
    assert.equal(f.properties.pa, Math.round((f.properties.hpa as number) * 100), `pa beside hpa on ${f.properties.kind}`);
});
