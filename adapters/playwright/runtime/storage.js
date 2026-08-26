import { UnsupportedWebCapabilityError } from './errors.js';

const CAPABILITIES = Object.freeze({
  indexedDB: 'IndexedDB',
  cacheStorage: 'Cache Storage',
  opfs: 'Origin Private File System',
  storage: 'navigator.storage',
  locks: 'Web Locks',
});

function readProperty(target, name) {
  try {
    return target?.[name];
  } catch {
    return undefined;
  }
}

function nativeObjects(globalObject) {
  const navigator = readProperty(globalObject, 'navigator');
  const storage = readProperty(navigator, 'storage');
  return {
    indexedDB: readProperty(globalObject, 'indexedDB'),
    cacheStorage: readProperty(globalObject, 'caches'),
    storage,
    locks: readProperty(navigator, 'locks'),
  };
}

function hasMethod(target, name) {
  return typeof readProperty(target, name) === 'function';
}

function unsupported(capability, method, reason = `${method}() is unavailable in this browser context`) {
  throw new UnsupportedWebCapabilityError(capability, reason);
}

function callNative(target, method, capability, args = [], label = method) {
  const fn = readProperty(target, method);
  if (typeof fn !== 'function') unsupported(capability, label);
  return fn.apply(target, args);
}

function listen(target, event, listener) {
  if (typeof target?.addEventListener === 'function') {
    target.addEventListener(event, listener, { once: true });
    return;
  }
  target[`on${event}`] = listener;
}

function requestResult(request, operation) {
  if (request && typeof request.then === 'function') return Promise.resolve(request);
  if (!request || (typeof request !== 'object' && typeof request !== 'function')) {
    return Promise.reject(new TypeError(`IndexedDB ${operation}() did not return an IDBRequest`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error || request.error || new Error(`IndexedDB ${operation}() failed`));
    };

    listen(request, 'success', () => {
      if (settled) return;
      settled = true;
      resolve(request.result);
    });
    listen(request, 'error', () => fail(request.error));
    listen(request, 'blocked', () => {});
  });
}

function openDatabase(request, onUpgrade) {
  let upgradeError;
  if (typeof onUpgrade === 'function') {
    if (request && (typeof request === 'object' || typeof request === 'function')) listen(request, 'upgradeneeded', (event) => {
      try {
        onUpgrade(request.result, event);
      } catch (error) {
        upgradeError = error;
        try {
          request.transaction?.abort?.();
        } catch {
          // The original upgrade error is the useful failure for callers.
        }
      }
    });
  }
  return requestResult(request, 'open').then(
    (result) => {
      if (upgradeError) throw upgradeError;
      return result;
    },
    (error) => {
      throw upgradeError || error;
    },
  );
}

function createIndexedDBAdapter(indexedDB) {
  const supported = hasMethod(indexedDB, 'open');
  const openRequest = (name, version) => version === undefined
    ? callNative(indexedDB, 'open', CAPABILITIES.indexedDB, [name])
    : callNative(indexedDB, 'open', CAPABILITIES.indexedDB, [name, version]);

  return Object.freeze({
    supported,
    raw: indexedDB,
    open(name, version, onUpgrade) {
      if (typeof version === 'function') {
        onUpgrade = version;
        version = undefined;
      }
      return openDatabase(openRequest(name, version), onUpgrade);
    },
    openRequest(name, version) {
      return openRequest(name, version);
    },
    deleteDatabase(name) {
      return requestResult(
        callNative(indexedDB, 'deleteDatabase', CAPABILITIES.indexedDB, [name]),
        'deleteDatabase',
      );
    },
    databases() {
      return Promise.resolve(callNative(indexedDB, 'databases', CAPABILITIES.indexedDB));
    },
  });
}

function createCacheStorageAdapter(cacheStorage) {
  return Object.freeze({
    supported: hasMethod(cacheStorage, 'open'),
    raw: cacheStorage,
    open(name) {
      return callNative(cacheStorage, 'open', CAPABILITIES.cacheStorage, [name]);
    },
    match(request, options) {
      return callNative(cacheStorage, 'match', CAPABILITIES.cacheStorage, [request, options]);
    },
    has(name) {
      return callNative(cacheStorage, 'has', CAPABILITIES.cacheStorage, [name]);
    },
    delete(name) {
      return callNative(cacheStorage, 'delete', CAPABILITIES.cacheStorage, [name]);
    },
    keys() {
      return callNative(cacheStorage, 'keys', CAPABILITIES.cacheStorage);
    },
  });
}

function createOPFSAdapter(storage) {
  const getDirectory = () => callNative(storage, 'getDirectory', CAPABILITIES.opfs);
  const fromRoot = async (method, args) => {
    const root = await getDirectory();
    return callNative(root, method, CAPABILITIES.opfs, args, `directory.${method}`);
  };

  return Object.freeze({
    supported: hasMethod(storage, 'getDirectory'),
    raw: storage,
    getDirectory,
    getFileHandle(name, options) {
      return fromRoot('getFileHandle', [name, options]);
    },
    getDirectoryHandle(name, options) {
      return fromRoot('getDirectoryHandle', [name, options]);
    },
    removeEntry(name, options) {
      return fromRoot('removeEntry', [name, options]);
    },
    resolve(possibleDescendant) {
      return fromRoot('resolve', [possibleDescendant]);
    },
  });
}

function createNavigatorStorageAdapter(storage) {
  return Object.freeze({
    supported: hasMethod(storage, 'estimate') || hasMethod(storage, 'persist') || hasMethod(storage, 'persisted'),
    raw: storage,
    estimate() {
      return callNative(storage, 'estimate', CAPABILITIES.storage);
    },
    persist() {
      return callNative(storage, 'persist', CAPABILITIES.storage);
    },
    persisted() {
      return callNative(storage, 'persisted', CAPABILITIES.storage);
    },
  });
}

function createWebLocksAdapter(locks) {
  function request(name, optionsOrCallback, callback) {
    const nativeRequest = readProperty(locks, 'request');
    if (typeof nativeRequest !== 'function') unsupported(CAPABILITIES.locks, 'request');
    if (typeof optionsOrCallback === 'function') return nativeRequest.call(locks, name, optionsOrCallback);
    if (arguments.length === 2) return nativeRequest.call(locks, name, optionsOrCallback);
    return nativeRequest.call(locks, name, optionsOrCallback, callback);
  }

  return Object.freeze({
    supported: hasMethod(locks, 'request'),
    raw: locks,
    request,
    run(name, callback, options = {}) {
      return request(name, options, callback);
    },
    query() {
      return callNative(locks, 'query', CAPABILITIES.locks);
    },
  });
}

function normalizeFactoryOptions(input) {
  if (!input) return { globalObject: globalThis };
  const hasOptions = typeof input === 'object' && (
    Object.prototype.hasOwnProperty.call(input, 'globalObject')
    || Object.prototype.hasOwnProperty.call(input, 'fallback')
    || Object.prototype.hasOwnProperty.call(input, 'memoryFallback')
    || Object.prototype.hasOwnProperty.call(input, 'testIsolation')
  );
  return hasOptions ? input : { globalObject: input };
}

function cloneMemoryValue(value, clone) {
  if (typeof clone === 'function') return clone(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return new value.constructor(value);
  }
  if (value instanceof Map) {
    return new Map([...value].map(([key, entry]) => [cloneMemoryValue(key), cloneMemoryValue(entry)]));
  }
  if (value instanceof Set) return new Set([...value].map((entry) => cloneMemoryValue(entry)));
  if (Array.isArray(value)) return value.map((entry) => cloneMemoryValue(entry));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneMemoryValue(entry)]),
  );
}

/**
 * Create a process-local store for tests that need persistence semantics without
 * granting the browser runtime access to a host filesystem. It is never used
 * by the native adapters automatically.
 */
export function createMemoryStorage(globalObject = globalThis) {
  const values = new Map();
  const clone = readProperty(globalObject, 'structuredClone');
  const copy = (value) => cloneMemoryValue(value, clone);

  return Object.freeze({
    supported: true,
    virtual: true,
    capability: 'storage.memory',
    persistent: false,
    inMemory: true,
    get(key, defaultValue) {
      return values.has(key) ? copy(values.get(key)) : defaultValue;
    },
    set(key, value) {
      values.set(key, copy(value));
    },
    has(key) {
      return values.has(key);
    },
    delete(key) {
      return values.delete(key);
    },
    clear() {
      values.clear();
    },
    keys() {
      return [...values.keys()];
    },
    entries() {
      return [...values.entries()].map(([key, value]) => [key, copy(value)]);
    },
  });
}

export function detectStorageCapabilities(globalObject = globalThis) {
  const native = nativeObjects(globalObject);
  return Object.freeze({
    indexedDB: hasMethod(native.indexedDB, 'open'),
    cacheStorage: hasMethod(native.cacheStorage, 'open'),
    opfs: hasMethod(native.storage, 'getDirectory'),
    storage: hasMethod(native.storage, 'estimate')
      || hasMethod(native.storage, 'persist')
      || hasMethod(native.storage, 'persisted'),
    locks: hasMethod(native.locks, 'request'),
  });
}

export function createStorageAdapters(input) {
  const options = normalizeFactoryOptions(input);
  if (options.fallback !== undefined && options.fallback !== false
    && options.fallback !== 'none' && options.fallback !== 'memory' && options.fallback !== 'virtual') {
    throw new TypeError('only the in-memory or virtual storage fallback is supported for test isolation');
  }
  const globalObject = options.globalObject || globalThis;
  const native = nativeObjects(globalObject);
  const features = detectStorageCapabilities(globalObject);
  const adapters = {
    features,
    indexedDB: createIndexedDBAdapter(native.indexedDB),
    cacheStorage: createCacheStorageAdapter(native.cacheStorage),
    opfs: createOPFSAdapter(native.storage),
    storage: createNavigatorStorageAdapter(native.storage),
    locks: createWebLocksAdapter(native.locks),
  };

  if (options.fallback === 'memory' || options.fallback === 'virtual'
    || options.memoryFallback === true || options.testIsolation === true) {
    const memory = createMemoryStorage(globalObject);
    adapters.memory = memory;
    adapters.fallback = memory;
    adapters.virtual = memory;
  }

  adapters.caches = adapters.cacheStorage;
  adapters.navigatorStorage = adapters.storage;
  adapters.webLocks = adapters.locks;
  return Object.freeze(adapters);
}

export const createBrowserStorage = createStorageAdapters;
