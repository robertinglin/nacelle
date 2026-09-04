import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime ALS message port propagation', () => {
  test('preserves ALS store across MessageChannel postMessage delivery', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const als = new AsyncLocalStorage();
      const channel = new MessageChannel();
      let settled = false;
      const finish = (where, store) => {
        if (settled) return;
        settled = true;
        channel.port1.close();
        channel.port2.close();
        assert.deepStrictEqual(store, { v: 42 }, where + ' expected store {v:42}, got ' + JSON.stringify(store));
      };
      channel.port1.onmessage = () => finish('onmessage', als.getStore());
      als.run({ v: 42 }, () => channel.port2.postMessage('go'));
      // Keep the entry alive until the message round-trips.
      const spin = () => { if (!settled) setTimeout(spin, 10); };
      spin();
    `, { timeoutMs: 30000 });

    await expectPass(expect, result);
  });
});
