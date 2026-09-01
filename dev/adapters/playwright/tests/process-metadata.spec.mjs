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
        assert.strictEqual(process.versions.webcontainer, '1.0.0');

        // These values identify the browser runtime and must not report a host Node executable.
        assert.strictEqual(process.execPath, '/browser/node');
        assert.strictEqual(process.pid, 1);
        assert.strictEqual(process.ppid, 0);
      })();
    `);

    await expectPass(expect, result);
  });

  test('keeps the owning process environment in CommonJS callbacks', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert/strict');
      const { fork } = require('node:child_process');
      const child = fork('/node/process-env-cjs-child.js', [], {
        env: { ...process.env, BNH_CHILD_ENV: 'child' },
      });
      child.once('error', (error) => {
        console.error(error.stack || error);
        process.exitCode = 1;
      });
      child.once('message', (message) => {
        try {
          assert.deepStrictEqual(message, {
            before: 'child',
            after: 'child',
            pid: message.pid,
          });
        } catch (error) {
          console.error(error.stack || error);
          process.exitCode = 1;
        }
      });
    `, {
      files: {
        '/node/process-env-cjs-child.js': `
          const readLater = require('/node/process-env-cjs-route.js');
          readLater().then((message) => {
            process.send(message);
            process.disconnect();
          }, (error) => {
            process.send({ error: String(error) });
            process.disconnect();
          });
        `,
        '/node/process-env-cjs-route.js': `
          const before = process.env.BNH_CHILD_ENV;
          module.exports = () => new Promise((resolve) => {
            setTimeout(() => {
              Promise.resolve().then(() => resolve({
                before,
                after: process.env.BNH_CHILD_ENV,
                pid: process.pid,
              }));
            }, 0);
          });
        `,
      },
    });

    await expectPass(expect, result);
  });
});
