import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('routes Node internal fork messages separately from user messages', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert');
    const { fork } = require('node:child_process');

    if (process.argv[2] === 'child') {
      process.send({ cmd: 'fooNODE_bar' });
      process.send({ cmd: 'NODE_bar' });
      process.exit(0);
    } else {
      const child = fork(process.argv[1], ['child']);
      const order = [];
      let messageCount = 0;
      let internalMessageCount = 0;
      child.once('message', (message) => {
        order.push('message');
        messageCount += 1;
        assert.deepStrictEqual(message, { cmd: 'fooNODE_bar' });
      });
      child.once('internalMessage', (message) => {
        order.push('internalMessage');
        internalMessageCount += 1;
        assert.deepStrictEqual(message, { cmd: 'NODE_bar' });
      });
      child.once('exit', (code, signal) => {
        order.push('exit');
        assert.strictEqual(code, 0);
        assert.strictEqual(signal, null);
      });
      child.once('close', () => {
        order.push('close');
        assert.strictEqual(messageCount, 1);
        assert.strictEqual(internalMessageCount, 1);
        assert.deepStrictEqual(order, ['message', 'internalMessage', 'exit', 'close']);
        process.stdout.write('child-ipc-contract-passed');
      });
    }
  `);

  await expectPass(expect, result);
  expect(result.stdout).toContain('child-ipc-contract-passed');
});

test('accepts a file URL as a fork entry point', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    import assert from 'node:assert';
    import { fork } from 'node:child_process';

    if (process.argv[2] === 'child') {
      process.disconnect();
    } else {
      const child = fork(new URL(import.meta.url), ['child']);
      child.once('disconnect', () => assert.strictEqual(child.connected, false));
      child.once('exit', (code, signal) => {
        assert.strictEqual(code, 0);
        assert.strictEqual(signal, null);
      });
    }
  `, {
    entryPath: '/node/fork-url-contract.mjs',
    files: {
      '/node/fork-url-contract.mjs': '',
    },
  });

  await expectPass(expect, result);
});

test('exposes a refable process channel to forked ESM children', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    if (process.argv[2] === 'child') {
      assert.strictEqual(typeof process.channel?.ref, 'function');
      assert.strictEqual(typeof process.channel?.unref, 'function');
      assert.strictEqual(typeof process.channel?.hasRef, 'function');
      process.channel.unref();
      assert.strictEqual(process.channel.hasRef(), false);
      process.channel.ref();
      assert.strictEqual(process.channel.hasRef(), true);
      process.send({ channel: 'refable' });
      process.exit(0);
    }

    const child = fork('/node/channel-ref-child.mjs', ['child']);
    child.once('message', (message) => assert.deepStrictEqual(message, { channel: 'refable' }));
    child.once('exit', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
    });
    child.once('close', () => process.stdout.write('channel ref contract passed'));
  `, {
    files: {
      '/node/channel-ref-child.mjs': `
        import assert from 'node:assert/strict';
        assert.strictEqual(typeof process.channel?.ref, 'function');
        assert.strictEqual(typeof process.channel?.unref, 'function');
        assert.strictEqual(typeof process.channel?.hasRef, 'function');
        process.channel.unref();
        assert.strictEqual(process.channel.hasRef(), false);
        process.channel.ref();
        assert.strictEqual(process.channel.hasRef(), true);
        process.send({ channel: 'refable' });
        process.exit(0);
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('channel ref contract passed');
});

test('settles Web Crypto operations in an isolated ESM child with public IPC', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/crypto-child.mjs', [], { cwd: '/node' });
    let message;
    let errorOutput = '';
    child.on('message', (value) => { message = value; });
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0, errorOutput);
      assert.strictEqual(signal, null);
      assert.deepStrictEqual(message, { valid: true });
      process.stdout.write('isolated Web Crypto child settled');
    });
  `, {
    files: {
      '/node/package.json': JSON.stringify({ type: 'module' }),
      '/node/crypto-child.mjs': `
        import assert from 'node:assert/strict';
        import crypto from 'node:crypto';

        const pair = await new Promise((resolve, reject) => {
          crypto.generateKeyPair('ec', { namedCurve: 'P-256' }, (error, publicKey, privateKey) => {
            if (error) reject(error);
            else resolve({ publicKey, privateKey });
          });
        });
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          pair.privateKey.export({ format: 'jwk' }),
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['sign'],
        );
        const publicKey = await crypto.subtle.importKey(
          'jwk',
          pair.publicKey.export({ format: 'jwk' }),
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        );
        const data = new TextEncoder().encode('isolated Web Crypto child');
        const signature = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          privateKey,
          data,
        );
        const valid = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          signature,
          data,
        );
        assert.strictEqual(valid, true);
        process.send({ valid });
        process.disconnect();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('isolated Web Crypto child settled');
});

test('preserves the public IPC channel through an ESM node:process import', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/imported-process-child.mjs', ['child'], { cwd: '/node' });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('message', (message) => {
      assert.deepStrictEqual(message, { imported: true, refable: true });
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('imported node:process IPC contract passed');
    });
  `, {
    files: {
      '/node/imported-process-child.mjs': `
        import assert from 'node:assert/strict';
        import nodeProcess from 'node:process';
        assert.strictEqual(typeof nodeProcess.send, 'function');
        assert.strictEqual(typeof nodeProcess.channel?.ref, 'function');
        assert.strictEqual(typeof nodeProcess.channel?.unref, 'function');
        assert.strictEqual(typeof nodeProcess.channel?.hasRef, 'function');
        nodeProcess.channel.unref();
        assert.strictEqual(nodeProcess.channel.hasRef(), false);
        nodeProcess.channel.ref();
        assert.strictEqual(nodeProcess.channel.hasRef(), true);
        nodeProcess.send({ imported: true, refable: true });
        nodeProcess.disconnect();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('imported node:process IPC contract passed');
});

test('preserves the public IPC channel through a CommonJS helper imported by ESM', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/esm-cjs-process-child.mjs', ['child'], { cwd: '/node' });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('message', (message) => {
      assert.deepStrictEqual(message, { helper: true, refable: true });
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('ESM CommonJS IPC contract passed');
    });
  `, {
    files: {
      '/node/esm-cjs-process-child.mjs': `
        import run from './esm-cjs-process-helper.cjs';
        run();
      `,
      '/node/esm-cjs-process-helper.cjs': `
        const assert = require('node:assert/strict');
        const nodeProcess = require('node:process');
        module.exports = () => {
          assert.strictEqual(typeof nodeProcess.send, 'function');
          assert.strictEqual(typeof nodeProcess.channel?.ref, 'function');
          assert.strictEqual(typeof nodeProcess.channel?.unref, 'function');
          assert.strictEqual(typeof nodeProcess.channel?.hasRef, 'function');
          nodeProcess.channel.unref();
          assert.strictEqual(nodeProcess.channel.hasRef(), false);
          nodeProcess.channel.ref();
          assert.strictEqual(nodeProcess.channel.hasRef(), true);
          nodeProcess.send({ helper: true, refable: true });
          nodeProcess.disconnect();
        };
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('ESM CommonJS IPC contract passed');
});

test('delivers a two-way IPC handshake to an isolated ESM child', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/esm-ipc-handshake-child.mjs', [], { cwd: '/node' });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      if (message?.kind === 'ready') child.send({ kind: 'options', value: 42 });
      else if (message?.kind === 'finished') {
        assert.strictEqual(message.value, 42);
        child.disconnect();
      }
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('isolated ESM IPC handshake passed');
    });
  `, {
    files: {
      '/node/esm-ipc-handshake-child.mjs': `
        import assert from 'node:assert/strict';
        import nodeProcess from 'node:process';
        import { once } from 'node:events';
        nodeProcess.send({ kind: 'ready' });
        const [{ kind, value }] = await once(nodeProcess, 'message');
        assert.strictEqual(kind, 'options');
        nodeProcess.send({ kind: 'finished', value });
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('isolated ESM IPC handshake passed');
});

test('delivers a two-way IPC handshake to a CommonJS child loaded by ESM', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/esm-cjs-ipc-handshake-child.mjs', [], { cwd: '/node' });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      if (message?.kind === 'ready') child.send({ kind: 'options', value: 42 });
      else if (message?.kind === 'finished') {
        assert.strictEqual(message.value, 42);
        child.disconnect();
      }
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('ESM CommonJS IPC handshake passed');
    });
  `, {
    files: {
      '/node/esm-cjs-ipc-handshake-child.mjs': `
        import run from './esm-cjs-ipc-handshake-helper.cjs';
        await run();
      `,
      '/node/esm-cjs-ipc-handshake-helper.cjs': `
        const assert = require('node:assert/strict');
        const events = require('node:events');
        const nodeProcess = require('node:process');
        module.exports = async () => {
          assert.strictEqual(typeof nodeProcess.send, 'function');
          nodeProcess.channel.ref();
          nodeProcess.send({ kind: 'ready' });
          const [{ kind, value }] = await events.once(nodeProcess, 'message');
          assert.strictEqual(kind, 'options');
          nodeProcess.send({ kind: 'finished', value });
        };
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('ESM CommonJS IPC handshake passed');
});

test('exposes the public IPC channel to a Node child spawned with ipc stdio', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { spawn } = require('node:child_process');

    (async () => {
      const child = spawn(process.execPath, ['/node/spawn-ipc-child.cjs'], {
        cwd: '/node',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let output = '';
      let message;
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.on('message', (value) => { message = value; });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(message, { channel: 'spawn' });
      assert.strictEqual(output, 'spawn IPC child ran\\n');
      process.stdout.write('spawn IPC channel contract passed');
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `, {
      files: {
        '/node/spawn-ipc-child.cjs': [
          "const assert = require('node:assert/strict');",
          "const nodeProcess = require('node:process');",
          'for (const currentProcess of [process, nodeProcess]) {',
          "  assert.strictEqual(typeof currentProcess.channel?.ref, 'function');",
          "  assert.strictEqual(typeof currentProcess.channel?.unref, 'function');",
          "  assert.strictEqual(typeof currentProcess.channel?.hasRef, 'function');",
          '  currentProcess.channel.ref();',
          '}',
          "nodeProcess.send({ channel: 'spawn' });",
          "nodeProcess.stdout.write('spawn IPC child ran\\n');",
          'nodeProcess.exit(0);',
        ].join('\n'),
      },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('spawn IPC channel contract passed');
});

test('settles an asynchronous fork worker after its IPC channel is released', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/async-ipc-worker.mjs', ['child']);
    child.on('message', (message) => {
      if (message?.kind === 'ready') {
        child.send({ kind: 'options', value: 1 });
      } else if (message?.kind === 'finished') {
        child.send({ kind: 'free' });
      }
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('async fork IPC lifecycle passed');
    });
  `, {
    files: {
      '/node/async-ipc-worker.mjs': `
        import assert from 'node:assert/strict';
        import { on } from 'node:events';
        const waitFor = async (kind) => {
          for await (const [message] of on(process, 'message')) {
            if (message?.kind === kind) return message;
          }
        };
        if (process.argv[2] === 'child') {
          process.channel.ref();
          process.send({ kind: 'ready' });
          const options = await waitFor('options');
          assert.deepStrictEqual(options, { kind: 'options', value: 1 });
          process.send({ kind: 'finished' });
          const free = await waitFor('free');
          assert.deepStrictEqual(free, { kind: 'free' });
          process.channel.unref();
          process.disconnect();
        }
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('async fork IPC lifecycle passed');
});

test('forwards fork execArgv through an ESM preload and public IPC channel', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/exec-argv-child.mjs', [], {
      cwd: '/node',
      execArgv: ['--import', '/node/preload.mjs'],
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('message', (message) => {
      assert.deepStrictEqual(message, { preloaded: true, channel: true });
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('fork execArgv contract passed');
    });
  `, {
    files: {
      '/node/package.json': JSON.stringify({ type: 'module' }),
      '/node/preload.mjs': 'globalThis.__bnhPreloaded = true;',
      '/node/exec-argv-child.mjs': `
        import assert from 'node:assert/strict';
        assert.strictEqual(globalThis.__bnhPreloaded, true);
        assert.strictEqual(typeof process.channel?.ref, 'function');
        process.channel.ref();
        process.send({ preloaded: true, channel: true });
        process.channel.unref();
        process.disconnect();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('fork execArgv contract passed');
});

test('exposes the refable IPC channel before a CommonJS fork entry loads', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/cjs-channel-child.cjs', [], { cwd: '/node' });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('message', (message) => {
      assert.deepStrictEqual(message, { refable: true });
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('CommonJS fork channel contract passed');
    });
  `, {
    files: {
      '/node/cjs-channel-child.cjs': [
        "const assert = require('node:assert/strict');",
        "assert.strictEqual(typeof process.channel?.ref, 'function');",
        "assert.strictEqual(typeof process.channel?.unref, 'function');",
        "assert.strictEqual(typeof process.channel?.hasRef, 'function');",
        'process.channel.unref();',
        'assert.strictEqual(process.channel.hasRef(), false);',
        'process.channel.ref();',
        'assert.strictEqual(process.channel.hasRef(), true);',
        "process.send({ refable: true });",
        'process.exit(0);',
      ].join('\n'),
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('CommonJS fork channel contract passed');
});

test('preserves the public IPC channel for CommonJS forks created by an ESM child', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const parent = fork('/node/esm-fork-parent.mjs', [], { cwd: '/node' });
    const messages = [];
    let errorOutput = '';
    parent.on('message', (value) => { messages.push(value); });
    parent.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    parent.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    parent.once('close', (code, signal) => {
      assert.strictEqual(code, 0, errorOutput);
      assert.strictEqual(signal, null);
      assert.deepStrictEqual(messages, [
        { parentChannel: true },
        { childChannel: true },
      ]);
      process.stdout.write('ESM-created CommonJS fork channel contract passed');
    });
  `, {
    files: {
      '/node/package.json': JSON.stringify({ type: 'module' }),
      '/node/esm-fork-parent.mjs': `
        import { fork } from 'node:child_process';
        if (typeof process.channel?.ref !== 'function') process.exitCode = 1;
        process.send({ parentChannel: typeof process.channel?.ref === 'function' });
        const child = fork('/node/refable-child.cjs', [], { cwd: '/node' });
        child.once('message', (message) => {
          process.send(message);
          child.disconnect();
        });
        child.once('close', (code) => {
          if (code !== 0) process.exitCode = code || 1;
          process.disconnect();
        });
      `,
      '/node/refable-child.cjs': `
        const nodeProcess = require('node:process');
        if (typeof nodeProcess.channel?.ref !== 'function') nodeProcess.exitCode = 1;
        else {
          nodeProcess.channel.ref();
          nodeProcess.send({ childChannel: true });
          nodeProcess.channel.unref();
          nodeProcess.disconnect();
        }
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('ESM-created CommonJS fork channel contract passed');
});

test('preserves a package-specifier preload while bootstrapping a forked ESM child', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/child.mjs', [], {
      cwd: '/node',
      env: { ...process.env, NODE_OPTIONS: '--import=loader-package/register' },
      silent: true,
      serialization: 'advanced',
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('message', (message) => {
      assert.deepStrictEqual(message, { ready: true });
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('package preload fork contract passed');
    });
  `, {
    files: {
      '/node/package.json': JSON.stringify({ type: 'module' }),
      '/node/node_modules/loader-package/package.json': JSON.stringify({
        name: 'loader-package',
        type: 'module',
        exports: { './register': './register.mjs' },
      }),
      '/node/node_modules/loader-package/register.mjs': `
        import { register } from 'node:module';
        register('./hooks.mjs', import.meta.url);
      `,
      '/node/node_modules/loader-package/hooks.mjs': `
        export async function resolve(specifier, context, nextResolve) {
          return nextResolve(specifier, context);
        }
        export async function load(url, context, nextLoad) {
          return nextLoad(url, context);
        }
      `,
      '/node/child.mjs': `
        import assert from 'node:assert/strict';
        assert.strictEqual(typeof process.channel?.ref, 'function');
        process.channel.ref();
        process.send({ ready: true });
        process.disconnect();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('package preload fork contract passed');
});

test('preserves the refable IPC channel through an advanced ESM child handshake', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/child.mjs', [], {
      cwd: '/node',
      silent: true,
      serialization: 'advanced',
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      if (message?.ready) child.send({ kind: 'options', value: 42 });
      if (message?.done) child.disconnect();
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('advanced ESM IPC contract passed');
    });
  `, {
    files: {
      '/node/child.mjs': `
        import run from './channel-helper.cjs';
        await run();
      `,
      '/node/channel-helper.cjs': `
        const assert = require('node:assert/strict');
        const events = require('node:events');
        const nodeProcess = require('node:process');
        module.exports = async () => {
          assert.strictEqual(typeof nodeProcess.send, 'function');
          assert.strictEqual(typeof nodeProcess.channel?.ref, 'function');
          assert.strictEqual(typeof nodeProcess.channel?.unref, 'function');
          nodeProcess.channel.ref();
          nodeProcess.send({ ready: true });
          const [{ kind, value }] = await events.once(nodeProcess, 'message');
          assert.strictEqual(kind, 'options');
          assert.strictEqual(value, 42);
          nodeProcess.send({ done: true });
          nodeProcess.disconnect();
        };
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('advanced ESM IPC contract passed');
});

test('forwards the child IPC send callback through an isolated ESM child', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/child.mjs', [], {
      cwd: '/node',
      silent: true,
      serialization: 'advanced',
    });
    let callbackError = new Error('child.send callback was not invoked');
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      if (message?.ready) {
        child.send({ kind: 'options', value: 7 }, (error) => {
          callbackError = error || null;
        });
      }
      if (message?.done) child.disconnect();
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      assert.strictEqual(callbackError, null);
      process.stdout.write('IPC callback contract passed');
    });
  `, {
    files: {
      '/node/child.mjs': `
        import events from 'node:events';
        import nodeProcess from 'node:process';
        nodeProcess.channel.ref();
        nodeProcess.send({ ready: true });
        const [{ kind, value }] = await events.once(nodeProcess, 'message');
        if (kind !== 'options' || value !== 7) nodeProcess.exitCode = 1;
        nodeProcess.send({ done: true });
        nodeProcess.disconnect();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('IPC callback contract passed');
});

test('delivers isolated ESM child IPC through an events async iterator', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/child.mjs', [], {
      cwd: '/node',
      silent: true,
      serialization: 'advanced',
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      if (message?.ready) child.send({ kind: 'options', value: 11 });
      if (message?.done) child.disconnect();
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('IPC async iterator contract passed');
    });
  `, {
    files: {
      '/node/child.mjs': `
        import events from 'node:events';
        import nodeProcess from 'node:process';
        nodeProcess.channel.ref();
        const messages = events.on(nodeProcess, 'message');
        nodeProcess.send({ ready: true });
        for await (const [message] of messages) {
          if (message?.kind !== 'options' || message.value !== 11) nodeProcess.exitCode = 1;
          nodeProcess.send({ done: true });
          nodeProcess.disconnect();
          break;
        }
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('IPC async iterator contract passed');
});

test('delivers same-realm CommonJS child IPC through an events async iterator', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/child.cjs', [], {
      cwd: '/node',
      silent: true,
      serialization: 'advanced',
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      if (message?.ready) child.send({ kind: 'options', value: 13 });
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      process.stdout.write('CommonJS IPC async iterator contract passed');
    });
  `, {
    files: {
      '/node/child.cjs': `
        const events = require('node:events');
        const nodeProcess = require('node:process');
        nodeProcess.channel.ref();
        const messages = events.on(nodeProcess, 'message');
        nodeProcess.send({ ready: true });
        (async () => {
          for await (const [message] of messages) {
            if (message?.kind !== 'options' || message.value !== 13) nodeProcess.exitCode = 1;
            nodeProcess.send({ done: true });
            nodeProcess.disconnect();
            break;
          }
        })();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('CommonJS IPC async iterator contract passed');
});

test('preserves ref and async IPC ordering across a worker-style child lifecycle', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/lifecycle-child.mjs', [], {
      cwd: '/node',
      silent: true,
      serialization: 'advanced',
    });
    const messages = [];
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      messages.push(message);
      if (message?.ava?.type === 'ready-for-options') {
        child.send({ ava: { type: 'options', options: { value: 17 } } });
      } else if (message?.ava?.type === 'worker-finished') {
        child.send({ ava: { type: 'free-worker' } });
      }
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      assert.deepStrictEqual(messages.map(({ ava }) => ava?.type), [
        'ready-for-options', 'worker-finished',
      ]);
      process.stdout.write('worker-style IPC lifecycle contract passed');
    });
  `, {
    files: {
      '/node/lifecycle-child.mjs': `
        import events from 'node:events';
        import nodeProcess from 'node:process';

        const nextMessage = async (type) => {
          for await (const [message] of events.on(nodeProcess, 'message')) {
            if (message?.ava?.type === type) return message;
          }
        };

        nodeProcess.channel.ref();
        nodeProcess.send({ ava: { type: 'ready-for-options' } });
        const options = await nextMessage('options');
        if (options.ava.options.value !== 17) nodeProcess.exitCode = 1;
        nodeProcess.channel.unref();
        nodeProcess.send({ ava: { type: 'worker-finished' } });
        nodeProcess.channel.ref();
        await nextMessage('free-worker');
        nodeProcess.channel.unref();
        setImmediate(() => nodeProcess.stdout.write('child lifecycle complete\\n'));
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('worker-style IPC lifecycle contract passed');
});

test('binds the public IPC channel for top-level CommonJS imports in ESM children', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/esm-entry.mjs', [], { cwd: '/node', silent: true });
    const messages = [];
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      messages.push(message);
      if (message?.ava?.type === 'ready-for-options') {
        child.send({ ava: { type: 'options', options: { value: 23 } } });
      } else if (message?.ava?.type === 'worker-finished') {
        child.send({ ava: { type: 'free-worker' } });
      }
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      assert.deepStrictEqual(messages.map(({ ava }) => ava?.type), [
        'ready-for-options', 'worker-finished',
      ]);
      process.stdout.write('top-level CommonJS IPC contract passed');
    });
  `, {
    files: {
      '/node/esm-entry.mjs': `
        import './top-level-channel.cjs';
      `,
      '/node/top-level-channel.cjs': `
        const events = require('node:events');
        const nodeProcess = require('node:process');
        const messages = events.on(nodeProcess, 'message');
        nodeProcess.channel.ref();
        nodeProcess.send({ ava: { type: 'ready-for-options' } });
        (async () => {
          for await (const [message] of messages) {
            if (message?.ava?.type === 'options') {
              if (message.ava.options.value !== 23) nodeProcess.exitCode = 1;
              nodeProcess.channel.unref();
              nodeProcess.send({ ava: { type: 'worker-finished' } });
              nodeProcess.channel.ref();
            } else if (message?.ava?.type === 'free-worker') {
              nodeProcess.channel.unref();
              setImmediate(() => nodeProcess.stdout.write('top-level child complete\\n'));
              break;
            }
          }
        })();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('top-level CommonJS IPC contract passed');
});

test('keeps concurrent IPC selectors ordered while a child is referenced', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');

    const child = fork('/node/selector-entry.mjs', [], { cwd: '/node', silent: true });
    const messages = [];
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.on('message', (message) => {
      messages.push(message);
      if (message?.ava?.type === 'ready-for-options') {
        child.send({ ava: { type: 'options', options: { value: 29 } } });
      } else if (message?.ava?.type === 'worker-finished') {
        child.send({ ava: { type: 'free-worker' } });
      }
    });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      assert.deepStrictEqual(messages.map(({ ava }) => ava?.type), [
        'ready-for-options', 'worker-finished',
      ]);
      process.stdout.write('concurrent IPC selector contract passed');
    });
  `, {
    files: {
      '/node/selector-entry.mjs': `
        import './selector-channel.cjs';
      `,
      '/node/selector-channel.cjs': `
        const events = require('node:events');
        const nodeProcess = require('node:process');
        const select = async (type) => {
          for await (const [message] of events.on(nodeProcess, 'message')) {
            if (message?.ava?.type === type) return message;
          }
        };
        const options = select('options');
        const peerFailed = select('peer-failed');
        const workerFreed = select('free-worker');
        nodeProcess.channel.ref();
        nodeProcess.send({ ava: { type: 'ready-for-options' } });
        (async () => {
          const selected = await options;
          if (selected.ava.options.value !== 29) nodeProcess.exitCode = 1;
          nodeProcess.channel.unref();
          nodeProcess.send({ ava: { type: 'worker-finished' } });
          nodeProcess.channel.ref();
          await workerFreed;
          nodeProcess.channel.unref();
          void peerFailed;
          setImmediate(() => nodeProcess.stdout.write('selectors complete\\n'));
        })();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('concurrent IPC selector contract passed');
});

test('preserves the process IPC control-flow contract across an ESM and CommonJS boundary', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');
    const child = fork('/node/control-flow-entry.mjs', [], { cwd: '/node', silent: true });
    const messages = [];
    child.on('message', (message) => {
      messages.push(message.ava?.type);
      if (message.ava?.type === 'ready-for-options') {
        child.send({ ava: { type: 'options', options: { value: 31 } } }, (error) => {
          assert.equal(error, null);
        });
      } else if (message.ava?.type === 'worker-finished') {
        child.send({ ava: { type: 'free-worker' } });
      }
    });
    child.once('close', (code, signal) => {
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.deepEqual(messages, ['ready-for-options', 'worker-finished']);
      process.stdout.write('process IPC control-flow contract passed');
    });
  `, {
    files: {
      '/node/control-flow-entry.mjs': `
        import './control-flow-channel.cjs';
      `,
      '/node/control-flow-channel.cjs': `
        const events = require('node:events');
        const nodeProcess = require('node:process');
        const controlFlow = (channel) => {
          let immediate = true;
          const backlog = [];
          const deliverNext = (error) => {
            if (error !== null || !channel.connected) return;
            let accepted = true;
            while (accepted && backlog.length) accepted = channel.send(backlog.shift(), deliverNext);
            immediate = accepted && backlog.length === 0;
          };
          return (message) => {
            if (!nodeProcess.connected) return;
            if (immediate) immediate = channel.send(message, deliverNext);
            else backlog.push(message);
          };
        };
        const select = async (type) => {
          for await (const [message] of events.on(nodeProcess, 'message')) {
            if (message?.ava?.type === type) return message;
          }
        };
        const send = controlFlow(nodeProcess);
        const options = select('options');
        const peerFailed = select('peer-failed');
        const workerFreed = select('free-worker');
        nodeProcess.channel.ref();
        send({ ava: { type: 'ready-for-options' } });
        (async () => {
          const selected = await options;
          if (selected.ava.options.value !== 31) nodeProcess.exitCode = 1;
          nodeProcess.channel.unref();
          send({ ava: { type: 'worker-finished' } });
          nodeProcess.channel.ref();
          await workerFreed;
          nodeProcess.channel.unref();
          void peerFailed;
          nodeProcess.stdout.write('control-flow child complete\\n');
          nodeProcess.disconnect();
        })();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('process IPC control-flow contract passed');
});

test('exposes the public process channel to CommonJS dependencies of a package-scoped ESM entry', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');
    const child = fork('/node/node_modules/worker-fixture/entry.js', [], { cwd: '/node', silent: true });
    const messages = [];
    child.on('message', (message) => {
      messages.push(message.kind);
      if (message.kind === 'ready') child.send({ kind: 'options', value: 37 });
      if (message.kind === 'done') child.disconnect();
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('close', (code, signal) => {
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.deepEqual(messages, ['ready', 'done']);
      process.stdout.write('package-scoped ESM process channel contract passed');
    });
  `, {
    files: {
      '/node/node_modules/worker-fixture/package.json': JSON.stringify({ type: 'module' }),
      '/node/node_modules/worker-fixture/entry.js': `
        import './channel.cjs';
      `,
      '/node/node_modules/worker-fixture/channel.cjs': `
        const nodeProcess = require('node:process');
        nodeProcess.channel.ref();
        nodeProcess.send({ kind: 'ready' });
        nodeProcess.once('message', (message) => {
          if (message?.kind !== 'options' || message.value !== 37) nodeProcess.exitCode = 1;
          nodeProcess.channel.unref();
          nodeProcess.send({ kind: 'done' });
          nodeProcess.disconnect();
        });
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('package-scoped ESM process channel contract passed');
});

test('settles a package-scoped ESM child after a CommonJS IPC ref handshake', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');
    const child = fork('/node/node_modules/worker-fixture/entry.js', [], { cwd: '/node', silent: true });
    const messages = [];
    child.on('message', (message) => {
      messages.push(message.kind);
      if (message.kind === 'ready') child.send({ kind: 'options', value: 37 });
      if (message.kind === 'worker-finished') child.send({ kind: 'free-worker' });
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('close', (code, signal) => {
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.deepEqual(messages, ['ready', 'worker-finished', 'done']);
      process.stdout.write('package-scoped ESM IPC ref handshake passed');
    });
  `, {
    files: {
      '/node/node_modules/worker-fixture/package.json': JSON.stringify({ type: 'module' }),
      '/node/node_modules/worker-fixture/entry.js': `
        import './channel.cjs';
      `,
      '/node/node_modules/worker-fixture/channel.cjs': `
        const { on } = require('node:events');
        const nodeProcess = require('node:process');
        (async () => {
          nodeProcess.channel.ref();
          nodeProcess.send({ kind: 'ready' });
          const [[options]] = await Promise.all([
            (async () => { for await (const [message] of on(nodeProcess, 'message')) return [message]; })(),
          ]);
          if (options?.kind !== 'options' || options.value !== 37) nodeProcess.exitCode = 1;
          nodeProcess.channel.ref();
          nodeProcess.send({ kind: 'worker-finished' });
          await new Promise((resolve) => nodeProcess.once('message', resolve));
          nodeProcess.channel.unref();
          nodeProcess.send({ kind: 'done' });
          nodeProcess.disconnect();
        })().catch((error) => {
          nodeProcess.stderr.write(error.stack + '\\n');
          nodeProcess.exitCode = 1;
        });
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('package-scoped ESM IPC ref handshake passed');
});

test('settles top-level-await ESM entries importing async CommonJS IPC channels', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');
    const child = fork('/node/node_modules/worker-fixture/entry.js', [], { cwd: '/node', silent: true });
    const messages = [];
    child.on('message', (message) => {
      messages.push(message.kind);
      if (message.kind === 'ready') child.send({ kind: 'options', value: 41 });
      if (message.kind === 'worker-finished') child.send({ kind: 'free-worker' });
    });
    child.once('error', (error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
    child.once('close', (code, signal) => {
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.deepEqual(messages, ['ready', 'worker-finished', 'done']);
      process.stdout.write('top-level-await ESM IPC channel contract passed');
    });
  `, {
    files: {
      '/node/node_modules/worker-fixture/package.json': JSON.stringify({ type: 'module' }),
      '/node/node_modules/worker-fixture/entry.js': `
        import channel from './channel.cjs';
        const options = await channel.options;
        if (options?.kind !== 'options' || options.value !== 41) process.exitCode = 1;
        channel.send({ kind: 'worker-finished' });
        await channel.workerFreed;
        channel.send({ kind: 'done' });
        channel.disconnect();
      `,
      '/node/node_modules/worker-fixture/channel.cjs': `
        const events = require('node:events');
        const nodeProcess = require('node:process');
        const select = (kind) => (async () => {
          for await (const [message] of events.on(nodeProcess, 'message')) {
            if (message?.kind === kind) return message;
          }
        })();
        const channel = {
          options: select('options'),
          workerFreed: select('free-worker'),
          send: (message) => nodeProcess.send(message),
          disconnect: () => nodeProcess.disconnect(),
        };
        nodeProcess.channel.ref();
        nodeProcess.send({ kind: 'ready' });
        module.exports = channel;
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('top-level-await ESM IPC channel contract passed');
});

test('keeps concurrent package-scoped ESM fork channels independent', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');
    (async () => {
      const children = [0, 1, 2].map((id) => fork(
        '/node/node_modules/worker-fixture/entry.js',
        [String(id)],
        { cwd: '/node', silent: true },
      ));
      const completions = children.map((child, id) => new Promise((resolve, reject) => {
        const messages = [];
        child.on('message', (message) => {
          messages.push(message.kind);
          if (message.kind === 'ready' && message.id === id) child.send({ kind: 'options', id, value: 43 + id });
        });
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, messages }));
      }));
      const results = await Promise.all(completions);
      for (const [id, childResult] of results.entries()) {
        assert.equal(childResult.code, 0);
        assert.equal(childResult.signal, null);
        assert.deepEqual(childResult.messages, ['ready', 'done']);
        children[id].removeAllListeners();
      }
      process.stdout.write('concurrent ESM fork channels contract passed');
    })().catch((error) => {
      process.stderr.write(error.stack + '\\n');
      process.exitCode = 1;
    });
  `, {
    files: {
      '/node/node_modules/worker-fixture/package.json': JSON.stringify({ type: 'module' }),
      '/node/node_modules/worker-fixture/entry.js': `
        import channel from './channel.cjs';
        const options = await channel.options;
        if (options?.kind !== 'options' || options.id !== Number(process.argv[2]) || options.value !== 43 + Number(process.argv[2])) {
          process.exitCode = 1;
        }
        channel.send({ kind: 'done', id: Number(process.argv[2]) });
        channel.disconnect();
      `,
      '/node/node_modules/worker-fixture/channel.cjs': `
        const { on } = require('node:events');
        const nodeProcess = require('node:process');
        const id = Number(nodeProcess.argv[2]);
        const select = async (kind) => {
          for await (const [message] of on(nodeProcess, 'message')) {
            if (message?.kind === kind && message.id === id) return message;
          }
        };
        nodeProcess.channel.ref();
        module.exports = { options: select('options'), send: (message) => nodeProcess.send({ ...message, id }), disconnect: () => nodeProcess.disconnect() };
        nodeProcess.send({ kind: 'ready', id });
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('concurrent ESM fork channels contract passed');
});
