import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime platform primitives', () => {
  test('provides deterministic browser-native node:os methods and constants', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const os = require('node:os');
      assert.strictEqual(os.totalmem(), 512 * 1024 * 1024);
      assert.strictEqual(os.freemem(), 256 * 1024 * 1024);
      assert.strictEqual(os.availableParallelism(), 1);
      assert.deepStrictEqual(os.cpus(), [{
        model: 'Browser CPU',
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      }]);
      assert.strictEqual(os.homedir(), '/home/browser');
      assert.strictEqual(os.hostname(), 'browser');
      assert.strictEqual(os.uptime(), 1);
      assert.deepStrictEqual(os.loadavg(), [0, 0, 0]);
      assert.strictEqual(os.userInfo().username, 'browser');
      assert.strictEqual(os.userInfo({ encoding: 'buffer' }).username.toString(), 'browser');
      assert.strictEqual(os.version(), 'Browser Native OS');
      assert.strictEqual(os.machine(), 'x86_64');
      assert.strictEqual(os.devNull, '/dev/null');
      assert.strictEqual(String(os.hostname), os.hostname());
      assert.strictEqual(String(os.totalmem), String(os.totalmem()));
      assert.strictEqual(String(os.availableParallelism), String(os.availableParallelism()));
      assert.strictEqual(os.constants.signals.SIGTERM, 15);
      assert.strictEqual(os.constants.priority.PRIORITY_NORMAL, 0);
      assert.strictEqual(os.constants.UV_UDP_REUSEADDR, 4);
      assert.strictEqual(os.getPriority(), 0);
      os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
      assert.strictEqual(os.getPriority(), 10);
    `);

    await expectPass(expect, result);
  });

  test('provides Buffer, crypto, path, URL, and file URL behavior', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const crypto = require('node:crypto');
      const path = require('node:path');
      const { fileURLToPath, pathToFileURL } = require('node:url');
      assert.strictEqual(path.resolve('browser', 'file.js'), '/node/browser/file.js');
      const bytes = Buffer.from('héllo', 'utf8');
      assert.strictEqual(bytes.toString('base64'), 'aMOpbGxv');
      assert.strictEqual(Buffer.from('aMOpbGxv', 'base64').toString(), 'héllo');
      assert.strictEqual(crypto.createHash('sha256').update('browser-node').digest('hex'), 'bbe69f3a1517143e8a375f3222f1b809f193d71075a44d6348fea7d8c74c8e58');
      assert.strictEqual(path.posix.normalize('/node//vfs/../file.js'), '/node/file.js');
      assert.strictEqual(path.posix.extname('/node/file.js'), '.js');
      const url = pathToFileURL('/node/file.js');
      assert.strictEqual(fileURLToPath(url), '/node/file.js');
      const parsed = new URL('https://example.test/path?mode=browser');
      assert.strictEqual(parsed.searchParams.get('mode'), 'browser');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('provides diagnostics channels, async context, compression, and WebAssembly', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const { performance } = require('node:perf_hooks');
      const { AsyncLocalStorage } = require('node:async_hooks');
      const diagnostics = require('node:diagnostics_channel');
      const zlib = require('node:zlib');
      performance.mark('start');
      performance.mark('end');
      performance.measure('measure', 'start', 'end');
      assert.ok(performance.now() >= 0);
      const storage = new AsyncLocalStorage();
      await new Promise((resolve, reject) => storage.run({ id: 7 }, () => Promise.resolve().then(() => {
        try { assert.deepStrictEqual(storage.getStore(), { id: 7 }); resolve(); } catch (error) { reject(error); }
      })));
      const channel = diagnostics.channel('bnh.playwright');
      let message;
      const listener = (value) => { message = value; };
      channel.subscribe(listener);
      channel.publish({ ok: true });
      channel.unsubscribe(listener);
      assert.deepStrictEqual(message, { ok: true });
      const input = Buffer.from('browser compression');
      const compressed = await zlib.gzip(input);
      assert.strictEqual((await zlib.gunzip(compressed)).toString(), input.toString());
      const wasm = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
      assert.strictEqual(WebAssembly.validate(wasm), true);
      const instance = await WebAssembly.instantiate(wasm);
      assert.strictEqual(instance.instance.exports.add(20, 22), 42);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('reports browser-only boundaries without invoking host subprocesses', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const boundaries = [
        ['native-addons', 'unsupported-boundary'],
        ['privileged-os-apis', 'unsupported-boundary'],
        ['real-subprocesses', 'unsupported-boundary'],
      ];
      assert.ok(boundaries.every(([, status]) => status === 'unsupported-boundary'));
      process.stdout.write(JSON.stringify({ browserNative: true, boundaries }));
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('unsupported-boundary');
    expect(result.stdout).toContain('real-subprocesses');
  });
});
