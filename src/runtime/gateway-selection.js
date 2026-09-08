/** Transport selection is independent of browser side effects. */
export const DIRECT_GATEWAY_POLICY = Object.freeze({
  nestedIframes: 'unsupported',
  externalResources: 'deny',
  customResourceRewriter: 'unsupported',
  bootstrap: 'static-function-source-v1',
  resourceDelivery: 'parent-owned-blobs-with-document-local-mirrors',
  maxBodyBytes: 16 * 1024 * 1024,
  maxConcurrentRequests: 32,
  requestTimeoutMs: 30_000,
  maxRedirects: 20,
  maxResources: 1024,
  maxDiagnostics: 128,
});

export function gatewayError(code, message) {
  return Object.assign(new Error(message), { name: 'GatewayError', code });
}

export function normalizeGatewayOptions(value = true) {
  if (value === false) return Object.freeze({ mode: 'disabled' });
  if (value !== true && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw gatewayError('ERR_GATEWAY_MODE', 'gateway must be a boolean or an options object');
  }
  const options = value === true ? {} : value;
  const mode = options.mode ?? 'auto';
  if (!['auto', 'service-worker', 'direct-iframe'].includes(mode)) {
    throw gatewayError('ERR_GATEWAY_MODE', `Unknown gateway mode: ${String(mode)}`);
  }
  for (const key of ['swPath', 'scope']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key].trim())) {
      throw gatewayError('ERR_GATEWAY_MODE', `${key} must be a nonempty string`);
    }
  }
  for (const key of ['requestTimeoutMs', 'maxBodyBytes', 'maxConcurrentRequests']) {
    if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key] <= 0
      || (key === 'requestTimeoutMs' && options[key] > 2 ** 31 - 1))) {
      throw gatewayError('ERR_GATEWAY_MODE', `${key} must be a positive, finite integer`);
    }
  }
  return Object.freeze({
    ...options, mode, swPath: options.swPath ?? '/runtime/gateway-sw.js', scope: options.scope ?? '/',
    requestTimeoutMs: options.requestTimeoutMs ?? DIRECT_GATEWAY_POLICY.requestTimeoutMs,
    maxBodyBytes: options.maxBodyBytes ?? DIRECT_GATEWAY_POLICY.maxBodyBytes,
    maxConcurrentRequests: options.maxConcurrentRequests ?? DIRECT_GATEWAY_POLICY.maxConcurrentRequests,
  });
}

export function selectGateway({ requestedMode = 'auto', runtimeModuleUrl, pageUrl,
  serviceWorkerAvailable = false, serviceWorkerPath = '/runtime/gateway-sw.js' } = {}) {
  if (!['auto', 'disabled', 'service-worker', 'direct-iframe'].includes(requestedMode)) {
    throw gatewayError('ERR_GATEWAY_MODE', `Unknown gateway mode: ${String(requestedMode)}`);
  }
  const origin = value => { try { return new URL(value).origin; } catch { return null; } };
  const runtimeOrigin = origin(runtimeModuleUrl);
  const pageOrigin = origin(pageUrl);
  let mode = requestedMode;
  let reason = 'explicit';
  if (requestedMode === 'disabled') reason = 'disabled';
  if (requestedMode === 'auto') {
    if (!serviceWorkerAvailable) { mode = 'direct-iframe'; reason = 'service-worker-unavailable'; }
    else if (!runtimeOrigin || runtimeOrigin === 'null' || !pageOrigin || runtimeOrigin !== pageOrigin) {
      mode = 'direct-iframe'; reason = 'cross-origin-module';
    } else { mode = 'service-worker'; reason = 'same-origin-module'; }
  }
  return Object.freeze({ mode, reason, runtimeOrigin, pageOrigin, workerPath: serviceWorkerPath });
}
