import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createAsyncHooksModule, AsyncResource } from '../../adapters/playwright/runtime/async-hooks.js';
import { createDiagnosticsModule } from '../../adapters/playwright/runtime/diagnostics.js';
import { createBrowserProcess } from '../../adapters/playwright/runtime/process.js';

class FakePort {
  constructor() { this.peer = null; this.onmessage = null; this.closed = false; }
  start() {}
  addEventListener(name, listener) { if (name === 'message') this.onmessage = listener; }
  removeEventListener() {}
  postMessage(value) {
    if (this.closed) throw new Error('closed');
    const copy = structuredClone(value);
    queueMicrotask(() => this.peer?.onmessage?.({ data: copy }));
  }
  close() { this.closed = true; }
}

class FakeChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class FakeWorker {
  constructor(source) {
    this.listeners = new Map();
    this.workerGlobal = { close() {} };
    vm.runInNewContext(source, { self: this.workerGlobal, setTimeout, clearTimeout, queueMicrotask, eval });
  }
  on(name, listener) { const set = this.listeners.get(name) || new Set(); set.add(listener); this.listeners.set(name, set); return this; }
  postMessage(value) { queueMicrotask(() => this.workerGlobal.onmessage?.({ data: value })); }
  terminate() { this.workerGlobal.close(); return Promise.resolve(1); }
}

test('async hooks propagate local storage and clean resource lifecycle', async () => {
  const module = createAsyncHooksModule();
  const lifecycle = [];
  const hook = module.createHook({ init: (id, type) => lifecycle.push(['init', id, type]), destroy: (id) => lifecycle.push(['destroy', id]) }).enable();
  const storage = new module.AsyncLocalStorage();
  await storage.run({ requestId: 7 }, () => Promise.resolve().then(() => {
    assert.deepEqual(storage.getStore(), { requestId: 7 });
  }));
  const resource = new AsyncResource('contract');
  resource.runInAsyncScope(() => assert.equal(module.executionAsyncId(), resource.asyncId()));
  resource.emitDestroy();
  hook.disable();
  module.cleanup();
  assert.ok(lifecycle.some(([, , type]) => type === 'PROMISE'));
  assert.ok(lifecycle.some(([name]) => name === 'destroy'));
});

test('diagnostics channels support subscriptions, tracing, and cleanup', async () => {
  const diagnostics = createDiagnosticsModule();
  const channel = diagnostics.channel('contract');
  const messages = [];
  const listener = (message) => messages.push(message);
  diagnostics.subscribe('contract', listener);
  channel.publish({ ok: true });
  assert.equal(diagnostics.unsubscribe('contract', listener), true);
  assert.deepEqual(messages, [{ ok: true }]);
  const tracing = diagnostics.tracingChannel('contract.trace');
  const phases = [];
  tracing.subscribe({ start: () => phases.push('start'), end: () => phases.push('end'), asyncStart: () => phases.push('asyncStart'), asyncEnd: () => phases.push('asyncEnd') });
  assert.equal(tracing.traceSync(() => 3), 3);
  assert.equal(await tracing.tracePromise(async () => 4), 4);
  assert.deepEqual(phases, ['start', 'end', 'asyncStart', 'asyncEnd']);
  diagnostics.clear();
  assert.equal(tracing.hasSubscribers, false);
});

test('browser process preserves IPC, stdio, and exit ordering without host subprocesses', async () => {
  const scope = { MessageChannel: FakeChannel, structuredClone, setTimeout, clearTimeout };
  const output = [];
  const messages = [];
  const order = [];
  const child = createBrowserProcess({
    scope,
    workerFactory: (source) => new FakeWorker(source),
    argv: ['node', 'entry.js'],
    stdout: { write: (value) => output.push(value) },
    run: ({ process }) => new Promise(() => {
      process.on('message', (message) => { process.send({ seen: message }); if (message === 2) process.exit(4); });
      process.stdout.write('worker-output');
    }),
  });
  child.on('spawn', () => order.push('spawn'));
  child.on('message', (message) => messages.push(message));
  child.on('exit', () => order.push('exit'));
  child.on('close', () => order.push('close'));
  await new Promise((resolve) => child.once('spawn', resolve));
  child.send(1);
  child.send(2);
  const terminal = await child.wait();
  assert.deepEqual(messages, [{ seen: 1 }, { seen: 2 }]);
  assert.deepEqual(output, ['worker-output']);
  assert.deepEqual(order, ['spawn', 'exit', 'close']);
  assert.equal(terminal.code, 4);
});
