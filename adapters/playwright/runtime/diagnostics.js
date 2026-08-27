import { UnsupportedWebCapabilityError } from './errors.js';

function requirePerformance(globalObject) {
  if (!globalObject.performance || typeof globalObject.performance.now !== 'function') {
    throw new UnsupportedWebCapabilityError('performance', 'the Performance Web API is not available');
  }
  return globalObject.performance;
}

export function createDiagnosticsChannel(name) {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('channel name must be non-empty');
  const listeners = new Set();
  const channel = {
    name,
    get hasSubscribers() { return listeners.size > 0; },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
    },
    unsubscribe(listener) {
      return listeners.delete(listener);
    },
    publish(message) {
      const snapshot = [...listeners];
      for (let index = 0; index < snapshot.length; index += 1) snapshot[index](message);
    },
    clear() {
      listeners.clear();
    },
  };
  return Object.freeze(channel);
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
  const getChannel = (name) => {
    if (!channels.has(name)) channels.set(name, createDiagnosticsChannel(name));
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
    Channel: class Channel {
      constructor(name) {
        const ch = createDiagnosticsChannel(name);
        this.name = ch.name;
        this.subscribe = ch.subscribe;
        this.unsubscribe = ch.unsubscribe;
        this.publish = ch.publish;
        Object.defineProperty(this, 'hasSubscribers', {
          get: () => ch.hasSubscribers,
        });
      }
    },
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
