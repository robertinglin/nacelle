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
