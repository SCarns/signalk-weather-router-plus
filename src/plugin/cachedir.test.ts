import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CACHE_DIRS, CACHEDIR_TAG, CACHEDIR_TAG_FILE, tagCacheDirs } from './cachedir';

// The spec's signature (https://bford.info/cachedir/), spelled out here
// rather than imported, so a typo in the module cannot pass.
const SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';

test('cachedir: the tag starts with the cache directory tag signature', () => {
  assert.equal(CACHEDIR_TAG.slice(0, SIGNATURE.length), SIGNATURE);
  assert.equal(Buffer.byteLength(SIGNATURE), 43);
});

test('cachedir: every cache directory is created and tagged; the rest of the data directory is not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-cachedir-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  fs.mkdirSync(path.join(root, 'coastline'));
  assert.deepEqual(tagCacheDirs(root), []);
  for (const name of CACHE_DIRS) {
    assert.equal(fs.readFileSync(path.join(root, name, CACHEDIR_TAG_FILE), 'utf8'), CACHEDIR_TAG, name);
  }
  assert.equal(fs.existsSync(path.join(root, 'coastline', CACHEDIR_TAG_FILE)), false);
  assert.equal(fs.existsSync(path.join(root, CACHEDIR_TAG_FILE)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cachedir: a tag already there is kept, and cached data next to it is untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-cachedir-'));
  const ecmwf = path.join(root, 'ecmwf');
  fs.mkdirSync(path.join(ecmwf, '2026101900'), { recursive: true });
  fs.writeFileSync(path.join(ecmwf, '2026101900', 'a.grib2'), 'x');
  const own = `${SIGNATURE}\n# written by hand\n`;
  fs.writeFileSync(path.join(ecmwf, CACHEDIR_TAG_FILE), own);
  assert.deepEqual(tagCacheDirs(root), []);
  assert.equal(fs.readFileSync(path.join(ecmwf, CACHEDIR_TAG_FILE), 'utf8'), own);
  assert.equal(fs.readFileSync(path.join(ecmwf, '2026101900', 'a.grib2'), 'utf8'), 'x');
  fs.rmSync(root, { recursive: true, force: true });
});

test('cachedir: a tag without the signature is written again', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-cachedir-'));
  fs.mkdirSync(path.join(root, 'forecast'));
  fs.mkdirSync(path.join(root, 'rtofs'));
  fs.writeFileSync(path.join(root, 'forecast', CACHEDIR_TAG_FILE), '');
  fs.writeFileSync(path.join(root, 'rtofs', CACHEDIR_TAG_FILE), SIGNATURE.slice(0, 20));
  assert.deepEqual(tagCacheDirs(root), []);
  assert.equal(fs.readFileSync(path.join(root, 'forecast', CACHEDIR_TAG_FILE), 'utf8'), CACHEDIR_TAG);
  assert.equal(fs.readFileSync(path.join(root, 'rtofs', CACHEDIR_TAG_FILE), 'utf8'), CACHEDIR_TAG);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cachedir: a CACHEDIR.TAG that is not a file is reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-cachedir-'));
  fs.mkdirSync(path.join(root, 'smoc', CACHEDIR_TAG_FILE), { recursive: true });
  const problems = tagCacheDirs(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /smoc/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cachedir: a directory that cannot be made is reported, and the others are still tagged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-cachedir-'));
  fs.writeFileSync(path.join(root, 'ecmwf'), 'a file where the directory belongs');
  const problems = tagCacheDirs(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /ecmwf/);
  assert.equal(fs.existsSync(path.join(root, 'rtofs', CACHEDIR_TAG_FILE)), true);
  fs.rmSync(root, { recursive: true, force: true });
});
