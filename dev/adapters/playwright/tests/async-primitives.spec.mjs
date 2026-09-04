import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime async primitives', () => {
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
      assert.deepStrictEqual(message, { isMainThread: false, value: 17 });
      assert.strictEqual(await new Promise((resolve) => worker.once('exit', resolve)), 0);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/url-worker-entry.mjs': [
          "import { isMainThread, parentPort, workerData } from 'node:worker_threads';",
          'parentPort.postMessage({ isMainThread, value: workerData.value });',
          'parentPort.close();',
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });
});
