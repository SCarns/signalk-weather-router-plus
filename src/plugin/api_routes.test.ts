/**
 * The route API's checks before a job is queued (a request too large, a polar not in the library) and the event
 * stream's replay when Last-Event-ID is not a number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerApi, type ApiDeps } from './api';

type Handler = (req: unknown, res: unknown) => unknown;
interface Answer {
  status: number;
  body: Record<string, unknown>;
  written: string;
}

function api(jobs: Record<string, unknown>, polarsDir: string): (key: string, req: Record<string, unknown>) => Promise<Answer> {
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
      jobs,
      polarLibrary: () => ({ polarFile: path.join(polarsDir, 'a.csv'), polarsDir }),
    } as unknown as ApiDeps
  );
  return async (key, req) => {
    const out: Answer = { status: 200, body: {}, written: '' };
    const res = {
      status(c: number) {
        out.status = c;
        return res;
      },
      json(b: Record<string, unknown>) {
        out.body = b;
        return res;
      },
      setHeader() {
        return res;
      },
      flushHeaders() {},
      write(s: string) {
        out.written += s;
        return true;
      },
      end() {
        return res;
      },
      headersSent: false,
      destroyed: false,
    };
    await routes.get(key)!({ query: {}, headers: {}, params: {}, on() {}, ...req }, res);
    return out;
  };
}

const ROUTE = { start: { lat: 41, lon: -71 }, end: { lat: 41.1, lon: -71.1 } };

test('POST /api/routes: a body over 64 KB is 413 and a polar not in the library 400, before any job is queued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-polars-'));
  fs.writeFileSync(path.join(dir, 'a.csv'), 'twa/tws;6\n0;0\n');
  try {
    const submitted: unknown[] = [];
    const jobs = {
      queueLength: 0,
      submit: (b: unknown) => (submitted.push(b), { id: 'j1', status: 'queued' }),
      links: () => ({ self: '/x/api/routes/j1' }),
    };
    const call = api(jobs, dir);
    const big = await call('POST /api/routes', { body: { ...ROUTE, name: 'n', pad: 'x'.repeat(70_000) } });
    assert.equal(big.status, 413);
    const bad = await call('POST /api/routes', { body: { ...ROUTE, vessel: { polar: 'nosuch.csv' } } });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /^vessel\.polar: polar not found: nosuch\.csv/);
    assert.equal(submitted.length, 0, 'nothing queued');
    const ok = await call('POST /api/routes', { body: { ...ROUTE, vessel: { polar: 'a.csv' } } });
    assert.equal(ok.status, 202);
    assert.equal(submitted.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/routes/:id/events: a Last-Event-ID that is not a number replays every event', async () => {
  const job = {
    id: 'j1',
    status: 'done',
    events: [
      { id: 1, event: 'status', data: { status: 'running' } },
      { id: 2, event: 'done', data: { status: 'done' } },
    ],
  };
  const call = api({ get: (id: string) => (id === 'j1' ? job : undefined) }, os.tmpdir());
  const replayed = async (lastId?: string): Promise<number> => {
    const a = await call('GET /api/routes/:id/events', {
      params: { id: 'j1' },
      headers: lastId === undefined ? {} : { 'last-event-id': lastId },
    });
    return (a.written.match(/^id: /gm) ?? []).length;
  };
  assert.equal(await replayed(), 2);
  assert.equal(await replayed('1'), 1);
  assert.equal(await replayed('garbage'), 2);
});
