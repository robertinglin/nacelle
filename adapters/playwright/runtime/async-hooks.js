let nextAsyncId = 2;
let executionId = 1;
const hooks = new Set();
const resources = new Map();
const contexts = new Map();
const relatedAsyncIds = new Map();
const promiseIds = new WeakMap();
const promiseContexts = new WeakMap();
const userContextMarker = Symbol('bnhUserContext');
const errorAsyncIds = new WeakMap();
const rootResource = {};
const asyncIdSymbol = Symbol('asyncId');
const triggerAsyncIdSymbol = Symbol('triggerId');
const initSymbol = Symbol('init');
const beforeSymbol = Symbol('before');
const afterSymbol = Symbol('after');
const destroySymbol = Symbol('destroy');
const promiseResolveSymbol = Symbol('promiseResolve');
export const ownerSymbol = Symbol('owner');
let hookDispatchDepth = 0;
let activeHookSnapshot = null;
const ASYNC_WRAP_PROVIDER_NAMES = [
  'NONE', 'DIRHANDLE', 'DNSCHANNEL', 'ELDHISTOGRAM', 'FILEHANDLE',
  'FILEHANDLECLOSEREQ', 'BLOBREADER', 'FSEVENTWRAP', 'FSREQCALLBACK',
  'FSREQPROMISE', 'GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP', 'HEAPSNAPSHOT',
  'HTTP2SESSION', 'HTTP2STREAM', 'HTTP2PING', 'HTTP2SETTINGS',
  'HTTPINCOMINGMESSAGE', 'HTTPCLIENTREQUEST', 'JSSTREAM', 'JSUDPWRAP',
  'MESSAGEPORT', 'PIPECONNECTWRAP', 'PIPESERVERWRAP', 'PIPEWRAP',
  'PROCESSWRAP', 'PROMISE', 'QUERYWRAP', 'QUIC_ENDPOINT', 'QUIC_LOGSTREAM',
  'QUIC_PACKET', 'QUIC_SESSION', 'QUIC_STREAM', 'QUIC_UDP', 'SHUTDOWNWRAP',
  'SIGNALWRAP', 'STATWATCHER', 'STREAMPIPE', 'TCPCONNECTWRAP',
  'TCPSERVERWRAP', 'TCPWRAP', 'TTYWRAP', 'UDPSENDWRAP', 'UDPWRAP',
  'SIGINTWATCHDOG', 'WORKER', 'WORKERCPUPROFILE', 'WORKERCPUUSAGE',
  'WORKERHEAPSNAPSHOT', 'WORKERHEAPSTATISTICS', 'WRITEWRAP', 'ZLIB',
  'CHECKPRIMEREQUEST', 'PBKDF2REQUEST', 'KEYPAIRGENREQUEST', 'KEYGENREQUEST',
  'KEYEXPORTREQUEST', 'CIPHERREQUEST', 'DERIVEBITSREQUEST', 'HASHREQUEST',
  'RANDOMBYTESREQUEST', 'RANDOMPRIMEREQUEST', 'SCRYPTREQUEST', 'SIGNREQUEST',
  'TLSWRAP', 'VERIFYREQUEST',
];
const asyncWrapProviders = Object.create(null);
for (const [index, name] of ASYNC_WRAP_PROVIDER_NAMES.entries()) {
  asyncWrapProviders[name] = index;
}
export const ASYNC_WRAP_PROVIDERS = Object.freeze(asyncWrapProviders);

function typeDescription(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      if (Object.is(value, -0)) return 'type number (-0)';
      return `type number (${value})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'string': {
      const short = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return short.includes("'")
        ? `type string (${JSON.stringify(short)})`
        : `type string ('${short}')`;
    }
    case 'function': return `function ${value.name || ''}`;
    case 'object': {
      if (Object.getPrototypeOf(value) === null) return '[Object: null prototype] {}';
      const constructorName = value.constructor?.name;
      return constructorName ? `an instance of ${constructorName}` : 'an instance of Object';
    }
    default: return `type ${typeof value} (${String(value)})`;
  }
}

function invalidArgumentType(name, expected, value) {
  const error = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${typeDescription(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidAsyncType(type) {
  const error = new TypeError(`Invalid name for async "type": ${type}`);
  error.code = 'ERR_ASYNC_TYPE';
  return error;
}

export class BrowserAsyncContextFrame extends Map {
  static enabled = false;

  static current() {}
  static set() {}
  static exchange() {}
  static disable() {}
}

const originalPromiseConstructor = Promise;
const originalThen = Promise.prototype.then;
const originalResolve = Promise.resolve;
const originalReject = Promise.reject;
const hostQueueMicrotask = typeof globalThis.queueMicrotask === 'function'
  ? globalThis.queueMicrotask.bind(globalThis)
  : null;
const hostSetTimeout = typeof globalThis.setTimeout === 'function'
  ? globalThis.setTimeout.bind(globalThis)
  : null;
let promisePatchInstalled = false;
// A destroy hook changes Node's promise-hook mode. Browsers do not expose
// that native transition, so defer the compatible boundary until user code
// creates its next resolved promise.
let promiseContextSwitchPending = false;
const pendingDestroyIds = new Set();
let destroyDrainScheduled = false;
let destroyDrainGeneration = 0;
const resourceFinalizer = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry((asyncId) => {
    const record = resources.get(asyncId);
    if (!record || record.destroyed) return;
    record.destroyed = true;
    queueDestroy(asyncId);
  })
  : null;

// Node gives queued destroy hooks a chance to run between long promise chains
// while still keeping them behind the current nextTick/microtask turn.
const DESTROY_DRAIN_MICROTASKS = 8192;

resources.set(executionId, {
  type: 'ROOT',
  triggerAsyncId: 0,
  resource: rootResource,
  process: globalThis.process,
  destroyed: false,
});
contexts.set(executionId, new Map());

function emit(name, ...args) {
  const currentProcess = globalThis.process;
  if (hookDispatchDepth === 0) activeHookSnapshot = [...hooks];
  hookDispatchDepth += 1;
  try {
    for (const hook of activeHookSnapshot) {
      if (hook.process !== currentProcess) continue;
      try {
        hook[name]?.(...args);
      } catch (error) {
        // A throwing hook terminates its Node process. Remove it before the
        // browser's virtual child can continue in the shared JavaScript realm.
        hooks.delete(hook);
        hook.enabled = false;
        throw error;
      }
    }
  } finally {
    hookDispatchDepth -= 1;
    if (hookDispatchDepth === 0) activeHookSnapshot = null;
  }
}

function newAsyncId(type, triggerAsyncId, resource, weakResource = false, collectOnExplicitGc = false, emitInitEvent = true) {
  const asyncId = nextAsyncId++;
  const resourceProcess = globalThis.process;
  const initObserved = emitInitEvent
    && [...hooks].some((hook) => hook.process === resourceProcess);
  const record = {
    type,
    triggerAsyncId,
    process: resourceProcess,
    destroyed: false,
    collectOnExplicitGc,
    initObserved,
  };
  if (weakResource && resource !== null && (typeof resource === 'object' || typeof resource === 'function')) {
    record.resource = new WeakRef(resource);
    resourceFinalizer?.register(resource, asyncId);
  } else {
    record.resource = resource;
  }
  resources.set(asyncId, record);
  if (emitInitEvent) emit('init', asyncId, type, triggerAsyncId, resource);
  const inherited = contexts.get(triggerAsyncId);
  if (inherited) contexts.set(asyncId, new Map(inherited));
  return asyncId;
}

function isUserCodeActive() {
  return globalThis.__bnhUserCode === true
    || contexts.get(executionId)?.has(userContextMarker) === true;
}

function trackPromise(promise, triggerAsyncId = executionId) {
  const knownAsyncId = promiseIds.get(promise);
  if (knownAsyncId !== undefined) return knownAsyncId;
  const asyncId = newAsyncId('PROMISE', triggerAsyncId, promise, true);
  promiseIds.set(promise, asyncId);
  const inheritedContext = contexts.get(triggerAsyncId);
  if (inheritedContext) promiseContexts.set(promise, inheritedContext);
  emit('promiseResolve', asyncId);
  return asyncId;
}

function withResourceProcess(asyncId, callback) {
  const resourceProcess = resources.get(asyncId)?.process;
  if (resourceProcess === undefined) return callback();
  const previousProcess = globalThis.process;
  globalThis.process = resourceProcess;
  try {
    return callback();
  } finally {
    globalThis.process = previousProcess;
  }
}

function drainDestroyedResources() {
  for (const asyncId of pendingDestroyIds) {
    pendingDestroyIds.delete(asyncId);
    destroyResource(asyncId);
  }
}

function destroyResource(asyncId) {
  const record = resources.get(asyncId);
  if (!record || !record.destroyed || record.destroyEmitted) return;
  record.destroyEmitted = true;
  const destroyObserved = record.initObserved;
  if (destroyObserved) withResourceProcess(asyncId, () => emit('destroy', asyncId));
  const relatedAsyncId = relatedAsyncIds.get(asyncId);
  if (relatedAsyncId !== undefined) {
    const relatedRecord = resources.get(relatedAsyncId);
    if (relatedRecord && !relatedRecord.destroyed) {
      relatedRecord.destroyed = true;
      queueDestroy(relatedAsyncId);
    }
  }
  contexts.delete(asyncId);
  relatedAsyncIds.delete(asyncId);
}

function resourceValue(record) {
  return record?.resource instanceof WeakRef ? record.resource.deref() : record?.resource;
}

function queueDestroy(asyncId) {
  pendingDestroyIds.add(asyncId);
  if (destroyDrainScheduled) return;
  destroyDrainScheduled = true;
  const generation = destroyDrainGeneration;
  let microtasks = 0;
  const advance = () => {
    if (generation !== destroyDrainGeneration) return;
    if (!pendingDestroyIds.size) {
      destroyDrainScheduled = false;
      return;
    }
    if (microtasks++ < DESTROY_DRAIN_MICROTASKS) {
      hostQueueMicrotask?.(advance);
      return;
    }
    drainDestroyedResources();
    destroyDrainScheduled = false;
  };
  if (hostQueueMicrotask) hostQueueMicrotask(advance);
  else if (hostSetTimeout) hostSetTimeout(advance, 0);
  else advance();
}

// The browser cannot expose a real V8 heap collection. Treat an explicit
// global.gc() request as the collection boundary for weak async resources.
export function collectAsyncResources() {
  for (const [asyncId, record] of resources) {
    if (!record.collectOnExplicitGc || record.destroyed) continue;
    record.destroyed = true;
    destroyResource(asyncId);
  }
}

function runInScope(asyncId, callback, thisArg, args, deferRestore = false, restoreAfterMicrotask = false) {
  const previous = executionId;
  const previousUserCode = globalThis.__bnhUserCode;
  executionId = asyncId;
  globalThis.__bnhUserCode = true;
  const record = resources.get(asyncId);
  const dispatchBefore = !record || record.initObserved || record.type === 'PROMISE';
  let dispatchAfter = dispatchBefore;
  const relatedAsyncId = relatedAsyncIds.get(asyncId);
  const lifecycleIds = relatedAsyncId === undefined ? [asyncId] : [asyncId, relatedAsyncId];
  try {
    return withResourceProcess(asyncId, () => {
      if (dispatchBefore) for (const lifecycleId of lifecycleIds) emit('before', lifecycleId);
      try {
        return Reflect.apply(callback, thisArg, args);
      } finally {
        // Node only reports the after event for a resource whose init was
        // observed by an enabled hook. A resource created before any hook was
        // enabled never had its init emitted, so it must not receive a
        // before/after pair either, even if a hook becomes enabled later.
        if (!dispatchAfter && record?.initObserved
            && [...hooks].some((hook) => hook.process === record?.process)) {
          dispatchAfter = true;
        }
        if (dispatchAfter) {
          for (const lifecycleId of [...lifecycleIds].reverse()) emit('after', lifecycleId);
        }
      }
    });
  } catch (error) {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      errorAsyncIds.set(error, asyncId);
    }
    throw error;
  } finally {
    if (restoreAfterMicrotask && hostQueueMicrotask) {
      hostQueueMicrotask(() => {
        if (executionId === asyncId) executionId = previous;
      });
    } else if (deferRestore && hostSetTimeout) {
      hostSetTimeout(() => {
        if (executionId === asyncId) executionId = previous;
      }, 0);
    } else {
      executionId = previous;
    }
    if (previousUserCode === undefined) delete globalThis.__bnhUserCode;
    else globalThis.__bnhUserCode = previousUserCode;
  }
}

function runWithErrorScope(error, callback) {
  const asyncId = error !== null && (typeof error === 'object' || typeof error === 'function')
    ? errorAsyncIds.get(error)
    : undefined;
  if (asyncId === undefined) return callback();
  return runInScope(asyncId, callback, undefined, [], true);
}

function runWithPromiseScope(promise, callback) {
  const asyncId = promiseIds.get(promise);
  if (asyncId === undefined) return callback();
  const promiseContext = promiseContexts.get(promise);
  if (promiseContext && promiseContext !== contexts.get(asyncId)) {
    const previousContext = contexts.get(asyncId);
    contexts.set(asyncId, promiseContext);
    try {
      return runInScope(asyncId, callback, undefined, [], true);
    } finally {
      const restore = () => {
        if (previousContext) contexts.set(asyncId, previousContext);
        else contexts.delete(asyncId);
      };
      if (hostSetTimeout) hostSetTimeout(restore, 0);
      else restore();
    }
  }
  return runInScope(asyncId, callback, undefined, [], true);
}

let taskHooksInstalled = false;

function installTaskHooks(scope) {
  if (taskHooksInstalled || !scope) return;
  taskHooksInstalled = true;
  // The runtime timer facade already creates one AsyncResource for each
  // timeout, interval, and immediate. Wrapping those functions here would
  // emit duplicate Timeout nodes and corrupt trigger-graph ordering.

  const originalQueueMicrotask = scope.queueMicrotask;
  if (typeof originalQueueMicrotask === 'function') {
    scope.queueMicrotask = function patchedQueueMicrotask(callback) {
      if (typeof callback !== 'function' || !isUserCodeActive()) {
        return originalQueueMicrotask.call(this, callback);
      }
      const resource = {};
      const triggerAsyncId = executionId;
      let asyncId;
      originalQueueMicrotask.call(this, () => {
        try {
          return runInScope(asyncId, callback, this, []);
        } finally {
          const record = resources.get(asyncId);
          if (record) {
            record.destroyed = true;
            queueDestroy(asyncId);
          }
        }
      });
      asyncId = newAsyncId('Microtask', triggerAsyncId, resource);
    };
  }

}

// Avoid changing host timers when this adapter module is imported by
// Playwright's Node-side test runner. Browser workers install task hooks when
// user async context tracking is requested, after runtime bookkeeping has
// captured its host timers.
const isBrowserRealm = (typeof window !== 'undefined' && window === globalThis)
  || (typeof self !== 'undefined' && self === globalThis);

function installPromiseHooks() {
  if (promisePatchInstalled) return;
  promisePatchInstalled = true;
  Promise.prototype.then = function patchedThen(onFulfilled, onRejected) {
    const knownAsyncId = promiseIds.get(this);
    if (knownAsyncId === undefined && !isUserCodeActive()) {
      return originalThen.call(this, onFulfilled, onRejected);
    }
    let triggerAsyncId = knownAsyncId || executionId;
    let asyncId;
    const fulfill = typeof onFulfilled === 'function'
      ? (...args) => runInScope(asyncId, onFulfilled, this, args)
      : onFulfilled;
    const reject = typeof onRejected === 'function'
      ? (...args) => runInScope(asyncId, onRejected, this, args)
      : onRejected;
    const result = originalThen.call(this, fulfill, reject);
    // The async resource belongs to the promise returned by then(), not the
    // source promise. A source promise may have multiple continuations.
    asyncId = newAsyncId('PROMISE', triggerAsyncId, result, true);
    promiseIds.set(result, asyncId);
    const inheritedContext = promiseContexts.get(this) || contexts.get(triggerAsyncId);
    if (inheritedContext) promiseContexts.set(result, inheritedContext);
    emit('promiseResolve', asyncId);
    return result;
  };
  Promise.resolve = function patchedResolve(value) {
    const result = Reflect.apply(originalResolve, this, [value]);
    const existingAsyncId = promiseIds.get(result);
    if (this === Promise && isUserCodeActive() && promiseContextSwitchPending
        && hooks.size > 0 && existingAsyncId === undefined) {
      // Native async functions hide their outer promise from the browser shim.
      // Recreate the two visible promise boundaries before native assimilation
      // supplies the continuation boundary through patchedThen.
      const promiseAsyncId = newAsyncId('PROMISE', executionId, result, true);
      const awaitedAsyncId = newAsyncId('PROMISE', promiseAsyncId, { promise: result }, true);
      promiseIds.set(result, awaitedAsyncId);
      emit('promiseResolve', promiseAsyncId);
      emit('promiseResolve', awaitedAsyncId);
      runInScope(promiseAsyncId, () => {}, undefined, []);
      promiseContextSwitchPending = false;
    } else if (this === Promise && isUserCodeActive() && hooks.size > 0) {
      if (existingAsyncId === undefined) trackPromise(result);
      promiseContextSwitchPending = false;
    }
    return result;
  };
  Promise.reject = function patchedReject(reason) {
    const result = Reflect.apply(originalReject, this, [reason]);
    if (this === Promise) {
      if (isUserCodeActive() && hooks.size > 0) {
        trackPromise(result);
      } else {
        promiseIds.set(result, executionId);
        const context = contexts.get(executionId);
        if (context) promiseContexts.set(result, context);
      }
    }
    return result;
  };
  if (isBrowserRealm && globalThis.Promise === originalPromiseConstructor) {
    function TrackedPromise(executor) {
      if (!new.target) throw new TypeError('Promises must be constructed via new');
      if (typeof executor !== 'function') throw new TypeError('Promise resolver is not a function');
      let resolvePromise;
      let rejectPromise;
      const result = new originalPromiseConstructor((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      if (isUserCodeActive() && hooks.size > 0
          && (!promiseContextSwitchPending || hooks.size === 1)) {
        trackPromise(result);
      }
      try {
        executor(resolvePromise, rejectPromise);
      } catch (error) {
        rejectPromise(error);
      }
      return result;
    }
    TrackedPromise.prototype = originalPromiseConstructor.prototype;
    Object.setPrototypeOf(TrackedPromise, originalPromiseConstructor);
    globalThis.Promise = TrackedPromise;
  }
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
    this.process = globalThis.process;
    this.enabled = false;
  }

  enable() {
    if (!this.enabled) {
      this.enabled = true;
      hooks.add(this);
      installPromiseHooks();
      // Native async functions use an intrinsic promise continuation that is
      // not observable through the patched Promise.prototype.then. Mark the
      // next user promise boundary so Promise.resolve can recreate the
      // visible async resource chain even for hooks that only observe init.
      promiseContextSwitchPending = true;
      if (isBrowserRealm) installTaskHooks(globalThis);
    }
    return this;
  }

  disable() {
    this.enabled = false;
    hooks.delete(this);
    return this;
  }
}

function internalAsyncHookError() {
  return new Error('async hook stack has become corrupted');
}

function internalNewAsyncId() {
  return newAsyncId(undefined, executionId, undefined, false, false, false);
}

function internalGetDefaultTriggerAsyncId() {
  return executionId;
}

function internalEmitInit(asyncId, type, triggerAsyncId, resource) {
  const record = resources.get(asyncId) || {
    type,
    triggerAsyncId,
    resource,
    process: globalThis.process,
    destroyed: false,
  };
  record.type = type;
  record.triggerAsyncId = triggerAsyncId === null ? internalGetDefaultTriggerAsyncId() : triggerAsyncId;
  record.resource = resource;
  record.destroyed = false;
  record.destroyEmitted = false;
  resources.set(asyncId, record);
  emit('init', asyncId, record.type, record.triggerAsyncId, resource);
}

const internalAsyncScopes = [];

function internalEmitBefore(asyncId, triggerAsyncId) {
  const record = resources.get(asyncId);
  if (record?.destroyed) throw internalAsyncHookError();
  if (!record) {
    resources.set(asyncId, {
      type: 'Unknown',
      triggerAsyncId: triggerAsyncId ?? executionId,
      resource: {},
      process: globalThis.process,
      destroyed: false,
    });
  }
  const previous = executionId;
  executionId = asyncId;
  internalAsyncScopes.push({ asyncId, previous });
  try {
    emit('before', asyncId);
  } catch (error) {
    internalAsyncScopes.pop();
    executionId = previous;
    throw error;
  }
}

function internalEmitAfter(asyncId) {
  const record = resources.get(asyncId);
  const scope = internalAsyncScopes.at(-1);
  if (record?.destroyed || !scope || scope.asyncId !== asyncId) throw internalAsyncHookError();
  emit('after', asyncId);
  internalAsyncScopes.pop();
  executionId = scope.previous;
}

function internalEmitDestroy(asyncId) {
  const record = resources.get(asyncId);
  if (!record || record.destroyed) return;
  record.destroyed = true;
  queueDestroy(asyncId);
}

function initHooksExist() {
  for (const hook of hooks) {
    if (hook.process === globalThis.process && typeof hook.init === 'function') return true;
  }
  return false;
}

function enabledHooksExist() {
  for (const hook of hooks) {
    if (hook.process === globalThis.process) return true;
  }
  return false;
}

function createInternalAsyncHooks() {
  return Object.freeze({
    newAsyncId: internalNewAsyncId,
    getDefaultTriggerAsyncId: internalGetDefaultTriggerAsyncId,
    emitInit: internalEmitInit,
    emitBefore: internalEmitBefore,
    emitAfter: internalEmitAfter,
    emitDestroy: internalEmitDestroy,
    initHooksExist,
    defaultTriggerAsyncIdScope: (_triggerAsyncId, callback, ...args) => Reflect.apply(callback, undefined, args),
    executionAsyncId: () => executionId,
    triggerAsyncId: () => resources.get(executionId)?.triggerAsyncId ?? executionId,
    symbols: Object.freeze({
      async_id_symbol: asyncIdSymbol,
      trigger_async_id_symbol: triggerAsyncIdSymbol,
      init_symbol: initSymbol,
      before_symbol: beforeSymbol,
      after_symbol: afterSymbol,
      destroy_symbol: destroySymbol,
      promise_resolve_symbol: promiseResolveSymbol,
      owner_symbol: ownerSymbol,
    }),
  });
}

export class AsyncResource {
  constructor(type, options = {}) {
    if (typeof type !== 'string') throw invalidArgumentType('type', 'string', type);
    const triggerAsyncId = typeof options === 'number'
      ? options
      : options?.triggerAsyncId !== undefined ? options.triggerAsyncId : executionId;
    if (!Number.isSafeInteger(triggerAsyncId) || triggerAsyncId < -1) {
      const error = new RangeError(`invalid async id: ${triggerAsyncId}`);
      error.code = 'ERR_INVALID_ASYNC_ID';
      throw error;
    }
    if (initHooksExist() && enabledHooksExist() && type.length === 0) {
      throw invalidAsyncType(type);
    }
    this._asyncId = newAsyncId(type, triggerAsyncId, this, true, true);
    this._type = type;
    // Browser DNS uses one GETADDRINFOREQWRAP for both lookup and c-ares-like
    // resolve calls. Preserve the visible Node QUERYWRAP boundary without
    // changing the underlying browser DNS operation or its public request id.
    if (type === 'GETADDRINFOREQWRAP') {
      const queryWrapId = newAsyncId('QUERYWRAP', triggerAsyncId, {}, true, true);
      relatedAsyncIds.set(this._asyncId, queryWrapId);
      relatedAsyncIds.set(queryWrapId, this._asyncId);
    }
    this._triggerAsyncId = triggerAsyncId;
    this._destroyed = false;
  }

  asyncId() { return this._asyncId; }
  triggerAsyncId() { return this._triggerAsyncId; }

  runInAsyncScope(callback, thisArg, ...args) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const retainTaskResource = this._type === 'Timeout'
      || this._type === 'Interval'
      || this._type === 'Immediate'
      || this._type === 'TickObject'
      || this._type === 'Microtask';
    return runInScope(this._asyncId, callback, thisArg, args, false, retainTaskResource);
  }

  emitDestroy() {
    if (this._destroyed) return this;
    this._destroyed = true;
    const resource = resources.get(this._asyncId);
    if (resource) {
      resource.destroyed = true;
      if (resource.type === 'FSREQCALLBACK') {
        destroyResource(this._asyncId);
        return this;
      }
      queueDestroy(this._asyncId);
      const relatedAsyncId = relatedAsyncIds.get(this._asyncId);
      const relatedResource = resources.get(relatedAsyncId);
      if (relatedResource) {
        relatedResource.destroyed = true;
        queueDestroy(relatedAsyncId);
      }
    }
    return this;
  }

  bind(callback, thisArg) {
    if (typeof callback !== 'function') throw invalidArgumentType('fn', 'Function', callback);
    const bound = function boundAsyncResource(...args) {
      const receiver = thisArg === undefined ? this : thisArg;
      return thisResource.runInAsyncScope(callback, receiver, ...args);
    };
    const thisResource = this;
    Object.defineProperty(bound, 'asyncResource', { configurable: true, value: thisResource });
    Object.defineProperty(bound, 'length', { configurable: true, value: callback.length });
    return bound;
  }

  static bind(callback, type, thisArg) {
    return new AsyncResource(type || callback.name || 'bound-anonymous-fn').bind(callback, thisArg);
  }
}

export function createAsyncHooksModule() {
  installPromiseHooks();
  return {
    createHook: (callbacks) => new AsyncHook(callbacks),
    executionAsyncId: () => executionId,
    triggerAsyncId: () => resources.get(executionId)?.triggerAsyncId ?? executionId,
    executionAsyncResource: () => resourceValue(resources.get(executionId)) ?? rootResource,
    AsyncResource,
    asyncWrapProviders: ASYNC_WRAP_PROVIDERS,
    _bnhRunWithErrorScope: runWithErrorScope,
    _bnhRunWithPromiseScope: runWithPromiseScope,
    AsyncLocalStorage: createAsyncLocalStorage(),
    internal: createInternalAsyncHooks(),
    cleanup() {
      for (const hook of [...hooks]) hook.disable();
      destroyDrainGeneration += 1;
      destroyDrainScheduled = false;
      promiseContextSwitchPending = false;
      pendingDestroyIds.clear();
      internalAsyncScopes.length = 0;
      hookDispatchDepth = 0;
      activeHookSnapshot = null;
      contexts.clear();
      resources.clear();
      relatedAsyncIds.clear();
      nextAsyncId = 2;
      executionId = 1;
      resources.set(executionId, {
        type: 'ROOT',
        triggerAsyncId: 0,
        resource: rootResource,
        process: globalThis.process,
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
      if (isBrowserRealm) installTaskHooks(globalThis);
    }

    _enable() {
      if (!this._enabled) this._enabled = true;
    }

    _propagate(resource, triggerResource, type) {
      if (!this._enabled) return;
      let resourceAsyncId;
      let triggerAsyncId;
      for (const [asyncId, record] of resources) {
        const value = resourceValue(record);
        if (value === resource) resourceAsyncId = asyncId;
        if (value === triggerResource) triggerAsyncId = asyncId;
        if (resourceAsyncId !== undefined && triggerAsyncId !== undefined) break;
      }
      if (resourceAsyncId === undefined || triggerAsyncId === undefined) return;
      const triggerContext = contexts.get(triggerAsyncId);
      const context = contexts.get(resourceAsyncId) || new Map();
      context.set(this, triggerContext?.get(this));
      contexts.set(resourceAsyncId, context);
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
      context.set(userContextMarker, true);
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
      context.set(userContextMarker, true);
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
          const settled = originalThen.call(result, restore);
          promiseIds.set(result, runAsyncId);
          promiseIds.set(settled, runAsyncId);
          promiseContexts.set(result, context);
          promiseContexts.set(settled, context);
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

      const previousContext = contexts.get(executionId) || new Map();
      const context = new Map(previousContext);
      const previous = context.has(this) ? context.get(this) : undefined;
      const hadPrevious = context.has(this);
      this._enabled = false;
      context.delete(this);
      contexts.set(executionId, context);
      try {
        return Reflect.apply(callback, undefined, args);
      } finally {
        this._enabled = true;
        contexts.set(executionId, previousContext);
        if (hadPrevious) previousContext.set(this, previous);
        else previousContext.delete(this);
      }
    }
  };
}
