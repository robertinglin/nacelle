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
const errorAsyncResources = new WeakMap();
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
const arrayPop = Function.call.bind(Array.prototype.pop);
const arrayPush = Function.call.bind(Array.prototype.push);
const arrayShift = Function.call.bind(Array.prototype.shift);

function currentProcess() {
  return globalThis.__bnhActiveProcess || globalThis.process;
}
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
const originalAll = Promise.all;
const hostQueueMicrotask = typeof globalThis.queueMicrotask === 'function'
  ? globalThis.queueMicrotask.bind(globalThis)
  : null;
const hostSetTimeout = typeof globalThis.setTimeout === 'function'
  ? globalThis.setTimeout.bind(globalThis)
  : null;
let promisePatchInstalled = false;
let trackedPromiseConstructor;
let promiseRejectionObserver = null;
let promiseRejectionHandledObserver = null;
const handledPromises = new WeakSet();
// A destroy hook changes Node's promise-hook mode. Browsers do not expose
// that native transition, so defer the compatible boundary until user code
// creates its next resolved promise.
let promiseContextSwitchPending = false;
const pendingDestroyIds = new Set();
const pendingNonPromiseDestroyIds = new Set();
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

export function setPromiseRejectionHandledObserver(observer) {
  const previous = promiseRejectionHandledObserver;
  promiseRejectionHandledObserver = typeof observer === 'function' ? observer : null;
  return () => {
    if (promiseRejectionHandledObserver === observer || promiseRejectionHandledObserver === null) {
      promiseRejectionHandledObserver = previous;
    }
  };
}

export function isPromiseHandled(promise) {
  return handledPromises.has(promise) || handledPromises.has(promiseTarget(promise));
}

export function promiseProcess(promise) {
  if (!promise) return undefined;
  const target = promiseTarget(promise);
  const asyncId = promiseIds.get(promise) ?? promiseIds.get(target);
  return asyncId === undefined ? undefined : resources.get(asyncId)?.process;
}

export function markPromiseHandled(promise) {
  if (!promise) return;
  const target = promiseTarget(promise);
  handledPromises.add(promise);
  if (target !== promise) handledPromises.add(target);
  promiseRejectionHandledObserver?.(promise, target);
}

function markPromiseCollectionInputs(values) {
  const items = Array.from(values);
  for (const item of items) {
    const target = promiseTarget(item);
    if (!promiseIds.has(item) && !promiseIds.has(target)) continue;
    markPromiseHandled(item);
    // Native Promise collection methods bypass the patched `.then` method.
    // Attach a no-op rejection branch so the browser's native tracker sees
    // the same consumption that Node's Promise.all does.
    originalThen.call(target, undefined, () => {});
  }
  return items;
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
    const target = promiseTarget(promise);
    const onSettled = () => completeAsyncCompletion(promise);
    if (target === promise) {
      // A promise may have crossed a separately evaluated runtime module and
      // therefore not be present in this module's WeakMap. Its public then
      // method is still the safe boundary for an observable proxy.
      target.then(onSettled, onSettled);
    } else {
      originalThen.call(target, onSettled, onSettled);
    }
  }
  return promise;
}

function completeAsyncCompletion(promise) {
  const callback = asyncCompletionHandlers.get(promise);
  if (!callback) return;
  asyncCompletionHandlers.delete(promise);
  callback();
}

function observeProcessExit(promise, error) {
  if (!promise || error?.[Symbol.for('bnh.process-exit')] !== true) return;
  // Firefox workers can report rejected exit sentinels without dispatching
  // unhandledrejection. Observe that rejection without changing its value.
  originalThen.call(promiseTarget(promise), undefined, () => {});
}

export function runAsyncGenerator(generatorFunction, thisArg, args = []) {
  let asyncResult;
  let pendingCompletion;
  let initialError;
  asyncResult = new Promise((resolve, reject) => {
    let iterator;
    try {
      iterator = Reflect.apply(generatorFunction, thisArg, args);
    } catch (error) {
      initialError = error;
      reject(error);
      observeProcessExit(asyncResult, error);
      return;
    }

    const advance = (method, value) => {
      let result;
      try {
        result = Reflect.apply(iterator[method], iterator, [value]);
      } catch (error) {
        initialError = error;
        reject(error);
        observeProcessExit(asyncResult, error);
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
      Promise.resolve(yielded).then(
        (nextValue) => {
          advance('next', nextValue);
          completeAsyncCompletion(yielded);
        },
        (error) => {
          advance('throw', error);
          completeAsyncCompletion(yielded);
        });
    };

    advance('next', undefined);
  });
  observeProcessExit(asyncResult, initialError);
  if (pendingCompletion) asyncCompletionHandlers.set(asyncResult, pendingCompletion);
  return asyncResult;
}

// Node gives queued destroy hooks a chance to run between long promise chains
// while still keeping them behind the current nextTick/microtask turn. Promise
// churn needs a larger window to avoid adding a microtask per continuation;
// non-Promise resources need a bounded window so a large timer batch cannot
// starve its next real timer indefinitely in a browser worker.
const PROMISE_DESTROY_DRAIN_MICROTASKS = 8192;
const RESOURCE_DESTROY_DRAIN_MICROTASKS = 64;

resources.set(executionId, {
  type: 'ROOT',
  triggerAsyncId: 0,
  resource: rootResource,
  process: currentProcess(),
  destroyed: false,
});
contexts.set(executionId, new Map());

function emit(name, ...args) {
  const process = currentProcess();
  if (hookDispatchDepth === 0) activeHookSnapshot = [...hooks];
  hookDispatchDepth += 1;
  try {
    for (const hook of activeHookSnapshot) {
      if (hook.process !== process) continue;
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
  const resourceProcess = currentProcess();
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
    // Constructing a WeakRef keeps its target alive until the job ends. Long
    // promise chains can therefore retain an entire compiler's intermediates.
    // Promise callbacks supply their live resource when entering the scope.
    if (type !== 'PROMISE') record.resource = new WeakRef(resource);
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

export function trackPromise(promise, triggerAsyncId = executionId) {
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

export function observablePromise(promise, options = {}) {
  if (promiseTargets.has(promise)) return promise;
  // A Proxy around a native Promise is still recognized as a branded Promise
  // by V8, which lets `await` bypass the observable `.then` property. Proxy an
  // ordinary promise-shaped object instead; it remains `instanceof Promise`
  // through the shared prototype, but `await` must invoke its `then` method.
  // Firefox can still recognize that prototype-shaped object as a native
  // promise while evaluating a browser ESM module after the guest globals
  // have been restored. A forced thenable deliberately has no Promise
  // prototype, so native ESM must use the forwarding method below.
  const target = options.forceThenable
    ? Object.create(null)
    : Object.create(originalPromiseConstructor.prototype);
  if (!options.forceThenable) {
    Object.defineProperty(target, 'constructor', {
      configurable: true,
      value: globalThis.Promise,
    });
  }
  Object.defineProperty(target, Symbol.toStringTag, {
    configurable: true,
    value: 'Promise',
  });
  const observable = new Proxy(target, {
      get(currentTarget, property, receiver) {
        if (property === 'then') {
          const context = contexts.get(executionId);
          const pending = promiseAwaitContexts.get(observable) || [];
          arrayPush(pending, {
          context: context ? new Map(context) : undefined,
          generation: asyncContextGeneration,
          });
          promiseAwaitContexts.set(observable, pending);
          promiseAwaitContexts.set(currentTarget, pending);
          // The proxy target is intentionally not a native Promise. Return a
          // forwarding method rather than the native prototype method, whose
          // brand check would reject the proxy before it reaches the tracked
          // underlying promise.
          return (onFulfilled, onRejected) => {
            if (typeof onRejected === 'function') markPromiseHandled(observable);
            const patchedThen = globalThis.Promise?.prototype?.then;
            if (typeof patchedThen === 'function' && patchedThen !== originalThen) {
              return patchedThen.call(observable, onFulfilled, onRejected);
            }
            return originalThen.call(promise, onFulfilled, onRejected);
          };
        }
        if (property === 'catch') {
          return (onRejected) => {
            const patchedThen = globalThis.Promise?.prototype?.then;
            if (typeof patchedThen === 'function' && patchedThen !== originalThen) {
              return patchedThen.call(observable, undefined, onRejected);
            }
            return originalThen.call(promise, undefined, onRejected);
          };
        }
        if (property === 'finally') {
          return (onFinally) => {
            const callback = typeof onFinally === 'function' ? onFinally : () => onFinally;
            const fulfill = (value) => originalResolve.call(originalPromiseConstructor, callback()).then(() => value);
            const reject = (reason) => originalResolve.call(originalPromiseConstructor, callback()).then(() => {
              throw reason;
            });
            const patchedThen = globalThis.Promise?.prototype?.then;
            if (typeof patchedThen === 'function' && patchedThen !== originalThen) {
              return patchedThen.call(observable, fulfill, reject);
            }
            return originalThen.call(promise, fulfill, reject);
          };
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
  const previousActiveProcess = globalThis.__bnhActiveProcess;
  const previousProcess = globalThis.process;
  const previousConsole = globalThis.console;
  const previousGlobal = globalThis.global;
  const previousTimers = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate,
    queueMicrotask: globalThis.queueMicrotask,
  };
  let installedProcess = false;
  let installedConsole = false;
  let installedGlobal = false;
  // Async resources are created while this callback is active. Keep the
  // logical owner paired with the process context; otherwise a same-realm
  // child callback can create a Promise recorded for the parent and lose the
  // child's AsyncLocalStorage context on its next continuation. Keep the
  // public global process paired as well when the runtime owns a mutable
  // browser global; Node-targeted WASM shims read `globalThis.process`
  // directly instead of consulting the private marker.
  globalThis.__bnhActiveProcess = resourceProcess;
  if (resourceProcess !== previousProcess) {
    try {
      globalThis.process = resourceProcess;
      installedProcess = globalThis.process === resourceProcess;
    } catch {
      // Some browser hosts expose an immutable process alias. The private
      // marker above remains sufficient for runtime-owned surfaces there.
    }
  }
  // Promise reactions and other observed async resources do not pass
  // through the timer facade, so the timer callback's scope bridge cannot
  // install the child's remaining globals for them. Keep CommonJS callbacks
  // (which resolve bare `console`, `setTimeout`, and `global` dynamically)
  // on the resource owner's overlay for the duration of the callback too.
  if (resourceProcess?._bnhConsole && resourceProcess._bnhConsole !== previousConsole) {
    try {
      globalThis.console = resourceProcess._bnhConsole;
      installedConsole = globalThis.console === resourceProcess._bnhConsole;
    } catch {
      // Host globals may be immutable; the private process marker still
      // preserves ownership for runtime-owned surfaces.
    }
  }
  if (resourceProcess?._bnhGlobal && resourceProcess._bnhGlobal !== previousGlobal) {
    try {
      globalThis.global = resourceProcess._bnhGlobal;
      installedGlobal = globalThis.global === resourceProcess._bnhGlobal;
    } catch {
      // Best effort for browser hosts with an immutable global alias.
    }
  }
  const timerContext = resourceProcess?._bnhTimerContext;
  if (timerContext) {
    try { Object.assign(globalThis, timerContext); } catch { /* best effort */ }
  }
  try {
    return callback();
  } finally {
    if (timerContext) {
      try { Object.assign(globalThis, previousTimers); } catch { /* best effort */ }
    }
    if (installedGlobal) {
      try { globalThis.global = previousGlobal; } catch { /* best effort */ }
    }
    if (installedConsole) {
      try { globalThis.console = previousConsole; } catch { /* best effort */ }
    }
    if (installedProcess) {
      try { globalThis.process = previousProcess; } catch { /* immutable host alias */ }
    }
    if (previousActiveProcess === undefined) globalThis.__bnhActiveProcess = undefined;
    else globalThis.__bnhActiveProcess = previousActiveProcess;
  }
}

function drainDestroyedResources() {
  for (const asyncId of pendingDestroyIds) {
    pendingDestroyIds.delete(asyncId);
    pendingNonPromiseDestroyIds.delete(asyncId);
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
  if (resources.get(asyncId)?.type !== 'PROMISE') pendingNonPromiseDestroyIds.add(asyncId);
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
    const drainAfter = enabledHooksExist() || pendingNonPromiseDestroyIds.size > 0
      ? RESOURCE_DESTROY_DRAIN_MICROTASKS
      : PROMISE_DESTROY_DRAIN_MICROTASKS;
    if (microtasks++ < drainAfter) {
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

function runInScope(asyncId, callback, thisArg, args, nativeContinuation = false, liveResource) {
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
  const previousResource = record?.resource;
  if (record && liveResource !== undefined) record.resource = liveResource;
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
    observeProcessExit(liveResource, error);
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      errorAsyncIds.set(error, asyncId);
      if (record?.resource) errorAsyncResources.set(error, resourceValue(record));
    }
    throw error;
  } finally {
    if (nativeContinuation && hostQueueMicrotask) {
      const restore = () => {
        if (!nativeContinuationActive) return;
        nativeContinuationActive = false;
        if (record) record.resource = previousResource;
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
      if (record) record.resource = previousResource;
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
  return runInScope(asyncId, callback, undefined, [], false, errorAsyncResources.get(error));
}

function runWithPromiseScope(promise, callback) {
  const asyncId = promiseIds.get(promise);
  if (asyncId === undefined) return callback();
  const promiseContext = promiseContexts.get(promise);
  if (promiseContext && promiseContext !== contexts.get(asyncId)) {
    const previousContext = contexts.get(asyncId);
    contexts.set(asyncId, promiseContext);
    try {
      return runInScope(asyncId, callback, undefined, [], false, promiseTarget(promise));
    } finally {
      if (previousContext) contexts.set(asyncId, previousContext);
      else contexts.delete(asyncId);
    }
  }
  return runInScope(asyncId, callback, undefined, [], false, promiseTarget(promise));
}

function dispatchUncaughtProcessError(processObject, error) {
  if (typeof processObject?._bnhDispatchUncaughtException === 'function') {
    const handled = processObject._bnhDispatchUncaughtException(error);
    if (handled === true) return;
    // A same-realm virtual child has already notified its parent boundary and
    // must not rethrow into the owner's event loop. Root errors are recorded
    // by the dispatcher and terminate through the runtime process boundary.
    if (processObject._bnhVirtualChild === true
      || processObject._bnhUncaughtException === error
      || typeof processObject._bnhDispatchUncaughtException === 'function') return;
  }
  throw error;
}

export function dispatchUncaughtAsyncError(processObject, error) {
  return dispatchUncaughtProcessError(processObject, error);
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
    const processObject = resources.get(asyncId)?.process;
    target.call(this, () => {
      try {
        return runInScope(asyncId, callback, this, []);
      } catch (error) {
        dispatchUncaughtProcessError(processObject, error);
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
      const processObject = resources.get(asyncId)?.process;
      originalQueueMicrotask.call(this, () => {
        try {
          return runInScope(asyncId, callback, this, []);
        } catch (error) {
          dispatchUncaughtProcessError(processObject, error);
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
    const sourcePromise = promiseTarget(this);
    // Attaching any reaction consumes the source promise's rejection in Node;
    // a rejection that propagates through a missing `onRejected` handler is
    // reported on the promise returned by `then()`. Tracking only explicit
    // rejection callbacks reports the source too early for chains such as
    // yargs's handlerResult.then(...).catch(...).
    markPromiseHandled(this);
    const knownAsyncId = promiseIds.get(this) ?? promiseIds.get(sourcePromise);
    const pendingAwaitContexts = promiseAwaitContexts.get(this)
      || promiseAwaitContexts.get(sourcePromise);
    const awaitContext = pendingAwaitContexts && arrayShift(pendingAwaitContexts);
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
        ? runInScope(asyncId, onFulfilled, this, args, nativeResolver || Boolean(awaitContext), result)
        : args[0];
    };
    const reject = (...args) => {
      observeProcessExit(result, args[0]);
      if (typeof onRejected !== 'function') throw args[0];
      return runInScope(asyncId, onRejected, this, args, false, result);
    };
    let result;
    result = originalThen.call(sourcePromise, fulfill, reject);
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
    // Firefox's compatibility Promise is already a native-branded
    // thenable. Returning the additional plain-object proxy here makes a
    // later native Promise operation reject its receiver as an incompatible
    // Proxy; the guest constructor's own `.then` boundary still restores the
    // async context for this continuation.
    return inheritedContext && globalThis.__BNH_FIREFOX_PROMISE_BOUNDARY__ !== true
      ? observablePromise(result)
      : result;
  };
  // Native Promise.prototype.catch() does not call the replaceable `then`
  // property, so it would bypass the context bridge for an unwrapped native
  // promise returned by an async ESM module. Route it through the patched
  // method just as observablePromise.catch() does.
  Promise.prototype.catch = function patchedCatch(onRejected) {
    return Promise.prototype.then.call(this, undefined, onRejected);
  };
  Promise.resolve = function patchedResolve(value) {
    if (promiseTargets.has(value) && this === globalThis.Promise) return value;
    const result = Reflect.apply(originalResolve, this, [value]);
    const existingAsyncId = promiseIds.get(result);
    const isGlobalPromiseConstructor = this === Promise
      || (isBrowserRealm && this === globalThis.Promise);
    if (isGlobalPromiseConstructor && isUserCodeActive() && promiseContextSwitchPending
        && existingAsyncId === undefined) {
      // Native async functions hide their outer promise from the browser shim.
      // Recreate the two visible promise boundaries before native assimilation
      // supplies the continuation boundary through patchedThen.
      const promiseAsyncId = newAsyncId('PROMISE', executionId, result, true);
      const awaitedAsyncId = newAsyncId('PROMISE', promiseAsyncId, { promise: result }, true);
      promiseIds.set(result, awaitedAsyncId);
      emit('promiseResolve', promiseAsyncId);
      emit('promiseResolve', awaitedAsyncId);
      runInScope(promiseAsyncId, () => {}, undefined, [], false, result);
      promiseContextSwitchPending = false;
    } else if (isGlobalPromiseConstructor && isUserCodeActive()) {
      if (existingAsyncId === undefined) trackPromise(result);
      promiseContextSwitchPending = false;
    }
    const isFirefoxBrowser = isBrowserRealm && /Firefox\//.test(String(globalThis.navigator?.userAgent || ''));
    return isFirefoxBrowser && isGlobalPromiseConstructor && isUserCodeActive()
      ? observablePromise(result)
      : result;
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
    const isFirefoxBrowser = isBrowserRealm && /Firefox\//.test(String(globalThis.navigator?.userAgent || ''));
    return isFirefoxBrowser && isUserCodeActive() ? observablePromise(result) : result;
  };
  if (isBrowserRealm && typeof originalAll === 'function') {
    Promise.all = function patchedAll(values) {
      let items;
      try {
        items = markPromiseCollectionInputs(values);
      } catch {
        return Reflect.apply(originalAll, this, [values]);
      }
      return Reflect.apply(originalAll, this, [items]);
    };
  }
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
    trackedPromiseConstructor = TrackedPromise;
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
    this.process = currentProcess();
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
    process: currentProcess(),
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
      process: currentProcess(),
      destroyed: false,
    });
    const inherited = contexts.get(trigger);
    if (inherited) contexts.set(asyncId, new Map(inherited));
  }
  const previous = executionId;
  executionId = asyncId;
  arrayPush(internalAsyncScopes, { asyncId, previous });
  try {
    emit('before', asyncId);
  } catch (error) {
    arrayPop(internalAsyncScopes);
    executionId = previous;
    throw error;
  }
}

function internalEmitAfter(asyncId) {
  const record = resources.get(asyncId);
  const scope = internalAsyncScopes.at(-1);
  if (record?.destroyed || !scope || scope.asyncId !== asyncId) throw internalAsyncHookError();
  emit('after', asyncId);
  arrayPop(internalAsyncScopes);
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
    if (hook.process === currentProcess() && typeof hook.init === 'function') return true;
  }
  return false;
}

function enabledHooksExist() {
  for (const hook of hooks) {
    if (hook.process === currentProcess()) return true;
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
  _bnhProcess() { return resources.get(this._asyncId)?.process; }

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
      // No destroy hook can observe an unobserved resource. Releasing it
      // synchronously avoids paying the long promise-chain grace period for
      // high-volume timers (for example a cache with thousands of expirations)
      // while preserving deferred ordering for resources with hooks attached.
      if (!resource.initObserved) {
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
    _bnhIsUserCodeActive: () => isUserCodeActive(),
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
      pendingNonPromiseDestroyIds.clear();
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
        process: currentProcess(),
        destroyed: false,
      });
      contexts.set(executionId, new Map());
      // Promise hooks live on the shared browser realm, but their tracked
      // constructor belongs to one virtual execution. Restore only the
      // constructor at cleanup; the delegating prototype/static hooks must
      // remain installed so already-created tracked Promise proxies stay
      // awaitable after their owner exits.
      if (globalThis.Promise === trackedPromiseConstructor) {
        globalThis.Promise = originalPromiseConstructor;
        trackedPromiseConstructor = undefined;
        promisePatchInstalled = false;
      }
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
      let resourceAsyncId = promiseIds.get(resource);
      let triggerAsyncId = promiseIds.get(triggerResource);
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
