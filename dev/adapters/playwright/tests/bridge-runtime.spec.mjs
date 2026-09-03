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

  test('does not keep a process alive for an unresolved Promise continuation', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      new Promise(() => {}).then(() => process.stdout.write('unreachable\\n'));
      process.stdout.write('done\\n');
    `, { timeoutMs: 250 });

    expect(result.timedOut, JSON.stringify(result)).toBe(false);
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toBe(['done', ''].join('\n'));
  });

  test('does not keep a nested virtual child alive for an unresolved Promise', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['/node/unresolved-child.js']);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.once('close', (code) => {
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'done\\n');
      });
    `, {
      timeoutMs: 500,
      files: {
        '/node/unresolved-child.js': [
          "new Promise(() => {}).then(() => process.stdout.write('unreachable\\n'));",
          "process.stdout.write('done\\n');",
        ].join('\n'),
      },
    });

    expect(result.timedOut, JSON.stringify(result)).toBe(false);
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
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

  test('keeps CommonJS async module imports in the child process context', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { pathToFileURL } = require('node:url');
      (async () => {
        process.stdout.write('before\\n');
        const loaded = await import(pathToFileURL('/node/loaded.js'));
        assert.strictEqual(loaded.default, 'loaded');
        process.stdout.write('after\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: { '/node/loaded.js': "module.exports = 'loaded';\n" },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('before');
    expect(result.stdout).toContain('after');
  });

  test('waits for async dynamic imports in shebang children', async ({ harnessPage }) => {
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
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'child-before\\nloaded\\nchild-after\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "const { pathToFileURL } = require('node:url');",
          '(async () => {',
          "  process.stdout.write('child-before\\n');",
          "  const loaded = await import(pathToFileURL('/node/loaded.js'));",
          "  process.stdout.write(loaded.default + '\\n');",
          "  process.stdout.write('child-after\\n');",
          '})().catch((error) => { console.error(error); process.exitCode = 1; });',
        ].join('\n'),
        '/node/loaded.js': "module.exports = 'loaded';\n",
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

  test('executes ESM shebang scripts without forcing CommonJS evaluation', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/esm-tool.mjs', ['argument'], { cwd: '/node' });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0, errorOutput);
        assert.strictEqual(output, 'esm tool argument\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/package.json': JSON.stringify({ type: 'module' }),
        '/node/node_modules/.bin/esm-tool.mjs': [
          '#!/usr/bin/env node',
          "if (typeof import.meta.url !== 'string') process.exitCode = 1;",
          "process.stdout.write('esm tool ' + process.argv[2] + '\\n');",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('executes extensionless ESM shebang bins from their package scope', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/esm-tool', ['argument'], { cwd: '/node' });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0, errorOutput);
        assert.strictEqual(output, 'extensionless esm argument\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({ type: 'module' }),
        '/node/node_modules/.bin/esm-tool': [
          '#!/usr/bin/env node',
          "if (typeof import.meta.url !== 'string') process.exitCode = 1;",
          "process.stdout.write('extensionless esm ' + process.argv[2] + '\\n');",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('preserves option-looking shebang script arguments after the script path', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const { spawn } = require('node:child_process');
      const child = spawn('/node/node_modules/.bin/tool', [
        '--require', 'test/support/env', '--reporter', 'spec', 'test/',
      ], { cwd: '/node' });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.once('close', (code) => {
        process.stdout.write(JSON.stringify({ code, argv: JSON.parse(output) }));
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      },
    });

    await expectPass(expect, result);
    expect(JSON.parse(result.stdout)).toEqual({
      code: 0,
      argv: ['--require', 'test/support/env', '--reporter', 'spec', 'test/'],
    });
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
          "child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code); });",
        ].join('\n'),
        '/node/npm-tool-child.js': "process.stdout.write('npm nested tool ran\\n'); process.exitCode = 7;",
      },
    });

    await expectPass(expect, result);
  });

  test('waits for asynchronous inherited-stdio children before closing', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const writes = [];
        const originalWrite = process.stdout.write;
        process.stdout.write = (chunk, ...args) => {
          writes.push(String(chunk));
          return originalWrite.call(process.stdout, chunk, ...args);
        };
        const child = spawn('/node/node_modules/.bin/tool', [], { stdio: 'inherit' });
        try {
          const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
          });
          assert.strictEqual(code, 0);
          assert.ok(writes.includes('async inherited child\\n'));
        } finally {
          process.stdout.write = originalWrite;
        }
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "setTimeout(() => process.stdout.write('async inherited child\\n'), 1);",
        ].join('\\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('runs required preloads in inherited execPath children before forwarding exit', async ({ harnessPage }) => {
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
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'preloaded\\ninner child\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['--require', '/node/preload.js', '/node/inner.js'], { stdio: 'inherit' });",
          "child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code); });",
        ].join('\\n'),
        '/node/preload.js': "process.stdout.write('preloaded\\n');",
        '/node/inner.js': "const assert = require('node:assert'); assert.strictEqual(require.main, module); setTimeout(() => process.stdout.write('inner child\\n'), 1);",
      },
    });

    await expectPass(expect, result);
  });

  test('executes direct ESM Node-file children through the ESM lifecycle', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['/node/direct-child.mjs']);
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.once('close', (code, signal) => {
        assert.strictEqual(code, 0);
        assert.strictEqual(signal, null);
        assert.strictEqual(stdout, 'direct esm child\\n');
        process.stdout.write('direct ESM child completed');
      });
    `, {
      files: {
        '/node/direct-child.mjs': `
          import assert from 'node:assert/strict';
          assert.strictEqual(typeof import.meta.url, 'string');
          process.stdout.write('direct esm child\\n');
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('direct ESM child completed');
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

  test('preserves empty VFS directories in worker snapshots', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const fs = require('node:fs');
      const { Worker } = require('node:worker_threads');
      fs.mkdirSync('/node/empty-worker-directory');
      const worker = new Worker('/node/empty-directory-worker.js');
      worker.once('message', (value) => {
        assert.deepStrictEqual(value, { exists: true, entries: [] });
        process.stdout.write('empty directory snapshot completed');
      });
    `, {
      files: {
        '/node/empty-directory-worker.js': `
          const { parentPort } = require('node:worker_threads');
          const fs = require('node:fs');
          parentPort.postMessage({
            exists: fs.existsSync('/node/empty-worker-directory'),
            entries: fs.readdirSync('/node/empty-worker-directory'),
          });
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('empty directory snapshot completed');
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

  test('resolves relative filesystem paths from each virtual process cwd', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn(process.execPath, ['/node/fs-cwd-child.js'], {
          cwd: '/node/workspace',
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(JSON.parse(output), {
          cwd: '/node/workspace',
          exists: true,
          entries: ['fixture.js'],
        });
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/workspace/test/fixture.js': '',
        '/node/fs-cwd-child.js': [
          "const fs = require('node:fs');",
          "process.stdout.write(JSON.stringify({ cwd: process.cwd(), exists: fs.existsSync('test'), entries: fs.readdirSync('test') }));",
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
