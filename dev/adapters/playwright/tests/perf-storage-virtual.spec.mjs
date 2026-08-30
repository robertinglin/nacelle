import assert from 'node:assert/strict';
import { test } from 'playwright/test';

import { createPerformancePrimitives } from '../runtime/perf.js';
import { createStorageAdapters } from '../runtime/storage.js';

function fakePerformance() {
  let currentTime = 100;
  const performance = {
    timeOrigin: 10,
    now: () => currentTime,
    getEntries: () => [],
    getEntriesByName: () => [],
    getEntriesByType: () => [],
    mark: () => undefined,
    measure: () => undefined,
    clearMarks: () => undefined,
    clearMeasures: () => undefined,
    clearResourceTimings: () => undefined,
    setResourceTimingBufferSize: () => undefined,
    toJSON: () => ({ timeOrigin: 10 }),
    advance(milliseconds) {
      currentTime += milliseconds;
    },
  };
  return performance;
}

test.describe('deterministic browser virtual fallbacks', () => {
  test('provides Node-shaped virtual performance metrics without host access', () => {
    const nativePerformance = fakePerformance();
    const { perfHooks, processMetadata } = createPerformancePrimitives(
      { performance: nativePerformance },
      { fallback: 'virtual' },
    );

    const initial = perfHooks.performance.eventLoopUtilization();
    nativePerformance.advance(4);
    const current = perfHooks.performance.eventLoopUtilization(initial);
    assert.deepEqual(current, { idle: 0, active: 4, utilization: 1 });
    assert.strictEqual(perfHooks.eventLoopUtilization, perfHooks.performance.eventLoopUtilization);

    const histogram = perfHooks.createHistogram();
    histogram.record(4);
    histogram.record(8);
    assert.strictEqual(histogram.count, 2);
    assert.strictEqual(histogram.min, 4);
    assert.strictEqual(histogram.max, 8);
    assert.strictEqual(histogram.mean, 6);
    assert.strictEqual(histogram.percentile(50), 4);
    histogram.disable();
    histogram.record(16);
    assert.strictEqual(histogram.count, 2);
    histogram.enable().reset();
    assert.strictEqual(histogram.count, 0);

    const delay = perfHooks.monitorEventLoopDelay({ resolution: 1 });
    assert.strictEqual(delay.count, 0);
    assert.strictEqual(delay.disable(), delay);

    const timerHistogram = perfHooks.createHistogram();
    const add = perfHooks.performance.timerify((left, right) => left + right, {
      histogram: timerHistogram,
    });
    assert.strictEqual(add(2, 3), 5);
    assert.strictEqual(timerHistogram.count, 1);

    assert.deepEqual(processMetadata.memoryUsage(), {
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    });
    assert.deepEqual(processMetadata.cpuUsage(), { user: 0, system: 0 });
    assert.deepEqual(processMetadata.resourceUsage(), {
      userCPUTime: 0,
      systemCPUTime: 0,
      maxRSS: 0,
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    });
    assert.deepEqual(processMetadata.getActiveResourcesInfo(), []);
  });

  test('keeps native capability denial explicit while opting into isolated virtual storage', async () => {
    const globalObject = { navigator: {} };
    const nativeOnly = createStorageAdapters({ globalObject });
    assert.throws(
      () => nativeOnly.storage.estimate(),
      (error) => error.code === 'ERR_UNSUPPORTED_WEB_CAPABILITY'
        && error.capability === 'navigator.storage',
    );

    const virtual = createStorageAdapters({ globalObject, fallback: 'virtual' });
    const value = { answer: 42, nested: new Map([['key', { ok: true }]]) };
    virtual.memory.set('value', value);
    value.nested.get('key').ok = false;
    const stored = virtual.memory.get('value');

    assert.strictEqual(virtual.features.storage, false);
    assert.strictEqual(virtual.storage.supported, false);
    assert.strictEqual(virtual.memory, virtual.fallback);
    assert.strictEqual(virtual.virtual, virtual.memory);
    assert.strictEqual(virtual.memory.virtual, true);
    assert.strictEqual(virtual.memory.persistent, false);
    assert.strictEqual(stored.nested.get('key').ok, true);
    assert.deepEqual(virtual.memory.keys(), ['value']);
  });
});
