/** Fixed, versioned source. No application strings are interpolated into this function. */
export function directIframeBootstrap() {
  'use strict';
  const PROTOCOL = 'nacelle-direct-gateway';
  const NativeRequest = globalThis.Request;
  const NativeResponse = globalThis.Response;
  const NativeHeaders = globalThis.Headers;
  const NativeURL = globalThis.URL;
  const resourceUrls = new Set();
  const pending = new Map();
  const sockets = new Map();
  let port;
  let identity;
  let incoming = 0;
  let outgoing = 0;
  let serial = 0;
  let closed = false;
  let currentPath = '/';
  let virtualPort = 3000;
  let maxBodyBytes = 16 * 1024 * 1024;
  let historyState = null;
  let historyLength = 1;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const error = (code, message) => Object.assign(new Error(message), { name: 'GatewayError', code });
  const send = (type, payload = {}, transfer = []) => {
    if (closed || !port) return;
    port.postMessage({ protocol: PROTOCOL, version: 1, ...identity, sequence: ++outgoing, type, payload }, transfer);
  };
  const diagnostic = (code, message) => {
    const detail = { code, message: String(message).slice(0, 512) };
    dispatchEvent(new CustomEvent('nacelle-gateway-error', { detail }));
    if (document.body) {
      let output = document.querySelector('[data-nacelle-gateway-error]');
      if (!output) { output = document.createElement('output'); output.setAttribute('data-nacelle-gateway-error', ''); document.body.append(output); }
      output.textContent = `${code}: ${detail.message}`;
    }
    return detail;
  };
  const unsupported = message => {
    const detail = diagnostic('ERR_GATEWAY_RESOURCE_UNSUPPORTED', message);
    ready.then(() => send('error', detail)).catch(() => {});
    return error(detail.code, detail.message);
  };
  const terminateRequest = (id, reason) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); item.cleanup();
    if (reason) { item.reject(reason); item.controller?.error(reason); }
    else item.controller?.close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    const reason = error('ERR_GATEWAY_CLOSED', 'Iframe gateway closed');
    readyReject(reason);
    for (const id of [...pending.keys()]) terminateRequest(id, reason);
    for (const socket of [...sockets.values()]) socket._finish(1001, '', false);
    for (const url of resourceUrls) NativeURL.revokeObjectURL(url);
    resourceUrls.clear();
    port?.close();
  };
  const virtualURL = input => new URL(String(input), `http://localhost:${virtualPort}${currentPath}`);
  const requestAddress = input => {
    const url = virtualURL(input);
    return /^[a-z][a-z\d+.-]*:|^\/\//i.test(String(input)) ? url.href : url.pathname + url.search + url.hash;
  };

  async function gatewayFetch(input, init = {}) {
    await ready;
    if (closed) throw error('ERR_GATEWAY_CLOSED', 'Iframe gateway closed');
    const address = input instanceof NativeRequest ? input.url : String(input);
    const request = new NativeRequest(virtualURL(address), {
      ...(input instanceof NativeRequest ? {
        method: input.method, headers: input.headers, signal: input.signal, redirect: input.redirect,
        ...(input.body ? { body: input.body, duplex: 'half' } : {}),
      } : {}), ...init, credentials: init.credentials ?? 'omit',
    });
    if (request.signal.aborted) throw request.signal.reason;
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
    if (body.length > maxBodyBytes) throw error('ERR_GATEWAY_BODY_LIMIT', 'Request exceeds maxBodyBytes');
    if (request.signal.aborted) throw request.signal.reason;
    const requestId = `http-${++serial}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        send('cancel', { requestId });
        terminateRequest(requestId, request.signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      pending.set(requestId, { resolve, reject, method: request.method,
        cleanup: () => request.signal.removeEventListener('abort', abort) });
      request.signal.addEventListener('abort', abort, { once: true });
      send('http-request', { requestId, method: request.method, url: requestAddress(address),
        headers: [...request.headers], body, mode: request.mode, credentials: request.credentials,
        redirect: request.redirect }, body.length ? [body.buffer] : []);
    });
  }
  globalThis.fetch = gatewayFetch;

  class GatewayXHR extends EventTarget {
    constructor() {
      super(); this.readyState = 0; this.status = 0; this.statusText = ''; this.responseURL = '';
      this.timeout = 0; this.responseType = ''; this.upload = new EventTarget(); this._text = '';
      this._response = null; this._headers = new NativeHeaders(); this._responseHeaders = new NativeHeaders();
      this._generation = 0; this._sending = false;
    }
    _emit(type, values = {}) {
      const event = new ProgressEvent(type, values);
      this.dispatchEvent(event); this[`on${type}`]?.call(this, event);
    }
    _state(value) { this.readyState = value; this._emit('readystatechange'); }
    get response() { return this.responseType === '' || this.responseType === 'text' ? this._text : this._response; }
    get responseText() {
      if (!['', 'text'].includes(this.responseType)) throw new DOMException('Non-text responseType', 'InvalidStateError');
      return this._text;
    }
    get responseXML() { throw unsupported('XML response documents are unsupported'); }
    get withCredentials() { return false; }
    set withCredentials(value) { if (value) throw unsupported('Ambient request credentials are unsupported'); }
    open(method, url, async = true, username, password) {
      if (!async || username !== undefined || password !== undefined) throw unsupported('Synchronous or credentialed XHR is unsupported');
      if (this._sending) this.abort();
      this._method = method; this._url = url; this._headers = new NativeHeaders();
      this.status = 0; this._text = ''; this._response = null; this._state(1);
    }
    setRequestHeader(name, value) {
      if (this.readyState !== 1 || this._sending) throw new DOMException('XHR is not opened', 'InvalidStateError');
      this._headers.append(name, value);
    }
    getResponseHeader(name) { return this.readyState < 2 ? null : this._responseHeaders.get(name); }
    getAllResponseHeaders() { return this.readyState < 2 ? '' : [...this._responseHeaders].map(([k, v]) => `${k}: ${v}\r\n`).join(''); }
    overrideMimeType() { throw unsupported('XHR overrideMimeType is unsupported'); }
    abort() {
      this._generation++; clearTimeout(this._timer); this._abort?.abort();
      const sending = this._sending; this._sending = false; this.status = 0; this._state(0);
      if (sending) { this._emit('abort'); this._emit('loadend'); }
    }
    send(body = null) {
      if (this.readyState !== 1 || this._sending) throw new DOMException('XHR is not opened', 'InvalidStateError');
      if (!['', 'text', 'json', 'arraybuffer', 'blob'].includes(this.responseType)) throw unsupported('Unsupported XHR responseType');
      this._sending = true; this._abort = new AbortController();
      const generation = ++this._generation;
      let timedOut = false;
      if (this.timeout > 0) this._timer = setTimeout(() => { timedOut = true; this._abort.abort(); }, this.timeout);
      this._emit('loadstart');
      (async () => {
        try {
          const response = await gatewayFetch(this._url, { method: this._method, headers: this._headers,
            body: /^(?:GET|HEAD)$/i.test(this._method) ? null : body, signal: this._abort.signal });
          if (generation !== this._generation) return;
          this.status = response.status; this.statusText = response.statusText; this.responseURL = response.url;
          this._responseHeaders = response.headers; this._state(2);
          const reader = response.body?.getReader();
          const chunks = [];
          let loaded = 0;
          const decoder = new TextDecoder();
          if (reader) for (;;) {
            const { done, value } = await reader.read();
            if (generation !== this._generation) return;
            if (done) break;
            chunks.push(value); loaded += value.length; this._text += decoder.decode(value, { stream: true }); this._state(3);
            this._emit('progress', { loaded, total: Number(response.headers.get('content-length') || 0), lengthComputable: response.headers.has('content-length') });
          }
          this._text += decoder.decode();
          const bytes = new Uint8Array(loaded); let at = 0;
          for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
          if (this.responseType === 'arraybuffer') this._response = bytes.buffer;
          else if (this.responseType === 'blob') this._response = new Blob([bytes], { type: response.headers.get('content-type') || '' });
          else if (this.responseType === 'json') { try { this._response = JSON.parse(this._text); } catch { this._response = null; } }
          this._state(4); this._emit('load');
        } catch (failure) {
          if (generation !== this._generation) return;
          this.status = 0; this._state(4); this._emit(timedOut ? 'timeout' : 'error');
        } finally {
          if (generation === this._generation) { clearTimeout(this._timer); this._sending = false; this._emit('loadend'); }
        }
      })();
    }
  }
  for (const [name, value] of Object.entries({ UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })) {
    Object.defineProperty(GatewayXHR, name, { value }); Object.defineProperty(GatewayXHR.prototype, name, { value });
  }
  globalThis.XMLHttpRequest = GatewayXHR;

  class GatewayWebSocket extends EventTarget {
    constructor(url, protocols = []) {
      super();
      protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
      if (new Set(protocols).size !== protocols.length || protocols.some(value => typeof value !== 'string' || !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(value))) throw new DOMException('Invalid WebSocket protocols', 'SyntaxError');
      this._url = String(url); this._id = `ws-${++serial}`; this._state = 0; this._protocol = '';
      this._binaryType = 'blob'; this._buffered = 0; this._queue = Promise.resolve();
      sockets.set(this._id, this);
      ready.then(() => {
        if (this._state !== 0) return;
        const address = virtualURL(this._url); if (address.protocol === 'http:') address.protocol = 'ws:';
        this._url = address.href;
        send('ws-open', { socketId: this._id, url: requestAddress(url), protocols });
      }).catch(() => this._finish(1006, '', false));
    }
    get url() { return this._url; }
    get readyState() { return this._state; }
    get protocol() { return this._protocol; }
    get extensions() { return ''; }
    get bufferedAmount() { return this._buffered; }
    get binaryType() { return this._binaryType; }
    set binaryType(value) { if (['blob', 'arraybuffer'].includes(value)) this._binaryType = value; }
    _emit(event) { this.dispatchEvent(event); this[`on${event.type}`]?.call(this, event); }
    _finish(code, reason, wasClean) {
      if (this._state === 3) return;
      this._state = 3; sockets.delete(this._id); this._emit(new CloseEvent('close', { code, reason, wasClean }));
    }
    send(value) {
      if (this._state === 0) throw new DOMException('WebSocket is connecting', 'InvalidStateError');
      if (this._state !== 1) return;
      const binary = value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
      const data = binary ? value instanceof Blob ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new TextEncoder().encode(String(value));
      const size = data.size ?? data.byteLength;
      if (size > maxBodyBytes || size + this._buffered > maxBodyBytes) throw error('ERR_GATEWAY_BODY_LIMIT', 'WebSocket send buffer exceeds maxBodyBytes');
      this._buffered += size;
      // Snapshot typed arrays at send(), and preserve Blob/text ordering.
      const snapshot = data instanceof Blob ? data : data.slice();
      this._queue = this._queue.then(async () => {
        const bytes = snapshot instanceof Blob ? new Uint8Array(await snapshot.arrayBuffer()) : snapshot;
        if (this._state !== 3) send('ws-send', { socketId: this._id, bytes, binary }, [bytes.buffer]);
        this._buffered -= size;
      }).catch(() => { this._emit(new Event('error')); this._finish(1006, '', false); });
    }
    close(code = 1000, reason = '') {
      if (code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) throw new DOMException('Invalid close code', 'InvalidAccessError');
      reason = String(reason);
      if (new TextEncoder().encode(reason).length > 123) throw new DOMException('Close reason too long', 'SyntaxError');
      if (this._state >= 2) return;
      if (this._state === 0) { send('ws-close', { socketId: this._id, code, reason }); this._finish(1006, '', false); return; }
      this._state = 2; this._queue.then(() => send('ws-close', { socketId: this._id, code, reason }));
    }
  }
  for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    Object.defineProperty(GatewayWebSocket, name, { value }); Object.defineProperty(GatewayWebSocket.prototype, name, { value });
  }
  globalThis.WebSocket = GatewayWebSocket;

  const navigate = payload => ready.then(() => send('navigation', payload)).catch(() => {});
  addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href');
    const url = href && href !== '#' ? href : link.getAttribute('data-nacelle-href') || href;
    navigate({ url, method: 'GET' });
  }, true);
  const submit = async (form, submitter) => {
    try {
      await ready;
      const action = submitter?.getAttribute('formaction') || submitter?.getAttribute('data-nacelle-formaction')
        || form.getAttribute('action') || form.getAttribute('data-nacelle-action') || currentPath;
      const method = (submitter?.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
      const data = new FormData(form, submitter);
      const params = new URLSearchParams();
      for (const [key, value] of data) params.append(key, typeof value === 'string' ? value : value.name);
      if (method === 'GET') {
        const url = virtualURL(action); url.search = params.toString();
        navigate({ url: requestAddress(action).startsWith('/') ? url.pathname + url.search + url.hash : url.href, method });
      } else if (method === 'POST') {
        const encoding = submitter?.getAttribute('formenctype') || form.enctype;
        const body = encoding === 'multipart/form-data' ? data : encoding === 'text/plain'
          ? [...params].map(([key, value]) => `${key}=${value}\r\n`).join('') : params;
        const request = new NativeRequest(virtualURL(action), { method, body });
        const bytes = new Uint8Array(await request.arrayBuffer());
        send('navigation', { url: requestAddress(action), method, headers: [...request.headers], body: bytes }, [bytes.buffer]);
      } else throw unsupported(`Unsupported form method: ${method}`);
    } catch (failure) { send('error', diagnostic(failure.code || 'ERR_GATEWAY_NAVIGATION', failure.message)); }
  };
  addEventListener('submit', event => { event.preventDefault(); submit(event.target, event.submitter); }, true);
  HTMLFormElement.prototype.submit = function () { submit(this); };
  for (const kind of ['pushState', 'replaceState']) {
    history[kind] = (state, _unused, url) => {
      const cloned = structuredClone(state);
      const address = virtualURL(url == null ? currentPath : url);
      if (address.origin !== `http://localhost:${virtualPort}`) throw new DOMException('History URL is not virtual', 'SecurityError');
      const path = address.pathname + address.search + address.hash;
      currentPath = path; historyState = cloned;
      if (kind === 'pushState') historyLength++;
      ready.then(() => send('history', { kind, path, state: cloned })).catch(() => {});
    };
  }
  history.go = (delta = 0) => { ready.then(() => send('history', { kind: 'go', delta: Number(delta) })).catch(() => {}); };
  history.back = () => history.go(-1);
  history.forward = () => history.go(1);
  Object.defineProperty(history, 'state', { get: () => historyState });
  Object.defineProperty(history, 'length', { get: () => historyLength });
  addEventListener('securitypolicyviolation', event => {
    const detail = diagnostic('ERR_GATEWAY_RESOURCE_UNSUPPORTED', `Blocked ${event.violatedDirective}: ${event.blockedURI}`);
    send('error', detail);
  });
  for (const name of ['EventSource', 'Worker', 'SharedWorker', 'WebTransport']) {
    globalThis[name] = function () { throw unsupported(`${name} is unsupported in direct mode`); };
  }
  if (navigator.sendBeacon) navigator.sendBeacon = () => { throw unsupported('sendBeacon is unsupported in direct mode'); };
  addEventListener('pagehide', () => { send('close'); close(); });

  const receive = event => {
    const message = event.data;
    if (!message || message.protocol !== PROTOCOL || message.version !== 1
      || message.sessionId !== identity.sessionId || message.nonce !== identity.nonce
      || !Number.isSafeInteger(message.sequence) || message.sequence < 1 || typeof message.type !== 'string'
      || !message.payload || typeof message.payload !== 'object') {
      send('error', diagnostic('ERR_GATEWAY_PROTOCOL', 'Invalid parent envelope')); return;
    }
    if (message.sequence <= incoming) return;
    if (message.sequence !== incoming + 1) {
      send('error', diagnostic('ERR_GATEWAY_SEQUENCE', 'Parent sequence gap')); close(); return;
    }
    incoming = message.sequence;
    const data = message.payload;
    const item = pending.get(data.requestId);
    if (message.type === 'http-response-start' && item) {
      const bodyless = item.method === 'HEAD' || [204, 205, 304].includes(data.status);
      const body = bodyless ? null : new ReadableStream({
        start(controller) { item.controller = controller; },
        cancel() { send('cancel', { requestId: data.requestId }); pending.delete(data.requestId); item.cleanup(); },
      });
      try {
        const response = new NativeResponse(body, { status: data.status, statusText: data.statusText, headers: data.headers });
        Object.defineProperties(response, { url: { value: `http://localhost:${virtualPort}${data.finalUrl}` }, redirected: { value: data.redirected } });
        item.resolve(response);
      } catch (failure) { send('cancel', { requestId: data.requestId }); terminateRequest(data.requestId, failure); }
    } else if (message.type === 'http-response-chunk' && item) item.controller?.enqueue(data.bytes);
    else if (message.type === 'http-response-end') terminateRequest(data.requestId);
    else if (message.type === 'http-response-error') terminateRequest(data.requestId, error(data.code, data.message));
    else if (message.type === 'history') {
      currentPath = data.path; historyState = data.state; historyLength = data.length;
      if (data.popstate) dispatchEvent(new PopStateEvent('popstate', { state: data.state }));
    } else if (message.type === 'diagnostic' || message.type === 'navigation-error') diagnostic(data.code, data.message);
    else if (message.type === 'close') close();
    else if (message.type.startsWith('ws-')) {
      const socket = sockets.get(data.socketId);
      if (!socket) return;
      if (message.type === 'ws-opened') { socket._protocol = data.protocol; socket._state = 1; socket._emit(new Event('open')); }
      else if (message.type === 'ws-message') {
        const value = data.binary ? socket.binaryType === 'blob' ? new Blob([data.bytes]) : data.bytes.buffer : new TextDecoder().decode(data.bytes);
        socket._emit(new MessageEvent('message', { data: value, origin: `http://localhost:${virtualPort}` }));
      } else if (message.type === 'ws-error') { socket._emit(new Event('error')); socket._finish(1006, '', false); }
      else if (message.type === 'ws-closed') socket._finish(data.code, data.reason, data.wasClean);
    }
  };
  // A sandbox without allow-same-origin cannot fetch the parent's Blob URLs.
  // Transfer the parent-owned Blob catalog and create document-local mirrors.
  // Dependencies precede dependants in the catalog, so CSS/module references
  // are substituted before any resource or application script becomes active.
  async function renderDocument(html, resources) {
    const replacements = new Map();
    const replace = text => {
      for (const [source, target] of replacements) text = text.split(source).join(target);
      return text;
    };
    for (const { url, blob } of resources) {
      let content = blob;
      if (['text/javascript', 'text/css'].includes(blob.type)) content = new Blob([replace(await blob.text())], { type: blob.type });
      if (closed) return;
      const local = NativeURL.createObjectURL(content);
      resourceUrls.add(local); replacements.set(url, local);
    }
    if (closed) return;
    const template = document.createElement('template');
    template.innerHTML = replace(html);
    const scripts = [...template.content.querySelectorAll('script')].map(original => {
      const placeholder = document.createComment('virtual script');
      original.replaceWith(placeholder);
      return { original, placeholder };
    });
    document.body.append(template.content);
    const deferred = [];
    const execute = ({ original, placeholder }) => new Promise(resolve => {
      if (closed) { resolve(); return; }
      const script = document.createElement('script');
      for (const attribute of original.attributes) script.setAttribute(attribute.name, attribute.value);
      script.textContent = original.textContent;
      if (script.type === 'module' && !script.hasAttribute('src')) {
        const url = NativeURL.createObjectURL(new Blob([script.textContent], { type: 'text/javascript' }));
        resourceUrls.add(url); script.src = url; script.textContent = '';
      }
      const executable = !script.type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/i.test(script.type);
      const waiting = executable && (script.hasAttribute('src') || script.type === 'module');
      script.async = original.hasAttribute('async');
      if (waiting) {
        script.onload = resolve;
        script.onerror = () => { send('error', diagnostic('ERR_GATEWAY_RESOURCE_UNSUPPORTED', 'A rewritten script could not be loaded')); resolve(); };
      }
      placeholder.replaceWith(script);
      if (!waiting) resolve();
    });
    for (const script of scripts) {
      if (script.original.type === 'module' || script.original.hasAttribute('defer') || script.original.hasAttribute('async')) deferred.push(script);
      else await execute(script);
    }
    await Promise.all(deferred.map(execute));
    if (!closed) document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
  }
  const initialize = async event => {
    const message = event.data;
    if (port || event.source !== parent || !event.ports[0] || message?.type !== 'init'
      || message.protocol !== PROTOCOL || message.version !== 1 || message.sequence !== 1
      || typeof message.sessionId !== 'string' || typeof message.nonce !== 'string'
      || message.nonce.length < 32 || !message.payload) return;
    identity = { sessionId: message.sessionId, nonce: message.nonce };
    incoming = 1; port = event.ports[0]; port.onmessage = receive; port.start();
    removeEventListener('message', initialize);
    currentPath = message.payload.path; virtualPort = message.payload.virtualPort;
    maxBodyBytes = message.payload.maxBodyBytes;
    historyState = message.payload.historyState; historyLength = message.payload.historyLength;
    send('ready', { bootstrapVersion: 1 }); readyResolve();
    try {
      if (message.payload.documentHtml !== undefined) await renderDocument(message.payload.documentHtml, message.payload.resources || []);
    } catch (failure) { send('error', diagnostic('ERR_GATEWAY_RESOURCE_UNSUPPORTED', failure.message)); }
    if (closed) return;
    if (message.payload.requestId) send('loaded', { requestId: message.payload.requestId, path: currentPath, title: document.title });
    for (const detail of message.payload.diagnostics || []) diagnostic(detail.code, detail.message);
    if (message.payload.popstate) dispatchEvent(new PopStateEvent('popstate', { state: historyState }));
  };
  addEventListener('message', initialize);
}

export const DIRECT_IFRAME_BOOTSTRAP = `(${directIframeBootstrap.toString()})();`.replace(/<\/script/gi, '<\\/script');
