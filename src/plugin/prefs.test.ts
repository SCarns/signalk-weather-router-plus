// The web app's Setup choices per Signal K user (public/rp-prefs.js):
// read from the server's application data at start-up, kept in
// localStorage, and sent back as JSON Patch on change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefs, isUserPref, PREFS_URL } from '../../public/rp-prefs.js';

/** localStorage stand-in: getItem/setItem/key/length over a Map. */
class MemStorage {
  m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  keepalive: boolean;
}

/**
 * A Signal K server's user application data: GET answers `getStatus` with
 * the stored object, POST applies the patch and answers `postStatus`.
 */
function fakeServer(stored: Record<string, unknown> | null, opts: { getStatus?: number; postStatus?: number } = {}) {
  const calls: Call[] = [];
  const doc: Record<string, unknown> = { ...(stored ?? {}) };
  const fetchFn = async (url: string, init: { method?: string; body?: string; keepalive?: boolean } = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, keepalive: !!init.keepalive });
    if (method === 'GET') {
      const status = opts.getStatus ?? 200;
      return new Response(status === 200 ? JSON.stringify(doc) : 'no', { status });
    }
    const status = opts.postStatus ?? 200;
    if (status === 200) {
      for (const op of body as { op: string; path: string; value: unknown }[]) {
        assert.equal(op.op, 'add');
        const key = op.path.slice(1).replace(/~1/g, '/').replace(/~0/g, '~');
        doc[key] = op.value;
      }
    }
    return new Response(JSON.stringify('ApplicationData saved'), { status });
  };
  return { calls, doc, fetchFn };
}

const quiet = { warn: () => {} };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

test('user choices are the Setup keys; page state and the legacy knots key are not', () => {
  for (const k of [
    'polarPath',
    'vesselType',
    'powerBoat',
    'rp:search',
    'rp:router',
    'routeVar:mode',
    'routeVar:sailThreshMs',
    'routeVar:maxWind:si',
  ]) {
    assert.ok(isUserPref(k), k);
  }
  for (const k of [
    'rp:view',
    'rp:tab',
    'rp:routeTab',
    'rp:layersTab',
    'rp:plan',
    'rp:seasStyle',
    'routeVar:sailThresh',
    'wrp-plotterext-polar',
  ]) {
    assert.ok(!isUserPref(k), k);
  }
  assert.equal(PREFS_URL, '/signalk/v1/applicationData/user/signalk-weather-router-plus/1.0.0');
});

test('start-up: the server choice wins, a choice only this browser has is sent up, page state stays local', async () => {
  const storage = new MemStorage();
  storage.setItem('polarPath', 'catalina36.csv'); // stale in this browser
  storage.setItem('routeVar:mode', 'sail_max'); // only this browser has it
  storage.setItem('routeVar:sailThresh', '5'); // legacy key: never sent
  storage.setItem('rp:view', '{"zoom":5}'); // page state: never sent
  const srv = fakeServer({ polarPath: 'Lagoon_560.pol', vesselType: 'sail', junk: 42 });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });

  assert.equal(await prefs.load(), true);
  assert.equal(prefs.remote, true);
  assert.equal(prefs.get('polarPath'), 'Lagoon_560.pol');
  assert.equal(storage.getItem('polarPath'), 'Lagoon_560.pol', 'copied into this browser before the page reads it');
  assert.equal(storage.getItem('vesselType'), 'sail');
  assert.equal(storage.getItem('junk'), null, 'keys that are not Setup choices are not copied');

  const posts = srv.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, PREFS_URL);
  assert.deepEqual(posts[0].body, [{ op: 'add', path: '/routeVar:mode', value: 'sail_max' }]);
  assert.equal(srv.doc['routeVar:mode'], 'sail_max');
  assert.equal(srv.doc['rp:view'], undefined);
  assert.equal(srv.doc['routeVar:sailThresh'], undefined);
});

test('a change is stored locally at once and sent once, batched, after the delay', async () => {
  const storage = new MemStorage();
  const srv = fakeServer({});
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, delayMs: 10, log: quiet });
  await prefs.load();

  // A slider drag: many values, one request with the last one.
  for (const v of ['2.1', '2.2', '2.3']) prefs.set('routeVar:sailThreshMs', v);
  prefs.set('polarPath', 'Lagoon_560.pol');
  prefs.set('rp:tab', 'routeSection'); // page state: local only
  assert.equal(storage.getItem('routeVar:sailThreshMs'), '2.3');
  assert.equal(storage.getItem('rp:tab'), 'routeSection');
  assert.equal(srv.calls.filter(c => c.method === 'POST').length, 0, 'nothing sent before the delay');

  await wait(40);
  const posts = srv.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, [
    { op: 'add', path: '/routeVar:sailThreshMs', value: '2.3' },
    { op: 'add', path: '/polarPath', value: 'Lagoon_560.pol' },
  ]);

  // Setting the value it already has sends nothing.
  prefs.set('polarPath', 'Lagoon_560.pol');
  await wait(40);
  assert.equal(srv.calls.filter(c => c.method === 'POST').length, 1);
});

test('a second browser of the same user gets the choice the first one made', async () => {
  const srv = fakeServer({});
  const a = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, log: quiet });
  await a.load();
  a.set('polarPath', 'Lagoon_560.pol');
  await a.flush();

  const storageB = new MemStorage();
  const b = createPrefs({ storage: storageB, fetchFn: srv.fetchFn, log: quiet });
  await b.load();
  assert.equal(b.get('polarPath'), 'Lagoon_560.pol');
  assert.equal(storageB.getItem('polarPath'), 'Lagoon_560.pol');
});

test('flush sends what is pending at once, with keepalive for a closing page', async () => {
  const srv = fakeServer({});
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, delayMs: 60_000, log: quiet });
  await prefs.load();
  prefs.set('vesselType', 'power');
  await prefs.flush(true);
  const posts = srv.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].keepalive, true);
  assert.equal(srv.doc.vesselType, 'power');
});

test('no login, security off, or no server: the choices stay in this browser and nothing is sent', async () => {
  for (const getStatus of [401, 404, 500]) {
    const storage = new MemStorage();
    const srv = fakeServer({}, { getStatus });
    const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, delayMs: 5, log: quiet });
    assert.equal(await prefs.load(), false, String(getStatus));
    prefs.set('polarPath', 'Lagoon_560.pol');
    await wait(20);
    assert.equal(storage.getItem('polarPath'), 'Lagoon_560.pol');
    assert.equal(srv.calls.filter(c => c.method === 'POST').length, 0, String(getStatus));
  }
  const thrown = createPrefs({
    storage: new MemStorage(),
    fetchFn: async () => {
      throw new TypeError('network down');
    },
    log: quiet,
  });
  assert.equal(await thrown.load(), false);
  const notObject = createPrefs({ storage: new MemStorage(), fetchFn: async () => new Response('[1]'), log: quiet });
  assert.equal(await notObject.load(), false, 'an array is not the stored object');
});

test('a write the server refuses (read-only user, security off) stops further writes', async () => {
  for (const postStatus of [401, 403, 405]) {
    const srv = fakeServer({}, { postStatus });
    const warnings: string[] = [];
    const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, log: { warn: (m: string) => warnings.push(m) } });
    await prefs.load();
    prefs.set('polarPath', 'a.pol');
    await prefs.flush();
    assert.equal(prefs.remote, false, String(postStatus));
    prefs.set('polarPath', 'b.pol');
    await prefs.flush();
    assert.equal(srv.calls.filter(c => c.method === 'POST').length, 1, String(postStatus));
    assert.equal(warnings.length, 1);
  }
});

test('a server that does not answer delays start-up by the timeout and no more', async () => {
  const fetchFn = (_url: string, init: { signal?: AbortSignal } = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn, timeoutMs: 30, log: quiet });
  const t0 = Date.now();
  assert.equal(await prefs.load(), false);
  assert.ok(Date.now() - t0 < 1000);
});

test('keys with / and ~ are escaped as JSON Pointer', async () => {
  const srv = fakeServer({});
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  prefs.set('routeVar:a/b~c', '1');
  await prefs.flush();
  assert.deepEqual(srv.calls.find(c => c.method === 'POST')!.body, [{ op: 'add', path: '/routeVar:a~1b~0c', value: '1' }]);
  assert.equal(srv.doc['routeVar:a/b~c'], '1');
});

test('blocked localStorage: a choice still holds for the page and still reaches the server', async () => {
  const srv = fakeServer({ polarPath: 'Lagoon_560.pol' });
  const prefs = createPrefs({ storage: null, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  assert.equal(prefs.get('polarPath'), 'Lagoon_560.pol');
  prefs.set('vesselType', 'power');
  assert.equal(prefs.get('vesselType'), 'power');
  await prefs.flush();
  assert.equal(srv.doc.vesselType, 'power');
});
