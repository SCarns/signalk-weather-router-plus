import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng } from './png';

test('png: encode then decode round-trips RGBA pixels', () => {
  const w = 5;
  const h = 3;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 0xff;
  const png = encodePng(w, h, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('latin1'), 'IEND');
  const out = decodePng(png);
  assert.equal(out.width, w);
  assert.equal(out.height, h);
  assert.deepEqual(out.rgba, rgba);
});

test('png: a transparent 256×256 tile is small, and the size check holds', () => {
  const png = encodePng(256, 256, new Uint8Array(256 * 256 * 4));
  assert.ok(png.length < 1500, `${png.length} bytes`);
  assert.throws(() => encodePng(2, 2, new Uint8Array(15)), /bytes for 2×2×4/);
});
