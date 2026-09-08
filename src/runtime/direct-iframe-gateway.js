import { gatewayError, DIRECT_GATEWAY_POLICY } from './gateway-selection.js';
import { CLIENT_CAPABILITIES, GATEWAY_PROTOCOL, createEnvelopePeer, normalizeRequest, normalizeVirtualUrl } from './direct-iframe-protocol.js';
import { openGatewayHttp } from './gateway-http.js';
import { openDirectWebSocket, validateWebSocketProtocols } from './direct-iframe-websocket.js';
import { bootstrapDocument, createBlobOwner, rewriteDocument } from './direct-iframe-resources.js';

const bytesTogether = chunks => {
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
};
const notify = (callback, ...args) => { try { callback?.(...args); } catch { /* Observers cannot interrupt session cleanup. */ } };
const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

/** One untrusted, opaque-origin iframe, one authenticated channel per document. */
export function createDirectIframeGateway({ iframe, net, globalObject: scope = globalThis,
  options = {}, gatewayOptions, onDiagnostic = () => {}, onClose = () => {} }) {
  if (!iframe?.contentWindow || typeof iframe.setAttribute !== 'function'
    || typeof scope.MessageChannel !== 'function' || !scope.crypto?.getRandomValues) {
    throw gatewayError('ERR_GATEWAY_SESSION', 'Direct mode requires an attached iframe, MessageChannel, and secure randomness');
  }
  const portNumber = options.port ?? 3000;
  const context = { port: portNumber, pageUrl: scope.location?.href, base: '/' };
  const initialPath = normalizeVirtualUrl(options.path ?? '/', context);
  const random = () => [...scope.crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const sessionId = random();
  const requests = new Map();
  const history = [{ path: initialPath, state: null }];
  let historyIndex = 0;
  let state = 'created';
  let closed = false;
  let peer;
  let channel;
  let handshakeTimer;
  let owner = createBlobOwner(scope);
  let preparingOwner;
  let expectedLoad = false;
  let ready = false;
  let serial = 0;
  let epoch = 0;
  let task;
  let queued;
  let pendingDocument;
  let documentDiagnostics = [];
  let connected = iframe.isConnected;
  const timers = { set: scope.setTimeout.bind(scope), clear: scope.clearTimeout.bind(scope) };
  const send = (type, payload, transfer) => { if (!closed) peer?.send(type, payload, transfer); };
  const report = failure => {
    const detail = Object.freeze({ code: failure.code?.startsWith('ERR_GATEWAY_') ? failure.code : 'ERR_GATEWAY_NAVIGATION',
      message: String(failure.message || failure).slice(0, 512), sessionId });
    notify(onDiagnostic, detail); notify(options.onError, detail);
    return detail;
  };
  const releaseChannel = () => {
    ready = false; timers.clear(handshakeTimer);
    if (channel) { channel.port1.onmessage = null; channel.port1.close(); channel.port2.close(); }
    channel = null; peer = null;
  };
  const abortRequests = failure => { for (const request of requests.values()) request.abortController.abort(failure); };
  const terminalTask = (current, failure) => {
    if (!current || current.done) return;
    current.done = true; timers.clear(current.timer);
    if (failure) current.reject(failure); else current.resolve();
  };
  const close = () => {
    if (closed) return;
    state = 'closing';
    try { send('close', {}); } catch { /* A failed transfer must not prevent teardown. */ }
    closed = true;
    const failure = gatewayError('ERR_GATEWAY_CLOSED', 'Iframe session closed');
    abortRequests(failure); requests.clear();
    terminalTask(task, failure); terminalTask(queued, failure);
    releaseChannel(); owner.close(); preparingOwner?.close();
    observer?.disconnect();
    iframe.removeEventListener('load', loadedFrame);
    scope.removeEventListener('message', windowMessage);
    scope.removeEventListener('pagehide', close);
    iframe.srcdoc = '<!doctype html>';
    state = 'closed'; notify(onClose, sessionId); notify(options.onClose);
  };
  const protocolError = failure => {
    report(failure);
    if (failure.code === 'ERR_GATEWAY_SEQUENCE') close();
  };
  const beginRequest = (requestId, kind) => {
    if (closed) throw gatewayError('ERR_GATEWAY_CLOSED', 'Iframe session closed');
    if (!validId(requestId) || requests.has(requestId)) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid or duplicate request identifier');
    if (requests.size >= gatewayOptions.maxConcurrentRequests) throw gatewayError('ERR_GATEWAY_REQUEST_LIMIT', 'Too many concurrent gateway requests');
    const request = { requestId, kind, startedAt: Date.now(), abortController: new scope.AbortController(), bytesReceived: 0, phase: 'queued' };
    request.timer = timers.set(() => request.abortController.abort(gatewayError('ERR_GATEWAY_TIMEOUT', 'Gateway request timed out')), gatewayOptions.requestTimeoutMs);
    requests.set(requestId, request);
    return request;
  };
  const finishRequest = request => { timers.clear(request.timer); if (requests.get(request.requestId) === request) requests.delete(request.requestId); };

  async function http(payload, callbacks = {}) {
    // Validation and admission happen before opening any socket.
    let request = normalizeRequest(payload, context, gatewayOptions.maxBodyBytes);
    const record = beginRequest(payload.requestId, 'http');
    let metadata;
    let redirects = 0;
    try {
      for (;;) {
        let redirectTarget;
        let redirectStatus;
        const hop = new scope.AbortController();
        const abort = () => hop.abort(record.abortController.signal.reason);
        record.abortController.signal.addEventListener('abort', abort, { once: true });
        if (record.abortController.signal.aborted) abort();
        record.phase = 'connected';
        const redirectSignal = gatewayError('ERR_GATEWAY_NAVIGATION', 'Following virtual redirect');
        try {
          await openGatewayHttp({ net, port: portNumber, request, signal: hop.signal, maxBodyBytes: gatewayOptions.maxBodyBytes,
            onStart(start) {
              if (start.headers['content-encoding'] && start.headers['content-encoding'] !== 'identity') throw gatewayError('ERR_GATEWAY_RESOURCE_UNSUPPORTED', 'Encoded HTTP responses are unsupported');
              const location = start.headers.location;
              if ([301, 302, 303, 307, 308].includes(start.status) && location) {
                // Validate even manual redirects: never expose a host navigation fallback.
                redirectTarget = normalizeVirtualUrl(location, { ...context, base: request.path });
                redirectStatus = start.status;
                if (request.redirect === 'error') throw gatewayError('ERR_GATEWAY_NAVIGATION', 'Redirects are disabled for this request');
                if (request.redirect === 'follow') { hop.abort(redirectSignal); return; }
                start.headers.location = redirectTarget;
                redirectTarget = null;
              }
              metadata = { ...start, redirected: redirects > 0, finalUrl: request.path };
              record.phase = 'streaming'; callbacks.onStart?.(metadata);
            },
            onChunk(bytes) {
              if (redirectTarget || hop.signal.aborted) return;
              record.bytesReceived += bytes.length;
              callbacks.onChunk?.(bytes);
            },
          });
        } catch (failure) { if (failure !== redirectSignal) throw failure; }
        finally { record.abortController.signal.removeEventListener('abort', abort); }
        if (!redirectTarget) break;
        if (++redirects > DIRECT_GATEWAY_POLICY.maxRedirects) throw gatewayError('ERR_GATEWAY_NAVIGATION', 'Too many virtual redirects');
        request = { ...request, path: redirectTarget };
        if ((redirectStatus === 303 && request.method !== 'HEAD') || ([301, 302].includes(redirectStatus) && request.method === 'POST')) {
          request.method = 'GET'; request.body = new Uint8Array(); delete request.headers['content-type'];
        }
      }
      record.phase = 'complete'; return metadata;
    } catch (failure) {
      record.phase = record.abortController.signal.aborted ? 'cancelled' : 'failed';
      throw failure.code?.startsWith('ERR_GATEWAY_') ? failure : gatewayError('ERR_GATEWAY_NAVIGATION', failure.message);
    } finally { finishRequest(record); }
  }
  async function buffered(url) {
    const chunks = [];
    const metadata = await http({ requestId: `asset-${++serial}`, url }, { onChunk: bytes => chunks.push(bytes) });
    return { ...metadata, bytes: bytesTogether(chunks) };
  }
  const syncHistory = popstate => send('history', { ...history[historyIndex], length: history.length, popstate });
  function commit(path, historyAction = 'push', targetIndex, entryState = null) {
    if (historyAction === 'traverse') historyIndex = targetIndex;
    else if (historyAction === 'replace') history[historyIndex] = { path, state: entryState };
    else { history.splice(historyIndex + 1); history.push({ path, state: entryState }); historyIndex++; }
    context.base = path;
  }
  async function runNavigation(current) {
    task = current;
    const generation = ++epoch;
    const requestId = `nav-${++serial}`;
    abortRequests(gatewayError('ERR_GATEWAY_CLOSED', 'Document navigation replaced the request'));
    state = 'navigating';
    current.timer = timers.set(() => {
      const failure = gatewayError('ERR_GATEWAY_TIMEOUT', 'Iframe navigation timed out');
      report(failure); terminalTask(current, failure); close();
    }, gatewayOptions.requestTimeoutMs);
    send('navigate', { requestId, path: current.path, method: current.payload.method || 'GET', headers: current.payload.headers || {}, body: current.payload.body || null });
    const chunks = [];
    const nextOwner = createBlobOwner(scope); preparingOwner = nextOwner;
    const diagnostics = [];
    try {
      const response = await http({ ...current.payload, url: current.path, requestId }, {
        onStart: metadata => send('http-response-start', { requestId, ...metadata }),
        onChunk: bytes => {
          chunks.push(bytes);
          const copy = bytes.slice(); send('http-response-chunk', { requestId, bytes: copy }, [copy.buffer]);
        },
      });
      send('http-response-end', { requestId });
      if (response.headers['content-security-policy'] || response.headers['x-frame-options']) throw gatewayError('ERR_GATEWAY_RESOURCE_UNSUPPORTED', 'Response framing policy cannot be preserved in a rewritten opaque document');
      const text = new TextDecoder().decode(bytesTogether(chunks));
      const html = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.contentType)
        ? text : `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
      const document = await rewriteDocument({ html, path: response.finalUrl, port: portNumber,
        pageUrl: context.pageUrl, scope, request: buffered, owner: nextOwner, maxBodyBytes: gatewayOptions.maxBodyBytes,
        onDiagnostic: failure => { const detail = report(failure); if (diagnostics.length < DIRECT_GATEWAY_POLICY.maxDiagnostics) diagnostics.push(detail); },
      });
      if (closed || generation !== epoch) { nextOwner.close(); return; }
      commit(response.finalUrl, current.action, current.targetIndex, current.entryState);
      abortRequests(gatewayError('ERR_GATEWAY_CLOSED', 'Document replaced'));
      releaseChannel(); owner.close(); owner = nextOwner; preparingOwner = null;
      documentDiagnostics = diagnostics;
      pendingDocument = { requestId, path: response.finalUrl, task: current, html: document, popstate: current.action === 'traverse' };
      expectedLoad = true; iframe.srcdoc = bootstrapDocument();
      handshakeTimer = timers.set(() => { report(gatewayError('ERR_GATEWAY_TIMEOUT', 'Iframe bootstrap did not load')); close(); }, gatewayOptions.requestTimeoutMs);
    } catch (failure) {
      nextOwner.close();
      if (closed || generation !== epoch) return;
      const detail = report(failure); send('navigation-error', { requestId, ...detail });
      state = 'loaded'; terminalTask(current, failure);
    }
  }
  function navigate(path, payload = {}, action = 'push', targetIndex, entryState) {
    if (closed) return Promise.reject(gatewayError('ERR_GATEWAY_CLOSED', 'Iframe session closed'));
    let normalized;
    try { normalized = normalizeVirtualUrl(path, context); normalizeRequest({ ...payload, url: normalized }, context, gatewayOptions.maxBodyBytes); }
    catch (failure) { report(failure); return Promise.reject(failure); }
    return new Promise((resolve, reject) => {
      const current = { path: normalized, payload, action, targetIndex, entryState, resolve, reject };
      const replaced = gatewayError('ERR_GATEWAY_CLOSED', 'Navigation superseded');
      terminalTask(task, replaced); terminalTask(queued, replaced);
      if (ready) runNavigation(current);
      else { queued = current; }
    });
  }
  const historyMessage = payload => {
    if (payload.kind === 'go') {
      if (!Number.isInteger(payload.delta)) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid history delta');
      const target = historyIndex + payload.delta;
      if (target < 0 || target >= history.length) return;
      navigate(history[target].path, {}, 'traverse', target, history[target].state).catch(() => {});
    } else if (['pushState', 'replaceState'].includes(payload.kind)) {
      const path = normalizeVirtualUrl(payload.path, context);
      commit(path, payload.kind === 'pushState' ? 'push' : 'replace', undefined, payload.state);
      syncHistory(false); notify(options.onNavigate, path, path);
    } else throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Unknown history operation');
  };
  const socketError = (socketId, failure) => send('ws-error', { socketId, ...report(failure) });
  function webSocket(payload) {
    const documentPeer = peer;
    const reply = (type, data, transfer) => { if (peer === documentPeer) send(type, data, transfer); };
    const path = normalizeVirtualUrl(payload.url, { ...context, websocket: true });
    const protocols = validateWebSocketProtocols(payload.protocols);
    const record = beginRequest(payload.socketId, 'websocket');
    record.abortController.signal.addEventListener('abort', () => {
      const reason = record.abortController.signal.reason;
      if (reason?.code === 'ERR_GATEWAY_TIMEOUT') reply('ws-error', { socketId: payload.socketId, ...report(reason) });
    }, { once: true });
    try {
      record.socket = openDirectWebSocket({ net, port: portNumber, path, protocols, scope,
        maxBodyBytes: gatewayOptions.maxBodyBytes, signal: record.abortController.signal,
        onOpen(protocol) { record.phase = 'streaming'; timers.clear(record.timer); reply('ws-opened', { socketId: payload.socketId, protocol }); },
        onMessage(bytes, binary) {
          record.bytesReceived += bytes.length;
          reply('ws-message', { socketId: payload.socketId, bytes, binary }, [bytes.buffer]);
        },
        onError: failure => reply('ws-error', { socketId: payload.socketId, ...report(failure) }),
        onClose(result) { record.phase = 'complete'; finishRequest(record); reply('ws-closed', { socketId: payload.socketId, ...result }); },
      });
    } catch (failure) { record.abortController.abort(); finishRequest(record); throw failure; }
  }
  function receive(message) {
    const payload = message.payload;
    try {
      switch (message.type) {
        case 'ready':
          if (ready || payload.bootstrapVersion !== 1) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid bootstrap readiness');
          ready = true; state = 'ready'; timers.clear(handshakeTimer);
          if (queued) { const next = queued; queued = null; runNavigation(next); }
          break;
        case 'loaded':
          if (!ready || !pendingDocument || payload.requestId !== pendingDocument.requestId || payload.path !== pendingDocument.path) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Unexpected document completion');
          state = 'loaded'; terminalTask(pendingDocument.task); pendingDocument = null;
          notify(options.onNavigate, context.base, context.base); break;
        case 'http-request': {
          const documentPeer = peer;
          const reply = (type, data, transfer) => { if (peer === documentPeer) send(type, data, transfer); };
          if (!ready) throw gatewayError('ERR_GATEWAY_SESSION', 'Session is not ready');
          http(payload, {
            onStart: metadata => reply('http-response-start', { requestId: payload.requestId, ...metadata }),
            onChunk: bytes => reply('http-response-chunk', { requestId: payload.requestId, bytes }, [bytes.buffer]),
          }).then(() => reply('http-response-end', { requestId: payload.requestId }), failure => {
            reply('http-response-error', { requestId: payload.requestId, ...report(failure) });
          }); break;
        }
        case 'cancel':
          requests.get(payload.requestId)?.abortController.abort(gatewayError('ERR_GATEWAY_CLOSED', 'Client cancelled request')); break;
        case 'navigation':
          navigate(payload.url, payload).catch(() => {}); break;
        case 'history': historyMessage(payload); break;
        case 'ws-open':
          if (!ready) throw gatewayError('ERR_GATEWAY_SESSION', 'Session is not ready');
          webSocket(payload); break;
        case 'ws-send': {
          const record = requests.get(payload.socketId);
          if (record?.kind !== 'websocket') throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Unknown WebSocket');
          record.socket.send(payload.bytes, payload.binary); break;
        }
        case 'ws-close': requests.get(payload.socketId)?.socket?.close(payload.code, payload.reason); break;
        case 'error':
          report(gatewayError(typeof payload.code === 'string' ? payload.code : 'ERR_GATEWAY_PROTOCOL', String(payload.message)));
          if (payload.code === 'ERR_GATEWAY_SEQUENCE') close();
          break;
        case 'close': close(); break;
        default: throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Unknown gateway message');
      }
    } catch (failure) {
      if (message.type.startsWith('ws-')) {
        socketError(payload.socketId, failure); requests.get(payload.socketId)?.abortController.abort(failure);
      } else protocolError(failure);
    }
  }
  function loadedFrame() {
    if (closed) return;
    if (!expectedLoad) { report(gatewayError('ERR_GATEWAY_NAVIGATION', 'Unmanaged iframe navigation is unsupported')); close(); return; }
    expectedLoad = false;
    try {
      releaseChannel(); channel = new scope.MessageChannel();
      const ownedChannel = channel;
      const nonce = random();
      let initializing = true;
      peer = createEnvelopePeer({ sessionId, nonce, onError: protocolError,
        send: (message, transfer) => {
          if (initializing) iframe.contentWindow.postMessage(message, '*', transfer);
          else ownedChannel.port1.postMessage(message, transfer);
        } });
      ownedChannel.port1.onmessage = event => {
        if (!closed && channel === ownedChannel && peer.receive(event.data)) receive(event.data);
      };
      ownedChannel.port1.start();
      // Only the opaque sandbox WindowProxy receives init. Later traffic is
      // authenticated by this transferred port, the nonce and both sequences.
      peer.send('init', { path: context.base, virtualPort: portNumber, capabilities: CLIENT_CAPABILITIES,
        maxBodyBytes: gatewayOptions.maxBodyBytes, historyState: history[historyIndex].state, historyLength: history.length,
        requestId: pendingDocument?.requestId, documentHtml: pendingDocument?.html, resources: owner.resources, popstate: pendingDocument?.popstate, diagnostics: documentDiagnostics }, [ownedChannel.port2]);
      initializing = false;
      state = 'bootstrap-sent';
      handshakeTimer = timers.set(() => { report(gatewayError('ERR_GATEWAY_TIMEOUT', 'Iframe bootstrap handshake timed out')); close(); }, gatewayOptions.requestTimeoutMs);
    } catch (failure) { report(gatewayError('ERR_GATEWAY_SESSION', `Iframe handshake failed: ${failure.message}`)); close(); }
  }
  function windowMessage(event) {
    if (event.data?.protocol !== GATEWAY_PROTOCOL) return;
    // Window traffic is never a request channel, even from the right frame.
    protocolError(gatewayError('ERR_GATEWAY_PROTOCOL', event.source === iframe.contentWindow
      ? 'Gateway operations require the transferred port' : 'Unexpected gateway message source'));
  }
  const observer = typeof scope.MutationObserver === 'function' ? new scope.MutationObserver(() => {
    if (iframe.isConnected) connected = true;
    if (connected && !iframe.isConnected) close();
    if (iframe.getAttribute('sandbox') !== 'allow-scripts allow-forms') {
      report(gatewayError('ERR_GATEWAY_SESSION', 'The direct iframe sandbox was modified')); close();
    }
  }) : null;
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.src = 'about:blank'; state = 'iframe-attached';
  iframe.addEventListener('load', loadedFrame);
  scope.addEventListener('message', windowMessage);
  scope.addEventListener('pagehide', close);
  observer?.observe(scope.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['sandbox'] });
  context.base = initialPath;
  expectedLoad = true; iframe.srcdoc = bootstrapDocument();
  handshakeTimer = timers.set(() => { report(gatewayError('ERR_GATEWAY_TIMEOUT', 'Iframe bootstrap did not load')); close(); }, gatewayOptions.requestTimeoutMs);
  if (options.autoLoad !== false) navigate(initialPath, {}, 'replace').catch(() => {});
  return Object.assign(close, {
    navigate: path => navigate(path),
    back: () => historyMessage({ kind: 'go', delta: -1 }),
    forward: () => historyMessage({ kind: 'go', delta: 1 }),
    getDiagnostic: () => Object.freeze({ sessionId, state, path: context.base, pendingRequests: requests.size, blobUrls: owner.size }),
  });
}
