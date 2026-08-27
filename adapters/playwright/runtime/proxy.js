import {
  DEFAULT_PROXY_CAPABILITY,
  PROXY_MODE_ADAPTER,
  normalizeProxyOperation,
  normalizeProxyRequest,
  normalizeProxySelection,
} from './proxy-contract.js';

const NODE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_PROXY',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_PROXY_INVALID_CONFIG',
]);

const PROXY_PROTOCOLS = new Set(['http:', 'https:']);

function invalidProxyConfig(message, details = {}, cause = undefined) {
  const error = proxyError('ERR_PROXY_INVALID_CONFIG', message, details, cause);
  error.name = 'TypeError';
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isResponseLike(value) {
  return isRecord(value)
    && Number.isInteger(value.status)
    && typeof value.arrayBuffer === 'function';
}

function proxyError(code, message, details = {}, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'ProxyCapabilityError';
  error.code = code;
  error.details = details;
  return error;
}

function errorCode(value) {
  const code = value?.code ?? value?.errno ?? value?.errorCode;
  if (typeof code === 'string') {
    const normalized = code.toUpperCase();
    if (NODE_ERROR_CODES.has(normalized) || normalized.startsWith('ERR_')) return normalized;
    if (normalized === 'ABORTERROR' || normalized === 'ABORT') return 'ABORT_ERR';
    if (normalized === 'TIMEOUT' || normalized === 'TIMEOUTERROR') return 'ETIMEDOUT';
  }
  if (value?.name === 'AbortError') return 'ABORT_ERR';
  if (value?.name === 'TimeoutError') return 'ETIMEDOUT';
  return 'ERR_PROXY';
}

function hasLineBreak(value) {
  return /[\r\n]/.test(String(value));
}

/** Normalize an HTTP proxy URL before it can become a browser request target. */
export function normalizeProxyURL(value, scope = globalThis) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidProxyConfig('Invalid proxy URL', { value });
  }
  if (hasLineBreak(value)) {
    throw invalidProxyConfig('Invalid proxy URL: credentials and authority must not contain CR or LF', { value });
  }
  let parsed;
  try {
    parsed = new scope.URL(value);
    if (!PROXY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) throw new Error('unsupported proxy protocol');
    // Accessing port makes URL implementations validate malformed numeric ports.
    const port = parsed.port ? Number(parsed.port) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error('invalid proxy port');
    }
    if (hasLineBreak(parsed.username) || hasLineBreak(parsed.password)) {
      throw new Error('invalid proxy credentials');
    }
  } catch (error) {
    throw invalidProxyConfig(`Invalid URL (invalid proxy URL): ${value}`, { value }, error);
  }
  return parsed;
}

/** Validate proxy environment values at configuration time, before any fetch. */
export function validateProxyEnvironment(proxyEnv, scope = globalThis) {
  if (proxyEnv === undefined || proxyEnv === null) return proxyEnv;
  for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY']) {
    if (proxyEnv[key] !== undefined && proxyEnv[key] !== '') normalizeProxyURL(String(proxyEnv[key]), scope);
  }
  return proxyEnv;
}

/** Reject request option values that could become injected HTTP authority data. */
export function validateProxyRequestOptions(options = {}) {
  for (const field of ['host', 'hostname', 'port']) {
    if (options[field] !== undefined && hasLineBreak(options[field])) {
      const error = new TypeError(`Invalid character in ${field}`);
      error.code = 'ERR_INVALID_CHAR';
      error.field = field;
      throw error;
    }
  }
  return options;
}

function ipv4Parts(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return null;
  return parts.map(Number);
}

function ipv4Number(parts) {
  return (((parts[0] * 256) + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function matchesIPv4Range(hostname, entry) {
  const [start, end] = entry.split('-', 2);
  const hostParts = ipv4Parts(hostname);
  const startParts = ipv4Parts(start);
  const endParts = ipv4Parts(end);
  return hostParts && startParts && endParts
    && ipv4Number(hostParts) >= ipv4Number(startParts)
    && ipv4Number(hostParts) <= ipv4Number(endParts);
}

function matchesIPv4Cidr(hostname, entry) {
  const [network, prefixText] = entry.split('/', 2);
  const hostParts = ipv4Parts(hostname);
  const networkParts = ipv4Parts(network);
  const prefix = Number(prefixText);
  if (!hostParts || !networkParts || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(hostParts) & mask) === (ipv4Number(networkParts) & mask);
}

/** Match Node's useful browser-safe NO_PROXY forms without resolving hostnames. */
export function matchesNoProxy(hostname, port, noProxy) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  const targetPort = Number(port);
  return String(noProxy || '').split(',').some((rawEntry) => {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry === '*') return true;
    let entryHost = entry;
    let entryPort;
    if (entry.startsWith('[')) {
      const closingBracket = entry.indexOf(']');
      if (closingBracket > -1) {
        entryHost = entry.slice(1, closingBracket);
        if (entry[closingBracket + 1] === ':') entryPort = entry.slice(closingBracket + 2);
      }
    } else {
      const separator = entry.lastIndexOf(':');
      if (separator > -1 && entry.indexOf(':') === separator) {
        entryHost = entry.slice(0, separator);
        entryPort = entry.slice(separator + 1);
      }
    }
    if (entryPort !== undefined && Number(entryPort) !== targetPort) return false;
    entryHost = entryHost.replace(/^\[|\]$/g, '');
    if (entryHost.includes('-') && matchesIPv4Range(host, entryHost)) return true;
    if (entryHost.includes('/') && matchesIPv4Cidr(host, entryHost)) return true;
    if (entryHost.startsWith('*.')) return host.endsWith(entryHost.slice(1));
    if (entryHost.startsWith('.')) return host.endsWith(entryHost) || host === entryHost.slice(1);
    return host === entryHost || host.endsWith(`.${entryHost}`);
  });
}

/** Convert adapter failures into errors that Node network callers understand. */
export function normalizeProxyError(value, context = {}) {
  if (value?.name === 'ProxyCapabilityError' && value.code) return value;
  const source = value instanceof Error ? value : new Error(
    typeof value === 'string' ? value : value?.message || 'proxy adapter failed',
  );
  const code = errorCode(value);
  const error = proxyError(code, source.message, {
    operation: context.operation,
    target: context.target,
  }, source);
  error.name = source.name || 'Error';
  for (const field of ['errno', 'syscall', 'hostname', 'address', 'port']) {
    if (source[field] !== undefined) error[field] = source[field];
  }
  if (error.errno === undefined && code.startsWith('E')) error.errno = code;
  return error;
}

/** Normalize an adapter response while retaining module-specific response fields. */
export function normalizeProxyResult(result, context = {}) {
  // Response metadata is exposed through accessors, so spreading a browser
  // Response would silently turn a successful proxy response into an empty object.
  // Check this before `ok === false`: HTTP error statuses are still responses.
  if (isResponseLike(result)) return result;
  if (isRecord(result) && (result.ok === false || result.error !== undefined || result.errorCode !== undefined)) {
    throw normalizeProxyError(result.error ?? result, context);
  }
  if (!isRecord(result)) return result;
  const normalized = { ...result };
  if (normalized.statusCode === undefined && Number.isInteger(normalized.status)) {
    normalized.statusCode = normalized.status;
  }
  if (normalized.code !== undefined) normalized.code = String(normalized.code).toUpperCase();
  return normalized;
}

function assertProxyCallAllowed(selection, operation) {
  if (selection.mode !== PROXY_MODE_ADAPTER || !selection.enabled) {
    throw proxyError('ERR_PROXY_NOT_OPTED_IN', `proxy ${operation} calls are not enabled`);
  }
  if (!selection.capabilityGranted) {
    throw proxyError('ERR_CAPABILITY_DENIED', `proxy ${operation} capability was not granted`, {
      key: selection.capabilityKey,
    });
  }
  if (selection.adapter === null) {
    throw proxyError('ERR_PROXY_ADAPTER_MISSING', `proxy ${operation} requires an explicit adapter`);
  }
}

function adapterMethod(adapter, operation) {
  if (typeof adapter === 'function') return adapter;
  if (typeof adapter[operation] === 'function') return adapter[operation].bind(adapter);
  if (typeof adapter.handle === 'function') return adapter.handle.bind(adapter);
  throw proxyError('ERR_PROXY_ADAPTER_INVALID', `proxy adapter does not implement ${operation}()`);
}

/** Invoke an explicitly supplied adapter; this function never creates host I/O. */
export async function callProxy(selection, operation = 'request', request = {}) {
  const normalizedOperation = normalizeProxyOperation(operation);
  const normalizedSelection = selection?.mode
    && typeof selection.enabled === 'boolean'
    && typeof selection.capabilityGranted === 'boolean'
    ? selection
    : normalizeProxySelection(selection, { capability: selection?.capability });
  assertProxyCallAllowed(normalizedSelection, normalizedOperation);
  const normalizedRequest = normalizeProxyRequest(normalizedOperation, request, normalizedSelection);
  const method = adapterMethod(normalizedSelection.adapter, normalizedOperation);
  try {
    const result = await method(normalizedRequest);
    return normalizeProxyResult(result, normalizedRequest);
  } catch (error) {
    throw normalizeProxyError(error, normalizedRequest);
  }
}

/** Build the run-scoped proxy surface consumed later by network, TLS, and HTTP modules. */
export function createProxyCapability(options = {}) {
  const selectionInput = options.selection ?? options;
  const selection = normalizeProxySelection(selectionInput, {
    capability: options.capability,
    capabilities: options.capabilities,
    runId: options.runId,
  });
  const call = (operation, request) => callProxy(selection, operation, request);
  return Object.freeze({
    ...selection,
    call,
    request: (request) => call('request', request),
    connect: (request) => call('connect', request),
    send: (request) => call('send', request),
    resolve: (request) => call('resolve', request),
    tls: (request) => call('tls', request),
  });
}

export const createProxyTransport = createProxyCapability;
export const invokeProxy = callProxy;
export { DEFAULT_PROXY_CAPABILITY };
