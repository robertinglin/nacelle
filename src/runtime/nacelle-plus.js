import { createNegotiatedTransport } from './transport.js';

const PAGE_REQUEST_SOURCE = 'nacelle-plus-page';
const EXTENSION_RESPONSE_SOURCE = 'nacelle-plus-extension';
const PAGE_ORIGIN = '*';
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_HEADER_VALUE_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const FORBIDDEN_HEADERS = new Set(['connection', 'content-length', 'cookie', 'host', 'origin', 'referer', 'set-cookie', 'transfer-encoding', 'upgrade']);

function transportError(code, message) {
  const error = new Error(message);
  error.name = 'NacellePlusError';
  error.code = code;
  return error;
}

function byteLength(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.length;
  return Infinity;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') throw transportError('ERR_NACELLE_PLUS_PROTOCOL', 'request must be an object');
  let target;
  try { target = new URL(String(request.target)); } catch { throw transportError('ERR_INVALID_URL', 'Nacelle+ only supports valid HTTP(S) targets'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw transportError('ERR_INVALID_URL', 'Nacelle+ only supports credential-free HTTP(S) targets');
  }
  const method = String(request.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) throw transportError('ERR_NACELLE_PLUS_METHOD', `unsupported HTTP method: ${method}`);
  if (request.headers !== undefined && (typeof request.headers !== 'object' || Array.isArray(request.headers))) {
    throw transportError('ERR_NACELLE_PLUS_HEADERS', 'request headers must be an object');
  }
  const headers = request.headers || {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(value))) {
      throw transportError('ERR_NACELLE_PLUS_HEADERS', `invalid request header: ${name}`);
    }
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-')) {
      throw transportError('ERR_NACELLE_PLUS_FORBIDDEN_HEADER', `request header is controlled by the browser: ${name}`);
    }
  }
  if (byteLength(request.body) > MAX_REQUEST_BODY_BYTES) {
    throw transportError('ERR_NACELLE_PLUS_REQUEST_TOO_LARGE', 'Nacelle+ request body exceeds the 16 MiB limit');
  }
  return { ...request, target: target.href, method, headers: { ...headers } };
}

function copyTransferableBody(body) {
  if (body instanceof Uint8Array) return body.slice().buffer;
  if (body instanceof ArrayBuffer) return body.slice(0);
  return body;
}

function postMessage(scope, message, transfer = []) {
  const origin = scope.location?.origin && scope.location.origin !== 'null' ? scope.location.origin : PAGE_ORIGIN;
  try { scope.postMessage(message, origin, transfer); } catch { scope.postMessage(message, origin); }
}

function errorFromResponse(response) {
  const source = response?.error || {};
  return transportError(source.code || 'ERR_NACELLE_PLUS', source.message || 'Nacelle+ request failed');
}

function validateResponseMetadata(metadata) {
  if (!metadata || !Number.isInteger(metadata.status) || metadata.status < 100 || metadata.status > 599) {
    throw transportError('ERR_NACELLE_PLUS_PROTOCOL', 'Nacelle+ returned an invalid response status');
  }
  if (!metadata.headers || typeof metadata.headers !== 'object' || Array.isArray(metadata.headers)) {
    throw transportError('ERR_NACELLE_PLUS_PROTOCOL', 'Nacelle+ returned invalid response headers');
  }
  if (metadata.statusText !== undefined && typeof metadata.statusText !== 'string') {
    throw transportError('ERR_NACELLE_PLUS_PROTOCOL', 'Nacelle+ returned an invalid response status text');
  }
  if (Object.keys(metadata.headers).length > 128) throw transportError('ERR_NACELLE_PLUS_PROTOCOL', 'Nacelle+ returned too many headers');
  for (const [name, value] of Object.entries(metadata.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(value))
      || new TextEncoder().encode(String(value)).byteLength > MAX_RESPONSE_HEADER_VALUE_BYTES) {
      throw transportError('ERR_NACELLE_PLUS_PROTOCOL', `Nacelle+ returned an invalid header: ${name}`);
    }
  }
  return metadata;
}

function makeResponse(metadata, onCancel, onChunkAck) {
  let streamController;
  let pendingSequence = null;
  const acknowledgePendingChunk = () => {
    if (pendingSequence === null) return;
    const sequence = pendingSequence;
    pendingSequence = null;
    onChunkAck(sequence);
  };
  const body = typeof ReadableStream === 'function'
    ? new ReadableStream({
      start(controller) { streamController = controller; },
      pull() { acknowledgePendingChunk(); },
      cancel: onCancel,
    })
    : null;
  const buffered = [];
  const response = {
    ok: metadata.status >= 200 && metadata.status < 300,
    status: metadata.status,
    statusText: metadata.statusText || '',
    headers: metadata.headers || {},
    body,
    arrayBuffer: async () => {
      if (!body) {
        const output = new Uint8Array(buffered.reduce((total, chunk) => total + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of buffered) { output.set(chunk, offset); offset += chunk.byteLength; }
        return output.buffer;
      }
      const reader = body.getReader();
      const chunks = [];
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        chunks.push(new Uint8Array(item.value));
      }
      const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      return output.buffer;
    },
  };
  return {
    response,
    push(bodyChunk, sequence) {
      const chunk = bodyChunk instanceof Uint8Array ? bodyChunk : new Uint8Array(bodyChunk);
      if (!streamController) {
        buffered.push(chunk);
        onChunkAck(sequence);
        return;
      }
      streamController.enqueue(chunk);
      pendingSequence = sequence;
      if (streamController.desiredSize > 0) acknowledgePendingChunk();
    },
    end() { streamController?.close(); },
    fail(error) { streamController?.error(error); },
  };
}

/** Create the page/content-script bridge used by the Chrome and Firefox companions. */
export function createNacellePlusAdapter({ globalObject = globalThis, extensionId, timeout = 15_000 } = {}) {
  if (typeof globalObject.postMessage !== 'function' || typeof globalObject.addEventListener !== 'function') {
    throw transportError('ERR_NACELLE_PLUS_UNAVAILABLE', 'Nacelle+ requires a browser page message bridge');
  }
  if (!Number.isFinite(timeout) || timeout <= 0) throw transportError('ERR_INVALID_TRANSPORT_TIMEOUT', 'Nacelle+ timeout must be positive');

  const pending = new Map();
  let sequence = 0;
  const expire = (requestId, request) => {
    if (!pending.has(requestId)) return;
    postMessage(globalObject, { source: PAGE_REQUEST_SOURCE, type: 'cancel', version: 1, requestId });
    request.signal?.removeEventListener?.('abort', request.onAbort);
    pending.delete(requestId);
    const error = transportError('ETIMEDOUT', `Nacelle+ stream timed out after ${timeout}ms`);
    if (request.started) request.stream?.fail(error);
    else request.reject(error);
  };
  const armTimeout = (requestId, request) => {
    clearTimeout(request.timer);
    request.timer = setTimeout(() => expire(requestId, request), timeout);
  };
  const onMessage = (event) => {
    if (event.source && event.source !== globalObject) return;
    const origin = globalObject.location?.origin;
    if (event.origin && origin && origin !== 'null' && event.origin !== origin) return;
    const message = event.data;
    if (message?.source !== EXTENSION_RESPONSE_SOURCE || !REQUEST_ID_PATTERN.test(String(message.requestId || ''))) return;
    const request = pending.get(message.requestId);
    if (!request) return;
    if (message.type === 'response-start') {
      if (request.started) return;
      let metadata;
      try { metadata = validateResponseMetadata(message.response); } catch (error) {
        clearTimeout(request.timer);
        postMessage(globalObject, { source: PAGE_REQUEST_SOURCE, type: 'cancel', version: 1, requestId: message.requestId });
        pending.delete(message.requestId);
        request.reject(error);
        return;
      }
      request.started = true;
      clearTimeout(request.timer);
      request.stream = makeResponse(metadata, () => {
        postMessage(globalObject, { source: PAGE_REQUEST_SOURCE, type: 'cancel', version: 1, requestId: message.requestId });
      }, (sequence) => {
        postMessage(globalObject, {
          source: PAGE_REQUEST_SOURCE, type: 'chunk-ack', version: 1, requestId: message.requestId, sequence,
        });
      });
      armTimeout(message.requestId, request);
      request.resolve(request.stream.response);
      return;
    }
    if (message.type === 'response-chunk') {
      if (request.stream && message.body instanceof ArrayBuffer && Number.isInteger(message.sequence) && message.sequence > 0) {
        request.total += message.body.byteLength;
        if (request.total > MAX_RESPONSE_BYTES) {
          postMessage(globalObject, { source: PAGE_REQUEST_SOURCE, type: 'cancel', version: 1, requestId: message.requestId });
          clearTimeout(request.timer);
          pending.delete(message.requestId);
          request.stream.fail(transportError('ERR_NACELLE_PLUS_RESPONSE_TOO_LARGE', 'Nacelle+ response exceeds the 16 MiB limit'));
          return;
        }
        request.stream.push(message.body, message.sequence);
        armTimeout(message.requestId, request);
      }
      return;
    }
    if (message.type === 'response-end') {
      clearTimeout(request.timer);
      request.stream?.end();
      request.signal?.removeEventListener?.('abort', request.onAbort);
      pending.delete(message.requestId);
      return;
    }
    if (message.type === 'response-error') {
      clearTimeout(request.timer);
      pending.delete(message.requestId);
      request.signal?.removeEventListener?.('abort', request.onAbort);
      const error = errorFromResponse(message.response);
      if (request.started) request.stream?.fail(error);
      else request.reject(error);
    }
  };
  globalObject.addEventListener('message', onMessage);

  const adapter = {
    request(rawRequest) {
      const request = validateRequest(rawRequest);
      const requestId = `nacelle-plus-${Date.now()}-${sequence += 1}`;
      const body = copyTransferableBody(request.body);
      const message = {
        source: PAGE_REQUEST_SOURCE,
        type: 'request',
        version: 1,
        extensionId,
        requestId,
        request: (({ signal, ...wireRequest }) => ({ ...wireRequest, body }))(request),
      };
      return new Promise((resolve, reject) => {
        const record = { resolve, reject, timer: null, started: false, stream: null, signal: request.signal, total: 0 };
        pending.set(requestId, record);
        armTimeout(requestId, record);
        if (request.signal?.aborted) {
          clearTimeout(record.timer);
          pending.delete(requestId);
          reject(transportError('ABORT_ERR', 'Nacelle+ request was aborted'));
          return;
        }
        const onAbort = () => {
          postMessage(globalObject, { source: PAGE_REQUEST_SOURCE, type: 'cancel', version: 1, requestId });
          clearTimeout(record.timer);
          pending.delete(requestId);
          const error = transportError('ABORT_ERR', 'Nacelle+ request was aborted');
          if (record.started) record.stream?.fail(error);
          else reject(error);
        };
        record.onAbort = onAbort;
        request.signal?.addEventListener?.('abort', onAbort, { once: true });
        const transfer = body instanceof ArrayBuffer ? [body] : [];
        postMessage(globalObject, message, transfer);
      });
    },
    close() {
      globalObject.removeEventListener?.('message', onMessage);
      for (const [requestId, request] of pending) {
        clearTimeout(request.timer);
        request.signal?.removeEventListener?.('abort', request.onAbort);
        postMessage(globalObject, { source: PAGE_REQUEST_SOURCE, type: 'cancel', version: 1, requestId });
        const error = transportError('ERR_NACELLE_PLUS_CLOSED', 'Nacelle+ adapter closed');
        if (request.started) request.stream?.fail(error);
        else request.reject(error);
      }
      pending.clear();
    },
  };
  return Object.freeze(adapter);
}

/** Build the negotiated Nacelle+ transport used by Nacelle's proxy capability. */
export function createNacellePlusTransport(options = {}) {
  const adapter = options.adapter || createNacellePlusAdapter(options);
  return createNegotiatedTransport({ ...options, adapter, fallback: options.fallback !== false });
}

export { PAGE_REQUEST_SOURCE, EXTENSION_RESPONSE_SOURCE };
