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
});
