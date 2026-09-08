import { gatewayError } from './gateway-selection.js';

export const GATEWAY_PROTOCOL = 'nacelle-direct-gateway';
export const GATEWAY_VERSION = 1;
export const CLIENT_CAPABILITIES = Object.freeze({ fetch: true, xhr: true, websocket: true, resourceRewrite: 1 });
const TOKEN = /^[!#$%&'*+.^_`|~\da-z-]+$/i;
const FORBIDDEN_HEADERS = new Set(['connection', 'content-length', 'cookie', 'cookie2', 'host',
  'origin', 'referer', 'proxy-authorization', 'proxy-authenticate', 'authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'keep-alive', 'accept-encoding', 'expect']);

export function normalizeVirtualUrl(input, { port = 3000, base = '/', websocket = false, pageUrl } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw gatewayError('ERR_GATEWAY_NAVIGATION', 'Invalid virtual server port');
  }
  if (typeof input !== 'string' || !input || /[\u0000-\u0020\u007f\\]/.test(input)) {
    throw gatewayError('ERR_GATEWAY_NAVIGATION', 'A virtual URL must be a nonempty URL without control characters');
  }
  const origin = `${websocket ? 'ws' : 'http'}://localhost:${port}`;
  let url;
  try { url = new URL(input, new URL(base, origin)); }
  catch { throw gatewayError('ERR_GATEWAY_NAVIGATION', 'Invalid virtual URL'); }
  if (websocket && url.protocol === 'http:') url.protocol = 'ws:';
  const allowed = websocket ? ['ws:'] : ['http:'];
  let hostOrigin = null;
  try { hostOrigin = new URL(pageUrl).host; } catch { /* no host in non-browser tests */ }
  if (!allowed.includes(url.protocol) || url.username || url.password
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || Number(url.port || (websocket ? 80 : 80)) !== port
    || (hostOrigin === url.host && /^[a-z][a-z\d+.-]*:|^\/\//i.test(input))
    || /^\/(?:__vhost__|__bnh_vnet__)(?:\/|$)/.test(url.pathname)
    || (websocket && url.hash)) {
    throw gatewayError('ERR_GATEWAY_NAVIGATION', 'Only this session\'s virtual server is accessible');
  }
  return url.pathname + url.search + url.hash;
}

export function normalizeRequestHeaders(input = {}) {
  if (!input || typeof input !== 'object') throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid headers');
  const entries = Array.isArray(input) ? input : typeof input.entries === 'function'
    ? [...input.entries()] : Object.entries(input);
  const result = Object.create(null);
  if (entries.length > 128) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'Too many request headers');
  let size = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid header entry');
    const [rawName, rawValue] = entry;
    if (typeof rawName !== 'string' || typeof rawValue !== 'string' || !TOKEN.test(rawName)
      || /[^\t\x20-\x7e\x80-\xff]/.test(rawValue)) {
      throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid header name or value');
    }
    const name = rawName.toLowerCase();
    size += name.length + rawValue.length;
    if (size > 32768) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'Request headers exceed 32 KiB');
    if (!FORBIDDEN_HEADERS.has(name) && !name.startsWith('sec-') && !name.startsWith('proxy-')) {
      result[name] = result[name] === undefined ? rawValue : `${result[name]}, ${rawValue}`;
    }
  }
  const connection = entries.filter(([name]) => name.toLowerCase() === 'connection').map(([, value]) => value).join(',');
  for (const name of connection.split(',')) delete result[name.trim().toLowerCase()];
  return result;
}

export function normalizeRequest(payload, context, maxBodyBytes) {
  if (!payload || typeof payload !== 'object') throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid request');
  const method = payload.method ?? 'GET';
  if (typeof method !== 'string' || !TOKEN.test(method) || ['CONNECT', 'TRACE', 'TRACK'].includes(method.toUpperCase())) {
    throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Unsupported HTTP method');
  }
  if (payload.credentials !== undefined && payload.credentials !== 'omit') {
    throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Direct requests require credentials: omit');
  }
  if (payload.mode !== undefined && !['cors', 'same-origin', 'no-cors', 'navigate'].includes(payload.mode)) {
    throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Unsupported request mode');
  }
  const redirect = payload.redirect ?? 'follow';
  if (!['follow', 'error', 'manual'].includes(redirect)) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid redirect mode');
  let body = payload.body;
  if (body == null) body = new Uint8Array();
  else if (typeof body === 'string') body = new TextEncoder().encode(body);
  else if (body instanceof ArrayBuffer) body = new Uint8Array(body);
  else if (!(body instanceof Uint8Array)) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Body must be bytes');
  if (body.byteLength > maxBodyBytes) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'Request body exceeds maxBodyBytes');
  if (['GET', 'HEAD'].includes(method.toUpperCase()) && body.byteLength) {
    throw gatewayError('ERR_GATEWAY_PROTOCOL', 'GET and HEAD cannot have request bodies');
  }
  return { path: normalizeVirtualUrl(payload.url ?? payload.path, context), method: method.toUpperCase(),
    headers: normalizeRequestHeaders(payload.headers), body, redirect };
}

export function createEnvelopePeer({ sessionId, nonce, send, onError }) {
  let outgoing = 0;
  let incoming = 0;
  let failed = false;
  return {
    send(type, payload = {}, transfer = []) {
      if (!failed) send({ protocol: GATEWAY_PROTOCOL, version: GATEWAY_VERSION, sessionId, nonce,
        sequence: ++outgoing, type, payload }, transfer);
    },
    receive(message) {
      if (failed) return false;
      if (!message || message.protocol !== GATEWAY_PROTOCOL || message.version !== GATEWAY_VERSION
        || message.sessionId !== sessionId || message.nonce !== nonce || typeof message.type !== 'string'
        || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)
        || !Number.isSafeInteger(message.sequence) || message.sequence < 1) {
        onError(gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid gateway envelope'));
        return false;
      }
      if (message.sequence <= incoming) return false;
      if (message.sequence !== incoming + 1) {
        failed = true;
        onError(gatewayError('ERR_GATEWAY_SEQUENCE', 'Gateway sequence gap; channel closed'));
        return false;
      }
      incoming = message.sequence;
      return true;
    },
  };
}
