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
