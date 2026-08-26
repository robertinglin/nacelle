import { EventEmitter } from './events.js';
import { Duplex } from './streams.js';
import { createProxyCapability } from './proxy.js';

const SERVER_REGISTRY = new Map();
let nextServerPort = 46000;
let nextStreamId = 1;

export const constants = Object.freeze({
  DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
  DEFAULT_SETTINGS_ENABLE_PUSH: 1,
  DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295,
  DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535,
  DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384,
  DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,
  NGHTTP2_NO_ERROR: 0,
  NGHTTP2_PROTOCOL_ERROR: 1,
  NGHTTP2_INTERNAL_ERROR: 2,
  NGHTTP2_FLOW_CONTROL_ERROR: 3,
  NGHTTP2_SETTINGS_TIMEOUT: 4,
  NGHTTP2_STREAM_CLOSED: 5,
  NGHTTP2_FRAME_SIZE_ERROR: 6,
  NGHTTP2_REFUSED_STREAM: 7,
  NGHTTP2_CANCEL: 8,
  NGHTTP2_COMPRESSION_ERROR: 9,
  NGHTTP2_CONNECT_ERROR: 10,
  NGHTTP2_ENHANCE_YOUR_CALM: 11,
  NGHTTP2_INADEQUATE_SECURITY: 12,
  NGHTTP2_HTTP_1_1_REQUIRED: 13,
  NGHTTP2_FLAG_NONE: 0,
  NGHTTP2_FLAG_END_STREAM: 1,
  NGHTTP2_FLAG_END_HEADERS: 4,
  NGHTTP2_FLAG_PADDED: 8,
  NGHTTP2_FLAG_PRIORITY: 32,
  NGHTTP2_HEADER_METHOD: ':method',
  NGHTTP2_HEADER_PATH: ':path',
  NGHTTP2_HEADER_STATUS: ':status',
  NGHTTP2_HEADER_SCHEME: ':scheme',
  NGHTTP2_HEADER_AUTHORITY: ':authority',
  NGHTTP2_HEADER_PROTOCOL: ':protocol',
  NGHTTP2_HEADER_CONTENT_TYPE: 'content-type',
  NGHTTP2_HEADER_CONTENT_LENGTH: 'content-length',
  NGHTTP2_HEADER_TE: 'te',
  NGHTTP2_HEADER_TRACEPARENT: 'traceparent',
  NGHTTP2_HEADER_ACCEPT: 'accept',
  NGHTTP2_HEADER_ACCEPT_ENCODING: 'accept-encoding',
  NGHTTP2_HEADER_USER_AGENT: 'user-agent',
  NGHTTP2_HEADER_PATH: ':path',
  HTTP2_HEADER_METHOD: ':method',
  HTTP2_HEADER_PATH: ':path',
  HTTP2_HEADER_STATUS: ':status',
  HTTP2_HEADER_SCHEME: ':scheme',
  HTTP2_HEADER_AUTHORITY: ':authority',
  HTTP2_HEADER_CONTENT_TYPE: 'content-type',
  HTTP2_HEADER_CONTENT_LENGTH: 'content-length',
  HTTP2_HEADER_TE: 'te',
  HTTP2_HEADER_ACCEPT: 'accept',
  HTTP2_HEADER_ACCEPT_ENCODING: 'accept-encoding',
  HTTP2_HEADER_USER_AGENT: 'user-agent',
});

const DEFAULT_SETTINGS = Object.freeze({
  headerTableSize: constants.DEFAULT_SETTINGS_HEADER_TABLE_SIZE,
  enablePush: true,
  initialWindowSize: constants.DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE,
  maxFrameSize: constants.DEFAULT_SETTINGS_MAX_FRAME_SIZE,
  maxConcurrentStreams: constants.DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS,
  maxHeaderListSize: constants.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE,
});

export const sensitiveHeaders = Symbol('nodejs.http2.sensitiveHeaders');
export const sensitiveHTTP2Headers = sensitiveHeaders;

function schedule(callback) {
  queueMicrotask(callback);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function http2Error(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bytesFor(value, scope) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') return new (scope.TextEncoder || TextEncoder)().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new TypeError('HTTP/2 stream chunks must be strings or Uint8Array values');
}

function normalizeHeaders(headers) {
  if (!isRecord(headers)) throw new TypeError('HTTP/2 headers must be an object');
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower) && !lower.startsWith(':')) {
      throw http2Error('ERR_HTTP2_INVALID_HEADER_NAME', `Invalid HTTP/2 header name: ${name}`);
    }
    if (['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'].includes(lower)) {
      throw http2Error('ERR_HTTP2_INVALID_CONNECTION_HEADERS', `HTTP/2 forbids the ${name} header`);
    }
    if (lower !== name && !lower.startsWith(':')) {
      throw http2Error('ERR_HTTP2_INVALID_HEADER_NAME', `HTTP/2 header names must be lowercase: ${name}`);
    }
    if (value === undefined || value === null) continue;
    if (lower === ':status' && !Array.isArray(value) && Number.isInteger(Number(value))) result[lower] = Number(value);
    else result[lower] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return result;
}

function authorityParts(authority, scope) {
  let url;
  try {
    url = new (scope.URL || URL)(String(authority).includes('://') ? authority : `https://${authority}`);
  } catch (error) {
    throw http2Error('ERR_INVALID_URL', `Invalid HTTP/2 authority: ${authority}`);
  }
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : 443));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw http2Error('ERR_SOCKET_BAD_PORT', `Invalid port: ${url.port}`);
  return { host: url.hostname, port, protocol: url.protocol };
}

function registryKey(host, port) {
  return `${String(host).toLowerCase()}:${port}`;
}

function allocatePort() {
  const start = nextServerPort;
  do {
    nextServerPort += 1;
    if (nextServerPort > 50000) nextServerPort = 46000;
    if ([...SERVER_REGISTRY.values()].every((server) => server._port !== nextServerPort)) return nextServerPort;
  } while (nextServerPort !== start);
  throw http2Error('EADDRINUSE', 'No virtual HTTP/2 ports are available');
}

function normalizeProxy(proxy, capability) {
  if (!proxy) return null;
  if (typeof proxy.connect === 'function' && typeof proxy.call === 'function') return proxy;
  return createProxyCapability({
    selection: proxy,
    capability: capability ?? proxy.capability,
    capabilities: capability ?? proxy.capabilities,
  });
}

class VirtualHttp2Stream extends Duplex {
  constructor(session, options = {}) {
    super({ highWaterMark: options.highWaterMark });
    this.session = session;
    this.id = options.id || nextStreamId;
    if (!options.id) nextStreamId += 2;
    this.pending = true;
    this.headersSent = false;
    this.sentHeaders = null;
    this.rstCode = 0;
    this.aborted = false;
    this.closed = false;
    this.destroyed = false;
    this._scope = session._scope;
    this._role = options.role || 'client';
    this._headers = options.headers || {};
    this._body = [];
    this._responseHeaders = null;
    this._responseComplete = false;
    this._peer = null;
    this._writable._write = (chunk, encoding, callback) => {
      try {
        this._body.push(bytesFor(chunk, this._scope));
        callback();
      } catch (error) {
        callback(error);
      }
    };
    this._writable._final = (callback) => {
      schedule(() => {
        if (this._role === 'client') this.session._dispatch(this);
        else this._finishResponse();
      });
      callback();
    };
  }

  on(name, listener) {
    const result = super.on(name, listener);
    if (name === 'data') this.resume();
    if (name === 'end' && this._endEmitted) schedule(() => listener.call(this));
    if (name === 'end' && this._ended && !this._buffer.length && !this._endEmitted) {
      schedule(() => this._maybeEmitEnd());
    }
    return result;
  }

  _bodyBytes() {
    const size = this._body.reduce((total, part) => total + part.byteLength, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of this._body) { result.set(part, offset); offset += part.byteLength; }
    return result;
  }

  _receiveResponse(headers, body, done = false) {
    if (!this._responseHeaders) {
      this._responseHeaders = headers;
      this.pending = false;
      this.emit('response', headers, 0);
      this.emit('headers', headers, 0);
    }
    if (body?.byteLength) this.push(body);
    if (done) {
      this._responseComplete = true;
      this.closed = true;
      this.push(null);
      schedule(() => this.emit('close'));
    }
  }

  respond(headers, options = {}) {
    if (this._role !== 'server') throw http2Error('ERR_HTTP2_INVALID_STREAM', 'Only server streams can respond');
    if (this.headersSent) throw http2Error('ERR_HTTP2_HEADERS_SENT', 'Response headers already sent');
    this.sentHeaders = normalizeHeaders(headers);
    this.headersSent = true;
    this._peer?._receiveResponse(this.sentHeaders, null, Boolean(options.endStream));
    return this;
  }

  additionalHeaders(headers) {
    if (this._role !== 'server' || !this.headersSent) throw http2Error('ERR_HTTP2_INVALID_STREAM', 'Additional headers require an active response');
    this._peer?.emit('headers', normalizeHeaders(headers), 0);
  }

  _sendResponseChunk(bytes) {
    if (!this.headersSent) this.respond({ ':status': 200 });
    this._peer?._receiveResponse(null, bytes, false);
  }

  _finishResponse() {
    if (!this.headersSent) this.respond({ ':status': 200 });
    this.closed = true;
    this._peer?._receiveResponse(null, this._bodyBytes(), true);
    schedule(() => this.emit('close'));
  }

  write(chunk, encoding, callback) {
    if (this._role === 'server' && this.headersSent) {
      const bytes = bytesFor(chunk, this._scope);
      this._sendResponseChunk(bytes);
      callback = typeof encoding === 'function' ? encoding : callback;
      callback?.();
      return true;
    }
    return super.write(chunk, encoding, callback);
  }

  close(code = constants.NGHTTP2_NO_ERROR, callback) {
    this.rstCode = code;
    this.aborted = code !== constants.NGHTTP2_NO_ERROR;
    this.closed = true;
    this._peer?._receiveResponse(null, null, true);
    schedule(() => { this.emit('close'); callback?.(); });
    return this;
  }

  rstStream(code) { return this.close(code); }
  setTimeout(milliseconds, callback) { if (callback) this.once('timeout', callback); this._timeout = setTimeout(() => this.emit('timeout'), milliseconds); return this; }
  setNoDelay() { return this; }
  setEncoding() { return this; }
  priority() { return this; }
  pushStream() { throw http2Error('ERR_HTTP2_NESTED_PUSH', 'HTTP/2 push streams are unavailable in the virtual browser contract'); }

  destroy(error) {
    if (this.closed && this.destroyed) return this;
    this.destroyed = true;
    this.closed = true;
    this.aborted ||= Boolean(error);
    if (error) this.emit('error', error);
    schedule(() => this.emit('close'));
    return super.destroy(error);
  }
}

export class ClientHttp2Session extends EventEmitter {
  constructor(authority, options, internal) {
    super();
    this._scope = internal.scope;
    this._authority = authority;
    this._options = options;
    this._proxy = internal.proxy;
    this._server = internal.server;
    this._pendingRequests = [];
    this._streams = new Set();
    this._connected = false;
    this.closed = false;
    this.destroyed = false;
    this.connecting = true;
    this.type = 1;
    this.alpnProtocol = 'h2';
    this.encrypted = true;
    this.localSettings = { ...DEFAULT_SETTINGS };
    this.remoteSettings = { ...DEFAULT_SETTINGS };
    this.socket = Object.freeze({ encrypted: true, alpnProtocol: 'h2', authorized: true });
    schedule(() => void this._connect());
  }

  async _connect() {
    try {
      if (this._proxy) {
        const result = await this._proxy.connect({
          target: `${this._authority.host}:${this._authority.port}`,
          hostname: this._authority.host,
          port: this._authority.port,
          protocol: this._authority.protocol,
          alpnProtocol: 'h2',
        });
        if (result?.alpnProtocol && result.alpnProtocol !== 'h2') {
          throw http2Error('ERR_HTTP2_ALPN_PROTOCOL', `Proxy negotiated ${result.alpnProtocol}, not h2`);
        }
      }
      this._connected = true;
      this.connecting = false;
      this.emit('connect');
      this.emit('remoteSettings', { ...this.remoteSettings });
      this.emit('localSettings', { ...this.localSettings });
      if (this._server) this._server._acceptSession(this);
      for (const stream of this._pendingRequests.splice(0)) this._dispatch(stream);
    } catch (error) {
      this.destroy(error);
    }
  }

  request(headers, options = {}) {
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_SESSION', 'Cannot create a stream on a closed session');
    const normalized = normalizeHeaders(headers);
    if (!normalized[':method']) normalized[':method'] = 'GET';
    if (!normalized[':path'] && normalized[':method'] !== 'CONNECT') normalized[':path'] = '/';
    const stream = new VirtualHttp2Stream(this, { ...options, headers: normalized, role: 'client' });
    stream._headers = normalized;
    this._streams.add(stream);
    stream.once('close', () => this._streams.delete(stream));
    if (options.endStream) stream.end();
    return stream;
  }

  _dispatch(stream) {
    if (stream.closed) return;
    if (!this._connected) { this._pendingRequests.push(stream); return; }
    if (this._server) {
      const serverStream = new VirtualHttp2Stream(this, { id: stream.id, role: 'server', headers: stream._headers });
      stream._peer = serverStream;
      serverStream._peer = stream;
      this._server.emit('stream', serverStream, { ...stream._headers }, 0);
      const body = stream._bodyBytes();
      if (body.byteLength) serverStream.push(body);
      serverStream.push(null);
      if (this._server.listenerCount('stream') === 0) {
        schedule(() => {
          if (!serverStream.headersSent) serverStream.respond({ ':status': 200, 'x-bnh-virtual': '1' });
          if (!serverStream.closed) serverStream.end();
        });
      }
      return;
    }
    schedule(() => stream._receiveResponse({ ':status': 200, 'x-bnh-virtual': '1' }, null, true));
  }

  settings(settings = {}) {
    if (!isRecord(settings)) throw new TypeError('HTTP/2 settings must be an object');
    this.localSettings = { ...this.localSettings, ...settings };
    schedule(() => this.emit('localSettings', { ...this.localSettings }));
    return this;
  }

  ping(payload, callback) {
    if (typeof payload === 'function') { callback = payload; payload = undefined; }
    const value = payload === undefined ? new Uint8Array(8) : bytesFor(payload, this._scope);
    if (value.byteLength !== 8) throw http2Error('ERR_HTTP2_INVALID_PING_PAYLOAD', 'HTTP/2 ping payload must be exactly 8 bytes');
    schedule(() => callback?.(null, 0, value));
    return this;
  }

  goaway(code = constants.NGHTTP2_NO_ERROR, lastStreamID = 0, opaqueData) {
    this.emit('goaway', code, lastStreamID, opaqueData);
    return this;
  }

  setTimeout(milliseconds, callback) { if (callback) this.once('timeout', callback); this._timeout = setTimeout(() => this.emit('timeout'), milliseconds); return this; }
  ref() { return this; }
  unref() { return this; }

  close(callback) {
    if (callback) this.once('close', callback);
    if (this.closed) return this;
    this.closed = true;
    this.connecting = false;
    for (const stream of this._streams) stream.close(constants.NGHTTP2_CANCEL);
    schedule(() => this.emit('close'));
    return this;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.closed = true;
    this.connecting = false;
    if (error) this.emit('error', error);
    schedule(() => this.emit('close'));
    return this;
  }
}

export class Http2Server extends EventEmitter {
  constructor(options = {}, listener, internal = {}) {
    super();
    if (typeof options === 'function') { listener = options; options = {}; }
    this._scope = internal.scope;
    this._options = { ...options };
    this._secure = Boolean(internal.secure);
    this._host = 'localhost';
    this._port = null;
    this.listening = false;
    this._sessions = new Set();
    if (typeof listener === 'function') this.on('stream', listener);
  }

  listen(...args) {
    let callback;
    if (typeof args.at(-1) === 'function') callback = args.pop();
    const input = isRecord(args[0]) ? { ...args[0] } : { port: args[0], host: args[1] };
    this._host = String(input.host || input.hostname || 'localhost');
    this._port = Number(input.port || 0) || allocatePort();
    if (!Number.isInteger(this._port) || this._port < 1 || this._port > 65535) throw http2Error('ERR_SOCKET_BAD_PORT', `Invalid port: ${input.port}`);
    const key = registryKey(this._host, this._port);
    if (SERVER_REGISTRY.has(key)) {
      const error = http2Error('EADDRINUSE', `listen EADDRINUSE ${this._host}:${this._port}`);
      schedule(() => this.emit('error', error));
      return this;
    }
    SERVER_REGISTRY.set(key, this);
    this.listening = true;
    schedule(() => { this.emit('listening'); callback?.(); });
    return this;
  }

  _acceptSession(session) {
    this._sessions.add(session);
    session.once('close', () => this._sessions.delete(session));
    this.emit('session', session);
  }

  address() { return this.listening ? { address: this._host, family: 'IPv4', port: this._port } : null; }
  close(callback) {
    if (callback) this.once('close', callback);
    if (!this.listening) { schedule(() => this.emit('close')); return this; }
    SERVER_REGISTRY.delete(registryKey(this._host, this._port));
    this.listening = false;
    for (const session of this._sessions) session.close();
    schedule(() => this.emit('close'));
    return this;
  }
  setTimeout(milliseconds, callback) { if (callback) this.once('timeout', callback); this._timeout = setTimeout(() => this.emit('timeout'), milliseconds); return this; }
  ref() { return this; }
  unref() { return this; }
}

export function getDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

export function createHttp2Module(scope = globalThis, options = {}) {
  if (options === undefined || (options && Object.keys(options).length === 0 && isRecord(scope)
    && ['proxy', 'capability'].some((key) => Object.hasOwn(scope, key)))) {
    options = scope;
    scope = globalThis;
  }
  const proxy = normalizeProxy(options.proxy, options.capability);

  function connect(authority, connectOptions = {}, listener) {
    if (typeof connectOptions === 'function') { listener = connectOptions; connectOptions = {}; }
    const target = authorityParts(authority, scope);
    const server = SERVER_REGISTRY.get(registryKey(target.host, target.port)) || SERVER_REGISTRY.get(registryKey('localhost', target.port));
    const session = new ClientHttp2Session(target, { ...connectOptions }, { scope, proxy: normalizeProxy(connectOptions.proxy, connectOptions.capability) || proxy, server });
    if (typeof listener === 'function') session.once('connect', listener);
    return session;
  }

  function createServer(serverOptions, listener) {
    return new Http2Server(serverOptions, listener, { scope, secure: false });
  }

  function createSecureServer(serverOptions, listener) {
    return new Http2Server(serverOptions, listener, { scope, secure: true });
  }

  return Object.freeze({
    connect,
    createServer,
    createSecureServer,
    constants,
    getDefaultSettings,
    sensitiveHeaders,
    sensitiveHTTP2Headers,
    ClientHttp2Session,
    ClientHttp2Stream: VirtualHttp2Stream,
    Http2Session: ClientHttp2Session,
    Http2Stream: VirtualHttp2Stream,
    Http2Server,
    Http2SecureServer: Http2Server,
  });
}

export const createHttp2Contract = createHttp2Module;
export const createHttp2Compatibility = createHttp2Module;

const defaultHttp2 = createHttp2Module();
export const connect = defaultHttp2.connect;
export const createServer = defaultHttp2.createServer;
export const createSecureServer = defaultHttp2.createSecureServer;
export const ClientHttp2Stream = defaultHttp2.ClientHttp2Stream;
export default defaultHttp2;
