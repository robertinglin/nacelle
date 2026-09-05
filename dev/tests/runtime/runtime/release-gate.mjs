import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const gateUrl = new URL('../../../../scripts/test-alpha.mjs', import.meta.url);
const source = readFileSync(gateUrl, 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('import.meta.url', JSON.stringify(gateUrl.href));

function runGate(argv, failedCommand) {
  const calls = [];
  const exit = new Error('gate exited');
  let exitCode = 0;
  try {
    vm.runInNewContext(source, {
      fs: { readdirSync: () => ['contract.mjs'], existsSync: () => true },
      path,
      fileURLToPath,
      process: {
        argv, execPath: process.execPath, env: {},
        exit(code) { exitCode = code; throw exit; },
      },
      console: { log() {}, error() {} },
      spawnSync(command, args, options) {
        calls.push({ command, args: Array.from(args), options });
        return { status: args.some((arg) => arg.endsWith(failedCommand)) ? 1 : 0 };
      },
    });
  } catch (error) {
    if (error !== exit) throw error;
  }
  return { calls, exitCode };
}

test('release gate runs runtime and browser checks without Python harness tests', () => {
  const { calls, exitCode } = runGate(['--require-native']);
  assert.equal(exitCode, 0);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(({ command }) => command === process.execPath));
  assert.ok(calls.every(({ args }) => !args.some((arg) => /python|self-test/.test(arg))));
  assert.ok(calls.some(({ args }) => args.includes('--test')));
  const parity = calls.find(({ args }) => args[0].endsWith('/parity-report.mjs'));
  assert.ok(parity.args.includes('--require-native'));
  const browsers = calls.filter(({ args }) => args[0].endsWith('/run-browser-tests.mjs'));
  assert.deepEqual(browsers.map(({ options }) => options.env.BNH_BROWSER), ['chromium', 'firefox']);
});

test('release gate still stops when a runtime build fails', () => {
  const { calls, exitCode } = runGate([], '/build.mjs');
  assert.equal(exitCode, 1);
  assert.ok(calls.at(-1).args[0].endsWith('/build.mjs'));
  assert.ok(!calls.some(({ args }) => args[0].endsWith('/run-browser-tests.mjs')));
});
