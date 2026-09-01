// Service Worker HTTP Gateway for Browser-Node-Harness
// Intercepts /__vhost__/:port/* and /__bnh_vnet__/:port/* navigation and fetch requests
// and routes them to the in-memory Node.js virtual HTTP server on the given port.

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const VHOST_PATTERN = /^https?:\/\/[^/]+\/(?:__vhost__|__bnh_vnet__)\/(\d+)(\/.*)?$/;
const GATEWAY_PROTOCOL_VERSION = 1;
const HARNESS_STATIC_PATTERNS = [
  /^\/runtime\//,
  /^\/wasm\//,
  /^\/tests\//,
  /^\/express-demo\.html/,
  /^\/favicon\.ico/,
  /^\/node_modules\//,
];

function isHarnessStaticPath(pathname) {
  return HARNESS_STATIC_PATTERNS.some((p) => p.test(pathname));
}

function gatewayResponseHeaders(headers = {}) {
  const result = new Headers(headers);
  // Virtual servers are run-scoped; cached responses can bypass a restarted server and its headers.
  result.set('cache-control', 'no-store');
  result.set('cross-origin-resource-policy', 'cross-origin');
  result.set('cross-origin-embedder-policy', 'require-corp');
  result.set('cross-origin-opener-policy', 'same-origin');
  return result;
}

function parseVhostUrl(urlString, referrerString) {
  if (!urlString) return null;
  try {
    const urlObj = new URL(urlString, 'http://localhost');

    // 1. Direct vhost URL (e.g. /__vhost__/3000/api/info or /__bnh_vnet__/3000)
    const directMatch = urlObj.pathname.match(/^\/(?:__vhost__|__bnh_vnet__)\/((?:r-[^/]+)\/)?(\d+)(\/.*)?$/);
    if (directMatch) {
      const routeId = directMatch[1] ? directMatch[1].slice(0, -1) : null;
      const port = parseInt(directMatch[2], 10);
      const subPath = directMatch[3] || '/';
      // Fragments stay in the browser document location and never belong in an HTTP request.
      return { port, routeId, version: Number(urlObj.searchParams.get('__bnh_gateway_version') || GATEWAY_PROTOCOL_VERSION), targetUrl: subPath + urlObj.search, source: 'direct' };
    }

    // 2. Referrer-based vhost URL (e.g. iframe navigating to root-relative /api/info)
    if (referrerString && !isHarnessStaticPath(urlObj.pathname)) {
      const refObj = new URL(referrerString, 'http://localhost');
      const refMatch = refObj.pathname.match(/^\/(?:__vhost__|__bnh_vnet__)\/((?:r-[^/]+)\/)?(\d+)/);
      if (refMatch) {
        const routeId = refMatch[1] ? refMatch[1].slice(0, -1) : null;
        const port = parseInt(refMatch[2], 10);
        return { port, routeId, version: Number(refObj.searchParams.get('__bnh_gateway_version') || GATEWAY_PROTOCOL_VERSION), targetUrl: urlObj.pathname + urlObj.search, source: 'referrer' };
      }
    }
  } catch {
    // ignore
  }

  return null;
}

self.addEventListener('fetch', (event) => {
  const virtualRequest = parseVhostUrl(event.request.url, event.request.referrer);
  if (virtualRequest?.source === 'direct') {
    event.respondWith(handleVirtualRequest(event.request, virtualRequest));
    return;
  }
  if (virtualRequest?.source === 'referrer' && event.request.mode === 'navigate') {
    event.respondWith(redirectToVirtualHost(event.request.url, virtualRequest.port, virtualRequest.routeId));
    return;
  }

  if (virtualRequest) {
    event.respondWith(handleVirtualRequest(event.request, virtualRequest));
    return;
  }

  // Fallback: Check if requesting client is inside a vhost frame
  try {
    const urlObj = new URL(event.request.url);
    if (!isHarnessStaticPath(urlObj.pathname) && event.clientId) {
      event.respondWith((async () => {
        try {
          const client = await self.clients.get(event.clientId);
          if (client && client.url) {
            const clientVhost = parseVhostUrl(client.url);
            if (clientVhost) {
              if (event.request.mode === 'navigate') {
                return redirectToVirtualHost(event.request.url, clientVhost.port, clientVhost.routeId);
              }
              const targetUrl = urlObj.pathname + urlObj.search;
              return await handleVirtualRequest(event.request, { port: clientVhost.port, routeId: clientVhost.routeId, version: clientVhost.version, targetUrl });
            }
          }
        } catch {
          // ignore
        }
        return fetch(event.request);
      })());
    }
  } catch {
    // ignore
  }
});

function redirectToVirtualHost(urlString, port, routeId = null) {
  const targetUrl = new URL(urlString);
  targetUrl.pathname = `/__vhost__/${routeId ? `${routeId}/` : ''}${port}${targetUrl.pathname}`;
  return Response.redirect(targetUrl.href, 307);
}

async function handleVirtualRequest(request, { port, routeId = null, version = GATEWAY_PROTOCOL_VERSION, targetUrl }) {
  // Find an active window client to forward the request to
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!allClients || allClients.length === 0) {
    return new Response('No active Nacelle Harness page found to handle virtual request', {
      status: 502,
      headers: gatewayResponseHeaders({
        'content-type': 'text/plain; charset=utf-8',
      }),
    });
  }

  // Always route to the top-level host window containing the Node runtime. The
  // Service Worker Client API calls this frame type "top-level"; a navigating
  // iframe may be the first client returned while its old document is closing.
  if (version !== GATEWAY_PROTOCOL_VERSION) {
    return new Response('Gateway protocol version mismatch', { status: 409, headers: gatewayResponseHeaders({ 'content-type': 'text/plain' }) });
  }
  const routeClients = routeId
    ? allClients.filter((client) => parseVhostUrl(client.url)?.routeId === routeId)
    : allClients;
  const targetClient = routeClients.find((c) => c.frameType === 'top-level')
    || routeClients.find((c) => c.frameType === 'top')
    || routeClients[0];
  if (!targetClient) return new Response('Gateway route is not bound to this client', { status: 409, headers: gatewayResponseHeaders({ 'content-type': 'text/plain' }) });

  const channel = new MessageChannel();
  const requestHeaders = {};
  for (const [key, val] of request.headers.entries()) {
    requestHeaders[key.toLowerCase()] = val;
  }

  let bodyBytes = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 0) bodyBytes = new Uint8Array(buffer);
    } catch {
      // ignore
    }
  }

  return new Promise((resolve) => {
    let headers = null;
    let statusCode = 200;
    let statusText = 'OK';
    const bodyChunks = [];
    let receivedBytes = 0;
    let contentLength = null;
    let settled = false;

    const cleanup = () => {
      channel.port1.removeEventListener?.('message', onResponseMessage);
      channel.port1.onmessage = null;
      channel.port1.close();
    };

    const finishResponse = (response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };

    const onResponseMessage = (msgEvent) => {
      const message = msgEvent.data;
      if (!message) return;

      if (message.type === 'bnh-vnet-response-start') {
        statusCode = message.statusCode || 200;
        statusText = message.statusText || 'OK';
        headers = gatewayResponseHeaders(message.headers || {});
        const declaredLength = headers.get('content-length');
        contentLength = declaredLength === null ? null : Number.parseInt(declaredLength, 10);
        if (!Number.isFinite(contentLength) || contentLength < 0) contentLength = null;
        if (!headers.has('access-control-allow-origin')) headers.set('access-control-allow-origin', '*');
        if (!headers.has('access-control-expose-headers')) headers.set('access-control-expose-headers', '*');
      } else if (message.type === 'bnh-vnet-response-chunk') {
        if (message.chunk) {
          let chunkBytes;
          if (typeof message.chunk.byteLength === 'number' && message.chunk.byteLength > 0) {
            if (message.chunk.buffer && typeof message.chunk.byteOffset === 'number') {
              chunkBytes = new Uint8Array(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength);
            } else {
              chunkBytes = new Uint8Array(message.chunk);
            }
          } else if (Array.isArray(message.chunk)) {
            chunkBytes = Uint8Array.from(message.chunk);
          } else if (typeof message.chunk === 'object') {
            chunkBytes = new Uint8Array(Object.values(message.chunk));
          } else {
            chunkBytes = new Uint8Array(0);
          }
          if (chunkBytes.byteLength > 0) {
            bodyChunks.push(chunkBytes);
            receivedBytes += chunkBytes.byteLength;
            if (contentLength !== null && receivedBytes >= contentLength) {
              finishResponse(createGatewayResponse());
            }
          }
        }
      } else if (message.type === 'bnh-vnet-response-end') {
        finishResponse(createGatewayResponse());
      } else if (message.type === 'bnh-vnet-response-error') {
        finishResponse(new Response(`Virtual Network Error: ${message.error || 'Connection refused'}`, {
          status: 502,
          headers: gatewayResponseHeaders({ 'content-type': 'text/plain; charset=utf-8' }),
        }));
      }
    };

    function createGatewayResponse() {
      let totalLen = 0;
      for (const c of bodyChunks) totalLen += c.byteLength;
      const fullBody = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of bodyChunks) {
        fullBody.set(c, offset);
        offset += c.byteLength;
      }
      if (!headers) {
        headers = gatewayResponseHeaders({
          'content-type': 'text/html; charset=utf-8',
          'access-control-allow-origin': '*',
        });
      }
      if (headers.has('content-length')) {
        headers.delete('content-length');
      }
      return new Response(fullBody, {
        status: statusCode,
        statusText,
        headers,
      });
    }

    channel.port1.onmessage = onResponseMessage;
    channel.port1.start?.();

    targetClient.postMessage({
      type: 'bnh-vnet-request',
      port,
      routeId,
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      method: request.method,
      url: targetUrl,
      headers: requestHeaders,
      body: bodyBytes,
    }, [channel.port2]);
  });
}
