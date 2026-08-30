function diagnosticSink(debug, globalObject) {
  if (!debug) return null;
  if (typeof debug === 'function') return debug;
  if (typeof debug.onEvent === 'function') return debug.onEvent;
  if (debug.enabled === false) return null;
  const logger = globalObject.console?.debug;
  return typeof logger === 'function' ? (event) => logger.call(globalObject.console, event) : null;
}

function safeTarget(value, scope) {
  try {
    const URLConstructor = scope.URL || globalThis.URL;
    const target = new URLConstructor(String(value));
    target.search = '';
    target.hash = '';
    return target.href;
  } catch {
    return '[invalid-url]';
  }
}

function targetOrigin(value, scope) {
  try {
    const URLConstructor = scope.URL || globalThis.URL;
    return new URLConstructor(String(value)).origin;
  } catch { return '[invalid-origin]'; }
}

function timestamp(scope) {
  return typeof scope.performance?.now === 'function'
    ? scope.performance.now()
    : Date.now();
}

function terminationFor(error) {
  const code = String(error?.code || '').toUpperCase();
  if (code === 'ERR_NACELLE_PLUS_GRANT_REVOKED') return 'revoked';
  if (code === 'ERR_NACELLE_PLUS_TRANSPORT_LOST') return 'transport_lost';
  if (code === 'ABORT_ERR' || code === 'ETIMEDOUT' || code === 'ERR_NACELLE_PLUS_BACKPRESSURE_TIMEOUT') return 'aborted';
  return 'failed';
}

/** Create opt-in, secret-free diagnostics for one Nacelle+ adapter. */
export function createNacellePlusDiagnostics({ debug = false, globalObject = globalThis } = {}) {
  const sink = diagnosticSink(debug, globalObject);
  const emit = (event) => {
    if (!sink) return;
    try { sink(Object.freeze({ ...event })); } catch { /* diagnostics never change request behavior */ }
  };
  const start = ({ requestId, target, fallbackReason }) => {
    const record = {
      requestId: String(requestId),
      target: safeTarget(target, globalObject),
      origin: targetOrigin(target, globalObject),
      fallbackReason: fallbackReason || 'explicit',
      startedAt: timestamp(globalObject),
      grant: 'pending',
      stream: false,
      bytesIn: 0,
      finished: false,
    };
    emit({
      transport: 'nacelle-plus',
      phase: 'start',
      request_id: record.requestId,
      origin: record.origin,
      target: record.target,
      fallback_reason: record.fallbackReason,
      grant: record.grant,
      stream: record.stream,
      bytes_in: 0,
    });
    return {
      response({ stream, status }) {
        record.grant = 'allowed';
        record.stream = stream === true;
        emit({
          transport: 'nacelle-plus',
          phase: 'response',
          request_id: record.requestId,
          origin: record.origin,
          target: record.target,
          fallback_reason: record.fallbackReason,
          grant: record.grant,
          stream: record.stream,
          status,
          bytes_in: record.bytesIn,
        });
      },
      addBytes(bytes) {
        record.bytesIn += Number(bytes) || 0;
      },
      finish(error, status) {
        if (record.finished) return;
        record.finished = true;
        if (error === null) record.grant = 'allowed';
        emit({
          transport: 'nacelle-plus',
          phase: 'finish',
          request_id: record.requestId,
          origin: record.origin,
          target: record.target,
          fallback_reason: record.fallbackReason,
          grant: record.grant,
          stream: record.stream,
          ...(status === undefined ? {} : { status }),
          bytes_in: record.bytesIn,
          duration_ms: Math.max(0, Math.round(timestamp(globalObject) - record.startedAt)),
          termination: error === null ? 'completed' : terminationFor(error),
        });
      },
    };
  };
  return Object.freeze({ start });
}

export { terminationFor };
