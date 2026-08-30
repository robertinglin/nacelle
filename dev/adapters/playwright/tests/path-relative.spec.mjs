import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime node:path relative', () => {
  test('computes equal and nested POSIX paths', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const path = require('node:path');
        assert.strictEqual(path.posix.relative('/node/project', '/node/project'), '');
        assert.strictEqual(
          path.posix.relative('/node/project', '/node/project/src/runtime.js'),
          'src/runtime.js',
        );
        assert.strictEqual(
          path.posix.relative('/node/project/src/runtime.js', '/node/project/test/fixture.js'),
          '../../test/fixture.js',
        );
      })();
    `);

    await expectPass(expect, result);
  });

  test('computes equal and nested Windows paths', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const path = require('node:path');
        const slash = String.fromCharCode(92);
        const project = ['C:', slash, 'node', slash, 'project'].join('');
        const source = [project, slash, 'src', slash, 'runtime.js'].join('');
        const fixture = [project, slash, 'test', slash, 'fixture.js'].join('');
        assert.strictEqual(path.win32.relative(project, project), '');
        assert.strictEqual(
          path.win32.relative(project, source),
          ['src', slash, 'runtime.js'].join(''),
        );
        assert.strictEqual(
          path.win32.relative(source, fixture),
          ['..', '..', 'test', 'fixture.js'].join(slash),
        );
      })();
    `);

    await expectPass(expect, result);
  });
});
