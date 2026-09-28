import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bloscDecompress, BloscError, lz4DecompressBlock, readBloscHeader } from './blosc';

const dir = path.join(__dirname, '..', '..', 'test-data', 'blosc');

interface Case { name: string; sha256: string; head: string; tail: string; flags: number; typesize: number; nbytes: number; blocksize: number; offset: number; length: number }

const sha = (b: Uint8Array): string => crypto.createHash('sha256').update(b).digest('hex');

test('blosc: every reference frame (numcodecs / c-blosc 1.21) decodes bit-exactly', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'blosc_cases.index.json'), 'utf8')) as { cases: Case[] };
  const blob = new Uint8Array(fs.readFileSync(path.join(dir, 'blosc_cases.bin')));
  const seen = { byte: 0, bit: 0, none: 0, split: 0, noSplit: 0, memcpyed: 0, multiBlockPartial: 0 };
  for (const c of idx.cases) {
    const frame = blob.subarray(c.offset, c.offset + c.length);
    const h = readBloscHeader(frame);
    assert.equal(h.flags, c.flags, c.name);
    assert.equal(h.nbytes, c.nbytes, c.name);
    const out = bloscDecompress(frame);
    assert.equal(out.length, c.nbytes, c.name);
    assert.equal(Buffer.from(out.subarray(0, 64)).toString('base64'), c.head, `${c.name} head`);
    assert.equal(Buffer.from(out.subarray(out.length - 64)).toString('base64'), c.tail, `${c.name} tail`);
    assert.equal(sha(out), c.sha256, `${c.name}: decoded bytes differ from the reference`);
    seen[h.shuffle === 'byte' ? 'byte' : h.shuffle === 'bit' ? 'bit' : 'none']++;
    if (h.memcpyed) seen.memcpyed++;
    else if (h.dontSplit) seen.noSplit++;
    else seen.split++;
    if (c.nbytes > c.blocksize && c.nbytes % c.blocksize !== 0) seen.multiBlockPartial++;
  }
  // The fixture set must keep covering every path.
  for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `no fixture exercises ${k}`);
});

test('blosc: a real CMEMS SMOC utotal chunk decodes bit-exactly (vs numcodecs)', () => {
  const frame = new Uint8Array(fs.readFileSync(path.join(dir, 'smoc_utotal_51780.0.3.2.blosc')));
  const ref = JSON.parse(fs.readFileSync(path.join(dir, 'smoc_utotal_51780.0.3.2.ref.json'), 'utf8')) as { sha256: string; nbytes: number; fill_count: number; samples: [number, number, number][] };
  const h = readBloscHeader(frame);
  assert.equal(h.codec, 'lz4');
  assert.equal(h.shuffle, 'byte');
  assert.equal(h.typesize, 4);
  assert.equal(h.dontSplit, false);
  const out = bloscDecompress(frame);
  assert.equal(out.length, ref.nbytes);
  assert.equal(sha(out), ref.sha256);
  const f = new Float32Array(out.buffer, out.byteOffset, out.length / 4);
  for (const [r, c, v] of ref.samples) assert.equal(f[r * 2048 + c], Math.fround(v), `sample ${r},${c}`);
  let fills = 0;
  const fill = Math.fround(9.969209968386869e36);
  for (let i = 0; i < f.length; i++) if (f[i] === fill) fills++;
  assert.equal(fills, ref.fill_count);
});

test('blosc: unsupported codecs, versions and corrupt frames fail clearly', () => {
  const frame = new Uint8Array(fs.readFileSync(path.join(dir, 'smoc_utotal_51780.0.3.2.blosc')));
  const zstd = frame.slice();
  zstd[2] = (zstd[2] & 0x1f) | (4 << 5);
  assert.throws(() => bloscDecompress(zstd), /codec zstd is not supported/);
  const v3 = frame.slice();
  v3[0] = 3;
  assert.throws(() => bloscDecompress(v3), /format version 3/);
  assert.throws(() => bloscDecompress(frame.subarray(0, 1000)), BloscError);
  const corrupt = frame.slice();
  for (let i = 200; i < 260; i++) corrupt[i] ^= 0xa5;
  assert.throws(() => bloscDecompress(corrupt), BloscError);
});

test('lz4: overlapping matches and long literal / match lengths', () => {
  // Token 0x1F: 1 literal 'a', then a match of 15+ext+4 bytes at offset 1 (run of 'a').
  // Final sequence: 5 literals 'bcdef'.
  const src = new Uint8Array([0x1f, 0x61, 0x01, 0x00, 0x05, 0x50, 0x62, 0x63, 0x64, 0x65, 0x66]);
  const dst = new Uint8Array(1 + 24 + 5);
  assert.equal(lz4DecompressBlock(src, 0, src.length, dst, 0, dst.length), dst.length);
  assert.equal(Buffer.from(dst).toString('latin1'), `${'a'.repeat(25)}bcdef`);
  // 20 literals via an extension byte (15 + 5).
  const lit = new Uint8Array(22);
  lit[0] = 0xf0;
  lit[1] = 5;
  for (let i = 0; i < 20; i++) lit[2 + i] = 65 + i;
  const out = new Uint8Array(20);
  lz4DecompressBlock(lit, 0, lit.length, out, 0, 20);
  assert.equal(Buffer.from(out).toString('latin1'), 'ABCDEFGHIJKLMNOPQRST');
  // Offset before the start of the output.
  assert.throws(() => lz4DecompressBlock(new Uint8Array([0x10, 0x61, 0x05, 0x00]), 0, 4, new Uint8Array(10), 0, 10), /offset before/);
});
