import { UnsupportedWebCapabilityError } from './errors.js';

function requirePerformance(globalObject) {
  if (!globalObject.performance || typeof globalObject.performance.now !== 'function') {
    throw new UnsupportedWebCapabilityError('performance', 'the Performance Web API is not available');
  }
  return globalObject.performance;
}

function receivedValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an instance of Array';
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  return `type ${typeof value} (${String(value)})`;
}

function invalidArgType(name, expected, value) {
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${receivedValue(value)}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  error.toString = () => `TypeError [ERR_INVALID_ARG_TYPE]: ${error.message}`;
  return error;
}

function validateChannelName(name) {
  if (typeof name !== 'string' && typeof name !== 'symbol') {
    throw invalidArgType('channel', 'one of type string or symbol', name);
  }
  return name;
}

function activeProcess() {
  const processObject = globalThis?.process;
  if (!processObject || typeof processObject.nextTick !== 'function'
    || typeof processObject.getCode !== 'function') return null;
  return processObject;
}

function deferUncaughtException(error) {
  const processObject = activeProcess();
  const dispatch = () => {
    if (typeof processObject?._bnhDispatchUncaughtException === 'function') {
      processObject._bnhDispatchUncaughtException(error, false);
      return;
    }
    throw error;
  };
  if (processObject) processObject.nextTick(dispatch);
  else if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(dispatch);
  else globalThis.setTimeout(dispatch, 0);
}

function markChannelActive(channel) {
  if (!channel._subscribers) channel._subscribers = [];
  if (!channel._stores) channel._stores = new Map();
}

function maybeMarkChannelInactive(channel) {
  if (!channel._subscribers?.length && !channel._stores?.size) {
    channel._subscribers = undefined;
    channel._stores = undefined;
  }
}

function defaultTransform(data) {
  return data;
}

function wrapStoreRun(store, data, next, transform = defaultTransform) {
  return () => {
    let context;
    try {
      context = (transform || defaultTransform)(data);
    } catch (error) {
      deferUncaughtException(error);
      return next();
    }
    return store.run(context, next);
  };
}

class DiagnosticsChannel {
  constructor(name) {
    this._subscribers = undefined;
    this._stores = undefined;
    this.name = name;
  }

  subscribe(subscription) {
    if (typeof subscription !== 'function') throw invalidArgType('subscription', 'function', subscription);
    markChannelActive(this);
    this._subscribers.push(subscription);
  }

  unsubscribe(subscription) {
    const index = this._subscribers?.indexOf(subscription) ?? -1;
    if (index === -1) return false;
    const subscribers = this._subscribers.slice();
    subscribers.splice(index, 1);
    this._subscribers = subscribers;
    maybeMarkChannelInactive(this);
    return true;
  }

  bindStore(store, transform) {
    markChannelActive(this);
    this._stores.set(store, transform);
  }

  unbindStore(store) {
    if (!this._stores?.has(store)) return false;
    this._stores.delete(store);
    maybeMarkChannelInactive(this);
    return true;
  }

  get hasSubscribers() {
    return Boolean(this._subscribers?.length || this._stores?.size);
  }

  publish(data) {
    const subscribers = this._subscribers;
    for (let index = 0; index < (subscribers?.length || 0); index += 1) {
      try {
        subscribers[index](data, this.name);
      } catch (error) {
        deferUncaughtException(error);
      }
    }
  }

  runStores(data, fn, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    let run = () => {
      this.publish(data);
      return Reflect.apply(fn, thisArg, args);
    };
    for (const [store, transform] of this._stores || []) {
      run = wrapStoreRun(store, data, run, transform);
    }
    return run();
  }

  clear() {
    this._subscribers?.splice(0);
    this._stores?.clear();
    maybeMarkChannelInactive(this);
  }
}

export function createDiagnosticsChannel(name) {
  return new DiagnosticsChannel(validateChannelName(name));
}

function inspectConsoleValue(value, seen = new Set()) {
  if (typeof value === 'string') return `'${value.replaceAll("'", "\\'")}'`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return String(value);
  if (value instanceof RegExp) return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return `[ ${value.map((item) => inspectConsoleValue(item, seen)).join(', ')} ]`;
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  const entries = Object.keys(value).map((key) => {
    const property = /^[A-Za-z_$][\w$]*$/.test(key) ? key : inspectConsoleValue(key);
    return `${property}: ${inspectConsoleValue(value[key], seen)}`;
  });
  return `{ ${entries.join(', ')} }`;
}

function formatConsoleArguments(values) {
  return values.map((value) => (typeof value === 'string'
    ? value
    : inspectConsoleValue(value, new Set())));
}

export function createPerformanceContract(globalObject = globalThis) {
  const performance = requirePerformance(globalObject);
  return Object.freeze({
    now: () => performance.now(),
    mark: (name, options) => performance.mark(name, options),
    measure: (name, start, end, options) => performance.measure(name, start, end, options),
    clearMarks: (name) => performance.clearMarks(name),
    clearMeasures: (name) => performance.clearMeasures(name),
    getEntriesByName: (name, type) => performance.getEntriesByName(name, type),
    timeOrigin: performance.timeOrigin,
    PerformanceObserver: globalObject.PerformanceObserver,
  });
}

export function createAsyncContextContract() {
  return Object.freeze({
    supported: false,
    getStore() {
      throw new UnsupportedWebCapabilityError(
        'async context propagation',
        'the browser has no standardized AsyncLocalStorage Web API',
      );
    },
    run() {
      throw new UnsupportedWebCapabilityError(
        'async context propagation',
        'the browser has no standardized AsyncLocalStorage Web API',
      );
    },
  });
}

export function createAsyncLocalStorage() {
  return class AsyncLocalStorage {
    #store;

    disable() {
      this.#store = undefined;
    }

    getStore() {
      return this.#store;
    }

    enterWith(store) {
      this.#store = store;
    }

    run(store, callback, ...args) {
      const previous = this.#store;
      this.#store = store;
      try {
        return callback(...args);
      } finally {
        // Restore after callbacks scheduled by the scope's synchronous body.
        queueMicrotask(() => {
          this.#store = previous;
        });
      }
    }
  };
}

export function createDiagnosticsChannelRegistry() {
  const channels = new Map();
  return {
    channel(name) {
      if (!channels.has(name)) channels.set(name, createDiagnosticsChannel(name));
      return channels.get(name);
    },
    hasSubscribers(name) {
      return Boolean(channels.get(name)?.hasSubscribers);
    },
    clear() {
      for (const channel of channels.values()) channel.clear();
      channels.clear();
    },
  };
}

export function createDiagnosticsModule() {
  const channels = new Map();
  const instrumentedConsoleMethods = new WeakMap();
  const instrumentConsoleMethod = (name, channel) => {
    const consoleObject = globalThis?.console;
    const method = consoleObject?.[name];
    if (!consoleObject || typeof method !== 'function') return;
    let methods = instrumentedConsoleMethods.get(consoleObject);
    if (!methods) {
      methods = new Set();
      instrumentedConsoleMethods.set(consoleObject, methods);
    }
    if (methods.has(name)) return;
    methods.add(name);
    consoleObject[name] = function diagnosticsConsoleMethod(...args) {
      channel.publish(args);
      return method.apply(this, formatConsoleArguments(args));
    };
  };

  class Channel extends DiagnosticsChannel {
    constructor(name) {
      super(name);
      channels.set(this.name, this);
    }

    subscribe(subscription) {
      super.subscribe(subscription);
      if (typeof this.name === 'string' && this.name.startsWith('console.')) {
        instrumentConsoleMethod(this.name.slice('console.'.length), this);
      }
    }
  }

  const getChannel = (name) => {
    validateChannelName(name);
    if (!channels.has(name)) channels.set(name, new Channel(name));
    return channels.get(name);
  };
  return {
    channel: getChannel,
    subscribe(name, subscription) {
      return getChannel(name).subscribe(subscription);
    },
    unsubscribe(name, subscription) {
      const ch = channels.get(name);
      if (!ch) return false;
      return ch.unsubscribe(subscription);
    },
    hasSubscribers(name) {
      const ch = channels.get(name);
      return ch ? ch.hasSubscribers : false;
    },
    clear() {
      for (const channel of channels.values()) channel.clear();
      channels.clear();
    },
    tracingChannel(nameOrChannels) {
      const channelNames = typeof nameOrChannels === 'string'
        ? { start: `${nameOrChannels}:start`, end: `${nameOrChannels}:end`, asyncStart: `${nameOrChannels}:asyncStart`, asyncEnd: `${nameOrChannels}:asyncEnd`, error: `${nameOrChannels}:error` }
        : { ...nameOrChannels };
      const tracing = {};
      for (const [key, value] of Object.entries(channelNames)) {
        tracing[key] = typeof value === 'string' ? getChannel(value) : value;
      }
      tracing.subscribe = (handlers) => {
        for (const [name, handler] of Object.entries(handlers || {})) {
          if (tracing[name] && typeof handler === 'function') tracing[name].subscribe(handler);
        }
        return tracing;
      };
      tracing.unsubscribe = (handlers) => {
        let done = true;
        for (const [name, handler] of Object.entries(handlers || {})) {
          if (tracing[name] && typeof handler === 'function') {
            done = tracing[name].unsubscribe(handler) && done;
          }
        }
        return done;
      };
      tracing.traceSync = (fn, context = {}) => {
        tracing.start.publish(context);
        try {
          const result = fn();
          tracing.end.publish({ ...context, result });
          return result;
        } catch (error) {
          tracing.error.publish({ ...context, error });
          throw error;
        }
      };
      tracing.tracePromise = (fn, context = {}) => {
        tracing.asyncStart.publish(context);
        let result;
        try {
          result = fn();
        } catch (error) {
          tracing.error.publish({ ...context, error });
          return Promise.reject(error);
        }
        return Promise.resolve(result).then(
          (value) => { tracing.asyncEnd.publish({ ...context, result: value }); return value; },
          (error) => { tracing.error.publish({ ...context, error }); throw error; },
        );
      };
      tracing.traceCallback = (fn, context = {}, thisArg, ...args) => {
        tracing.start.publish(context);
        try {
          const result = fn.apply(thisArg, args);
          tracing.end.publish({ ...context, result });
          return result;
        } catch (error) {
          tracing.error.publish({ ...context, error });
          throw error;
        }
      };
      Object.defineProperty(tracing, 'hasSubscribers', {
        get: () => Object.values(tracing).some((c) => c && c.hasSubscribers),
      });
      return tracing;
    },
    Channel,
  };
}

export function createDiagnosticsContract(globalObject = globalThis) {
  return Object.freeze({
    performance: createPerformanceContract(globalObject),
    diagnosticsModule: createDiagnosticsModule(),
    channel: createDiagnosticsChannel,
    asyncContext: Object.freeze({
      supported: true,
      AsyncLocalStorage: createAsyncLocalStorage(),
    }),
    createError(message, { cause, code } = {}) {
      const error = new Error(message, { cause });
      if (code !== undefined) error.code = code;
      return error;
    },
  });
}
