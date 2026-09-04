import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compactRunResult,
  createTerminalSummary,
  persistCitgmArtifacts,
  persistTerminalSummary,
} from '../../../adapters/playwright/citgm-artifacts.mjs';

test('CITGM terminal artifacts preserve complete streams and externalize verbose traces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bnh-citgm-artifacts-'));
  try {
    const progressEvents = [
      { runId: 'citgm-test', phase: 'execution', event: 'child-started' },
      { runId: 'citgm-test', phase: 'execution', event: 'output-activity', stream: 'stderr', bytes: 24, chunks: 1 },
    ];
    const networkEvents = [{ source: 'guest-fetch', method: 'GET', url: 'https://example.test/' }];
    const stdout = 'ok - upstream test\n';
    const stderr = 'not ok - upstream test: Error: expected\n';
    const runResult = {
      phase: 'complete',
      details: { network: { events: networkEvents } },
      stdout: new Uint8Array([1, 2, 3]),
      error: {
        name: 'Error',
        code: 'ERR_UPSTREAM',
        message: `large diagnostic ${'x'.repeat(100_000)}`,
        stack: `Error: ${'y'.repeat(100_000)}`,
      },
      detail: 'z'.repeat(100_000),
      outputEvents: Array.from({ length: 500 }, (_value, index) => ({
        event: 'output',
        stream: 'stderr',
        bytes: index,
        url: `https://trace.example.test/${index}`,
      })),
      lifecycleEvents: Array.from({ length: 500 }, () => 'running'),
    };
    const artifacts = await persistCitgmArtifacts({
      root,
      runId: 'citgm-test',
      stdout,
      stderr,
      progressEvents,
      networkEvents,
      runResult,
    });
    const counts = {
      stdout: { bytes: stdout.length, chunks: 1 },
      stderr: { bytes: stderr.length, chunks: 1 },
    };
    const terminal = createTerminalSummary({
      runId: 'citgm-test',
      result: { exitCode: 1, timedOut: false, stdout, stderr },
      stage: 'completion',
      artifacts,
      progressEvents,
      networkEvents,
      outputCounts: counts,
    });
    const compacted = compactRunResult(runResult, artifacts, counts, { progress: 2, network: 1 });

    assert.equal(await readFile(artifacts.stdout, 'utf8'), stdout);
    assert.equal(await readFile(artifacts.stderr, 'utf8'), stderr);
    assert.deepEqual((await readFile(artifacts.network, 'utf8')).trim().split('\n').map(JSON.parse), networkEvents);
    assert.deepEqual((await readFile(artifacts.progress, 'utf8')).trim().split('\n').map(JSON.parse), progressEvents);
    assert.equal(compacted.details.network.events.artifact, artifacts.network);
    assert.equal(compacted.details.network.events.count, 1);
    assert.equal(compacted.outputEvents.count, 500);
    assert.equal(compacted.outputEvents.first.event, 'output');
    assert.equal(compacted.outputEvents.last.bytes, 499);
    assert.equal(compacted.lifecycleEvents.count, 500);
    assert.equal(compacted.lifecycleEvents.first, 'running');
    assert.equal(compacted.error.message.bytes, 100_017);
    assert.equal(compacted.error.stack.bytes, 100_007);
    assert.equal(compacted.detail.bytes, 100_000);
    assert.ok(JSON.stringify(compacted).length < 8_000, 'run-result projection must stay bounded');
    assert.doesNotMatch(JSON.stringify(compacted), /https:\/\/trace\.example\.test/);
    assert.doesNotMatch(JSON.stringify(compacted), /"0"\s*:\s*1/);
    assert.deepEqual(terminal.failureExcerpts.stderr, ['not ok - upstream test: Error: expected']);
    assert.equal(terminal.exit.code, 1);
    assert.equal(terminal.timedOut, false);
    assert.equal(terminal.artifacts.network, artifacts.network);
    const terminalText = JSON.stringify(terminal);
    assert.ok(terminalText.length < 4_000, 'terminal summary must stay compact');
    assert.doesNotMatch(terminalText, /https?:\/\//);
    assert.doesNotMatch(terminalText, /"0"\s*:\s*1/);
    await persistTerminalSummary(artifacts, terminal);
    assert.deepEqual(JSON.parse(await readFile(artifacts.terminalSummary, 'utf8')), terminal);
    const primaryText = JSON.stringify({ runResult: compacted, terminal });
    assert.ok(primaryText.length < 12_000, 'primary terminal projection must stay compact');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
