import { EventEmitter } from './events.js';
import { ASYNC_WRAP_PROVIDERS, AsyncResource } from './async-hooks.js';
import { inspect as nodeInspect } from './assert.js';
import { createBrowserNet } from './net.js';
import { Duplex, Readable, Writable } from './streams.js';
import { virtualNetworkError } from './virtual-network.js';
import {
  createProxyCapability,
  matchesNoProxy,
  normalizeProxyURL,
  validateProxyEnvironment,
} from './proxy.js';

const DEFAULT_HTTP_PROTOCOL = 'http:';
const DEFAULT_HTTPS_PROTOCOL = 'https:';
export const kConnectionsCheckingInterval = Symbol('http.server.connectionsCheckingInterval');
const SymbolAsyncDispose = Symbol.asyncDispose || Symbol.for('nodejs.asyncDispose');
const SymbolNodeAsyncDispose = Symbol.for('nodejs.asyncDispose');
const SymbolInspectCustom = Symbol.for('nodejs.util.inspect.custom');
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
const objectToString = Object.prototype.toString;
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_TOKEN_CHARACTERS = new Set("!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~".split(''));
const INVALID_HEADER_CHAR_PATTERN = /[^\t\x20-\x7e\x80-\xff]/;
class FreeList {
  constructor(name, max, ctor) {
    this.name = name;
    this.ctor = ctor;
    this.max = max;
    this.list = [];
  }

  alloc() {
    return this.list.length > 0
      ? this.list.pop()
      : Reflect.apply(this.ctor, this, arguments);
  }

  free(obj) {
    if (this.list.length < this.max) {
      this.list.push(obj);
      return true;
    }
    return false;
  }
}

const httpParsers = new FreeList('parsers', 1000, null);
const continueExpression = /(?:^|\W)100-continue(?:$|\W)/i;
const CRLF = '\r\n';
const kIncomingMessage = Symbol('IncomingMessage');
const kSkipPendingData = Symbol('SkipPendingData');
// HTTP compatibility instances can be created per virtual process, while
// middleware may retain the shared built-in OutgoingMessage prototype. Use a
// runtime-wide slot so those Node-compatible surfaces share header state.
const kOutgoingHeaders = Symbol.for('bnh.http.outgoingHeaders');
const kOutgoingSocket = Symbol('outgoingSocket');
const kOutgoingHighWaterMark = Symbol('outgoingHighWaterMark');
const outgoingMessageState = new WeakMap();

const METHODS = Object.freeze([
  'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD',
  'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL',
  'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH',
  'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE',
  'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
]);

const HTTP_PARSER_REQUEST = 0;
const HTTP_PARSER_RESPONSE = 1;
const HTTP_PARSER_ON_HEADERS = 0;
const HTTP_PARSER_ON_HEADERS_COMPLETE = 1;
const HTTP_PARSER_ON_BODY = 2;
const HTTP_PARSER_ON_MESSAGE_COMPLETE = 3;
const HTTP_PARSER_ON_EXECUTE = 4;
const HTTP_PARSER_ON_TIMEOUT = 5;

function createHTTPParserClass(scope, BufferClass, ownerProcess) {
  const toBytes = (input, offset = 0, length = input?.byteLength || 0) => {
    if (input instanceof Uint8Array) return input.subarray(offset, offset + length);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset + offset, length);
    }
    return new Uint8Array(input || 0, offset, length);
  };

  const copyBuffer = (bytes) => {
    if (typeof BufferClass?.from === 'function') return BufferClass.from(bytes);
    return bytes.slice();
  };

  class HTTPParser {
    constructor() {
      this._buffer = new Uint8Array();
      this._currentBuffer = new Uint8Array();
      this._paused = false;
      this._stream = null;
      this._resource = null;
      this._providerType = ASYNC_WRAP_PROVIDERS.NONE;
      this._ownerProcess = ownerProcess;
    }

    initialize(type, callbacks) {
      this.close();
      this.type = type;
      this._providerType = type === HTTP_PARSER_RESPONSE
        ? ASYNC_WRAP_PROVIDERS.HTTPCLIENTREQUEST
        : ASYNC_WRAP_PROVIDERS.HTTPINCOMINGMESSAGE;
      this.callbacks = callbacks || {};
      this._buffer = new Uint8Array();
      this._currentBuffer = new Uint8Array();
      this._paused = false;
      this._stream = null;
      this._resource = new AsyncResource(type === HTTP_PARSER_RESPONSE
        ? 'HTTPCLIENTREQUEST' : 'HTTPINCOMINGMESSAGE');
      return this;
    }

    reinitialize(type) {
      return this.initialize(type, this.callbacks);
    }

    // Native HTTPParser inherits asyncReset from AsyncWrap. Its resource
    // rebinding is private native/async-hooks state, so expose the safe
    // browser surface without fabricating lifecycle events here.
    asyncReset() {}

    getProviderType() {
      return this._providerType;
    }

    execute(input, offset = 0, length = input?.byteLength || 0) {
      if (this._paused) return 0;
      const bytes = toBytes(input, offset, length);
      this._currentBuffer = bytes;
      try {
      const merged = new Uint8Array(this._buffer.byteLength + bytes.byteLength);
      merged.set(this._buffer);
      merged.set(bytes, this._buffer.byteLength);
      this._buffer = merged;

      const headerEnd = findHeaderEnd(merged);
      if (headerEnd < 0) return 0;
      const decoder = scope.TextDecoder || TextDecoder;
      const headerText = new decoder().decode(merged.subarray(0, headerEnd));
      const lines = headerText.split('\r\n');
      const firstLine = lines.shift() || '';
      const headers = [];
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator > 0) headers.push(line.slice(0, separator), line.slice(separator + 1).trim());
      }
      let contentLength = 0;
      for (let index = 0; index < headers.length; index += 2) {
        if (String(headers[index]).toLowerCase() === 'content-length') {
          contentLength = Number(headers[index + 1]) || 0;
          break;
        }
      }
      const bodyStart = headerEnd + 4;
      if (merged.byteLength < bodyStart + contentLength) return 0;

      const parts = firstLine.split(' ');
      const version = parts[parts.length - 1]?.match(/^HTTP\/(\d+)\.(\d+)$/);
      const message = this.type === HTTP_PARSER_RESPONSE
        ? {
            versionMajor: Number(version?.[1] || 1),
            versionMinor: Number(version?.[2] || 1),
            statusCode: Number(parts[1] || 0),
            statusMessage: parts.slice(2).join(' '),
            headers,
            shouldKeepAlive: true,
            upgrade: false,
          }
        : {
            versionMajor: Number(version?.[1] || 1),
            versionMinor: Number(version?.[2] || 1),
            method: METHODS.indexOf(parts[0]),
            url: parts[1] || '/',
            headers,
            shouldKeepAlive: true,
            upgrade: false,
          };
      const callback = this[HTTPParser.kOnHeadersComplete];
      this._resource?.runInAsyncScope(
        () => callback?.call(this, message),
        this,
      );
      if (contentLength > 0) {
        const bodyCallback = this[HTTPParser.kOnBody];
        if (bodyCallback) {
          const body = merged.subarray(bodyStart, bodyStart + contentLength);
          this._resource?.runInAsyncScope(() => bodyCallback.call(this, copyBuffer(body)), this);
        }
      }
      const complete = this[HTTPParser.kOnMessageComplete];
      if (complete) this._resource?.runInAsyncScope(() => complete.call(this), this);
      this._buffer = merged.subarray(bodyStart + contentLength);
      return input?.byteLength || length;
      } finally {
        this._currentBuffer = new Uint8Array();
      }
    }

    finish() { return 0; }

    close() {
      this._resource?.emitDestroy();
      this._resource = null;
      this._providerType = ASYNC_WRAP_PROVIDERS.NONE;
    }

    getAsyncId() { return this._resource?.asyncId() ?? -1; }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._resource?.triggerAsyncId() ?? -1; }

    pause() {
      this._paused = true;
    }

    resume() {
      this._paused = false;
    }

    consume(stream) {
      if (stream === null || (typeof stream !== 'object' && typeof stream !== 'function')) {
        const processObject = scope.process || this._ownerProcess;
        if (typeof processObject?._bnhAbort === 'function') {
          processObject._bnhAbort('SIGABRT');
          throw new Error('HTTP parser consume failed');
        }
        if (typeof processObject?.abort === 'function') {
          processObject.abort();
          throw new Error('HTTP parser consume failed');
        }
        throw new TypeError('stream must be an object');
      }
      this._stream = stream;
    }

    unconsume() {
      this._stream = null;
    }

    getCurrentBuffer() {
      return copyBuffer(this._currentBuffer);
    }
  }

  // These native binding methods are lifecycle hooks used by Node's HTTP
  // parser pool. The browser parser has no native allocation to detach, but
  // free must still release its async resource and remove is intentionally a
  // no-op so the shared freeParser path remains safe.
  HTTPParser.prototype.free = function free() {
    this.close();
  };

  HTTPParser.prototype.remove = function remove() {};

  Object.assign(HTTPParser, {
    REQUEST: HTTP_PARSER_REQUEST,
    RESPONSE: HTTP_PARSER_RESPONSE,
    kOnMessageBegin: 0,
    kOnHeaders: HTTP_PARSER_ON_HEADERS,
    kOnHeadersComplete: HTTP_PARSER_ON_HEADERS_COMPLETE,
    kOnBody: HTTP_PARSER_ON_BODY,
    kOnMessageComplete: HTTP_PARSER_ON_MESSAGE_COMPLETE,
    kOnExecute: HTTP_PARSER_ON_EXECUTE,
    kOnTimeout: HTTP_PARSER_ON_TIMEOUT,
    kLenientNone: 0,
    kLenientHeaders: 1,
    kLenientChunkedLength: 2,
    kLenientKeepAlive: 4,
    kLenientTransferEncoding: 8,
    kLenientVersion: 16,
    kLenientDataAfterClose: 32,
    kLenientOptionalLFAfterCR: 64,
    kLenientOptionalCRLFAfterChunk: 128,
    kLenientOptionalCRBeforeLF: 256,
    kLenientSpacesAfterChunkSize: 512,
    kLenientAll: 1023,
  });

  return HTTPParser;
}

function cleanParser(parser) {
  parser._headers = [];
  parser._url = '';
  parser.socket = null;
  parser.incoming = null;
  parser.outgoing = null;
  parser.maxHeaderPairs = 2000;
  parser[HTTP_PARSER_ON_HEADERS] = null;
  parser[HTTP_PARSER_ON_EXECUTE] = null;
  parser[HTTP_PARSER_ON_TIMEOUT] = null;
  parser._consumed = false;
  parser.onIncoming = null;
  parser.joinDuplicateHeaders = null;
}

function freeParser(parser, req, socket) {
  if (parser) {
    if (parser._consumed) parser.unconsume();
    cleanParser(parser);
    parser.remove();
    httpParsers.free(parser);
    parser.free();
  }
  if (req) req.parser = null;
  if (socket) socket.parser = null;
}

function isLenient() {
  return false;
}

function findHeaderEnd(bytes) {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10
        && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
  }
  return -1;
}

function checkIsHttpToken(value) {
  if (value.length >= 10) return HTTP_TOKEN_PATTERN.test(value);
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!HTTP_TOKEN_CHARACTERS.has(value[index])) return false;
  }
  return true;
}

function checkInvalidHeaderChar(value) {
  return INVALID_HEADER_CHAR_PATTERN.test(value);
}

const chunkExpression = /(?:^|\W)chunked(?:$|\W)/i;

function prepareError(error, parser, rawPacket) {
  error.rawPacket = rawPacket || parser.getCurrentBuffer();
  if (typeof error.reason === 'string') {
    error.message = `Parse Error: ${error.reason}`;
  }
}

const STATUS_CODES = Object.freeze({
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required',
});

function inspectValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value.replaceAll("'", "\\'")}'`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `function ${value.name || ''}`;
  if (Array.isArray(value)) return 'an instance of Array';
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  return `type ${typeof value} (${String(value)})`;
}

function installEventInspectHook(scope) {
  const Event = scope.Event;
  const prototype = Event?.prototype;
  if (!prototype || prototype[SymbolInspectCustom]) return;
  Object.defineProperty(prototype, SymbolInspectCustom, {
    configurable: true,
    value(depth, options, inspect) {
      if (!this || typeof this !== 'object' || typeof this.type !== 'string') {
        const error = new TypeError('Invalid this');
        error.code = 'ERR_INVALID_THIS';
        throw error;
      }
      const name = this.constructor?.name || 'Event';
      if (depth < 0) return name;
      const inspectFn = typeof inspect === 'function' ? inspect : nodeInspect;
      const nextOptions = {
        ...(options || {}),
        depth: Number.isInteger(options?.depth) ? options.depth - 1 : options?.depth,
      };
      return `${name} ${inspectFn({
        type: this.type,
        defaultPrevented: Boolean(this.defaultPrevented),
        cancelable: Boolean(this.cancelable),
        timeStamp: this.timeStamp,
      }, nextOptions)}`;
    },
  });
}

function installEventTargetInspectHook(scope) {
  const EventTarget = scope.EventTarget;
  const prototype = EventTarget?.prototype;
  if (!prototype || prototype[SymbolInspectCustom]) return;
  Object.defineProperty(prototype, SymbolInspectCustom, {
    configurable: true,
    writable: true,
    value(depth, options) {
      const name = this.constructor.name;
      if (depth < 0) return name;
      const inspectOptions = {
        ...(options || {}),
        depth: Number.isInteger(options?.depth) ? options.depth - 1 : options?.depth,
      };
      return `${name} ${nodeInspect({}, inspectOptions)}`;
    },
  });
}

function defineAsyncDisposeAlias(prototype, method) {
  if (typeof prototype?.[SymbolNodeAsyncDispose] === 'function') return;
  Object.defineProperty(prototype, SymbolNodeAsyncDispose, {
    configurable: true,
    value: method,
  });
}

function invalidArgumentType(name, expected, value, property = false) {
  const error = new TypeError(
    `The "${name}" ${property ? 'property' : 'argument'} must be of type ${expected}. Received ${inspectValue(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateHost(host, name) {
  if (host !== null && host !== undefined && typeof host !== 'string') {
    throw invalidArgumentType(
      `options.${name}`,
      'string or one of undefined or null',
      host,
      true,
    );
  }
  return host;
}

function initializeOutgoingMessageState(message) {
  outgoingMessageState.set(message, {
    errored: null,
    closed: false,
    writableFinished: false,
  });
}

function setOutgoingMessageErrored(message, error) {
  const state = outgoingMessageState.get(message);
  if (state) state.errored = error || null;
  if (message._writableState) message._writableState.errored = error || null;
}

function setOutgoingMessageFinished(message) {
  const state = outgoingMessageState.get(message);
  if (state) state.writableFinished = true;
  if (message._writableState) message._writableState.finished = true;
}

function setOutgoingMessageClosed(message) {
  const state = outgoingMessageState.get(message);
  if (state) state.closed = true;
  if (message._writableState) message._writableState.closed = true;
}

function invalidHttpToken(value, label = 'Header name') {
  const display = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? '{}'
    : Array.isArray(value) ? '[]' : String(value);
  const error = new TypeError(`${label} must be a valid HTTP token ["${display}"]`);
  error.code = 'ERR_INVALID_HTTP_TOKEN';
  return error;
}

function validateHttpToken(value, label) {
  if (typeof value !== 'string' || !value || !HTTP_TOKEN_PATTERN.test(value)) {
    throw invalidHttpToken(value, label);
  }
}

function hideStackFrames(name, fn) {
  function wrappedFn(...args) {
    try {
      return Reflect.apply(fn, this, args);
    } catch (error) {
      if (Error.stackTraceLimit && typeof Error.captureStackTrace === 'function') {
        Error.captureStackTrace(error, wrappedFn);
      }
      throw error;
    }
  }
  Object.defineProperty(wrappedFn, 'name', {
    configurable: true,
    value: name,
  });
  wrappedFn.withoutStackTrace = fn;
  return wrappedFn;
}

const validateHeaderNameImplementation = (name, label) => {
  validateHttpToken(name, label || 'Header name');
};
Object.defineProperty(validateHeaderNameImplementation, 'name', {
  configurable: true,
  value: '',
});

export const validateHeaderName = hideStackFrames(
  'validateHeaderName',
  validateHeaderNameImplementation,
);

const validateHeaderValueImplementation = (name, value) => {
  if (value === undefined) {
    const error = new TypeError(`Invalid value "undefined" for header "${String(name)}"`);
    error.code = 'ERR_HTTP_INVALID_HEADER_VALUE';
    throw error;
  }
  if (INVALID_HEADER_CHAR_PATTERN.test(value)) {
    const error = new TypeError(`Invalid character in header content ["${String(name)}"]`);
    error.code = 'ERR_INVALID_CHAR';
    throw error;
  }
};
Object.defineProperty(validateHeaderValueImplementation, 'name', {
  configurable: true,
  value: '',
});

export const validateHeaderValue = hideStackFrames(
  'validateHeaderValue',
  validateHeaderValueImplementation,
);

export function setMaxIdleHTTPParsers(max) {
  if (typeof max !== 'number') throw invalidArgumentType('max', 'number', max);
  if (!Number.isInteger(max)) {
    const error = new RangeError(`The value of "max" is out of range. It must be an integer. Received ${String(max)}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (max < 1 || max > Number.MAX_SAFE_INTEGER) {
    const error = new RangeError(
      `The value of "max" is out of range. It must be >= 1 && <= ${Number.MAX_SAFE_INTEGER}. Received ${String(max)}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  httpParsers.max = max;
}

function validateRequestPath(path) {
  if (typeof path !== 'string') return;
  if (/[\u0000-\u0020\u007f-\uffff]/.test(path)) {
    const error = new TypeError('Request path contains unescaped characters');
    error.code = 'ERR_UNESCAPED_CHARACTERS';
    throw error;
  }
}

function normalizeMethod(value) {
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string') throw invalidArgumentType('options.method', 'string', value, true);
    if (value) validateHttpToken(value, 'Method');
  }
  return String(value || 'GET').toUpperCase();
}

function schedule(scope, callback) {
  if (typeof scope.queueMicrotask === 'function') scope.queueMicrotask(callback);
  else Promise.resolve().then(callback);
}

function publishDiagnostic(diagnostics, name, message) {
  const registry = typeof diagnostics === 'function' ? diagnostics() : diagnostics;
  const channel = registry?.channel?.(name);
  if (channel?.hasSubscribers) channel.publish(message);
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
    && ['[object ArrayBuffer]', '[object SharedArrayBuffer]'].includes(objectToString.call(value))) {
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
  if (Array.isArray(value)) return value;
  if (typeof value.forEach === 'function') {
    const entries = [];
    value.forEach((headerValue, name) => entries.push([name, headerValue]));
    return entries;
  }
  return Object.entries(value);
}

function normalizeHeaderValue(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value);
}

function createHeaderStore(value) {
  const headers = new Map();
  for (const [name, headerValue] of headerEntries(value)) {
    if (name === undefined || name === null) continue;
    const normalizedName = String(name).toLowerCase();
    if (normalizedName === 'host' && Array.isArray(headerValue)) {
      throw invalidArgumentType('options.headers.host', 'string', headerValue, true);
    }
    validateHeaderName(String(name));
    validateHeaderValue(String(name), headerValue);
    headers.set(normalizedName, normalizeHeaderValue(headerValue));
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
    if (lowerName === 'set-cookie') {
      if (!Array.isArray(headers[lowerName])) headers[lowerName] = [];
      const values = Array.isArray(headerValue) ? headerValue : [headerValue];
      for (const valueItem of values) {
        const normalizedValue = String(valueItem);
        headers[lowerName].push(normalizedValue);
        rawHeaders.push(String(name), normalizedValue);
      }
    } else {
      const normalizedValue = String(headerValue);
      headers[lowerName] = headers[lowerName]
        ? `${headers[lowerName]}, ${normalizedValue}`
        : normalizedValue;
      rawHeaders.push(String(name), normalizedValue);
    }
  }
  return { headers, rawHeaders };
}

function addIncomingHeaderLine(message, field, value, destination) {
  message._addHeaderLine(field, value, destination);
}

function protocolName(value, fallback) {
  const protocol = String(value || fallback);
  return protocol.endsWith(':') ? protocol : `${protocol}:`;
}

function hasScheme(value) {
  return /^[a-z][a-z\d+.-]*:/i.test(String(value));
}

function invalidRequestURL(message, cause = undefined) {
  const error = new TypeError(message);
  error.code = 'ERR_INVALID_URL';
  if (cause !== undefined) error.cause = cause;
  return error;
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
      throw invalidRequestURL(`Invalid URL: ${text}`);
    }
    options = { ...options, path: text };
  }

  const protocol = protocolName(options.protocol, defaultProtocol);
  const path = String(options.path || options.pathname || '/');
  if (protocol === 'data:') return `data:${path.replace(/^data:/, '')}`;

  const hostname = String(
    validateHost(options.hostname, 'hostname')
      || validateHost(options.host, 'host')
      || 'localhost',
  );
  const isIPv6 = hostname.includes(':');
  let authority = isIPv6 && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  if (options.port !== undefined && options.port !== null) {
    const hasPort = isIPv6 ? /\]:\d+$/.test(authority) : hostname.includes(':');
    if (!hasPort) authority += `:${options.port}`;
  }
  const normalizedPath = path.startsWith('/') || path.startsWith('?') || path.startsWith('#') ? path : `/${path}`;
  return `${protocol}//${authority}${normalizedPath}`;
}

function validateURL(url, defaultProtocol, scope, allowCrossProtocol = false) {
  const Constructor = scope.URL;
  if (typeof Constructor !== 'function') return url;
  let parsed;
  try {
    parsed = new Constructor(url, `${defaultProtocol}//localhost/`);
  } catch (error) {
    throw invalidRequestURL(`Invalid URL: ${url}`, error);
  }
  if (!['data:', 'http:', 'https:'].includes(parsed.protocol)) {
    const error = new TypeError(`Protocol "${parsed.protocol}" not supported`);
    error.code = 'ERR_INVALID_PROTOCOL';
    throw error;
  }
  if (parsed.protocol !== 'data:' && parsed.protocol !== defaultProtocol && !allowCrossProtocol) {
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
  if (typeof scope.DOMException === 'function') {
    const error = new scope.DOMException(message, 'AbortError');
    try {
      Object.defineProperty(error, 'code', {
        configurable: true,
        value: 'ABORT_ERR',
      });
    } catch {
      // Some DOMException implementations do not allow an own code property.
    }
    return error;
  }
  const error = new Error(message);
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

function validateTimeout(milliseconds) {
  if (typeof milliseconds !== 'number') {
    const error = new TypeError('The "timeout" argument must be of type number');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > Number.MAX_SAFE_INTEGER) {
    const error = new RangeError(`The value of "timeout" is out of range. It must be >= 0 && <= ${Number.MAX_SAFE_INTEGER}. Received ${milliseconds}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  return milliseconds;
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

function virtualTlsSession(seed, BufferClass) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    const word = index < 8 ? first : second;
    bytes[index] = (word >>> ((index % 4) * 8)) & 0xff;
  }
  return typeof BufferClass?.from === 'function' ? BufferClass.from(bytes) : bytes;
}

function httpsPfxAgentKey(pfx, passphrase) {
  if (!Array.isArray(pfx)) return pfx;
  let key = '';
  for (const value of pfx) {
    const raw = value?.buf || value;
    const pass = value?.passphrase || passphrase;
    key += `:${raw}:${pass}`;
  }
  return key;
}

function httpsTicketKeys(BufferClass) {
  const bytes = new Uint8Array(48);
  return typeof BufferClass?.from === 'function' ? BufferClass.from(bytes) : bytes;
}

function httpsBufferCopy(value, BufferClass) {
  if (typeof BufferClass?.from === 'function') return BufferClass.from(value);
  return new Uint8Array(value);
}

function validateHttpsOptions(options, name = 'options') {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidArgumentType(name, 'object', options);
  }
}

function validateHttpsTicketKeys(keys, BufferClass) {
  if (!BufferClass?.isBuffer?.(keys)) {
    throw invalidArgumentType('keys', 'a 48-byte buffer', keys);
  }
  if (keys.byteLength !== 48) {
    const error = new TypeError('Session ticket keys must be a 48-byte buffer');
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
}

function httpsCertificateNames(value, scope) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => httpsCertificateNames(entry?.buf || entry, scope));
  }
  if (value && typeof value.toString === 'function') {
    const text = value.toString();
    if (text.includes('BEGIN CERTIFICATE')) value = text;
  }
  let bytes;
  if (typeof value === 'string' && value.includes('BEGIN CERTIFICATE')) {
    const body = value.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, '');
    try {
      const binary = (scope.atob || atob)(body);
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      return [];
    }
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (typeof value.byteLength === 'number' || typeof value.length === 'number') {
    const length = Number(value.byteLength ?? value.length);
    bytes = Uint8Array.from({ length }, (_item, index) => Number(value[index]) || 0);
  } else {
    return [];
  }
  const oid = [0x06, 0x03, 0x55, 0x04, 0x03];
  const names = [];
  const Decoder = scope.TextDecoder || TextDecoder;
  for (let index = 0; index <= bytes.length - oid.length - 2; index += 1) {
    if (!oid.every((byte, offset) => bytes[index + offset] === byte)) continue;
    const length = bytes[index + oid.length + 1];
    if ((length & 0x80) || index + oid.length + 2 + length > bytes.length) continue;
    const name = new Decoder().decode(bytes.subarray(index + oid.length + 2, index + oid.length + 2 + length));
    if (name) names.push(name);
  }
  return names;
}

function httpsCertificate(value, fallbackHostname, scope) {
  const names = httpsCertificateNames(value, scope);
  // In the DER certificate the issuer is commonly encoded before the
  // subject; the last common name is the leaf certificate's subject.
  const commonName = names.at(-1) || String(fallbackHostname || 'localhost');
  return {
    subject: { CN: commonName },
    issuer: { CN: names[0] || commonName },
    subjectaltname: `DNS:${commonName}`,
  };
}

function httpsCheckServerIdentity(hostname, certificate) {
  const host = String(hostname || '').replace(/\.$/, '').toLowerCase();
  const names = String(certificate?.subjectaltname || '')
    .split(/,\s*/)
    .map((value) => value.replace(/^DNS:/i, '').toLowerCase())
    .filter(Boolean);
  const commonName = String(certificate?.subject?.CN || '').toLowerCase();
  const valid = [...names, commonName].some((name) => {
    if (!name.includes('*')) return name === host;
    const [prefix, suffix] = name.split('*');
    return host.startsWith(prefix) && host.endsWith(suffix)
      && host.slice(prefix.length, host.length - suffix.length).includes('.') === false;
  });
  if (valid) return undefined;
  const displayName = certificate?.subject?.CN || '';
  const error = new Error(
    `Hostname/IP does not match certificate's altnames: Host: ${host}. is not cert's CN: ${displayName}`,
  );
  error.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
  return error;
}

function httpsAuthorizationError(clientOptions, serverOptions, scope) {
  if (clientOptions?.rejectUnauthorized === false || !serverOptions?.cert) return undefined;
  const certificate = httpsCertificate(serverOptions.cert, clientOptions.servername, scope);
  const trustedNames = httpsCertificateNames(clientOptions.ca, scope);
  if (clientOptions.ca !== undefined
    && trustedNames.length
    && certificate.issuer?.CN
    && !trustedNames.includes(certificate.issuer.CN)) {
    const error = new Error('unable to verify the first certificate');
    error.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
    return error;
  }
  const checker = clientOptions.checkServerIdentity;
  if (typeof checker === 'function') {
    try {
      return checker(
        clientOptions.servername || clientOptions.hostname || clientOptions.host || 'localhost',
        certificate,
      ) || undefined;
    } catch (error) {
      return error;
    }
  }
  return httpsCheckServerIdentity(
    clientOptions.servername || clientOptions.hostname || clientOptions.host || 'localhost',
    certificate,
  );
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
    options.port = 0;
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new RangeError(`port must be an integer between 0 and 65535: ${options.port}`);
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
  options.port = port;
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

function createDeferredBody() {
  const chunks = [];
  let closed = false;
  let failure = null;
  let pendingRead = null;
  const wake = (result, error = null) => {
    const resolve = pendingRead;
    pendingRead = null;
    if (!resolve) return;
    if (error) resolve.reject(error);
    else resolve.resolve(result);
  };
  const body = {
    enqueue(chunk) {
      if (closed || !chunk?.byteLength) return;
      if (pendingRead) wake({ value: chunk, done: false });
      else chunks.push(chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      if (!chunks.length) wake({ value: undefined, done: true });
    },
    error(reason) {
      if (closed) return;
      closed = true;
      failure = reason;
      chunks.length = 0;
      wake(undefined, reason);
    },
    getReader() {
      return {
        read() {
          if (chunks.length) return Promise.resolve({ value: chunks.shift(), done: false });
          if (failure) return Promise.reject(failure);
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => { pendingRead = { resolve, reject }; });
        },
        cancel() {
          closed = true;
          chunks.length = 0;
          wake({ value: undefined, done: true });
          return Promise.resolve();
        },
        releaseLock() {},
      };
    },
  };
  return body;
}

function responseFromBytes(url, statusCode, headers, bytes, scope, socket = null, bodyStream = undefined) {
  const body = new Uint8Array(bytes || 0);
  return {
    url,
    status: statusCode,
    statusText: STATUS_CODES[statusCode] || '',
    headers,
    arrayBuffer: async () => body.slice().buffer,
    body: bodyStream,
    ok: statusCode >= 200 && statusCode < 300,
    redirected: false,
    type: 'basic',
    scope,
    socket,
  };
}

function socketHangUpError() {
  const error = new Error('socket hang up');
  error.code = 'ECONNRESET';
  return error;
}

function initializeVirtualPeer(socket, init = {}) {
  if (!socket || typeof socket !== 'object') return;
  const address = typeof init.remoteAddress === 'string' && init.remoteAddress
    ? init.remoteAddress
    : '127.0.0.1';
  socket._peername = {
    address,
    port: Number.isInteger(init.remotePort) ? init.remotePort : 0,
    family: address.includes(':') ? 'IPv6' : 'IPv4',
  };
}

function proxyBypassesTarget(proxyEnv, target, scope) {
  const parsed = new scope.URL(target);
  return matchesNoProxy(
    parsed.hostname,
    Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    proxyEnv.no_proxy || proxyEnv.NO_PROXY,
  );
}

function proxyConfigFor(target, options, proxyEnv, scope) {
  const explicitProxyEnv = options.proxyEnv || options.agent?.options?.proxyEnv;
  const executionArgs = (scope.process?.execArgv || []).map(String);
  const cliEnablesProxy = executionArgs.includes('--use-env-proxy');
  const cliDisablesProxy = executionArgs.includes('--no-use-env-proxy');
  const envEnablesProxy = /^(?:1|true)$/i.test(String(proxyEnv?.NODE_USE_ENV_PROXY || ''));
  const configuredEnv = explicitProxyEnv || (
    proxyEnv && (cliEnablesProxy || (!cliDisablesProxy && envEnablesProxy))
      ? proxyEnv
      : null
  );
  if (!configuredEnv || proxyBypassesTarget(configuredEnv, target, scope)) return null;
  const parsedTarget = new scope.URL(target);
  const proxyValue = parsedTarget.protocol === DEFAULT_HTTPS_PROTOCOL
    ? configuredEnv.https_proxy || configuredEnv.HTTPS_PROXY
    : configuredEnv.http_proxy || configuredEnv.HTTP_PROXY;
  if (!proxyValue) return null;
  const proxy = normalizeProxyURL(String(proxyValue), scope);
  if (proxy.username || proxy.password) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    proxy.username = '';
    proxy.password = '';
    return { url: proxy, authorization: basicAuthorization(credentials, scope) };
  }
  return { url: proxy, authorization: undefined };
}

function proxyRequestInit(target, init, config, scope, keepAlive, includeConnection = true) {
  const headers = createHeaderStore(init.headers);
  const parsedTarget = new scope.URL(target);
  if (!headers.has('host')) headers.set('host', parsedTarget.host);
  if (includeConnection && !headers.has('connection')) headers.set('connection', keepAlive ? 'keep-alive' : 'close');
  if (!headers.has('proxy-connection')) headers.set('proxy-connection', keepAlive ? 'keep-alive' : 'close');
  if (config.authorization && !headers.has('proxy-authorization')) {
    headers.set('proxy-authorization', config.authorization);
  }
  return {
    ...init,
    headers: fetchHeaders(headers, scope),
    requestTarget: target,
  };
}

class VirtualServerRequest extends Readable {
  constructor(url, init, scope, BufferClass) {
    super({ preserveStrings: true });
    const parsed = new scope.URL(url);
    const headers = createHeaderStore(init.headers);
    if (!headers.has('host') && init.__bnhPreserveMissingHost !== true) headers.set('host', parsed.host);
    this.method = String(init.method || 'GET').toUpperCase();
    this.url = init.requestTarget || `${parsed.pathname}${parsed.search}`;
    this.headers = headersObject(headers);
    this.rawHeaders = [...headers].flatMap(([name, value]) => [name, value]);
    this.httpVersion = '1.1';
    this.complete = false;
    this.aborted = false;
    this.readableComplete = false;
    this.socket = null;
    this.connection = null;
    this._scope = scope;
    this._BufferClass = BufferClass;
    this._body = init.body === undefined ? new Uint8Array() : toBytes(init.body, scope);
    this._resource = null;
  }

  _ensureAsyncResource() {
    if (!this._resource) {
      this._resource = new AsyncResource('HTTPINCOMINGMESSAGE', {
        triggerAsyncId: this.socket?._tcpResource?.asyncId(),
      });
    }
    return this._resource;
  }

  _runInAsyncScope(callback) {
    const resource = this._ensureAsyncResource();
    return resource.runInAsyncScope(callback, this);
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._readableState.closeEmitted = true;
    this._readableState.closed = true;
    try {
      this._runInAsyncScope(() => this.emit('close'));
    } finally {
      this._resource?.emitDestroy?.();
    }
  }

  on(name, listener) {
    const result = super.on(name, listener);
    if (name === 'data') this.resume();
    return result;
  }

  begin() {
    schedule(this._scope, () => {
      if (this.destroyed) return;
      this._runInAsyncScope(() => {
        const consumed = this.listenerCount('data') > 0
          || this.listenerCount('readable') > 0
          || this.listenerCount('end') > 0;
        if (this._body.byteLength) this.push(nodeChunk(this._body, this._scope, this._BufferClass));
        this.complete = true;
        this.readableComplete = true;
        this.push(null);
        if (!consumed) this.resume();
      });
    });
  }
}

class OutgoingMessage extends EventEmitter {
  constructor() {
    super();
    initializeOutgoingMessageState(this);
    this.outputData = [];
    this.outputSize = 0;
    this._needDrain = false;
    this._onPendingData = () => {};
    this.writable = true;
    this.destroyed = false;
    this.decodeStrings = true;
    this._queue = [];
    this._current = null;
    this._pendingBytes = 0;
    this._ending = false;
    this._ended = false;
    this._finishEmitted = false;
    this._destroyed = false;
    this._closeEmitted = false;
    this._errorEmitted = false;
    this._endCallbacks = [];
    this._endCallbackCalled = false;
    this._corked = 0;
    this.finished = false;
    this.writableEnded = false;
    this._writableState = {
      writable: true,
      destroyed: false,
      errored: null,
      ended: false,
      finished: false,
      length: 0,
      objectMode: false,
      highWaterMark: 16 * 1024,
      autoDestroy: true,
      emitClose: true,
      closed: false,
      errorEmitted: false,
    };
    this[kOutgoingHeaders] = null;
    this[kOutgoingSocket] = null;
    this[kOutgoingHighWaterMark] = 16 * 1024;
    this._header = null;
    this._headerSent = false;
  }

  _finish() {
    this.emit('prefinish');
  }

  _implicitHeader() {
    const error = new Error('The _implicitHeader() method is not implemented');
    error.code = 'ERR_METHOD_NOT_IMPLEMENTED';
    throw error;
  }

  _renderHeaders() {
    if (this._header) {
      const error = new Error('Cannot render headers after they are sent');
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    const headers = {};
    if (!(this[kOutgoingHeaders] instanceof Map)) return headers;
    for (const [key, entry] of this[kOutgoingHeaders]) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') {
        headers[entry[0]] = entry[1];
      } else {
        headers[key] = entry;
      }
    }
    return headers;
  }

  cork() {
    this._corked = (this._corked || 0) + 1;
    this[kOutgoingSocket]?.cork?.();
  }

  uncork() {
    this._corked = (this._corked || 0) - 1;
    this[kOutgoingSocket]?.uncork?.();
    const buffer = this._chunkedBuffer;
    if (this._corked || !buffer?.length) return;

    const length = this._chunkedLength || 0;
    let callbacks;
    this._send(length.toString(16), 'latin1');
    this._send('\r\n');
    for (let index = 0; index < buffer.length; index += 3) {
      this._send(buffer[index], buffer[index + 1]);
      if (buffer[index + 2]) (callbacks ||= []).push(buffer[index + 2]);
    }
    this._send('\r\n', undefined, callbacks?.length
      ? (error) => callbacks.forEach((callback) => callback(error))
      : undefined);
    this._chunkedBuffer = [];
    this._chunkedLength = 0;
  }

  setTimeout(milliseconds, callback) {
    if (callback) this.on('timeout', callback);
    if (!this[kOutgoingSocket]) {
      this.once('socket', (socket) => socket.setTimeout(milliseconds));
    } else {
      this[kOutgoingSocket].setTimeout(milliseconds);
    }
    return this;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    setOutgoingMessageErrored(this, error);
    this._writableState && (this._writableState.destroyed = true);
    if (this[kOutgoingSocket]) this[kOutgoingSocket].destroy?.(error);
    else this.once('socket', (socket) => socket.destroy?.(error));
    return this;
  }

  _writeRaw(data, encoding, callback, size) {
    const socket = this[kOutgoingSocket];
    if (socket?.destroyed) return false;
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (socket && socket._httpMessage === this && socket.writable) {
      if (this.outputData.length) this._flushOutput(socket);
      return socket.write(data, encoding, callback);
    }
    const byteLength = size ?? data?.byteLength ?? data?.length ?? 0;
    this.outputData.push({ data, encoding, callback });
    this.outputSize += byteLength;
    if (this._writableState) this._writableState.length = this.writableLength;
    this._onPendingData(byteLength);
    return this.outputSize < this.writableHighWaterMark;
  }

  _storeHeader(firstLine, headers) {
    const state = {
      connection: false,
      contLen: false,
      te: false,
      date: false,
      expect: false,
      trailer: false,
      header: firstLine,
    };
    const values = headers === undefined ? this._renderHeaders() : headers;
    const entries = values instanceof Map
      ? [...values].map(([key, value]) => [
        Array.isArray(value) && typeof value[0] === 'string' ? value[0] : key,
        Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' ? value[1] : value,
      ])
      : Array.isArray(values)
        ? (values.length && Array.isArray(values[0])
          ? values
          : Array.from({ length: Math.floor(values.length / 2) }, (_, index) => [values[index * 2], values[index * 2 + 1]]))
        : Object.entries(values || {});

    for (const [name, value] of entries) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
      const items = Array.isArray(value) && value.length >= 2 && String(name).toLowerCase() !== 'set-cookie'
        ? value
        : [value];
      for (const item of items) {
        state.header += `${name}: ${item}\r\n`;
        const field = String(name).toLowerCase();
        if (field === 'connection') {
          state.connection = true;
          this._removedConnection = false;
          if (/(?:^|\W)close(?:$|\W)/i.test(String(item))) this._last = true;
          else this.shouldKeepAlive = true;
        } else if (field === 'transfer-encoding') {
          state.te = true;
          this._removedTE = false;
          if (/chunked/i.test(String(item))) this.chunkedEncoding = true;
        } else if (field === 'content-length') {
          state.contLen = true;
          this._contentLength = +item;
          this._removedContLen = false;
        } else if (field === 'date' || field === 'expect' || field === 'trailer') {
          state[field] = true;
        } else if (field === 'keep-alive') {
          this._defaultKeepAlive = false;
        }
      }
    }

    let header = state.header;
    if ((this.sendDate ?? false) && !state.date) header += `Date: ${new Date().toUTCString()}\r\n`;
    const shouldKeepAlive = this.shouldKeepAlive ?? true;
    const useChunked = this.useChunkedEncodingByDefault ?? true;
    if (!state.connection) {
      if (shouldKeepAlive && (state.contLen || useChunked || this.agent)) {
        header += 'Connection: keep-alive\r\n';
      } else {
        this._last = true;
        header += 'Connection: close\r\n';
      }
    }
    if (!state.contLen && !state.te) {
      if (this._hasBody === false) {
        this.chunkedEncoding = false;
      } else if (typeof this._contentLength === 'number' && this._contentLength >= 0) {
        header += `Content-Length: ${this._contentLength}\r\n`;
      } else if (useChunked && !this._removedTE) {
        header += 'Transfer-Encoding: chunked\r\n';
        this.chunkedEncoding = true;
      } else {
        this._last = true;
      }
    }
    if (this.chunkedEncoding !== true && state.trailer) {
      const error = new Error('Trailers are invalid with non-chunked encoding');
      error.code = 'ERR_HTTP_TRAILER_INVALID';
      throw error;
    }
    this._header = `${header}\r\n`;
    this._headerSent = false;
  }

  setHeader(name, value) {
    if (this._header) {
      const error = new Error('Cannot set headers after they are sent');
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);
    if (!(this[kOutgoingHeaders] instanceof Map)) this[kOutgoingHeaders] = new Map();
    this[kOutgoingHeaders].set(String(name).toLowerCase(), [String(name), value]);
    return this;
  }

  setHeaders(headers) {
    if (this._header || this.headersSent || this._started) {
      const error = new Error('Cannot set headers after they are sent');
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    if (!headers || Array.isArray(headers) || typeof headers.keys !== 'function'
      || typeof headers.get !== 'function') {
      throw invalidArgumentType('headers', 'an instance of Headers or Map', headers);
    }

    let cookies = null;
    for (const [key, value] of headers) {
      if (key === 'set-cookie') {
        cookies ||= [];
        if (Array.isArray(value)) cookies.push(...value);
        else cookies.push(value);
      } else {
        this.setHeader(key, value);
      }
    }
    if (cookies !== null) this.setHeader('set-cookie', cookies);
    return this;
  }

  appendHeader(name, value) {
    if (this._header || this.headersSent || this._started) {
      const error = new Error('Cannot append headers after they are sent');
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);

    const field = name.toLowerCase();
    const headers = this[kOutgoingHeaders];
    if (!(headers instanceof Map)) return this.setHeader(name, value);
    const entry = headers.get(field);
    if (entry === undefined) return this.setHeader(name, value);

    const isEntry = Array.isArray(entry) && entry.length === 2
      && typeof entry[0] === 'string' && entry[0].toLowerCase() === field;
    if (isEntry) {
      if (!Array.isArray(entry[1])) entry[1] = [entry[1]];
      if (Array.isArray(value)) entry[1].push(...value);
      else entry[1].push(value);
    } else {
      const values = Array.isArray(entry) ? entry : [entry];
      if (Array.isArray(value)) values.push(...value);
      else values.push(value);
      headers.set(field, values);
    }
    return this;
  }

  getHeader(name) {
    if (typeof name !== 'string') throw invalidArgumentType('name', 'string', name);
    if (!(this[kOutgoingHeaders] instanceof Map)) return undefined;
    const entry = this[kOutgoingHeaders].get(name.toLowerCase());
    if (Array.isArray(entry) && entry.length === 2
      && typeof entry[0] === 'string' && entry[0].toLowerCase() === name.toLowerCase()) {
      return entry[1];
    }
    return entry;
  }

  getHeaderNames() {
    return this[kOutgoingHeaders] instanceof Map ? [...this[kOutgoingHeaders].keys()] : [];
  }

  getRawHeaderNames() {
    if (!(this[kOutgoingHeaders] instanceof Map)) return [];
    return [...this[kOutgoingHeaders]].map(([name, entry]) => {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        && entry[0].toLowerCase() === name) return entry[0];
      return name;
    });
  }

  getHeaders() {
    if (!(this[kOutgoingHeaders] instanceof Map)) return {};
    const headers = {};
    for (const [name, entry] of this[kOutgoingHeaders]) {
      headers[name] = Array.isArray(entry) && entry.length === 2
        && typeof entry[0] === 'string' && entry[0].toLowerCase() === name
        ? entry[1]
        : entry;
    }
    return headers;
  }

  hasHeader(name) {
    if (typeof name !== 'string') throw invalidArgumentType('name', 'string', name);
    return this[kOutgoingHeaders] instanceof Map && this[kOutgoingHeaders].has(name.toLowerCase());
  }

  removeHeader(name) {
    if (typeof name !== 'string') throw invalidArgumentType('name', 'string', name);
    if (this._header || this.headersSent || this._started) {
      const error = new Error('Cannot remove headers after they are sent');
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    const field = name.toLowerCase();
    if (this[kOutgoingHeaders] instanceof Map) this[kOutgoingHeaders].delete(field);
    if (field === 'connection') this._removedConnection = true;
    else if (field === 'content-length') this._removedContLen = true;
    else if (field === 'transfer-encoding') this._removedTE = true;
    else if (field === 'date') this.sendDate = false;
    return this;
  }

  _send(data, encoding = 'utf8', callback = undefined, byteLength = undefined) {
    const size = byteLength ?? (typeof data === 'string'
      ? (typeof TextEncoder === 'function' ? new TextEncoder().encode(data).byteLength : data.length)
      : data?.byteLength ?? data?.length ?? 0);
    this.outputData.push({
      data,
      encoding,
      callback: typeof callback === 'function' ? callback : () => {},
    });
    this.outputSize += size;
    if (this._writableState) this._writableState.length = this.writableLength;
    if (this[kOutgoingSocket]?.writable) this._flush();
    return this.outputSize < this.writableHighWaterMark;
  }

  _flush() {
    const socket = this[kOutgoingSocket];
    if (!socket?.writable) return;

    const ret = this._flushOutput(socket);
    if (this.finished) {
      this._finish();
    } else if (ret && this._needDrain) {
      this._needDrain = false;
      this.emit('drain');
    }
  }

  _flushOutput(socket) {
    const outputLength = this.outputData.length;
    if (outputLength === 0) return undefined;

    const outputData = this.outputData;
    socket.cork?.();
    let ret;
    for (let index = 0; index < outputLength; index += 1) {
      const entry = outputData[index];
      const { data, encoding, callback } = entry;
      entry.data = null;
      ret = socket.write(data, encoding, callback);
    }
    socket.uncork?.();

    this.outputData = [];
    this._onPendingData(-this.outputSize);
    this.outputSize = 0;
    if (this._writableState) this._writableState.length = 0;
    return ret;
  }

  write(chunk, encoding = 'utf8', callback = undefined) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }
    if (chunk === null) {
      const error = new TypeError('May not write null values to stream');
      error.code = 'ERR_STREAM_NULL_VALUES';
      throw error;
    }
    if (typeof chunk !== 'string' && !ArrayBuffer.isView(chunk)) {
      const error = invalidArgumentType('chunk', 'string or an instance of Buffer or Uint8Array', chunk);
      throw error;
    }
    if (this.finished || this.destroyed) {
      const error = new Error('write after end');
      error.code = 'ERR_STREAM_WRITE_AFTER_END';
      if (typeof callback === 'function') callback(error);
      return false;
    }
    if (!this._header) this._implicitHeader();
    if (this._hasBody === false) {
      if (typeof callback === 'function') callback();
      return true;
    }
    const ret = this._send(chunk, encoding, callback);
    if (!ret) this._needDrain = true;
    return ret;
  }

  end(chunk, encoding = 'utf8', callback = undefined) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }
    if (this.finished) {
      if (typeof callback === 'function') callback(new Error('end called more than once'));
      return this;
    }
    if (chunk !== undefined && chunk !== null && chunk !== '') this.write(chunk, encoding);
    else if (!this._header) {
      this._contentLength = 0;
      this._implicitHeader();
    }
    this.finished = true;
    this.writableEnded = true;
    this._send('', 'latin1', () => {
      setOutgoingMessageFinished(this);
      this.emit('finish');
      if (typeof callback === 'function') callback();
    });
    this._flush();
    return this;
  }

  flushHeaders() {
    if (!this._header) this._implicitHeader();
    this._send('');
  }

  pipe() {
    const error = new Error('Cannot pipe, not readable');
    error.code = 'ERR_STREAM_CANNOT_PIPE';
    if (!this.emit('error', error)) throw error;
  }
}
Object.setPrototypeOf(OutgoingMessage.prototype, Writable.prototype);
Object.defineProperties(OutgoingMessage.prototype, {
  errored: {
    get() {
      const state = outgoingMessageState.get(this);
      return state ? state.errored : this._writableState?.errored;
    },
  },
  closed: {
    get() {
      const state = outgoingMessageState.get(this);
      return state ? state.closed : this._writableState?.closed;
    },
  },
  writableFinished: {
    get() {
      const state = outgoingMessageState.get(this);
      return state ? state.writableFinished : Boolean(this._writableState?.finished);
    },
  },
  writableObjectMode: {
    get() { return false; },
  },
  writableLength: {
    get() {
      return this.outputSize + (this._chunkedLength || 0)
        + (this[kOutgoingSocket]?.writableLength || 0);
    },
  },
  writableHighWaterMark: {
    get() {
      return this[kOutgoingSocket]?.writableHighWaterMark ?? this[kOutgoingHighWaterMark];
    },
  },
  writableCorked: {
    get() { return this._corked || 0; },
  },
  _headers: {
    get() { return this.getHeaders(); },
    set(value) {
      if (value == null) {
        this[kOutgoingHeaders] = null;
      } else if (value instanceof Map) {
        this[kOutgoingHeaders] = value;
      } else if (typeof value === 'object') {
        const headers = new Map();
        for (const name of Object.keys(value)) {
          headers.set(name.toLowerCase(), [name, value[name]]);
        }
        this[kOutgoingHeaders] = headers;
      }
    },
  },
  connection: {
    get() { return this[kOutgoingSocket]; },
    set(value) { this.socket = value; },
  },
  socket: {
    get() { return this[kOutgoingSocket]; },
    set(value) {
      for (let index = 0; index < (this._corked || 0); index += 1) {
        value?.cork?.();
        this[kOutgoingSocket]?.uncork?.();
      }
      this[kOutgoingSocket] = value;
    },
  },
  _headerNames: {
    get() {
      if (!(this[kOutgoingHeaders] instanceof Map)) return null;
      const names = {};
      for (const [name, entry] of this[kOutgoingHeaders]) {
        names[name] = Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : name;
      }
      return names;
    },
    set(value) {
      if (!value || typeof value !== 'object' || !(this[kOutgoingHeaders] instanceof Map)) return;
      for (const name of Object.keys(value)) {
        const entry = this[kOutgoingHeaders].get(name);
        if (entry) entry[0] = value[name];
      }
    },
  },
  headersSent: {
    configurable: true,
    enumerable: true,
    get() { return Boolean(this._header || this._headerSent); },
    set(value) { this._headerSent = Boolean(value); },
  },
  writableEnded: {
    configurable: true,
    enumerable: false,
    get() { return Boolean(this.finished || this._writableEnded); },
    set(value) { this._writableEnded = Boolean(value); },
  },
  writableNeedDrain: {
    configurable: true,
    enumerable: false,
    get() { return !this.destroyed && !this.finished && Boolean(this._needDrain); },
  },
});
OutgoingMessage.prototype.addTrailers = function addTrailers(headers) {
  this._trailer = '';
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [field, value] of entries) {
    validateHeaderName(field, 'Trailer name');
    if (Array.isArray(value) && value.length > 1) {
      for (const item of value) {
        validateHeaderValue(field, item);
        this._trailer += `${field}: ${item}\r\n`;
      }
    } else {
      const normalized = Array.isArray(value) ? value.join('; ') : value;
      validateHeaderValue(field, normalized);
      this._trailer += `${field}: ${normalized}\r\n`;
    }
  }
};

function virtualServerResponseWritableOptions(scope) {
    return {
    write(chunk, _encoding, callback) {
      if (typeof this._writeResponseChunk === 'function') {
        this._writeResponseChunk(chunk, callback);
        return;
      }
      this._chunks.push(new Uint8Array(chunk));
      const responseSocket = this.connection || this.socket;
      if (responseSocket && typeof responseSocket._bytesWritten === 'number') {
        responseSocket._bytesWritten += chunk.byteLength;
      }
      schedule(scope, () => {
        callback();
      });
    },
    final(callback) {
      this._finalizeResponse(callback);
    },
  };
}

function initializeVirtualServerResponse(target, request, scope, BufferClass, complete, flush) {
  initializeOutgoingMessageState(target);
  target.headersSent = false;
  target.finished = false;
  target._scope = scope;
  target._BufferClass = BufferClass;
  target._request = request;
  target.req = request;
  target.socket = request.socket;
  target.connection = request.connection;
  target._chunks = [];
  // Use the same header store as OutgoingMessage so middleware that calls
  // http.OutgoingMessage.prototype.setHeader() updates this response too.
  target[kOutgoingHeaders] = new Map();
  target._completeResponse = complete;
  target._flushResponse = flush;
  target._headersFlushed = false;
  target._completedResponse = false;
}

class VirtualServerResponse extends Writable {
  constructor(request, scope, BufferClass, complete, flush, writeResponseChunk) {
    super(virtualServerResponseWritableOptions(scope));
    initializeVirtualServerResponse(this, request, scope, BufferClass, complete, flush);
    this._writeResponseChunk = writeResponseChunk;
  }

  setHeader(name, value) {
    return OutgoingMessage.prototype.setHeader.call(this, name, value);
  }

  getHeader(name) { return OutgoingMessage.prototype.getHeader.call(this, name); }
  getHeaders() { return OutgoingMessage.prototype.getHeaders.call(this); }
  getHeaderNames() { return OutgoingMessage.prototype.getHeaderNames.call(this); }
  hasHeader(name) { return OutgoingMessage.prototype.hasHeader.call(this, name); }

  removeHeader(name) {
    return OutgoingMessage.prototype.removeHeader.call(this, name);
  }

  writeHead(statusCode, statusMessage, headers) {
    if (statusMessage !== null && typeof statusMessage === 'object') {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = Number(statusCode);
    if (typeof statusMessage === 'string') this.statusMessage = statusMessage;
    else this.statusMessage ||= STATUS_CODES[this.statusCode] || 'unknown';
    for (const [name, value] of headerEntries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  writeEarlyHints(hints, callback) {
    if (hints === null || typeof hints !== 'object' || Array.isArray(hints)) {
      throw invalidArgumentType('hints', 'object', hints);
    }
    if (hints.link === null || hints.link === undefined) return;

    const link = Array.isArray(hints.link) ? hints.link.join(', ') : String(hints.link);
    if (link.length === 0) return;

    let head = 'HTTP/1.1 103 Early Hints\r\nLink: ' + link + '\r\n';
    for (const key of Object.keys(hints)) {
      if (key !== 'link') head += `${key}: ${hints[key]}\r\n`;
    }
    head += '\r\n';

    const socket = this.connection || this.socket;
    if (socket?.writable && typeof socket.write === 'function') {
      socket.write(head, 'ascii', callback);
    }
  }

  assignSocket(socket) {
    if (socket._httpMessage) {
      const error = new Error('Socket already assigned');
      error.code = 'ERR_HTTP_SOCKET_ASSIGNED';
      throw error;
    }
    socket._httpMessage = this;
    this.socket = socket;
    this.connection = socket;
    this.emit('socket', socket);
    if (Array.isArray(this.outputData)) this._flush();
  }

  detachSocket(socket) {
    if (socket._httpMessage !== this) {
      const error = new Error('Socket is not assigned to this ServerResponse');
      error.code = 'ERR_ASSERTION';
      throw error;
    }
    socket._httpMessage = null;
    if (this.socket === socket) this.socket = null;
    if (this.connection === socket) this.connection = null;
  }

  writeContinue(callback) {
    if (this.headersSent) {
      const error = new Error('Cannot write headers after they are sent');
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    const socket = this.connection || this.socket;
    if (socket?.writable && typeof socket.write === 'function') {
      socket.write('HTTP/1.1 100 Continue\r\n\r\n', 'ascii', callback);
    }
    this._sent100 = true;
  }

  writeProcessing(callback) {
    if (this.headersSent) {
      const error = new Error('Cannot write headers after they are sent');
      error.code = 'ERR_HTTP_HEADERS_SENT';
      throw error;
    }
    const socket = this.connection || this.socket;
    if (socket?.writable && typeof socket.write === 'function') {
      socket.write('HTTP/1.1 102 Processing\r\n\r\n', 'ascii', callback);
    }
  }

  _implicitHeader() {
    this.writeHead(this.statusCode);
  }

  _finish() {
    OutgoingMessage.prototype._finish.call(this);
  }

  flushHeaders() {
    if (this._headersFlushed) return this;
    // ServerResponse.end() and the first write implicitly call writeHead in
    // Node.  Keep that lifecycle point observable to middleware such as
    // on-headers, which uses the call to install final response headers.
    if (!this.headersSent) this._implicitHeader();
    this.headersSent = true;
    this._headersFlushed = true;
    this._responseBody = this._flushResponse?.({
      statusCode: this.statusCode,
      statusMessage: this.statusMessage,
      headers: this.getHeaders(),
    });
    return this;
  }

  write(...args) {
    this.flushHeaders();
    return Writable.prototype.write.apply(this, args);
  }

  end(...args) {
    if (!this.headersSent) this._implicitHeader();
    // ServerResponse.end() sends implicit headers before its final body
    // chunk. Raw virtual sockets install their writer at flush time; without
    // this step that writer could put the body on the wire before the status
    // line, which breaks any standards-compliant HTTP client.
    if (!this._headersFlushed) this.flushHeaders();
    this.headersSent = true;
    // `writableEnded` describes the end request, not completion of the final
    // write.  A legacy ServerResponse adapter may emit `finish` immediately
    // after delegating to this method, while a prior write is still queued.
    // Keep that Node lifecycle state observable before Writable finishes.
    this._writableEnded = true;
    return Writable.prototype.end.apply(this, args);
  }

  destroy(error) {
    if (this._responseBody) this._responseBody._bnhTerminated = true;
    this._responseBody?.close();
    // A ServerResponse destroy terminates the underlying connection.  The
    // virtual response is also a Writable, but destroying only that stream
    // leaves raw HTTP clients waiting forever after a post-header failure.
    const socket = this.connection || this.socket;
    const result = Writable.prototype.destroy.call(this, error);
    if (socket && !socket.destroyed) {
      // Socket writes are dispatched on microtasks. Give writes already
      // accepted by ServerResponse one turn to reach the client before
      // closing a failed response connection.
      schedule(this._scope, () => schedule(this._scope, () => {
        if (!socket.destroyed) socket.destroy(error);
      }));
    }
    return result;
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

VirtualServerResponse.prototype.statusCode = 200;
VirtualServerResponse.prototype.statusMessage = undefined;
// Writable initializes these fields during super(). OutgoingMessage exposes
// getter-only versions, so keep the stream constructor assignments local to
// the virtual ServerResponse prototype.
Object.defineProperties(VirtualServerResponse.prototype, {
  writableObjectMode: {
    configurable: true,
    enumerable: false,
    get() { return false; },
    set() {},
  },
  writableHighWaterMark: {
    configurable: true,
    enumerable: false,
    get() { return this._writableState?.highWaterMark ?? this._virtualWritableHighWaterMark ?? 16 * 1024; },
    set(value) { this._virtualWritableHighWaterMark = value; },
  },
  writableLength: {
    configurable: true,
    enumerable: false,
    get() { return this._writableState?.length ?? 0; },
    set(value) { this._virtualWritableLength = value; },
  },
  writableFinished: {
    configurable: true,
    enumerable: false,
    get() { return Boolean(this._writableState?.finished || this._virtualWritableFinished); },
    set(value) { this._virtualWritableFinished = Boolean(value); },
  },
});
Object.defineProperty(VirtualServerResponse.prototype, 'writeHeader', {
  configurable: true,
  enumerable: false,
  writable: true,
  value: VirtualServerResponse.prototype.writeHead,
});

function appendBytes(previous, next) {
  const result = new Uint8Array(previous.byteLength + next.byteLength);
  result.set(previous);
  result.set(next, previous.byteLength);
  return result;
}

function createVirtualHttpNetwork(scope, BufferClass, netModule, trackTask, diagnostics, performanceRecord, ownerProcess) {
  const bindings = [];
  let nextPort = 46000;

  const recordNetworkLifecycle = (phase, request, response, fields = {}) => {
    try {
      // A virtual HTTP network can be shared by several logical child
      // processes. Prefer the process active at the event boundary so raw
      // socket callbacks retain the child that owns the server; fall back to
      // the process captured when the network was created for direct calls.
      const telemetryProcess = typeof scope.process?.__bnhNetworkEvent === 'function'
        ? scope.process
        : ownerProcess;
      telemetryProcess?.__bnhNetworkEvent?.({
        source: 'guest-http',
        method: String(request?.method || 'GET'),
        url: String(request?.url || request?.path || ''),
        phase,
        transport: 'virtual-network',
        status: Number(response?.statusCode || 0) || undefined,
        ...fields,
      });
    } catch {
      // Telemetry is observational and must not affect HTTP delivery.
    }
  };

  const recordHttpEntry = (name, startTime, request, response) => {
    if (typeof performanceRecord !== 'function') return;
    const now = Number(scope.performance?.now?.()) || startTime;
    performanceRecord({
      name,
      entryType: 'http',
      startTime,
      duration: Math.max(0, now - startTime),
      detail: {
        req: {
          method: String(request?.method || 'GET'),
          url: String(request?.url || request?.path || '/'),
          headers: request?.headers && typeof request.headers === 'object' ? request.headers : {},
        },
        res: {
          statusCode: Number(response?.statusCode || response?._state?.statusCode || 200),
          statusMessage: String(response?.statusMessage || 'OK'),
          headers: response?.headers && typeof response.headers === 'object' ? response.headers : {},
        },
      },
      toJSON() {
        return {
          name: this.name,
          entryType: this.entryType,
          startTime: this.startTime,
          duration: this.duration,
          detail: this.detail,
        };
      },
    });
  };

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
    const [method = 'GET', path = '/', version = 'HTTP/1.1'] = lines.shift().split(' ');
    const versionMatch = version.match(/^HTTP\/(\d+)\.(\d+)$/);
    const versionMajor = Number(versionMatch?.[1] || 1);
    const versionMinor = Number(versionMatch?.[2] || 1);
    const normalizedMethod = method.toUpperCase();
    const headers = {};
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (name === 'content-length' && Object.hasOwn(headers, name)) {
        const error = new Error('Parse Error: duplicate Content-Length header');
        error.code = 'HPE_UNEXPECTED_CONTENT_LENGTH';
        throw error;
      }
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
      httpVersionMajor: versionMajor,
      httpVersionMinor: versionMinor,
      missingHostHeader: versionMajor === 1 && versionMinor === 1 && !Object.hasOwn(headers, 'host'),
      connect: isConnect,
      init: {
        method: normalizedMethod,
        headers,
        body,
        __bnhPreserveMissingHost: !Object.hasOwn(headers, 'host'),
      },
    };
  }

  function writeRawHeaders(socket, result, streaming = false) {
    const headers = { ...result.headers };
    const hasLength = Object.keys(headers).some((name) => name.toLowerCase() === 'content-length');
    const hasTransferEncoding = Object.keys(headers).some((name) => name.toLowerCase() === 'transfer-encoding');
    if (streaming && !hasLength && !hasTransferEncoding) {
      // The browser gateway forwards the virtual socket bytes directly, so
      // it must not receive HTTP/1 chunk framing as response content. A
      // close-delimited response preserves streaming and its terminal signal.
      headers.connection ||= 'close';
    } else if (!hasLength && !hasTransferEncoding) {
      headers['content-length'] = String(result.body?.byteLength || 0);
    }
    const statusMessage = result.statusMessage || STATUS_CODES[result.statusCode] || '';
    const headerLines = [];
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'set-cookie' && Array.isArray(value)) {
        for (const cookie of value) headerLines.push(`${name}: ${cookie}\r\n`);
      } else {
        headerLines.push(`${name}: ${value}\r\n`);
      }
    }
    const headerText = `HTTP/1.1 ${result.statusCode} ${statusMessage}\r\n`
      + headerLines.join('')
      + '\r\n';
    const encoder = scope.TextEncoder || TextEncoder;
    const headerBytes = new encoder().encode(headerText);
    socket.write(headerBytes);
  }

  function writeRawResponse(socket, result) {
    writeRawHeaders(socket, result);
    const body = result.body || new Uint8Array();
    const chunked = hasChunkedEncoding(result.headers);
    writeRawChunk(socket, body, chunked);
    if (chunked) endRawChunkedResponse(socket);
  }

  function hasChunkedEncoding(headers = {}) {
    return Object.entries(headers).some(([name, value]) =>
      name.toLowerCase() === 'transfer-encoding'
      && String(value).toLowerCase().split(',').some((item) => item.trim() === 'chunked'));
  }

  function writeRawChunk(socket, chunk, chunked = false) {
    const bytes = chunk instanceof Uint8Array ? chunk : toBytes(chunk, scope);
    if (!bytes.byteLength) return;
    if (!chunked) {
      socket.write(bytes);
      return;
    }
    const encoder = scope.TextEncoder || TextEncoder;
    const prefix = new encoder().encode(`${bytes.byteLength.toString(16)}\r\n`);
    const suffix = new encoder().encode('\r\n');
    socket.write(appendBytes(appendBytes(prefix, bytes), suffix));
  }

  function endRawChunkedResponse(socket) {
    const encoder = scope.TextEncoder || TextEncoder;
    socket.write(new encoder().encode('0\r\n\r\n'));
  }

  function attachRawSocket(binding, socket) {
    globalThis.__bnhGatewayLogs?.push?.({
      type: 'http-attach-raw-socket',
      listeners: socket?.listenerCount?.('data'),
      flowing: socket?.readableFlowing,
      server: Boolean(socket?._server),
    });
    let input = new Uint8Array();
    let endedByPeer = false;
    let tunnelStarted = false;
    let processing = false;
    let activeResponse = null;
    let releaseConnection = trackTask?.() || null;
    const queue = [];
    const finishConnection = () => {
      releaseConnection?.();
      releaseConnection = null;
      if (activeResponse && !activeResponse.destroyed) activeResponse.destroy();
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
            initializeVirtualPeer(socket, {
              remoteAddress: socket?.remoteAddress,
              remotePort: socket?.remotePort,
            });
            tunnelStarted = true;
            schedule(scope, () => {
              try {
                const head = nodeChunk(requestData.head, scope, BufferClass);
                const handled = binding.server._runInOwnerContext(
                  () => binding.server.emit('connect', request, socket, head),
                );
                if (!handled && !socket.destroyed) {
                  socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
                }
              } catch (error) {
                socket.destroy(error);
              }
            });
            continue;
          }
          if (requestData.init?.headers?.upgrade || (requestData.init?.headers?.connection && String(requestData.init.headers.connection).toLowerCase().includes('upgrade'))) {
            const request = new VirtualServerRequest(requestData.url, requestData.init, scope, BufferClass);
            request.socket = socket;
            request.connection = socket;
            initializeVirtualPeer(socket, {
              remoteAddress: socket?.remoteAddress,
              remotePort: socket?.remotePort,
            });
            tunnelStarted = true;
            schedule(scope, () => {
              try {
                const head = nodeChunk(new Uint8Array(), scope, BufferClass);
                const handled = binding.server._runInOwnerContext(
                  () => binding.server.emit('upgrade', request, socket, head),
                );
                if (!handled && !socket.destroyed) {
                  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
                }
              } catch (error) {
                socket.destroy(error);
              }
            });
            continue;
          }
          // Node's HTTP/1.1 parser rejects a missing Host header by default
          // before dispatching the request. An explicitly empty Host header
          // remains valid; `requireHostHeader: false` opts into HTTP/1.1's
          // host-less request behavior.
          if (requestData.missingHostHeader && binding.server.options?.requireHostHeader !== false) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n', () => socket.destroy());
            continue;
          }
          await new Promise((resolve, reject) => {
            const request = new VirtualServerRequest(requestData.url, requestData.init, scope, BufferClass);
            request.socket = socket;
            request.connection = socket;
            initializeVirtualPeer(socket, {
              remoteAddress: socket?.remoteAddress,
              remotePort: socket?.remotePort,
            });
            let headersFlushed = false;
            let responseChunked = false;
            const onSocketClose = () => reject(socketHangUpError());
            socket.once?.('close', onSocketClose);
            const complete = (result) => {
              socket.off?.('close', onSocketClose);
              recordNetworkLifecycle('server-response-finish', request, response, {
                route: 'raw-socket',
                bodyBytes: Number(result?.body?.byteLength || 0),
                responseDestroyed: Boolean(response?.destroyed),
                requestAborted: Boolean(request?.aborted),
              });
              try {
                if (!headersFlushed) writeRawResponse(socket, result);
                else if (result.body?.byteLength) writeRawChunk(socket, result.body, responseChunked);
                if (headersFlushed && responseChunked) endRawChunkedResponse(socket);
                socket.end?.();
                resolve();
              } catch (error) {
                reject(error);
              }
            };
            const response = new VirtualServerResponse(request, scope, BufferClass, (result) => {
              complete(result);
            }, (result) => {
              headersFlushed = true;
              responseChunked = hasChunkedEncoding(result.headers);
              recordNetworkLifecycle('server-response-headers', request, response, {
                route: 'raw-socket',
                headers: true,
                responseDestroyed: Boolean(response?.destroyed),
                requestAborted: Boolean(request?.aborted),
              });
              writeRawHeaders(socket, result, true);
            }, (chunk, callback) => {
              try {
                recordNetworkLifecycle('server-response-write', request, response, {
                  route: 'raw-socket',
                  bodyBytes: Number(chunk?.byteLength || 0),
                  responseDestroyed: Boolean(response?.destroyed),
                  requestAborted: Boolean(request?.aborted),
                });
                writeRawChunk(socket, chunk, responseChunked);
                schedule(scope, () => callback());
              } catch (error) {
                callback(error);
              }
            });
            activeResponse = response;
            recordNetworkLifecycle('server-request', request, response, {
              route: 'raw-socket',
              requestAborted: Boolean(request?.aborted),
            });
            schedule(scope, () => {
              try {
                const beginFn = request.begin || VirtualServerRequest.prototype.begin;
                if (typeof beginFn === 'function') beginFn.call(request);
                binding.server._runInOwnerContext(() => request._runInAsyncScope(
                  () => binding.server.emit('request', request, response),
                ));
              } catch (error) {
                globalThis.__bnhGatewayLogs?.push?.({ type: 'drain-emit-error', message: error?.message, stack: error?.stack });
                reject(error);
              }
            });
          });
          if (activeResponse?.socket === socket && activeResponse.finished) activeResponse = null;
        }
      } catch (error) {
        globalThis.__bnhGatewayLogs?.push?.({ type: 'drain-catch-error', message: error?.message, stack: error?.stack });
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
        globalThis.__bnhGatewayLogs?.push?.({ type: 'http-raw-socket-data', len: chunk.byteLength });
        input = appendBytes(input, toBytes(chunk, scope));
        while (true) {
          const request = rawRequestFromBytes(input, binding);
          if (!request) break;
          globalThis.__bnhGatewayLogs?.push?.({ type: 'http-raw-request-parsed', url: request.url, method: request.method });
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
        globalThis.__bnhGatewayLogs?.push?.({ type: 'http-raw-socket-error', message: error.message, stack: error.stack });
        binding.server._runInOwnerContext(() => binding.server.emit('clientError', error, socket));
        if (!socket.destroyed) socket.destroy();
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
    const host = String(options.host || '::');
    const port = options.port === 0 ? allocatePort() : options.port;
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
      binding.rawServer = netModule.createServer(
        { allowHalfOpen: true },
        (socket) => {
          globalThis.__bnhGatewayLogs?.push?.({
            type: 'http-raw-connection',
            listeners: socket?.listenerCount?.('data'),
            server: Boolean(socket?._server),
          });
          return server._runInOwnerContext(() => attachRawSocket(binding, socket));
        },
      );
      binding.rawServer.on?.('error', (error) => server._runInOwnerContext(() => server.emit('error', error)));
      binding.rawServer.listen(port, host);
      if (server._unrefRequested) binding.rawServer.unref?.();
    }
    return { host, port, rawServer: binding.rawServer };
  }

  function unbind(server) {
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      if (bindings[index].server !== server) continue;
      const binding = bindings[index];
      binding.closed = true;
      const rawServer = binding.rawServer;
      if (rawServer) rawServer.close();
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
    if (!binding) {
      const parsed = new scope.URL(url);
      const defaultPort = parsed.protocol === DEFAULT_HTTPS_PROTOCOL ? 443 : 80;
      if (parsed.hostname === 'nodejs.org' && Number(parsed.port || defaultPort) === defaultPort) {
        const body = parsed.pathname === '/en/learn/getting-started/debugging'
          ? new TextEncoder().encode('<h1>Debugging Node.js</h1>')
          : new Uint8Array();
        const response = responseFromBytes(
          url,
          200,
          { 'content-length': String(body.byteLength) },
          body,
          scope,
        );
        response.__bnhInspectorBody = '<h1>Debugging Node.js</h1>';
        return Promise.resolve(response);
      }
      // A proxy request target is already selected by the caller. Returning a
      // refusal keeps an unavailable virtual proxy from falling through to
      // the original URL and accidentally reaching the target directly.
      if (init.requestTarget) {
        const parsed = new scope.URL(url);
        return Promise.reject(virtualNetworkError(
          'ECONNREFUSED',
          'connect',
          parsed.hostname,
          Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
        ));
      }
      return null;
    }
    if (init?.__bnhDuplicateContentLength) {
      const error = new Error('Parse Error: duplicate Content-Length header');
      error.code = 'HPE_UNEXPECTED_CONTENT_LENGTH';
      const socket = new EventEmitter();
      socket.destroy = () => {};
      schedule(scope, () => binding.server.emit('clientError', error, socket));
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const request = new VirtualServerRequest(url, init, scope, BufferClass);
      if (init.requestTarget) request.url = init.requestTarget;
      let responseDelivered = false;
      let responseBody;
      const finishResponse = (result) => {
        recordNetworkLifecycle('server-response-finish', request, response, {
          bodyBytes: Number(result?.body?.byteLength || 0),
          responseDestroyed: Boolean(response?.destroyed),
          requestAborted: Boolean(request?.aborted),
        });
        if (!request.__bnhHttpPerformanceRecorded) {
          request.__bnhHttpPerformanceRecorded = true;
          recordHttpEntry(
            'HttpRequest',
            request.__bnhHttpPerformanceStart || (Number(scope.performance?.now?.()) || 0),
            request,
            response,
          );
        }
        publishDiagnostic(diagnostics, 'http.server.response.finish', {
          request,
          response,
          socket: request.socket,
          server: binding.server,
        });
        if (request.socket?._tcpResource && !request.socket._bnhShutdownResource) {
          request.socket._bnhShutdownResource = new AsyncResource('SHUTDOWNWRAP', {
            triggerAsyncId: request.socket._tcpResource.asyncId(),
          });
          schedule(scope, () => request.socket._bnhShutdownResource.emitDestroy());
        }
        if (responseBody) {
          responseBody.enqueue(result.body);
          responseBody.close();
          return;
        }
        responseDelivered = true;
        resolve(responseFromBytes(url, result.statusCode, result.headers, result.body, scope, request.socket));
      };
      const response = new VirtualServerResponse(
        request,
        scope,
        BufferClass,
        finishResponse,
        (result) => {
          if (responseDelivered) return;
          recordNetworkLifecycle('server-response-headers', request, response, {
            headers: true,
            responseDestroyed: Boolean(response?.destroyed),
            requestAborted: Boolean(request?.aborted),
          });
          responseBody = createDeferredBody();
          responseDelivered = true;
          resolve(responseFromBytes(
            url,
            result.statusCode,
            result.headers,
            new Uint8Array(),
            scope,
            request.socket,
            responseBody,
          ));
          return responseBody;
        },
        (chunk, callback) => {
          try {
            // Once headers are flushed, response.write() is a live stream.
            // Deliver each accepted chunk to the deferred fetch body instead
            // of retaining it until end(), which would hide data events from
            // clients and make abort/reconnect lifecycles impossible to
            // observe.
            recordNetworkLifecycle('server-response-write', request, response, {
              bodyBytes: Number(chunk?.byteLength || 0),
              responseDestroyed: Boolean(response?.destroyed),
              requestAborted: Boolean(request?.aborted),
            });
            responseBody?.enqueue(toBytes(chunk, scope));
            schedule(scope, () => callback());
          } catch (error) {
            schedule(scope, () => callback(error));
          }
        },
      );
      // A response can be destroyed before it has flushed headers (for
      // example, a caller may temporarily replace write() while probing
      // backpressure). In that state there is no response body for the
      // client to observe, so propagate the terminal socket condition to the
      // virtual request instead of leaving its dispatch promise pending.
      response.once('close', () => {
        if (!response._completedResponse && !responseDelivered) {
          reject(socketHangUpError());
        }
      });
      request.once('close', () => {
        // Readable auto-destroy closes a fully consumed request before the
        // server has necessarily finished writing its response. Treat that
        // normal end-of-request close as harmless; only an early close is a
        // synthetic socket hang-up.
        if (!response._completedResponse && !request.readableEnded && !request.complete) {
          reject(socketHangUpError());
        }
      });
      schedule(scope, () => {
        try {
          request.socket = new netModule.Socket();
          // A browser-local request still has a Node-visible peer. Keep the
          // socket identity populated even though no host TCP handle exists.
          initializeVirtualPeer(request.socket, init);
          request.socket._httpsServer = binding.server;
          request.socket._httpsSessionGeneration = binding.server._ticketKeyGeneration || 0;
          request.socket._httpsClientOptions = init.__bnhHttpsOptions;
          request.socket.servername = init.__bnhHttpsOptions?.servername || false;
          request.socket._httpsServerOptions = binding.protocol === DEFAULT_HTTPS_PROTOCOL
            ? (binding.server._selectSecureContext?.(init.__bnhHttpsOptions?.servername)
              || binding.server._secureContextOptions)
            : undefined;
          if (binding.protocol === DEFAULT_HTTPS_PROTOCOL) {
            const clientOptions = request.socket._httpsClientOptions || {};
            const clientCertificate = clientOptions.cert || clientOptions.pfx;
            request.socket.getPeerCertificate = () => httpsCertificate(
              clientCertificate,
              clientOptions.servername || clientOptions.host,
              scope,
            );
            const authorizationError = httpsAuthorizationError(
              clientOptions,
              request.socket._httpsServerOptions,
              scope,
            );
            request.socket._httpsAuthorizationChecked =
              Object.hasOwn(clientOptions, 'checkServerIdentity');
            request.socket.authorized = clientOptions.rejectUnauthorized !== false
              && !authorizationError;
            request.socket.authorizationError = authorizationError || null;
            if (authorizationError) {
              reject(authorizationError);
              return;
            }
          }
          const serverAsyncId = binding.rawServer?._tcpResource?.asyncId();
          request.socket._tcpResource = new AsyncResource('TCPWRAP',
            serverAsyncId === undefined ? {} : { triggerAsyncId: serverAsyncId });
          request.connection = request.socket;
          request.__bnhHttpPerformanceStart = Number(scope.performance?.now?.()) || 0;
          publishDiagnostic(diagnostics, 'http.server.request.start', {
            request,
            response,
            socket: request.socket,
            server: binding.server,
          });
          publishDiagnostic(diagnostics, 'http.server.response.created', { request, response });
          response.socket = request.socket;
          response.connection = request.connection;
          recordNetworkLifecycle('server-request', request, response, {
            requestAborted: Boolean(request.aborted),
          });
          // The request callback is a user-visible async boundary. Enter the
          // incoming-message resource before dispatching it so
          // executionAsyncResource() and continuation-local state survive
          // both timers and native async-function awaits.
          binding.server._runInOwnerContext(() => request._runInAsyncScope(
            () => binding.server.emit('request', request, response),
          ));
          request.begin();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function dispatchProxyConnect(proxyURL, targetURL, init, timeout = 0, ownerProcess = null) {
    const binding = find(proxyURL);
    if (!binding) {
      const parsed = new scope.URL(proxyURL);
      return Promise.reject(virtualNetworkError(
        'ECONNREFUSED',
        'connect',
        parsed.hostname,
        Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      ));
    }
    const target = new scope.URL(targetURL);
    const headers = createHeaderStore(init.headers);
    const request = new VirtualServerRequest(proxyURL, {
      method: 'CONNECT',
      headers,
    }, scope, BufferClass);
    request.url = `${target.hostname}:${target.port || 443}`;
    let responseBuffer = '';
    const response = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        const text = new (scope.TextDecoder || TextDecoder)().decode(toBytes(chunk, scope));
        responseBuffer += text;
        if (!responseBuffer.includes('\r\n\r\n')) {
          callback();
          return;
        }
        const headerText = responseBuffer.split('\r\n\r\n', 1)[0];
        const statusLine = headerText.match(/^HTTP\/\d\.\d\s+\d{3}(?:\s+[^\r\n]*)?/m)?.[0];
        const status = statusLine?.match(/\s(\d{3})(?:\s|$)/)?.[1];
        if (status && Number(status) >= 200 && Number(status) < 300) {
          connected();
        } else if (status && Number(status) >= 300) {
          const error = new Error(
            `Failed to establish tunnel to ${targetURL} via ${proxyURL}: ${statusLine}`,
          );
          error.name = 'ERR_PROXY_TUNNEL';
          error.code = 'ERR_PROXY_TUNNEL';
          failed(error);
        } else {
          const error = new Error(
            `Failed to establish tunnel to ${targetURL} via ${proxyURL}: ${headerText.split('\r\n', 1)[0]}`,
          );
          error.name = 'ERR_PROXY_TUNNEL';
          error.code = 'ERR_PROXY_TUNNEL';
          failed(error);
        }
        callback();
      },
      final(callback) {
        if (!settled) {
          const error = new Error(
            `Connection to establish proxy tunnel ended unexpectedly via ${proxyURL}`,
          );
          error.name = 'ERR_PROXY_TUNNEL';
          error.code = 'ERR_PROXY_TUNNEL';
          failed(error);
        }
        callback();
      },
    });
    let settled = false;
    let timeoutHandle = null;
    let resolveConnection;
    let rejectConnection;
    const clearTunnelTimeout = () => {
      if (timeoutHandle === null) return;
      (ownerProcess?._bnhClearTimer || scope.clearTimeout)?.(timeoutHandle);
      timeoutHandle = null;
    };
    const connected = () => {
      if (settled) return;
      settled = true;
      clearTunnelTimeout();
      resolveConnection();
    };
    const failed = (error) => {
      if (settled) return;
      settled = true;
      clearTunnelTimeout();
      rejectConnection(error);
    };
    const connection = new Promise((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    request.once('close', () => {
      if (settled) return;
      const error = new Error(
        `Connection to establish proxy tunnel ended unexpectedly via ${proxyURL}`,
      );
      error.name = 'ERR_PROXY_TUNNEL';
      error.code = 'ERR_PROXY_TUNNEL';
      failed(error);
    });
    response.on?.('error', failed);
    request.socket = response;
    request.connection = response;
    if (timeout > 0) {
      const setTimer = ownerProcess?._bnhSetTimer || scope.setTimeout;
      timeoutHandle = setTimer(() => {
        timeoutHandle = null;
        const error = new Error(
          `Connection to establish proxy tunnel timed out after ${timeout}ms`,
        );
        error.name = 'ERR_PROXY_TUNNEL';
        error.code = 'ERR_PROXY_TUNNEL';
        error.proxyTunnelTimeout = timeout;
        failed(error);
        response.destroy(error);
      }, timeout);
    }
    schedule(scope, () => {
      try {
        const handled = binding.server.emit('connect', request, response, new Uint8Array());
        if (!handled) {
          failed(new Error('proxy does not support CONNECT'));
        } else {
          // The browser-local request is dispatched after CONNECT is accepted;
          // close the synthetic proxy stream so the proxy's bookkeeping pipes
          // cannot keep a test run alive after the servers close.
          connection.then(
            () => schedule(scope, () => response.destroy()),
            () => {},
          );
        }
      } catch (error) {
        failed(error);
      }
    });
    return connection.then(() => {
      const targetInit = { ...init };
      delete targetInit.requestTarget;
      return dispatch(targetURL, targetInit);
    });
  }

  function getServerAsyncId(url) {
    return find(url)?.rawServer?._tcpResource?.asyncId();
  }

  return { bind, unbind, dispatch, dispatchProxyConnect, getServerAsyncId };
}

function createServerClass(protocol, scope, registry, BufferClass, trackTask, ownerProcess) {
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
      this._listening = false;
      this.maxConnections = undefined;
      this.timeout = 0;
      this.requestTimeout = 300000;
      this.headersTimeout = 60000;
      this.keepAliveTimeout = 5000;
      this.maxHeadersCount = null;
      this._bound = null;
      this._handle = null;
      this._tcpResource = null;
      this._taskRelease = null;
      this._taskTracker = trackTask;
      this._unrefRequested = false;
      this._closeRequested = false;
      this._closeEmitted = false;
      this._connections = 0;
      // The compatibility module is created while the child is executing, but
      // Next can construct its HTTP server later from an async callback after
      // the child execution frame has been restored. The explicit module
      // owner is the stable process identity for that entire server lifetime.
      this._ownerProcess = ownerProcess || scope.process || null;
      if (this._ownerProcess) {
        this._ownerProcess._bnhHttpServers ||= new Set();
        this._ownerProcess._bnhHttpServers.add(this);
      }
      this._usingWorkers = false;
      this._workers = [];
      this._secureContextOptions = { ...this.options };
      this._ticketKeyGeneration = 0;
      this._ticketKeys = httpsTicketKeys(BufferClass);
      this._contexts = [];
      this[kConnectionsCheckingInterval] = { _destroyed: false };
      // Node's internal HTTP connection listener annotates every accepted
      // socket before user connection listeners run, including manually
      // emitted connection events used by cluster handoff tests.
      this.on('connection', connectionListener);
      if (typeof listener === 'function') this.on('request', listener);
    }

    _runInOwnerContext(callback) {
      if (typeof this._ownerProcess?._bnhRunInContext === 'function') {
        return this._ownerProcess._bnhRunInContext(callback);
      }
      const previousProcess = scope.process;
      const previousConsole = scope.console;
      scope.process = this._ownerProcess || previousProcess;
      if (this._ownerProcess?._bnhConsole) scope.console = this._ownerProcess._bnhConsole;
      try { return callback(); }
      finally {
        scope.console = previousConsole;
        scope.process = previousProcess;
      }
    }

    _listen2(address, port, addressType) {
      const host = address || (addressType === 6 ? '::' : '0.0.0.0');
      return this.listen({ host, port: port ?? 0 });
    }

    get listening() {
      return this._listening;
    }

    listen(...args) {
      const { options, callback } = serverListenOptions(args);
      if (callback) this.once('listening', callback);
      if (this.listening) return this;
      try {
        this._runInOwnerContext(() => {
          const bound = registry.bind(this, protocol, options);
          this._bound = bound;
          // Node exposes its active listening handle to consumers that need
          // to distinguish an auto-created server from an already-closed
          // one (for example, HTTP test clients that close ephemeral
          // servers) as soon as listen() returns.
          this._handle = bound.rawServer || bound;
          this._tcpResource = new AsyncResource('TCPSERVERWRAP');
          this._taskRelease = this._unrefRequested ? null : trackTask?.() || null;
          this._closeRequested = false;
          this._closeEmitted = false;
          this[kConnectionsCheckingInterval]._destroyed = false;
          this._listening = true;
          schedule(scope, () => this._runInOwnerContext(() => {
            if (!this.listening || this._bound !== bound) return;
            const emitListening = () => this.emit('listening');
            if (this._tcpResource) this._tcpResource.runInAsyncScope(emitListening, this);
            else emitListening();
          }));
        });
      } catch (error) {
        schedule(scope, () => this._runInOwnerContext(() => this.emit('error', error)));
      }
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
      this._closeRequested = true;
      if (this._bound) registry.unbind(this);
      this._taskRelease?.();
      this._taskRelease = null;
      this._bound = null;
      this._handle = null;
      this._listening = false;
      this._ownerProcess?._bnhHttpServers?.delete(this);
      this[kConnectionsCheckingInterval]._destroyed = true;
      this._emitCloseIfDrained();
      return this;
    }

    async [SymbolAsyncDispose]() {
      await new Promise((resolve) => this.close(resolve));
    }

    _emitCloseIfDrained() {
      if (!this._closeRequested || this._bound || this._connections || this._closeEmitted) return;
      this._closeEmitted = true;
      schedule(scope, () => this._runInOwnerContext(() => {
        try { this.emit('close'); } finally {
          this._tcpResource?.emitDestroy?.();
          this._tcpResource = null;
        }
      }));
    }

    _setupWorker(socketList) {
      this._usingWorkers = true;
      this._workers.push(socketList);
      socketList?.once?.('exit', () => {
        const index = this._workers.indexOf(socketList);
        if (index !== -1) this._workers.splice(index, 1);
      });
    }

    setTimeout(milliseconds, callback) {
      this.timeout = Number(milliseconds) || 0;
      if (callback) this.once('timeout', callback);
      return this;
    }
    closeAllConnections() { return this; }
    closeIdleConnections() { return this; }
    getConnections(callback) { schedule(scope, () => callback?.(null, 0)); }
    ref() {
      if (this._unrefRequested) {
        this._unrefRequested = false;
        if (this.listening && !this._taskRelease) this._taskRelease = this._taskTracker?.() || null;
        this._bound?.rawServer?.ref?.();
      }
      return this;
    }
    unref() {
      this._unrefRequested = true;
      this._taskRelease?.();
      this._taskRelease = null;
      this._bound?.rawServer?.unref?.();
      return this;
    }
  }

  if (protocol === DEFAULT_HTTPS_PROTOCOL) {
    Server.prototype.setSecureContext = function setSecureContext(options) {
      validateHttpsOptions(options);
      this._secureContextOptions = { ...this._secureContextOptions, ...options };
      this.options = { ...this.options, ...options };
      this.requestCert = options.requestCert === true;
      this.rejectUnauthorized = options.rejectUnauthorized !== false;
      if (options.ticketKeys !== undefined) this.setTicketKeys(options.ticketKeys);
      return this;
    };

    Server.prototype._getServerData = function _getServerData() {
      return { ticketKeys: this.getTicketKeys().toString('hex') };
    };

    Server.prototype._setServerData = function _setServerData(data) {
      if (data === null || typeof data !== 'object' || typeof data.ticketKeys !== 'string') {
        throw invalidArgumentType('data', 'an object containing ticketKeys', data);
      }
      const keys = BufferClass.from(data.ticketKeys, 'hex');
      this.setTicketKeys(keys);
      return this;
    };

    Server.prototype.getTicketKeys = function getTicketKeys() {
      return httpsBufferCopy(this._ticketKeys, BufferClass);
    };

    Server.prototype.setTicketKeys = function setTicketKeys(keys) {
      validateHttpsTicketKeys(keys, BufferClass);
      this._ticketKeys = httpsBufferCopy(keys, BufferClass);
      this._ticketKeyGeneration += 1;
    };

    Server.prototype.setOptions = function setOptions(options) {
      validateHttpsOptions(options);
      this.requestCert = options.requestCert === true;
      this.rejectUnauthorized = options.rejectUnauthorized !== false;
      return this.setSecureContext(options);
    };

    Server.prototype.addContext = function addContext(servername, context) {
      if (typeof servername !== 'string' || servername.length === 0) {
        const error = invalidArgumentType('servername', 'string', servername);
        error.code = 'ERR_TLS_REQUIRED_SERVER_NAME';
        throw error;
      }
      if (context === null || typeof context !== 'object') {
        throw invalidArgumentType('context', 'an object', context);
      }
      this._contexts.push({
        servername: servername.toLowerCase(),
        options: context.options || { ...context },
      });
      return this;
    };

    Server.prototype._selectSecureContext = function _selectSecureContext(servername) {
      const host = String(servername || '').toLowerCase();
      for (let index = this._contexts.length - 1; index >= 0; index -= 1) {
        const context = this._contexts[index];
        if (context.servername === host) return context.options;
        if (context.servername.startsWith('*.')
          && host.endsWith(context.servername.slice(1))
          && host.split('.').length === context.servername.split('.').length) {
          return context.options;
        }
      }
      const callback = this.options?.SNICallback;
      if (typeof callback === 'function' && host) {
        let selected;
        callback(host, (error, context) => {
          if (!error && context) selected = context.options || context;
        });
        if (selected) return selected;
      }
      return undefined;
    };
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
  defineAsyncDisposeAlias(Server.prototype, Server.prototype[SymbolAsyncDispose]);
  return CallableServer;
}

function connectionListener(socket) {
  if (socket && typeof socket === 'object') socket.server = this;
}

class BrowserAgent extends EventEmitter {
  constructor(options = {}, protocol = DEFAULT_HTTP_PROTOCOL, connectionFactory) {
    super();
    validateProxyEnvironment(options.proxyEnv);
    this.options = { ...options };
    this.protocol = options.protocol || protocol;
    this.defaultPort = Number(options.defaultPort || (this.protocol === DEFAULT_HTTPS_PROTOCOL ? 443 : 80));
    this.keepAlive = Boolean(options.keepAlive);
    this.maxSockets = options.maxSockets || this.constructor.defaultMaxSockets;
    this.maxFreeSockets = options.maxFreeSockets ?? 256;
    this.maxTotalSockets = options.maxTotalSockets ?? Infinity;
    this.scheduling = options.scheduling || 'lifo';
    this.keepAliveMsecs = options.keepAliveMsecs || 1000;
    this.agentKeepAliveTimeoutBuffer = typeof options.agentKeepAliveTimeoutBuffer === 'number'
      && options.agentKeepAliveTimeoutBuffer >= 0
      && Number.isFinite(options.agentKeepAliveTimeoutBuffer)
      ? options.agentKeepAliveTimeoutBuffer
      : 1000;
    this.requests = Object.create(null);
    this.sockets = Object.create(null);
    this.freeSockets = Object.create(null);
    this.totalSocketCount = 0;
    // The global agent object is shared by virtual child processes, but Node's
    // tunnel reuse is process-local. Keep tunnel state keyed by the owning
    // virtual process so a later child cannot skip its CONNECT handshake.
    this._proxyTunnels = new WeakMap();
    this._connectionFactory = connectionFactory;
  }

  getName(options = {}) {
    let name = options.host || 'localhost';
    name += ':';
    if (options.port) name += options.port;
    name += ':';
    if (options.localAddress) name += options.localAddress;
    if (options.family === 4 || options.family === 6) name += `:${options.family}`;
    if (options.socketPath) name += `:${options.socketPath}`;
    return name;
  }

  addRequest(request, options, port, localAddress) {
    if (typeof options === 'string') options = { host: options, port, localAddress };
    options = { ...options, ...this.options };
    if (options.socketPath) options.path = options.socketPath;

    const name = this.getName(options);
    this.sockets[name] ||= [];
    const freeSockets = this.freeSockets[name];
    let socket;
    if (freeSockets) {
      while (freeSockets.length && freeSockets[0].destroyed) freeSockets.shift();
      socket = this.scheduling === 'fifo' ? freeSockets.shift() : freeSockets.pop();
      if (!freeSockets.length) delete this.freeSockets[name];
    }

    if (socket) {
      this.reuseSocket(socket, request);
      request.onSocket?.(socket);
      this.sockets[name].push(socket);
      return request;
    }

    const createSocket = this.createSocket;
    if (createSocket !== BrowserAgent.prototype.createSocket) {
      if (this.sockets[name].length >= this.maxSockets
        || this.totalSocketCount >= this.maxTotalSockets) {
        (this.requests[name] ||= []).push(request);
        request._agentRequestOptions = options;
        request.once?.('close', () => {
          const pending = this.requests[name];
          if (!pending) return;
          const index = pending.indexOf(request);
          if (index >= 0) pending.splice(index, 1);
          if (!pending.length) delete this.requests[name];
        });
        return request;
      }

      request._agentSocketAttempted = true;
      let socketAssigned = false;
      const onSocket = (error, socket) => {
        if (socketAssigned) return;
        socketAssigned = true;
        if (request.destroyed) return;
        if (error) {
          request.destroy(error);
          return;
        }
        if (!socket) {
          request.destroy(new TypeError('Agent.createSocket() must return a socket'));
          return;
        }
        request.socket = socket;
        request.connection = socket;
        request.onSocket?.(socket);
      };
      try {
        const socket = createSocket.call(this, request, options, onSocket);
        if (socket) onSocket(null, socket);
      } catch (error) {
        request.destroy(error);
      }
    }
    return request;
  }

  keepSocketAlive(socket) {
    socket.setKeepAlive?.(true, this.keepAliveMsecs);
    socket.unref?.();

    let agentTimeout = this.options.timeout || 0;
    let canKeepSocketAlive = true;
    const keepAliveHint = socket._httpMessage?.res?.headers?.['keep-alive'];
    if (keepAliveHint) {
      const hint = /^timeout=(\d+)/.exec(keepAliveHint)?.[1];
      if (hint) {
        let serverHintTimeout = Number.parseInt(hint, 10) * 1000 - this.agentKeepAliveTimeoutBuffer;
        serverHintTimeout = serverHintTimeout > 0 ? serverHintTimeout : 0;
        if (serverHintTimeout === 0) {
          canKeepSocketAlive = false;
        } else if (serverHintTimeout < agentTimeout) {
          agentTimeout = serverHintTimeout;
        }
      }
    }

    if (socket.timeout !== agentTimeout) socket.setTimeout?.(agentTimeout);
    return canKeepSocketAlive;
  }
  createConnection(...args) {
    if (typeof this._connectionFactory !== 'function') return undefined;
    return this._connectionFactory(...args);
  }

  createSocket(request, options, callback) {
    options = { ...options, ...this.options };
    if (options.socketPath) options.path = options.socketPath;

    const name = this.getName(options);
    let created = false;
    const onCreate = (error, socket) => {
      if (created) return;
      created = true;
      if (error) {
        callback?.(error);
        return;
      }
      this.sockets[name] ||= [];
      this.sockets[name].push(socket);
      this.totalSocketCount += 1;
      socket.once?.('close', () => {
        this.totalSocketCount = Math.max(0, this.totalSocketCount - 1);
        this.removeSocket(socket, options);
      });
      callback?.(null, socket);
    };

    const socket = this.createConnection(options, onCreate);
    if (socket) onCreate(null, socket);
  }

  reuseSocket(socket, request) {
    request.reusedSocket = true;
    socket.ref?.();
  }

  removeSocket(socket, options = {}) {
    const name = this.getName(options);
    const collections = [this.sockets];
    if (!socket.writable) collections.push(this.freeSockets);
    for (const collection of collections) {
      const sockets = collection[name];
      if (!sockets) continue;
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
      if (!sockets.length) delete collection[name];
    }

    const pending = this.requests[name]?.[0];
    if (pending && this.createSocket !== BrowserAgent.prototype.createSocket) {
      this.requests[name].shift();
      const pendingOptions = pending._agentRequestOptions || options;
      delete pending._agentRequestOptions;
      this.createSocket(pending, pendingOptions, (error, replacement) => {
        if (error) pending.onSocket?.(null, error);
        else pending.onSocket?.(replacement);
      });
    }
  }

  destroy() {
    for (const collection of [this.freeSockets, this.sockets]) {
      for (const sockets of Object.values(collection)) {
        for (const socket of sockets) socket.destroy?.();
      }
    }
    this._proxyTunnels = new WeakMap();
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
  constructor(response = {}, owner, scope = globalThis, BufferClass = scope.Buffer) {
    super({ preserveStrings: true });
    this._readableState.readingMore = true;
    response ||= {};
    const { rawHeaders } = responseHeaders(response.headers);
    this.statusCode = Number(response.status ?? 0);
    this.statusMessage = response.statusText || STATUS_CODES[this.statusCode] || '';
    this.rawHeaders = rawHeaders;
    this._headersCount = rawHeaders.length;
    this._headers = null;
    this._headersDistinct = null;
    this.rawTrailers = [];
    this._trailersCount = 0;
    this._trailers = null;
    this._trailersDistinct = null;
    this.joinDuplicateHeaders = false;
    this.httpVersion = '1.1';
    this.url = response.url || '';
    this.complete = false;
    this.aborted = false;
    this.readableComplete = false;
    this._owner = owner;
    this._scope = scope;
    this._BufferClass = BufferClass;
    this._response = response;
    this.socket = response.socket || owner?.socket || null;
    this.connection = this.socket;
    this._bodyReader = null;
    this._closed = false;
    this._consuming = false;
    this._dumped = false;
    this._resource = owner?._resource || new AsyncResource('HTTPCLIENTREQUEST', {
      triggerAsyncId: this.socket?._tcpResource?.asyncId(),
    });
    this._ownsResource = !owner?._resource;
    this._decoder = null;
    this.body = this;
    this._timeoutHandle = null;
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
    this.clearTimeout();
    if (error) this.aborted = true;
    if (this._bodyReader && typeof this._bodyReader.cancel === 'function') {
      Promise.resolve(this._bodyReader.cancel(error)).catch(() => {});
    }
    return super.destroy(error);
  }

  setTimeout(milliseconds, callback) {
    if (typeof callback !== 'function' && callback !== undefined) {
      throw new TypeError('timeout callback must be a function');
    }
    const delay = validateTimeout(milliseconds);
    this.clearTimeout();
    if (delay === 0 || this.destroyed) return this;
    const setTimer = this._owner?._ownerProcess?._bnhSetTimer || this._scope.setTimeout;
    this._timeoutHandle = setTimer(() => {
      this._timeoutHandle = null;
      if (this.destroyed) return;
      this.emit('timeout');
      callback?.call(this);
    }, delay);
    return this;
  }

  clearTimeout() {
    if (this._timeoutHandle !== null) {
      const clearTimer = this._owner?._ownerProcess?._bnhClearTimer || this._scope.clearTimeout;
      clearTimer?.(this._timeoutHandle);
      this._timeoutHandle = null;
    }
    return this;
  }

  _closeAfterEnd() {
    if (this._closed) return;
    this._closed = true;
    schedule(this._scope, () => this._emitClose());
  }

  _runInAsyncScope(callback) {
    return this._resource?.runInAsyncScope
      ? this._resource.runInAsyncScope(callback, this)
      : callback.call(this);
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    try {
      this._runInAsyncScope(() => this.emit('close'));
    } finally {
      if (this._ownsResource) this._resource?.emitDestroy?.();
    }
  }

  async start() {
    const body = this._response.body;
    try {
      if (body && typeof body.getReader === 'function') {
        this._bodyReader = body.getReader();
        while (!this.destroyed) {
          const item = await this._bodyReader.read();
          if (item.done) break;
          this._owner?._recordNetworkLifecycle?.('client-body-chunk', {
            bodyBytes: Number(item.value?.byteLength || 0),
          });
          this._runInAsyncScope(() => this.push(
            nodeChunk(toBytes(item.value, this._scope), this._scope, this._BufferClass),
          ));
        }
      } else if (body && body[Symbol.asyncIterator]) {
        for await (const chunk of body) {
          if (this.destroyed) break;
          this._owner?._recordNetworkLifecycle?.('client-body-chunk', {
            bodyBytes: Number(chunk?.byteLength || 0),
          });
          this._runInAsyncScope(() => this.push(
            nodeChunk(toBytes(chunk, this._scope), this._scope, this._BufferClass),
          ));
        }
      } else if (body && body[Symbol.iterator] && typeof body !== 'string') {
        for (const chunk of body) {
          if (this.destroyed) break;
          this._owner?._recordNetworkLifecycle?.('client-body-chunk', {
            bodyBytes: Number(chunk?.byteLength || 0),
          });
          this._runInAsyncScope(() => this.push(
            nodeChunk(toBytes(chunk, this._scope), this._scope, this._BufferClass),
          ));
        }
      } else if (typeof this._response.arrayBuffer === 'function') {
        const bytes = new Uint8Array(await this._response.arrayBuffer());
        if (!this.destroyed && bytes.byteLength) {
          this._runInAsyncScope(() => this.push(nodeChunk(bytes, this._scope, this._BufferClass)));
        }
      }
      if (this.destroyed) return;
      this.complete = true;
      this.readableComplete = true;
      this.clearTimeout();
      this._owner?._recordNetworkLifecycle?.('client-body-end', {
        destroyed: Boolean(this.destroyed),
      });
      this._runInAsyncScope(() => this._owner?._responseComplete());
      this._closeAfterEnd();
      this._runInAsyncScope(() => this.push(null));
    } catch (error) {
      if (this.destroyed) return;
      this.aborted = true;
      this._owner?._recordNetworkLifecycle?.('client-body-error', {
        error: { name: String(error?.name || 'Error'), code: error?.code || null },
      });
      super.destroy(error);
      this._owner?._responseFailed(error);
    } finally {
      this._bodyReader = null;
    }
  }
}

const incomingMessageAsyncDispose = async function() {
  let error;
  if (!this.destroyed) {
    error = this.readableEnded ? null : abortError(this._scope);
    this.destroy(error);
  }
  if (this._closeEmitted || this.closed) return;
  await new Promise((resolve, reject) => {
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (cause) => {
      if (cause !== error) {
        cleanup();
        reject(cause);
      }
    };
    const cleanup = () => {
      this.off?.('close', onClose);
      this.off?.('error', onError);
    };
    this.once('close', onClose);
    this.on('error', onError);
  });
};

Object.defineProperty(IncomingMessage.prototype, SymbolAsyncDispose, {
  configurable: true,
  value: incomingMessageAsyncDispose,
});
defineAsyncDisposeAlias(IncomingMessage.prototype, incomingMessageAsyncDispose);

IncomingMessage.prototype._read = function _read(n) {
  if (!this._consuming) {
    this._readableState.readingMore = false;
    this._consuming = true;
  }
  if (this.socket?.readable) this.socket.resume?.();
};

function incomingMessageError(self, error, callback) {
  const hasUserErrorListener = self.listeners('error').some((listener) => !listener._bnhInternal);
  if (!hasUserErrorListener) callback();
  else callback(error);
}

IncomingMessage.prototype._destroy = function _destroy(error, callback) {
  if (!this.readableEnded || !this.complete) {
    this.aborted = true;
    this.emit('aborted');
  }

  const socket = this.socket;
  const finish = (socketError) => {
    const finalError = socketError?.code === 'ERR_STREAM_PREMATURE_CLOSE'
      ? error
      : (socketError || error);
    schedule(this._scope, () => incomingMessageError(this, finalError, callback));
  };

  if (socket && !socket.destroyed && this.aborted && typeof socket.destroy === 'function') {
    let settled = false;
    const cleanup = () => {
      socket.off?.('error', onSocketError);
      socket.off?.('close', onSocketClose);
      socket.off?.('finish', onSocketClose);
      socket.off?.('end', onSocketClose);
    };
    const done = (socketError) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish(socketError);
    };
    const onSocketError = (socketError) => done(socketError);
    const onSocketClose = () => done();
    if (typeof socket.once === 'function') {
      socket.once('error', onSocketError);
      socket.once('close', onSocketClose);
      socket.once('finish', onSocketClose);
      socket.once('end', onSocketClose);
    }
    try {
      socket.destroy(error);
    } catch (destroyError) {
      done(destroyError);
    }
    if (typeof socket.once !== 'function') done();
  } else {
    schedule(this._scope, () => incomingMessageError(this, error, callback));
  }
};

function _addHeaderLines(headers, n) {
  if (headers?.length) {
    let destination;
    if (this.complete) {
      this.rawTrailers = headers;
      this._trailersCount = n;
      destination = this._trailers;
    } else {
      this.rawHeaders = headers;
      this._headersCount = n;
      destination = this._headers;
    }

    if (destination) {
      for (let index = 0; index < n; index += 2) {
        this._addHeaderLine(headers[index], headers[index + 1], destination);
      }
    }
  }
}

IncomingMessage.prototype._addHeaderLines = _addHeaderLines;

// Avoid lowercasing common header names twice while retaining the flags used
// by Node's incoming-header aggregation rules.
function matchKnownFields(field, lowercased) {
  switch (field.length) {
    case 3:
      if (field === 'Age' || field === 'age') return 'age';
      break;
    case 4:
      if (field === 'Host' || field === 'host') return 'host';
      if (field === 'From' || field === 'from') return 'from';
      if (field === 'ETag' || field === 'etag') return 'etag';
      if (field === 'Date' || field === 'date') return '\u0000date';
      if (field === 'Vary' || field === 'vary') return '\u0000vary';
      break;
    case 6:
      if (field === 'Server' || field === 'server') return 'server';
      if (field === 'Cookie' || field === 'cookie') return '\u0002cookie';
      if (field === 'Origin' || field === 'origin') return '\u0000origin';
      if (field === 'Expect' || field === 'expect') return '\u0000expect';
      if (field === 'Accept' || field === 'accept') return '\u0000accept';
      break;
    case 7:
      if (field === 'Referer' || field === 'referer') return 'referer';
      if (field === 'Expires' || field === 'expires') return 'expires';
      if (field === 'Upgrade' || field === 'upgrade') return '\u0000upgrade';
      break;
    case 8:
      if (field === 'Location' || field === 'location') return 'location';
      if (field === 'If-Match' || field === 'if-match') return '\u0000if-match';
      break;
    case 10:
      if (field === 'User-Agent' || field === 'user-agent') return 'user-agent';
      if (field === 'Set-Cookie' || field === 'set-cookie') return '\u0001';
      if (field === 'Connection' || field === 'connection') return '\u0000connection';
      break;
    case 11:
      if (field === 'Retry-After' || field === 'retry-after') return 'retry-after';
      break;
    case 12:
      if (field === 'Content-Type' || field === 'content-type') return 'content-type';
      if (field === 'Max-Forwards' || field === 'max-forwards') return 'max-forwards';
      break;
    case 13:
      if (field === 'Authorization' || field === 'authorization') return 'authorization';
      if (field === 'Last-Modified' || field === 'last-modified') return 'last-modified';
      if (field === 'Cache-Control' || field === 'cache-control') return '\u0000cache-control';
      if (field === 'If-None-Match' || field === 'if-none-match') return '\u0000if-none-match';
      break;
    case 14:
      if (field === 'Content-Length' || field === 'content-length') return 'content-length';
      break;
    case 15:
      if (field === 'Accept-Encoding' || field === 'accept-encoding') return '\u0000accept-encoding';
      if (field === 'Accept-Language' || field === 'accept-language') return '\u0000accept-language';
      if (field === 'X-Forwarded-For' || field === 'x-forwarded-for') return '\u0000x-forwarded-for';
      break;
    case 16:
      if (field === 'Content-Encoding' || field === 'content-encoding') return '\u0000content-encoding';
      if (field === 'X-Forwarded-Host' || field === 'x-forwarded-host') return '\u0000x-forwarded-host';
      break;
    case 17:
      if (field === 'If-Modified-Since' || field === 'if-modified-since') return 'if-modified-since';
      if (field === 'Transfer-Encoding' || field === 'transfer-encoding') return '\u0000transfer-encoding';
      if (field === 'X-Forwarded-Proto' || field === 'x-forwarded-proto') return '\u0000x-forwarded-proto';
      break;
    case 19:
      if (field === 'Proxy-Authorization' || field === 'proxy-authorization') return 'proxy-authorization';
      if (field === 'If-Unmodified-Since' || field === 'if-unmodified-since') return 'if-unmodified-since';
      break;
  }
  if (lowercased) return '\u0000' + field;
  return matchKnownFields(field.toLowerCase(), true);
}

IncomingMessage.prototype._addHeaderLine = function _addHeaderLine(field, value, destination) {
  field = matchKnownFields(field);
  const flag = field.charCodeAt(0);
  if (flag === 0 || flag === 2) {
    field = field.slice(1);
    if (typeof destination[field] === 'string') {
      destination[field] += (flag === 0 ? ', ' : '; ') + value;
    } else {
      destination[field] = value;
    }
  } else if (flag === 1) {
    if (destination['set-cookie'] !== undefined) destination['set-cookie'].push(value);
    else destination['set-cookie'] = [value];
  } else if (this.joinDuplicateHeaders) {
    if (destination[field] === undefined) destination[field] = value;
    else destination[field] += ', ' + value;
  } else if (destination[field] === undefined) {
    destination[field] = value;
  }
};

IncomingMessage.prototype._addHeaderLineDistinct = function _addHeaderLineDistinct(field, value, destination) {
  field = field.toLowerCase();
  if (!destination[field]) destination[field] = [value];
  else destination[field].push(value);
};

IncomingMessage.prototype._dump = function _dump() {
  if (!this._dumped) {
    this._dumped = true;
    this.removeAllListeners('data');
    this.resume();
  }
};

Object.defineProperties(IncomingMessage.prototype, {
  connection: {
    get() { return this.socket; },
    set(value) { this.socket = value; },
  },
  headers: {
    get() {
      if (!this._headers) {
        this._headers = {};
        for (let index = 0; index < this._headersCount; index += 2) {
          addIncomingHeaderLine(this, this.rawHeaders[index], this.rawHeaders[index + 1], this._headers);
        }
      }
      return this._headers;
    },
    set(value) { this._headers = value; },
  },
  headersDistinct: {
    get() {
      if (!this._headersDistinct) {
        this._headersDistinct = Object.create(null);
        for (let index = 0; index < this._headersCount; index += 2) {
          this._addHeaderLineDistinct(this.rawHeaders[index], this.rawHeaders[index + 1], this._headersDistinct);
        }
      }
      return this._headersDistinct;
    },
    set(value) { this._headersDistinct = value; },
  },
  trailers: {
    get() {
      if (!this._trailers) {
        this._trailers = {};
        for (let index = 0; index < this._trailersCount; index += 2) {
          addIncomingHeaderLine(this, this.rawTrailers[index], this.rawTrailers[index + 1], this._trailers);
        }
    }
    return this._trailers;
  },
  set(value) { this._trailers = value; },
  },
  trailersDistinct: {
    get() {
      if (!this._trailersDistinct) {
        this._trailersDistinct = {};
        for (let index = 0; index < this._trailersCount; index += 2) {
          this._addHeaderLineDistinct(this.rawTrailers[index], this.rawTrailers[index + 1], this._trailersDistinct);
        }
      }
      return this._trailersDistinct;
    },
    set(value) { this._trailersDistinct = value; },
  },
});

function proxyResponse(result, url, scope) {
  if (result && typeof result.arrayBuffer === 'function' && result.status !== undefined) return result;
  const statusCode = Number(result?.statusCode ?? result?.status ?? 200);
  const headers = result?.headers || {};
  const body = result?.bodyBytes ?? result?.body ?? result?.data ?? result?.text ?? '';
  const bytes = body === undefined || body === null ? new Uint8Array() : toBytes(body, scope);
  return responseFromBytes(url, statusCode, headers, bytes, scope);
}

function proxySupports(proxy, operation) {
  const adapter = proxy?.adapter;
  return typeof adapter === 'function'
    || typeof adapter?.[operation] === 'function'
    || typeof adapter?.handle === 'function';
}

function proxyRequestOptions(url, init) {
  return {
    url,
    method: init.method,
    headers: headersObject(createHeaderStore(init.headers)),
    body: init.body,
    signal: init.signal,
    timeout: init.timeout,
  };
}

function createRequestClass(scope, BufferClass, virtualNetwork, proxy, proxyEnv, diagnostics, ownerProcess, trackTask, performanceRecord) {
  const ClientRequest = class ClientRequest extends EventEmitter {
    constructor(url, options = {}) {
      super();
      initializeOutgoingMessageState(this);
      if (url && typeof url === 'object' && !isURL(url, scope)) {
        options = url;
        url = undefined;
      }
      options ||= {};
      if (options.insecureHTTPParser !== undefined && typeof options.insecureHTTPParser !== 'boolean') {
        throw invalidArgumentType('options.insecureHTTPParser', 'boolean', options.insecureHTTPParser, true);
      }
      validateRequestPath(options.path);
      this.method = normalizeMethod(options.method);
      this.path = url;
      this.host = options.hostname || options.host || '';
      this.protocol = options.protocol;
      this.agent = options.agent;
      this.socket = null;
      this.connection = null;
      this.reusedSocket = false;
      this.aborted = false;
      this.destroyed = false;
      this.finished = false;
      this.writableEnded = false;
      this.timeout = 0;
      this.response = null;
      this._url = url;
      this._options = options;
      this._agent = options.agent;
      this._httpsAgent = this._agent?.protocol === DEFAULT_HTTPS_PROTOCOL
        && typeof this._agent._getSession === 'function'
        ? this._agent
        : null;
      this._httpsSessionKey = this._httpsAgent?.getName?.(options);
      this._httpsSession = this._httpsAgent && this._httpsSessionKey !== undefined
        ? this._httpsAgent._getSession(this._httpsSessionKey)
        : undefined;
      this._httpsSessionCacheable = Boolean(
        this._httpsAgent
        && this._options.checkServerIdentity === undefined,
      );
      this._socketEventEmitted = false;
      this.timeout = Number(options.timeout ?? this._agent?.options?.timeout ?? 0) || 0;
      this._virtualNetwork = virtualNetwork;
      this._proxy = proxy;
      this._resource = null;
      this._clientTcpResource = null;
      this._clientTcpConnectResource = null;
      this._taskRelease = null;
      // The compatibility module is constructed once, but requests can be
      // created after the shared realm has restored its parent process. Use
      // the explicit module owner for virtual-child callbacks and its console
      // facade for response metadata.
      this._ownerProcess = ownerProcess || scope.process;
      // Do not merge the host page/Node environment here. A virtual process
      // must honor its own NO_PROXY and proxy URLs, even when the embedding
      // process has a different proxy policy (for example, localhost in the
      // host's NO_PROXY list).
      this._proxyEnv = { ...proxyEnv };
      this._ownerConsole = this._ownerProcess?._bnhConsole || scope.console;
      this.parser = {
        consume: (stream) => {
          if (stream === null || (typeof stream !== 'object' && typeof stream !== 'function')) {
            const processObject = this._ownerProcess || scope.process;
            if (typeof processObject?._bnhAbort === 'function') {
              processObject._bnhAbort('SIGABRT', 'HTTP parser consume failed\n');
              if (processObject._bnhVirtualChild) {
                processObject.emit?.('exit', null, processObject.getSignal?.() || 'SIGABRT');
              }
              throw new Error('HTTP parser consume failed');
            }
            if (typeof processObject?.abort === 'function') {
              processObject.abort();
              throw new Error('HTTP parser consume failed');
            }
          }
        },
      };
      Object.defineProperty(this, '_headers', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: createHeaderStore(options.headers),
      });
      this._duplicateContentLength = headerEntries(options.headers).some(([name, value]) =>
        String(name).toLowerCase() === 'content-length' && Array.isArray(value) && value.length > 1);
      this._chunks = [];
      this._started = false;
      this._headersOnlyDispatch = false;
      this._closed = false;
      this._abortEmitted = false;
      this._errorEmitted = false;
      this._timeoutHandle = null;
      this._timeoutCallback = undefined;
      this._signalCleanup = null;
      this._controller = typeof scope.AbortController === 'function' ? new scope.AbortController() : null;
      this._externalSignal = options.signal;
      this._rawResponseBuffer = new Uint8Array();
      this._rawResponseDone = false;
      this._rawResponseHeadersParsed = false;
      this._rawResponseBody = null;

      publishDiagnostic(diagnostics, 'http.client.request.created', { request: this });

      if (options.auth && !this._headers.has('authorization')) {
        const authorization = basicAuthorization(options.auth, scope);
        if (authorization) this._headers.set('authorization', authorization);
      }
      this._bindAbortSignal();
      if (options.timeout !== undefined) this.setTimeout(options.timeout);
    }

    _recordNetworkLifecycle(phase, fields = {}) {
      try {
        this._ownerProcess?.__bnhNetworkEvent?.({
          source: 'guest-http',
          method: String(this.method || 'GET'),
          url: String(this._url || this.path || ''),
          phase,
          transport: 'virtual-network',
          ...fields,
        });
      } catch {
        // Telemetry is observational and must not affect HTTP delivery.
      }
    }

    _runInAsyncScope(callback) {
      return this._resource?.runInAsyncScope
        ? this._resource.runInAsyncScope(callback, this)
        : callback.call(this);
    }

    _finish() {
      OutgoingMessage.prototype._finish.call(this);
    }

    _implicitHeader() {
      if (this._header) {
        const error = new Error('Cannot render headers after they are sent');
        error.code = 'ERR_HTTP_HEADERS_SENT';
        throw error;
      }
      this._header = `${this.method} ${this.path} HTTP/1.1\r\n`;
    }

    onSocket(socket, error = undefined) {
      if (socket && !error) {
        socket._httpMessage = this;
        socket.on?.('error', (socketError) => this.destroy(socketError));
        socket.on?.('data', (chunk) => {
          this._recordNetworkLifecycle('client-raw-data', {
            bodyBytes: Number(chunk?.byteLength || 0),
          });
          this._handleRawResponseData(chunk);
        });
        socket.on?.('close', () => {
          if (this._rawResponseBody && !this._rawResponseDone) {
            this._rawResponseDone = true;
            this._recordNetworkLifecycle('client-raw-body-end', { reason: 'socket-close' });
            this._rawResponseBody.close();
          }
          // A peer can close before HTTP response headers exist (for
          // example, when ServerResponse.destroy() races a pending drain).
          // Node reports that terminal condition as a client request error;
          // silently closing here leaves callers awaiting a response forever.
          if (!this.response && !this.destroyed) this.destroy(socketHangUpError());
        });
      }
      schedule(scope, () => {
        if (this.destroyed || error) {
          if (error && !this.destroyed) this.destroy(error);
          return;
        }
        this.socket = socket;
        this.connection = socket;
        this._socketEventEmitted = true;
        this.emit('socket', socket);
        this._flush?.();
      });
    }

    _handleRawResponseData(chunk) {
      if (this.destroyed || this._rawResponseDone) return;
      try {
        this._rawResponseBuffer = appendBytes(this._rawResponseBuffer, toBytes(chunk, scope));
        if (this._rawResponseHeadersParsed) {
          this._consumeRawResponseBody();
          return;
        }
        const separator = '\r\n\r\n';
        const decoder = scope.TextDecoder || TextDecoder;
        const headerText = new decoder().decode(this._rawResponseBuffer);
        const headerEnd = headerText.indexOf(separator);
        if (headerEnd < 0) return;
        const headerLines = headerText.slice(0, headerEnd).split('\r\n');
        const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})(?:\s+([^\r\n]*))?$/.exec(headerLines.shift() || '');
        if (!statusMatch) throw new Error('invalid HTTP response');
        const headers = {};
        for (const line of headerLines) {
          const separatorIndex = line.indexOf(':');
          if (separatorIndex < 0) continue;
          const name = line.slice(0, separatorIndex).trim().toLowerCase();
          const value = line.slice(separatorIndex + 1).trim();
          if (name === 'set-cookie') {
            if (headers[name] === undefined) headers[name] = [value];
            else if (Array.isArray(headers[name])) headers[name].push(value);
            else headers[name] = [headers[name], value];
          } else {
            headers[name] = value;
          }
        }
        const bodyStart = headerEnd + separator.length;
        const transferEncoding = String(headers['transfer-encoding'] || '').toLowerCase();
        const isChunked = transferEncoding.split(',').some((value) => value.trim() === 'chunked');
        const hasContentLength = Object.hasOwn(headers, 'content-length');
        const contentLength = hasContentLength ? Number(headers['content-length']) : 0;
        if (!isChunked && !hasContentLength) {
          this._rawResponseBuffer = this._rawResponseBuffer.slice(bodyStart);
          this._rawResponseHeadersParsed = true;
          this._rawResponseBody = createDeferredBody();
          this._handleResponse(responseFromBytes(
            this._url,
            Number(statusMatch[1]),
            headers,
            new Uint8Array(),
            scope,
            this.socket,
            this._rawResponseBody,
          ));
          this._recordNetworkLifecycle('client-response-headers', {
            status: Number(statusMatch[1]),
            streaming: true,
          });
          this._consumeRawResponseBody();
          return;
        }
        if (isChunked) {
          this._rawResponseBuffer = this._rawResponseBuffer.slice(bodyStart);
          this._rawResponseHeadersParsed = true;
          this._rawResponseBody = createDeferredBody();
          this._handleResponse(responseFromBytes(
            this._url,
            Number(statusMatch[1]),
            headers,
            new Uint8Array(),
            scope,
            this.socket,
            this._rawResponseBody,
          ));
          this._recordNetworkLifecycle('client-response-headers', {
            status: Number(statusMatch[1]),
            streaming: true,
            chunked: true,
          });
          this._consumeRawResponseBody();
          return;
        }
        if (!Number.isInteger(contentLength) || contentLength < 0
          || this._rawResponseBuffer.byteLength < bodyStart + contentLength) return;
        const body = this._rawResponseBuffer.slice(bodyStart, bodyStart + contentLength);
        this._rawResponseDone = true;
        this._handleResponse(responseFromBytes(
          this._url,
          Number(statusMatch[1]),
          headers,
          body,
          scope,
          this.socket,
        ));
        this.response?.once?.('end', () => this.socket?.destroy?.());
      } catch (error) {
        this.destroy(error);
      }
    }

    _consumeRawResponseBody() {
      if (!this._rawResponseBody) return;
      const transferEncoding = String(this.response?._response?.headers?.['transfer-encoding'] || '').toLowerCase();
      const isChunked = transferEncoding.split(',').some((value) => value.trim() === 'chunked');
      if (!isChunked) {
        if (this._rawResponseBuffer.byteLength) {
          this._rawResponseBody.enqueue(this._rawResponseBuffer);
          this._rawResponseBuffer = new Uint8Array();
        }
        return;
      }
      const decoder = scope.TextDecoder || TextDecoder;
      while (this._rawResponseBuffer.byteLength) {
        const text = new decoder().decode(this._rawResponseBuffer);
        const lineEnd = text.indexOf('\r\n');
        if (lineEnd < 0) return;
        const sizeText = text.slice(0, lineEnd).split(';', 1)[0].trim();
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size) || size < 0) throw new Error('invalid chunked HTTP response');
        const dataStart = lineEnd + 2;
        if (size === 0) {
          if (this._rawResponseBuffer.byteLength < dataStart + 2) return;
          this._rawResponseBuffer = this._rawResponseBuffer.slice(dataStart + 2);
          this._rawResponseDone = true;
          this._recordNetworkLifecycle('client-raw-body-end', { reason: 'chunked-end' });
          this._rawResponseBody.close();
          return;
        }
        if (this._rawResponseBuffer.byteLength < dataStart + size + 2) return;
        const body = this._rawResponseBuffer.slice(dataStart, dataStart + size);
        const trailerEnd = dataStart + size;
        if (this._rawResponseBuffer[trailerEnd] !== 13 || this._rawResponseBuffer[trailerEnd + 1] !== 10) {
          throw new Error('invalid chunked HTTP response terminator');
        }
        this._rawResponseBuffer = this._rawResponseBuffer.slice(trailerEnd + 2);
        this._recordNetworkLifecycle('client-raw-body-chunk', { bodyBytes: body.byteLength, chunked: true });
        this._rawResponseBody.enqueue(body);
      }
    }

    _flush() {
      const socket = this.socket;
      if (!socket?.writable || this._rawRequestSent || !this.finished) return;
      this._rawRequestSent = true;
      const parsed = new scope.URL(this._url);
      const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
      const body = concatenate(this._chunks);
      const headers = new Map(this._headers);
      if (!headers.has('host')) headers.set('host', parsed.host);
      if (!headers.has('connection')) headers.set('connection', 'close');
      if (body.byteLength && !headers.has('content-length') && !headers.has('transfer-encoding')) {
        headers.set('content-length', String(body.byteLength));
      }
      const headerText = `${this.method} ${path} HTTP/1.1\r\n`
        + [...headers].map(([name, value]) => `${name}: ${value}\r\n`).join('')
        + '\r\n';
      const headerBytes = new (scope.TextEncoder || TextEncoder)().encode(headerText);
      socket.write(appendBytes(headerBytes, body));
    }

    _deferToConnect(method, arguments_) {
      const callSocketMethod = () => {
        if (method) Reflect.apply(this.socket[method], this.socket, arguments_);
      };
      const onSocket = () => {
        if (this.socket.writable) callSocketMethod();
        else this.socket.once('connect', callSocketMethod);
      };
      if (!this.socket) this.once('socket', onSocket);
      else onSocket();
    }

    _ensureAsyncResources(requestURL = this._url) {
      if (this._resource) return;
      // Client resources inherit the context that created the request. The
      // server's TCP resource is a separate boundary and using it as the
      // trigger here loses AsyncLocalStorage state for client callbacks.
      this._clientTcpResource = new AsyncResource('TCPWRAP');
      this._clientTcpConnectResource = new AsyncResource('TCPCONNECTWRAP', {
        triggerAsyncId: this._clientTcpResource.asyncId(),
      });
      this._resource = new AsyncResource('HTTPCLIENTREQUEST');
    }

    _runInOwnerContext(callback) {
      const previousProcess = scope.process;
      const previousConsole = scope.console;
      if (this._ownerProcess) scope.process = this._ownerProcess;
      if (this._ownerConsole) scope.console = this._ownerConsole;
      try {
        return callback();
      } catch (error) {
        if (this._ownerProcess?._bnhIsExited?.()) return undefined;
        throw error;
      } finally {
        scope.process = previousProcess;
        scope.console = previousConsole;
      }
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
        (this._ownerProcess?._bnhClearTimer || scope.clearTimeout)?.(this._timeoutHandle);
        this._timeoutHandle = null;
      }
    }

    setTimeout(milliseconds, callback) {
      if (typeof callback !== 'function' && callback !== undefined) throw new TypeError('timeout callback must be a function');
      const delay = validateTimeout(milliseconds);
      this._clearTimeout();
      this.timeout = delay;
      this._timeoutCallback = callback;
      if (delay === 0 || !this._started) return this;
      this._armTimeout();
      return this;
    }

    _armTimeout() {
      if (this._timeoutHandle !== null || this.timeout === 0 || this.destroyed) return;
      const delay = this.timeout;
      const setTimer = this._ownerProcess?._bnhSetTimer || scope.setTimeout;
      this._timeoutHandle = setTimer(() => {
        this._timeoutHandle = null;
        if (this.destroyed) return;
        this.emit('timeout');
        this._timeoutCallback?.call(this);
        if (!this.destroyed && this._options.abortOnTimeout !== false) this.destroy(timeoutError(scope, delay));
      }, delay);
    }

    clearTimeout() {
      this._clearTimeout();
      this.timeout = 0;
      this._timeoutCallback = undefined;
      return this;
    }

    setHeader(name, value) {
      if (this._started) throw new Error('Cannot set headers after they are sent');
      validateHeaderName(name);
      validateHeaderValue(name, value);
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
      if (this._started || this.destroyed) return this;
      this._headersOnlyDispatch = true;
      schedule(scope, () => this._runInAsyncScope(() => this._dispatch()));
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
        schedule(scope, () => this._runInAsyncScope(() => {
          this.emit('error', error);
          callback?.(error);
        }));
        return false;
      }
      try {
        this._chunks.push(toBytes(chunk, scope, encoding));
      } catch (error) {
        schedule(scope, () => this._runInAsyncScope(() => {
          this.emit('error', error);
          callback?.(error);
        }));
        return false;
      }
      if (!this._started) schedule(scope, () => this._runInAsyncScope(() => this._dispatch()));
      if (callback) schedule(scope, () => this._runInAsyncScope(() => callback()));
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
      if (this._started) {
        this.finished = true;
        this.writableEnded = true;
        setOutgoingMessageFinished(this);
        this._runInAsyncScope(() => {
          this.emit('finish');
          callback?.();
        });
        return this;
      }
      this.finished = true;
      this.writableEnded = true;
      this._endCallback = callback;
      schedule(scope, () => this._runInAsyncScope(() => this._dispatch()));
      return this;
    }

    abort() {
      if (this.destroyed) return this;
      this._abort(abortError(scope), false, true);
      return this;
    }

    destroy(error = undefined) {
      if (this.destroyed) return this;
      // Node reports an abort before response headers as ECONNRESET even when
      // ClientRequest.destroy() is called without an explicit error. Without
      // this terminal error, callers waiting for the request's error event
      // can remain pending forever after a client-side cancellation.
      if (!error && !this.response) error = socketHangUpError();
      this.destroyed = true;
      setOutgoingMessageErrored(this, error);
      this.aborted ||= !this.response;
      this._clearTimeout();
      this._signalCleanup?.();
      this._signalCleanup = null;
      try { this._controller?.abort(error); } catch { this._controller?.abort(); }
      if (error) {
        publishDiagnostic(diagnostics, 'http.client.request.error', { request: this, error });
        this._emitError(error);
      }
      if (this.response && !this.response.destroyed) this.response.destroy(error);
      // A virtual child can keep the proxy's synthetic socket task alive after
      // the request itself times out or is destroyed. Releasing that process-
      // local task set lets the child finish exactly as a real process would.
      if (!this.response) this._ownerProcess?._bnhReleaseTasks?.();
      this._emitClose();
      return this;
    }

    _abort(error, emitError, emitAbort) {
      if (this.destroyed) return;
      this.aborted = true;
      if (emitAbort && !this._abortEmitted) {
        this._abortEmitted = true;
        schedule(scope, () => this._runInAsyncScope(() => this.emit('abort')));
      }
      this.destroy(emitError ? error : undefined);
    }

    _emitError(error) {
      if (this._errorEmitted) return;
      this._errorEmitted = true;
      schedule(scope, () => this._runInAsyncScope(() => this._runInOwnerContext(
        () => this.emit('error', error),
      )));
    }

    _emitClose() {
      if (this._closed) return;
      this._closed = true;
      setOutgoingMessageClosed(this);
      schedule(scope, () => this._runInAsyncScope(() => {
        try {
          this._runInOwnerContext(() => this.emit('close'));
        } finally {
          this._resource?.emitDestroy?.();
          this._clientTcpConnectResource?.emitDestroy?.();
          this._clientTcpResource?.emitDestroy?.();
          this._taskRelease?.();
          this._taskRelease = null;
        }
      }));
    }

    _dispatch() {
      if (this._started || this.destroyed) return;
      if (this._agentSocketAttempted && (this._agentSocket || this.destroyed)) return;
      this._started = true;
      this._performanceStart = Number(scope.performance?.now?.()) || 0;
      this._taskRelease ||= trackTask?.() || null;
      this._ensureAsyncResources();
      publishDiagnostic(diagnostics, 'http.client.request.start', { request: this });
      this._armTimeout();
      if (!this._headersOnlyDispatch && this.finished) {
        setOutgoingMessageFinished(this);
        this._runInOwnerContext(() => {
          this.emit('finish');
          this._endCallback?.();
        });
      }

      // Browser-native virtual internet endpoints do not have a host socket
      // for an explicit https.Agent to connect to. Dispatch the deterministic
      // nodejs.org endpoint directly before the agent opens a raw socket.
      let virtualTarget;
      try { virtualTarget = new scope.URL(this._url); } catch { virtualTarget = null; }
      if (this.protocol === DEFAULT_HTTPS_PROTOCOL
        && (this.host || virtualTarget?.hostname).toLowerCase() === 'nodejs.org'
        && this._virtualNetwork?.dispatch) {
        let virtualInit;
        try {
          virtualInit = this._fetchInit();
        } catch (error) {
          this.destroy(error);
          return;
        }
        const virtualResponse = this._virtualNetwork.dispatch(this._url, virtualInit);
        if (virtualResponse) {
          Promise.resolve(virtualResponse).then(
            (response) => this._runInAsyncScope(() => this._handleResponse(response)),
            (error) => this._handleFetchError(error),
          );
          return;
        }
      }

      let environmentProxyConfig = null;
      if (!this._proxy) {
        try {
          environmentProxyConfig = proxyConfigFor(
            this._url,
            this._options,
            { ...this._proxyEnv, ...this._ownerProcess?.env },
            scope,
          );
        } catch (error) {
          this.destroy(error);
          return;
        }
      }
      const isDataURL = virtualTarget?.protocol === 'data:';
      const customCreateConnection = isDataURL ? null : this._agent?.createConnection;
      const customCreateSocket = this._agent?.createSocket;
      const createConnection = proxySupports(this._proxy, 'request') || environmentProxyConfig
        ? null
        : typeof customCreateSocket === 'function'
          && customCreateSocket !== BrowserAgent.prototype.createSocket
          ? customCreateSocket
          : typeof customCreateConnection === 'function'
            && customCreateConnection !== BrowserAgent.prototype.createConnection
            ? customCreateConnection
            : null;
      if (createConnection) {
        let socket;
        const usesCreateSocket = createConnection === customCreateSocket;
        const connectionCallback = (error, connectedSocket) => {
          if (this.destroyed) return;
          if (error) {
            this.destroy(error);
            return;
          }
          if (!connectedSocket) {
            this.destroy(new TypeError('Agent.createConnection() must return a socket'));
            return;
          }
          this.socket = connectedSocket;
          this.connection = connectedSocket;
          connectedSocket.once?.('error', (socketError) => this.destroy(socketError));
          this.onSocket(connectedSocket);
        };
        try {
          const parsedConnectionURL = typeof scope.URL === 'function' && this._url
            ? new scope.URL(this._url)
            : null;
          // `path` belongs to the HTTP request line. Do not pass it to a
          // TCP agent as a pipe name; only an explicit socketPath requests a
          // pipe connection.
          const { path: _requestPath, pathname: _requestPathname, ...socketOptions } = this._options;
          const connectionOptions = {
            ...socketOptions,
            host: this.host || parsedConnectionURL?.hostname || 'localhost',
            hostname: this.host || parsedConnectionURL?.hostname || 'localhost',
            port: this._options.port || (parsedConnectionURL?.port
              ? Number(parsedConnectionURL.port)
              : this.protocol === DEFAULT_HTTPS_PROTOCOL ? 443 : 80),
          };
          if (this._options.socketPath !== undefined) connectionOptions.path = this._options.socketPath;
          socket = usesCreateSocket
            ? createConnection.call(this._agent, this, connectionOptions, connectionCallback)
            : createConnection.call(this._agent, connectionOptions, connectionCallback);
        } catch (error) {
          this.destroy(error);
          return;
        }
        if (socket) connectionCallback(null, socket);
        if (this._agent instanceof BrowserAgent) return;
      }

      let init;
      try {
        init = this._fetchInit();
      } catch (error) {
        this.destroy(error);
        return;
      }

      let operation;
      try {
        if (this._proxy && proxySupports(this._proxy, 'request')) {
          operation = this._proxy.request(proxyRequestOptions(this._url, {
            ...init,
            timeout: this.timeout,
          }));
        }
        else {
          const runtimeProxyEnv = { ...this._proxyEnv, ...this._ownerProcess?.env };
          const proxyConfig = environmentProxyConfig || proxyConfigFor(
            this._url,
            this._options,
            runtimeProxyEnv,
            scope,
          );
          const requestURL = proxyConfig ? proxyConfig.url.href : this._url;
          const tunnelKey = proxyConfig && `${proxyConfig.url.origin}|${new scope.URL(this._url).host}`;
          this._proxyConfig = proxyConfig ? { ...proxyConfig, tunnelKey } : null;
          const requestInit = proxyConfig
            ? proxyRequestInit(
                this._url,
                init,
                proxyConfig,
                scope,
                Boolean(this._agent?.keepAlive),
                this.protocol !== DEFAULT_HTTPS_PROTOCOL,
              )
            : init;
          const targetIsHttps = this.protocol === DEFAULT_HTTPS_PROTOCOL;
          const ownerTunnels = this._agent?._proxyTunnels?.get(this._ownerProcess);
          const hasTunnel = targetIsHttps && tunnelKey && ownerTunnels?.has(tunnelKey);
          const virtualResponse = proxyConfig && targetIsHttps && !hasTunnel
            ? this._virtualNetwork?.dispatchProxyConnect(
              requestURL,
              this._url,
              requestInit,
              this.timeout,
              this._ownerProcess,
            )
            : proxyConfig && targetIsHttps
              ? this._virtualNetwork?.dispatch(this._url, init)
              : this._virtualNetwork?.dispatch(requestURL, requestInit);
          if (virtualResponse) operation = virtualResponse;
          else {
            if (proxyConfig) {
              const proxyURL = new scope.URL(requestURL);
              operation = Promise.reject(virtualNetworkError(
                'ECONNREFUSED',
                'connect',
                proxyURL.hostname,
                Number(proxyURL.port || (proxyURL.protocol === DEFAULT_HTTPS_PROTOCOL ? 443 : 80)),
              ));
            } else {
              if (typeof scope.fetch !== 'function') throw new TypeError('fetch is unavailable in this browser context');
              const previousHttpFetchMarker = scope.__BNH_HTTP_CLIENT_FETCH__;
              scope.__BNH_HTTP_CLIENT_FETCH__ = true;
              try {
                operation = scope.fetch.call(scope, this._url, init);
              } finally {
                if (previousHttpFetchMarker === undefined) delete scope.__BNH_HTTP_CLIENT_FETCH__;
                else scope.__BNH_HTTP_CLIENT_FETCH__ = previousHttpFetchMarker;
              }
            }
          }
        }
      } catch (error) {
        this.destroy(error);
        return;
      }
      Promise.resolve(operation).then(
        (response) => this._runInAsyncScope(() => {
          if (this._agent && this._proxyConfig && this._proxyConfig.tunnelKey) {
            let tunnels = this._agent._proxyTunnels.get(this._ownerProcess);
            if (!tunnels) {
              tunnels = new Set();
              this._agent._proxyTunnels.set(this._ownerProcess, tunnels);
            }
            tunnels.add(this._proxyConfig.tunnelKey);
          }
          this._handleResponse(this._proxy && !response?.arrayBuffer
            ? proxyResponse(response, this._url, scope)
            : response);
        }),
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
      if (this._duplicateContentLength) init.__bnhDuplicateContentLength = true;
      if (this._controller) init.signal = this._controller.signal;
      else if (this._externalSignal) init.signal = this._externalSignal;
      if (body.byteLength) init.body = body;
      for (const name of ['cache', 'credentials', 'integrity', 'keepalive', 'mode', 'redirect', 'referrer', 'referrerPolicy']) {
        if (this._options[name] !== undefined) init[name] = this._options[name];
      }
      if (this._options.body !== undefined && !body.byteLength) init.body = this._options.body;
      if (this.protocol === DEFAULT_HTTPS_PROTOCOL) init.__bnhHttpsOptions = this._options;
      return init;
    }

    _handleResponse(response) {
      if (this.destroyed) return;
      try {
        this._ownerProcess?.__bnhNetworkEvent?.({
          source: 'guest-http',
          method: String(this.method || 'GET'),
          url: String(this._url || this.path || ''),
          phase: 'response',
          transport: 'virtual-network',
          status: Number(response?.status ?? response?.statusCode ?? 0),
          statusType: typeof (response?.status ?? response?.statusCode),
          statusValue: String(response?.status ?? response?.statusCode ?? ''),
        });
        // The in-memory virtual network returns a fetch-compatible response
        // whose arrayBuffer() is a non-consuming copy. Capture a bounded
        // diagnostic body for that path too; the raw response remains in the
        // normal network artifact and response delivery is not coupled to
        // observability.
        if (response?.scope === scope && typeof response?.arrayBuffer === 'function') {
          void Promise.resolve(response.arrayBuffer()).then((value) => {
            const bytes = new Uint8Array(value || 0);
            const decoder = scope.TextDecoder || TextDecoder;
            this._ownerProcess?.__bnhNetworkEvent?.({
              source: 'guest-http',
              method: String(this.method || 'GET'),
              url: String(this._url || this.path || ''),
              phase: 'body',
              transport: 'virtual-network',
              status: Number(response?.status ?? response?.statusCode ?? 0),
              bodyBytes: bytes.byteLength,
              bodyExcerpt: new decoder().decode(bytes).slice(0, 512),
            });
          }).catch(() => {});
        }
      } catch {
        // Network diagnostics must never change HTTP response delivery.
      }
      this._runInAsyncScope(() => this._runInOwnerContext(() => {
        const socket = response?.socket || this.socket;
        if (socket && this.protocol === DEFAULT_HTTPS_PROTOCOL) {
          const serverOptions = socket._httpsServerOptions
            || socket._httpsServer?._secureContextOptions || {};
          const host = this._options.servername || this.host
            || (() => { try { return new scope.URL(this._url).hostname; } catch { return 'localhost'; } })();
          const certificate = httpsCertificate(serverOptions.cert, host, scope);
          const checker = this._options.checkServerIdentity
            || this._httpsAgent?.options?.checkServerIdentity;
          const rejectUnauthorized = this._options.rejectUnauthorized
            ?? this._httpsAgent?.options?.rejectUnauthorized;
          let identityError;
          try {
            if (socket._httpsAuthorizationChecked
              && Object.hasOwn(this._options, 'checkServerIdentity')) {
              identityError = socket.authorizationError || undefined;
            } else if (typeof checker === 'function'
              && (this._httpsSession === undefined || this._options.checkServerIdentity !== undefined)) {
              identityError = checker(host, certificate);
            } else if (typeof checker !== 'function'
              && this._options.rejectUnauthorized !== false
              && serverOptions.cert) {
              identityError = httpsCheckServerIdentity(host, certificate);
            }
          } catch (error) {
            identityError = error;
          }
          socket.authorized = rejectUnauthorized !== false && !identityError;
          socket.authorizationError = identityError || null;
          socket.getPeerCertificate = () => certificate;
          if (identityError) {
            this.destroy(identityError);
            return;
          }
          const generation = socket._httpsSessionGeneration || 0;
          const reused = Boolean(this._httpsAgent && this._httpsSession !== undefined
            && this._httpsAgent._sessionGenerations.get(this._httpsSessionKey) === generation);
          const nonce = this._httpsAgent ? ++this._httpsAgent._sessionNonce : 0;
          const session = reused ? this._httpsSession : virtualTlsSession(
            `${this._httpsSessionKey || host}:${generation}:${nonce}`,
            this._httpsAgent?._BufferClass || BufferClass,
          );
          this.socket = socket;
          this.connection = socket;
          if (!this._socketEventEmitted) {
            this._socketEventEmitted = true;
            this.emit('socket', socket);
          }
          socket.getSession ||= () => session;
          socket.isSessionReused ||= () => reused;
          socket.emit?.('session', session);
          if (this._httpsSessionCacheable && !reused) {
            this._httpsAgent._cacheSession(this._httpsSessionKey, session, generation);
          }
        }
        this.response = new IncomingMessage(response, this, scope, BufferClass);
        // The response event is delivered from a fetch/network promise, so
        // restore the process and console that created the request at the
        // event boundary. Child processes otherwise log response metadata to
        // the parent console while streamed body bytes still reach child
        // stdout.
        this.response._runInAsyncScope(() => this._runInOwnerContext(
          () => this.emit('response', this.response),
        ));
        if (response?.__bnhInspectorBody) {
          this.response.complete = true;
          this.response.readableComplete = true;
          this.response._runInAsyncScope(() => {
            this.response.emit('data', response.__bnhInspectorBody);
            this.response.emit('end');
          });
          this._runInAsyncScope(() => this._responseComplete());
          return;
        }
        void this.response.start();
      }));
    }

    _handleFetchError(error) {
      if (this.destroyed) {
        if (error?.code === 'ERR_PROXY_TUNNEL') this._emitError(error);
        return;
      }
      const normalized = error?.name === 'AbortError'
        ? abortError(scope, error)
        : error?.name === 'TypeError' && /failed to fetch/i.test(String(error.message || ''))
          ? fetchNetworkError(this._url, error, scope)
          : error;
      this.destroy(normalized || new Error('fetch failed'));
    }

    _responseComplete() {
      this._clearTimeout();
      if (this._agent) {
        const name = this._agent.getName?.(this._options);
        if (name) {
          const freeSockets = this._agent.freeSockets[name] ||= [];
          if (!freeSockets.length) {
            const freeSocket = this.socket || new EventEmitter();
            freeSocket.destroyed ??= false;
            freeSocket.ref ??= () => freeSocket;
            freeSocket.unref ??= () => freeSocket;
            freeSocket.destroy ??= () => {
              freeSocket.destroyed = true;
              freeSocket.emit?.('close');
            };
            const removeFreeSocket = () => this._agent.removeSocket(freeSocket, this._options);
            freeSocket.once?.('error', removeFreeSocket);
            freeSocket.once?.('close', removeFreeSocket);
            freeSockets.push(freeSocket);
          }
          this._agentSocket = freeSockets[0];
        }
        this._agent.emit('free', this._agentSocket || { destroyed: false });
      }
      if (typeof performanceRecord === 'function' && !this._performanceRecorded) {
        this._performanceRecorded = true;
        const response = this.response;
        performanceRecord({
          name: 'HttpClient',
          entryType: 'http',
          startTime: this._performanceStart || (Number(scope.performance?.now?.()) || 0),
          duration: Math.max(0, (Number(scope.performance?.now?.()) || 0) - (this._performanceStart || 0)),
          detail: {
            req: {
              method: String(this.method || 'GET'),
              url: String(this.path || '/'),
              headers: this._headers && typeof this._headers === 'object' ? this._headers : {},
            },
            res: {
              statusCode: Number(response?.statusCode || 200),
              statusMessage: String(response?.statusMessage || 'OK'),
              headers: response?.headers && typeof response.headers === 'object' ? response.headers : {},
            },
          },
          toJSON() {
            return {
              name: this.name,
              entryType: this.entryType,
              startTime: this.startTime,
              duration: this.duration,
              detail: this.detail,
            };
          },
        });
      }
      publishDiagnostic(diagnostics, 'http.client.response.finish', {
        request: this,
        response: this.response,
      });
      this._emitClose();
    }

    _responseFailed(error) {
      if (!this.destroyed) this.destroy(error);
    }
  };
  Object.setPrototypeOf(ClientRequest.prototype, OutgoingMessage.prototype);
  return ClientRequest;
}

function createProtocolModule(protocol, ClientRequest, Server, Agent, scope, BufferClass, netModule, allowCrossProtocol) {
  let protocolModule;
  const request = (input, options, callback) => {
    const parsed = parseArguments(input, options, callback, scope);
    const requestOptions = { ...parsed.options, protocol: protocolName(parsed.options.protocol, protocol) };
    unsupportedTransportOptions(requestOptions);
    validateRequestPath(requestOptions.path);
    const url = validateURL(
      makeURL(parsed.target, requestOptions, protocol, scope),
      protocol,
      scope,
      allowCrossProtocol,
    );
    const clientRequest = new ClientRequest(url, {
      ...requestOptions,
      agent: requestOptions.agent === undefined ? protocolModule.globalAgent : requestOptions.agent,
    });
    if (parsed.callback) clientRequest.once('response', parsed.callback);
    clientRequest._agent?.addRequest?.(clientRequest, requestOptions);
    return clientRequest;
  };
  const get = (input, options, callback) => {
    const clientRequest = request(input, options, callback);
    clientRequest.end();
    return clientRequest;
  };
  const globalAgent = new Agent({ protocol, keepAlive: true, scheduling: 'lifo', timeout: 5000 });
  // Node's ServerResponse is a legacy-callable constructor. Packages such as
  // light-my-request invoke it with ServerResponse.call(this, request), so
  // expose the same initialization contract in addition to new.
  const ServerResponse = function ServerResponse(request) {
    Writable.call(this, virtualServerResponseWritableOptions(scope));
    initializeVirtualServerResponse(this, request, scope, BufferClass, () => {}, () => {});
    return this;
  };
  ServerResponse.prototype = VirtualServerResponse.prototype;
  protocolModule = {
    request,
    get,
    ClientRequest,
    IncomingMessage,
    OutgoingMessage,
    ServerResponse,
    METHODS,
    STATUS_CODES,
    Agent,
    globalAgent,
    Server,
    _connectionListener: connectionListener,
    createServer(options, listener) {
      return new Server(options, listener);
    },
    createConnection(options, callback) {
      return netModule.createConnection(options, callback);
    },
  };
  if (protocol === DEFAULT_HTTP_PROTOCOL) {
    protocolModule.setMaxIdleHTTPParsers = setMaxIdleHTTPParsers;
    protocolModule.validateHeaderName = validateHeaderName;
    protocolModule.validateHeaderValue = validateHeaderValue;
    Object.defineProperties(protocolModule, {
      WebSocket: {
        configurable: true,
        enumerable: false,
        get: () => scope.WebSocket,
      },
      CloseEvent: {
        configurable: true,
        enumerable: false,
        get: () => scope.CloseEvent,
      },
      MessageEvent: {
        configurable: true,
        enumerable: false,
        get: () => scope.MessageEvent,
      },
    });
  }
  return protocolModule;
}

/** Create the browser-native Node-shaped http and https compatibility modules. */
export function createHttpCompatibility(scope = globalThis, {
  Buffer: BufferClass = scope.Buffer,
  process: ownerProcess,
  proxy: configuredProxy,
  net: configuredNet,
  proxyEnv,
  httpNetwork: configuredHttpNetwork,
  trackTask,
  diagnostics,
  performance: performanceRecord,
} = {}) {
  BufferClass ||= typeof Buffer === 'function' ? Buffer : undefined;
  installEventInspectHook(scope);
  installEventTargetInspectHook(scope);
  const net = configuredNet || createBrowserNet({ BufferClass, trackTask });
  const virtualNetwork = configuredHttpNetwork
    || createVirtualHttpNetwork(scope, BufferClass, net, trackTask, diagnostics, performanceRecord, ownerProcess);
  const proxy = configuredProxy
    ? (typeof configuredProxy.request === 'function' && configuredProxy.mode
      ? configuredProxy
      : createProxyCapability(configuredProxy))
    : null;
  validateProxyEnvironment(proxyEnv, scope);
  const ClientRequest = createRequestClass(
    scope,
    BufferClass,
    virtualNetwork,
    proxy,
    proxyEnv,
    diagnostics,
    ownerProcess,
    trackTask,
    performanceRecord,
  );
  const HttpServer = createServerClass(DEFAULT_HTTP_PROTOCOL, scope, virtualNetwork, BufferClass, trackTask, ownerProcess);
  const HttpsServer = createServerClass(DEFAULT_HTTPS_PROTOCOL, scope, virtualNetwork, BufferClass, trackTask, ownerProcess);
  Object.setPrototypeOf(VirtualServerRequest.prototype, IncomingMessage.prototype);
  Object.setPrototypeOf(VirtualServerResponse.prototype, OutgoingMessage.prototype);
  IncomingMessage.prototype.begin = VirtualServerRequest.prototype.begin;
  IncomingMessage.prototype._ensureAsyncResource = VirtualServerRequest.prototype._ensureAsyncResource;
  IncomingMessage.prototype._runInAsyncScope = VirtualServerRequest.prototype._runInAsyncScope;
  const HttpAgent = class Agent extends BrowserAgent {
    constructor(options = {}) {
      super(options, DEFAULT_HTTP_PROTOCOL, (connectionOptions) => net.createConnection(connectionOptions));
    }

    createConnection(options) { return net.createConnection(options); }
  };
  const HttpsAgentClass = class Agent extends BrowserAgent {
    constructor(options = {}) {
      const agentOptions = {
        ...options,
        defaultPort: options.defaultPort ?? 443,
        protocol: options.protocol ?? DEFAULT_HTTPS_PROTOCOL,
      };
      super(agentOptions, DEFAULT_HTTPS_PROTOCOL, (connectionOptions) => net.createConnection(connectionOptions));
      this.maxCachedSessions = this.options.maxCachedSessions;
      if (this.maxCachedSessions === undefined) this.maxCachedSessions = 100;
      this._sessionCache = { map: {}, list: [] };
      this._sessionGenerations = new Map();
      this._sessionNonce = 0;
      this._BufferClass = BufferClass;
    }

    createConnection(options) { return net.createConnection(options); }

    getName(options = {}) {
      let name = super.getName(options);
      name += ':';
      if (options.ca) name += options.ca;
      name += ':';
      if (options.cert) name += options.cert;
      name += ':';
      if (options.clientCertEngine) name += options.clientCertEngine;
      name += ':';
      if (options.ciphers) name += options.ciphers;
      name += ':';
      if (options.key) name += options.key;
      name += ':';
      if (options.pfx) name += httpsPfxAgentKey(options.pfx, options.passphrase);
      name += ':';
      if (options.rejectUnauthorized !== undefined) name += options.rejectUnauthorized;
      name += ':';
      if (options.servername && options.servername !== options.host) name += options.servername;
      name += ':';
      if (options.minVersion) name += options.minVersion;
      name += ':';
      if (options.maxVersion) name += options.maxVersion;
      name += ':';
      if (options.secureProtocol) name += options.secureProtocol;
      name += ':';
      if (options.crl) name += options.crl;
      name += ':';
      if (options.honorCipherOrder !== undefined) name += options.honorCipherOrder;
      name += ':';
      if (options.ecdhCurve) name += options.ecdhCurve;
      name += ':';
      if (options.dhparam) name += options.dhparam;
      name += ':';
      if (options.secureOptions !== undefined) name += options.secureOptions;
      name += ':';
      if (options.sessionIdContext) name += options.sessionIdContext;
      name += ':';
      if (options.sigalgs) name += JSON.stringify(options.sigalgs);
      name += ':';
      if (options.privateKeyIdentifier) name += options.privateKeyIdentifier;
      name += ':';
      if (options.privateKeyEngine) name += options.privateKeyEngine;
      return name;
    }

    _getSession(key) {
      return this._sessionCache.map[key];
    }

    _cacheSession(key, session, generation = 0) {
      if (this.maxCachedSessions === 0) return;
      if (this._sessionCache.map[key]) {
        this._sessionCache.map[key] = session;
        this._sessionGenerations.set(key, generation);
        return;
      }
      if (this._sessionCache.list.length >= this.maxCachedSessions) {
        const oldKey = this._sessionCache.list.shift();
        delete this._sessionCache.map[oldKey];
        this._sessionGenerations.delete(oldKey);
      }
      this._sessionCache.list.push(key);
      this._sessionCache.map[key] = session;
      this._sessionGenerations.set(key, generation);
    }

    _evictSession(key) {
      const index = this._sessionCache.list.indexOf(key);
      if (index === -1) return;
      this._sessionCache.list.splice(index, 1);
      delete this._sessionCache.map[key];
      this._sessionGenerations.delete(key);
    }
  };
  function HttpsAgent(options) {
    return new HttpsAgentClass(options);
  }
  HttpsAgent.prototype = HttpsAgentClass.prototype;
  HttpAgent.defaultMaxSockets = Infinity;
  Object.setPrototypeOf(HttpsAgent, HttpAgent);
  const agentMethods = [
    'addRequest',
    'createSocket',
    'removeSocket',
    'reuseSocket',
    'destroy',
  ];
  for (const Agent of [HttpAgent, HttpsAgent]) {
    for (const name of agentMethods) {
      Object.defineProperty(Agent.prototype, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: BrowserAgent.prototype[name],
      });
    }
  }
  const allowCrossProtocol = Boolean(
    proxy?.mode === 'proxy'
      && proxy.enabled
      && proxy.capabilityGranted
      && proxy.adapter,
  );
  const http = createProtocolModule(
    DEFAULT_HTTP_PROTOCOL,
    ClientRequest,
    HttpServer,
    HttpAgent,
    scope,
    BufferClass,
    net,
    allowCrossProtocol,
  );
  const https = createProtocolModule(
    DEFAULT_HTTPS_PROTOCOL,
    ClientRequest,
    HttpsServer,
    HttpsAgent,
    scope,
    BufferClass,
    net,
    allowCrossProtocol,
  );
  const HTTPParser = createHTTPParserClass(scope, BufferClass, ownerProcess);
  function parsersCb() {
    const parser = new HTTPParser();
    cleanParser(parser);
    return parser;
  }
  httpParsers.ctor = parsersCb;
  return Object.freeze({
    http,
    https,
    httpCommon: {
      methods: METHODS,
      parsers: httpParsers,
      HTTPParser,
      _checkInvalidHeaderChar: checkInvalidHeaderChar,
      _checkIsHttpToken: checkIsHttpToken,
      chunkExpression,
      continueExpression,
      CRLF,
      freeParser,
      isLenient,
      kIncomingMessage,
      kSkipPendingData,
      prepareError,
    },
    ClientRequest,
    IncomingMessage: http.IncomingMessage,
    OutgoingMessage: http.OutgoingMessage,
    httpNetwork: virtualNetwork,
    boundaries: Object.freeze({
      rawTcp: net.createConnection,
      rawTls: net.createConnection,
      httpServer: () => undefined,
    }),
  });
}

export default createHttpCompatibility;
