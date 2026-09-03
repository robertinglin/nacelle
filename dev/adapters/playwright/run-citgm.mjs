#!/usr/bin/env node
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { firefox, chromium } from 'playwright';
import {
  CITGM_ARTIFACT_ROOT,
  compactRunResult,
  createTerminalSummary,
  persistCitgmArtifacts,
  persistTerminalSummary,
} from './citgm-artifacts.mjs';
import { formatProgressLine } from './progress-protocol.mjs';

const adapterRoot = path.dirname(new URL(import.meta.url).pathname);
const browserTypes = { chromium, firefox };

function usage() {
  return 'Usage: node dev/adapters/playwright/run-citgm.mjs [--browser=chromium|firefox] <module> [citgm options]';
}

function parseArgs(rawArgs) {
  let browserName = 'chromium';
  let citgmVersion = process.env.NACELLE_CITGM_VERSION || '10.0.2';
  let timeoutMs = Number(process.env.NACELLE_CITGM_TIMEOUT_MS || 15 * 60 * 1000);
  let module = null;
  const citgmArgs = [];
  let hostOptions = true;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (hostOptions && argument === '--') {
      hostOptions = false;
      continue;
    }
    if (hostOptions && (argument === '--browser' || argument.startsWith('--browser='))) {
      browserName = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : rawArgs[++index];
      continue;
    }
    if (hostOptions && (argument === '--citgm-version' || argument.startsWith('--citgm-version='))) {
      citgmVersion = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : rawArgs[++index];
      continue;
    }
    if (hostOptions && (argument === '--run-timeout' || argument.startsWith('--run-timeout='))) {
      timeoutMs = Number(argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : rawArgs[++index]);
      continue;
    }
    if (!module && !argument.startsWith('-')) {
      module = argument;
      continue;
    }
    citgmArgs.push(argument);
  }

  if (!browserTypes[browserName]) throw new Error(`Unsupported browser "${browserName}". ${usage()}`);
  if (!module) throw new Error(usage());
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--run-timeout must be a positive number of milliseconds');
  return { browserName, citgmVersion, timeoutMs, module, citgmArgs };
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, server) {
  const deadline = Date.now() + 10_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`static server exited with code ${server.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`static server did not become ready: ${lastError}`);
}

function outputCountsFromProgress(progressEvents, stdout, stderr) {
  const counts = {
    stdout: { bytes: 0, chunks: 0 },
    stderr: { bytes: 0, chunks: 0 },
  };
  for (const event of progressEvents) {
    if (event?.event !== 'output-activity' || !counts[event.stream]) continue;
    counts[event.stream].bytes += Number(event.bytes) || 0;
    counts[event.stream].chunks += Number(event.chunks) || 0;
  }
  for (const stream of ['stdout', 'stderr']) {
    if (counts[stream].bytes === 0 && (stream === 'stdout' ? stdout : stderr)) {
      counts[stream].bytes = new TextEncoder().encode(stream === 'stdout' ? stdout : stderr).byteLength;
      counts[stream].chunks = 1;
    }
  }
  return counts;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = await allocatePort();
  const server = spawn(process.execPath, ['server.js', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: adapterRoot,
    env: { ...process.env, BNH_WORKTREE: adapterRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverError = '';
  const progressEvents = [];
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { serverError += chunk; });

  try {
    const url = `http://127.0.0.1:${port}/citgm.html`;
    await waitForServer(url, server);
    const browser = await browserTypes[options.browserName].launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(0);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof globalThis.__NACELLE_CITGM__?.run === 'function');
      await page.exposeBinding('__bnhReportProgress', async (_source, event) => {
        progressEvents.push(event);
        try { process.stderr.write(formatProgressLine(event)); } catch { /* diagnostics cannot affect the run */ }
      });
      process.stdout.write('Starting browser-side CITGM execution...\n');
      const result = await page.evaluate((request) => globalThis.__NACELLE_CITGM__.run(request), {
        module: options.module,
        args: options.citgmArgs,
        timeoutMs: options.timeoutMs,
        citgmVersion: options.citgmVersion,
        browser: options.browserName,
        progress: { binding: '__bnhReportProgress' },
      });
      const completeProgress = Array.isArray(result.progressTrace) && result.progressTrace.length
        ? result.progressTrace : progressEvents;
      const stdout = result.stdout || '';
      const stderr = result.stderr || '';
      const outputCounts = outputCountsFromProgress(completeProgress, stdout, stderr);
      // The bridge owns the run identity. A child result may carry a stale or
      // nested runId, while the progress trace is emitted by this invocation.
      const runId = completeProgress.find((event) => event?.runId)?.runId
        || result.runResult?.runId || `citgm-host-${Date.now()}`;
      const artifacts = await persistCitgmArtifacts({
        root: process.env.NACELLE_CITGM_ARTIFACT_DIR || CITGM_ARTIFACT_ROOT,
        runId,
        stdout,
        stderr,
        progressEvents: completeProgress,
        networkEvents: result.networkEvents || [],
        runResult: result.runResult || null,
        metadata: {
          module: result.module,
          citgmVersion: result.citgmVersion,
          browser: options.browserName,
          timeoutMs: options.timeoutMs,
          precache: result.precache || null,
          install: result.install || null,
          preload: result.preload || null,
        },
      });
      const terminal = createTerminalSummary({
        runId,
        result: { ...result, stdout, stderr },
        stage: completeProgress.at(-1)?.stage || 'completion',
        artifacts,
        progressEvents: completeProgress,
        networkEvents: result.networkEvents || [],
        outputCounts,
      });
      await persistTerminalSummary(artifacts, terminal);
      const primary = {
        module: result.module,
        citgmVersion: result.citgmVersion,
        browser: options.browserName,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        error: result.error || result.runResult?.error || null,
        runResult: compactRunResult(result.runResult, artifacts, outputCounts, {
          progress: completeProgress.length,
          network: result.networkEvents?.length || 0,
        }),
        precache: result.precache || null,
        install: result.install || null,
        preload: result.preload || null,
        progress: result.progress || null,
        network: { count: result.networkEvents?.length || 0, artifact: artifacts.network },
        artifacts,
        terminal,
      };
      // The compact terminal record is intentionally emitted before the
      // complete stream dumps and primary result JSON. Consumers can rely on
      // it even when a verbose trace exceeds their output limit.
      process.stdout.write(`BNH_CITGM_TERMINAL ${JSON.stringify(terminal)}\n`);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      process.stdout.write(`${JSON.stringify(primary)}\n`);
      process.exitCode = result.exitCode === null ? 1 : result.exitCode;
    } finally {
      await browser.close();
    }
  } finally {
    server.kill('SIGTERM');
    if (serverError && server.exitCode !== 0) process.stderr.write(serverError);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
