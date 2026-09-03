import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compactForSummary,
  createCITGMArtifactWriter,
  failureExcerpt,
  outputSummary,
} from '../result-artifacts.mjs';

test('CITGM artifacts preserve complete streams and separate traces from bounded excerpts', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'bnh-artifacts-'));
  const writer = await createCITGMArtifactWriter({ rootDir, module: 'module/name', runId: 'run-1' });
  const stdout = `prefix\n${'x'.repeat(5000)}\n`;
  const stderr = 'Error: upstream failure\nfull stderr detail\n';
  for (let index = 0; index < 64; index += 1) {
    writer.recordProgress({ runId: 'run-1', phase: 'execution', event: 'child-running', sequence: index });
  }
  const summary = compactForSummary({ details: { networkEvents: Array(1000).fill('trace') } });
  await writer.close({
    stdout,
    stderr,
    networkEvents: [{ url: 'https://example.test', method: 'GET' }],
    runResult: { outputEvents: [{ stream: 'stdout', bytes: new Uint8Array([1, 2, 3]) }] },
    summary,
  });

  assert.equal(await readFile(writer.paths.stdout, 'utf8'), stdout);
  assert.equal(await readFile(writer.paths.stderr, 'utf8'), stderr);
  const progressLines = (await readFile(writer.paths.progress, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(progressLines.length, 64);
  assert.equal(progressLines.at(-1).sequence, 63);
  assert.deepEqual(JSON.parse(await readFile(writer.paths.network, 'utf8')), {
    url: 'https://example.test', method: 'GET',
  });
  assert.deepEqual(JSON.parse(await readFile(writer.paths.summary, 'utf8')), {
    details: { networkEvents: { count: 1000 } },
  });
  assert.deepEqual(JSON.parse(await readFile(writer.paths.runResult, 'utf8')).outputEvents[0].bytes, {
    type: 'bytes', byteLength: 3, encoding: 'base64', data: 'AQID',
  });
  assert.deepEqual(JSON.parse(await readFile(writer.paths.terminalSummary, 'utf8')), {
    details: { networkEvents: { count: 1000 } },
  });
  const bounded = compactForSummary({
    outputEvents: Array.from({ length: 10000 }, (_, index) => ({ index, trace: 'x'.repeat(5000) })),
    nested: { details: { networkEvents: ['a', 'b', 'c'] } },
  });
  assert.deepEqual(bounded.outputEvents, { count: 10000 });
  assert.deepEqual(bounded.nested.details.networkEvents, { count: 3 });
  assert.ok(JSON.stringify(bounded).length < 500);
  assert.deepEqual(compactForSummary({ bytes: new Uint8Array(4096) }), { bytes: { bytes: 4096 } });
  assert.deepEqual(outputSummary({ stdout: 'λ\n', stderr: 'x', output: { stdout: { chunks: 7 } } }), {
    stdout: { bytes: 3, chunks: 7 },
    stderr: { bytes: 1, chunks: 1 },
    totalBytes: 4,
    totalChunks: 8,
  });
  assert.deepEqual(outputSummary(
    { stdout: 'abc', stderr: '' },
    { counters: { output: { stdoutChunks: 4, stderrChunks: 2 } } },
  ), {
    stdout: { bytes: 3, chunks: 4 },
    stderr: { bytes: 0, chunks: 2 },
    totalBytes: 3,
    totalChunks: 6,
  });
  assert.deepEqual(outputSummary(
    {},
    { counters: { output: { stdoutBytes: 662, stdoutChunks: 9, stderrBytes: 178, stderrChunks: 1 } } },
  ), {
    stdout: { bytes: 662, chunks: 9 },
    stderr: { bytes: 178, chunks: 1 },
    totalBytes: 840,
    totalChunks: 10,
  });
  assert.ok(Buffer.byteLength(failureExcerpt(stdout, 64)) <= 90);
  assert.match(failureExcerpt(stderr, 4096), /upstream failure/);
});

test('CITGM artifacts retain output already received before a browser failure', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'bnh-artifacts-stream-'));
  const writer = await createCITGMArtifactWriter({ rootDir, module: 'module', runId: 'run-stream' });
  await writer.recordOutput('stdout', 'partial stdout\n');
  await writer.recordOutput('stderr', Uint8Array.from([101, 114, 114, 111, 114, 10]));
  await writer.close({ stdout: 'unavailable fallback', stderr: 'unavailable fallback' });
  assert.equal(await readFile(writer.paths.stdout, 'utf8'), 'partial stdout\n');
  assert.equal(await readFile(writer.paths.stderr, 'utf8'), 'error\n');
});
