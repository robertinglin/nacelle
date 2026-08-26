const CONTEXT_MARKER = Symbol('browser-node-vm-context');
const GLOBAL_SHADOWS = Object.freeze(['process', 'Buffer']);
const CONTEXT_REALMS = new WeakMap();
const TYPED_ARRAY_NAMES = Object.freeze([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

function createContextEvaluator(scope) {
  const FunctionConstructor = scope.Function || Function;
  return FunctionConstructor('context', 'source', `
    with (context) {
      const globalThis = context;
      return eval(source);
    }
  `);
}

function contextObject(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('contextifiedObject must be an object');
  }
  return value;
}

function markContext(context) {
  Object.defineProperty(context, CONTEXT_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return context;
}

function createBrowserRealm(scope) {
  const document = scope?.document;
  if (!document || typeof document.createElement !== 'function') return null;

  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.src = 'about:blank';
  const parent = document.body || document.documentElement;
  if (!parent || typeof parent.append !== 'function') return null;
  parent.append(frame);

  const realm = frame.contentWindow;
  if (!realm || typeof realm.Function !== 'function') {
    frame.remove();
    return null;
  }

  return {
    evaluate: realm.Function('source', 'return eval(source);'),
    global: realm,
    nativeKeys: new Set(Reflect.ownKeys(realm)),
    managedKeys: new Set(),
  };
}

function isNativeBuffer(value, arrayBuffer, sharedArrayBuffer) {
  return value instanceof arrayBuffer
    || (typeof sharedArrayBuffer === 'function' && value instanceof sharedArrayBuffer);
}

function createForeignTypedArray(NativeTypedArray, ForeignArrayBuffer, NativeArrayBuffer, NativeSharedArrayBuffer) {
  return class ForeignTypedArray extends NativeTypedArray {
    constructor(value, byteOffset, length) {
      if (arguments.length === 0) {
        super(new ForeignArrayBuffer(0));
        return;
      }
      if (arguments.length === 1 && typeof value === 'number') {
        super(new ForeignArrayBuffer(value * NativeTypedArray.BYTES_PER_ELEMENT));
        return;
      }
      if (arguments.length === 1 && !isNativeBuffer(value, NativeArrayBuffer, NativeSharedArrayBuffer)) {
        const source = new NativeTypedArray(value);
        const buffer = new ForeignArrayBuffer(source.byteLength);
        super(buffer);
        this.set(source);
        return;
      }
      super(value, byteOffset, length);
    }
  };
}

function installSyntheticRealm(scope, context) {
  const NativeArrayBuffer = scope.ArrayBuffer;
  if (typeof NativeArrayBuffer !== 'function') return;

  class ForeignArrayBuffer extends NativeArrayBuffer {}
  const NativeSharedArrayBuffer = scope.SharedArrayBuffer;
  const ForeignSharedArrayBuffer = typeof NativeSharedArrayBuffer === 'function'
    ? class ForeignSharedArrayBuffer extends NativeSharedArrayBuffer {}
    : undefined;
  const constructors = {
    ArrayBuffer: ForeignArrayBuffer,
    ...(ForeignSharedArrayBuffer ? { SharedArrayBuffer: ForeignSharedArrayBuffer } : {}),
  };

  for (const name of TYPED_ARRAY_NAMES) {
    const NativeTypedArray = scope[name];
    if (typeof NativeTypedArray === 'function') {
      constructors[name] = createForeignTypedArray(
        NativeTypedArray,
        ForeignArrayBuffer,
        NativeArrayBuffer,
        NativeSharedArrayBuffer,
      );
    }
  }

  const NativeDataView = scope.DataView;
  if (typeof NativeDataView === 'function') {
    constructors.DataView = class ForeignDataView extends NativeDataView {};
  }

  for (const [name, constructor] of Object.entries(constructors)) {
    if (Object.prototype.hasOwnProperty.call(context, name)) continue;
    Object.defineProperty(context, name, {
      configurable: true,
      enumerable: false,
      value: constructor,
      writable: true,
    });
  }
}

function copyContextToRealm(context, realm, managedKeys) {
  for (const key of managedKeys) {
    if (key === 'globalThis' || key in context) continue;
    try { delete realm[key]; } catch { /* browser globals can be immutable */ }
  }
  for (const key of Reflect.ownKeys(context)) {
    if (key === CONTEXT_MARKER || key === 'globalThis') continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(context, key);
    if (!descriptor) continue;
    managedKeys.add(key);
    try {
      Object.defineProperty(realm, key, descriptor);
    } catch {
      try { realm[key] = context[key]; } catch { /* browser globals can be immutable */ }
    }
  }
}

function copyRealmToContext(context, realm, nativeKeys, managedKeys) {
  for (const key of Reflect.ownKeys(realm)) {
    if (key === 'globalThis' || (nativeKeys.has(key) && !managedKeys.has(key))) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(realm, key);
    if (!descriptor) continue;
    managedKeys.add(key);
    try {
      Object.defineProperty(context, key, descriptor);
    } catch {
      try { context[key] = realm[key]; } catch { /* preserve the realm result */ }
    }
  }
}

function shadowBrowserGlobals(context) {
  for (const name of GLOBAL_SHADOWS) {
    if (name in context) continue;
    Object.defineProperty(context, name, {
      configurable: true,
      enumerable: true,
      value: undefined,
      writable: true,
    });
  }
}

function timedOutScriptError(timeout) {
  const error = new Error(`Script execution timed out after ${timeout}ms`);
  error.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
  return error;
}

function isObviouslyUnbounded(source) {
  return /\bwhile\s*\(\s*true\s*\)/.test(source)
    || /\bfor\s*\(\s*;\s*;\s*\)/.test(source);
}

/** Create the browser-native subset of Node's vm module. */
export function createVmModule(scope = globalThis) {
  const evaluate = createContextEvaluator(scope);

  function createContext(sandbox = {}, options = {}) {
    const context = contextObject(sandbox);
    if (!context[CONTEXT_MARKER]) {
      markContext(context);
      const realm = createBrowserRealm(scope);
      if (!realm) installSyntheticRealm(scope, context);
      CONTEXT_REALMS.set(context, realm);
    }
    const realm = CONTEXT_REALMS.get(context);
    if (!('globalThis' in context)) context.globalThis = realm?.global || context;
    shadowBrowserGlobals(context);
    if (realm) copyContextToRealm(context, realm.global, realm.managedKeys);
    if (options.name !== undefined) context.__bnhContextName = String(options.name);
    return context;
  }

  function isContext(value) {
    return Boolean(value && value[CONTEXT_MARKER]);
  }

  function runInContext(code, contextifiedObject, options = {}) {
    const context = contextObject(contextifiedObject);
    if (!isContext(context)) throw new TypeError('contextifiedObject is not a vm.Context');
    const source = String(code);
    const timeout = Number(options.timeout || 0);
    if (timeout > 0 && isObviouslyUnbounded(source)) throw timedOutScriptError(timeout);
    const realm = CONTEXT_REALMS.get(context);
    if (!realm) return evaluate(context, source);
    copyContextToRealm(context, realm.global, realm.managedKeys);
    try {
      return realm.evaluate(source);
    } finally {
      copyRealmToContext(context, realm.global, realm.nativeKeys, realm.managedKeys);
    }
  }

  function runInNewContext(code, sandbox = {}, options = {}) {
    return runInContext(code, createContext(sandbox, options), options);
  }

  function runInThisContext(code) {
    return (scope.eval || eval)(String(code));
  }

  class Script {
    constructor(code, options = {}) {
      this.code = String(code);
      this.options = { ...options };
    }

    runInContext(contextifiedObject, options = {}) {
      return runInContext(this.code, contextifiedObject, { ...this.options, ...options });
    }

    runInNewContext(sandbox = {}, options = {}) {
      return runInNewContext(this.code, sandbox, { ...this.options, ...options });
    }

    runInThisContext(options = {}) {
      return runInThisContext(this.code, options);
    }
  }

  return Object.freeze({
    Script,
    createContext,
    createScript: (code, options) => new Script(code, options),
    isContext,
    runInContext,
    runInNewContext,
    runInThisContext,
  });
}
