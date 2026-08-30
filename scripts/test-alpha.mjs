#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeTestDirectory = path.join(repositoryRoot, 'dev/tests/runtime/runtime');
const browserRoot = path.join(repositoryRoot, 'dev/adapters/playwright');
const requireNative = process.argv.includes('--require-native');
const skipBrowsers = process.argv.includes('--skip-browsers');

function run(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    ...options,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) {
    console.error(`${label} could not start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
    return false;
  }
  return true;
}

const runtimeTests = fs.readdirSync(runtimeTestDirectory)
  .filter((name) => name.endsWith('.mjs'))
  .sort()
  .map((name) => path.join(runtimeTestDirectory, name));

const steps = [
  ['runtime contracts', process.execPath, ['--test', '--test-concurrency=1', ...runtimeTests]],
  ['harness and adapter contracts', path.join(repositoryRoot, 'dev/scripts/self-test.sh'), []],
  ['Node 22 build', process.execPath, [path.join(repositoryRoot, 'scripts/build.mjs'), '--node-version=v22']],
  ['Node 22 artifact validation', process.execPath, [path.join(repositoryRoot, 'scripts/validate-version-support.mjs'), '--node-version=v22']],
  ['Node 22 parity', process.execPath, [
    path.join(repositoryRoot, 'scripts/parity-report.mjs'),
    '--node-version=v22',
    ...(requireNative ? ['--require-native'] : []),
  ]],
  ['Node profile coverage', process.execPath, [
    '--experimental-test-coverage',
    '--test',
    '--test-concurrency=1',
    '--test-coverage-include=src/versions/**',
    '--test-coverage-lines=80',
    '--test-coverage-functions=80',
    '--test-coverage-branches=80',
    path.join(runtimeTestDirectory, 'version-support.mjs'),
  ]],
  ['Nacelle+ extension builds', process.execPath, [path.join(repositoryRoot, 'nacelle-plus/build.mjs')]],
];

for (const [label, command, args] of steps) {
  if (!run(label, command, args)) process.exit(1);
}

if (!skipBrowsers) {
  const playwrightCli = path.join(browserRoot, 'node_modules/playwright/cli.js');
  if (!fs.existsSync(playwrightCli)) {
    console.error('Playwright is not installed; run npm ci --prefix dev/adapters/playwright');
    process.exit(1);
  }
  for (const browser of ['chromium', 'firefox']) {
    if (!run(`${browser} browser workloads`, process.execPath, [
      path.join(browserRoot, 'tests/run-browser-tests.mjs'),
    ], { env: { BNH_BROWSER: browser, BNH_NODE_VERSION: 'v22' } })) process.exit(1);
  }
}

console.log('\nNode 22 alpha gate passed.');
