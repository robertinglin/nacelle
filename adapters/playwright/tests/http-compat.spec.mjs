import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

function commonjsSource(label, body) {
  return `
    (async () => {
      ${body}
    })().catch((error) => {
      console.error('http-compat: ${label}', error?.stack || error);
      process.exitCode = 1;
    });
  `;
}

async function runContract(expectObject, harnessPage, label, body) {
  const result = await harnessPage.run(commonjsSource(label, body));
  await expectPass(expectObject, result);
  return result;
}

test.describe('browser-native http compatibility', () => {
  test('keeps data payload bytes stable when URL query parameters change', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'data-url-query', `
      const assert = require('node:assert');
      const url = new URL('data:text/plain,bnh%20network');
      url.searchParams.set('mode', 'browser');
      const response = await fetch(url);
      assert.strictEqual(await response.text(), 'bnh network');
    `);
  });

  test('supports request/get lifecycle, response metadata, readable bodies, and async iteration', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'request/get', `
      const assert = require('node:assert');
      const http = require('node:http');

      const lifecycle = [];
      const requested = await new Promise((resolve, reject) => {
        const request = http.request('data:text/plain,browser%20http', (response) => {
          lifecycle.push('response');
          assert.strictEqual(response.statusCode, 200);
          assert.strictEqual(response.headers['content-type'], 'text/plain');
          (async () => {
            const chunks = [];
            for await (const chunk of response) chunks.push(chunk.toString('utf8'));
            resolve(chunks.join(''));
          })().catch(reject);
        });
        request.once('finish', () => lifecycle.push('finish'));
        request.once('close', () => lifecycle.push('close'));
        request.once('error', reject);
        request.end();
      });
      assert.strictEqual(requested, 'browser http');
      assert.ok(lifecycle.includes('finish'));
      assert.ok(lifecycle.includes('response'));
      assert.ok(lifecycle.includes('close'));

      const fetched = await new Promise((resolve, reject) => {
        http.get({
          href: 'data:text/plain,browser%20get',
          headers: { 'X-BNH-Request': 'present' },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.once('end', () => resolve(body));
          response.once('error', reject);
        }).once('error', reject);
      });
      assert.strictEqual(fetched, 'browser get');
    `);
  });

  test('propagates AbortSignal cancellation and exposes virtual server boundaries', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'abort/boundaries', `
      const assert = require('node:assert');
      const http = require('node:http');
      const https = require('node:https');

      const controller = new AbortController();
      controller.abort();
      const aborted = await new Promise((resolve) => {
        const request = http.get('data:text/plain,aborted', { signal: controller.signal });
        request.once('error', (error) => resolve(error));
      });
      assert.ok(aborted.name === 'AbortError' || aborted.code === 'ABORT_ERR');

      const server = http.createServer();
      assert.strictEqual(server.listening, false);
      assert.strictEqual(typeof server.listen, 'function');
      server.close();
      const agent = new https.Agent();
      assert.strictEqual(agent.protocol, 'https:');
      agent.destroy();
    `);
  });

  test('maps request timeout to abortable fetch cancellation', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'timeout', `
      const assert = require('node:assert');
      const http = require('node:http');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });

      try {
        const result = await new Promise((resolve, reject) => {
          const request = http.request('data:text/plain,delayed');
          let sawTimeout = false;
          request.setTimeout(5, () => { sawTimeout = true; });
          request.once('error', (error) => resolve({ error, sawTimeout }));
          request.once('close', () => {});
          request.end();
          setTimeout(() => reject(new Error('timeout contract did not finish')), 500);
        });
        assert.strictEqual(result.sawTimeout, true);
        assert.ok(result.error.name === 'TimeoutError' || result.error.code === 'ETIMEDOUT');
      } finally {
        globalThis.fetch = originalFetch;
      }
    `);
  });
});
