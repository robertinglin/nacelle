import assert from 'node:assert/strict';
import test from 'node:test';
import { Nacelle, createNacellePlusAdapter, createNegotiatedTransport, isBrowserFetchFailure } from '../../../../src/index.js';

function messageScope(onPostMessage) {
  let listener = null;
  const scope = {
    addEventListener(_type, callback) { listener = callback; },
    removeEventListener(_type, callback) { if (listener === callback) listener = null; },
    postMessage(message, _origin, transfer) { onPostMessage(message, transfer, (event) => listener?.(event)); },
  };
  return scope;
}

test('Nacelle+ page adapter round-trips a request over the message bridge', async () => {
  let posted;
  const scope = messageScope((message, _transfer, respond) => {
    posted = message;
    queueMicrotask(() => respond({
      data: {
        source: 'nacelle-plus-extension',
        requestId: message.requestId,
        response: { ok: true, status: 204, headers: {}, body: new ArrayBuffer(0) },
      },
    }));
  });
  const adapter = createNacellePlusAdapter({ globalObject: scope, timeout: 100 });
  const response = await adapter.request({ target: 'https://api.example.test/health', method: 'GET' });

  assert.equal(posted.source, 'nacelle-plus-page');
  assert.equal(posted.request.operation, 'request');
  assert.equal(posted.request.target, 'https://api.example.test/health');
  assert.equal(response.status, 204);
  adapter.close();
});

test('negotiated transport uses native fetch before privileged fallback', async () => {
  let nativeCalls = 0;
  let fallbackCalls = 0;
  const nativeScope = {
    fetch: async () => {
      nativeCalls += 1;
      return new Response('native');
    },
  };
  const transport = createNegotiatedTransport({
    globalObject: nativeScope,
    adapter: { request: async () => { fallbackCalls += 1; return new Response('privileged'); } },
  });

  await assert.doesNotReject(() => transport.request({ target: 'https://api.example.test/normal' }));
  assert.equal(nativeCalls, 1);
  assert.equal(fallbackCalls, 0);
});

test('negotiated transport falls back only for browser network failures', async () => {
  let fallbackCalls = 0;
  const transport = createNegotiatedTransport({
    globalObject: { fetch: async () => { throw new TypeError('Failed to fetch'); } },
    adapter: { request: async () => { fallbackCalls += 1; return new Response('privileged'); } },
  });
  const response = await transport.request({ target: 'https://api.example.test/cors' });
  assert.equal(await response.text(), 'privileged');
  assert.equal(fallbackCalls, 1);
  assert.equal(isBrowserFetchFailure(new TypeError('Failed to fetch')), true);
  assert.equal(isBrowserFetchFailure(Object.assign(new Error('cancelled'), { name: 'AbortError' })), false);
});

test('Nacelle installs Nacelle+ as the existing HTTP proxy capability', async () => {
  let calls = 0;
  const node = await Nacelle.create({
    gateway: false,
    nacellePlus: {
      fallback: false,
      adapter: {
        request: async (request) => {
          calls += 1;
          assert.equal(request.target, 'https://api.example.test/data');
          return new Response('from-nacelle-plus', { status: 200, headers: { 'x-transport': 'plus' } });
        },
      },
    },
  });
  const child = await node.execute(`
    const https = require('node:https');
    https.get('https://api.example.test/data', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => process.stdout.write(response.statusCode + ':' + response.headers['x-transport'] + ':' + body));
    }).on('error', (error) => { console.error(error); process.exitCode = 1; });
  `);
  assert.equal(await child.exit, 0);
  assert.equal(await child.stdoutText(), '200:plus:from-nacelle-plus');
  assert.equal(calls, 1);
  assert.equal(node.transport.mode, 'negotiated');
});
