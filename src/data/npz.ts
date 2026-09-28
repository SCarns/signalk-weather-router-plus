/**
 * Reader for numpy `.npz` archives (a ZIP of `.npy` members, stored or
 * deflated) and the `.npy` format (v1.0 to v3.0 headers). Supports the
 * dtypes the routing data uses: little-endian float32/float64,
 * int32/int64, bool, and fixed-width Unicode strings (`<U4`).
 *
 * Only the pieces of ZIP needed for numpy output are implemented:
 * local file headers + central directory, methods 0 (store) and 8
 * (deflate), no encryption, no ZIP64 beyond what fits in 32 bits.
 */

import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

export type NpyArray =
  | { kind: 'f32'; shape: number[]; data: Float32Array }
  | { kind: 'f64'; shape: number[]; data: Float64Array }
  | { kind: 'i32'; shape: number[]; data: Int32Array }
  | { kind: 'i64'; shape: number[]; data: BigInt64Array }
  | { kind: 'bool'; shape: number[]; data: Uint8Array }
  | { kind: 'str'; shape: number[]; data: string[] };

export class NpzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NpzError';
  }
}

/** Parse one `.npy` buffer. */
export function parseNpy(buf: Buffer): NpyArray {
  if (buf.length < 10 || buf[0] !== 0x93 || buf.toString('latin1', 1, 6) !== 'NUMPY') {
    throw new NpzError('not an .npy buffer');
  }
  const major = buf[6];
  let headerLen: number;
  let dataStart: number;
  if (major === 1) {
    headerLen = buf.readUInt16LE(8);
    dataStart = 10 + headerLen;
  } else if (major === 2 || major === 3) {
    headerLen = buf.readUInt32LE(8);
    dataStart = 12 + headerLen;
  } else {
    throw new NpzError(`unsupported .npy version ${major}`);
  }
  const header = buf.toString(major === 3 ? 'utf8' : 'latin1', dataStart - headerLen, dataStart);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeStr = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || !fortran || shapeStr === undefined) throw new NpzError(`unparseable .npy header: ${header}`);
  if (fortran === 'True') throw new NpzError('Fortran-ordered arrays are not supported');
  const shape = shapeStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const data = buf.subarray(dataStart);

  const le = descr[0] === '<' || descr[0] === '|';
  const code = descr.replace(/^[<>|=]/, '');
  const toArrayBuffer = (bytesPer: number): ArrayBuffer => {
    const need = count * bytesPer;
    if (data.length < need) throw new NpzError(`.npy data truncated: need ${need} bytes, have ${data.length}`);
    // Copy into an aligned standalone ArrayBuffer.
    const out = new ArrayBuffer(need);
    new Uint8Array(out).set(data.subarray(0, need));
    return out;
  };
  if (!le && !code.startsWith('U') && code !== 'b1') throw new NpzError(`big-endian dtype ${descr} not supported`);
  if (code === 'f4') return { kind: 'f32', shape, data: new Float32Array(toArrayBuffer(4)) };
  if (code === 'f8') return { kind: 'f64', shape, data: new Float64Array(toArrayBuffer(8)) };
  if (code === 'i4') return { kind: 'i32', shape, data: new Int32Array(toArrayBuffer(4)) };
  if (code === 'i8') return { kind: 'i64', shape, data: new BigInt64Array(toArrayBuffer(8)) };
  if (code === 'b1') return { kind: 'bool', shape, data: new Uint8Array(toArrayBuffer(1)) };
  const u = /^U(\d+)$/.exec(code);
  if (u) {
    const chars = Number(u[1]);
    const strs: string[] = [];
    const bytesPer = chars * 4;
    for (let i = 0; i < count; i++) {
      let s = '';
      for (let c = 0; c < chars; c++) {
        const cp = data.readUInt32LE(i * bytesPer + c * 4);
        if (cp === 0) break;
        s += String.fromCodePoint(cp);
      }
      strs.push(s);
    }
    return { kind: 'str', shape, data: strs };
  }
  throw new NpzError(`dtype ${descr} not supported`);
}

/** Read every `.npy` member of an `.npz` file, keyed by name without the extension. */
export function readNpz(filePath: string): Map<string, NpyArray> {
  const buf = fs.readFileSync(filePath);
  // Locate the end-of-central-directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new NpzError(`${filePath}: not a ZIP archive`);
  const entries = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, NpyArray>();
  for (let e = 0; e < entries; e++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new NpzError(`${filePath}: bad central directory entry`);
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOff = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    cd += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new NpzError(`${filePath}: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + compSize);
    let member: Buffer;
    if (method === 0) member = raw;
    else if (method === 8) member = zlib.inflateRawSync(raw);
    else throw new NpzError(`${filePath}: ZIP method ${method} not supported for ${name}`);
    if (name.endsWith('.npy')) out.set(name.slice(0, -4), parseNpy(member));
  }
  return out;
}
