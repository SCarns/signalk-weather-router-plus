// Departure windows (windows.ts): one route job per departure, one at a
// time, on the real job manager with a stand-in for the route worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobManager, type Job } from './jobs';
import type { RouteRequest, RouteSummary } from './protocol';
import {
  departureMetrics,
  validateWindowRequest,
  WINDOW_LIMITS,
  windowDepartures,
  WindowManager,
  type DepartureWindow,
  type WindowDeps,
} from './windows';

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 2, 0);
const ROUTE: RouteRequest = { start: { lat: 38.7, lon: -9.4 }, end: { lat: 32.6, lon: -16.9 }, mode: 'sail_max', name: 'Lisbon-Madeira' };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-windows-'));
}

/** A finished route's GeoJSON: points with the leg values the metrics read. */
function routeGeo(depMs: number, opts: { wind: number; swh: number; twa: number[]; beyond?: boolean }) {
  const pts = opts.twa.map((twa, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-9.4 - i, 38.7 - i * 1.5] },
    properties: {
      time: new Date(depMs + i * 6 * H).toISOString(),
      mode: i === 0 ? 'motoring' : 'sailing',
      ...(i > 0
        ? {
            twa_deg: twa,
            wind_ms: opts.wind - 1,
            leg_wind_max_ms: opts.wind,
            swh_m: opts.swh - 0.5,
            leg_swh_max_m: opts.swh,
            sea_index: 60 + i,
            encounter_index: 70 + i,
          }
        : {}),
      ...(i < opts.twa.length - 1 ? { leg_time_s: 6 * 3600 } : {}),
    },
  }));
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: opts.beyond ? { legs_beyond_forecast: 2 } : {} },
      ...pts,
    ],
  };
}

function summary(depMs: number, hours: number): RouteSummary {
  return {
    total_distance_m: 1_100_000,
    total_time_s: hours * 3600,
    sailing_time_s: (hours - 6) * 3600,
    motoring_time_s: 6 * 3600,
    waypoint_count: 4,
    warnings: 0,
    departure: new Date(depMs).toISOString(),
    arrival: new Date(depMs + hours * H).toISOString(),
  };
}

interface Harness {
  dir: string;
  jobs: JobManager;
  windows: WindowManager;
  started: Job[];
  cancelled: string[];
  finished: DepartureWindow[];
  /** Finish the running job (as the route worker would). */
  finish: (how?: { hours?: number; fail?: string; beyond?: boolean; wind?: number }) => void;
}

function harness(opts: { dir?: string; validTo?: number | null; keepJobs?: number } = {}): Harness {
  const dir = opts.dir ?? tmp();
  const jobs = new JobManager(dir, opts.keepJobs ?? 50, '/plugins/wrp');
  const started: Job[] = [];
  jobs.on('start', (j: Job) => started.push(j));
  const cancelled: string[] = [];
  const finished: DepartureWindow[] = [];
  const deps: WindowDeps = {
    cancelRunning: id => cancelled.push(id),
    forecastValidToMs: () => (opts.validTo === undefined ? T0 + 240 * H : opts.validTo),
    onFinished: w => finished.push(w),
  };
  const windows = new WindowManager(jobs, dir, deps, '/plugins/wrp');
  const finish: Harness['finish'] = (how = {}) => {
    const id = jobs.runningId;
    assert.ok(id, 'a job is running');
    const job = jobs.get(id)!;
    if (how.fail) return jobs.onError(id, how.fail);
    const dep = Date.parse(job.request.departure!);
    jobs.onDone(
      id,
      routeGeo(dep, { wind: how.wind ?? 12, swh: 2.5, twa: [0, 45, 120, 50], beyond: how.beyond }),
      {},
      summary(dep, how.hours ?? 96)
    );
  };
  return { dir, jobs, windows, started, cancelled, finished, finish };
}

test('windowDepartures: from every step to the latest, both ends included', () => {
  assert.deepEqual(
    windowDepartures(T0, T0 + 24 * H, 6 * 3600).map(t => (t - T0) / H),
    [0, 6, 12, 18, 24]
  );
  assert.deepEqual(
    windowDepartures(T0, T0 + 20 * H, 6 * 3600).map(t => (t - T0) / H),
    [0, 6, 12, 18]
  );
  assert.deepEqual(windowDepartures(T0, T0, 3600), [T0]);
});

test('validateWindowRequest: the route, the times, the step and the size of the window', () => {
  const from = new Date(T0).toISOString();
  const to = new Date(T0 + 48 * H).toISOString();
  assert.equal(validateWindowRequest({ route: ROUTE, from, to }), null);
  assert.equal(validateWindowRequest({ route: ROUTE, from, to, step_s: 3 * 3600 }), null);
  assert.match(validateWindowRequest(null)!, /JSON body required/);
  assert.match(validateWindowRequest({ from, to })!, /route is required/);
  assert.match(validateWindowRequest({ route: ROUTE, from: 'soon', to })!, /from must be/);
  assert.match(validateWindowRequest({ route: ROUTE, from: to, to: from })!, /not be before/);
  assert.match(validateWindowRequest({ route: ROUTE, from, to: new Date(T0 + 20 * 86400_000).toISOString() })!, /within/);
  assert.match(validateWindowRequest({ route: ROUTE, from, to, step_s: 60 })!, /step_s must be/);
  assert.match(validateWindowRequest({ route: ROUTE, from, to: new Date(T0 + 15 * 86400_000).toISOString(), step_s: 3600 })!, /at most 48/);
  assert.match(validateWindowRequest({ route: { ...ROUTE, start: { lat: 99, lon: 0 } }, from, to })!, /^route: /);
});

test('departureMetrics: strongest wind, highest waves, roughest sea, time close-hauled under sail, past the forecast', () => {
  const dir = tmp();
  const jobs = new JobManager(dir, 50, '');
  const job = jobs.submit({ ...ROUTE, departure: new Date(T0).toISOString() });
  jobs.onDone(job.id, routeGeo(T0, { wind: 14, swh: 3.2, twa: [0, 45, 120, 50], beyond: true }), {}, summary(T0, 18));
  const m = departureMetrics(jobs.get(job.id)!);
  assert.equal(m.max_wind_ms, 14);
  assert.equal(m.max_swh_m, 3.2);
  assert.equal(m.max_sea_index, 73, 'the encounter index where given');
  // Legs into points 1 and 3 are close-hauled (45°, 50°), 6 h each; the leg into point 2 is a reach.
  assert.equal(m.upwind_time_s, 12 * 3600);
  assert.equal(m.beyond_forecast, true);
  assert.equal(m.total_time_s, 18 * 3600);
  assert.equal(m.arrival, new Date(T0 + 18 * H).toISOString());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a window computes its departures one at a time, as unlisted, unpublished route jobs', () => {
  const h = harness();
  const w = h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0 + 18 * H).toISOString(), step_s: 6 * 3600 });
  assert.equal(w.departures.length, 4);
  for (let k = 0; k < 4; k++) {
    const active = h.jobs.list(100, true).filter(j => j.status === 'queued' || j.status === 'running');
    assert.equal(active.length, 1, `one window job at a time (departure ${k})`);
    assert.equal(active[0].request.departure, w.departures[k].departure);
    assert.equal(active[0].request.publish, false, 'never published');
    assert.equal(active[0].windowId, w.id);
    assert.match(active[0].request.name!, /^Lisbon-Madeira · 2026-11-02 \d\d:00Z$/);
    assert.equal(h.windows.get(w.id)!.departures[k].status, 'running');
    h.finish({ hours: 90 + k });
  }
  const done = h.windows.get(w.id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(
    done.departures.map(d => d.status),
    ['done', 'done', 'done', 'done']
  );
  assert.deepEqual(
    done.departures.map(d => d.metrics!.total_time_s / 3600),
    [90, 91, 92, 93]
  );
  assert.equal(h.finished.length, 1, 'one notification for the window');
  assert.equal(h.jobs.list(100).length, 0, 'window jobs are not in the job list');
  assert.equal(h.jobs.list(100, true).length, 4);
  assert.equal(h.windows.toPublic(done).links.self, `/plugins/wrp/api/windows/${w.id}`);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('a route asked for while a window runs waits behind one window job, not the whole window', () => {
  const h = harness();
  h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0 + 18 * H).toISOString(), step_s: 6 * 3600 });
  const mine = h.jobs.submit({ ...ROUTE, departure: new Date(T0).toISOString(), name: 'mine' });
  h.finish(); // the window's first departure
  assert.equal(h.jobs.runningId, mine.id, 'the route asked for runs next');
  h.finish();
  for (let k = 1; k < 4; k++) h.finish();
  assert.deepEqual(
    h.started.map(j => j.request.name === 'mine'),
    [false, true, false, false, false]
  );
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('departures after the forecast, and after a passage that ran past it, are skipped; a failed one does not stop the window', () => {
  const h = harness({ validTo: T0 + 30 * H });
  const w = h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0 + 36 * H).toISOString(), step_s: 6 * 3600 });
  assert.equal(w.departures.length, 7);
  h.finish({ fail: 'no route found' }); // 00
  h.finish({ hours: 20 }); // 06
  h.finish({ hours: 20, beyond: true }); // 12: arrives after the forecast
  const done = h.windows.get(w.id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(
    done.departures.map(d => d.status),
    ['failed', 'done', 'done', 'skipped', 'skipped', 'skipped', 'skipped']
  );
  assert.equal(done.departures[0].error, 'no route found');
  assert.match(done.departures[3].error!, /earlier departure already arrives after the forecast/);
  assert.equal(h.started.length, 3, 'the skipped departures were never computed');

  // Departing after the forecast's last step: not computed at all.
  const late = h.windows.create({
    route: ROUTE,
    from: new Date(T0 + 24 * H).toISOString(),
    to: new Date(T0 + 36 * H).toISOString(),
    step_s: 6 * 3600,
  });
  h.finish({ hours: 3 }); // 24
  assert.deepEqual(
    h.windows.get(late.id)!.departures.map(d => d.status),
    ['done', 'skipped', 'skipped']
  );
  assert.match(h.windows.get(late.id)!.departures[1].error!, /departs after the forecast ends/);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('cancel: departures not started are cancelled, the running one is stopped, no notification', () => {
  const h = harness();
  const w = h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0 + 18 * H).toISOString(), step_s: 6 * 3600 });
  h.finish();
  const running = h.jobs.runningId!;
  assert.equal(h.windows.cancel(w.id), true);
  assert.deepEqual(h.cancelled, [running], 'the route worker is told to stop');
  // The worker answers the cancel.
  h.jobs.onError(running, 'cancelled', true);
  const c = h.windows.get(w.id)!;
  assert.equal(c.status, 'cancelled');
  assert.deepEqual(
    c.departures.map(d => d.status),
    ['done', 'cancelled', 'cancelled', 'cancelled']
  );
  assert.equal(h.jobs.runningId, null, 'nothing submitted after the cancel');
  assert.equal(h.finished.length, 0);
  assert.equal(h.windows.cancel(w.id), false, 'only a running window');

  // A window whose job is still queued behind another route: the queued job is cancelled.
  const other = h.jobs.submit({ ...ROUTE, name: 'busy', departure: new Date(T0).toISOString() });
  const w2 = h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0 + 6 * H).toISOString(), step_s: 6 * 3600 });
  assert.equal(h.windows.get(w2.id)!.departures[0].status, 'queued');
  h.windows.cancel(w2.id);
  assert.equal(h.jobs.get(h.windows.get(w2.id)!.departures[0].job_id!)!.status, 'cancelled');
  assert.equal(h.jobs.runningId, other.id);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('delete takes the window’s route jobs with it; the job trim leaves window jobs alone; old windows are trimmed', () => {
  const h = harness({ keepJobs: 1 });
  const w = h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0 + 12 * H).toISOString(), step_s: 6 * 3600 });
  for (let k = 0; k < 3; k++) h.finish();
  // Two ordinary routes with keepJobs 1: one is trimmed, the window's three stay.
  for (const n of ['a', 'b']) {
    h.jobs.submit({ ...ROUTE, name: n, departure: new Date(T0).toISOString() });
    h.finish();
  }
  assert.equal(h.jobs.list(100).length, 1);
  assert.equal(h.jobs.list(100, true).filter(j => j.windowId === w.id).length, 3);
  const ids = h.windows.get(w.id)!.departures.map(d => d.job_id!);
  assert.equal(h.windows.delete(w.id), true);
  assert.equal(h.windows.get(w.id), undefined);
  for (const id of ids) assert.equal(h.jobs.get(id), undefined);
  assert.ok(!fs.existsSync(path.join(h.dir, 'windows', `${w.id}.json`)));

  for (let i = 0; i < WINDOW_LIMITS.keep + 2; i++) {
    h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0).toISOString() });
    h.finish();
  }
  assert.equal(h.windows.list(100).length, WINDOW_LIMITS.keep);
  assert.equal(h.jobs.list(100, true).filter(j => j.windowId).length, WINDOW_LIMITS.keep, 'trimmed windows took their jobs');
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test('a restart: a finished window is back as it was; one in progress ends failed; jobs of windows that are gone are deleted', () => {
  const h = harness();
  const a = h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0 + 6 * H).toISOString(), step_s: 6 * 3600 });
  h.finish();
  h.finish();
  const b = h.windows.create({ route: ROUTE, from: new Date(T0).toISOString(), to: new Date(T0 + 12 * H).toISOString(), step_s: 6 * 3600 });
  h.finish(); // b's first; its second is running when the plugin stops
  // As the plugin's stop(): the windows let go first, then the running job fails.
  h.windows.close();
  h.jobs.failRunning('plugin stopped');
  // A window file lost (an orphan job remains).
  fs.unlinkSync(path.join(h.dir, 'windows', `${a.id}.json`));

  const h2 = harness({ dir: h.dir });
  assert.equal(h2.windows.get(a.id), undefined);
  assert.equal(h2.jobs.list(100, true).filter(j => j.windowId === a.id).length, 0, 'orphan jobs deleted');
  const back = h2.windows.get(b.id)!;
  assert.equal(back.status, 'failed');
  assert.match(back.error!, /plugin restarted/);
  assert.deepEqual(
    back.departures.map(d => d.status),
    ['done', 'failed', 'cancelled']
  );
  assert.ok(back.departures[0].metrics, 'metrics kept');
  fs.rmSync(h.dir, { recursive: true, force: true });
});
