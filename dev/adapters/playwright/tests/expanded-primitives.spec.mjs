import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('unrefed worker parent ports allow natural worker exit', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { Worker } = require('node:worker_threads');
    (async () => {
      const worker = new Worker('/node/unref-parent-port-worker.cjs');
      let ready = false;
      const outcome = await new Promise((resolve, reject) => {
        worker.once('message', (value) => {
          ready = value === 'ready';
        });
        worker.once('error', reject);
        worker.once('exit', (code) => resolve({ code, ready }));
      });
      assert.deepStrictEqual(outcome, { code: 0, ready: true });
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    files: {
      '/node/unref-parent-port-worker.cjs': [
        "const { parentPort } = require('node:worker_threads');",
        'parentPort.on(\'message\', () => {});',
        "parentPort.postMessage('ready');",
        'parentPort.unref();',
      ].join('\n'),
    },
    timeoutMs: 10_000,
  });
  await expectPass(expect, result);
});

test('forwards legacy reallyExit from a nested child runner', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { spawn } = require('node:child_process');
    (async () => {
      const child = spawn(process.execPath, ['/node/legacy-runner.cjs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.strictEqual(code, 7);
      assert.strictEqual(output, 'legacy-runner-complete\\n');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    files: {
      '/node/legacy-runner.cjs': [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['/node/legacy-child.cjs'], { stdio: ['ignore', 'pipe', 'pipe'] });",
        "child.once('exit', (code) => { process.exitCode = code; process.stdout.write('legacy-runner-complete\\n'); process.reallyExit(); });",
      ].join('\n'),
      '/node/legacy-child.cjs': "setTimeout(() => process.exit(7), 0);",
    },
    timeoutMs: 10_000,
  });
  await expectPass(expect, result);
});

test('file worker with unref can satisfy a synchronous Atomics waiter', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { Worker } = require('node:worker_threads');
    (async () => {
      const dataBuffer = new SharedArrayBuffer(4);
      const syncBuffer = new SharedArrayBuffer(4);
      const cells = new Int32Array(syncBuffer);
      const worker = new Worker('/node/unref-sync-worker.cjs', {
        workerData: {
          dataBuffer,
          syncBuffer,
          firstMessage: { value: 7, projectDir: '/node/citgm/tmp/f7215f77/ansi-regex' },
        },
      });
      worker.unref();
      assert.strictEqual(Atomics.wait(cells, 0, 0, 5000), 'ok');
      assert.strictEqual(cells[0], 7);
      assert.strictEqual(new Int32Array(dataBuffer)[0], 7);
      const message = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      assert.strictEqual(message, 'ready');
      await worker.terminate();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    files: {
      '/node/unref-sync-worker.cjs': [
        "const { parentPort, workerData } = require('node:worker_threads');",
        "const fs = require('node:fs/promises');",
        "const v8 = require('node:v8');",
        "const data = new Int32Array(workerData.dataBuffer);",
        "const sync = new Int32Array(workerData.syncBuffer);",
        "(async () => {",
        "  let current = workerData.firstMessage.projectDir;",
        "  while (true) {",
        "    const candidate = current + '/package.json';",
        "    try { await fs.access(candidate); await fs.readFile(candidate, 'utf8'); break; } catch {}",
        "    if (current === '/') break;",
        "    current = current.slice(0, current.lastIndexOf('/')) || '/';",
        "  }",
        "  const encoded = v8.serialize({ value: workerData.firstMessage.value });",
        "  data[0] = encoded.length > 0 ? 7 : 0;",
        "  Atomics.store(sync, 0, 7);",
        "  Atomics.notify(sync, 0);",
        "  parentPort.postMessage('ready');",
        "})().catch((error) => { parentPort.postMessage({ error: error.message }); });",
        "setInterval(() => {}, 1000);",
      ].join('\n'),
      '/node/package.json': '{}',
      '/node/citgm/tmp/f7215f77/ansi-regex/package.json': '{}',
    },
    timeoutMs: 10_000,
  });
  await expectPass(expect, result);
});

test('preserves large synchronous workerData port replies through an ESM child', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    import assert from 'node:assert/strict';
    import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';

    const { port1, port2 } = new MessageChannel();
    const syncBuffer = new SharedArrayBuffer(4);
    const cells = new Int32Array(syncBuffer);
    const worker = new Worker('/node/worker-data-port.cjs', {
      workerData: { port: port2, syncBuffer },
      transferList: [port2],
    });
    worker.postMessage({ id: 7 });
    assert.strictEqual(Atomics.wait(cells, 0, 0, 5000), 'ok');
    assert.deepStrictEqual(receiveMessageOnPort(port1), {
      message: { id: 7, value: 'x'.repeat(100_000) },
    });
    await worker.terminate();
  `, {
    entryPath: '/node/esm-worker-parent.mjs',
    files: {
      '/node/package.json': '{"type":"module"}',
      '/node/worker-data-port.cjs': [
        "const { parentPort, workerData } = require('node:worker_threads');",
        "parentPort.on('message', ({ id }) => {",
        "  workerData.port.postMessage({ id, value: 'x'.repeat(100000) });",
        "  Atomics.store(new Int32Array(workerData.syncBuffer), 0, 1);",
        "  Atomics.notify(new Int32Array(workerData.syncBuffer), 0);",
        '});',
      ].join('\n'),
    },
  });
  await expectPass(expect, result);
});

test('supports a synchronous CommonJS worker that dynamically imports an ESM package', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { MessageChannel, Worker, receiveMessageOnPort } = require('node:worker_threads');

    const { port1, port2 } = new MessageChannel();
    const syncBuffer = new SharedArrayBuffer(4);
    const cells = new Int32Array(syncBuffer);
    const worker = new Worker('/node/project/node_modules/sync-worker/worker.cjs', {
      workerData: { workerPort: port2, sharedBufferView: cells },
      transferList: [port2],
    });
    worker.postMessage({ id: 11 });
    assert.strictEqual(Atomics.wait(cells, 0, 0, 5000), 'ok');
    assert.deepStrictEqual(receiveMessageOnPort(port1), {
      message: { id: 11, result: 'esm-package-result' },
    });
    worker.terminate();
  `, {
    files: {
      '/node/project/node_modules/sync-worker/package.json': '{}',
      '/node/project/node_modules/sync-worker/worker.cjs': [
        "const { parentPort, workerData } = require('node:worker_threads');",
        "parentPort.on('message', async ({ id }) => {",
        "  const imported = await import('esm-package');",
        "  workerData.workerPort.postMessage({ id, result: imported.default });",
        "  Atomics.add(workerData.sharedBufferView, 0, 1);",
        "  Atomics.notify(workerData.sharedBufferView, 0);",
        '});',
      ].join('\n'),
      '/node/project/node_modules/esm-package/package.json': JSON.stringify({
        type: 'module',
        exports: {
          '.': {
            import: { default: './index.js' },
            require: { default: './index.cjs' },
          },
        },
      }),
      '/node/project/node_modules/esm-package/index.js': "export default 'esm-package-result';",
      '/node/project/node_modules/esm-package/index.cjs': "module.exports = 'cjs-package-result';",
    },
  });
  await expectPass(expect, result);
});

test('keeps ESM Function-created dynamic imports inside the VFS loader', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    import assert from 'node:assert/strict';
    const load = new Function('specifier', 'return import(specifier)');
    const imported = await load('function-import-package');
    assert.strictEqual(imported.default, 'function-import-result');
  `, {
    entryPath: '/node/project/entry.mjs',
    files: {
      '/node/project/package.json': '{"type":"module"}',
      '/node/project/node_modules/function-import-package/package.json': JSON.stringify({
        type: 'module',
        exports: './index.js',
      }),
      '/node/project/node_modules/function-import-package/index.js': "export default 'function-import-result';",
    },
  });
  await expectPass(expect, result);
});

test('does not report a caught failed dynamic import as unhandled', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    (async () => {
      try {
        await import('file:///node/project/missing-package-entry');
      } catch (error) {
        assert.strictEqual(error.code, 'ERR_MODULE_NOT_FOUND');
      }
      const imported = await import('fallback-package');
      assert.strictEqual(imported.default, 'fallback-package-result');
      const nested = await import('./esm-fallback-loader.mjs');
      assert.strictEqual(nested.default, 'fallback-package-result');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    entryPath: '/node/project/entry.cjs',
    files: {
      '/node/project/node_modules/fallback-package/package.json': JSON.stringify({
        type: 'module',
        exports: './index.js',
      }),
      '/node/project/node_modules/fallback-package/index.js': "export default 'fallback-package-result';",
      '/node/project/esm-fallback-loader.mjs': [
        "async function importPlugin(name) {",
        "  try { return await import('file:///node/project/' + name); }",
        "  catch { return import('fallback-package'); }",
        "}",
        "const loaded = await importPlugin('missing-package-entry');",
        "export default loaded.default;",
      ].join('\n'),
    },
  });
  await expectPass(expect, result);
});

test('reports an uncaught failed dynamic import as unhandled', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      await import('file:///node/project/missing-package-entry');
    })();
  `);
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(1);
});

test('binds fs to an ESM worker process', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { Worker } = require('node:worker_threads');
    (async () => {
      const worker = new Worker('/node/esm-fs-worker.mjs');
      const value = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      assert.strictEqual(value, 'esm-fs-worker');
      await worker.terminate();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    files: {
      '/node/marker.txt': 'esm-fs-worker',
      '/node/esm-fs-worker.mjs': [
        "import { readFileSync } from 'node:fs';",
        "import { parentPort } from 'node:worker_threads';",
        "parentPort.postMessage(readFileSync('/node/marker.txt', 'utf8'));",
      ].join('\n'),
    },
    timeoutMs: 10_000,
  });
  await expectPass(expect, result);
});

test('callback-style fs access completes in a synchronously-waited worker', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { Worker } = require('node:worker_threads');
    (async () => {
      const syncBuffer = new SharedArrayBuffer(4);
      const cells = new Int32Array(syncBuffer);
      const worker = new Worker('/node/access-callback-worker.cjs', {
        workerData: { syncBuffer, path: '/node/package.json' },
      });
      worker.unref();
      assert.strictEqual(Atomics.wait(cells, 0, 0, 5000), 'ok');
      assert.strictEqual(Atomics.load(cells, 0), 1);
      const message = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      assert.strictEqual(message, 'accessed');
      await worker.terminate();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    files: {
      '/node/access-callback-worker.cjs': [
        "const { parentPort, workerData } = require('node:worker_threads');",
        "const fs = require('node:fs');",
        "const cells = new Int32Array(workerData.syncBuffer);",
        "fs.access(workerData.path, (error) => {",
        "  Atomics.store(cells, 0, error ? -1 : 1);",
        "  Atomics.notify(cells, 0);",
        "  parentPort.postMessage(error ? error.code : 'accessed');",
        "});",
      ].join('\n'),
      '/node/package.json': '{}',
    },
    timeoutMs: 10_000,
  });
  await expectPass(expect, result);
});

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
        Atomics.store(cells, 0, 0);
        const waiter = new Worker(
          \`const {parentPort, workerData} = require('node:worker_threads');
          const cells = new Int32Array(workerData);
          setTimeout(() => {
            Atomics.store(cells, 0, 1);
            Atomics.notify(cells, 0);
            parentPort.postMessage('ready');
          }, 10);\`,
          {eval: true, workerData: shared},
        );
        const waiterMessage = new Promise((resolve, reject) => {
          waiter.once('message', resolve);
          waiter.once('error', reject);
        });
        assert.strictEqual(Atomics.wait(cells, 0, 0, 5000), 'ok');
        assert.strictEqual(Atomics.load(cells, 0), 1);
        assert.strictEqual(await waiterMessage, 'ready');
        assert.strictEqual(await waiter.terminate(), 1);
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
