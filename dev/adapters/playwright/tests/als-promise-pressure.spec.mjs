import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime ALS promise pressure', () => {
  test('keeps the ALS store alive across a long await chain', async ({ harnessPage }) => {
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
    `, { timeoutMs: 180000 });

    await expectPass(expect, result);
  });
});
