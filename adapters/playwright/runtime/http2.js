import { EventEmitter } from './events.js';
import { Duplex, Readable, Stream } from './streams.js';
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

function publishDiagnostic(diagnostics, name, message) {
  const channel = diagnostics?.channel?.(name);
  if (channel?.hasSubscribers) channel.publish(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function http2Error(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function bytesFor(value, scope, encoding = 'utf8') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') {
    encoding = String(encoding).toLowerCase();
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return new (scope.TextEncoder || TextEncoder)().encode(value);
    }
    if (typeof scope.Buffer?.from === 'function') return new Uint8Array(scope.Buffer.from(value, encoding));
    if (!['ascii', 'base64', 'base64url', 'binary', 'hex', 'latin1', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'].includes(encoding)) {
      const error = new TypeError(`Unknown encoding: ${encoding}`);
      error.code = 'ERR_UNKNOWN_ENCODING';
      throw error;
    }
    throw new TypeError(`HTTP/2 stream encoding requires Buffer support: ${encoding}`);
  }
  if (value !== null && typeof value === 'object'
    && ['[object ArrayBuffer]', '[object SharedArrayBuffer]'].includes(Object.prototype.toString.call(value))) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new TypeError('HTTP/2 stream chunks must be strings or Uint8Array values');
}

function normalizeHeaders(headers) {
  const isArray = Array.isArray(headers);
  if (!isRecord(headers) && !isArray) throw new TypeError('HTTP/2 headers must be an object');
  const result = Object.create(null);
  const entries = isArray
    ? Array.from({ length: Math.floor(headers.length / 2) }, (_, index) => [headers[index * 2], headers[index * 2 + 1]])
    : Object.entries(headers);
  for (const [name, value] of entries) {
    if (name === undefined || name === null) throw new TypeError('HTTP/2 header names must be strings');
    const lower = String(name).toLowerCase();
    const isPseudo = lower.startsWith(':');
    if (isPseudo ? !/^:[a-z][a-z0-9-]*$/.test(lower) : !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower)) {
      throw http2Error('ERR_HTTP2_INVALID_HEADER_NAME', `Invalid HTTP/2 header name: ${name}`);
    }
    if (isPseudo && ![':authority', ':method', ':path', ':protocol', ':scheme', ':status'].includes(lower)) {
      throw http2Error('ERR_HTTP2_INVALID_PSEUDOHEADER', `Invalid HTTP/2 pseudo-header: ${name}`);
    }
    if (['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'].includes(lower)) {
      throw http2Error('ERR_HTTP2_INVALID_CONNECTION_HEADERS', `HTTP/2 forbids the ${name} header`);
    }
    if (value === undefined || value === null) continue;
    if (lower === ':status') {
      if (Array.isArray(value) || !Number.isInteger(Number(value)) || Number(value) < 100 || Number(value) > 999) {
        throw http2Error('ERR_HTTP2_INVALID_STATUS', `Invalid HTTP/2 status code: ${value}`);
      }
      result[lower] = Number(value);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (/\0|[\r\n]/.test(String(item))) {
        throw http2Error('ERR_HTTP2_INVALID_HEADER_VALUE', `Invalid HTTP/2 header value for ${name}`);
      }
    }
    result[isArray && !isPseudo ? String(name) : lower] = Array.isArray(value) ? values.map(String) : String(value);
  }
  return result;
}

function rawHeaderPairs(headers) {
  const entries = Object.entries(headers || {});
  const ordered = [
    ...entries.filter(([name]) => String(name).startsWith(':')),
    ...entries.filter(([name]) => !String(name).startsWith(':')),
  ];
  return ordered.flatMap(([name, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) => [name, item]);
  });
}

function serverFor(host, port) {
  const exact = SERVER_REGISTRY.get(registryKey(host, port));
  if (exact) return exact;
  return [...SERVER_REGISTRY.values()].find((server) => server._port === port
    && (server._host === 'localhost' || host === 'localhost'
      || (server._host === '127.0.0.1' && host === '127.0.0.1')));
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

function noSocketManipulationError() {
  return http2Error(
    'ERR_HTTP2_NO_SOCKET_MANIPULATION',
    'HTTP/2 sockets should not be directly manipulated (e.g. read and written)',
  );
}

const compatibilitySocketHandler = {
  has(stream, property) {
    const sessionSocket = stream.session?.socket;
    return property in stream || Boolean(sessionSocket && property in sessionSocket);
  },

  get(stream, property) {
    switch (property) {
      case 'on':
      case 'once':
      case 'end':
      case 'emit':
      case 'destroy':
        return stream[property].bind(stream);
      case 'writable':
      case 'destroyed':
        return stream[property];
      case 'readable':
        return stream._compatRequest ? stream._compatRequest.readable : stream.readable;
      case 'setTimeout': {
        const session = stream.session;
        return (session || stream).setTimeout.bind(session || stream);
      }
      case 'write':
      case 'read':
      case 'pause':
      case 'resume':
        throw noSocketManipulationError();
      default: {
        const sessionSocket = stream.session?.socket;
        const value = sessionSocket?.[property];
        return typeof value === 'function' ? value.bind(sessionSocket) : value;
      }
    }
  },

  getPrototypeOf(stream) {
    return Object.getPrototypeOf(stream.session?.socket || stream);
  },

  set(stream, property, value) {
    switch (property) {
      case 'writable':
      case 'readable':
      case 'destroyed':
      case 'on':
      case 'once':
      case 'end':
      case 'emit':
      case 'destroy':
        stream[property] = value;
        return true;
      case 'setTimeout': {
        const session = stream.session;
        (session || stream).setTimeout = value;
        return true;
      }
      case 'write':
      case 'read':
      case 'pause':
      case 'resume':
        throw noSocketManipulationError();
      default: {
        const sessionSocket = stream.session?.socket;
        if (sessionSocket) sessionSocket[property] = value;
        else stream[property] = value;
        return true;
      }
    }
  },
};

function compatibilitySocket(stream) {
  if (!stream._compatSocket) stream._compatSocket = new Proxy(stream, compatibilitySocketHandler);
  return stream._compatSocket;
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
    this._vfs = session._vfs;
    this._diagnostics = session._diagnostics;
    this._role = options.role || 'client';
    this._isPush = Boolean(options.push);
    Object.defineProperty(this, 'constructor', {
      configurable: true,
      value: { name: this._role === 'server' ? 'ServerHttp2Stream' : 'ClientHttp2Stream' },
    });
    this._headers = options.headers || {};
    this._body = [];
    this._diagnosticChunks = [];
    this._dispatched = false;
    this._bodyDiagnosticsPublished = false;
    this._finishDiagnosticsPublished = false;
    this._closeDiagnosticsPublished = false;
    this._responseHeaders = null;
    this._responseComplete = false;
    this._responseFile = null;
    this._peer = null;
    this._compatRequest = null;
    this._compatSocket = null;
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
        if (this._role === 'client') {
          this._publishBodyDiagnostics();
          this.session._dispatch(this);
        } else this._finishResponse();
      });
      callback();
    };
  }

  get closed() {
    return Boolean(this._http2Closed);
  }

  set closed(value) {
    this._http2Closed = Boolean(value);
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

  _publishBodyDiagnostics() {
    if (this._bodyDiagnosticsPublished || this._role !== 'client') return;
    this._bodyDiagnosticsPublished = true;
    if (this._diagnosticChunks.length > 0) {
      const writev = this._diagnosticChunks.length > 1;
      const chunks = this._diagnosticChunks;
      const data = writev
        ? chunks.every(({ chunk }) => typeof chunk !== 'string')
          ? chunks.map(({ chunk }) => chunk)
          : chunks.map(({ chunk, encoding }) => ({ chunk, encoding }))
        : chunks[0].chunk;
      publishDiagnostic(this._diagnostics, 'http2.client.stream.bodyChunkSent', {
        stream: this,
        writev,
        data,
        encoding: writev ? '' : this._diagnosticChunks[0].encoding,
      });
    }
    publishDiagnostic(this._diagnostics, 'http2.client.stream.bodySent', { stream: this });
  }

  _publishFinishDiagnostics(headers, flags = 0) {
    if (this._finishDiagnosticsPublished) return;
    this._finishDiagnosticsPublished = true;
    publishDiagnostic(this._diagnostics, `http2.${this._role}.stream.finish`, {
      stream: this,
      headers,
      flags,
    });
  }

  _publishCreatedDiagnostics(headers) {
    publishDiagnostic(this._diagnostics, `http2.${this._role}.stream.created`, {
      stream: this,
      headers,
    });
  }

  _publishStartDiagnostics(headers) {
    publishDiagnostic(this._diagnostics, `http2.${this._role}.stream.start`, {
      stream: this,
      headers,
    });
  }

  _publishCloseDiagnostics() {
    if (this._closeDiagnosticsPublished) return;
    this._closeDiagnosticsPublished = true;
    publishDiagnostic(this._diagnostics, `http2.${this._role}.stream.close`, { stream: this });
  }

  _receiveResponse(headers, body, done = false) {
    if (!this._responseHeaders) {
      this._responseHeaders = headers;
      this.pending = false;
      if (this._role === 'client') this._publishFinishDiagnostics(headers);
      this.emit('response', headers, 0);
      this.emit('headers', headers, 0);
    }
    if (body?.byteLength) this.push(body);
    if (done) {
      this._responseComplete = true;
      this.closed = true;
      this.push(null);
      this._publishCloseDiagnostics();
      schedule(() => this.emit('close'));
    }
  }

  respond(headers = {}, options = {}) {
    if (this._role !== 'server') throw http2Error('ERR_HTTP2_INVALID_STREAM', 'Only server streams can respond');
    if (this.headersSent) throw http2Error('ERR_HTTP2_HEADERS_SENT', 'Response headers already sent');
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw http2Error('ERR_INVALID_ARG_TYPE', 'options must be an object');
    }
    this.sentHeaders = normalizeHeaders(headers);
    if (!this.sentHeaders[':status']) this.sentHeaders[':status'] = 200;
    this.headersSent = true;
    if (this._role === 'server') this._publishFinishDiagnostics(this.sentHeaders);
    this._peer?._receiveResponse(this.sentHeaders, null, Boolean(options.endStream));
    return this;
  }

  respondWithFD(fdValue, headers = {}, options = {}) {
    if (this._role !== 'server') throw http2Error('ERR_HTTP2_INVALID_STREAM', 'Only server streams can respond');
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_STREAM', 'The stream has been destroyed');
    if (this.headersSent) throw http2Error('ERR_HTTP2_HEADERS_SENT', 'Response headers already sent');
    if (!this._vfs?.readDescriptor) {
      throw http2Error('ERR_HTTP2_FD_UNAVAILABLE', 'HTTP/2 file descriptor responses require a VFS-backed runtime');
    }

    const fd = typeof fdValue === 'number' ? fdValue : fdValue?.fd;
    if (!Number.isInteger(fd)) throw http2Error('ERR_INVALID_ARG_TYPE', 'fd must be a number or a FileHandle');
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw http2Error('ERR_INVALID_ARG_TYPE', 'options must be an object');
    }
    for (const name of ['offset', 'length']) {
      if (options[name] !== undefined && (typeof options[name] !== 'number' || !Number.isFinite(options[name]))) {
        throw http2Error('ERR_INVALID_ARG_VALUE', `options.${name} must be a number`);
      }
    }
    if (options.statCheck !== undefined && typeof options.statCheck !== 'function') {
      throw http2Error('ERR_INVALID_ARG_VALUE', 'options.statCheck must be a function');
    }

    let stat;
    try {
      stat = this._vfs.fs.fstatSync(fd);
      const responseHeaders = normalizeHeaders(headers);
      const responseOptions = {
        ...options,
        offset: options.offset ?? 0,
        length: options.length ?? -1,
      };
      if (options.statCheck?.(stat, responseHeaders, responseOptions) === false) {
        this._releaseResponseFile(fd);
        return this;
      }
      if (this.headersSent) {
        this._releaseResponseFile(fd);
        return this;
      }

      const offset = Math.max(0, Math.trunc(responseOptions.offset));
      const available = Math.max(0, stat.size - offset);
      const length = responseOptions.length < 0
        ? available
        : Math.min(Math.max(0, Math.trunc(responseOptions.length)), available);
      responseHeaders['content-length'] = String(length);
      const status = Number(responseHeaders[':status'] ?? 200);
      if ([204, 205, 304].includes(status) || this._headers[':method'] === 'HEAD') {
        throw http2Error('ERR_HTTP2_PAYLOAD_FORBIDDEN', `Responses with ${status} status must not have a payload`);
      }
      this.respond(responseHeaders);

      if (length === 0) {
        this.end();
        return this;
      }

      let position = offset;
      let remaining = length;
      const readNext = () => {
        if (this.closed || this.destroyed) return;
        const buffer = new Uint8Array(Math.min(remaining, 64 * 1024));
        this._vfs.readDescriptor(fd, buffer, 0, buffer.length, position, (error, result) => {
          if (error) {
            this.destroy(error);
            return;
          }
          if (!result.bytesRead) {
            this.end();
            return;
          }
          const chunk = buffer.subarray(0, result.bytesRead);
          position += result.bytesRead;
          remaining -= result.bytesRead;
          this._sendResponseChunk(chunk);
          if (remaining) readNext();
          else this.end();
        });
      };
      readNext();
      return this;
    } catch (error) {
      this._releaseResponseFile(fd);
      throw error;
    }
  }

  respondWithFile(pathValue, headers = {}, options = {}) {
    if (this._role !== 'server') throw http2Error('ERR_HTTP2_INVALID_STREAM', 'Only server streams can respond');
    if (!this._vfs?.fs?.openSync) {
      throw http2Error('ERR_HTTP2_FILE_UNAVAILABLE', 'HTTP/2 file responses require a VFS-backed runtime');
    }
    let fd;
    try {
      fd = this._vfs.fs.openSync(pathValue, 'r');
      this._responseFile = { fd };
      return this.respondWithFD(fd, headers, options);
    } catch (error) {
      this._releaseResponseFile(fd);
      throw error;
    }
  }

  _releaseResponseFile(fd = this._responseFile?.fd) {
    if (!this._responseFile || this._responseFile.fd !== fd) return;
    this._responseFile = null;
    try { this._vfs.fs.closeSync(fd); } catch {}
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
    this._releaseResponseFile();
    this._publishCloseDiagnostics();
    schedule(() => this.emit('close'));
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }
    const diagnosticEncoding = typeof chunk === 'string' ? String(encoding || 'utf8') : 'buffer';
    this._diagnosticChunks.push({ chunk, encoding: diagnosticEncoding });
    if (typeof chunk === 'string') chunk = bytesFor(chunk, this._scope, encoding);
    if (this._role === 'server' && this.headersSent) {
      this._sendResponseChunk(chunk);
      callback?.();
      return true;
    }
    return super.write(chunk, encoding, callback);
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
      encoding = 'utf8';
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }
    if (chunk !== undefined) {
      const diagnosticEncoding = typeof chunk === 'string' ? String(encoding || 'utf8') : 'buffer';
      this._diagnosticChunks.push({ chunk, encoding: diagnosticEncoding });
    }
    if (typeof chunk === 'string') chunk = bytesFor(chunk, this._scope, encoding);
    return super.end(chunk, encoding, callback);
  }

  close(code = constants.NGHTTP2_NO_ERROR, callback) {
    this.rstCode = code;
    this.aborted = code !== constants.NGHTTP2_NO_ERROR;
    this.closed = true;
    this._releaseResponseFile();
    this._peer?._receiveResponse(null, null, true);
    this._publishCloseDiagnostics();
    schedule(() => { this.emit('close'); callback?.(); });
    return this;
  }

  rstStream(code) { return this.close(code); }
  setTimeout(milliseconds, callback) { if (callback) this.once('timeout', callback); this._timeout = setTimeout(() => this.emit('timeout'), milliseconds); return this; }
  setNoDelay() { return this; }
  priority() { return this; }
  pushStream(headers = {}, options = {}, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (!isRecord(options)) throw new TypeError('options must be an object');
    if (this._role !== 'server') throw http2Error('ERR_HTTP2_INVALID_STREAM', 'Only server streams can push');
    if (this._isPush) throw http2Error('ERR_HTTP2_NESTED_PUSH', 'Cannot create a push stream from a push stream');
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_STREAM', 'The stream has been destroyed');
    if (this.session.remoteSettings.enablePush === false) {
      throw http2Error('ERR_HTTP2_PUSH_DISABLED', 'HTTP/2 push streams are disabled');
    }
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const normalized = normalizeHeaders(headers);
    if (!normalized[':method']) normalized[':method'] = 'GET';
    if (!normalized[':scheme']) normalized[':scheme'] = this._headers[':scheme'] || 'https';
    if (!normalized[':authority']) normalized[':authority'] = this._headers[':authority'];
    if (!normalized[':path']) normalized[':path'] = '/';
    normalized[sensitiveHeaders] = [];
    const id = nextStreamId;
    nextStreamId += 2;
    const pushServer = new VirtualHttp2Stream(this.session, {
      id,
      headers: normalized,
      role: 'server',
      push: true,
      highWaterMark: options.highWaterMark,
    });
    const pushClient = new VirtualHttp2Stream(this.session, {
      id,
      headers: normalized,
      role: 'client',
      push: true,
      highWaterMark: options.highWaterMark,
    });
    pushServer._peer = pushClient;
    pushClient._peer = pushServer;
    this.session._streams.add(pushClient);
    pushClient.once('close', () => this.session._streams.delete(pushClient));
    pushServer._publishCreatedDiagnostics(normalized);
    pushServer._publishStartDiagnostics(normalized);
    pushClient._publishCreatedDiagnostics(normalized);
    pushClient._publishStartDiagnostics(normalized);
    schedule(() => {
      this.session.emit('stream', pushClient, { ...normalized }, 0);
      callback(null, pushServer, { ...normalized });
    });
    return pushServer;
  }

  destroy(error) {
    if (this.closed && this.destroyed) return this;
    this.destroyed = true;
    this.closed = true;
    this._releaseResponseFile();
    this.aborted ||= Boolean(error);
    if (error) {
      if (this.rstCode === constants.NGHTTP2_NO_ERROR) {
        this.rstCode = this._role === 'client' ? constants.NGHTTP2_CANCEL : constants.NGHTTP2_INTERNAL_ERROR;
      }
      publishDiagnostic(this._diagnostics, `http2.${this._role}.stream.error`, { stream: this, error });
      this._publishCloseDiagnostics();
      if (this._peer && !this._peer.destroyed) {
        const peer = this._peer;
        peer.rstCode = this.rstCode;
        peer.aborted = true;
        schedule(() => peer.destroy(http2Error(
          'ERR_HTTP2_STREAM_ERROR',
          `Stream closed with error code ${this.rstCode}`,
        )));
      }
    }
    if (!error) this._publishCloseDiagnostics();
    schedule(() => this.emit('close'));
    return super.destroy(error);
  }
}

// Compatibility request surface used by the request-oriented HTTP/2 API.
// The raw ServerHttp2Stream remains the source of body data and lifecycle;
// this wrapper only adapts it to Node's IncomingMessage-like interface.
export class Http2ServerRequest extends Readable {
  constructor(stream, headers, options, rawHeaders) {
    super({ autoDestroy: false, ...options });
    this._compatState = { closed: false, didRead: false };
    this._headers = headers || Object.create(null);
    this._rawHeaders = rawHeaders || rawHeaderPairs(this._headers);
    this._trailers = {};
    this._rawTrailers = [];
    this._stream = stream;
    this._aborted = false;
    stream._compatRequest = this;

    stream.on('end', () => this.push(null));
    stream.on('error', () => {});
    stream.on('aborted', () => {
      if (!this._compatState.closed) {
        this._aborted = true;
        this.emit('aborted');
      }
    });
    stream.on('close', () => {
      this._compatState.closed = true;
      this.push(null);
      if (!this._compatState.didRead && !this._resumeScheduled) this.resume();
      stream._compatSocket = null;
      stream._compatRequest = null;
      this.emit('close');
    });
    stream.on('timeout', () => this.emit('timeout'));
    this.on('pause', () => stream.pause());
    this.on('resume', () => stream.resume());
  }

  get aborted() {
    return this._aborted || Boolean(this._stream.aborted);
  }

  get complete() {
    return this.aborted || this.readableEnded || this._compatState.closed || this._stream.destroyed;
  }

  get stream() {
    return this._stream;
  }

  get headers() {
    return this._headers;
  }

  get rawHeaders() {
    return this._rawHeaders;
  }

  get trailers() {
    return this._trailers;
  }

  get rawTrailers() {
    return this._rawTrailers;
  }

  get httpVersionMajor() {
    return 2;
  }

  get httpVersionMinor() {
    return 0;
  }

  get httpVersion() {
    return '2.0';
  }

  get socket() {
    return compatibilitySocket(this._stream);
  }

  get connection() {
    return this.socket;
  }

  _read() {
    if (!this._compatState.didRead) {
      this._compatState.didRead = true;
      this._stream.on('data', (chunk) => {
        if (!this.push(chunk)) this._stream.pause();
      });
    } else {
      queueMicrotask(() => this._stream.resume());
    }
  }

  get method() {
    return this._headers[':method'];
  }

  set method(method) {
    if (typeof method !== 'string') {
      throw http2Error('ERR_INVALID_ARG_TYPE', 'method must be a string');
    }
    if (method.trim() === '') throw http2Error('ERR_INVALID_ARG_VALUE', 'method must not be empty');
    this._headers[':method'] = method;
  }

  get authority() {
    return this._headers[':authority'] ?? this._headers.host;
  }

  get scheme() {
    return this._headers[':scheme'];
  }

  get url() {
    return this._headers[':path'];
  }

  set url(url) {
    this._headers[':path'] = url;
  }

  setTimeout(milliseconds, callback) {
    if (!this._compatState.closed) this._stream.setTimeout(milliseconds, callback);
    return this;
  }
}

// Compatibility response surface used by the request-oriented HTTP/2 API.
// Keep these accessors backed by the virtual stream so the response observes
// the same lifecycle and writable state as the raw stream API.
export class Http2ServerResponse extends Stream {
  constructor(stream, options) {
    super(options);
    this._stream = stream;
    this._state = {
      sendDate: true,
      statusCode: 200,
    };
  }

  get socket() {
    if (this._stream?.closed || this._stream?.destroyed) return undefined;
    return compatibilitySocket(this._stream);
  }

  get connection() {
    return this.socket;
  }

  get stream() {
    return this._stream;
  }

  get headersSent() {
    return Boolean(this._stream?.headersSent);
  }

  get sendDate() {
    return this._state.sendDate;
  }

  set sendDate(value) {
    this._state.sendDate = Boolean(value);
  }

  get statusCode() {
    return this._state.statusCode;
  }

  set statusCode(value) {
    const code = value | 0;
    if (code >= 100 && code < 200) {
      const error = new RangeError('Informational status codes cannot be used');
      error.code = 'ERR_HTTP2_INFO_STATUS_NOT_ALLOWED';
      throw error;
    }
    if (code < 100 || code > 599) {
      const error = new RangeError(`Invalid status code: ${code}`);
      error.code = 'ERR_HTTP2_STATUS_INVALID';
      throw error;
    }
    this._state.statusCode = code;
  }

  get writableCorked() {
    return this._stream?.writableCorked ?? 0;
  }

  get writableHighWaterMark() {
    return this._stream?.writableHighWaterMark;
  }

  get writableFinished() {
    return this._stream?.writableFinished ?? false;
  }
}

export class ClientHttp2Session extends EventEmitter {
  constructor(authority, options, internal) {
    super();
    this._scope = internal.scope;
    this._vfs = internal.vfs;
    this._diagnostics = internal.diagnostics;
    this._authority = authority;
    this._options = options;
    this._proxy = internal.proxy;
    this._server = internal.server;
    this._taskRelease = internal.trackTask?.() || null;
    this._pendingRequests = [];
    this._streams = new Set();
    this._connected = false;
    this.closed = false;
    this.destroyed = false;
    this.connecting = true;
    this.type = 1;
    this.alpnProtocol = 'h2';
    this.encrypted = true;
    this.timeout = 0;
    this.localSettings = { ...DEFAULT_SETTINGS };
    this.remoteSettings = { ...DEFAULT_SETTINGS, ...(this._server?._options?.settings || {}) };
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
      if (this.closed || this.destroyed) return;
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

  request(headers = {}, options = {}) {
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_SESSION', 'Cannot create a stream on a closed session');
    const normalized = normalizeHeaders(headers);
    if (!normalized[':method']) normalized[':method'] = 'GET';
    if (!normalized[':scheme'] && normalized[':method'] !== 'CONNECT') normalized[':scheme'] = this._authority.protocol.slice(0, -1);
    if (!normalized[':authority'] && !normalized.host) {
      const defaultPort = this._authority.protocol === 'http:' ? 80 : 443;
      normalized[':authority'] = `${this._authority.host}${this._authority.port === defaultPort ? '' : `:${this._authority.port}`}`;
    }
    if (!normalized[':path'] && normalized[':method'] !== 'CONNECT') normalized[':path'] = '/';
    const stream = new VirtualHttp2Stream(this, { ...options, headers: normalized, role: 'client' });
    stream._headers = normalized;
    this._streams.add(stream);
    stream._publishCreatedDiagnostics(normalized);
    schedule(() => this._dispatch(stream));
    stream.once('close', () => this._streams.delete(stream));
    const { signal } = options;
    if (signal) {
      const abort = () => stream.destroy(abortError());
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        stream.once('close', () => signal.removeEventListener('abort', abort));
      }
    }
    if (options.endStream) stream.end();
    return stream;
  }

  _dispatch(stream) {
    if (stream.closed) return;
    if (!this._connected) {
      if (!this._pendingRequests.includes(stream)) this._pendingRequests.push(stream);
      return;
    }
    if (stream._dispatched) return;
    stream._dispatched = true;
    stream._publishStartDiagnostics(stream._headers);
    stream._publishBodyDiagnostics();
    if (this._server) {
      const serverStream = new VirtualHttp2Stream(this, { id: stream.id, role: 'server', headers: stream._headers });
      stream._peer = serverStream;
      serverStream._peer = stream;
      serverStream._publishCreatedDiagnostics(stream._headers);
      serverStream._publishStartDiagnostics(stream._headers);
      this._server.emit('stream', serverStream, { ...stream._headers }, 0);
      if (this._server.listenerCount('request') > 0) {
        this._server._emitRequest(serverStream, stream._headers);
      }
      const body = stream._bodyBytes();
      if (body.byteLength) serverStream.push(body);
      serverStream.push(null);
      if (this._server.listenerCount('stream') === 0 && this._server.listenerCount('request') === 0) {
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

  setNextStreamID() {
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
    return nextStreamId;
  }

  setLocalWindowSize() {
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
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
    if (this.closed) {
      schedule(() => callback?.());
      return this;
    }
    if (callback) this.once('close', callback);
    this.closed = true;
    this._connected = false;
    this.connecting = false;
    this._taskRelease?.();
    this._taskRelease = null;
    for (const stream of this._streams) stream.close(constants.NGHTTP2_CANCEL);
    schedule(() => this.emit('close'));
    return this;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.closed = true;
    this._connected = false;
    this.connecting = false;
    this._taskRelease?.();
    this._taskRelease = null;
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
    this._diagnostics = internal.diagnostics;
    this._trackTask = internal.trackTask;
    this._taskRelease = null;
    this._secure = Boolean(internal.secure);
    this._requestClass = this._options.Http2ServerRequest || Http2ServerRequest;
    this._responseClass = this._options.Http2ServerResponse || Http2ServerResponse;
    this._host = 'localhost';
    this._port = null;
    this.listening = false;
    this._sessions = new Set();
    this.timeout = 0;
    this.maxConnections = undefined;
    if (typeof listener === 'function') this.on('request', listener);
  }

  listen(...args) {
    let callback;
    if (typeof args.at(-1) === 'function') callback = args.pop();
    const input = isRecord(args[0]) ? { ...args[0] } : { port: args[0], host: args[1] };
    if (this.listening) throw http2Error('ERR_SERVER_ALREADY_LISTEN', 'Server is already listening');
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
    this._taskRelease = this._trackTask?.() || null;
    this.listening = true;
    schedule(() => { this.emit('listening'); callback?.(); });
    return this;
  }

  _acceptSession(session) {
    this._sessions.add(session);
    session.once('close', () => this._sessions.delete(session));
    this.emit('session', session);
  }

  _emitRequest(stream, headers) {
    const rawHeaders = rawHeaderPairs(headers);
    const request = new this._requestClass(stream, headers, undefined, rawHeaders);
    const response = new this._responseClass(stream);
    if (headers[':method'] === 'CONNECT') {
      if (!this.emit('connect', request, response)) {
        response.statusCode = 405;
        response.end?.();
      }
      return;
    }
    this.emit('request', request, response);
  }

  address() { return this.listening ? { address: this._host, family: 'IPv4', port: this._port } : null; }
  close(callback) {
    if (callback) this.once('close', callback);
    if (!this.listening) { schedule(() => this.emit('close')); return this; }
    SERVER_REGISTRY.delete(registryKey(this._host, this._port));
    this._taskRelease?.();
    this._taskRelease = null;
    this.listening = false;
    this._port = null;
    for (const session of this._sessions) session.close();
    schedule(() => this.emit('close'));
    return this;
  }
  setTimeout(milliseconds, callback) {
    this.timeout = Number(milliseconds) || 0;
    if (callback) this.once('timeout', callback);
    if (this._timeout) clearTimeout(this._timeout);
    if (this.timeout > 0) this._timeout = setTimeout(() => this.emit('timeout'), this.timeout);
    return this;
  }
  getConnections(callback) { schedule(() => callback?.(null, this._sessions.size)); return this; }
  closeAllConnections() { for (const session of this._sessions) session.close(); return this; }
  closeIdleConnections() { return this; }
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
  const diagnostics = options.diagnostics;

  function connect(authority, connectOptions = {}, listener) {
    if (typeof connectOptions === 'function') { listener = connectOptions; connectOptions = {}; }
    const target = authorityParts(authority, scope);
    const server = serverFor(target.host, target.port);
    const session = new ClientHttp2Session(target, { ...connectOptions }, {
      scope,
      vfs: options.vfs,
      proxy: normalizeProxy(connectOptions.proxy, connectOptions.capability) || proxy,
      server,
      diagnostics,
      trackTask: options.trackTask,
    });
    if (typeof listener === 'function') session.once('connect', listener);
    return session;
  }

  function createServer(serverOptions, listener) {
    return new Http2Server(serverOptions, listener, {
      scope,
      secure: false,
      diagnostics,
      trackTask: options.trackTask,
    });
  }

  function createSecureServer(serverOptions, listener) {
    return new Http2Server(serverOptions, listener, {
      scope,
      secure: true,
      diagnostics,
      trackTask: options.trackTask,
    });
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
    Http2ServerRequest,
    Http2ServerResponse,
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
