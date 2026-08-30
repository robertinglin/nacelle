import { test as base } from 'playwright/test';

export const browserRuntimeURL = process.env.BNH_TEST_URL
  || (process.env.BNH_BROWSER_URL && !process.env.BNH_BROWSER_URL.includes('{')
    ? process.env.BNH_BROWSER_URL
    : '');

const defaultCapabilities = Object.freeze({
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 8 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
  envVars: { allowed: [] },
});

export const test = base.extend({
  harnessPage: async ({ page }, use, testInfo) => {
    const entry = `/node/.bnh-playwright-tests/${testInfo.testId}.js`;
    let files = new Map();
    await page.exposeBinding('__bnhReadFile', async (_source, requestedPath) => {
      const value = files.get(requestedPath);
      if (value === undefined) throw new Error(`unexpected manifest path: ${requestedPath}`);
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      return {
        encoding: 'base64',
        data: bytes.toString('base64'),
      };
    });
    await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      if (!globalThis.__BROWSER_NODE_HARNESS__ || typeof globalThis.__BROWSER_NODE_HARNESS__.run !== 'function') {
        throw new Error('browser page must expose __BROWSER_NODE_HARNESS__.run');
      }
    });

    await use({
      async run(sourceOverride, options = {}) {
        const entryPath = options.entryPath || entry;
        const variant = options.variant || process.env.BNH_NODE_VERSION || 'v22';
        files = new Map(Object.entries({ ...(options.files || {}), [entryPath]: sourceOverride }));
        const capabilities = options.capabilities || {
          ...defaultCapabilities,
          envVars: { allowed: Object.keys(options.env || {}) },
          'process.env': { allowed: Object.keys(options.env || {}) },
        };
        return await page.evaluate(async ({ entryPath, sourceText, flags, env, timeoutMs, files, capabilities, proxy, variant }) => {
          return await globalThis.__BROWSER_NODE_HARNESS__.run({
            schemaVersion: 1,
            entry: entryPath,
            variant,
            capabilities,
            proxy,
            files: {
              mode: 'playwright-binding',
              readBinding: '__bnhReadFile',
              manifest: Object.entries(files).map(([path, value]) => ({
                path,
                bytes: typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength,
              })),
            },
            flags,
            env,
            timeoutMs,
            metadata: {
              testPath: entryPath,
              sourceSha256: 'playwright-test-source',
              bundleBytes: new TextEncoder().encode(sourceText).byteLength,
              omittedFiles: [],
            },
          });
        }, {
          entryPath,
          sourceText: sourceOverride,
          files: Object.fromEntries(files),
          flags: options.flags || [],
          env: options.env || {},
          timeoutMs: options.timeoutMs || 10_000,
          capabilities,
          proxy: options.proxy,
          variant,
        });
      },
    });
  },
});

export async function expectPass(expect, result) {
  const details = JSON.stringify(result);
  expect(result.exitCode, details).toBe(0);
  expect(result.timedOut, details).not.toBe(true);
}
