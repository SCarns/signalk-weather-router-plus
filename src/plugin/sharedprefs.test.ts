/**
 * The Setup choices every browser shares with security off (sharedprefs.ts), and their API: 405 with security on,
 * read and JSON-Patched with it off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_SHARED_PREFS_BYTES, SHARED_PREFS_FILE, SharedPrefsError, SharedPrefsStore } from './sharedprefs';
import { CACHE_DIRS, CACHEDIR_TAG_FILE, tagCacheDirs } from './cachedir';
import { registerApi, type ApiDeps } from './api';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-sharedprefs-'));

test('read: {} with no file; add and remove one member each; kept across instances, no temporary file left', () => {
  const dir = tmp();
  try {
    const a = new SharedPrefsStore(dir);
    assert.deepEqual(a.read(), {});
    assert.deepEqual(
      a.patch([
        { op: 'add', path: '/polarPath', value: 'Lagoon_560.pol' },
        { op: 'add', path: '/routeVar:maxWind:si', value: '12.5' },
        { op: 'add', path: '/a~1b~0c', value: 'escaped' },
      ]),
      { polarPath: 'Lagoon_560.pol', 'routeVar:maxWind:si': '12.5', 'a/b~c': 'escaped' }
    );
    a.patch([
      { op: 'remove', path: '/routeVar:maxWind:si' },
      { op: 'add', path: '/polarPath', value: 'b.pol' },
    ]);
    const b = new SharedPrefsStore(dir);
    assert.deepEqual(b.read(), { polarPath: 'b.pol', 'a/b~c': 'escaped' });
    assert.deepEqual(fs.readdirSync(dir), [SHARED_PREFS_FILE]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refused, nothing written: not a patch, other operations, nested or unsafe paths, a value not a string, too large', () => {
  const dir = tmp();
  try {
    const store = new SharedPrefsStore(dir);
    store.patch([{ op: 'add', path: '/polarPath', value: 'a.pol' }]);
    const before = fs.readFileSync(store.file, 'utf8');
    const refused = (body: unknown, status: number): void => {
      assert.throws(
        () => store.patch(body),
        (e: unknown) => e instanceof SharedPrefsError && e.status === status,
        JSON.stringify(body).slice(0, 80)
      );
    };
    refused({ polarPath: 'b.pol' }, 400);
    refused([null], 400);
    refused([{ op: 'replace', path: '/polarPath', value: 'b.pol' }], 400);
    refused([{ op: 'add', path: '/a/b', value: 'x' }], 400);
    refused([{ op: 'add', path: 'polarPath', value: 'x' }], 400);
    refused([{ op: 'add', path: '/', value: 'x' }], 400);
    refused([{ op: 'add', path: '/__proto__', value: 'x' }], 400);
    refused([{ op: 'add', path: '/constructor', value: 'x' }], 400);
    refused([{ op: 'add', path: '/polarPath', value: 3 }], 400);
    // A later bad operation leaves the earlier ones unapplied too.
    refused(
      [
        { op: 'add', path: '/vesselType', value: 'power' },
        { op: 'add', path: '/x', value: {} },
      ],
      400
    );
    refused([{ op: 'add', path: '/big', value: 'x'.repeat(MAX_SHARED_PREFS_BYTES) }], 413);
    refused(
      Array.from({ length: 201 }, (_, i) => ({ op: 'add', path: `/k${i}`, value: 'v' })),
      413
    );
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
    assert.equal(({} as Record<string, unknown>).x, undefined, 'no prototype touched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable file is kept aside and counts as no choices; members that are not strings are left out', () => {
  const dir = tmp();
  try {
    const store = new SharedPrefsStore(dir);
    fs.writeFileSync(store.file, '{"polarPath": "a.pol", "n": 3, "__proto__": "x"}');
    assert.deepEqual(store.read(), { polarPath: 'a.pol' });
    fs.writeFileSync(store.file, '{not json');
    assert.deepEqual(store.read(), {});
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith(`${SHARED_PREFS_FILE}.corrupt-`)));
    assert.ok(!fs.existsSync(store.file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backups keep the file: it is in the data directory itself, which tagCacheDirs never tags', () => {
  const dir = tmp();
  try {
    const store = new SharedPrefsStore(dir);
    store.patch([{ op: 'add', path: '/polarPath', value: 'a.pol' }]);
    tagCacheDirs(dir);
    assert.equal(path.dirname(store.file), dir);
    assert.ok(!fs.existsSync(path.join(dir, CACHEDIR_TAG_FILE)), 'the data directory has no tag');
    assert.ok(!(CACHE_DIRS as readonly string[]).includes(SHARED_PREFS_FILE));
    assert.ok(fs.existsSync(path.join(dir, CACHE_DIRS[0], CACHEDIR_TAG_FILE)), 'the caches are tagged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type Handler = (req: unknown, res: unknown) => unknown;

function api(store: SharedPrefsStore, securityOff: () => boolean) {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (p: string | string[], h: Handler) => {
    for (const x of Array.isArray(p) ? p : [p]) routes.set(`${m} ${x}`, h);
  };
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  registerApi(
    router as never,
    {
      pluginId: 'x',
      basePath: '/x',
      publicDir: '/nonexistent',
      sharedPrefs: store,
      securityOff,
    } as unknown as ApiDeps
  );
  return async (key: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const out = { status: 200, body: undefined as unknown };
    const res = {
      status(c: number) {
        out.status = c;
        return res;
      },
      json(b: unknown) {
        out.body = b;
        return res;
      },
      setHeader() {
        return res;
      },
      headersSent: false,
      destroyed: false,
    };
    await routes.get(key)!({ query: {}, headers: {}, params: {}, body }, res);
    return out;
  };
}

test('GET / POST /api/prefs: 405 with security on, nothing written; the store with it off', async () => {
  const dir = tmp();
  try {
    const store = new SharedPrefsStore(dir);
    let off = false;
    const call = api(store, () => off);
    const patch = [{ op: 'add', path: '/polarPath', value: 'a.pol' }];
    for (const [key, body] of [
      ['GET /api/prefs', undefined],
      ['POST /api/prefs', patch],
    ] as const) {
      const r = await call(key, body);
      assert.equal(r.status, 405, key);
      assert.match((r.body as { error: string }).error, /security is on/);
    }
    assert.ok(!fs.existsSync(store.file));
    off = true;
    assert.deepEqual(await call('POST /api/prefs', patch), { status: 200, body: { polarPath: 'a.pol' } });
    assert.deepEqual(await call('GET /api/prefs'), { status: 200, body: { polarPath: 'a.pol' } });
    const bad = await call('POST /api/prefs', { polarPath: 'b.pol' });
    assert.equal(bad.status, 400);
    const big = await call('POST /api/prefs', [{ op: 'add', path: '/big', value: 'x'.repeat(MAX_SHARED_PREFS_BYTES) }]);
    assert.equal(big.status, 413);
    assert.deepEqual(store.read(), { polarPath: 'a.pol' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
