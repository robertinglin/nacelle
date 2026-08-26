import assert from 'node:assert/strict';
import { expect, test } from 'playwright/test';
import { createCluster, createWorkerCluster } from '../runtime/cluster.js';
import { BrowserEventEmitter } from '../runtime/events.js';
import { createBrowserProcess } from '../runtime/process.js';
import { createVirtualProcess } from '../runtime/virtual-process.js';

function event(emitter, name) {
  return new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));
}

test.describe('browser virtual cluster', () => {
  test('exposes primary-shaped state and preserves default settings', () => {
    const cluster = createCluster({ forceFallback: true });

    assert.equal(cluster.isPrimary, true);
    assert.equal(cluster.isMaster, true);
    assert.equal(cluster.isWorker, false);
    assert.equal(cluster.worker, null);
    assert.deepEqual(cluster.settings.args, []);
    assert.deepEqual(cluster.settings.execArgv, []);
    assert.equal(cluster.settings.exec, '/browser/node');
    assert.equal(typeof cluster.Worker, 'function');
    assert.deepEqual(Object.keys(cluster.workers), []);

    cluster.setupPrimary({ args: ['worker-entry'], execArgv: ['--trace-warnings'], silent: true });
    assert.deepEqual(cluster.settings.args, ['worker-entry']);
    assert.deepEqual(cluster.settings.execArgv, ['--trace-warnings']);
    assert.equal(cluster.settings.silent, true);
    assert.throws(() => cluster.setupMaster({ serialization: 'advanced' }), { code: 'ERR_CLUSTER_UNSUPPORTED_SETTING' });
  });

  test('coordinates a fallback worker with Node-shaped lifecycle and IPC events', async () => {
    const clusterEvents = [];
    const cluster = createCluster({
      forceFallback: true,
      process: { pid: 77, env: { inherited: 'yes' } },
      workerRun: async ({ process }) => {
        process.on('message', (message) => {
          process.send({ reply: message.value, inherited: process.env.inherited, assigned: process.env.assigned });
          process.disconnect();
        });
        await new Promise((resolve) => process.once('disconnect', resolve));
      },
    });
    for (const name of ['fork', 'online', 'message', 'disconnect', 'exit']) {
      cluster.on(name, (...args) => clusterEvents.push([name, args[0]?.id ?? args[0], args[1]]));
    }

    const worker = cluster.fork({ assigned: 42 });
    assert.equal(cluster.workers[worker.id], worker);
    assert.equal(worker.process.ppid, 77);

    await event(cluster, 'online');
    const workerMessage = event(worker, 'message');
    const clusterMessage = event(cluster, 'message');
    const workerDisconnect = event(worker, 'disconnect');
    const workerExit = event(worker, 'exit');
    worker.send({ value: 9 });
    assert.deepEqual((await workerMessage)[0], { reply: 9, inherited: 'yes', assigned: '42' });
    assert.equal((await clusterMessage)[0], worker);

    await workerDisconnect;
    const exit = await workerExit;
    assert.deepEqual(exit.slice(0, 2), [0, null]);
    assert.equal(worker.isConnected(), false);
    assert.equal(worker.isDead(), true);
    assert.equal(cluster.workers[worker.id], undefined);
    const names = clusterEvents.map(([name]) => name);
    assert.deepEqual(names.slice(0, 2), ['fork', 'online']);
    assert.equal(names.at(-1), 'exit');
    assert.deepEqual([...names].sort(), ['disconnect', 'exit', 'fork', 'message', 'online']);
  });

  test('disconnects all workers and reports closed IPC instead of simulating a host child', async () => {
    let childDisconnected;
    const cluster = createCluster({
      forceFallback: true,
      workerRun: async ({ process }) => {
        await new Promise((resolve) => {
          childDisconnected = resolve;
          process.once('disconnect', resolve);
        });
      },
    });
    const worker = cluster.fork();
    await event(cluster, 'online');

    let callbackCalled = false;
    cluster.disconnect(() => { callbackCalled = true; });
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.equal(callbackCalled, true);
    assert.equal(worker.isConnected(), false);
    childDisconnected?.();
    await worker.process.wait();
    assert.equal(worker.isDead(), true);
    assert.throws(() => worker.send({ after: 'disconnect' }), { code: 'ERR_IPC_CLOSED' });
  });

  test('terminates browser workers when their primary exits', async () => {
    const primaryProcess = new BrowserEventEmitter();
    Object.assign(primaryProcess, { pid: 91, env: {} });
    const cluster = createCluster({
      forceFallback: true,
      process: primaryProcess,
      workerRun: async ({ process }) => new Promise((resolve) => process.once('disconnect', resolve)),
    });
    const worker = cluster.fork();
    await event(cluster, 'online');

    const workerExit = event(worker, 'exit');
    primaryProcess.emit('exit', 0);

    // The primary exit handler must make the worker terminal before returning;
    // an outer runtime may run its own exit assertion immediately afterward.
    assert.equal(worker.process.terminal?.forced, true);
    assert.equal(worker.isDead(), true);
    assert.deepEqual(Object.keys(cluster.workers), []);
    await workerExit;

    assert.equal(worker.isConnected(), false);
    assert.equal(worker.isDead(), true);
    assert.deepEqual(Object.keys(cluster.workers), []);
    assert.throws(() => cluster.fork(), { code: 'ERR_CLUSTER_CLOSED' });
  });

  test('treats pre-ready SIGKILL as intentional worker termination', async () => {
    const fakeWorker = {
      listeners: new Map(),
      on(name, listener) {
        const listeners = this.listeners.get(name) || [];
        listeners.push(listener);
        this.listeners.set(name, listeners);
        return this;
      },
      postMessage() {},
      terminate() { return true; },
      close() {},
    };
    const processHandle = createBrowserProcess({
      workerFactory: () => fakeWorker,
      scope: globalThis,
      run: () => {},
    });

    processHandle.terminate();
    const terminal = await processHandle.wait();
    assert.equal(terminal.forced, true);
    assert.equal(terminal.signal, 'SIGKILL');
    assert.equal(processHandle.state, 'failed');
  });

  test('rejects missing entries, unserializable messages, and raw host handles', async () => {
    const empty = createCluster({ forceFallback: true });
    assert.throws(() => empty.fork(), { code: 'ERR_CLUSTER_ENTRY_UNAVAILABLE' });

    const cluster = createCluster({
      forceFallback: true,
      workerRun: async ({ process }) => new Promise((resolve) => process.once('disconnect', resolve)),
    });
    const worker = cluster.fork();
    await event(cluster, 'online');
    assert.throws(() => worker.send(() => {}), { code: 'ERR_IPC_SERIALIZATION' });
    assert.throws(() => worker.send({ value: 1 }, { server: true }), { code: 'ERR_UNSUPPORTED_BROWSER_BOUNDARY' });
    await new Promise((resolve) => {
      assert.equal(worker.send({ value: 1 }, { server: true }, (error) => {
        assert.equal(error.code, 'ERR_UNSUPPORTED_BROWSER_BOUNDARY');
        resolve();
      }), false);
    });
    worker.disconnect();
    await worker.process.wait();
  });

  test('can expose the same Node-shaped API inside a virtual worker', async () => {
    let workerCluster;
    const processHandle = createVirtualProcess({
      forceFallback: true,
      run: async ({ process }) => {
        workerCluster = createWorkerCluster({ process, id: 3 });
        assert.equal(workerCluster.isPrimary, false);
        assert.equal(workerCluster.isMaster, false);
        assert.equal(workerCluster.isWorker, true);
        assert.equal(workerCluster.worker.id, 3);
        process.disconnect();
      },
    });
    await processHandle.wait();
    expect(workerCluster.worker.isDead()).toBe(true);
    assert.equal(workerCluster.worker.isConnected(), false);
  });
});
