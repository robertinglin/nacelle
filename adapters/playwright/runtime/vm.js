const CONTEXT_MARKER = Symbol('browser-node-vm-context');
const MODULE_KIND = Symbol('browser-node-vm-module-kind');
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const VM_CONSTANTS = Object.freeze(Object.assign(Object.create(null), {
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol.for('nodejs.vm_dynamic_import_main_context_default'),
  DONT_CONTEXTIFY: Symbol.for('nodejs.vm_context_no_contextify'),
}));
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

function inspectModuleValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => !['globalThis', 'process', 'Buffer', '__bnhContextName'].includes(key));
    if (keys.length === 0) return '{}';
    return `{ ${keys.map((key) => `${key}: ${inspectModuleValue(value[key])}`).join(', ')} }`;
  }
  return String(value);
}

function inspectModule(module, name, depth) {
  if (module?.[MODULE_KIND] !== name) throw vmError('ERR_INVALID_THIS', 'Invalid this');
  if (typeof depth === 'number' && depth < 0) return `[${name}]`;
  return `${name} {\n  status: ${inspectModuleValue(module.status)},\n  identifier: ${inspectModuleValue(module.identifier)},\n  context: ${inspectModuleValue(module.context)}\n}`;
}

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
      enumerable: false,
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

function vmError(code, message, Type = Error) {
  const error = new Type(message);
  error.code = code;
  return error;
}

function receivedValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

function measureMemoryReceivedValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an instance of Array';
  if (typeof value === 'function') return 'function ';
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

function measureMemoryResult() {
  return { total: 0, current: 0, other: [] };
}

function markVmPromise(promise, state) {
  Object.defineProperty(promise, '__bnhInspect', {
    configurable: true,
    enumerable: true,
    value: `Promise { ${state} }`,
    writable: true,
  });
  return promise;
}

function parseModuleRequests(source) {
  const requests = [];
  const seen = new Set();
  const add = (specifier, attributes = {}) => {
    const key = `${specifier}\0${JSON.stringify(attributes)}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ specifier, attributes: Object.freeze({ ...attributes }) });
  };
  const importPattern = /\b(?:import|export)\s+(?:(?:[^'";]*?)\s+from\s+)?(['"])([^'"]+)\1(?:\s+with\s+\{([^}]*)\})?/g;
  const sideEffectPattern = /\bimport\s+(['"])([^'"]+)\1(?:\s+with\s+\{([^}]*)\})?/g;
  const parseAttributes = (text) => {
    const attributes = {};
    if (!text) return attributes;
    for (const match of text.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"])(.*?)\2/g)) attributes[match[1]] = match[3];
    return attributes;
  };
  for (const match of source.matchAll(importPattern)) add(match[2], parseAttributes(match[3]));
  for (const match of source.matchAll(sideEffectPattern)) add(match[2], parseAttributes(match[3]));
  return requests;
}

function splitModuleDeclaration(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function transformModuleSource(source) {
  let transformed = String(source).replace(/\bimport\.meta\b/g, '__bnhImportMeta');
  transformed = transformed.replace(/\bimport\s*\(/g, '__bnhDynamicImport(');
  transformed = transformed.replace(
    /\bimport\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*(?:with\s*\{[^}]*\})?\s*;?/g,
    (_, clause, quote, specifier) => {
      const dependency = `__bnhDeps[${JSON.stringify(specifier)}]`;
      const trimmed = clause.trim();
      const bind = (name, expression) => `Object.defineProperty(__bnhImportBindings, ${JSON.stringify(name)}, { configurable: true, get: () => ${expression} });`;
      if (trimmed.startsWith('*')) {
        return bind(trimmed.match(/\bas\s+([\w$]+)/)[1], dependency);
      }
      const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
      const declarations = [];
      if (parts[0] && !parts[0].startsWith('{')) declarations.push(bind(parts[0], `${dependency}.default`));
      const named = trimmed.match(/\{([\s\S]*)\}/)?.[1];
      if (named) {
        for (const item of named.split(',')) {
          const [exportName, localName] = item.trim().split(/\s+as\s+/);
          if (exportName) declarations.push(bind(localName || exportName, `${dependency}[${JSON.stringify(exportName)}]`));
        }
      }
      return declarations.join('\n');
    },
  );
  transformed = transformed.replace(
    /\bimport\s+(['"])([^'"]+)\1\s*(?:with\s*\{[^}]*\})?\s*;?/g,
    (_, quote, specifier) => `void __bnhDeps[${JSON.stringify(specifier)}];`,
  );
  const exports = [];
  transformed = transformed.replace(
    /\bexport\s+(const|let|var)\s+([^;\n]+)\s*;?/g,
    (_, declaration, body) => {
      for (const part of splitModuleDeclaration(body)) {
        const name = part.match(/^([A-Za-z_$][\w$]*)\s*=/)?.[1];
        if (name) exports.push([name, name]);
      }
      return `${declaration} ${body};`;
    },
  );
  transformed = transformed.replace(
    /\bexport\s+(function|class)\s+([A-Za-z_$][\w$]*)/g,
    (_, declaration, name) => { exports.push([name, name]); return `${declaration} ${name}`; },
  );
  transformed = transformed.replace(
    /\bexport\s+default\s+(async\s+)?function(?:\s+([A-Za-z_$][\w$]*))?/g,
    (_, asyncKeyword = '', name = '__bnhDefault') => {
      exports.push(['default', name]);
      return `${asyncKeyword}function ${name}`;
    },
  );
  transformed = transformed.replace(
    /\bexport\s+default\s+class(?:\s+([A-Za-z_$][\w$]*))?/g,
    (_, name = '__bnhDefault') => {
      exports.push(['default', name]);
      return `class ${name}`;
    },
  );
  transformed = transformed.replace(
    /\bexport\s+default\s+(?!function\b|class\b)([^;]+);?/g,
    (_, expression) => { exports.push(['default', `(${expression})`]); return ''; },
  );
  transformed = transformed.replace(
    /\bexport\s*\{([^}]+)\}\s*;?/g,
    (_, names) => names.split(',').map((item) => {
      const [local, exported] = item.trim().split(/\s+as\s+/);
      exports.push([exported || local, local]);
      return '';
    }).join('\n'),
  );
  transformed = transformed.replace(
    /\bexport\s+\*\s+from\s+(['"])([^'"]+)\1\s*;?/g,
    (_, quote, specifier) => `__bnhExportAll(__bnhDeps[${JSON.stringify(specifier)}]);`,
  );
  const assignments = exports.map(([name, expression]) => `__bnhSetExport(${JSON.stringify(name)}, ${expression});`).join('\n');
  return `${transformed}\n${assignments}`;
}

function moduleExportNames(source) {
  const names = new Set();
  for (const match of String(source).matchAll(/\bexport\s+(?:const|let|var)\s+([^;\n]+)/g)) {
    for (const part of splitModuleDeclaration(match[1])) {
      const name = part.match(/^([A-Za-z_$][\w$]*)\s*=/)?.[1];
      if (name) names.add(name);
    }
  }
  for (const match of String(source).matchAll(/\bexport\s+(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  if (/\bexport\s+default\b/.test(source)) names.add('default');
  for (const match of String(source).matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const item of match[1].split(',')) {
      const [, local, exported] = item.trim().match(/^([^\s]+)(?:\s+as\s+([^\s]+))?$/) || [];
      if (local) names.add(exported || local);
    }
  }
  return names;
}

/** Create the browser-native subset of Node's vm module. */
export function createVmModule(scope = globalThis) {
  const evaluate = createContextEvaluator(scope);
  const FunctionConstructor = scope.Function || Function;
  const moduleIds = new WeakMap();
  let measureMemoryWarned = false;

  const moduleIdentifier = (context) => {
    if (!moduleIds.has(context)) moduleIds.set(context, 0);
    const id = moduleIds.get(context);
    moduleIds.set(context, id + 1);
    return `vm:module(${id})`;
  };

  function createContext(sandbox = {}, options = {}) {
    const context = contextObject(sandbox);
    if (!context[CONTEXT_MARKER]) {
      markContext(context);
      const realm = createBrowserRealm(scope);
      if (!realm) installSyntheticRealm(scope, context);
      CONTEXT_REALMS.set(context, realm);
    }
    const realm = CONTEXT_REALMS.get(context);
    if (!('globalThis' in context)) {
      Object.defineProperty(context, 'globalThis', {
        configurable: true,
        enumerable: false,
        value: realm?.global || context,
        writable: true,
      });
    }
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
    const previousFilename = scope.__bnhVmFilename;
    scope.__bnhVmFilename = options.filename;
    try {
      if (!realm) return evaluate(context, source);
      copyContextToRealm(context, realm.global, realm.managedKeys);
      return realm.evaluate(source);
    } finally {
      if (previousFilename === undefined) delete scope.__bnhVmFilename;
      else scope.__bnhVmFilename = previousFilename;
      if (realm) copyRealmToContext(context, realm.global, realm.nativeKeys, realm.managedKeys);
    }
  }

  function runInNewContext(code, sandbox = {}, options = {}) {
    return runInContext(code, createContext(sandbox, options), options);
  }

  function runInThisContext(code) {
    return (scope.eval || eval)(String(code));
  }

  function compileFunction(code, params = [], options = {}) {
    if (!Array.isArray(params)) throw new TypeError('params must be an array');
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
    const source = String(code).replace(/\bimport\s*\(/g, '__bnhDynamicImport(');
    const compiled = FunctionConstructor('__bnhDynamicImport', ...params.map(String), source);
    let functionObject;
    functionObject = (...args) => {
      const dynamicImport = (specifier) => {
        if (typeof options.importModuleDynamically !== 'function') return Promise.reject(vmError('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'A dynamic import callback was not specified'));
        return Promise.resolve(options.importModuleDynamically(specifier, functionObject)).then((module) => module?.namespace || module);
      };
      return compiled(dynamicImport, ...args);
    };
    return functionObject;
  }

  function measureMemory(options = {}) {
    if (!measureMemoryWarned) {
      measureMemoryWarned = true;
      scope.process?.emitWarning?.(
        'vm.measureMemory is an experimental feature and might change at any time',
        { type: 'ExperimentalWarning' },
      );
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw vmError(
        'ERR_INVALID_ARG_TYPE',
        `The "options" argument must be of type object. Received ${measureMemoryReceivedValue(options)}`,
        TypeError,
      );
    }
    const mode = options.mode === undefined ? 'summary' : options.mode;
    const execution = options.execution === undefined ? 'default' : options.execution;
    if (mode !== 'summary' && mode !== 'detailed') {
      throw vmError(
        'ERR_INVALID_ARG_VALUE',
        `The property 'options.mode' must be one of: 'summary', 'detailed'. Received ${measureMemoryReceivedValue(mode)}`,
        TypeError,
      );
    }
    if (execution !== 'default' && execution !== 'eager') {
      throw vmError(
        'ERR_INVALID_ARG_VALUE',
        `The property 'options.execution' must be one of: 'default', 'eager'. Received ${measureMemoryReceivedValue(execution)}`,
        TypeError,
      );
    }
    return Promise.resolve(measureMemoryResult());
  }

  class Script {
    constructor(code, options = {}) {
      this.code = String(code);
      this.options = { ...options };
      FunctionConstructor(this.code);
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

  class SourceTextModule {
    constructor(sourceText, options = {}) {
      if (typeof sourceText !== 'string') throw vmError('ERR_INVALID_ARG_TYPE', 'The "code" argument must be of type string', TypeError);
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw vmError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object', TypeError);
      }
      if (options.identifier !== undefined && typeof options.identifier !== 'string') throw vmError('ERR_INVALID_ARG_TYPE', 'The "options.identifier" property must be of type string', TypeError);
      if (options.context !== undefined && !isContext(options.context)) throw vmError('ERR_INVALID_ARG_TYPE', 'The "options.context" property must be a vm.Context', TypeError);
      for (const name of ['initializeImportMeta', 'importModuleDynamically']) {
        if (options[name] !== undefined && typeof options[name] !== 'function') throw vmError('ERR_INVALID_ARG_TYPE', `The "options.${name}" property must be of type function`, TypeError);
      }
      this.sourceText = sourceText;
      this.options = { ...options };
      this._status = 'unlinked';
      this._error = undefined;
      this._dependencies = new Map();
      this._requests = parseModuleRequests(sourceText);
      this._namespace = Object.create(null);
      this._exportNames = moduleExportNames(sourceText);
      this._namespaceView = new Proxy(this._namespace, {
        get: (target, property, receiver) => {
          if (this._status === 'evaluating' && typeof property === 'string'
              && this._exportNames.has(property) && !Object.hasOwn(target, property)) {
            throw new ReferenceError(`Cannot access '${property}' before initialization`);
          }
          return Reflect.get(target, property, receiver);
        },
        set: () => false,
        defineProperty: () => false,
      });
      this._identifier = options.identifier || moduleIdentifier(options.context || scope);
      this._context = options.context;
      this._evaluation = null;
      this._moduleContext = null;
      this._dependencySpecifiers = Object.freeze(this._requests.map(({ specifier }) => specifier));
      Object.defineProperty(this, MODULE_KIND, { configurable: false, enumerable: false, value: 'SourceTextModule' });
    }

    get status() { return this._status; }
    get identifier() { return this._identifier; }
    get context() { return this._context; }
    get namespace() {
      if (this._status === 'unlinked' || this._status === 'linking') throw vmError('ERR_VM_MODULE_STATUS', 'Module status must not be unlinked or linking');
      return this._namespaceView;
    }
    get error() {
      if (this._status !== 'errored') throw vmError('ERR_VM_MODULE_STATUS', 'Module status must be errored');
      return this._error;
    }
    get moduleRequests() {
      return Object.freeze(this._requests.map(({ specifier, attributes }) => Object.freeze({
        __proto__: null,
        specifier,
        attributes: Object.freeze({ __proto__: null, ...attributes }),
      })));
    }
    get dependencySpecifiers() { return this._dependencySpecifiers; }
    [INSPECT_CUSTOM](depth) { return inspectModule(this, 'SourceTextModule', depth); }

    link(linker) {
      if (typeof linker !== 'function') return Promise.reject(vmError('ERR_INVALID_ARG_TYPE', 'The "linker" argument must be of type function', TypeError));
      if (this._status === 'linked' || this._status === 'evaluated') return Promise.reject(vmError('ERR_VM_MODULE_ALREADY_LINKED', 'Module has already been linked'));
      if (this._status !== 'unlinked') return Promise.reject(vmError('ERR_VM_MODULE_STATUS', 'Module status must be unlinked'));
      this._status = 'linking';
      return Promise.resolve().then(async () => {
        for (const request of this._requests) {
          const dependency = await linker(request.specifier, this);
          if (!(dependency instanceof SourceTextModule) && !(dependency instanceof SyntheticModule)) throw vmError('ERR_VM_MODULE_NOT_MODULE', 'Linked module must be a Module');
          if (dependency.context !== this.context) throw vmError('ERR_VM_MODULE_DIFFERENT_CONTEXT', 'Linked modules must use the same context');
          this._dependencies.set(request.specifier, dependency);
        }
        this._status = 'linked';
      }).catch((error) => {
        this._status = 'errored';
        this._error = error;
        throw error;
      });
    }

    linkRequests(modules) {
      if (!Array.isArray(modules) || modules.length !== this._requests.length) throw vmError('ERR_MODULE_LINK_MISMATCH', 'Linked modules do not match module requests');
      if (!modules.every((module) => module instanceof SourceTextModule || module instanceof SyntheticModule)) throw vmError('ERR_VM_MODULE_NOT_MODULE', 'Linked module must be a Module');
      this._dependencies = new Map(this._requests.map(({ specifier }, index) => [specifier, modules[index]]));
    }

    instantiate() {
      if (this._status !== 'unlinked') throw vmError('ERR_VM_MODULE_STATUS', 'Module must be unlinked');
      this._status = 'linked';
    }

    evaluate(options = {}) {
      if (options === null || typeof options !== 'object' || Array.isArray(options)) return Promise.reject(vmError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object', TypeError));
      if (this._status !== 'linked' && this._status !== 'evaluated' && this._status !== 'errored') return Promise.reject(vmError('ERR_VM_MODULE_STATUS', 'Module status must be one of linked, evaluated, or errored'));
      if (this._status === 'errored') return markVmPromise(Promise.reject(this._error), '<rejected>');
      if (this._evaluation) return this._evaluation;
      const timeout = Number(options.timeout || 0);
      if (timeout > 0 && isObviouslyUnbounded(this.sourceText)) {
        const error = timedOutScriptError(timeout);
        this._status = 'errored';
        this._error = error;
        this._evaluation = markVmPromise(Promise.reject(error), '<rejected>');
        return this._evaluation;
      }
      const context = this._context || scope;
      if (!this._context && context.process && typeof context.process === 'object') {
        Object.defineProperty(context.process, Symbol.toStringTag, { configurable: true, value: 'process' });
      }
      const dependencies = Object.fromEntries([...this._dependencies].map(([specifier, dependency]) => [specifier, dependency.namespace]));
      const importMeta = Object.create(null);
      if (typeof this.options.initializeImportMeta === 'function') this.options.initializeImportMeta(importMeta, this);
      const setExport = (name, value) => { this._namespace[name] = value; };
      const exportAll = (namespace) => { for (const name of Reflect.ownKeys(namespace)) if (name !== 'default') setExport(name, namespace[name]); };
      const dynamicImport = (specifier) => {
        if (typeof this.options.importModuleDynamically !== 'function') return Promise.reject(vmError('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'A dynamic import callback was not specified'));
        return Promise.resolve(this.options.importModuleDynamically(specifier, this)).then((module) => module?.namespace || module);
      };
      const names = ['__bnhDeps', '__bnhImportMeta', '__bnhSetExport', '__bnhExportAll', '__bnhDynamicImport', '__bnhImportBindings'];
      const values = [dependencies, importMeta, setExport, exportAll, dynamicImport, null];
      const moduleContext = Object.create(context);
      values[values.length - 1] = moduleContext;
      this._moduleContext = moduleContext;
      for (let index = 0; index < names.length; index += 1) Object.defineProperty(moduleContext, names[index], { configurable: true, value: values[index] });
      const run = () => {
        const transformed = transformModuleSource(this.sourceText);
        const runner = FunctionConstructor('context', 'source', `with (context) { return eval(source); }`);
        return runner(moduleContext, /\bawait\b/.test(this.sourceText) ? `(async () => { ${transformed} })()` : transformed);
      };
      const cleanup = () => {
        delete moduleContext.__bnhSetExport;
        delete moduleContext.__bnhExportAll;
      };
      const copyContextChanges = () => {
        for (const key of Object.keys(moduleContext)) context[key] = moduleContext[key];
      };
      const finish = () => {
        copyContextChanges();
        cleanup();
        this._status = 'evaluated';
        if (this._evaluation) this._evaluation.__bnhInspect = 'Promise { undefined }';
        return undefined;
      };
      const fail = (error) => {
        copyContextChanges();
        cleanup();
        this._status = 'errored';
        this._error = error;
        if (this._evaluation) this._evaluation.__bnhInspect = 'Promise { <rejected> }';
        throw error;
      };
      const dependencyPromises = [...this._dependencies.values()].map((dependency) => dependency.evaluate(options));
      if (dependencyPromises.length > 0) {
        this._status = 'evaluating';
        this._evaluation = markVmPromise(Promise.all(dependencyPromises).then(run).then(finish).catch(fail), '<pending>');
        return this._evaluation;
      }
      this._status = 'evaluating';
      try {
        const result = run();
        if (result && typeof result.then === 'function') {
          this._evaluation = markVmPromise(Promise.resolve(result).then(finish).catch(fail), '<pending>');
        } else {
          this._evaluation = markVmPromise(Promise.resolve(finish()), 'undefined');
        }
      } catch (error) {
        try { fail(error); } catch (failure) { this._evaluation = markVmPromise(Promise.reject(failure), '<rejected>'); }
      }
      return this._evaluation;
    }
  }

  class SyntheticModule {
    constructor(exportNames, evaluateCallback, options = {}) {
      if (!Array.isArray(exportNames) || !exportNames.every((name) => typeof name === 'string')) {
        throw vmError('ERR_INVALID_ARG_TYPE', `The "exportNames" argument must be an Array of unique strings. Received ${receivedValue(exportNames)}`, TypeError);
      }
      const duplicate = exportNames.find((name, index) => exportNames.indexOf(name) !== index);
      if (duplicate !== undefined) throw vmError('ERR_INVALID_ARG_VALUE', `The property 'exportNames.${duplicate}' is duplicated. Received '${duplicate}'`, TypeError);
      if (typeof evaluateCallback !== 'function') throw vmError('ERR_INVALID_ARG_TYPE', `The "evaluateCallback" argument must be of type function. Received ${receivedValue(evaluateCallback)}`, TypeError);
      if (options === null || typeof options !== 'object' || Array.isArray(options)) throw vmError('ERR_INVALID_ARG_TYPE', `The "options" argument must be of type object. Received ${receivedValue(options)}`, TypeError);
      if (options.context !== undefined && !isContext(options.context)) throw vmError('ERR_INVALID_ARG_TYPE', 'The "options.context" property must be a vm.Context', TypeError);
      this._status = 'linked';
      this._exportNames = new Set(exportNames);
      this._namespace = Object.create(null);
      this._namespaceView = new Proxy(this._namespace, { set: () => false, defineProperty: () => false });
      this._evaluateCallback = evaluateCallback;
      this._identifier = options.identifier || moduleIdentifier(options.context || scope);
      this._context = options.context;
      this._evaluation = null;
      Object.defineProperty(this, MODULE_KIND, { configurable: false, enumerable: false, value: 'SyntheticModule' });
    }
    get status() { return this._status; }
    get identifier() { return this._identifier; }
    get context() { return this._context; }
    get namespace() { return this._namespaceView; }
    get error() { if (this._status !== 'errored') throw vmError('ERR_VM_MODULE_STATUS', 'Module status must be errored'); return this._error; }
    get moduleRequests() { return Object.freeze([]); }
    get dependencySpecifiers() { return Object.freeze([]); }
    [INSPECT_CUSTOM](depth) { return inspectModule(this, 'SyntheticModule', depth); }
    link() { return Promise.resolve(); }
    linkRequests() {}
    instantiate() {}
    setExport(name, value) {
      if (!(this instanceof SyntheticModule) || !(this._exportNames instanceof Set)) throw vmError('ERR_INVALID_THIS', 'Invalid this');
      if (typeof name !== 'string') throw vmError('ERR_INVALID_ARG_TYPE', 'The "name" argument must be of type string', TypeError);
      if (!this._exportNames.has(name)) throw vmError('ERR_INVALID_ARG_VALUE', `Export '${name}' is not defined`, ReferenceError);
      this._namespace[name] = value;
    }
    evaluate() {
      if (this._evaluation) return this._evaluation;
      this._status = 'evaluating';
      try {
        this._evaluateCallback.call(this);
        this._status = 'evaluated';
        this._evaluation = markVmPromise(Promise.resolve(), 'undefined');
      } catch (error) {
        this._status = 'errored';
        this._error = error;
        this._evaluation = markVmPromise(Promise.reject(error), '<rejected>');
      }
      return this._evaluation;
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
    compileFunction,
    measureMemory,
    constants: VM_CONSTANTS,
    SourceTextModule,
    SyntheticModule,
  });
}
