import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('runs top-level-await ESM children without changing CommonJS children', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert');
    const { spawn } = require('node:child_process');

    const runChild = (entry) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry]);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, output }));
    });

    (async () => {
      assert.deepStrictEqual(await runChild('/node/child-esm.mjs'), {
        code: 0,
        signal: null,
        output: 'esm-child',
      });
      assert.deepStrictEqual(await runChild('/node/child-commonjs.js'), {
        code: 0,
        signal: null,
        output: 'commonjs-child',
      });
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `, {
    files: {
      '/node/child-esm.mjs': `
        import { value } from './child-value.mjs';
        await Promise.resolve();
        process.stdout.write(value);
      `,
      '/node/child-value.mjs': 'export const value = "esm-child";',
      '/node/child-commonjs.js': 'process.stdout.write("commonjs-child");',
    },
  });

  await expectPass(expect, result);
});
