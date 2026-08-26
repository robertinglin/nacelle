function missing(name) {
  return (..._args) => {
    throw new TypeError(`${name} is not available in this browser context`);
  };
}

function bindOptional(scope, name) {
  const value = scope[name];
  return typeof value === 'function' ? value.bind(scope) : value;
}

function normalizeDataURL(input, scope) {
  if (typeof scope.URL !== 'function' || !(input instanceof scope.URL) || input.protocol !== 'data:') {
    return input;
  }
  if (!input.search && !input.hash) return input;
  const normalized = new scope.URL(input.href);
  normalized.search = '';
  normalized.hash = '';
  return normalized;
}

/** Return the browser's network objects without importing a host transport. */
export function createNetworkPrimitives(scope = globalThis) {
  const nativeFetch = typeof scope.fetch === 'function' ? scope.fetch.bind(scope) : null;
  const fetch = typeof scope.fetch === 'function'
    ? (input, init) => nativeFetch(normalizeDataURL(input, scope), init)
    : missing('fetch');
  return {
    URL: scope.URL,
    URLSearchParams: scope.URLSearchParams,
    Headers: scope.Headers,
    Request: scope.Request,
    Response: scope.Response,
    AbortController: scope.AbortController,
    AbortSignal: scope.AbortSignal,
    WebSocket: scope.WebSocket,
    Blob: scope.Blob,
    File: scope.File,
    FormData: scope.FormData,
    fetch,
    request: (input, init) => fetch(input, init),
    async fetchText(input, init) {
      return (await fetch(input, init)).text();
    },
    async fetchJson(input, init) {
      return (await fetch(input, init)).json();
    },
    async fetchBytes(input, init) {
      return new Uint8Array(await (await fetch(input, init)).arrayBuffer());
    },
    createAbortController: () => {
      if (typeof scope.AbortController !== 'function') throw new TypeError('AbortController is unavailable');
      return new scope.AbortController();
    },
    createWebSocket: (...args) => {
      if (typeof scope.WebSocket !== 'function') throw new TypeError('WebSocket is unavailable');
      return new scope.WebSocket(...args);
    },
  };
}

/** Expose browser methods that are useful when callers do not need wrappers. */
export function createBrowserNetworkGlobals(scope = globalThis) {
  return {
    URL: scope.URL,
    URLSearchParams: scope.URLSearchParams,
    Headers: scope.Headers,
    Request: scope.Request,
    Response: scope.Response,
    AbortController: scope.AbortController,
    AbortSignal: scope.AbortSignal,
    WebSocket: scope.WebSocket,
    fetch: bindOptional(scope, 'fetch'),
  };
}
