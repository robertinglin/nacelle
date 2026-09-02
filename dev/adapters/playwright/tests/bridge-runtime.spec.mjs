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

  test('reports live generic lifecycle and output activity without candidate text', async ({ harnessPage }) => {
    const start = harnessPage.progressEvents.length;
    const candidateText = 'candidate-output-must-stay-out-of-progress';
    const result = await harnessPage.run(`
      process.stdout.write(${JSON.stringify(candidateText)});
      setTimeout(() => {}, 250);
    `);

    await expectPass(expect, result);
    const progress = harnessPage.progressEvents.slice(start);
    expect(progress.find((event) => event.phase === 'lifecycle' && event.event === 'started')).toMatchObject({
      stage: 'runtime-reset',
      browser: 'chromium',
      timeoutMs: 10_000,
      childActive: false,
      counters: { networkEvents: 0 },
    });
    expect(progress.some((event) => event.phase === 'setup' && event.event === 'mount-complete')).toBe(true);
    const childStart = progress.find((event) => event.phase === 'execution' && event.event === 'child-started');
    expect(childStart).toMatchObject({
      stage: 'child-launch',
      command: 'node',
      childActive: true,
    });
    expect(childStart.entry).toMatch(/\.js$/);
    expect(progress.some((event) => (
      event.phase === 'execution'
      && event.event === 'upstream-test-started'
      && event.stage === 'upstream-test-execution'
      && event.childActive === true
    ))).toBe(true);
    expect(progress.some((event) => (
      event.phase === 'execution'
      && event.event === 'output-activity'
      && event.stream === 'stdout'
      && event.bytes >= candidateText.length
      && event.counters.output.stdoutBytes >= candidateText.length
    ))).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'lifecycle', event: 'completed', code: 0 });
    expect(JSON.stringify(progress)).not.toContain(candidateText);
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

  test('reports browser output as non-TTY while preserving tty window APIs', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const tty = require('node:tty');
        assert.strictEqual(tty.isatty(1), false);
        assert.strictEqual(tty.isatty(process.stdout), false);
        assert.strictEqual(typeof tty.getWindowSize, 'function');
        assert.deepStrictEqual(tty.getWindowSize(), [80, 24]);
        assert.deepStrictEqual(new tty.WriteStream(1).getWindowSize(), [80, 24]);
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

  test('runs npm scripts when Node launches the npm entrypoint', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/node', [
          '/node/node_modules/.bin/npm', 'test',
        ], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (value) => {
            resolve(value);
          });
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'npm entrypoint ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({
          name: 'npm-entrypoint-fixture',
          version: '1.0.0',
          scripts: { test: "node -e \"process.stdout.write('npm entrypoint ran\\\\n')\"" },
        }),
        '/node/node_modules/.bin/node': '#!/usr/bin/env node\\n',
        '/node/node_modules/.bin/npm': '#!/usr/bin/env node\\n',
      },
    });

    await expectPass(expect, result);
  });

  test('executes shebang scripts from the virtual filesystem', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/tool', ['argument'], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'tool ran argument\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': "#!/usr/bin/env node\nprocess.stdout.write('tool ran ' + process.argv[2] + '\\n');\n",
      },
    });

    await expectPass(expect, result);
  });

  test('waits for shebang child processes and propagates their output and status', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/tool', [], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 7);
        assert.strictEqual(output, 'tool start\\nnested tool ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "process.stdout.write('tool start\\n');",
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['/node/tool-child.js'], { stdio: 'inherit' });",
          "child.once('error', (error) => { process.stderr.write('tool error ' + error.message + '\\n'); process.exit(2); });",
          "child.once('exit', (code, signal) => { process.on('exit', () => { if (signal) process.kill(process.pid, signal); else process.exit(code); }); });",
        ].join('\n'),
        '/node/tool-child.js': "process.stdout.write('nested tool ran\\n'); process.exitCode = 7;",
      },
    });

    await expectPass(expect, result);
  });

  test('forwards output and status through npm scripts that launch shebang children', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/node', [
          '/node/node_modules/.bin/npm', 'test',
        ], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 7);
        assert.strictEqual(output, 'npm tool start\\nnpm nested tool ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({
          name: 'npm-shebang-fixture',
          version: '1.0.0',
          scripts: { test: 'tool' },
        }),
        '/node/node_modules/.bin/node': '#!/usr/bin/env node\\n',
        '/node/node_modules/.bin/npm': '#!/usr/bin/env node\\n',
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "process.stdout.write('npm tool start\\n');",
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['/node/npm-tool-child.js'], { stdio: 'inherit' });",
          "child.once('exit', (code, signal) => { process.on('exit', () => { if (signal) process.kill(process.pid, signal); else process.exit(code); }); });",
        ].join('\n'),
        '/node/npm-tool-child.js': "process.stdout.write('npm nested tool ran\\n'); process.exitCode = 7;",
      },
    });

    await expectPass(expect, result);
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

  test('resolves relative paths from each virtual process cwd', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn(process.execPath, ['/node/path-cwd-child.js'], {
          cwd: '/node/workspace',
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, '/node/workspace/test.js\\n/node\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/workspace/.keep': '',
        '/node/path-cwd-child.js': [
          "const path = require('node:path');",
          "process.stdout.write(path.resolve('test.js') + '\\n');",
          "process.stdout.write(path.dirname(path.resolve('.')) + '\\n');",
        ].join('\n'),
      },
    });

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
