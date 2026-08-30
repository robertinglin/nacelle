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

function parseVhostUrl(urlString, referrerString) {
  if (!urlString) return null;
  try {
    const urlObj = new URL(urlString, 'http://localhost');

    // 1. Direct vhost URL (e.g. /__vhost__/3000/api/info or /__bnh_vnet__/3000)
    const directMatch = urlObj.pathname.match(/^\/(?:__vhost__|__bnh_vnet__)\/(\d+)(\/.*)?$/);
    if (directMatch) {
      const port = parseInt(directMatch[1], 10);
      const subPath = directMatch[2] || '/';
      return { port, targetUrl: subPath + urlObj.search };
    }

    // 2. Referrer-based vhost URL (e.g. iframe navigating to root-relative /api/info)
    if (referrerString && !isHarnessStaticPath(urlObj.pathname)) {
      const refObj = new URL(referrerString, 'http://localhost');
      const refMatch = refObj.pathname.match(/^\/(?:__vhost__|__bnh_vnet__)\/(\d+)/);
      if (refMatch) {
        const port = parseInt(refMatch[1], 10);
        return { port, targetUrl: urlObj.pathname + urlObj.search };
      }
    }
  } catch {
    // ignore
  }

  return null;
}

self.addEventListener('fetch', (event) => {
  const directVhost = parseVhostUrl(event.request.url, event.request.referrer);
  if (directVhost) {
    event.respondWith(handleVirtualRequest(event.request, directVhost));
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
              const targetUrl = urlObj.pathname + urlObj.search;
              return await handleVirtualRequest(event.request, { port: clientVhost.port, targetUrl });
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

async function handleVirtualRequest(request, { port, targetUrl }) {
  // Find an active window client to forward the request to
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!allClients || allClients.length === 0) {
    return new Response('No active Browser Node Harness page found to handle virtual request', {
      status: 502,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cross-origin-resource-policy': 'cross-origin',
      },
    });
  }

  // Always route to the top-level host window containing the Node runtime
  const targetClient = allClients.find((c) => c.frameType === 'top') || allClients[0];

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

    const timeout = setTimeout(() => {
      resolve(new Response('Gateway Timeout: In-browser Node server did not respond in time', {
        status: 504,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }));
    }, 15000);

    channel.port1.onmessage = (msgEvent) => {
      const message = msgEvent.data;
      if (!message) return;

      if (message.type === 'bnh-vnet-response-start') {
        statusCode = message.statusCode || 200;
        statusText = message.statusText || 'OK';
        headers = new Headers(message.headers || {});
        if (!headers.has('cross-origin-resource-policy')) headers.set('cross-origin-resource-policy', 'cross-origin');
        if (!headers.has('cross-origin-embedder-policy')) headers.set('cross-origin-embedder-policy', 'require-corp');
        if (!headers.has('cross-origin-opener-policy')) headers.set('cross-origin-opener-policy', 'same-origin');
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
          }
        }
      } else if (message.type === 'bnh-vnet-response-end') {
        clearTimeout(timeout);
        channel.port1.close();
        let totalLen = 0;
        for (const c of bodyChunks) totalLen += c.byteLength;
        const fullBody = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of bodyChunks) {
          fullBody.set(c, offset);
          offset += c.byteLength;
        }
        if (!headers) {
          headers = new Headers({
            'content-type': 'text/html; charset=utf-8',
            'cross-origin-resource-policy': 'cross-origin',
            'access-control-allow-origin': '*',
          });
        }
        if (headers.has('content-length')) {
          headers.delete('content-length');
        }
        resolve(new Response(fullBody, {
          status: statusCode,
          statusText,
          headers,
        }));
      } else if (message.type === 'bnh-vnet-response-error') {
        clearTimeout(timeout);
        channel.port1.close();
        resolve(new Response(`Virtual Network Error: ${message.error || 'Connection refused'}`, {
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }));
      }
    };

    targetClient.postMessage({
      type: 'bnh-vnet-request',
      port,
      method: request.method,
      url: targetUrl,
      headers: requestHeaders,
      body: bodyBytes,
    }, [channel.port2]);
  });
}
