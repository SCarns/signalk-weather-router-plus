/**
 * Value-for-value verification of the TypeScript GRIB2/CCSDS decoder
 * against eccodes.
 *
 * Expects a corpus directory containing, per message:
 *   <name>.grib2  raw GRIB2 message (one message per file)
 *   <name>.json   eccodes keys (shortName, step, Ni, Nj, missingValue, ...)
 *   <name>.f64    eccodes codes_get_values() as little-endian float64
 *
 * Usage: node --import tsx tools/verify_grib_corpus.ts <corpus-dir>
 * Exit code 0 only if every message decodes and matches exactly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseGrib2Message } from '../src/grib/grib2';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: verify_grib_corpus.ts <corpus-dir>');
  process.exit(2);
}

interface Truth {
  shortName: string;
  step: number | string;
  Ni: number;
  Nj: number;
  numberOfValues: number;
  numberOfDataPoints: number;
  missingValue: number;
  bitmapPresent: number;
  referenceValue: number;
  binaryScaleFactor: number;
  decimalScaleFactor: number;
  bitsPerValue: number;
  ccsdsFlags: number;
  ccsdsBlockSize: number;
  ccsdsRsi: number;
  discipline: number;
  parameterCategory: number;
  parameterNumber: number;
  forecastTime: number;
  dataDate: number;
  dataTime: number;
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.grib2')).sort();
if (files.length === 0) {
  console.error(`no .grib2 files in ${dir}`);
  process.exit(2);
}

let failures = 0;
let totalCells = 0;
let totalExact = 0;
const t0 = Date.now();

for (const f of files) {
  const base = f.slice(0, -6);
  const buf = new Uint8Array(fs.readFileSync(path.join(dir, f)));
  const truth = JSON.parse(fs.readFileSync(path.join(dir, base + '.json'), 'utf8')) as Truth;
  const truthRaw = fs.readFileSync(path.join(dir, base + '.f64'));
  const truthVals = new Float64Array(truthRaw.buffer, truthRaw.byteOffset, truthRaw.byteLength / 8);

  let line = `${base.padEnd(38)}`;
  try {
    const msg = parseGrib2Message(buf);
    const problems: string[] = [];
    const check = (name: string, got: unknown, want: unknown) => {
      if (got !== want) problems.push(`${name}: got ${String(got)} want ${String(want)}`);
    };
    check('Ni', msg.grid.ni, truth.Ni);
    check('Nj', msg.grid.nj, truth.Nj);
    check('numberOfValues', msg.packing.numberOfValues, truth.numberOfValues);
    check('numberOfDataPoints', msg.numberOfDataPoints, truth.numberOfDataPoints);
    check('bitmap', msg.hasBitmap, truth.bitmapPresent === 1);
    check('bitsPerValue', msg.packing.bitsPerValue, truth.bitsPerValue);
    check('binaryScaleFactor', msg.packing.binaryScaleFactor, truth.binaryScaleFactor);
    check('decimalScaleFactor', msg.packing.decimalScaleFactor, truth.decimalScaleFactor);
    check('referenceValue', msg.packing.referenceValue, truth.referenceValue);
    if (msg.packing.ccsds) {
      check('ccsdsFlags', msg.packing.ccsds.flags, truth.ccsdsFlags);
      check('ccsdsBlockSize', msg.packing.ccsds.blockSize, truth.ccsdsBlockSize);
      check('ccsdsRsi', msg.packing.ccsds.rsi, truth.ccsdsRsi);
    }
    check('discipline', msg.discipline, truth.discipline);
    check('parameterCategory', msg.product.parameterCategory, truth.parameterCategory);
    check('parameterNumber', msg.product.parameterNumber, truth.parameterNumber);
    check('forecastHours', msg.product.forecastHours, Number(truth.step));
    const yyyymmdd = truth.dataDate;
    const hhmm = truth.dataTime;
    const want = Date.UTC(
      Math.floor(yyyymmdd / 10000), Math.floor((yyyymmdd % 10000) / 100) - 1, yyyymmdd % 100,
      Math.floor(hhmm / 100), hhmm % 100, 0,
    );
    check('referenceTime', msg.referenceTime.getTime(), want);

    const tDec = Date.now();
    const vals = msg.decode();
    const decodeMs = Date.now() - tDec;

    if (vals.length !== truthVals.length) {
      problems.push(`length: got ${vals.length} want ${truthVals.length}`);
    } else {
      let exact = 0;
      let maxAbs = 0;
      let maxAt = -1;
      let missingMismatch = 0;
      for (let i = 0; i < vals.length; i++) {
        const t = truthVals[i];
        const v = vals[i];
        const tMissing = truth.bitmapPresent === 1 && t === truth.missingValue;
        if (tMissing || Number.isNaN(v)) {
          if (!(tMissing && Number.isNaN(v))) missingMismatch++;
          else exact++;
          continue;
        }
        if (v === t) {
          exact++;
        } else {
          const d = Math.abs(v - t);
          if (d > maxAbs) {
            maxAbs = d;
            maxAt = i;
          }
        }
      }
      totalCells += vals.length;
      totalExact += exact;
      if (missingMismatch) problems.push(`missing-value mismatches: ${missingMismatch}`);
      if (exact !== vals.length) {
        problems.push(`inexact: ${vals.length - exact} cells, max |diff| ${maxAbs} at ${maxAt} (got ${vals[maxAt]} want ${truthVals[maxAt]})`);
      }
      line += ` ${String(vals.length).padStart(8)} cells  exact ${String(exact).padStart(8)}  ${String(decodeMs).padStart(5)} ms`;
    }
    if (problems.length) {
      failures++;
      line += `\n    FAIL ${problems.join('; ')}`;
    } else {
      line += '  OK';
    }
  } catch (err) {
    failures++;
    line += `\n    ERROR ${(err as Error).name}: ${(err as Error).message}`;
  }
  console.log(line);
}

console.log(`\n${files.length} messages, ${totalCells} cells, ${totalExact} exact, ${failures} failing, ${Date.now() - t0} ms`);
process.exit(failures ? 1 : 0);
