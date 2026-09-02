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

test('supports synchronous require of an ESM graph when the Node profile enables it', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, ['/node/cjs-requires-esm.js'], { encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }));
  `, {
    files: {
      '/node/cjs-requires-esm.js': `
        const value = require('./package-type-module/synchronous.js');
        const packageValue = require('demo-package');
        if (value.default !== 'default' || value.named !== 'named' || packageValue !== 'main') process.exit(1);
        process.stdout.write(JSON.stringify({ ...value, packageValue }));
      `,
      '/node/package-type-module/synchronous.js': `
        import first from './first.js';
        import second from './second.js';
        export const named = first.value + second;
        export default 'default';
      `,
      '/node/package-type-module/first.js': "export default { value: (() => { return 'na'; })() };",
      '/node/package-type-module/second.js': "export default 'med';",
      '/node/package-type-module/package.json': '{"type":"module"}',
      '/node/node_modules/demo-package/package.json': '{"type":"module","main":"entry.cjs"}',
      '/node/node_modules/demo-package/entry.cjs': "module.exports = 'main';",
      '/node/node_modules/demo-package/index.mjs': "export default 'wrong';",
    },
  });

  await expectPass(expect, result);
  const child = JSON.parse(result.stdout);
  expect(child.status).toBe(0);
  expect(child.signal).toBe(null);
  expect(JSON.parse(child.stdout)).toEqual({ __esModule: true, default: 'default', named: 'named', packageValue: 'main' });
});

test('keeps the owning process environment in a same-realm native ESM graph', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');
    const launch = (label, delay) => new Promise((resolve, reject) => {
      const child = fork('/node/process-env-child.js', [label, String(delay)], {
        env: { ...process.env, BNH_CHILD_ENV: label },
      });
      child.once('error', reject);
      child.once('message', (message) => {
        try {
          assert.deepStrictEqual(message, {
            label,
            before: label,
            after: label,
            pid: message.pid,
          });
          resolve(message);
        } catch (error) {
          reject(error);
        }
      });
    });
    Promise.all([launch('first', 5), launch('second', 0)]).then(
      () => {},
      (error) => {
        console.error(error.stack || error);
        process.exitCode = 1;
      },
    );
  `, {
    files: {
      '/node/process-env-child.js': `
        const label = process.argv[2];
        const delay = Number(process.argv[3]);
        setTimeout(() => {
          import('/node/process-env-route.mjs').then((module) => {
            process.send({ label, before: module.before, after: module.after, pid: module.pid });
          }, (error) => {
            process.send({ error: String(error) });
          });
        }, delay);
      `,
      '/node/process-env-route.mjs': `
        export const pid = process.pid;
        export const before = process.env.BNH_CHILD_ENV;
        await Promise.resolve();
        export const after = process.env.BNH_CHILD_ENV;
      `,
    },
  });

  await expectPass(expect, result);
});
