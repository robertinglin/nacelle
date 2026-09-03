import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';
import { createModuleLoader } from '../runtime/module-loader.js';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('preserves the node: prefix for builtin module identity', () => {
  const loader = createModuleLoader({
    files: new Map(),
    builtins: { assert: {} },
    globalObject: {},
  });

  expect(loader.resolve('assert')).toBe('assert');
  expect(loader.resolve('node:assert')).toBe('node:assert');
  expect(loader.moduleURL('assert')).not.toBe(loader.moduleURL('node:assert'));

  loader.dispose();
});

test.describe('browser ESM loader', () => {
  test('runs a mounted mjs entry with VFS-relative modules and builtins', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { answer, moduleURL } from './answer.mjs';
      import cjsValue from './fixture.cjs';
      const dynamic = await import('./dynamic.mjs');
      assert.strictEqual(answer, 42);
      assert.strictEqual(cjsValue, 'from commonjs');
      assert.strictEqual(dynamic.value, 84);
      assert.strictEqual(moduleURL, '/node/esm/answer.mjs');
      process.stdout.write('esm entry completed');
    `, {
      entryPath: '/node/esm/main.mjs',
      files: {
        '/node/esm/answer.mjs': `
          import { fileURLToPath } from 'node:url';
          export const answer = 42;
          export const moduleURL = fileURLToPath(import.meta.url);
        `,
        '/node/esm/dynamic.mjs': 'export const value = 84;',
        '/node/esm/fixture.cjs': "module.exports = 'from commonjs';",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('esm entry completed');
  });

  test('resolves dynamic imports of builtin modules inside ESM', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const fs = await import('fs');
      if (typeof fs.readFileSync !== 'function') throw new Error('fs builtin was not loaded');
      process.stdout.write('dynamic builtin completed');
    `, { entryPath: '/node/esm/dynamic-builtin.mjs' });

    await expectPass(expect, result);
    expect(result.stdout).toContain('dynamic builtin completed');
  });

  test('routes global ESM console errors to the child stderr stream', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      console.error('esm child diagnostic');
      process.exitCode = 1;
    `, { entryPath: '/node/esm/console-error.mjs' });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('esm child diagnostic');
  });

  test('rewrites minified static imports with no whitespace around from', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import marker from './minified.mjs';
      if (marker !== 'minified builtin completed') throw new Error(marker);
      process.stdout.write(marker);
    `, {
      entryPath: '/node/esm/minified-entry.mjs',
      files: {
        '/node/esm/minified.mjs': 'var marker=1;import fs from"fs";export default typeof fs.readFileSync === "function" ? "minified builtin completed" : "wrong";',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('minified builtin completed');
  });

  test('rewrites minified imports in a package-scoped .js ESM module', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import marker from './package/index.js';
      if (marker !== 'package builtin completed') throw new Error(marker);
      process.stdout.write(marker);
    `, {
      entryPath: '/node/esm/package-entry.mjs',
      files: {
        '/node/esm/package/package.json': JSON.stringify({ type: 'module' }),
        '/node/esm/package/index.js': 'const quoted=/["\']/;import fs from"fs";export default typeof fs.readFileSync === "function" ? "package builtin completed" : "wrong";',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('package builtin completed');
  });

  test('loads a cyclic ESM graph without deadlocking URL materialization', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import { value } from './cycle-a.mjs';
      if (value !== 'ab') throw new Error(value);
      process.stdout.write(value);
    `, {
      entryPath: '/node/esm/cycle-entry.mjs',
      files: {
        '/node/esm/cycle-a.mjs': "import { value as other } from './cycle-b.mjs'; export const value = 'a' + other;",
        '/node/esm/cycle-b.mjs': "import { value as other } from './cycle-a.mjs'; export const value = 'b'; void other;",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('ab');
  });

  test('loads hashbang ESM and exposes events.once as a named export', async ({ harnessPage }) => {
    const source = `#! }]) // isn't js
      import assert from 'node:assert/strict';
      import { EventEmitter, once } from 'node:events';
      import marker from '../common/index.mjs';
      const emitter = new EventEmitter();
      const event = once(emitter, 'value');
      emitter.emit('value', marker, 42);
      assert.deepStrictEqual(await event, ['common', 42]);
      assert.strictEqual(typeof once, 'function');
      process.stdout.write('hashbang esm completed');
`;
    const result = await harnessPage.run(source, {
      entryPath: '/node/esm/test-esm-shebang.mjs',
      files: {
        '/node/common/index.mjs': 'export default "common";',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('hashbang esm completed');
  });
});
