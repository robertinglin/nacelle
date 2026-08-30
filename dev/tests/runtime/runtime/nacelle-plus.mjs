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
    if (message.type !== 'request') return;
    posted = message;
    queueMicrotask(() => respond({
      data: {
        source: 'nacelle-plus-extension',
        type: 'response-start',
        requestId: message.requestId,
        response: { status: 200, headers: {} },
      },
    }));
    queueMicrotask(() => respond({
      data: { source: 'nacelle-plus-extension', type: 'response-chunk', requestId: message.requestId, sequence: 1, body: new TextEncoder().encode('streamed').buffer },
    }));
    queueMicrotask(() => respond({
      data: { source: 'nacelle-plus-extension', type: 'response-end', requestId: message.requestId },
    }));
  });
  const adapter = createNacellePlusAdapter({ globalObject: scope, timeout: 100 });
  const response = await adapter.request({ target: 'https://api.example.test/health', method: 'GET', headers: {} });

  assert.equal(posted.source, 'nacelle-plus-page');
  assert.equal(posted.type, 'request');
  assert.equal(posted.request.target, 'https://api.example.test/health');
  assert.equal(response.status, 200);
  assert.equal(await new Response(response.body).text(), 'streamed');
  adapter.close();
});

test('Nacelle+ reports a deterministic error when the extension bridge is lost', async () => {
  const scope = messageScope((message, _transfer, respond) => {
    if (message.type !== 'request') return;
    queueMicrotask(() => respond({
      data: {
        source: 'nacelle-plus-extension',
        type: 'response-error',
        requestId: message.requestId,
        response: { ok: false, error: { code: 'ERR_NACELLE_PLUS_TRANSPORT_LOST', message: 'extension restarted' } },
      },
    }));
  });
  const adapter = createNacellePlusAdapter({ globalObject: scope, timeout: 100 });
  await assert.rejects(
    adapter.request({ target: 'https://api.example.test/restart', headers: {} }),
    { code: 'ERR_NACELLE_PLUS_TRANSPORT_LOST' },
  );
  adapter.close();
});

test('Nacelle+ propagates aborts across the page bridge', async () => {
  let cancelled;
  const scope = messageScope((message) => {
    if (message.type === 'cancel') cancelled = message.requestId;
  });
  const adapter = createNacellePlusAdapter({ globalObject: scope, timeout: 100 });
  const controller = new AbortController();
  const pending = adapter.request({ target: 'https://api.example.test/slow', headers: {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.match(cancelled, /^nacelle-plus-/);
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
    proxy: { mode: 'proxy', enabled: true, capability: { proxy: true } },
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

test('Nacelle+ transport stays outside the runtime without an explicit grant', async () => {
  let calls = 0;
  const node = await Nacelle.create({
    gateway: false,
    nacellePlus: {
      fallback: false,
      adapter: { request: async () => { calls += 1; return new Response('should not run'); } },
    },
  });
  const child = await node.execute(`
    const https = require('node:https');
    https.get('https://api.example.test/blocked', () => process.exitCode = 0)
      .on('error', () => process.exitCode = 1);
  `);
  assert.equal(await child.exit, 1);
  assert.equal(calls, 0);
});
