import { NacelleError, redactTrace } from './tracing.js';

const encoder = new TextEncoder();

function denied(code, message, details = {}) {
  return new NacelleError(code, message, details);
}

function canonicalRequest(request) {
  return [request.name, request.origin, String(request.method || 'GET').toUpperCase(), request.path, request.bodyHash || ''].join('\n');
}

function fallbackSignature(secret, message) {
  let hash = 2166136261;
  for (const byte of encoder.encode(`${secret}\n${message}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Named secret broker: user code can request signatures, never key material. */
export function createSecretBroker({ secrets = {}, origins = [], globalObject = globalThis, signer } = {}) {
  const allowedOrigins = new Set(origins.map((value) => new URL(value).origin));
  const secretMap = new Map(Object.entries(secrets).map(([name, value]) => [String(name), String(value)]));
  const assertOrigin = (origin) => {
    let normalized;
    try { normalized = new URL(origin).origin; } catch { throw denied('ERR_SECRET_ORIGIN_DENIED', 'secret origin is invalid'); }
    if (!allowedOrigins.has(normalized)) throw denied('ERR_SECRET_ORIGIN_DENIED', 'secret origin is not granted', { origin: normalized });
    return normalized;
  };
  return Object.freeze({
    async get() { throw denied('ERR_SECRET_RAW_ACCESS', 'raw secret access is unavailable'); },
    async signRequest(request = {}) {
      const name = String(request.name || '');
      const secret = secretMap.get(name);
      if (!secret) throw denied('ERR_SECRET_NOT_FOUND', `secret is not granted: ${name}`);
      const origin = assertOrigin(request.origin);
      const normalized = { ...request, name, origin, method: String(request.method || 'GET').toUpperCase(), path: String(request.path || '/') };
      const message = canonicalRequest(normalized);
      const signature = signer
        ? await signer({ name, origin, method: normalized.method, path: normalized.path, bodyHash: normalized.bodyHash || '', message })
        : globalObject.crypto?.subtle
          ? await (async () => {
            const key = await globalObject.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            const bytes = await globalObject.crypto.subtle.sign('HMAC', key, encoder.encode(message));
            return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
          })()
          : fallbackSignature(secret, message);
      return Object.freeze({ name, origin, method: normalized.method, path: normalized.path, signature: String(signature) });
    },
    redact(value) { return redactTrace(value); },
  });
}
