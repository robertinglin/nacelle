import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModuleLoader } from '../../../../src/runtime/module-loader.js';
import { createNodeTest } from '../../../../src/runtime/node-test.js';

test('canonicalizes bare and node: builtin names without VFS fallback', () => {
  const dns = { name: 'dns' };
  const loader = createModuleLoader({
    files: new Map([
      ['/node/dns.js', 'throw new Error("dns VFS fallback")'],
      ['/node/entry.js', 'module.exports = require("node:dns")'],
    ]),
    builtins: { dns },
  });

  assert.equal(loader.resolve('dns'), 'dns');
  assert.equal(loader.resolve('node:dns'), 'node:dns');
  assert.equal(loader.require('dns'), dns);
  assert.equal(loader.require('node:dns'), dns);
  assert.throws(() => loader.require('node:missing'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
});

test('aggregates async node:test suites, hooks, and subtests', async () => {
  const output = [];
  const errors = [];
  const processObject = { exitCode: 0 };
  const scope = {
    process: processObject,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
  };
  let pending = 0;
  const nodeTest = createNodeTest({
    scope,
    processObject,
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
    assert,
    trackTask: () => {
      pending += 1;
      return () => { pending -= 1; };
    },
  });

  nodeTest.describe('suite', () => {
    nodeTest.before(() => output.push('before'));
    nodeTest.after(() => output.push('after'));
    nodeTest.beforeEach(() => output.push('beforeEach'));
    nodeTest.afterEach(() => output.push('afterEach'));
    nodeTest.it('parent', async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await context.test('child', () => output.push('child'));
    });
  });
  nodeTest.skip('skipped', () => { throw new Error('skip callback ran'); });
  nodeTest.__bnhSourceLoaded();

  await Promise.resolve();
  while (pending) await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(processObject.exitCode, 0);
  assert.deepEqual(errors, []);
  assert.ok(output.includes('before'));
  assert.ok(output.includes('child'));
  assert.ok(output.includes('after'));
  assert.ok(output.some((line) => line.includes('skipped') && line.includes('# SKIP')));
});
