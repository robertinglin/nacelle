import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const policySource = fs.readFileSync(new URL('../../../../nacelle-plus/extension/policy.js', import.meta.url), 'utf8');
const backgroundSource = fs.readFileSync(new URL('../../../../nacelle-plus/extension/background.js', import.meta.url), 'utf8');

function loadPolicy() {
  const context = { ArrayBuffer, TextEncoder, URL };
  vm.runInNewContext(`${policySource}\nglobalThis.__policy = NacellePlusPolicy;`, context);
  return context.__policy;
}

function backgroundHarness(initialGrants, fetchImpl) {
  let onConnect;
  let onMessage;
  let grants = initialGrants;
  const removedPermissions = [];
  const permissions = {
    contains: async () => true,
    remove: async (value) => { removedPermissions.push(value); },
  };
  const browser = {
    runtime: {
      id: 'nacelle-plus-test',
      getURL: (path) => `moz-extension://nacelle-plus-test/${path}`,
      onMessage: { addListener: (listener) => { onMessage = listener; } },
      onConnect: { addListener: (listener) => { onConnect = listener; } },
    },
    storage: {
      local: {
        get: async () => ({ nacellePlusGrants: grants }),
        set: async (value) => { grants = value.nacellePlusGrants; },
      },
    },
    permissions,
  };
  const context = {
    browser,
    importScripts: () => {},
    ArrayBuffer,
    TextEncoder,
    URL,
    Headers,
    Response,
    ReadableStream,
    AbortController,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(`${policySource}\n${backgroundSource}`, context);
  return {
    connect(port) { onConnect(port); },
    manage(message, sender) { return onMessage(message, sender, () => {}); },
    grants: () => grants,
    removedPermissions,
  };
}

function testPort(sender) {
  let onMessage;
  let onDisconnect;
  const messages = [];
  return {
    name: 'nacelle-plus-transport-v1',
    sender,
    messages,
    onMessage: { addListener: (listener) => { onMessage = listener; } },
    onDisconnect: { addListener: (listener) => { onDisconnect = listener; } },
    postMessage(message) {
      messages.push(message);
      if (message.type === 'response-chunk') queueMicrotask(() => onMessage({
        type: 'chunk-ack', requestId: message.requestId, sequence: message.sequence,
      }));
    },
    disconnect() { onDisconnect?.(); },
    async send(message) { return onMessage(message); },
  };
}

test('Nacelle+ policy rejects hostile URLs, headers, and private targets by default', () => {
  const policy = loadPolicy();
  assert.equal(policy.validateRequest({ target: 'javascript:alert(1)', headers: {} }).error.code, 'ERR_INVALID_URL');
  assert.equal(policy.validateRequest({ target: 'https://api.example.test', headers: { Cookie: 'secret' } }).error.code, 'ERR_NACELLE_PLUS_FORBIDDEN_HEADER');
  assert.equal(policy.validateRequest({ target: 'https://api.example.test', headers: { Authorization: 'ok\r\nX-Evil: yes' } }).error.code, 'ERR_NACELLE_PLUS_HEADERS');
  assert.equal(policy.isPrivateOrigin('http://127.0.0.1:8080'), true);
  assert.equal(policy.isPrivateOrigin('http://[::ffff:127.0.0.1]:8080'), true);
  assert.equal(policy.isPrivateOrigin('https://api.example.test'), false);
});

test('Nacelle+ strips authorization and rechecks every redirect destination', () => {
  const policy = loadPolicy();
  const next = policy.redirectTarget(
    'https://api.example.test/start',
    { status: 302, headers: new Headers({ location: 'https://evil.example.test/collect' }) },
    { method: 'GET', headers: { Authorization: 'Bearer secret', Accept: 'text/plain' } },
  );
  assert.equal(next.target, 'https://evil.example.test/collect');
  assert.equal(next.headers.Authorization, undefined);
  assert.equal(next.headers.Accept, 'text/plain');
});

test('hostile redirect cannot escape the stored origin grant', async () => {
  const calls = [];
  const harness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async (target) => {
    calls.push(target);
    return new Response(null, { status: 302, headers: { location: 'https://evil.example.test/collect' } });
  });
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/' },
  });
  harness.connect(port);
  await port.send({
    type: 'request', version: 1, requestId: 'req-redirect',
    request: { target: 'https://api.example.test/start', method: 'GET', headers: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const error = port.messages.find((message) => message.type === 'response-error');
  assert.deepEqual(calls, ['https://api.example.test/start']);
  assert.equal(error.response.error.code, 'ERR_NACELLE_PLUS_PERMISSION_REQUIRED');
  assert.equal(error.response.error.details.targetOrigin, 'https://evil.example.test');
});

test('hostile frames are rejected before Nacelle+ performs a request', async () => {
  let calls = 0;
  const harness = backgroundHarness({}, async () => { calls += 1; return new Response('bad'); });
  let disconnected = false;
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 2,
    tab: { id: 7, url: 'https://app.example.test/' },
  });
  port.onDisconnect.addListener(() => { disconnected = true; });
  harness.connect(port);
  assert.equal(disconnected, true);
  assert.equal(calls, 0);
});

test('Nacelle+ streams response chunks through the port with acknowledgements', async () => {
  const harness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      controller.enqueue(new TextEncoder().encode('second'));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/plain' } }));
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/' },
  });
  harness.connect(port);
  await port.send({
    type: 'request', version: 1, requestId: 'req-stream',
    request: { target: 'https://api.example.test/stream', method: 'GET', headers: {} },
  });
  assert.deepEqual(port.messages.map((message) => message.type), [
    'response-start', 'response-chunk', 'response-chunk', 'response-end',
  ]);
});

test('Nacelle+ cancellation reaches the extension fetch signal', async () => {
  let aborted = false;
  const harness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async (_target, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  }));
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/' },
  });
  harness.connect(port);
  const pending = port.send({
    type: 'request', version: 1, requestId: 'req-cancel',
    request: { target: 'https://api.example.test/slow', method: 'GET', headers: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await port.send({ type: 'cancel', requestId: 'req-cancel' });
  await pending;
  assert.equal(aborted, true);
});

test('Nacelle+ grants are inspectable and revocable', async () => {
  const harness = backgroundHarness({}, async () => new Response('unused'));
  const uiSender = {
    id: 'nacelle-plus-test',
    url: 'moz-extension://nacelle-plus-test/popup.html',
  };
  const grant = await harness.manage({
    type: 'nacelle-plus-request', operation: 'grant',
    pageOrigin: 'https://app.example.test', targetOrigin: 'https://api.example.test',
  }, uiSender);
  assert.equal(grant.ok, true);
  const listed = await harness.manage({ type: 'nacelle-plus-request', operation: 'list' }, uiSender);
  assert.equal(listed.grants.length, 1);
  assert.equal(listed.grants[0].targets.length, 1);
  assert.equal(listed.grants[0].targets[0].targetOrigin, 'https://api.example.test');
  assert.equal(listed.grants[0].targets[0].allowPrivate, false);
  const revoked = await harness.manage({
    type: 'nacelle-plus-request', operation: 'revoke',
    pageOrigin: 'https://app.example.test', targetOrigin: 'https://api.example.test',
  }, uiSender);
  assert.equal(revoked.ok, true);
  assert.equal(Object.keys(harness.grants()).length, 0);
  assert.equal(harness.removedPermissions.length, 1);
  assert.equal(harness.removedPermissions[0].origins[0], 'https://api.example.test/*');
});

test('Nacelle+ rejects an oversized response before reading its body', async () => {
  const harness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async () => new Response(null, {
    status: 200,
    headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
  }));
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/' },
  });
  harness.connect(port);
  await port.send({
    type: 'request', version: 1, requestId: 'req-large',
    request: { target: 'https://api.example.test/large', method: 'GET', headers: {} },
  });
  const error = port.messages.find((message) => message.type === 'response-error');
  assert.equal(error.response.error.code, 'ERR_NACELLE_PLUS_RESPONSE_TOO_LARGE');
});
