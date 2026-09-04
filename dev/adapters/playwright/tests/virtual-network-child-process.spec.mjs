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

test('ESM children route dynamic HTTP imports through the virtual network', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/javascript');
      response.end('export const answer = 42;');
    });
    server.listen(0, () => {
      const target = 'http://localhost:' + server.address().port + '/module.mjs';
      const child = spawn(process.execPath, ['/node/virtual-network-import-child.mjs'], {
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
      '/node/virtual-network-import-child.mjs': `
        const imported = await import(process.env.TARGET_URL);
        process.stdout.write(String(imported.answer));
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: '42',
    errorOutput: '',
  });
});

test('nested CommonJS eval importers use the virtual HTTP loader', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/javascript');
      response.end('export const answer = 42;');
    });
    server.listen(0, '127.0.0.1', () => {
      const target = 'http://127.0.0.1:' + server.address().port + '/index.mjs';
      const child = spawn(process.execPath, ['/node/eval-import-child.cjs'], {
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
      '/node/eval-import-child.cjs': `
        const createDynamicImporter = require('/node/eval-import-helper.cjs');
        createDynamicImporter(process.env.TARGET_URL)
          .then((module) => process.stdout.write(String(module.answer)))
          .catch((error) => { console.error(error); process.exitCode = 1; });
      `,
      '/node/eval-import-helper.cjs': `
        const { URL } = require('node:url');
        function createDynamicImporter(url) {
          return eval('(target) => import(target)')(new URL(url));
        }
        module.exports = createDynamicImporter;
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: '42',
    errorOutput: '',
  });
});

test('VM scripts route dynamic imports through the virtual HTTP loader', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/javascript');
      response.end('export const answer = 43;');
    });
    server.listen(0, '127.0.0.1', () => {
      const target = 'http://127.0.0.1:' + server.address().port + '/index.mjs';
      const child = spawn(process.execPath, ['/node/vm-import-child.cjs'], {
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
      '/node/vm-import-child.cjs': `
        const vm = require('node:vm');
        const dynamicImport = vm.runInNewContext('eval("(url) => import(url)")', { process });
        Promise.resolve().then(() => dynamicImport(process.env.TARGET_URL))
          .then((module) => process.stdout.write(String(module.answer)))
          .catch((error) => { console.error(error); process.exitCode = 1; });
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: '43',
    errorOutput: '',
  });
});

test('VM scripts evaluated in the current context route dynamic imports through the virtual HTTP loader', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/javascript');
      response.end('export const answer = 45;');
    });
    server.listen(0, '127.0.0.1', () => {
      const target = 'http://127.0.0.1:' + server.address().port + '/index.mjs';
      const child = spawn(process.execPath, ['/node/vm-this-context-import-child.cjs'], {
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
      '/node/vm-this-context-import-child.cjs': `
        const vm = require('node:vm');
        const dynamicImport = vm.runInThisContext('eval("(url) => import(url)")');
        dynamicImport(process.env.TARGET_URL)
          .then((module) => process.stdout.write(String(module.answer)))
          .catch((error) => { console.error(error); process.exitCode = 1; });
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: '45',
    errorOutput: '',
  });
});

test('VM Script dynamic imports use the owning process loader by default', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/javascript');
      response.end('export const answer = 48;');
    });
    server.listen(0, '127.0.0.1', () => {
      const target = 'http://127.0.0.1:' + server.address().port + '/index.mjs';
      const child = spawn(process.execPath, ['/node/vm-script-import-child.cjs'], {
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
      '/node/vm-script-import-child.cjs': `
        const vm = require('node:vm');
        const script = new vm.Script(
          'import(process.env.TARGET_URL).then((module) => process.stdout.write(String(module.answer))).catch((error) => { console.error(error); process.exitCode = 1; })',
          { filename: '/node/vm-script-import-child.cjs' },
        );
        script.runInNewContext({ process });
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: '48',
    errorOutput: '',
  });
});

test('VM Script dynamic import callbacks expose a module namespace', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['/node/vm-script-callback-child.cjs']);
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    child.once('close', (code, signal) => process.stdout.write(JSON.stringify({ code, signal, output, errorOutput })));
  `, {
    capabilities,
    files: {
      '/node/vm-script-callback-child.cjs': `
        const vm = require('node:vm');
        (async () => {
          const context = vm.createContext({ process });
          const dependency = new vm.SourceTextModule('export const answer = 49;', { context });
          await dependency.link(() => {});
          await dependency.evaluate();
          const script = new vm.Script(
            'import("virtual").then((module) => process.stdout.write(String(module.answer)))',
            { filename: '/node/vm-script-callback-child.cjs', importModuleDynamically: () => dependency },
          );
          await script.runInContext(context);
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      `,
    },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: '49',
    errorOutput: '',
  });
});

test('Function-constructed imports use the owning CommonJS module loader', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/javascript');
      response.end('export const answer = 46;');
    });
    server.listen(0, '127.0.0.1', () => {
      const target = 'http://127.0.0.1:' + server.address().port + '/index.mjs';
      const child = spawn(process.execPath, ['/node/function-import-child.cjs'], {
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
      '/node/function-import-child.cjs': `
        const dynamicImport = new Function(
          'specifier',
          'return import(specifier)',
        );
        dynamicImport(process.env.TARGET_URL)
          .then((module) => process.stdout.write(String(module.answer)))
          .catch((error) => { console.error(error); process.exitCode = 1; });
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: '46',
    errorOutput: '',
  });
});

test('ESM imports preserve deferred import callbacks from CommonJS dependencies', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/javascript');
      response.end('export const answer = 44;');
    });
    server.listen(0, '127.0.0.1', () => {
      const target = 'http://127.0.0.1:' + server.address().port + '/index.mjs';
      const child = spawn(process.execPath, ['/node/esm-cjs-import-child.mjs'], {
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
      '/node/esm-cjs-import-child.mjs': `
        const deferred = await import('/node/node_modules/deferred-import/index.js');
        const loaded = await deferred.default(process.env.TARGET_URL);
        process.stdout.write(String(loaded.answer));
      `,
      '/node/node_modules/deferred-import/package.json': '{"name":"deferred-import","main":"index.js"}',
      '/node/node_modules/deferred-import/index.js': `
        module.exports = function load(url) {
          return eval('(target) => import(target)')(url);
        };
      `,
    },
    env: { TARGET_URL: 'unused-by-parent' },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 0,
    signal: null,
    output: '44',
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
