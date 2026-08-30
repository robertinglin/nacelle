import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser-native node:test builtin', () => {
  test('runs a synchronous passing test', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { test } = require('node:test');

      test('sync pass', () => {
        assert.strictEqual(2 + 2, 4);
      });
    `);

    await expectPass(expect, result);
  });

  test('sets exitCode and writes stderr for a synchronous assertion failure', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { test } = require('node:test');

      test('sync failure', () => {
        assert.strictEqual('browser', 'node', 'node:test assertion failure');
      });
    `);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('node:test assertion failure');
  });

  test('waits for an asynchronous test to complete', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { test } = require('node:test');

      test('async completion', async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.strictEqual(true, true);
        process.stdout.write('async test completed\\n');
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('async test completed');
  });

  test('does not execute skipped or todo test callbacks', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const { test } = require('node:test');

      test('skipped callback', { skip: 'browser regression coverage' }, () => {
        throw new Error('skip callback executed');
      });
      test('todo callback', { todo: 'browser regression coverage' }, () => {
        throw new Error('todo callback executed');
      });
    `);

    await expectPass(expect, result);
    expect(result.stderr).not.toContain('callback executed');
  });
});
