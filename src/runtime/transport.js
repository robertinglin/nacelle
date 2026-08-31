function transportError(code, message) {
  const error = new Error(message);
  error.name = 'NacelleTransportError';
  error.code = code;
  return error;
}

function isAdapter(value) {
  return typeof value === 'function'
    || (value !== null && typeof value === 'object' && typeof value.request === 'function');
}

function invokeAdapter(adapter, request) {
  if (typeof adapter === 'function') return adapter(request);
  return adapter.request(request);
}

function requestInit(request) {
  const init = {
    method: request.method || 'GET',
    headers: request.headers,
    redirect: request.redirect,
    signal: request.signal,
  };
  if (!['GET', 'HEAD'].includes(String(init.method).toUpperCase()) && request.body !== undefined) {
    init.body = request.body;
  }
  return init;
}

/** Browser fetch rejects CORS failures as TypeError without a portable code. */
export function isBrowserFetchFailure(error) {
  return error?.name === 'TypeError'
    || error?.code === 'ERR_NETWORK'
    || error?.code === 'ERR_FAILED';
}

/**
 * Compose normal browser fetch with an explicitly supplied privileged adapter.
 * The adapter is only called after native fetch rejects with a browser network
 * failure, keeping the extension out of requests that the page can already make.
 */
export function createNegotiatedTransport({ globalObject = globalThis, adapter, fallback = true } = {}) {
  if (!isAdapter(adapter)) {
    throw transportError('ERR_INVALID_TRANSPORT_ADAPTER', 'a request adapter is required');
  }
  const nativeFetch = typeof globalObject.fetch === 'function' ? globalObject.fetch.bind(globalObject) : null;

  const request = async (proxyRequest) => {
    const target = String(proxyRequest?.target || proxyRequest?.url || '');
    if (!target) throw transportError('ERR_INVALID_TRANSPORT_REQUEST', 'a request target is required');
    const method = String(proxyRequest.method || 'GET').toUpperCase();
    // A browser failure is not proof that the request was not sent. Unsafe
    // methods must be owned by the privileged adapter before any page fetch.
    if (!['GET', 'HEAD'].includes(method)) return invokeAdapter(adapter, { ...proxyRequest, method });
    if (!fallback || !nativeFetch) return invokeAdapter(adapter, proxyRequest);
    try {
      return await nativeFetch(target, requestInit({ ...proxyRequest, method }));
    } catch (error) {
      if (!isBrowserFetchFailure(error)) throw error;
      return invokeAdapter(adapter, { ...proxyRequest, method, fallbackReason: 'cors' });
    }
  };

  const negotiated = {
    mode: 'negotiated',
    adapter: Object.freeze({ request }),
    request,
    close() {
      adapter.close?.();
    },
    fetch(input, init = {}) {
      const target = String(input?.url || input);
      return request({
        target,
        method: init.method || 'GET',
        headers: init.headers,
        redirect: init.redirect,
        body: init.body,
        signal: init.signal,
      });
    },
  };
  return Object.freeze(negotiated);
}
