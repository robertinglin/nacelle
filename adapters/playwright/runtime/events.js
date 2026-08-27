/**
 * Small event emitter used by browser adapters.
 *
 * Browser EventTarget listeners receive Event objects, while Node-facing
 * shims conventionally receive the useful payload directly. Keeping this
 * translation in one place avoids making every adapter know both contracts.
 */
import { installAbortSignalTimeout } from './timers.js';

let defaultMaxListeners = 10;
const kMaxEventTargetListeners = Symbol('events.maxEventTargetListeners');
const kMaxEventTargetListenersWarned = Symbol('events.maxEventTargetListenersWarned');

function receivedValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'number' || typeof value === 'boolean') return `type ${typeof value} (${value})`;
  if (typeof value === 'bigint') return `type bigint (${value}n)`;
  if (typeof value === 'symbol') return `type symbol (${String(value)})`;
  return `an instance of ${value?.constructor?.name || typeof value}`;
}

function validateMaxListeners(value, name = 'n') {
  if (typeof value !== 'number') {
    const error = new TypeError(`The "${name}" argument must be of type number. Received ${receivedValue(value)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (Number.isNaN(value) || value < 0) {
    const error = new RangeError(`The value of "${name}" is out of range. It must be >= 0. Received ${receivedValue(value)}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  return value;
}

function isEventTarget(value) {
  const EventTarget = globalThis.EventTarget;
  return typeof EventTarget === 'function' && value instanceof EventTarget;
}

function invalidEventTargets(value) {
  const error = new TypeError(
    `The "eventTargets" argument must be an instance of EventEmitter or EventTarget. Received ${receivedValue(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
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
  constructor() {
    this._listeners = new Map();
    this._onceListeners = new Map();
    this._maxListeners = undefined;
    this._warned = new Set();
    if (typeof EventEmitter.init === 'function') EventEmitter.init.call(this);
  }

  static get defaultMaxListeners() {
    return defaultMaxListeners;
  }

  static set defaultMaxListeners(value) {
    defaultMaxListeners = validateMaxListeners(value, 'defaultMaxListeners');
  }

  on(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (name !== 'newListener') this.emit('newListener', name, listener.listener || listener);
    const listeners = this._listeners.get(name) || new Set();
    listeners.add(listener);
    this._listeners.set(name, listeners);
    this.checkListenerLimit(name, listeners);
    return this;
  }

  addListener(name, listener) {
    return this.on(name, listener);
  }

  prependListener(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (name !== 'newListener') this.emit('newListener', name, listener.listener || listener);
    const listeners = this._listeners.get(name) || new Set();
    this._listeners.set(name, new Set([listener, ...listeners]));
    this.checkListenerLimit(name, this._listeners.get(name));
    return this;
  }

  getMaxListeners() {
    return this._maxListeners ?? defaultMaxListeners;
  }

  setMaxListeners(value) {
    this._maxListeners = validateMaxListeners(value, 'setMaxListeners');
    return this;
  }

  checkListenerLimit(name, listeners) {
    const limit = this.getMaxListeners();
    if (limit === 0 || listeners.size <= limit || this._warned.has(name)) return;
    this._warned.add(name);
    emitMaxListenersWarning(this, name, listeners.size);
  }

  once(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const onceListener = function onceListener(...args) {
      this.off(name, onceListener);
      listener.apply(this, args);
    };
    onceListener.listener = listener;
    const onceListeners = this._onceListeners.get(listener) || new Set();
    onceListeners.add(onceListener);
    this._onceListeners.set(listener, onceListeners);
    return this.on(name, onceListener);
  }

  prependOnceListener(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const onceListener = (...args) => {
      this.off(name, onceListener);
      listener.apply(this, args);
    };
    onceListener.listener = listener;
    const onceListeners = this._onceListeners.get(listener) || new Set();
    onceListeners.add(onceListener);
    this._onceListeners.set(listener, onceListeners);
    return this.prependListener(name, onceListener);
  }

  off(name, listener) {
    const listeners = this._listeners.get(name);
    if (!listeners) return this;
    listeners.delete(listener);
    const onceListeners = this._onceListeners.get(listener);
    if (onceListeners) {
      for (const onceListener of onceListeners) listeners.delete(onceListener);
      onceListeners.clear();
      this._onceListeners.delete(listener);
    }
    if (listeners.size === 0) this._listeners.delete(name);
    return this;
  }

  removeListener(name, listener) {
    return this.off(name, listener);
  }

  removeAllListeners(name = undefined) {
    if (name === undefined) {
      this._listeners.clear();
      this._onceListeners.clear();
    } else {
      const listeners = this._listeners.get(name);
      if (listeners) {
        for (const listener of listeners) this.off(name, listener);
      }
    }
    return this;
  }

  emit(name, ...args) {
    const listeners = this._listeners.get(name);
    if (name === 'error' && listeners?.size && this.domain && typeof this.domain._errorHandler === 'function') {
      const userListeners = [...listeners].filter((listener) => !listener._bnhInternal);
      if (userListeners.length === 0) {
        const snapshot = [...listeners];
        for (let index = 0; index < snapshot.length; index += 1) snapshot[index].apply(this, args);
        const error = args[0];
        if (error && (typeof error === 'object' || typeof error === 'function')) {
          Object.defineProperty(error, 'domainEmitter', {
            configurable: true,
            value: this,
            writable: true,
          });
          Object.defineProperty(error, 'domainThrown', {
            configurable: true,
            value: false,
            writable: true,
          });
        }
        this.domain._errorHandler(error);
        return true;
      }
    }
    if (!listeners || listeners.size === 0) {
      if (name === 'error' && this.domain && typeof this.domain._errorHandler === 'function') {
        const error = args[0];
        if (error && (typeof error === 'object' || typeof error === 'function')) {
          Object.defineProperty(error, 'domainEmitter', {
            configurable: true,
            value: this,
            writable: true,
          });
          Object.defineProperty(error, 'domainThrown', {
            configurable: true,
            value: false,
            writable: true,
          });
        }
        this.domain._errorHandler(error);
        return true;
      }
      return false;
    }
    const snapshot = [...listeners];
    for (let index = 0; index < snapshot.length; index += 1) snapshot[index].apply(this, args);
    return true;
  }

  listenerCount(name) {
    return this._listeners.get(name)?.size || 0;
  }

  listeners(name) {
    const listeners = this._listeners.get(name);
    if (!listeners || listeners.size === 0) return [];
    return [...listeners].map((listener) => listener.listener || listener);
  }
}

export function getEventListeners(emitter, name) {
  if (emitter && typeof emitter.listeners === 'function') {
    return emitter.listeners(name);
  }
  return [];
}

// Node exposes these names as aliases. Some upstream tests compare the
// function objects directly, so delegation is not equivalent here.
BrowserEventEmitter.prototype.addListener = BrowserEventEmitter.prototype.on;
BrowserEventEmitter.prototype.removeListener = BrowserEventEmitter.prototype.off;

export function once(emitter, name, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const isEventTarget = typeof emitter?.addEventListener === 'function'
      && typeof emitter?.on !== 'function';
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

export function addAbortListener(signal, listener) {
  if (!signal || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function') {
    const error = new TypeError('The "signal" argument must be an instance of AbortSignal');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (typeof listener !== 'function') {
    const error = new TypeError('The "listener" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  let disposed = false;
  const onAbort = (event) => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', onAbort);
    listener(event);
  };
  // A listener registered with capture runs before a same-target listener
  // that calls stopImmediatePropagation(), matching Node's abort-listener
  // guarantee that this helper cannot be bypassed by user propagation code.
  signal.addEventListener('abort', onAbort, { once: true, capture: true });
  // Some browser AbortSignal implementations still let a same-target
  // stopImmediatePropagation() suppress the listener. A microtask observes
  // the completed abort without keeping a live polling task around.
  globalThis.queueMicrotask?.(() => {
    if (signal.aborted) onAbort({ target: signal, type: 'abort' });
  });
  if (signal.aborted) onAbort(signal.reason);
  return {
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener('abort', onAbort);
    },
  };
}

BrowserEventEmitter.once = once;

if (typeof globalThis.window === 'object' || typeof globalThis.document === 'object' || typeof globalThis.location === 'object') {
  installAbortSignalTimeout(globalThis);
}

// Node core constructors call EventEmitter both with and without `new`.
// Keep the implementation class for browser code while exposing a callable
// constructor for core modules that use FunctionPrototypeCall.
export function EventEmitter(...args) {
  if (new.target) {
    const emitter = new BrowserEventEmitter(...args);
    if (new.target.prototype && new.target.prototype !== BrowserEventEmitter.prototype) {
      Object.setPrototypeOf(emitter, new.target.prototype);
    }
    return emitter;
  }
  if (!this._listeners) {
    this._listeners = new Map();
    this._onceListeners = new Map();
    this._maxListeners = undefined;
    this._warned = new Set();
  }
  if (typeof EventEmitter.init === 'function') EventEmitter.init.call(this, ...args);
  return this;
}

EventEmitter.prototype = BrowserEventEmitter.prototype;
Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
  configurable: true,
  get: () => defaultMaxListeners,
  set: (value) => { defaultMaxListeners = validateMaxListeners(value, 'defaultMaxListeners'); },
});

EventEmitter.listenerCount = function listenerCount(emitter, name) {
  if (typeof emitter?.listenerCount === 'function') return emitter.listenerCount(name);
  return BrowserEventEmitter.prototype.listenerCount.call(emitter, name);
};

EventEmitter.setMaxListeners = function setMaxListeners(value = defaultMaxListeners, ...eventTargets) {
  validateMaxListeners(value, 'setMaxListeners');
  if (eventTargets.length === 0) {
    defaultMaxListeners = value;
    return;
  }

  for (const target of eventTargets) {
    if (isEventTarget(target)) {
      target[kMaxEventTargetListeners] = value;
      target[kMaxEventTargetListenersWarned] = false;
    } else if (typeof target?.setMaxListeners === 'function') {
      target.setMaxListeners(value);
    } else {
      throw invalidEventTargets(target);
    }
  }
};

Object.defineProperties(EventEmitter, {
  kMaxEventTargetListeners: {
    value: kMaxEventTargetListeners,
    enumerable: false,
    configurable: false,
    writable: false,
  },
  kMaxEventTargetListenersWarned: {
    value: kMaxEventTargetListenersWarned,
    enumerable: false,
    configurable: false,
    writable: false,
  },
});

EventEmitter.on = function on(emitter, name, options = {}) {
  const queue = [];
  const waiters = [];
  let finished = false;
  const highWaterMark = Number(options.highWaterMark) || 1;
  const watermarkData = { high: highWaterMark, get size() { return queue.length; } };
  const cleanup = () => {
    emitter.off?.(name, onEvent);
    for (const closeName of options.close || []) emitter.off?.(closeName, onClose);
    emitter.off?.('error', onError);
  };
  const settle = (value, done = false) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value, done });
    else {
      queue.push(value);
      if (queue.length >= highWaterMark) emitter.pause?.();
    }
  };
  const onEvent = (...args) => settle(args.length === 1 ? args[0] : args);
  const onClose = () => {
    if (finished) return;
    finished = true;
    cleanup();
    while (waiters.length) waiters.shift()({ value: undefined, done: true });
  };
  const onError = (error) => {
    if (finished) return;
    finished = true;
    cleanup();
    while (waiters.length) waiters.shift()({ value: Promise.reject(error), done: false });
  };
  emitter.on?.(name, onEvent);
  for (const closeName of options.close || []) emitter.on?.(closeName, onClose);
  if (name !== 'error') emitter.on?.('error', onError);
  const iterator = {
    next() {
      if (queue.length) {
        const value = queue.shift();
        if (queue.length < highWaterMark) emitter.resume?.();
        return Promise.resolve({ value, done: false });
      }
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    return() { onClose(); return Promise.resolve({ value: undefined, done: true }); },
    [Symbol.asyncIterator]() { return this; },
    [Symbol.for('nodejs.watermarkData')]: watermarkData,
  };
  return iterator;
};
