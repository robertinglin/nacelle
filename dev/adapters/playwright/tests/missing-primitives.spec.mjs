import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

function commonjsSource(label, body) {
  return `
    (async () => {
    ${body}
    })().catch((error) => {
      console.error('missing-primitives: ${label}', error?.stack || error);
      process.exitCode = 1;
    });
  `;
}

async function expectContract(expectObject, harnessPage, label, body, options = {}) {
  const result = await harnessPage.run(commonjsSource(label, body), options);
  await expectPass(expectObject, result);
}

test.describe('browser runtime missing primitive contracts', () => {
  test('loads node:console and writes through Console', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'node:console', `
      const assert = require('node:assert');
      const { Console } = require('node:console');
      const output = [];
      const sink = { write(value) { output.push(String(value)); return true; } };
      const logger = new Console({ stdout: sink, stderr: sink });
      logger.log('hello %s', 'browser');
      assert.strictEqual(output.join(''), 'hello browser\\n');
    `);
  });

  test('loads node:constants with standard OS constants', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'node:constants', `
      const assert = require('node:assert');
      const constants = require('node:constants');
      assert.strictEqual(constants.O_RDONLY, 0);
      assert.strictEqual(typeof constants.O_CREAT, 'number');
      assert.strictEqual(typeof constants.SIGTERM, 'number');
    `);
  });

  test('round-trips values with node:querystring', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'node:querystring', `
      const assert = require('node:assert');
      const querystring = require('node:querystring');
      const encoded = querystring.stringify({ q: 'browser node', tag: ['contract', 'test'] });
      assert.strictEqual(encoded, 'q=browser%20node&tag=contract&tag=test');
      assert.deepStrictEqual(querystring.parse(encoded), {
        q: 'browser node',
        tag: ['contract', 'test'],
      });
    `);
  });

  test('decodes split UTF-8 code points with node:string_decoder', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'node:string_decoder', `
      const assert = require('node:assert');
      const { StringDecoder } = require('node:string_decoder');
      const decoder = new StringDecoder('utf8');
      const bytes = Buffer.from('€', 'utf8');
      assert.strictEqual(decoder.write(bytes.subarray(0, 1)), '');
      assert.strictEqual(decoder.end(bytes.subarray(1)), '€');
    `);
  });

  test('provides WHATWG streams through node:stream/web', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'node:stream/web', `
      const assert = require('node:assert');
      const { ReadableStream, TransformStream, WritableStream } = require('node:stream/web');
      assert.strictEqual(typeof ReadableStream, 'function');
      assert.strictEqual(typeof TransformStream, 'function');
      assert.strictEqual(typeof WritableStream, 'function');
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue('browser');
          controller.close();
        },
      });
      const transformed = new TransformStream({
        transform(value, controller) {
          controller.enqueue(value.toUpperCase());
        },
      });
      const reader = readable.pipeThrough(transformed).getReader();
      const first = await reader.read();
      assert.strictEqual(first.value, 'BROWSER');
      assert.strictEqual(first.done, false);
      const last = await reader.read();
      assert.strictEqual(last.done, true);
    `);
  });

  test('consumes Node streams through node:stream/consumers', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'node:stream/consumers', `
      const assert = require('node:assert');
      const { Readable } = require('node:stream');
      const { text, json, buffer } = require('node:stream/consumers');
      assert.strictEqual(await text(Readable.from(['browser ', 'consumer'])), 'browser consumer');
      assert.deepStrictEqual(await json(Readable.from(['{"answer":42}'])), { answer: 42 });
      assert.strictEqual((await buffer(Readable.from(['o', 'k']))).toString(), 'ok');
    `);
  });

  test('exposes predicates through node:util/types', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'node:util/types', `
      const assert = require('node:assert');
      const types = require('node:util/types');
      const bytes = new Uint8Array(1);
      assert.strictEqual(types.isArrayBuffer(new ArrayBuffer(1)), true);
      assert.strictEqual(types.isAnyArrayBuffer(new ArrayBuffer(1)), true);
      assert.strictEqual(types.isDate(new Date()), true);
      assert.strictEqual(types.isMap(new Map()), true);
      assert.strictEqual(types.isRegExp(/browser/), true);
      assert.strictEqual(types.isSet(new Set()), true);
      assert.strictEqual(types.isTypedArray(bytes), true);
      assert.strictEqual(types.isUint8Array(bytes), true);
      assert.strictEqual(types.isPromise(Promise.resolve()), true);
      assert.strictEqual(types.isBoxedPrimitive(Object(7)), true);
    `);
  });

  test('supports fs access for mounted virtual files', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'fs.access', `
      const assert = require('node:assert');
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const root = path.join('.bnh-missing-primitives', String(process.pid));
      const file = path.join(root, 'access.txt');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(file, 'present', 'utf8');
      await fs.access(file);
      assert.strictEqual((await fs.readFile(file, 'utf8')), 'present');
    `);
  });

  test('copies mounted virtual files with fs copyFile', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'fs.copyFile', `
      const assert = require('node:assert');
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const root = path.join('.bnh-missing-primitives', String(process.pid));
      const source = path.join(root, 'source.txt');
      const target = path.join(root, 'target.txt');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(source, 'copied', 'utf8');
      await fs.copyFile(source, target);
      assert.strictEqual(await fs.readFile(target, 'utf8'), 'copied');
    `);
  });

  test('resolves mounted virtual files with fs realpath', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'fs.realpath', `
      const assert = require('node:assert');
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const root = path.join('.bnh-missing-primitives', String(process.pid));
      const file = path.join(root, 'realpath.txt');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(file, 'resolved', 'utf8');
      assert.strictEqual(await fs.realpath(file), path.resolve(file));
    `);
  });

  test('truncates mounted virtual files with fs truncate', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'fs.truncate', `
      const assert = require('node:assert');
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const root = path.join('.bnh-missing-primitives', String(process.pid));
      const file = path.join(root, 'truncate.txt');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(file, 'truncate me', 'utf8');
      await fs.truncate(file, 8);
      assert.strictEqual(await fs.readFile(file, 'utf8'), 'truncate');
    `);
  });

  test('streams virtual filesystem watch events through async iteration', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'fs.watch async iterator', `
      const assert = require('node:assert');
      const fs = require('node:fs');
      const fsp = require('node:fs/promises');
      const path = require('node:path');
      const root = path.join('.bnh-missing-primitives', String(process.pid));
      await fsp.mkdir(root, { recursive: true });
      const watcher = fs.watch(root);
      const nextEvent = watcher[Symbol.asyncIterator]().next();
      await fsp.writeFile(path.join(root, 'watched.txt'), 'event', 'utf8');
      const event = await nextEvent;
      assert.strictEqual(event.done, false);
      assert.strictEqual(event.value.eventType, 'rename');
      assert.strictEqual(event.value.filename, 'watched.txt');
      await watcher[Symbol.asyncIterator]().return();
    `);
  });

  test('combines AbortSignal.timeout and AbortSignal.any', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'AbortSignal.timeout/any', `
      const assert = require('node:assert');
      assert.strictEqual(typeof AbortSignal.timeout, 'function');
      assert.strictEqual(typeof AbortSignal.any, 'function');
      const timedOut = AbortSignal.timeout(0);
      await new Promise((resolve) => timedOut.addEventListener('abort', resolve, { once: true }));
      assert.strictEqual(timedOut.aborted, true);
      const first = new AbortController();
      const second = new AbortController();
      const combined = AbortSignal.any([first.signal, second.signal]);
      second.abort('second signal');
      assert.strictEqual(combined.aborted, true);
      assert.strictEqual(combined.reason, 'second signal');
    `);
  });

  test('keeps an AbortSignal.any timeout race alive and preserves its reason', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'AbortSignal.any timeout race', `
      const assert = require('node:assert');
      const { once } = require('node:events');
      const signal = AbortSignal.any([AbortSignal.timeout(40), AbortSignal.timeout(200)]);
      const abortPromise = Promise.race([
        once(signal, 'abort').then(() => { throw signal.reason; }),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
      await assert.rejects(() => abortPromise, {
        name: 'TimeoutError',
        message: 'The operation was aborted due to timeout',
      });
    `);
  });

  test('does not keep the browser process alive for an unobserved timeout signal', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'AbortSignal.timeout unref', `
      const assert = require('node:assert');
      const signal = AbortSignal.timeout(1000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(signal.aborted, false);
    `, { timeoutMs: 500 });
  });

  test('cancels timers/promises setTimeout with an AbortSignal', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'timers/promises cancellation', `
      const assert = require('node:assert');
      const { setTimeout: delay } = require('node:timers/promises');
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        delay(0, 'unexpected result', { signal: controller.signal }),
        (error) => error && error.name === 'AbortError',
      );
    `);
  });

  test('uses Web Crypto through Node-shaped derivation, AES, and signing helpers', async ({ harnessPage }) => {
    await expectContract(expect, harnessPage, 'crypto wrappers', `
      const assert = require('node:assert');
      const crypto = require('node:crypto');
      const derived = crypto.pbkdf2Sync('password', 'salt', 1, 32, 'sha256');
      assert.strictEqual(derived.toString('hex'), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
      const key = Buffer.alloc(16, 7);
      const iv = Buffer.alloc(12, 3);
      const encrypted = await crypto.aesGcmEncrypt('browser secret', key, iv);
      assert.strictEqual((await crypto.aesGcmDecrypt(encrypted, key, iv)).toString(), 'browser secret');
      const signature = await crypto.sign('hmac', 'browser payload', 'browser key');
      assert.strictEqual(await crypto.verify('hmac', 'browser payload', 'browser key', signature), true);
      assert.strictEqual(await crypto.verify('hmac', 'tampered', 'browser key', signature), false);
    `);
  });
});
