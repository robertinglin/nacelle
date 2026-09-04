import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'playwright/test';
import { createProgressReporter } from '../progress-protocol.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');
const adapterRoot = resolve(root, 'adapters/playwright');

async function source(relativePath) {
  return await readFile(resolve(root, relativePath), 'utf8');
}

test.describe('browser runtime test contracts', () => {
  test('defines the page-side request, file binding, and result contract', async () => {
    const contract = await source('adapters/playwright/bridge-contract.d.ts');
    expect(contract).toContain('schemaVersion: 1');
    expect(contract).toContain("mode: 'playwright-binding'");
    expect(contract).toContain("readBinding: '__bnhReadFile'");
    expect(contract).toContain('run(request: NacelleHarnessRequest)');
    expect(contract).toContain('exitCode: number | null');
    expect(contract).toContain('timedOut?: boolean');
    expect(contract).toContain('expected?:');
    expect(contract).toContain("binding: '__bnhReportProgress'");
    expect(contract).toContain("binding: '__bnhRecordOutput'");
    expect(contract).toContain("type: 'progress'");
  });

  test('requires reset, mount, spawn, stream capture, timeout kill, and runtime version details', async () => {
    const bridge = await source('adapters/playwright/target-bridge.example.js');
    for (const marker of [
      'runtime.reset',
      'runtime.mount(',
      'runtime.spawn(',
      'child.stdoutText()',
      'child.stderrText()',
      'setTimeout(async () =>',
      'await child.kill()',
      'runtime.version',
    ]) expect(bridge).toContain(marker);
    expect(bridge).not.toMatch(/node:(?:child_process|fs|net)/);
  });

  test('keeps target execution page-side while the adapter only serves files and calls the bridge', async () => {
    const adapter = await source('adapters/playwright/adapter-core.mjs');
    expect(adapter).toContain('page.evaluate(async (input) =>');
    expect(adapter).toContain('return await bridge.run(input)');
    expect(adapter).toContain('page.exposeBinding(\'__bnhReadFile\'');
    expect(adapter).toContain('expected: request.expected || null');
    expect(adapter).toContain("page.exposeBinding('__bnhReportProgress'");
    expect(adapter).toContain("progress: onProgress ? { binding: '__bnhReportProgress' }");
    expect(adapter).not.toContain('spawn(process.execPath');
    const runner = await source('adapters/playwright/run-citgm.mjs');
    expect(runner).toContain("page.exposeBinding('__bnhRecordOutput'");
    expect(runner).toContain("output: { binding: '__bnhRecordOutput' }");
  });

  test('uses a bounded, candidate-output-free progress protocol', async () => {
    const progress = await source('adapters/playwright/progress-protocol.mjs');
    expect(progress).toContain("export const PROGRESS_PREFIX = 'BNH_PROGRESS '");
    expect(progress).toContain('const DEFAULT_MAX_PENDING = 64');
    expect(progress).toContain("event === 'output-activity'");
    expect(progress).not.toContain('testPath');
    expect(progress).not.toContain('packageName');
  });

  test('CITGM progress carries request metadata, stage, child identity, and counters', async () => {
    const citgm = await source('adapters/playwright/citgm-bridge.js');
    expect(citgm).toContain("stage: 'runtime-reset'");
    expect(citgm).toContain('citgmVersion');
    expect(citgm).toContain('childActive');
    expect(citgm).toContain("'upstream-test-started'");
    expect(citgm).toContain('processArgv');
    expect(citgm).toContain('networkEvents');
    expect(citgm).toContain('outputCounters');
    expect(citgm).toContain('cacheUnpacked: false');
    expect(citgm).toContain('candidate-install-runs-on-demand-in-active-child');
    expect(citgm).not.toContain('preloadNpm.install');
    expect(citgm).toContain('installStats = {');
    expect(citgm).toContain('npmCache.clearMemory()');
  });

  test('coalesces burst activity and delivers progress in report order', async () => {
    const received = [];
    globalThis.__testProgressBinding = async (event) => {
      received.push(event);
    };
    try {
      const reporter = createProgressReporter({ binding: '__testProgressBinding', runId: 'run-1' });
      reporter.emit('lifecycle', 'started');
      for (let count = 1; count <= 100; count += 1) {
        reporter.emit('bootstrap', 'npm-installed', { events: count });
      }
      await reporter.flush();
      expect(received).toHaveLength(2);
      expect(received[1]).toMatchObject({ phase: 'bootstrap', event: 'npm-installed', events: 100 });
      expect(received.map((event) => event.sequence)).toEqual([1, 2]);
    } finally {
      delete globalThis.__testProgressBinding;
    }
  });

  test('covers every shared primitive family in the source contracts', async () => {
    const runtime = await source('harness/browser_node_harness/primitive_suites/runtime.py');
    const io = await source('harness/browser_node_harness/primitive_suites/io_network.py');
    const platform = await source('harness/browser_node_harness/primitive_suites/system_platform.py');
    for (const marker of [
      'globals', 'buffer-encoding', 'promise-microtasks', 'event-emitter',
      'uncaught-exception', 'unhandled-rejection',
    ]) expect(runtime).toContain(`"${marker}"`);
    for (const marker of [
      'vfs-io', 'http-fetch', 'streams-backpressure', 'workers-communication',
      'fs.watch', 'MessageChannel', 'AbortController',
    ]) expect(io).toContain(marker);
    for (const marker of [
      'system-platform-process', 'system-platform-module-loading',
      'system-platform-crypto', 'system-platform-diagnostics',
      'system-platform-compression', 'system-platform-wasm',
      'system-platform-unsupported-boundaries', 'native-addons',
    ]) expect(platform).toContain(marker);
  });

  test('defines separate structural and browser test commands', async () => {
    const packageJSON = JSON.parse(await readFile(resolve(adapterRoot, 'package.json'), 'utf8'));
    expect(packageJSON.scripts['test:structural']).toContain('structural.spec.mjs');
    expect(packageJSON.scripts['test:browser']).toContain('run-browser-tests.mjs');
    const browserRunner = await readFile(resolve(adapterRoot, 'tests/run-browser-tests.mjs'), 'utf8');
    expect(browserRunner).toContain('bridge-runtime.spec.mjs');
    expect(browserRunner).toContain('async-primitives.spec.mjs');
    expect(browserRunner).toContain('missing-primitives.spec.mjs');
    expect(browserRunner).toContain('platform-primitives.spec.mjs');
  });

  test('ships the shared target server used by every integration worktree', async () => {
    const server = await source('adapters/playwright/server.js');
    expect(server).toContain('process.env.BNH_WORKTREE || process.cwd()');
    expect(server).toContain("'/harness.html'");
    expect(server).toContain("'Cross-Origin-Opener-Policy'");
    expect(server).toContain("'Cross-Origin-Embedder-Policy'");
  });
});
