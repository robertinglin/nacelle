/**
 * Small event emitter used by browser adapters.
 *
 * Browser EventTarget listeners receive Event objects, while Node-facing
 * shims conventionally receive the useful payload directly. Keeping this
 * translation in one place avoids making every adapter know both contracts.
 */
import { AsyncResource } from './async-hooks.js';
import { installAbortSignalTimeout } from './timers.js';

let defaultMaxListeners = 10;
const kMaxEventTargetListeners = Symbol('events.maxEventTargetListeners');
const kMaxEventTargetListenersWarned = Symbol('events.maxEventTargetListenersWarned');
const kCapture = Symbol('events.captureRejections');
const captureRejectionSymbol = Symbol.for('nodejs.rejection');
const errorMonitor = Symbol('events.errorMonitor');
let EventEmitterAsyncResource;

class ListenerList extends Array {
  get size() {
    return this.length;
  }

  add(listener) {
    this.push(listener);
    return this;
  }

  delete(listener) {
    const index = this.lastIndexOf(listener);
    if (index < 0) return false;
    this.splice(index, 1);
    return true;
  }

  clear() {
    this.length = 0;
  }
}

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

function invalidArgumentType(name, expected, value) {
  const normalizedExpected = expected === 'of type Function'
    ? 'of type function'
    : expected === 'of type Object'
      ? 'of type object'
      : expected;
  const error = new TypeError(
    `The "${name}" ${name.includes('.') ? 'property' : 'argument'} must be ${normalizedExpected}. Received ${receivedValue(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateFunction(value, name) {
  if (typeof value !== 'function') throw invalidArgumentType(name, 'of type Function', value);
}

function validateObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArgumentType(name, 'of type Object', value);
  }
}

function validateAbortSignal(value, name) {
  if (value !== undefined
    && (value === null || typeof value !== 'object' || !('aborted' in value))) {
    throw invalidArgumentType(name, 'AbortSignal', value);
  }
}

function validateMaxListeners(value, name = 'n') {
  if (typeof value !== 'number') {
    throw invalidArgumentType(name, 'of type number', value);
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

function invalidEmitter(value) {
  const error = new TypeError(
    `The "emitter" argument must be an instance of EventEmitter or EventTarget. Received ${receivedValue(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidThis(name) {
  const error = new TypeError(`Value of "this" must be of type ${name}`);
  error.code = 'ERR_INVALID_THIS';
  return error;
}

function invalidEventEmitter(value) {
  const error = new TypeError(
    `The "emitter" argument must be an instance of EventEmitter. Received ${receivedValue(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function initializeCapture(target, options) {
  if (options?.captureRejections) {
    if (typeof options.captureRejections !== 'boolean') {
      throw invalidArgumentType('options.captureRejections', 'of type boolean', options.captureRejections);
    }
    target[kCapture] = Boolean(options.captureRejections);
  } else {
    target[kCapture] = EventEmitter.prototype[kCapture];
  }
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
  constructor(options) {
    this._listeners = new Map();
    this._onceListeners = new Map();
    this._maxListeners = undefined;
    this._warned = new Set();
    if (typeof EventEmitter.init === 'function') EventEmitter.init.call(this, options);
    initializeCapture(this, options);
  }

  static get defaultMaxListeners() {
    return defaultMaxListeners;
  }

  static set defaultMaxListeners(value) {
    defaultMaxListeners = validateMaxListeners(value, 'defaultMaxListeners');
  }

  on(name, listener) {
    validateFunction(listener, 'listener');
    if (name !== 'newListener') this.emit('newListener', name, listener.listener || listener);
    const listeners = this._listeners.get(name) || new ListenerList();
    listeners.add(listener);
    this._listeners.set(name, listeners);
    syncEvents(this);
    this.checkListenerLimit(name, listeners);
    return this;
  }

  addListener(name, listener) {
    return this.on(name, listener);
  }

  prependListener(name, listener) {
    validateFunction(listener, 'listener');
    if (name !== 'newListener') this.emit('newListener', name, listener.listener || listener);
    const listeners = this._listeners.get(name) || new ListenerList();
    this._listeners.set(name, new ListenerList(listener, ...listeners));
    syncEvents(this);
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
    validateFunction(listener, 'listener');
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
    validateFunction(listener, 'listener');
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
    validateFunction(listener, 'listener');
    const listeners = this._listeners.get(name);
    if (!listeners) return this;
    let index = listeners.length - 1;
    while (index >= 0 && listeners[index] !== listener && listeners[index].listener !== listener) index -= 1;
    if (index >= 0) {
      const removed = listeners[index];
      listeners.splice(index, 1);
      const onceListeners = this._onceListeners.get(removed.listener ? removed.listener : listener);
      if (onceListeners) {
        onceListeners.delete(removed);
        if (onceListeners.size === 0) this._onceListeners.delete(removed.listener);
      }
    }
    if (listeners.size === 0) this._listeners.delete(name);
    syncEvents(this);
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
        for (const listener of [...listeners]) this.off(name, listener);
      }
    }
    syncEvents(this);
    return this;
  }

  emit(name, ...args) {
    if (name === 'error') {
      const monitors = this._listeners.get(errorMonitor);
      if (monitors?.size) {
        const snapshot = [...monitors];
        for (let index = 0; index < snapshot.length; index += 1) snapshot[index].apply(this, args);
      }
    }
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
    for (let index = 0; index < snapshot.length; index += 1) {
      const result = snapshot[index].apply(this, args);
      if (this[kCapture] && result && typeof result.then === 'function') {
        try {
          result.then(undefined, (error) => {
            const processObject = globalThis.process;
            const dispatch = () => {
              if (typeof this[captureRejectionSymbol] === 'function') {
                this[captureRejectionSymbol](error, name, ...args);
                return;
              }
              const previous = this[kCapture];
              this[kCapture] = false;
              try { this.emit('error', error); } finally { this[kCapture] = previous; }
            };
            if (typeof processObject?.nextTick === 'function') processObject.nextTick(dispatch);
            else if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(dispatch);
            else dispatch();
          });
        } catch (error) {
          this.emit('error', error);
        }
      }
    }
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

  rawListeners(name) {
    const listeners = this._listeners.get(name);
    if (!listeners || listeners.size === 0) return [];
    return [...listeners];
  }

  eventNames() {
    return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
  }
}

function syncEvents(emitter) {
  let events = emitter._events;
  if (!events || typeof events !== 'object') {
    events = Object.create(null);
    emitter._events = events;
  }
  for (const key of Reflect.ownKeys(events)) delete events[key];
  for (const [name, listeners] of emitter._listeners) {
    if (listeners.size === 0) continue;
    const values = [...listeners];
    Object.defineProperty(events, name, {
      configurable: true,
      enumerable: typeof name === 'string',
      writable: true,
      value: values.length === 1 ? values[0] : values,
    });
  }
  emitter._eventsCount = emitter._listeners.size;
}

export function getEventListeners(emitter, name) {
  if (emitter && typeof emitter.listeners === 'function') {
    return emitter.listeners(name);
  }
  if (isEventTarget(emitter)) return [];
  throw invalidEmitter(emitter);
}

export function getMaxListeners(emitterOrTarget) {
  if (typeof emitterOrTarget?.getMaxListeners === 'function') {
    return emitterOrTarget._maxListeners === undefined
      ? defaultMaxListeners
      : emitterOrTarget._maxListeners;
  }
  if (isEventTarget(emitterOrTarget)) {
    return typeof emitterOrTarget[kMaxEventTargetListeners] === 'number'
      ? emitterOrTarget[kMaxEventTargetListeners]
      : defaultMaxListeners;
  }
  throw invalidEmitter(emitterOrTarget);
}

// Node exposes these names as aliases. Some upstream tests compare the
// function objects directly, so delegation is not equivalent here.
BrowserEventEmitter.prototype.addListener = BrowserEventEmitter.prototype.on;
BrowserEventEmitter.prototype.removeListener = BrowserEventEmitter.prototype.off;

export function once(emitter, name, options = {}) {
  try {
    validateObject(options, 'options');
    validateAbortSignal(options.signal, 'options.signal');
    if (typeof emitter?.on !== 'function' && typeof emitter?.addEventListener !== 'function') {
      throw invalidEventEmitter(emitter);
    }
  } catch (error) {
    return Promise.reject(error);
  }
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
    throw invalidArgumentType('signal', 'an instance of AbortSignal', signal);
  }
  validateFunction(listener, 'listener');
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
    this._events = Object.create(null);
    this._eventsCount = 0;
    this._maxListeners = undefined;
    this._warned = new Set();
  }
  if (typeof EventEmitter.init === 'function') EventEmitter.init.call(this, ...args);
  return this;
}

EventEmitter.prototype = BrowserEventEmitter.prototype;
EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;
EventEmitter.init = function init(options) {
  initializeCapture(this, options);
};
Object.defineProperty(EventEmitter.prototype, kCapture, {
  configurable: false,
  enumerable: false,
  value: false,
  writable: true,
});
Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
  configurable: true,
  get: () => defaultMaxListeners,
  set: (value) => { defaultMaxListeners = validateMaxListeners(value, 'defaultMaxListeners'); },
});

Object.defineProperty(EventEmitter, 'captureRejections', {
  enumerable: true,
  get: () => EventEmitter.prototype[kCapture],
  set: (value) => {
    if (typeof value !== 'boolean') {
      throw invalidArgumentType('EventEmitter.captureRejections', 'of type boolean', value);
    }
    EventEmitter.prototype[kCapture] = value;
  },
});

EventEmitter.captureRejectionSymbol = captureRejectionSymbol;
EventEmitter.errorMonitor = errorMonitor;

function lazyEventEmitterAsyncResource() {
  if (EventEmitterAsyncResource !== undefined) return EventEmitterAsyncResource;
  const kEventEmitter = Symbol('events.eventEmitter');
  const kAsyncResource = Symbol('events.asyncResource');
  class EventEmitterReferencingAsyncResource extends AsyncResource {
    constructor(emitter, type, options) {
      super(type, options);
      this[kEventEmitter] = emitter;
    }

    get eventEmitter() {
      if (this[kEventEmitter] === undefined) throw invalidThis('EventEmitterReferencingAsyncResource');
      return this[kEventEmitter];
    }
  }
  EventEmitterAsyncResource = class EventEmitterAsyncResource extends EventEmitter {
    constructor(options = undefined) {
      let name;
      if (typeof options === 'string') {
        name = options;
        options = undefined;
      } else {
        if (new.target === EventEmitterAsyncResource && typeof options?.name !== 'string') {
          throw invalidArgumentType('options.name', 'of type string', options?.name);
        }
        name = options?.name || new.target.name;
      }
      super(options);
      this[kAsyncResource] = new EventEmitterReferencingAsyncResource(this, name, options);
    }

    emit(event, ...args) {
      if (this[kAsyncResource] === undefined) throw invalidThis('EventEmitterAsyncResource');
      return this.asyncResource.runInAsyncScope(super.emit, this, event, ...args);
    }

    emitDestroy() {
      if (this[kAsyncResource] === undefined) throw invalidThis('EventEmitterAsyncResource');
      this.asyncResource.emitDestroy();
    }

    get asyncId() {
      if (this[kAsyncResource] === undefined) throw invalidThis('EventEmitterAsyncResource');
      return this.asyncResource.asyncId();
    }

    get triggerAsyncId() {
      if (this[kAsyncResource] === undefined) throw invalidThis('EventEmitterAsyncResource');
      return this.asyncResource.triggerAsyncId();
    }

    get asyncResource() {
      if (this[kAsyncResource] === undefined) throw invalidThis('EventEmitterAsyncResource');
      return this[kAsyncResource];
    }
  };
  return EventEmitterAsyncResource;
}

Object.defineProperty(EventEmitter, 'EventEmitterAsyncResource', {
  configurable: true,
  enumerable: true,
  get: lazyEventEmitterAsyncResource,
  set: undefined,
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

EventEmitter.getMaxListeners = getMaxListeners;

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
  validateObject(options, 'options');
  validateAbortSignal(options.signal, 'options.signal');
  if (typeof emitter?.on !== 'function' && typeof emitter?.addEventListener !== 'function') {
    throw invalidEventEmitter(emitter);
  }
  const highWaterMark = options.highWaterMark ?? options.highWatermark ?? Number.MAX_SAFE_INTEGER;
  const lowWaterMark = options.lowWaterMark ?? options.lowWatermark ?? 1;
  if (typeof highWaterMark !== 'number') throw invalidArgumentType('options.highWaterMark', 'of type number', highWaterMark);
  if (typeof lowWaterMark !== 'number') throw invalidArgumentType('options.lowWaterMark', 'of type number', lowWaterMark);
  if (!Number.isInteger(highWaterMark) || highWaterMark < 1 || highWaterMark > Number.MAX_SAFE_INTEGER) {
    const error = new RangeError(`The value of "options.highWaterMark" is out of range. It must be >= 1 && <= ${Number.MAX_SAFE_INTEGER}. Received ${receivedValue(highWaterMark)}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (!Number.isInteger(lowWaterMark) || lowWaterMark < 1 || lowWaterMark > Number.MAX_SAFE_INTEGER) {
    const error = new RangeError(`The value of "options.lowWaterMark" is out of range. It must be >= 1 && <= ${Number.MAX_SAFE_INTEGER}. Received ${receivedValue(lowWaterMark)}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  const queue = [];
  const waiters = [];
  let finished = false;
  // readline's Interface async iterator asks events.on() to yield only its
  // first event argument. Keep the normal Node contract (one value for one
  // argument, an array for multiple arguments) for every other caller. The
  // marker is owned by Node's internal/events/symbols module, so identify it
  // by its stable description instead of creating a second, incompatible
  // symbol in this shared browser shim.
  const firstEventParam = Object.getOwnPropertySymbols(options)
    .some((symbol) => symbol.description === 'kFirstEventParam' && options[symbol] === true);
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
  const onEvent = (...args) => settle(firstEventParam ? args[0] : args.length === 1 ? args[0] : args);
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
