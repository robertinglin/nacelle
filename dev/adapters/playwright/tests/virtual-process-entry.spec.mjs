import { expect } from 'playwright/test';
import { browserRuntimeURL, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('runs VFS .mjs child entries as native ESM in both process modes', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const results = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const capabilities = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 2 },
      ipc: { enabled: false },
      signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
      output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
      envVars: { allowed: [] },
    };
    const entry = '/node/child/main.mjs';
    const files = {
      [entry]: `
        import { value } from './dependency.mjs';
        await Promise.resolve();
        process.stdout.write(value);
      `,
      '/node/child/dependency.mjs': 'export const value = "esm-child";',
    };

    const run = async (forceFallback) => {
      const stdout = [];
      const stderr = [];
      const collect = (target) => (value) => {
        if (typeof value === 'string') target.push(value);
        else if (value instanceof ArrayBuffer) target.push(new TextDecoder().decode(value));
        else if (ArrayBuffer.isView(value)) target.push(new TextDecoder().decode(value));
        else target.push(String(value));
      };
      const child = createVirtualProcess({
        forceFallback,
        entry,
        argv: ['/browser/node', entry],
        cwd: '/node',
        vfs: { capabilities, files },
        stdout: collect(stdout),
        stderr: collect(stderr),
      });
      const terminal = await child.wait();
      return { code: terminal.code, stdout: stdout.join(''), stderr: stderr.join('') };
    };

    return { fallback: await run(true), worker: await run(false) };
  });

  expect(results).toEqual({
    fallback: { code: 0, stdout: 'esm-child', stderr: '' },
    worker: { code: 0, stdout: 'esm-child', stderr: '' },
  });
});

test('maps asynchronous fs reads from fd 0 to a worker child stdin pipe', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const capabilities = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 1 },
      ipc: { enabled: false },
      signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
      output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
      envVars: { allowed: [] },
    };
    const output = [];
    const child = createVirtualProcess({
      forceFallback: false,
      entry: '/node/read-stdin.js',
      argv: ['/browser/node', '/node/read-stdin.js'],
      cwd: '/node',
      vfs: {
        capabilities,
        files: {
          '/node/read-stdin.js': `
            const fs = require('node:fs');
            const buffer = Buffer.alloc(5);
            fs.read(0, buffer, 0, buffer.length, null, (error, bytesRead) => {
              process.stdout.write(JSON.stringify({
                code: error?.code || null,
                bytesRead,
                value: buffer.toString(),
              }));
              process.exit(error ? 1 : 0);
            });
          `,
        },
      },
      stdout: (value) => output.push(typeof value === 'string' ? value : new TextDecoder().decode(value)),
    });
    child.send({ __bnhWorkerStdin: true, value: new TextEncoder().encode('hello') });
    child.send({ __bnhWorkerStdinEnd: true });
    const terminal = await child.wait();
    return { code: terminal.code, stdout: output.join('') };
  });

  expect(result).toEqual({ code: 0, stdout: '{"code":null,"bytesRead":5,"value":"hello"}' });
});

test('forwards async child_process stdin to an ESM child fd 0 read', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const capabilities = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 2 },
      ipc: { enabled: false },
      signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
      output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
      envVars: { allowed: [] },
    };
    const output = [];
    const child = createVirtualProcess({
      forceFallback: false,
      entry: '/node/parent.js',
      argv: ['/browser/node', '/node/parent.js'],
      cwd: '/node',
      vfs: {
        capabilities,
        files: {
          '/node/parent.js': `
            const { spawn } = require('node:child_process');
            const child = spawn(process.execPath, ['/node/read-stdin.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', value => { stdout += value; });
            child.stderr.on('data', value => { stderr += value; });
            child.once('close', code => {
              process.stdout.write(JSON.stringify({ code, stdout, stderr }));
            });
            child.stdin.write('hello');
            child.stdin.end();
          `,
          '/node/read-stdin.mjs': `
            import fs from 'node:fs';
            const buffer = Buffer.alloc(5);
            fs.read(0, buffer, 0, buffer.length, null, (error, bytesRead) => {
              process.stdout.write(JSON.stringify({ code: error?.code || null, bytesRead, value: buffer.toString() }));
            });
          `,
        },
      },
      stdout: value => output.push(String(value)),
      stderr: value => output.push('stderr:' + String(value)),
    });
    const terminal = await child.wait();
    return { code: terminal.code, output: output.join('') };
  });
  expect(result).toEqual({ code: 0, output: '{"code":0,"stdout":"{\\"code\\":null,\\"bytesRead\\":5,\\"value\\":\\"hello\\"}","stderr":""}' });
});

test('preserves binary stdout from an ESM child process pipe', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['/node/emit-binary.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', value => chunks.push([...new Uint8Array(value)]));
    child.stderr.on('data', value => { stderr += value; });
    child.once('close', code => {
      process.stdout.write(JSON.stringify({ code, bytes: chunks.flat(), stderr }));
    });
  `, {
    files: {
      '/node/emit-binary.mjs': `
        process.stdout.write(new Uint8Array([0, 255, 1, 2, 128]));
      `,
    },
  });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('{"code":0,"bytes":[0,255,1,2,128],"stderr":""}');
});

test('emits CommonJS child close after asynchronous stdout end', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['/node/child.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let ended = false;
    child.stdout.on('data', value => { stdout += value; });
    child.stdout.on('end', () => { ended = true; });
    child.stderr.on('data', () => {});
    child.once('close', code => {
      process.stdout.write(JSON.stringify({ code, stdout, ended }));
    });
  `, {
    files: {
      '/node/child.js': `setTimeout(() => process.stdout.write('child-output'), 0);`,
    },
  });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('{"code":0,"stdout":"child-output","ended":true}');
});

test('keeps concurrent virtual fs opens and closes timer-fair', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const fs = require('node:fs');
    const n = 1024;
    let opens = 0;
    let callbacks = 0;
    let closed = 0;
    let errors = 0;
    let going = true;
    const fds = [];
    for (let i = 0; i < n; i += 1) go();
    function go() {
      opens += 1;
      fs.open('/node/file.txt', 'r', (error, fd) => {
        callbacks += 1;
        if (error) { errors += 1; return; }
        fds.push(fd);
        if (going) go();
      });
    }
    const finish = () => {
      if (callbacks !== opens) {
        setTimeout(finish, 0);
        return;
      }
      const opened = fds.splice(0);
      let remaining = opened.length;
      if (!remaining) done();
      for (const fd of opened) {
        fs.close(fd, error => {
          if (!error) closed += 1;
          remaining -= 1;
          if (remaining === 0) done();
        });
      }
    };
    const done = () => {
      process.stdout.write(JSON.stringify({ opens, callbacks, errors, closed, fds: fds.length }));
      process.exit(errors || closed !== opens ? 1 : 0);
    };
    setTimeout(() => { going = false; finish(); }, 100);
  `, {
    files: { '/node/file.txt': 'file' },
    timeoutMs: 5_000,
  });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.stderr).toBe('');
  expect(result.stdout).toMatch(/^\{"opens":\d+,"callbacks":\d+,"errors":0,"closed":\d+,"fds":0\}$/);
});

test('completes a high-volume virtual fs write/read cycle', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = '/node/citgm/tmp/diagnostic/graceful-fs';
    const n = 4097;
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(path.join(directory, 'files'), { recursive: true });
    process.chdir(directory);
    for (let i = 0; i < n; i += 1) fs.writeFile(path.join('files', 'file-' + i), 'content', 'ascii', () => {});
    let remaining = n;
    let errors = 0;
    let wrong = 0;
    for (let i = 0; i < n; i += 1) {
      fs.readFile(path.join('files', 'file-' + i), 'ascii', (error, value) => {
        if (error) errors += 1;
        else if (value !== 'content') wrong += 1;
        remaining -= 1;
        if (remaining === 0) {
          process.stdout.write(JSON.stringify({ errors, wrong }));
          process.exit(errors || wrong ? 1 : 0);
        }
      });
    }
  `, { timeoutMs: 5_000 });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('{"errors":0,"wrong":0}');
});

test('does not keep the parent alive for an unrefed ESM child', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['/node/long-lived.mjs'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    process.stdout.write('unrefed ESM child released');
  `, {
    files: {
      '/node/long-lived.mjs': 'setTimeout(() => {}, 1000);',
    },
    timeoutMs: 500,
  });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('unrefed ESM child released');
});

test('preserves fork entry identity with Node execution arguments', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { fork } = require('node:child_process');
    const child = fork('/node/fork-identity.mjs', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      execArgv: ['--conditions', 'development', '--experimental-import-meta-resolve'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('close', code => {
      process.stdout.write(JSON.stringify({ code, stdout, stderr }));
    });
  `, {
    files: {
      '/node/fork-identity.mjs': `
        import process from 'node:process';
        process.stdout.write(JSON.stringify({ execPath: process.execPath, argv: process.argv, execArgv: process.execArgv }));
      `,
    },
  });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    stdout: JSON.stringify({
      execPath: '/browser/node',
      argv: ['/browser/node', '/node/fork-identity.mjs'],
      execArgv: ['--conditions', 'development', '--experimental-import-meta-resolve'],
    }),
    stderr: '',
  });
});

test('delivers child output before a nonzero terminal frame', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const capabilities = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 1 },
      ipc: { enabled: false },
      signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
      output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
      envVars: { allowed: [] },
    };
    const stdout = [];
    const stderr = [];
    const decode = (value) => typeof value === 'string' ? value : new TextDecoder().decode(value);
    const child = createVirtualProcess({
      forceFallback: false,
      entry: '/node/child.js',
      argv: ['/browser/node', '/node/child.js'],
      cwd: '/node',
      vfs: {
        capabilities,
        files: {
          '/node/child.js': "process.stdout.write('child stdout\\n'); process.stderr.write('child stderr\\n'); process.exit(7);",
        },
      },
      stdout: (value) => stdout.push(decode(value)),
      stderr: (value) => stderr.push(decode(value)),
    });
    const terminal = await child.wait();
    return { code: terminal.code, stdout: stdout.join(''), stderr: stderr.join('') };
  });

  expect(result).toEqual({ code: 7, stdout: 'child stdout\n', stderr: 'child stderr\n' });
});

test('forwards POSIX signals beyond the default termination trio', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const signals = ['SIGHUP', 'SIGUSR1', 'SIGUSR2'];
    const capabilities = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 1 },
      ipc: { enabled: false },
      signals: { allowed: [
        'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS',
        'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM',
        'SIGTERM', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
        'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO',
        'SIGPWR', 'SIGSYS',
      ] },
      output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
      envVars: { allowed: [] },
    };
    const run = async (forceFallback) => {
      const results = [];
      for (const signal of signals) {
        const output = [];
        let resolveReady;
        const ready = new Promise((resolve) => { resolveReady = resolve; });
        const child = createVirtualProcess({
          forceFallback,
          entry: '/node/signals.js',
          argv: ['/browser/node', '/node/signals.js'],
          cwd: '/node',
          signalGrants: capabilities.signals.allowed,
          vfs: {
            capabilities,
            files: {
              '/node/signals.js': `
                process.on(${JSON.stringify(signal)}, () => {
                  process.stdout.write(${JSON.stringify(`${signal}\n`)});
                  process.exit(0);
                });
                process.stdout.write('ready\\n');
                setInterval(() => {}, 1000);
              `,
            },
          },
          stdout: (value) => {
            const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
            output.push(text);
            if (text.includes('ready')) resolveReady();
          },
        });
        await ready;
        child.kill(signal);
        const terminal = await child.wait();
        results.push({ code: terminal.code, stdout: output.join('') });
      }
      return results;
    };
    return { fallback: await run(true), worker: await run(false) };
  });

  expect(result).toEqual({
    fallback: [
      { code: 0, stdout: 'ready\nSIGHUP\n' },
      { code: 0, stdout: 'ready\nSIGUSR1\n' },
      { code: 0, stdout: 'ready\nSIGUSR2\n' },
    ],
    worker: [
      { code: 0, stdout: 'ready\nSIGHUP\n' },
      { code: 0, stdout: 'ready\nSIGUSR1\n' },
      { code: 0, stdout: 'ready\nSIGUSR2\n' },
    ],
  });
});

test('cleans up an ESM worker after an unhandled signal', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { fork } = require('node:child_process');
    const child = fork('/node/unhandled-signal.mjs', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
           child.once('spawn', () => setTimeout(() => child.kill('SIGTERM'), 100));
    child.once('close', (code, signal) => {
      process.stdout.write(JSON.stringify({ code, signal, stdout, stderr }));
    });
  `, {
    files: {
             '/node/unhandled-signal.mjs': `
               import { setTimeout } from 'node:timers';
               import('./unhandled-signal-child.mjs');
               setTimeout(() => process.stdout.write('still-running'), 10_000);
             `,
             '/node/unhandled-signal-child.mjs': `
               export const loaded = true;
             `,
    },
    timeoutMs: 5_000,
  });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    code: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
  });
});

test('waits for spawned children to finish after a handled signal', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const capabilities = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 4 },
      ipc: { enabled: false },
      signals: { allowed: [
        'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS',
        'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM',
        'SIGTERM', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
        'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO',
        'SIGPWR', 'SIGSYS',
      ] },
      output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
      envVars: { allowed: [] },
    };
    const output = [];
    const child = createVirtualProcess({
      entry: '/node/parent.js',
      argv: ['/browser/node', '/node/parent.js'],
      cwd: '/node',
      signalGrants: capabilities.signals.allowed,
      vfs: {
        capabilities,
        files: {
          '/node/package.json': '{"type":"module"}',
          '/node/parent.js': `
            import { spawn } from 'node:child_process';
            const child = spawn(process.execPath, ['/node/signal-child.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
            let childOutput = '';
            let signalSent = false;
            const events = [];
            const timeout = setTimeout(() => {
              process.stdout.write(JSON.stringify({ timeout: true, childState: child.state, exitCode: child.exitCode, signalCode: child.signalCode, handleState: child._handle?.state, handleTerminal: child._handle?.terminal, handleRuntimeState: child._handle?.runtimeState, childOutput, events }));
              process.exit(1);
            }, 2000);
            child.stdout.on('data', (value) => {
              childOutput += value.toString();
              if (!signalSent && childOutput.includes('ready')) {
                signalSent = true;
                child.kill('SIGHUP');
              }
            });
            child.on('error', (error) => events.push({ type: 'error', code: error.code || null, message: error.message }));
            child.on('exit', (code, signal) => events.push({ type: 'exit', code, signal }));
            child.on('close', (code, signal) => {
              clearTimeout(timeout);
              process.stdout.write(JSON.stringify({ code, signal, childOutput }));
              process.exit(0);
            });
          `,
          '/node/signal-child.js': `
            process.on('SIGHUP', () => {
              process.stdout.write('SIGHUP\\n');
              process.exit(0);
            });
            process.stdout.write('ready\\n');
            setInterval(() => {}, 1000);
          `,
        },
      },
      stdout: (value) => output.push(typeof value === 'string' ? value : new TextDecoder().decode(value)),
    });
    const terminal = await child.wait();
    return { code: terminal.code, stdout: output.join('') };
  });

  expect(result).toEqual({
    code: 0,
    stdout: '{"code":0,"signal":null,"childOutput":"ready\\nSIGHUP\\n"}',
  });
});

test('returns the exit code from asynchronous ESM descendants of spawnSync', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const capabilities = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 4 },
      ipc: { enabled: false },
      signals: { allowed: ['SIGINT', 'SIGTERM', 'SIGKILL'] },
      output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
      envVars: { allowed: [] },
    };
    const output = [];
    const child = createVirtualProcess({
      entry: '/node/parent.js',
      argv: ['/browser/node', '/node/parent.js'],
      cwd: '/node',
      vfs: {
        capabilities,
        files: {
          '/node/package.json': '{"type":"module"}',
          '/node/parent.js': `
            import { spawn } from 'node:child_process';
            const child = spawn(process.execPath, ['/node/fail.js'], { stdio: 'inherit' });
            child.on('close', (code) => process.exit(code));
          `,
          '/node/fail.js': 'process.exit(42);',
        },
      },
      stdout: (value) => output.push(typeof value === 'string' ? value : new TextDecoder().decode(value)),
    });
    const terminal = await child.wait();
    return { code: terminal.code, stdout: output.join('') };
  });

  expect(result).toEqual({ code: 42, stdout: '' });
});

test('propagates a nested asynchronous executable exit code through spawnSync', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const capabilities = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 6 },
      ipc: { enabled: false },
      signals: { allowed: ['SIGINT', 'SIGTERM', 'SIGKILL'] },
      output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
      envVars: { allowed: [] },
    };
    const createWorkerBrokerPort = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        const request = event.data;
        if (request?.type !== 'create' || !request.port) return;
        const worker = new Worker(request.source, request.options || {});
        const clientPort = request.port;
        let initialized = false;
        clientPort.onmessage = (clientEvent) => {
          const message = clientEvent.data;
          if (message?.type === 'postMessage') {
            const transfers = [...(message.transfers || [])];
            let value = message.value;
            if (!initialized) {
              initialized = true;
              const childBrokerPort = createWorkerBrokerPort();
              value = { ...value, workerBrokerPort: childBrokerPort };
              transfers.push(childBrokerPort);
            }
            worker.postMessage(value, transfers);
          } else if (message?.type === 'terminate') {
            worker.terminate();
            clientPort.close();
          }
        };
        clientPort.start?.();
        worker.addEventListener('message', (workerEvent) => {
          clientPort.postMessage({ type: 'message', value: workerEvent.data });
        });
        worker.addEventListener('error', (workerEvent) => {
          clientPort.postMessage({ type: 'error', error: { name: workerEvent?.error?.name || 'Error', message: String(workerEvent?.error?.message || workerEvent?.message || 'worker failed') } });
        });
      };
      channel.port1.start?.();
      return channel.port2;
    };
    const output = [];
    const child = createVirtualProcess({
      workerBrokerPort: createWorkerBrokerPort(),
      entry: '/node/test.js',
      argv: ['/browser/node', '/node/test.js'],
      cwd: '/node',
      vfs: {
        capabilities,
        esmNested: true,
        files: {
          '/node/package.json': '{"type":"module"}',
          '/node/test.js': `
            import { spawnSync } from 'node:child_process';
            const result = spawnSync('/node/pm', ['exit-override', 'fail']);
            process.stdout.write(JSON.stringify({ status: result.status, error: result.error?.code || null }));
          `,
          '/node/pm': `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const result = spawnSync('/node/pm-fail', []);
process.exit(result.status ?? 1);
`,
          '/node/pm-fail': '#!/usr/bin/env node\nprocess.exit(42);',
        },
      },
      stdout: (value) => output.push(typeof value === 'string' ? value : new TextDecoder().decode(value)),
    });
    const terminal = await child.wait();
    return { code: terminal.code, stdout: output.join('') };
  });

  expect(result).toEqual({ code: 0, stdout: '{"status":42,"error":null}' });
});

test('reports an unhandled self-signal as a nonzero child termination', async ({ page }) => {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createVirtualProcess } = await import('/runtime/virtual-process.js');
    const child = createVirtualProcess({
      entry: '/node/terminate.js',
      argv: ['/browser/node', '/node/terminate.js'],
      cwd: '/node',
      vfs: {
        capabilities: {
          vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
          workers: { entryModules: ['*'], maxChildren: 1 },
          ipc: { enabled: false },
          signals: { allowed: ['SIGINT', 'SIGTERM', 'SIGKILL'] },
          output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
          envVars: { allowed: [] },
        },
        files: { '/node/terminate.js': "process.kill(process.pid, 'SIGINT');" },
      },
    });
    const terminal = await child.wait();
    return { code: terminal.code, signal: terminal.signal, state: child.state };
  });

  expect(result).toEqual({ code: 1, signal: null, state: 'exited' });
});
