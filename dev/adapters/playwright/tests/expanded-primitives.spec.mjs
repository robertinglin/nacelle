import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

const contracts = {
  'http-fetch': `
    const assert = require('node:assert');
    (async () => {
      const url = new URL('data:text/plain,bnh%20network');
      assert.strictEqual(url.protocol, 'data:');
      assert.strictEqual(url.pathname, 'text/plain,bnh%20network');
      url.searchParams.set('mode', 'browser');
      assert.strictEqual(url.searchParams.get('mode'), 'browser');
      const response = await fetch(url, { headers: {'X-BNH-Request': 'present'} });
      assert.strictEqual(response.ok, true);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(await response.text(), 'bnh network');
      assert.strictEqual(response.headers.get('content-type'), 'text/plain');
      const headers = new Headers({'X-BNH-Header': 'value'});
      headers.append('X-BNH-Header', 'second');
      assert.strictEqual(headers.get('x-bnh-header'), 'value, second');
      const request = new Request(url, {redirect: 'manual', headers});
      assert.strictEqual(request.redirect, 'manual');
      assert.strictEqual(request.headers.get('x-bnh-header'), 'value, second');
      const redirect = Response.redirect('data:text/plain,redirected', 302);
      assert.strictEqual(redirect.status, 302);
      assert.strictEqual(redirect.headers.get('location'), 'data:text/plain,redirected');
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(fetch('data:text/plain,aborted', {signal: aborted.signal}),
        (error) => error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
      assert.strictEqual(typeof WebSocket, 'function');
      assert.strictEqual(WebSocket.OPEN, 1);
      assert.strictEqual(WebSocket.CLOSED, 3);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `,
  'unhandled-rejection': `
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
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `,
  'workers-communication': `
    const assert = require('node:assert');
    const { Worker, MessageChannel, BroadcastChannel, isMainThread } = require('node:worker_threads');
    assert.strictEqual(isMainThread, true);
    (async () => {
      const workerSource = \`
        const {parentPort} = require('node:worker_threads');
        parentPort.once('message', ({buffer, map}) => {
          parentPort.postMessage({kind: 'message', mapValue: map.get('value'), byteLength: buffer.byteLength});
          setInterval(() => {}, 1000);
        });
      \`;
      const worker = new Worker(workerSource, {eval: true});
      const buffer = new ArrayBuffer(8);
      const view = new Uint8Array(buffer);
      view[0] = 42;
      const result = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.postMessage({buffer, map: new Map([['value', 7]])}, [buffer]);
      });
      assert.deepStrictEqual(result, {kind: 'message', mapValue: 7, byteLength: 8});
      assert.strictEqual(buffer.byteLength, 0);
      assert.strictEqual(await worker.terminate(), 1);
      const channels = new MessageChannel();
      const channelMessage = new Promise((resolve) => channels.port1.once('message', resolve));
      channels.port2.postMessage({kind: 'channel', value: 9});
      assert.deepStrictEqual(await channelMessage, {kind: 'channel', value: 9});
      channels.port1.close();
      channels.port2.close();
      if (typeof BroadcastChannel === 'function') {
        const name = 'bnh-broadcast-' + Date.now();
        const first = new BroadcastChannel(name);
        const second = new BroadcastChannel(name);
        const broadcast = new Promise((resolve) => second.onmessage = (event) => resolve(event.data));
        first.postMessage({kind: 'broadcast', value: 11});
        assert.deepStrictEqual(await broadcast, {kind: 'broadcast', value: 11});
        first.close();
        second.close();
      }
      if (typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object') {
        const shared = new SharedArrayBuffer(4);
        const cells = new Int32Array(shared);
        Atomics.store(cells, 0, 3);
        assert.strictEqual(Atomics.load(cells, 0), 3);
        assert.strictEqual(Atomics.add(cells, 0, 2), 3);
        assert.strictEqual(Atomics.load(cells, 0), 5);
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `,
};

for (const [name, source] of Object.entries(contracts)) {
  test(`expanded primitive contract: ${name}`, async ({ harnessPage }) => {
    const result = await harnessPage.run(source);
    await expectPass(expect, result);
  });
}
