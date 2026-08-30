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
  NGHTTP2_ERR_DEFERRED: -508,
  NGHTTP2_ERR_STREAM_ID_NOT_AVAILABLE: -509,
  NGHTTP2_ERR_INVALID_ARGUMENT: -501,
  NGHTTP2_ERR_STREAM_CLOSED: -510,
  NGHTTP2_ERR_NOMEM: -901,
  NGHTTP2_ERR_FRAME_SIZE_ERROR: -522,
  NGHTTP2_HCAT_REQUEST: 0,
  NGHTTP2_HCAT_RESPONSE: 1,
  NGHTTP2_HCAT_PUSH_RESPONSE: 2,
  NGHTTP2_HCAT_HEADERS: 3,
  NGHTTP2_NV_FLAG_NONE: 0,
  NGHTTP2_NV_FLAG_NO_INDEX: 1,
  NGHTTP2_SESSION_SERVER: 0,
  NGHTTP2_SESSION_CLIENT: 1,
  NGHTTP2_STREAM_STATE_IDLE: 1,
  NGHTTP2_STREAM_STATE_OPEN: 2,
  NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
  NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
  NGHTTP2_STREAM_STATE_CLOSED: 7,
  NGHTTP2_FLAG_ACK: 1,
  NGHTTP2_DEFAULT_WEIGHT: 16,
  DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0,
  MAX_MAX_FRAME_SIZE: 16777215,
  MIN_MAX_FRAME_SIZE: 16384,
  MAX_INITIAL_WINDOW_SIZE: 2147483647,
  NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
  NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
  NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
  NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
  NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
  NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
  NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
  PADDING_STRATEGY_NONE: 0,
  PADDING_STRATEGY_ALIGNED: 1,
  PADDING_STRATEGY_MAX: 2,
  PADDING_STRATEGY_CALLBACK: 1,
  STREAM_OPTION_EMPTY_PAYLOAD: 1,
  STREAM_OPTION_GET_TRAILERS: 2,
  HTTP2_HEADER_ACCEPT_ENCODING: 'accept-encoding',
  HTTP2_HEADER_ACCEPT_LANGUAGE: 'accept-language',
  HTTP2_HEADER_ACCEPT_RANGES: 'accept-ranges',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: 'access-control-allow-credentials',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: 'access-control-allow-headers',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: 'access-control-allow-methods',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: 'access-control-allow-origin',
  HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: 'access-control-expose-headers',
  HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: 'access-control-request-headers',
  HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: 'access-control-request-method',
  HTTP2_HEADER_AGE: 'age',
  HTTP2_HEADER_AUTHORIZATION: 'authorization',
  HTTP2_HEADER_CACHE_CONTROL: 'cache-control',
  HTTP2_HEADER_CONNECTION: 'connection',
  HTTP2_HEADER_CONTENT_DISPOSITION: 'content-disposition',
  HTTP2_HEADER_CONTENT_ENCODING: 'content-encoding',
  HTTP2_HEADER_COOKIE: 'cookie',
  HTTP2_HEADER_DATE: 'date',
  HTTP2_HEADER_ETAG: 'etag',
  HTTP2_HEADER_FORWARDED: 'forwarded',
  HTTP2_HEADER_HOST: 'host',
  HTTP2_HEADER_PROTOCOL: ':protocol',
  HTTP2_HEADER_IF_MODIFIED_SINCE: 'if-modified-since',
  HTTP2_HEADER_IF_NONE_MATCH: 'if-none-match',
  HTTP2_HEADER_IF_RANGE: 'if-range',
  HTTP2_HEADER_IF_UNMODIFIED_SINCE: 'if-unmodified-since',
  HTTP2_HEADER_LAST_MODIFIED: 'last-modified',
  HTTP2_HEADER_LINK: 'link',
  HTTP2_HEADER_LOCATION: 'location',
  HTTP2_HEADER_MAX_FORWARDS: 'max-forwards',
  HTTP2_HEADER_RANGE: 'range',
  HTTP2_HEADER_REFERER: 'referer',
  HTTP2_HEADER_RETRY_AFTER: 'retry-after',
  HTTP2_HEADER_SERVER: 'server',
  HTTP2_HEADER_SET_COOKIE: 'set-cookie',
  HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: 'strict-transport-security',
  HTTP2_HEADER_TRANSFER_ENCODING: 'transfer-encoding',
  HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: 'upgrade-insecure-requests',
  HTTP2_HEADER_UPGRADE: 'upgrade',
  HTTP2_HEADER_VARY: 'vary',
  HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: 'x-content-type-options',
  HTTP2_HEADER_X_FRAME_OPTIONS: 'x-frame-options',
  HTTP2_HEADER_X_XSS_PROTECTION: 'x-xss-protection',
  HTTP2_HEADER_KEEP_ALIVE: 'keep-alive',
  HTTP2_HEADER_PROXY_CONNECTION: 'proxy-connection',
  HTTP2_HEADER_ALT_SVC: 'alt-svc',
  HTTP2_HEADER_CONTENT_SECURITY_POLICY: 'content-security-policy',
  HTTP2_HEADER_EARLY_DATA: 'early-data',
  HTTP2_HEADER_EXPECT_CT: 'expect-ct',
  HTTP2_HEADER_ORIGIN: 'origin',
  HTTP2_HEADER_PURPOSE: 'purpose',
  HTTP2_HEADER_TIMING_ALLOW_ORIGIN: 'timing-allow-origin',
  HTTP2_HEADER_X_FORWARDED_FOR: 'x-forwarded-for',
  HTTP2_HEADER_PRIORITY: 'priority',
  HTTP2_HEADER_ACCEPT_CHARSET: 'accept-charset',
  HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: 'access-control-max-age',
  HTTP2_HEADER_ALLOW: 'allow',
  HTTP2_HEADER_CONTENT_LANGUAGE: 'content-language',
  HTTP2_HEADER_CONTENT_LOCATION: 'content-location',
  HTTP2_HEADER_CONTENT_MD5: 'content-md5',
  HTTP2_HEADER_CONTENT_RANGE: 'content-range',
  HTTP2_HEADER_DNT: 'dnt',
  HTTP2_HEADER_EXPECT: 'expect',
  HTTP2_HEADER_EXPIRES: 'expires',
  HTTP2_HEADER_FROM: 'from',
  HTTP2_HEADER_IF_MATCH: 'if-match',
  HTTP2_HEADER_PREFER: 'prefer',
  HTTP2_HEADER_PROXY_AUTHENTICATE: 'proxy-authenticate',
  HTTP2_HEADER_PROXY_AUTHORIZATION: 'proxy-authorization',
  HTTP2_HEADER_REFRESH: 'refresh',
  HTTP2_HEADER_TRAILER: 'trailer',
  HTTP2_HEADER_TK: 'tk',
  HTTP2_HEADER_VIA: 'via',
  HTTP2_HEADER_WARNING: 'warning',
  HTTP2_HEADER_WWW_AUTHENTICATE: 'www-authenticate',
  HTTP2_HEADER_HTTP2_SETTINGS: 'http2-settings',
  HTTP2_METHOD_ACL: 'ACL',
  HTTP2_METHOD_BASELINE_CONTROL: 'BASELINE-CONTROL',
  HTTP2_METHOD_BIND: 'BIND',
  HTTP2_METHOD_CHECKIN: 'CHECKIN',
  HTTP2_METHOD_CHECKOUT: 'CHECKOUT',
  HTTP2_METHOD_COPY: 'COPY',
  HTTP2_METHOD_CONNECT: 'CONNECT',
  HTTP2_METHOD_DELETE: 'DELETE',
  HTTP2_METHOD_GET: 'GET',
  HTTP2_METHOD_HEAD: 'HEAD',
  HTTP2_METHOD_LABEL: 'LABEL',
  HTTP2_METHOD_LINK: 'LINK',
  HTTP2_METHOD_LOCK: 'LOCK',
  HTTP2_METHOD_MERGE: 'MERGE',
  HTTP2_METHOD_MKACTIVITY: 'MKACTIVITY',
  HTTP2_METHOD_MKCALENDAR: 'MKCALENDAR',
  HTTP2_METHOD_MKCOL: 'MKCOL',
  HTTP2_METHOD_MKREDIRECTREF: 'MKREDIRECTREF',
  HTTP2_METHOD_MKWORKSPACE: 'MKWORKSPACE',
  HTTP2_METHOD_MOVE: 'MOVE',
  HTTP2_METHOD_OPTIONS: 'OPTIONS',
  HTTP2_METHOD_ORDERPATCH: 'ORDERPATCH',
  HTTP2_METHOD_PATCH: 'PATCH',
  HTTP2_METHOD_POST: 'POST',
  HTTP2_METHOD_PRI: 'PRI',
  HTTP2_METHOD_PROPFIND: 'PROPFIND',
  HTTP2_METHOD_PROPPATCH: 'PROPPATCH',
  HTTP2_METHOD_PUT: 'PUT',
  HTTP2_METHOD_REBIND: 'REBIND',
  HTTP2_METHOD_REPORT: 'REPORT',
  HTTP2_METHOD_SEARCH: 'SEARCH',
  HTTP2_METHOD_TRACE: 'TRACE',
  HTTP2_METHOD_UNBIND: 'UNBIND',
  HTTP2_METHOD_UNCHECKOUT: 'UNCHECKOUT',
  HTTP2_METHOD_UNLINK: 'UNLINK',
  HTTP2_METHOD_UNLOCK: 'UNLOCK',
  HTTP2_METHOD_UPDATE: 'UPDATE',
  HTTP2_METHOD_UPDATEREDIRECTREF: 'UPDATEREDIRECTREF',
  HTTP2_METHOD_VERSION_CONTROL: 'VERSION-CONTROL',
  HTTP_STATUS_CONTINUE: 100,
  HTTP_STATUS_SWITCHING_PROTOCOLS: 101,
  HTTP_STATUS_EARLY_HINTS: 103,
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_CREATED: 201,
  HTTP_STATUS_ACCEPTED: 202,
  HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203,
  HTTP_STATUS_NO_CONTENT: 204,
  HTTP_STATUS_RESET_CONTENT: 205,
  HTTP_STATUS_MULTI_STATUS: 207,
  HTTP_STATUS_ALREADY_REPORTED: 208,
  HTTP_STATUS_IM_USED: 226,
  HTTP_STATUS_MULTIPLE_CHOICES: 300,
  HTTP_STATUS_MOVED_PERMANENTLY: 301,
  HTTP_STATUS_FOUND: 302,
  HTTP_STATUS_SEE_OTHER: 303,
  HTTP_STATUS_NOT_MODIFIED: 304,
  HTTP_STATUS_USE_PROXY: 305,
  HTTP_STATUS_TEMPORARY_REDIRECT: 307,
  HTTP_STATUS_BAD_REQUEST: 400,
  HTTP_STATUS_UNAUTHORIZED: 401,
  HTTP_STATUS_FORBIDDEN: 403,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_METHOD_NOT_ALLOWED: 405,
  HTTP_STATUS_NOT_ACCEPTABLE: 406,
  HTTP_STATUS_REQUEST_TIMEOUT: 408,
  HTTP_STATUS_CONFLICT: 409,
  HTTP_STATUS_GONE: 410,
  HTTP_STATUS_LENGTH_REQUIRED: 411,
  HTTP_STATUS_URI_TOO_LONG: 414,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415,
  HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416,
  HTTP_STATUS_EXPECTATION_FAILED: 417,
  HTTP_STATUS_TEAPOT: 418,
  HTTP_STATUS_MISDIRECTED_REQUEST: 421,
  HTTP_STATUS_UNPROCESSABLE_ENTITY: 422,
  HTTP_STATUS_LOCKED: 423,
  HTTP_STATUS_FAILED_DEPENDENCY: 424,
  HTTP_STATUS_TOO_EARLY: 425,
  HTTP_STATUS_UPGRADE_REQUIRED: 426,
  HTTP_STATUS_TOO_MANY_REQUESTS: 429,
  HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
  HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
  HTTP_STATUS_NOT_IMPLEMENTED: 501,
  HTTP_STATUS_BAD_GATEWAY: 502,
  HTTP_STATUS_SERVICE_UNAVAILABLE: 503,
  HTTP_STATUS_GATEWAY_TIMEOUT: 504,
  HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505,
  HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506,
  HTTP_STATUS_INSUFFICIENT_STORAGE: 507,
  HTTP_STATUS_LOOP_DETECTED: 508,
  HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509,
  HTTP_STATUS_NOT_EXTENDED: 510,
  HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511,
  HTTP_STATUS_PROCESSING: 102,
  HTTP_STATUS_PARTIAL_CONTENT: 206,
  HTTP_STATUS_PAYMENT_REQUIRED: 402,
  HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407,
  HTTP_STATUS_PRECONDITION_FAILED: 412,
  HTTP_STATUS_PAYLOAD_TOO_LARGE: 413,
  HTTP_STATUS_PRECONDITION_REQUIRED: 428,
  HTTP_STATUS_PERMANENT_REDIRECT: 308,
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
  enableConnectProtocol: false,
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

function http2CompatError(type, code, message) {
  const error = new type(message);
  error.code = code;
  return error;
}

let statusMessageWarned = false;

function warnUnsupportedStatusMessage(scope) {
  if (statusMessageWarned) return;
  statusMessageWarned = true;
  scope?.process?.emitWarning?.(
    'Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)',
    'UnsupportedWarning',
  );
}

function invalidHeaderNameError(name) {
  return http2CompatError(
    TypeError,
    'ERR_INVALID_ARG_TYPE',
    `The "name" argument must be of type string.${invalidArgumentDescription(name)}`,
  );
}

function validateCompatHeader(name, value) {
  if (typeof name !== 'string') {
    throw http2CompatError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "name" argument must be of type string');
  }
  if (name === '' || name.includes(' ')) {
    throw http2CompatError(TypeError, 'ERR_INVALID_HTTP_TOKEN', `Header name must be a valid HTTP token ["${name}"]`);
  }
  if ([':status', ':method', ':path', ':authority', ':scheme'].includes(name)) {
    throw http2CompatError(
      TypeError,
      'ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED',
      'Cannot set HTTP/2 pseudo-headers',
    );
  }
  if (value === undefined || value === null) {
    throw http2CompatError(
      TypeError,
      'ERR_HTTP2_INVALID_HEADER_VALUE',
      `Invalid value "${value}" for header "${name}"`,
    );
  }
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

const SETTINGS_FIELDS = [
  ['headerTableSize', constants.NGHTTP2_SETTINGS_HEADER_TABLE_SIZE, 0, 0xffffffff],
  ['enablePush', constants.NGHTTP2_SETTINGS_ENABLE_PUSH, 0, 1],
  ['maxConcurrentStreams', constants.NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, 0, 0xffffffff],
  ['initialWindowSize', constants.NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE, 0, constants.MAX_INITIAL_WINDOW_SIZE],
  ['maxFrameSize', constants.NGHTTP2_SETTINGS_MAX_FRAME_SIZE, constants.MIN_MAX_FRAME_SIZE, constants.MAX_MAX_FRAME_SIZE],
  ['maxHeaderListSize', constants.NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE, 0, 0xffffffff],
  ['enableConnectProtocol', constants.NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL, 0, 1],
];

function settingError(name, value, type = RangeError) {
  return http2CompatError(type, 'ERR_HTTP2_INVALID_SETTING_VALUE', `Invalid value for setting "${name}": ${value}`);
}

function invalidArgumentDescription(value) {
  if (value === null || value === undefined) return ` Received ${value}`;
  if (typeof value === 'object') {
    const constructorName = value.constructor?.name;
    return constructorName ? ` Received an instance of ${constructorName}` : ` Received ${String(value)}`;
  }
  const inspected = typeof value === 'string' ? `'${value}'` : String(value);
  return ` Received type ${typeof value} (${inspected})`;
}

function validateSettings(settings) {
  if (settings === undefined) return;
  if (!isRecord(settings)) {
    throw http2CompatError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "settings" argument must be of type object');
  }
  for (const [name, , min, max] of SETTINGS_FIELDS) {
    if (settings[name] === undefined) continue;
    const value = settings[name];
    if (name === 'enablePush' || name === 'enableConnectProtocol') {
      if (typeof value !== 'boolean') throw settingError(name, value, TypeError);
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw settingError(name, value);
    }
  }
  if (settings.maxHeaderSize !== undefined) {
    const value = settings.maxHeaderSize;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw settingError('maxHeaderSize', value);
    }
  }
  const custom = settings.customSettings;
  if (custom === undefined) return;
  if (!isRecord(custom)) throw settingError('customSettings', custom, TypeError);
  const keys = Object.keys(custom);
  if (keys.length > 10) throw http2CompatError(RangeError, 'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS', 'Too many custom settings');
  for (const key of keys) {
    const id = Number(key);
    const value = custom[key];
    if (!Number.isInteger(id) || id <= 0 || id > 0xffff || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw settingError('customSettings', value);
    }
  }
}

function settingValue(settings, name) {
  if (name === 'maxHeaderListSize' && settings.maxHeaderSize !== undefined) return settings.maxHeaderSize;
  if (name === 'enablePush' || name === 'enableConnectProtocol') return Number(settings[name]);
  return settings[name];
}

function getPackedSettingsForScope(settings = {}, scope = globalThis) {
  validateSettings(settings);
  const records = [];
  for (const [name, id] of SETTINGS_FIELDS) {
    if (settings[name] === undefined && !(name === 'maxHeaderListSize' && settings.maxHeaderSize !== undefined)) continue;
    records.push([id, settingValue(settings, name)]);
  }
  for (const key of Object.keys(settings.customSettings || {})) {
    const id = Number(key);
    if (id >= 1 && id <= 8 && SETTINGS_FIELDS.some(([, knownId]) => knownId === id)) continue;
    records.push([id, settings.customSettings[key]]);
  }
  const bytes = new Uint8Array(records.length * 6);
  const view = new DataView(bytes.buffer);
  records.forEach(([id, value], index) => {
    const offset = index * 6;
    view.setUint16(offset, id);
    view.setUint32(offset + 2, value >>> 0);
  });
  return scope.Buffer?.from ? scope.Buffer.from(bytes) : bytes;
}

export function getPackedSettings(settings, scope = globalThis) {
  return getPackedSettingsForScope(settings, scope);
}

export function getUnpackedSettings(buf, options = {}) {
  if (!ArrayBuffer.isView(buf) || buf.length === undefined) {
    throw http2CompatError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      `The "buf" argument must be an instance of Buffer or TypedArray.${invalidArgumentDescription(buf)}`,
    );
  }
  if (buf.length % 6 !== 0) {
    throw http2CompatError(RangeError, 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', 'Packed settings length must be a multiple of six');
  }
  const settings = {};
  for (let offset = 0; offset < buf.length; offset += 6) {
    const id = buf[offset] * 0x100 + buf[offset + 1];
    const value = (buf[offset + 2] * 0x1000000)
      + (buf[offset + 3] * 0x10000)
      + (buf[offset + 4] * 0x100)
      + buf[offset + 5];
    switch (id) {
      case 1: settings.headerTableSize = value; break;
      case 2: settings.enablePush = value !== 0; break;
      case 3: settings.maxConcurrentStreams = value; break;
      case 4: settings.initialWindowSize = value; break;
      case 5: settings.maxFrameSize = value; break;
      case 6:
        settings.maxHeaderListSize = value;
        settings.maxHeaderSize = value;
        break;
      case 8: settings.enableConnectProtocol = value !== 0; break;
      default: (settings.customSettings ||= {})[id] = value;
    }
  }
  if (options?.validate) validateSettings(settings);
  return settings;
}

export function performServerHandshake(socket, options = {}) {
  if (socket && socket._http2ServerSession) {
    throw http2Error('ERR_HTTP2_SOCKET_BOUND', 'The socket is already bound to an HTTP/2 session');
  }
  const session = new ClientHttp2Session(
    { host: 'localhost', port: 0, protocol: options?.encrypted === false ? 'http:' : 'https:' },
    { ...options },
    {
      scope: globalThis,
      vfs: options?.vfs,
      diagnostics: options?.diagnostics,
      performance: options?.performance,
      connection: socket,
      serverHandshake: true,
    },
  );
  session.type = constants.NGHTTP2_SESSION_SERVER;
  if (socket && typeof socket === 'object') socket._http2ServerSession = session;
  return session;
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
    super({ highWaterMark: options.highWaterMark, autoDestroy: false });
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
    if (this._role !== 'server') this.additionalHeaders = undefined;
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
    this._inputEnded = false;
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
          if (!this._inputEnded) {
            this._inputEnded = true;
            this._peer?.push(null);
          }
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

  _read() {}

  // DuplexImpl dispatches writes through the public owner before consulting
  // the inner writable.  Keep the HTTP/2 stream's body sink on the owner so
  // request.end() works for streams created from a duplexPair() connection.
  _write(chunk, _encoding, callback) {
    try {
      const bytes = bytesFor(chunk, this._scope);
      this._body.push(bytes);
      if (this._role === 'client' && this._peer?._acceptingInput) this._peer.push(bytes);
      if (this._role === 'client' && this._peer?._acceptingInput) setTimeout(callback, 0);
      else callback();
    } catch (error) {
      callback(error);
    }
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
    const status = headers?.[':status'];
    if (status >= 100 && status < 200) {
      this.emit('headers', headers, 0);
      return;
    }
    if (!this._responseHeaders) {
      this._responseHeaders = headers;
      this.pending = false;
      if (this._role === 'client') this._publishFinishDiagnostics(headers);
      this.emit('response', headers, 0);
    }
    if (body?.byteLength) this.push(body);
    if (done) {
      if (this._role === 'client' && typeof this._performance === 'function' && !this._performanceRecorded) {
        this._performanceRecorded = true;
        const now = Number(this._scope?.performance?.now?.()) || this._performanceStart;
        this._performance({
          name: 'Http2Session',
          entryType: 'http2',
          startTime: this._performanceStart,
          duration: Math.max(0, now - this._performanceStart),
          detail: {
            type: 'client',
            framesReceived: 4 + (this._peer?._wroteWithCallback ? 1 : 0),
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
      this._responseComplete = true;
      this.closed = true;
      this.push(null);
      this._publishCloseDiagnostics();
      schedule(() => this._emitClose());
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
    const status = Number(this.sentHeaders[':status']);
    const endStream = Boolean(options.endStream)
      || status === 204 || status === 205 || status === 304;
    const wireHeaders = { ...this.sentHeaders };
    for (const [name, value] of Object.entries(wireHeaders)) {
      if (Array.isArray(value) && name !== 'set-cookie') wireHeaders[name] = value.join(', ');
    }
    schedule(() => this._peer?._receiveResponse(wireHeaders, null, endStream));
    if (endStream && this._role === 'server') {
      this.closed = true;
      this.destroyed = true;
      this._publishCloseDiagnostics();
      schedule(() => this._emitClose());
    }
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
    if (this._role !== 'server' || this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_STREAM', 'Additional headers require an active response');
    this._peer?.emit('headers', normalizeHeaders(headers), 0);
  }

  _sendResponseChunk(bytes) {
    if (!this.headersSent) this.respond({ ':status': 200 });
    setTimeout(() => this._peer?._receiveResponse(null, bytes, false), 0);
  }

  _finishResponse() {
    if (!this.headersSent) this.respond({ ':status': 200 });
    this.closed = true;
    this.destroyed = true;
    const body = this._bodyBytes();
    setTimeout(() => {
      this._peer?._receiveResponse(null, body, true);
      this._responseComplete = true;
      this._compatResponse?._finishResponse?.();
    }, 0);
    this._releaseResponseFile();
    this._publishCloseDiagnostics();
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }
    const diagnosticEncoding = typeof chunk === 'string' ? String(encoding || 'utf8') : 'buffer';
    if (typeof callback === 'function') this._wroteWithCallback = true;
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
    if (this._role === 'server' && this.headersSent) {
      if (chunk !== undefined) this._sendResponseChunk(chunk);
      return super.end(undefined, undefined, callback);
    }
    return super.end(chunk, encoding, callback);
  }

  close(code = constants.NGHTTP2_NO_ERROR, callback) {
    if (typeof callback === 'function') this.once('close', callback);
    if (code !== constants.NGHTTP2_NO_ERROR) {
      return this.destroy(http2Error(
        'ERR_HTTP2_STREAM_ERROR',
        `Stream closed with error code ${code}`,
      ));
    }
    this.rstCode = code;
    this.aborted = code !== constants.NGHTTP2_NO_ERROR;
    this.closed = true;
    this._releaseResponseFile();
    this._peer?._receiveResponse(null, null, true);
    this._publishCloseDiagnostics();
    schedule(() => this._emitClose());
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
    stream.on('error', (error) => {
      if (!this.destroyed) this.destroy(error);
    });
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

  [Symbol.for('nodejs.asyncDispose')]() {
    this.destroy();
    return Promise.resolve();
  }
}

// Compatibility response surface used by the request-oriented HTTP/2 API.
// Keep these accessors backed by the virtual stream so the response observes
// the same lifecycle and writable state as the raw stream API.
export class Http2ServerResponse extends Stream {
  constructor(stream, options) {
    super(options);
    this._stream = stream;
    this._headers = Object.create(null);
    this._trailers = Object.create(null);
    this._state = {
      closed: false,
      ending: false,
      destroyed: false,
      sendDate: true,
      statusCode: 200,
    };
    this.req = stream?._compatRequest;
    const finishResponse = () => {
      if (this._state.closed) return;
      this._state.closed = true;
      this.emit('finish');
      this.emit('close');
    };
    this._finishResponse = finishResponse;
    if (stream) stream._compatResponse = this;
    stream?.on('error', (error) => {
      if (!this._state.destroyed) this.destroy(error);
    });
    stream?.on('close', () => {
      if (!this._state.closed) {
        this._state.closed = true;
        this.emit('close');
      }
    });
  }

  get _header() {
    return this.headersSent;
  }

  get writableEnded() {
    return this._state.ending;
  }

  get finished() {
    return this._state.ending;
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

  get writableLength() {
    return this._stream?.writableLength;
  }

  cork() {
    this._stream.cork();
  }

  uncork() {
    this._stream.uncork();
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }

    let error;
    if (this._state.ending) {
      error = http2Error('ERR_STREAM_WRITE_AFTER_END', 'write after end');
    } else if (this._state.closed || this._stream.closed) {
      error = http2Error('ERR_HTTP2_INVALID_STREAM', 'The stream has been destroyed');
    } else if (this._state.destroyed || this._stream.destroyed) {
      return false;
    }

    if (error) {
      if (typeof callback === 'function') queueMicrotask(() => callback(error));
      this.destroy(error);
      return false;
    }

    if (!this._stream.headersSent) {
      this._stream.respond({ ':status': this._state.statusCode });
    }
    return this._stream.write(chunk, encoding, callback);
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }

    if (this._state.closed || this._state.ending) {
      if (typeof callback === 'function') queueMicrotask(callback);
      return this;
    }

    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this._state.ending = true;

    if (typeof callback === 'function') {
      if (this._stream.writableFinished) queueMicrotask(callback);
      else this._stream.once('finish', callback);
    }

    if (!this._stream.headersSent) this._stream.respond({ ':status': this._state.statusCode });
    if (!this._state.closed && !this._stream.destroyed) this._stream.end();
    return this;
  }

  destroy(error) {
    if (this._state.destroyed) return;
    this._state.destroyed = true;
    this._stream.destroy(error);
  }

  setTimeout(milliseconds, callback) {
    if (this._state.closed) return;
    this._stream.setTimeout(milliseconds, callback);
  }

  createPushResponse(headers, callback) {
    if (typeof callback !== 'function') {
      const error = new TypeError('callback must be a function');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (this._state.closed || this._stream.closed) {
      queueMicrotask(() => callback(http2Error(
        'ERR_HTTP2_INVALID_STREAM',
        'The stream has been destroyed',
      )));
      return;
    }
    this._stream.pushStream(headers, {}, (error, stream) => {
      if (error) {
        callback(error);
        return;
      }
      callback(null, new Http2ServerResponse(stream));
    });
  }

  writeContinue() {
    if (this._stream.headersSent || this._state.closed) return false;
    this._stream.additionalHeaders({ ':status': 100 });
    return true;
  }

  setTrailer(name, value) {
    if (typeof name !== 'string') validateCompatHeader(name, value);
    name = name.trim().toLowerCase();
    validateCompatHeader(name, value);
    this._trailers[name] = value;
  }

  addTrailers(headers) {
    for (const name of Object.keys(headers)) this.setTrailer(name, headers[name]);
  }

  getHeader(name) {
    if (typeof name !== 'string') {
      throw invalidHeaderNameError(name);
    }
    return this._headers[name.trim().toLowerCase()];
  }

  getHeaderNames() {
    return Object.keys(this._headers);
  }

  getHeaders() {
    return Object.assign(Object.create(null), this._headers);
  }

  hasHeader(name) {
    if (typeof name !== 'string') throw invalidHeaderNameError(name);
    return Object.hasOwn(this._headers, name.trim().toLowerCase());
  }

  removeHeader(name) {
    if (typeof name !== 'string') throw invalidHeaderNameError(name);
    if (this.headersSent) throw http2Error('ERR_HTTP2_HEADERS_SENT', 'Response has already been initiated.');
    name = name.trim().toLowerCase();
    if (name === 'date') {
      this._state.sendDate = false;
      return;
    }
    delete this._headers[name];
  }

  setHeader(name, value) {
    if (typeof name !== 'string') throw invalidHeaderNameError(name);
    if (this.headersSent) throw http2Error('ERR_HTTP2_HEADERS_SENT', 'Response has already been initiated.');
    name = name.trim().toLowerCase();
    validateCompatHeader(name, value);
    this._headers[name] = value;
  }

  appendHeader(name, value) {
    if (typeof name !== 'string') throw invalidHeaderNameError(name);
    if (this.headersSent) throw http2Error('ERR_HTTP2_HEADERS_SENT', 'Response has already been initiated.');
    name = name.trim().toLowerCase();
    validateCompatHeader(name, value);
    if (!Object.hasOwn(this._headers, name)) return this.setHeader(name, value);
    const current = Array.isArray(this._headers[name]) ? this._headers[name] : [this._headers[name]];
    this._headers[name] = current.concat(Array.isArray(value) ? value : [value]);
  }

  get statusMessage() {
    warnUnsupportedStatusMessage(this._stream?._scope);
    return '';
  }

  set statusMessage(value) {
    warnUnsupportedStatusMessage(this._stream?._scope);
  }

  flushHeaders() {
    if (!this._state.closed && !this.headersSent) this.writeHead(this._state.statusCode);
  }

  writeHead(statusCode, statusMessage, headers) {
    if (this._state.closed || this._stream.destroyed || this._stream.closed) return this;
    if (this.headersSent) throw http2Error('ERR_HTTP2_HEADERS_SENT', 'Response has already been initiated.');
    if (typeof statusMessage === 'string') warnUnsupportedStatusMessage(this._stream?._scope);
    if (headers === undefined && statusMessage && typeof statusMessage === 'object') headers = statusMessage;

    if (Array.isArray(headers)) {
      const pairs = Array.isArray(headers[0]) ? headers : Array.from(
        { length: Math.ceil(headers.length / 2) },
        (_, index) => [headers[index * 2], headers[index * 2 + 1]],
      );
      if (headers.length % 2 !== 0 && !Array.isArray(headers[0])) {
        throw http2CompatError(TypeError, 'ERR_INVALID_ARG_VALUE', 'The "headers" argument is invalid');
      }
      for (const [name] of pairs) this.removeHeader(name);
      for (const [name, value] of pairs) this.appendHeader(name, value);
    } else if (headers && typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }

    this.statusCode = statusCode;
    this._stream.respond({ ...this._headers, ':status': this._state.statusCode }, {
      endStream: this._state.ending,
      sendDate: this._state.sendDate,
    });
    return this;
  }

  writeEarlyHints(hints) {
    if (hints === null || typeof hints !== 'object' || Array.isArray(hints)) {
      throw http2CompatError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "hints" argument must be of type object');
    }
    const link = hints.link;
    let linkValue;
    if (typeof link === 'string') linkValue = link;
    else if (Array.isArray(link)) linkValue = link.join(', ');
    else throw http2CompatError(TypeError, 'ERR_INVALID_ARG_VALUE', `The "hints" argument is invalid`);
    if (!linkValue) return false;
    if (this.headersSent || this._state.closed) return false;
    const headers = { ...hints, link: linkValue, ':status': constants.HTTP_STATUS_EARLY_HINTS };
    this._stream.additionalHeaders(headers);
    return true;
  }
}

export class ClientHttp2Session extends EventEmitter {
  constructor(authority, options, internal) {
    super();
    this._scope = internal.scope;
    this._vfs = internal.vfs;
    this._diagnostics = internal.diagnostics;
    this._performance = internal.performance;
    this._performanceStart = Number(this._scope?.performance?.now?.()) || 0;
    this._performanceRecorded = false;
    this._authority = authority;
    this._options = options;
    this._proxy = internal.proxy;
    this._server = internal.server;
    this._connection = internal.connection || null;
    this._serverHandshake = internal.serverHandshake === true;
    this._serverSession = null;
    this._trackTask = internal.trackTask;
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
    this._localWindowSize = this.localSettings.initialWindowSize;
    this.socket = this._connection || Object.freeze({ encrypted: true, alpnProtocol: 'h2', authorized: true });
    if (this._serverHandshake) {
      this._connected = true;
      this.connecting = false;
    } else {
      schedule(() => void this._connect());
    }
  }

  _retainTask() {
    if (!this._taskRelease && this._trackTask && !this.closed && !this.destroyed) {
      this._taskRelease = this._trackTask();
    }
  }

  _releaseIdleTask() {
    if (this.closed || this.destroyed || this.connecting || this._pendingRequests.length || this._streams.size) return;
    this._taskRelease?.();
    this._taskRelease = null;
  }

  async _connect() {
    try {
      const lookup = this._options?.lookup;
      if (typeof lookup === 'function') {
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = (error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve();
          };
          try {
            const result = lookup(this._authority.host, {}, done);
            if (result?.then) result.then(() => done(), done);
          } catch (error) {
            done(error);
          }
        });
      }
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
      const serverSession = this._connection?._peer?._http2ServerSession;
      if (serverSession) {
        this._serverSession = serverSession;
        serverSession._clientSession = this;
        serverSession._connected = true;
        serverSession.connecting = false;
        serverSession.socket = this._connection._peer;
        schedule(() => serverSession.emit('connect'));
      }
      this._connected = true;
      this.connecting = false;
      this.emit('connect', this);
      this.emit('remoteSettings', { ...this.remoteSettings });
      this.emit('localSettings', { ...this.localSettings });
      if (this._server) this._server._acceptSession(this);
      for (const stream of this._pendingRequests.splice(0)) this._dispatch(stream);
      this._releaseIdleTask();
    } catch (error) {
      this.destroy(error);
    }
  }

  request(headers = {}, options = {}) {
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_SESSION', 'Cannot create a stream on a closed session');
    this._retainTask();
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
    stream.once('close', () => {
      this._streams.delete(stream);
      this._releaseIdleTask();
    });
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
    const server = this._server || this._serverSession;
    if (server) {
      const serverStream = new VirtualHttp2Stream(server, { id: stream.id, role: 'server', headers: stream._headers });
      stream._peer = serverStream;
      serverStream._peer = stream;
      serverStream._acceptingInput = true;
      serverStream._publishCreatedDiagnostics(stream._headers);
      serverStream._publishStartDiagnostics(stream._headers);
      server.emit('stream', serverStream, { ...stream._headers }, 0);
      if (typeof this._performance === 'function' && !this._performanceRecorded) {
        this._performanceRecorded = true;
        const now = Number(this._scope?.performance?.now?.()) || this._performanceStart;
        this._performance({
          name: 'Http2Session',
          entryType: 'http2',
          startTime: this._performanceStart,
          duration: Math.max(0, now - this._performanceStart),
          detail: {
            type: 'client',
            framesReceived: 4 + (serverStream._wroteWithCallback ? 1 : 0),
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
      if (server.listenerCount('request') > 0 && typeof server._emitRequest === 'function') {
        server._emitRequest(serverStream, stream._headers);
      }
      const body = stream._bodyBytes();
      if (body.byteLength) serverStream.push(body);
      if (stream._inputEnded) {
        serverStream._acceptingInput = false;
        serverStream.push(null);
      }
      if (server.listenerCount('stream') === 0 && server.listenerCount('request') === 0) {
        schedule(() => {
          if (!serverStream.headersSent) serverStream.respond({ ':status': 200, 'x-bnh-virtual': '1' });
          if (!serverStream.closed) serverStream.end();
        });
      }
      return;
    }
    if (stream._ending || stream._writableState?.ending) {
      schedule(() => stream._receiveResponse({ ':status': 200, 'x-bnh-virtual': '1' }, null, true));
    }
  }

  settings(settings = {}) {
    if (!isRecord(settings)) throw new TypeError('HTTP/2 settings must be an object');
    this.localSettings = { ...this.localSettings, ...settings };
    this._retainTask();
    schedule(() => {
      this.emit('localSettings', { ...this.localSettings });
      this._releaseIdleTask();
    });
    return this;
  }

  setNextStreamID() {
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
    return nextStreamId;
  }

  get state() {
    return {
      effectiveLocalWindowSize: this._localWindowSize,
      localWindowSize: this._localWindowSize,
      remoteWindowSize: this.remoteSettings.initialWindowSize,
    };
  }

  setLocalWindowSize(windowSize) {
    if (this.closed || this.destroyed) throw http2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
    if (!Number.isInteger(windowSize) || windowSize < 0 || windowSize > constants.MAX_INITIAL_WINDOW_SIZE) {
      throw http2Error('ERR_HTTP2_INVALID_SETTING_VALUE', 'Invalid local window size');
    }
    this._localWindowSize = windowSize;
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
    for (const stream of [...this._streams]) {
      stream.destroy();
      if (!stream._closeEmitted) {
        stream._publishCloseDiagnostics();
        stream._emitClose();
      }
      if (!stream._closeEmitted) schedule(() => {
        stream._publishCloseDiagnostics();
        stream._emitClose();
      });
    }
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
    for (const stream of [...this._streams]) {
      const streamError = error || (!stream.writableFinished
        ? http2Error('ERR_HTTP2_SESSION_ERROR', 'The HTTP/2 session has been destroyed')
        : undefined);
      stream.destroy(streamError);
      if (!stream._closeEmitted) schedule(() => {
        stream._publishCloseDiagnostics();
        stream._emitClose();
      });
    }
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
    this._timeoutMilliseconds = 0;
    Object.defineProperty(this, 'timeout', {
      configurable: true,
      enumerable: true,
      get: () => this._timeoutMilliseconds,
      set: (milliseconds) => {
        this._timeoutMilliseconds = Number(milliseconds) || 0;
        for (const session of this._sessions) this._armSessionTimeout(session);
      },
    });
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
    this._armSessionTimeout(session);
    session.once('close', () => {
      if (session._serverTimeout) clearTimeout(session._serverTimeout);
      session._serverTimeout = null;
      this._sessions.delete(session);
    });
    this.emit('session', session);
  }

  _armSessionTimeout(session) {
    if (session._serverTimeout) clearTimeout(session._serverTimeout);
    session._serverTimeout = null;
    if (this._timeoutMilliseconds > 0 && !session.closed && !session.destroyed) {
      session._serverTimeout = setTimeout(() => {
      session._serverTimeout = null;
        if (!session.closed && !session.destroyed) {
          const handled = this.emit('timeout', session);
          if (!handled && !session.closed && !session.destroyed) session.close();
        }
      }, this._timeoutMilliseconds);
    }
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
    this.timeout = milliseconds;
    if (callback) this.once('timeout', callback);
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
    const connection = typeof connectOptions.createConnection === 'function'
      ? connectOptions.createConnection(target, connectOptions)
      : undefined;
    const session = new ClientHttp2Session(target, { ...connectOptions }, {
      scope,
      vfs: options.vfs,
      proxy: normalizeProxy(connectOptions.proxy, connectOptions.capability) || proxy,
      server,
      diagnostics,
      trackTask: options.trackTask,
      performance: options.performance,
      connection,
    });
    if (typeof listener === 'function') session.once('connect', listener);
    return session;
  }

  Object.defineProperty(connect, Symbol.for('nodejs.util.promisify.custom'), {
    configurable: true,
    value: function promisifiedConnect(authority, connectOptions) {
      return new Promise((resolve, reject) => {
        const session = connect(authority, connectOptions, () => {
          session.removeListener('error', reject);
          resolve(session);
        });
        session.once('error', reject);
      });
    },
  });

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
    getPackedSettings: (settings) => getPackedSettingsForScope(settings, scope),
    getUnpackedSettings,
    performServerHandshake,
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
