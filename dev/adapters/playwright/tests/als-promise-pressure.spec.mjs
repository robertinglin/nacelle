import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime ALS promise pressure', () => {
  test('keeps the ALS store alive across a long await chain', async ({ harnessPage }) => {
    // Firefox's browser-native Promise scheduler needs more wall-clock budget
    // for two million tracked awaits when this test runs in the full suite.
    const pressureTimeoutMs = 240000;
    test.setTimeout(pressureTimeoutMs);
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const als = new AsyncLocalStorage();
      (async () => {
        const final = await als.run({ tag: 'store' }, async () => {
          for (let i = 0; i < 2000000; i += 1) {
            await Promise.resolve();
            if (als.getStore() === undefined) return 'LOST@' + i;
          }
          return als.getStore() === undefined ? 'LOST@end' : 'OK';
        });
        assert.strictEqual(final, 'OK');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, { timeoutMs: pressureTimeoutMs });

    await expectPass(expect, result);
  });
});
