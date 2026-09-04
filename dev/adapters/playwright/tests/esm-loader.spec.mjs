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

  test('exposes the default export of a JSON ESM import', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import irregularPlurals from './irregular-plurals.json' with { type: 'json' };
      assert.deepStrictEqual(irregularPlurals, { person: 'people', mouse: 'mice' });
      process.stdout.write('json default completed');
    `, {
      entryPath: '/node/esm/json-entry.mjs',
      files: {
        '/node/esm/irregular-plurals.json': JSON.stringify({ person: 'people', mouse: 'mice' }),
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('json default completed');
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

  test('routes deferred eval imports from an ESM module through the virtual loader', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      const dynamicImport = eval('(url) => import(url)');
      const loaded = await dynamicImport('./loaded.mjs');
      assert.strictEqual(loaded.answer, 43);
      process.stdout.write('esm eval dynamic import completed');
    `, {
      entryPath: '/node/esm/eval-dynamic-import.mjs',
      files: { '/node/esm/loaded.mjs': 'export const answer = 43;' },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('esm eval dynamic import completed');
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

  test('preserves conditional package imports and ESM named exports', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { marker } from 'conditional-esm-package';
      assert.strictEqual(marker, 'node-condition');
      process.stdout.write('conditional ESM package completed');
    `, {
      entryPath: '/node/conditional-entry.mjs',
      files: {
        '/node/node_modules/conditional-esm-package/package.json': JSON.stringify({
          type: 'module',
          imports: {
            '#runtime': {
              node: './node-runtime.js',
              default: './default-runtime.js',
            },
          },
          exports: { '.': './index.js' },
        }),
        '/node/node_modules/conditional-esm-package/index.js': "export { marker } from '#runtime';",
        '/node/node_modules/conditional-esm-package/node-runtime.js': "export const marker = 'node-condition';",
        '/node/node_modules/conditional-esm-package/default-runtime.js': "export const marker = 'default-condition';",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('conditional ESM package completed');
  });

  test('preserves named exports through dynamic conditional ESM imports', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      const module = await import('dynamic-conditional-package');
      assert.deepStrictEqual(module.supportsColor, { level: 0 });
      assert.deepStrictEqual(module.supportsColorNamed, { level: 0 });
      process.stdout.write('dynamic conditional ESM package completed');
    `, {
      entryPath: '/node/dynamic-conditional-entry.mjs',
      files: {
        '/node/node_modules/dynamic-conditional-package/package.json': JSON.stringify({
          type: 'module',
          imports: {
            '#supports-color': {
              node: './node-supports-color.js',
              default: './browser-supports-color.js',
            },
          },
          exports: './source/index.js',
        }),
        '/node/dynamic-conditional-entry.mjs': `
          import assert from 'node:assert/strict';
          const module = await import('dynamic-conditional-package');
          assert.deepStrictEqual(module.supportsColor, { level: 0 });
          assert.deepStrictEqual(module.supportsColorNamed, { level: 0 });
          process.stdout.write('dynamic conditional ESM package completed');
        `,
        '/node/node_modules/dynamic-conditional-package/source/index.js': `
          import supportsColor from '#supports-color';
          const { stdout } = supportsColor;
          export { stdout as supportsColor, stdout as supportsColorNamed };
        `,
        '/node/node_modules/dynamic-conditional-package/node-supports-color.js': 'export default { stdout: { level: 0 } };',
        '/node/node_modules/dynamic-conditional-package/browser-supports-color.js': 'export default { stdout: { level: 3 } };',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('dynamic conditional ESM package completed');
  });

  test('runs a forked unknown-extension entry through an async module.register loader hook', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert/strict');
      const { fork } = require('node:child_process');

      const child = fork('/node/node_modules/loader-fixture/worker.ts', [], {
        cwd: '/node',
        env: { ...process.env, NODE_OPTIONS: '--import=loader-fixture/register' },
        silent: true,
      });
      child.once('error', (error) => {
        process.stderr.write(error.stack + '\\n');
        process.exitCode = 1;
      });
      child.once('message', (message) => {
        assert.deepStrictEqual(message, { answer: 42 });
      });
      child.once('close', (code, signal) => {
        assert.strictEqual(code, 0);
        assert.strictEqual(signal, null);
        process.stdout.write('async loader fork contract passed');
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({ type: 'module' }),
        '/node/node_modules/loader-fixture/package.json': JSON.stringify({
          name: 'loader-fixture',
          type: 'module',
          exports: { './register': './register.mjs' },
        }),
        '/node/node_modules/loader-fixture/register.mjs': `
          import { register } from 'node:module';
          register('./hooks.mjs', import.meta.url);
        `,
        '/node/node_modules/loader-fixture/hooks.mjs': `
          export async function resolve(specifier, context, nextResolve) {
            return nextResolve(specifier, context);
          }
          export async function load(url, context, nextLoad) {
            if (!url.endsWith('.ts')) return nextLoad(url, context);
            const result = await nextLoad(url, { ...context, format: 'module' });
            const source = typeof result.source === 'string'
              ? result.source
              : new TextDecoder().decode(result.source);
            return { format: 'module', shortCircuit: true, source: source.replace(/: number\\b/g, '') };
          }
        `,
        '/node/node_modules/loader-fixture/worker.ts': `
          import assert from 'node:assert/strict';
          const answer: number = 42;
          assert.strictEqual(answer, 42);
          process.send({ answer });
          process.disconnect();
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('async loader fork contract passed');
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
