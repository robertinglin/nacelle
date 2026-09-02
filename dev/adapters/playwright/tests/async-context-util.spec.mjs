import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser-native async context and util primitives', () => {
  test('supports v22 util.promisify callback, custom, and multi-value contracts', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const util = require('node:util');
        const fs = require('node:fs');
        const { promisify } = util;
        assert.strictEqual(Object.hasOwn(util, 'promisify'), true);
        assert.strictEqual(typeof promisify, 'function');
        assert.strictEqual(promisify.custom, Symbol.for('nodejs.util.promisify.custom'));
        assert.strictEqual(await promisify(fs.exists)('/node'), true);
        assert.strictEqual(await promisify(fs.exists)('/does-not-exist'), false);

        const receiver = { value: 7, read(callback) { callback(null, this.value); } };
        receiver.readAsync = promisify(receiver.read);
        assert.strictEqual(await receiver.readAsync(), 7);

        const pair = (first, second, callback) => callback(null, first, second);
        Object.defineProperty(pair, util.customPromisifyArgs, { value: ['first', 'second'] });
        assert.deepStrictEqual(await promisify(pair)('a', 'b'), { first: 'a', second: 'b' });

        const failure = new Error('callback failure');
        await assert.rejects(promisify((callback) => callback(failure))(), failure);

        const original = () => {};
        const custom = () => 'custom';
        original[promisify.custom] = custom;
        assert.strictEqual(promisify(original), custom);
        assert.strictEqual(promisify(promisify(original)), custom);
        const wrapped = promisify((callback) => callback(null, 3));
        assert.strictEqual(promisify(wrapped), wrapped);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('propagates AsyncLocalStorage through browser tasks and exit scopes', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const {
          AsyncLocalStorage,
          AsyncResource,
          createHook,
          executionAsyncResource,
        } = require('node:async_hooks');
        const storage = new AsyncLocalStorage();
        const events = [];
        const resources = new Map();
        const hook = createHook({
          init(id, type, triggerId, resource) {
            if (type === 'BrowserResource') {
              resources.set(id, resource);
              events.push(['init', id, triggerId, resource]);
            }
          },
          before(id) {
            if (resources.has(id)) assert.strictEqual(executionAsyncResource(), resources.get(id));
            events.push(['before', id, executionAsyncResource()]);
          },
          after(id) {
            if (resources.has(id)) assert.strictEqual(executionAsyncResource(), resources.get(id));
            events.push(['after', id, executionAsyncResource()]);
          },
        }).enable();

        const rootResource = executionAsyncResource();
        let resolveExit;
        const exitDone = new Promise((resolve) => { resolveExit = resolve; });
        assert.strictEqual(typeof rootResource, 'object');
        assert.strictEqual(storage.getStore(), undefined);

        await storage.run({ name: 'outer' }, async () => {
          assert.strictEqual(storage.getStore().name, 'outer');
          await Promise.resolve().then(() => {
            assert.strictEqual(storage.getStore().name, 'outer');
          });

          await new Promise((resolve) => setTimeout(() => {
            assert.strictEqual(storage.getStore().name, 'outer');
            resolve();
          }, 0));

          const resource = new AsyncResource('BrowserResource');
          assert.notStrictEqual(executionAsyncResource(), rootResource);
          assert.notStrictEqual(executionAsyncResource(), resource);
          resource.runInAsyncScope(() => {
            assert.strictEqual(executionAsyncResource(), resource);
            assert.strictEqual(storage.getStore().name, 'outer');
          });
          resource.emitDestroy();

          storage.exit(() => {
            assert.strictEqual(storage.getStore(), undefined);
            Promise.resolve().then(() => assert.strictEqual(storage.getStore(), undefined));
            setTimeout(() => {
              assert.strictEqual(storage.getStore(), undefined);
              resolveExit();
            }, 0);
          });
          assert.strictEqual(storage.getStore().name, 'outer');
        });

        await exitDone;
        assert.strictEqual(storage.getStore(), undefined);
        assert.ok(events.some(([kind, , resource]) => kind === 'before' && resource));
        hook.disable();
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });
});
