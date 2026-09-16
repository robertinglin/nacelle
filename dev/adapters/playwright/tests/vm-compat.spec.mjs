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

  test('exposes own intrinsic globals to legacy child module loaders', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert/strict');
      const { spawn } = require('node:child_process');
      (async () => {
        const child = spawn(process.execPath, ['/node/inspect-global.cjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0, stderr);
        assert.deepStrictEqual(JSON.parse(stdout), {
          globalFunction: 'function',
          returnedGlobalFunction: 'function',
          vmScript: 'function',
        });
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `, {
      files: {
        '/node/inspect-global.cjs': [
          "const vm = require('node:vm');",
          "const descriptor = Object.getOwnPropertyDescriptor(global, 'Function');",
          "const loader = new vm.Script(\"const __global__ = this; (function() { return Object.getOwnPropertyDescriptor(__global__, 'Function'); })\").runInNewContext({ global });",
          "const returnedDescriptor = loader();",
          "process.stdout.write(JSON.stringify({ globalFunction: typeof descriptor?.value, returnedGlobalFunction: typeof returnedDescriptor?.value, vmScript: typeof vm.Script }));",
        ].join('\n'),
      },
      timeoutMs: 10_000,
    });
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

  test('preserves structured Error.captureStackTrace inside a context realm', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const vm = require('node:vm');
        const context = vm.createContext({});
        const stack = vm.runInContext(
          '(() => { const previous = Error.prepareStackTrace; Error.prepareStackTrace = (_, sites) => sites; const target = { stack: [] }; Error.captureStackTrace(target); Error.prepareStackTrace = previous; return target.stack; })()',
          context,
        );
        assert(Array.isArray(stack));
        assert(stack.length > 0);
        assert.strictEqual(typeof stack[0].getFileName, 'function');
      })();
    `);

    await expectPass(expect, result);
  });

  test('normalizes browser regex recursion errors to Node RangeErrors', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const vm = require('node:vm');
        const run = vm.runInThisContext(
          'function runLongRegex() { const input = "a".repeat(1e7); return /(?:a|b)+/.test(input); } runLongRegex',
        );
        let thrown;
        try {
          run();
        } catch (error) {
          thrown = error;
        }
        assert(thrown, 'the long regular expression should overflow the regex stack');
        assert.strictEqual(thrown.name, 'RangeError');
        assert.strictEqual(thrown.message, 'Maximum call stack size exceeded');
      })();
    `);

    await expectPass(expect, result);
  });

  test('honors vm.Script filename in evaluated callsites', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const capture = (label) => {
          const previousPrepare = Error.prepareStackTrace;
          const previousLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = 20;
          Error.prepareStackTrace = (_error, sites) => sites.map((site) => ({
            file: site.getFileName?.(),
            line: site.getLineNumber?.(),
            column: site.getColumnNumber?.(),
            method: site.getFunctionName?.(),
            text: String(site),
          }));
          try {
            return { label, stack: new Error(label).stack };
          } finally {
            Error.prepareStackTrace = previousPrepare;
            Error.stackTraceLimit = previousLimit;
          }
        };
        function first() { return capture('first'); }
        function second() { return capture('second'); }
        globalThis.__bnhCaptureCallsite = () => capture('vm-script');
        const vm = require('node:vm');
        const vmScript = new vm.Script(
          'function callCapture() { return globalThis.__bnhCaptureCallsite(); } callCapture();',
          { filename: '/node/vm-script.js' },
        ).runInThisContext();
        delete globalThis.__bnhCaptureCallsite;
        assert.strictEqual(vmScript.label, 'vm-script');
        const callCaptureFrame = vmScript.stack.find((site) => site.method === 'callCapture');
        assert(callCaptureFrame, 'vm.Script should preserve the evaluated function callsite');
        assert.strictEqual(callCaptureFrame.file, '/node/vm-script.js');
        assert.strictEqual(callCaptureFrame.line, 1);
      })();
    `);
    await expectPass(expect, result);
  });

});
