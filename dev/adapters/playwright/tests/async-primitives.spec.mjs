import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime async primitives', () => {
  test('preserves AsyncLocalStorage through queued promise work', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const { AsyncLocalStorage } = require('node:async_hooks');
        const storage = new AsyncLocalStorage();
        class Queue {
          #head;
          #tail;
          #size = 0;
          enqueue(value) {
            const node = {value};
            if (this.#head) this.#tail.next = node;
            else this.#head = node;
            this.#tail = node;
            this.#size++;
          }
          dequeue() {
            const current = this.#head;
            if (!current) return;
            this.#head = current.next;
            this.#size--;
            if (!this.#head) this.#tail = undefined;
            return current.value;
          }
          get size() {
            return this.#size;
          }
        }
        const queue = new Queue();
        let active = 0;
        const resumeNext = () => {
          if (active < 2 && queue.size > 0) {
            active += 1;
            queue.dequeue().run();
          }
        };
        const next = () => {
          active -= 1;
          resumeNext();
        };
        const run = async (function_, resolve, args) => {
          const result = (async () => function_(...args))();
          resolve(result);
          try {
            await result;
          } catch {}
          next();
        };
        const limit = (function_, ...args) => new Promise((resolve) => {
          const item = {};
          new Promise((internalResolve) => {
            item.run = internalResolve;
            queue.enqueue(item);
          }).then(run.bind(undefined, function_, resolve, args));
          resumeNext();
        });
        const check = async id => {
          await Promise.resolve();
          assert.strictEqual(storage.getStore()?.id, id);
        };
        await Promise.all(Array.from({length: 100}, (_, id) => storage.run({id}, () => limit(check, id))));
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, { timeoutMs: 30000 });

    await expectPass(expect, result);
  });

  test('preserves AsyncLocalStorage through an ESM queue boundary', async ({ harnessPage }) => {
    const entryPath = '/node/p-limit-als-entry.mjs';
    const result = await harnessPage.run(`
      import { AsyncLocalStorage } from 'node:async_hooks';
      import pLimit from './p-limit-als-limit.mjs';

      const store = new AsyncLocalStorage();
      const limit = pLimit(2);
      const checkId = async id => {
        await Promise.resolve();
        if (store.getStore()?.id !== id) throw new Error('lost async context');
      };
      const startContext = async id => store.run({ id }, () => limit(checkId, id));
      await Promise.all(Array.from({ length: 100 }, (_, id) => startContext(id)));
    `, {
      entryPath,
      files: {
        '/node/p-limit-als-limit.mjs': `
          export default function pLimit(concurrency) {
            const queue = [];
            let active = 0;
            const resumeNext = () => {
              if (active < concurrency && queue.length > 0) {
                active += 1;
                queue.shift().run();
              }
            };
            const next = () => {
              active -= 1;
              resumeNext();
            };
            const run = async (function_, resolve, args) => {
              const result = (async () => function_(...args))();
              resolve(result);
              try { await result; } catch {}
              next();
            };
            return (function_, ...args) => new Promise(resolve => {
              const item = {};
              new Promise(internalResolve => {
                item.run = internalResolve;
                queue.push(item);
              }).then(run.bind(undefined, function_, resolve, args));
              resumeNext();
            });
          }
        `,
      },
      timeoutMs: 30000,
    });

    await expectPass(expect, result);
  });

  test('does not report a rejection handled through queued Promise.all work', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const unhandled = [];
        let fixtureError;
        const onUnhandled = (reason, promise) => unhandled.push({
          reasonIsFixture: reason === fixtureError,
          reasonMessage: reason?.message,
          promiseConstructor: promise?.constructor?.name,
          promiseHasOwnThen: Boolean(promise && Object.prototype.hasOwnProperty.call(promise, 'then')),
        });
        process.on('unhandledRejection', onUnhandled);

        const pLimit = concurrency => {
          const queue = [];
          let activeCount = 0;
          const resumeNext = () => {
            if (activeCount < concurrency && queue.length > 0) {
              activeCount++;
              queue.shift()();
            }
          };
          const next = () => {
            activeCount--;
            resumeNext();
          };
          const run = async (function_, resolve, args) => {
            const result = (async () => function_(...args))();
            resolve(result);
            try { await result; } catch {}
            next();
          };
          const enqueue = (function_, resolve, args) => {
            new Promise(internalResolve => {
              queue.push(internalResolve);
            }).then(run.bind(undefined, function_, resolve, args));
            resumeNext();
          };
          return (function_, ...args) => new Promise(resolve => {
            enqueue(function_, resolve, args);
          });
        };
        class EndError extends Error {
          constructor(value) {
            super();
            this.value = value;
          }
        }
        const testElement = async (element, tester) => tester(await element);
        const finder = async element => {
          const values = await Promise.all(element);
          if (values[1] === true) throw new EndError(values[0]);
          return false;
        };
        const pLocate = async (iterable, tester) => {
          const limit = pLimit(Number.POSITIVE_INFINITY);
          const items = [...iterable].map(element => [element, limit(testElement, element, tester)]);
          const checkLimit = pLimit(1);
          try {
            await Promise.all(items.map(element => checkLimit(finder, element)));
          } catch (error) {
            if (error instanceof EndError) return error.value;
            throw error;
          }
        };

        fixtureError = new Error('fixture');
        await assert.rejects(
          pLocate([1, 2, 3], () => Promise.reject(fixtureError)),
          error => error === fixtureError,
        );
        await new Promise(resolve => setTimeout(resolve, 50));
        process.removeListener('unhandledRejection', onUnhandled);
        assert.deepStrictEqual(unhandled, [], JSON.stringify(unhandled));
      })().catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    `, { timeoutMs: 30000 });

    await expectPass(expect, result);
  });

  test('does not report the published p-locate ESM rejection path', async ({ harnessPage }) => {
    const entryPath = '/node/p-locate-rejection-entry.mjs';
    const result = await harnessPage.run(`
      import assert from 'node:assert';
      import pLocate from './p-locate-rejection.mjs';

      const unhandled = [];
      const onUnhandled = (reason, promise) => unhandled.push({
        reasonMessage: reason?.message,
        promiseConstructor: promise?.constructor?.name,
        promiseHasOwnThen: Boolean(promise && Object.prototype.hasOwnProperty.call(promise, 'then')),
      });
      process.on('unhandledRejection', onUnhandled);
      const fixtureError = new Error('fixture');
      await assert.rejects(
        pLocate([1, 2, 3], () => Promise.reject(fixtureError)),
        error => error === fixtureError,
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      process.removeListener('unhandledRejection', onUnhandled);
      assert.deepStrictEqual(unhandled, [], JSON.stringify(unhandled));
    `, {
      entryPath,
      files: {
        '/node/p-locate-rejection.mjs': `
          import pLimit from './p-locate-rejection-limit.mjs';

          class EndError extends Error {
            constructor(value) {
              super();
              this.value = value;
            }
          }

          const testElement = async (element, tester) => tester(await element);
          const finder = async element => {
            const values = await Promise.all(element);
            if (values[1] === true) throw new EndError(values[0]);
            return false;
          };

          export default async function pLocate(iterable, tester) {
            const limit = pLimit(Number.POSITIVE_INFINITY);
            const items = [...iterable].map(element => [element, limit(testElement, element, tester)]);
            const checkLimit = pLimit(1);
            try {
              await Promise.all(items.map(element => checkLimit(finder, element)));
            } catch (error) {
              if (error instanceof EndError) return error.value;
              throw error;
            }
          }
        `,
        '/node/p-locate-rejection-limit.mjs': `
          export default function pLimit(concurrency) {
            const queue = [];
            let activeCount = 0;
            const resumeNext = () => {
              if (activeCount < concurrency && queue.length > 0) {
                activeCount++;
                queue.shift()();
              }
            };
            const next = () => {
              activeCount--;
              resumeNext();
            };
            const run = async (function_, resolve, arguments_) => {
              const result = (async () => function_(...arguments_))();
              resolve(result);
              try { await result; } catch {}
              next();
            };
            const enqueue = (function_, resolve, arguments_) => {
              new Promise(internalResolve => {
                queue.push(internalResolve);
              }).then(run.bind(undefined, function_, resolve, arguments_));
              if (activeCount < concurrency) resumeNext();
            };
            return (function_, ...arguments_) => new Promise(resolve => {
              enqueue(function_, resolve, arguments_);
            });
          }
        `,
      },
      timeoutMs: 30000,
    });

    await expectPass(expect, result);
  });

  test('delivers unhandled rejections to the process handler before setImmediate', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      (async () => {
        let handled = false;
        const handler = (reason, promise) => {
          handled = true;
          assert.strictEqual(reason.message, 'runtime unhandled rejection');
          assert.strictEqual(typeof promise.then, 'function');
          process.removeListener('unhandledRejection', handler);
        };
        process.once('unhandledRejection', handler);
        Promise.reject(new Error('runtime unhandled rejection'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(handled, true);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('delivers later rejection handling to the process handler', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const events = [];
        const rejection = new Promise((resolve, reject) => reject(new Error('runtime late rejection')));
        process.once('unhandledRejection', (reason, promise) => {
          events.push(['unhandled', reason.message, promise]);
        });
        process.once('rejectionHandled', (promise) => {
          events.push(['handled', promise]);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await rejection.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepStrictEqual(events.map(([name, value]) => [name, name === 'unhandled' ? value : typeof value]), [
          ['unhandled', 'runtime late rejection'],
          ['handled', 'object'],
        ]);
        // Browser event payloads can be cross-realm wrappers, so their object
        // identity is not stable across Chromium and Firefox. The runtime
        // still forwards both promise payloads to the process handlers.
        assert.strictEqual(typeof events[0][2]?.then, 'function');
        assert.strictEqual(typeof events[1][1]?.then, 'function');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('preserves process, timer, microtask, and environment behavior', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const order = [];
      process.nextTick(() => order.push('nextTick'));
      queueMicrotask(() => order.push('microtask'));
      Promise.resolve().then(() => order.push('promise'));
      await new Promise((resolve) => setImmediate(() => {
        order.push('immediate');
        resolve();
      }));
      assert.deepStrictEqual(order, ['nextTick', 'microtask', 'promise', 'immediate']);
      assert.strictEqual(process.env.BNH_TEST, 'browser');
      assert.strictEqual(typeof setTimeout, 'function');
      assert.strictEqual(typeof clearTimeout, 'function');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, { env: { BNH_TEST: 'browser' } });

    await expectPass(expect, result);
  });

  test('matches execution resources across browser-native fs.readFile stages', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { readFile } = require('node:fs');
      const { createHook, executionAsyncResource, AsyncResource } = require('node:async_hooks');
      let firstSeenAsyncId = -1;
      const resources = new Map();
      let initCount = 0;
      let beforeCount = 0;
      let afterCount = 0;
      const hook = createHook({
        init(asyncId, type, triggerAsyncId, resource) {
          if (firstSeenAsyncId === -1) firstSeenAsyncId = asyncId;
          assert.strictEqual(resources.get(asyncId), undefined);
          resources.set(asyncId, resource);
          initCount += 1;
        },
        before(asyncId) {
          if (asyncId >= firstSeenAsyncId) {
            assert.strictEqual(executionAsyncResource(), resources.get(asyncId));
            beforeCount += 1;
          }
        },
        after(asyncId) {
          if (asyncId >= firstSeenAsyncId) {
            assert.strictEqual(executionAsyncResource(), resources.get(asyncId));
            afterCount += 1;
          }
        },
      }).enable();
      const resource = new AsyncResource('TheResource');
      assert.strictEqual(resources.get(resource.asyncId()), resource);
      resource.runInAsyncScope(() => {
        assert.strictEqual(executionAsyncResource(), resource);
      });
      readFile(__filename, (error) => {
        assert.ifError(error);
      });
      process.on('exit', () => {
        hook.disable();
        assert.ok(initCount >= 5, 'expected at least five initialized resources');
        assert.ok(beforeCount >= 5, 'expected at least five before callbacks');
        assert.ok(afterCount >= 5, 'expected at least five after callbacks');
      });
    `);

    await expectPass(expect, result);
  });

  test('implements EventEmitter listener ordering, once, off, and errors', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { EventEmitter } = require('node:events');
      const emitter = new EventEmitter();
      const seen = [];
      const listener = (value) => seen.push(['on', value]);
      emitter.on('value', listener);
      emitter.once('value', (value) => seen.push(['once', value]));
      assert.strictEqual(emitter.listenerCount('value'), 2);
      assert.strictEqual(emitter.emit('value', 1), true);
      assert.strictEqual(emitter.emit('value', 2), true);
      emitter.off('value', listener);
      assert.deepStrictEqual(seen, [['on', 1], ['once', 1], ['on', 2]]);
      assert.strictEqual(emitter.listenerCount('value'), 0);
      assert.strictEqual(emitter.emit('missing'), false);
    `);

    await expectPass(expect, result);
  });

  test('supports stream backpressure, transform, async iteration, and errors', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const { Readable, Transform, Writable } = require('node:stream');
      const received = [];
      const writable = new Writable({
        highWaterMark: 1,
        write(chunk, encoding, callback) {
          received.push(chunk.toString());
          setTimeout(callback, 0);
        },
      });
      assert.strictEqual(writable.write('a'), false);
      await new Promise((resolve) => writable.once('drain', resolve));
      await new Promise((resolve, reject) => {
        writable.once('finish', resolve);
        writable.once('error', reject);
        Readable.from(['b', 'c']).pipe(writable);
      });
      assert.deepStrictEqual(received, ['a', 'b', 'c']);
      const doubled = Readable.from([1, 2, 3]).pipe(new Transform({
        objectMode: true,
        transform(value, encoding, callback) { callback(null, value * 2); },
      }));
      const values = [];
      for await (const value of doubled) values.push(value);
      assert.deepStrictEqual(values, [2, 4, 6]);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('supports legacy Transform.call constructors', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const { Transform } = require('node:stream');
        const { inherits } = require('node:util');
        function LegacyTransform(options) {
          Transform.call(this, options);
        }
        inherits(LegacyTransform, Transform);
        const transformed = new LegacyTransform({
          transform(chunk, _encoding, callback) {
            callback(null, chunk.toString().toUpperCase());
          },
        });
        const output = await new Promise((resolve, reject) => {
          const chunks = [];
          transformed.on('data', chunk => chunks.push(chunk.toString()));
          transformed.once('end', () => resolve(chunks));
          transformed.once('error', reject);
          transformed.end('legacy');
        });
        assert.deepStrictEqual(output, ['LEGACY']);
      })().catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('preserves matching-decoder string chunks across surrogate boundaries', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const { Readable } = require('node:stream');
        const source = new Readable({ encoding: 'utf8' });
        const chunks = [];
        let index = 0;
        source._read = () => {
          source.push(index++ === 0 ? '\\uD83D' : '\\uDE3B', 'utf8');
          if (index === 2) source.push(null);
        };
        await new Promise((resolve, reject) => {
          source.on('data', chunk => chunks.push(chunk));
          source.once('end', resolve);
          source.once('error', reject);
        });
        assert.strictEqual(chunks.join(''), '\\uD83D\\uDE3B');
      })().catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('string_decoder preserves a leading UTF-8 BOM', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const { StringDecoder } = require('node:string_decoder');
        const decoder = new StringDecoder('utf8');
        const text = decoder.write(Buffer.from([0xef, 0xbb, 0xbf])) + decoder.end();
        assert.strictEqual(text, '\\uFEFF');
      })();
    `);

    await expectPass(expect, result);
  });

  test('supports worker communication, message channels, and transferable ownership', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const { Worker, MessageChannel, isMainThread } = require('node:worker_threads');
      assert.strictEqual(isMainThread, true);
      const worker = new Worker(
        "const { parentPort } = require('node:worker_threads'); parentPort.on('message', ({ buffer }) => parentPort.postMessage({ bytes: buffer.byteLength }));",
        { eval: true },
      );
      const buffer = new ArrayBuffer(8);
      const reply = new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      worker.postMessage({ buffer }, [buffer]);
      assert.deepStrictEqual(await reply, { bytes: 8 });
      assert.strictEqual(buffer.byteLength, 0);
      assert.strictEqual(await worker.terminate(), 1);
      const channel = new MessageChannel();
      const message = new Promise((resolve) => channel.port1.once('message', resolve));
      channel.port2.postMessage({ kind: 'channel', value: 7 });
      assert.deepStrictEqual(await message, { kind: 'channel', value: 7 });
      channel.port1.close();
      channel.port2.close();
      if (typeof BroadcastChannel === 'function') {
        const name = 'bnh-browser-broadcast-' + Date.now();
        const first = new BroadcastChannel(name);
        const second = new BroadcastChannel(name);
        const broadcast = new Promise((resolve) => second.onmessage = resolve);
        first.postMessage({ kind: 'broadcast', value: 11 });
        assert.deepStrictEqual((await broadcast).data, { kind: 'broadcast', value: 11 });
        first.close();
        second.close();
      }
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('runs a virtual worker when its entrypoint is a file URL', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert/strict');
      const { Worker } = require('node:worker_threads');
      const worker = new Worker(new URL('file:///node/url-worker-entry.mjs'), {
        workerData: { value: 17 },
      });
      const message = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      assert.deepStrictEqual(message, {
        isMainThread: false,
        value: 17,
        processSend: 'undefined',
        processChannel: 'undefined',
      });
      assert.strictEqual(await new Promise((resolve) => worker.once('exit', resolve)), 0);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/url-worker-entry.mjs': [
          "import process from 'node:process';",
          "import { isMainThread, parentPort, workerData } from 'node:worker_threads';",
          'parentPort.postMessage({ isMainThread, value: workerData.value, processSend: typeof process.send, processChannel: typeof process.channel });',
          'parentPort.close();',
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });
});
