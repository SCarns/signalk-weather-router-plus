/**
 * CCSDS 121.0-B lossless (Adaptive Entropy Coding / extended Rice)
 * decoder, as used by GRIB2 data representation template 5.42.
 *
 * This is a TypeScript port of the decoder in libaec (Mathis Rosenhauer
 * et al., BSD-2-Clause), `src/decode.c`, which is what eccodes calls to
 * unpack `grid_ccsds` messages. Every branch below corresponds to a
 * state in libaec's finite-state machine; the fast/slow path duality of
 * the C code is collapsed because the whole compressed buffer is
 * available up front.
 *
 * Output samples are the unsigned integers the GRIB2 packer stored
 * (the "X" of regulation 92.9.4); scaling back to physical values is
 * the caller's job.
 */

export const AEC_DATA_SIGNED = 1;
export const AEC_DATA_3BYTE = 2;
export const AEC_DATA_MSB = 4;
export const AEC_DATA_PREPROCESS = 8;
export const AEC_RESTRICTED = 16;
export const AEC_PAD_RSI = 32;

/** Second-extension option: maximum fundamental-sequence value. */
const SE_TABLE_SIZE = 90;
/** Zero-block "remainder of segment" code. */
const ROS = 5;

export interface AecParams {
  /** Bits per uncompressed sample (GRIB2 octet 20 of template 5.42). */
  bitsPerSample: number;
  /** Samples per block (octet 23). */
  blockSize: number;
  /** Blocks per reference sample interval (octets 24-25). */
  rsi: number;
  /** libaec option flags (octet 22). */
  flags: number;
}

export class AecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AecError';
  }
}

/**
 * MSB-first bit reader over a byte buffer. Accumulates whole bytes into
 * a JS number (exact to 2^53), so reads of up to 32 bits are exact.
 */
class BitReader {
  private bytePos = 0;
  private acc = 0;
  private nbits = 0;

  constructor(private readonly buf: Uint8Array) {}

  /** Read `n` bits (1..32) as an unsigned integer. */
  readBits(n: number): number {
    while (this.nbits < n) {
      if (this.bytePos >= this.buf.length) {
        throw new AecError(
          `compressed stream exhausted (need ${n} bits, have ${this.nbits})`,
        );
      }
      this.acc = this.acc * 256 + this.buf[this.bytePos++];
      this.nbits += 8;
    }
    const rem = this.nbits - n;
    const div = 2 ** rem;
    const value = Math.floor(this.acc / div);
    this.acc -= value * div;
    this.nbits = rem;
    return value;
  }

  /**
   * Fundamental sequence: count zero bits up to and including the
   * terminating one bit; return the count of zeros.
   */
  readFs(): number {
    let zeros = 0;
    for (;;) {
      if (this.nbits === 0) {
        if (this.bytePos >= this.buf.length) {
          throw new AecError('compressed stream exhausted inside fundamental sequence');
        }
        this.acc = this.buf[this.bytePos++];
        this.nbits = 8;
      }
      const top = 2 ** (this.nbits - 1);
      if (this.acc >= top) {
        this.acc -= top;
        this.nbits--;
        return zeros;
      }
      this.nbits--;
      zeros++;
      if (zeros > 4096) {
        throw new AecError('fundamental sequence longer than 4096 zeros; stream is corrupt');
      }
    }
  }

  /** Drop bits to the next byte boundary (AEC_PAD_RSI). */
  alignToByte(): void {
    const drop = this.nbits % 8;
    if (drop) {
      const div = 2 ** (this.nbits - drop);
      this.acc = this.acc % div;
      this.nbits -= drop;
    }
  }
}

function createSeTable(): Int32Array {
  // libaec create_se_table: maps a second-extension code m to the
  // (i, ms) pair it was built from.
  const table = new Int32Array(2 * (SE_TABLE_SIZE + 1));
  let k = 0;
  for (let i = 0; i < 13; i++) {
    const ms = k;
    for (let j = 0; j <= i; j++) {
      table[2 * k] = i;
      table[2 * k + 1] = ms;
      k++;
    }
  }
  return table;
}

const SE_TABLE = createSeTable();

/** Per-option block counts, for test coverage reporting. */
export interface AecStats {
  zeroBlocks: number;
  secondExtension: number;
  /** Indexed by k (split bits). */
  split: number[];
  uncompressed: number;
  rsiFlushes: number;
}

/**
 * Decode `nSamples` samples from a CCSDS 121.0-B stream.
 *
 * Throws AecError on any configuration the reference decoder rejects,
 * on a corrupt stream, or if the stream ends before `nSamples` have
 * been produced. Never returns partial data.
 */
export function aecDecode(
  input: Uint8Array,
  p: AecParams,
  nSamples: number,
  stats?: AecStats,
): Uint32Array {
  const { bitsPerSample: bps, blockSize, rsi, flags } = p;

  // aec_decode_init configuration checks.
  if (bps > 32 || bps === 0) throw new AecError(`bits_per_sample ${bps} out of range 1..32`);
  if (rsi === 0 || rsi > 4096) throw new AecError(`rsi ${rsi} out of range 1..4096`);
  if (blockSize & 1 || blockSize > 256 || blockSize === 0) {
    throw new AecError(`block_size ${blockSize} must be even and in 2..256`);
  }
  if (!Number.isInteger(nSamples) || nSamples < 0) {
    throw new AecError(`nSamples ${nSamples} invalid`);
  }

  let idLen: number;
  if (bps > 16) {
    idLen = 5;
  } else if (bps > 8) {
    idLen = 4;
  } else if (flags & AEC_RESTRICTED) {
    if (bps <= 2) idLen = 1;
    else if (bps <= 4) idLen = 2;
    else throw new AecError('AEC_RESTRICTED requires bits_per_sample <= 4');
  } else {
    idLen = 3;
  }

  const signed = (flags & AEC_DATA_SIGNED) !== 0;
  // xmax / xmin as in aec_decode_init. For unsigned data xmin is 0.
  const xmax = signed ? 2 ** (bps - 1) - 1 : 2 ** bps - 1;
  const idUncomp = 2 ** idLen - 1;

  const pp = (flags & AEC_DATA_PREPROCESS) !== 0;
  const rsiSize = rsi * blockSize;
  const rsiBuf = new Uint32Array(rsiSize);
  let rsip = 0; // samples currently in rsiBuf
  let ref = pp ? 1 : 0;
  let ebs = blockSize - ref; // encoded block size

  const out = new Uint32Array(nSamples);
  let produced = 0; // samples flushed into `out`

  const reader = new BitReader(input);

  const put = (s: number): void => {
    rsiBuf[rsip++] = s >>> 0;
  };

  /**
   * Post-process (undo the preprocessor's prediction mapping) one
   * reference-sample interval and append it to `out`, truncated to
   * nSamples. Mirrors the FLUSH macro in libaec.
   */
  const flush = (): void => {
    const n = Math.min(rsip, nSamples - produced);
    if (n <= 0) return;
    if (!pp) {
      for (let i = 0; i < n; i++) out[produced + i] = rsiBuf[i];
      produced += n;
      return;
    }
    // First sample of the interval is the reference sample.
    let data = rsiBuf[0];
    if (signed) {
      const m = 2 ** (bps - 1);
      // Sign-extend the reference sample, then keep it as int32 semantics.
      data = ((data ^ m) - m) | 0;
    }
    out[produced] = data >>> 0;

    if (!signed) {
      // xmin == 0 branch.
      const med = Math.floor(xmax / 2) + 1;
      let d32 = data >>> 0;
      for (let i = 1; i < n; i++) {
        const d = rsiBuf[i];
        const halfD = (d >>> 1) + (d & 1);
        const mask = (d32 & med) !== 0 ? xmax : 0;
        if (halfD <= ((mask ^ d32) >>> 0)) {
          const t = d & 1 ? ~(d >>> 1) : d >>> 1;
          d32 = (d32 + t) >>> 0;
        } else {
          d32 = (mask ^ d) >>> 0;
        }
        out[produced + i] = d32;
      }
    } else {
      let dI = data | 0;
      for (let i = 1; i < n; i++) {
        const d = rsiBuf[i];
        const halfD = (d >>> 1) + (d & 1);
        const t = d & 1 ? ~(d >>> 1) : d >>> 1;
        if (dI < 0) {
          if (halfD <= xmax + dI + 1) dI = (dI + t) | 0;
          else dI = (d - xmax - 1) | 0;
        } else if (halfD <= xmax - dI) {
          dI = (dI + t) | 0;
        } else {
          dI = (xmax - d) | 0;
        }
        out[produced + i] = dI >>> 0;
      }
    }
    produced += n;
  };

  /** m_next_cds: called before every block except the first. */
  const nextCds = (): void => {
    if (rsip === rsiSize) {
      if (stats) stats.rsiFlushes++;
      flush();
      rsip = 0;
      if (pp) {
        ref = 1;
        ebs = blockSize - 1;
      }
      if (flags & AEC_PAD_RSI) reader.alignToByte();
    } else {
      ref = 0;
      ebs = blockSize;
    }
  };

  let first = true;
  while (produced + rsip < nSamples) {
    if (!first) nextCds();
    first = false;

    const id = reader.readBits(idLen);

    if (id === 0) {
      // Low-entropy options.
      const sub = reader.readBits(1);
      if (ref) put(reader.readBits(bps));
      if (sub === 1) {
        // Second-extension option (m_se).
        if (stats) stats.secondExtension++;
        let i = ref;
        while (i < blockSize) {
          const m = reader.readFs();
          if (m > SE_TABLE_SIZE) throw new AecError(`second-extension code ${m} > ${SE_TABLE_SIZE}`);
          const d1 = m - SE_TABLE[2 * m + 1];
          if ((i & 1) === 0) {
            put(SE_TABLE[2 * m] - d1);
            i++;
          }
          put(d1);
          i++;
        }
      } else {
        // Zero-block option (m_zero_block).
        if (stats) stats.zeroBlocks++;
        let zeroBlocks = reader.readFs() + 1;
        if (zeroBlocks === ROS) {
          const b = Math.floor(rsip / blockSize);
          zeroBlocks = Math.min(rsi - b, 64 - (b % 64));
        } else if (zeroBlocks > ROS) {
          zeroBlocks--;
        }
        const zeroSamples = zeroBlocks * blockSize - ref;
        if (rsiSize - rsip < zeroSamples) {
          throw new AecError(
            `zero block of ${zeroSamples} samples overruns the reference sample interval`,
          );
        }
        rsiBuf.fill(0, rsip, rsip + zeroSamples);
        rsip += zeroSamples;
      }
    } else if (id === idUncomp) {
      // Uncompressed block (m_uncomp): block_size raw samples, the
      // reference sample (if any) is simply the first of them.
      if (stats) stats.uncompressed++;
      for (let i = 0; i < blockSize; i++) put(reader.readBits(bps));
    } else {
      // Sample-splitting option with k = id - 1 split bits (m_split).
      const k = id - 1;
      if (stats) stats.split[k] = (stats.split[k] ?? 0) + 1;
      if (ref) put(reader.readBits(bps));
      const base = rsip;
      for (let i = 0; i < ebs; i++) {
        rsiBuf[base + i] = (reader.readFs() << k) >>> 0;
      }
      if (k) {
        for (let i = 0; i < ebs; i++) {
          rsiBuf[base + i] = (rsiBuf[base + i] + reader.readBits(k)) >>> 0;
        }
      }
      rsip += ebs;
    }
  }

  flush();
  if (produced !== nSamples) {
    throw new AecError(`decoded ${produced} samples, expected ${nSamples}`);
  }
  return out;
}
