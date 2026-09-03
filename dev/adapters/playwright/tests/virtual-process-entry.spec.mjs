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
