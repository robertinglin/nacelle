import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime bridge and core primitives', () => {
  test('resets, mounts, spawns, and captures stdout and stderr in the browser', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      assert.strictEqual(typeof process.stdout.write, 'function');
      assert.strictEqual(typeof process.stderr.write, 'function');
      process.stdout.write('browser stdout\\n');
      process.stderr.write('browser stderr\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('browser stdout');
    expect(result.stderr).toContain('browser stderr');
  });

  test('keeps Buffer arrays and assert predicates Node-compatible', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        assert.deepStrictEqual([...Buffer.from([0, 127, 255])], [0, 127, 255]);
        assert.throws(
          () => { throw new TypeError('expected failure'); },
          (error) => error instanceof TypeError && error.message === 'expected failure',
        );
      })();
    `);

    await expectPass(expect, result);
  });

  test('loads test-assert.js-style CommonJS modules that declare process locally', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const fs = require('node:fs');
        fs.mkdirSync('/node/test/common', { recursive: true });
        fs.mkdirSync('/node/test/parallel', { recursive: true });
        fs.writeFileSync('/node/test/common/index.js', [
          "'use strict';",
          'const process = globalThis.process;',
          'module.exports = { version: process.version };',
        ].join('\\n'));
        fs.writeFileSync('/node/test/parallel/test-assert.js', [
          "'use strict';",
          "const common = require('../common');",
          "const assert = require('node:assert');",
          'assert.strictEqual(common.version, process.version);',
          'module.exports = true;',
        ].join('\\n'));

        assert.strictEqual(require('/node/test/parallel/test-assert.js'), true);
      })();
    `);

    await expectPass(expect, result);
  });

  test('propagates process.exitCode assignments to the bridge result', async ({ harnessPage }) => {
    const result = await harnessPage.run(`process.exitCode = 17;`);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(17);
  });

  test('runs the upstream worker abort-on-uncaught-exception case', async ({ harnessPage }) => {
    const entryPath = '/node/test/abort/test-worker-abort-uncaught-exception.js';
    const result = await harnessPage.run(`
      'use strict';
      const common = require('../common');
      const assert = require('assert');
      const { spawn } = require('child_process');
      const { Worker } = require('worker_threads');

      if (process.argv[2] === 'child') {
        new Worker('throw new Error("foo");', { eval: true });
        return;
      }

      const child = spawn(process.execPath, [
        '--abort-on-uncaught-exception', __filename, 'child',
      ]);
      child.on('exit', common.mustCall((code, sig) => {
        if (common.isWindows) {
          assert.strictEqual(code, 0x80000003);
        } else {
          assert(['SIGABRT', 'SIGTRAP', 'SIGILL'].includes(sig),
            \`Unexpected signal \${sig}\`);
        }
      }));
    `, {
      entryPath,
      files: {
        '/node/test/common/index.js': `
          module.exports = {
            isWindows: false,
            mustCall(callback) { return (...args) => callback(...args); },
          };
        `,
      },
    });

    await expectPass(expect, result);
  });

  test('uses the mounted virtual filesystem rather than the host filesystem', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const root = path.join('.bnh-playwright-vfs', String(process.pid));
      const file = path.join(root, 'nested', 'value.txt');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'browser-vfs', 'utf8');
      assert.strictEqual(await fs.readFile(file, 'utf8'), 'browser-vfs');
      assert.strictEqual((await fs.stat(file)).isFile(), true);
      await fs.rm(root, { recursive: true, force: true });
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('uses browser fetch and transport objects without a host socket', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const request = new Request('data:text/plain,browser-fetch', {
        headers: { 'X-BNH-Test': 'present' },
      });
      const response = await fetch(request);
      assert.strictEqual(response.ok, true);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(await response.text(), 'browser-fetch');
      assert.strictEqual(request.headers.get('x-bnh-test'), 'present');
      assert.strictEqual(typeof WebSocket, 'function');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('kills a timed-out child through the bridge lifecycle', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const timer = setInterval(() => {}, 10);
      process.stdout.write('before-timeout');
      void timer;
    `, { timeoutMs: 50 });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
  });

  test('settles cluster workers before the primary exit event returns', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const cluster = require('node:cluster');
      const keepAlive = setInterval(() => {}, 1000);

      if (cluster.isWorker) {
        return;
      }

      (async () => {
        const worker = cluster.fork();
        await new Promise((resolve) => worker.once('online', resolve));
        process.once('exit', () => {
          assert.strictEqual(worker.isDead(), true);
          assert.strictEqual(worker.process.connected, false);
          assert.strictEqual(worker.process.state, 'failed');
          assert.notStrictEqual(worker.process.terminal, null);
        });
        clearInterval(keepAlive);
        process.exit(0);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('awaits cancelled execution cleanup before child.kill returns', async ({ page }) => {
    await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const { createRuntime } = await import('/runtime.js');
      const runtime = createRuntime({ globalObject: globalThis });
      const originalProcess = globalThis.process;
      await runtime.mount({
        '/node/teardown-race.js': new TextEncoder().encode('setTimeout(() => {}, 50);'),
      });
      const child = await runtime.spawn(['node', '/node/teardown-race.js']);
      const kill = child.kill();
      const exit = await Promise.race([
        child.exit.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 10)),
      ]);
      await kill;
      return { exit, globalsRestored: globalThis.process === originalProcess };
    });

    expect(result.exit).toBe('resolved');
    expect(result.globalsRestored).toBe(true);
  });
});
