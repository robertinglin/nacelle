import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('exposes the promise boundary used by async_hooks tracking', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const thenBefore = Promise.prototype.then;
      let thenCalls = 0;
      Promise.prototype.then = function observedThen(...args) {
        thenCalls += 1;
        return thenBefore.apply(this, args);
      };
      const resolved = Promise.resolve('resolved');
      const constructed = new Promise((resolve) => resolve('constructed'));
      const describe = (promise) => ({
        instanceofPromise: promise instanceof Promise,
        prototypeMatches: Object.getPrototypeOf(promise) === Promise.prototype,
        toStringTag: Object.prototype.toString.call(promise),
        thenMatches: promise.then === Promise.prototype.then,
        hasOwnThen: Object.hasOwn(promise, 'then'),
      });
      assert.deepStrictEqual(describe(resolved), {
        instanceofPromise: true,
        prototypeMatches: true,
        toStringTag: '[object Promise]',
        thenMatches: true,
        hasOwnThen: false,
      });
      assert.deepStrictEqual(describe(constructed), describe(resolved));
      assert.strictEqual(await resolved, 'resolved');
      assert.strictEqual(await constructed, 'constructed');
      assert.ok(thenCalls >= 2);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

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
      assert.strictEqual(storage.getStore(), parent);
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

test('keeps one run store across one native await', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const promise = storage.run('child', async () => {
        assert.strictEqual(storage.getStore(), 'child');
        await Promise.resolve();
        return storage.getStore();
      });
      assert.strictEqual(storage.getStore(), undefined);
      assert.strictEqual(await promise, 'child');
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('preserves a run store through a native async function boundary', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const nativeValue = async () => 1;
      const result = storage.run('native-boundary', async () => {
        await nativeValue();
        return storage.getStore();
      });
      assert.strictEqual(storage.getStore(), undefined);
      assert.strictEqual(await result, 'native-boundary');
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('isolates concurrent run stores across promise and timer turns', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const task = (name, delay) => storage.run(name, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        assert.strictEqual(storage.getStore(), name);
        await Promise.resolve();
        assert.strictEqual(storage.getStore(), name);
        await new Promise((resolve) => queueMicrotask(resolve));
        return storage.getStore();
      });
      for (let iteration = 0; iteration < 12; iteration += 1) {
        const first = 'first-' + iteration;
        const second = 'second-' + iteration;
        assert.deepStrictEqual(
          await Promise.all([task(first, iteration % 3), task(second, (iteration + 1) % 3)]),
          [first, second],
        );
      }
      assert.strictEqual(storage.getStore(), undefined);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('isolates concurrent awaiters of one promise', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      let release;
      const pending = new Promise((resolve) => { release = resolve; });
      const readStore = (name) => storage.run(name, async () => {
        await pending;
        return storage.getStore();
      });
      const first = readStore('first');
      const second = readStore('second');
      release();
      const results = await Promise.all([first, second]);
      assert.deepStrictEqual(results, ['first', 'second']);
      assert.strictEqual(storage.getStore(), undefined);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('preserves one store across direct promise, microtask, and timer awaits', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const readStore = (name) => storage.run(name, async () => {
        assert.strictEqual(storage.getStore(), name);
        await Promise.resolve();
        assert.strictEqual(storage.getStore(), name);
        await new Promise((resolve) => queueMicrotask(resolve));
        assert.strictEqual(storage.getStore(), name);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return storage.getStore();
      });

      for (let iteration = 0; iteration < 16; iteration += 1) {
        const first = 'first-' + iteration;
        const second = 'second-' + iteration;
        assert.deepStrictEqual(
          await Promise.all([readStore(first), readStore(second)]),
          [first, second],
        );
        assert.strictEqual(storage.getStore(), undefined);
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('preserves a run store through a promise, microtask, and timer chain', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      for (let iteration = 0; iteration < 24; iteration += 1) {
        const store = { requestId: 'chain-' + iteration };
        const completed = storage.run(store, () => new Promise((resolve, reject) => {
          Promise.resolve().then(() => {
            assert.strictEqual(storage.getStore(), store);
            queueMicrotask(() => {
              try {
                assert.strictEqual(storage.getStore(), store);
                setTimeout(() => {
                  try {
                    assert.strictEqual(storage.getStore(), store);
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                }, 0);
              } catch (error) {
                reject(error);
              }
            });
          }, reject);
        }));
        assert.strictEqual(storage.getStore(), undefined);
        await completed;
        assert.strictEqual(storage.getStore(), undefined);
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('propagates one store through queueMicrotask, nextTick, timers, and immediates', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const store = { requestId: 'request-1' };
      const seen = [];
      await storage.run(store, () => new Promise((resolve, reject) => {
        const check = (name) => {
          try {
            assert.strictEqual(storage.getStore(), store);
            seen.push(name);
            if (seen.length === 4) resolve();
          } catch (error) {
            reject(error);
          }
        };
        queueMicrotask(() => check('microtask'));
        process.nextTick(() => check('nextTick'));
        setTimeout(() => check('timeout'), 0);
        setImmediate(() => check('immediate'));
      }));
      assert.deepStrictEqual(seen.sort(), ['immediate', 'microtask', 'nextTick', 'timeout']);
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

test('does not mutate promise snapshots when enterWith changes the current resource', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const beforeEnter = Promise.resolve().then(() => storage.getStore());

      storage.enterWith('entered');
      assert.strictEqual(storage.getStore(), 'entered');
      assert.strictEqual(await beforeEnter, undefined);
      assert.strictEqual(storage.getStore(), 'entered');
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('keeps exit scoped to the branch that leaves the store', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const storage = new AsyncLocalStorage();
      const values = await storage.run('outer', async () => {
        const exited = storage.exit(() => new Promise((resolve) => {
          setImmediate(() => resolve(storage.getStore()));
        }));
        const retained = Promise.resolve().then(() => storage.getStore());
        return [await exited, await retained];
      });

      assert.deepStrictEqual(values, [undefined, 'outer']);
      assert.strictEqual(storage.getStore(), undefined);
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

test('preserves AsyncLocalStorage for node:stream/web callbacks', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const { ReadableStream } = require('node:stream/web');
      const storage = new AsyncLocalStorage();
      const store = { requestId: 'stream-request' };
      const seen = [];

      const stream = storage.run(store, () => new ReadableStream({
        start() {
          seen.push(['start', storage.getStore()]);
        },
        pull(controller) {
          seen.push(['pull', storage.getStore()]);
          controller.enqueue('ok');
          controller.close();
        },
        cancel(reason) {
          seen.push(['cancel', storage.getStore(), reason]);
        },
      }));

      assert.strictEqual(storage.getStore(), undefined);
      const reader = stream.getReader();
      assert.deepStrictEqual(await reader.read(), { value: 'ok', done: false });
      assert.deepStrictEqual(await reader.read(), { value: undefined, done: true });
      assert.deepStrictEqual(seen, [
        ['start', store],
        ['pull', store],
      ]);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('preserves nested AsyncLocalStorage stores for stream callbacks', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const { ReadableStream } = require('node:stream/web');
      const outer = new AsyncLocalStorage();
      const inner = new AsyncLocalStorage();
      const seen = [];
      const stream = outer.run('outer', () => inner.run('inner', () => new ReadableStream({
        start() {
          seen.push(['start', outer.getStore(), inner.getStore()]);
        },
        pull(controller) {
          seen.push(['pull', outer.getStore(), inner.getStore()]);
          controller.enqueue('ok');
          controller.close();
        },
      })));
      const reader = stream.getReader();
      await reader.read();
      assert.deepStrictEqual(seen, [
        ['start', 'outer', 'inner'],
        ['pull', 'outer', 'inner'],
      ]);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('preserves nested stores through the global Web Stream constructor', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const outer = new AsyncLocalStorage();
      const inner = new AsyncLocalStorage();
      const seen = [];
      const stream = outer.run('outer', () => inner.run('inner', () => new ReadableStream({
        start() {
          seen.push(['start', outer.getStore(), inner.getStore()]);
        },
        pull(controller) {
          seen.push(['pull', outer.getStore(), inner.getStore()]);
          controller.enqueue('ok');
          controller.close();
        },
      })));
      const reader = stream.getReader();
      await reader.read();
      assert.deepStrictEqual(seen, [
        ['start', 'outer', 'inner'],
        ['pull', 'outer', 'inner'],
      ]);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});

test('preserves nested stores across async render-like promises', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const work = new AsyncLocalStorage();
      const request = new AsyncLocalStorage();
      const result = work.run('work', async () => {
        await Promise.resolve();
        return request.run('request', async () => {
          await Promise.resolve();
          return [work.getStore(), request.getStore()];
        });
      });
      assert.deepStrictEqual(await result, ['work', 'request']);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);

  await expectPass(expect, result);
});
