#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

export const MANIFEST_URL = new URL('../dev/adapters/playwright/citgm-top-100.json', import.meta.url);
const CITGM_RUNNER = new URL('../dev/adapters/playwright/run-citgm.mjs', import.meta.url);
const DEFAULT_RESULTS_DIR = '/tmp/nacelle-citgm-top-100';

export function selectEntries(manifest, { from = 1, to = manifest?.packages?.length || 0 } = {}) {
  const packages = Array.isArray(manifest?.packages) ? manifest.packages : [];
  const maxRank = packages.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > maxRank) {
    throw new RangeError(`rank range must be between 1 and ${maxRank}: ${from}-${to}`);
  }
  return packages.filter(({ rank }) => rank >= from && rank <= to);
}

function usage() {
  return [
    'Usage: node scripts/run-citgm-top-100.mjs [options]',
    '',
    'Options:',
    '  --browser=chromium|firefox  Browser engine (default: chromium)',
    '  --from=N                    First inclusive manifest rank (default: 1)',
    '  --to=N                      Last inclusive manifest rank (default: 100)',
    '  --results-dir=PATH          Artifact and sweep-summary directory',
  '  --run-timeout=MS            Per-package browser timeout',
  '  --resume                    Skip ranks already recorded in summary.json',
  '  --stop-on-failure           Stop after the first failed package or gate (default)',
  '  --continue-on-failure       Continue after a failed package or gate',
  '  --verbose                   Forward each child progress line to the terminal',
  '  --dry-run                   Print the selected package commands only',
  ].join('\n');
}

function readOption(args, index, name) {
  const argument = args[index];
  if (argument === name) return { value: args[index + 1], nextIndex: index + 1 };
  if (argument.startsWith(`${name}=`)) return { value: argument.slice(name.length + 1), nextIndex: index };
  return null;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseArgs(args) {
  const options = {
    browser: 'chromium',
    from: 1,
    to: 100,
    resultsDir: DEFAULT_RESULTS_DIR,
    runTimeout: Number(process.env.NACELLE_CITGM_TIMEOUT_MS || 15 * 60 * 1000),
    resume: false,
    stopOnFailure: true,
    verbose: false,
    dryRun: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') throw new Error(usage());
    if (argument === '--resume') { options.resume = true; continue; }
    if (argument === '--stop-on-failure') { options.stopOnFailure = true; continue; }
    if (argument === '--continue-on-failure') { options.stopOnFailure = false; continue; }
    if (argument === '--verbose') { options.verbose = true; continue; }
    if (argument === '--dry-run') { options.dryRun = true; continue; }
    const browser = readOption(args, index, '--browser');
    if (browser) { options.browser = browser.value; index = browser.nextIndex; continue; }
    const from = readOption(args, index, '--from');
    if (from) { options.from = parsePositiveInteger(from.value, '--from'); index = from.nextIndex; continue; }
    const to = readOption(args, index, '--to');
    if (to) { options.to = parsePositiveInteger(to.value, '--to'); index = to.nextIndex; continue; }
    const resultsDir = readOption(args, index, '--results-dir');
    if (resultsDir) { options.resultsDir = path.resolve(resultsDir.value); index = resultsDir.nextIndex; continue; }
    const runTimeout = readOption(args, index, '--run-timeout');
    if (runTimeout) { options.runTimeout = parsePositiveInteger(runTimeout.value, '--run-timeout'); index = runTimeout.nextIndex; continue; }
    throw new Error(`unknown option: ${argument}\n\n${usage()}`);
  }
  if (!['chromium', 'firefox'].includes(options.browser)) throw new Error(`unsupported browser: ${options.browser}`);
  if (!Number.isInteger(options.runTimeout) || options.runTimeout <= 0) throw new Error('--run-timeout must be a positive integer');
  return options;
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_URL, 'utf8'));
  const packages = Array.isArray(manifest.packages) ? manifest.packages : [];
  if (manifest.schemaVersion !== 1 || packages.length !== 100) throw new Error('top-100 manifest must contain exactly 100 packages');
  const names = new Set();
  for (const [index, entry] of packages.entries()) {
    if (entry.rank !== index + 1 || typeof entry.name !== 'string' || !entry.name || names.has(entry.name)) {
      throw new Error(`invalid top-100 manifest entry at index ${index}`);
    }
    names.add(entry.name);
  }
  return manifest;
}

async function readSummary(summaryPath) {
  try {
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    return Array.isArray(summary.results) ? summary : { results: [] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { results: [] };
    throw error;
  }
}

function terminalFromOutput(output) {
  const line = output.split('\n').find((item) => item.startsWith('BNH_CITGM_TERMINAL '));
  if (!line) return null;
  try { return JSON.parse(line.slice('BNH_CITGM_TERMINAL '.length)); } catch { return null; }
}

function runOne(entry, options, total) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn(process.execPath, [
      CITGM_RUNNER.pathname,
      `--browser=${options.browser}`,
      `--run-timeout=${options.runTimeout}`,
      entry.name,
    ], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      env: { ...process.env, NACELLE_CITGM_ARTIFACT_DIR: options.resultsDir },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let stdout = '';
    const collect = (chunk, stream) => {
      const text = String(chunk);
      if (stream === 'stdout') stdout += text;
      if (options.verbose) process[stream].write(text);
    };
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.once('error', (error) => resolve({ entry, exitCode: 1, error: String(error?.stack || error), terminal: null }));
    child.once('exit', (code, signal) => {
      const terminal = terminalFromOutput(stdout);
      const outcome = code === 0 ? 'passed' : 'failed';
      const endedAt = new Date().toISOString();
      process.stdout.write(`CITGM_TOP_100 ${JSON.stringify({ rank: entry.rank, name: entry.name, outcome, completed: `${entry.rank}/${total}`, runId: terminal?.runId || null, durationMs: Date.now() - startedMs })}\n`);
      resolve({
        entry,
        startedAt,
        endedAt,
        durationMs: Date.now() - startedMs,
        exitCode: code ?? 1,
        signal: signal || null,
        outcome,
        runId: terminal?.runId || null,
        artifactDirectory: terminal?.artifacts?.directory || null,
        error: terminal?.error || null,
      });
    });
  });
}

function safePackageDirectoryName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+$/, '_');
}

function runGate({ name, args, cwd, logPath, verbose }) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn(name, args, {
      cwd,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk, stream) => {
      const text = String(chunk);
      output += text;
      if (verbose) process[stream].write(text);
    };
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    const finish = (exitCode, signal, error = null) => {
      const outcome = exitCode === 0 ? 'passed' : 'failed';
      const endedAt = new Date().toISOString();
      writeFile(logPath, output, 'utf8').catch(() => {});
      process.stdout.write(`CITGM_TOP_100_GATE ${JSON.stringify({ name: name === process.execPath ? args.join(' ') : args.slice(0, 2).join(' '), outcome, durationMs: Date.now() - startedMs, logPath })}\n`);
      resolve({
        name,
        args,
        startedAt,
        endedAt,
        durationMs: Date.now() - startedMs,
        exitCode: exitCode ?? 1,
        signal: signal || null,
        outcome,
        logPath,
        error: error ? String(error?.stack || error) : null,
      });
    };
    child.once('error', (error) => finish(1, null, error));
    child.once('exit', (code, signal) => finish(code ?? 1, signal));
  });
}

async function runGates(entry, options) {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const gateDirectory = path.join(options.resultsDir, 'gates', `rank-${String(entry.rank).padStart(3, '0')}-${safePackageDirectoryName(entry.name)}`);
  await mkdir(gateDirectory, { recursive: true });
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const gates = [
    { name: 'build', args: ['run', 'build', '--', '--node-version=v22'] },
    { name: 'npm-test', args: ['test'] },
    { name: 'browser-e2e', args: ['run', 'test:browser:chromium'] },
  ];
  const results = [];
  for (const gate of gates) {
    const result = await runGate({
      name: npmCommand,
      args: gate.args,
      cwd: root,
      logPath: path.join(gateDirectory, `${gate.name}.log`),
      verbose: options.verbose,
    });
    results.push({ ...result, gate: gate.name });
    if (result.outcome !== 'passed') break;
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest();
  const selected = selectEntries(manifest, { from: options.from, to: options.to });
  await mkdir(options.resultsDir, { recursive: true });
  const summaryPath = path.join(options.resultsDir, 'summary.json');
  const prior = options.resume ? await readSummary(summaryPath) : { results: [] };
  const completedRanks = new Set(prior.results.filter(({ outcome }) => outcome === 'passed').map(({ rank }) => rank));
  const entries = selected.filter(({ rank }) => !options.resume || !completedRanks.has(rank));
  const summary = {
    schemaVersion: 1,
    manifest: new URL('../dev/adapters/playwright/citgm-top-100.json', import.meta.url).pathname,
    browser: options.browser,
    selectedRange: { from: options.from, to: options.to },
    results: [...prior.results],
  };
  if (options.dryRun) {
    for (const entry of entries) process.stdout.write(`${entry.rank}\t${entry.name}\n`);
    return;
  }
  for (const entry of entries) {
    process.stdout.write(`CITGM_TOP_100_START ${entry.rank}/100 ${entry.name}\n`);
    const result = await runOne(entry, options, 100);
    const gates = result.outcome === 'passed' ? await runGates(entry, options) : [];
    const gateFailure = gates.find(({ outcome }) => outcome !== 'passed');
    const outcome = result.outcome === 'passed' && !gateFailure ? 'passed' : 'failed';
    summary.results = [...summary.results.filter(({ rank }) => rank !== entry.rank), {
      rank: entry.rank,
      name: entry.name,
      outcome,
      failureStage: result.outcome !== 'passed' ? 'citgm' : (gateFailure ? gateFailure.gate : null),
      startedAt: result.startedAt || null,
      endedAt: result.endedAt || new Date().toISOString(),
      durationMs: result.durationMs || null,
      exitCode: result.exitCode,
      signal: result.signal || null,
      runId: result.runId || null,
      artifactDirectory: result.artifactDirectory || null,
      error: result.error || null,
      gates,
    }].sort((left, right) => left.rank - right.rank);
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    if (outcome !== 'passed' && options.stopOnFailure) break;
  }
  const passed = summary.results.filter(({ outcome }) => outcome === 'passed').length;
  const failed = summary.results.filter(({ outcome }) => outcome !== 'passed').length;
  process.stdout.write(`CITGM_TOP_100_SUMMARY ${JSON.stringify({ summaryPath, selected: entries.length, passed, failed })}\n`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
