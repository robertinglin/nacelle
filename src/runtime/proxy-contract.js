export const PROXY_MODE_VIRTUAL = 'virtual';
export const PROXY_MODE_ADAPTER = 'proxy';
export const PROXY_MODE_PROXY = PROXY_MODE_ADAPTER;
export const DEFAULT_PROXY_MODE = PROXY_MODE_VIRTUAL;
export const DEFAULT_PROXY_CAPABILITY = 'proxy';

export const PROXY_OPERATIONS = Object.freeze([
  'request',
  'connect',
  'send',
  'resolve',
  'tls',
]);

const VALID_PROXY_MODES = new Set([PROXY_MODE_VIRTUAL, PROXY_MODE_ADAPTER]);
const VALID_PROXY_OPERATIONS = new Set(PROXY_OPERATIONS);

function proxyError(code, message, details = {}) {
  const error = new TypeError(message);
  error.name = 'ProxyCapabilityError';
  error.code = code;
  error.details = details;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAdapter(value) {
  if (typeof value === 'function') return true;
  return isRecord(value) && ['request', 'connect', 'send', 'resolve', 'tls', 'handle'].some((name) => (
    typeof value[name] === 'function'
  ));
}

function capabilityIsGranted(grant, key) {
  if (grant === true) return true;
  if (grant === false || grant === undefined || grant === null) return false;
  if (Array.isArray(grant)) return grant.includes(key);
  if (!isRecord(grant)) return false;
  if (Object.hasOwn(grant, key)) return capabilityIsGranted(grant[key], key);
  if (Array.isArray(grant.allowed)) return grant.allowed.includes(key);
  if (Array.isArray(grant.keys)) return grant.keys.includes(key);
  return grant.enabled === true || grant.allow === true || grant.allowed === true;
}

/** Normalize the explicit capability grant used by one browser run. */
export function normalizeProxyGrant(grant, key = DEFAULT_PROXY_CAPABILITY) {
  if (typeof key !== 'string' || !key) {
    throw proxyError('ERR_INVALID_PROXY_CAPABILITY', 'proxy capability key must be a non-empty string', { key });
  }
  return Object.freeze({ key, granted: capabilityIsGranted(grant, key) });
}

/** Normalize transport selection without importing or contacting a host transport. */
export function normalizeProxySelection(selection = {}, { capability, capabilities, runId } = {}) {
  const source = typeof selection === 'function' ? { adapter: selection, mode: PROXY_MODE_ADAPTER } : selection;
  if (source === null || source === undefined) return normalizeProxySelection({}, { capability, capabilities, runId });
  if (!isRecord(source)) {
    throw proxyError('ERR_INVALID_PROXY_SELECTION', 'proxy selection must be an object or callback');
  }

  const mode = source.mode ?? DEFAULT_PROXY_MODE;
  if (!VALID_PROXY_MODES.has(mode)) {
    throw proxyError('ERR_INVALID_PROXY_MODE', `unsupported proxy mode: ${mode}`, { mode });
  }

  const adapter = source.adapter ?? source.callback ?? null;
  if (adapter !== null && !isAdapter(adapter)) {
    throw proxyError('ERR_INVALID_PROXY_ADAPTER', 'proxy adapter must be a callback or operation object');
  }

  const capabilityKey = source.capabilityKey ?? source.capabilityName ?? DEFAULT_PROXY_CAPABILITY;
  const grant = source.capability ?? capability ?? source.capabilities ?? capabilities;
  const capabilityGrant = isRecord(grant)
    && grant.key === capabilityKey
    && typeof grant.granted === 'boolean'
    ? Object.freeze({ key: capabilityKey, granted: grant.granted })
    : normalizeProxyGrant(grant, capabilityKey);
  const enabled = source.enabled ?? source.optIn ?? mode === PROXY_MODE_ADAPTER;

  if (typeof enabled !== 'boolean') {
    throw proxyError('ERR_INVALID_PROXY_SELECTION', 'proxy enabled/optIn must be boolean');
  }

  return Object.freeze({
    runId: source.runId ?? runId ?? null,
    mode,
    enabled: mode === PROXY_MODE_ADAPTER && enabled,
    adapter,
    capability: capabilityGrant,
    capabilityKey: capabilityGrant.key,
    capabilityGranted: capabilityGrant.granted,
  });
}

export function normalizeProxyOperation(operation) {
  const value = operation ?? 'request';
  if (!VALID_PROXY_OPERATIONS.has(value)) {
    throw proxyError('ERR_INVALID_PROXY_OPERATION', `unsupported proxy operation: ${value}`, { operation: value });
  }
  return value;
}

export function normalizeProxyRequest(operation, request = {}, selection = {}) {
  const normalizedOperation = normalizeProxyOperation(operation);
  if (!isRecord(request)) {
    throw proxyError('ERR_INVALID_PROXY_REQUEST', 'proxy request must be an object', { operation: normalizedOperation });
  }
  return {
    ...request,
    operation: normalizedOperation,
    runId: request.runId ?? selection.runId ?? null,
    target: request.target ?? request.url ?? request.href ?? null,
  };
}

export function isProxyAdapter(value) {
  return isAdapter(value);
}

export const normalizeProxyTransport = normalizeProxySelection;
