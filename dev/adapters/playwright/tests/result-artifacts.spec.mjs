import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCITGMArtifactWriter, failureExcerpt } from '../result-artifacts.mjs';

test('CITGM artifacts preserve complete streams and separate traces from bounded excerpts', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'bnh-artifacts-'));
  const writer = await createCITGMArtifactWriter({ rootDir, module: 'module/name', runId: 'run-1' });
  const stdout = `prefix\n${'x'.repeat(5000)}\n`;
  const stderr = 'Error: upstream failure\nfull stderr detail\n';
  writer.recordProgress({ runId: 'run-1', phase: 'execution', event: 'child-running' });
  await writer.close({ stdout, stderr, networkEvents: [{ url: 'https://example.test', method: 'GET' }] });

  assert.equal(await readFile(writer.paths.stdout, 'utf8'), stdout);
  assert.equal(await readFile(writer.paths.stderr, 'utf8'), stderr);
  assert.deepEqual(JSON.parse(await readFile(writer.paths.progress, 'utf8')), {
    runId: 'run-1', phase: 'execution', event: 'child-running',
  });
  assert.deepEqual(JSON.parse(await readFile(writer.paths.network, 'utf8')), {
    url: 'https://example.test', method: 'GET',
  });
  assert.ok(Buffer.byteLength(failureExcerpt(stdout, 64)) <= 90);
  assert.match(failureExcerpt(stderr, 4096), /upstream failure/);
});
