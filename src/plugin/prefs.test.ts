// The web app's Setup choices per Signal K user (public/rp-prefs.js):
// read from the server's application data at start-up, kept in
// localStorage, and sent back as JSON Patch on change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefs, isUserPref, LOGIN_STATUS_URL, OWNER_KEY, PREFS_URL } from '../../public/rp-prefs.js';

/** localStorage stand-in: getItem/setItem/removeItem/key/length over a Map. */
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
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  keepalive: boolean;
}

interface ServerOpts {
  /** The logged-in user /skServer/loginStatus reports; null: not logged in. */
  user?: string | null;
  getStatus?: number;
  /** POST answers, in order; the last one repeats. */
  postStatus?: number[];
  /** Hold every POST until release() is called. */
  holdPosts?: boolean;
}

/**
 * A Signal K server's user application data: GET answers with the stored
 * object, POST applies the patch; /skServer/loginStatus names the user.
 */
function fakeServer(stored: Record<string, unknown> | null, opts: ServerOpts = {}) {
  const calls: Call[] = [];
  const doc: Record<string, unknown> = { ...(stored ?? {}) };
  const user = opts.user === undefined ? 'dirk' : opts.user;
  const held: (() => void)[] = [];
  let posts = 0;
  const fetchFn = async (url: string, init: { method?: string; body?: string; keepalive?: boolean } = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, keepalive: !!init.keepalive });
    if (url === LOGIN_STATUS_URL) {
      return Response.json(user ? { status: 'loggedIn', username: user } : { status: 'notLoggedIn' });
    }
    if (method === 'GET') {
      const status = opts.getStatus ?? 200;
      return new Response(status === 200 ? JSON.stringify(doc) : 'no', { status });
    }
    const list = opts.postStatus ?? [200];
    const status = list[Math.min(posts++, list.length - 1)];
    if (opts.holdPosts) await new Promise<void>(r => held.push(r));
    if (status === 200) {
      for (const op of body as { op: string; path: string; value: unknown }[]) {
        assert.equal(op.op, 'add');
        const key = op.path.slice(1).replace(/~1/g, '/').replace(/~0/g, '~');
        doc[key] = op.value;
      }
    }
    return new Response(JSON.stringify(status === 200 ? 'ApplicationData saved' : 'no'), { status });
  };
  const postCalls = () => calls.filter(c => c.method === 'POST');
  const release = () => {
    for (const r of held.splice(0)) r();
  };
  return { calls, doc, fetchFn, postCalls, release };
}

const quiet = { warn: () => {} };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

test('user choices are the Setup keys; page state, the owner and the legacy knots key are not', () => {
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
    OWNER_KEY,
  ]) {
    assert.ok(!isUserPref(k), k);
  }
  assert.equal(PREFS_URL, '/signalk/v1/applicationData/user/signalk-weather-router-plus/1.0.0');
  assert.equal(LOGIN_STATUS_URL, '/skServer/loginStatus');
});

test('start-up: the server choice wins and is copied into this browser; page state stays local', async () => {
  const storage = new MemStorage();
  storage.setItem(OWNER_KEY, 'dirk');
  storage.setItem('polarPath', 'catalina36.csv'); // stale in this browser
  storage.setItem('rp:view', '{"zoom":5}'); // page state: never sent
  storage.setItem('routeVar:sailThresh', '5'); // legacy key: never sent
  const srv = fakeServer({ polarPath: 'Lagoon_560.pol', vesselType: 'sail', junk: 42 });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });

  assert.equal(await prefs.load(), true);
  assert.equal(prefs.remote, true);
  assert.equal(prefs.get('polarPath'), 'Lagoon_560.pol');
  assert.equal(storage.getItem('polarPath'), 'Lagoon_560.pol', 'copied into this browser before the page reads it');
  assert.equal(storage.getItem('vesselType'), 'sail');
  assert.equal(storage.getItem('junk'), null, 'keys that are not Setup choices are not copied');
  assert.equal(storage.getItem('rp:view'), '{"zoom":5}');
  assert.equal(storage.getItem('routeVar:sailThresh'), '5', 'left for rp-core.js to migrate');
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0, 'nothing only this browser has, nothing sent');
});

test('the choices a browser held before (no owner) go up only into a record that has none', async () => {
  // A fresh record: this user's first browser after the upgrade.
  const storage = new MemStorage();
  storage.setItem('polarPath', 'Lagoon_560.pol');
  storage.setItem('routeVar:mode', 'sail_max');
  storage.setItem('rp:view', '{"zoom":5}');
  const srv = fakeServer({});
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.equal(storage.getItem(OWNER_KEY), 'dirk', 'the browser now holds this user’s choices');
  assert.equal(srv.postCalls().length, 1);
  assert.deepEqual(srv.postCalls()[0].body, [
    { op: 'add', path: '/polarPath', value: 'Lagoon_560.pol' },
    { op: 'add', path: '/routeVar:mode', value: 'sail_max' },
  ]);

  // A record that has choices: the browser's ownerless ones may be
  // another user's, so they are dropped, not sent.
  const storage2 = new MemStorage();
  storage2.setItem('routeVar:mode', 'motor');
  storage2.setItem('powerBoat', '{"name":"Someone else"}');
  const srv2 = fakeServer({ polarPath: 'Lagoon_560.pol' });
  const prefs2 = createPrefs({ storage: storage2, fetchFn: srv2.fetchFn, log: quiet });
  await prefs2.load();
  await prefs2.flush();
  assert.equal(srv2.postCalls().length, 0);
  assert.equal(storage2.getItem('routeVar:mode'), null);
  assert.equal(storage2.getItem('powerBoat'), null);
  assert.equal(prefs2.get('powerBoat'), null);
  assert.equal(storage2.getItem('polarPath'), 'Lagoon_560.pol');
  assert.equal(storage2.getItem(OWNER_KEY), 'dirk');
});

test('a browser that held this user’s choices sends up the ones the record lacks', async () => {
  const storage = new MemStorage();
  storage.setItem(OWNER_KEY, 'dirk');
  storage.setItem('routeVar:mode', 'sail_max'); // set while the server could not be reached
  const srv = fakeServer({ polarPath: 'Lagoon_560.pol' });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.deepEqual(srv.postCalls()[0].body, [{ op: 'add', path: '/routeVar:mode', value: 'sail_max' }]);
  assert.equal(srv.doc['routeVar:mode'], 'sail_max');
});

test('another user’s choices in this browser are neither sent nor used', async () => {
  const storage = new MemStorage();
  storage.setItem(OWNER_KEY, 'skipper');
  storage.setItem('powerBoat', '{"name":"Skipper boat"}');
  storage.setItem('polarPath', 'catalina36.csv');
  const srv = fakeServer({}, { user: 'crew' });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0, 'not copied into crew’s record');
  assert.equal(prefs.get('powerBoat'), null);
  assert.equal(prefs.get('polarPath'), null, 'crew starts from the default polar');
  assert.equal(storage.getItem(OWNER_KEY), 'crew');
});

test('the user unknown (no login status): the browser’s choices are left as they are', async () => {
  const storage = new MemStorage();
  storage.setItem('polarPath', 'Lagoon_560.pol');
  const srv = fakeServer({}, { user: null });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  assert.equal(await prefs.load(), true);
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0);
  assert.equal(storage.getItem('polarPath'), 'Lagoon_560.pol');
  assert.equal(storage.getItem(OWNER_KEY), null);
});

test('start-up does not wait for the upload of this browser’s choices', async () => {
  const storage = new MemStorage();
  storage.setItem('polarPath', 'Lagoon_560.pol');
  const srv = fakeServer({}, { holdPosts: true });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  const done = await Promise.race([prefs.load().then(() => 'loaded'), wait(200).then(() => 'stalled')]);
  assert.equal(done, 'loaded', 'a POST that does not answer does not hold the page');
  assert.equal(srv.postCalls().length, 1);
  srv.release();
  await prefs.flush();
  assert.equal(srv.doc.polarPath, 'Lagoon_560.pol');
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
  assert.equal(srv.postCalls().length, 0, 'nothing sent before the delay');

  await wait(40);
  assert.equal(srv.postCalls().length, 1);
  assert.deepEqual(srv.postCalls()[0].body, [
    { op: 'add', path: '/routeVar:sailThreshMs', value: '2.3' },
    { op: 'add', path: '/polarPath', value: 'Lagoon_560.pol' },
  ]);

  // Setting the value it already has sends nothing.
  prefs.set('polarPath', 'Lagoon_560.pol');
  await wait(40);
  assert.equal(srv.postCalls().length, 1);
});

test('one request at a time: a change made while one runs goes in the next', async () => {
  const srv = fakeServer({}, { holdPosts: true });
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, delayMs: 5, log: quiet });
  await prefs.load();
  prefs.set('polarPath', 'a.pol');
  await wait(20);
  assert.equal(srv.postCalls().length, 1, 'first request running');
  prefs.set('polarPath', 'b.pol');
  prefs.set('vesselType', 'power');
  await wait(20);
  assert.equal(srv.postCalls().length, 1, 'no second request while the first runs');
  srv.release();
  await wait(20);
  assert.equal(srv.postCalls().length, 2);
  assert.deepEqual(srv.postCalls()[1].body, [
    { op: 'add', path: '/polarPath', value: 'b.pol' },
    { op: 'add', path: '/vesselType', value: 'power' },
  ]);
  srv.release();
  await prefs.flush();
  assert.equal(srv.doc.polarPath, 'b.pol', 'the newer value is the one kept');
});

test('a change the server did not take is kept and sent again; a newer value meanwhile wins', async () => {
  const srv = fakeServer({}, { postStatus: [500, 200] });
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, retryMs: 20, log: quiet });
  await prefs.load();
  prefs.set('polarPath', 'a.pol');
  prefs.set('vesselType', 'sail');
  await prefs.flush();
  assert.equal(srv.postCalls().length, 1);
  assert.equal(srv.doc.polarPath, undefined, 'HTTP 500: not stored');
  assert.equal(prefs.remote, true, 'a 500 does not stop saving');
  prefs.set('polarPath', 'b.pol'); // newer than the failed one
  await wait(80);
  assert.equal(srv.postCalls().length, 2, 'sent again after the retry delay');
  assert.deepEqual(srv.postCalls()[1].body, [
    { op: 'add', path: '/polarPath', value: 'b.pol' },
    { op: 'add', path: '/vesselType', value: 'sail' },
  ]);
  assert.equal(srv.doc.polarPath, 'b.pol');
  assert.equal(srv.doc.vesselType, 'sail');
});

test('a network error is retried too', async () => {
  let fail = true;
  const srv = fakeServer({});
  const fetchFn = async (url: string, init: { method?: string; body?: string } = {}) => {
    if (init.method === 'POST' && fail) {
      fail = false;
      throw new TypeError('network down');
    }
    return srv.fetchFn(url, init);
  };
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn, retryMs: 10, log: quiet });
  await prefs.load();
  prefs.set('polarPath', 'Lagoon_560.pol');
  await prefs.flush();
  await wait(50);
  assert.equal(srv.doc.polarPath, 'Lagoon_560.pol');
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

test('a closing page sends everything not yet taken, the request in flight included, with keepalive', async () => {
  const srv = fakeServer({}, { holdPosts: true });
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, delayMs: 5, log: quiet });
  await prefs.load();
  prefs.set('polarPath', 'a.pol');
  await wait(20); // in flight, held
  prefs.set('vesselType', 'power'); // pending behind it
  await prefs.flush(true);
  const posts = srv.postCalls();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].keepalive, true);
  assert.deepEqual(posts[1].body, [
    { op: 'add', path: '/polarPath', value: 'a.pol' },
    { op: 'add', path: '/vesselType', value: 'power' },
  ]);
  srv.release();
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
    assert.equal(srv.postCalls().length, 0, String(getStatus));
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
    const srv = fakeServer({}, { postStatus: [postStatus] });
    const warnings: string[] = [];
    const prefs = createPrefs({
      storage: new MemStorage(),
      fetchFn: srv.fetchFn,
      retryMs: 5,
      log: { warn: (m: string) => warnings.push(m) },
    });
    await prefs.load();
    prefs.set('polarPath', 'a.pol');
    await prefs.flush();
    assert.equal(prefs.remote, false, String(postStatus));
    prefs.set('polarPath', 'b.pol');
    await prefs.flush();
    await wait(20);
    assert.equal(srv.postCalls().length, 1, String(postStatus));
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
  assert.deepEqual(srv.postCalls()[0].body, [{ op: 'add', path: '/routeVar:a~1b~0c', value: '1' }]);
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
