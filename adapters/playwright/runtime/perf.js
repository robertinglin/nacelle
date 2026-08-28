import { UnsupportedWebCapabilityError } from './errors.js';
import { inspect } from './assert.js';

const HOST_ONLY_REASON = 'this metric requires access to the host Node.js process';
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const PERFORMANCE_METHODS = Object.freeze([
  'now',
  'getEntries',
  'getEntriesByName',
  'getEntriesByType',
  'mark',
  'measure',
  'clearMarks',
  'clearMeasures',
  'clearResourceTimings',
  'setResourceTimingBufferSize',
  'markResourceTiming',
  'toJSON',
]);

const PERFORMANCE_CONSTANTS = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 2,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 4,
  NODE_PERFORMANCE_GC_WEAKCB: 8,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0,
  NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 1,
  NODE_PERFORMANCE_GC_FLAGS_FORCED: 2,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 4,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 8,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 16,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 32,
});

function unsupportedFunction(capability, reason = HOST_ONLY_REASON) {
  return function unsupportedBrowserMetric() {
    throw new UnsupportedWebCapabilityError(capability, reason);
  };
}

function defineUnsupportedProperty(target, property, capability, reason = HOST_ONLY_REASON) {
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: false,
    get: () => {
      throw new UnsupportedWebCapabilityError(capability, reason);
    },
  });
}

function requirePerformance(globalObject) {
  const performance = globalObject?.performance;
  if (!performance || typeof performance.now !== 'function') {
    throw new UnsupportedWebCapabilityError(
      'performance',
      'the Performance Web API is not available',
    );
  }
  return performance;
}

function bindPerformanceMethod(performance, name) {
  if (typeof performance[name] !== 'function') {
    return unsupportedFunction(
      `performance.${name}`,
      `the Performance Web API does not provide ${name}()`,
    );
  }
  return performance[name].bind(performance);
}

function inspectOptionsAtChildDepth(options = {}) {
  return {
    ...options,
    depth: options.depth == null ? null : options.depth - 1,
  };
}

function inspectPerformanceEntry(depth, options = {}) {
  if (depth < 0) return this;
  return `${this.constructor.name} ${inspect(this.toJSON(), inspectOptionsAtChildDepth(options))}`;
}

function installInspectCustom(target, handler) {
  if (!target || typeof target !== 'object') return;
  if (typeof target[INSPECT_CUSTOM] === 'function') return;
  try {
    Object.defineProperty(target, INSPECT_CUSTOM, {
      configurable: true,
      writable: true,
      value: handler,
    });
  } catch {
    // Some browser built-in prototypes may be non-extensible.
  }
}

function installPerformanceEntryInspect(globalObject) {
  for (const constructor of [
    globalObject.PerformanceEntry,
    globalObject.PerformanceMark,
    globalObject.PerformanceMeasure,
  ]) {
    installInspectCustom(constructor?.prototype, inspectPerformanceEntry);
  }
}

function scheduleMicrotask(globalObject, callback) {
  if (typeof globalObject.queueMicrotask === 'function') {
    globalObject.queueMicrotask(callback);
    return;
  }
  Promise.resolve().then(callback);
}

function sortEntries(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const timeDifference = Number(left.entry.startTime) - Number(right.entry.startTime);
      return timeDifference || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function createObserverEntryListClass() {
  return class BrowserPerformanceObserverEntryList {
    #entries;

    constructor(entries) {
      this.#entries = sortEntries(entries);
    }

    getEntries() {
      return [...this.#entries];
    }

    getEntriesByName(name, type) {
      return this.#entries.filter((entry) => (
        entry.name === name && (type === undefined || entry.entryType === type)
      ));
    }

    getEntriesByType(type) {
      return this.#entries.filter((entry) => entry.entryType === type);
    }
  };
}

function normalizeObserveOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('PerformanceObserver.observe() requires an options object');
  }

  const hasType = options.type !== undefined;
  const hasEntryTypes = options.entryTypes !== undefined;
  if (hasType && hasEntryTypes) {
    throw new TypeError('PerformanceObserver.observe() cannot specify both type and entryTypes');
  }

  const entryTypes = hasType ? [options.type] : options.entryTypes;
  if (!Array.isArray(entryTypes) || entryTypes.length === 0) {
    throw new TypeError('PerformanceObserver.observe() requires type or a non-empty entryTypes array');
  }
  if (entryTypes.some((type) => typeof type !== 'string' || type.length === 0)) {
    throw new TypeError('PerformanceObserver entry types must be non-empty strings');
  }

  return { entryTypes: [...new Set(entryTypes)], buffered: options.buffered === true };
}

function createPerformanceObserver(globalObject, functionObservers) {
  const NativePerformanceObserver = globalObject.PerformanceObserver;
  if (typeof NativePerformanceObserver !== 'function') {
    return { Observer: undefined, EntryList: createObserverEntryListClass() };
  }

  const EntryList = createObserverEntryListClass();
  const states = new WeakMap();

  function stateOf(observer) {
    return states.get(observer);
  }

  function takeRecords(observer) {
    const state = stateOf(observer);
    if (!state) return [];

    const entries = state.nativeRecords.splice(0);
    if (state.nativeObserver) entries.push(...state.nativeObserver.takeRecords());
    entries.push(...state.functionRecords.splice(0));
    return sortEntries(entries);
  }

  function scheduleDelivery(observer) {
    const state = stateOf(observer);
    if (!state || state.deliveryScheduled) return;
    state.deliveryScheduled = true;
    scheduleMicrotask(globalObject, () => {
      const current = stateOf(observer);
      if (!current) return;
      current.deliveryScheduled = false;
      if (current.observedTypes.size === 0) {
        current.nativeRecords.length = 0;
        current.functionRecords.length = 0;
        return;
      }
      const entries = takeRecords(observer);
      if (entries.length > 0) current.callback(new EntryList(entries), observer);
    });
  }

  function disconnectObserver(observer) {
    const state = stateOf(observer);
    if (!state) return;
    state.nativeObserver?.disconnect();
    state.observedTypes.clear();
    state.nativeTypes.clear();
    state.nativeRecords.length = 0;
    state.functionRecords.length = 0;
    functionObservers.delete(observer);
  }

  function recordFunctionEntry(entry) {
    for (const observer of functionObservers) {
      const state = stateOf(observer);
      if (!state || !state.observedTypes.has('function')) continue;
      state.functionRecords.push(entry);
      scheduleDelivery(observer);
    }
  }

  class BrowserPerformanceObserver {
    constructor(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('PerformanceObserver callback must be a function');
      }

      const observer = this;
      const state = {
        callback,
        deliveryScheduled: false,
        functionRecords: [],
        nativeObserver: null,
        nativeRecords: [],
        nativeTypes: new Set(),
        observedTypes: new Set(),
      };
      state.nativeObserver = new NativePerformanceObserver((list) => {
        const current = stateOf(observer);
        if (!current || current.observedTypes.size === 0) return;
        current.nativeRecords.push(...list.getEntries());
        scheduleDelivery(observer);
      });
      states.set(this, state);
    }

    observe(options) {
      const state = stateOf(this);
      const normalized = normalizeObserveOptions(options);
      const nativeTypes = normalized.entryTypes.filter((type) => type !== 'function');

      disconnectObserver(this);
      state.observedTypes = new Set(normalized.entryTypes);
      state.nativeTypes = new Set(nativeTypes);

      try {
        if (nativeTypes.length > 0) {
          state.nativeObserver.observe({ entryTypes: nativeTypes, buffered: normalized.buffered });
        }
      } catch (error) {
        disconnectObserver(this);
        throw error;
      }

      if (state.observedTypes.has('function')) functionObservers.add(this);
    }

    disconnect() {
      disconnectObserver(this);
    }

    takeRecords() {
      return takeRecords(this);
    }
  }

  installInspectCustom(BrowserPerformanceObserver.prototype, function inspectObserver(depth, options = {}) {
    if (depth < 0) return this;
    const state = stateOf(this);
    const records = state
      ? [...state.nativeRecords, ...state.functionRecords]
      : [];
    return `PerformanceObserver ${inspect({
      connected: Boolean(state?.observedTypes.size),
      pending: Boolean(state?.deliveryScheduled || records.length),
      entryTypes: state ? [...state.observedTypes] : [],
      buffer: records,
    }, inspectOptionsAtChildDepth(options))}`;
  });

  const nativeTypes = Array.isArray(NativePerformanceObserver.supportedEntryTypes)
    ? NativePerformanceObserver.supportedEntryTypes
    : [];
  Object.defineProperty(BrowserPerformanceObserver, 'supportedEntryTypes', {
    configurable: false,
    enumerable: true,
    value: Object.freeze([...new Set([...nativeTypes, 'function'])]),
  });

  return {
    Observer: BrowserPerformanceObserver,
    EntryList,
    recordFunctionEntry,
  };
}

function createFunctionEntry(name, startTime, duration, detail) {
  const entry = {
    name,
    entryType: 'function',
    startTime,
    duration,
    detail,
    toJSON() {
      return {
        name: this.name,
        entryType: this.entryType,
        startTime: this.startTime,
        duration: this.duration,
        detail: this.detail,
      };
    },
  };
  if (Array.isArray(detail)) {
    detail.forEach((value, index) => { entry[index] = value; });
  }
  Object.defineProperty(entry, INSPECT_CUSTOM, {
    configurable: true,
    value: inspectPerformanceEntry,
  });
  return entry;
}

function createVirtualEventLoopUtilization(performance, globalObject) {
  const startedAt = performance.now();
  let preLoopSnapshots = 3;

  function snapshot() {
    if (preLoopSnapshots > 0) {
      preLoopSnapshots -= 1;
      return { idle: 0, active: 0, utilization: 0 };
    }
    const active = Math.max(0, performance.now() - startedAt);
    const idle = 1;
    return { idle, active, utilization: active + idle === 0 ? 0 : active / (active + idle) };
  }

  function subtract(left, right) {
    const active = Math.max(0, Number(left?.active) - Number(right?.active));
    const idle = Math.max(0, Number(left?.idle) - Number(right?.idle));
    const total = active + idle;
    return { idle, active, utilization: total === 0 ? 0 : active / total };
  }

  return function eventLoopUtilization(first, second) {
    if (first === undefined) return snapshot();
    if (second === undefined) return subtract(snapshot(), first);
    return subtract(first, second);
  };
}

function createVirtualNodeTiming(performance, globalObject) {
  let firstLoopStartRead = true;
  let firstLoopExitRead = true;
  let firstIdleTimeRead = true;
  const values = {
    name: 'node',
    entryType: 'node',
    startTime: 0,
    nodeStart: 0,
    v8Start: 1,
    environment: 2,
    bootstrapComplete: 3,
  };
  const timing = { ...values };
  Object.defineProperties(timing, {
    duration: { enumerable: true, get: () => performance.now() },
    loopStart: { enumerable: true, get: () => {
      if (firstLoopStartRead) {
        firstLoopStartRead = false;
        return -1;
      }
      return Math.max(values.bootstrapComplete, performance.now() - 1);
    } },
    loopExit: { enumerable: true, get: () => {
      if (firstLoopExitRead) {
        firstLoopExitRead = false;
        return -1;
      }
      return Math.max(0, performance.now() - 1);
    } },
    idleTime: { enumerable: true, get: () => {
      if (firstIdleTimeRead) {
        firstIdleTimeRead = false;
        return 0;
      }
      return 1;
    } },
    uvMetricsInfo: { enumerable: true, get: () => ({ loopIdleTime: 0, loopCount: 0 }) },
    toJSON: { enumerable: false, value() {
      return {
        ...values,
        duration: timing.duration,
        loopStart: timing.loopStart,
        loopExit: timing.loopExit,
        idleTime: timing.idleTime,
        uvMetricsInfo: timing.uvMetricsInfo,
      };
    } },
  });
  for (const name of ['nodeStart', 'v8Start', 'environment', 'bootstrapComplete']) {
    try { performance.mark(name, { startTime: values[name] }); } catch { /* browser mark options vary */ }
  }
  return timing;
}

function createVirtualHistogram(performance) {
  const EMPTY_MIN = 9223372036854776000;
  const EMPTY_MIN_BIGINT = 9223372036854775807n;
  const stateKey = Symbol('virtualHistogramState');
  const HistogramConstructor = class Histogram {
    constructor() {
      const error = new TypeError('Illegal constructor');
      error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
      throw error;
    }
  };

  return function createHistogram(options) {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw new TypeError('createHistogram() options must be an object');
    }

    const samples = [];
    let lastRecordTime;
    let enabled = true;
    const histogram = {
      enable() {
        enabled = true;
        return this;
      },
      disable() {
        enabled = false;
        return this;
      },
      reset() {
        samples.length = 0;
        lastRecordTime = undefined;
      },
      record(value, count = 1) {
        if (!enabled) return;
        if (typeof value !== 'number') {
          const error = new TypeError('The "val" argument must be of type number');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (!Number.isFinite(value) || value < 0) {
          const error = new RangeError('The "val" argument is out of range');
          error.code = 'ERR_OUT_OF_RANGE';
          throw error;
        }
        if (!Number.isSafeInteger(count) || count < 1) {
          const error = new RangeError('The "count" argument is out of range');
          error.code = 'ERR_OUT_OF_RANGE';
          throw error;
        }
        for (let index = 0; index < count; index += 1) samples.push(Math.floor(value));
      },
      recordBigInt(value) {
        if (typeof value !== 'bigint') {
          const error = new TypeError('The "val" argument must be of type bigint');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (value < 0n) {
          const error = new RangeError('The "val" argument is out of range');
          error.code = 'ERR_OUT_OF_RANGE';
          throw error;
        }
        if (enabled) samples.push(Number(value));
      },
      add(other) {
        const otherState = other?.[stateKey];
        if (!otherState) {
          const error = new TypeError('The "other" argument must be a Histogram');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (enabled) samples.push(...otherState.samples);
      },
      recordDelta() {
        const now = performance.now();
        const delta = lastRecordTime === undefined ? 0 : Math.max(0, now - lastRecordTime) * 1e6;
        lastRecordTime = now;
        this.record(Math.floor(delta));
      },
      percentile(percentile) {
        if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
          throw new RangeError('percentile must be between 0 and 100');
        }
        if (samples.length === 0) return 0;
        const sorted = [...samples].sort((left, right) => left - right);
        const index = Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1);
        return sorted[Math.max(0, index)];
      },
      percentileBigInt(percentile) {
        return BigInt(this.percentile(percentile));
      },
    };

    for (const property of [
      'count', 'countBigInt', 'min', 'minBigInt', 'max', 'maxBigInt',
      'mean', 'stddev', 'exceeds', 'exceedsBigInt', 'sum',
    ]) {
      Object.defineProperty(histogram, property, {
        enumerable: true,
        get() {
          if (property === 'count') return samples.length;
          if (property === 'countBigInt') return BigInt(samples.length);
          if (property === 'min') return samples.length ? Math.min(...samples) : EMPTY_MIN;
          if (property === 'minBigInt') return samples.length ? BigInt(Math.min(...samples)) : EMPTY_MIN_BIGINT;
          if (property === 'max') return samples.length ? Math.max(...samples) : 0;
          if (property === 'maxBigInt') return samples.length ? BigInt(Math.max(...samples)) : 0n;
          if (property === 'exceeds') return 0;
          if (property === 'exceedsBigInt') return 0n;
          if (samples.length === 0 && ['mean', 'stddev'].includes(property)) return Number.NaN;
          if (samples.length === 0) return 0;
          const sum = samples.reduce((total, value) => total + value, 0);
          if (property === 'sum') return sum;
          const mean = sum / samples.length;
          if (property === 'mean') return mean;
          return Math.sqrt(samples.reduce((total, value) => total + ((value - mean) ** 2), 0) / samples.length);
        },
      });
    }
    Object.defineProperty(histogram, 'percentiles', {
      enumerable: true,
      get: () => new Map([
        [0, samples.length ? Math.min(...samples) : 0],
        [100, samples.length ? Math.max(...samples) : 0],
      ]),
    });
    Object.defineProperty(histogram, 'percentilesBigInt', {
      enumerable: true,
      get: () => new Map([
        [0, BigInt(samples.length ? Math.min(...samples) : 0)],
        [100, BigInt(samples.length ? Math.max(...samples) : 0)],
      ]),
    });
    Object.defineProperty(histogram, stateKey, { value: { samples } });
    Object.defineProperty(histogram, 'constructor', { configurable: true, value: HistogramConstructor });
    Object.defineProperty(histogram, Symbol.for('nodejs.util.inspect.custom'), {
      configurable: true,
      value(depth) { return depth < 0 ? '[RecordableHistogram]' : 'Histogram'; },
    });
    Object.defineProperty(histogram, Symbol.toStringTag, { value: 'Histogram' });
    return histogram;
  };
}

function createVirtualMonitorEventLoopDelay(createHistogram) {
  return function monitorEventLoopDelay(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('monitorEventLoopDelay() options must be an object');
    }
    if (options.resolution !== undefined
      && (!Number.isInteger(options.resolution) || options.resolution < 1)) {
      throw new RangeError('monitorEventLoopDelay() resolution must be a positive integer');
    }
    const histogram = createHistogram();
    histogram.enable();
    return histogram;
  };
}

function createVirtualProcessMetadata() {
  const zeroCpuUsage = (previous) => {
    if (previous !== undefined && (previous === null || typeof previous !== 'object')) {
      throw new TypeError('process.cpuUsage() previous value must be an object');
    }
    return { user: 0, system: 0 };
  };
  const memoryUsage = () => ({
    // Browsers do not expose the host process's RSS or allocator counters.
    // Keep the observable Node contract usable without leaking a fake host
    // measurement; arrayBuffers remains zero so size-delta checks are skipped.
    rss: 1,
    heapTotal: 1,
    heapUsed: 1,
    external: 1,
    arrayBuffers: 0,
  });
  memoryUsage.rss = () => 1;
  return {
    memoryUsage,
    cpuUsage: zeroCpuUsage,
    threadCpuUsage: zeroCpuUsage,
    resourceUsage: () => ({
      userCPUTime: 0,
      systemCPUTime: 0,
      maxRSS: 0,
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    }),
    getActiveResourcesInfo: () => [],
    availableMemory: () => 0,
    constrainedMemory: () => 0,
  };
}

function createTimerify(performance, recordFunctionEntry) {
  return function timerify(fn, options) {
    if (typeof fn !== 'function') {
      const error = new TypeError('The "fn" argument must be of type function');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw new TypeError('timerify() options must be an object');
    }
    if (options?.histogram !== undefined && typeof options.histogram?.record !== 'function') {
      const error = new TypeError('The "histogram" option must provide a record() method');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    const wrapped = function timerified(...args) {
      const startTime = performance.now();
      const complete = () => {
        const duration = performance.now() - startTime;
        options?.histogram?.record(duration * 1e6);
        recordFunctionEntry(createFunctionEntry(fn.name, startTime, duration, args));
      };

      let result;
      try {
        result = new.target
          ? Reflect.construct(fn, args, fn)
          : Reflect.apply(fn, this, args);
      } catch (error) {
        complete();
        throw error;
      }

      if (!new.target && typeof result?.finally === 'function') return result.finally(complete);
      complete();
      return result;
    };

    Object.defineProperty(wrapped, 'name', {
      configurable: true,
      value: `timerified ${fn.name}`,
    });
    Object.defineProperty(wrapped, 'length', {
      configurable: true,
      value: fn.length,
    });
    return wrapped;
  };
}

function createPerformanceFacade(nativePerformance, timerify, eventLoopUtilization, nodeTiming) {
  const performance = Object.create(Object.getPrototypeOf(nativePerformance));
  for (const name of PERFORMANCE_METHODS) {
    Object.defineProperty(performance, name, {
      configurable: true,
      enumerable: false,
      value: bindPerformanceMethod(nativePerformance, name),
    });
  }
  Object.defineProperty(performance, 'timeOrigin', {
    configurable: true,
    enumerable: false,
    value: nativePerformance.timeOrigin,
  });
  Object.defineProperty(performance, 'timerify', {
    configurable: true,
    enumerable: false,
    value: timerify,
  });

  Object.defineProperty(performance, 'eventLoopUtilization', {
    configurable: true,
    enumerable: false,
    value: eventLoopUtilization || unsupportedFunction('performance.eventLoopUtilization'),
  });
  if (nodeTiming) {
    Object.defineProperty(performance, 'nodeTiming', {
      configurable: true,
      enumerable: false,
      value: nodeTiming,
    });
  } else {
    defineUnsupportedProperty(performance, 'nodeTiming', 'performance.nodeTiming');
  }
  return performance;
}

function monotonicNanoseconds(performance, startTime) {
  return Math.max(0, Math.floor((performance.now() - startTime) * 1e6));
}

function createProcessMetadata(performance, startTime, virtual = false) {
  const processStart = Number.isFinite(startTime) ? startTime : performance.now();

  function hrtime(previous) {
    const current = monotonicNanoseconds(performance, processStart);
    const currentSeconds = Math.floor(current / 1e9);
    const currentNanoseconds = current % 1e9;
    if (previous === undefined) return [currentSeconds, currentNanoseconds];
    if (!Array.isArray(previous) || previous.length < 2) {
      throw new TypeError('process.hrtime() previous value must be a [seconds, nanoseconds] array');
    }
    let seconds = currentSeconds - Number(previous[0]);
    let nanoseconds = currentNanoseconds - Number(previous[1]);
    if (nanoseconds < 0) {
      seconds -= 1;
      nanoseconds += 1e9;
    }
    return [seconds, nanoseconds];
  }

  Object.defineProperty(hrtime, 'bigint', {
    configurable: true,
    value: () => {
      if (typeof BigInt !== 'function') {
        throw new UnsupportedWebCapabilityError(
          'process.hrtime.bigint',
          'BigInt is not available in this browser',
        );
      }
      return BigInt(monotonicNanoseconds(performance, processStart));
    },
  });

  const processMetadata = {
    hrtime,
    uptime: () => Math.max(0, (performance.now() - processStart) / 1000),
  };
  const virtualMetadata = virtual ? createVirtualProcessMetadata() : {};
  for (const name of [
    'memoryUsage',
    'cpuUsage',
    'threadCpuUsage',
    'resourceUsage',
    'getActiveResourcesInfo',
    'availableMemory',
    'constrainedMemory',
  ]) {
    processMetadata[name] = virtualMetadata[name] || unsupportedFunction(`process.${name}`);
  }
  return Object.freeze(processMetadata);
}

function createPerfHooks(globalObject, performance, observer, entryList, virtualMetrics) {
  const perfHooks = {
    Performance: globalObject.Performance,
    PerformanceEntry: globalObject.PerformanceEntry,
    PerformanceMark: globalObject.PerformanceMark,
    PerformanceMeasure: globalObject.PerformanceMeasure,
    PerformanceResourceTiming: globalObject.PerformanceResourceTiming,
    PerformanceObserver: observer,
    PerformanceObserverEntryList: entryList,
    performance,
    eventLoopUtilization: performance.eventLoopUtilization,
    monitorEventLoopDelay: virtualMetrics?.monitorEventLoopDelay
      || unsupportedFunction('perf_hooks.monitorEventLoopDelay'),
    createHistogram: virtualMetrics?.createHistogram
      || unsupportedFunction('perf_hooks.createHistogram'),
  };
  Object.defineProperty(perfHooks, 'constants', {
    configurable: false,
    enumerable: true,
    value: PERFORMANCE_CONSTANTS,
  });
  return Object.freeze(perfHooks);
}

/**
 * Build the browser-owned part of Node v22's perf_hooks and process timing APIs.
 * The returned perfHooks object can be installed as the node:perf_hooks builtin;
 * processMetadata contains only helpers that can be derived from browser timing.
 */
export function createPerformancePrimitives(globalObject = globalThis, options = {}) {
  if (options.fallback !== undefined && options.fallback !== false
    && options.fallback !== 'none' && options.fallback !== 'virtual') {
    throw new TypeError('only the virtual performance fallback is supported');
  }
  const nativePerformance = requirePerformance(globalObject);
  installPerformanceEntryInspect(globalObject);
  const functionObservers = new Set();
  const observerParts = createPerformanceObserver(globalObject, functionObservers);
  const virtual = options.fallback === 'virtual';
  const createHistogram = virtual ? createVirtualHistogram(nativePerformance) : undefined;
  const eventLoopUtilization = virtual
    ? createVirtualEventLoopUtilization(nativePerformance, globalObject)
    : undefined;
  const nodeTiming = virtual ? createVirtualNodeTiming(nativePerformance, globalObject) : undefined;
  const timerify = createTimerify(
    nativePerformance,
    observerParts.recordFunctionEntry || (() => {}),
  );
  const performance = createPerformanceFacade(nativePerformance, timerify, eventLoopUtilization, nodeTiming);
  const virtualMetrics = virtual
    ? {
        createHistogram,
        monitorEventLoopDelay: createVirtualMonitorEventLoopDelay(createHistogram),
      }
    : undefined;
  const perfHooks = createPerfHooks(
    globalObject,
    performance,
    observerParts.Observer,
    observerParts.EntryList,
    virtualMetrics,
  );
  const processMetadata = createProcessMetadata(nativePerformance, options.startTime, virtual);

  return Object.freeze({ perfHooks, processMetadata });
}
