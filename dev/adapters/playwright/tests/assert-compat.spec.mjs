import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('Node assert v22 compatibility', () => {
  test('assert.equal treats NaN values as equal', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      assert.equal(NaN, NaN);
    `);

    await expectPass(expect, result);
  });

  test('loads the assert/strict builtin alias', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const strict = require('assert/strict');
      assert.strictEqual(strict, require('node:assert/strict'));
      assert.strictEqual(strict.equal, strict.strictEqual);
      assert.throws(() => strict.equal(1, '1'));
    `);

    await expectPass(expect, result);
  });

  test('assert.throws matches an Error constructor', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const thrown = assert.throws(
        () => { throw new TypeError('constructor match'); },
        Error,
      );
      assert.strictEqual(thrown.name, 'TypeError');
    `);

    await expectPass(expect, result);
  });

  test('assert.throws matches an error predicate', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const thrown = assert.throws(
        () => { throw new RangeError('predicate match'); },
        (error) => error instanceof RangeError && error.message === 'predicate match',
      );
      assert.strictEqual(thrown.name, 'RangeError');
    `);

    await expectPass(expect, result);
  });

  test('assert.throws matches an error message with a RegExp', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      assert.throws(
        () => { throw new Error('regexp match'); },
        /regexp match/,
      );
    `);

    await expectPass(expect, result);
  });

  test('assert.throws matches assertion error fields', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const thrown = assert.throws(
        () => assert.strictEqual(1, '1'),
        {
          message: /strictly equal/,
          name: 'AssertionError',
          operator: 'strictEqual',
          actual: 1,
          expected: '1',
        },
      );
      assert.strictEqual(thrown.name, 'AssertionError');
      assert.strictEqual(thrown.operator, 'strictEqual');
      assert.strictEqual(thrown.actual, 1);
      assert.strictEqual(thrown.expected, '1');
    `);

    await expectPass(expect, result);
  });

  test('assert.partialDeepStrictEqual matches a nested subset', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      assert.partialDeepStrictEqual(
        { status: 'rejected', reason: { code: 'ERR_TEST', message: 'details' }, extra: true },
        { status: 'rejected', reason: { code: 'ERR_TEST' } },
      );
      assert.partialDeepStrictEqual(
        [{ status: 'rejected', reason: new Error('first') }, { status: 'fulfilled', value: 1 }],
        [{ status: 'rejected' }, { status: 'fulfilled' }],
      );
    `);

    await expectPass(expect, result);
  });

  test('assert.partialDeepStrictEqual reports the Node operator and preserves exports', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      assert.strictEqual(typeof assert.partialDeepStrictEqual, 'function');
      assert.throws(
        () => assert.partialDeepStrictEqual({ status: 'fulfilled' }, { status: 'rejected' }),
        { name: 'AssertionError', code: 'ERR_ASSERTION', operator: 'partialDeepStrictEqual' },
      );
      assert.throws(
        () => assert.partialDeepStrictEqual({ value: 1 }),
        { code: 'ERR_MISSING_ARGS' },
      );
    `);

    await expectPass(expect, result);
  });
});
