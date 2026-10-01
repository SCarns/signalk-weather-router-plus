import { test } from 'node:test';
import { KTS_TO_MS } from '../geo/units';
import assert from 'node:assert/strict';
import { decodePng } from './png';
import { renderArrowsPng, renderBarbsPng, renderIsobarsPng } from './glyphtiles';
import { tileBBox } from './tiles';
import type { IsobarFeature } from '../engine/isobars';

const Z = 3;
const X = 2;
const Y = 3;
const PX = 256;

function painted(rgba: Uint8Array): { count: number; cx: number; cy: number } {
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < PX * PX; i++) {
    if (rgba[i * 4 + 3] > 0) {
      count++;
      sx += i % PX;
      sy += Math.floor(i / PX);
    }
  }
  return { count, cx: count ? sx / count : -1, cy: count ? sy / count : -1 };
}

test('glyph tiles: a barb is drawn at its point, pointing into the wind, in the speed colour', () => {
  const b = tileBBox(Z, X, Y);
  const lon = (b.west + b.east) / 2;
  const lat = (b.north + b.south) / 2; // the tile centre in degrees is above the pixel centre (Mercator), that is fine
  // 20 kt from the north: staff goes up from the plot point, feathers to the left.
  const png = renderBarbsPng(Z, X, Y, [{ lon, lat, speed_ms: 20 * KTS_TO_MS, dir_deg: 0 }]);
  const { rgba } = decodePng(png);
  const p = painted(rgba);
  assert.ok(p.count > 40 && p.count < 400, `${p.count} painted pixels`);
  // The glyph lies above and left of the plot point.
  const [ax, ay] = [128, 128 + 0]; // the plot point is near the tile centre column
  assert.ok(p.cy < ay + 20 && p.cx <= ax + 2, `centroid ${p.cx.toFixed(0)},${p.cy.toFixed(0)}`);
  // Colour: 20 kt → '#F9A825' (strong).
  let found = false;
  for (let i = 0; i < PX * PX && !found; i++)
    if (rgba[i * 4 + 3] === 255 && rgba[i * 4] === 0xf9 && rgba[i * 4 + 1] === 0xa8 && rgba[i * 4 + 2] === 0x25) found = true;
  assert.ok(found, 'strong-wind colour present');

  // From the east: the staff extends to the right of the plot point.
  const east = painted(decodePng(renderBarbsPng(Z, X, Y, [{ lon, lat, speed_ms: 20 * KTS_TO_MS, dir_deg: 90 }])).rgba);
  assert.ok(east.cx > 128, `east centroid x ${east.cx.toFixed(0)}`);
  // Calm: a small ring.
  const calm = painted(decodePng(renderBarbsPng(Z, X, Y, [{ lon, lat, speed_ms: 0.5, dir_deg: 200 }])).rgba);
  assert.ok(calm.count > 15 && calm.count < 80, `calm ring ${calm.count}`);
  // A point far outside the tile draws nothing.
  assert.equal(painted(decodePng(renderBarbsPng(Z, X, Y, [{ lon: lon + 90, lat, speed_ms: 10, dir_deg: 0 }])).rgba).count, 0);
});

test('glyph tiles: arrows point where the current flows; slack is a pause symbol', () => {
  const b = tileBBox(Z, X, Y);
  const lon = (b.west + b.east) / 2;
  const lat = (b.north + b.south) / 2;
  const pt = (speed: number, dir: number) => ({ lon, lat, speed_ms: speed, dir_deg: dir, u_ms: 0, v_ms: 0 });
  const north = painted(decodePng(renderArrowsPng(Z, X, Y, [pt(1.0, 0)])).rgba);
  const southPx = painted(decodePng(renderArrowsPng(Z, X, Y, [pt(1.0, 180)])).rgba);
  assert.ok(north.count > 30, `${north.count} pixels`);
  // Flowing north: the head is above the centre; flowing south: below.
  assert.ok(north.cy < southPx.cy, `north cy ${north.cy.toFixed(0)} south cy ${southPx.cy.toFixed(0)}`);
  const slack = painted(decodePng(renderArrowsPng(Z, X, Y, [pt(0.01, 0)])).rgba);
  assert.ok(slack.count > 8 && slack.count < 60, `slack ${slack.count}`);
});

test('glyph tiles: isobars are drawn as lines, highs and lows as dots', () => {
  const b = tileBBox(Z, X, Y);
  const midLat = (b.north + b.south) / 2;
  const features: IsobarFeature[] = [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [b.west - 1, midLat],
          [b.east + 1, midLat],
        ],
      },
      properties: { kind: 'isobar', hpa: 1020, pa: 102000, bold: true },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(b.west + b.east) / 2, midLat + 2] },
      properties: { kind: 'high', hpa: 1024 },
    },
  ];
  const { rgba } = decodePng(renderIsobarsPng(Z, X, Y, features));
  const p = painted(rgba);
  assert.ok(p.count > 256, `${p.count} painted pixels (a full-width line plus a dot)`);
  // The line crosses the whole tile width at one row band.
  let rowHits = 0;
  for (let y = 0; y < PX; y++) if (rgba[(y * PX + 10) * 4 + 3] > 0) rowHits++;
  assert.ok(rowHits >= 1 && rowHits <= 4, `line rows at x=10: ${rowHits}`);
});
