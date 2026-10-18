/**
 * The mesh archive download (mesharchive.ts) against a local HTTP server:
 * unpacked into the mesh folder, resumed after a cut connection, refused
 * when the archive or what it holds is wrong; and the tar reader's rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ARCHIVE_PART, downloadMeshArchive, type MeshDownloadTask, TarExtractor } from './mesharchive';
import { type TarEntry, tarOf, zstd } from './tarfixture';

const TOP = '01CGD_mesh';
const INDEX = JSON.stringify({ tiles: [{ file: 'mesh_000_000.bin' }, { file: 'mesh_000_001.bin' }] });
/** The tiles' bytes: `random` makes them incompressible (a cut connection then stops part-way through real data). */
const meshTar = (tile = 3000, random = false): Buffer =>
  tarOf([
    { name: TOP },
    { name: `${TOP}/mesh_000_000.bin`, data: random ? randomBytes(tile) : Buffer.alloc(tile, 1) },
    { name: `${TOP}/index.json`, data: Buffer.from(INDEX) },
    { name: `${TOP}/mesh_000_001.bin`, data: random ? randomBytes(tile) : Buffer.alloc(tile, 2) },
  ]);

/** Serve one archive; `cutAfter`: the first full GET stops after that many bytes (a dropped connection). */
function serve(body: Buffer, cutAfter?: number): Promise<{ url: string; ranges: string[]; close: () => void }> {
  const ranges: string[] = [];
  let cut = cutAfter;
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': body.length, etag: '"a"' }).end();
        return;
      }
      const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
      ranges.push(String(req.headers.range ?? ''));
      const from = m ? Number(m[1]) : 0;
      if (from)
        res.writeHead(206, { 'content-length': body.length - from, 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` });
      else res.writeHead(200, { 'content-length': body.length });
      if (cut !== undefined && !from) {
        const n = cut;
        cut = undefined;
        res.write(body.subarray(0, n), () => res.destroy());
        return;
      }
      res.end(body.subarray(from));
    });
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}/01CGD_mesh.tar.zst`, ranges, close: () => srv.close() });
    });
  });
}

function task(url: string, store: string, bytes = 6000): MeshDownloadTask {
  return {
    task: 'mesh-download',
    url,
    work: path.join(store, '.dl-01CGD'),
    dest: path.join(store, '01CGD.new'),
    top: TOP,
    build: 'b1',
    bytes,
  };
}

test('mesh archive: downloaded, unpacked under the mesh folder (top folder stripped), checked against the catalogue', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-arch-'));
  const s = await serve(zstd(meshTar()));
  try {
    const r = await downloadMeshArchive(task(s.url, store));
    assert.deepEqual(r, { files: 2, bytes: 6000 });
    const dest = path.join(store, '01CGD.new');
    assert.deepEqual(fs.readdirSync(dest).sort(), ['index.json', 'mesh_000_000.bin', 'mesh_000_001.bin']);
    assert.equal(fs.readFileSync(path.join(dest, 'mesh_000_001.bin'))[0], 2);
    const p = JSON.parse(fs.readFileSync(path.join(store, '.dl-01CGD', 'progress.json'), 'utf8'));
    assert.equal(p.phase, 'unpack');
    assert.equal(p.files, 3);
    // The catalogue's bytes must match what the tiles hold.
    await assert.rejects(
      () => downloadMeshArchive(task(s.url, store, 6001)),
      /the unpacked tiles hold 6000 bytes, the catalogue says 6001/
    );
  } finally {
    s.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('mesh archive: a cut connection is resumed with a Range request from where the part stopped', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-arch-'));
  const body = zstd(meshTar(200_000, true));
  const s = await serve(body, Math.floor(body.length / 2));
  try {
    await assert.rejects(() => downloadMeshArchive(task(s.url, store, 400_000)));
    const part = fs.statSync(path.join(store, '.dl-01CGD', ARCHIVE_PART)).size;
    assert.ok(part > 0 && part < body.length, `part ${part} of ${body.length}`);
    const r = await downloadMeshArchive(task(s.url, store, 400_000));
    assert.deepEqual(r, { files: 2, bytes: 400_000 });
    assert.equal(s.ranges[s.ranges.length - 1], `bytes=${part}-`, 'the second GET asked for the rest only');
  } finally {
    s.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('mesh archive: a damaged archive fails and is dropped, so the next try downloads it afresh', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-arch-'));
  const bad = Buffer.from(zstd(meshTar()));
  bad[Math.floor(bad.length / 2)] ^= 0xff;
  const s = await serve(bad);
  try {
    await assert.rejects(() => downloadMeshArchive(task(s.url, store)), /unpacking the mesh archive failed/);
    assert.ok(!fs.existsSync(path.join(store, '.dl-01CGD', 'archive.tar.zst')), 'the damaged archive is gone');
  } finally {
    s.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('mesh archive: not enough disk for the rest of the archive and the mesh is refused before downloading', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-arch-'));
  const s = await serve(zstd(meshTar()));
  try {
    await assert.rejects(() => downloadMeshArchive(task(s.url, store, 1e18)), /not enough disk space: [\d.]+ GB free/);
    assert.deepEqual(s.ranges, [], 'nothing fetched');
  } finally {
    s.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
});

/** Unpack a tar (uncompressed) with the reader into a fresh folder. */
async function untar(entries: TarEntry[], end = true): Promise<string> {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-untar-'));
  const t = new TarExtractor(dest, TOP);
  // Small chunks: headers and data split across writes.
  const buf = tarOf(entries, end);
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += 700) chunks.push(buf.subarray(i, i + 700));
  await pipeline(Readable.from(chunks), t);
  return dest;
}

test('tar reader: GNU long names, nested folders, empty files; anything else or a path leaving the folder is refused', async () => {
  const long = `${TOP}/w065s65/${'x'.repeat(120)}.bin`;
  const dest = await untar([
    { name: TOP },
    { name: `${TOP}/w065s65` },
    { name: `${TOP}/w065s65/index.json`, data: Buffer.from('{}') },
    { name: long, data: Buffer.alloc(513, 4) },
    { name: `${TOP}/empty.bin`, data: Buffer.alloc(0) },
  ]);
  assert.equal(fs.readFileSync(path.join(dest, 'w065s65', `${'x'.repeat(120)}.bin`)).length, 513);
  assert.equal(fs.statSync(path.join(dest, 'empty.bin')).size, 0);
  assert.ok(!fs.readdirSync(path.join(dest, 'w065s65')).some(f => f.endsWith('.part')), 'no part files left');
  fs.rmSync(dest, { recursive: true, force: true });
  await assert.rejects(() => untar([{ name: `${TOP}/../evil.bin`, data: Buffer.from('x') }]), /leaves the mesh folder/);
  await assert.rejects(() => untar([{ name: `other/a.bin`, data: Buffer.from('x') }]), /not under 01CGD_mesh\//);
  await assert.rejects(() => untar([{ name: `${TOP}/link`, type: '2' }]), /type '2' \(only files and folders are expected\)/);
  await assert.rejects(() => untar([{ name: `${TOP}/a.bin`, data: Buffer.from('x') }], false), /archive truncated/);
});
