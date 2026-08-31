const TIMEOUT_REASON = 'The operation was aborted due to timeout';
const TIMEOUT_COMPATIBILITY = Symbol.for('bnh.abort-signal-timeout-compatibility');

function timeoutReason(scope) {
  if (typeof scope.DOMException === 'function') return new scope.DOMException(TIMEOUT_REASON, 'TimeoutError');
  const error = new Error(TIMEOUT_REASON);
  error.name = 'TimeoutError';
  return error;
}

function installTimeoutMethod(AbortSignalClass, timeout) {
  try {
    AbortSignalClass.timeout = timeout;
    if (AbortSignalClass.timeout === timeout) return true;
  } catch {}
  try {
    Object.defineProperty(AbortSignalClass, 'timeout', { configurable: true, writable: true, value: timeout });
    return AbortSignalClass.timeout === timeout;
  } catch {
    return false;
  }
}

export function installAbortSignalTimeout(scope = globalThis) {
  const AbortSignalClass = scope.AbortSignal;
  const AbortControllerClass = scope.AbortController;
  if (typeof AbortSignalClass !== 'function' || typeof AbortControllerClass !== 'function') return false;
  if (!scope.document && !scope.location) return false;
  if (AbortSignalClass[TIMEOUT_COMPATIBILITY]) return true;

  const browserTimeout = (milliseconds) => {
    const delay = Number(milliseconds);
    if (!Number.isInteger(delay) || delay < 0) throw new RangeError('delay must be a non-negative integer');
    const controller = new AbortControllerClass();
    const runtimeSetTimeout = scope.process?._bnhSetTimer;
    const timer = typeof runtimeSetTimeout === 'function'
      ? runtimeSetTimeout.call(scope.process, () => controller.abort(timeoutReason(scope)), delay)
      : typeof scope.setTimeout === 'function'
        ? scope.setTimeout(() => controller.abort(timeoutReason(scope)), delay)
        : null;
    if (!timer && typeof scope.setTimeout !== 'function' && typeof runtimeSetTimeout !== 'function') throw new TypeError('setTimeout is unavailable');
    timer?.unref?.();
    return controller.signal;
  };

  if (!installTimeoutMethod(AbortSignalClass, browserTimeout)) return false;
  try { Object.defineProperty(AbortSignalClass, TIMEOUT_COMPATIBILITY, { configurable: true, value: true }); } catch {}
  return true;
}
