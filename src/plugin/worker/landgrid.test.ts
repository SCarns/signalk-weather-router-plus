import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gridBuilderEntry } from './landgrid';

test('the grid builder thread is started from a module that exists (it lives one folder above the worker folder)', () => {
  const entry = gridBuilderEntry();
  assert.ok(fs.existsSync(entry), `${entry} does not exist`);
  assert.match(entry, /[\\/]plugin[\\/]gridbuilder\.(ts|js)$/);
});
