import process from 'node:process';
import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser Node process umask', () => {
  test('is browser-local and preserves Node umask semantics', async ({ harnessPage }) => {
    const hostUmaskBefore = process.umask();
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');

        assert.strictEqual(process.umask(), 0o022);
        assert.strictEqual(process.umask(0o077), 0o022);
        assert.strictEqual(process.umask(), 0o077);
      })();
    `);
    const hostUmaskAfter = process.umask();

    await expectPass(expect, result);
    expect(hostUmaskAfter).toBe(hostUmaskBefore);
  });

  test('exposes browser-local uid/gid and high-bit umask semantics', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');

        assert.strictEqual(process.getuid(), 1000);
        assert.strictEqual(process.getgid(), 1000);
        assert.strictEqual(process.umask(0o10664), 0o022);
        assert.strictEqual(process.umask(), 0o664);
        assert.strictEqual(process.umask('10664'), 0o664);
        assert.throws(() => process.umask('999'), { code: 'ERR_INVALID_ARG_VALUE' });
        assert.throws(() => process.setuid({}), { code: 'ERR_INVALID_ARG_TYPE' });
        assert.throws(() => process.setuid('nobody'), {
          code: 'ERR_UNKNOWN_CREDENTIAL',
          message: 'User identifier does not exist: nobody',
        });
      })();
    `);

    await expectPass(expect, result);
  });
});
