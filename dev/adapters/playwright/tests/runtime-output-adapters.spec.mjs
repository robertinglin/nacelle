import { expect, test } from 'playwright/test';
import { createRuntime } from '../runtime.js';
import { createCapabilityCompatibility } from '../runtime/compat.js';
import { createProcess, installProcessContract } from '../runtime/process.js';
import { path } from '../runtime/path.js';
import { ensureOutputStream, OutputCollector, Readable, Transform, Writable } from '../runtime/streams.js';

test.describe('browser primitive output adapters', () => {
  test('decodes byte chunks sent through process stdout and stderr callbacks', async () => {
    const runtime = createRuntime();
    await runtime.reset({
      runId: 'runtime-output-normalization',
      capabilities: {
        vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
        workers: { entryModules: ['*'], maxChildren: 1 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 1024, stdoutBytes: 1024, stderrBytes: 1024 },
        envVars: { allowed: [] },
      },
    });
    await runtime.mount({
      '/node/output.js': new TextEncoder().encode(`
        const encoder = new TextEncoder();
        process.stdout.write('stdout string');
        process.stdout.write(encoder.encode(' stdout bytes'));
        process.stdout.write(encoder.encode(' stdout buffer').buffer);
        process.stdout.write(new Uint8ClampedArray(encoder.encode(' stdout typed')));
        process.stderr.write('stderr string');
        process.stderr.write(encoder.encode(' stderr bytes'));
        process.stderr.write(encoder.encode(' stderr buffer').buffer);
        process.stderr.write(new Uint8ClampedArray(encoder.encode(' stderr typed')));
      `),
    });
    const stdout = [];
    const stderr = [];

    expect(await runtime.executeEntry('/node/output.js', {}, (value) => stdout.push(value), (value) => stderr.push(value))).toBe(0);
    expect(stdout.join('')).toBe('stdout string stdout bytes stdout buffer stdout typed');
    expect(stderr.join('')).toBe('stderr string stderr bytes stderr buffer stderr typed');
  });

  test('preserves Node cork and uncork semantics on virtual process stdio', async () => {
    const runtime = createRuntime();
    await runtime.reset({
      runId: 'runtime-output-cork',
      capabilities: {
        vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
        workers: { entryModules: ['*'], maxChildren: 1 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 1024, stdoutBytes: 1024, stderrBytes: 1024 },
        envVars: { allowed: [] },
      },
    });
    await runtime.mount({
      '/node/cork.js': `
        process.stdout.cork();
        process.stdout.write('stdout first');
        process.stdout.write(' stdout second', () => process.stdout.write(' stdout callback'));
        process.stdout.uncork();
        process.stderr.cork();
        process.stderr.write('stderr first');
        process.stderr.uncork();
      `,
    });
    const stdout = [];
    const stderr = [];

    expect(await runtime.executeEntry('/node/cork.js', {}, (value) => stdout.push(value), (value) => stderr.push(value))).toBe(0);
    expect(stdout.join('')).toBe('stdout first stdout second stdout callback');
    expect(stderr.join('')).toBe('stderr first');
  });

  test('provides Node path namespace helpers without host path resolution', () => {
    expect(path.toNamespacedPath('/node/entry.mjs')).toBe('/node/entry.mjs');
    expect(path.toNamespacedPath(null)).toBeNull();
    expect(path.win32.toNamespacedPath('C:/node/entry.mjs')).toBe('\\\\?\\C:\\node\\entry.mjs');
    expect(path.win32.toNamespacedPath('\\\\server\\share\\entry.mjs')).toBe('\\\\?\\UNC\\server\\share\\entry.mjs');
  });

  test('adapts browser process output endpoints to EventEmitter-compatible streams', async () => {
    const writes = [];
    const process = createProcess({
      output: {
        stdout: { write(value) { writes.push(value); } },
        stderr: { write(value) { writes.push(value); } },
      },
    });
    const events = [];
    process.stdout.once('finish', () => events.push('stdout-finish'));
    process.stderr.on('finish', () => events.push('stderr-finish'));

    expect(typeof process.stdout.on).toBe('function');
    expect(typeof process.stdout.once).toBe('function');
    expect(process.stdout.isTTY).toBe(false);
    expect(process.stderr.isTTY).toBe(false);
    process.stdout.write('browser output');
    process.stdout.end();
    process.stderr.end();
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(writes).toHaveLength(1);
    expect(events).toEqual(['stdout-finish', 'stderr-finish']);
  });

  test('starts readable flow when a data listener is attached', async () => {
    const readable = new Readable({ read() {} });
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(new TextDecoder().decode(chunk)));

    readable.push('browser stream');
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(chunks).toEqual(['browser stream']);
  });

  test('pulls paused readable streams and emits readable before end once', async () => {
    const chunks = [];
    const events = [];
    let reads = 0;
    const readable = new Readable({
      highWaterMark: 1,
      read() {
        if (reads++ === 0) this.push('browser stream');
        else this.push(null);
      },
    });
    const ended = new Promise((resolve) => readable.once('end', resolve));

    readable.on('readable', () => {
      events.push('readable');
      let chunk;
      while ((chunk = readable.read()) !== null) chunks.push(new TextDecoder().decode(chunk));
    });
    await ended;

    expect(chunks).toEqual(['browser stream']);
    expect(events).toEqual(['readable']);
  });

  test('completes a read/readable consumer after the final buffered chunk', async () => {
    let reads = 0;
    const readable = new Readable({
      highWaterMark: 1,
      read() {
        if (reads++ === 0) {
          this.push('final chunk');
          this.push(null);
        }
      },
    });
    const chunks = [];
    const pull = (async () => {
      while (true) {
        const chunk = readable.read();
        if (chunk !== null) {
          chunks.push(new TextDecoder().decode(chunk));
          continue;
        }
        if (readable.readableEnded) return;
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            readable.off('readable', onDone);
            readable.off('end', onDone);
            readable.off('error', onError);
          };
          const onDone = () => {
            cleanup();
            resolve();
          };
          const onError = (error) => {
            cleanup();
            reject(error);
          };
          readable.on('readable', onDone);
          readable.on('end', onDone);
          readable.on('error', onError);
        });
      }
    })();

    await Promise.race([
      pull,
      new Promise((_, reject) => setTimeout(() => reject(new Error('readable pull timed out')), 1000)),
    ]);
    expect(chunks).toEqual(['final chunk']);
    expect(readable.readableEnded).toBe(true);
  });

  test('preserves object-mode values through Readable.from and Transform', async () => {
    const transformed = Readable.from([1, 2, 3]).pipe(new Transform({
      objectMode: true,
      transform(value, _encoding, callback) {
        callback(null, value * 2);
      },
    }));
    const values = [];
    for await (const value of transformed) values.push(value);
    expect(values).toEqual([2, 4, 6]);
  });

  test('orders writable completion and reports synchronous write failure', async () => {
    const events = [];
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('write failed'));
      },
    });
    writable.on('error', () => events.push('error'));
    const accepted = writable.write('browser stream', () => events.push('callback'));

    expect(accepted).toBe(false);
    expect(events).toEqual(['callback']);
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(events).toEqual(['callback', 'error']);

    const completed = [];
    const ending = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    ending.on('prefinish', () => completed.push('prefinish'));
    ending.on('finish', () => completed.push('finish'));
    ending.end();
    expect(completed).toEqual(['prefinish']);
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(completed).toEqual(['prefinish', 'finish']);
  });

  test('reports a writable callback invoked more than once', async () => {
    const errors = [];
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
        callback();
      },
    });
    writable.on('error', (error) => errors.push(error.code));
    writable.write('browser stream');
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(errors).toEqual(['ERR_MULTIPLE_CALLBACK']);
  });

  test('keeps timer-driven writes ordered through pipe backpressure', async () => {
    const received = [];
    const writable = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        received.push(new TextDecoder().decode(chunk));
        setTimeout(callback, 0);
      },
    });
    const finished = new Promise((resolve, reject) => {
      writable.once('finish', resolve);
      writable.once('error', reject);
    });

    Readable.from(['a', 'b', 'c']).pipe(writable);
    await finished;
    expect(received).toEqual(['a', 'b', 'c']);
  });

  test('adapts worker-provided plain output endpoints at the process contract boundary', () => {
    const writes = [];
    const process = {
      stdout: { isTTY: true, write(value) { writes.push(value); } },
      stderr: { isTTY: true, write(value) { writes.push(value); } },
    };
    installProcessContract(process);

    expect(typeof process.stdout.on).toBe('function');
    expect(typeof process.stdout.once).toBe('function');
    expect(process.stdout.isTTY).toBe(false);
    process.stdout.write('worker output');
    expect(writes).toHaveLength(1);
  });

  test('keeps collected output browser-native and explicitly non-TTY', () => {
    const collector = new OutputCollector();
    const compatibility = createCapabilityCompatibility({
      manifest: { envVars: { allowed: [] } },
      vfs: { fs: { promises: {} } },
      output: collector,
    });

    expect(compatibility.stdout).toBe(collector.stdout);
    expect(compatibility.stderr).toBe(collector.stderr);
    expect(compatibility.stdout.isTTY).toBe(false);
    expect(typeof compatibility.stdout.on).toBe('function');
    expect(typeof compatibility.stdout.once).toBe('function');
    expect(ensureOutputStream(compatibility.stdout)).toBe(compatibility.stdout);
  });
});
