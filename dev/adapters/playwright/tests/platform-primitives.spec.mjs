import { expect } from 'playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

const zlibWasm = new Uint8Array(await readFile(
  fileURLToPath(new URL('../../../../src/wasm/v22/zlib.wasm', import.meta.url)),
));
const brotliWasm = new Uint8Array(await readFile(
  fileURLToPath(new URL('../../../../src/wasm/v22/brotli.wasm', import.meta.url)),
));

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

  test('loads core zlib WASM from the shared runtime asset path', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
      const assert = require('node:assert');
      const zlib = require('node:zlib');
      const input = Buffer.from('default runtime zlib asset');
      const compressed = zlib.gzipSync(input);
      assert.deepStrictEqual([...zlib.gunzipSync(compressed)], [...input]);
      })();
    `);

    await expectPass(expect, result);
  });

  test('streams gzip output incrementally through the browser compression stream', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const zlib = require('node:zlib');
      const input = Buffer.alloc(16 * 1024 * 1024);
      let random = 0x12345678;
      for (let index = 0; index < input.length; index += 1) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        input[index] = random >>> 24;
      }
      const stream = zlib.createGzip();
      const chunks = [];
      const errors = [];
      const ended = new Promise((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
      });
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', (error) => errors.push(error));
      for (let offset = 0; offset < input.length; offset += 64 * 1024) {
        const accepted = stream.write(input.subarray(offset, offset + 64 * 1024));
        if (!accepted) {
          await new Promise((resolve, reject) => {
            const onDrain = () => {
              stream.off('error', onError);
              resolve();
            };
            const onError = (error) => {
              stream.off('drain', onDrain);
              reject(error);
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(errors.length, 0, errors[0]?.stack || 'gzip stream error');
      assert.ok(chunks.length > 0, 'gzip must produce output before the writable closes');
      assert.ok(chunks.length <= 128, 'gzip output was split into too many chunks: ' + chunks.length);
      stream.end();
      await ended;
      const compressed = Buffer.concat(chunks);
      assert.deepStrictEqual([...compressed.subarray(0, 2)], [0x1f, 0x8b]);
      const decoded = zlib.gunzipSync(compressed);
      assert.strictEqual(decoded.length, input.length);
      assert.strictEqual(decoded[0], input[0]);
      assert.strictEqual(decoded[decoded.length - 1], input[input.length - 1]);
      const raw = zlib.deflateRawSync(input);
      const rawDecoded = zlib.inflateRawSync(raw);
      assert.strictEqual(rawDecoded.length, input.length);
      assert.strictEqual(rawDecoded[0], input[0]);
      assert.strictEqual(rawDecoded[rawDecoded.length - 1], input[input.length - 1]);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, { files: { '/node/internal/deps/zlib.wasm': zlibWasm } });

    await expectPass(expect, result);
  });

  test('loads the WASI-linked Brotli codec and round trips native zlib calls', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
      const assert = require('node:assert');
      const zlib = require('node:zlib');
      const input = Buffer.from('browser-native Brotli');
      const compressed = zlib.brotliCompressSync(input);
      assert.ok(compressed.length > 0);
      assert.deepStrictEqual([...zlib.brotliDecompressSync(compressed)], [...input]);
      })();
    `, { files: { '/node/internal/deps/brotli.wasm': brotliWasm } });

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
