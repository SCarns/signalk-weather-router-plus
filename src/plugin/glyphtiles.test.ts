import { test } from 'node:test';
import { KTS_TO_MS } from '../geo/units';
import assert from 'node:assert/strict';
import { decodePng } from './png';
import { renderArrowsPng, renderBarbsPng, renderIsobarsPng, renderSeasPng, renderWaveArrowsPng, waveArrowLength } from './glyphtiles';
import { seaBandGlyphColour, waveGlyphColour } from './legends';
import type { SeaPoint } from './overlays';
import { tileBBox } from './tiles';
import type { IsobarFeature } from './isobars';

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

function hasColour(rgba: Uint8Array, hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  for (let i = 0; i < PX * PX; i++)
    if (rgba[i * 4 + 3] === 255 && rgba[i * 4] === n >> 16 && rgba[i * 4 + 1] === ((n >> 8) & 255) && rgba[i * 4 + 2] === (n & 255))
      return true;
  return false;
}

test('glyph tiles: sea state arrows point the way the waves travel, in the band colour, outlined; opposing is larger', () => {
  const b = tileBBox(Z, X, Y);
  const lon = (b.west + b.east) / 2;
  const lat = (b.north + b.south) / 2;
  const pt = (o: Partial<SeaPoint>): SeaPoint => ({
    lon,
    lat,
    idx: 120,
    swh_m: 2,
    mwp_s: 8,
    to_deg: 0,
    rel: 'none',
    steepen: 1,
    wind_ms: null,
    wind_to_deg: null,
    cur_ms: 0,
    cur_to_deg: null,
    ...o,
  });
  const none = decodePng(renderSeasPng(Z, X, Y, [pt({})])).rgba;
  const p = painted(none);
  assert.ok(p.count > 20, `${p.count} pixels`);
  // Band colour (rough: 100..150) and the dark outline both present.
  assert.ok(hasColour(none, seaBandGlyphColour(120)), 'band colour present');
  // The outline: a dark fringe round the glyph (anti-aliased, so dark rather than exactly #0f172a).
  let dark = 0;
  for (let i = 0; i < PX * PX; i++) if (none[i * 4 + 3] > 0 && none[i * 4] < 80 && none[i * 4 + 1] < 80 && none[i * 4 + 2] < 100) dark++;
  assert.ok(dark > 10, `${dark} dark outline pixels`);
  // The thin arrow's head is at the top when the waves travel north, at the bottom when south.
  const head = (to: number): number => {
    const rgba = decodePng(renderSeasPng(Z, X, Y, [pt({ to_deg: to })])).rgba;
    let wsum = 0;
    let ysum = 0;
    for (let i = 0; i < PX * PX; i++) {
      // Weight by how wide each row is painted: the head (a chevron) is wider than the shaft.
      if (rgba[i * 4 + 3] > 0) {
        const y = Math.floor(i / PX);
        wsum += 1;
        ysum += y;
      }
    }
    return ysum / wsum;
  };
  assert.ok(head(0) < head(180), `north ${head(0).toFixed(1)} south ${head(180).toFixed(1)}`);
  // Opposing with steepening 1.5 is drawn larger than with none.
  const opp1 = painted(decodePng(renderSeasPng(Z, X, Y, [pt({ rel: 'opposing', steepen: 1 })])).rgba).count;
  const opp15 = painted(decodePng(renderSeasPng(Z, X, Y, [pt({ rel: 'opposing', steepen: 1.5 })])).rgba).count;
  assert.ok(opp15 > opp1 * 1.5, `opposing ${opp1} → steepened ${opp15}`);
});

test('glyph tiles: wave arrows are coloured by height and longer for a longer period', () => {
  const b = tileBBox(Z, X, Y);
  const lon = (b.west + b.east) / 2;
  const lat = (b.north + b.south) / 2;
  const pt = (o: Partial<SeaPoint>): SeaPoint => ({
    lon,
    lat,
    idx: 60,
    swh_m: 3,
    mwp_s: 8,
    to_deg: 90,
    rel: 'none',
    steepen: 1,
    wind_ms: null,
    wind_to_deg: null,
    cur_ms: 0,
    cur_to_deg: null,
    ...o,
  });
  assert.equal(waveArrowLength(4), 12);
  assert.equal(waveArrowLength(16), 34);
  assert.equal(waveArrowLength(null), 20);
  const rgba = decodePng(renderWaveArrowsPng(Z, X, Y, [pt({})])).rgba;
  assert.ok(hasColour(rgba, waveGlyphColour(3)), 'height colour present');
  // Travelling east: wider than tall.
  let minX = PX,
    maxX = 0,
    minY = PX,
    maxY = 0;
  for (let i = 0; i < PX * PX; i++)
    if (rgba[i * 4 + 3] > 0) {
      const x = i % PX,
        y = Math.floor(i / PX);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  assert.ok(maxX - minX > maxY - minY, `east arrow ${maxX - minX}×${maxY - minY}`);
  const short = painted(decodePng(renderWaveArrowsPng(Z, X, Y, [pt({ mwp_s: 4 })])).rgba).count;
  const long = painted(decodePng(renderWaveArrowsPng(Z, X, Y, [pt({ mwp_s: 16 })])).rgba).count;
  assert.ok(long > short * 1.5, `4 s ${short} px, 16 s ${long} px`);
});
