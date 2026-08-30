import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('passes the Node test global-check setting into browser process.env', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (() => {
      const assert = require('node:assert');
      assert.strictEqual(process.env.NODE_TEST_KNOWN_GLOBALS, '0');
    })();
  `, { env: { NODE_TEST_KNOWN_GLOBALS: '0' } });

  await expectPass(expect, result);
});
