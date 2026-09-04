let nextAsyncId = 2;
let executionId = 1;
let asyncContextGeneration = 0;
const hooks = new Set();
const resources = new Map();
const contexts = new Map();
const relatedAsyncIds = new Map();
const promiseIds = new WeakMap();
const promiseContexts = new WeakMap();
const promiseAwaitContexts = new WeakMap();
const promiseTargets = new WeakMap();
const asyncCompletionHandlers = new WeakMap();
const userContextMarker = Symbol('bnhUserContext');
const errorAsyncIds = new WeakMap();
const reportedRejections = new WeakSet();
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
let promiseRejectionObserver = null;
const handledPromises = new WeakSet();
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

export function setPromiseRejectionObserver(observer) {
  const previous = promiseRejectionObserver;
  promiseRejectionObserver = typeof observer === 'function' ? observer : null;
  return () => {
    if (promiseRejectionObserver === observer || promiseRejectionObserver === null) {
      promiseRejectionObserver = previous;
    }
  };
}

export function isPromiseHandled(promise) {
  return handledPromises.has(promise) || handledPromises.has(promiseTarget(promise));
}

function observePromiseRejection(promise, reason) {
  if (handledPromises.has(promise)) return;
  reportedRejections.add(promise);
  const target = promiseTarget(promise);
  if (target !== promise) reportedRejections.add(target);
  promiseRejectionObserver?.(promise, reason);
}

export function isPromiseRejectionReported(promise) {
  return reportedRejections.has(promise) || reportedRejections.has(promiseTarget(promise));
}

export function registerAsyncCompletion(promise, callback) {
  if (promise && typeof callback === 'function') {
    asyncCompletionHandlers.set(promise, callback);
    // A dynamic import may be consumed by native Promise reactions rather
    // than the transformed async-generator runner. Attach the lifecycle
    // release to the Promise settlement itself so both forms observe the
    // same completion boundary.
    // Observable promises are deliberately thenable proxies rather than
    // native Promise receivers. Use their underlying native target for the
    // internal settlement observer so the hook does not expose a brand error
    // to user code.
    originalThen.call(promiseTarget(promise),
      () => completeAsyncCompletion(promise),
      () => completeAsyncCompletion(promise));
  }
  return promise;
}

function completeAsyncCompletion(promise) {
  const callback = asyncCompletionHandlers.get(promise);
  if (!callback) return;
  asyncCompletionHandlers.delete(promise);
  callback();
}

export function runAsyncGenerator(generatorFunction, thisArg, args = [], taskTracker = null) {
  let asyncResult;
  let pendingCompletion;
  asyncResult = new Promise((resolve, reject) => {
    let iterator;
    try {
      iterator = Reflect.apply(generatorFunction, thisArg, args);
    } catch (error) {
      reject(error);
      return;
    }

    const advance = (method, value) => {
      let result;
      try {
        result = Reflect.apply(iterator[method], iterator, [value]);
      } catch (error) {
        reject(error);
        return;
      }
      if (result.done) {
        const completion = asyncCompletionHandlers.get(result.value);
        if (completion) {
          asyncCompletionHandlers.delete(result.value);
          if (asyncResult) asyncCompletionHandlers.set(asyncResult, completion);
          else pendingCompletion = completion;
        }
        resolve(result.value);
        return;
      }
      const yielded = result.value;
      const releaseYield = typeof taskTracker === 'function' ? taskTracker() : null;
      let yieldReleased = false;
      const completeYield = () => {
        if (yieldReleased) return;
        yieldReleased = true;
        releaseYield?.();
      };
      Promise.resolve(yielded).then(
        (nextValue) => {
          try {
            advance('next', nextValue);
            completeAsyncCompletion(yielded);
          } finally {
            completeYield();
          }
        },
        (error) => {
          try {
            advance('throw', error);
            completeAsyncCompletion(yielded);
          } finally {
            completeYield();
          }
        },
      );
    };

    advance('next', undefined);
  });
  if (pendingCompletion) asyncCompletionHandlers.set(asyncResult, pendingCompletion);
  return asyncResult;
}

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
  const resourceProcess = globalThis.__bnhActiveProcess || globalThis.process;
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
  const inherited = contexts.get(triggerAsyncId);
  if (inherited) {
    contexts.set(asyncId, new Map(inherited));
  }
  if (emitInitEvent) emit('init', asyncId, type, triggerAsyncId, resource);
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
  // Keep the promise's own snapshot instead of retaining the trigger resource's
  // mutable map. A later enterWith/run must not rewrite this promise's context.
  const promiseContext = contexts.get(asyncId);
  if (promiseContext) promiseContexts.set(promise, promiseContext);
  emit('promiseResolve', asyncId);
  return asyncId;
}

function promiseTarget(promise) {
  return promiseTargets.get(promise) || promise;
}

function observablePromise(promise) {
  if (promiseTargets.has(promise)) return promise;
  // A Proxy around a native Promise is still recognized as a branded Promise
  // by V8, which lets `await` bypass the observable `.then` property. Proxy an
  // ordinary promise-shaped object instead; it remains `instanceof Promise`
  // through the shared prototype, but `await` must invoke its `then` method.
  const target = Object.create(originalPromiseConstructor.prototype);
  Object.defineProperty(target, 'constructor', {
    configurable: true,
    value: globalThis.Promise,
  });
  Object.defineProperty(target, Symbol.toStringTag, {
    configurable: true,
    value: 'Promise',
  });
  const observable = new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (property === 'then') {
        const context = contexts.get(executionId);
        const pending = promiseAwaitContexts.get(observable) || [];
        pending.push({
          context: context ? new Map(context) : undefined,
          generation: asyncContextGeneration,
        });
        promiseAwaitContexts.set(observable, pending);
        promiseAwaitContexts.set(currentTarget, pending);
      }
      return Reflect.get(currentTarget, property, receiver);
    },
  });
  promiseTargets.set(observable, promise);
  return observable;
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
  // Destroyed records must leave the strong resources map or long promise
  // churn grows it to V8's 2^24 Map entry cap and newAsyncId throws
  // RangeError: Map maximum size exceeded.
  resources.delete(asyncId);
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

function runInScope(asyncId, callback, thisArg, args, nativeContinuation = false) {
  const generation = asyncContextGeneration;
  const previous = executionId;
  const previousUserCode = globalThis.__bnhUserCode;
  executionId = asyncId;
  globalThis.__bnhUserCode = true;
  let nativeContinuationActive = true;
  if (nativeContinuation && hostQueueMicrotask) {
    // Awaiting a thenable creates the browser's hidden promise reaction after
    // the resolver returns. Queue the context switch before invoking the
    // resolver so unrelated reactions already in the queue run in their own
    // context, then let the hidden await continuation run before restoring it.
    hostQueueMicrotask(() => {
      if (!nativeContinuationActive || generation !== asyncContextGeneration || !resources.has(asyncId)) return;
      executionId = asyncId;
      globalThis.__bnhUserCode = true;
    });
  }
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
    if (nativeContinuation && hostQueueMicrotask) {
      const restore = () => {
        if (!nativeContinuationActive) return;
        nativeContinuationActive = false;
        if (generation !== asyncContextGeneration) return;
        if (executionId === asyncId) {
          executionId = previous;
          if (previousUserCode === undefined) delete globalThis.__bnhUserCode;
          else globalThis.__bnhUserCode = previousUserCode;
        }
      };
      // The browser queues the await continuation while callback executes;
      // this restoration therefore lands immediately after that continuation.
      hostQueueMicrotask(restore);
      executionId = previous;
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
  return runInScope(asyncId, callback, undefined, []);
}

function runWithPromiseScope(promise, callback) {
  const asyncId = promiseIds.get(promise);
  if (asyncId === undefined) return callback();
  const promiseContext = promiseContexts.get(promise);
  if (promiseContext && promiseContext !== contexts.get(asyncId)) {
    const previousContext = contexts.get(asyncId);
    contexts.set(asyncId, promiseContext);
    try {
      return runInScope(asyncId, callback, undefined, []);
    } finally {
      if (previousContext) contexts.set(asyncId, previousContext);
      else contexts.delete(asyncId);
    }
  }
  return runInScope(asyncId, callback, undefined, []);
}

const taskHookTargets = new WeakMap();

// Harness-driven queues (MessagePort delivery, stream write completion) resume
// guest code from contexts the guest did not choose. Node models each
// delivered message as a MESSAGEPORT async resource and runs stream write
// callbacks in the initiating write's context; capture the current scope when
// the guest hands work to such a queue and restore it when the queue calls
// back, or scheduler loops that yield there (React's scheduler in Next dev)
// lose their AsyncLocalStorage store.
export function captureAsyncScope(type = 'ASYNCSCOPE') {
  return newAsyncId(type, executionId, null);
}

export function runInCapturedScope(asyncId, callback) {
  if (asyncId === undefined || asyncId === null) return callback();
  try {
    return runInScope(asyncId, callback, undefined, []);
  } finally {
    const record = resources.get(asyncId);
    if (record && !record.destroyed) {
      record.destroyed = true;
      queueDestroy(asyncId);
    }
  }
}

function wrapQueueMicrotask(target) {
  const wrapped = function patchedQueueMicrotask(callback) {
    if (typeof callback !== 'function' || !isUserCodeActive()) {
      return target.call(this, callback);
    }
    const resource = {};
    const triggerAsyncId = executionId;
    const asyncId = newAsyncId('Microtask', triggerAsyncId, resource);
    target.call(this, () => {
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
  };
  Object.defineProperty(wrapped, '__bnhWrappedQueueMicrotask', { value: target });
  return wrapped;
}

const queueMicrotaskScopes = new WeakSet();

function installTaskHooks(scope) {
  if (!scope) return;
  // The runtime timer facade already creates one AsyncResource for each
  // timeout, interval, and immediate. Wrapping those functions here would
  // emit duplicate Timeout nodes and corrupt trigger-graph ordering.
  //
  // One realm hosts many virtual children. Their lifecycles keep assigning
  // scope.queueMicrotask (per-child context bridges) and restoring timer
  // snapshots over it with Object.assign, so a one-time wrapper is silently
  // clobbered and guest microtasks lose their async context. Install an
  // accessor that wraps every future assignment instead.
  if (!queueMicrotaskScopes.has(scope)) {
    try {
      queueMicrotaskScopes.add(scope);
      let currentQueueMicrotask = wrapQueueMicrotask(scope.queueMicrotask);
      Object.defineProperty(scope, 'queueMicrotask', {
        configurable: true,
        get() { return currentQueueMicrotask; },
        set(nextQueueMicrotask) {
          currentQueueMicrotask = typeof nextQueueMicrotask === 'function'
            && !Object.prototype.hasOwnProperty.call(nextQueueMicrotask, '__bnhWrappedQueueMicrotask')
            ? wrapQueueMicrotask(nextQueueMicrotask)
            : nextQueueMicrotask;
        },
      });
      return;
    } catch {
      queueMicrotaskScopes.delete(scope);
    }
  }

  const originalQueueMicrotask = scope.queueMicrotask;
  if (typeof originalQueueMicrotask === 'function') {
    if (taskHookTargets.get(scope) === originalQueueMicrotask) return;
    taskHookTargets.set(scope, originalQueueMicrotask);
    scope.queueMicrotask = function patchedQueueMicrotask(callback) {
      if (typeof callback !== 'function' || !isUserCodeActive()) {
        return originalQueueMicrotask.call(this, callback);
      }
      const resource = {};
      const triggerAsyncId = executionId;
      const asyncId = newAsyncId('Microtask', triggerAsyncId, resource);
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
    if (typeof onRejected === 'function') handledPromises.add(this);
    const sourcePromise = promiseTarget(this);
    const knownAsyncId = promiseIds.get(this) ?? promiseIds.get(sourcePromise);
    const pendingAwaitContexts = promiseAwaitContexts.get(this)
      || promiseAwaitContexts.get(sourcePromise);
    const awaitContext = pendingAwaitContexts?.shift();
    if (pendingAwaitContexts?.length === 0) {
      promiseAwaitContexts.delete(this);
      promiseAwaitContexts.delete(sourcePromise);
    }
    if (knownAsyncId === undefined && !isUserCodeActive() && !awaitContext) {
      return originalThen.call(sourcePromise, onFulfilled, onRejected);
    }
    let triggerAsyncId = knownAsyncId || executionId;
    let asyncId;
    const nativeResolver = typeof onFulfilled === 'function'
      && String(onFulfilled).includes('[native code]');
    const fulfill = (...args) => {
      return typeof onFulfilled === 'function'
        ? runInScope(asyncId, onFulfilled, this, args, nativeResolver || Boolean(awaitContext))
        : args[0];
    };
    const reject = (...args) => {
      return typeof onRejected === 'function'
        ? runInScope(asyncId, onRejected, this, args)
        : (() => { throw args[0]; })();
    };
    let result;
    try {
      result = originalThen.call(sourcePromise, fulfill, reject);
    } catch (error) {
      throw error;
    }
    // The async resource belongs to the promise returned by then(), not the
    // source promise. A source promise may have multiple continuations.
    asyncId = newAsyncId('PROMISE', triggerAsyncId, result, true);
    promiseIds.set(result, asyncId);
    // Promise continuations inherit the context in which `then()` is
    // registered, even when the source promise was created in another scope.
    // The async hook trigger remains the source promise, but the store belongs
    // to the current execution context.
    const currentContext = contexts.get(executionId);
    const sourceContext = promiseContexts.get(this) || contexts.get(triggerAsyncId);
    const inheritedContext = awaitContext?.generation === asyncContextGeneration
      ? awaitContext.context || currentContext || sourceContext
      : currentContext || sourceContext;
    if (inheritedContext) {
      const context = new Map(inheritedContext);
      contexts.set(asyncId, context);
      promiseContexts.set(result, context);
    }
    emit('promiseResolve', asyncId);
    return inheritedContext ? observablePromise(result) : result;
  };
  Promise.resolve = function patchedResolve(value) {
    if (promiseTargets.has(value) && this === globalThis.Promise) return value;
    const result = Reflect.apply(originalResolve, this, [value]);
    const existingAsyncId = promiseIds.get(result);
    if (this === Promise && isUserCodeActive() && promiseContextSwitchPending
        && existingAsyncId === undefined) {
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
    } else if (this === Promise && isUserCodeActive()) {
      if (existingAsyncId === undefined) trackPromise(result);
      promiseContextSwitchPending = false;
    }
    return result;
  };
  Promise.reject = function patchedReject(reason) {
    const result = Reflect.apply(originalReject, this, [reason]);
    if (this === Promise) {
      if (isUserCodeActive()) {
        trackPromise(result);
      } else {
        promiseIds.set(result, executionId);
        const context = contexts.get(executionId);
        if (context) promiseContexts.set(result, context);
      }
    }
    observePromiseRejection(result, reason);
    return result;
  };
  if (isBrowserRealm && globalThis.Promise === originalPromiseConstructor) {
    // Async functions use the browser's intrinsic Promise constructor. A
    // wrapper that merely returns a native Promise is therefore invisible to
    // `await`: the continuation runs through the intrinsic promise path and
    // never reaches our patched `.then`. Promise subclasses are deliberately
    // treated as thenables by that path, so the patched method can restore the
    // resource that created the promise before invoking the continuation.
    function TrackedPromise(executor) {
      if (!new.target) throw new TypeError('Promises must be constructed via new');
      if (typeof executor !== 'function') throw new TypeError('Promise resolver is not a function');
      let resolvePromise;
      let rejectPromise;
      const target = new originalPromiseConstructor((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      const result = observablePromise(target);
      if (isUserCodeActive()) {
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
    Object.defineProperty(TrackedPromise, 'name', { value: 'Promise' });
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
  const inherited = contexts.get(record.triggerAsyncId);
  if (inherited) contexts.set(asyncId, new Map(inherited));
  emit('init', asyncId, record.type, record.triggerAsyncId, resource);
}

const internalAsyncScopes = [];

function internalEmitBefore(asyncId, triggerAsyncId) {
  const record = resources.get(asyncId);
  if (record?.destroyed) throw internalAsyncHookError();
  if (!record) {
    const trigger = triggerAsyncId ?? executionId;
    resources.set(asyncId, {
      type: 'Unknown',
      triggerAsyncId: trigger,
      resource: {},
      process: globalThis.process,
      destroyed: false,
    });
    const inherited = contexts.get(trigger);
    if (inherited) contexts.set(asyncId, new Map(inherited));
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
    return runInScope(this._asyncId, callback, thisArg, args);
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

export function createAsyncHooksModule(scope = globalThis) {
  installPromiseHooks();
  if (isBrowserRealm) installTaskHooks(scope);
  return {
    createHook: (callbacks) => new AsyncHook(callbacks),
    executionAsyncId: () => executionId,
    triggerAsyncId: () => resources.get(executionId)?.triggerAsyncId ?? executionId,
    executionAsyncResource: () => resourceValue(resources.get(executionId)) ?? rootResource,
    AsyncResource,
    asyncWrapProviders: ASYNC_WRAP_PROVIDERS,
    _bnhRunWithErrorScope: runWithErrorScope,
    _bnhRunWithPromiseScope: runWithPromiseScope,
    AsyncLocalStorage: createAsyncLocalStorage(scope),
    _bnhInstallTaskHooks: () => installTaskHooks(scope),
    internal: createInternalAsyncHooks(),
    cleanup() {
      for (const hook of [...hooks]) hook.disable();
      asyncContextGeneration += 1;
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

function createAsyncLocalStorage(scope) {
  installPromiseHooks();
  return class AsyncLocalStorage {
    constructor() {
      this._enabled = false;
      if (isBrowserRealm) installTaskHooks(scope);
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
      for (const [asyncId, context] of contexts) {
        const disabledContext = new Map(context);
        disabledContext.delete(this);
        contexts.set(asyncId, disabledContext);
      }
    }

    getStore() {
      if (!this._enabled) return undefined;
      const context = contexts.get(executionId);
      const value = context?.get(this);
      return value;
    }

    static bind(callback) {
      return AsyncResource.bind(callback);
    }

    static snapshot() {
      return this.bind((callback, ...args) => callback(...args));
    }

    enterWith(value) {
      this._enabled = true;
      const context = new Map(contexts.get(executionId) || []);
      context.set(this, value);
      context.set(userContextMarker, true);
      contexts.set(executionId, context);
    }
    run(value, callback, ...args) {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      this._enabled = true;
      const previousContext = contexts.get(executionId);
      const context = new Map(previousContext || []);
      const runAsyncId = executionId;
      context.set(this, value);
      context.set(userContextMarker, true);
      contexts.set(executionId, context);
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        if (previousContext) contexts.set(runAsyncId, previousContext);
        else contexts.delete(runAsyncId);
      };
      try {
        const result = Reflect.apply(callback, undefined, args);
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
      context.delete(this);
      contexts.set(executionId, context);
      try {
        return Reflect.apply(callback, undefined, args);
      } finally {
        contexts.set(executionId, previousContext);
      }
    }
  };
}
