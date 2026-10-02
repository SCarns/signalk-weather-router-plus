/**
 * The web app's files as the API serves them: index.html's script and
 * style tags and the ES modules' import specifiers all carry the same
 * ?v= tag, so a browser sees one URL (one module instance) per file and
 * a new install never runs a stale script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerApi, type ApiDeps } from './api';

type Handler = (req: unknown, res: unknown) => unknown;

function serve(publicDir: string): (file: string) => Promise<{ status: number; body: string; type: string | null }> {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (p: string | string[], h: Handler) => {
    for (const x of Array.isArray(p) ? p : [p]) routes.set(`${m} ${x}`, h);
  };
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  registerApi(router as never, { pluginId: 'x', basePath: '/x', publicDir } as unknown as ApiDeps);
  return async (file: string) => {
    const h = routes.get('GET /ui/:file')!;
    let status = 200;
    let body = '';
    let type: string | null = null;
    const res = {
      status(c: number) {
        status = c;
        return res;
      },
      type(t: string) {
        type = t;
        return res;
      },
      send(b: string) {
        body = b;
        return res;
      },
      json(b: unknown) {
        body = JSON.stringify(b);
        return res;
      },
      setHeader() {
        return res;
      },
      sendFile(p: string) {
        body = fs.readFileSync(p, 'utf8');
        return res;
      },
      headersSent: false,
      destroyed: false,
    };
    await h({ params: { file }, query: {}, path: `/ui/${file}` }, res);
    return { status, body, type };
  };
}

test('index.html tags and module import specifiers carry one and the same version tag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-public-'));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<link rel="stylesheet" href="ol.css">\n<script src="ol.js"></script>\n<script type="module" src="rp-plan.js"></script>\n'
  );
  fs.writeFileSync(path.join(dir, 'rp-core.js'), 'export const API = "/x/api";\n');
  fs.writeFileSync(
    path.join(dir, 'rp-plan.js'),
    "import { API } from './rp-core.js';\nimport './rp-layers.js';\nconst s = 'from \"./rp-core.js\" in a string stays';\nconsole.log(API, s);\n"
  );
  fs.writeFileSync(path.join(dir, 'ol.js'), "import './rp-core.js'; // vendored: not ours, not rewritten\n");
  const get = serve(dir);
  const html = await get('index.html');
  const tags = [...html.body.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  const tag = tags[0].split('?v=')[1];
  assert.ok(tag && tag.length > 0, 'a tag');
  assert.deepEqual(tags, [`ol.css?v=${tag}`, `ol.js?v=${tag}`, `rp-plan.js?v=${tag}`]);
  const plan = await get('rp-plan.js');
  assert.equal(plan.type, 'application/javascript');
  assert.match(plan.body, new RegExp(`^import \\{ API \\} from './rp-core\\.js\\?v=${tag}';$`, 'm'));
  assert.match(plan.body, new RegExp(`^import './rp-layers\\.js\\?v=${tag}';$`, 'm'));
  assert.match(plan.body, /from "\.\/rp-core\.js" in a string stays/, 'only import specifiers change');
  const ol = await get('ol.js');
  assert.equal(ol.body, "import './rp-core.js'; // vendored: not ours, not rewritten\n");
  fs.rmSync(dir, { recursive: true, force: true });
});
