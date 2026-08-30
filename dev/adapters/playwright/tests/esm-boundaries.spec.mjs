import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

const capabilities = {
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 8 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
  envVars: { allowed: [] },
  proxy: { mode: 'proxy', enabled: true, capability: { proxy: true } },
};

test('preserves a granted proxy adapter for an ESM child', async ({ harnessPage, page }) => {
  await page.evaluate(() => {
    globalThis.__BNH_PROXY_ADAPTER__ = async () => ({ status: 200, body: 'proxy adapter survived' });
  });
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    delete globalThis.__BNH_PROXY_ADAPTER__;
    const mainRequest = http.get('http://main-proxy.test/', (res) => {
      res.resume();
      res.once('end', () => {
        const child = spawn(process.execPath, ['--no-warnings', '/node/proxy-child.mjs']);
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
        child.once('close', (code, signal) => {
          process.stdout.write(JSON.stringify({ mainResponse: res.statusCode, code, signal, output, errorOutput }));
        });
      });
    });
    mainRequest.once('error', (error) => { throw error; });
  `, {
    capabilities,
    proxy: { mode: 'proxy', enabled: true, capability: { proxy: true } },
    files: {
      '/node/proxy-child.mjs': `
        import http from 'node:http';
        const response = await new Promise((resolve, reject) => {
          const request = http.get('http://proxy-child.test/', (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk.toString(); });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
          });
          request.once('error', reject);
        });
        process.stdout.write(JSON.stringify(response));
      `,
    },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    mainResponse: 200,
    code: 0,
    signal: null,
    output: JSON.stringify({ statusCode: 200, body: 'proxy adapter survived' }),
    errorOutput: '',
  });
});

test('reports the Node-like synchronous ERR_REQUIRE_ESM boundary', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, [
      '--no-experimental-require-module',
      '/node/cjs-esm.js',
    ], { encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ status: child.status, signal: child.signal, stderr: child.stderr }));
  `, {
    files: {
      '/node/cjs-esm.js': `eval("require('./package-type-module/cjs.js')");`,
      '/node/package-type-module/cjs.js': 'module.exports = 1;',
      '/node/package-type-module/package.json': '{"type":"module"}',
    },
  });

  await expectPass(expect, result);
  const child = JSON.parse(result.stdout);
  expect(child.status).toBe(1);
  expect(child.signal).toBe(null);
  expect(child.stderr).toContain('Error [ERR_REQUIRE_ESM]: require() of ES Module /node/package-type-module/cjs.js from /node/cjs-esm.js not supported.');
  expect(child.stderr).toContain('Instead either rename cjs.js to end in .cjs, change the requiring code to use dynamic import() which is available in all CommonJS modules, or change "type": "module" to "type": "commonjs" in /node/package-type-module/package.json to treat all .js files as CommonJS (using .mjs for all ES modules instead).');
});
