const NacellePlusPolicy = (() => {
  const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
  const MAX_HEADER_COUNT = 128;
  const MAX_HEADER_VALUE_BYTES = 64 * 1024;
  const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  const METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
  const REDIRECT_MODES = new Set(['follow', 'manual', 'error']);
  const FORBIDDEN_HEADERS = new Set([
    'connection', 'content-length', 'cookie', 'host', 'origin', 'referer',
    'set-cookie', 'transfer-encoding', 'upgrade',
  ]);

  function failure(code, message, details = {}) {
    return { ok: false, error: { code, message, details } };
  }

  function byteLength(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (Array.isArray(value)) return value.length;
    return Infinity;
  }

  function origin(value) {
    let parsed;
    try { parsed = new URL(String(value)); } catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.origin;
  }

  function isPrivateOrigin(value) {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa') || hostname.endsWith('.lan')) return true;
    if (hostname === '0.0.0.0' || hostname === '::') return true;
    if (hostname.startsWith('::ffff:')) {
      const mapped = hostname.slice('::ffff:'.length);
      if (mapped.includes('.') && isPrivateOrigin(`http://${mapped}`)) return true;
      const groups = mapped.split(':');
      if (groups.length === 2 && groups.every((group) => /^[\da-f]{1,4}$/.test(group))) {
        const high = Number.parseInt(groups[0], 16);
        const low = Number.parseInt(groups[1], 16);
        const ipv4 = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
        if (isPrivateOrigin(`http://${ipv4}`)) return true;
      }
    }
    if (hostname === 'metadata.google.internal' || hostname === 'instance-data') return true;
    if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')) return true;
    const parts = hostname.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 192 && parts[1] === 0)
      || (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19)
      || parts[0] >= 224;
  }

  function validateRequest(request) {
    if (!request || typeof request !== 'object') return failure('ERR_NACELLE_PLUS_PROTOCOL', 'request must be an object');
    if (!origin(request.target)) return failure('ERR_INVALID_URL', 'Nacelle+ only supports credential-free HTTP(S) targets');
    const method = String(request.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) return failure('ERR_NACELLE_PLUS_METHOD', `unsupported HTTP method: ${method}`);
    if (request.redirect !== undefined && !REDIRECT_MODES.has(request.redirect)) {
      return failure('ERR_NACELLE_PLUS_REDIRECT', `unsupported redirect mode: ${request.redirect}`);
    }
    if (request.headers !== undefined && (typeof request.headers !== 'object' || Array.isArray(request.headers))) {
      return failure('ERR_NACELLE_PLUS_HEADERS', 'request headers must be an object');
    }
    const headers = request.headers || {};
    if (Object.keys(headers).length > MAX_HEADER_COUNT) {
      return failure('ERR_NACELLE_PLUS_HEADERS', 'request contains too many headers');
    }
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(value))) {
        return failure('ERR_NACELLE_PLUS_HEADERS', `invalid request header: ${name}`);
      }
      if (new TextEncoder().encode(String(value)).byteLength > MAX_HEADER_VALUE_BYTES) {
        return failure('ERR_NACELLE_PLUS_HEADERS', `request header is too large: ${name}`);
      }
      if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-')) {
        return failure('ERR_NACELLE_PLUS_FORBIDDEN_HEADER', `request header is controlled by the browser: ${name}`);
      }
    }
    if (byteLength(request.body) > MAX_REQUEST_BODY_BYTES) {
      return failure('ERR_NACELLE_PLUS_REQUEST_TOO_LARGE', 'Nacelle+ request body exceeds the 16 MiB limit');
    }
    return null;
  }

  function redirectTarget(current, response, request) {
    const location = response.headers.get('location');
    if (!location) return null;
    let target;
    try { target = new URL(location, current); } catch { return { error: failure('ERR_NACELLE_PLUS_REDIRECT', 'redirect location is not a valid URL') }; }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      return { error: failure('ERR_NACELLE_PLUS_REDIRECT', 'redirect target must be a credential-free HTTP(S) URL') };
    }
    const method = String(request.method).toUpperCase();
    const changesToGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST');
    const headers = { ...request.headers };
    if (target.origin !== new URL(current).origin) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'authorization') delete headers[name];
      }
    }
    return {
      target: target.href,
      method: changesToGet ? 'GET' : request.method,
      headers,
      body: changesToGet ? undefined : request.body,
    };
  }

  return Object.freeze({
    isRequestId: (value) => REQUEST_ID_PATTERN.test(String(value || '')),
    isPrivateOrigin,
    redirectTarget,
    validateRequest,
  });
})();
