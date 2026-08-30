import assert from 'node:assert/strict';
import test from 'node:test';
import { createNegotiatedTransport } from '../../../../src/index.js';

const BASE_URL = 'https://transport.example.test';

function response(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    statusText: init.statusText,
    headers: init.headers,
  });
}

function streamingResponse(chunks, init = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return response(stream, init);
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function fixtureHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return { ...headers };
}

async function fixtureFetch(input, init = {}, privileged = false) {
  const target = new URL(String(input));
  if (target.pathname === '/cors' && !privileged) throw new TypeError('Failed to fetch');
  if (init.signal?.aborted) {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }

  if (target.pathname === '/redirect') {
    if (init.redirect === 'manual') return response(null, { status: 302, headers: { location: `${BASE_URL}/final` } });
    return fixtureFetch(`${BASE_URL}/final`, init, privileged);
  }
  if (target.pathname === '/final') return response('redirected', { headers: { 'x-fixture': 'final' } });
  if (target.pathname === '/headers') {
    return response('headers', { headers: { 'x-repeat': 'one, two', 'x-request-method': init.method || 'GET' } });
  }
  if (target.pathname === '/auth') {
    return response(null, { status: headerValue(init.headers, 'authorization') ? 204 : 401 });
  }
  if (target.pathname === '/binary') return response(new Uint8Array([0, 1, 2, 127, 255]), { headers: { 'content-type': 'application/octet-stream' } });
  if (target.pathname === '/stream') return streamingResponse(['one\n', 'two\n', 'three\n'], { headers: { 'content-type': 'text/plain' } });
  if (target.pathname === '/sse') return streamingResponse(['data: first\n\n', 'data: second\n\n'], { headers: { 'content-type': 'text/event-stream' } });
  if (target.pathname === '/compression') return response('compressed fixture bytes', { headers: { 'content-encoding': 'gzip' } });
  if (target.pathname === '/large') return response(new Uint8Array(256 * 1024).fill(65));
  if (target.pathname === '/no-content') return response(null, { status: 204 });
  if (target.pathname === '/not-modified') return response(null, { status: 304 });
  if (target.pathname === '/malformed') throw new TypeError('malformed response');
  return response('ok');
}

function requestInit(request) {
  return {
    method: request.method || 'GET',
    headers: request.headers,
    redirect: request.redirect,
    signal: request.signal,
    body: request.body,
  };
}

async function snapshot(requester, request) {
  try {
    const result = await requester(request);
    const body = new Uint8Array(await result.arrayBuffer());
    return {
      kind: 'response',
      status: result.status,
      statusText: result.statusText,
      headers: fixtureHeaders(result.headers),
      body: Array.from(body),
    };
  } catch (error) {
    return { kind: 'error', name: error.name, code: error.code, message: error.message };
  }
}

const cases = [
  { name: 'redirect follow', request: { target: `${BASE_URL}/redirect` } },
  { name: 'redirect manual', request: { target: `${BASE_URL}/redirect`, redirect: 'manual' } },
  { name: 'headers', request: { target: `${BASE_URL}/headers`, method: 'POST', headers: { 'x-client': 'conformance' }, body: 'request' } },
  { name: 'authorization header', request: { target: `${BASE_URL}/auth`, headers: { authorization: 'Bearer test-token' } } },
  { name: 'binary body', request: { target: `${BASE_URL}/binary` } },
  { name: 'streaming body', request: { target: `${BASE_URL}/stream` } },
  { name: 'OpenAI-compatible SSE', request: { target: `${BASE_URL}/sse` } },
  { name: 'compression metadata', request: { target: `${BASE_URL}/compression` } },
  { name: 'large payload', request: { target: `${BASE_URL}/large` } },
  { name: '204 response', request: { target: `${BASE_URL}/no-content` } },
  { name: '304 response', request: { target: `${BASE_URL}/not-modified` } },
  { name: 'malformed response', request: { target: `${BASE_URL}/malformed` } },
];

test('native fetch and Nacelle+ preserve the same response contract', async () => {
  const native = (request) => fixtureFetch(request.target, requestInit(request));
  const privileged = createNegotiatedTransport({
    globalObject: { fetch: (input, init) => fixtureFetch(input, init, false) },
    adapter: { request: (request) => fixtureFetch(request.target, requestInit(request), true) },
  });

  for (const fixture of cases) {
    const expected = await snapshot(native, fixture.request);
    const actual = await snapshot(privileged.request, fixture.request);
    assert.deepEqual(actual, expected, fixture.name);
  }
  privileged.close();
});

test('Nacelle+ falls back for a CORS failure and preserves the response', async () => {
  let privilegedCalls = 0;
  const transport = createNegotiatedTransport({
    globalObject: { fetch: (input, init) => fixtureFetch(input, init, false) },
    adapter: {
      request: (request) => {
        privilegedCalls += 1;
        assert.equal(request.fallbackReason, 'cors');
        return fixtureFetch(request.target, requestInit(request), true);
      },
    },
  });

  const result = await transport.request({ target: `${BASE_URL}/cors` });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'ok');
  assert.equal(privilegedCalls, 1);
  transport.close();
});

test('native and Nacelle+ report aborts instead of treating them as CORS failures', async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = createNegotiatedTransport({
    globalObject: { fetch: (input, init) => fixtureFetch(input, init, false) },
    adapter: { request: (request) => fixtureFetch(request.target, requestInit(request), true) },
  });
  const actual = await snapshot(transport.request, { target: `${BASE_URL}/slow`, signal: controller.signal });
  assert.deepEqual(actual, { kind: 'error', name: 'AbortError', code: undefined, message: 'The operation was aborted' });
  transport.close();
});
