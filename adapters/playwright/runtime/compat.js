import { ensureOutputStream } from './streams.js';
import { AsyncResource } from './async-hooks.js';
import { inspect as runtimeInspect } from './assert.js';

export const kWeakHandler = Symbol.for('nodejs.internal.event_target.weakHandler');

const abortSignalCompatibilityKey = Symbol.for('bnh.abort-signal-compatibility');

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new TextEncoder().encode(String(value));
}

/** Map Node-shaped compatibility names to already-assembled grants. */
export function createCapabilityCompatibility(capabilities) {
  if (!capabilities?.manifest || !capabilities.vfs || !capabilities.output) {
    const error = new Error('browser capabilities were not assembled');
    error.code = 'ERR_CAPABILITY_DENIED';
    throw error;
  }
  const stdout = ensureOutputStream(capabilities.output.stdout);
  const stderr = ensureOutputStream(capabilities.output.stderr);
  return Object.freeze({
    fs: capabilities.vfs.fs,
    promises: capabilities.vfs.fs.promises,
    stdout,
    stderr,
    envKeys: Object.freeze([...capabilities.manifest.envVars.allowed]),
  });
}

function encodeComponent(value) {
  return encodeURIComponent(String(value));
}

function decodeComponent(value) {
  return decodeURIComponent(String(value).replace(/\+/g, ' '));
}

function appendQueryValue(target, key, value) {
  if (target[key] === undefined) target[key] = value;
  else if (Array.isArray(target[key])) target[key].push(value);
  else target[key] = [target[key], value];
}

export function createQuerystring() {
  const stringify = (value, separator = '&', equal = '=') => Object.entries(value || {})
    .flatMap(([key, item]) => (Array.isArray(item) ? item : [item]).map((entry) => (
      `${encodeComponent(key)}${equal}${entry === null || entry === undefined ? '' : encodeComponent(entry)}`
    )))
    .join(separator);
  const parse = (value, separator = '&', equal = '=') => {
    const result = {};
    for (const part of String(value || '').split(separator)) {
      if (!part) continue;
      const index = part.indexOf(equal);
      const key = decodeComponent(index < 0 ? part : part.slice(0, index));
      const item = decodeComponent(index < 0 ? '' : part.slice(index + equal.length));
      appendQueryValue(result, key, item);
    }
    return result;
  };
  return Object.freeze({
    stringify,
    encode: stringify,
    parse,
    decode: parse,
    escape: encodeURIComponent,
    unescape: decodeURIComponent,
  });
}

export function createStringDecoder() {
  return class StringDecoder {
    constructor(encoding = 'utf8') {
      const normalized = String(encoding).toLowerCase();
      this.encoding = normalized;
      const browserEncoding = normalized === 'utf8' ? 'utf-8' : normalized;
      this.decoder = new TextDecoder(browserEncoding === 'utf-8' ? browserEncoding : 'utf-8');
    }

    write(value) {
      return this.decoder.decode(bytes(value), { stream: true });
    }

    end(value) {
      return `${value === undefined ? '' : this.decoder.decode(bytes(value), { stream: true })}${this.decoder.decode()}`;
    }
  };
}

function tag(value) {
  return Object.prototype.toString.call(value);
}

function typedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
// Node exposes the callback result names through this well-known symbol.
// Keeping the exact registry key matters because callers define it without
// importing any runtime-specific helper.
const promisifyArgs = Symbol.for('nodejs.util.promisify.customArgs');

function invalidFunctionArgument(name, value) {
  const received = value === null ? 'null' : typeof value;
  const error = new TypeError(`The "${name}" argument must be of type function. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

export function createPromisify() {
  function promisify(original) {
    if (typeof original !== 'function') throw invalidFunctionArgument('original', original);

    const custom = original[promisifyCustom];
    if (custom !== undefined) {
      if (typeof custom !== 'function') throw invalidFunctionArgument('util.promisify.custom', custom);
      Object.defineProperty(custom, promisifyCustom, {
        configurable: true,
        enumerable: false,
        value: custom,
        writable: false,
      });
      return custom;
    }

    const argumentNames = original[promisifyArgs];
    const wrapped = function promisified(...args) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const callback = (error, ...values) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(error);
            return;
          }
          if (Array.isArray(argumentNames) && values.length > 1) {
            resolve(Object.fromEntries(argumentNames.map((name, index) => [name, values[index]])));
          } else {
            resolve(values[0]);
          }
        };
        try {
          Reflect.apply(original, this, [...args, callback]);
        } catch (error) {
          reject(error);
        }
      });
    };

    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original));
    Object.defineProperty(wrapped, promisifyCustom, {
      configurable: true,
      enumerable: false,
      value: wrapped,
      writable: false,
    });
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype' || key === promisifyCustom) continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (descriptor) {
        try { Object.defineProperty(wrapped, key, descriptor); } catch { /* function metadata can be non-configurable */ }
      }
    }
    return wrapped;
  }

  Object.defineProperty(promisify, 'custom', {
    configurable: false,
    enumerable: true,
    value: promisifyCustom,
    writable: false,
  });
  return promisify;
}

export function createUtilModule(scope = globalThis) {
  return Object.freeze({
    promisify: createPromisify(),
    customPromisifyArgs: promisifyArgs,
    types: createUtilTypes(scope),
  });
}

export function createUtilTypes(scope = globalThis) {
  const isTag = (name) => (value) => tag(value) === `[object ${name}]`;
  return Object.freeze({
    isAnyArrayBuffer: (value) => value instanceof ArrayBuffer || (typeof scope.SharedArrayBuffer === 'function' && value instanceof scope.SharedArrayBuffer),
    isArrayBuffer: (value) => value instanceof ArrayBuffer,
    isArrayBufferView: (value) => ArrayBuffer.isView(value),
    isArgumentsObject: isTag('Arguments'),
    isAsyncFunction: isTag('AsyncFunction'),
    isBigInt64Array: (value) => value instanceof BigInt64Array,
    isBigUint64Array: (value) => value instanceof BigUint64Array,
    isBooleanObject: isTag('Boolean'),
    isBoxedPrimitive: (value) => ['Boolean', 'Number', 'String', 'BigInt', 'Symbol'].includes(tag(value).slice(8, -1)),
    isCryptoKey: (value) => typeof scope.CryptoKey === 'function' && value instanceof scope.CryptoKey,
    isDataView: (value) => value instanceof DataView,
    isDate: isTag('Date'),
    isFloat32Array: (value) => value instanceof Float32Array,
    isFloat64Array: (value) => value instanceof Float64Array,
    isGeneratorFunction: isTag('GeneratorFunction'),
    isGeneratorObject: isTag('Generator'),
    isInt16Array: (value) => value instanceof Int16Array,
    isInt32Array: (value) => value instanceof Int32Array,
    isInt8Array: (value) => value instanceof Int8Array,
    isMap: (value) => value instanceof Map,
    isNativeError: (value) => value instanceof Error,
    isNumberObject: isTag('Number'),
    isPromise: (value) => value instanceof Promise,
    isRegExp: (value) => value instanceof RegExp,
    isSet: (value) => value instanceof Set,
    isSharedArrayBuffer: (value) => typeof scope.SharedArrayBuffer === 'function' && value instanceof scope.SharedArrayBuffer,
    isStringObject: isTag('String'),
    isSymbolObject: isTag('Symbol'),
    isTypedArray: typedArray,
    isUint16Array: (value) => value instanceof Uint16Array,
    isUint32Array: (value) => value instanceof Uint32Array,
    isUint8Array: (value) => value instanceof Uint8Array,
    isUint8ClampedArray: (value) => value instanceof Uint8ClampedArray,
    isWeakMap: (value) => value instanceof WeakMap,
    isWeakSet: (value) => value instanceof WeakSet,
    isProxy: () => false,
    isExternal: () => false,
    isMapIterator: (value) => tag(value) === '[object Map Iterator]',
    isSetIterator: (value) => tag(value) === '[object Set Iterator]',
    isModuleNamespaceObject: (value) => tag(value) === '[object Module]',
  });
}

export function createConstants() {
  return Object.freeze({
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, O_NOATIME: 0x40000,
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGPIPE: 13,
    UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3,
    crypto: Object.freeze({ ENGINE_METHOD_ALL: 0 }),
  });
}

function quoteConsoleString(value) {
  return `'${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}'`;
}

function inspectConsole(value, options = {}, state = { seen: new WeakSet(), depth: 0 }) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return quoteConsoleString(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }
  if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ' (anonymous)'}]`;
  if (state.seen.has(value)) return '[Circular]';
  if (options.depth !== null && state.depth >= (options.depth ?? 2)) {
    if (Array.isArray(value)) return '[Array]';
    return '[Object]';
  }
  state.seen.add(value);
  const next = { ...state, depth: state.depth + 1 };
  let result;
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
    const items = Array.from(value, (entry) => inspectConsole(entry, options, next));
    result = options.multiline && items.length
      ? `[\n${items.map((entry) => `  ${entry}`).join(',\n')}\n]`
      : items.length ? `[ ${items.join(', ')} ]` : '[]';
  } else if (value instanceof Date) {
    result = Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  } else if (value instanceof Map) {
    result = `Map(${value.size}) { ${[...value].map(([key, entry]) => `${inspectConsole(key, options, next)} => ${inspectConsole(entry, options, next)}`).join(', ')} }`;
  } else if (value instanceof Set) {
    result = `Set(${value.size}) { ${[...value].map((entry) => inspectConsole(entry, options, next)).join(', ')} }`;
  } else {
    const keys = Object.keys(value);
    const entries = keys.map((key) => {
      const label = /^[A-Za-z_$][\w$]*$/.test(key) ? key : quoteConsoleString(key);
      return `${label}: ${inspectConsole(value[key], options, next)}`;
    });
    result = options.multiline && entries.length
      ? `{\n${entries.map((entry) => `  ${entry}`).join(',\n')}\n}`
      : entries.length ? `{ ${entries.join(', ')} }` : '{}';
  }
  state.seen.delete(value);
  return result;
}

function inspectValue(value, inspectOptions, useRuntimeInspect) {
  return useRuntimeInspect ? runtimeInspect(value, inspectOptions) : inspectConsole(value, inspectOptions);
}

function formatConsole(values, inspectOptions = {}, useRuntimeInspect = false) {
  if (!values.length) return '';
  if (typeof values[0] !== 'string') return values.map((value) => inspectValue(value, inspectOptions, useRuntimeInspect)).join(' ');
  let index = 1;
  const first = values[0].replace(/%[sdifjoO%]/g, (token) => {
    if (token === '%%') return '%';
    if (index >= values.length) return token;
    const value = values[index++];
    if (token === '%j') {
      try { return JSON.stringify(value); } catch { return '[Circular]'; }
    }
    if (token === '%o' || token === '%O') return inspectValue(value, inspectOptions, useRuntimeInspect);
    if (token === '%d' || token === '%i') return String(Number(value));
    if (token === '%f') return String(Number.parseFloat(value));
    return String(value);
  });
  return [first, ...values.slice(index).map((value) => typeof value === 'string' ? value : inspectValue(value, inspectOptions, useRuntimeInspect))].join(' ');
}

function invalidConsoleType(name, value, expected) {
  const received = value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'object'
    ? `an instance of ${value.constructor?.name || 'Object'}` : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidInspectOptions(value) {
  const received = value === null ? 'null' : typeof value === 'boolean' ? `type boolean (${value})`
    : typeof value === 'string' ? `type string (${quoteConsoleString(value)})`
      : typeof value === 'number' ? `type number (${value})`
        : typeof value === 'symbol' ? `type symbol (${String(value)})` : String(value);
  const error = new TypeError(`The "options.inspectOptions" property must be of type object. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidConsoleValue(name, value) {
  const error = new TypeError(`The argument '${name}' must be one of: 'auto', true, false. Received ${inspectConsole(value)}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function writableConsoleStream(stream, name) {
  if (stream && typeof stream.write === 'function') return stream;
  const error = new TypeError(`Console expects a writable stream instance for ${name}`);
  error.code = 'ERR_CONSOLE_WRITABLE_STREAM';
  throw error;
}

function streamError(stream) {
  return stream?._writableState?.errored || stream?.errored || null;
}

function writeStream(stream, value, ignoreErrors) {
  try {
    stream.write(`${value}\n`);
  } catch (error) {
    if (!ignoreErrors || error instanceof RangeError) throw error;
    return;
  }
  const error = streamError(stream);
  if (error && (!ignoreErrors || error instanceof RangeError)) throw error;
}

function stringWidth(value) {
  return [...String(value)].reduce((width, character) => {
    const code = character.codePointAt(0);
    return width + ((code >= 0x1100 && (code <= 0x115f || code >= 0x2e80)) ? 2 : 1);
  }, 0);
}

const TABLE_UNDEFINED = Symbol('console.table.undefined');

function tableRows(data, properties) {
  const iteratorTag = Object.prototype.toString.call(data);
  if (data instanceof Map || iteratorTag === '[object Map Iterator]') {
    const entries = data instanceof Map ? [...data] : [...data];
    if (data instanceof Map || entries.every((entry) => Array.isArray(entry) && entry.length === 2)) {
      return { index: '(iteration index)', rows: entries.map(([key, value], index) => ({ index, key, value })), columns: ['Key', 'Values'], values: (row, column) => column === 'Key' ? row.key : row.value };
    }
    return { index: '(iteration index)', rows: entries.map((value, index) => ({ index, value })), columns: ['Values'], values: (row) => row.value };
  }
  if (data && (data instanceof Set || iteratorTag === '[object Set Iterator]')) {
    const values = data instanceof Set ? [...data] : [...data];
    return { index: '(iteration index)', rows: values.map((value, index) => ({ index, value })), columns: ['Values'], values: (row) => row.value };
  }
  if (Array.isArray(data) || (ArrayBuffer.isView(data) && !(data instanceof DataView))) {
    const rows = Array.from(data, (value, index) => ({ index, value }));
    const nested = new Set();
    let hasValues = false;
    for (const row of rows) {
      if (row.value && typeof row.value === 'object' && !Array.isArray(row.value)) for (const key of Object.keys(row.value)) nested.add(key);
      if (Array.isArray(row.value)) for (let index = 0; index < row.value.length; index += 1) nested.add(String(index));
      if (row.value === null || typeof row.value !== 'object') hasValues = true;
    }
    const columns = rows.length === 0 ? [] : [...nested, ...(hasValues ? ['Values'] : nested.size ? [] : ['Values'])];
    return {
      index: '(index)', rows, columns,
      values: (row, column) => column === 'Values' && (row.value === null || typeof row.value !== 'object')
        ? row.value === undefined ? TABLE_UNDEFINED : row.value
        : row.value && Object.prototype.hasOwnProperty.call(row.value, column) ? row.value[column] : undefined,
    };
  }
  const rows = Object.keys(Object(data)).map((key) => ({ index: key, value: data[key] }));
  const nested = new Set();
  let hasValues = false;
  for (const row of rows) {
    if (row.value && typeof row.value === 'object' && !Array.isArray(row.value)) for (const key of Object.keys(row.value)) nested.add(key);
    if (Array.isArray(row.value)) for (let index = 0; index < row.value.length; index += 1) nested.add(String(index));
    if (row.value === null || typeof row.value !== 'object') hasValues = true;
  }
  const columns = rows.length === 0 ? [] : [...nested, ...(hasValues ? ['Values'] : nested.size ? [] : ['Values'])];
  return {
    index: '(index)', rows, columns,
    values: (row, column) => column === 'Values' && (row.value === null || typeof row.value !== 'object')
      ? row.value === undefined ? TABLE_UNDEFINED : row.value
      : row.value && Object.prototype.hasOwnProperty.call(row.value, column) ? row.value[column] : undefined,
  };
}

function formatTable(data, properties) {
  const table = tableRows(data, properties);
  const columns = properties === undefined ? table.columns : properties;
  const headers = [table.index, ...columns];
  const rows = table.rows.map((row) => [row.index, ...columns.map((column) => table.values(row, column))]);
  const rendered = rows.map((row) => row.map((value, index) => index === 0
    ? String(value)
    : value === TABLE_UNDEFINED ? inspectConsole(undefined) : value === undefined ? ''
      : Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))
        ? inspectConsole(value) : inspectConsole(value, { depth: 0 })));
  const widths = headers.map((header, index) => Math.max(stringWidth(header), ...rendered.map((row) => stringWidth(row[index] || ''))));
  const border = (left, join, right, fill = '─') => left + widths.map((width) => fill.repeat(width + 2)).join(join) + right;
  const line = (row) => `│${row.map((value, index) => ` ${value}${' '.repeat(widths[index] - stringWidth(value))} `).join('│')}│`;
  return [
    border('┌', '┬', '┐'),
    line(headers),
    border('├', '┼', '┤'),
    ...rendered.map(line),
    border('└', '┴', '┘'),
  ].join('\n');
}

export function createConsoleModule(processObject) {
  const methods = ['log', 'info', 'debug', 'warn', 'error', 'dir', 'time', 'timeEnd', 'timeLog', 'timeStamp', 'trace', 'assert', 'clear', 'count', 'countReset', 'group', 'groupEnd', 'table', 'dirxml', 'groupCollapsed'];
  function Console(stdoutOrOptions, stderr, ignoreErrors) {
    if (!new.target) return new Console(...arguments);
    let options = {};
    if (stdoutOrOptions && typeof stdoutOrOptions === 'object' && Object.hasOwn(stdoutOrOptions, 'stdout')) options = stdoutOrOptions;
    const stdout = options.stdout ?? stdoutOrOptions;
    const error = options.stderr ?? stderr ?? processObject.stderr;
    this._stdout = writableConsoleStream(stdout, 'stdout');
    this._stderr = writableConsoleStream(error, 'stderr');
    this._ignoreErrors = options.ignoreErrors ?? ignoreErrors ?? true;
    this._inspectOptions = options.inspectOptions ?? {};
    if (options.inspectOptions !== undefined && (options.inspectOptions === null || typeof options.inspectOptions !== 'object' || Array.isArray(options.inspectOptions))) {
      throw invalidInspectOptions(options.inspectOptions);
    }
    if (options.colorMode !== undefined && !['auto', true, false].includes(options.colorMode)) throw invalidConsoleValue('colorMode', options.colorMode);
    if (options.colorMode !== undefined && options.inspectOptions?.colors !== undefined) {
      const incompatible = new TypeError('Option "options.inspectOptions.color" cannot be used in combination with option "colorMode"');
      incompatible.code = 'ERR_INCOMPATIBLE_OPTION_PAIR';
      throw incompatible;
    }
    this._colorMode = options.colorMode;
    this._groupIndentation = options.groupIndentation === undefined ? 2 : options.groupIndentation;
    if (options.groupIndentation !== undefined && typeof options.groupIndentation !== 'number') {
      throw invalidConsoleType('options.groupIndentation', options.groupIndentation, 'of type number');
    }
    if (options.groupIndentation !== undefined && !Number.isInteger(options.groupIndentation)) {
      const range = new RangeError('The property \'options.groupIndentation\' must be an integer');
      range.code = 'ERR_OUT_OF_RANGE';
      throw range;
    }
    if (this._groupIndentation < 0 || this._groupIndentation > 1000) {
      const range = new RangeError('The property \'options.groupIndentation\' must be >= 0 && <= 1000');
      range.code = 'ERR_OUT_OF_RANGE';
      throw range;
    }
    this._groupIndent = 0;
    this._times = new Map();
    this._counts = new Map();
    for (const name of methods) if (typeof this[name] === 'function') this[name] = this[name].bind(this);
  }
  const write = (instance, stream, values) => {
    const indentation = ' '.repeat(instance._groupIndent * instance._groupIndentation);
    const inspectOptions = instance._colorMode !== undefined || Object.keys(instance._inspectOptions).length > 0
      ? { ...instance._inspectOptions, multiline: true }
      : instance._inspectOptions;
    const text = formatConsole(values, inspectOptions, false).replaceAll('\n', `\n${indentation}`);
    writeStream(stream, `${indentation}${text}`, instance._ignoreErrors);
  };
  Object.assign(Console.prototype, {
    constructor: Console,
    log(...values) { write(this, this._stdout, values); },
    info(...values) { this.log(...values); },
    debug(...values) { this.log(...values); },
    warn(...values) { write(this, this._stderr, values); },
    error(...values) { this.warn(...values); },
    dir(value) {
      const inspectOptions = this._colorMode !== undefined || Object.keys(this._inspectOptions).length > 0
        ? { ...this._inspectOptions, multiline: true }
        : this._inspectOptions;
      write(this, this._stdout, [inspectValue(value, inspectOptions, false)]);
    },
    time(label = 'default') { if (!this._times.has(String(label))) this._times.set(String(label), Date.now()); },
    timeEnd(label = 'default') { const key = String(label); if (!this._times.has(key)) return; const duration = Date.now() - this._times.get(key); this._times.delete(key); this.log(`${key}: ${duration}ms`); },
    timeLog(label = 'default', ...values) { const key = String(label); if (!this._times.has(key)) return; const duration = Date.now() - this._times.get(key); this.log(`${key}: ${duration}ms`, ...values); },
    timeStamp() {},
    trace(...values) {
      const stack = new Error().stack?.split('\n').slice(2).join('\n') || '';
      const inspectOptions = this._colorMode !== undefined || Object.keys(this._inspectOptions).length > 0
        ? { ...this._inspectOptions, multiline: true }
        : this._inspectOptions;
      write(this, this._stderr, [`Trace: ${formatConsole(values, inspectOptions, false)}${stack ? `\n${stack}` : ''}`]);
    },
    assert(value, ...values) { if (!value) this.error('Assertion failed', ...values); },
    clear() {},
    count(label = 'default') { const key = String(label); const count = (this._counts.get(key) || 0) + 1; this._counts.set(key, count); this.log(`${key}: ${count}`); },
    countReset(label = 'default') { this._counts.delete(String(label)); },
    group(...values) { if (values.length) this.log(...values); this._groupIndent += 1; },
    groupEnd() { this._groupIndent = Math.max(0, this._groupIndent - 1); },
    table(data, properties) {
      if (properties !== undefined && !Array.isArray(properties)) throw invalidConsoleType('properties', properties, 'an instance of Array');
      if (data === null || data === undefined || typeof data !== 'object') {
        writeStream(this._stdout, typeof data === 'string' ? data : inspectConsole(data, this._inspectOptions), this._ignoreErrors);
        return;
      }
      writeStream(this._stdout, formatTable(data, properties), this._ignoreErrors);
    },
    dirxml(...values) { this.log(...values); },
    groupCollapsed(...values) { this.group(...values); },
  });
  const consoleObject = new Console(processObject.stdout, processObject.stderr);
  consoleObject.Console = Console;
  return Object.freeze(consoleObject);
}

async function readStream(stream) {
  if (stream?.getReader) {
    const reader = stream.getReader();
    const chunks = [];
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        chunks.push(bytes(item.value));
      }
    } finally {
      reader.releaseLock();
    }
    return chunks;
  }
  const chunks = [];
  for await (const item of stream || []) chunks.push(bytes(item));
  return chunks;
}

function joinChunks(chunks) {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function createStreamConsumers(scope, BufferClass) {
  const collect = async (stream) => joinChunks(await readStream(stream));
  return Object.freeze({
    arrayBuffer: async (stream) => (await collect(stream)).buffer,
    blob: async (stream) => new scope.Blob([await collect(stream)]),
    buffer: async (stream) => BufferClass.from(await collect(stream)),
    json: async (stream) => JSON.parse(new TextDecoder().decode(await collect(stream))),
    text: async (stream) => new TextDecoder().decode(await collect(stream)),
  });
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

function installAbortSignalCompatibility(scope) {
  const AbortSignalClass = scope.AbortSignal;
  if (typeof AbortSignalClass !== 'function' || scope[abortSignalCompatibilityKey]) return;

  const state = { gcGeneration: 0, signals: new WeakMap() };
  Object.defineProperty(scope, abortSignalCompatibilityKey, { configurable: true, value: state });

  const trackSignal = (signal) => {
    if (!signal || state.signals.has(signal)) return state.signals.get(signal);
    const signalState = { strongListeners: new Set(), weakListeners: new Set() };
    state.signals.set(signal, signalState);
    return signalState;
  };
  const nativeAddEventListener = AbortSignalClass.prototype.addEventListener;
  const nativeRemoveEventListener = AbortSignalClass.prototype.removeEventListener;
  if (typeof nativeAddEventListener === 'function' && typeof nativeRemoveEventListener === 'function') {
    Object.defineProperties(AbortSignalClass.prototype, {
      addEventListener: {
        configurable: true,
        value(type, listener, options) {
          const result = Reflect.apply(nativeAddEventListener, this, [type, listener, options]);
          if (type === 'abort' && typeof listener === 'function') {
            const signalState = trackSignal(this);
            const listeners = options?.[kWeakHandler] ? signalState.weakListeners : signalState.strongListeners;
            listeners.add(listener);
          }
          return result;
        },
      },
      removeEventListener: {
        configurable: true,
        value(type, listener, options) {
          const result = Reflect.apply(nativeRemoveEventListener, this, [type, listener, options]);
          if (type === 'abort' && typeof listener === 'function') {
            const signalState = state.signals.get(this);
            signalState?.strongListeners.delete(listener);
            signalState?.weakListeners.delete(listener);
          }
          return result;
        },
      },
    });
  }

  if (typeof AbortSignalClass.timeout === 'function') {
    const nativeTimeout = AbortSignalClass.timeout.bind(AbortSignalClass);
    const timeout = (milliseconds) => {
      const nativeSignal = nativeTimeout(milliseconds);
      trackSignal(nativeSignal);
      const controller = new scope.AbortController();
      const abort = () => controller.abort(new scope.DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ));
      if (nativeSignal.aborted) abort();
      else nativeSignal.addEventListener('abort', abort, { once: true, [kWeakHandler]: true });
      trackSignal(controller.signal);
      return controller.signal;
    };
    try { AbortSignalClass.timeout = timeout; } catch { /* native method is immutable */ }
  }

  if (typeof AbortSignalClass.any === 'function') {
    const nativeAny = AbortSignalClass.any.bind(AbortSignalClass);
    const receivedType = (value) => value === null ? 'null' : value === undefined ? 'undefined' : typeof value;
    const any = (signals) => {
      if (signals === null || signals === undefined || typeof signals[Symbol.iterator] !== 'function') {
        const error = new TypeError(`The "signals" argument must be an iterable of AbortSignal instances. Received ${receivedType(signals)}`);
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      const values = [...signals];
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (!(value instanceof AbortSignalClass)) {
          const error = new TypeError(`The "signals[${index}]" argument must be an instance of AbortSignal. Received ${receivedType(value)}`);
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
      }
      const signal = nativeAny(values);
      trackSignal(signal);
      return signal;
    };
    try { AbortSignalClass.any = any; } catch { /* native method is immutable */ }
  }

  const signalConstructor = function AbortSignal() {
    const error = new TypeError('Illegal constructor');
    error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
    throw error;
  };
  try {
    Object.defineProperty(AbortSignalClass.prototype, 'constructor', {
      configurable: true,
      value: signalConstructor,
      writable: true,
    });
  } catch { /* browser prototype is immutable */ }

  if (typeof scope.Event === 'function' && scope.Event.prototype
      && !Object.prototype.hasOwnProperty.call(scope.Event.prototype, 'isTrusted')) {
    try {
      Object.defineProperty(scope.Event.prototype, 'isTrusted', {
        configurable: true,
        get() { return false; },
      });
    } catch { /* browser prototype is immutable */ }
  }

  const NativeWeakRef = scope.WeakRef;
  if (typeof NativeWeakRef === 'function') {
    class CompatibleWeakRef {
      constructor(value) {
        const signalState = state.signals.get(value);
        this.signalState = signalState;
        this.value = signalState ? value : undefined;
        this.native = signalState ? null : new NativeWeakRef(value);
      }

      deref() {
        if (!this.signalState) return this.native.deref();
        if (state.gcGeneration > 0 && this.signalState.strongListeners.size === 0) this.value = undefined;
        return this.value;
      }
    }
    scope.WeakRef = CompatibleWeakRef;
  }

  const nativeGc = typeof scope.gc === 'function' ? scope.gc.bind(scope) : null;
  scope.gc = () => {
    state.gcGeneration += 1;
    nativeGc?.();
  };
}

export function createInternalEventTarget(scope = globalThis) {
  const Event = scope.Event || class BrowserEvent {};
  const EventTarget = scope.EventTarget || class BrowserEventTarget {
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  };
  class NodeEventTarget extends EventTarget {}
  const kCreateEvent = Symbol('bnh.createEvent');
  const kNewListener = Symbol('bnh.newListener');
  const kRemoveListener = Symbol('bnh.removeListener');

  function defineEventHandler(target, name) {
    const property = `on${name}`;
    if (Object.getOwnPropertyDescriptor(target, property)) return;
    const handler = Symbol(property);
    Object.defineProperty(target, property, {
      configurable: true,
      enumerable: true,
      get() { return this[handler] || null; },
      set(value) {
        const previous = this[handler];
        if (previous) this.removeEventListener?.(name, previous);
        this[handler] = typeof value === 'function' ? value : null;
        if (this[handler]) this.addEventListener?.(name, this[handler]);
      },
    });
  }

  function initNodeEventTarget() {}

  return Object.freeze({
    Event,
    EventTarget,
    NodeEventTarget,
    defineEventHandler,
    initNodeEventTarget,
    kCreateEvent,
    kNewListener,
    kRemoveListener,
    kWeakHandler,
  });
}

export function installBrowserAbortSignalCompatibility(scope = globalThis) {
  installAbortSignalCompatibility(scope);
}

export function createAborted() {
  return function aborted(signal, resource) {
    if (signal === undefined) {
      const err = new TypeError("The \"signal\" argument must be an instance of AbortSignal. Received undefined");
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    if (signal === null || typeof signal !== 'object' || !('aborted' in signal)) {
      const err = new TypeError("The \"signal\" argument must be an instance of AbortSignal. Received " + (signal === null ? 'null' : typeof signal));
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    const throwOnNullable = true;
    const allowArray = true;
    const allowFunction = true;
    if (throwOnNullable && resource === null) {
      const err = new TypeError("The \"resource\" argument must be of type Object. Received null");
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    const throwOnArray = !allowArray;
    if (throwOnArray && Array.isArray(resource)) {
      const err = new TypeError("The \"resource\" argument must be of type Object. Received array");
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    const throwOnFunction = !allowFunction;
    const typeofValue = typeof resource;
    if (typeofValue !== 'object' && (throwOnFunction || typeofValue !== 'function')) {
      const err = new TypeError("The \"resource\" argument must be of type Object. Received " + (resource === null ? 'null' : typeofValue));
      err.code = 'ERR_INVALID_ARG_TYPE';
      return Promise.reject(err);
    }
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

const kIsClosedPromise = Symbol.for('nodejs.webstream.isClosedPromise');
const kControllerErrorFunction = Symbol.for('nodejs.webstream.controllerErrorFunction');

export function addAbortSignal(signal, stream) {
  try {
    if (!signal || typeof signal !== 'object' || !('aborted' in signal)) {
      return stream;
    }
    if (signal.aborted) {
      if (stream && typeof stream.destroy === 'function') {
        stream.destroy(abortError());
      } else if (stream && typeof stream[kControllerErrorFunction] === 'function') {
        stream[kControllerErrorFunction](abortError());
      } else if (stream && typeof stream.cancel === 'function' && typeof stream.getReader === 'function') {
        stream.cancel(abortError());
      } else if (stream && typeof stream.abort === 'function' && typeof stream.getWriter === 'function') {
        stream.abort(abortError());
      }
      return stream;
    }
    const onAbort = () => {
      try {
        if (stream && typeof stream.destroy === 'function') {
          stream.destroy(abortError());
        } else if (stream && typeof stream[kControllerErrorFunction] === 'function') {
          stream[kControllerErrorFunction](abortError());
        } else if (stream && typeof stream.cancel === 'function' && typeof stream.getReader === 'function') {
          stream.cancel(abortError());
        } else if (stream && typeof stream.abort === 'function' && typeof stream.getWriter === 'function') {
          stream.abort(abortError());
        }
      } catch (e) {
        throw e;
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return stream;
  } catch (e) {
    throw e;
  }
}

export function finished(stream, options, callbackArgument) {
  try {
    const isNodeStream = stream && typeof stream.on === 'function'
      && (stream._readableState || stream._writableState);
    const isWebStream = stream && (typeof stream.getReader === 'function'
      || typeof stream.getWriter === 'function');
    if (!isNodeStream && !isWebStream && !(stream && kIsClosedPromise in stream)) {
      const error = new TypeError('The "stream" argument must be an instance of Stream or ReadableStream');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    let callback = callbackArgument;
    if (typeof options === 'function') {
      if (callbackArgument !== undefined) {
        const error = new TypeError('The "callback" argument must be of type function');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      callback = options;
      options = undefined;
    } else if (options !== undefined && options !== null && typeof options !== 'object') {
      const error = new TypeError(callbackArgument === undefined
        ? 'The "callback" argument must be of type function'
        : 'The "options" argument must be an object');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (callback !== undefined && typeof callback !== 'function') {
      const error = new TypeError('The "callback" argument must be of type function');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (callback === undefined) callback = null;
    const callbackResource = callback ? new AsyncResource('STREAMFINISHED') : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const complete = (error = undefined) => {
        if (settled) return;
        settled = true;
        try {
          if (callbackResource) callbackResource.runInAsyncScope(callback, undefined, error);
          if (error && !callbackResource) reject(error);
          else resolve();
        } finally {
          callbackResource?.emitDestroy();
        }
      };
      const onFinish = () => complete();
      const onError = (err) => complete(err || abortError());
      const onClose = () => {
        const readableState = stream?._readableState;
        const writableState = stream?._writableState;
        const premature = Boolean(
          (readableState?.readable !== false && !readableState?.endEmitted)
          || (writableState?.writable !== false && !writableState?.finished),
        );
        if (!premature) {
          complete();
          return;
        }
        const error = new Error('Premature close');
        error.code = 'ERR_STREAM_PREMATURE_CLOSE';
        complete(error);
      };
      if (stream && typeof stream.on === 'function') {
        stream.on('finish', onFinish);
        stream.on('end', onFinish);
        stream.on('close', onClose);
        if (options && options.error !== false) {
          stream.on('error', onError);
        }
    } else if (stream && typeof stream.getReader === 'function') {
      if (stream.locked) {
        const closedPromise = stream[kIsClosedPromise];
        Promise.resolve(closedPromise?.promise).then(
          () => resolve(),
          (err) => reject(err || abortError())
        );
        return;
      }
      (async () => {
        try {
            const reader = stream.getReader();
            while (true) {
              const result = await reader.read();
              if (result.done) break;
            }
            reader.releaseLock();
            resolve();
          } catch (err) {
            reject(err || abortError());
          }
        })();
        return;
      } else if (stream && kIsClosedPromise in stream && stream[kIsClosedPromise]) {
        const closedPromise = stream[kIsClosedPromise];
        Promise.resolve(closedPromise.promise).then(
          () => resolve(),
          (err) => reject(err || abortError())
        );
        return;
      } else {
        resolve();
      }
    });
  } catch (e) {
    throw e;
  }
}

export function createWebStreamModule(scope) {
  const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
  const patchStream = (StreamClass) => {
    if (typeof StreamClass === 'function' && StreamClass.prototype) {
      StreamClass.prototype[inspectCustom] = function() {
        throw Object.assign(new TypeError('Invalid this'), { code: 'ERR_INVALID_THIS' });
      };
    }
  };
  if (typeof scope.TextEncoderStream === 'function') patchStream(scope.TextEncoderStream);
  if (typeof scope.TextDecoderStream === 'function') patchStream(scope.TextDecoderStream);
  const patchCompressionInspect = (StreamClass, name) => {
    if (typeof StreamClass !== 'function' || !StreamClass.prototype) return;
    Object.defineProperty(StreamClass.prototype, inspectCustom, {
      configurable: true,
      value() { return `${name} { readable: ReadableStream, writable: WritableStream }`; },
    });
  };
  patchCompressionInspect(scope.CompressionStream, 'CompressionStream');
  patchCompressionInspect(scope.DecompressionStream, 'DecompressionStream');
  return Object.freeze({
    ReadableStream: scope.ReadableStream,
    WritableStream: scope.WritableStream,
    TransformStream: scope.TransformStream,
    ByteLengthQueuingStrategy: scope.ByteLengthQueuingStrategy,
    CountQueuingStrategy: scope.CountQueuingStrategy,
    TextEncoderStream: typeof scope.TextEncoderStream === 'function' ? scope.TextEncoderStream : undefined,
    TextDecoderStream: typeof scope.TextDecoderStream === 'function' ? scope.TextDecoderStream : undefined,
    CompressionStream: typeof scope.CompressionStream === 'function' ? scope.CompressionStream : undefined,
    DecompressionStream: typeof scope.DecompressionStream === 'function' ? scope.DecompressionStream : undefined,
  });
}
