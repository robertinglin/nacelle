import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser-native node:test builtin', () => {
  test('runs a synchronous passing test', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { test } = require('node:test');

      test('sync pass', () => {
        assert.strictEqual(2 + 2, 4);
      });
    `);

    await expectPass(expect, result);
  });

  test('sets exitCode and writes stderr for a synchronous assertion failure', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { test } = require('node:test');

      test('sync failure', () => {
        assert.strictEqual('browser', 'node', 'node:test assertion failure');
      });
    `);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('node:test assertion failure');
  });

  test('waits for an asynchronous test to complete', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { test } = require('node:test');

      test('async completion', async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.strictEqual(true, true);
        process.stdout.write('async test completed\\n');
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('async test completed');
  });

  test('preserves the standard async function constructor identity', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert/strict');
      const asyncFunction = async () => {};
      assert.strictEqual(asyncFunction.constructor.name, 'AsyncFunction');
      assert.strictEqual(Object.prototype.toString.call(asyncFunction), '[object AsyncFunction]');
    `);

    await expectPass(expect, result);
  });

  test('keeps process stdout writable when a reporter pipes into it', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const { Readable } = require('node:stream');
      Readable.from(['reporter output\\n']).pipe(process.stdout);
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('reporter output');
  });

  test('does not execute skipped or todo test callbacks', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const { test } = require('node:test');

      test('skipped callback', { skip: 'browser regression coverage' }, () => {
        throw new Error('skip callback executed');
      });
      test('todo callback', { todo: 'browser regression coverage' }, () => {
        throw new Error('todo callback executed');
      });
    `);

    await expectPass(expect, result);
    expect(result.stderr).not.toContain('callback executed');
  });

  test('waits for suite hooks registered during the suite definition', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { describe, test } = require('node:test');
      let ready = false;

      describe('async hook suite', () => {
        require('node:test').before(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          ready = true;
        });
        test('hook completed first', () => assert.strictEqual(ready, true));
      });
    `);

    await expectPass(expect, result);
  });

  test('run loads test files and emits the standard test stream events', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { run } = require('node:test');

      (async () => {
        const events = [];
        const streamEvents = [];
        const stream = run({ files: ['/node/runner-test.js'] });
        stream.on('test:pass', () => events.push('test:pass'));
        for (const type of ['test:enqueue', 'test:dequeue', 'test:start', 'test:complete', 'test:plan', 'test:diagnostic', 'test:summary']) {
          stream.on(type, () => streamEvents.push(type));
        }
        const report = stream.compose(async function* (source) {
          for await (const event of source) {
            if (event.type === 'test:complete') {
              assert.strictEqual(event.data.details.passed, true);
              assert.strictEqual(event.data.file, '/node/runner-test.js');
              yield 'report saw complete\\n';
            }
          }
        });
        const reportChunks = [];
        report.on('data', (chunk) => reportChunks.push(String(chunk)));
        await new Promise((resolve, reject) => {
          report.once('error', reject);
          report.once('end', resolve);
        });
        assert.deepStrictEqual(events, ['test:pass']);
        assert.deepStrictEqual(streamEvents, [
          'test:dequeue', 'test:complete', 'test:start',
          'test:plan', 'test:diagnostic', 'test:diagnostic', 'test:diagnostic',
          'test:diagnostic', 'test:diagnostic', 'test:diagnostic', 'test:diagnostic',
          'test:summary',
        ]);
        assert.deepStrictEqual(reportChunks, ['report saw complete\\n']);
        process.stdout.write('node:test runner stream completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
        files: {
          '/node/runner-test.js': [
          "const { before, test } = require('node:test');",
          "let ready = false;",
          "before(async () => { await Promise.resolve(); ready = true; });",
          "test('runner pass', () => require('node:assert').strictEqual(ready, true));",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('node:test runner stream completed');
  });

  test('enforces the node:test run timeout and closes its result stream', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { run } = require('node:test');

      (async () => {
        const failures = [];
        globalThis.aborted = false;
        const stream = run({ files: ['/node/hanging-test.js'], timeout: 20 });
        stream.on('test:fail', (event) => failures.push(event));
        stream.resume();
        await new Promise((resolve, reject) => {
          stream.once('error', reject);
          stream.once('end', resolve);
        });
        assert.strictEqual(failures.length, 1);
        assert.strictEqual(globalThis.aborted, true);
        assert.match(failures[0].details.error.cause.message, /timed out after 20ms/);
        // A failed node:test run correctly sets the hosting process exitCode;
        // this oracle has inspected that failure and is itself successful.
        process.exitCode = 0;
        process.stdout.write('node:test timeout completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/hanging-test.js': [
          "const { test } = require('node:test');",
          'test(\'hangs\', async (context) => new Promise((resolve, reject) => context.signal.addEventListener(\'abort\', () => { globalThis.aborted = true; reject(context.signal.reason); })));',
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('node:test timeout completed');
  });

  test('pipes an async-generator node:test reporter into process stdout', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { finished } = require('node:stream/promises');
      const { run } = require('node:test');

      (async () => {
        const stream = await run({ files: ['/node/reporter-test.js'] });
        const output = stream.compose(async function* reporter(source) {
          for await (const event of source) {
            if (event.type === 'test:complete') {
              assert.strictEqual(event.data.details.passed, true);
              yield 'reporter: ' + event.data.name + '\\n';
            }
          }
        });
        output.pipe(process.stdout);
        await finished(stream);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/reporter-test.js': "const { test } = require('node:test'); test('reporter pass', () => {});",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('reporter: reporter pass');
  });

  test('completes an async-generator composition after an object stream terminal', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { Readable } = require('node:stream');
      (async () => {
        const source = new Readable({ objectMode: true, read() {} });
        const output = source.compose(async function* (input) {
          for await (const value of input) yield value + 1;
        });
        const values = [];
        output.on('data', (value) => values.push(value));
        await new Promise((resolve, reject) => {
          output.once('error', reject);
          output.once('end', resolve);
          source.push(1);
          source.push(null);
        });
        assert.deepStrictEqual(values, [2]);
        process.stdout.write('async composition completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('async composition completed');
  });

  test('observes a Web Stream with finished without stealing its reader', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { finished } = require('node:stream');

      (async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([7]));
            controller.close();
          },
        });
        const terminal = new Promise((resolve, reject) => {
          finished(stream, (error) => error ? reject(error) : resolve());
        });
        assert.strictEqual(stream.locked, false);
        const reader = stream.getReader();
        assert.deepStrictEqual(await reader.read(), { value: new Uint8Array([7]), done: false });
        assert.deepStrictEqual(await reader.read(), { value: undefined, done: true });
        reader.releaseLock();
        await terminal;
        assert.strictEqual(stream.locked, false);
        process.stdout.write('web stream finished callback completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('web stream finished callback completed');
  });

  test('preserves non-consuming finished semantics in a nested Node child', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn(process.execPath, ['/node/web-stream-finished-child.js']);
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0, errorOutput);
        assert.strictEqual(output, 'nested web stream finished completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/web-stream-finished-child.js': [
          "const assert = require('node:assert');",
          "const { finished } = require('node:stream');",
          "const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([9])); controller.close(); } });",
          "const terminal = new Promise((resolve, reject) => finished(stream, (error) => error ? reject(error) : resolve()));",
          "assert.strictEqual(stream.locked, false);",
          "(async () => {",
          "  const reader = stream.getReader();",
          "  assert.deepStrictEqual(await reader.read(), { value: new Uint8Array([9]), done: false });",
          "  assert.deepStrictEqual(await reader.read(), { value: undefined, done: true });",
          "  reader.releaseLock();",
          "  await terminal;",
          "  assert.strictEqual(stream.locked, false);",
          "  process.stdout.write('nested web stream finished completed\\n');",
          "})().catch((error) => { console.error(error); process.exitCode = 1; });",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('shares node:test state across an ESM runner and imported ESM test files', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { finished } from 'node:stream/promises';
      import { run } from 'node:test';

      const stream = run({ files: ['/node/esm-runner-test.mjs'] });
      const events = [];
      stream.on('test:pass', (event) => events.push(event.name));
      const report = stream.compose(async function* reporter(source) {
        for await (const event of source) {
          if (event.type === 'test:complete') yield 'esm report complete\\n';
        }
      });
      const chunks = [];
      report.on('data', (chunk) => chunks.push(String(chunk)));
      await new Promise((resolve, reject) => {
        report.once('error', reject);
        report.once('end', resolve);
      });
      await finished(stream);
      assert.deepStrictEqual(events, ['esm runner pass']);
      assert.deepStrictEqual(chunks, ['esm report complete\\n']);
      process.stdout.write('esm node:test runner completed\\n');
    `, {
      entryPath: '/node/esm-runner.mjs',
      files: {
        '/node/esm-runner-test.mjs': `
          import { test } from 'node:test';
          test('esm runner pass', () => {});
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('esm node:test runner completed');
  });

  test('preserves generic runner discovery state through a child terminal result', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert/strict');
      const { run } = require('node:test');
      const stream = run({ files: ['/node/state-test.js'] });
      stream.resume();
      stream.once('end', () => {
        assert.deepStrictEqual(process.__bnhNodeTestState.requestedFiles, ['/node/state-test.js']);
        assert.deepStrictEqual(process.__bnhNodeTestState.files, ['/node/state-test.js']);
        assert.strictEqual(process.__bnhNodeTestState.registered, 1);
        process.stdout.write('node:test discovery state completed\\n');
      });
    `, {
      files: {
        '/node/state-test.js': "const { test } = require('node:test'); test('state pass', () => {});",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('node:test discovery state completed');
    expect(result.runResult?.details?.runtime_state?.nodeTest?.requestedFiles)
      .toEqual(['/node/state-test.js']);
  });

  test('runs root hooks when an ESM runner discovers a CommonJS test file', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { run } from 'node:test';

      const stream = run({ files: ['/node/cjs-hook-test.js'] });
      stream.resume();
      await new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.once('end', resolve);
      });
      assert.strictEqual(process.exitCode, 0);
      process.stdout.write('esm CJS root hook completed\\n');
    `, {
      entryPath: '/node/esm-cjs-runner.mjs',
        files: {
          '/node/cjs-hook-test.js': [
          "const { before, test } = require('node:test');",
          "const assert = require('node:assert/strict');",
          "const dns = require('node:dns').promises;",
          "let ready = false;",
          "before(async () => { const lookup = await dns.lookup('localhost'); ready = lookup.address === '127.0.0.1'; });",
          "test('CJS root hook ran', () => assert.strictEqual(ready, true));",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('esm CJS root hook completed');
  });

  test('runs asynchronous CommonJS root hooks through a required helper module', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { run } from 'node:test';

      const stream = run({ files: ['/node/cjs-helper-hook-test.js'] });
      stream.resume();
      await new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.once('end', resolve);
      });
      assert.strictEqual(process.exitCode, 0);
      process.stdout.write('esm CJS helper root hook completed\\n');
    `, {
      entryPath: '/node/esm-cjs-helper-runner.mjs',
      files: {
        '/node/cjs-hook-helper.js': [
          "const dns = require('node:dns').promises;",
          'module.exports.getLoopbackHost = async () => {',
          "  const lookup = await dns.lookup('localhost');",
          "  return [lookup.address, lookup.family === 6 ? '[' + lookup.address + ']' : lookup.address];",
          '};',
        ].join('\n'),
        '/node/cjs-helper-hook-test.js': [
          "const { before, test } = require('node:test');",
          "const assert = require('node:assert/strict');",
          "const helper = require('./cjs-hook-helper');",
          'let localhost;',
          'before(async function () { [localhost] = await helper.getLoopbackHost(); });',
          "test('CJS helper root hook ran', () => assert.strictEqual(localhost, '127.0.0.1'));",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('esm CJS helper root hook completed');
  });

  test('waits for all discovered files before running registered tests', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { run } from 'node:test';

      const stream = run({ files: ['/node/early.test.js', '/node/late-hook.test.js'] });
      stream.resume();
      await new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.once('end', resolve);
      });
      assert.strictEqual(process.exitCode, 0);
      process.stdout.write('discovery gate completed\\n');
    `, {
      entryPath: '/node/discovery-gate-runner.mjs',
      files: {
        '/node/early.test.js': [
          "const { test } = require('node:test');",
          "test('early file test', () => {});",
          'setTimeout(() => {}, 0);',
        ].join('\n'),
        '/node/late-hook.test.js': [
          "const { before, test } = require('node:test');",
          "const assert = require('node:assert/strict');",
          "const dns = require('node:dns').promises;",
          'let ready = false;',
          "before(async () => { const lookup = await dns.lookup('localhost'); ready = lookup.address === '127.0.0.1'; });",
          "test('late file root hook test', () => assert.strictEqual(ready, true));",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('discovery gate completed');
  });
});
