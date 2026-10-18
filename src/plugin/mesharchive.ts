/**
 * One published mesh as its archive (the catalogue's `archive`, a
 * `.tar.zst` of the mesh folder): downloaded with Range resume, unpacked
 * into a folder, and checked against the catalogue. Runs in a child
 * process (childtask.ts `mesh-download`); plugin/meshes.ts writes the
 * marker and swaps the folder in.
 *
 * Working files live in a hidden folder beside the store's meshes
 * (`<store>/.dl-<name>/`): the archive while it downloads (`archive.part`)
 * and once complete (`archive.tar.zst`), `state.json` (what the archive is:
 * URL, build, size and ETag; a change starts the download over) and
 * `progress.json` (for the panel). The archive stays until the mesh is in
 * place, so a stopped download resumes where it stopped (the owner's
 * choice, 2026-10-18).
 *
 * Unpacking needs zstd in node:zlib (Node 22.15 and later). The tar reader
 * is the plugin's own: plain files and folders, GNU long names; anything
 * else, or a path leaving the mesh folder, fails the download and names
 * the entry. zstd's own checksum catches a damaged archive; the tiles the
 * unpacked indexes list must all be there and add up to the catalogue's
 * `bytes`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

/** The child task: one mesh archive downloaded and unpacked into `dest`. */
export interface MeshDownloadTask {
  task: 'mesh-download';
  /** The archive's URL. */
  url: string;
  /** The working folder (`<store>/.dl-<name>`). */
  work: string;
  /** The folder the mesh is unpacked into (`<store>/<name>.new`). */
  dest: string;
  /** The archive's top folder (`<name>_mesh`), stripped when unpacking. */
  top: string;
  /** The catalogue's build date and unpacked tile bytes. */
  build: string;
  bytes: number;
  /** Start over: the working folder and `dest` are emptied first ("Download again"). */
  fresh?: boolean;
}

export interface MeshDownloadResult {
  files: number;
  bytes: number;
}

/** What `progress.json` holds: the archive downloaded, then unpacked (compressed bytes read), and files written. */
export interface MeshDownloadProgress {
  phase: 'download' | 'unpack';
  bytes: number;
  total: number;
  files: number;
}

export const ARCHIVE_PART = 'archive.part';
export const ARCHIVE_FILE = 'archive.tar.zst';
export const STATE_FILE = 'state.json';
export const DOWNLOAD_PROGRESS_FILE = 'progress.json';
/** The working folder of a mesh's download, under the store (hidden from the store's mesh list). */
export function downloadWorkDir(storeDir: string, name: string): string {
  return path.join(storeDir, `.dl-${name}`);
}

const HEAD_TIMEOUT_MS = 60_000;
/** How often progress.json is rewritten. */
const PROGRESS_EVERY_MS = 1000;

interface ArchiveState {
  url: string;
  build: string;
  size: number;
  etag: string | null;
}

/** zlib's zstd decompressor (Node 22.15+; @types/node 20 does not declare it). */
function zstdDecompress(): Transform {
  const make = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
  if (typeof make !== 'function')
    throw new Error(`this Node (${process.version}) cannot unpack the mesh archives (zstd needs Node 22.15 or later)`);
  return make();
}

function writeJson(file: string, v: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/**
 * The tar stream written into a folder: 512-byte headers, data padded to
 * 512. Entries are plain files ('0' or NUL) and folders ('5'), named
 * under `top/` (stripped), a GNU long name ('L') giving the next entry's
 * name. Each file is written to `<name>.part` and renamed when complete.
 */
export class TarExtractor extends Writable {
  /** Files written. */
  files = 0;
  private buf: Buffer = Buffer.alloc(0);
  /** The entry being written: its file descriptor (null for a long name's data), path and bytes still to come. */
  private entry: { fd: number | null; tmp: string; target: string; left: number; pad: number; longName: Buffer[] | null } | null = null;
  private longName: string | null = null;
  private ended = false;

  constructor(
    private readonly dest: string,
    private readonly top: string
  ) {
    super();
  }

  private target(name: string): string | null {
    const parts = name.split('/').filter(p => p !== '' && p !== '.');
    if (parts[0] !== this.top) throw new Error(`archive entry ${name}: not under ${this.top}/`);
    const rest = parts.slice(1);
    if (!rest.length) return null; // the top folder itself
    if (rest.some(p => p === '..')) throw new Error(`archive entry ${name}: leaves the mesh folder`);
    const p = path.resolve(this.dest, ...rest);
    if (!p.startsWith(path.resolve(this.dest) + path.sep)) throw new Error(`archive entry ${name}: leaves the mesh folder`);
    return p;
  }

  private header(h: Buffer): void {
    if (h.every(b => b === 0)) {
      this.ended = true;
      return;
    }
    const str = (a: number, n: number): string => {
      const s = h.subarray(a, a + n);
      const z = s.indexOf(0);
      return s.subarray(0, z < 0 ? n : z).toString('utf8');
    };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    const stored = parseInt(str(148, 8).trim() || 'x', 8);
    if (stored !== sum) throw new Error('archive damaged: a tar header fails its checksum');
    let size: number;
    if (h[124] & 0x80) {
      // GNU base-256 size.
      size = 0;
      for (let i = 125; i < 136; i++) size = size * 256 + h[i];
    } else size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const ustar = str(257, 6) === 'ustar'; // POSIX ("ustar\0"); GNU writes "ustar " and has no prefix field
    let name = this.longName ?? (ustar && str(345, 155) ? `${str(345, 155)}/${str(0, 100)}` : str(0, 100));
    this.longName = null;
    const pad = (512 - (size % 512)) % 512;
    if (type === 'L') {
      this.entry = { fd: null, tmp: '', target: '', left: size, pad, longName: [] };
      return;
    }
    if (type === '5') {
      const t = this.target(name);
      if (t) fs.mkdirSync(t, { recursive: true });
      if (size) this.entry = { fd: null, tmp: '', target: '', left: size, pad, longName: null };
      return;
    }
    if (type !== '0') throw new Error(`archive entry ${name}: type '${type}' (only files and folders are expected)`);
    name = name.replace(/\/$/, '');
    const t = this.target(name);
    if (!t) throw new Error(`archive entry ${name}: a file in place of the top folder`);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    const tmp = `${t}.part`;
    this.entry = { fd: fs.openSync(tmp, 'w'), tmp, target: t, left: size, pad, longName: null };
    if (size === 0) this.closeEntry();
  }

  private closeEntry(): void {
    const e = this.entry!;
    if (e.longName) this.longName = Buffer.concat(e.longName).toString('utf8').replace(/\0+$/, '');
    else if (e.fd !== null) {
      fs.closeSync(e.fd);
      fs.renameSync(e.tmp, e.target);
      this.files++;
    }
    e.fd = null;
    e.left = 0;
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      let off = 0;
      while (!this.ended) {
        if (this.entry && this.entry.left > 0) {
          const n = Math.min(this.entry.left, this.buf.length - off);
          if (n <= 0) break;
          const part = this.buf.subarray(off, off + n);
          if (this.entry.longName) this.entry.longName.push(Buffer.from(part));
          else if (this.entry.fd !== null) fs.writeSync(this.entry.fd, part);
          this.entry.left -= n;
          off += n;
          if (this.entry.left === 0) this.closeEntry();
          continue;
        }
        if (this.entry && this.entry.pad > 0) {
          const n = Math.min(this.entry.pad, this.buf.length - off);
          if (n <= 0) break;
          this.entry.pad -= n;
          off += n;
          continue;
        }
        this.entry = null;
        if (this.buf.length - off < 512) break;
        this.header(this.buf.subarray(off, off + 512));
        off += 512;
      }
      this.buf = this.ended ? Buffer.alloc(0) : this.buf.subarray(off);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _final(cb: (err?: Error | null) => void): void {
    if (this.entry?.fd != null) fs.closeSync(this.entry.fd);
    cb(this.ended ? null : new Error('archive truncated: the tar stream ended before its end marker'));
  }
}

/**
 * The tiles the unpacked mesh's indexes list (its `index.json`, or each
 * cluster's under `meshes.json`): all present, and their total. Throws
 * naming a missing tile.
 */
export function checkUnpacked(dest: string): { tiles: number; bytes: number } {
  let clusters = [''];
  if (!fs.existsSync(path.join(dest, 'index.json'))) {
    const m = readJson<{ meshes: { dir: string }[] }>(path.join(dest, 'meshes.json'));
    if (!m || !Array.isArray(m.meshes)) throw new Error('the archive holds no index.json or meshes.json');
    clusters = m.meshes.map(c => c.dir);
  }
  let tiles = 0;
  let bytes = 0;
  for (const c of clusters) {
    const ix = readJson<{ tiles: { file: string }[] }>(path.join(dest, c, 'index.json'));
    if (!ix || !Array.isArray(ix.tiles)) throw new Error(`${path.join(c, 'index.json')}: missing or unreadable in the archive`);
    for (const t of ix.tiles) {
      const n = sizeOf(path.join(dest, c, t.file));
      if (n < 0) throw new Error(`${path.join(c, t.file)}: listed in the index, missing from the archive`);
      tiles++;
      bytes += n;
    }
  }
  return { tiles, bytes };
}

/** Download (resuming) and unpack one mesh archive; see the header. */
export async function downloadMeshArchive(t: MeshDownloadTask): Promise<MeshDownloadResult> {
  const work = path.resolve(t.work);
  const dest = path.resolve(t.dest);
  if (t.fresh) {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(work, { recursive: true });
  const part = path.join(work, ARCHIVE_PART);
  const archive = path.join(work, ARCHIVE_FILE);
  const progressFile = path.join(work, DOWNLOAD_PROGRESS_FILE);
  let last = 0;
  const progress = (p: MeshDownloadProgress, force = false): void => {
    const now = Date.now();
    if (!force && now - last < PROGRESS_EVERY_MS) return;
    last = now;
    writeJson(progressFile, p);
  };

  // What the archive is now; a change from what the working folder was started for starts it over.
  const head = await fetch(t.url, { method: 'HEAD', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
  if (!head.ok) throw new Error(`${t.url}: HTTP ${head.status}`);
  const size = Number(head.headers.get('content-length'));
  if (!Number.isFinite(size) || size <= 0) throw new Error(`${t.url}: no size given`);
  const state: ArchiveState = { url: t.url, build: t.build, size, etag: head.headers.get('etag') };
  const prev = readJson<ArchiveState>(path.join(work, STATE_FILE));
  if (!prev || prev.url !== state.url || prev.build !== state.build || prev.size !== state.size || prev.etag !== state.etag) {
    fs.rmSync(part, { force: true });
    fs.rmSync(archive, { force: true });
    writeJson(path.join(work, STATE_FILE), state);
  }

  // Room for what is still to come: the rest of the archive and the unpacked mesh, with a tenth to spare.
  {
    const toFetch = sizeOf(archive) === size ? 0 : size - Math.max(0, Math.min(size, sizeOf(part)));
    const need = (toFetch + t.bytes) * 1.1;
    const fsStat = fs.statfsSync(work);
    const free = fsStat.bavail * fsStat.bsize;
    if (free < need)
      throw new Error(
        `not enough disk space: ${(free / 1e9).toFixed(1)} GB free, ${(need / 1e9).toFixed(1)} GB needed (the archive still to download and the mesh unpacked)`
      );
  }

  // Download, resuming a part already there.
  if (sizeOf(archive) !== size) {
    fs.rmSync(archive, { force: true });
    let have = Math.max(0, sizeOf(part));
    if (have > size) {
      fs.rmSync(part, { force: true });
      have = 0;
    }
    if (have < size) {
      const res = await fetch(t.url, have > 0 ? { headers: { Range: `bytes=${have}-` } } : {});
      if (have > 0 && res.status === 200) {
        // The server sent the whole file: start the part over.
        fs.rmSync(part, { force: true });
        have = 0;
      } else if (!(res.status === 206 || (have === 0 && res.status === 200))) throw new Error(`${t.url}: HTTP ${res.status}`);
      if (!res.body) throw new Error(`${t.url}: no body`);
      let got = have;
      const count = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          got += chunk.length;
          progress({ phase: 'download', bytes: got, total: size, files: 0 });
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        count,
        fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' })
      );
    }
    const n = sizeOf(part);
    if (n !== size) throw new Error(`download incomplete: ${n} of ${size} bytes`);
    fs.renameSync(part, archive);
  }
  progress({ phase: 'download', bytes: size, total: size, files: 0 }, true);

  // Unpack into an empty folder.
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tar = new TarExtractor(dest, t.top);
  let read = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      read += chunk.length;
      progress({ phase: 'unpack', bytes: read, total: size, files: tar.files });
      cb(null, chunk);
    },
  });
  try {
    await pipeline(fs.createReadStream(archive), counter, zstdDecompress(), tar);
  } catch (err) {
    // A damaged archive is not resumed: the next try downloads it afresh.
    const msg = (err as Error).message;
    if (!/cannot unpack/.test(msg)) fs.rmSync(archive, { force: true });
    throw new Error(`unpacking the mesh archive failed: ${msg}`, { cause: err });
  }
  progress({ phase: 'unpack', bytes: size, total: size, files: tar.files }, true);
  const c = checkUnpacked(dest);
  if (c.bytes !== t.bytes) throw new Error(`the unpacked tiles hold ${c.bytes} bytes, the catalogue says ${t.bytes}`);
  return { files: c.tiles, bytes: c.bytes };
}
