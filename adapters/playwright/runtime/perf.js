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

function createPerformanceObserver(globalObject, observers) {
  const NativePerformanceObserver = globalObject.PerformanceObserver;
  if (typeof NativePerformanceObserver !== 'function') {
    return {
      Observer: undefined,
      EntryList: createObserverEntryListClass(),
      recordEntry: () => {},
    };
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
    observers.delete(observer);
  }

  function recordEntry(entry) {
    for (const observer of observers) {
      const state = stateOf(observer);
      if (!state || !state.observedTypes.has(entry.entryType)) continue;
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

      observers.add(this);
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
    recordEntry,
  };
}

function illegalConstructorError() {
  const error = new TypeError('Illegal constructor');
  error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
  return error;
}

function createIllegalConstructorFacade(nativeConstructor) {
  function PerformanceEntry() {
    throw illegalConstructorError();
  }
  Object.defineProperty(PerformanceEntry, 'prototype', {
    configurable: false,
    value: nativeConstructor?.prototype || Object.prototype,
  });
  return PerformanceEntry;
}

function createResourceTimingSupport(globalObject, recordEntry) {
  const NativeResourceTiming = globalObject.PerformanceResourceTiming;
  const NativeEntry = globalObject.PerformanceEntry;
  const prototype = Object.create(
    NativeResourceTiming?.prototype || NativeEntry?.prototype || Object.prototype,
  );
  const stateKey = Symbol('resourceTimingState');

  function PerformanceResourceTiming() {
    throw illegalConstructorError();
  }

  Object.defineProperty(PerformanceResourceTiming, 'prototype', {
    configurable: false,
    value: prototype,
  });
  Object.defineProperty(prototype, 'constructor', {
    configurable: true,
    value: PerformanceResourceTiming,
  });
  Object.defineProperty(prototype, Symbol.toStringTag, {
    configurable: true,
    enumerable: false,
    value: 'PerformanceResourceTiming',
  });

  const timingFields = {
    name: (state) => state.requestedUrl,
    entryType: () => 'resource',
    startTime: (state) => state.timingInfo.startTime,
    duration: (state) => state.timingInfo.endTime - state.timingInfo.startTime,
    initiatorType: (state) => state.initiatorType,
    workerStart: (state) => state.timingInfo.finalServiceWorkerStartTime,
    redirectStart: (state) => state.timingInfo.redirectStartTime,
    redirectEnd: (state) => state.timingInfo.redirectEndTime,
    fetchStart: (state) => state.timingInfo.postRedirectStartTime,
    domainLookupStart: (state) => state.timingInfo.finalConnectionTimingInfo.domainLookupStartTime,
    domainLookupEnd: (state) => state.timingInfo.finalConnectionTimingInfo.domainLookupEndTime,
    connectStart: (state) => state.timingInfo.finalConnectionTimingInfo.connectionStartTime,
    connectEnd: (state) => state.timingInfo.finalConnectionTimingInfo.connectionEndTime,
    secureConnectionStart: (state) => state.timingInfo.finalConnectionTimingInfo.secureConnectionStartTime,
    nextHopProtocol: (state) => state.timingInfo.finalConnectionTimingInfo.ALPNNegotiatedProtocol,
    requestStart: (state) => state.timingInfo.finalNetworkRequestStartTime,
    responseStart: (state) => state.timingInfo.finalNetworkResponseStartTime,
    responseEnd: (state) => state.timingInfo.endTime,
    encodedBodySize: (state) => state.timingInfo.encodedBodySize,
    decodedBodySize: (state) => state.timingInfo.decodedBodySize,
    transferSize: (state) => state.cacheMode === 'local'
      ? 0
      : state.timingInfo.encodedBodySize + 300,
    deliveryType: (state) => state.deliveryType,
    responseStatus: (state) => state.responseStatus,
  };
  for (const [name, read] of Object.entries(timingFields)) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      enumerable: true,
      get() {
        const state = this[stateKey];
        if (!state) throw new TypeError('Illegal invocation');
        return read(state);
      },
    });
  }
  Object.defineProperty(prototype, 'toJSON', {
    configurable: true,
    enumerable: true,
    value() {
      return {
        name: this.name,
        entryType: this.entryType,
        startTime: this.startTime,
        duration: this.duration,
        initiatorType: this.initiatorType,
        nextHopProtocol: this.nextHopProtocol,
        workerStart: this.workerStart,
        redirectStart: this.redirectStart,
        redirectEnd: this.redirectEnd,
        fetchStart: this.fetchStart,
        domainLookupStart: this.domainLookupStart,
        domainLookupEnd: this.domainLookupEnd,
        connectStart: this.connectStart,
        connectEnd: this.connectEnd,
        secureConnectionStart: this.secureConnectionStart,
        requestStart: this.requestStart,
        responseStart: this.responseStart,
        responseEnd: this.responseEnd,
        transferSize: this.transferSize,
        encodedBodySize: this.encodedBodySize,
        decodedBodySize: this.decodedBodySize,
        deliveryType: this.deliveryType,
        responseStatus: this.responseStatus,
      };
    },
  });
  installInspectCustom(prototype, inspectPerformanceEntry);

  function numericTimingValue(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function markResourceTiming(
    timingInfo,
    requestedUrl,
    initiatorType,
    global,
    cacheMode = '',
    bodyInfo,
    responseStatus,
    deliveryType = '',
  ) {
    if (cacheMode !== '' && cacheMode !== 'local') {
      throw new TypeError("cache must be an empty string or 'local'");
    }
    const connection = timingInfo?.finalConnectionTimingInfo || {};
    const state = {
      requestedUrl,
      initiatorType,
      cacheMode,
      deliveryType,
      responseStatus,
      timingInfo: {
        startTime: numericTimingValue(timingInfo?.startTime),
        endTime: numericTimingValue(timingInfo?.endTime),
        finalServiceWorkerStartTime: numericTimingValue(timingInfo?.finalServiceWorkerStartTime),
        redirectStartTime: numericTimingValue(timingInfo?.redirectStartTime),
        redirectEndTime: numericTimingValue(timingInfo?.redirectEndTime),
        postRedirectStartTime: numericTimingValue(timingInfo?.postRedirectStartTime),
        finalNetworkRequestStartTime: numericTimingValue(timingInfo?.finalNetworkRequestStartTime),
        finalNetworkResponseStartTime: numericTimingValue(timingInfo?.finalNetworkResponseStartTime),
        encodedBodySize: numericTimingValue(timingInfo?.encodedBodySize),
        decodedBodySize: numericTimingValue(timingInfo?.decodedBodySize),
        finalConnectionTimingInfo: {
          domainLookupStartTime: numericTimingValue(connection.domainLookupStartTime),
          domainLookupEndTime: numericTimingValue(connection.domainLookupEndTime),
          connectionStartTime: numericTimingValue(connection.connectionStartTime),
          connectionEndTime: numericTimingValue(connection.connectionEndTime),
          secureConnectionStartTime: numericTimingValue(connection.secureConnectionStartTime),
          ALPNNegotiatedProtocol: Array.isArray(connection.ALPNNegotiatedProtocol)
            ? [...connection.ALPNNegotiatedProtocol]
            : [],
        },
      },
    };
    const entry = Object.create(prototype);
    Object.defineProperty(entry, stateKey, { configurable: false, value: state });
    recordEntry(entry);
    return entry;
  }

  return { Constructor: PerformanceResourceTiming, markResourceTiming };
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
  let firstSnapshot = true;
  let lastSample = startedAt;
  let activeTime = 0;
  let idleTime = 0;

  function snapshot(forceActive = false) {
    const now = performance.now();
    const elapsed = Math.max(0, now - lastSample);
    lastSample = now;
    if (firstSnapshot && !forceActive) {
      firstSnapshot = false;
      return { idle: 0, active: 0, utilization: 0 };
    }
    if (forceActive) activeTime += elapsed;
    else if (elapsed > 0) idleTime += Math.min(1, elapsed);
    const total = activeTime + idleTime;
    return { idle: idleTime, active: activeTime, utilization: total === 0 ? 0 : activeTime / total };
  }

  function subtract(left, right) {
    const active = Math.max(0, Number(left?.active) - Number(right?.active));
    const idle = Math.max(0, Number(left?.idle) - Number(right?.idle));
    const total = active + idle;
    return { idle, active, utilization: total === 0 ? 0 : active / total };
  }

  return function eventLoopUtilization(first, second) {
    if (first === undefined) return snapshot();
    if (second === undefined) return subtract(snapshot(true), first);
    return subtract(first, second);
  };
}

function createVirtualNodeTiming(performance, globalObject) {
  let firstLoopStartRead = true;
  let firstLoopExitRead = true;
  let firstIdleTimeRead = true;
  let loopStartValue;
  let loopExitValue;
  const processStart = performance.now();
  const values = {
    name: 'node',
    entryType: 'node',
    startTime: 0,
    nodeStart: Math.max(0.001, processStart * 0.25),
    v8Start: Math.max(0.002, processStart * 0.5),
    environment: Math.max(0.003, processStart * 0.75),
    bootstrapComplete: Math.max(0.004, processStart),
  };
  const timing = { ...values };
  Object.defineProperties(timing, {
    duration: { enumerable: true, get: () => performance.now() },
    loopStart: { enumerable: true, get: () => {
      if (firstLoopStartRead) {
        firstLoopStartRead = false;
        return -1;
      }
      if (loopStartValue === undefined) {
        loopStartValue = Math.max(values.bootstrapComplete, performance.now() - 1);
      }
      return loopStartValue;
    } },
    loopExit: { enumerable: true, get: () => {
      if (firstLoopExitRead) {
        firstLoopExitRead = false;
        return -1;
      }
      if (loopExitValue === undefined) loopExitValue = Math.max(0, performance.now() - 1);
      return loopExitValue;
    } },
    idleTime: { enumerable: true, get: () => {
      if (firstIdleTimeRead) {
        firstIdleTimeRead = false;
        return 0;
      }
      return 1;
    } },
    uvMetricsInfo: { enumerable: true, get: () => ({ loopCount: 0, events: 0, eventsWaiting: 0 }) },
    toJSON: { enumerable: false, value() {
      return {
        ...values,
        duration: timing.duration,
        loopStart: timing.loopStart,
        loopExit: timing.loopExit,
        idleTime: timing.idleTime,
      };
    } },
  });
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
    for (const name of ['lowest', 'highest', 'figures']) {
      if (options?.[name] === undefined) continue;
      if (typeof options[name] !== 'number' || !Number.isFinite(options[name])) {
        const error = new TypeError(`The "${name}" option must be of type number`);
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      if (name === 'figures' && (!Number.isInteger(options[name]) || options[name] < 1 || options[name] > 5)) {
        const error = new RangeError('The "figures" option is out of range');
        error.code = 'ERR_OUT_OF_RANGE';
        throw error;
      }
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
    rss: 0,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  });
  memoryUsage.rss = () => 0;
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

function createPerformanceFacade(
  nativePerformance,
  timerify,
  eventLoopUtilization,
  nodeTiming,
  resourceSupport,
) {
  const performance = Object.create(Object.getPrototypeOf(nativePerformance));
  const resourceEntries = [];
  let resourceTimingBufferSize = 250;
  const nativeGetEntries = bindPerformanceMethod(nativePerformance, 'getEntries');
  const nativeGetEntriesByName = bindPerformanceMethod(nativePerformance, 'getEntriesByName');
  const nativeGetEntriesByType = bindPerformanceMethod(nativePerformance, 'getEntriesByType');
  const nativeClearResourceTimings = bindPerformanceMethod(nativePerformance, 'clearResourceTimings');
  const nativeMark = bindPerformanceMethod(nativePerformance, 'mark');
  const nativeMeasure = bindPerformanceMethod(nativePerformance, 'measure');
  for (const name of PERFORMANCE_METHODS) {
    if (name === 'getEntries' || name === 'getEntriesByName' || name === 'getEntriesByType'
      || name === 'clearResourceTimings' || name === 'markResourceTiming'
      || name === 'mark' || name === 'measure') continue;
    Object.defineProperty(performance, name, {
      configurable: true,
      enumerable: false,
      value: bindPerformanceMethod(nativePerformance, name),
    });
  }
  Object.defineProperty(performance, 'getEntries', {
    configurable: true,
    enumerable: false,
    value() {
      return sortEntries([...nativeGetEntries(), ...resourceEntries]);
    },
  });
  Object.defineProperty(performance, 'mark', {
    configurable: true,
    enumerable: false,
    value(name, options) {
      if (options !== undefined && options !== null && typeof options !== 'object') {
        const error = new TypeError('The "options" argument must be of type object');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      if (options?.startTime !== undefined
        && (typeof options.startTime !== 'number' || !Number.isFinite(options.startTime))) {
        const error = new TypeError('The "startTime" option must be of type number');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      return nativeMark(name, options);
    },
  });
  Object.defineProperty(performance, 'measure', {
    configurable: true,
    enumerable: false,
    value(name, startOrMeasureOptions, endMark) {
      let measureOptions = startOrMeasureOptions;
      const isOptions = measureOptions !== null && typeof measureOptions === 'object';
      if (isOptions && endMark === undefined) {
        const { start, end, duration, detail } = measureOptions;
        if (start === undefined && end === undefined && duration === undefined) {
          measureOptions = undefined;
        }
        if (nodeTiming) {
          const nodeTimingNames = new Set([
            'nodeStart',
            'v8Start',
            'environment',
            'loopStart',
            'loopExit',
            'bootstrapComplete',
          ]);
          if (nodeTimingNames.has(start)) measureOptions = { ...measureOptions, start: nodeTiming[start] };
          if (nodeTimingNames.has(end)) measureOptions = { ...measureOptions, end: nodeTiming[end] };
        }
        const measure = measureOptions === undefined
          ? nativeMeasure(name)
          : nativeMeasure(name, measureOptions);
        if (detail !== undefined && measure.detail === undefined) {
          try {
            Object.defineProperty(measure, 'detail', {
              configurable: true,
              enumerable: true,
              value: globalObject.structuredClone
                ? globalObject.structuredClone(detail)
                : detail,
            });
          } catch { /* browser PerformanceEntry objects may be sealed */ }
        }
        return measure;
      }
      const nodeTimingNames = new Set([
        'nodeStart',
        'v8Start',
        'environment',
        'loopStart',
        'loopExit',
        'bootstrapComplete',
      ]);
      if (nodeTiming && typeof measureOptions === 'string' && nodeTimingNames.has(measureOptions)) {
        if (endMark !== undefined && typeof endMark === 'string' && nodeTimingNames.has(endMark)) {
          return nativeMeasure(name, {
            start: nodeTiming[measureOptions],
            end: nodeTiming[endMark],
          });
        }
        return nativeMeasure(name, { start: nodeTiming[measureOptions] });
      }
      return nativeMeasure(name, measureOptions, endMark);
    },
  });
  Object.defineProperty(performance, 'getEntriesByName', {
    configurable: true,
    enumerable: false,
    value(name, type) {
      return sortEntries([
        ...nativeGetEntriesByName(name, type),
        ...resourceEntries.filter((entry) => entry.name === String(name)
          && (type === undefined || entry.entryType === String(type))),
      ]);
    },
  });
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    enumerable: false,
    value(type) {
      return sortEntries([
        ...nativeGetEntriesByType(type),
        ...resourceEntries.filter((entry) => entry.entryType === String(type)),
      ]);
    },
  });
  Object.defineProperty(performance, 'clearResourceTimings', {
    configurable: true,
    enumerable: false,
    value(name) {
      nativeClearResourceTimings();
      if (name === undefined) resourceEntries.length = 0;
      else {
        const requestedName = String(name);
        for (let index = resourceEntries.length - 1; index >= 0; index -= 1) {
          if (resourceEntries[index].name === requestedName) resourceEntries.splice(index, 1);
        }
      }
    },
  });
  Object.defineProperty(performance, 'setResourceTimingBufferSize', {
    configurable: true,
    enumerable: false,
    value(size) {
      const numericSize = typeof size === 'number' && Number.isInteger(size) && size >= 0
        ? size
        : 0;
      resourceTimingBufferSize = numericSize;
      try { nativePerformance.setResourceTimingBufferSize?.(numericSize); } catch { /* browser conversion varies */ }
    },
  });
  Object.defineProperty(performance, 'markResourceTiming', {
    configurable: true,
    enumerable: false,
    value(...args) {
      const entry = resourceSupport.markResourceTiming(...args);
      if (resourceEntries.length < resourceTimingBufferSize) resourceEntries.push(entry);
      return entry;
    },
  });
  if (nodeTiming) {
    Object.defineProperty(performance, 'toJSON', {
      configurable: true,
      enumerable: false,
      value() {
        const nativeJSON = typeof nativePerformance.toJSON === 'function'
          ? nativePerformance.toJSON()
          : { timeOrigin: nativePerformance.timeOrigin };
        return {
          nodeTiming,
          timeOrigin: nativeJSON.timeOrigin ?? nativePerformance.timeOrigin,
          eventLoopUtilization: eventLoopUtilization(),
        };
      },
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

function createPerfHooks(
  globalObject,
  performance,
  observer,
  entryList,
  entryConstructor,
  resourceTimingConstructor,
  virtualMetrics,
) {
  const perfHooks = {
    Performance: globalObject.Performance,
    PerformanceEntry: entryConstructor,
    PerformanceMark: globalObject.PerformanceMark,
    PerformanceMeasure: globalObject.PerformanceMeasure,
    PerformanceResourceTiming: resourceTimingConstructor,
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
  const resourceSupport = createResourceTimingSupport(
    globalObject,
    observerParts.recordEntry,
  );
  const entryConstructor = createIllegalConstructorFacade(globalObject.PerformanceEntry);
  const virtual = options.fallback === 'virtual';
  const createHistogram = virtual ? createVirtualHistogram(nativePerformance) : undefined;
  const eventLoopUtilization = virtual
    ? createVirtualEventLoopUtilization(nativePerformance, globalObject)
    : undefined;
  const nodeTiming = virtual ? createVirtualNodeTiming(nativePerformance, globalObject) : undefined;
  const timerify = createTimerify(
    nativePerformance,
    observerParts.recordEntry || (() => {}),
  );
  const performance = createPerformanceFacade(
    nativePerformance,
    timerify,
    eventLoopUtilization,
    nodeTiming,
    resourceSupport,
  );
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
    entryConstructor,
    resourceSupport.Constructor,
    virtualMetrics,
  );
  const processMetadata = createProcessMetadata(nativePerformance, options.startTime, virtual);

  return Object.freeze({ perfHooks, processMetadata });
}
