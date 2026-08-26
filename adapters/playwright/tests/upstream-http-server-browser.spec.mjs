import { expect } from 'playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './harness-test-helpers.mjs';

const nodeRoot = path.resolve(fileURLToPath(new URL('../../../.bnh-state/v22/node', import.meta.url)));

async function collectFiles(relativeRoot) {
  const files = {};
  async function walk(relative) {
    for (const entry of await readdir(path.join(nodeRoot, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && /\.(?:js|mjs|cjs|json)$/.test(entry.name)) {
        files[`/node/${child}`] = await readFile(path.join(nodeRoot, child), 'utf8');
      }
    }
  }
  await walk(relativeRoot);
  return files;
}

test('runs the upstream HTTP server source directly in the target browser bridge', async ({ harnessPage }) => {
  const entry = 'test/parallel/test-http-server.js';
  const files = {
    ...await collectFiles('test/common'),
    ...await collectFiles('test/fixtures'),
  };
  const source = await readFile(path.join(nodeRoot, entry), 'utf8');
  const result = await harnessPage.run(
    source,
    {
      entryPath: `/node/${entry}`,
      files,
      timeoutMs: 10_000,
      env: { NODE_TEST_KNOWN_GLOBALS: '0' },
    },
  );
  expect(JSON.stringify(result)).toContain('exitCode');
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
});
