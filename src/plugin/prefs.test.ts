// The web app's Setup choices per Signal K user (public/rp-prefs.js):
// read from the server's application data at start-up, kept in
// localStorage, and sent back as JSON Patch on change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefs, isUserPref, LOGIN_STATUS_URL, OWNER_KEY, PREFS_URL, SHARED_OWNER, SHARED_PREFS_URL } from '../../public/rp-prefs.js';

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
  /** Hold the read of the choices until releaseGet() is called. */
  holdGet?: boolean;
  /**
   * Security off: loginStatus says no authentication is required, Signal K's application data answers 404 / 405,
   * and the plugin's store (SHARED_PREFS_URL) holds the record. Without it the plugin's store answers 405.
   */
  securityOff?: boolean;
  /** The plugin store's answer with security off (default: the record). */
  sharedStatus?: number;
}

/**
 * A Signal K server's user application data: GET answers with the stored
 * object, POST applies the patch; /skServer/loginStatus names the user.
 */
function fakeServer(stored: Record<string, unknown> | null, opts: ServerOpts = {}) {
  const calls: Call[] = [];
  const doc: Record<string, unknown> = { ...(stored ?? {}) };
  let user = opts.user === undefined ? 'dirk' : opts.user;
  const held: (() => void)[] = [];
  const heldGets: (() => void)[] = [];
  let posts = 0;
  const fetchFn = async (url: string, init: { method?: string; body?: string; keepalive?: boolean } = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, keepalive: !!init.keepalive });
    if (url === LOGIN_STATUS_URL) {
      if (opts.securityOff) return Response.json({ status: 'notLoggedIn', readOnlyAccess: false, authenticationRequired: false });
      return Response.json(user ? { status: 'loggedIn', username: user } : { status: 'notLoggedIn' });
    }
    if (url === SHARED_PREFS_URL ? !opts.securityOff || opts.sharedStatus : opts.securityOff) {
      const status = url === SHARED_PREFS_URL ? (opts.sharedStatus ?? 405) : method === 'GET' ? 404 : 405;
      return new Response('no', { status });
    }
    if (method === 'GET') {
      if (opts.holdGet) await new Promise<void>(r => heldGets.push(r));
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
  const releaseGet = () => {
    for (const r of heldGets.splice(0)) r();
  };
  /** Another login (or a logout) in the same browser: the session's user from now on. */
  const setUser = (u: string | null) => {
    user = u;
  };
  return { calls, doc, fetchFn, postCalls, release, releaseGet, setUser };
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
  const srv = fakeServer({ polarPath: 'Lagoon_560.pol', vesselType: 'sail', junk: 42 });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });

  assert.equal(await prefs.load(), true);
  assert.equal(prefs.remote, true);
  assert.equal(prefs.get('polarPath'), 'Lagoon_560.pol');
  assert.equal(storage.getItem('polarPath'), 'Lagoon_560.pol', 'copied into this browser before the page reads it');
  assert.equal(storage.getItem('vesselType'), 'sail');
  assert.equal(storage.getItem('junk'), null, 'keys that are not Setup choices are not copied');
  assert.equal(storage.getItem('rp:view'), '{"zoom":5}');
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0, 'nothing only this browser has, nothing sent');
});

test('choices from before (no owner) stay in use here, are not sent, and wait for the user to claim them', async () => {
  const storage = new MemStorage();
  storage.setItem('polarPath', 'Lagoon_560.pol');
  storage.setItem('routeVar:mode', 'sail_max');
  storage.setItem('rp:view', '{"zoom":5}');
  const srv = fakeServer({});
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0, 'an empty record does not make them this user’s');
  assert.equal(prefs.get('polarPath'), 'Lagoon_560.pol', 'still in use in this browser, as before');
  assert.equal(prefs.user, 'dirk');
  assert.deepEqual(prefs.legacyChoices(), [
    ['polarPath', 'Lagoon_560.pol'],
    ['routeVar:mode', 'sail_max'],
  ]);
  assert.equal(storage.getItem(OWNER_KEY), null, 'no owner until the user answers');

  // Not answered: asked again on the next load.
  const again = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await again.load();
  assert.equal(again.legacyChoices().length, 2);

  // Claimed: sent up, and the browser is this user's from now on.
  again.keepLegacy();
  await again.flush();
  assert.deepEqual(srv.postCalls()[0].body, [
    { op: 'add', path: '/polarPath', value: 'Lagoon_560.pol' },
    { op: 'add', path: '/routeVar:mode', value: 'sail_max' },
  ]);
  assert.equal(storage.getItem(OWNER_KEY), 'dirk');
  assert.deepEqual(again.legacyChoices(), []);
});

test('choices from before that the user discards are dropped; one the user sets is theirs', async () => {
  const storage = new MemStorage();
  storage.setItem('routeVar:mode', 'motor');
  storage.setItem('powerBoat', '{"name":"Someone else"}');
  storage.setItem('rp:view', '{"zoom":5}');
  const srv = fakeServer({ polarPath: 'Lagoon_560.pol' });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  assert.equal(storage.getItem('polarPath'), 'Lagoon_560.pol', 'the record’s choice wins');
  // Setting one makes it the user's own: sent, and no longer waiting.
  prefs.set('routeVar:mode', 'sail_max');
  await prefs.flush();
  assert.deepEqual(srv.postCalls()[0].body, [{ op: 'add', path: '/routeVar:mode', value: 'sail_max' }]);
  assert.deepEqual(prefs.legacyChoices(), [['powerBoat', '{"name":"Someone else"}']]);
  prefs.discardLegacy();
  assert.equal(storage.getItem('powerBoat'), null);
  assert.equal(prefs.get('powerBoat'), null);
  assert.equal(storage.getItem('rp:view'), '{"zoom":5}', 'page state untouched');
  assert.equal(storage.getItem(OWNER_KEY), 'dirk');
  await prefs.flush();
  assert.equal(srv.postCalls().length, 1, 'nothing more sent');
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

test('the knots sail speed from before 2026-10 is converted here first and then follows the owner rules', async () => {
  // 5 kn = 2.572 m/s, kept to 0.1: '2.6'.
  const browser = (owner: string | null, extra: Record<string, string> = {}) => {
    const storage = new MemStorage();
    if (owner !== null) storage.setItem(OWNER_KEY, owner);
    storage.setItem('routeVar:sailThresh', '5');
    for (const [k, v] of Object.entries(extra)) storage.setItem(k, v);
    return storage;
  };

  // No owner: in use here, not sent, offered with the other older choices.
  let storage = browser(null);
  let srv = fakeServer({});
  let prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.equal(storage.getItem('routeVar:sailThresh'), null, 'the knots key is gone');
  assert.equal(prefs.get('routeVar:sailThreshMs'), '2.6');
  assert.equal(srv.postCalls().length, 0, 'not sent before the user claims it');
  assert.deepEqual(prefs.legacyChoices(), [['routeVar:sailThreshMs', '2.6']]);

  // Another user's browser: dropped, not copied into this user's record.
  storage = browser('skipper');
  srv = fakeServer({}, { user: 'crew' });
  prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0);
  assert.equal(prefs.get('routeVar:sailThreshMs'), null);
  assert.equal(storage.getItem('routeVar:sailThresh'), null);

  // This user's browser: sent up like any choice the record lacks.
  storage = browser('dirk');
  srv = fakeServer({});
  prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.deepEqual(srv.postCalls()[0].body, [{ op: 'add', path: '/routeVar:sailThreshMs', value: '2.6' }]);

  // A value in m/s already here is kept; the record's value still wins.
  storage = browser('dirk', { 'routeVar:sailThreshMs': '3.1' });
  srv = fakeServer({ 'routeVar:sailThreshMs': '1.8' });
  prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  assert.equal(prefs.get('routeVar:sailThreshMs'), '1.8');
  assert.equal(storage.getItem('routeVar:sailThresh'), null);

  // No server: converted all the same, and the old key is gone.
  storage = browser(null, { 'routeVar:mode': 'sail_max' });
  prefs = createPrefs({ storage, fetchFn: fakeServer({}, { getStatus: 404 }).fetchFn, log: quiet });
  assert.equal(await prefs.load(), false);
  assert.equal(prefs.get('routeVar:sailThreshMs'), '2.6');
  assert.equal(storage.getItem('routeVar:sailThresh'), null);

  // Not a number: dropped without a converted value.
  storage = browser('dirk');
  storage.setItem('routeVar:sailThresh', '');
  prefs = createPrefs({ storage, fetchFn: fakeServer({}).fetchFn, log: quiet });
  await prefs.load();
  assert.equal(prefs.get('routeVar:sailThreshMs'), null);
  assert.equal(storage.getItem('routeVar:sailThresh'), null);
});

test('the knots cruise speed in powerBoat from before 2026-10 is converted here first and then follows the owner rules', async () => {
  const KT_MS = 1852 / 3600;
  const ms = String(7 * KT_MS);
  const browser = (owner: string | null, boat: string, extra: Record<string, string> = {}) => {
    const storage = new MemStorage();
    if (owner !== null) storage.setItem(OWNER_KEY, owner);
    storage.setItem('powerBoat', boat);
    for (const [k, v] of Object.entries(extra)) storage.setItem(k, v);
    return storage;
  };
  const old = JSON.stringify({ name: 'Testboat', cruise_kts: 7 });
  const byKey = (pairs: [string, string][]) => [...pairs].sort(([a], [b]) => a.localeCompare(b));

  // No owner: both in use here, not sent, offered with the other older choices; Discard drops both.
  let storage = browser(null, old);
  let srv = fakeServer({});
  let prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.equal(storage.getItem('powerBoat'), '{"name":"Testboat"}', 'the knots are gone from powerBoat');
  assert.equal(prefs.get('routeVar:pb_cruise:si'), ms);
  assert.equal(srv.postCalls().length, 0, 'not sent before the user claims it');
  assert.deepEqual(byKey(prefs.legacyChoices()), [
    ['powerBoat', '{"name":"Testboat"}'],
    ['routeVar:pb_cruise:si', ms],
  ]);
  prefs.discardLegacy();
  assert.equal(storage.getItem('powerBoat'), null);
  assert.equal(storage.getItem('routeVar:pb_cruise:si'), null);

  // This user's browser: sent up like any choice the record lacks.
  storage = browser('dirk', old);
  srv = fakeServer({});
  prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.deepEqual(byKey((srv.postCalls()[0].body as { path: string; value: string }[]).map(o => [o.path, o.value])), [
    ['/powerBoat', '{"name":"Testboat"}'],
    ['/routeVar:pb_cruise:si', ms],
  ]);

  // A cruise speed in m/s already here is kept; the knots are dropped all the same.
  storage = browser('dirk', old, { 'routeVar:pb_cruise:si': '2.5' });
  prefs = createPrefs({ storage, fetchFn: fakeServer({}).fetchFn, log: quiet });
  await prefs.load();
  assert.equal(prefs.get('routeVar:pb_cruise:si'), '2.5');
  assert.equal(storage.getItem('powerBoat'), '{"name":"Testboat"}');

  // No server: converted all the same.
  storage = browser(null, old);
  prefs = createPrefs({ storage, fetchFn: fakeServer({}, { getStatus: 404 }).fetchFn, log: quiet });
  assert.equal(await prefs.load(), false);
  assert.equal(prefs.get('routeVar:pb_cruise:si'), ms);

  // Not a number: dropped without a converted value. Not JSON, or no knots: left as it is.
  for (const [boat, after] of [
    [JSON.stringify({ name: 'B', cruise_kts: 'fast' }), '{"name":"B"}'],
    ['{not json', '{not json'],
    ['{"name":"C"}', '{"name":"C"}'],
  ]) {
    storage = browser('dirk', boat);
    prefs = createPrefs({ storage, fetchFn: fakeServer({}).fetchFn, log: quiet });
    await prefs.load();
    assert.equal(storage.getItem('powerBoat'), after, boat);
    assert.equal(prefs.get('routeVar:pb_cruise:si'), null, boat);
  }
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

test('the Freeboard panel’s own keys from before are moved to the store’s and then follow the owner rules', async () => {
  const PANEL = {
    'wrp-plotterext-polar': 'p.pol',
    'wrp-plotterext-sail-thresh-ms': '2.5',
    'wrp-plotterext-maxWind-ms': '10',
    'wrp-plotterext-maxSwh-ms': '',
  };
  const browser = (owner: string | null, extra: Record<string, string> = {}) => {
    const storage = new MemStorage();
    if (owner !== null) storage.setItem(OWNER_KEY, owner);
    for (const [k, v] of Object.entries({ ...PANEL, ...extra })) storage.setItem(k, v);
    return storage;
  };
  const gone = (storage: MemStorage) => Object.keys(PANEL).every(k => storage.getItem(k) === null);
  const byKey = (pairs: [string, string][]) => [...pairs].sort(([a], [b]) => a.localeCompare(b));

  // No owner: in use here under the store's keys, not sent, offered with Keep / Discard. A store key this browser
  // already has wins over the panel's (the panel read its own only without one).
  let storage = browser(null, { polarPath: 'web.pol' });
  let srv = fakeServer({});
  let prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.ok(gone(storage), 'the panel’s keys are gone');
  assert.equal(srv.postCalls().length, 0, 'not sent before the user claims them');
  assert.deepEqual(
    byKey(prefs.legacyChoices()),
    byKey([
      ['polarPath', 'web.pol'],
      ['routeVar:maxSwh:si', ''],
      ['routeVar:maxWind:si', '10'],
      ['routeVar:sailThreshMs', '2.5'],
    ])
  );

  // Another user's browser: dropped, neither shown nor sent; the record's value wins over the panel's.
  storage = browser('skipper');
  srv = fakeServer({ 'routeVar:maxWind:si': '12' }, { user: 'crew' });
  prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.ok(gone(storage));
  assert.equal(srv.postCalls().length, 0);
  assert.equal(prefs.get('polarPath'), null, 'another user’s panel polar not shown');
  assert.equal(prefs.get('routeVar:sailThreshMs'), null);
  assert.equal(prefs.get('routeVar:maxWind:si'), '12');

  // This user's browser: sent up like any choice the record lacks.
  storage = browser('dirk');
  srv = fakeServer({});
  prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.deepEqual(
    byKey((srv.postCalls()[0].body as { path: string; value: string }[]).map(o => [o.path, o.value])),
    byKey([
      ['/polarPath', 'p.pol'],
      ['/routeVar:maxSwh:si', ''],
      ['/routeVar:maxWind:si', '10'],
      ['/routeVar:sailThreshMs', '2.5'],
    ])
  );

  // No server: moved all the same.
  storage = browser(null);
  prefs = createPrefs({ storage, fetchFn: fakeServer({}, { getStatus: 404 }).fetchFn, log: quiet });
  assert.equal(await prefs.load(), false);
  assert.ok(gone(storage));
  assert.equal(prefs.get('polarPath'), 'p.pol');
});

test('a failed read: another user’s choices are dropped as when it works; a choice nobody can be named for has no owner', async () => {
  // Alice's browser: her mode is in her record too.
  const alices = () => {
    const storage = new MemStorage();
    storage.setItem(OWNER_KEY, 'alice');
    storage.setItem('routeVar:mode', 'fastest');
    return storage;
  };
  // Alice opens the page again, the read working: a choice made by someone else is not sent up as hers.
  const aliceLoads = async (storage: MemStorage, why: string, offered: [string, string][]) => {
    const srv = fakeServer({ 'routeVar:mode': 'fastest' }, { user: 'alice' });
    const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
    assert.equal(await prefs.load(), true);
    await prefs.flush();
    assert.equal(srv.postCalls().length, 0, why + ': not sent as Alice’s');
    assert.deepEqual(prefs.legacyChoices(), offered, why + ': offered with Keep / Discard');
    assert.equal(prefs.get('routeVar:mode'), 'fastest', why + ': her own from her record');
  };
  const failingRead = (srv: ReturnType<typeof fakeServer>) => async (u: string, init?: { method?: string }) => {
    if (u === PREFS_URL && (init?.method ?? 'GET') === 'GET') throw new TypeError('network down');
    return srv.fetchFn(u, init);
  };

  // Bob logged in, the read failing (an error status, or no answer): Alice's choices are neither shown nor kept, and
  // the browser is Bob's, so his choice goes to his record at his next load, never to hers.
  for (const [why, fetchFn] of [
    ['500, Bob', fakeServer({}, { getStatus: 500, user: 'bob' }).fetchFn],
    ['no answer, Bob', failingRead(fakeServer({}, { user: 'bob' }))],
  ] as const) {
    const storage = alices();
    const prefs = createPrefs({ storage, fetchFn, log: quiet });
    assert.equal(await prefs.load(), false, why);
    assert.equal(prefs.get('routeVar:mode'), null, why + ': Alice’s mode not shown to Bob');
    assert.equal(storage.getItem(OWNER_KEY), 'bob', why);
    prefs.set('polarPath', 'b.pol');
    assert.equal(storage.getItem(OWNER_KEY), 'bob', why + ': his choice');
    const bobs = fakeServer({}, { user: 'bob' });
    const again = createPrefs({ storage: Object.assign(new MemStorage(), { m: new Map(storage.m) }), fetchFn: bobs.fetchFn, log: quiet });
    await again.load();
    await again.flush();
    assert.deepEqual(bobs.postCalls()[0]?.body, [{ op: 'add', path: '/polarPath', value: 'b.pol' }], why + ': to Bob’s record');
    await aliceLoads(storage, why, []);
    assert.equal(storage.getItem('polarPath'), null, why + ': Bob’s choice dropped when Alice logs in');
  }

  // Nobody logged in (the read answers 401), or the read works with the login status unknown: a choice there cannot
  // be named for anyone, so the browser has no owner and Alice is asked.
  for (const [why, fetchFn, loads] of [
    ['401, no login', fakeServer({}, { getStatus: 401, user: null }).fetchFn, false],
    ['unknown user', fakeServer({}, { user: null }).fetchFn, true],
  ] as const) {
    const storage = alices();
    const prefs = createPrefs({ storage, fetchFn, log: quiet });
    assert.equal(await prefs.load(), loads, why);
    assert.equal(storage.getItem(OWNER_KEY), 'alice', why + ': nothing chosen yet: still Alice’s');
    prefs.set('polarPath', 'b.pol');
    assert.equal(storage.getItem(OWNER_KEY), null, why + ': no owner after the choice');
    await aliceLoads(storage, why, [['polarPath', 'b.pol']]);
  }

  // A choice made while the read is still waiting (the Freeboard panel). Nobody logged in: no owner. Bob: his.
  for (const [why, user, owner] of [
    ['chosen while reading, no login', null, null],
    ['chosen while reading, Bob', 'bob', 'bob'],
  ] as const) {
    const storage = alices();
    const held = fakeServer({}, { getStatus: user ? 500 : 401, user, holdGet: true });
    const prefs = createPrefs({ storage, fetchFn: held.fetchFn, log: quiet });
    const loading = prefs.load();
    await wait(5);
    prefs.set('polarPath', 'b.pol');
    held.releaseGet();
    assert.equal(await loading, false);
    assert.equal(storage.getItem(OWNER_KEY), owner, why);
    assert.equal(storage.getItem('polarPath'), 'b.pol', why + ': the choice is kept');
  }

  // Alice herself while the read fails: still hers, and sent up for her at the next load as before.
  const storage = alices();
  let prefs = createPrefs({ storage, fetchFn: fakeServer({}, { getStatus: 500, user: 'alice' }).fetchFn, log: quiet });
  assert.equal(await prefs.load(), false);
  assert.equal(prefs.get('routeVar:mode'), 'fastest', 'her own still in use');
  prefs.set('polarPath', 'b.pol');
  assert.equal(storage.getItem(OWNER_KEY), 'alice');
  const srv = fakeServer({ 'routeVar:mode': 'fastest' }, { user: 'alice' });
  prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  await prefs.load();
  await prefs.flush();
  assert.deepEqual(srv.postCalls()[0].body, [{ op: 'add', path: '/polarPath', value: 'b.pol' }]);
  assert.deepEqual(prefs.legacyChoices(), []);
});

test('start-up does not wait for the upload of this browser’s choices', async () => {
  const storage = new MemStorage();
  storage.setItem(OWNER_KEY, 'dirk');
  storage.setItem('polarPath', 'Lagoon_560.pol');
  const srv = fakeServer({}, { holdPosts: true });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, log: quiet });
  const done = await Promise.race([prefs.load().then(() => 'loaded'), wait(200).then(() => 'stalled')]);
  assert.equal(done, 'loaded', 'a POST that does not answer does not hold the page');
  await wait(20); // after the login check
  assert.equal(srv.postCalls().length, 1, 'the upload is out, not answered yet');
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

test('no login, or no server: the choices stay in this browser and nothing is sent', async () => {
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

test('a write the server refuses (read-only user, no application data) stops further writes', async () => {
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

test('each request reads the login status first and goes only while it names the user load() found', async () => {
  const srv = fakeServer({});
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, delayMs: 5, log: quiet });
  await prefs.load();
  for (const v of ['a.pol', 'b.pol']) {
    prefs.set('polarPath', v);
    await prefs.flush();
  }
  const i = srv.calls.map((c, n) => (c.method === 'POST' ? n : -1)).filter(n => n >= 0);
  assert.equal(i.length, 2);
  for (const n of i) assert.equal(srv.calls[n - 1].url, LOGIN_STATUS_URL, 'the call before each POST');
  assert.equal(srv.doc.polarPath, 'b.pol');
});

test('another user or nobody logged in since load(): the queue is dropped, the choices stay here, nothing more is sent', async () => {
  // Another login in another tab (the session cookie is the browser's), or a logout.
  for (const [why, now] of [
    ['user changed', 'bob'],
    ['no user', null],
  ] as const) {
    const storage = new MemStorage();
    const srv = fakeServer({});
    const warnings: string[] = [];
    const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, delayMs: 5, log: { warn: (m: string) => warnings.push(m) } });
    await prefs.load();
    srv.setUser(now);
    prefs.set('polarPath', 'a.pol');
    await prefs.flush();
    assert.equal(prefs.remote, false, why);
    assert.equal(srv.postCalls().length, 0, why + ': not sent to the session’s user');
    prefs.set('vesselType', 'power');
    await prefs.flush();
    await wait(20);
    assert.equal(srv.postCalls().length, 0, why + ': nor later');
    assert.equal(storage.getItem('polarPath'), 'a.pol', why + ': kept in this browser');
    assert.equal(prefs.get('vesselType'), 'power', why);
    assert.equal(storage.getItem(OWNER_KEY), 'dirk', why + ': still recorded as the user load() found');
    assert.equal(warnings.length, 1, why);
    await prefs.flush(true);
    assert.equal(srv.postCalls().length, 0, why + ': the closing page sends nothing either');
  }
});

test('a check that fails (an error status, a network error, no answer) stops the writes too', async () => {
  const hang = (init: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  for (const [why, answer] of [
    ['HTTP 500', async () => new Response('no', { status: 500 })],
    [
      'network error',
      async () => {
        throw new TypeError('network down');
      },
    ],
    ['no answer', hang],
  ] as const) {
    const storage = new MemStorage();
    const srv = fakeServer({});
    let failing = false;
    const fetchFn = async (u: string, init: { method?: string; body?: string; signal?: AbortSignal } = {}) =>
      failing && u === LOGIN_STATUS_URL ? answer(init) : srv.fetchFn(u, init);
    const prefs = createPrefs({ storage, fetchFn, delayMs: 5, timeoutMs: 30, log: quiet });
    await prefs.load();
    failing = true;
    prefs.set('polarPath', 'a.pol');
    await prefs.flush();
    assert.equal(prefs.remote, false, why);
    assert.equal(srv.postCalls().length, 0, why);
    assert.equal(storage.getItem('polarPath'), 'a.pol', why + ': kept in this browser');
  }
});

test('a retry reads the login status again: after another login it is not sent', async () => {
  const srv = fakeServer({}, { postStatus: [500, 200] });
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, retryMs: 10, log: quiet });
  await prefs.load();
  prefs.set('polarPath', 'a.pol');
  await prefs.flush();
  assert.equal(srv.postCalls().length, 1, 'HTTP 500: kept for a retry');
  assert.equal(prefs.remote, true);
  srv.setUser('bob');
  await wait(60);
  assert.equal(srv.postCalls().length, 1, 'the retry is not sent as Bob’s');
  assert.equal(prefs.remote, false);
  assert.equal(srv.doc.polarPath, undefined);
});

test('the user unknown at load(): a choice made later is not sent to whoever the session is', async () => {
  const storage = new MemStorage();
  const srv = fakeServer({}, { user: null });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, delayMs: 5, log: quiet });
  assert.equal(await prefs.load(), true);
  srv.setUser('dirk');
  prefs.set('polarPath', 'a.pol');
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0);
  assert.equal(prefs.remote, false);
  assert.equal(storage.getItem('polarPath'), 'a.pol');
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

test('a choice made while load() waits for the server wins over the stored one and is sent up', async () => {
  // The Freeboard panel opens its controls before the read answers (the web app waits for load()).
  const storage = new MemStorage();
  storage.setItem(OWNER_KEY, 'dirk');
  const srv = fakeServer({ 'routeVar:mode': 'fastest', polarPath: 'a.pol' }, { holdGet: true });
  const prefs = createPrefs({ storage, fetchFn: srv.fetchFn, delayMs: 0, log: quiet });
  const loading = prefs.load();
  await wait(5);
  prefs.set('routeVar:mode', 'sail_max');
  srv.releaseGet();
  assert.equal(await loading, true);
  assert.equal(prefs.get('routeVar:mode'), 'sail_max');
  assert.equal(storage.getItem('routeVar:mode'), 'sail_max');
  assert.equal(prefs.get('polarPath'), 'a.pol', 'the other choices come from the server');
  await prefs.flush();
  assert.equal(srv.doc['routeVar:mode'], 'sail_max');
});

test("security off: one set of choices for every browser, read from and written to the plugin's store", async () => {
  const srv = fakeServer({ vesselType: 'sail' }, { securityOff: true });
  const s1 = new MemStorage();
  const p1 = createPrefs({ storage: s1, fetchFn: srv.fetchFn, delayMs: 0, log: quiet });
  assert.equal(await p1.load(), true);
  assert.equal(p1.remote, true);
  assert.equal(p1.shared, true);
  assert.equal(p1.user, SHARED_OWNER);
  assert.equal(p1.get('vesselType'), 'sail');
  assert.equal(s1.getItem(OWNER_KEY), SHARED_OWNER);
  p1.set('polarPath', 'b.pol');
  await p1.flush();
  assert.equal(srv.doc.polarPath, 'b.pol');
  assert.ok(srv.postCalls().length > 0 && srv.postCalls().every(c => c.url === SHARED_PREFS_URL), 'written to the plugin, not to Signal K');
  // Another browser, no login: the same choices.
  const p2 = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, log: quiet });
  assert.equal(await p2.load(), true);
  assert.equal(p2.get('polarPath'), 'b.pol');
});

test("security off: a write to the plugin's store reads no login status first; its 405 (security on since) stops the writes", async () => {
  const srv = fakeServer({}, { securityOff: true, postStatus: [200, 405] });
  const warnings: string[] = [];
  const prefs = createPrefs({
    storage: new MemStorage(),
    fetchFn: srv.fetchFn,
    delayMs: 0,
    log: { warn: (m: string) => warnings.push(m) },
  });
  assert.equal(await prefs.load(), true);
  const before = srv.calls.length;
  prefs.set('polarPath', 'a.pol');
  await prefs.flush();
  assert.deepEqual(
    srv.calls.slice(before).map(c => c.method + ' ' + c.url),
    ['POST ' + SHARED_PREFS_URL],
    'the write alone'
  );
  assert.equal(srv.doc.polarPath, 'a.pol');
  prefs.set('polarPath', 'b.pol');
  await prefs.flush();
  assert.equal(prefs.remote, false);
  assert.ok(
    warnings.some(w => w.includes('HTTP 405')),
    JSON.stringify(warnings)
  );
  prefs.set('polarPath', 'c.pol');
  await wait(20);
  assert.equal(srv.postCalls().length, 2, 'nothing after the 405');
  assert.equal(srv.doc.polarPath, 'a.pol');
});

test("security off but the plugin's store refuses: the choices stay in this browser", async () => {
  const srv = fakeServer({}, { securityOff: true, sharedStatus: 405 });
  const prefs = createPrefs({ storage: new MemStorage(), fetchFn: srv.fetchFn, delayMs: 0, log: quiet });
  assert.equal(await prefs.load(), false);
  assert.equal(prefs.shared, false);
  prefs.set('polarPath', 'a.pol');
  await wait(20);
  assert.equal(srv.postCalls().length, 0);
});

test('a security switch: the choices held for the other side are asked about, not dropped or sent', async () => {
  // Security turned on: the browser held every browser's choices, a user logs in.
  let storage = new MemStorage();
  storage.setItem(OWNER_KEY, SHARED_OWNER);
  storage.setItem('polarPath', 'boat.pol');
  let srv = fakeServer({}, { user: 'dirk' });
  let prefs = createPrefs({ storage, fetchFn: srv.fetchFn, delayMs: 0, log: quiet });
  assert.equal(await prefs.load(), true);
  assert.deepEqual(prefs.legacyChoices(), [['polarPath', 'boat.pol']]);
  assert.equal(storage.getItem('polarPath'), 'boat.pol', 'still in use here');
  assert.equal(storage.getItem(OWNER_KEY), SHARED_OWNER, 'no owner yet');
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0);
  prefs.keepLegacy();
  await prefs.flush();
  assert.equal(srv.doc.polarPath, 'boat.pol');
  assert.ok(srv.postCalls().every(c => c.url === PREFS_URL));
  assert.equal(storage.getItem(OWNER_KEY), 'dirk');
  // Security turned off: the browser held a user's choices.
  storage = new MemStorage();
  storage.setItem(OWNER_KEY, 'dirk');
  storage.setItem('polarPath', 'dirk.pol');
  srv = fakeServer({}, { securityOff: true });
  prefs = createPrefs({ storage, fetchFn: srv.fetchFn, delayMs: 0, log: quiet });
  assert.equal(await prefs.load(), true);
  assert.deepEqual(prefs.legacyChoices(), [['polarPath', 'dirk.pol']]);
  await prefs.flush();
  assert.equal(srv.postCalls().length, 0);
  prefs.discardLegacy();
  assert.equal(storage.getItem('polarPath'), null);
  assert.equal(storage.getItem(OWNER_KEY), SHARED_OWNER);
});
