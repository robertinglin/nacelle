function formatError(error) {
  const message = error?.message == null ? String(error) : String(error.message);
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  if (!stack) return message;
  if (!message || stack.includes(message)) return stack;
  return `${error?.name || 'Error'}: ${message}\n${stack}`;
}

function normalizeOptions(options) {
  return options && typeof options === 'object' ? options : {};
}

function splitDefinition(name, options, callback) {
  if (typeof name === 'function') return { name: '(anonymous)', options: {}, callback: name };
  if (typeof options === 'function') return { name, options: {}, callback: options };
  return { name, options: normalizeOptions(options), callback };
}

function codedError(Type, code, message) {
  const error = new Type(message);
  error.code = code;
  return error;
}

function invalidType(name, expected, value) {
  return codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
    `The "${name}" argument must be of type ${expected}. Received ${value === null ? 'null' : typeof value}`);
}

const stringifiedEnvs = new WeakSet();

function normalizeProcessEnv(processObject) {
  const env = processObject?.env;
  if (!env || typeof env !== 'object' || stringifiedEnvs.has(env)) return;
  const stringified = new Proxy(env, {
    set(target, property, value) {
      target[property] = String(value);
      return true;
    },
    defineProperty(target, property, descriptor) {
      if ('value' in descriptor) descriptor = { ...descriptor, value: String(descriptor.value) };
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
  stringifiedEnvs.add(stringified);
  processObject.env = stringified;
}

function createMockTracker(scope, timerModules, moduleOptions = {}) {
  timerModules = timerModules || {};
  timerModules.timers ||= scope.require?.('node:timers') || {};
  timerModules.timerPromises ||= scope.require?.('node:timers/promises') || timerModules.timers.promises || {};
  const processObject = moduleOptions.processObject || scope.process;
  const sourcePath = moduleOptions.sourcePath || processObject?.argv?.[1] || '/node/index.js';
  let activeProcessOverride;
  const activeProcess = () => moduleOptions.activeProcess?.()
    || activeProcessOverride || processObject.__bnhActiveProcess || scope.__bnhActiveProcess || scope.process || processObject;
  const mocks = [];
  let timers;

  const moduleMockKeys = (resolved) => {
    const keys = [resolved];
    if (resolved.startsWith('node:')) keys.push(resolved.slice(5));
    else if (resolved.startsWith('/')) keys.push(`file://${resolved}`);
    return keys;
  };

  const resolveModuleSpecifier = (specifier) => {
    const owner = activeProcess();
    const resolve = owner?.__bnhModuleResolve || processObject?.__bnhModuleResolve;
    if (typeof resolve === 'function') {
      const stackCallers = [...String(new Error().stack || '').matchAll(/(?:\(|\s)(\/node\/[^:)]+):\d+:\d+\)?/g)];
      const stackCaller = stackCallers.find((match) => !match[1].endsWith('/node-test.js'));
      const candidateCaller = stackCaller?.[1] || owner?.argv?.[1] || processObject?.argv?.[1] || sourcePath;
      const caller = /^(?:\/|file:|data:)/.test(String(candidateCaller))
        ? candidateCaller
        : `${owner?.cwd?.() || '/node'}/index.js`;
      const result = resolve(specifier, caller);
      const url = result?.url;
      if (typeof url === 'string') {
        if (url.startsWith('file:')) {
          try { return decodeURIComponent(new URL(url).pathname); } catch { return url; }
        }
        return url;
      }
    }
    if (specifier.startsWith('node:')) return specifier;
    if (specifier.startsWith('/')) return specifier;
    if (specifier.startsWith('.') && typeof URL === 'function') {
      try { return decodeURIComponent(new URL(specifier, `file://${sourcePath}`).pathname); } catch { /* use raw */ }
    }
    return specifier;
  };

  const makeModuleMockValue = (entry) => {
    const format = entry.format;
    const base = entry.hasDefaultExport ? entry.defaultExport : {};
    if (format === 'module') {
      if (entry.hasDefaultExport) return base;
      const namespace = {};
      for (const name of Object.keys(entry.namedExports)) {
        Object.defineProperty(namespace, name, Object.getOwnPropertyDescriptor(entry.namedExports, name));
      }
      return namespace;
    }
    const exportNames = Object.keys(entry.namedExports);
    if (exportNames.length > 0 && (format === 'commonjs' || format === 'json')
        && (base === null || (typeof base !== 'object' && typeof base !== 'function'))) {
      throw new Error('Cannot create mock because named exports cannot be applied to the default export');
    }
    const value = format === 'json' && !entry.hasDefaultExport ? {} : base;
    for (const name of exportNames) {
      Object.defineProperty(value, name, Object.getOwnPropertyDescriptor(entry.namedExports, name));
    }
    return value;
  };

  const makeModuleMockNamespace = (entry) => {
    if (entry.cache && entry.namespace) return entry.namespace;
    const value = makeModuleMockValue(entry);
    const namespace = entry.format === 'json'
      ? { default: entry.hasDefaultExport ? entry.defaultExport : value }
      : entry.format === 'module'
        ? { ...(entry.hasDefaultExport ? { default: entry.defaultExport } : {}) }
        : { default: value, ...(value && (typeof value === 'object' || typeof value === 'function') ? value : {}) };
    if (entry.format === 'module') {
      for (const name of Object.keys(entry.namedExports)) {
        Object.defineProperty(namespace, name, Object.getOwnPropertyDescriptor(entry.namedExports, name));
      }
    }
    if (entry.cache) entry.namespace = namespace;
    return namespace;
  };

  const module = (specifier, options = {}) => {
    const isUrl = specifier !== null && typeof specifier === 'object'
      && typeof specifier.href === 'string' && typeof specifier.toString === 'function';
    if (typeof specifier !== 'string' && !isUrl) {
      throw invalidType('specifier', 'string or URL', specifier);
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw invalidType('options', 'Object', options);
    }
    const input = typeof specifier === 'string' ? specifier : String(specifier);
    const owner = activeProcess();
    const processCandidates = [owner, processObject, scope.process, scope.__bnhModulePermissionProcess, scope.__bnhActiveProcess];
    const ownerArgs = processCandidates.flatMap((candidate) => [
      ...(candidate?.argv || []), ...(candidate?.execArgv || []),
    ]).concat(moduleOptions.execArgv || []).map(String);
    if (ownerArgs.includes('--permission') && !ownerArgs.includes('--allow-worker')) {
      const permissionProcess = processCandidates.find((candidate) => [
        ...(candidate?.argv || []), ...(candidate?.execArgv || []),
      ].map(String).includes('--permission')) || owner;
      permissionProcess?.stdout?.write?.('Access to this API has been restricted. Use --allow-worker to enable module mocking.\n');
      const error = new Error('Access to this API has been restricted. Use --allow-worker to enable module mocking.');
      error.code = 'ERR_ACCESS_DENIED';
      throw error;
    }
    const { cache = false, namedExports = {}, defaultExport } = options;
    if (typeof cache !== 'boolean') throw invalidType('options.cache', 'boolean', cache);
    if (namedExports === null || typeof namedExports !== 'object' || Array.isArray(namedExports)) {
      throw invalidType('options.namedExports', 'Object', namedExports);
    }
    const resolved = resolveModuleSpecifier(input);
    const format = resolved.startsWith('node:') || !resolved.endsWith('.mjs') && !resolved.endsWith('.json')
      ? (resolved.endsWith('.js') && owner?.execArgv?.includes('--experimental-default-type=module') ? 'module' : 'commonjs')
      : resolved.endsWith('.json') ? 'json' : 'module';
    const state = owner.__bnhModuleMocks || (owner.__bnhModuleMocks = new Map());
    scope.__bnhModuleMocks = state;
    const keys = [...new Set([
      ...moduleMockKeys(resolved),
      input === resolved ? undefined : input,
    ].filter((key) => key !== undefined))];
    if (keys.some((key) => state.get(key)?.active)) {
      const error = codedError(Error, 'ERR_INVALID_STATE', `Cannot mock '${input}'. The module is already mocked.`);
      throw error;
    }
    const entry = {
      active: true,
      cache,
      defaultExport,
      format,
      hasDefaultExport: Object.hasOwn(options, 'defaultExport'),
      namedExports,
      resolved,
      cjsValue: null,
      namespace: null,
    };
    entry.getCjsValue = () => {
      if (entry.cache && entry.cjsValue !== null) return entry.cjsValue;
      const value = makeModuleMockValue(entry);
      if (entry.cache) entry.cjsValue = value;
      return value;
    };
    entry.getNamespace = () => makeModuleMockNamespace(entry);
    for (const key of keys) state.set(key, entry);
    const context = {
      restore() {
        if (!entry.active) return;
        entry.active = false;
        for (const key of keys) if (state.get(key) === entry) state.delete(key);
        entry.cjsValue = null;
        entry.namespace = null;
      },
    };
    mocks.push({ restore: context.restore });
    return context;
  };

  function validateFunction(value, name) {
    if (typeof value !== 'function') throw invalidType(name, 'function', value);
  }

  function mockFunction(original, implementation, options = {}) {
    if (original !== null && typeof original === 'object') {
      options = original;
      original = function() {};
      implementation = original;
    } else if (implementation !== null && typeof implementation === 'object') {
      options = implementation;
      implementation = original;
    }
    original ??= function() {};
    implementation ??= original;
    validateFunction(original, 'original');
    validateFunction(implementation, 'implementation');
    options = normalizeOptions(options);
    const times = options.times === undefined ? Infinity : options.times;
    if (times !== Infinity && typeof times !== 'number') {
      throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "options.times" property must be of type number. Received ${times === null ? 'null' : typeof times}`);
    }
    if (times !== Infinity && (!Number.isInteger(times) || times < 1)) {
      throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', `The value of "options.times" is out of range. It must be >= 1. Received ${times}`);
    }
    let current = implementation;
    const once = new Map();
    const calls = [];
    let entry;
    const context = {
      get calls() { return calls.slice(); },
      callCount() { return calls.length; },
      mockImplementation(fn) { validateFunction(fn, 'implementation'); current = fn; },
      mockImplementationOnce(fn, onCall) {
        validateFunction(fn, 'implementation');
        const index = onCall ?? calls.length;
        if (!Number.isInteger(index) || index < calls.length) {
          throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', `The value of "onCall" is out of range. It must be >= ${calls.length}`);
        }
        once.set(index, fn);
      },
      resetCalls() { calls.length = 0; },
      restore() { current = original; if (entry) entry.restore = () => {}; },
    };
    const invoke = (thisArg, args, target, construct) => {
      const callIndex = calls.length;
      const fn = once.get(callIndex) || current;
      once.delete(callIndex);
      let result;
      let error;
      let receiver = thisArg;
      try {
        if (construct) {
          receiver = Reflect.construct(fn, args, target);
          result = receiver;
        } else {
          result = Reflect.apply(fn, thisArg, args);
        }
        return result;
      } catch (cause) {
        error = cause;
        throw cause;
      } finally {
        calls.push({ arguments: args, error, result, target, this: receiver });
        if (calls.length === times) context.restore();
      }
    };
    const mocked = new Proxy(original, {
      apply(_target, thisArg, args) { return invoke(thisArg, args, undefined, false); },
      construct(_target, args) { return invoke(undefined, args, original, true); },
      get(_target, key, receiver) { return key === 'mock' ? context : Reflect.get(original, key, receiver); },
    });
    entry = { restore: () => context.restore() };
    mocks.push(entry);
    return mocked;
  }

  function findDescriptor(object, property) {
    for (let current = object; current; current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) return descriptor;
    }
    return null;
  }

  function method(object, property, implementation, options = {}) {
    if (typeof property !== 'string' && typeof property !== 'symbol') {
      throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "methodName" argument must be one of type string or symbol');
    }
    if ((typeof object !== 'object' || object === null) && typeof object !== 'function') {
      throw invalidType('object', 'object', object);
    }
    if (implementation !== null && typeof implementation === 'object') {
      options = implementation;
      implementation = undefined;
    }
    options = normalizeOptions(options);
    const descriptor = findDescriptor(object, property);
    if (options.getter === true && options.setter === true) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The property 'options.setter' cannot be used with 'options.getter'");
    if (!descriptor) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', `The property ${String(property)} does not exist`);
    const getter = options.getter === true;
    const setter = options.setter === true;
    const original = getter ? descriptor.get : setter ? descriptor.set : descriptor.value;
    if (typeof original !== 'function') throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The argument 'methodName' must be a method");
    const mocked = mockFunction(original, implementation ?? original, options);
    const context = mocked.mock;
    const entry = mocks.at(-1);
    context.restore = () => { Object.defineProperty(object, property, descriptor); entry.restore = () => {}; };
    const replacement = { configurable: descriptor.configurable, enumerable: descriptor.enumerable };
    if (getter) { replacement.get = mocked; replacement.set = descriptor.set; }
    else if (setter) { replacement.get = descriptor.get; replacement.set = mocked; }
    else { replacement.writable = descriptor.writable; replacement.value = mocked; }
    try {
      Object.defineProperty(object, property, replacement);
    } catch (error) {
      delete mocked.mock;
      mocks.pop();
      throw error;
    }
    return mocked;
  }

  function property(object, propertyName, value) {
    if (object === null || typeof object !== 'object') throw invalidType('object', 'object', object);
    if (typeof propertyName !== 'string' && typeof propertyName !== 'symbol') {
      throw invalidType('propertyName', 'string or symbol', propertyName);
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, propertyName);
    if (!descriptor) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', 'propertyName is not a property of the object');
    let current = arguments.length > 2 ? value : object[propertyName];
    const accesses = [];
    const once = new Map();
    const context = {
      get accesses() { return accesses.slice(); },
      accessCount() { return accesses.length; },
      mockImplementation(next) { if (!descriptor.writable) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', 'property cannot be set'); current = next; accesses.push({ type: 'set', value: next, stack: new Error() }); },
      mockImplementationOnce(next, index = accesses.length) { if (!Number.isInteger(index) || index < accesses.length) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', `The value of "onAccess" is out of range. It must be >= ${accesses.length}`); once.set(index, next); },
      resetAccesses() { accesses.length = 0; },
      restore() { Object.defineProperty(object, propertyName, descriptor); },
    };
    Object.defineProperty(object, propertyName, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get() { const index = accesses.length; const next = once.has(index) ? once.get(index) : current; once.delete(index); accesses.push({ type: 'get', value: next, stack: new Error() }); return next; },
      set(next) { context.mockImplementation(next); },
    });
    const entry = { restore: context.restore };
    mocks.push(entry);
    return new Proxy(object, { get(target, key, receiver) { return key === 'mock' ? context : Reflect.get(target, key, receiver); } });
  }

  function createTimers() {
    const timerObjects = [...new Set([timerModules.timers, scope.require?.('node:timers')].filter(Boolean))];
    const promiseObjects = [...new Set([timerModules.timerPromises, timerModules.timers?.promises, scope.require?.('node:timers/promises')].filter(Boolean))];
    const originalDate = scope.Date;
    const nativeSetTimeout = scope.setTimeout?.bind(scope);
    const original = [];
    const remembered = new WeakMap();
    const queue = [];
    let enabled = false;
    let now = 0;
    let nextId = 1;
    const marker = '__bnhMockTimers';
    const failState = () => { throw codedError(Error, 'ERR_INVALID_STATE', 'You should enable MockTimers first by calling the .enable function'); };
    const insert = (entry) => { queue.push(entry); queue.sort((a, b) => a.runAt - b.runAt || a.priority - b.priority || a.id - b.id); };
    const clear = (handle) => {
      const entry = queue.find((item) => item.handle === handle || item.handle?.id === handle);
      if (entry) entry.handle.active = false;
      for (let i = queue.length - 1; i >= 0; i -= 1) if (!queue[i].handle.active) queue.splice(i, 1);
    };
    const schedule = (repeat, callback, delay, args, priority = 1) => {
      if (callback === undefined) callback = () => {};
      if (typeof callback !== 'function') throw invalidType('callback', 'function', callback);
      const numericDelay = Number(delay) || 0;
      const ms = numericDelay < 0 || numericDelay > 2147483647 ? 1 : Math.max(0, numericDelay);
      const handle = { id: nextId++, repeat, active: true, _refed: true,
        ref() { this._refed = true; return this; }, unref() { this._refed = false; return this; }, hasRef() { return this._refed; },
        refresh() { const entry = queue.find((item) => item.handle === this); if (entry) entry.runAt = now + entry.delay; return this; },
        close() { clear(this); return this; }, [Symbol.toPrimitive]() { return this.id; } };
      insert({ id: handle.id, handle, callback, args, delay: ms, runAt: now + ms, priority });
      return handle;
    };
    const fakeSetTimeout = (callback, delay, ...args) => schedule(false, callback, delay, args);
    const fakeSetInterval = (callback, delay, ...args) => schedule(true, callback, delay, args);
    const fakeSetImmediate = (callback, ...args) => schedule(false, callback, 0, args, 0);
    const signalListeners = new WeakMap();
    const trackAbortListener = (signal, listener) => {
      let listeners = signalListeners.get(signal);
      if (!listeners) {
        listeners = new Set();
        signalListeners.set(signal, listeners);
        if (typeof signal.listeners !== 'function') Object.defineProperty(signal, 'listeners', { configurable: true, value: (name) => name === 'abort' ? [...listeners] : [] });
      }
      listeners.add(listener);
      signal.addEventListener('abort', listener, { once: true });
    };
    const untrackAbortListener = (signal, listener) => {
      signal?.removeEventListener?.('abort', listener);
      signalListeners.get(signal)?.delete(listener);
    };
    const abortReason = (signal) => {
      const reason = signal?.reason || Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
      if (reason.name === 'AbortError' && reason.code === 20) return Object.assign(new Error(reason.message), { name: 'AbortError', code: 'ABORT_ERR' });
      if (reason.code === undefined) reason.code = 'ABORT_ERR';
      return reason;
    };
    const promiseTimer = (delay, value, options = {}) => new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal && typeof signal.addEventListener !== 'function') { reject(invalidType('options.signal', 'AbortSignal', signal)); return; }
      if (signal?.aborted) { reject(abortReason(signal)); return; }
      const handle = fakeSetTimeout(() => { untrackAbortListener(signal, abort); resolve(value); }, delay);
      const abort = () => { clear(handle); reject(abortReason(signal)); };
      if (signal) trackAbortListener(signal, abort);
    });
    const nativePromiseImmediate = (value, options = {}) => new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal && typeof signal.addEventListener !== 'function') { reject(invalidType('options.signal', 'AbortSignal', signal)); return; }
      if (signal?.aborted) { reject(abortReason(signal)); return; }
      const handle = nativeSetTimeout(() => { untrackAbortListener(signal, abort); resolve(value); }, 0);
      const abort = () => { scope.clearTimeout(handle); untrackAbortListener(signal, abort); reject(abortReason(signal)); };
      if (signal) trackAbortListener(signal, abort);
    });
    const fakeIntervalIterator = (delay, value, options = {}) => {
      const signal = options?.signal;
      if (signal && typeof signal.addEventListener !== 'function') return { next: () => Promise.reject(invalidType('options.signal', 'AbortSignal', signal)), return: () => Promise.resolve({ done: true, value: undefined }), [Symbol.asyncIterator]() { return this; } };
      let closed = Boolean(signal?.aborted);
      const pending = [];
      const values = [];
      let handle;
      const finishAbort = () => {
        if (closed) return;
        closed = true;
        if (handle) clear(handle);
        while (pending.length) pending.shift().reject(abortReason(signal));
        untrackAbortListener(signal, finishAbort);
      };
      const deliver = () => {
        if (closed) return;
        const result = { done: false, value };
        if (pending.length) pending.shift().resolve(result);
        else values.push(result);
      };
      if (!closed) {
        handle = fakeSetInterval(deliver, delay);
        if (signal) trackAbortListener(signal, finishAbort);
      }
      return {
        next() {
          if (values.length) return Promise.resolve(values.shift());
          if (closed) return Promise.reject(abortReason(signal));
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        },
        return() {
          if (!closed) { closed = true; clear(handle); untrackAbortListener(signal, finishAbort); }
          while (pending.length) pending.shift().resolve({ done: true, value: undefined });
          return Promise.resolve({ done: true, value: undefined });
        },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    function remember(target, key) { if (!target) return; let keys = remembered.get(target); if (!keys) { keys = new Set(); remembered.set(target, keys); } if (keys.has(key)) return; keys.add(key); original.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) }); }
    function replace(target, key, value) { if (!target) return; remember(target, key); Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value }); }
    function replaceAll(targets, key, value) { for (const target of targets) replace(target, key, value); }
    function restoreAll() { for (const { target, key, descriptor } of original) { if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key]; } original.length = 0; if (scope[marker] === api) delete scope[marker]; }
    const fakeDate = () => {
      const RealDate = originalDate;
      function MockDate(...args) { return new.target ? (args.length ? Reflect.construct(RealDate, args, new.target) : Reflect.construct(RealDate, [now], new.target)) : RealDate(now); }
      Object.setPrototypeOf(MockDate, RealDate); MockDate.prototype = RealDate.prototype; MockDate.now = () => now; MockDate.isMock = true; MockDate.toString = () => RealDate.toString(); return MockDate;
    };
    const api = {
      enable(options = {}) {
        if (enabled) throw codedError(Error, 'ERR_INVALID_STATE', 'MockTimers is already enabled!');
        if (scope[marker] && scope[marker] !== api) throw codedError(Error, 'ERR_INVALID_STATE', 'MockTimers is already enabled!');
        options = normalizeOptions(options);
        const apis = options.apis ?? ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'scheduler.wait'];
        if (!Array.isArray(apis)) throw invalidType('options.apis', 'Array', apis);
        for (const name of apis) { if (typeof name !== 'string') throw invalidType('options.apis', 'string', name); if (!['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'scheduler.wait'].includes(name)) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', `option ${name} is not supported`); }
        const initial = options.now ?? 0;
        if (initial instanceof Date) now = initial.getTime();
        else if (typeof initial !== 'number') throw invalidType('initialTime', 'number', initial);
        else if (!Number.isFinite(initial) || initial < 0) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', 'epoch must be a positive integer');
        else now = initial;
        enabled = true; Object.defineProperty(scope, marker, { configurable: true, value: api });
        if (apis.includes('setTimeout')) { replace(scope, 'setTimeout', fakeSetTimeout); replace(scope, 'clearTimeout', clear); replaceAll(timerObjects, 'setTimeout', fakeSetTimeout); replaceAll(timerObjects, 'clearTimeout', clear); replaceAll(promiseObjects, 'setTimeout', promiseTimer); if (!apis.includes('setImmediate')) replaceAll(promiseObjects, 'setImmediate', nativePromiseImmediate); }
        if (apis.includes('setInterval')) { replace(scope, 'setInterval', fakeSetInterval); replace(scope, 'clearInterval', clear); replaceAll(timerObjects, 'setInterval', fakeSetInterval); replaceAll(timerObjects, 'clearInterval', clear); replaceAll(promiseObjects, 'setInterval', fakeIntervalIterator); }
        if (apis.includes('setImmediate')) { replace(scope, 'setImmediate', fakeSetImmediate); replace(scope, 'clearImmediate', clear); replaceAll(timerObjects, 'setImmediate', fakeSetImmediate); replaceAll(timerObjects, 'clearImmediate', clear); replaceAll(promiseObjects, 'setImmediate', (value, opts) => promiseTimer(0, value, opts)); }
        if (apis.includes('scheduler.wait')) { for (const target of promiseObjects) { remember(target, 'scheduler'); replace(target, 'scheduler', { wait: (delay, opts) => promiseTimer(delay, undefined, opts), yield: () => promiseTimer(0) }); } }
        if (apis.includes('Date')) replace(scope, 'Date', fakeDate());
      },
      tick(time = 1) { if (!enabled) failState(); if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', 'time must be a non-negative number'); now += time; let entry; while ((entry = queue.find((item) => item.handle.active && item.runAt <= now))) { if (!entry.handle.repeat) clear(entry.handle); else entry.runAt += entry.delay; entry.callback(...entry.args); queue.sort((a, b) => a.runAt - b.runAt || a.id - b.id); } },
      runAll() { if (!enabled) failState(); const last = queue.filter((item) => item.handle.active).at(-1); if (last) api.tick(Math.max(0, last.runAt - now)); },
      setTime(time = 0) { if (!enabled) failState(); if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', 'time must be a non-negative number'); now = time; },
      reset() { if (!enabled) return; enabled = false; for (const item of queue) item.handle.active = false; queue.length = 0; restoreAll(); now = 0; },
      [Symbol.dispose]() { api.reset(); },
    };
    return api;
  }

  function getter(object, property, implementation, options) {
    if (implementation && typeof implementation === 'object') { options = implementation; implementation = undefined; }
    options = normalizeOptions(options);
    if (options.getter === false) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The property 'options.getter' cannot be false");
    if (options.setter === true) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The property 'options.setter' cannot be used with 'options.getter'");
    return method(object, property, implementation, { ...options, getter: true });
  }
  function setter(object, property, implementation, options) {
    if (implementation && typeof implementation === 'object') { options = implementation; implementation = undefined; }
    options = normalizeOptions(options);
    if (options.setter === false) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The property 'options.setter' cannot be false");
    if (options.getter === true) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The property 'options.setter' cannot be used with 'options.getter'");
    return method(object, property, implementation, { ...options, setter: true });
  }
  return { fn: (...args) => mockFunction(...args), method, getter, setter, property, module, get timers() { return timers ||= createTimers(); }, reset() { restoreAll(); timers?.reset(); mocks.length = 0; }, restoreAll };
  function restoreAll() { for (const entry of mocks) entry.restore(); }
}

export function createNodeTest({ scope, processObject, stdout, stderr, trackTask, assert, timers = {}, timerPromises = {}, sourcePath, execArgv = [] }) {
  normalizeProcessEnv(processObject);
  const schedule = typeof scope.queueMicrotask === 'function' ? scope.queueMicrotask.bind(scope) : (callback) => scope.setTimeout(callback, 0);
  const createRoot = () => ({ name: '<root>', fullName: '<root>', parent: null, before: [], after: [], beforeEach: [], afterEach: [], children: [], started: false, beforeReady: null, completion: null, runTail: Promise.resolve() });
  // A node:test runner gives each discovered file its own top-level suite.
  // Keep the initial root for ordinary `test()` calls, then replace it before
  // each file loaded by run() so root hooks and child registration cannot leak
  // between otherwise independent files.
  let root = createRoot();
  const suiteStack = [root];
  let testTail = Promise.resolve();
  let testCount = 0;
  let passCount = 0;
  let failCount = 0;
  let testApiUsed = false;
  let activeRun = null;
  let runOwnsOutput = false;
  let sourceEvaluationComplete = false;
  let resolveSourceEvaluation;
  const sourceEvaluation = new Promise((resolve) => { resolveSourceEvaluation = resolve; });
  // `node:test.run()` discovers every requested file before starting any of
  // their tests.  Keep registration-time chains behind this gate so a test
  // from the first file cannot start while a later file is still registering
  // its root hooks.
  let testStartGate = Promise.resolve();
  const runtimeState = {
    registered: 0,
    completed: 0,
    files: [],
    requestedFiles: [],
    activeRun: false,
    activeTest: null,
    streamEvents: [],
    streamError: null,
    streamTerminal: null,
  };
  processObject.__bnhNodeTestState = runtimeState;
  function emitRunEvent(type, data, { emit = true, push = true } = {}) {
    if (!activeRun) return;
    const event = { type, data };
    runtimeState.streamEvents.push(type);
    if (emit) activeRun.stream.emit(type, data);
    if (push) activeRun.stream.push(event);
    return event;
  }
  function recordResult(result) {
    testCount += 1;
    runtimeState.completed = testCount;
    if (result.status === 'fail') failCount += 1;
    else if (result.status === 'pass') passCount += 1;
    if (!activeRun) return;
    const passed = result.status === 'pass';
    const data = {
      name: result.name,
      nesting: 0,
      testNumber: testCount,
      testId: testCount,
      parentId: 0,
      details: {
        duration_ms: result.duration_ms || 0,
        type: 'test',
        passed,
        ...(passed ? {} : { error: { cause: result.error || new Error(`test '${result.name}' failed`) } }),
      },
      tags: [],
      line: 1,
      column: 1,
      file: result.file || activeRun.file || sourcePath || processObject.argv?.[1],
    };
    emitRunEvent('test:complete', data);
    emitRunEvent('test:start', data);
    const outcomeData = passed
      ? { ...data, details: { ...data.details } }
      : data;
    if (passed) delete outcomeData.details.passed;
    emitRunEvent(passed ? 'test:pass' : 'test:fail', outcomeData);
  }
  const assertionRegistry = new Map();
  let activeProcessOverride;
  const trackerOptions = { processObject, sourcePath, execArgv, activeProcess: () => activeProcessOverride };
  const globalMock = createMockTracker(scope, { timers, timerPromises }, trackerOptions);
  const snapshotFiles = new Map();
  let serializers = [(value) => JSON.stringify(value, null, 2)];
  let resolveSnapshotPath = (path) => `${path}.snapshot`;
  const snapshotApi = (actual, options) => createSnapshotAssertions({ fullName: '<root>', filePath: sourcePath || processObject.argv?.[1] }).snapshot(actual, options);
  Object.assign(snapshotApi, {
    setDefaultSnapshotSerializers(next) { if (!Array.isArray(next) || next.some((fn) => typeof fn !== 'function')) throw invalidType('serializers', 'Array', next); serializers = next.slice(); scope.require?.('internal/test_runner/snapshot')?.setDefaultSnapshotSerializers?.(next); },
    setResolveSnapshotPath(next) { if (typeof next !== 'function') throw invalidType('fn', 'function', next); resolveSnapshotPath = next; scope.require?.('internal/test_runner/snapshot')?.setResolveSnapshotPath?.(next); },
  });
  const assertionApi = (...args) => Reflect.apply(assert, undefined, args);
  Object.defineProperty(assertionApi, 'register', { configurable: true, enumerable: true, value: registerAssertion });

  function reportFailure(error) { processObject.exitCode ||= 1; const detail = formatError(error); if (!runOwnsOutput) stderr(`${detail}\n`); if (!runOwnsOutput && detail.includes('Missing snapshots')) stdout(`${detail}\n`); return detail; }
  async function runHooks(hooks, context) { for (const hook of hooks) await Reflect.apply(hook, context, [context]); }
  async function runWithTimeout(action, timeout, label, onTimeout) {
    if (timeout === undefined || timeout === null) return action();
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', `The value of \"timeout\" is out of range. It must be >= 0. Received ${timeout}`);
    }
    let timer;
    let timedOut = false;
    const actionPromise = Promise.resolve().then(action);
    // A timed-out test may still be unwinding an operation it created. Attach
    // a rejection handler so that late completion cannot become an unrelated
    // process-level unhandled rejection after node:test has reported the
    // timeout.
    actionPromise.catch(() => {});
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = scope.setTimeout(() => {
        timedOut = true;
        const error = codedError(Error, 'ERR_TEST_FAILURE', `test \"${label}\" timed out after ${timeout}ms`);
        error.failureType = 'testTimeout';
        onTimeout?.(error);
        reject(error);
      }, timeout);
    });
    try {
      return await Promise.race([actionPromise, timeoutPromise]);
    } finally {
      if (!timedOut && timer !== undefined) scope.clearTimeout?.(timer);
    }
  }
  function diagnostic(message) { stdout(`# ${String(message).replace(/\r?\n/g, '\n# ')}\n`); }
  function registerAssertion(name, fn) { if (typeof name !== 'string') throw invalidType('name', 'string', name); if (typeof fn !== 'function') throw invalidType('fn', 'function', fn); assertionRegistry.set(name, fn); }
  function serialize(value, localSerializers = serializers) {
    if (!Array.isArray(localSerializers)) throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "options.serializers" property must be an instance of Array');
    const invalidSerializer = localSerializers.findIndex((fn) => typeof fn !== 'function');
    if (invalidSerializer !== -1) throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "options.serializers[${invalidSerializer}]" property must be of type function. Received ${typeof localSerializers[invalidSerializer]}`);
    let result = value;
    try { for (const fn of localSerializers) result = fn(result); } catch (cause) { const error = codedError(Error, 'ERR_INVALID_STATE', 'The provided serializers did not generate a string'); error.input = value; error.cause = cause; throw error; }
    if (typeof result !== 'string') { const error = codedError(Error, 'ERR_INVALID_STATE', 'The provided serializers did not generate a string'); error.input = value; throw error; }
    return result;
  }
  function snapshotFile(path) { let file = snapshotFiles.get(path); if (!file) { file = { snapshots: Object.create(null), counts: new Map(), loaded: false }; snapshotFiles.set(path, file); } return file; }
  function writeSnapshotFiles() {
    if (!processObject.execArgv?.includes('--test-update-snapshots')) return;
    const fs = scope.require('node:fs');
    const pathModule = scope.require('node:path');
    for (const [path, file] of snapshotFiles) {
      const entries = Object.entries(file.snapshots);
      const source = entries.map(([key, value]) => `exports[${JSON.stringify(key)}] = ${JSON.stringify(value)};`).join('\n') + (entries.length ? '\n' : '');
      fs.mkdirSync?.(pathModule.dirname(path), { recursive: true });
      fs.writeFileSync(path, source, 'utf8');
    }
  }
  function loadSnapshot(path, file) {
    if (file.loaded) return;
    file.loaded = true;
    try { const source = scope.require('node:fs').readFileSync(path, 'utf8'); const exports = {}; new Function('exports', source)(exports); if (!exports || typeof exports !== 'object') throw new Error('Malformed snapshot file'); for (const [key, value] of Object.entries(exports)) file.snapshots[key] = value; } catch (cause) { const error = codedError(Error, 'ERR_INVALID_STATE', `Cannot read snapshot file '${path}'.${cause?.code === 'ENOENT' ? ' Missing snapshots can be generated by rerunning the command with the --test-update-snapshots flag.' : ''}`); error.cause = cause; error.filename = path; throw error; }
  }
  function createSnapshotAssertions(context, record = () => {}) {
    const inferFilePath = () => {
      const stack = String(new Error().stack || '');
      const match = stack.split('\n')
        .map((line) => line.match(/(\/node\/[^():\n]+\.m?js):\d+/)?.[1])
        .find((candidate) => candidate && !candidate.includes('/runtime/'));
      return match || context.filePath || sourcePath || processObject.argv?.[1] || '/node/test.js';
    };
    const resolveSnapshotFile = (filePath) => {
      const previousProcess = scope.process;
      scope.process = processObject;
      try { return resolveSnapshotPath(filePath); }
      finally { scope.process = previousProcess; }
    };
    const snapshot = (actual, options = {}) => { record(); if (options === null || typeof options !== 'object') throw invalidType('options', 'object', options); const value = `\n${serialize(actual, options.serializers === undefined ? serializers : options.serializers).replaceAll('`', '\\`').replaceAll('${', '\\${')}\n`; const path = resolveSnapshotFile(inferFilePath()); const file = snapshotFile(path); const id = `${context.fullName} ${file.counts.get(context.fullName) || 1}`; file.counts.set(context.fullName, (file.counts.get(context.fullName) || 1) + 1); if (processObject.execArgv?.includes('--test-update-snapshots')) file.snapshots[id] = value; else { loadSnapshot(path, file); if (file.snapshots[id] !== value) assert.strictEqual(value, file.snapshots[id]); } };
    const fileSnapshot = (actual, path, options = {}) => { record(); if (typeof path !== 'string') throw invalidType('path', 'string', path); if (options === null || typeof options !== 'object') throw invalidType('options', 'object', options); const value = serialize(actual, options.serializers === undefined ? serializers : options.serializers); const fs = scope.require('node:fs'); if (processObject.execArgv?.includes('--test-update-snapshots')) fs.writeFileSync(path, value, 'utf8'); else assert.strictEqual(value, fs.readFileSync(path, 'utf8')); };
    return { snapshot, fileSnapshot };
  }
  function createTestAssert(context) {
    const result = {}; const excluded = new Set(['AssertionError', 'CallTracker', 'strict', 'Assert', 'options']);
    for (const key of Object.keys(assert)) if (!excluded.has(key) && typeof assert[key] === 'function') result[key] = (...args) => { context._assertionCount += 1; return Reflect.apply(assert[key], context, args); };
    Object.assign(result, createSnapshotAssertions(context, () => { context._assertionCount += 1; }));
    for (const [name, fn] of assertionRegistry) result[name] = (...args) => { context._assertionCount += 1; return Reflect.apply(fn, context, args); };
    return result;
  }
  function startSuite(suite) {
    if (suite.started) return suite; suite.started = true; const release = trackTask();
    suite.beforeReady = (async () => { try { await Promise.resolve(); await runHooks(suite.before, { name: suite.name, fullName: suite.fullName, signal: suite.signal, diagnostic, assert }); return null; } catch (error) { return error; } })();
    suite.completion = (async () => { const beforeError = await suite.beforeReady; await Promise.all(suite.children); try { await runHooks([...suite.after].reverse(), { name: suite.name, signal: suite.signal }); } catch (error) { reportFailure(error); } if (beforeError) reportFailure(beforeError); })().finally(() => release?.()); return suite;
  }
  function hook(name, callback) { if (typeof callback !== 'function') throw invalidType(`${name} callback`, 'function', callback); suiteStack.at(-1)[name].push(callback); }
  function beginFile() {
    root = createRoot();
    suiteStack.length = 0;
    suiteStack.push(root);
  }
  function hookChain(suite, name) { const chain = []; for (let current = suite; current; current = current.parent) chain.push(...current[name]); return name === 'afterEach' ? chain : chain.reverse(); }
  function createSuite(name, options, callback, parent) {
    const suite = { name: String(name ?? '(anonymous suite)'), fullName: parent === root ? String(name ?? '(anonymous suite)') : `${parent.fullName} > ${String(name ?? '(anonymous suite)')}`, parent, signal: options.signal, before: [], after: [], beforeEach: [], afterEach: [], children: [], started: false, beforeReady: null, completion: null, runTail: Promise.resolve() };
    let definitionError = null;
    if (!options.skip && !options.todo && typeof callback === 'function') {
      suiteStack.push(suite);
      const context = { name: suite.name, fullName: suite.fullName, signal: suite.signal, diagnostic, assert };
      try { Reflect.apply(callback, context, [context]); } catch (error) { definitionError = error; } finally { suiteStack.pop(); }
    }
    // Hooks are registered while the suite definition callback runs. Start
    // the suite only after that callback has returned so async before hooks
    // cannot race test execution with an empty hook list.
    parent.children.push(startSuite(suite).completion);
    if (definitionError) throw definitionError;
    return suite.completion;
  }
  function register(name, options, callback, parent = suiteStack.at(-1), ownerNode = null) {
    testApiUsed = true;
    runtimeState.registered += 1;
    const task = splitDefinition(name, options, callback); const label = String(task.name ?? '(unnamed test)'); const testOptions = task.options; const fullName = ownerNode?.fullName ? `${ownerNode.fullName} > ${label}` : parent === root ? label : `${parent.fullName} > ${label}`;
    // Capture the owning file while the file is being discovered. The active
    // run advances to the next file before the serialized result is emitted,
    // so consulting activeRun.file at completion misattributes failures and
    // leaves reporters without the real per-test error context.
    const file = activeRun?.file || sourcePath || processObject.argv?.[1];
    const result = new Promise((resolve) => {
      const node = { children: [], fullName, file, before: [], after: [], beforeEach: [], afterEach: [], beforeReady: null, context: null, mock: null };
      const run = async () => {
        const release = trackTask();
        runtimeState.activeTest = { name: label, fullName, file, state: 'running' };
        try {
          const suiteState = startSuite(parent);
          const beforeError = await suiteState.beforeReady;
          if (beforeError) {
            const detail = reportFailure(beforeError);
            if (!runOwnsOutput) stderr(`not ok - ${label}: ${detail}\n`);
            return { name: label, status: 'fail', error: beforeError, file };
          }
          if (testOptions.skip || testOptions.todo) {
            if (!runOwnsOutput) stdout(`ok - ${label}${testOptions.skip ? ' # SKIP' : ' # TODO'}\n`);
            return { name: label, status: testOptions.skip ? 'skip' : 'pass', file };
          }
          let planCount = null;
          const testAbortController = typeof scope.AbortController === 'function'
            ? new scope.AbortController()
            : null;
          const externalSignal = testOptions.signal;
          let removeExternalAbort = null;
          if (testAbortController && externalSignal?.addEventListener) {
            const forwardAbort = () => testAbortController.abort(externalSignal.reason);
            if (externalSignal.aborted) forwardAbort();
            else {
              externalSignal.addEventListener('abort', forwardAbort, { once: true });
              removeExternalAbort = () => externalSignal.removeEventListener('abort', forwardAbort);
            }
          }
          const testSignal = testAbortController?.signal || externalSignal;
          const context = {
            name: label,
            fullName,
            filePath: file,
            signal: testSignal,
            assert: null,
            _assertionCount: 0,
            diagnostic,
            before: (fn) => node.before.push(fn),
            after: (fn) => node.after.push(fn),
            beforeEach: (fn) => node.beforeEach.push(fn),
            afterEach: (fn) => node.afterEach.push(fn),
            plan(count) {
              if (!Number.isInteger(count) || count < 0) {
                throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "count" argument must be a non-negative integer');
              }
              planCount = count;
            },
            runOnly(value) { node.runOnly = Boolean(value); },
            skip(message) { node.skipReason = message || true; },
            todo(message) { node.todoReason = message || true; },
            test: (childName, childOptions, childCallback) => {
              const child = register(childName, childOptions, childCallback, parent, node);
              node.children.push(child);
              return child;
            },
            waitFor: (condition, options = {}) => {
              if (typeof condition !== 'function') throw invalidType('condition', 'function', condition);
              const interval = options.interval ?? 50;
              const waitTimeout = options.timeout ?? 1000;
              return new Promise((resolve, reject) => {
                const started = Date.now();
                const poll = async () => {
                  try { resolve(await condition()); }
                  catch (error) {
                    if (Date.now() - started >= waitTimeout) {
                      error.cause ||= error;
                      reject(error);
                    } else scope.setTimeout(poll, interval);
                  }
                };
                poll();
              });
            },
          };
          context.assert = createTestAssert(context);
          node.context = context;
          node.mock = createMockTracker(scope, { timers, timerPromises }, trackerOptions);
          Object.defineProperty(context, 'mock', { enumerable: true, get: () => node.mock });
          let failure = null;
          const execute = async () => {
            try {
              await runHooks(hookChain(parent, 'beforeEach'), context);
              if (ownerNode?.beforeReady) await ownerNode.beforeReady;
              if (ownerNode) await runHooks(ownerNode.beforeEach, context);
              if (typeof task.callback === 'function') {
                if (task.callback.length > 1) {
                  await new Promise((resolve, reject) => {
                    let called = false;
                    const done = (error) => {
                      if (called) return;
                      called = true;
                      if (error) reject(error);
                      else resolve();
                    };
                    try { Reflect.apply(task.callback, context, [context, done]); }
                    catch (error) { reject(error); }
                  });
                } else await Reflect.apply(task.callback, context, [context]);
              }
            } catch (error) {
              failure = error;
            }
            try {
              if (ownerNode) await runHooks([...ownerNode.afterEach].reverse(), context);
              await runHooks(hookChain(parent, 'afterEach'), context);
            } catch (error) {
              failure ||= error;
            }
            const childResults = await Promise.all(node.children);
            if (node.beforeReady) await node.beforeReady;
            try { await runHooks([...node.after].reverse(), context); }
            catch (error) { failure ||= error; }
            if (planCount !== null && context._assertionCount !== planCount) {
              failure ||= new Error(`_plan_ assertion count mismatch: expected ${planCount}, actual ${context._assertionCount}`);
            }
            if (!failure && childResults.some((child) => child.status === 'fail')) {
              failure = new Error(`subtest of '${label}' failed`);
            }
          };
          const timeout = testOptions.timeout ?? activeRun?.timeout;
          try {
            try { await runWithTimeout(execute, timeout, label, (error) => testAbortController?.abort(error)); }
            catch (error) { failure ||= error; }
            node.mock.reset();
            globalMock.reset();
            if (failure) {
              const detail = reportFailure(failure);
              if (!runOwnsOutput) stderr(`not ok - ${label}: ${detail}\n`);
              return { name: label, status: 'fail', error: failure, file };
            }
            if (!runOwnsOutput) stdout(`ok - ${label}\n`);
            return { name: label, status: 'pass', file };
          } finally {
            removeExternalAbort?.();
          }
        } finally {
          if (runtimeState.activeTest?.file === file && runtimeState.activeTest?.name === label) {
            runtimeState.activeTest = null;
          }
          release?.();
        }
      };
      const finish = (value) => { recordResult(value); resolve(value); };
      if (ownerNode) schedule(() => run().then(finish, (error) => finish({ name: label, status: 'fail', error, file })));
      else {
        const previous = testTail;
        testTail = previous.then(() => testStartGate).then(() => run()).then(
          finish,
          (error) => finish({ name: label, status: 'fail', error, file }),
        );
      }
    });
    parent.children.push(result); return result;
  }
  const test = (name, options, callback) => register(name, options, callback);
  const describe = (name, options, callback) => { const definition = splitDefinition(name, options, callback); return createSuite(definition.name, definition.options, definition.callback, suiteStack.at(-1)); };
  const mock = globalMock;
  const run = (options = {}) => {
    if (activeRun) return activeRun.stream;
    runOwnsOutput = true;
    const releaseRunTask = trackTask();
    const streamApi = scope.require('node:stream');
    const Readable = streamApi?.Readable;
    if (typeof Readable !== 'function') throw codedError(Error, 'ERR_UNSUPPORTED_NODE_TEST_RUN', 'node:test run requires node:stream.Readable');
    const stream = new Readable({ objectMode: true, read() {} });
    activeRun = {
      stream,
      file: null,
      timeout: options['no-timeout'] ? null : options.timeout ?? 30000,
    };
    runtimeState.activeRun = true;
    runtimeState.streamEvents = [];
    runtimeState.streamError = null;
    runtimeState.streamTerminal = null;
    stream.once('error', (error) => {
      runtimeState.streamError = formatError(error);
      runtimeState.streamTerminal = 'error';
    });
    stream.once('end', () => { runtimeState.streamTerminal = 'end'; });
    stream.once('close', () => { runtimeState.streamTerminal ||= 'close'; });
    const files = Array.isArray(options.files) ? options.files : options.files ? [options.files] : [];
    runtimeState.requestedFiles = files.map((file) => String(file));
    runtimeState.files = [];
    const importer = processObject.argv?.[1] || sourcePath || '/node/index.js';
    let releaseDiscovery;
    const discoveryComplete = new Promise((resolve) => { releaseDiscovery = resolve; });
    testStartGate = discoveryComplete;
    const finishDiscovery = () => {
      releaseDiscovery?.();
      releaseDiscovery = null;
      if (testStartGate === discoveryComplete) testStartGate = Promise.resolve();
    };
    (async () => {
      try {
        // Match Node's TestsStream scheduling: give callers a turn to attach
        // event listeners before discovery and execution begin.
        await Promise.resolve();
        for (const file of files) {
          beginFile();
          activeRun.file = String(file);
          runtimeState.files.push(activeRun.file);
          emitRunEvent('test:enqueue', {
            nesting: 0,
            name: activeRun.file,
            type: 'test',
            testId: runtimeState.files.length,
            parentId: 0,
            tags: [],
            line: 1,
            column: 1,
            file: activeRun.file,
          }, { emit: false });
          emitRunEvent('test:dequeue', {
            nesting: 0,
            name: activeRun.file,
            type: 'test',
            testId: runtimeState.files.length,
            parentId: 0,
            tags: [],
            line: 1,
            column: 1,
            file: activeRun.file,
          });
          if (typeof processObject.__bnhModuleImport !== 'function') {
            throw codedError(Error, 'ERR_UNSUPPORTED_NODE_TEST_RUN', 'node:test run cannot load test files in this process');
          }
          await processObject.__bnhModuleImport(String(file), importer, undefined, processObject);
        }
        // Release test chains only after the final file has finished
        // registering its tests and root hooks.
        finishDiscovery();
        await testTail;
        emitRunEvent('test:plan', { nesting: 0, count: testCount });
        for (const [name, count] of [
          ['tests', testCount], ['suites', 0], ['pass', passCount], ['fail', failCount],
          ['cancelled', 0], ['skipped', 0], ['todo', 0],
        ]) emitRunEvent('test:diagnostic', { nesting: 0, message: `${name} ${count}`, level: 'info' });
        emitRunEvent('test:summary', {
          success: failCount === 0,
          counts: {
            tests: testCount,
            failed: failCount,
            passed: passCount,
            cancelled: 0,
            skipped: 0,
            todo: 0,
            topLevel: testCount,
            suites: 0,
          },
          duration_ms: 0,
          file: undefined,
        });
      } catch (error) {
        processObject.exitCode ||= 1;
        runtimeState.streamError = formatError(error);
        stderr(`${formatError(error)}\n`);
        stream.destroy(error);
        return;
      } finally {
        finishDiscovery();
        if (!stream.destroyed) stream.push(null);
        activeRun = null;
        runtimeState.activeRun = false;
        releaseRunTask?.();
      }
    })();
    return stream;
  };
  Object.assign(test, { test, it: test, describe, suite: describe, only: test, skip: (name, options, callback) => { const d = splitDefinition(name, options, callback); return register(d.name, { ...d.options, skip: true }, d.callback); }, todo: (name, options, callback) => { const d = splitDefinition(name, options, callback); return register(d.name, { ...d.options, todo: true }, d.callback); }, before: (callback) => hook('before', callback), after: (callback) => hook('after', callback), beforeEach: (callback) => hook('beforeEach', callback), afterEach: (callback) => hook('afterEach', callback), run });
  Object.defineProperty(test, 'mock', { configurable: true, enumerable: true, get: () => mock });
  Object.defineProperty(test, '__bnhSetActiveProcess', {
    configurable: true,
    value: (value) => { activeProcessOverride = value; },
  });
  Object.defineProperty(test, '__bnhSourceLoaded', {
    configurable: true,
    value: () => {
      if (sourceEvaluationComplete) return;
      sourceEvaluationComplete = true;
      resolveSourceEvaluation?.();
      resolveSourceEvaluation = null;
    },
  });
  // Same-realm virtual children do not pass through executeEntry(), which is
  // where the top-level runtime normally marks source evaluation complete.
  // Expose the marker on the logical process so the child launcher can settle
  // this instance after its synchronous entry (and any --test extras) load.
  Object.defineProperty(processObject, '__bnhNodeTestSourceLoaded', {
    configurable: true,
    value: () => test.__bnhSourceLoaded(),
  });
  Object.defineProperty(test, 'snapshot', { configurable: true, enumerable: true, value: snapshotApi });
  Object.defineProperty(test, 'assert', { configurable: true, enumerable: true, value: assertionApi });
  const summaryRelease = trackTask();
  schedule(async () => {
    // Entry evaluation may yield for preloads before it registers its first
    // test. Do not mistake that initial empty window for a test-free process;
    // the runtime marks the entry loaded after the CommonJS/ESM boundary.
    await sourceEvaluation;
    await testTail;
    if (!testApiUsed) {
      summaryRelease?.();
      return;
    }
    try { writeSnapshotFiles(); } catch (error) { failCount += 1; processObject.exitCode ||= 1; stderr(`${formatError(error)}\n`); }
    if (!runOwnsOutput) stdout(`# tests ${testCount}\n# pass ${passCount}\n# fail ${failCount}\n`);
    summaryRelease?.();
  });
  const instances = new WeakMap([[processObject, test]]);
  const activeInstance = () => {
    // ESM evaluation resumes after the loader has restored the ambient
    // scope.process.  Keep builtin node:test imports bound to the logical
    // process selected by the loader instead of creating a second registry.
    const activeProcess = activeProcessOverride || scope.__bnhActiveProcess || scope.process || processObject;
    if (activeProcess === processObject) return test;
    let instance = instances.get(activeProcess);
    if (!instance) {
      const writeStdout = (value) => activeProcess.stdout?.write?.(value) ?? stdout(value);
      const writeStderr = (value) => activeProcess.stderr?.write?.(value) ?? stderr(value);
      instance = createNodeTest({
        scope,
        processObject: activeProcess,
        stdout: writeStdout,
        stderr: writeStderr,
        trackTask: activeProcess._bnhTaskTracker || trackTask,
        assert,
        timers,
        timerPromises,
        sourcePath: activeProcess.argv?.[1],
        execArgv: activeProcess.execArgv,
      });
      instances.set(activeProcess, instance);
    }
    return instance;
  };
  return new Proxy(test, {
    apply(_target, thisArg, args) { return Reflect.apply(activeInstance(), thisArg, args); },
    get(_target, property, receiver) {
      if (property === '__bnhSetActiveProcess') return Reflect.get(_target, property, receiver);
      return Reflect.get(activeInstance(), property, receiver);
    },
  });
}
