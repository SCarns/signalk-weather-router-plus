// Runs every src/**/*.test.ts under `node --test` with the tsx loader.
// Node 20's test runner does not expand `**` globs (that came in Node 21),
// and a shell `find` does not work under Windows' cmd, so the files are
// listed here and passed explicitly. Extra arguments are passed through.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function find(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) find(p, out);
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = find('src', []).sort();
if (files.length === 0) {
  console.error('no test files found under src/');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', '--import', 'tsx', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
