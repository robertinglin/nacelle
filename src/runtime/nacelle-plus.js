import { createNegotiatedTransport } from './transport.js';

const PAGE_REQUEST_SOURCE = 'nacelle-plus-page';
const EXTENSION_RESPONSE_SOURCE = 'nacelle-plus-extension';

function transportError(code, message) {
  const error = new Error(message);
  error.name = 'NacellePlusError';
  error.code = code;
  return error;
}

function copyTransferableBody(body) {
  if (body instanceof Uint8Array) return body.slice().buffer;
  if (body instanceof ArrayBuffer) return body.slice(0);
  return body;
}

function postMessage(scope, message, transfer = []) {
  try {
    scope.postMessage(message, '*', transfer);
  } catch {
    scope.postMessage(message, '*');
  }
}

/** Create the page/content-script bridge used by the Chrome and Firefox companions. */
export function createNacellePlusAdapter({ globalObject = globalThis, extensionId, timeout = 15_000 } = {}) {
  if (typeof globalObject.postMessage !== 'function' || typeof globalObject.addEventListener !== 'function') {
    throw transportError('ERR_NACELLE_PLUS_UNAVAILABLE', 'Nacelle+ requires a browser page message bridge');
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw transportError('ERR_INVALID_TRANSPORT_TIMEOUT', 'Nacelle+ timeout must be positive');
  }

  const pending = new Map();
  let sequence = 0;
  const onMessage = (event) => {
    if (event.source && event.source !== globalObject) return;
    const message = event.data;
    if (message?.source !== EXTENSION_RESPONSE_SOURCE) return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    clearTimeout(request.timer);
    if (message.response?.ok === false) request.resolve(message.response);
    else if (message.response) request.resolve(message.response);
    else request.reject(transportError('ERR_NACELLE_PLUS_PROTOCOL', 'Nacelle+ returned an empty response'));
  };
  globalObject.addEventListener('message', onMessage);

  const adapter = {
    request(request) {
      const requestId = `nacelle-plus-${Date.now()}-${sequence += 1}`;
      const body = copyTransferableBody(request?.body);
      const message = {
        source: PAGE_REQUEST_SOURCE,
        version: 1,
        extensionId,
        requestId,
        request: { ...request, operation: 'request', body },
      };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(transportError('ETIMEDOUT', `Nacelle+ request timed out after ${timeout}ms`));
        }, timeout);
        pending.set(requestId, { resolve, reject, timer });
        const transfer = body instanceof ArrayBuffer ? [body] : [];
        postMessage(globalObject, message, transfer);
      });
    },
    close() {
      globalObject.removeEventListener?.('message', onMessage);
      for (const { timer, reject } of pending.values()) {
        clearTimeout(timer);
        reject(transportError('ERR_NACELLE_PLUS_CLOSED', 'Nacelle+ adapter closed'));
      }
      pending.clear();
    },
  };
  return Object.freeze(adapter);
}

/** Build the negotiated Nacelle+ transport used by Nacelle's proxy capability. */
export function createNacellePlusTransport(options = {}) {
  const adapter = options.adapter || createNacellePlusAdapter(options);
  return createNegotiatedTransport({
    ...options,
    adapter,
    fallback: options.fallback !== false,
  });
}

export { PAGE_REQUEST_SOURCE, EXTENSION_RESPONSE_SOURCE };
