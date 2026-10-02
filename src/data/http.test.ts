import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, parseRetryAfterMs } from './http';

function responder(
  answers: (number | Error)[],
  body = 'ok',
  headers: Record<string, string> = {}
): { fetchImpl: typeof fetch; calls: number } {
  const st = { calls: 0 };
  const fetchImpl = (async () => {
    const a = answers[Math.min(st.calls, answers.length - 1)];
    st.calls++;
    if (a instanceof Error) throw a;
    return new Response(body, { status: a, headers });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return st.calls;
    },
  } as { fetchImpl: typeof fetch; calls: number };
}

test('fetchWithRetry: 5xx and network errors are retried with 2, 4, 8 s backoff plus jitter; then the answer is returned', async () => {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const r = responder([503, new Error('ECONNRESET'), 200], 'payload');
  const out = await fetchWithRetry(
    'http://x/y',
    {},
    {
      timeoutMs: 1000,
      retries: 6,
      fetchImpl: r.fetchImpl,
      sleepImpl: async ms => {
        sleeps.push(ms);
      },
      log: m => logs.push(m),
      tag: 'test',
      readBody: true,
    }
  );
  assert.equal(out.status, 200);
  assert.equal(new TextDecoder().decode(out.body!), 'payload');
  assert.equal(r.calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] >= 2000 && sleeps[0] < 2500, `first backoff ${sleeps[0]}`);
  assert.ok(sleeps[1] >= 4000 && sleeps[1] < 4500, `second backoff ${sleeps[1]}`);
  assert.ok(logs[0].startsWith('test: retry 1/5 for http://x/y after 2.'), logs[0]);
});

test('fetchWithRetry: Retry-After raises the backoff; 404 is returned without a retry; retries exhausted throw the last error', async () => {
  const sleeps: number[] = [];
  const r = responder([429, 200], 'ok', { 'retry-after': '10' });
  await fetchWithRetry(
    'http://x',
    {},
    {
      timeoutMs: 1000,
      retries: 3,
      fetchImpl: r.fetchImpl,
      sleepImpl: async ms => {
        sleeps.push(ms);
      },
    }
  );
  assert.ok(sleeps[0] >= 10000 && sleeps[0] < 10500, `retry-after backoff ${sleeps[0]}`);
  const nf = responder([404]);
  const out = await fetchWithRetry(
    'http://x',
    {},
    { timeoutMs: 1000, retries: 3, fetchImpl: nf.fetchImpl, sleepImpl: async () => undefined }
  );
  assert.equal(out.status, 404);
  assert.equal(out.body, null);
  assert.equal(nf.calls, 1);
  class MyErr extends Error {}
  const bad = responder([500]);
  await assert.rejects(
    fetchWithRetry(
      'http://x',
      {},
      { timeoutMs: 1000, retries: 2, fetchImpl: bad.fetchImpl, sleepImpl: async () => undefined, makeError: m => new MyErr(m) }
    ),
    (e: unknown) => e instanceof MyErr && /HTTP 500/.test((e as Error).message)
  );
  assert.equal(bad.calls, 2);
});

test('parseRetryAfterMs: seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('7'), 7000);
  assert.equal(parseRetryAfterMs(null), null);
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(parseRetryAfterMs('Thu, 01 Oct 2026 00:00:30 GMT', now), 30000);
  assert.equal(parseRetryAfterMs('garbage'), null);
});
