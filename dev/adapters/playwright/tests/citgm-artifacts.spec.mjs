import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  compactRunResult,
  createTerminalSummary,
  persistCitgmArtifacts,
  persistTerminalSummary,
} from '../citgm-artifacts.mjs';

test('persists complete child output while keeping terminal records bounded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bnh-citgm-artifacts-'));
  try {
    const runId = 'artifact-contract';
    const largeUrl = 'https://trace.example/raw?payload=';
    const childStdout = `${largeUrl}${'stdout,'.repeat(20_000)}`;
    const childStderr = `AssertionError: ${largeUrl}${'stderr,'.repeat(20_000)}`;
    const childOutputs = [{
      entry: '/node_modules/tool/bin.js',
      argv: ['bin.js'],
      code: 1,
      stdout: childStdout,
      stderr: childStderr,
    }];
    const progressEvents = Array.from({ length: 2_000 }, (_, index) => ({
      event: 'progress', index, bytes: new Uint8Array([index % 255]),
      url: `${largeUrl}${index}`,
    }));
    const networkEvents = Array.from({ length: 2_000 }, (_, index) => ({
      url: `${largeUrl}${index}`,
      body: new Uint8Array([index % 255]),
    }));
    const runResult = {
      runId,
      exit: { code: 1, signal: null, reason: 'exit' },
      error: { name: 'Error', message: childStderr },
      outputEvents: progressEvents,
      lifecycleEvents: progressEvents,
      networkEvents,
      details: { child_outputs: childOutputs },
    };
    const artifacts = await persistCitgmArtifacts({
      root,
      runId,
      stdout: 'outer stdout\n',
      stderr: 'outer stderr\n',
      progressEvents,
      networkEvents,
      childOutputs,
      runResult,
    });
    const summary = createTerminalSummary({
      runId,
      result: { exitCode: 1, timedOut: false, stdout: 'outer stdout\n', stderr: 'outer stderr\n', runResult },
      stage: 'completion',
      artifacts,
      progressEvents,
      networkEvents,
      childOutputs,
    });
    await persistTerminalSummary(artifacts, summary);

    const childArtifact = await readFile(artifacts.childOutput, 'utf8');
    assert.ok(childArtifact.includes(childStdout));
    assert.ok(childArtifact.includes(childStderr));
    assert.ok((await readFile(artifacts.runResult, 'utf8')).includes(childStdout));

    const terminalText = await readFile(artifacts.terminalSummary, 'utf8');
    assert.ok(terminalText.length < 10_000, `terminal summary was ${terminalText.length} bytes`);
    assert.ok(!terminalText.includes(largeUrl));
    assert.ok(!terminalText.includes('"body":[0,'));
    const terminal = JSON.parse(terminalText);
    assert.equal(terminal.artifacts.childOutput, artifacts.childOutput);
    assert.equal(terminal.output.childOutputChunks, 1);
    assert.ok(terminal.failureExcerpts.stderr.length > 0);

    const compact = compactRunResult(runResult, artifacts, {
      stdout: { bytes: 13, chunks: 1 },
      stderr: { bytes: 13, chunks: 1 },
    }, { progress: progressEvents.length, network: networkEvents.length });
    const compactText = JSON.stringify(compact);
    assert.ok(compactText.length < 10_000, `compact result was ${compactText.length} bytes`);
    assert.equal(compact.details.child_outputs.count, 1);
    assert.equal(compact.details.child_outputs.artifact, artifacts.childOutput);
    assert.ok(!compactText.includes(childStdout));
    assert.ok(!compactText.includes(childStderr));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
