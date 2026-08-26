import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'playwright/test';

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
    expect(contract).toContain('run(request: BrowserNodeHarnessRequest)');
    expect(contract).toContain('exitCode: number | null');
    expect(contract).toContain('timedOut?: boolean');
    expect(contract).toContain('expected?:');
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
    expect(adapter).not.toContain('spawn(process.execPath');
  });

  test('covers every shared primitive family in the source contracts', async () => {
    const runtime = await source('src/browser_node_harness/primitive_suites/runtime.py');
    const io = await source('src/browser_node_harness/primitive_suites/io_network.py');
    const platform = await source('src/browser_node_harness/primitive_suites/system_platform.py');
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
});
