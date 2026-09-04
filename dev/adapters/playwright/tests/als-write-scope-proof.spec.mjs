import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime ALS stream write scope', () => {
  test('preserves ALS store for write callbacks queued behind an in-flight write', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const { Writable } = require('node:stream');
      const als = new AsyncLocalStorage();
      let phase = 'init';
      const w = new Writable({ write(chunk, enc, cb) { setImmediate(cb); } });
      w.write('warm', () => { phase = 'warm-done'; });
      als.run({ v: 7 }, () => {
        // Queued behind the in-flight warm write; the pump will resume this
        // write from its own microtask chain, not from this scope.
        w.write('probe', () => {
          phase = 'done';
          const store = als.getStore();
          if (!store || store.v !== 7) {
            console.error('WRITE-SCOPE LOST store=' + JSON.stringify(store));
            process.exitCode = 1;
          }
        });
      });
      const spin = () => { if (phase !== 'done') setTimeout(spin, 10); };
      spin();
      const watchdog = setTimeout(() => {
        console.error('WRITE-SCOPE STUCK at ' + phase);
        process.exitCode = 1;
      }, 15000);
      watchdog.unref?.();
    `, { timeoutMs: 30000 });

    await expectPass(expect, result);
  });
});
