#!/usr/bin/env node
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { firefox, chromium } from 'playwright';
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = await allocatePort();
  const server = spawn(process.execPath, ['server.js', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: adapterRoot,
    env: { ...process.env, BNH_WORKTREE: adapterRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverError = '';
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
        try { process.stderr.write(formatProgressLine(event)); } catch { /* diagnostics cannot affect the run */ }
      });
      process.stdout.write('Starting browser-side CITGM execution...\n');
      const result = await page.evaluate((request) => globalThis.__NACELLE_CITGM__.run(request), {
        module: options.module,
        args: options.citgmArgs,
        timeoutMs: options.timeoutMs,
        citgmVersion: options.citgmVersion,
        progress: { binding: '__bnhReportProgress' },
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.stdout.write(`${JSON.stringify({
        module: result.module,
        citgmVersion: result.citgmVersion,
        browser: options.browserName,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        error: result.error || result.runResult?.error || null,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        runResult: result.runResult || null,
        precache: result.precache || null,
        install: result.install || null,
        preload: result.preload || null,
        progress: result.progress || null,
        networkEvents: result.networkEvents || [],
      })}\n`);
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
