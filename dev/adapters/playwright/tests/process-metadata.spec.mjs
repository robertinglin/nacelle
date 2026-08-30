import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser Node process metadata', () => {
  test('exposes the metadata required by test/common/index.js without host-process capabilities', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');

        assert.ok(process.config && typeof process.config === 'object');
        assert.ok(process.config.variables && typeof process.config.variables === 'object');
        assert.strictEqual(process.config.variables.v8_enable_i18n_support, 1);
        assert.strictEqual(process.config.variables.openssl_quic, false);
        assert.strictEqual(process.config.variables.asan, 0);

        assert.ok(process.config.target_defaults && typeof process.config.target_defaults === 'object');
        assert.strictEqual(process.config.target_defaults.default_configuration, 'Release');

        assert.ok(process.features && typeof process.features === 'object');
        assert.strictEqual(process.features.inspector, false);
        assert.strictEqual(process.features.debug, false);

        assert.ok(process.versions && typeof process.versions === 'object');
        assert.strictEqual(typeof process.versions.openssl, 'undefined');

        // These values identify the browser runtime and must not report a host Node executable.
        assert.strictEqual(process.execPath, '/browser/node');
        assert.strictEqual(process.pid, 1);
        assert.strictEqual(process.ppid, 0);
      })();
    `);

    await expectPass(expect, result);
  });
});
