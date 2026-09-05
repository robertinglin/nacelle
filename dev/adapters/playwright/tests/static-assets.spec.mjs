import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserAssetPath, browserAssetContentType } from '../static-assets.mjs';
const adapterRoot = fileURLToPath(new URL('../', import.meta.url));

test('browser harness serves canonical sources and their relative dependency graph', () => {
  const pending = ['/runtime.js', '/index.js'];
  const seen = new Set();
  while (pending.length) {
    const request = pending.pop(); if (seen.has(request)) continue; seen.add(request);
    const { absolute } = browserAssetPath(request, adapterRoot);
    assert.ok(fs.existsSync(absolute), `${request} -> ${absolute}`);
    const source = fs.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+\.m?js)['"]/g)) {
      pending.push(new URL(match[1], `http://localhost${request}`).pathname);
    }
  }
  assert.ok(seen.size > 40, `only ${seen.size} modules checked`);
  assert.equal(browserAssetPath('/runtime.js', adapterRoot).absolute, path.resolve(adapterRoot, '../../../src/runtime.js'));
});

test('browser harness uses WebAssembly MIME type and rejects encoded path escapes', () => {
  assert.equal(browserAssetContentType('engine.wasm'), 'application/wasm');
  assert.throws(() => browserAssetPath('/runtime/%2e%2e%2f%2e%2e%2foutside.js', adapterRoot), /unsafe/);
  assert.throws(() => browserAssetPath('/%zz', adapterRoot), /unsafe/);
});
