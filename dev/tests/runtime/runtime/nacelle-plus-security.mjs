import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const policySource = fs.readFileSync(new URL('../../../../nacelle-plus/extension/policy.js', import.meta.url), 'utf8');
const backgroundSource = fs.readFileSync(new URL('../../../../nacelle-plus/extension/background.js', import.meta.url), 'utf8');
const contentScriptSource = fs.readFileSync(new URL('../../../../nacelle-plus/extension/content-script.js', import.meta.url), 'utf8');

function loadPolicy() {
  const context = { ArrayBuffer, TextEncoder, URL };
  vm.runInNewContext(`${policySource}\nglobalThis.__policy = NacellePlusPolicy;`, context);
  return context.__policy;
}

function backgroundHarness(initialGrants, fetchImpl) {
  let onConnect;
  let onMessage;
  let onPermissionsRemoved;
  let grants = initialGrants;
  const removedPermissions = [];
  const permissions = {
    contains: async () => true,
    remove: async (value) => {
      removedPermissions.push(value);
      onPermissionsRemoved?.(value);
    },
    onRemoved: { addListener: (listener) => { onPermissionsRemoved = listener; } },
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
    removePermission(value) { onPermissionsRemoved?.(value); },
  };
}

function testPort(sender, { autoAck = true } = {}) {
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
      if (autoAck && message.type === 'response-chunk') queueMicrotask(() => onMessage({
        type: 'chunk-ack', requestId: message.requestId, sequence: message.sequence,
      }));
    },
    disconnect() { onDisconnect?.(); },
    async send(message) { return onMessage(message); },
  };
}

function contentScriptHarness() {
  let pageListener;
  let portListener;
  const pageMessages = [];
  const portMessages = [];
  const port = {
    onMessage: { addListener: (listener) => { portListener = listener; } },
    onDisconnect: { addListener: () => {} },
    postMessage(message) { portMessages.push(message); },
  };
  const windowObject = {
    location: { origin: 'https://app.example.test' },
    addEventListener: (type, listener) => { if (type === 'message') pageListener = listener; },
    postMessage: (message) => { pageMessages.push(message); },
  };
  const browser = { runtime: { connect: () => port } };
  vm.runInNewContext(contentScriptSource, {
    browser,
    window: windowObject,
    location: windowObject.location,
    ArrayBuffer,
    setInterval: () => {},
    setTimeout,
    clearTimeout,
  });
  return { pageListener, pageMessages, portListener, portMessages, windowObject };
}

test('Nacelle+ policy rejects hostile URLs, headers, and private targets by default', () => {
  const policy = loadPolicy();
  for (const target of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,secret', 'blob:https://app.example.test/id']) {
    assert.equal(policy.validateRequest({ target, headers: {} }).error.code, 'ERR_INVALID_URL');
  }
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

test('Nacelle+ revocation aborts an active request and external permission removal invalidates grants', async () => {
  let aborted = false;
  const harness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async (_target, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  }));
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/' },
  });
  harness.connect(port);
  port.send({
    type: 'request', version: 1, requestId: 'req-revoke',
    request: { target: 'https://api.example.test/slow', method: 'GET', headers: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const uiSender = { id: 'nacelle-plus-test', url: 'moz-extension://nacelle-plus-test/popup.html' };
  await harness.manage({
    type: 'nacelle-plus-request', operation: 'revoke',
    pageOrigin: 'https://app.example.test', targetOrigin: 'https://api.example.test',
  }, uiSender);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
  assert.equal(port.messages.at(-1).response.error.code, 'ERR_NACELLE_PLUS_GRANT_REVOKED');

  const secondHarness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async () => new Response('unused'));
  secondHarness.removePermission({ origins: ['https://api.example.test/*'] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(secondHarness.grants(), {});
});

test('Nacelle+ disables private browsing sessions', () => {
  const harness = backgroundHarness({}, async () => new Response('must not run'));
  let disconnected = false;
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/', incognito: true },
  });
  port.onDisconnect.addListener(() => { disconnected = true; });
  harness.connect(port);
  assert.equal(disconnected, true);
});

test('Nacelle+ stops reading when a page does not acknowledge a chunk', async () => {
  let readCount = 0;
  const harness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => {
          readCount += 1;
          return { done: false, value: new TextEncoder().encode('chunk') };
        },
      }),
    },
  }));
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/' },
  }, { autoAck: false });
  harness.connect(port);
  port.send({
    type: 'request', version: 1, requestId: 'req-backpressure',
    request: { target: 'https://api.example.test/stream', method: 'GET', headers: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(readCount, 1);
  port.disconnect();
});

test('Nacelle+ content bridge waits for the page before acknowledging chunks', () => {
  const harness = contentScriptHarness();
  harness.portListener({
    type: 'response-chunk', requestId: 'req-content', sequence: 1, body: new ArrayBuffer(1),
  });
  assert.equal(harness.pageMessages.length, 1);
  assert.equal(harness.portMessages.some((message) => message.type === 'chunk-ack'), false);
  harness.pageListener({
    source: harness.windowObject,
    origin: 'https://app.example.test',
    data: {
      source: 'nacelle-plus-page', version: 1, type: 'chunk-ack', requestId: 'req-content', sequence: 1,
    },
  });
  assert.equal(harness.portMessages.at(-1).type, 'chunk-ack');
  assert.equal(harness.portMessages.at(-1).requestId, 'req-content');
  assert.equal(harness.portMessages.at(-1).sequence, 1);
});

test('Nacelle+ enforces a per-page concurrency budget', async () => {
  const harness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async (_target, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/' },
  });
  harness.connect(port);
  for (let index = 0; index < 9; index += 1) {
    port.send({
      type: 'request', version: 1, requestId: `req-budget-${index}`,
      request: { target: `https://api.example.test/slow-${index}`, method: 'GET', headers: {} },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  const error = port.messages.find((message) => message.requestId === 'req-budget-8');
  assert.equal(error.response.error.code, 'ERR_NACELLE_PLUS_CONCURRENCY_LIMIT');
  port.disconnect();
});

test('Nacelle+ enforces a global concurrency budget across pages', async () => {
  const pageOrigins = Array.from({ length: 7 }, (_value, index) => `https://app-${index}.example.test`);
  const grants = Object.fromEntries(pageOrigins.map((pageOrigin) => [pageOrigin, ['https://api.example.test']]));
  let calls = 0;
  const harness = backgroundHarness(grants, async (_target, options) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  });
  const ports = pageOrigins.map((pageOrigin, pageIndex) => {
    const port = testPort({
      id: 'nacelle-plus-test',
      url: `${pageOrigin}/`,
      frameId: 0,
      tab: { id: pageIndex + 1, url: `${pageOrigin}/` },
    });
    harness.connect(port);
    return port;
  });
  ports.forEach((port, pageIndex) => {
    for (let requestIndex = 0; requestIndex < 8; requestIndex += 1) {
      port.send({
        type: 'request', version: 1, requestId: `req-global-${pageIndex}-${requestIndex}`,
        request: { target: `https://api.example.test/slow-${pageIndex}-${requestIndex}`, method: 'GET', headers: {} },
      });
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rejected = ports.flatMap((port) => port.messages).filter((message) => message.type === 'response-error');
  assert.equal(calls, 50);
  assert.equal(rejected.length, 6);
  assert.equal(rejected.every((message) => message.response.error.code === 'ERR_NACELLE_PLUS_CONCURRENCY_LIMIT'), true);
  ports.forEach((port) => port.disconnect());
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

test('Nacelle+ bounds response metadata before exposing it to the page', async () => {
  const harness = backgroundHarness({
    'https://app.example.test': ['https://api.example.test'],
  }, async () => new Response(null, {
    status: 200,
    headers: { 'x-large': 'x'.repeat(64 * 1024 + 1) },
  }));
  const port = testPort({
    id: 'nacelle-plus-test',
    url: 'https://app.example.test/',
    frameId: 0,
    tab: { id: 7, url: 'https://app.example.test/' },
  });
  harness.connect(port);
  await port.send({
    type: 'request', version: 1, requestId: 'req-metadata-large',
    request: { target: 'https://api.example.test/metadata', method: 'GET', headers: {} },
  });
  const error = port.messages.find((message) => message.type === 'response-error');
  assert.equal(error.response.error.code, 'ERR_NACELLE_PLUS_RESPONSE_METADATA_TOO_LARGE');
});
