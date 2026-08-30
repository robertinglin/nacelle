const api = globalThis.browser || globalThis.chrome;
const isFirefox = Boolean(globalThis.browser);
const GRANTS_KEY = 'nacellePlusGrants';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function call(target, method, ...args) {
  if (isFirefox) return Promise.resolve(target[method](...args));
  return new Promise((resolve, reject) => {
    target[method](...args, (value) => {
      const error = api.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    });
  });
}

function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

function originFrom(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  return parsed.origin;
}

function permissionPattern(origin) {
  const parsed = new URL(origin);
  return `${parsed.protocol}//${parsed.host}/*`;
}

function senderPageOrigin(sender) {
  return originFrom(sender?.tab?.url || sender?.url);
}

async function grants() {
  const stored = await call(api.storage.local, 'get', GRANTS_KEY);
  return stored?.[GRANTS_KEY] && typeof stored[GRANTS_KEY] === 'object' ? stored[GRANTS_KEY] : {};
}

async function saveGrant(pageOrigin, targetOrigin) {
  const current = await grants();
  const targets = new Set(Array.isArray(current[pageOrigin]) ? current[pageOrigin] : []);
  targets.add(targetOrigin);
  current[pageOrigin] = [...targets].sort();
  await call(api.storage.local, 'set', [{ [GRANTS_KEY]: current }]);
}

async function isGranted(pageOrigin, targetOrigin) {
  const current = await grants();
  if (!current[pageOrigin]?.includes(targetOrigin)) return false;
  return call(api.permissions, 'contains', { origins: [permissionPattern(targetOrigin)] });
}

function extensionSender(sender) {
  return typeof sender?.url === 'string' && sender.url.startsWith(`${api.runtime.getURL('')}`);
}

function normalizeHeaders(value) {
  const headers = {};
  if (!value || typeof value !== 'object') return headers;
  for (const [name, headerValue] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (['connection', 'content-length', 'host', 'origin', 'referer'].includes(lower)) continue;
    headers[name] = String(headerValue);
  }
  return headers;
}

function normalizeBody(value) {
  if (value === undefined || value === null) return undefined;
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  return String(value);
}

async function requestTarget(request, pageOrigin) {
  const targetOrigin = originFrom(request?.target);
  if (!targetOrigin) return failure('ERR_INVALID_URL', 'Nacelle+ only supports HTTP(S) targets');
  if (!(await isGranted(pageOrigin, targetOrigin))) {
    return failure(
      'ERR_NACELLE_PLUS_PERMISSION_REQUIRED',
      `Nacelle+ permission is required for ${targetOrigin}`,
      { pageOrigin, targetOrigin },
    );
  }
  const method = String(request.method || 'GET').toUpperCase();
  const options = {
    method,
    headers: normalizeHeaders(request.headers),
    redirect: 'follow',
    credentials: 'omit',
  };
  if (!['GET', 'HEAD'].includes(method)) options.body = normalizeBody(request.body);
  const controller = new AbortController();
  const timeout = Number(request.timeout);
  const timer = Number.isFinite(timeout) && timeout > 0
    ? setTimeout(() => controller.abort(), timeout)
    : null;
  options.signal = controller.signal;
  try {
    const response = await fetch(request.target, options);
    const length = Number(response.headers.get('content-length'));
    if (Number.isInteger(length) && length > MAX_RESPONSE_BYTES) {
      return failure('ERR_NACELLE_PLUS_RESPONSE_TOO_LARGE', 'Nacelle+ response exceeds the 16 MiB limit');
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      return failure('ERR_NACELLE_PLUS_RESPONSE_TOO_LARGE', 'Nacelle+ response exceeds the 16 MiB limit');
    }
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } catch (error) {
    return failure(error.name === 'AbortError' ? 'ETIMEDOUT' : 'ERR_NACELLE_PLUS_REQUEST', error.message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleMessage(message, sender) {
  if (!message || message.type !== 'nacelle-plus-request') return failure('ERR_NACELLE_PLUS_PROTOCOL', 'unknown Nacelle+ message');
  if (message.operation === 'grant') {
    if (!extensionSender(sender)) return failure('ERR_NACELLE_PLUS_PERMISSION', 'only the extension UI can grant permissions');
    const pageOrigin = originFrom(message.pageOrigin);
    const targetOrigin = originFrom(message.targetOrigin);
    if (!pageOrigin || !targetOrigin) return failure('ERR_INVALID_URL', 'permission origins must be HTTP(S)');
    await saveGrant(pageOrigin, targetOrigin);
    return { ok: true, pageOrigin, targetOrigin };
  }
  if (message.operation === 'status') {
    const pageOrigin = originFrom(message.pageOrigin);
    const targetOrigin = originFrom(message.targetOrigin);
    if (!pageOrigin || !targetOrigin) return failure('ERR_INVALID_URL', 'permission origins must be HTTP(S)');
    return { ok: true, granted: await isGranted(pageOrigin, targetOrigin) };
  }
  if (message.operation !== 'request') return failure('ERR_NACELLE_PLUS_UNSUPPORTED', 'only HTTP request transport is implemented');
  const pageOrigin = senderPageOrigin(sender);
  if (!pageOrigin) return failure('ERR_NACELLE_PLUS_ORIGIN', 'Nacelle+ could not determine the requesting page origin');
  return requestTarget(message.request, pageOrigin);
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const pending = handleMessage(message, sender);
  if (isFirefox) return pending;
  pending.then(sendResponse, (error) => sendResponse(failure('ERR_NACELLE_PLUS_EXTENSION', error.message)));
  return true;
});
