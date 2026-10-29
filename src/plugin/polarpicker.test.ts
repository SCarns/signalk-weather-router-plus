import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

/** Minimal select behavior: replacing options resets selection, and an absent value selects nothing. */
class Select {
  options: { value: string }[] = [];
  private selected = '';
  get value(): string {
    return this.selected;
  }
  set value(v: string) {
    this.selected = this.options.some(o => o.value === v) ? v : '';
  }
  set innerHTML(html: string) {
    this.options = [...html.matchAll(/<option value="([^"]*)">/g)].map(m => ({ value: m[1] }));
    this.selected = this.options[0]?.value ?? '';
  }
}

/** Run the real picker functions with only the DOM and API boundaries replaced. */
function picker(stored: string, filter: string) {
  const sel = new Select();
  const input = { value: filter };
  const previews: string[] = [];
  const nodes: Record<string, unknown> = { polarSelect: sel, polarFilter: input, openVesselForm: {}, polarInfo: {} };
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-core.js'), 'utf8');
  const code = source.slice(source.indexOf('let _polarItems = [];'), source.indexOf('export let _polarAngles'));
  const context = {
    document: {
      getElementById: (id: string) => nodes[id],
      createElement: () => ({
        value: '',
        textContent: '',
        get outerHTML() {
          return `<option value="${this.value}">${this.textContent}</option>`;
        },
      }),
    },
    prefs: { get: () => stored },
    API: '/api',
    authFetch: async () => ({
      ok: true,
      json: async () => [
        { path: 'auto', label: 'Automatic' },
        { path: 'signalk-active', label: 'Polar Management: TBD' },
        { path: 'other.pol', label: 'Other boat' },
      ],
    }),
    loadPolarAngles: () => {},
    loadPolarTable: (value: string) => previews.push(value),
    drawPolarDiagram: () => {},
    console,
  };
  const refresh = runInNewContext(`${code}\nloadPolarList`, context) as () => Promise<void>;
  return { refresh, sel, input, previews };
}

test('periodic polar refresh keeps the current filter and the selected matching polar', async () => {
  const p = picker('signalk-active', 'tbd');
  await p.refresh();
  await p.refresh();
  assert.equal(p.input.value, 'tbd');
  assert.deepEqual(p.sel.options, [{ value: 'signalk-active' }]);
  assert.equal(p.sel.value, 'signalk-active');
  assert.deepEqual(p.previews, ['signalk-active', 'signalk-active']);
});

test('a saved polar excluded by the filter does not clear the matching selection', async () => {
  const p = picker('other.pol', 'tbd');
  await p.refresh();
  assert.equal(p.sel.value, 'signalk-active');
  assert.deepEqual(p.previews, ['signalk-active']);
});

test('with no saved polar and no filter the picker defaults to automatic detection', async () => {
  const p = picker('', '');
  await p.refresh();
  assert.equal(p.sel.value, 'auto');
});

test('a pending table response cannot restore a preview after the polar list fails', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/rp-core.js'), 'utf8');
  const code = source.slice(source.indexOf('let _polarItems = [];'), source.indexOf('const _POLAR_TWS_COLORS')).replace(/^export /gm, '');
  const select = new Select();
  const hint = { textContent: '', appendChild() {} };
  const nodes: Record<string, unknown> = {
    polarSelect: select,
    polarFilter: { value: '' },
    openVesselForm: {},
    polarInfo: {},
    polarSourceHint: hint,
  };
  let lists = 0;
  let finishTable!: (r: Response) => void;
  const pending = new Promise<Response>(resolve => {
    finishTable = resolve;
  });
  const context = {
    document: {
      getElementById: (id: string) => nodes[id],
      createElement: () => ({
        value: '',
        textContent: '',
        get outerHTML() {
          return `<option value="${this.value}">${this.textContent}</option>`;
        },
      }),
      createTextNode: () => ({}),
    },
    prefs: { get: () => '' },
    API: '/api',
    authFetch: async (url: string) => {
      if (url.includes('/polars/table')) return pending;
      if (url.includes('/polar-angles')) return Response.json({ tws_ms: [5] });
      lists++;
      return lists === 1
        ? Response.json([{ path: 'auto', label: 'Automatic' }])
        : Response.json({ error: 'List unavailable' }, { status: 503 });
    },
    drawPolarDiagram: () => {},
    unitText: (s: string) => s,
    console: { log() {} },
  };
  const picker = runInNewContext(`${code}\n({refresh:loadPolarList, table:()=>_polarTable})`, context) as {
    refresh: () => Promise<void>;
    table: () => unknown;
  };
  await picker.refresh(); // Starts the table request, whose body has not arrived.
  await picker.refresh(); // List fails while that request remains pending.
  finishTable(Response.json({ source: 'signalk', label: 'Stale boat', twa_deg: [45, 90], tws_ms: [5], speeds_ms: [[2], [3]] }));
  // Drain the fetch/body/preview promise chain without relying on a wall-clock delay.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(picker.table(), null);
  assert.equal(hint.textContent, 'Active source unavailable: List unavailable');
});
