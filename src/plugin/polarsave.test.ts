import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerPolarManagementSave, saveGeneratedPolar } from '../../public/rp-polar.js';

const canonical = { kind: 'polarTable', name: 'Generated boat' };

test('generated polar handoff uses the provider importer, with no overwrite or activation', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const id = await saveGeneratedPolar(async (url, init) => {
    calls.push({ url, init: init as RequestInit });
    return Response.json({ id: 'generated-boat-123' });
  }, canonical);
  assert.equal(id, 'generated-boat-123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/plugins/signalk-polar-management/imports/text/canonical');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { content: JSON.stringify(canonical) });
});

test('provider absence, validation, permissions and unexpected responses report failure', async () => {
  for (const status of [404, 405, 503])
    await assert.rejects(
      saveGeneratedPolar(async () => new Response('Not available', { status }), canonical),
      /Your local polar is saved/
    );
  for (const status of [400, 401, 403])
    await assert.rejects(
      saveGeneratedPolar(async () => Response.json({ error: 'Provider refused' }, { status }), canonical),
      /Provider refused/
    );
  await assert.rejects(
    saveGeneratedPolar(async () => Response.json({}), canonical),
    /Check its library/
  );
  await assert.rejects(
    saveGeneratedPolar(async () => {
      throw new Error('offline');
    }, canonical),
    /offline/
  );
});

/** DOM boundary for the save action: records text, children and the click listener. */
class Element {
  style: Record<string, string> = {};
  textContent = '';
  disabled = false;
  type = '';
  href = '';
  children: Element[] = [];
  click: (() => Promise<void>) | undefined;
  ownerDocument = { createElement: () => new Element() };
  setAttribute(): void {}
  addEventListener(_name: string, handler: () => Promise<void>): void {
    this.click = handler;
  }
  append(...elements: Element[]): void {
    this.children.push(...elements);
  }
  appendChild(el: Element): void {
    this.children.push(el);
  }
}

test('save is opt-in; provider failure can be retried and success leaves activation to the user', async () => {
  const container = new Element();
  let calls = 0;
  offerPolarManagementSave(container as never, canonical, async () => {
    calls++;
    return calls === 1 ? Response.json({ error: 'Provider unavailable' }, { status: 503 }) : Response.json({ id: 'new-copy' });
  });
  assert.equal(calls, 0, 'generation does not write to the provider');
  const [button, note, link] = container.children[0].children;
  assert.equal(link.href, '/signalk-polar-management/');
  await button.click!();
  assert.equal(button.disabled, false, 'retry remains possible');
  assert.match(note.textContent, /Your local polar is saved/);
  await button.click!();
  assert.equal(button.disabled, true, 'avoid accidental duplicate imports after success');
  assert.match(note.textContent, /new-copy/);
  assert.match(note.textContent, /active polar has not changed/);
});
