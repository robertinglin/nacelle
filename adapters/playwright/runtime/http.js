import { EventEmitter } from './events.js';
import { createBrowserNet } from './net.js';
import { Readable, Writable } from './streams.js';
import { createProxyCapability } from './proxy.js';

const DEFAULT_HTTP_PROTOCOL = 'http:';
const DEFAULT_HTTPS_PROTOCOL = 'https:';
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
const objectToString = Object.prototype.toString;

const METHODS = Object.freeze([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE',
]);

const STATUS_CODES = Object.freeze({
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

function schedule(scope, callback) {
  if (typeof scope.queueMicrotask === 'function') scope.queueMicrotask(callback);
  else Promise.resolve().then(callback);
}

function textEncoder(scope) {
  const Constructor = scope.TextEncoder || (typeof TextEncoder === 'function' ? TextEncoder : null);
  if (!Constructor) throw new TypeError('TextEncoder is unavailable in this browser context');
  return new Constructor();
}

function toBytes(value, scope, encoding = 'utf8') {
  if (value === undefined || value === null) throw new TypeError('request body chunk must not be null');
  if (typeof value === 'string') {
    if (encoding && encoding !== 'utf8' && encoding !== 'utf-8' && typeof scope.Buffer?.from === 'function') {
      return toBytes(scope.Buffer.from(value, encoding), scope);
    }
    return textEncoder(scope).encode(value);
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value !== null && typeof value === 'object'
    && objectToString.call(value) === '[object ArrayBuffer]') {
    return new Uint8Array(value.slice(0));
  }
  throw new TypeError('request body chunk must be a string, Buffer, or Uint8Array');
}

function concatenate(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function nodeChunk(bytes, scope, BufferClass) {
  if (typeof BufferClass?.from === 'function') return BufferClass.from(bytes);
  if (typeof scope.Buffer?.from === 'function') return scope.Buffer.from(bytes);
  return bytes;
}

function isURL(value, scope) {
  return typeof scope.URL === 'function' && value !== null && typeof value === 'object'
    && (value instanceof scope.URL || objectToString.call(value) === '[object URL]');
}

function isRequest(value, scope) {
  return typeof scope.Request === 'function' && value !== null && typeof value === 'object'
    && (value instanceof scope.Request || objectToString.call(value) === '[object Request]');
}

function isTarget(value, scope) {
  return typeof value === 'string' || isURL(value, scope) || isRequest(value, scope);
}

function headerEntries(value) {
  if (!value) return [];
  if (typeof value.forEach === 'function') {
    const entries = [];
    value.forEach((headerValue, name) => entries.push([name, headerValue]));
    return entries;
  }
  if (Array.isArray(value)) return value;
  return Object.entries(value);
}

function normalizeHeaderValue(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value);
}

function createHeaderStore(value) {
  const headers = new Map();
  for (const [name, headerValue] of headerEntries(value)) {
    if (name === undefined || name === null) continue;
    headers.set(String(name).toLowerCase(), normalizeHeaderValue(headerValue));
  }
  return headers;
}

function headersObject(headers) {
  const result = {};
  for (const [name, value] of headers) result[name] = value;
  return result;
}

function fetchHeaders(headers, scope) {
  if (typeof scope.Headers !== 'function') return headersObject(headers);
  const result = new scope.Headers();
  for (const [name, value] of headers) result.set(name, value);
  return result;
}

function responseHeaders(value) {
  const headers = {};
  const rawHeaders = [];
  for (const [name, headerValue] of headerEntries(value)) {
    const lowerName = String(name).toLowerCase();
    const normalizedValue = String(headerValue);
    headers[lowerName] = headers[lowerName]
      ? `${headers[lowerName]}, ${normalizedValue}`
      : normalizedValue;
    rawHeaders.push(String(name), normalizedValue);
  }
  return { headers, rawHeaders };
}

function protocolName(value, fallback) {
  const protocol = String(value || fallback);
  return protocol.endsWith(':') ? protocol : `${protocol}:`;
}

function hasScheme(value) {
  return /^[a-z][a-z\d+.-]*:/i.test(String(value));
}

function makeURL(input, options, defaultProtocol, scope) {
  let target = input;
  if (isRequest(input, scope)) target = input.url;
  if (isURL(target, scope)) target = target.href;
  if (target === undefined || target === null || target === '') target = options.href || options.url;

  if (target !== undefined && target !== null && target !== '') {
    const text = String(target);
    if (hasScheme(text)) return text;
    if (text.startsWith('//')) return `${protocolName(options.protocol, defaultProtocol)}${text}`;
    if (!options.hostname && !options.host) {
      throw new TypeError('a URL or hostname is required');
    }
    options = { ...options, path: text };
  }

  const protocol = protocolName(options.protocol, defaultProtocol);
  const path = String(options.path || options.pathname || '/');
  if (protocol === 'data:') return `data:${path.replace(/^data:/, '')}`;

  const hostname = String(options.hostname || options.host || 'localhost');
  let authority = hostname;
  if (options.port !== undefined && options.port !== null && !authority.includes(':')) {
    authority += `:${options.port}`;
  }
  const normalizedPath = path.startsWith('/') || path.startsWith('?') || path.startsWith('#') ? path : `/${path}`;
  return `${protocol}//${authority}${normalizedPath}`;
}

function validateURL(url, defaultProtocol, scope) {
  const Constructor = scope.URL;
  if (typeof Constructor !== 'function') return url;
  let parsed;
  try {
    parsed = new Constructor(url, `${defaultProtocol}//localhost/`);
  } catch (error) {
    throw new TypeError(`invalid request URL: ${error.message}`);
  }
  if (!['data:', 'http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError(`unsupported request protocol: ${parsed.protocol}`);
  }
  if (parsed.protocol !== 'data:' && parsed.protocol !== defaultProtocol) {
    const error = new Error(`Protocol "${parsed.protocol}" not supported. Expected "${defaultProtocol}"`);
    error.code = 'ERR_INVALID_PROTOCOL';
    throw error;
  }
  return parsed.href;
}

function basicAuthorization(value, scope) {
  const encoded = String(value);
  if (typeof scope.btoa === 'function') return `Basic ${scope.btoa(encoded)}`;
  if (typeof btoa === 'function') return `Basic ${btoa(encoded)}`;
  return undefined;
}

function abortError(scope, reason) {
  if (reason instanceof Error) {
    if (!reason.code) reason.code = 'ABORT_ERR';
    return reason;
  }
  const message = reason ? String(reason) : 'The operation was aborted';
  const error = typeof scope.DOMException === 'function'
    ? new scope.DOMException(message, 'AbortError')
    : new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function timeoutError(scope, milliseconds) {
  const message = `The operation timed out after ${milliseconds} ms`;
  if (typeof scope.DOMException === 'function') {
    return new scope.DOMException(message, 'TimeoutError');
  }
  const error = new Error(message);
  error.name = 'TimeoutError';
  error.code = 'ETIMEDOUT';
  return error;
}

function fetchNetworkError(url, cause, scope) {
  let hostname = '';
  try { hostname = new scope.URL(url).hostname; } catch { hostname = ''; }
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const code = local ? 'ECONNREFUSED' : 'ENOTFOUND';
  const syscall = local ? 'connect' : 'getaddrinfo';
  const error = new Error(`${syscall} ${code} ${hostname}`.trim());
  error.code = code;
  error.errno = code;
  error.syscall = syscall;
  if (hostname) {
    error.hostname = hostname;
    error.address = hostname;
  }
  if (cause !== undefined) error.cause = cause;
  return error;
}

function unsupportedTransportOptions(options) {
  if (options.socketPath !== undefined && options.socketPath !== false) {
    const error = new TypeError('http socketPath is unavailable in the browser virtual network');
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
}

function validateServerOptions(options) {
  if (options === undefined || options === null || typeof options === 'function') return;
  if (typeof options === 'object' && !Array.isArray(options)) return;
  const error = new TypeError('The "options" argument must be of type object');
  error.code = 'ERR_INVALID_ARG_TYPE';
  throw error;
}

function serverListenOptions(args) {
  let options = {};
  let callback;
  for (const value of args) {
    if (typeof value === 'function') callback = value;
    else if (typeof value === 'number') options.port = value;
    else if (typeof value === 'string') options.host = value;
    else if (value && typeof value === 'object') options = { ...value };
  }
  if (options.port === undefined) {
    const error = new TypeError('server.listen() requires a numeric port in the browser virtual network');
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new RangeError(`port must be an integer between 0 and 65535: ${options.port}`);
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
  return { options, callback };
}

function hostMatches(bindingHost, requestHost) {
  const binding = String(bindingHost || '127.0.0.1').toLowerCase();
  const request = String(requestHost || 'localhost').toLowerCase();
  if (binding === request || binding === '::' || binding === '0.0.0.0') return true;
  const loopbackV4 = new Set(['localhost', '127.0.0.1']);
  const loopbackV6 = new Set(['::1', '[::1]']);
  return (loopbackV4.has(binding) && loopbackV4.has(request))
    || (loopbackV6.has(binding) && loopbackV6.has(request));
}

function responseFromBytes(url, statusCode, headers, bytes, scope) {
  const body = new Uint8Array(bytes || 0);
  return {
    url,
    status: statusCode,
    statusText: STATUS_CODES[statusCode] || '',
    headers,
    arrayBuffer: async () => body.slice().buffer,
    body: undefined,
    ok: statusCode >= 200 && statusCode < 300,
    redirected: false,
    type: 'basic',
    scope,
  };
}

class VirtualServerRequest extends Readable {
  constructor(url, init, scope, BufferClass) {
    super({ preserveStrings: true });
    const parsed = new scope.URL(url);
    const headers = createHeaderStore(init.headers);
    if (!headers.has('host')) headers.set('host', parsed.host);
    this.method = String(init.method || 'GET').toUpperCase();
    this.url = `${parsed.pathname}${parsed.search}`;
    this.headers = headersObject(headers);
    this.rawHeaders = [...headers].flatMap(([name, value]) => [name, value]);
    this.httpVersion = '1.1';
    this.complete = false;
    this.aborted = false;
    this.readableEnded = false;
    this.readableComplete = false;
    this.socket = null;
    this.connection = null;
    this._scope = scope;
    this._BufferClass = BufferClass;
    this._body = init.body === undefined ? new Uint8Array() : toBytes(init.body, scope);
  }

  on(name, listener) {
    const result = super.on(name, listener);
    if (name === 'data') this.resume();
    return result;
  }

  begin() {
    schedule(this._scope, () => {
      if (this.destroyed) return;
      if (this._body.byteLength) this.push(nodeChunk(this._body, this._scope, this._BufferClass));
      this.complete = true;
      this.readableEnded = true;
      this.readableComplete = true;
      this.push(null);
    });
  }
}

class VirtualServerResponse extends Writable {
  constructor(request, scope, BufferClass, complete) {
    super({
      write(chunk, _encoding, callback) {
        this._chunks.push(new Uint8Array(chunk));
        callback();
      },
      final(callback) {
        this._finalizeResponse(callback);
      },
    });
    this.statusCode = 200;
    this.statusMessage = STATUS_CODES[200];
    this.headersSent = false;
    this.finished = false;
    this.writableEnded = false;
    this._scope = scope;
    this._BufferClass = BufferClass;
    this._request = request;
    this.req = request;
    this._chunks = [];
    this._headers = new Map();
    this._completeResponse = complete;
    this._completedResponse = false;
  }

  setHeader(name, value) {
    if (this.headersSent) throw new Error('Cannot set headers after they are sent');
    this._headers.set(String(name).toLowerCase(), normalizeHeaderValue(value));
    return this;
  }

  getHeader(name) { return this._headers.get(String(name).toLowerCase()); }
  getHeaders() { return headersObject(this._headers); }
  getHeaderNames() { return [...this._headers.keys()]; }
  hasHeader(name) { return this._headers.has(String(name).toLowerCase()); }

  removeHeader(name) {
    if (this.headersSent) throw new Error('Cannot remove headers after they are sent');
    this._headers.delete(String(name).toLowerCase());
    return this;
  }

  writeHead(statusCode, statusMessage, headers) {
    if (typeof statusMessage === 'object') {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = Number(statusCode);
    this.statusMessage = statusMessage || STATUS_CODES[this.statusCode] || '';
    for (const [name, value] of headerEntries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
    return this;
  }

  write(...args) {
    this.headersSent = true;
    return super.write(...args);
  }

  end(...args) {
    this.headersSent = true;
    return super.end(...args);
  }

  _finalizeResponse(callback) {
    if (this._completedResponse) {
      callback();
      return;
    }
    this.headersSent = true;
    this.finished = true;
    this._completedResponse = true;
    const body = concatenate(this._chunks);
    const responseBody = this._request.method === 'HEAD' ? new Uint8Array() : body;
    this._completeResponse({
      statusCode: this.statusCode,
      statusMessage: this.statusMessage,
      headers: this.getHeaders(),
      body: responseBody,
    });
    callback();
  }
}

function appendBytes(previous, next) {
  const result = new Uint8Array(previous.byteLength + next.byteLength);
  result.set(previous);
  result.set(next, previous.byteLength);
  return result;
}

function createVirtualHttpNetwork(scope, BufferClass, netModule, trackTask) {
  const bindings = [];
  let nextPort = 46000;

  function rawRequestFromBytes(bytes, binding) {
    let headerEnd = -1;
    for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
      if (bytes[index] === 13 && bytes[index + 1] === 10
        && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
        headerEnd = index;
        break;
      }
    }
    if (headerEnd < 0) return null;
    const decoder = scope.TextDecoder || TextDecoder;
    const headerText = new decoder().decode(bytes.slice(0, headerEnd));
    const lines = headerText.split('\r\n');
    const [method = 'GET', path = '/'] = lines.shift().split(' ');
    const normalizedMethod = method.toUpperCase();
    const headers = {};
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }
    // CONNECT switches the connection from HTTP framing to a byte stream.
    // Bytes after the header belong to the tunnel and are exposed as Node's
    // `head` argument instead of being parsed as another HTTP request.
    const isConnect = normalizedMethod === 'CONNECT';
    const contentLength = isConnect ? 0 : Number(headers['content-length'] || 0);
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      const error = new TypeError('invalid HTTP content-length');
      error.code = 'HPE_INVALID_CONTENT_LENGTH';
      throw error;
    }
    const bodyStart = headerEnd + 4;
    if (bytes.byteLength < bodyStart + contentLength) return null;
    const body = bytes.slice(bodyStart, bodyStart + contentLength);
    const host = headers.host || `${binding.host}:${binding.port}`;
    const protocol = binding.protocol;
    const url = isConnect
      ? `${protocol}//${path}`
      : `${protocol}//${host}${path.startsWith('/') ? path : `/${path}`}`;
    return {
      consumed: bodyStart + contentLength,
      url,
      method: normalizedMethod,
      target: path,
      connect: isConnect,
      init: { method: normalizedMethod, headers, body },
    };
  }

  function writeRawResponse(socket, result) {
    const headers = { ...result.headers };
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(result.body?.byteLength || 0);
    }
    const statusMessage = result.statusMessage || STATUS_CODES[result.statusCode] || '';
    const headerText = `HTTP/1.1 ${result.statusCode} ${statusMessage}\r\n`
      + Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')
      + '\r\n';
    const encoder = scope.TextEncoder || TextEncoder;
    const headerBytes = new encoder().encode(headerText);
    const body = result.body || new Uint8Array();
    socket.write(appendBytes(headerBytes, body));
  }

  function attachRawSocket(binding, socket) {
    let input = new Uint8Array();
    let endedByPeer = false;
    let tunnelStarted = false;
    let processing = false;
    let releaseConnection = trackTask?.() || null;
    const queue = [];
    const finishConnection = () => {
      releaseConnection?.();
      releaseConnection = null;
    };
    socket.once?.('close', finishConnection);

    async function drain() {
      if (processing) return;
      processing = true;
      try {
        while (queue.length) {
          const requestData = queue.shift();
          if (requestData.connect) {
            const request = new VirtualServerRequest(requestData.url, requestData.init, scope, BufferClass);
            request.url = requestData.target;
            request.socket = socket;
            request.connection = socket;
            tunnelStarted = true;
            schedule(scope, () => {
              try {
                const head = nodeChunk(requestData.head, scope, BufferClass);
                const handled = binding.server.emit('connect', request, socket, head);
                if (!handled && !socket.destroyed) {
                  socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
                }
              } catch (error) {
                socket.destroy(error);
              }
            });
            continue;
          }
          await new Promise((resolve, reject) => {
            const request = new VirtualServerRequest(requestData.url, requestData.init, scope, BufferClass);
            request.socket = socket;
            request.connection = socket;
            const response = new VirtualServerResponse(request, scope, BufferClass, (result) => {
              try {
                writeRawResponse(socket, result);
                resolve();
              } catch (error) {
                reject(error);
              }
            });
            schedule(scope, () => {
              try {
                binding.server.emit('request', request, response);
                request.begin();
              } catch (error) {
                reject(error);
              }
            });
          });
        }
      } catch (error) {
        socket.destroy(error);
      } finally {
        processing = false;
        if (binding.closed && endedByPeer && !socket.destroyed) {
          socket.end(() => socket.destroy());
        }
      }
    }

    socket.on('data', (chunk) => {
      if (tunnelStarted) return;
      try {
        input = appendBytes(input, toBytes(chunk, scope));
        while (true) {
          const request = rawRequestFromBytes(input, binding);
          if (!request) break;
          input = input.slice(request.consumed);
          if (request.connect) {
            request.head = input;
            input = new Uint8Array();
          }
          queue.push(request);
          if (request.connect) break;
        }
        void drain();
      } catch (error) {
        socket.destroy(error);
      }
    });
    socket.on('end', () => {
      endedByPeer = true;
      // Let the serialized request drain close the connection after the last
      // response. Closing directly from the peer-end event can race a
      // response handler that just called server.close().
      void drain();
    });
    socket.on('error', finishConnection);
  }

  function allocatePort() {
    for (let attempt = 0; attempt < 19500; attempt += 1) {
      const port = nextPort;
      nextPort = nextPort >= 65500 ? 46000 : nextPort + 1;
      if (!bindings.some((binding) => binding.port === port)) return port;
    }
    const error = new Error('no browser virtual HTTP ports are available');
    error.code = 'EADDRINUSE';
    throw error;
  }

  function bind(server, protocol, options) {
    const host = String(options.host || '127.0.0.1');
    const port = options.port || allocatePort();
    if (bindings.some((binding) => binding.port === port && hostMatches(binding.host, host))) {
      const error = new Error(`listen EADDRINUSE: address already in use ${host}:${port}`);
      error.code = 'EADDRINUSE';
      error.syscall = 'listen';
      error.address = host;
      error.port = port;
      throw error;
    }
    const binding = { server, protocol, host, port, rawServer: null, closed: false };
    bindings.push(binding);
    if (netModule?.createServer) {
      binding.rawServer = netModule.createServer({ allowHalfOpen: true }, (socket) => attachRawSocket(binding, socket));
      binding.rawServer.on?.('error', (error) => server.emit('error', error));
      binding.rawServer.listen(port, host);
    }
    return { host, port };
  }

  function unbind(server) {
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      if (bindings[index].server !== server) continue;
      const binding = bindings[index];
      binding.closed = true;
      const rawServer = binding.rawServer;
      if (rawServer?._network) {
        rawServer._network.unbindTcp(rawServer);
        rawServer._taskRelease?.();
        rawServer._taskRelease = null;
        rawServer.listening = false;
        rawServer._boundPort = null;
        rawServer._boundAddress = null;
      }
      bindings.splice(index, 1);
    }
  }

  function find(url) {
    const parsed = new scope.URL(url);
    return bindings.find((binding) => binding.protocol === parsed.protocol
      && binding.port === Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      && hostMatches(binding.host, parsed.hostname));
  }

  function dispatch(url, init) {
    const binding = find(url);
    if (!binding) return null;
    return new Promise((resolve, reject) => {
      const request = new VirtualServerRequest(url, init, scope, BufferClass);
      const response = new VirtualServerResponse(request, scope, BufferClass, (result) => {
        resolve(responseFromBytes(url, result.statusCode, result.headers, result.body, scope));
      });
      schedule(scope, () => {
        try {
          binding.server.emit('request', request, response);
          request.begin();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  return { bind, unbind, dispatch };
}

function createServerClass(protocol, scope, registry, BufferClass, trackTask) {
  class Server extends EventEmitter {
    constructor(options, listener) {
      super();
      validateServerOptions(options);
      if (typeof options === 'function') {
        listener = options;
        options = {};
      }
      if (options === undefined || options === null) options = {};
      this.options = { ...options };
      this.listening = false;
      this.maxConnections = undefined;
      this._bound = null;
      this._taskRelease = null;
      this.on('connection', (socket) => { socket.server = this; });
      if (typeof listener === 'function') this.on('request', listener);
    }

    listen(...args) {
      const { options, callback } = serverListenOptions(args);
      if (callback) this.once('listening', callback);
      schedule(scope, () => {
        if (this.listening) return;
        try {
          this._bound = registry.bind(this, protocol, options);
          this._taskRelease = trackTask?.() || null;
          this.listening = true;
          this.emit('listening');
        } catch (error) {
          this.emit('error', error);
          callback?.(error);
        }
      });
      return this;
    }

    address() {
      if (!this._bound) return null;
      return {
        address: this._bound.host,
        family: this._bound.host.includes(':') ? 'IPv6' : 'IPv4',
        port: this._bound.port,
      };
    }

    close(callback) {
      if (callback) this.once('close', callback);
      if (this._bound) registry.unbind(this);
      this._taskRelease?.();
      this._taskRelease = null;
      this._bound = null;
      this.listening = false;
      schedule(scope, () => this.emit('close'));
      return this;
    }

    closeAllConnections() { return this; }
    closeIdleConnections() { return this; }
    getConnections(callback) { schedule(scope, () => callback?.(null, 0)); }
    ref() { return this; }
    unref() { return this; }
  }

  // Node exposes http.Server as a callable constructor as well as a
  // constructable one. Keep the implementation class private so both forms
  // share the same EventEmitter-backed instance shape.
  function CallableServer(options, listener) {
    return new Server(options, listener);
  }
  CallableServer.prototype = Server.prototype;
  Object.defineProperty(Server.prototype, 'constructor', {
    configurable: true,
    value: CallableServer,
    writable: true,
  });
  Object.defineProperty(CallableServer, 'name', { value: 'Server' });
  return CallableServer;
}

class BrowserAgent extends EventEmitter {
  constructor(options = {}, protocol = DEFAULT_HTTP_PROTOCOL, connectionFactory) {
    super();
    this.options = { ...options };
    this.protocol = options.protocol || protocol;
    this.defaultPort = Number(options.defaultPort || (this.protocol === DEFAULT_HTTPS_PROTOCOL ? 443 : 80));
    this.keepAlive = Boolean(options.keepAlive);
    this.maxSockets = options.maxSockets ?? Infinity;
    this.maxFreeSockets = options.maxFreeSockets ?? 256;
    this.maxTotalSockets = options.maxTotalSockets ?? Infinity;
    this.scheduling = options.scheduling || 'lifo';
    this.requests = Object.create(null);
    this.sockets = Object.create(null);
    this.freeSockets = Object.create(null);
    this._connectionFactory = connectionFactory;
  }

  getName(options = {}) {
    const host = options.host || options.hostname || 'localhost';
    const port = options.port || this.defaultPort;
    return `${host}:${port}${options.localAddress ? `:${options.localAddress}` : ''}`;
  }

  addRequest(request, options = {}) {
    const name = this.getName(options);
    (this.requests[name] ||= []).push(request);
    request.once?.('close', () => {
      const pending = this.requests[name];
      if (!pending) return;
      const index = pending.indexOf(request);
      if (index >= 0) pending.splice(index, 1);
      if (!pending.length) delete this.requests[name];
    });
    return request;
  }

  keepSocketAlive(socket) { return this.keepAlive && !socket.destroyed; }
  createConnection(options, callback) {
    if (typeof this._connectionFactory !== 'function') return undefined;
    return this._connectionFactory(options, callback);
  }
  reuseSocket(socket) { socket.ref?.(); return socket; }
  removeSocket(socket, options = {}) {
    const name = this.getName(options);
    for (const collection of [this.sockets, this.freeSockets]) {
      const sockets = collection[name];
      if (!sockets) continue;
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
      if (!sockets.length) delete collection[name];
    }
  }

  destroy() {
    this.requests = Object.create(null);
    this.sockets = Object.create(null);
    this.freeSockets = Object.create(null);
    this.emit('free');
    return this;
  }
}

function parseArguments(input, options, callback, scope) {
  let target = input;
  let requestOptions = options;
  let responseCallback = callback;

  if (typeof requestOptions === 'function') {
    responseCallback = requestOptions;
    requestOptions = undefined;
  }
  if (typeof responseCallback !== 'function') responseCallback = undefined;

  if (!isTarget(target, scope) && target && typeof target === 'object') {
    requestOptions = target;
    target = requestOptions.href || requestOptions.url;
  }
  if (!requestOptions || typeof requestOptions !== 'object' || isURL(requestOptions, scope)) requestOptions = {};
  else requestOptions = { ...requestOptions };

  return { target, options: requestOptions, callback: responseCallback };
}

class IncomingMessage extends Readable {
  constructor(response, owner, scope, BufferClass) {
    super({ preserveStrings: true });
    const { headers, rawHeaders } = responseHeaders(response.headers);
    this.statusCode = Number(response.status ?? 0);
    this.statusMessage = response.statusText || STATUS_CODES[this.statusCode] || '';
    this.headers = headers;
    this.rawHeaders = rawHeaders;
    this.httpVersion = '1.1';
    this.url = response.url || '';
    this.complete = false;
    this.aborted = false;
    this.readableEnded = false;
    this.readableComplete = false;
    this._owner = owner;
    this._scope = scope;
    this._BufferClass = BufferClass;
    this._response = response;
    this._bodyReader = null;
    this._closed = false;
    this._decoder = null;
    this.body = this;
  }

  setEncoding(encoding = 'utf8') {
    const Decoder = this._scope.TextDecoder || (typeof TextDecoder === 'function' ? TextDecoder : null);
    if (!Decoder) throw new TypeError('TextDecoder is unavailable in this browser context');
    this._decoder = new Decoder(encoding === 'utf8' ? 'utf-8' : encoding);
    return this;
  }

  on(name, listener) {
    const result = super.on(name, listener);
    if (name === 'data') this.resume();
    return result;
  }

  push(chunk) {
    if (chunk !== null && this._decoder) {
      const bytes = toBytes(chunk, this._scope);
      chunk = this._decoder.decode(bytes, { stream: true });
    } else if (chunk === null && this._decoder) {
      const trailing = this._decoder.decode();
      this._decoder = null;
      if (trailing) super.push(trailing);
    }
    return super.push(chunk);
  }

  destroy(error) {
    if (error) this.aborted = true;
    if (this._bodyReader && typeof this._bodyReader.cancel === 'function') {
      Promise.resolve(this._bodyReader.cancel(error)).catch(() => {});
    }
    return super.destroy(error);
  }

  _closeAfterEnd() {
    if (this._closed) return;
    this._closed = true;
    schedule(this._scope, () => this.emit('close'));
  }

  async start() {
    const body = this._response.body;
    try {
      if (body && typeof body.getReader === 'function') {
        this._bodyReader = body.getReader();
        while (!this.destroyed) {
          const item = await this._bodyReader.read();
          if (item.done) break;
          this.push(nodeChunk(toBytes(item.value, this._scope), this._scope, this._BufferClass));
        }
      } else if (body && body[Symbol.asyncIterator]) {
        for await (const chunk of body) {
          if (this.destroyed) break;
          this.push(nodeChunk(toBytes(chunk, this._scope), this._scope, this._BufferClass));
        }
      } else if (body && body[Symbol.iterator] && typeof body !== 'string') {
        for (const chunk of body) {
          if (this.destroyed) break;
          this.push(nodeChunk(toBytes(chunk, this._scope), this._scope, this._BufferClass));
        }
      } else if (typeof this._response.arrayBuffer === 'function') {
        const bytes = new Uint8Array(await this._response.arrayBuffer());
        if (!this.destroyed && bytes.byteLength) this.push(nodeChunk(bytes, this._scope, this._BufferClass));
      }
      if (this.destroyed) return;
      this.complete = true;
      this.readableEnded = true;
      this.readableComplete = true;
      this._owner?._responseComplete();
      this._closeAfterEnd();
      this.push(null);
    } catch (error) {
      if (this.destroyed) return;
      this.aborted = true;
      super.destroy(error);
      this._owner?._responseFailed(error);
    } finally {
      this._bodyReader = null;
    }
  }
}

function proxyResponse(result, url, scope) {
  if (result && typeof result.arrayBuffer === 'function' && result.status !== undefined) return result;
  const statusCode = Number(result?.statusCode ?? result?.status ?? 200);
  const headers = result?.headers || {};
  const body = result?.bodyBytes ?? result?.body ?? result?.data ?? result?.text ?? '';
  const bytes = body === undefined || body === null ? new Uint8Array() : toBytes(body, scope);
  return responseFromBytes(url, statusCode, headers, bytes, scope);
}

function proxyRequestOptions(url, init) {
  return {
    url,
    method: init.method,
    headers: headersObject(createHeaderStore(init.headers)),
    body: init.body,
    signal: init.signal,
  };
}

function createRequestClass(scope, BufferClass, virtualNetwork, proxy) {
  return class ClientRequest extends EventEmitter {
    constructor(url, options = {}) {
      super();
      this.method = String(options.method || 'GET').toUpperCase();
      this.path = url;
      this.host = options.hostname || options.host || '';
      this.protocol = options.protocol;
      this.aborted = false;
      this.destroyed = false;
      this.finished = false;
      this.writableEnded = false;
      this.writableFinished = false;
      this.timeout = 0;
      this.response = null;
      this._url = url;
      this._options = options;
      this._virtualNetwork = virtualNetwork;
      this._proxy = proxy;
      this._headers = createHeaderStore(options.headers);
      this._chunks = [];
      this._started = false;
      this._closed = false;
      this._abortEmitted = false;
      this._errorEmitted = false;
      this._timeoutHandle = null;
      this._signalCleanup = null;
      this._controller = typeof scope.AbortController === 'function' ? new scope.AbortController() : null;
      this._externalSignal = options.signal;

      if (options.auth && !this._headers.has('authorization')) {
        const authorization = basicAuthorization(options.auth, scope);
        if (authorization) this._headers.set('authorization', authorization);
      }
      this._bindAbortSignal();
      if (options.timeout !== undefined) this.setTimeout(options.timeout);
    }

    _bindAbortSignal() {
      const signal = this._externalSignal;
      if (!signal || typeof signal.addEventListener !== 'function') return;
      const onAbort = () => this._abort(abortError(scope, signal.reason), true, false);
      this._signalCleanup = () => signal.removeEventListener?.('abort', onAbort);
      if (signal.aborted) schedule(scope, onAbort);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    _clearTimeout() {
      if (this._timeoutHandle !== null) {
        scope.clearTimeout?.(this._timeoutHandle);
        this._timeoutHandle = null;
      }
    }

    setTimeout(milliseconds, callback) {
      if (typeof callback !== 'function' && callback !== undefined) throw new TypeError('timeout callback must be a function');
      this._clearTimeout();
      const delay = Math.max(0, Number(milliseconds) || 0);
      this.timeout = delay;
      this._timeoutHandle = scope.setTimeout(() => {
        this._timeoutHandle = null;
        if (this.destroyed) return;
        this.emit('timeout');
        callback?.call(this);
        if (!this.destroyed && this._options.abortOnTimeout !== false) this.destroy(timeoutError(scope, delay));
      }, delay);
      return this;
    }

    clearTimeout() {
      this._clearTimeout();
      this.timeout = 0;
      return this;
    }

    setHeader(name, value) {
      if (this._started) throw new Error('Cannot set headers after they are sent');
      this._headers.set(String(name).toLowerCase(), normalizeHeaderValue(value));
      return this;
    }

    getHeader(name) {
      return this._headers.get(String(name).toLowerCase());
    }

    getHeaders() {
      return headersObject(this._headers);
    }

    getHeaderNames() {
      return [...this._headers.keys()];
    }

    hasHeader(name) {
      return this._headers.has(String(name).toLowerCase());
    }

    removeHeader(name) {
      if (this._started) throw new Error('Cannot remove headers after they are sent');
      this._headers.delete(String(name).toLowerCase());
      return this;
    }

    flushHeaders() {
      return this;
    }

    setNoDelay() {
      return this;
    }

    setSocketKeepAlive() {
      return this;
    }

    write(chunk, encoding = 'utf8', callback = undefined) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = 'utf8';
      }
      if (this.finished || this.destroyed) {
        const error = new Error('write after end');
        error.code = 'ERR_STREAM_WRITE_AFTER_END';
        schedule(scope, () => {
          this.emit('error', error);
          callback?.(error);
        });
        return false;
      }
      try {
        this._chunks.push(toBytes(chunk, scope, encoding));
      } catch (error) {
        schedule(scope, () => {
          this.emit('error', error);
          callback?.(error);
        });
        return false;
      }
      if (callback) schedule(scope, () => callback());
      return true;
    }

    end(chunk, encoding = 'utf8', callback = undefined) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = 'utf8';
      }
      if (chunk !== undefined) this.write(chunk, encoding);
      if (this.finished) return this;
      this.finished = true;
      this.writableEnded = true;
      this._endCallback = callback;
      schedule(scope, () => this._dispatch());
      return this;
    }

    abort() {
      if (this.destroyed) return this;
      this._abort(abortError(scope), false, true);
      return this;
    }

    destroy(error = undefined) {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.aborted ||= !this.response;
      this._clearTimeout();
      this._signalCleanup?.();
      this._signalCleanup = null;
      try { this._controller?.abort(error); } catch { this._controller?.abort(); }
      if (error) this._emitError(error);
      if (this.response && !this.response.destroyed) this.response.destroy(error);
      this._emitClose();
      return this;
    }

    _abort(error, emitError, emitAbort) {
      if (this.destroyed) return;
      this.aborted = true;
      if (emitAbort && !this._abortEmitted) {
        this._abortEmitted = true;
        schedule(scope, () => this.emit('abort'));
      }
      this.destroy(emitError ? error : undefined);
    }

    _emitError(error) {
      if (this._errorEmitted) return;
      this._errorEmitted = true;
      schedule(scope, () => this.emit('error', error));
    }

    _emitClose() {
      if (this._closed) return;
      this._closed = true;
      schedule(scope, () => this.emit('close'));
    }

    _dispatch() {
      if (this._started || this.destroyed) return;
      this._started = true;
      this.writableFinished = true;
      this.emit('finish');
      this._endCallback?.();

      let init;
      try {
        init = this._fetchInit();
      } catch (error) {
        this.destroy(error);
        return;
      }

      let operation;
      try {
        if (this._proxy) operation = this._proxy.request(proxyRequestOptions(this._url, init));
        else {
          const virtualResponse = this._virtualNetwork?.dispatch(this._url, init);
          if (virtualResponse) operation = virtualResponse;
          else {
            if (typeof scope.fetch !== 'function') throw new TypeError('fetch is unavailable in this browser context');
            operation = scope.fetch.call(scope, this._url, init);
          }
        }
      } catch (error) {
        this.destroy(error);
        return;
      }
      Promise.resolve(operation).then(
        (response) => this._handleResponse(this._proxy && !response?.arrayBuffer
          ? proxyResponse(response, this._url, scope)
          : response),
        (error) => this._handleFetchError(error),
      );
    }

    _fetchInit() {
      unsupportedTransportOptions(this._options);
      const body = concatenate(this._chunks);
      if (BODYLESS_METHODS.has(this.method) && body.byteLength) {
        throw new TypeError(`Request with ${this.method} method cannot have a body`);
      }
      const init = {
        method: this.method,
        headers: fetchHeaders(this._headers, scope),
      };
      if (this._controller) init.signal = this._controller.signal;
      else if (this._externalSignal) init.signal = this._externalSignal;
      if (body.byteLength) init.body = body;
      for (const name of ['cache', 'credentials', 'integrity', 'keepalive', 'mode', 'redirect', 'referrer', 'referrerPolicy']) {
        if (this._options[name] !== undefined) init[name] = this._options[name];
      }
      if (this._options.body !== undefined && !body.byteLength) init.body = this._options.body;
      return init;
    }

    _handleResponse(response) {
      if (this.destroyed) return;
      this.response = new IncomingMessage(response, this, scope, BufferClass);
      this.emit('response', this.response);
      void this.response.start();
    }

    _handleFetchError(error) {
      if (this.destroyed) return;
      const normalized = error?.name === 'AbortError'
        ? abortError(scope, error)
        : error?.name === 'TypeError' && /failed to fetch/i.test(String(error.message || ''))
          ? fetchNetworkError(this._url, error, scope)
          : error;
      this.destroy(normalized || new Error('fetch failed'));
    }

    _responseComplete() {
      this._clearTimeout();
      this._emitClose();
    }

    _responseFailed(error) {
      if (!this.destroyed) this.destroy(error);
    }
  };
}

function createProtocolModule(protocol, ClientRequest, Server, Agent, scope, netModule) {
  const request = (input, options, callback) => {
    const parsed = parseArguments(input, options, callback, scope);
    const requestOptions = { ...parsed.options, protocol: protocolName(parsed.options.protocol, protocol) };
    unsupportedTransportOptions(requestOptions);
    const url = validateURL(makeURL(parsed.target, requestOptions, protocol, scope), protocol, scope);
    const clientRequest = new ClientRequest(url, requestOptions);
    if (parsed.callback) clientRequest.once('response', parsed.callback);
    return clientRequest;
  };
  const get = (input, options, callback) => {
    const clientRequest = request(input, options, callback);
    clientRequest.end();
    return clientRequest;
  };
  const globalAgent = new Agent({ protocol });
  const module = {
    request,
    get,
    ClientRequest,
    IncomingMessage,
    METHODS,
    STATUS_CODES,
    Agent,
    globalAgent,
    Server,
    createServer(options, listener) {
      return new Server(options, listener);
    },
    createConnection(options, callback) {
      return netModule.createConnection(options, callback);
    },
  };
  return Object.freeze(module);
}

/** Create the browser-native Node-shaped http and https compatibility modules. */
export function createHttpCompatibility(scope = globalThis, {
  Buffer: BufferClass = scope.Buffer,
  proxy: configuredProxy,
  net: configuredNet,
  trackTask,
} = {}) {
  BufferClass ||= typeof Buffer === 'function' ? Buffer : undefined;
  const net = configuredNet || createBrowserNet({ BufferClass, trackTask });
  const virtualNetwork = createVirtualHttpNetwork(scope, BufferClass, net, trackTask);
  const proxy = configuredProxy
    ? (typeof configuredProxy.request === 'function' && configuredProxy.mode
      ? configuredProxy
      : createProxyCapability(configuredProxy))
    : null;
  const ClientRequest = createRequestClass(scope, BufferClass, virtualNetwork, proxy);
  const HttpServer = createServerClass(DEFAULT_HTTP_PROTOCOL, scope, virtualNetwork, BufferClass, trackTask);
  const HttpsServer = createServerClass(DEFAULT_HTTPS_PROTOCOL, scope, virtualNetwork, BufferClass, trackTask);
  const HttpAgent = class Agent extends BrowserAgent {
    constructor(options = {}) { super(options, DEFAULT_HTTP_PROTOCOL, net.createConnection); }
  };
  const HttpsAgent = class Agent extends BrowserAgent {
    constructor(options = {}) { super(options, DEFAULT_HTTPS_PROTOCOL, net.createConnection); }
  };
  const http = createProtocolModule(DEFAULT_HTTP_PROTOCOL, ClientRequest, HttpServer, HttpAgent, scope, net);
  const https = createProtocolModule(DEFAULT_HTTPS_PROTOCOL, ClientRequest, HttpsServer, HttpsAgent, scope, net);
  return Object.freeze({
    http,
    https,
    ClientRequest,
    IncomingMessage: http.IncomingMessage,
    boundaries: Object.freeze({
      rawTcp: net.createConnection,
      rawTls: net.createConnection,
      httpServer: () => undefined,
    }),
  });
}

export default createHttpCompatibility;
