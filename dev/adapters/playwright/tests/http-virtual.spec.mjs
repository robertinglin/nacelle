import { expect, test } from 'playwright/test';
import { createHttpCompatibility } from '../runtime/http.js';
import { Readable, Writable } from '../runtime/streams.js';

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
  test('supports legacy callable ServerResponse construction', () => {
    const { http } = createHttpCompatibility(globalThis);
    const request = { socket: {}, connection: {} };
    const response = Object.create(http.ServerResponse.prototype);

    http.ServerResponse.call(response, request);

    response.setHeader('x-legacy-constructor', 'present');
    expect(response).toBeInstanceOf(http.ServerResponse);
    expect(response.getHeader('x-legacy-constructor')).toBe('present');
    expect(response.writable).toBe(true);
  });

  test('exposes Node’s complete HTTP method table', () => {
    const { http } = createHttpCompatibility(globalThis);
    expect(http.METHODS).toContain('UNLOCK');
    expect(http.METHODS).toContain('M-SEARCH');
    expect(http.METHODS).toContain('MKCALENDAR');
  });

  test('treats null as an omitted final Writable chunk', () => {
    const writable = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    expect(() => writable.end(null, null, null)).not.toThrow();
  });

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

  test('allows a server handler to complete a loopback client request before its response', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const server = http.createServer((request, response) => {
      if (request.url === '/fetch') {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      const nested = http.get({
        host: 'localhost',
        port: server.address().port,
        path: '/fetch',
      }, (nestedResponse) => {
        const chunks = [];
        nestedResponse.on('data', (chunk) => chunks.push(chunk));
        nestedResponse.once('end', () => {
          response.statusCode = nestedResponse.statusCode;
          response.end(Buffer.concat(chunks).toString());
        });
      });
      nested.once('error', (error) => response.destroy(error));
    });
    await listen(server, 0, '127.0.0.1');

    const response = await get(http, {
      host: 'localhost',
      port: server.address().port,
      path: '/',
    });
    expect(response.statusCode).toBe(200);
    await expect(responseText(response)).resolves.toBe('{"ok":true}');
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

  test('exposes a loopback peer identity on browser-local server requests', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const server = http.createServer((request, response) => {
      response.end(JSON.stringify({
        remoteAddress: request.socket.remoteAddress,
        remoteFamily: request.socket.remoteFamily,
        remotePort: request.socket.remotePort,
      }));
    });
    await listen(server, 0, '127.0.0.1');

    const response = await get(http, {
      host: '127.0.0.1',
      port: server.address().port,
      path: '/peer-identity',
    });
    const peer = JSON.parse(await responseText(response));
    expect(peer.remoteAddress).toBe('127.0.0.1');
    expect(peer.remoteFamily).toBe('IPv4');
    expect(peer.remotePort).toBeGreaterThan(0);
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

  test('destroys the underlying connection when a response fails after headers', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial');
      response.destroy(new Error('response stream failed'));
    });
    await listen(server, 0, '127.0.0.1');

    const terminal = new Promise((resolve, reject) => {
      const request = http.get({
        host: 'localhost',
        port: server.address().port,
        path: '/stream-error',
      }, (response) => {
        response.resume();
        response.once('close', () => resolve(response.statusCode));
        response.once('error', reject);
      });
      request.once('error', reject);
    });

    await expect(terminal).resolves.toBe(200);
    await close(server);
  });

  test('propagates a client abort to the active server response', async () => {
    const { http } = createHttpCompatibility(globalThis);
    let resolveServerClosed;
    const serverClosed = new Promise((resolve) => { resolveServerClosed = resolve; });
    const server = http.createServer((_request, response) => {
      response.once('close', resolveServerClosed);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial');
    });
    await listen(server, 0, '127.0.0.1');
    const request = http.get({
      host: 'localhost',
      port: server.address().port,
      path: '/client-abort',
    }, (response) => {
      response.once('data', () => request.destroy());
    });
    request.once('error', () => {});

    await serverClosed;
    await close(server);
  });

  test('reports ECONNRESET when a client request is destroyed before headers', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const server = http.createServer((_request, response) => {
      setTimeout(() => response.end('late response'), 10);
    });
    await listen(server, 0, '127.0.0.1');

    const error = await new Promise((resolve, reject) => {
      const request = http.get({
        host: 'localhost',
        port: server.address().port,
        path: '/destroy-before-headers',
      });
      request.once('error', resolve);
      request.once('close', () => {
        if (!request.destroyed) reject(new Error('request closed without being destroyed'));
      });
      request.destroy();
    });

    expect(error).toMatchObject({ code: 'ECONNRESET' });
    await close(server);
  });

  test('accepts a new request after aborting a pending streamed response', async () => {
    const { http } = createHttpCompatibility(globalThis);
    let requestNumber = 0;
    const server = http.createServer((_request, response) => {
      requestNumber += 1;
      response.writeHead(200, { 'transfer-encoding': 'chunked' });
      response.write('first');
      setTimeout(() => {
        response.write(requestNumber === 1 ? 'late' : 'second');
        response.end();
      }, 20);
    });
    await listen(server, 0, '127.0.0.1');

    const firstClosed = new Promise((resolve, reject) => {
      let request;
      request = http.get({
        host: 'localhost',
        port: server.address().port,
        path: '/abort-stream',
      }, (response) => {
        response.once('data', () => request.destroy());
        response.once('error', reject);
      });
      request.once('error', (error) => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      request.once('close', resolve);
    });
    await Promise.race([
      firstClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('aborted request did not close')), 1000)),
    ]);

    const second = await get(http, {
      host: 'localhost',
      port: server.address().port,
      path: '/after-abort',
    });
    const secondBody = responseText(second);
    await Promise.race([
      secondBody,
      new Promise((_, reject) => setTimeout(() => reject(new Error('request after abort did not finish')), 1000)),
    ]);
    const body = await secondBody;
    expect({
      body,
      statusCode: second.statusCode,
      complete: second.complete,
      readableEnded: second.readableEnded,
      readableLength: second.readableLength,
      requestNumber,
    }).toEqual({
      body: 'firstsecond',
      statusCode: 200,
      complete: true,
      readableEnded: true,
      readableLength: 0,
      requestNumber: 2,
    });
    await close(server);
  });

  test('closes an async piped response when its client request is destroyed', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const { finished } = await import('../../../../src/runtime/compat.js');
    let requestNumber = 0;
    const server = http.createServer(async (_request, response) => {
      const source = new Readable();
      source._read = () => {};
      requestNumber += 1;
      response.setHeader('content-type', 'text/plain');
      response.setHeader('transfer-encoding', 'chunked');
      finished(source, { readable: true, writable: false }, () => {});
      finished(response, () => {});
      source.push('first');
      source.pipe(response);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
      });
      source.push(requestNumber === 1 ? 'late' : 'second');
      source.push(null);
    });
    await listen(server, 0, '127.0.0.1');

    const firstData = new Promise((resolve, reject) => {
      let request;
      request = http.get({
        host: 'localhost',
        port: server.address().port,
        path: '/abort-async-pipe',
      }, (response) => {
        response.once('data', (chunk) => {
          expect(chunk.toString()).toBe('first');
          request.destroy();
          resolve();
        });
        response.once('error', reject);
      });
      request.once('error', (error) => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      request.once('close', () => {});
    });
    await Promise.race([
      firstData,
      new Promise((_, reject) => setTimeout(() => reject(new Error('async piped response did not stream')), 50)),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await get(http, {
      host: 'localhost',
      port: server.address().port,
      path: '/after-async-pipe-abort',
    });
    await expect(responseText(second)).resolves.toBe('firstsecond');
    expect(requestNumber).toBe(2);
    await close(server);
  });

  test('finishes a response destroyed before a pending drain', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const { finished } = await import('../../../../src/runtime/compat.js');
    let cancelled = false;
    let resolveCancelled;
    const cancelledPromise = new Promise((resolve) => { resolveCancelled = resolve; });
    const server = http.createServer((_request, response) => {
      const source = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        pull() { return new Promise(() => {}); },
        cancel() { cancelled = true; resolveCancelled(); },
      });
      const reader = source.getReader();
      finished(response, () => reader.cancel());
      response.write = () => {
        queueMicrotask(() => { response.destroy(); response.emit('drain'); });
        return false;
      };
      reader.read().then(({ value }) => response.write(value));
    });
    await listen(server, 0, '127.0.0.1');
    const request = http.get({ host: 'localhost', port: server.address().port, path: '/pending-drain' });
    request.once('error', () => {});
    await cancelledPromise;
    expect(cancelled).toBe(true);
    await close(server);
  });

  test('cancels a queued readable stream after its source closes', async () => {
    let pulls = 0;
    let cancelled = 0;
    const source = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([2]));
        controller.close();
      },
      cancel() { cancelled += 1; },
    });
    const reader = source.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel();
    expect(pulls).toBe(1);
    expect(cancelled).toBe(1);
  });

  test('cancels a response stream when drain races response destruction', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const { finished } = await import('../../../../src/runtime/compat.js');
    let cancelCalled = false;
    let resolveCancel;
    const cancelPromise = new Promise((resolve) => { resolveCancel = resolve; });
    const server = http.createServer((_request, response) => {
      const originalWrite = response.write.bind(response);
      let firstWrite = true;
      response.write = function write(chunk, encoding, callback) {
        if (firstWrite) {
          firstWrite = false;
          if (typeof callback === 'function') callback();
          queueMicrotask(() => {
            response.destroy();
            response.emit('drain');
          });
          return false;
        }
        return originalWrite(chunk, encoding, callback);
      };
      const source = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        pull(controller) {
          controller.enqueue(new Uint8Array([2]));
          controller.close();
        },
        cancel() { cancelCalled = true; resolveCancel(); },
      });
      let sourceOpen = true;
      let waitingDrain = false;
      const reader = source.getReader();
      finished(response, () => {
        if (sourceOpen) reader.cancel().catch(() => {});
      });
      const onReadError = () => {
        sourceOpen = false;
        response.destroy();
      };
      const onRead = (result) => {
        if (result.done) {
          sourceOpen = false;
          response.end();
          return;
        }
        if (response.destroyed) {
          sourceOpen = false;
          reader.cancel().catch(() => {});
          return;
        }
        const shouldContinue = response.write(result.value);
        if (!shouldContinue) {
          waitingDrain = true;
          response.once('drain', onDrain);
          return;
        }
        reader.read().then(onRead, onReadError);
      };
      const onDrain = () => {
        if (!waitingDrain || !sourceOpen || response.destroyed) return;
        waitingDrain = false;
        reader.read().then(onRead, onReadError);
      };
      reader.read().then(onRead, onReadError);
    });
    await listen(server, 0, '127.0.0.1');
    const terminal = new Promise((resolve, reject) => {
      const request = http.get({ host: 'localhost', port: server.address().port, path: '/drain-destroy' }, (response) => {
        response.once('close', resolve);
        response.resume();
      });
      request.once('error', (error) => {
        if (error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
    });
    await Promise.race([
      terminal,
      new Promise((_, reject) => setTimeout(() => reject(new Error('response termination timed out')), 1000)),
    ]);
    await Promise.race([
      cancelPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stream cancellation timed out')), 1000)),
    ]);
    expect(cancelCalled).toBe(true);
    await close(server);
  });

  test('forwards a byte web stream through a legacy ServerResponse adapter', async () => {
    const { http } = createHttpCompatibility(globalThis);
    const { ReadableStream } = await import('node:stream/web');
    const { Writable } = await import('node:stream');
    const util = await import('node:util');

    function Response(req) {
      http.ServerResponse.call(this, req);
      this._lightMyRequest = { headers: null, trailers: {}, payloadChunks: [] };
      this.assignSocket(new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(callback); } }));
    }
    util.inherits(Response, http.ServerResponse);
    Response.prototype.write = function write(data, encoding, callback) {
      http.ServerResponse.prototype.write.call(this, data, encoding, callback);
      this._lightMyRequest.payloadChunks.push(Buffer.from(data, encoding));
      return true;
    };
    Response.prototype.end = function end(data, encoding, callback) {
      if (data) this.write(data, encoding);
      http.ServerResponse.prototype.end.call(this, callback);
      this.emit('finish');
      this.destroy();
    };
    Response.prototype.destroy = function destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
    };

    const raw = new Response({ method: 'GET', socket: null, connection: null });
    const payload = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(Buffer.from('web '))); },
      pull(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('response')));
        controller.close();
      },
      type: 'bytes',
    });
    const reader = payload.getReader();
    let sourceOpen = true;
    const onRead = ({ value, done }) => {
      if (done) {
        sourceOpen = false;
        raw.end(null, null, null);
        return;
      }
      raw.write(value);
      reader.read().then(onRead, (error) => { sourceOpen = false; raw.destroy(error); });
    };
    raw.once('close', () => {
      if (sourceOpen) reader.cancel().catch(() => {});
    });
    reader.read().then(onRead);
    await new Promise((resolve) => raw.once('finish', resolve));

    expect(raw.statusCode).toBe(200);
    expect(raw._lightMyRequest.payloadChunks.map((chunk) => chunk.toString())).toEqual(['web ', 'response']);
  });

  test('keeps an async-iterated Node body readable through a byte web stream', async () => {
    const { Readable } = await import('node:stream');
    const { ReadableStream } = await import('node:stream/web');
    const source = new Readable({ read() {} });
    const iterator = source[Symbol.asyncIterator]();
    const body = new ReadableStream({
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value));
      },
      cancel() { source.destroy(); },
      type: 'bytes',
    });
    const reader = body.getReader();
    const first = reader.read();
    source.push(new Uint8Array(Buffer.from('async ')));
    source.push(new Uint8Array(Buffer.from('body')));
    source.push(null);
    expect((await first).value).toEqual(new Uint8Array(Buffer.from('async ')));
    expect((await reader.read()).value).toEqual(new Uint8Array(Buffer.from('body')));
    expect((await reader.read()).done).toBe(true);
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
