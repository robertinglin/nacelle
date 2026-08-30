import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

function commonjsSource(label, body) {
  return `
    (async () => {
    ${body}
    })().catch((error) => {
      console.error('perf-compat: ${label}', error?.stack || error);
      process.exitCode = 1;
    });
  `;
}

test.describe('browser Node v22 performance compatibility', () => {
  test('exposes browser performance entries and Node-shaped observer lists', async ({ harnessPage }) => {
    const result = await harnessPage.run(commonjsSource('entries-observer', `
      const assert = require('node:assert');
      const { performance, PerformanceObserver } = require('node:perf_hooks');
      assert.strictEqual(typeof performance.now, 'function');
      assert.strictEqual(typeof performance.getEntries, 'function');
      assert.strictEqual(typeof performance.getEntriesByName, 'function');
      assert.strictEqual(typeof performance.getEntriesByType, 'function');
      assert.strictEqual(typeof performance.mark, 'function');
      assert.strictEqual(typeof performance.measure, 'function');
      assert.strictEqual(typeof performance.clearMarks, 'function');
      assert.strictEqual(typeof performance.clearMeasures, 'function');
      assert.strictEqual(typeof performance.timeOrigin, 'number');
      assert.strictEqual(typeof performance.toJSON, 'function');
      assert.strictEqual(typeof PerformanceObserver, 'function');
      assert.ok(PerformanceObserver.supportedEntryTypes.includes('mark'));

      const suffix = String(process.pid);
      const startName = 'bnh-perf-start-' + suffix;
      const endName = 'bnh-perf-end-' + suffix;
      const measureName = 'bnh-perf-measure-' + suffix;
      performance.clearMarks(startName);
      performance.clearMarks(endName);
      performance.clearMeasures(measureName);
      performance.mark(startName);
      performance.mark(endName);
      const measure = performance.measure(measureName, startName, endName);
      assert.strictEqual(measure.name, measureName);
      assert.strictEqual(measure.entryType, 'measure');
      assert.ok(Number.isFinite(measure.startTime));
      assert.ok(measure.duration >= 0);
      assert.strictEqual(performance.getEntriesByName(measureName, 'measure').length, 1);
      assert.strictEqual(performance.getEntriesByType('measure').some((entry) => entry.name === measureName), true);
      assert.ok(performance.getEntries().some((entry) => entry.name === measureName));

      await new Promise((resolve, reject) => {
        const observer = new PerformanceObserver((list, callbackObserver) => {
          try {
            assert.strictEqual(callbackObserver, observer);
            const entries = list.getEntriesByType('measure');
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(entries[0].name, measureName);
            assert.strictEqual(list.getEntriesByName(measureName, 'measure').length, 1);
            assert.strictEqual(list.getEntriesByName('missing').length, 0);
            callbackObserver.disconnect();
            resolve();
          } catch (error) {
            callbackObserver.disconnect();
            reject(error);
          }
        });
        observer.observe({ type: 'measure' });
        performance.measure(measureName, startName, endName);
      });

      performance.clearMarks(startName);
      performance.clearMarks(endName);
      performance.clearMeasures(measureName);
    `));

    await expectPass(expect, result);
  });

  test('timerifies sync functions into observable browser-safe function entries', async ({ harnessPage }) => {
    const result = await harnessPage.run(commonjsSource('timerify', `
      const assert = require('node:assert');
      const { performance, PerformanceObserver } = require('node:perf_hooks');
      assert.strictEqual(typeof performance.timerify, 'function');

      await new Promise((resolve, reject) => {
        const observer = new PerformanceObserver((list, callbackObserver) => {
          try {
            const entries = list.getEntriesByType('function');
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(entries[0].name, 'add');
            assert.strictEqual(entries[0].entryType, 'function');
            assert.ok(entries[0].duration >= 0);
            assert.deepStrictEqual(entries[0].detail, [4, 5]);
            assert.strictEqual(list.getEntriesByName('add', 'function').length, 1);
            callbackObserver.disconnect();
            resolve();
          } catch (error) {
            callbackObserver.disconnect();
            reject(error);
          }
        });
        observer.observe({ entryTypes: ['function'] });
        const add = performance.timerify(function add(left, right) {
          return left + right;
        });
        assert.strictEqual(add.name, 'timerified add');
        assert.strictEqual(add.length, 2);
        assert.strictEqual(add(4, 5), 9);
      });
    `));

    await expectPass(expect, result);
  });

  test('provides monotonic process helpers and deterministic virtual metrics', async ({ harnessPage }) => {
    const result = await harnessPage.run(commonjsSource('process-metadata', `
      const assert = require('node:assert');
      const { performance } = require('node:perf_hooks');
      assert.ok(process.uptime() >= 0);
      assert.strictEqual(typeof process.hrtime, 'function');
      assert.strictEqual(typeof process.hrtime.bigint, 'function');
      const before = process.hrtime();
      const beforeBigInt = process.hrtime.bigint();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const delta = process.hrtime(before);
      assert.strictEqual(Array.isArray(delta), true);
      assert.strictEqual(delta.length, 2);
      assert.ok(delta[0] >= 0);
      assert.ok(delta[1] >= 0 && delta[1] < 1e9);
      assert.ok(process.hrtime.bigint() >= beforeBigInt);
      assert.ok(performance.now() >= 0);

      assert.throws(
        () => performance.nodeTiming,
        (error) => error?.code === 'ERR_UNSUPPORTED_WEB_CAPABILITY'
          && error?.status === 'unsupported-capability',
      );
      const perfHooks = require('node:perf_hooks');
      const utilization = perfHooks.eventLoopUtilization();
      assert.deepStrictEqual(Object.keys(utilization).sort(), ['active', 'idle', 'utilization']);
      const histogram = perfHooks.createHistogram();
      histogram.record(10);
      histogram.record(20);
      assert.strictEqual(histogram.count, 2);
      assert.strictEqual(histogram.mean, 15);
      const delay = perfHooks.monitorEventLoopDelay();
      assert.strictEqual(typeof delay.percentile, 'function');
      assert.strictEqual(typeof process.memoryUsage().rss, 'number');
      assert.deepStrictEqual(process.cpuUsage(), { user: 0, system: 0 });
      assert.strictEqual(typeof process.resourceUsage().maxRSS, 'number');
    `));

    await expectPass(expect, result);
  });
});
