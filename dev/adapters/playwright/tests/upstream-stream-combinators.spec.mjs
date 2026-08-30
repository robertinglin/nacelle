import { expect } from 'playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRuntimeURL, test } from './harness-test-helpers.mjs';

const nodeRoot = path.resolve(fileURLToPath(new URL('../../../.bnh-state/v22/node', import.meta.url)));
const entries = [
  'test/parallel/test-readable-large-hwm.js',
  'test/parallel/test-readable-single-end.js',
  'test/parallel/test-stream-filter.js',
  'test/parallel/test-stream-map.js',
  'test/parallel/test-stream-flatMap.js',
];

async function collectFiles(relativeRoot) {
  const files = {};
  async function walk(relative) {
    for (const entry of await readdir(path.join(nodeRoot, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && (/\.(?:js|mjs|cjs|json)$/.test(entry.name)
        || relativeRoot === 'test/fixtures' && entry.name === 'x.txt')) {
        files[`/node/${child}`] = await readFile(path.join(nodeRoot, child), 'utf8');
      }
    }
  }
  await walk(relativeRoot);
  return files;
}

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

for (const entry of entries) {
  test(`runs upstream ${entry}`, async ({ harnessPage }) => {
    const files = {
      ...await collectFiles('test/common'),
      ...await collectFiles('test/fixtures'),
    };
    const source = await readFile(path.join(nodeRoot, entry), 'utf8');
    const result = await harnessPage.run(source, {
      entryPath: `/node/${entry}`,
      files,
      env: { NODE_TEST_KNOWN_GLOBALS: '0' },
      capabilities: {
        vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
        workers: { entryModules: ['*'], maxChildren: 8 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
        envVars: { allowed: ['NODE_TEST_KNOWN_GLOBALS'] },
      },
      timeoutMs: 30_000,
    });
    expect(result.timedOut, JSON.stringify(result)).toBe(false);
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
  });
}
