/**
 * Test fixtures for the mesh archives (mesharchive.ts): a tar written as
 * GNU tar writes one (512-byte headers with checksums, data padded, two
 * zero blocks at the end; a GNU long-name entry for a name over 100
 * bytes), and zstd compression through node:zlib.
 */

import * as zlib from 'node:zlib';

export interface TarEntry {
  name: string;
  /** File contents; absent for a folder. */
  data?: Buffer;
  /** Header type to write instead ('L', 'x', '2', …): for tests of entries the reader refuses. */
  type?: string;
}

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar  \0', 257); // GNU magic and version
  h.fill(32, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function padded(data: Buffer): Buffer {
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([data, Buffer.alloc(pad)]);
}

/** A tar of the entries, with the end marker unless `end` is false. */
export function tarOf(entries: TarEntry[], end = true): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const isDir = e.data === undefined && !e.type;
    const data = e.data ?? Buffer.alloc(0);
    let name = isDir && !e.name.endsWith('/') ? `${e.name}/` : e.name;
    if (Buffer.byteLength(name) > 100) {
      const long = Buffer.from(name + '\0');
      parts.push(header('././@LongLink', long.length, 'L'), padded(long));
      name = name.slice(0, 100);
    }
    parts.push(header(name, data.length, e.type ?? (isDir ? '5' : '0')));
    if (data.length) parts.push(padded(data));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** zstd of a buffer (Node 22.15+). */
export function zstd(b: Buffer): Buffer {
  const fn = (zlib as unknown as { zstdCompressSync: (b: Buffer, o?: object) => Buffer }).zstdCompressSync;
  return fn(b, { params: { [(zlib.constants as unknown as Record<string, number>).ZSTD_c_checksumFlag]: 1 } });
}
