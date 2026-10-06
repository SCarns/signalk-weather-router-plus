/**
 * Blosc1 chunk decompressor, pure TypeScript (no native module).
 *
 * Implements the c-blosc 1.x decompression path (blosc/blosc.c
 * `blosc_run_decompression_with_context`, `serial_blosc`, `blosc_d`;
 * README_CHUNK_FORMAT.rst) for the codecs Zarr v2 stores use most:
 *
 *   header (16 bytes, little endian)
 *     0  version      (format version; c-blosc 1.x writes 2)
 *     1  versionlz    (codec format version)
 *     2  flags        bit0 byte-shuffle, bit1 memcpyed, bit2 bit-shuffle,
 *                     bit3 reserved (must be 0), bit4 blocks not split,
 *                     bits5-7 codec: 0 blosclz, 1 lz4/lz4hc, 2 snappy,
 *                     3 zlib, 4 zstd
 *     3  typesize
 *     4  nbytes       uncompressed size
 *     8  blocksize
 *     12 cbytes       compressed size including the header
 *
 *   memcpyed: the nbytes of data follow the header verbatim.
 *   otherwise: int32 bstarts[nblocks] (absolute offsets into the chunk),
 *     then per block `nsplits` streams, each an int32 compressed size and
 *     the stream; a stream whose compressed size equals its uncompressed
 *     size is stored raw. A block is split into `typesize` streams unless
 *     flag bit 4 is set, typesize > 16, blocksize / typesize < 128, or it
 *     is the last, partial block.
 *   After decompression a block is byte-unshuffled (bit 0, typesize > 1)
 *   or bit-unshuffled (bit 2, blocksize >= typesize).
 *
 * Only the LZ4 codec (block format; lz4 and lz4hc share it) is
 * implemented; any other codec fails with a clear error.
 */

export class BloscError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BloscError';
  }
}

const BLOSC_DOSHUFFLE = 0x01;
const BLOSC_MEMCPYED = 0x02;
const BLOSC_DOBITSHUFFLE = 0x04;
const BLOSC_RESERVED = 0x08;
const BLOSC_DONT_SPLIT = 0x10;
const MIN_BUFFERSIZE = 128;
const MAX_SPLITS = 16;
const HEADER = 16;
const CODEC_NAMES = ['blosclz', 'lz4', 'snappy', 'zlib', 'zstd'];

export interface BloscHeader {
  version: number;
  versionlz: number;
  flags: number;
  typesize: number;
  nbytes: number;
  blocksize: number;
  cbytes: number;
  codec: string;
  shuffle: 'none' | 'byte' | 'bit';
  memcpyed: boolean;
  dontSplit: boolean;
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function i32(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

export function readBloscHeader(src: Uint8Array): BloscHeader {
  if (src.length < HEADER) throw new BloscError(`blosc: ${src.length} bytes is shorter than the 16-byte header`);
  const flags = src[2];
  const codecId = flags >> 5;
  return {
    version: src[0],
    versionlz: src[1],
    flags,
    typesize: src[3],
    nbytes: u32(src, 4),
    blocksize: u32(src, 8),
    cbytes: u32(src, 12),
    codec: CODEC_NAMES[codecId] ?? `unknown(${codecId})`,
    shuffle: flags & BLOSC_DOSHUFFLE ? 'byte' : flags & BLOSC_DOBITSHUFFLE ? 'bit' : 'none',
    memcpyed: (flags & BLOSC_MEMCPYED) !== 0,
    dontSplit: (flags & BLOSC_DONT_SPLIT) !== 0,
  };
}

/**
 * LZ4 block format decoder: decompress `src[sOff, sOff + sLen)` into
 * `dst[dOff, dOff + dLen)`. The block must decode to exactly `dLen`
 * bytes (as c-blosc requires); returns the number of bytes written.
 */
export function lz4DecompressBlock(src: Uint8Array, sOff: number, sLen: number, dst: Uint8Array, dOff: number, dLen: number): number {
  const sEnd = sOff + sLen;
  const dEnd = dOff + dLen;
  let s = sOff;
  let d = dOff;
  if (sLen <= 0) throw new BloscError('lz4: empty block');
  for (;;) {
    if (s >= sEnd) throw new BloscError('lz4: truncated block (no token)');
    const token = src[s++];
    // Literals.
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b: number;
      do {
        if (s >= sEnd) throw new BloscError('lz4: truncated literal length');
        b = src[s++];
        litLen += b;
      } while (b === 255);
    }
    if (litLen > 0) {
      if (s + litLen > sEnd) throw new BloscError('lz4: literals run past the end of the input');
      if (d + litLen > dEnd) throw new BloscError('lz4: literals overflow the output');
      dst.set(src.subarray(s, s + litLen), d);
      s += litLen;
      d += litLen;
    }
    // The last sequence has literals only and ends the block.
    if (s === sEnd) break;
    // Match.
    if (s + 2 > sEnd) throw new BloscError('lz4: truncated match offset');
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0) throw new BloscError('lz4: zero match offset');
    if (d - offset < dOff) throw new BloscError('lz4: match offset before the start of the output');
    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b: number;
      do {
        if (s >= sEnd) throw new BloscError('lz4: truncated match length');
        b = src[s++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;
    if (d + matchLen > dEnd) throw new BloscError('lz4: match overflows the output');
    let m = d - offset;
    if (offset >= matchLen) {
      dst.copyWithin(d, m, m + matchLen);
      d += matchLen;
    } else {
      // Overlapping copy (run-length style): byte by byte.
      const end = d + matchLen;
      while (d < end) dst[d++] = dst[m++];
    }
  }
  return d - dOff;
}

/** Inverse of the byte shuffle (shuffle_generic / unshuffle_generic_inline). */
export function byteUnshuffle(typesize: number, blocksize: number, src: Uint8Array, sOff: number, dst: Uint8Array, dOff: number): void {
  const neblock = Math.floor(blocksize / typesize);
  const rem = blocksize % typesize;
  for (let j = 0; j < typesize; j++) {
    const base = sOff + j * neblock;
    for (let i = 0; i < neblock; i++) dst[dOff + i * typesize + j] = src[base + i];
  }
  // Leftover bytes (blocksize not a multiple of typesize) were not shuffled.
  for (let k = blocksize - rem; k < blocksize; k++) dst[dOff + k] = src[sOff + k];
}

/**
 * Inverse of the bit shuffle (c-blosc blosc_internal_bitunshuffle with
 * the scalar bitshuffle kernels bshuf_trans_byte_bitrow_scal then
 * bshuf_shuffle_bit_eightelem_scal). Only a block holding a multiple of
 * 8 elements is bit-shuffled; otherwise it was copied as is.
 */
export function bitUnshuffle(typesize: number, blocksize: number, src: Uint8Array, sOff: number, dst: Uint8Array, dOff: number): void {
  const size = Math.floor(blocksize / typesize);
  if (size % 8 !== 0) {
    dst.set(src.subarray(sOff, sOff + blocksize), dOff);
    return;
  }
  const E = typesize;
  const nbyteRow = size / 8;
  const nbyte = size * E;
  // Transpose the bytes of the 8·E bit rows (scratch reused across calls).
  const tmp = scratchBytes('bit', nbyte);
  for (let jj = 0; jj < E; jj++) {
    for (let ii = 0; ii < nbyteRow; ii++) {
      for (let kk = 0; kk < 8; kk++) tmp[ii * 8 * E + jj * 8 + kk] = src[sOff + (jj * 8 + kk) * nbyteRow + ii];
    }
  }
  // Transpose the bits of each 8×8 bit matrix (TRANS_BIT_8X8 on a
  // little-endian uint64: bit c of byte r ↔ bit r of byte c), writing
  // byte kk of the result to element kk.
  const x = bitX;
  for (let jj = 0; jj < 8 * E; jj += 8) {
    for (let ii = 0; ii + 8 * E - 1 < nbyte; ii += 8 * E) {
      for (let c = 0; c < 8; c++) {
        let v = 0;
        for (let r = 0; r < 8; r++) v |= ((tmp[ii + jj + r] >> c) & 1) << r;
        x[c] = v;
      }
      for (let kk = 0; kk < 8; kk++) dst[dOff + ii + jj / 8 + kk * E] = x[kk];
    }
  }
  const offset = size * E;
  for (let k = offset; k < blocksize; k++) dst[dOff + k] = src[sOff + k];
}

/**
 * Scratch buffers reused across calls (one set per thread: each worker has
 * its own module instance). Without them every chunk allocated and freed
 * its own block buffer and bit-transpose buffer, and a tile worker decoding
 * thousands of chunks churned that through the allocator, which keeps the
 * freed space (brain, 2026-10-06: +375 MB of glibc arenas with the
 * prebuilder on). A scratch grows when a larger size is needed and is then
 * kept at that size.
 */
const scratch: Record<string, Uint8Array> = {};
function scratchBytes(key: string, n: number): Uint8Array {
  const b = scratch[key];
  if (b && b.length >= n) return b;
  const grown = new Uint8Array(n);
  scratch[key] = grown;
  return grown;
}
const bitX = new Uint8Array(8);

/**
 * Decompress a whole Blosc1 chunk. With `out` (at least `nbytes` long) the
 * data are written there and the returned array is its first `nbytes` bytes;
 * without it a new array is returned.
 */
export function bloscDecompress(src: Uint8Array, out?: Uint8Array): Uint8Array {
  const h = readBloscHeader(src);
  if (h.version === 0 || h.version > 2) {
    throw new BloscError(
      `blosc: format version ${h.version} is not supported (Blosc1 format versions 1 and 2 only; Blosc2 frames are not)`
    );
  }
  if (h.flags & BLOSC_RESERVED) throw new BloscError('blosc: reserved flag bit 3 is set (chunk from a newer format)');
  const { nbytes, blocksize, cbytes, typesize } = h;
  if (cbytes > src.length) throw new BloscError(`blosc: header says ${cbytes} compressed bytes but only ${src.length} are present`);
  if (typesize <= 0) throw new BloscError('blosc: typesize 0');
  if (out !== undefined && out.length < nbytes)
    throw new BloscError(`blosc: output buffer of ${out.length} bytes is shorter than ${nbytes}`);
  out = out === undefined ? new Uint8Array(nbytes) : out.subarray(0, nbytes);
  if (nbytes === 0) return out;
  if (h.memcpyed) {
    if (nbytes + HEADER !== cbytes)
      throw new BloscError(`blosc: memcpyed chunk of ${nbytes} bytes has cbytes ${cbytes} (want ${nbytes + HEADER})`);
    out.set(src.subarray(HEADER, HEADER + nbytes));
    return out;
  }
  if (blocksize <= 0 || blocksize > nbytes) throw new BloscError(`blosc: invalid blocksize ${blocksize} for ${nbytes} bytes`);
  const codecId = h.flags >> 5;
  if (codecId !== 1) throw new BloscError(`blosc: codec ${h.codec} is not supported (only lz4)`);
  const leftover = nbytes % blocksize;
  const nblocks = Math.floor(nbytes / blocksize) + (leftover > 0 ? 1 : 0);
  if (nblocks > (cbytes - HEADER) / 4) throw new BloscError('blosc: chunk too short for its block-start table');
  const doShuffle = (h.flags & BLOSC_DOSHUFFLE) !== 0 && typesize > 1;
  const tmp = scratchBytes('block', blocksize);
  for (let j = 0; j < nblocks; j++) {
    const isLeftover = j === nblocks - 1 && leftover > 0;
    const bsize = isLeftover ? leftover : blocksize;
    const doBitShuffle = (h.flags & BLOSC_DOBITSHUFFLE) !== 0 && bsize >= typesize;
    const unshuffle = doShuffle || doBitShuffle;
    const dOff = j * blocksize;
    // Destination of the codec output: straight into `out`, or a scratch
    // block when an unshuffle follows.
    const target = unshuffle ? tmp : out;
    const tBase = unshuffle ? 0 : dOff;
    let srcOff = i32(src, HEADER + 4 * j);
    const nsplits = !h.dontSplit && typesize <= MAX_SPLITS && Math.floor(bsize / typesize) >= MIN_BUFFERSIZE && !isLeftover ? typesize : 1;
    const neblock = Math.floor(bsize / nsplits);
    let written = 0;
    for (let s = 0; s < nsplits; s++) {
      if (srcOff < 0 || srcOff > cbytes - 4) throw new BloscError(`blosc: block ${j} stream ${s} offset ${srcOff} out of range`);
      const cs = i32(src, srcOff);
      srcOff += 4;
      if (cs < 0 || cs > cbytes - srcOff) throw new BloscError(`blosc: block ${j} stream ${s} compressed size ${cs} out of range`);
      if (cs === neblock) {
        target.set(src.subarray(srcOff, srcOff + neblock), tBase + written);
      } else {
        const n = lz4DecompressBlock(src, srcOff, cs, target, tBase + written, neblock);
        if (n !== neblock) throw new BloscError(`blosc: block ${j} stream ${s} decoded to ${n} bytes, want ${neblock}`);
      }
      srcOff += cs;
      written += neblock;
    }
    if (written !== bsize) throw new BloscError(`blosc: block ${j} decoded to ${written} bytes, want ${bsize}`);
    if (doShuffle) byteUnshuffle(typesize, bsize, tmp, 0, out, dOff);
    else if (doBitShuffle) bitUnshuffle(typesize, bsize, tmp, 0, out, dOff);
  }
  return out;
}
