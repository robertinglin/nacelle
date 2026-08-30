importScripts('policy.js');

const api = globalThis.browser || globalThis.chrome;
const isFirefox = Boolean(globalThis.browser);
const GRANTS_KEY = 'nacellePlusGrants';
const PORT_NAME = 'nacelle-plus-transport-v1';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const MAX_ACK_WAIT = 30_000;

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
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed.origin;
}

function permissionPattern(origin) {
  const parsed = new URL(origin);
  return `${parsed.protocol}//${parsed.host}/*`;
}

function senderIdentity(sender) {
  const pageOrigin = originFrom(sender?.tab?.url);
  const senderOrigin = originFrom(sender?.url);
  if (sender?.id && sender.id !== api.runtime.id) return null;
  if (!Number.isInteger(sender?.tab?.id) || sender.tab.id < 0 || sender?.frameId !== 0) return null;
  if (!pageOrigin || (senderOrigin && senderOrigin !== pageOrigin)) return null;
  return { pageOrigin, tabId: sender.tab.id };
}

function extensionSender(sender) {
  return sender?.id === api.runtime.id
    && typeof sender?.url === 'string'
    && sender.url.startsWith(api.runtime.getURL(''));
}

async function grants() {
  const stored = await call(api.storage.local, 'get', GRANTS_KEY);
  return stored?.[GRANTS_KEY] && typeof stored[GRANTS_KEY] === 'object' ? stored[GRANTS_KEY] : {};
}

function targetGrant(current, pageOrigin, targetOrigin) {
  const entry = current[pageOrigin];
  if (Array.isArray(entry)) return entry.includes(targetOrigin) ? { allowPrivate: false } : null;
  const value = entry?.targets?.[targetOrigin];
  return value && typeof value === 'object' ? value : value === true ? { allowPrivate: false } : null;
}

function grantSnapshot(current) {
  return Object.entries(current).flatMap(([pageOrigin, entry]) => {
    const targets = Array.isArray(entry)
      ? entry.map((targetOrigin) => [targetOrigin, { allowPrivate: false }])
      : Object.entries(entry?.targets || {});
    return [{ pageOrigin, targets: targets.map(([targetOrigin, value]) => ({
      targetOrigin,
      allowPrivate: value?.allowPrivate === true,
    })) }];
  });
}

async function saveGrant(pageOrigin, targetOrigin, allowPrivate) {
  const current = await grants();
  const entry = Array.isArray(current[pageOrigin])
    ? Object.fromEntries(current[pageOrigin].map((origin) => [origin, { allowPrivate: false }]))
    : { ...(current[pageOrigin]?.targets || {}) };
  entry[targetOrigin] = { allowPrivate: allowPrivate === true, createdAt: Date.now() };
  current[pageOrigin] = { targets: entry };
  await call(api.storage.local, 'set', { [GRANTS_KEY]: current });
}

async function revokeGrant(pageOrigin, targetOrigin) {
  const current = await grants();
  const existing = current[pageOrigin];
  const targets = Array.isArray(existing)
    ? existing.filter((origin) => origin !== targetOrigin)
    : Object.fromEntries(Object.entries(existing?.targets || {}).filter(([origin]) => origin !== targetOrigin));
  if (Array.isArray(targets) ? targets.length : Object.keys(targets).length) {
    current[pageOrigin] = Array.isArray(targets) ? targets : { targets };
  } else delete current[pageOrigin];
  await call(api.storage.local, 'set', { [GRANTS_KEY]: current });

  const stillUsed = grantSnapshot(current).some((grant) => grant.targets.some((target) => target.targetOrigin === targetOrigin));
  if (!stillUsed) await call(api.permissions, 'remove', { origins: [permissionPattern(targetOrigin)] });
}

async function grantState(pageOrigin, targetOrigin) {
  const grant = targetGrant(await grants(), pageOrigin, targetOrigin);
  if (!grant) return { granted: false, code: 'ERR_NACELLE_PLUS_PERMISSION_REQUIRED' };
  if (NacellePlusPolicy.isPrivateOrigin(targetOrigin) && grant.allowPrivate !== true) {
    return { granted: false, code: 'ERR_NACELLE_PLUS_PRIVATE_TARGET_REQUIRES_EXPLICIT_GRANT' };
  }
  if (!(await call(api.permissions, 'contains', { origins: [permissionPattern(targetOrigin)] }))) {
    return { granted: false, code: 'ERR_NACELLE_PLUS_PERMISSION_REQUIRED' };
  }
  return { granted: true };
}

function validateSenderRequest(message, sender) {
  if (!message || message.type !== 'request' || message.version !== 1 || typeof message.requestId !== 'string'
    || !NacellePlusPolicy.isRequestId(message.requestId)) {
    return failure('ERR_NACELLE_PLUS_PROTOCOL', 'invalid Nacelle+ request envelope');
  }
  if (message.extensionId && message.extensionId !== api.runtime.id) {
    return failure('ERR_NACELLE_PLUS_EXTENSION_ID', 'request targets a different Nacelle+ extension');
  }
  const identity = senderIdentity(sender);
  if (!identity) return failure('ERR_NACELLE_PLUS_SENDER', 'only top-level HTTP(S) tabs may use Nacelle+');
  const requestError = NacellePlusPolicy.validateRequest(message.request);
  if (requestError) return requestError;
  return identity;
}

function sendPort(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function requestHeaders(value) {
  const headers = Object.create(null);
  for (const [name, headerValue] of Object.entries(value || {})) headers[name] = String(headerValue);
  return headers;
}

function responseHeaders(headers) {
  const output = Object.create(null);
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (lower === 'set-cookie' || lower === 'set-cookie2') continue;
    output[lower] = value;
  }
  return output;
}

async function fetchRedirectChain(request, pageOrigin, controller) {
  let current = {
    target: request.target,
    method: request.method,
    headers: requestHeaders(request.headers),
    body: request.body,
  };
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const targetOrigin = originFrom(current.target);
    const state = await grantState(pageOrigin, targetOrigin);
    if (!state.granted) {
      return failure(
        state.code,
        `Nacelle+ permission is required for ${targetOrigin}`,
        { pageOrigin, targetOrigin, redirect },
      );
    }
    let response;
    try {
      response = await fetch(current.target, {
        method: current.method,
        headers: current.headers,
        body: ['GET', 'HEAD'].includes(current.method) ? undefined : current.body,
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (error) {
      return failure(controller.timedOut ? 'ETIMEDOUT' : controller.signal.aborted ? 'ABORT_ERR' : 'ERR_NACELLE_PLUS_REQUEST', error.message);
    }
    if (response.type === 'opaqueredirect' || response.status === 0) {
      return failure('ERR_NACELLE_PLUS_REDIRECT_UNAVAILABLE', 'Nacelle+ could not inspect a redirect response safely');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect === MAX_REDIRECTS) return failure('ERR_NACELLE_PLUS_TOO_MANY_REDIRECTS', 'Nacelle+ redirect limit exceeded');
    const next = NacellePlusPolicy.redirectTarget(current.target, response, current);
    if (!next) return response;
    if (next.error) return next.error;
    current = next;
  }
  return failure('ERR_NACELLE_PLUS_TOO_MANY_REDIRECTS', 'Nacelle+ redirect limit exceeded');
}

function waitForChunkAck(acknowledgements, requestId, sequence, controller) {
  return new Promise((resolve) => {
    const pending = acknowledgements.get(requestId) || new Map();
    const finish = (delivered) => {
      controller.signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      pending.delete(sequence);
      resolve(delivered);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), MAX_ACK_WAIT);
    pending.set(sequence, finish);
    acknowledgements.set(requestId, pending);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
}

async function streamTarget(request, pageOrigin, port, controller, acknowledgements) {
  const response = await fetchRedirectChain(request, pageOrigin, controller);
  if (response?.ok === false && response.error) {
    sendPort(port, { type: 'response-error', requestId: request.requestId, response });
    return;
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isInteger(length) && length > MAX_RESPONSE_BYTES) {
    sendPort(port, {
      type: 'response-error', requestId: request.requestId,
      response: failure('ERR_NACELLE_PLUS_RESPONSE_TOO_LARGE', 'Nacelle+ response exceeds the 16 MiB limit'),
    });
    controller.abort();
    return;
  }
  if (!sendPort(port, {
    type: 'response-start',
    requestId: request.requestId,
    response: { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) },
  })) return;

  let total = 0;
  let sequence = 0;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value);
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          sendPort(port, {
            type: 'response-error', requestId: request.requestId,
            response: failure('ERR_NACELLE_PLUS_RESPONSE_TOO_LARGE', 'Nacelle+ response exceeds the 16 MiB limit'),
          });
          controller.abort();
          return;
        }
        const chunkBytes = new Uint8Array(chunk.byteLength);
        chunkBytes.set(chunk);
        const chunkSequence = sequence += 1;
        const acknowledged = waitForChunkAck(acknowledgements, request.requestId, chunkSequence, controller);
        if (!sendPort(port, {
          type: 'response-chunk', requestId: request.requestId, sequence: chunkSequence, body: chunkBytes.buffer,
        })) return;
        if (!(await acknowledged)) { controller.abort(); return; }
      }
    } else if (response.body) {
      sendPort(port, {
        type: 'response-error', requestId: request.requestId,
        response: failure('ERR_NACELLE_PLUS_STREAM_UNAVAILABLE', 'Nacelle+ requires a streaming response body'),
      });
      controller.abort();
    }
    sendPort(port, { type: 'response-end', requestId: request.requestId });
  } catch (error) {
    sendPort(port, {
      type: 'response-error', requestId: request.requestId,
      response: failure(controller.timedOut ? 'ETIMEDOUT' : controller.signal.aborted ? 'ABORT_ERR' : 'ERR_NACELLE_PLUS_REQUEST', error.message),
    });
  }
}

async function handleUiMessage(message, sender) {
  if (!message || message.type !== 'nacelle-plus-request' || !extensionSender(sender)) {
    return failure('ERR_NACELLE_PLUS_PERMISSION', 'only Nacelle+ UI pages may manage grants');
  }
  if (message.operation === 'grant') {
    const pageOrigin = originFrom(message.pageOrigin);
    const targetOrigin = originFrom(message.targetOrigin);
    if (!pageOrigin || !targetOrigin) return failure('ERR_INVALID_URL', 'permission origins must be HTTP(S)');
    await saveGrant(pageOrigin, targetOrigin, message.allowPrivate === true);
    return { ok: true, pageOrigin, targetOrigin, allowPrivate: message.allowPrivate === true };
  }
  if (message.operation === 'revoke') {
    const pageOrigin = originFrom(message.pageOrigin);
    const targetOrigin = originFrom(message.targetOrigin);
    if (!pageOrigin || !targetOrigin) return failure('ERR_INVALID_URL', 'permission origins must be HTTP(S)');
    await revokeGrant(pageOrigin, targetOrigin);
    return { ok: true, pageOrigin, targetOrigin };
  }
  if (message.operation === 'list') return { ok: true, grants: grantSnapshot(await grants()) };
  if (message.operation === 'status') {
    const pageOrigin = originFrom(message.pageOrigin);
    const targetOrigin = originFrom(message.targetOrigin);
    if (!pageOrigin || !targetOrigin) return failure('ERR_INVALID_URL', 'permission origins must be HTTP(S)');
    return { ok: true, ...(await grantState(pageOrigin, targetOrigin)) };
  }
  return failure('ERR_NACELLE_PLUS_UNSUPPORTED', 'unsupported Nacelle+ management operation');
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const pending = handleUiMessage(message, sender);
  if (isFirefox) return pending;
  pending.then(sendResponse, (error) => sendResponse(failure('ERR_NACELLE_PLUS_EXTENSION', error.message)));
  return true;
});

api.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const identity = senderIdentity(port.sender);
  const controllers = new Map();
  const acknowledgements = new Map();
  if (!identity) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener(async (message) => {
    if (!message || message.type === 'heartbeat') {
      sendPort(port, { type: 'heartbeat-ack' });
      return;
    }
    if (message.type === 'chunk-ack') {
      const pending = acknowledgements.get(message.requestId);
      const resolve = pending?.get(message.sequence);
      if (resolve) {
        pending.delete(message.sequence);
        resolve(true);
      }
      return;
    }
    if (message.type === 'cancel') {
      if (NacellePlusPolicy.isRequestId(message.requestId)) controllers.get(message.requestId)?.abort();
      return;
    }
    const validated = validateSenderRequest(message, port.sender);
    if (validated?.ok === false) {
      sendPort(port, { type: 'response-error', requestId: message?.requestId, response: validated });
      return;
    }
    if (controllers.has(message.requestId)) {
      sendPort(port, {
        type: 'response-error', requestId: message.requestId,
        response: failure('ERR_NACELLE_PLUS_DUPLICATE_REQUEST', 'request ID is already active'),
      });
      return;
    }
    const controller = new AbortController();
    controllers.set(message.requestId, controller);
    let timeout;
    try {
      const timeoutMs = Number(message.request.timeout);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeout = setTimeout(() => { controller.timedOut = true; controller.abort(); }, timeoutMs);
      }
      await streamTarget({ ...message.request, requestId: message.requestId }, validated.pageOrigin, port, controller, acknowledgements);
    } finally {
      if (timeout) clearTimeout(timeout);
      controllers.delete(message.requestId);
      for (const resolve of acknowledgements.get(message.requestId)?.values() || []) resolve(false);
      acknowledgements.delete(message.requestId);
    }
  });
  port.onDisconnect.addListener(() => {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    for (const pending of acknowledgements.values()) {
      for (const resolve of pending.values()) resolve(false);
    }
    acknowledgements.clear();
  });
});
