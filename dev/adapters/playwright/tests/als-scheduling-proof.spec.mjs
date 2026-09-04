import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

// Regression contract for the Next.js dev-server ALS break: a store entered
// before scheduling must stay visible when each scheduling primitive fires,
// inside a same-realm child launched through npm -> shell -> node (the same
// nesting the Next.js demo uses).
const SERVER = `
  const http = require('node:http');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();
  const store = { token: 'request-store' };

  const server = http.createServer((req, res) => {
    const results = [];
    const check = (label) => {
      results.push(label + '=' + (als.getStore() === store ? 'PASS' : 'FAIL'));
    };
    als.run(store, () => {
      check('sync');
      queueMicrotask(() => check('queueMicrotask'));
      setImmediate(() => check('setImmediate'));
      setTimeout(() => check('setTimeout'), 5);
      Promise.resolve().then(() => check('promise-then'));
      (async () => { await Promise.resolve(); check('async-await'); })();
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        check('async-after-timer-await');
        res.end(results.join(' '));
      })();
    });
  });
  server.listen(3100, () => {
    http.get('http://127.0.0.1:3100/', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        console.log('ALS-HTTP ' + body);
        const failed = body.split(' ').filter((entry) => entry.endsWith('FAIL'));
        server.close(() => process.exit(failed.length ? 1 : 0));
      });
    });
  });
`;

const PARENT_ENTRY = `
  const { exec } = require('node:child_process');
  const child = exec('npm run als-check', { cwd: '/node' });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('exit', (code) => {
    setTimeout(() => process.exit(code || 0), 50);
  });
`;

test('ALS store survives request-entry scheduling through npm->shell->node nesting', async ({ harnessPage }) => {
  const result = await harnessPage.run(PARENT_ENTRY, {
    files: {
      '/node/package.json': JSON.stringify({
        name: 'als-check',
        scripts: { 'als-check': 'node server.js' },
      }),
      '/node/server.js': SERVER,
    },
  });
  await expectPass(expect, result);
});
