import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../../../src/runtime/gateway-sw.js', import.meta.url), 'utf8');
for (const pathname of ['/runtime.js', '/index.js', '/versions/index.js', '/versions/v22/profile.js']) {
  test(`worker dependency ${pathname} does not wait for its initializing client`, () => {
    const listeners = new Map();
    let clientLookups = 0;
    let intercepted = false;
    const context = vm.createContext({
      URL,
      self: {
        location: new URL('http://example.test/runtime/gateway-sw.js'),
        addEventListener: (name, callback) => listeners.set(name, callback),
        clients: { get: () => { clientLookups += 1; return new Promise(() => {}); } },
      },
    });
    vm.runInContext(source, context);
    listeners.get('fetch')({
      request: { url: `http://example.test${pathname}`, referrer: 'http://example.test/runtime/process-entry.js' },
      clientId: 'initializing-worker',
      respondWith: () => { intercepted = true; },
    });
    assert.equal(clientLookups, 0, 'an initializing worker client cannot be awaited');
    assert.equal(intercepted, false, 'runtime dependencies must load directly from the host');
  });
}

for (const pathname of ['/gateway-sw.js', '/runtime/gateway-sw.js']) {
  test(`WebSocket bootstrap bypasses virtual HTTP routing for ${pathname}`, async () => {
    const listeners = new Map();
    const location = new URL(pathname, 'http://example.test');
    const context = vm.createContext({
      URL, Headers, Response,
      self: {
        location,
        addEventListener: (name, callback) => listeners.set(name, callback),
        clients: {
          get: async () => ({ url: 'http://example.test/__vhost__/3000/' }),
          matchAll: async () => [],
        },
      },
    });
    vm.runInContext(source, context);
    let intercepted;
    const request = {
      url: new URL('gateway-websocket-client.js', location).href,
      referrer: 'http://example.test/__vhost__/3000/',
    };
    listeners.get('fetch')({ request, clientId: 'preview', respondWith: value => { intercepted = value; } });
    assert.equal(intercepted, undefined, 'the bootstrap must load from the host server');
    listeners.get('fetch')({ request: { ...request, url: 'http://example.test/app.js' }, clientId: 'preview', respondWith: value => { intercepted = value; } });
    assert.equal((await intercepted).status, 502, 'application scripts still go to the virtual server');
  });
}
