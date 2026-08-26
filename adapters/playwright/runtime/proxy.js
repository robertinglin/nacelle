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
]);

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
