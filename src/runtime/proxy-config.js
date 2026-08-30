import { normalizeProxyURL, validateProxyEnvironment } from './proxy.js';

function proxyEnvironmentValue(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.map(String).join(',') : String(value);
}

/**
 * Build the small proxy configuration accepted by Nacelle.create().
 * Environment values are kept explicit because the virtual Node process uses
 * the same HTTP_PROXY/NO_PROXY conventions as native Node.
 */
export function createProxyConfig(options = {}, scope = globalThis) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('proxy configuration must be an object');
  }
  if (options.env !== undefined
    && (options.env === null || typeof options.env !== 'object' || Array.isArray(options.env))) {
    throw new TypeError('proxy configuration env must be an object');
  }
  const sharedProxy = options.url ?? options.proxyUrl;
  const httpProxy = options.httpProxy ?? options.http ?? sharedProxy;
  const httpsProxy = options.httpsProxy ?? options.https ?? sharedProxy;
  const noProxy = proxyEnvironmentValue(options.noProxy ?? options.no_proxy);
  const configured = { ...(options.env || {}) };
  if (httpProxy !== undefined) {
    const parsed = normalizeProxyURL(String(httpProxy), scope);
    configured.http_proxy = parsed.href;
    configured.HTTP_PROXY = parsed.href;
  }
  if (httpsProxy !== undefined) {
    const parsed = normalizeProxyURL(String(httpsProxy), scope);
    configured.https_proxy = parsed.href;
    configured.HTTPS_PROXY = parsed.href;
  }
  if (noProxy !== undefined) {
    configured.no_proxy = noProxy;
    configured.NO_PROXY = noProxy;
  }
  const hasEnvironmentProxy = httpProxy !== undefined || httpsProxy !== undefined;
  if (hasEnvironmentProxy) configured.NODE_USE_ENV_PROXY = options.useEnvProxy === false ? '0' : '1';
  validateProxyEnvironment(configured, scope);

  const mode = options.mode ?? (options.adapter ? 'proxy' : 'virtual');
  const enabled = options.enabled ?? Boolean(options.adapter);
  const capability = options.capability ?? Boolean(options.adapter);
  return Object.freeze({
    ...options,
    mode,
    enabled,
    capability,
    env: Object.freeze(configured),
  });
}
