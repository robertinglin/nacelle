let nextAsyncId = 2;
let executionId = 1;
const hooks = new Set();
const resources = new Map();
const contexts = new Map();
const promiseIds = new WeakMap();
const rootResource = {};
const originalThen = Promise.prototype.then;
let promisePatchInstalled = false;

resources.set(executionId, {
  type: 'ROOT',
  triggerAsyncId: 0,
  resource: rootResource,
  destroyed: false,
});
contexts.set(executionId, new Map());

function emit(name, ...args) {
  for (const hook of [...hooks]) hook[name]?.(...args);
}

function newAsyncId(type, triggerAsyncId, resource) {
  const asyncId = nextAsyncId++;
  resources.set(asyncId, { type, triggerAsyncId, resource, destroyed: false });
  emit('init', asyncId, type, triggerAsyncId, resource);
  const inherited = contexts.get(triggerAsyncId);
  if (inherited) contexts.set(asyncId, new Map(inherited));
  return asyncId;
}

function runInScope(asyncId, callback, thisArg, args) {
  const previous = executionId;
  executionId = asyncId;
  emit('before', asyncId);
  try {
    return Reflect.apply(callback, thisArg, args);
  } finally {
    emit('after', asyncId);
    executionId = previous;
  }
}

let taskHooksInstalled = false;

function installTaskHooks(scope) {
  if (taskHooksInstalled || !scope) return;
  taskHooksInstalled = true;
  for (const [name, type] of [['setTimeout', 'Timeout'], ['setInterval', 'Interval']]) {
    const original = scope[name];
    if (typeof original !== 'function') continue;
    scope[name] = function patchedTimer(callback, delay, ...args) {
      if (typeof callback !== 'function') return original.call(this, callback, delay, ...args);
      const resource = {};
      const triggerAsyncId = executionId;
      let asyncId;
      const wrapped = (...callbackArgs) => runInScope(asyncId, callback, this, callbackArgs);
      const handle = original.call(this, wrapped, delay, ...args);
      resource.handle = handle;
      asyncId = newAsyncId(type, triggerAsyncId, resource);
      return handle;
    };
  }

  const originalQueueMicrotask = scope.queueMicrotask;
  if (typeof originalQueueMicrotask === 'function') {
    scope.queueMicrotask = function patchedQueueMicrotask(callback) {
      if (typeof callback !== 'function') return originalQueueMicrotask.call(this, callback);
      const resource = {};
      const triggerAsyncId = executionId;
      let asyncId;
      originalQueueMicrotask.call(this, () => runInScope(asyncId, callback, this, []));
      asyncId = newAsyncId('Microtask', triggerAsyncId, resource);
    };
  }

}

// Avoid changing host timers when this adapter module is imported by
// Playwright's Node-side test runner. Browser workers need the same hooks as
// browser windows so tasks inherit the store from the scope that scheduled them.
const isBrowserRealm = (typeof window !== 'undefined' && window === globalThis)
  || (typeof self !== 'undefined' && self === globalThis);
if (isBrowserRealm) installTaskHooks(globalThis);

function installPromiseHooks() {
  if (promisePatchInstalled) return;
  promisePatchInstalled = true;
  Promise.prototype.then = function patchedThen(onFulfilled, onRejected) {
    const triggerAsyncId = promiseIds.get(this) || executionId;
    let asyncId;
    const fulfill = typeof onFulfilled === 'function'
      ? (...args) => runInScope(asyncId, onFulfilled, this, args)
      : onFulfilled;
    const reject = typeof onRejected === 'function'
      ? (...args) => runInScope(asyncId, onRejected, this, args)
      : onRejected;
    const result = originalThen.call(this, fulfill, reject);
    asyncId = newAsyncId('PROMISE', triggerAsyncId, result);
    promiseIds.set(result, asyncId);
    emit('promiseResolve', asyncId);
    return result;
  };
}

class AsyncHook {
  constructor(callbacks = {}) {
    if (callbacks === null || typeof callbacks !== 'object') throw new TypeError('callbacks must be an object');
    for (const name of ['init', 'before', 'after', 'destroy', 'promiseResolve']) {
      if (callbacks[name] !== undefined && typeof callbacks[name] !== 'function') {
        throw new TypeError(`${name} must be a function`);
      }
    }
    Object.assign(this, callbacks);
    this.enabled = false;
  }

  enable() {
    if (!this.enabled) {
      this.enabled = true;
      hooks.add(this);
      installPromiseHooks();
    }
    return this;
  }

  disable() {
    this.enabled = false;
    hooks.delete(this);
    return this;
  }
}

export class AsyncResource {
  constructor(type, options = {}) {
    if (typeof type !== 'string') throw new TypeError('type must be a string');
    const triggerAsyncId = typeof options === 'number'
      ? options
      : options?.triggerAsyncId ?? executionId;
    if (!Number.isSafeInteger(triggerAsyncId) || triggerAsyncId < -1) {
      const error = new RangeError(`invalid async id: ${triggerAsyncId}`);
      error.code = 'ERR_INVALID_ASYNC_ID';
      throw error;
    }
    this._asyncId = newAsyncId(type, triggerAsyncId, this);
    this._triggerAsyncId = triggerAsyncId;
    this._destroyed = false;
  }

  asyncId() { return this._asyncId; }
  triggerAsyncId() { return this._triggerAsyncId; }

  runInAsyncScope(callback, thisArg, ...args) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    return runInScope(this._asyncId, callback, thisArg, args);
  }

  emitDestroy() {
    if (this._destroyed) return this;
    this._destroyed = true;
    const resource = resources.get(this._asyncId);
    if (resource) resource.destroyed = true;
    emit('destroy', this._asyncId);
    contexts.delete(this._asyncId);
    return this;
  }

  bind(callback, thisArg = this) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    return (...args) => this.runInAsyncScope(callback, thisArg, ...args);
  }

  static bind(callback, type, thisArg) {
    return new AsyncResource(type || callback?.name || 'bound-anonymous-fn').bind(callback, thisArg);
  }
}

export function createAsyncHooksModule() {
  return {
    createHook: (callbacks) => new AsyncHook(callbacks),
    executionAsyncId: () => executionId,
    triggerAsyncId: () => resources.get(executionId)?.triggerAsyncId ?? executionId,
    executionAsyncResource: () => resources.get(executionId)?.resource ?? rootResource,
    AsyncResource,
    asyncWrapProviders: Object.freeze({ __proto__: null }),
    AsyncLocalStorage: createAsyncLocalStorage(),
    cleanup() {
      for (const hook of [...hooks]) hook.disable();
      contexts.clear();
      resources.clear();
      nextAsyncId = 2;
      executionId = 1;
      resources.set(executionId, {
        type: 'ROOT',
        triggerAsyncId: 0,
        resource: rootResource,
        destroyed: false,
      });
      contexts.set(executionId, new Map());
    },
  };
}

function createAsyncLocalStorage() {
  installPromiseHooks();
  return class AsyncLocalStorage {
    constructor() {
      this._enabled = false;
    }

    disable() {
      this._enabled = false;
      for (const context of contexts.values()) context.delete(this);
    }

    getStore() {
      return this._enabled ? contexts.get(executionId)?.get(this) : undefined;
    }

    static bind(callback) {
      return AsyncResource.bind(callback);
    }

    static snapshot() {
      return this.bind((callback, ...args) => callback(...args));
    }

    enterWith(value) {
      this._enabled = true;
      const context = contexts.get(executionId) || new Map();
      context.set(this, value);
      contexts.set(executionId, context);
    }
    run(value, callback, ...args) {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      this._enabled = true;
      const context = contexts.get(executionId) || new Map();
      const previous = context.has(this) ? context.get(this) : undefined;
      const hadPrevious = context.has(this);
      const runAsyncId = executionId;
      context.set(this, value);
      contexts.set(executionId, context);
      const restore = () => {
        const currentContext = contexts.get(runAsyncId);
        if (!currentContext) return;
        if (hadPrevious) currentContext.set(this, previous);
        else currentContext.delete(this);
      };
      try {
        const result = Reflect.apply(callback, undefined, args);
        if (result !== null && (typeof result === 'object' || typeof result === 'function')
          && typeof result.then === 'function') {
          // Native async continuations do not invoke the patched Promise.then.
          // Keep this scope live until the callback's promise settles so an
          // await continuation can still read the store.
          const settled = Promise.resolve(result);
          originalThen.call(settled, restore, restore);
          return result;
        }
        restore();
        return result;
      } catch (error) {
        restore();
        throw error;
      }
    }

    exit(callback, ...args) {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      if (!this._enabled) return Reflect.apply(callback, undefined, args);

      const context = contexts.get(executionId) || new Map();
      const previous = context.has(this) ? context.get(this) : undefined;
      const hadPrevious = context.has(this);
      this._enabled = false;
      context.delete(this);
      contexts.set(executionId, context);
      try {
        return Reflect.apply(callback, undefined, args);
      } finally {
        this._enabled = true;
        if (hadPrevious) context.set(this, previous);
        else context.delete(this);
      }
    }
  };
}
