function receivedType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an instance of Array';
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  return `type ${typeof value} (${String(value)})`;
}

function validateReference(value) {
  if ((typeof value === 'object' && value !== null && !Array.isArray(value)) || typeof value === 'function') return;
  const error = new TypeError(`The "obj" argument must be of type object. Received ${receivedType(value)}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  throw error;
}

function warnExperimental(processObject, method, warned) {
  if (warned.has(method)) return;
  warned.add(method);
  processObject.emitWarning?.(
    `process.finalization.${method} is an experimental feature and might change at any time`,
    { type: 'ExperimentalWarning' },
  );
}

/** Install Node's process.finalization lifecycle contract without host hooks. */
export function installProcessFinalization(processObject) {
  let finalization;
  let listenersInstalled = false;
  const warned = new Set();
  const registrations = {
    beforeExit: new Map(),
    exit: new Map(),
  };

  const invoke = (event) => {
    const current = registrations[event];
    for (const [ref, callbacks] of current) {
      current.delete(ref);
      for (const callback of callbacks) Reflect.apply(callback, undefined, [ref, event]);
    }
  };

  const installListeners = () => {
    if (listenersInstalled) return;
    listenersInstalled = true;
    processObject.once?.('beforeExit', () => invoke('beforeExit'));
    processObject.once?.('exit', () => invoke('exit'));
  };

  const register = (ref, callback, event) => {
    validateReference(ref);
    warnExperimental(processObject, event === 'beforeExit' ? 'registerBeforeExit' : 'register', warned);
    installListeners();
    const callbacks = registrations[event].get(ref) || [];
    callbacks.push(callback);
    registrations[event].set(ref, callbacks);
  };

  const unregister = (ref) => {
    registrations.beforeExit.delete(ref);
    registrations.exit.delete(ref);
  };

  const createFinalization = () => ({
    register(ref, callback) { register(ref, callback, 'exit'); },
    registerBeforeExit(ref, callback) { register(ref, callback, 'beforeExit'); },
    unregister,
  });

  Object.defineProperty(processObject, 'finalization', {
    configurable: true,
    enumerable: true,
    get() {
      finalization ||= createFinalization();
      return finalization;
    },
    set(value) {
      finalization = value;
    },
  });
  return processObject;
}
