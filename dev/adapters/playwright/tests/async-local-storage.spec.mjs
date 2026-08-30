import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('preserves AsyncLocalStorage.run through native async/await continuations', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const parent = { name: 'parent' };
      storage.enterWith(parent);

      const fulfilled = storage.run({ name: 'fulfilled' }, async () => {
        assert.strictEqual(storage.getStore().name, 'fulfilled');
        await Promise.resolve();
        assert.strictEqual(storage.getStore().name, 'fulfilled');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.strictEqual(storage.getStore().name, 'fulfilled');
        return 'done';
      });
      assert.strictEqual(storage.getStore().name, 'fulfilled');
      assert.strictEqual(await fulfilled, 'done');
      assert.strictEqual(storage.getStore(), parent);

      const rejected = storage.run({ name: 'rejected' }, async () => {
        await Promise.resolve();
        assert.strictEqual(storage.getStore().name, 'rejected');
        throw new Error('expected rejection');
      });
      await assert.rejects(rejected, /expected rejection/);
      assert.strictEqual(storage.getStore(), parent);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('scopes enterWith to tasks created after the store is entered', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const store = { foo: 'bar' };

      await new Promise((resolve) => {
        let completed = 0;
        const done = () => {
          completed += 1;
          if (completed === 2) resolve();
        };

        setImmediate(() => {
          storage.enterWith(store);
          assert.strictEqual(storage.getStore(), store);
          setTimeout(() => {
            assert.strictEqual(storage.getStore(), store);
            done();
          }, 10);
        });

        setTimeout(() => {
          assert.strictEqual(storage.getStore(), undefined);
          done();
        }, 10);
      });
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('propagates Promise.resolve continuations created inside AsyncLocalStorage.run', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const expected = new Error('expected rejection');
      const next = () => Promise.resolve().then(() => {
        assert.strictEqual(storage.getStore().get('a'), 1);
        throw expected;
      });

      await assert.rejects(new Promise((resolve, reject) => {
        const result = storage.run(new Map(), () => {
          const store = storage.getStore();
          store.set('a', 1);
          next().then(resolve, reject);
        });
        assert.strictEqual(result, undefined);
      }), expected);
      assert.strictEqual(storage.getStore(), undefined);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});
