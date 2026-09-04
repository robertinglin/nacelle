#!/usr/bin/env node
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { firefox, chromium } from 'playwright';
import { allocateHostPort } from './host-port.mjs';
import {
  CITGM_ARTIFACT_ROOT,
  compactRunResult,
  createTerminalSummary,
  persistCitgmArtifacts,
  persistTerminalSummary,
} from './citgm-artifacts.mjs';
import { launchBrowser } from './adapter-core.mjs';
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
  const port = await allocateHostPort();
  const server = spawn(process.execPath, ['server.js', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: adapterRoot,
    env: { ...process.env, BNH_WORKTREE: adapterRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverError = '';
  const progressEvents = [];
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { serverError += chunk; });
  const loopbackServers = new Map();
  const loopbackSockets = new Map();
  let nextLoopbackId = 1;
  let nextLoopbackSocketId = 1;

  try {
    const url = `http://127.0.0.1:${port}/citgm.html`;
  await waitForServer(url, server);
  const browser = await launchBrowser(browserTypes[options.browserName], options.browserName);
  let browserCdp = null;
  try {
    const page = await browser.newPage();
      page.setDefaultTimeout(0);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof globalThis.__NACELLE_CITGM__?.run === 'function');
      const artifactRoot = path.resolve(process.env.NACELLE_CITGM_ARTIFACT_DIR || CITGM_ARTIFACT_ROOT);
      const traceSources = new Map();
      let traceWrites = Promise.resolve();
      let networkEventCount = 0;
      const browserDiagnostics = [];
      const queueTrace = (runId, filename, value) => {
        const id = String(runId || `browser-${Date.now()}`);
        const file = path.join(artifactRoot, id, filename);
        const source = traceSources.get(id) || {};
        source[filename] = file;
        traceSources.set(id, source);
        traceWrites = traceWrites.then(async () => {
          await mkdir(path.dirname(file), { recursive: true });
          await appendFile(file, value, 'utf8');
        }).catch(() => {});
        return traceWrites;
      };
      const latestTraceSources = (runId) => {
        const source = traceSources.get(String(runId)) || {};
        return {
          stdout: source['stdout.log'],
          stderr: source['stderr.log'],
          progress: source['progress.jsonl'],
          network: source['network.jsonl'],
        };
      };
      await page.exposeBinding('__bnhReportProgress', async (_source, event) => {
        progressEvents.push(event);
        await queueTrace(event?.runId, 'progress.jsonl', `${JSON.stringify(event)}\n`);
        try { process.stderr.write(formatProgressLine(event)); } catch { /* diagnostics cannot affect the run */ }
      });
      await page.exposeBinding('__bnhReportNetwork', async (_source, payload) => {
        const events = Array.isArray(payload?.events) ? payload.events : [payload];
        for (const item of events) {
          networkEventCount += 1;
          await queueTrace(item?.runId, 'network.jsonl', `${JSON.stringify(item?.event || item)}\n`);
        }
      });
      await page.exposeBinding('__bnhReportOutput', async (_source, payload) => {
        const events = Array.isArray(payload?.events) ? payload.events : [payload];
        for (const item of events) {
          const stream = item?.stream === 'stderr' ? 'stderr' : 'stdout';
          await queueTrace(item?.runId, `${stream}.log`, String(item?.text || ''));
        }
      });
      await page.exposeBinding('__bnhFetchExternal', async (_source, request = {}) => {
        const response = await fetch(String(request.url || ''), {
          method: String(request.method || 'GET'),
          headers: request.headers || {},
          body: request.body === undefined ? undefined : Uint8Array.from(request.body),
          redirect: 'follow',
        });
        return {
          url: response.url,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          bodyBytes: [...new Uint8Array(await response.arrayBuffer())],
        };
      });
      page.on('crash', () => { browserDiagnostics.push({ event: 'page-crash' }); });
      if (options.browserName === 'chromium') {
        try {
          browserCdp = await browser.newBrowserCDPSession();
          await browserCdp.send('Target.setDiscoverTargets', { discover: true });
          browserCdp.on('Target.targetCrashed', (payload) => {
            browserDiagnostics.push({
              event: 'browser-target-crashed',
              targetId: String(payload?.targetId || '').slice(0, 128) || null,
              status: String(payload?.status || '').slice(0, 64) || null,
              errorCode: Number.isInteger(payload?.errorCode) ? payload.errorCode : null,
            });
          });
        } catch {
          // Browser-level CDP diagnostics are optional and must not affect the run.
        }
        try {
          const cdp = await page.context().newCDPSession(page);
          cdp.on('Target.targetCrashed', (payload) => {
            browserDiagnostics.push({
              event: 'target-crashed',
              status: String(payload?.status || '').slice(0, 64) || null,
              errorCode: Number.isInteger(payload?.errorCode) ? payload.errorCode : null,
            });
          });
        } catch {
          // CDP diagnostics are optional and must not affect the run.
        }
      }
      page.on('pageerror', (error) => {
        browserDiagnostics.push({
          event: 'page-error',
          name: String(error?.name || 'Error').slice(0, 64),
          message: String(error?.message || error).slice(0, 512),
        });
      });
      browser.on('disconnected', () => { browserDiagnostics.push({ event: 'browser-disconnected' }); });
      const deliverLoopback = (id, event, value) => page.evaluate(({ id: targetId, event: targetEvent, value: targetValue }) => {
        return globalThis.__BNH_EXTERNAL_TCP_DELIVER__?.(targetId, targetEvent, targetValue) || false;
      }, { id: String(id), event, value });
      await page.exposeBinding('__bnhOpenLoopback', async (_source, request = {}) => {
        const id = String(nextLoopbackId++);
        const server = net.createServer((socket) => {
          const socketId = `${id}:${nextLoopbackSocketId++}`;
          loopbackSockets.set(socketId, socket);
          let delivery = deliverLoopback(id, 'connect', {
            listenerId: id,
            socketId,
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            localAddress: socket.localAddress,
            localPort: socket.localPort,
          });
          socket.on('data', (chunk) => {
            delivery = Promise.resolve(delivery).then(() => deliverLoopback(socketId, 'data', [...chunk]));
          });
          socket.on('end', () => {
            delivery = Promise.resolve(delivery).then(() => deliverLoopback(socketId, 'end'));
          });
          socket.on('close', () => {
            loopbackSockets.delete(socketId);
            delivery = Promise.resolve(delivery).then(() => deliverLoopback(socketId, 'close'));
          });
          socket.on('error', () => {});
        });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(Number(request.port), String(request.address || '127.0.0.1'), resolve);
        });
        loopbackServers.set(id, server);
        return { id };
      });
      await page.exposeBinding('__bnhWriteLoopback', async (_source, request = {}) => {
        const socket = loopbackSockets.get(String(request.id));
        if (!socket) return false;
        if (request.operation === 'data') {
          socket.write(Uint8Array.from(request.bytes || []));
        } else if (request.operation === 'end') {
          socket.end();
        } else if (request.operation === 'close') {
          socket.destroy();
        }
        return true;
      });
      await page.exposeBinding('__bnhCloseLoopback', async (_source, request = {}) => {
        const id = String(request.id);
        loopbackServers.get(id)?.close();
        loopbackServers.delete(id);
        for (const [socketId, socket] of loopbackSockets) {
          if (socketId.startsWith(`${id}:`)) {
            socket.destroy();
            loopbackSockets.delete(socketId);
          }
        }
      });
      process.stdout.write('Starting browser-side CITGM execution...\n');
      let result;
      try {
        result = await page.evaluate((request) => globalThis.__NACELLE_CITGM__.run(request), {
          module: options.module,
          args: options.citgmArgs,
          timeoutMs: options.timeoutMs,
          citgmVersion: options.citgmVersion,
          browser: options.browserName,
          progress: { binding: '__bnhReportProgress' },
          capture: {
            progressBinding: '__bnhReportProgress',
            networkBinding: '__bnhReportNetwork',
            outputBinding: '__bnhReportOutput',
          },
        });
      } catch (error) {
        await traceWrites;
        const runId = progressEvents.find((event) => event?.runId)?.runId
          || `citgm-browser-failure-${Date.now()}`;
        const sources = latestTraceSources(runId);
        const stdout = sources.stdout ? await readFile(sources.stdout, 'utf8').catch(() => '') : '';
        const stderr = sources.stderr ? await readFile(sources.stderr, 'utf8').catch(() => '') : '';
        const failure = {
          module: options.module,
          citgmVersion: options.citgmVersion,
          exitCode: 1,
          timedOut: false,
          error: {
            name: error?.name || 'Error',
            message: String(error?.message || error),
            code: error?.code || 'ERR_BROWSER_RUNTIME',
          },
          stdout,
          stderr,
          runResult: null,
        };
        const outputCounts = outputCountsFromProgress(progressEvents, stdout, stderr);
        const artifacts = await persistCitgmArtifacts({
          root: artifactRoot,
          runId,
          stdout,
          stderr,
          progressEvents,
          networkEvents: [],
          runResult: null,
          traceSources: sources,
          metadata: {
            module: options.module,
            citgmVersion: options.citgmVersion,
            browser: options.browserName,
            timeoutMs: options.timeoutMs,
            browserFailure: true,
            browserDiagnostics,
          },
        });
        const terminal = createTerminalSummary({
          runId,
          result: failure,
          stage: progressEvents.at(-1)?.stage || 'browser-failure',
          artifacts,
          progressEvents,
          networkEventCount,
          outputCounts,
        });
        await persistTerminalSummary(artifacts, terminal);
        process.stdout.write(`BNH_CITGM_TERMINAL ${JSON.stringify(terminal)}\n`);
        process.stderr.write(`${error?.stack || error}\n`);
        process.exitCode = 1;
        return;
      }
      await traceWrites;
      const completeProgress = Array.isArray(result.progressTrace) && result.progressTrace.length
        ? result.progressTrace : progressEvents;
      const stdout = result.stdout || '';
      const stderr = result.stderr || '';
      const outputCounts = outputCountsFromProgress(completeProgress, stdout, stderr);
      // The bridge owns the run identity. A child result may carry a stale or
      // nested runId, while the progress trace is emitted by this invocation.
      const runId = completeProgress.find((event) => event?.runId)?.runId
        || result.runResult?.runId || `citgm-host-${Date.now()}`;
      const childOutputs = Array.isArray(result.runResult?.details?.child_outputs)
        ? result.runResult.details.child_outputs
        : Array.isArray(result.runResult?.childOutputs) ? result.runResult.childOutputs : [];
      const artifacts = await persistCitgmArtifacts({
        root: process.env.NACELLE_CITGM_ARTIFACT_DIR || CITGM_ARTIFACT_ROOT,
        runId,
        stdout,
        stderr,
        progressEvents: completeProgress,
        networkEvents: result.networkEvents || [],
        traceSources: latestTraceSources(runId),
        childOutputs,
        runResult: result.runResult || null,
        metadata: {
          module: result.module,
          citgmVersion: result.citgmVersion,
          browser: options.browserName,
          timeoutMs: options.timeoutMs,
          precache: result.precache || null,
          install: result.install || null,
          preload: result.preload || null,
          browserDiagnostics,
        },
      });
      const terminal = createTerminalSummary({
        runId,
        result: { ...result, stdout, stderr },
        stage: completeProgress.at(-1)?.stage || 'completion',
        artifacts,
        progressEvents: completeProgress,
        networkEvents: result.networkEvents || [],
        networkEventCount,
        childOutputs,
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
          network: networkEventCount || result.networkEvents?.length || 0,
        }),
        precache: result.precache || null,
        install: result.install || null,
        preload: result.preload || null,
        progress: result.progress || null,
        network: { count: networkEventCount || result.networkEvents?.length || 0, artifact: artifacts.network },
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
      await browserCdp?.detach?.().catch?.(() => {});
      for (const socket of loopbackSockets.values()) socket.destroy();
      for (const server of loopbackServers.values()) server.close();
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
