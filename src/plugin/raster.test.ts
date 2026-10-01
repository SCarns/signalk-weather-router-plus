import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, hexRgba } from './raster';

const at = (c: Canvas, x: number, y: number): number[] => [...c.data.subarray((y * c.width + x) * 4, (y * c.width + x) * 4 + 4)];

test('raster: a horizontal 2 px line covers its row fully and the next rows partly', () => {
  const c = new Canvas(16, 8);
  c.line(2, 4, 12, 4, 2, [255, 0, 0, 255]);
  assert.deepEqual(at(c, 6, 3), [255, 0, 0, 255], 'centre rows opaque');
  assert.deepEqual(at(c, 6, 4), [255, 0, 0, 255]);
  assert.equal(at(c, 6, 2)[3], 0, 'beyond the stroke');
  assert.equal(at(c, 0, 4)[3], 0, 'before the start');
  assert.ok(at(c, 2, 4)[3] > 0, 'the end caps are drawn');
});

test('raster: a filled triangle is opaque inside, empty outside, partial on the edge', () => {
  const c = new Canvas(20, 20);
  c.polygon(
    [
      [2, 2],
      [18, 2],
      [2, 18],
    ],
    [0, 0, 255, 255]
  );
  assert.deepEqual(at(c, 5, 5), [0, 0, 255, 255]);
  assert.equal(at(c, 17, 17)[3], 0);
  const edge = at(c, 9, 10)[3];
  assert.ok(edge > 0 && edge < 255, `edge alpha ${edge}`);
});

test('raster: a ring and alpha blending', () => {
  const c = new Canvas(20, 20);
  c.circle(10, 10, 6, 1.5, [0, 0, 0, 255]);
  assert.equal(at(c, 10, 10)[3], 0, 'hollow');
  assert.ok(at(c, 16, 10)[3] > 150, 'on the ring');
  // Half-transparent red over opaque blue: purple-ish, still opaque.
  const b = new Canvas(1, 1);
  b.blend(0, 0, [0, 0, 255, 255], 1);
  b.blend(0, 0, [255, 0, 0, 255], 0.5);
  assert.deepEqual(at(b, 0, 0), [128, 0, 128, 255]);
  assert.deepEqual(hexRgba('#ff8000', 100), [255, 128, 0, 100]);
});
