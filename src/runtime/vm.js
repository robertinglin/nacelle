const CONTEXT_MARKER = Symbol('browser-node-vm-context');
const MODULE_KIND = Symbol('browser-node-vm-module-kind');
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const VM_CONSTANTS = Object.freeze(Object.assign(Object.create(null), {
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol.for('nodejs.vm_dynamic_import_main_context_default'),
  DONT_CONTEXTIFY: Symbol.for('nodejs.vm_context_no_contextify'),
}));
const GLOBAL_SHADOWS = Object.freeze(['process', 'Buffer']);
const CONTEXT_REALMS = new WeakMap();
let nextScriptDynamicImportId = 1;
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
  if (value === null || typeof value !== 'object') throw vmInvalidArgType('object', 'object', value);
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

function vmTypeDescription(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (Object.is(value, -0)) return 'type number (-0)';
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'string': {
      const shortened = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return shortened.includes("'")
        ? `type string (${JSON.stringify(shortened)})`
        : `type string ('${shortened}')`;
    }
    case 'object': {
      let constructorName;
      try { constructorName = value.constructor?.name; } catch { /* use inspect fallback */ }
      if (constructorName) return `an instance of ${constructorName}`;
      return String(value);
    }
    default: return `type ${typeof value} (${String(value)})`;
  }
}

function vmFormatExpected(expected) {
  const values = Array.isArray(expected) ? expected : [expected];
  const types = [];
  const instances = [];
  const other = [];
  const typeNames = new Set(['bigint', 'boolean', 'function', 'number', 'object', 'string', 'symbol', 'undefined']);
  for (const value of values) {
    if (typeNames.has(String(value).toLowerCase())) types.push(String(value).toLowerCase());
    else if (value === 'Array' || value === 'Buffer' || value === 'TypedArray' || value === 'DataView') instances.push(value);
    else other.push(value);
  }
  const list = (items) => items.length === 1
    ? items[0]
    : items.length === 2
      ? `${items[0]} or ${items[1]}`
      : `${items.slice(0, -1).join(', ')}, or ${items.at(-1)}`;
  let result = '';
  if (types.length) result += `${types.length > 1 ? 'one of type' : 'of type'} ${list(types)}`;
  if (instances.length) result += `${result ? ' or ' : ''}an instance of ${list(instances)}`;
  if (other.length) {
    result += `${result ? ' or ' : ''}${other.length > 1 ? `one of ${list(other)}` : (String(other[0]).toLowerCase() !== String(other[0]) ? 'an ' : 'a ') + other[0]}`;
  }
  return result;
}

function vmInvalidArgType(name, expected, value) {
  const kind = name.includes('.') ? 'property' : 'argument';
  return vmError(
    'ERR_INVALID_ARG_TYPE',
    `The "${name}" ${kind} must be ${vmFormatExpected(expected)}. Received ${vmTypeDescription(value)}`,
    TypeError,
  );
}

function vmInvalidArgValue(name, value, reason) {
  const kind = name.includes('.') ? 'property' : 'argument';
  return vmError(
    'ERR_INVALID_ARG_VALUE',
    `The ${kind} '${name}' ${reason}. Received ${receivedValue(value)}`,
    TypeError,
  );
}

function vmOutOfRange(name, reason, value) {
  return vmError(
    'ERR_OUT_OF_RANGE',
    `The value of "${name}" is out of range. It must be ${reason}. Received ${receivedValue(value)}`,
    RangeError,
  );
}

function validateObject(value, name, allowArray = false) {
  if (value === null || typeof value !== 'object' || (!allowArray && Array.isArray(value))) {
    throw vmInvalidArgType(name, 'Object', value);
  }
}

function validateString(value, name) {
  if (typeof value !== 'string') throw vmInvalidArgType(name, 'string', value);
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw vmInvalidArgType(name, 'boolean', value);
}

function validateInt32(value, name) {
  if (typeof value !== 'number') throw vmInvalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw vmOutOfRange(name, 'an integer', value);
  if (value < -2147483648 || value > 2147483647) {
    throw vmOutOfRange(name, '>= -2147483648 && <= 2147483647', value);
  }
}

function validateUint32(value, name, positive = false) {
  if (typeof value !== 'number') throw vmInvalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw vmOutOfRange(name, 'an integer', value);
  const minimum = positive ? 1 : 0;
  if (value < minimum || value > 4294967295) {
    throw vmOutOfRange(name, `>= ${minimum} && <= 4294967295`, value);
  }
}

function validateOneOf(value, name, choices) {
  if (!choices.includes(value)) {
    const allowed = choices.map((choice) => typeof choice === 'string' ? `'${choice}'` : String(choice)).join(', ');
    throw vmInvalidArgValue(name, value, `must be one of: ${allowed}`);
  }
}

function validateBuffer(value, name, scope = globalThis) {
  const BufferConstructor = scope?.Buffer || globalThis.Buffer;
  const isBuffer = typeof BufferConstructor?.isBuffer === 'function' && BufferConstructor.isBuffer(value);
  const arrayBuffer = scope?.ArrayBuffer || ArrayBuffer;
  if (!isBuffer && !arrayBuffer.isView(value)) throw vmInvalidArgType(name, ['Buffer', 'TypedArray', 'DataView'], value);
}

function validateStringArray(value, name) {
  if (!Array.isArray(value)) throw vmInvalidArgType(name, 'Array', value);
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') throw vmInvalidArgType(`${name}[${index}]`, 'string', value[index]);
  }
}

function validateContext(value, isContextFunction) {
  if (!isContextFunction(value)) throw vmInvalidArgType('contextifiedObject', 'vm.Context', value);
}

function getContextOptions(options) {
  if (!options) return {};
  const contextOptions = {
    name: options.contextName,
    origin: options.contextOrigin,
    codeGeneration: options.contextCodeGeneration,
    microtaskMode: options.microtaskMode,
  };
  if (contextOptions.name !== undefined) validateString(contextOptions.name, 'options.contextName');
  if (contextOptions.origin !== undefined) validateString(contextOptions.origin, 'options.contextOrigin');
  if (contextOptions.codeGeneration !== undefined) {
    validateObject(contextOptions.codeGeneration, 'options.contextCodeGeneration');
    const { strings, wasm } = contextOptions.codeGeneration;
    if (strings !== undefined) validateBoolean(strings, 'options.contextCodeGeneration.strings');
    if (wasm !== undefined) validateBoolean(wasm, 'options.contextCodeGeneration.wasm');
  }
  if (contextOptions.microtaskMode !== undefined) validateString(contextOptions.microtaskMode, 'options.microtaskMode');
  return contextOptions;
}

function getRunInContextArgs(options = {}) {
  validateObject(options, 'options');
  let timeout = options.timeout;
  if (timeout === undefined) timeout = -1;
  else validateUint32(timeout, 'options.timeout', true);
  const displayErrors = options.displayErrors === undefined ? true : options.displayErrors;
  const breakOnSigint = options.breakOnSigint === undefined ? false : options.breakOnSigint;
  validateBoolean(displayErrors, 'options.displayErrors');
  validateBoolean(breakOnSigint, 'options.breakOnSigint');
  return { timeout, displayErrors, breakOnSigint };
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

// vm.Script runs in a browser realm where a native import() would resolve
// against the adapter page rather than Node's module loader. Preserve string,
// comment, and template-literal contents while routing actual import
// expressions through the script's per-context callback.
function rewriteScriptDynamicImports(source, bindingName) {
  const text = String(source);
  let index = 0;
  const isIdentifierPart = (character) => character !== undefined && /[$\w]/u.test(character);

  const copyQuoted = (quote) => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      index += 1;
      if (character === '\\') index += 1;
      else if (character === quote) break;
    }
    return text.slice(start, index);
  };

  const copyComment = () => {
    const start = index;
    index += 2;
    if (text[start + 1] === '/') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
    } else {
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      if (index < text.length) index += 2;
    }
    return text.slice(start, index);
  };

  const scanTemplate = () => {
    let result = '`';
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') {
        result += text.slice(index, index + 2);
        index += 2;
      } else if (character === '`') {
        result += character;
        index += 1;
        break;
      } else if (character === '$' && text[index + 1] === '{') {
        result += '${';
        index += 2;
        result += scanCode(true);
      } else {
        result += character;
        index += 1;
      }
    }
    return result;
  };

  const scanCode = (stopAtBrace = false) => {
    let result = '';
    let braceDepth = stopAtBrace ? 1 : 0;
    while (index < text.length) {
      const character = text[index];
      const next = text[index + 1];
      if (text.startsWith('eval', index)
        && !isIdentifierPart(text[index - 1])
        && !isIdentifierPart(text[index + 4])) {
        let open = index + 4;
        while (/\s/u.test(text[open] || '')) open += 1;
        if (text[open] === '(') {
          let literalStart = open + 1;
          while (/\s/u.test(text[literalStart] || '')) literalStart += 1;
          if (text[literalStart] === '\'' || text[literalStart] === '"') {
            result += text.slice(index, literalStart);
            index = literalStart;
            const quoted = copyQuoted(text[literalStart]);
            const body = quoted.slice(1, -1);
            result += quoted[0] + rewriteScriptDynamicImports(body, bindingName) + quoted.slice(-1);
            continue;
          }
        }
      }
      if (character === '\'' || character === '"') {
        result += copyQuoted(character);
        continue;
      }
      if (character === '/' && (next === '/' || next === '*')) {
        result += copyComment();
        continue;
      }
      if (character === '`') {
        result += scanTemplate();
        continue;
      }
      if (stopAtBrace) {
        if (character === '{') braceDepth += 1;
        if (character === '}') {
          braceDepth -= 1;
          result += character;
          index += 1;
          if (braceDepth === 0) return result;
          continue;
        }
      }
      if (text.startsWith('import', index)
        && !isIdentifierPart(text[index - 1])
        && text[index - 1] !== '.'
        && !isIdentifierPart(text[index + 6])) {
        let callIndex = index + 6;
        while (/\s/u.test(text[callIndex] || '')) callIndex += 1;
        if (text[callIndex] === '(') {
          result += bindingName;
          index += 6;
          continue;
        }
      }
      result += character;
      index += 1;
    }
    return result;
  };

  return scanCode();
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
  let defaultContextNameIndex = 1;
  let measureMemoryWarned = false;

  const moduleIdentifier = (context) => {
    if (!moduleIds.has(context)) moduleIds.set(context, 0);
    const id = moduleIds.get(context);
    moduleIds.set(context, id + 1);
    return `vm:module(${id})`;
  };

  function normalizeContextError(value) {
    if (!value || typeof value !== 'object' || !(value instanceof (scope.Error || Error))) return value;
    const name = value.name || value.constructor?.name;
    if (typeof name !== 'string' || !name.endsWith('Error')) return value;
    const foreignConstructor = function ForeignVmError() {};
    Object.defineProperty(foreignConstructor, 'name', { configurable: true, value: name });
    const foreignPrototype = Object.create(scope.Error?.prototype || Error.prototype);
    Object.defineProperty(foreignPrototype, 'constructor', { configurable: true, value: foreignConstructor });
    const normalized = Object.create(foreignPrototype);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      try { Object.defineProperty(normalized, key, descriptor); } catch { /* preserve the normalized error */ }
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, 'name')) {
      Object.defineProperty(normalized, 'name', { configurable: true, value: name });
    }
    return normalized;
  }

  function createContext(sandbox = {}, options = {}) {
    const dontContextify = sandbox === VM_CONSTANTS.DONT_CONTEXTIFY;
    if (!dontContextify && isContext(sandbox)) return sandbox;
    const context = contextObject(dontContextify ? {} : sandbox);
    validateObject(options, 'options');
    const {
      name = `VM Context ${defaultContextNameIndex++}`,
      origin,
      codeGeneration,
      microtaskMode,
    } = options;
    validateString(name, 'options.name');
    if (origin !== undefined) validateString(origin, 'options.origin');
    if (codeGeneration !== undefined) {
      validateObject(codeGeneration, 'options.codeGeneration');
      const { strings, wasm } = codeGeneration;
      if (strings !== undefined) validateBoolean(strings, 'options.codeGeneration.strings');
      if (wasm !== undefined) validateBoolean(wasm, 'options.codeGeneration.wasm');
    }
    if (microtaskMode !== undefined) validateOneOf(microtaskMode, 'options.microtaskMode', ['afterEvaluate', undefined]);
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
    if (Object.prototype.hasOwnProperty.call(options, 'name')) context.__bnhContextName = name;
    return context;
  }

  function isContext(value) {
    if (value === null || typeof value !== 'object') throw vmInvalidArgType('object', 'object', value);
    return Boolean(value && value[CONTEXT_MARKER]);
  }

  function runInContext(code, contextifiedObject, options = {}) {
    validateContext(contextifiedObject, isContext);
    const scriptOptions = typeof options === 'string' ? { filename: options } : { ...options };
    return new Script(code, scriptOptions).runInContext(contextifiedObject, scriptOptions);
  }

  function runInNewContext(code, sandbox = {}, options = {}) {
    const contextOptions = getContextOptions(options);
    const context = createContext(sandbox, contextOptions);
    const scriptOptions = typeof options === 'string' ? { filename: options } : { ...options };
    return new Script(code, scriptOptions).runInContext(context, scriptOptions);
  }

  function runInThisContext(code, options) {
    const scriptOptions = typeof options === 'string' ? { filename: options } : options;
    return new Script(code, scriptOptions).runInThisContext(scriptOptions);
  }

  function compileFunction(code, params, options = {}) {
    validateString(code, 'code');
    validateObject(options, 'options');
    if (params !== undefined) validateStringArray(params, 'params');
    const effectiveParams = params === undefined ? [] : params;
    const {
      filename = '',
      columnOffset = 0,
      lineOffset = 0,
      cachedData,
      produceCachedData = false,
      parsingContext,
      contextExtensions = [],
    } = options;
    validateString(filename, 'options.filename');
    validateInt32(columnOffset, 'options.columnOffset');
    validateInt32(lineOffset, 'options.lineOffset');
    if (cachedData !== undefined) validateBuffer(cachedData, 'options.cachedData', scope);
    validateBoolean(produceCachedData, 'options.produceCachedData');
    if (parsingContext !== undefined) {
      if (parsingContext === null || typeof parsingContext !== 'object' || !isContext(parsingContext)) {
        throw vmInvalidArgType('options.parsingContext', 'Context', parsingContext);
      }
    }
    if (!Array.isArray(contextExtensions)) throw vmInvalidArgType('options.contextExtensions', 'Array', contextExtensions);
    for (let index = 0; index < contextExtensions.length; index += 1) {
      const extension = contextExtensions[index];
      if (extension !== null && (typeof extension !== 'object' || Array.isArray(extension))) {
        throw vmInvalidArgType(`options.contextExtensions[${index}]`, 'object', extension);
      }
    }
    const source = String(code).replace(/\bimport\s*\(/g, '__bnhDynamicImport(');
    const compiled = FunctionConstructor('__bnhDynamicImport', ...effectiveParams, source);
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
    validateObject(options, 'options');
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
      if (typeof options === 'string') options = { filename: options };
      else validateObject(options, 'options');
      const {
        filename = 'evalmachine.<anonymous>',
        lineOffset = 0,
        columnOffset = 0,
        cachedData,
        produceCachedData = false,
      } = options;
      validateString(filename, 'options.filename');
      validateInt32(lineOffset, 'options.lineOffset');
      validateInt32(columnOffset, 'options.columnOffset');
      if (cachedData !== undefined) validateBuffer(cachedData, 'options.cachedData', scope);
      validateBoolean(produceCachedData, 'options.produceCachedData');
      this.options = { ...options, filename, lineOffset, columnOffset, produceCachedData };
      FunctionConstructor(this.code);
    }

    createCachedData() {
      return scope.Buffer?.alloc?.(0) || new Uint8Array(0);
    }

    runInContext(contextifiedObject, options = {}) {
      validateContext(contextifiedObject, isContext);
      const runOptions = getRunInContextArgs(options);
      const dynamicImportBinding = `__bnhVmDynamicImport${nextScriptDynamicImportId++}`;
      const hasDynamicImport = /\bimport\s*\(/u.test(this.code);
      const source = hasDynamicImport
        ? rewriteScriptDynamicImports(this.code, dynamicImportBinding)
        : this.code;
      if (runOptions.timeout > 0 && isObviouslyUnbounded(source)) throw timedOutScriptError(runOptions.timeout);
      const context = contextifiedObject;
      if (hasDynamicImport) {
        const dynamicImport = (specifier) => {
          if (typeof this.options.importModuleDynamically === 'function') {
            return Promise.resolve(this.options.importModuleDynamically(specifier, this));
          }
          const activeProcess = context.process || scope.process;
          if (typeof activeProcess?.__bnhModuleImport === 'function') {
            const filename = this.options.filename;
            const importer = typeof filename === 'string' && filename.startsWith('/')
              ? filename
              : `/node/${filename}`;
            return Promise.resolve(activeProcess.__bnhModuleImport(
              specifier,
              importer,
              undefined,
              activeProcess,
            ));
          }
          return Promise.reject(vmError(
            'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
            'A dynamic import callback was not specified',
          ));
        };
        Object.defineProperty(context, dynamicImportBinding, {
          configurable: true,
          enumerable: false,
          value: dynamicImport,
          writable: false,
        });
      }
      const realm = CONTEXT_REALMS.get(context);
      const previousFilename = scope.__bnhVmFilename;
      scope.__bnhVmFilename = this.options.filename;
      try {
        if (!realm) return normalizeContextError(evaluate(context, source));
        copyContextToRealm(context, realm.global, realm.managedKeys);
        return normalizeContextError(realm.evaluate(source));
      } finally {
        if (previousFilename === undefined) delete scope.__bnhVmFilename;
        else scope.__bnhVmFilename = previousFilename;
        if (realm) copyRealmToContext(context, realm.global, realm.nativeKeys, realm.managedKeys);
      }
    }

    runInNewContext(sandbox = {}, options = {}) {
      const context = createContext(sandbox, getContextOptions(options));
      return this.runInContext(context, options);
    }

    runInThisContext(options = {}) {
      getRunInContextArgs(options);
      const dynamicImportBinding = `__bnhVmDynamicImport${nextScriptDynamicImportId++}`;
      const hasDynamicImport = /\bimport\s*\(/u.test(this.code);
      const source = hasDynamicImport
        ? rewriteScriptDynamicImports(this.code, dynamicImportBinding)
        : this.code;
      if (hasDynamicImport) {
        const dynamicImport = (specifier) => {
          if (typeof this.options.importModuleDynamically === 'function') {
            return Promise.resolve(this.options.importModuleDynamically(specifier, this));
          }
          const activeProcess = scope.process;
          if (typeof activeProcess?.__bnhModuleImport === 'function') {
            const filename = this.options.filename;
            const importer = typeof filename === 'string' && filename.startsWith('/')
              ? filename
              : `/node/${filename}`;
            return Promise.resolve(activeProcess.__bnhModuleImport(
              specifier,
              importer,
              undefined,
              activeProcess,
            ));
          }
          return Promise.reject(vmError(
            'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
            'A dynamic import callback was not specified',
          ));
        };
        Object.defineProperty(scope, dynamicImportBinding, {
          configurable: true,
          enumerable: false,
          value: dynamicImport,
          writable: false,
        });
      }
      return (scope.eval || eval)(source);
    }
  }

  class SourceTextModule {
    constructor(sourceText, options = {}) {
      validateString(sourceText, 'code');
      validateObject(options, 'options');
      if (options.identifier !== undefined) validateString(options.identifier, 'options.identifier');
      if (options.context !== undefined) validateContext(options.context, isContext);
      for (const name of ['initializeImportMeta', 'importModuleDynamically']) {
        if (options[name] !== undefined && typeof options[name] !== 'function') throw vmInvalidArgType(`options.${name}`, 'function', options[name]);
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
      if (typeof linker !== 'function') return Promise.reject(vmInvalidArgType('linker', 'function', linker));
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
      if (options === null || typeof options !== 'object' || Array.isArray(options)) return Promise.reject(vmInvalidArgType('options', 'Object', options));
      if (options.timeout !== undefined) validateUint32(options.timeout, 'options.timeout', true);
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
        throw vmInvalidArgType('exportNames', 'Array', exportNames);
      }
      const duplicate = exportNames.find((name, index) => exportNames.indexOf(name) !== index);
      if (duplicate !== undefined) throw vmError('ERR_INVALID_ARG_VALUE', `The property 'exportNames.${duplicate}' is duplicated. Received '${duplicate}'`, TypeError);
      if (typeof evaluateCallback !== 'function') throw vmInvalidArgType('evaluateCallback', 'function', evaluateCallback);
      validateObject(options, 'options');
      if (options.context !== undefined) validateContext(options.context, isContext);
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
      validateString(name, 'name');
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
