import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { iterateGrib2 } from './grib2';
import { aecDecode, AecError } from './ccsds';

const fixture = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10u10v_3steps.grib2');
const truthPath = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10u10v_3steps.truth.json');

interface Truth {
  shortName: string;
  step: number;
  Ni: number;
  Nj: number;
  dataDate: number;
  dataTime: number;
  latitudeOfFirstGridPointInDegrees: number;
  longitudeOfFirstGridPointInDegrees: number;
  iDirectionIncrementInDegrees: number;
  count: number;
  min: number;
  max: number;
  sum: number;
  sha256_f64le: string;
  sampleStride: number;
  samples: number[];
}

test('ECMWF CCSDS-packed GRIB2 decodes to exactly what eccodes produces', () => {
  const buf = new Uint8Array(fs.readFileSync(fixture));
  const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8')) as Truth[];
  const msgs = [...iterateGrib2(buf)];
  assert.equal(msgs.length, truth.length);
  msgs.forEach((m, i) => {
    const t = truth[i];
    assert.equal(m.grid.ni, t.Ni);
    assert.equal(m.grid.nj, t.Nj);
    assert.equal(m.product.forecastHours, t.step);
    assert.equal(m.grid.la1, t.latitudeOfFirstGridPointInDegrees);
    assert.equal(m.grid.lo1, t.longitudeOfFirstGridPointInDegrees);
    assert.equal(m.grid.di, t.iDirectionIncrementInDegrees);
    const param = m.product.parameterNumber === 2 ? '10u' : '10v';
    assert.equal(param, t.shortName);
    const vals = m.decode();
    assert.equal(vals.length, t.count);
    // Full-array hash of the little-endian float64 bytes, as eccodes wrote them.
    const hash = createHash('sha256')
      .update(Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength))
      .digest('hex');
    assert.equal(hash, t.sha256_f64le, `${t.shortName} +${t.step}h: decoded values differ from eccodes`);
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    for (let k = 0; k < vals.length; k++) {
      if (vals[k] < mn) mn = vals[k];
      if (vals[k] > mx) mx = vals[k];
      sum += vals[k];
    }
    assert.equal(mn, t.min);
    assert.equal(mx, t.max);
    assert.ok(Math.abs(sum - t.sum) < 1e-6 * Math.abs(t.sum) + 1e-6);
    t.samples.forEach((s, k) => assert.equal(vals[k * t.sampleStride], s));
  });
});

test('reference time is parsed from section 1', () => {
  const buf = new Uint8Array(fs.readFileSync(fixture));
  const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8')) as Truth[];
  const m = [...iterateGrib2(buf)][0];
  const d = truth[0].dataDate;
  const hm = truth[0].dataTime;
  const want = Date.UTC(Math.floor(d / 10000), Math.floor((d % 10000) / 100) - 1, d % 100, Math.floor(hm / 100), hm % 100);
  assert.equal(m.referenceTime.getTime(), want);
});

test('CCSDS decoder rejects invalid configuration and truncated streams', () => {
  assert.throws(() => aecDecode(new Uint8Array(8), { bitsPerSample: 0, blockSize: 32, rsi: 128, flags: 14 }, 10), AecError);
  assert.throws(() => aecDecode(new Uint8Array(8), { bitsPerSample: 12, blockSize: 33, rsi: 128, flags: 14 }, 10), AecError);
  assert.throws(() => aecDecode(new Uint8Array(8), { bitsPerSample: 12, blockSize: 32, rsi: 5000, flags: 14 }, 10), AecError);
  // Too few bytes for the requested samples in the uncompressed option.
  const uncompressed = new Uint8Array([0xf0, 0x00]); // id=15 (uncompressed) then not enough data
  assert.throws(() => aecDecode(uncompressed, { bitsPerSample: 12, blockSize: 32, rsi: 128, flags: 14 }, 32), AecError);
});

test('CCSDS decoder handles a hand-built zero block', () => {
  // idLen=4 for 12-bit samples. id=0 → low entropy, sub-bit 0 → zero block,
  // reference sample (12 bits, preprocess on) = 0x123, then fs "1" → zeroBlocks=1
  // (single block of 32 zeros minus the reference).
  // Bits: 0000 0 000100100011 1 → pad
  const bits = '0000' + '0' + '000100100011' + '1';
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const bytes = new Uint8Array(padded.length / 8);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  const out = aecDecode(bytes, { bitsPerSample: 12, blockSize: 32, rsi: 128, flags: 14 }, 32);
  assert.equal(out.length, 32);
  assert.equal(out[0], 0x123); // reference sample passes through the preprocessor unchanged
  // Zero deltas map back to the reference value under the unsigned preprocessor.
  for (let i = 1; i < 32; i++) assert.equal(out[i], 0x123);
});
