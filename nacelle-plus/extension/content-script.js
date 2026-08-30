const api = globalThis.browser || globalThis.chrome;
const PORT_NAME = 'nacelle-plus-transport-v1';
const PAGE_SOURCE = 'nacelle-plus-page';
const EXTENSION_SOURCE = 'nacelle-plus-extension';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const requestIds = new Set();
let port;
let reconnectTimer;

function pageOrigin() {
  return location.origin;
}

function postToPage(message, transfer = []) {
  try { window.postMessage(message, pageOrigin(), transfer); } catch { window.postMessage(message, pageOrigin()); }
}

function sendPort(message) {
  try {
    port?.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function connect() {
  if (port) return port;
  try { port = api.runtime.connect({ name: PORT_NAME }); } catch { return null; }
  port.onMessage.addListener((message) => {
    if (!message || !REQUEST_ID_PATTERN.test(String(message.requestId || ''))) return;
    if (message.type === 'response-start') {
      postToPage({ source: EXTENSION_SOURCE, type: 'response-start', requestId: message.requestId, response: message.response });
    } else if (message.type === 'response-chunk' && message.body instanceof ArrayBuffer
      && Number.isInteger(message.sequence) && message.sequence > 0) {
      postToPage({ source: EXTENSION_SOURCE, type: 'response-chunk', requestId: message.requestId, sequence: message.sequence, body: message.body }, [message.body]);
      // The page adapter acknowledges after its ReadableStream has capacity.
      // This keeps a stalled page from making the extension drain the network.
    } else if (message.type === 'response-end') {
      requestIds.delete(message.requestId);
      postToPage({ source: EXTENSION_SOURCE, type: 'response-end', requestId: message.requestId });
    } else if (message.type === 'response-error') {
      requestIds.delete(message.requestId);
      postToPage({ source: EXTENSION_SOURCE, type: 'response-error', requestId: message.requestId, response: message.response });
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    for (const requestId of requestIds) {
      postToPage({
        source: EXTENSION_SOURCE,
        type: 'response-error',
        requestId,
        response: { ok: false, error: { code: 'ERR_NACELLE_PLUS_TRANSPORT_LOST', message: 'Nacelle+ transport disconnected before the response completed' } },
      });
    }
    requestIds.clear();
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 250);
  });
  return port;
}

connect();
// Traffic from the content script keeps an active MV3 port observable while a
// long response is in flight. A disconnect fails requests instead of replaying
// them, which avoids duplicating POSTs after a worker restart.
setInterval(() => sendPort({ type: 'heartbeat' }), 15_000);

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== pageOrigin()) return;
  const message = event.data;
  if (!message || message.source !== PAGE_SOURCE || message.version !== 1
    || typeof message.requestId !== 'string' || !REQUEST_ID_PATTERN.test(message.requestId)) return;
  if (message.type === 'chunk-ack' && Number.isInteger(message.sequence) && message.sequence > 0) {
    sendPort({ type: 'chunk-ack', requestId: message.requestId, sequence: message.sequence });
    return;
  }
  if (message.type === 'cancel') {
    sendPort({ type: 'cancel', requestId: message.requestId });
    return;
  }
  if (message.type !== 'request' || !message.request || requestIds.has(message.requestId)) return;
  const activePort = connect();
  if (!activePort) {
    postToPage({
      source: EXTENSION_SOURCE,
      type: 'response-error',
      requestId: message.requestId,
      response: { ok: false, error: { code: 'ERR_NACELLE_PLUS_BRIDGE_UNAVAILABLE', message: 'Nacelle+ bridge unavailable' } },
    });
    return;
  }
  requestIds.add(message.requestId);
  if (!sendPort({ type: 'request', version: 1, requestId: message.requestId, extensionId: message.extensionId, request: message.request })) {
    requestIds.delete(message.requestId);
    postToPage({
      source: EXTENSION_SOURCE,
      type: 'response-error',
      requestId: message.requestId,
      response: { ok: false, error: { code: 'ERR_NACELLE_PLUS_BRIDGE_UNAVAILABLE', message: 'Nacelle+ bridge unavailable' } },
    });
  }
});
