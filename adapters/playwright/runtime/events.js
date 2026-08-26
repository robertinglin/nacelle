/**
 * Small event emitter used by browser adapters.
 *
 * Browser EventTarget listeners receive Event objects, while Node-facing
 * shims conventionally receive the useful payload directly. Keeping this
 * translation in one place avoids making every adapter know both contracts.
 */
import { installAbortSignalTimeout } from './timers.js';

let defaultMaxListeners = 10;

function validateMaxListeners(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('The value of "n" is out of range. It must be a non-negative integer.');
  }
  return value;
}

function activeProcess() {
  const candidate = globalThis?.process;
  // Never route compatibility warnings to the host process. Browser process
  // objects expose getCode(), which is absent from the host process object.
  if (!candidate || typeof candidate.emit !== 'function' || typeof candidate.getCode !== 'function') return null;
  return candidate;
}

function emitMaxListenersWarning(emitter, name, count) {
  const warning = new Error(
    `Possible EventEmitter memory leak detected. ${count} ${String(name)} listeners added to [EventEmitter]. ` +
    'Use emitter.setMaxListeners() to increase limit',
  );
  warning.name = 'MaxListenersExceededWarning';
  warning.emitter = emitter;
  warning.type = name;
  warning.count = count;

  const processObject = activeProcess();
  if (!processObject) return;

  // Node's default warning handler runs before user-installed warning
  // listeners. Write through the active process so stderr monkeypatches see
  // exactly one default write.
  processObject.stderr?.write?.(`${warning.name}: ${warning.message}\n`);
  processObject.emit('warning', warning);
}

export class BrowserEventEmitter {
  #listeners = new Map();
  #onceListeners = new Map();
  #maxListeners;
  #warned = new Set();

  static get defaultMaxListeners() {
    return defaultMaxListeners;
  }

  static set defaultMaxListeners(value) {
    defaultMaxListeners = validateMaxListeners(value);
  }

  constructor() {
    if (typeof BrowserEventEmitter.init === 'function') {
      BrowserEventEmitter.init.call(this);
    }
  }

  on(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const listeners = this.#listeners.get(name) || new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    this.#checkListenerLimit(name, listeners);
    return this;
  }

  addListener(name, listener) {
    return this.on(name, listener);
  }

  getMaxListeners() {
    return this.#maxListeners ?? BrowserEventEmitter.defaultMaxListeners;
  }

  setMaxListeners(value) {
    this.#maxListeners = validateMaxListeners(value);
    return this;
  }

  #checkListenerLimit(name, listeners) {
    const limit = this.getMaxListeners();
    if (limit === 0 || listeners.size <= limit || this.#warned.has(name)) return;
    this.#warned.add(name);
    emitMaxListenersWarning(this, name, listeners.size);
  }

  once(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const onceListener = function onceListener(...args) {
      this.off(name, listener);
      listener.apply(this, args);
    };
    const onceListeners = this.#onceListeners.get(listener) || new Set();
    onceListeners.add(onceListener);
    this.#onceListeners.set(listener, onceListeners);
    return this.on(name, onceListener);
  }

  off(name, listener) {
    const listeners = this.#listeners.get(name);
    if (!listeners) return this;
    listeners.delete(listener);
    const onceListeners = this.#onceListeners.get(listener);
    if (onceListeners) {
      for (const onceListener of onceListeners) listeners.delete(onceListener);
      onceListeners.clear();
      this.#onceListeners.delete(listener);
    }
    if (listeners.size === 0) this.#listeners.delete(name);
    return this;
  }

  removeListener(name, listener) {
    return this.off(name, listener);
  }

  removeAllListeners(name = undefined) {
    if (name === undefined) {
      this.#listeners.clear();
      this.#onceListeners.clear();
    } else {
      const listeners = this.#listeners.get(name);
      if (listeners) {
        for (const listener of listeners) this.off(name, listener);
      }
    }
    return this;
  }

  emit(name, ...args) {
    const listeners = this.#listeners.get(name);
    if (!listeners || listeners.size === 0) return false;
    for (const listener of [...listeners]) listener.apply(this, args);
    return true;
  }

  listenerCount(name) {
    return this.#listeners.get(name)?.size || 0;
  }

  listeners(name) {
    const listeners = this.#listeners.get(name);
    if (!listeners || listeners.size === 0) return [];
    return [...listeners];
  }
}

export function getEventListeners(emitter, name) {
  if (emitter && typeof emitter.listeners === 'function') {
    return emitter.listeners(name);
  }
  return [];
}

export function once(emitter, name, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const isEventTarget = typeof emitter?.addEventListener === 'function';
    const cleanup = () => {
      if (isEventTarget) emitter.removeEventListener?.(name, onEvent);
      else {
        emitter.off?.(name, onEvent);
        emitter.off?.('error', onError);
      }
      options.signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onEvent = (...args) => finish(resolve, args);
    const onError = (error) => finish(reject, error);
    const onAbort = () => {
      const error = new Error('The operation was aborted');
      error.code = 'ABORT_ERR';
      finish(reject, error);
    };
    if (isEventTarget) emitter.addEventListener(name, onEvent, { once: true });
    else {
      emitter.once?.(name, onEvent);
      if (name !== 'error') emitter.once?.('error', onError);
    }
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

BrowserEventEmitter.once = once;

if (typeof globalThis.window === 'object' || typeof globalThis.document === 'object' || typeof globalThis.location === 'object') {
  installAbortSignalTimeout(globalThis);
}

// Alias retained for small Node-facing shims that use the conventional name.
export const EventEmitter = BrowserEventEmitter;
