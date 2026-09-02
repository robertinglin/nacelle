import { expect, test } from 'playwright/test';
import { createHttpCompatibility } from '../runtime/http.js';

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString('utf8'); });
    request.once('end', () => resolve(body));
    request.once('error', reject);
  });
}

function get(http, input, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(input, options, resolve);
    request.once('error', reject);
  });
}

function request(http, input, options, body) {
  return new Promise((resolve, reject) => {
    const client = http.request(input, options, resolve);
    client.once('error', reject);
    client.end(body);
  });
}

function responseText(response) {
  return new Promise((resolve, reject) => {
    let body = '';
    response.on('data', (chunk) => { body += new TextDecoder().decode(chunk); });
    response.once('end', () => resolve(body));
    response.once('error', reject);
  });
}

test.describe('browser-native virtual HTTP compatibility', () => {
  test('routes Node-shaped requests to an in-memory server and accepts an Agent', async () => {
    const { http: baseHttp } = createHttpCompatibility(globalThis);
    const { http } = createHttpCompatibility(globalThis);
    const server = http.createServer(async (request, response) => {
      const body = await requestBody(request);
      response.writeHead(201, { 'x-request-method': request.method });
      baseHttp.OutgoingMessage.prototype.setHeader.call(
        response,
        'Set-Cookie',
        ['first=one; Path=/', 'second=two; Path=/'],
      );
      response.end(`${request.url}|${request.headers['x-client']}|${body}`);
    });
    await listen(server, 0, '127.0.0.1');

    const address = server.address();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
    const response = await request(http, {
      host: 'localhost',
      port: address.port,
      path: '/echo?mode=virtual',
      method: 'POST',
      headers: { 'x-client': 'present' },
      agent,
    }, undefined, 'browser body');

    expect(response.statusCode).toBe(201);
    expect(response.headers['x-request-method']).toBe('POST');
    expect(response.headers['set-cookie']).toEqual(['first=one; Path=/', 'second=two; Path=/']);
    await expect(responseText(response)).resolves.toBe('/echo?mode=virtual|present|browser body');
    expect(server).toBeInstanceOf(http.Server);
    expect(agent.keepAlive).toBe(true);
    expect(agent.maxSockets).toBe(2);
    await close(server);
  });

  test('supports https-shaped virtual servers and preserves fetch fallback by default', async () => {
    const fetchCalls = [];
    const scope = Object.create(globalThis);
    scope.fetch = async (input) => {
        fetchCalls.push(String(input));
        return new Response('fetch fallback', { status: 200 });
    };
    const { http, https } = createHttpCompatibility(scope);
    const server = https.createServer((request, response) => response.end(`secure:${request.url}`));
    await listen(server, 0, '127.0.0.1');

    const response = await get(https, {
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/secure',
      agent: new https.Agent({ keepAlive: true }),
    });
    await expect(responseText(response)).resolves.toBe('secure:/secure');
    expect(https.globalAgent).toBeInstanceOf(https.Agent);

    const fallback = await get(http, 'data:text/plain,fallback');
    await expect(responseText(fallback)).resolves.toBe('fetch fallback');
    expect(fetchCalls).toEqual(['data:text/plain,fallback']);
    await close(server);
  });

  test('runs implicit header hooks before ending a response', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const server = http.createServer((_request, response) => {
      const writeHead = response.writeHead;
      response.writeHead = function onHeadersWriteHead(...args) {
        this.setHeader('x-implicit-header-hook', 'ran');
        return writeHead.apply(this, args);
      };
      response.end('body');
    });
    await listen(server, 0, '127.0.0.1');

    const response = await get(http, {
      host: '127.0.0.1',
      port: server.address().port,
      path: '/implicit-headers',
    });
    expect(response.headers['x-implicit-header-hook']).toBe('ran');
    await expect(responseText(response)).resolves.toBe('body');
    await close(server);
  });

  test('uses a proxy only when explicitly enabled and capability-granted', async () => {
    const notOptedIn = createHttpCompatibility(globalThis, {
      proxy: { adapter: () => ({ status: 200 }), capability: { proxy: true } },
    }).https;
    await expect(get(notOptedIn, 'https://example.test/blocked'))
      .rejects.toMatchObject({ code: 'ERR_PROXY_NOT_OPTED_IN' });

    const notGranted = createHttpCompatibility(globalThis, {
      proxy: { mode: 'proxy', enabled: true, adapter: () => ({ status: 200 }) },
    }).https;
    await expect(get(notGranted, 'https://example.test/blocked'))
      .rejects.toMatchObject({ code: 'ERR_CAPABILITY_DENIED' });

    const calls = [];
    const compatible = createHttpCompatibility(globalThis, {
      proxy: {
        mode: 'proxy',
        enabled: true,
        capability: { proxy: true },
        adapter: (request) => {
          calls.push(request);
          return { status: 202, headers: { 'x-proxy': 'yes' }, body: 'proxied body' };
        },
      },
    });
    const response = await get(compatible.https, 'https://example.test/proxied');
    expect(response.statusCode).toBe(202);
    expect(response.headers['x-proxy']).toBe('yes');
    await expect(responseText(response)).resolves.toBe('proxied body');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'request',
      target: 'https://example.test/proxied',
      method: 'GET',
    });
  });

  test('reads a browser Response returned by an explicit proxy', async () => {
    const calls = [];
    const compatible = createHttpCompatibility(globalThis, {
      proxy: {
        mode: 'proxy',
        enabled: true,
        capability: { proxy: true },
        adapter: (request) => {
          calls.push(request);
          return new Response('response body', {
            status: 203,
            headers: { 'x-proxy': 'response' },
          });
        },
      },
    });

    const server = compatible.http.createServer((_request, response) => response.end('virtual body'));
    await listen(server, 0, '127.0.0.1');
    const response = await get(compatible.http, {
      hostname: 'localhost',
      port: server.address().port,
      path: '/proxied',
    });
    expect(response.statusCode).toBe(203);
    expect(response.headers['x-proxy']).toBe('response');
    await expect(responseText(response)).resolves.toBe('response body');
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toContain('/proxied');
    await close(server);
  });
});
