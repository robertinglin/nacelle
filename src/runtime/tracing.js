const SECRET_KEY = /secret|token|password|authorization|api[-_]?key|private[-_]?key/i;

function makeTraceId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (url.search) {
        for (const parameter of url.searchParams.keys()) url.searchParams.set(parameter, '[REDACTED]');
        return url.toString();
      }
    } catch {}
    return value.replace(/(bearer\s+|token=|key=)[^\s&]+/ig, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export class NacelleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NacelleError';
    this.code = String(code || 'ERR_NACELLE_UNKNOWN');
    this.details = redact(details);
    if (details.traceId) this.traceId = String(details.traceId);
  }
}

/** Bounded structured trace recorder shared by runtime, gateway, and policy layers. */
export function createTraceRecorder({ traceId = makeTraceId(), maxEvents = 256 } = {}) {
  const events = [];
  let startedAt = null;
  let finishedAt = null;
  let failure = null;
  const append = (type, payload = {}) => {
    const event = Object.freeze({ traceId, type, at: Date.now(), ...redact(payload) });
    if (events.length >= maxEvents) events.shift();
    events.push(event);
    return event;
  };
  return {
    traceId,
    start(payload = {}) { startedAt = Date.now(); append('start', payload); return traceId; },
    event(type, payload = {}) { return append(type, payload); },
    finish(error = null, payload = {}) {
      finishedAt = Date.now();
      failure = error ? { name: error.name, message: error.message, code: error.code || 'ERR_NACELLE_UNKNOWN', traceId: error.traceId || traceId } : null;
      append('finish', { ...payload, error: failure });
      return failure;
    },
    export() {
      return Object.freeze({ traceId, startedAt, finishedAt, failure: failure && { ...failure }, events: events.map((event) => ({ ...event })) });
    },
  };
}

export function redactTrace(value) { return redact(value); }
