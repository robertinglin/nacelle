import { expect } from 'playwright/test';
import { browserRuntimeURL, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

async function openRuntime(page) {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
}

test.describe('browser-native worker process boundary', () => {
  test('shares bytes in both raw and descriptor-shaped worker VFS entries', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { prepareWorkerVfs } = await import('/runtime/process.js');
      const bytes = new Uint8Array([1, 2, 3]);
      const prepared = prepareWorkerVfs({
        files: {
          '/node/raw.js': bytes,
          '/node/descriptor.js': { data: bytes, mode: 0o755 },
        },
        artifacts: [{ path: '/node/raw.js', bytes }],
      }, {
        crossOriginIsolated: true,
        SharedArrayBuffer,
      });
      return {
        raw: prepared.files['/node/raw.js'].buffer instanceof SharedArrayBuffer,
        descriptor: prepared.files['/node/descriptor.js'].data.buffer instanceof SharedArrayBuffer,
        artifact: prepared.artifacts[0].bytes.buffer instanceof SharedArrayBuffer,
        sourceUnchanged: bytes.buffer instanceof ArrayBuffer,
      };
    });

    expect(result).toEqual({ raw: true, descriptor: true, artifact: true, sourceUnchanged: true });
  });

  test('terminates a worker after ordered natural completion', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createBrowserProcess } = await import('/runtime/process.js');
      let terminationCount = 0;
      let cleanupResolve;
      const cleanup = new Promise((resolve) => { cleanupResolve = resolve; });
      const fakeWorker = {
        listeners: new Map(),
        on(name, listener) {
          const set = this.listeners.get(name) || [];
          set.push(listener);
          this.listeners.set(name, set);
          return this;
        },
        postMessage(message) {
          const frame = {
            channel: 'bnh-process-control',
            key: message.key,
            runId: message.runId,
            childId: message.childId,
          };
          queueMicrotask(() => message.controlPort.postMessage({ ...frame, type: 'ready' }));
          queueMicrotask(() => message.controlPort.postMessage({
            ...frame,
            type: 'terminal',
            status: 'exited',
            kind: 'natural',
            code: 0,
            signal: null,
            forced: false,
            lastUserSequence: 0,
          }));
          message.controlPort.onmessage = (event) => {
            if (event.data?.type !== 'cleanup') return;
            message.controlPort.postMessage({ ...frame, type: 'worker-closed' });
            cleanupResolve();
          };
          message.controlPort.start?.();
        },
        terminate() {
          terminationCount += 1;
          return true;
        },
      };
      const child = createBrowserProcess({
        scope: globalThis,
        workerFactory: () => fakeWorker,
        run: () => {},
        argv: ['node', 'entry.js'],
      });
      const terminal = await child.wait();
      await cleanup;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { terminal, terminationCount };
    });

    expect(result.terminal).toMatchObject({ status: 'exited', kind: 'natural', code: 0 });
    expect(result.terminationCount).toBe(1);
  });

  test('keeps worker IPC/output FIFO and emits one terminal lifecycle', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createBrowserProcess } = await import('/runtime/process.js');
      const output = { stdout: [], stderr: [] };
      const messages = [];
      const order = [];
      const once = (emitter, name) => new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));
      const child = createBrowserProcess({
        scope: globalThis,
        stdout: { write: (value) => output.stdout.push(value) },
        stderr: { write: (value) => output.stderr.push(value) },
        argv: ['node', 'worker.js'],
        env: { NUMBER: 7 },
        cwd: '/logical',
        ppid: 42,
        run: ({ process }) => {
          process.stdout.write('stdout');
          process.stderr.write('stderr');
          process.on('message', (message) => {
            process.send({ seen: message });
            if (message === 2) process.exit(7);
          });
          return new Promise(() => {});
        },
      });
      child.on('spawn', () => order.push('spawn'));
      child.on('message', (message) => messages.push(message));
      child.on('exit', () => order.push('exit'));
      child.on('close', () => order.push('close'));
      await once(child, 'spawn');
      child.send(1);
      child.send(2);
      const terminal = await child.wait();
      return {
        messages,
        output,
        order,
        terminal,
        stateHistory: child.stateHistory,
        identity: { pid: child.pid, ppid: child.ppid, argv: child.argv, env: child.env, cwd: child.cwd() },
      };
    });

    expect(result.messages).toEqual([{ seen: 1 }, { seen: 2 }]);
    expect(result.output).toEqual({ stdout: ['stdout'], stderr: ['stderr'] });
    expect(result.order).toEqual(['spawn', 'exit', 'close']);
    expect(result.stateHistory).toEqual(['created', 'starting', 'running', 'exited']);
    expect(result.identity).toMatchObject({ ppid: 42, argv: ['node', 'worker.js'], env: { NUMBER: '7' }, cwd: '/logical' });
    expect(result.terminal).toMatchObject({ status: 'exited', kind: 'exit', code: 7, signal: null, forced: false });
  });

  test('shares nested VFS file descriptors across worker boundaries', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { prepareWorkerVfs } = await import('/runtime/process.js');
      const source = new Uint8Array([1, 2, 3]);
      const descriptor = prepareWorkerVfs({
        files: { '/node/example.js': { data: source, mode: 0o755 } },
        artifacts: [{ path: '/node/example.js', bytes: source }],
      }, globalThis);
      return {
        sharedFile: descriptor.files['/node/example.js'].data.buffer instanceof SharedArrayBuffer,
        sharedArtifact: descriptor.artifacts[0].bytes.buffer instanceof SharedArrayBuffer,
        mode: descriptor.files['/node/example.js'].mode,
        bytes: [...descriptor.files['/node/example.js'].data],
      };
    });
    expect(result).toEqual({ sharedFile: true, sharedArtifact: true, mode: 0o755, bytes: [1, 2, 3] });
  });

  test('handles cooperative signals, abort cancellation, and forced termination', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createBrowserProcess } = await import('/runtime/process.js');
      const once = (emitter, name) => new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));
      const options = (run, extra = {}) => ({ scope: globalThis, run, ...extra });

      const handled = createBrowserProcess(options(({ process }) => new Promise(() => {
        process.on('SIGTERM', () => process.exit(0));
      })));
      await once(handled, 'spawn');
      handled.kill('SIGTERM');
      const handledTerminal = await handled.wait();

      const unhandled = createBrowserProcess(options(() => new Promise(() => {})));
      await once(unhandled, 'spawn');
      unhandled.kill('SIGINT');
      const unhandledTerminal = await unhandled.wait();

      const forced = createBrowserProcess(options(() => new Promise(() => {})));
      await once(forced, 'spawn');
      forced.terminate();
      const forcedTerminal = await forced.wait();

      const controller = new AbortController();
      const aborted = createBrowserProcess(options(() => new Promise(() => {}), { signal: controller.signal }));
      await once(aborted, 'spawn');
      controller.abort('test cancellation');
      const abortedTerminal = await aborted.wait();

      return { handledTerminal, unhandledTerminal, forcedTerminal, abortedTerminal };
    });

    expect(result.handledTerminal).toMatchObject({ status: 'exited', kind: 'exit', code: 0, signal: null });
    expect(result.unhandledTerminal).toMatchObject({ status: 'failed', kind: 'signal', code: null, signal: 'SIGINT', forced: false });
    expect(result.forcedTerminal).toMatchObject({ status: 'failed', kind: 'signal', code: null, signal: 'SIGKILL', forced: true });
    expect(result.abortedTerminal).toMatchObject({ status: 'failed', kind: 'signal', code: null, signal: 'SIGTERM', forced: false });
  });

  test('turns an uncaught browser worker exception into a structured failure', async ({ page }) => {
    await openRuntime(page);
    const terminal = await page.evaluate(async () => {
      const { createBrowserProcess } = await import('/runtime/process.js');
      const child = createBrowserProcess({
        scope: globalThis,
        run: () => {
          setTimeout(() => { throw new Error('uncaught worker boom'); }, 0);
          return new Promise(() => {});
        },
      });
      return await child.wait();
    });

    expect(terminal).toMatchObject({ status: 'failed', kind: 'uncaught-exception', code: 1, signal: null });
    expect(terminal.error).toMatchObject({ code: 'ERR_WORKER_EXCEPTION', message: 'uncaught worker boom' });
  });

  test('carries terminal runtime state across the worker control boundary', async ({ page }) => {
    await openRuntime(page);
    const terminal = await page.evaluate(async () => {
      const { createBrowserProcess } = await import('/runtime/process.js');
      const child = createBrowserProcess({
        scope: globalThis,
        run: ({ process }) => {
          process.__bnhNodeTestState = {
            requestedFiles: ['/node/example.test.js'],
            files: ['/node/example.test.js'],
            registered: 1,
            completed: 1,
          };
          process.exit(0);
        },
      });
      return await child.wait();
    });

    expect(terminal).toMatchObject({ status: 'exited', kind: 'exit', code: 0 });
    expect(terminal.runtimeState).toEqual({
      requestedFiles: ['/node/example.test.js'],
      files: ['/node/example.test.js'],
      registered: 1,
      completed: 1,
    });
  });

  test('reports node:test discovery state from a VFS worker entry', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createVirtualProcess } = await import('/runtime/virtual-process.js');
      const capabilities = {
        vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
        workers: { entryModules: ['*'], maxChildren: 4 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
        envVars: { allowed: [] },
      };
      const entry = '/node/runner.js';
      const encode = (source) => new TextEncoder().encode(source);
      const stdout = [];
      const stderr = [];
      const child = createVirtualProcess({
        scope: globalThis,
        forceFallback: true,
        entry,
        argv: ['node', entry],
        cwd: '/node',
        vfs: {
          capabilities,
          files: {
            [entry]: encode(`
              const assert = require('node:assert/strict');
              const { run } = require('node:test');
              const stream = run({ files: ['/node/example.test.js'] });
              stream.resume();
              stream.on('end', () => {
                assert.deepStrictEqual(process.__bnhNodeTestState.requestedFiles, ['/node/example.test.js']);
                process.stdout.write('worker node:test complete\\n');
              });
            `),
            '/node/example.test.js': encode("const { test } = require('node:test'); test('worker pass', () => {});"),
          },
        },
        stdout: (value) => stdout.push(String(value)),
        stderr: (value) => stderr.push(String(value)),
      });
      const terminal = await child.wait();
      return { terminal, stdout: stdout.join(''), stderr: stderr.join('') };
    });

    expect(result.terminal).toMatchObject({ status: 'exited', code: 0 });
    expect(result.terminal.runtimeState?.nodeTest?.requestedFiles, JSON.stringify(result)).toEqual(['/node/example.test.js']);
    expect(result.stdout).toContain('worker node:test complete');
    expect(result.stderr).toBe('');
  });

  test('streams an async piped HTTP response through a runtime worker before it ends', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createRuntime } = await import('/runtime.js');
      const capabilities = {
        vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
        workers: { entryModules: ['*'], maxChildren: 2 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
        envVars: { allowed: [] },
      };
      const runtime = createRuntime({ globalObject: globalThis });
      const source = `
        (async () => {
        const assert = require('node:assert');
        const { finished, Readable } = require('node:stream');
        const http = require('node:http');
        const server = http.createServer(async (_request, response) => {
          const stream = new Readable();
          stream._read = () => {};
          response.setHeader('content-type', 'text/plain');
          response.setHeader('transfer-encoding', 'chunked');
          finished(stream, { readable: true, writable: false }, () => {});
          finished(response, () => {});
          stream.push('first');
          stream.pipe(response);
          await new Promise((resolve) => setTimeout(resolve, 100));
          stream.push('late');
          stream.push(null);
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43306, '127.0.0.1', resolve); });
        await new Promise((resolve, reject) => {
          let request;
          request = http.get('http://localhost:43306/abort', (response) => {
            response.once('data', (chunk) => {
              assert.strictEqual(chunk.toString(), 'first');
              request.destroy();
              resolve();
            });
            response.once('error', reject);
          });
          request.once('error', (error) => {
            if (error.code !== 'ECONNRESET') reject(error);
          });
        });
        const response = await new Promise((resolve, reject) => {
          const request = http.get('http://localhost:43306/next', resolve);
          request.once('error', reject);
        });
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        await new Promise((resolve, reject) => { response.once('end', resolve); response.once('error', reject); });
        assert.strictEqual(body, 'firstlate');
        await new Promise((resolve) => server.close(resolve));
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      const stdout = [];
      const stderr = [];
      await runtime.reset({ runId: 'worker-http-stream-regression', capabilities, isolation: 'worker' });
      await runtime.mount({ '/node/runner.js': new TextEncoder().encode(source) });
      const code = await runtime.executeEntry('/node/runner.js', {
        cwd: '/node',
        env: {},
        processArgv: ['node', '/node/runner.js'],
      }, (value) => stdout.push(String(value)), (value) => stderr.push(String(value)));
      return { code, stdout: stdout.join(''), stderr: stderr.join('') };
    });

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('preserves async piped response delivery through a nested virtual child', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createRuntime } = await import('/runtime.js');
      const capabilities = {
        vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
        workers: { entryModules: ['*'], maxChildren: 4 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
        envVars: { allowed: [] },
        proxy: { mode: 'proxy', enabled: true, capability: true },
      };
      const encode = (source) => new TextEncoder().encode(source);
      const runtime = createRuntime({ globalObject: globalThis });
      const childSource = `
        const assert = require('node:assert');
        const { finished, Readable } = require('node:stream');
        const http = require('node:http');
        const server = http.createServer(async (_request, response) => {
          const stream = new Readable();
          stream._read = () => {};
          const reply = {
            raw: response,
            get sent() { return response.writableEnded === true; },
            then(fulfilled, rejected) {
              if (this.sent) {
                fulfilled();
                return;
              }
              finished(this.raw, (error) => {
                if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                  rejected?.(error);
                  return;
                }
                fulfilled();
              });
            },
          };
          response.setHeader('content-type', 'text/plain');
          response.setHeader('transfer-encoding', 'chunked');
          finished(stream, { readable: true, writable: false }, () => {});
          finished(response, () => {});
          stream.push('first');
          stream.pipe(response);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 10);
            timer.unref?.();
          });
          stream.push('late');
          stream.push(null);
          await new Promise((resolve, reject) => reply.then(resolve, reject));
          return reply;
        });
        (async () => {
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43307, '127.0.0.1', resolve); });
          await new Promise((resolve, reject) => {
            let request;
            request = http.get('http://localhost:43307/abort', (response) => {
              response.once('data', (chunk) => {
                assert.strictEqual(chunk.toString(), 'first');
                request.destroy();
                resolve();
              });
              response.once('error', reject);
            });
            request.once('error', (error) => {
              if (error.code !== 'ECONNRESET') reject(error);
            });
          });
          const response = await new Promise((resolve, reject) => {
            const request = http.get('http://localhost:43307/next', resolve);
            request.once('error', reject);
          });
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          await new Promise((resolve, reject) => { response.once('end', resolve); response.once('error', reject); });
          assert.strictEqual(body, 'firstlate');
          await new Promise((resolve) => server.close(resolve));
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      const parentSource = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['/node/http-child.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
        child.once('error', () => process.exit(1));
        child.once('close', (code) => process.exit(code || 0));
        setTimeout(() => { child.kill('SIGKILL'); process.exit(1); }, 3000).unref();
      `;
      const stdout = [];
      const stderr = [];
      await runtime.reset({
        runId: 'nested-http-stream-regression',
        capabilities,
        isolation: 'worker',
        proxy: {
          mode: 'proxy',
          enabled: true,
          capability: true,
          adapter: { connect() { throw new Error('unexpected external connection'); } },
        },
      });
      await runtime.mount({
        '/node/runner.js': encode(parentSource),
        '/node/http-child.js': encode(childSource),
      });
      const code = await runtime.executeEntry('/node/runner.js', {
        cwd: '/node',
        env: {},
        processArgv: ['node', '/node/runner.js'],
      }, (value) => stdout.push(String(value)), (value) => stderr.push(String(value)));
      return { code, stdout: stdout.join(''), stderr: stderr.join('') };
    });

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('propagates a readable response abort through a nested virtual child', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createRuntime } = await import('/runtime.js');
      const encode = (source) => new TextEncoder().encode(source);
      const capabilities = {
        vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
        workers: { entryModules: ['*'], maxChildren: 4 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 1024 * 1024, stdoutBytes: 1024 * 1024, stderrBytes: 1024 * 1024 },
        envVars: { allowed: [] },
      };
      const runtime = createRuntime({ globalObject: globalThis });
      const parentSource = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['/node/readable-abort-child.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
        child.once('error', () => process.exit(1));
        child.once('close', (code, signal) => process.exit(signal ? 1 : (code || 0)));
      `;
      const childSource = `
        const assert = require('node:assert');
        const { finished, Readable } = require('node:stream');
        const http = require('node:http');
        let serverClosed;
        const serverClosedPromise = new Promise((resolve) => { serverClosed = resolve; });
        let sourceClosed;
        const sourceClosedPromise = new Promise((resolve) => { sourceClosed = resolve; });
        let responsePremature = false;
        let sourcePremature = false;
        const server = http.createServer((_request, response) => {
          const source = new Readable({ read() {} });
          source.once('close', () => {
            sourceClosed();
          });
          finished(source, { readable: true, writable: false }, (error) => {
            sourcePremature = error?.code === 'ERR_STREAM_PREMATURE_CLOSE';
          });
          finished(response, (error) => {
            responsePremature = error?.code === 'ERR_STREAM_PREMATURE_CLOSE';
            if (error && !source.destroyed) source.destroy(error);
          });
          response.once('close', serverClosed);
          response.writeHead(200, { 'content-type': 'text/plain' });
          source.pipe(response);
          source.push('partial');
        });
        (async () => {
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43308, '127.0.0.1', resolve); });
          await new Promise((resolve, reject) => {
            const request = http.get('http://localhost:43308/readable-abort', (response) => {
              response.once('readable', () => {
                process.stdout.write('readable-abort-seen\\n');
                response.destroy();
                resolve();
              });
              response.once('error', reject);
            });
            request.once('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
          });
          await Promise.race([
            serverClosedPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('server response did not close')), 1000)),
          ]);
          await Promise.race([
            sourceClosedPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('response source did not close')), 1000)),
          ]);
          assert.ok(responsePremature);
          assert.ok(sourcePremature);
          assert.ok(true);
          await new Promise((resolve) => server.close(resolve));
          process.exit(0);
        })().catch((error) => { console.error(error); process.exit(1); });
      `;
      const stdout = [];
      const stderr = [];
      const decode = (value) => typeof value === 'string' ? value : new TextDecoder().decode(value);
      await runtime.reset({ runId: 'nested-readable-abort-regression', capabilities, isolation: 'worker' });
      await runtime.mount({
        '/node/runner.js': encode(parentSource),
        '/node/readable-abort-child.js': encode(childSource),
      });
      const code = await runtime.executeEntry('/node/runner.js', {
        cwd: '/node',
        env: {},
        processArgv: ['node', '/node/runner.js'],
      }, (value) => stdout.push(decode(value)), (value) => stderr.push(decode(value)));
      return { code, stdout: stdout.join(''), stderr: stderr.join('') };
    });

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('readable-abort-seen');
    expect(result.stderr).toBe('');
  });
});
