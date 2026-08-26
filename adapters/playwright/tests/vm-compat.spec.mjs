import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser-native node:vm builtin', () => {
  test('creates assert-compatible SyntaxErrors in a context and runs new contexts', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const vm = require('node:vm');
        const context = vm.createContext({ answer: 41 });

        const syntaxError = vm.runInContext('new SyntaxError("context syntax error")', context);
        assert.strictEqual(syntaxError.name, 'SyntaxError');
        assert.strictEqual(syntaxError.message, 'context syntax error');
        assert.throws(
          () => vm.runInContext('throw new SyntaxError("thrown syntax error")', context),
          (error) => error.name === 'SyntaxError' && error.message === 'thrown syntax error',
        );

        assert.strictEqual(vm.runInNewContext('answer + 1', { answer: 41 }), 42);
        assert.strictEqual(vm.runInNewContext('typeof process'), 'undefined');
        assert.strictEqual(vm.runInNewContext('globalThis.process'), undefined);
      })();
    `);

    await expectPass(expect, result);
  });

  test('uses a distinct browser realm for context constructors and Web Crypto inputs', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const vm = require('node:vm');
        const { webcrypto } = require('node:crypto');
        const context = vm.createContext({ answer: 41 });
        const foreign = vm.runInContext('(() => { const view = new Uint8Array([1, 2, 3, 4]); return { buffer: view.buffer, view, arrayBuffer: ArrayBuffer, global: globalThis }; })()', context);

        assert.notStrictEqual(foreign.arrayBuffer, ArrayBuffer);
        assert.notStrictEqual(foreign.global, globalThis);
        assert.notStrictEqual(Object.getPrototypeOf(foreign.buffer), ArrayBuffer.prototype);
        assert.strictEqual(ArrayBuffer.isView(foreign.view), true);
        assert.notStrictEqual(Object.getPrototypeOf(foreign.view), Uint8Array.prototype);
        assert.strictEqual(vm.isContext(context), true);
        assert.strictEqual(vm.runInContext('answer + 1', context), 42);

        vm.runInContext('answer = 42; globalThis.createdInContext = true', context);
        assert.strictEqual(context.answer, 42);
        assert.strictEqual(context.createdInContext, true);
        await webcrypto.subtle.digest('SHA-256', foreign.buffer);
        await webcrypto.subtle.digest('SHA-256', foreign.view);

        const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, foreign.buffer);
        const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        assert.deepStrictEqual([...new Uint8Array(plaintext)], [1, 2, 3, 4]);

        if (typeof SharedArrayBuffer === 'function') {
          const sharedContext = vm.createContext({});
          const foreignShared = vm.runInContext('new SharedArrayBuffer(4)', sharedContext);
          assert.notStrictEqual(Object.getPrototypeOf(foreignShared), SharedArrayBuffer.prototype);
          const [sameRealmResult, crossRealmResult] = await Promise.allSettled([
            webcrypto.subtle.digest('SHA-256', new Uint8Array(new SharedArrayBuffer(4))),
            webcrypto.subtle.digest('SHA-256', new Uint8Array(foreignShared)),
          ]);
          assert.strictEqual(sameRealmResult.status, 'rejected');
          assert.strictEqual(crossRealmResult.status, 'rejected');
          assert.strictEqual(crossRealmResult.reason.message, sameRealmResult.reason.message);
        }
      })();
    `);

    await expectPass(expect, result);
  });

});
