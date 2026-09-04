import { expect } from 'playwright/test';
import { browserRuntimeURL, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

const capabilities = {
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 8 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
  envVars: { allowed: ['TARGET_URL'] },
};

test('ESM child processes can reach a parent-owned virtual server', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((request, response) => response.end('parent-server-visible'));
    server.listen(0, () => {
      const target = 'http://localhost:' + server.address().port + '/from-child';
      const child = spawn(process.execPath, ['--no-warnings', '/node/virtual-network-child.mjs'], {
        env: { TARGET_URL: target },
      });
      let output = '';
      let errorOutput = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
      child.once('close', (code, signal) => {
        server.close(() => process.stdout.write(JSON.stringify({ code, signal, output, errorOutput })));
      });
    });
  `, {
    capabilities,
    files: {
      '/node/virtual-network-child.mjs': `
        import http from 'node:http';
        const response = await new Promise((resolve, reject) => {
          const request = http.get(process.env.TARGET_URL, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk.toString(); });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
          });
          request.once('error', reject);
        });
        process.stdout.write(JSON.stringify(response));
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: JSON.stringify({ statusCode: 200, body: 'parent-server-visible' }),
    errorOutput: '',
  });
});

test('CommonJS child processes can reach a parent-owned virtual server', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((request, response) => response.end('parent-server-visible'));
    server.listen(0, () => {
      const target = 'http://localhost:' + server.address().port + '/from-child';
      const child = spawn(process.execPath, ['/node/virtual-network-child.js'], {
        env: { TARGET_URL: target },
      });
      let output = '';
      let errorOutput = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
      child.once('close', (code, signal) => {
        server.close(() => process.stdout.write(JSON.stringify({ code, signal, output, errorOutput })));
      });
    });
  `, {
    capabilities,
    files: {
      '/node/virtual-network-child.js': `
        const http = require('node:http');
        const response = http.get(process.env.TARGET_URL, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => process.stdout.write(JSON.stringify({ statusCode: res.statusCode, body })));
        });
        response.once('error', (error) => { process.stderr.write(error.stack + '\\n'); process.exitCode = 1; });
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: JSON.stringify({ statusCode: 200, body: 'parent-server-visible' }),
    errorOutput: '',
  });
});

test('CommonJS child processes keep their own HTTP server alive through a request', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['/node/virtual-http-child.js']);
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    child.once('close', (code, signal) => process.stdout.write(JSON.stringify({ code, signal, output, errorOutput })));
  `, {
    capabilities,
    files: {
      '/node/virtual-http-child.js': `
        const assert = require('node:assert');
        const http = require('node:http');
        const server = http.createServer((_request, response) => response.end('child-server-visible'));
        assert.ok(server._handle === null);
        server.listen(0, () => {
          assert.ok(server._handle);
          http.get({ host: 'localhost', port: server.address().port, path: '/from-child' }, (response) => {
            let body = '';
            response.on('data', (chunk) => { body += chunk.toString(); });
            response.on('end', () => server.close(() => process.stdout.write(JSON.stringify({ statusCode: response.statusCode, body }))));
          });
        });
        assert.ok(server.address());
        assert.ok(server.address().port > 0);
      `,
    },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: JSON.stringify({ statusCode: 200, body: 'child-server-visible' }),
    errorOutput: '',
  });
});

test('ESM child fetch uses a parent-owned virtual CONNECT proxy', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const proxy = http.createServer();
    proxy.on('connect', (request, response) => {
      response.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
      response.end('HTTP/1.1 200 OK\\r\\nContent-Length: 13\\r\\nConnection: close\\r\\n\\r\\nproxied-child');
    });
    proxy.listen(0, () => {
      const child = spawn(process.execPath, ['--no-warnings', '/node/virtual-fetch-child.mjs'], {
        env: {
          FETCH_URL: 'http://virtual-target.test/through-proxy',
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: 'http://localhost:' + proxy.address().port,
        },
      });
      let output = '';
      let errorOutput = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
      child.once('close', (code, signal) => {
        proxy.close(() => process.stdout.write(JSON.stringify({ code, signal, output, errorOutput })));
      });
    });
  `, {
    capabilities,
    files: {
      '/node/virtual-fetch-child.mjs': `
        const response = await fetch(process.env.FETCH_URL);
        process.stdout.write(await response.text());
      `,
    },
    timeoutMs: 5000,
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: 'proxied-child',
    errorOutput: '',
  });
  expect(result.stderr).toBe('');
});
