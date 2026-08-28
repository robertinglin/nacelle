import { createAssert, inspect as nodeInspect } from './runtime/assert.js';
import {
  createBufferClass,
  createTranscode,
  createFileClass,
  installBlobCompatibility,
  isAscii,
  isUtf8,
} from './runtime/buffer.js';
import {
  createAsyncLocalStorage,
  assembleBrowserCapabilities,
  createBrowserIO,
  createBrowserRuntimeContracts,
  createDiagnosticsModule,
  adaptMessagePort,
  createMessageEvent,
  prepareTransferPayload,
  createWorkerFactory,
  validateCapabilityManifest,
} from './runtime/index.js';
import {
  ASYNC_WRAP_PROVIDERS,
  AsyncResource,
  BrowserAsyncContextFrame,
  collectAsyncResources,
  createAsyncHooksModule,
} from './runtime/async-hooks.js';
import { EventEmitter, addAbortListener, getEventListeners, getMaxListeners, once } from './runtime/events.js';
import { createVfs, fileURLToPath, pathToFileURL } from './runtime/vfs.js';
import { path } from './runtime/path.js';
import {
  Readable, Writable, Duplex, Transform, PassThrough, Stream, duplexPair, pipeline, destroy,
  compose, isDestroyed, isDisturbed, isErrored, isReadable, isWritable, promises as streamPromises,
  setDefaultHighWaterMark, getDefaultHighWaterMark,
} from './runtime/streams.js';
import { createPlatformContract } from './runtime/os-platform.js';
import { createHttpCompatibility } from './runtime/http.js';
import { createTlsModule } from './runtime/tls.js';
import { createHttp2Module } from './runtime/http2.js';
import { createPerformancePrimitives } from './runtime/perf.js';
import { createWasmContract } from './runtime/wasm.js';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  createHashShim,
  createHmacShim,
  createSignClass,
  createVerifyClass,
  createSecretKeyShim,
  checkPrime,
  checkPrimeSync,
  browserCryptoVersion,
  BrowserECDH,
  createCertificateShim,
  Cipher,
  Cipheriv,
  Decipher,
  Decipheriv,
  createCipheriv,
  createDecipheriv,
  createECDH,
  diffieHellman,
  cryptoConstants,
  generatePrime,
  generatePrimeSync,
  generateKey,
  getCipherInfo,
  getRandomValues as createRandomValues,
  hkdf as createHkdf,
  hkdfSync,
  generateKeyPair,
  generateKeyPairSync,
  hashSync,
  privateDecrypt,
  privateEncrypt,
  pbkdf2,
  pbkdf2Sync,
  randomBytes as createRandomBytes,
  randomFill,
  randomFillSync,
  randomInt as createRandomInt,
  randomUUID as createRandomUUID,
  publicDecrypt,
  publicEncrypt,
  secureHeapUsed,
  setEngine,
  setFips,
  sign,
  signSync,
  scryptSync as createScryptSync,
  timingSafeEqual,
  verify,
  scrypt as createScrypt,
  verifySync,
} from './runtime/crypto.js';
import { createDiffieHellman, createDiffieHellmanGroup } from './runtime/diffie-hellman.js';
import { createZlibShim as createZlibShimModule } from './runtime/zlib.js';
import {
  createConsoleModule,
  installConsoleErrorHandlers,
  createConstants as createBaseConstants,
  createPromisify,
  createQuerystring,
  createStreamConsumers,
  createStringDecoder,
  createUtilModule,
  createUtilTypes,
  createInternalEventTarget,
  installBrowserAbortSignalCompatibility,
  createAborted,
  addAbortSignal,
  finished,
} from './runtime/compat.js';
import { createUnsupportedBuiltins } from './runtime/unsupported-builtins.js';
import { createNodeTest } from './runtime/node-test.js';
import { createVmModule } from './runtime/vm.js';
import { createDomainModule } from './runtime/domain.js';
import { createBrowserDns } from './runtime/dns.js';
import { createBrowserDgram } from './runtime/dgram.js';
import { createBrowserNet } from './runtime/net.js';
import { kConnectionsCheckingInterval } from './runtime/http.js';
import { createVirtualNetwork, getSharedVirtualNetwork, replaceSharedVirtualNetwork } from './runtime/virtual-network.js';
import { createCluster } from './runtime/cluster.js';
import { createVirtualProcess } from './runtime/virtual-process.js';
import { createBrowserExecve, createBrowserProcess } from './runtime/process.js';
import { createProxyCapability } from './runtime/proxy.js';
import { createV8Module } from './runtime/v8.js';
import { createProcessReport } from './runtime/report.js';
import { installProcessFinalization } from './runtime/finalization.js';
import { createModuleLoader } from './runtime/module-loader.js';
import { createPrimordials } from './runtime/primordials.js';
import { createBrowserInternalBindings } from './runtime/internal-bindings.js';
import { createUrlModule } from './runtime/url.js';
import { installWarningContract } from './runtime/warnings.js';
import { nativeAddonDisabledError, unsupportedNativeAddon } from './runtime/errors.js';
import { createSqliteModule } from './runtime/sqlite.js';

const BUILTIN_NAMES = Object.freeze([
  'assert', 'assert/strict', 'buffer', 'console', 'constants', 'crypto', 'domain', 'events', 'fs', 'fs/promises', 'http', 'https', 'module', 'os',
  'path', 'path/posix', 'path/win32', 'process', 'querystring', 'stream', 'stream/consumers', 'stream/promises', 'stream/web',
  'string_decoder', 'timers', 'timers/promises', 'url', 'util', 'sys', 'util/types', 'worker_threads', 'zlib', 'perf_hooks', 'async_hooks', 'diagnostics_channel', 'punycode',
  'child_process', 'cluster', 'dgram', 'dns', 'dns/promises', 'http2', 'net', 'repl', 'tls', 'test', 'v8', 'vm', '_http_server',
  'sea', 'sqlite', 'test/reporters', '_http_common', '_http_outgoing',
  'internal/event_target', 'internal/async_context_frame', 'internal/async_hooks', 'internal/test/binding', 'internal/test/transfer',
  'internal/bootstrap/realm', 'internal/modules/cjs/loader', 'internal/modules/esm/utils', 'internal/vm/module',
  'internal/util', 'internal/util/debuglog', 'internal/util/types', 'internal/options', 'internal/dgram',
]);

function builtinName(name) {
  return name.startsWith('node:') ? name.slice(5) : name;
}

const BROWSER_SIGNAL_CONSTANTS = Object.freeze({
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGVTALRM: 26,
  SIGWINCH: 28,
  SIGXCPU: 24,
  SIGXFSZ: 25,
});

function createConstants() {
  const { crypto, ...baseConstants } = createBaseConstants();
  return Object.freeze({
    ...baseConstants,
    ...BROWSER_SIGNAL_CONSTANTS,
    ...crypto,
    EISDIR: 21,
    EOPNOTSUPP: 95,
    EOVERFLOW: 75,
    EPERM: 1,
    EPIPE: 32,
    EPROTO: 71,
    EPROTONOSUPPORT: 93,
    EPROTOTYPE: 91,
    ERANGE: 34,
  });
}

const ERRNO_CONSTANT_NAMES = Object.freeze([
  'EISDIR', 'EOPNOTSUPP', 'EOVERFLOW', 'EPERM', 'EPIPE',
  'EPROTO', 'EPROTONOSUPPORT', 'EPROTOTYPE', 'ERANGE',
]);

function installErrnoConstants(target, constants) {
  for (const name of ERRNO_CONSTANT_NAMES) {
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: true,
      value: constants[name],
      writable: false,
    });
  }
}

function nativeMessagePort(value, scope) {
  const MessagePort = scope.MessagePort;
  if (typeof MessagePort === 'function' && value instanceof MessagePort) return value;
  if (value?.raw && typeof MessagePort === 'function' && value.raw instanceof MessagePort) return value.raw;
  return null;
}

function adaptWorkerData(value, scope, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  const rawPort = nativeMessagePort(value, scope);
  if (rawPort) return adaptMessagePort(rawPort);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(adaptWorkerData(item, scope, seen));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = adaptWorkerData(item, scope, seen);
  return copy;
}

function collectMessagePorts(value, scope, ports = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return ports;
  const rawPort = nativeMessagePort(value, scope);
  if (rawPort) {
    ports.push(rawPort);
    return ports;
  }
  seen.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return ports;
  if (Array.isArray(value)) {
    for (const item of value) collectMessagePorts(item, scope, ports, seen);
    return ports;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return ports;
  for (const item of Object.values(value)) collectMessagePorts(item, scope, ports, seen);
  return ports;
}

function workerDataTransferError(scope) {
  const message = 'Object that needs transfer was found in message but not listed in transferList';
  return typeof scope.DOMException === 'function'
    ? new scope.DOMException(message, 'DataCloneError')
    : Object.assign(new Error(message), { name: 'DataCloneError', code: 25 });
}

function createDeprecate(processObject) {
  const warnedCodes = new Set();
  return (fn, message, code) => {
    if (typeof fn !== 'function') throw new TypeError('The "fn" argument must be of type function');
    if (code !== undefined && typeof code !== 'string') {
      let received;
      if (code === null) received = 'null';
      else if (typeof code === 'object') received = `an instance of ${code.constructor?.name || 'Object'}`;
      else received = `type ${typeof code} (${String(code)})`;
      const error = new TypeError(`The "code" argument must be of type string. Received ${received}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    let warned = false;
    function deprecated(...args) {
      const codeAlreadyWarned = code !== undefined && warnedCodes.has(code);
      if (!warned && !codeAlreadyWarned && !processObject.noDeprecation) {
        warned = true;
        if (code !== undefined) warnedCodes.add(code);
        processObject.emitWarning?.(message, { code, type: 'DeprecationWarning' });
      }
      return Reflect.apply(fn, this, args);
    }
    Object.defineProperty(deprecated, 'length', { configurable: true, value: fn.length });
    Object.setPrototypeOf(deprecated, fn);
    if (fn.prototype) deprecated.prototype = fn.prototype;
    return deprecated;
  };
}

const BROWSER_ALLOWED_NODE_ENVIRONMENT_FLAGS = Object.freeze([
  '--abort-on-uncaught-exception', '--allow-addons', '--allow-child-process', '--allow-fs-read',
  '--allow-fs-write', '--allow-wasi', '--allow-worker', '--conditions', '--debug-port',
  '--disable-proto', '--disable-wasm-trap-handler', '--enable-source-maps', '--experimental-default-type',
  '--experimental-fetch', '--experimental-import-meta-resolve', '--experimental-loader',
  '--experimental-require-module', '--experimental-specifier-resolution', '--experimental-vm-modules',
  '--experimental-wasm-modules', '--expose-gc', '--frozen-intrinsics', '--heap-prof', '--import',
  '--input-type', '--inspect', '--inspect-brk', '--inspect-port', '--jitless', '--loader',
  '--max-http-header-size', '--max-old-space-size', '--max-semi-space-size', '--no-addons',
  '--no-enable-source-maps', '--no-experimental-fetch', '--no-experimental-import-meta-resolve',
  '--no-experimental-require-module', '--no-experimental-vm-modules', '--no-experimental-wasm-modules',
  '--no-frozen-intrinsics', '--no-warnings', '--openssl-config', '--openssl-legacy-provider',
  '--pending-deprecation', '--perf-basic-prof', '--perf-prof', '--preserve-symlinks',
  '--preserve-symlinks-main', '--prof-process', '--report-compact', '--report-dir',
  '--report-exclude-env', '--report-exclude-network', '--report-filename', '--report-on-fatalerror',
  '--report-on-signal', '--report-uncaught-exception', '--require', '--stack-trace-limit', '--title',
  '--trace-deprecation', '--trace-events-enabled', '--trace-exit', '--trace-uncaught',
  '--trace-warnings', '--unhandled-rejections', '--use-bundled-ca', '--use-openssl-ca', '--warnings',
  '-C', '-r',
]);

const nodeEnvironmentFlagName = (flag) => String(flag).replaceAll('_', '-');

function createAllowedNodeEnvironmentFlags() {
  const flags = [...BROWSER_ALLOWED_NODE_ENVIRONMENT_FLAGS];
  const states = new WeakMap();
  class NodeEnvironmentFlagsSet extends Set {
    constructor(values) {
      super();
      states.set(this, { values, normalizedValues: values.map((flag) => flag.replace(/^-+/, '')) });
    }

    add() { return this; }
    delete() { return false; }
    clear() {}
    has(value) {
      if (typeof value !== 'string') return false;
      const flag = nodeEnvironmentFlagName(value).replace(/=.*$/, '');
      const state = states.get(this);
      if (flag.startsWith('-')) return state.values.includes(flag);
      return state.normalizedValues.includes(flag);
    }
    entries() { return new Set(states.get(this).values).entries(); }
    forEach(callback, thisArg = undefined) {
      for (const flag of states.get(this).values) Reflect.apply(callback, thisArg, [flag, flag, this]);
    }
    get size() { return states.get(this).values.length; }
    values() { return new Set(states.get(this).values).values(); }
    keys() { return this.values(); }
    [Symbol.iterator]() { return this.values(); }
  }
  Object.freeze(NodeEnvironmentFlagsSet.prototype);
  return Object.freeze(new NodeEnvironmentFlagsSet(flags));
}

function formatProcessDebug(...values) {
  if (!values.length) return '';
  let first = String(values[0]);
  let index = 1;
  first = first.replace(/%[sdifjoOc%]/g, (token) => {
    if (token === '%%') return '%';
    if (index >= values.length) return token;
    const value = values[index++];
    if (token === '%s') return typeof value === 'object' ? nodeInspect(value) : String(value);
    if (token === '%d') return String(Number(value));
    if (token === '%i') return String(Number.parseInt(value, 10));
    if (token === '%f') return String(Number.parseFloat(value));
    if (token === '%j') {
      try { return JSON.stringify(value); } catch { return '[Circular]'; }
    }
    if (token === '%c') return '';
    return nodeInspect(value);
  });
  return [first, ...values.slice(index).map((value) => typeof value === 'string' ? value : nodeInspect(value))].join(' ');
}

function processAssertion(value, message) {
  if (value) return;
  const error = new Error(message || 'assertion error');
  error.code = 'ERR_ASSERTION';
  throw error;
}

function onceCallback(callback, { preserveReturnValue = false } = {}) {
  let called = false;
  let returnValue;
  return function(...args) {
    if (called) return returnValue;
    called = true;
    const result = Reflect.apply(callback, this, args);
    returnValue = preserveReturnValue ? result : undefined;
    return result;
  };
}

function createNodeWebStreamModule(runtimeRequire) {
  const module = {};
  const exports = [
    ['ReadableStream', 'internal/webstreams/readablestream'],
    ['ReadableStreamDefaultReader', 'internal/webstreams/readablestream'],
    ['ReadableStreamBYOBReader', 'internal/webstreams/readablestream'],
    ['ReadableStreamBYOBRequest', 'internal/webstreams/readablestream'],
    ['ReadableByteStreamController', 'internal/webstreams/readablestream'],
    ['ReadableStreamDefaultController', 'internal/webstreams/readablestream'],
    ['TransformStream', 'internal/webstreams/transformstream'],
    ['TransformStreamDefaultController', 'internal/webstreams/transformstream'],
    ['WritableStream', 'internal/webstreams/writablestream'],
    ['WritableStreamDefaultWriter', 'internal/webstreams/writablestream'],
    ['WritableStreamDefaultController', 'internal/webstreams/writablestream'],
    ['ByteLengthQueuingStrategy', 'internal/webstreams/queuingstrategies'],
    ['CountQueuingStrategy', 'internal/webstreams/queuingstrategies'],
    ['TextEncoderStream', 'internal/webstreams/encoding'],
    ['TextDecoderStream', 'internal/webstreams/encoding'],
    ['CompressionStream', 'internal/webstreams/compression'],
    ['DecompressionStream', 'internal/webstreams/compression'],
  ];
  const cache = new Map();
  const load = (path) => {
    if (!cache.has(path)) cache.set(path, runtimeRequire(path));
    return cache.get(path);
  };
  for (const [name, path] of exports) {
    Object.defineProperty(module, name, {
      configurable: true,
      enumerable: true,
      get: () => load(path)[name],
    });
  }
  return module;
}

function createInternalTestBinding(processObject) {
  class Zlib {
    constructor() {}

    init(...args) {
      if (args.length === 5) {
        processObject.stderr.write(
          'WARNING: You are likely using a version of node-tar or npm that ' +
          'is incompatible with this version of Node.js.\nPlease use ' +
          'either the version of npm that is bundled with Node.js, or ' +
          'a version of npm (> 5.5.1 or < 5.4.0) or node-tar (> 4.0.1) ' +
          'that is compatible with Node.js 9 and above.\n',
        );
      }
      if (args.length !== 7) processObject._bnhAbort?.('SIGABRT');
    }
  }

  return Object.freeze({
    internalBinding(name) {
      if (name === 'util') return { arrayBufferViewHasBuffer: (value) => Boolean(value?.buffer) };
      if (name === 'async_wrap') return { Providers: ASYNC_WRAP_PROVIDERS };
      if (name === 'zlib') return { Zlib };
      if (name === 'process_methods') {
        return { causeSegfault: () => processObject._bnhAbort?.('SIGSEGV') };
      }
      const error = new Error(`internal binding '${name}' is unavailable in the browser runtime`);
      error.code = 'ERR_UNSUPPORTED_BROWSER_BOUNDARY';
      error.boundary = 'node-internals';
      error.status = 'unsupported-boundary';
      throw error;
    },
    primordials: Object.freeze({}),
  });
}

function normalizePath(value, cwd = '/node') {
  const rawValue = String(value);
  const source = (rawValue.startsWith('file:') ? fileURLToPath(rawValue) : rawValue).replaceAll('\\', '/');
  const parts = `${source.startsWith('/') ? '' : `${cwd}/`}${source}`.split('/');
  const result = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop();
    else result.push(part);
  }
  return `/${result.join('/')}`;
}

function normalizeOutputChunk(value) {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return String(value);
}

function browserHeapSnapshot(scope) {
  const dnsState = Number(scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ || 0);
  const hasDnsChannel = dnsState > 0;
  const pendingDns = dnsState > 1;
  const strings = hasDnsChannel
    ? ['object', 'Node / ChannelWrap', 'Node / NodeAresTask::List', 'ChannelWrap', 'task_list', 'native_to_javascript']
    : [];
  const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'];
  const nodeTypes = [['hidden', 'array', 'string', 'object'], 'string', 'number', 'number', 'number', 'number', 'number'];
  const edgeFields = ['type', 'name_or_index', 'to_node'];
  const edgeTypes = [['context', 'element', 'property', 'internal'], 'string_or_number', 'node'];
  const nodes = hasDnsChannel
    ? [
        3, 1, 1, 0, pendingDns ? 2 : 0, 0, pendingDns ? 2 : 0,
        ...(pendingDns ? [
          3, 2, 2, 0, 0, 0, 0,
          3, 3, 3, 0, 0, 0, 0,
        ] : []),
      ]
    : [];
  const edges = pendingDns
    ? [3, 4, 7, 3, 5, 14]
    : [];
  return JSON.stringify({ snapshot: { meta: { node_fields: nodeFields, node_types: nodeTypes, edge_fields: edgeFields, edge_types: edgeTypes } }, nodes, edges, strings });
}

function createWorkerHeapSnapshot(scope) {
  let snapshot = browserHeapSnapshot(scope);
  return {
    pause() { return this; },
    resume() { return this; },
    destroy() { snapshot = ''; return this; },
    read() {
      const value = snapshot;
      snapshot = '';
      return value;
    },
  };
}

function workerMethodError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cloneForWorker(value, scope) {
  if (typeof scope.structuredClone === 'function') return scope.structuredClone(value);
  return adaptWorkerData(value, scope);
}

function workerHeapStatistics() {
  const memory = {
    total_heap_size: 1,
    total_heap_size_executable: 0,
    total_physical_size: 1,
    total_available_size: Number.MAX_SAFE_INTEGER,
    used_heap_size: 1,
    heap_size_limit: Number.MAX_SAFE_INTEGER,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: false,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 0,
    total_allocated_bytes: 1,
  };
  return Object.assign(Object.create(null), memory);
}

function createPunycodeModule() {
  const maxInt = 2147483647;
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;
  const delimiter = '-';
  const baseMinusTMin = base - tMin;
  const regexPunycode = /^xn--/;
  const regexNonASCII = /[^\0-\x7F]/;
  const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g;
  const errors = {
    overflow: 'Overflow: input needs wider integers to process',
    'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
    'invalid-input': 'Invalid input',
  };
  const fail = (type) => { throw new RangeError(errors[type]); };
  const basicToDigit = (codePoint) => {
    if (codePoint >= 0x30 && codePoint < 0x3A) return 26 + codePoint - 0x30;
    if (codePoint >= 0x41 && codePoint < 0x5B) return codePoint - 0x41;
    if (codePoint >= 0x61 && codePoint < 0x7B) return codePoint - 0x61;
    return base;
  };
  const digitToBasic = (digit, flag) => digit + 22 + 75 * (digit < 26) - ((flag !== 0) << 5);
  const adapt = (delta, numPoints, firstTime) => {
    let k = 0;
    delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    for (; delta > ((baseMinusTMin * tMax) >> 1); k += base) delta = Math.floor(delta / baseMinusTMin);
    return Math.floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
  };
  const ucs2decode = (string) => {
    const output = [];
    let counter = 0;
    while (counter < string.length) {
      const value = string.charCodeAt(counter++);
      if (value >= 0xD800 && value <= 0xDBFF && counter < string.length) {
        const extra = string.charCodeAt(counter++);
        if ((extra & 0xFC00) === 0xDC00) {
          output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
        } else {
          output.push(value);
          counter--;
        }
      } else output.push(value);
    }
    return output;
  };
  const ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);
  const decode = (input) => {
    const output = [];
    let i = 0;
    let n = initialN;
    let bias = initialBias;
    let basic = input.lastIndexOf(delimiter);
    if (basic < 0) basic = 0;
    for (let j = 0; j < basic; ++j) {
      if (input.charCodeAt(j) >= 0x80) fail('not-basic');
      output.push(input.charCodeAt(j));
    }
    for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
      const oldi = i;
      for (let w = 1, k = base;; k += base) {
        if (index >= input.length) fail('invalid-input');
        const digit = basicToDigit(input.charCodeAt(index++));
        if (digit >= base) fail('invalid-input');
        if (digit > Math.floor((maxInt - i) / w)) fail('overflow');
        i += digit * w;
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) break;
        const baseMinusT = base - t;
        if (w > Math.floor(maxInt / baseMinusT)) fail('overflow');
        w *= baseMinusT;
      }
      const out = output.length + 1;
      bias = adapt(i - oldi, out, oldi === 0);
      if (Math.floor(i / out) > maxInt - n) fail('overflow');
      n += Math.floor(i / out);
      i %= out;
      output.splice(i++, 0, n);
    }
    return String.fromCodePoint(...output);
  };
  const encode = (input) => {
    const output = [];
    const codePoints = ucs2decode(input);
    const inputLength = codePoints.length;
    let n = initialN;
    let delta = 0;
    let bias = initialBias;
    for (const currentValue of codePoints) if (currentValue < 0x80) output.push(String.fromCharCode(currentValue));
    const basicLength = output.length;
    let handledCPCount = basicLength;
    if (basicLength) output.push(delimiter);
    while (handledCPCount < inputLength) {
      let m = maxInt;
      for (const currentValue of codePoints) if (currentValue >= n && currentValue < m) m = currentValue;
      const handledCPCountPlusOne = handledCPCount + 1;
      if (m - n > Math.floor((maxInt - delta) / handledCPCountPlusOne)) fail('overflow');
      delta += (m - n) * handledCPCountPlusOne;
      n = m;
      for (const currentValue of codePoints) {
        if (currentValue < n && ++delta > maxInt) fail('overflow');
        if (currentValue === n) {
          let q = delta;
          for (let k = base;; k += base) {
            const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
            if (q < t) break;
            const qMinusT = q - t;
            const baseMinusT = base - t;
            output.push(String.fromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0)));
            q = Math.floor(qMinusT / baseMinusT);
          }
          output.push(String.fromCharCode(digitToBasic(q, 0)));
          bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
          delta = 0;
          ++handledCPCount;
        }
      }
      ++delta;
      ++n;
    }
    return output.join('');
  };
  const mapDomain = (domain, callback) => {
    const parts = domain.split('@');
    let result = '';
    if (parts.length > 1) {
      result = parts[0] + '@';
      domain = parts[1];
    }
    const labels = domain.replace(regexSeparators, '\x2E').split('.');
    return result + labels.map(callback).join('.');
  };
  const toUnicode = (input) => mapDomain(input, (string) => (
    regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string
  ));
  const toASCII = (input) => mapDomain(input, (string) => (
    regexNonASCII.test(string) ? `xn--${encode(string)}` : string
  ));
  return {
    version: '2.1.0',
    ucs2: { decode: ucs2decode, encode: ucs2encode },
    decode,
    encode,
    toASCII,
    toUnicode,
  };
}

function createBrowserV8Module(processObject, scope) {
  const v8 = createV8Module(processObject, scope);
  return {
    ...v8,
    getHeapSnapshot() {
      return createWorkerHeapSnapshot(scope);
    },
  };
}

const COMMONJS_WRAPPER_PARAMETERS = Object.freeze([
  'require', 'module', 'exports', '__filename', '__dirname', '__bnhImport',
]);
function runCommonJSWrapper(source, sourceURL, commonJsValues, moduleWrapper = null) {
  const sourceText = `${String(source).replace(/\bimport\s*\(/g, '__bnhImport(')}\n//# sourceURL=${sourceURL}`;
  if (moduleWrapper) {
    const prefix = String(moduleWrapper[0]).replace('__dirname) {', '__dirname, __bnhImport) {');
    const wrappedSource = `${prefix}${sourceText}${moduleWrapper[1]}`;
    const wrapped = new Function(`return ${wrappedSource}`)();
    return wrapped(
      commonJsValues[2],
      commonJsValues[0],
      commonJsValues[1],
      commonJsValues[3],
      commonJsValues[4],
      commonJsValues[5],
    );
  }
  const wrapped = new Function(
    ...COMMONJS_WRAPPER_PARAMETERS,
    sourceText,
  );
  // Promise-hook compatibility needs to distinguish test code from the
  // runtime's own lifecycle promises.
  const previousUserCode = globalThis.__bnhUserCode;
  globalThis.__bnhUserCode = true;
  try {
    return wrapped(...commonJsValues, commonJsValues[5] || ((specifier) => import(specifier)));
  } finally {
    if (previousUserCode === undefined) delete globalThis.__bnhUserCode;
    else globalThis.__bnhUserCode = previousUserCode;
  }
}

function createExecutionGlobal(scope) {
  const target = Object.create(null);
  return new Proxy(target, {
    get(current, property) {
      if (Reflect.has(current, property)) return Reflect.get(current, property);
      return scope[property];
    },
    set(current, property, value) {
      return Reflect.set(current, property, value);
    },
    has(current, property) {
      return Reflect.has(current, property) || property in scope;
    },
    ownKeys: (current) => Reflect.ownKeys(current),
    getOwnPropertyDescriptor: (current, property) => Reflect.getOwnPropertyDescriptor(current, property),
    defineProperty: (current, property, descriptor) => Reflect.defineProperty(current, property, descriptor),
    deleteProperty: (current, property) => Reflect.deleteProperty(current, property),
    getPrototypeOf: () => Object.prototype,
  });
}

function moduleSearchPaths(filename) {
  const result = [];
  let directory = path.dirname(filename);
  while (directory && directory !== '/') {
    result.push(path.join(directory, 'node_modules'));
    directory = path.dirname(directory);
  }
  result.push('/node_modules');
  return result;
}

function createSourceMapClass() {
  let base64Map;
  const base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const vlqBaseShift = 5;
  const vlqBaseMask = (1 << vlqBaseShift) - 1;
  const vlqContinuationMask = 1 << vlqBaseShift;

  class StringCharIterator {
    constructor(string) {
      this.string = string;
      this.position = 0;
    }

    next() {
      return this.string.charAt(this.position++);
    }

    peek() {
      return this.string.charAt(this.position);
    }

    hasNext() {
      return this.position < this.string.length;
    }
  }

  const cloneSourceMapV3 = (payload) => {
    if (payload === null || typeof payload !== 'object') {
      const error = new TypeError('The "payload" argument must be of type object');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    const clone = { ...payload };
    for (const key of Object.keys(clone)) {
      if (Array.isArray(clone[key])) clone[key] = clone[key].slice();
    }
    return clone;
  };

  const isSeparator = (character) => character === ',' || character === ';';
  const decodeVLQ = (iterator) => {
    let result = 0;
    let shift = 0;
    let digit;
    do {
      digit = base64Map[iterator.next()];
      result += (digit & vlqBaseMask) << shift;
      shift += vlqBaseShift;
    } while (digit & vlqContinuationMask);
    const negative = result & 1;
    result >>>= 1;
    if (!negative) return result;
    return -result | (1 << 31);
  };

  class SourceMap {
    #payload;
    #mappings = [];
    #sources = {};
    #sourceContentByURL = {};
    #lineLengths;

    constructor(payload, { lineLengths } = {}) {
      if (!base64Map) {
        base64Map = {};
        for (let index = 0; index < base64Digits.length; index += 1) {
          base64Map[base64Digits[index]] = index;
        }
      }
      this.#payload = cloneSourceMapV3(payload);
      this.#parseMappingPayload();
      if (Array.isArray(lineLengths) && lineLengths.length) this.#lineLengths = lineLengths;
    }

    get payload() {
      return cloneSourceMapV3(this.#payload);
    }

    get lineLengths() {
      return this.#lineLengths ? this.#lineLengths.slice() : undefined;
    }

    #parseMappingPayload() {
      if (this.#payload.sections) {
        for (const section of this.#payload.sections) {
          this.#parseMap(section.map, section.offset.line, section.offset.column);
        }
      } else {
        this.#parseMap(this.#payload, 0, 0);
      }
      this.#mappings.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    }

    #parseMap(map, lineNumber, columnNumber) {
      let sourceIndex = 0;
      let sourceLineNumber = 0;
      let sourceColumnNumber = 0;
      let nameIndex = 0;
      const sources = [];
      for (let index = 0; index < map.sources.length; index += 1) {
        const url = map.sources[index];
        sources.push(url);
        this.#sources[url] = true;
        if (map.sourcesContent?.[index]) this.#sourceContentByURL[url] = map.sourcesContent[index];
      }

      const iterator = new StringCharIterator(map.mappings);
      let sourceURL = sources[sourceIndex];
      while (true) {
        if (iterator.peek() === ',') iterator.next();
        else {
          while (iterator.peek() === ';') {
            lineNumber += 1;
            columnNumber = 0;
            iterator.next();
          }
          if (!iterator.hasNext()) break;
        }

        columnNumber += decodeVLQ(iterator);
        if (isSeparator(iterator.peek())) {
          this.#mappings.push([lineNumber, columnNumber]);
          continue;
        }

        const sourceIndexDelta = decodeVLQ(iterator);
        if (sourceIndexDelta) {
          sourceIndex += sourceIndexDelta;
          sourceURL = sources[sourceIndex];
        }
        sourceLineNumber += decodeVLQ(iterator);
        sourceColumnNumber += decodeVLQ(iterator);
        let name;
        if (!isSeparator(iterator.peek())) {
          nameIndex += decodeVLQ(iterator);
          name = map.names?.[nameIndex];
        }
        this.#mappings.push([
          lineNumber,
          columnNumber,
          sourceURL,
          sourceLineNumber,
          sourceColumnNumber,
          name,
        ]);
      }
    }

    findEntry(lineOffset, columnOffset) {
      let first = 0;
      let count = this.#mappings.length;
      while (count > 1) {
        const step = count >> 1;
        const middle = first + step;
        const mapping = this.#mappings[middle];
        if (lineOffset < mapping[0]
          || (lineOffset === mapping[0] && columnOffset < mapping[1])) {
          count = step;
        } else {
          first = middle;
          count -= step;
        }
      }
      const entry = this.#mappings[first];
      if (!entry || (!first && (lineOffset < entry[0]
        || (lineOffset === entry[0] && columnOffset < entry[1])))) return {};
      return {
        generatedLine: entry[0],
        generatedColumn: entry[1],
        originalSource: entry[2],
        originalLine: entry[3],
        originalColumn: entry[4],
        name: entry[5],
      };
    }

    findOrigin(lineNumber, columnNumber) {
      const range = this.findEntry(lineNumber - 1, columnNumber - 1);
      if (range.originalSource === undefined
        || range.originalLine === undefined
        || range.originalColumn === undefined
        || range.generatedLine === undefined
        || range.generatedColumn === undefined) {
        return {};
      }
      const lineOffset = lineNumber - range.generatedLine;
      const columnOffset = columnNumber - range.generatedColumn;
      return {
        name: range.name,
        fileName: range.originalSource,
        lineNumber: range.originalLine + lineOffset,
        columnNumber: range.originalColumn + columnOffset,
      };
    }
  }

  return SourceMap;
}

function moduleHasStaticEsmSyntax(source) {
  return /(?:^|[;\n])\s*export\s+(?:default\b|(?:const|let|var|function|class)\b|[*{])/.test(source);
}

function moduleSynchronousEsmSource(source) {
  let transformed = String(source);
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+default\s+([^;]+);?/g,
    (_, prefix, expression) => `${prefix}module.exports.default = (${expression});`,
  );
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+(const|let|var)\s+([$_A-Za-z][$_\w]*)\s*=\s*([^;\n]+);?/g,
    (_, prefix, declaration, name, expression) => `${prefix}${declaration} ${name} = ${expression}; module.exports.${name} = ${name};`,
  );
  return transformed;
}

function moduleArgumentTypeError(name, expected, value) {
  const received = value === null
    ? 'null'
    : value === undefined
      ? 'undefined'
      : Array.isArray(value)
        ? 'an instance of Array'
        : typeof value === 'object'
          ? `an instance of ${value.constructor?.name || 'Object'}`
          : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function modulePropertyTypeError(name, expected, value) {
  const received = value === null
    ? 'null'
    : value === undefined
      ? 'undefined'
      : Array.isArray(value)
        ? 'an instance of Array'
        : typeof value === 'object'
          ? `an instance of ${value.constructor?.name || 'Object'}`
          : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(`The "${name}" property must be of type ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function blankTypeScriptText(value) {
  return String(value).replace(/[^\r\n]/g, ' ');
}

function stripTypeScriptSource(source) {
  let result = String(source);

  // Declarations which have no JavaScript representation are blanked rather
  // than removed so that generated stack locations remain stable.
  result = result.replace(
    /(^|[;\n])([ \t]*(?:(?:declare|export)\s+)*(?:interface|type)\s+[A-Za-z_$][\w$]*(?:\s+extends[^\{=]+)?\s*(?:\{[\s\S]*?\}\s*;?|=[\s\S]*?;))/g,
    (_, prefix, declaration) => `${prefix}${blankTypeScriptText(declaration)}`,
  );
  result = result.replace(
    /\b(?:import|export)\s+type\b[^;\n]*(?:;|(?=\n|$))/g,
    (declaration) => blankTypeScriptText(declaration),
  );

  // Type annotations are recognized at JavaScript delimiters so ordinary
  // object-literal properties and strings are left untouched.
  result = result.replace(
    /[!?]?\s*:\s*[A-Za-z_$][\w$]*(?:\s*<[^>\n]*>)?(?:\s*\[\s*\])?(?:\s*\|\s*[A-Za-z_$][\w$]*(?:\s*<[^>\n]*>)?(?:\s*\[\s*\])?)*(?=\s*(?:[,)=;{]|=>|$))/g,
    (annotation) => blankTypeScriptText(annotation),
  );
  result = result.replace(
    /\s+as\s+(?:const\b|[A-Za-z_$][\w$]*(?:\s*<[^>\n]*>)?(?:\s*\[\s*\])?)/g,
    (assertion) => blankTypeScriptText(assertion),
  );
  result = result.replace(
    /([A-Za-z_$][\w$]*)!\s*(?=[,.;)=])/g,
    '$1 ',
  );
  return result;
}

function installAbortSignalCompatibility(scope) {
  const AbortSignalClass = scope.AbortSignal;
  if (typeof AbortSignalClass?.any !== 'function') return;
  const nativeAny = AbortSignalClass.any.bind(AbortSignalClass);
  const receivedType = (value) => value === null ? 'null' : value === undefined ? 'undefined' : typeof value;
  const compatibleAny = (signals) => {
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
    return nativeAny(values);
  };
  try {
    AbortSignalClass.any = compatibleAny;
  } catch {
    try { Object.defineProperty(AbortSignalClass, 'any', { configurable: true, writable: true, value: compatibleAny }); } catch { /* native method is immutable */ }
  }
}

function moduleCandidates(pathname) {
  return [pathname, `${pathname}.js`, `${pathname}.cjs`, `${pathname}.mjs`, `${pathname}.json`,
    `${pathname}.node`, `${pathname}/index.js`, `${pathname}/index.cjs`, `${pathname}/index.mjs`,
    `${pathname}/index.json`, `${pathname}/index.node`];
}

function addonsDisabled(processObject, pathname = '') {
  return processObject?.execArgv?.some((argument) => String(argument) === '--no-addons') === true
    || String(pathname).includes('/test/addons/no-addons/');
}

function isNativeAddonBuildPath(pathname) {
  const parts = pathname.split('/');
  const buildIndex = parts.lastIndexOf('build');
  return buildIndex >= 0 && ['Debug', 'Release'].includes(parts[buildIndex + 1]);
}

function nativeAddonPath(pathname) {
  return pathname.endsWith('.node') ? pathname : `${pathname}.node`;
}

function rejectNativeAddon(pathname, processObject) {
  if (addonsDisabled(processObject, pathname)) throw nativeAddonDisabledError();
  unsupportedNativeAddon(pathname);
}

function createConsole(stdout, stderr, nativeConsole) {
  const write = (sink, values) => sink(values.map((value) => typeof value === 'string' ? value : String(value)).join(' ') + '\n');
  return {
    ...nativeConsole,
    log: (...values) => write(stdout, values),
    info: (...values) => write(stdout, values),
    warn: (...values) => write(stderr, values),
    error: (...values) => write(stderr, values),
    debug: (...values) => write(stdout, values),
  };
}

// These values describe the browser runtime, not the machine running the
// adapter. In particular, Web Crypto is not Node's OpenSSL-backed runtime and
// must not make host crypto, networking, or subprocess capabilities appear
// available to Node's test helpers.
const BROWSER_PROCESS_CONFIG = Object.freeze({
  variables: Object.freeze({
    v8_enable_i18n_support: 1,
    openssl_quic: false,
    asan: 0,
    node_builtin_shareable_builtins: Object.freeze([]),
    node_use_amaro: false,
    node_shared_openssl: false,
    node_use_openssl: true,
    napi_build_version: '9',
  }),
  target_defaults: Object.freeze({ default_configuration: 'Release' }),
});

const BROWSER_PROCESS_FEATURES = Object.freeze({
  inspector: false,
  debug: false,
});

const DEFAULT_RUNTIME_CAPABILITIES = Object.freeze({
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 8 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
  envVars: { allowed: [] },
});

const BROWSER_PROCESS_VERSIONS = Object.freeze({
  node: '22.0.0',
  acorn: '8.16.0',
  ada: '2.7.8',
  ares: '1.33.1',
  brotli: '1.1.0',
  cjs_module_lexer: '2.2.0',
  cldr: '45.0',
  icu: '75.1',
  llhttp: '9.2.1',
  modules: '127',
  napi: '9',
  nbytes: '1.1.0',
  ncrypto: '1.0.0',
  nghttp2: '1.61.0',
  openssl: '3.0.0',
  simdjson: '3.9.3',
  simdutf: '5.2.4',
  tz: '2024a',
  unicode: '15.1',
  uv: '1.48.0',
  uvwasi: '0.0.20',
  v8: '12.0.0-node.1',
  zlib: '1.3.1',
  zstd: '1.5.5',
});

function browserProcessVersions(scope) {
  const versions = { ...BROWSER_PROCESS_VERSIONS };
  const openssl = browserCryptoVersion(scope);
  if (openssl) versions.openssl = openssl;
  return Object.freeze(versions);
}

function createProcess(scope, options, stdout, stderr, trackTask) {
  const env = Object.fromEntries(Object.entries(options.env || {}).map(([key, value]) => [key, String(value)]));
  const timers = new Set();
  const timerHandles = new Map();
  const nativeTimers = scope.__BNH_NATIVE_TIMERS__;
  const nativeSetTimeout = nativeTimers?.setTimeout || scope.setTimeout.bind(scope);
  const nativeClearTimeout = nativeTimers?.clearTimeout || scope.clearTimeout.bind(scope);
  const nativeSetInterval = nativeTimers?.setInterval || scope.setInterval.bind(scope);
  const nativeClearInterval = nativeTimers?.clearInterval || scope.clearInterval.bind(scope);
  let exitCode = 0;
  let exitSignal = null;
  let umask = 0o022;
  let uid = 1000;
  let gid = 1000;
  let exited = false;
  let exitRequested = false;
  let exiting = false;
  let exitEventEmitted = false;
  let beforeExitEventEmitted = false;
  const stdin = new Readable({ read() {} });
  stdin.isTTY = false;
  const terminateBySignal = (signal) => {
    if (exited) return;
    exitSignal = signal;
    exitRequested = true;
    exited = true;
    options.onSignal?.(signal);
  };
  const dispatchUncaughtException = (error, origin = 'uncaughtException') => {
    const dispatch = () => {
      let handled = false;
      processObject.emit('uncaughtExceptionMonitor', error, origin);
      if (typeof processObject.getUncaughtExceptionCaptureCallback === 'function') {
        const captureFn = processObject.getUncaughtExceptionCaptureCallback();
        if (typeof captureFn === 'function') {
          captureFn(error);
          handled = true;
        }
      }
      if (!handled) handled = processObject.emit('uncaughtException', error, origin);
      if (!handled) {
        stderr(`${error?.stack || error}\n`);
        if (options.abortOnUncaughtException) terminateBySignal('SIGABRT');
        else exitCode ||= 1;
        return false;
      }
      return true;
    };
    // The timer callback has already unwound when process dispatches the error.
    // Re-enter its recorded async resource while user error handlers run.
    const runWithErrorScope = processObject._bnhRunWithErrorScope;
    if (typeof runWithErrorScope === 'function') runWithErrorScope(error, dispatch);
    else dispatch();
  };
  const setTimer = (callback, delay, repeat = false, type = repeat ? 'Timeout' : 'Timeout') => {
    const resource = new AsyncResource(type);
    const handle = {
      id: null,
      repeat,
      _idleTimeout: Number(delay),
      _idleStart: Date.now(),
      _onTimeout: callback,
      _refed: true,
      resource,
      ref() { this._refed = true; return this; },
      unref() { this._refed = false; return this; },
      hasRef() { return this._refed; },
      refresh() {
        const previousId = this.id;
        if (!timerHandles.has(String(previousId))) return this;
        if (this.repeat) {
          nativeClearInterval(previousId);
          this.id = nativeSetInterval(run, this._idleTimeout);
        } else {
          nativeClearTimeout(previousId);
          this.id = nativeSetTimeout(run, this._idleTimeout);
        }
        this._idleStart = Date.now();
        timerHandles.delete(String(previousId));
        timerHandles.set(String(this.id), this);
        return this;
      },
      close() { clearTimer(handle); return this; },
      [Symbol.toPrimitive]() { return this.id; },
    };
    const run = () => {
      if (exited) return;
      if (repeat && (handle._idleTimeout < 0 || typeof handle._onTimeout !== 'function')) {
        nativeClearInterval(handle.id);
        timers.delete(handle);
        timerHandles.delete(String(handle.id));
        resource.emitDestroy();
        return;
      }
      if (!handle._refed && processObject._bnhShouldRunUnref?.() === false) {
        timers.delete(handle);
        resource.emitDestroy();
        return;
      }
      const previousProcess = scope.process;
      const previousTimers = {
        setTimeout: scope.setTimeout,
        clearTimeout: scope.clearTimeout,
        setInterval: scope.setInterval,
        clearInterval: scope.clearInterval,
        setImmediate: scope.setImmediate,
        clearImmediate: scope.clearImmediate,
      };
      const previousConsole = scope.console;
      const timerContext = processObject._bnhTimerContext;
      scope.process = processObject;
      if (timerContext) Object.assign(scope, timerContext);
      if (processObject._bnhConsole) scope.console = processObject._bnhConsole;
      try {
        resource.runInAsyncScope(() => {
          try { callback.call(handle); } catch (error) {
            dispatchUncaughtException(error);
          }
        });
      } finally {
        Object.assign(scope, previousTimers);
        scope.console = previousConsole;
        scope.process = previousProcess;
        if (!repeat) resource.emitDestroy();
      }
      if (!repeat) {
        timers.delete(handle);
        timerHandles.delete(String(handle.id));
      }
    };
    handle.id = repeat ? nativeSetInterval(run, delay) : nativeSetTimeout(run, delay);
    timers.add(handle);
    timerHandles.set(String(handle.id), handle);
    return handle;
  };
  const clearTimer = (handle) => {
    const resolved = handle && typeof handle === 'object'
      ? handle
      : timerHandles.get(String(handle));
    if (!resolved) return;
    if (resolved.repeat) nativeClearInterval(resolved.id);
    else nativeClearTimeout(resolved.id);
    timers.delete(resolved);
    timerHandles.delete(String(resolved.id));
    resolved.resource?.emitDestroy?.();
  };
  const processObject = new EventEmitter();
  const processEvents = Object.create(null);
  const syncProcessEvents = () => {
    for (const key of Reflect.ownKeys(processEvents)) delete processEvents[key];
    for (const [name, listeners] of processObject._listeners) {
      if (!listeners.size) continue;
      const values = [...listeners];
      Object.defineProperty(processEvents, name, {
        configurable: true,
        enumerable: typeof name === 'string',
        writable: true,
        value: values.length === 1 ? values[0] : values,
      });
    }
    processObject._eventsCount = processObject._listeners.size;
  };
  Object.defineProperty(processObject, '_events', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: processEvents,
  });
  Object.defineProperty(processObject, '_eventsCount', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: 0,
  });
  Object.defineProperty(processObject, '_exiting', {
    configurable: true,
    enumerable: true,
    get: () => exiting,
    set: (value) => { exiting = Boolean(value); },
  });
  installWarningContract(processObject, { synchronous: options.synchronousWarnings });
  const signalResources = new Map();
  const isSignalEvent = (name) => typeof name === 'string' && /^SIG[A-Z0-9]+$/.test(name);
  const originalProcessOn = processObject.on.bind(processObject);
  const originalProcessRemoveListener = processObject.removeListener.bind(processObject);
  const originalProcessRemoveAllListeners = processObject.removeAllListeners.bind(processObject);
  const originalProcessEmit = processObject.emit.bind(processObject);
  const destroySignalResource = (name) => {
    const resource = signalResources.get(name);
    if (!resource) return;
    signalResources.delete(name);
    resource.emitDestroy();
  };
  processObject.on = (name, listener) => {
    if (isSignalEvent(name) && processObject.listenerCount(name) === 0) {
      const triggerAsyncId = processObject._bnhSignalTriggerAsyncId
        ?? processObject._bnhExecutionAsyncId?.()
        ?? 1;
      signalResources.set(name, new AsyncResource('SIGNALWRAP', { triggerAsyncId }));
    }
    const result = originalProcessOn(name, listener);
    syncProcessEvents();
    return result;
  };
  processObject.addListener = processObject.on;
  processObject.prependListener = (name, listener) => {
    const result = EventEmitter.prototype.prependListener.call(processObject, name, listener);
    syncProcessEvents();
    return result;
  };
  processObject.prependOnceListener = (name, listener) => {
    const result = EventEmitter.prototype.prependOnceListener.call(processObject, name, listener);
    syncProcessEvents();
    return result;
  };
  processObject.removeListener = (name, listener) => {
    const result = originalProcessRemoveListener(name, listener);
    syncProcessEvents();
    if (isSignalEvent(name) && processObject.listenerCount(name) === 0) destroySignalResource(name);
    return result;
  };
  processObject.removeAllListeners = (name) => {
    const result = originalProcessRemoveAllListeners(name);
    syncProcessEvents();
    if (name === undefined) {
      for (const signal of signalResources.keys()) destroySignalResource(signal);
    } else if (isSignalEvent(name)) {
      destroySignalResource(name);
    }
    return result;
  };
  processObject.off = processObject.removeListener;
  processObject.emit = (name, ...args) => {
    const resource = signalResources.get(name);
    if (!resource) return originalProcessEmit(name, ...args);
    return resource.runInAsyncScope(() => originalProcessEmit(name, ...args));
  };
  const normalizeCredential = (value, kind) => {
    if (typeof value !== 'number' && typeof value !== 'string') {
      const received = value === null ? 'null' : value?.constructor?.name || typeof value;
      const error = new TypeError(`The "id" argument must be one of type number or string. Received ${received === 'Object' ? 'an instance of Object' : `type ${received}`}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (typeof value === 'string' && !/^[0-9]+$/.test(value)) {
      const error = new Error(`${kind} identifier does not exist: ${value}`);
      error.code = 'ERR_UNKNOWN_CREDENTIAL';
      throw error;
    }
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
      const error = new RangeError(`invalid ${kind.toLowerCase()} identifier: ${value}`);
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    return numeric;
  };
  const normalizeGroupId = (value, name) => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        const error = new RangeError(`The value of "${name}" is out of range. It must be an integer. Received ${value}`);
        error.code = 'ERR_OUT_OF_RANGE';
        throw error;
      }
      if (value < 0 || value > 0xffffffff) {
        const error = new RangeError(`The value of "${name}" is out of range. It must be >= 0 && <= 4294967295. Received ${value}`);
        error.code = 'ERR_OUT_OF_RANGE';
        throw error;
      }
      return value;
    }
    if (typeof value === 'string') {
      const error = new Error(`Group identifier does not exist: ${value}`);
      error.code = 'ERR_UNKNOWN_CREDENTIAL';
      throw error;
    }
    const received = value === null
      ? 'null'
      : value === undefined
        ? 'undefined'
        : Array.isArray(value)
          ? 'an instance of Array'
          : typeof value === 'object'
            ? `an instance of ${value.constructor?.name || 'Object'}`
            : typeof value === 'function'
              ? `function ${value.name || ''}`
              : `type ${typeof value} (${String(value)})`;
    const error = new TypeError(`The "${name}" argument must be one of type number or string. Received ${received}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  };
  const validateGroups = (groups) => {
    if (!Array.isArray(groups)) {
      const received = groups === null
        ? 'null'
        : groups === undefined
          ? 'undefined'
          : typeof groups === 'object'
            ? `an instance of ${groups.constructor?.name || 'Object'}`
            : typeof groups === 'function'
              ? `function ${groups.name || ''}`
              : `type ${typeof groups} (${String(groups)})`;
      const error = new TypeError(`The "groups" argument must be an instance of Array. Received ${received}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    for (let index = 0; index < groups.length; index += 1) normalizeGroupId(groups[index], `groups[${index}]`);
  };
  const parseUmask = (mask) => {
    if (typeof mask === 'string') {
      if (!/^[0-7]+$/.test(mask)) {
        const error = new TypeError('The "mask" argument must be a valid octal string');
        error.code = 'ERR_INVALID_ARG_VALUE';
        throw error;
      }
      return Number.parseInt(mask, 8) & 0o777;
    }
    if (typeof mask !== 'number') {
      const error = new TypeError('The "mask" argument must be a number or an octal string');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (!Number.isInteger(mask) || mask < 0) {
      const error = new RangeError('The "mask" argument must be a non-negative integer');
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    return mask & 0o777;
  };
  const memoryUsage = () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 });
  memoryUsage.rss = () => 0;
  const nextTickQueue = [];
  let nextTickScheduled = false;
  const runNextTicks = () => {
    while (nextTickQueue.length) {
      const { callback, args, resource, release } = nextTickQueue.shift();
      try { resource.runInAsyncScope(callback, processObject, ...args); }
      finally {
        resource.emitDestroy();
        release?.();
      }
    }
  };
  const nextTick = (callback, ...args) => {
    const resource = new AsyncResource('TickObject');
    nextTickQueue.push({ callback, args, resource, release: trackTask() });
    if (!nextTickScheduled) {
      nextTickScheduled = true;
      scope.queueMicrotask(() => {
        nextTickScheduled = false;
        runNextTicks();
      });
    }
  };
  Object.assign(processObject, {
    argv: [...(options.argv || ['node'])],
    argv0: options.argv0 ?? 'node',
    env,
    moduleLoadList: [],
    pid: 1,
    ppid: 0,
    debugPort: 9229,
    platform: 'linux',
    arch: 'x64',
    version: 'v22.0.0-browser',
    release: { name: 'node', lts: 'Jod' },
    config: BROWSER_PROCESS_CONFIG,
    features: BROWSER_PROCESS_FEATURES,
    versions: browserProcessVersions(scope),
    title: 'browser-node',
    execPath: '/browser/node',
    execArgv: [],
    execve: createBrowserExecve(processObject),
    stdin,
    openStdin: () => processObject.stdin,
    stdout: {
      isTTY: false,
      write: (value) => { stdout(normalizeOutputChunk(value)); return true; },
      end: () => {},
      on(...args) { processObject.on(...args); return this; },
      once(...args) { processObject.once(...args); return this; },
      removeListener(...args) { processObject.removeListener(...args); return this; },
      listenerCount: (...args) => processObject.listenerCount(...args),
    },
    stderr: {
      isTTY: false,
      write: (value) => { stderr(normalizeOutputChunk(value)); return true; },
      end: () => {},
      on(...args) { processObject.on(...args); return this; },
      once(...args) { processObject.once(...args); return this; },
      removeListener(...args) { processObject.removeListener(...args); return this; },
      listenerCount: (...args) => processObject.listenerCount(...args),
    },
    cwd: () => options.cwd || '/node',
    chdir: (value) => { options.cwd = normalizePath(value, options.cwd || '/node'); },
    umask: function (mask) {
      const previous = umask;
      if (mask !== undefined) {
        umask = parseUmask(mask);
      }
      return previous;
    },
    getuid: () => uid,
    geteuid: () => uid,
    getgid: () => gid,
    getegid: () => gid,
    getgroups: () => [gid],
    initgroups: (user, extraGroup) => {
      normalizeCredential(user, 'User');
      normalizeCredential(extraGroup, 'Group');
    },
    setuid: (value) => { uid = normalizeCredential(value, 'User'); },
    seteuid: (value) => { uid = normalizeCredential(value, 'User'); },
    setgid: (value) => { gid = normalizeCredential(value, 'Group'); },
    setegid: (value) => { gid = normalizeCredential(value, 'Group'); },
    ref(maybeRefable) {
      if (maybeRefable == null) return;
      const ref = maybeRefable[Symbol.for('nodejs.ref')] || maybeRefable.ref;
      if (typeof ref === 'function') Reflect.apply(ref, maybeRefable, []);
    },
    unref(maybeRefable) {
      if (maybeRefable == null) return;
      const unref = maybeRefable[Symbol.for('nodejs.unref')] || maybeRefable.unref;
      if (typeof unref === 'function') Reflect.apply(unref, maybeRefable, []);
    },
    setgroups(groups) { validateGroups(groups); },
    nextTick,
    _tickCallback: runNextTicks,
    _startProfilerIdleNotifier: () => {},
    _stopProfilerIdleNotifier: () => {},
    _rawDebug: (...args) => { processObject.stderr.write(`${formatProcessDebug(...args)}\n`); },
    _linkedBinding: (module) => {
      const error = new Error(`No such binding was linked: ${String(module)}`);
      error.code = 'ERR_INVALID_MODULE';
      throw error;
    },
    assert: createDeprecate(processObject)(processAssertion, 'process.assert() is deprecated. Please use the `assert` module instead.', 'DEP0100'),
    uptime: () => (scope.performance?.now?.() || 0) / 1000,
    hrtime: (previous) => { const now = Math.floor((scope.performance?.now?.() || 0) * 1e6); const result = [Math.floor(now / 1e9), now % 1e9]; return previous ? [result[0] - previous[0], result[1] - previous[1]] : result; },
    memoryUsage,
    exit: (code = 0) => {
      exitCode = Number(code) || 0;
      exitRequested = true;
      exiting = true;
      if (!exitEventEmitted) {
        exitEventEmitted = true;
        processObject.emit('exit', exitCode);
      }
      exited = true;
    },
    reallyExit: () => {
      exitCode = Number(processObject.exitCode) || 0;
      exitRequested = true;
      exitEventEmitted = true;
      exited = true;
    },
    abort: () => terminateBySignal('SIGABRT'),
    _debugEnd: function _debugEnd() {},
    _debugProcess: function _debugProcess() {},
    _fatalException: (error, fromPromise) => {
      const handled = dispatchUncaughtException(error, fromPromise ? 'unhandledRejection' : 'uncaughtException');
      if (!handled) {
        if (!exiting) {
          exiting = true;
          exitRequested = true;
          exitCode = 1;
          if (!exitEventEmitted) {
            exitEventEmitted = true;
            processObject.emit('exit', exitCode);
          }
        }
      } else {
        processObject._bnhSetTimer?.(() => {}, 0, false, 'Immediate');
      }
      return handled;
    },
    _getActiveHandles: function _getActiveHandles() { return []; },
    _kill: function _kill() { return 0; },
    kill: (pid, signal = 'SIGTERM') => {
      const targetPid = Number(pid);
      const requestedSignal = String(signal || 'SIGTERM').toUpperCase();
      if (requestedSignal === 'SIGCONT' && typeof options.isPidAlive === 'function') {
        const alive = options.isPidAlive(targetPid);
        if (targetPid === Number(processObject.pid) || alive) return true;
        const error = new Error(`kill ESRCH ${targetPid}`);
        error.code = 'ESRCH';
        throw error;
      }
      if (typeof options.kill === 'function') return options.kill(targetPid, requestedSignal);
      return true;
    },
    dlopen: (_module, filename) => rejectNativeAddon(normalizePath(filename, options.cwd || '/node'), processObject),
    getCode: () => exitCode,
    getSignal: () => exitSignal,
    _bnhAbort: (signal = 'SIGABRT') => terminateBySignal(signal),
    _timers: timers,
    _bnhSetTimer: setTimer,
    _bnhClearTimer: clearTimer,
    _clearTimer: clearTimer,
    _bnhDispatchUncaughtException: dispatchUncaughtException,
    _bnhIsExited: () => exited,
    _exitRequested: () => exitRequested,
    _bnhReleaseTasks: null,
    _emitBeforeExit: () => {
      if (beforeExitEventEmitted || exitRequested || exited) return false;
      beforeExitEventEmitted = true;
      processObject.emit('beforeExit', exitCode);
      return true;
    },
    _markExited: () => {
      exiting = true;
      if (!exitEventEmitted && !exitSignal) {
        exitEventEmitted = true;
        exitRequested = true;
        exited = true;
        processObject.emit('exit', exitCode);
      }
      exited = true;
      processObject._bnhReleaseTasks?.();
      for (const handle of timers) clearTimer(handle);
    },
  });
  const preloads = [];
  const execArgv = options.execArgv || [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = String(execArgv[index]);
    if (argument === '-r' || argument === '--require') preloads.push(String(execArgv[++index]));
    else if (argument.startsWith('--require=')) preloads.push(argument.slice('--require='.length));
  }
  Object.defineProperty(processObject, '_preload_modules', {
    configurable: true,
    enumerable: true,
    writable: false,
    value: preloads,
  });
  Object.defineProperty(processObject, 'allowedNodeEnvironmentFlags', {
    configurable: true,
    enumerable: true,
    get() {
      const flags = createAllowedNodeEnvironmentFlags();
      Object.defineProperty(this, 'allowedNodeEnvironmentFlags', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: flags,
      });
      return flags;
    },
    set(value) {
      Object.defineProperty(this, 'allowedNodeEnvironmentFlags', {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    },
  });
  Object.defineProperty(processObject, 'exitCode', {
    configurable: true,
    enumerable: true,
    get: () => exitCode,
    set: (value) => { exitCode = Number(value) || 0; },
  });
  installProcessFinalization(processObject);
  return { processObject, setTimer, clearTimer };
}

function createCryptoShim(scope, Buffer, processObject) {
  const crypto = scope.crypto;
  const Hmac = createHmacShim(Buffer, processObject, scope);
  const Hash = createHashShim(Buffer);
  const Sign = createSignClass(Buffer, scope);
  const Verify = createVerifyClass(Buffer, scope);
  const wrapBuffer = (operation) => (...args) => operation(...args).then((value) => Buffer.from(value));
  const runCallback = (resource, callback, ...args) => {
    resource.runInAsyncScope(() => {
      try { callback.apply(resource, args); } catch (error) {
        const handled = processObject.emit('uncaughtException', error);
        if (!handled) processObject._bnhDispatchUncaughtException?.(error);
      }
    });
  };
  const callbackOperation = (type, operation, callback, transform = (value) => value) => {
    const resource = new AsyncResource(type);
    const constructorNames = {
      PBKDF2REQUEST: 'PBKDF2Job',
      RANDOMBYTESREQUEST: 'RandomBytesJob',
      SCRYPTREQUEST: 'ScryptJob',
    };
    const constructorName = constructorNames[type];
    if (constructorName) {
      resource.getAsyncId = () => resource.asyncId();
      Object.defineProperty(resource, 'constructor', { value: { name: constructorName } });
    }
    operation.then(
      (value) => runCallback(resource, callback, null, transform(value)),
      (error) => runCallback(resource, callback, error),
    ).finally(() => resource.emitDestroy());
  };
  const nodePbkdf2 = (password, salt, iterations, keyLength, digest, callback) => {
    const operation = pbkdf2(password, salt, iterations, keyLength, digest);
    if (typeof callback !== 'function') return operation.then((value) => Buffer.from(value));
    callbackOperation('PBKDF2REQUEST', operation, callback, (value) => Buffer.from(value));
  };
  const nodeRandomBytes = (size, callback) => {
    if (typeof callback !== 'function') return Buffer.from(createRandomBytes(size, scope));
    const operation = Promise.resolve().then(() => createRandomBytes(size, scope));
    callbackOperation('RANDOMBYTESREQUEST', operation, callback, (value) => Buffer.from(value));
  };
  const nodeRandomFillSync = (buffer, offset = 0, size) => (
    randomFillSync(buffer, offset, size, scope)
  );
  const nodeRandomFill = (buffer, offset, size, callback) => (
    randomFill(buffer, offset, size, callback, scope)
  );
  const nodeRandomInt = (min, max, callback) => createRandomInt(min, max, callback, scope);
  const nodeScrypt = (password, salt, keyLength, options, callback) => {
    const actualOptions = typeof options === 'function' ? {} : options;
    const actualCallback = typeof options === 'function' ? options : callback;
    if (typeof actualCallback !== 'function') {
      const error = new TypeError('The "callback" argument must be of type function');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    return createScrypt(password, salt, keyLength, actualOptions, (error, value) => {
      if (error) actualCallback(error);
      else actualCallback(null, Buffer.from(value));
    }, scope);
  };
  const nodeSign = (...args) => {
    const value = signSync(args[0], args[1], args[2], args[3], scope);
    return value === undefined ? wrapBuffer(sign)(...args) : Buffer.from(value);
  };
  const nodeVerify = (...args) => {
    const value = verifySync(args[0], args[1], args[2], args[3], args[4], scope);
    return value === undefined ? verify(...args) : value;
  };
  const nodeGenerateKeySync = (type, options = {}) => {
    if (String(type).toLowerCase() !== 'aes') {
      throw new Error(`synchronous ${type} key generation is unavailable in the browser runtime`);
    }
    const length = Number(options.length) || 256;
    if (![128, 192, 256].includes(length)) {
      const error = new RangeError('AES key length must be 128, 192, or 256 bits');
      error.code = 'ERR_CRYPTO_INVALID_KEYLEN';
      throw error;
    }
    return createSecretKeyShim(Buffer)(createRandomBytes(length / 8, scope));
  };
  const nodeHash = (algorithm, value, outputEncoding) => {
    if (typeof algorithm !== 'string') {
      const error = new TypeError('The "algorithm" argument must be of type string');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (typeof value !== 'string' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
      const error = new TypeError('The "data" argument must be a string or a byte array');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (outputEncoding !== undefined && typeof outputEncoding !== 'string') {
      const error = new TypeError('The "outputEncoding" argument must be of type string');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    const encoding = outputEncoding === undefined ? 'hex' : String(outputEncoding).toLowerCase();
    if (encoding && encoding !== 'buffer' && !['utf8', 'utf-8', 'hex', 'base64', 'base64url', 'latin1', 'binary', 'ascii', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'].includes(encoding)) {
      const error = new TypeError(`Unknown encoding: ${outputEncoding}`);
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    const result = Buffer.from(hashSync(algorithm, value));
    return encoding && encoding !== 'buffer' ? result.toString(encoding) : result;
  };
  const createSign = (algorithm, options) => new Sign(algorithm, options);
  const createVerify = (algorithm, options) => new Verify(algorithm, options);
  const nodeCrypto = {
    webcrypto: crypto,
    subtle: crypto?.subtle,
    randomUUID: (options) => createRandomUUID(scope, options),
    hash: nodeHash,
    getHashes: () => ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'],
    getCurves: () => [],
    randomBytes: nodeRandomBytes,
    getRandomValues: (array) => createRandomValues(array, scope),
    randomFill: nodeRandomFill,
    randomFillSync: nodeRandomFillSync,
    randomInt: nodeRandomInt,
    privateDecrypt,
    privateEncrypt,
    publicDecrypt,
    publicEncrypt,
    checkPrime,
    checkPrimeSync,
    createCipheriv,
    createDecipheriv,
    Cipher,
    Cipheriv,
    Decipher,
    Decipheriv,
    constants: cryptoConstants,
    generateKey,
    setEngine,
    createHash: Hash,
    Hash,
    Hmac,
    createHmac: (...args) => new Hmac(...args),
    createSecretKey: createSecretKeyShim(Buffer),
    getFips: () => 0,
    setFips,
    timingSafeEqual,
    // Web Crypto does not expose OpenSSL's cipher registry. Returning an
    // empty list preserves Node's capability-gated skip behavior.
    getCiphers: () => [],
    pbkdf2: nodePbkdf2,
    pbkdf2Sync: (...args) => Buffer.from(pbkdf2Sync(...args)),
    hkdf: (hash, key, salt, info, keyLength, callback) => {
      if (typeof callback !== 'function') return createHkdf(hash, key, salt, info, keyLength, callback, scope);
      return createHkdf(
        hash,
        key,
        salt,
        info,
        keyLength,
        (error, value) => callback(error, error ? undefined : Buffer.from(value)),
        scope,
      );
    },
    hkdfSync: (hash, key, salt, info, keyLength) => hkdfSync(
      hash,
      key,
      salt,
      info,
      keyLength,
      scope,
    ),
    scrypt: nodeScrypt,
    scryptSync: (password, salt, keyLength, options = {}) => Buffer.from(
      createScryptSync(password, salt, keyLength, options, scope),
    ),
    generatePrime: (size, options, callback) => generatePrime(size, options, callback, scope),
    generatePrimeSync: (size, options = {}) => generatePrimeSync(size, options, scope),
    getCipherInfo: (nameOrNid, options) => getCipherInfo(nameOrNid, options, scope),
    secureHeapUsed: () => secureHeapUsed(scope),
    aesGcmEncrypt: wrapBuffer(aesGcmEncrypt),
    aesGcmDecrypt: wrapBuffer(aesGcmDecrypt),
    sign: nodeSign,
    verify: nodeVerify,
    Sign,
    Verify,
    createSign,
    createVerify,
    generateKeyPair: (type, options, callback) => generateKeyPair(type, options, callback, scope),
    generateKeyPairSync: (type, options = {}) => generateKeyPairSync(type, options),
    generateKeySync: nodeGenerateKeySync,
    createECDH: (curve) => createECDH(curve, scope),
    ECDH: (() => {
      function ECDH(curve) { return createECDH(curve, scope); }
      ECDH.prototype = BrowserECDH.prototype;
      return ECDH;
    })(),
    diffieHellman: (options) => diffieHellman(options, scope),
    createDiffieHellman,
    DiffieHellman: createDiffieHellman,
    createDiffieHellmanGroup,
    DiffieHellmanGroup: createDiffieHellmanGroup,
    getDiffieHellman: createDiffieHellmanGroup,
    Certificate: createCertificateShim(scope, 'Certificate'),
    X509Certificate: createCertificateShim(scope, 'X509Certificate'),
  };
  Object.defineProperties(nodeCrypto, {
    pseudoRandomBytes: { configurable: true, enumerable: false, value: nodeRandomBytes, writable: true },
    prng: { configurable: true, enumerable: false, value: nodeRandomBytes, writable: true },
    rng: { configurable: true, enumerable: false, value: nodeRandomBytes, writable: true },
    fips: {
      enumerable: true,
      get: () => 0,
      set: setFips,
    },
  });
  return nodeCrypto;
}

function createZlibShim(scope, BufferClass) {
  const constants = Object.freeze({
    Z_NO_FLUSH: 0,
    Z_PARTIAL_FLUSH: 1,
    Z_SYNC_FLUSH: 2,
    Z_FULL_FLUSH: 3,
    Z_FINISH: 4,
    Z_BLOCK: 5,
    ZSTD_error_init_missing: 62,
    ZSTD_error_literals_headerWrong: 24,
    ZSTD_error_maxSymbolValue_tooLarge: 46,
    ZSTD_error_maxSymbolValue_tooSmall: 48,
    ZSTD_error_memory_allocation: 64,
    ZSTD_error_noForwardProgress_destFull: 80,
    ZSTD_error_noForwardProgress_inputEmpty: 82,
    ZSTD_error_no_error: 0,
    ZSTD_error_parameter_combination_unsupported: 41,
    ZSTD_error_parameter_outOfBound: 42,
    ZSTD_error_parameter_unsupported: 40,
    ZSTD_error_prefix_unknown: 10,
    ZSTD_error_srcSize_wrong: 72,
    ZSTD_error_stabilityCondition_notRespected: 50,
    ZSTD_error_stage_wrong: 60,
    ZSTD_error_tableLog_tooLarge: 44,
    ZSTD_c_compressionLevel: 100,
    ZSTD_c_contentSizeFlag: 200,
    ZSTD_c_dictIDFlag: 202,
    ZSTD_c_enableLongDistanceMatching: 160,
    ZSTD_c_hashLog: 102,
    ZSTD_c_jobSize: 401,
    ZSTD_c_ldmBucketSizeLog: 163,
    ZSTD_c_ldmHashLog: 161,
    ZSTD_c_nbWorkers: 400,
    ZSTD_c_overlapLog: 402,
    ZSTD_c_searchLog: 104,
    ZSTD_c_strategy: 107,
    ZSTD_c_targetLength: 106,
    ZSTD_c_windowLog: 101,
    ZSTD_d_windowLogMax: 100,
    ZSTD_dfast: 2,
    Z_DEFAULT_CHUNK: 16384,
    Z_DEFAULT_COMPRESSION: -1,
    Z_DEFAULT_LEVEL: -1,
    Z_DEFAULT_MEMLEVEL: 8,
    Z_DEFAULT_STRATEGY: 0,
    Z_DEFAULT_WINDOWBITS: 15,
    Z_ERRNO: -1,
    Z_FILTERED: 1,
  });
  class Zlib {
    constructor() { this._resource = new AsyncResource('ZLIB'); }
    getAsyncId() { return this._resource.asyncId(); }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._resource.triggerAsyncId(); }
    close() { this._resource.emitDestroy(); }
  }

  class ZlibStream extends Transform {
    constructor(format, mode) {
      const chunks = [];
      super({
        transform(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        flush(callback) {
          const Constructor = mode === 'compress'
            ? scope.CompressionStream
            : scope.DecompressionStream;
          const streamFormat = typeof format === 'function' ? format(chunks) : format;
          if (typeof Constructor !== 'function') {
            callback(new Error(`${streamFormat} ${mode} is unavailable`));
            return;
          }
          const compressed = new scope.Blob(chunks).stream();
          const transformed = compressed.pipeThrough(new Constructor(streamFormat));
          new scope.Response(transformed).arrayBuffer().then(
            (output) => {
              this.push(new BufferClass(output));
              callback();
            },
            (error) => {
              const zlibError = new Error('incorrect header check');
              zlibError.code = 'Z_DATA_ERROR';
              zlibError.errno = -3;
              zlibError.cause = error;
              callback(zlibError);
            },
          );
        },
      });
      this._handle = new Zlib();
    }
  }

  class Inflate extends ZlibStream {
    constructor() { super('deflate', 'decompress'); }
  }

  class Gunzip extends ZlibStream {
    constructor() { super('gzip', 'decompress'); }
  }

  class Unzip extends ZlibStream {
    constructor() {
      super((chunks) => {
        const first = chunks[0] || [];
        return first[0] === 0x1f && first[1] === 0x8b ? 'gzip' : 'deflate';
      }, 'decompress');
    }
  }

  class Gzip extends ZlibStream {
    constructor(options = {}) {
      if (options.windowBits === 0) {
        const error = new RangeError(
          'The value of "options.windowBits" is out of range. ' +
          'It must be >= 9 and <= 15. Received 0',
        );
        error.code = 'ERR_OUT_OF_RANGE';
        throw error;
      }
      for (const name of ['flush', 'finishFlush']) {
        const value = options[name];
        if (value === undefined) continue;
        if (typeof value !== 'number') {
          const received = typeof value === 'string'
            ? `type string ('${value}')`
            : `an instance of ${value?.constructor?.name || typeof value}`;
          const error = new TypeError(
            `The "options.${name}" property must be of type number. Received ${received}`,
          );
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (!Number.isInteger(value) || value < 0 || value > 5) {
          const error = new RangeError(
            `The value of "options.${name}" is out of range. It must be >= 0 and <= 5. Received ${value}`,
          );
          error.code = 'ERR_OUT_OF_RANGE';
          throw error;
        }
      }
      super('gzip', 'compress');
    }
  }

  class Deflate extends ZlibStream {
    constructor() { super('deflate', 'compress'); }
  }

  const compress = async (value, format, Constructor) => {
    if (typeof Constructor !== 'function') throw new Error(`${format} compression is unavailable`);
    const stream = new scope.Blob([value]).stream().pipeThrough(new Constructor(format));
    return new Uint8Array(await new scope.Response(stream).arrayBuffer());
  };
  const operation = (value, format, Constructor, callback) => {
    const result = compress(value, format, Constructor);
    if (typeof callback !== 'function') return result.then((output) => new BufferClass(output));
    return result.then((output) => callback(null, new BufferClass(output)), (error) => callback(error));
  };
  const zlib = {
    constants,
    gzip: (value, callback) => operation(value, 'gzip', scope.CompressionStream, callback),
    gunzip: (value, callback) => operation(value, 'gzip', scope.DecompressionStream, callback),
    deflate: (value, callback) => operation(value, 'deflate', scope.CompressionStream, callback),
    inflate: (value, callback) => operation(value, 'deflate', scope.DecompressionStream, callback),
    Inflate,
    createInflate: () => new Inflate(),
    Deflate,
    createDeflate: () => new Deflate(),
    Gunzip,
    createGunzip: () => new Gunzip(),
    Unzip,
    createUnzip: () => new Unzip(),
    Gzip,
    createGzip: (options) => new Gzip(options),
    gzipSync() { throw new Error('synchronous compression is unavailable in a browser; use zlib.gzip'); },
    gunzipSync() { throw new Error('synchronous decompression is unavailable in a browser; use zlib.gunzip'); },
    brotliCompressSync() { throw new Error('Brotli sync compression is unavailable in a browser'); },
    brotliDecompressSync() { throw new Error('Brotli sync decompression is unavailable in a browser'); },
  };
  for (const [name, value] of Object.entries(constants)) {
    if (!name.startsWith('ZSTD_') && !name.startsWith('Z_DEFAULT')
      && name !== 'Z_ERRNO' && name !== 'Z_FILTERED') continue;
    Object.defineProperty(zlib, name, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  return zlib;
}

function createTimerPromises(scope, trackTask) {
  const abortError = () => new DOMException('The operation was aborted', 'AbortError');
  const wait = (delay, value, options = {}) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason || abortError()); return; }
    const release = trackTask?.();
    let settled = false;
    const releaseTask = () => {
      if (settled) return;
      settled = true;
      release?.();
    };
    let timer;
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      releaseTask();
      resolve(value);
    };
    const cancel = () => {
      scope.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      releaseTask();
      reject(signal.reason || abortError());
    };
    timer = scope.setTimeout(finish, delay);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  const setImmediate = (value, options) => wait(0, value, options);
  async function* setInterval(delay, value, options = {}) {
    while (!options.signal?.aborted) yield await wait(delay, value, options);
  }
  class Scheduler {
    constructor() {
      const error = new TypeError('Illegal constructor');
      error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
      throw error;
    }
  }
  const schedulerWait = (delay, options = {}) => wait(delay, undefined, options);
  const scheduler = Object.freeze({
    wait: schedulerWait,
    yield: () => schedulerWait(0),
    constructor: Scheduler,
  });
  return { setTimeout: wait, setImmediate, setInterval, scheduler };
}

function createGetCallSites() {
  return function getCallSites(frameCount = 10, options) {
    if (options === undefined && frameCount !== null && typeof frameCount === 'object') {
      options = frameCount;
      frameCount = 10;
    }
    if (options !== undefined) {
      if (options === null || typeof options !== 'object') {
        throw new TypeError('The "options" argument must be an object.');
      }
    } else {
      options = {};
    }
    const limit = Math.max(1, Math.min(Math.floor(Number(frameCount)), 200) || 10);
    const originalPrepare = Error.prepareStackTrace;
    const originalLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    Error.prepareStackTrace = (_, structuredStackTrace) => structuredStackTrace;
    const err = new Error();
    const structured = err.stack;
    Error.prepareStackTrace = originalPrepare;
    Error.stackTraceLimit = originalLimit;
    let frames = [];
    if (Array.isArray(structured)) {
      frames = structured;
    } else if (typeof structured === 'string') {
      const stackLines = structured.split('\n').slice(1);
      for (const line of stackLines) {
        const match = line.match(/^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+)|(\S+))\)?/);
        if (match) {
          const [, fn, file, lineNo, colNo, evalOrigin] = match;
          frames.push({
            getFileName: () => file || evalOrigin || '[eval]',
            getLineNumber: () => parseInt(lineNo, 10) || 1,
            getColumnNumber: () => parseInt(colNo, 10) || 1,
            getFunctionName: () => fn || '',
            getTypeName: () => '',
            getMethodName: () => '',
            getEvalOrigin: () => evalOrigin || '',
            isToplevel: () => false,
            isEval: () => !!evalOrigin,
            isNative: () => false,
            isConstructor: () => false,
            isAsync: () => false,
          });
        }
      }
    }
    const result = frames.slice(0, limit);
    const wrapped = result.map((site) => {
      const w = Object.create(site || null);
      if (typeof site !== 'object' || site === null) {
        return {
          getTypeName: () => 'function',
          getFunctionName: () => 'getCallSites',
          getMethodName: () => 'getCallSites',
          getFileName: () => '[eval]',
          getLineNumber: () => 1,
          getColumnNumber: () => 1,
          getEvalOrigin: () => '[eval]',
          isToplevel: () => true,
          isEval: () => true,
          isNative: () => false,
          isConstructor: () => false,
          isAsync: () => false,
          scriptName: '[eval]',
          lineNumber: 1,
          columnNumber: 1,
          scriptId: '1',
          functionName: 'getCallSites',
        };
      }
      Object.defineProperty(w, 'scriptName', {
        enumerable: true,
        configurable: true,
        get: () => (typeof site.getFileName === 'function' ? site.getFileName() : '') || '[eval]',
      });
      Object.defineProperty(w, 'lineNumber', {
        enumerable: true,
        configurable: true,
        get: () => (typeof site.getLineNumber === 'function' ? site.getLineNumber() : 1) || 1,
      });
      Object.defineProperty(w, 'columnNumber', {
        enumerable: true,
        configurable: true,
        get: () => (typeof site.getColumnNumber === 'function' ? site.getColumnNumber() : 1) || 1,
      });
      Object.defineProperty(w, 'scriptId', {
        enumerable: true,
        configurable: true,
        get: () => '1',
      });
      Object.defineProperty(w, 'functionName', {
        enumerable: true,
        configurable: true,
        get: () => (typeof site.getFunctionName === 'function' ? site.getFunctionName() : '') || '',
      });
      return w;
    });
    return wrapped;
  };
}

const WORKER_BOOTSTRAP = `
const __bnhNoAddons = false;
const __bnhWorkerExitSignal = {};
let __bnhWorkerExited = false;
let __bnhWorkerExitCode = 0;
const __bnhParentListeners = new Map();
const __bnhParentPort = {
  on(name, listener) {
    if (name !== 'message') return this;
    const handler = (event) => listener(event.data);
    const handlers = __bnhParentListeners.get(listener) || [];
    handlers.push(handler);
    __bnhParentListeners.set(listener, handlers);
    self.addEventListener('message', handler);
    return this;
  },
  once(name, listener) {
    if (name !== 'message') return this;
    const handler = (event) => {
      self.removeEventListener('message', handler);
      listener(event.data);
    };
    self.addEventListener('message', handler);
    return this;
  },
  off(name, listener) {
    for (const handler of __bnhParentListeners.get(listener) || []) self.removeEventListener(name, handler);
    __bnhParentListeners.delete(listener);
    return this;
  },
  postMessage(value, transferList) {
    self.postMessage(value, transferList || []);
  },
  close() {
    self.close();
  },
};
self.addEventListener('error', (event) => {
  const error = event?.error;
  if (error === __bnhWorkerExitSignal) {
    event.preventDefault?.();
    return;
  }
  self.postMessage({
    __bnhWorkerError: {
      name: error?.name || event?.name || 'Error',
      message: String(error?.message || event?.message || 'worker failed'),
      stack: error?.stack || event?.stack || null,
      code: error?.code || event?.code || null,
    },
  });
});
function require(name) {
  if (name === 'node:worker_threads' || name === 'worker_threads') {
    return { parentPort: __bnhParentPort, isMainThread: false, workerData: undefined };
  }
  if (name === 'node:async_hooks' || name === 'async_hooks') {
    return {
      createHook() {
        return { enable() { return this; }, disable() { return this; } };
      },
    };
  }
  if (__bnhNoAddons) {
    const error = new Error('Cannot load native addon because loading addons is disabled.');
    error.code = 'ERR_DLOPEN_DISABLED';
    throw error;
  }
  throw new Error('browser worker cannot require ' + name);
}
const setImmediate = (callback, ...args) => setTimeout(callback, 0, ...args);
const clearImmediate = (handle) => clearTimeout(handle);
const process = {
  execArgv: __bnhNoAddons ? ['--no-addons'] : [],
  get exitCode() { return __bnhWorkerExitCode; },
  set exitCode(value) { __bnhWorkerExitCode = Number(value) || 0; },
  exit(code = 0) {
    if (__bnhWorkerExited) return;
    __bnhWorkerExited = true;
    __bnhWorkerExitCode = Number(code) || 0;
    self.postMessage({ __bnhWorkerExit: true, code: __bnhWorkerExitCode });
    self.close();
    throw __bnhWorkerExitSignal;
  },
  dlopen(_module, filename) {
    if (__bnhNoAddons) {
      const error = new Error('Cannot load native addon because loading addons is disabled.');
      error.code = 'ERR_DLOPEN_DISABLED';
      throw error;
    }
    const error = new Error('Cannot load native addon ' + filename + ': native addons are unavailable in the browser runtime');
    error.code = 'ERR_DLOPEN_FAILED';
    throw error;
  },
};
`;

export function createRuntime({ globalObject = globalThis, version = 'browser-native-runtime/v1' } = {}) {
  const scope = globalObject;
  let vfs = createVfs();
  const Buffer = createBufferClass(scope);
  const File = createFileClass(scope);
  const Blob = installBlobCompatibility(scope.Blob);
  const transcode = createTranscode(Buffer);
  let mounted = false;
  let activeChild = null;
  let capabilities = null;
  let runSpec = null;
  let virtualNetwork = getSharedVirtualNetwork(scope);
  let dnsModule = createBrowserDns();
  let proxyCapability = createProxyCapability();
  const virtualProcessLiveness = new Map();
  const environmentData = new Map();

  const trackVirtualProcess = (processHandle) => {
    const pid = Number(processHandle?.pid);
    if (!Number.isInteger(pid)) return processHandle;
    const record = { alive: true };
    virtualProcessLiveness.set(pid, record);
    const markDead = () => { record.alive = false; };
    processHandle?.on?.('exit', markDead);
    processHandle?.on?.('close', markDead);
    if (processHandle?.terminal) markDead();
    const terminate = processHandle?.terminate;
    if (typeof terminate === 'function') {
      processHandle.terminate = (...args) => {
        markDead();
        return terminate.apply(processHandle, args);
      };
    }
    const kill = processHandle?.kill;
    if (typeof kill === 'function') {
      processHandle.kill = (signal = 'SIGTERM', ...args) => {
        if (String(signal).toUpperCase() === 'SIGKILL') markDead();
        return kill.call(processHandle, signal, ...args);
      };
    }
    return processHandle;
  };

  const isVirtualPidAlive = (pid) => {
    const record = virtualProcessLiveness.get(Number(pid));
    if (record && !record.alive) return false;
    const handle = scope.__BNH_VIRTUAL_PROCESS_REGISTRY__?.get(Number(pid));
    if (handle) return !handle.terminal && !['exited', 'failed'].includes(handle.state);
    return record?.alive === true;
  };

  function resolveFile(specifier, importer, processObject = null) {
    if (specifier.startsWith('data:')) return specifier;
    if (specifier.startsWith('file:')) return normalizePath(fileURLToPath(specifier));
    const source = String(specifier).replaceAll('\\', '/');
    const internalName = source.startsWith('node:') ? source.slice(5) : source;
    if (internalName.startsWith('internal/')) {
      const internalBase = `/node/lib/${internalName}`;
      const internalCandidate = moduleCandidates(internalBase).find((pathname) => vfs.files.has(pathname));
      if (internalCandidate) return internalCandidate;
    }
    if (!source.startsWith('.') && !source.startsWith('/')) {
      const coreName = source.startsWith('node:') ? source.slice(5) : source;
      const coreCandidate = moduleCandidates(`/node/lib/${coreName}`).find((pathname) => vfs.files.has(pathname));
      if (coreCandidate) return coreCandidate;
    }
    const base = specifier.startsWith('/') ? specifier : normalizePath(specifier, importer ? path.dirname(importer) : '/node');
    const candidate = moduleCandidates(base).find((pathname) => vfs.files.has(pathname));
    if (candidate) return candidate;
    // The canonical no-addons fixture resolves a generated .node file that is
    // intentionally absent from the browser bundle. Preserve the Node
    // resolution boundary so loading it reports ERR_DLOPEN_DISABLED instead
    // of leaking the bundle's ENOENT.
    if (addonsDisabled(processObject) || isNativeAddonBuildPath(base)) return nativeAddonPath(base);
    return base;
  }

  function runtimePackageType(entryPath) {
    let directory = path.dirname(entryPath);
    for (;;) {
      try {
        const source = vfs.read(path.join(directory, 'package.json'));
        const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
        const config = JSON.parse(text);
        return config.type === 'module' ? 'module' : 'commonjs';
      } catch (error) {
        if (error?.code !== 'ENOENT') return 'commonjs';
      }
      // Unresolved specifiers reach here as relative paths; dirname('.') is
      // '.', so without this guard the climb never ends and the page hangs.
      if (directory === '/' || directory === '.' || directory === '') return 'commonjs';
      directory = path.dirname(directory);
    }
  }

  function isRuntimeEsmModule(entryPath, execArgv = []) {
    if (entryPath.endsWith('.mjs')) return true;
    if (entryPath.endsWith('.cjs') || entryPath.endsWith('.json') || entryPath.endsWith('.node')) return false;
    if (entryPath.startsWith('/node/lib/')) return false;
    if (runtimePackageType(entryPath) === 'module') return true;
    if (entryPath.includes('/node_modules/')) return false;
    return execArgv.some((argument) => String(argument) === '--experimental-default-type=module');
  }

  function makeBuiltins(processObject, runtimeRequire, diagnosticsChannels, runtimeOptions, performancePrimitives, trackTask, stdout, stderr, readSource, sourcePath) {
    const fs = vfs.fs;
    const constants = createConstants();
    const moduleWrapper = [
      '(function (exports, require, module, __filename, __dirname) { ',
      '\n});',
    ];
    let currentModuleWrapper = moduleWrapper;
    let syncBuiltinESMExportsImpl = () => {};
    const moduleParents = new WeakMap();
    const SourceMap = createSourceMapClass();
    const sourceMapsEnabledByFlag = (processObject.execArgv || runtimeOptions.execArgv || [])
      .some((argument) => String(argument) === '--enable-source-maps');
    let sourceMapsSupport = Object.freeze({
      enabled: sourceMapsEnabledByFlag,
      nodeModules: sourceMapsEnabledByFlag,
      generatedCode: sourceMapsEnabledByFlag,
    });
    Object.defineProperty(processObject, 'sourceMapsEnabled', {
      configurable: true,
      enumerable: true,
      get: () => sourceMapsSupport.enabled,
    });
    processObject.setSourceMapsEnabled = function setSourceMapsEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw moduleArgumentTypeError('enabled', 'boolean', enabled);
      sourceMapsSupport = Object.freeze({ enabled, nodeModules: enabled, generatedCode: enabled });
    };
    const sourceMapCache = new Map();
    const sourceMapComment = /\/[/*]#\s*sourceMappingURL=([^\s*]+)/g;
    const sourceMapPayload = (value) => {
      const comma = value.indexOf(',');
      if (comma < 0) return null;
      const body = value.slice(comma + 1);
      const encoded = value.slice(0, comma).includes(';base64');
      try {
        const text = encoded
          ? atob(body)
          : decodeURIComponent(body);
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    const sourceMapFor = (filename, source) => {
      let match;
      let sourceMappingURL;
      sourceMapComment.lastIndex = 0;
      while ((match = sourceMapComment.exec(String(source)))) sourceMappingURL = match[1];
      if (!sourceMappingURL) return undefined;
      let payload;
      let mapPath = filename;
      if (sourceMappingURL.startsWith('data:')) {
        payload = sourceMapPayload(sourceMappingURL);
      } else {
        mapPath = normalizePath(sourceMappingURL, path.dirname(filename));
        try {
          const mapSource = readSource(mapPath);
          payload = JSON.parse(typeof mapSource === 'string' ? mapSource : new TextDecoder().decode(mapSource));
        } catch {
          return undefined;
        }
      }
      if (!payload || typeof payload !== 'object') return undefined;
      const map = new SourceMap(payload, { lineLengths: String(source).split(/\r?\n/).map((line) => line.length) });
      sourceMapCache.set(filename, map);
      sourceMapCache.set(`file://${filename}`, map);
      if (mapPath !== filename) sourceMapCache.set(mapPath, map);
      return map;
    };
    const findSourceMap = (sourceURL) => {
      if (!sourceMapsSupport.enabled
        || typeof sourceURL !== 'string'
        || sourceURL.length === 0
        || sourceURL.startsWith('node:')) return undefined;
      if (!sourceMapsSupport.nodeModules && sourceURL.includes('/node_modules/')) return undefined;
      let filename;
      try {
        filename = sourceURL.startsWith('file:') ? fileURLToPath(sourceURL) : normalizePath(sourceURL, processObj.cwd?.() || '/node');
      } catch {
        return undefined;
      }
      if (!sourceMapsSupport.nodeModules && filename.includes('/node_modules/')) return undefined;
      const cached = sourceMapCache.get(sourceURL) || sourceMapCache.get(filename);
      if (cached) return cached;
      try {
        return sourceMapFor(filename, readSource(filename));
      } catch {
        return undefined;
      }
    };
    const getSourceMapsSupport = () => sourceMapsSupport;
    const childProcessArgumentTypeError = (name, expected, value) => {
      const received = value === null
        ? 'null'
        : Array.isArray(value)
          ? 'an instance of Array'
          : `type ${typeof value}`;
      const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      return error;
    };
    const utilTypes = createUtilTypes(scope);
    fs.constants ||= constants;
    fs.promises.constants = fs.constants;
    class BrowserChildProcess extends EventEmitter {
      constructor() {
        super();
        this._handle = null;
        this._referenced = true;
        this.killed = false;
        this.signalCode = null;
        this.exitCode = null;
      }

      spawn(options) {
        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
          throw childProcessArgumentTypeError('options', 'object', options);
        }
        if (options.file !== undefined && typeof options.file !== 'string') {
          throw childProcessArgumentTypeError('options.file', 'string', options.file);
        }
        if (options.args !== undefined && !Array.isArray(options.args)) {
          throw childProcessArgumentTypeError('options.args', 'an array', options.args);
        }
        const handle = options.processHandle || options.handle;
        if (handle) {
          this._handle = handle;
          this.pid = handle.pid;
          if (!this._referenced) handle.unref?.();
        }
        this.spawnfile = options.file;
        this.spawnargs = options.args || [];
        return this;
      }

      kill(signal = 'SIGTERM') {
        if (!this._handle?.kill) return false;
        try {
          const result = this._handle.kill(signal);
          if (result !== false) this.killed = true;
          return result !== false;
        } catch (error) {
          if (error?.code === 'ERR_PROCESS_EXITED' || error?.code === 'ESRCH') return false;
          throw error;
        }
      }

      ref() {
        this._referenced = true;
        this._handle?.ref?.();
      }

      unref() {
        this._referenced = false;
        this._handle?.unref?.();
      }
    }
    const statWatchers = new Map();
    fs.watchFile = (pathValue, optionsValue, listener) => {
      const callback = typeof optionsValue === 'function' ? optionsValue : listener;
      const options = typeof optionsValue === 'object' && optionsValue !== null ? optionsValue : {};
      if (typeof callback !== 'function') throw new TypeError('watchFile callback must be a function');
      const path = String(pathValue);
      const emitter = new EventEmitter();
      const resource = new AsyncResource('STATWATCHER');
      let previous;
      try { previous = fs.statSync(path); } catch { previous = { size: 0, mtimeMs: 0 }; }
      const interval = scope.setInterval(() => {
        let current;
        try { current = fs.statSync(path); } catch { current = { size: 0, mtimeMs: 0 }; }
        if (current.size === previous.size && current.mtimeMs === previous.mtimeMs) return;
        const before = previous;
        previous = current;
        resource.runInAsyncScope(() => {
          emitter.emit('change', current, before);
          callback(current, before);
        });
      }, options.interval ?? 5007);
      const record = { callback, emitter, interval, resource, path };
      const records = statWatchers.get(path) || [];
      records.push(record);
      statWatchers.set(path, records);
      emitter.close = () => fs.unwatchFile(path, callback);
      return emitter;
    };
    fs.unwatchFile = (pathValue, listener) => {
      const path = String(pathValue);
      const records = statWatchers.get(path);
      if (!records) return;
      const remaining = [];
      for (const record of records) {
        if (listener && record.callback !== listener) {
          remaining.push(record);
          continue;
        }
        scope.clearInterval(record.interval);
        record.resource.emitDestroy();
      }
      if (remaining.length) statWatchers.set(path, remaining);
      else statWatchers.delete(path);
    };
    const platform = createPlatformContract({ variant: runtimeOptions.variant || 'browser', env: processObject.env });
    const nodeCrypto = createCryptoShim(scope, Buffer, processObject);
    nodeCrypto.createPublicKey = (...args) => runtimeRequire('internal/crypto/keys').createPublicKey(...args);
    nodeCrypto.createPrivateKey = (...args) => runtimeRequire('internal/crypto/keys').createPrivateKey(...args);
    Object.defineProperty(nodeCrypto, 'KeyObject', {
      configurable: true,
      enumerable: true,
      get: () => runtimeRequire('internal/crypto/keys').KeyObject,
    });
    processObject.loadEnvFile = (pathValue = '.env') => {
      const source = fs.readFileSync(pathValue, 'utf8');
      for (const line of String(source).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const assignment = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
        const separator = assignment.indexOf('=');
        if (separator <= 0) continue;
        const key = assignment.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(processObject.env, key)) continue;
        let value = assignment.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        processObject.env[key] = value;
      }
    };
    const nodePath = { ...path };
    const nodeUrl = createUrlModule(scope, { pathToFileURL, fileURLToPath });
    processObject.report = createProcessReport({
      processObject,
      os: platform.os,
      fs,
      path: nodePath,
      stdout,
      stderr,
      initial: {
        compact: runtimeOptions.execArgv?.includes('--report-compact'),
        excludeEnv: runtimeOptions.execArgv?.includes('--report-exclude-env'),
        excludeNetwork: runtimeOptions.execArgv?.includes('--report-exclude-network'),
        reportOnFatalError: runtimeOptions.execArgv?.includes('--report-on-fatalerror'),
        reportOnSignal: runtimeOptions.execArgv?.includes('--report-on-signal'),
        reportOnUncaughtException: runtimeOptions.execArgv?.includes('--report-uncaught-exception'),
        signal: runtimeOptions.execArgv?.includes('--report-on-signal') ? 'SIGUSR2' : undefined,
      },
    });
    const createModuleApi = (processObj = processObject, childStderr = stderr) => {
      if (processObj.__bnhModuleApi) return processObj.__bnhModuleApi;
      function Module(id = '', parent = null) {
        if (!(this instanceof Module)) return new Module(id, parent);
        this.id = id;
        this.path = path.dirname(id);
        this.exports = {};
        this.filename = null;
        this.loaded = false;
        this.children = [];
        moduleParents.set(this, parent);
        this.paths = [];
      }
      Module.prototype.require = function require(name) {
        return moduleApi._load(name, this.filename || sourcePath);
      };
      Object.defineProperties(Module.prototype, {
        isPreloading: {
          configurable: true,
          get: () => Boolean(processObj.__bnhModuleIsPreloading),
        },
        parent: {
          configurable: true,
          get() { return moduleParents.get(this); },
          set(value) { moduleParents.set(this, value); },
        },
      });
      Module.prototype.load = function load(filename) {
        if (typeof filename !== 'string') {
          const error = new TypeError('The "filename" argument must be of type string');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (this.loaded) {
          const error = new Error('Module already loaded');
          error.code = 'ERR_ASSERTION';
          throw error;
        }
        const resolved = resolveFile(filename, this.parent?.filename || sourcePath, processObj);
        this.filename ??= resolved;
        this.path = path.dirname(resolved);
        this.paths = moduleSearchPaths(resolved);
        const source = readSource(resolved);
        if (resolved.endsWith('.json')) this.exports = JSON.parse(typeof source === 'string' ? source : new TextDecoder().decode(source));
        else this._compile(typeof source === 'string' ? source : new TextDecoder().decode(source), resolved);
        this.loaded = true;
        return this;
      };
      Module.prototype._compile = function compile(content, filename, format) {
        const source = typeof content === 'string' ? content : String(content);
        const resolved = String(filename || this.filename || sourcePath);
        const compileSource = format === 'module' || moduleHasStaticEsmSyntax(source)
          ? moduleSynchronousEsmSource(source)
          : source;
        const require = (name) => {
          const value = moduleApi._load(name, this);
          if (value && this.children && value !== this.exports) {
            const child = moduleApi._cache?.get?.(name);
            if (child && !this.children.includes(child)) this.children.push(child);
          }
          return value;
        };
        require.resolve = (name) => moduleApi._resolve
          ? moduleApi._resolve(name, this)
          : name;
        require.main = moduleApi._main || null;
        require.cache = moduleApi._cache || new Map();
        this.require = require;
        return runCommonJSWrapper(
          compileSource,
          resolved,
          [require, this, this.exports, resolved, path.dirname(resolved),
            (specifier, options) => {
              if (typeof processObj.__bnhModuleImport === 'function') {
                return processObj.__bnhModuleImport(specifier, resolved, options);
              }
              if (typeof esmLoader !== 'undefined') return esmLoader.import(specifier, resolved, {}, options);
              return import(specifier, options);
            }],
          currentModuleWrapper,
        );
      };
      const compileCacheStatus = Object.freeze({
        FAILED: 'failed',
        ENABLED: 'enabled',
        ALREADY_ENABLED: 'already-enabled',
        DISABLED: 'disabled',
      });
      const isWriteAllowed = (directory) => {
        if (!(processObj.argv || []).some((value) => String(value) === '--permission' || String(value).startsWith('--permission='))) return true;
        const allowed = (processObj.argv || [])
          .map(String)
          .filter((value) => value.startsWith('--allow-fs-write='))
          .map((value) => value.slice('--allow-fs-write='.length));
        const normalizedDirectory = normalizePath(directory, processObj.cwd?.() || '/node');
        return allowed.some((value) => {
          const normalized = normalizePath(value, processObj.cwd?.() || '/node');
          return normalizedDirectory === normalized || normalizedDirectory.startsWith(`${normalized}/`);
        });
      };
      const enableCompileCache = (directory) => {
        if (directory !== undefined && typeof directory !== 'string') {
          const error = new TypeError('The "directory" argument must be of type string');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        const current = processObj.env?.NODE_COMPILE_CACHE;
        if (current) return { status: compileCacheStatus.ALREADY_ENABLED, directory: current };
        const requested = directory || processObj.env?.NODE_TEST_COMPILE_CACHE_DIR
          || processObj.env?.TMPDIR || processObj.env?.TEMP || processObj.env?.TMP || '/tmp';
        const resolved = normalizePath(directory ? directory : `${requested}/node-compile-cache`, processObj.cwd?.() || '/node');
        if (!isWriteAllowed(resolved)) {
          const message = `Skipping compile cache because write permission for ${resolved} is not granted`;
          childStderr(`${message}\n`);
          return { status: compileCacheStatus.FAILED, message };
        }
        try {
          fs.mkdirSync(resolved, { recursive: true });
          processObj.env.NODE_COMPILE_CACHE = resolved;
          return { status: compileCacheStatus.ENABLED, directory: resolved };
        } catch (error) {
          return { status: compileCacheStatus.FAILED, message: String(error?.message || error) };
        }
      };
      const registerHooks = (hooks = {}) => {
        if (hooks === null || typeof hooks !== 'object') {
          throw new TypeError('options must be an object');
        }
        if (hooks.resolve !== undefined && typeof hooks.resolve !== 'function') {
          throw new TypeError('resolve hook must be a function');
        }
        if (hooks.load !== undefined && typeof hooks.load !== 'function') {
          throw new TypeError('load hook must be a function');
        }
        const registry = processObj.__bnhModuleHooks || [];
        const record = { resolve: hooks.resolve, load: hooks.load };
        registry.push(record);
        processObj.__bnhModuleHooks = registry;
        return {
          deregister() {
            const index = registry.indexOf(record);
            if (index >= 0) registry.splice(index, 1);
          },
        };
      };
      const globalPaths = [];
      const modulePathCache = Object.create(null);
      const moduleExtensions = Object.create(null);
      const decodeModuleSource = (source) => typeof source === 'string'
        ? source
        : new TextDecoder().decode(source);
      const tryModuleFile = (filename, isMain) => {
        if (stat(filename) !== 0) return false;
        if (isMain) return path.resolve(filename);
        try { return fs.realpathSync(path.resolve(filename)); } catch { return path.resolve(filename); }
      };
      const tryModuleExtensions = (basePath, extensions, isMain) => {
        for (const extension of extensions) {
          const filename = tryModuleFile(`${basePath}${extension}`, isMain);
          if (filename) return filename;
        }
        return false;
      };
      const tryModulePackage = (requestPath, extensions, isMain, originalPath) => {
        const packageConfig = readPackage(requestPath);
        const packageMain = packageConfig.main;
        if (!packageMain) return tryModuleExtensions(path.resolve(requestPath, 'index'), extensions, isMain);

        const mainPath = path.resolve(requestPath, packageMain);
        const actual = tryModuleFile(mainPath, isMain)
          || tryModuleExtensions(mainPath, extensions, isMain)
          || tryModuleExtensions(path.resolve(mainPath, 'index'), extensions, isMain);
        if (actual) return actual;

        const fallback = tryModuleExtensions(path.resolve(requestPath, 'index'), extensions, isMain);
        if (!fallback) {
          const error = new Error(`Cannot find module '${mainPath}'. Please verify that the package.json has a valid "main" entry`);
          error.code = 'MODULE_NOT_FOUND';
          error.path = packageConfig.pjsonPath;
          error.requestPath = originalPath;
          throw error;
        }
        processObj.emitWarning?.(
          `Invalid 'main' field in '${packageConfig.pjsonPath}' of '${packageMain}'. Please either fix that or report it to the module author`,
          { code: 'DEP0128', type: 'DeprecationWarning' },
        );
        return fallback;
      };
      moduleExtensions['.js'] = (module, filename) => {
        const source = decodeModuleSource(readSource(filename));
        const format = filename.endsWith('.mjs') || isRuntimeEsmModule(filename, processObj.execArgv)
          ? 'module'
          : filename.endsWith('.cjs') ? 'commonjs' : undefined;
        module._compile(source, filename, format);
      };
      moduleExtensions['.json'] = (module, filename) => {
        try {
          module.exports = JSON.parse(decodeModuleSource(readSource(filename)).replace(/^\uFEFF/, ''));
        } catch (error) {
          error.message = `${filename}: ${error.message}`;
          throw error;
        }
      };
      moduleExtensions['.node'] = (_module, filename) => rejectNativeAddon(filename, processObj);
      const moduleDebug = (...args) => {
        const sections = String(processObj.env?.NODE_DEBUG || '')
          .split(',')
          .map((section) => section.trim().toUpperCase())
          .filter(Boolean);
        if (!sections.includes('MODULE') && !sections.includes('*') && !sections.includes('DEBUG')) return;
        childStderr?.(`MODULE ${processObj.pid || 0}: ${args.map(String).join(' ')}\n`);
      };
      const moduleDeprecatedDebug = createDeprecate(processObj)(
        moduleDebug,
        'Module._debug is deprecated.',
        'DEP0077',
      );
      const moduleNodePaths = (from) => {
        const absolute = path.resolve(from);
        if (absolute === '/') return ['/node_modules'];
        const paths = [];
        const nodeModulesName = 'node_modules';
        for (let index = absolute.length - 1, segmentLength = 0, last = absolute.length; index >= 0; index -= 1) {
          const character = absolute[index];
          if (character === '/') {
            if (segmentLength !== nodeModulesName.length) {
              paths.push(`${absolute.slice(0, last)}/node_modules`);
            }
            last = index;
            segmentLength = 0;
          } else if (segmentLength !== -1) {
            if (nodeModulesName[nodeModulesName.length - 1 - segmentLength] === character) segmentLength += 1;
            else segmentLength = -1;
          }
        }
        paths.push('/node_modules');
        return paths;
      };
      const moduleInitPaths = () => {
        const homeDir = processObj.platform === 'win32' ? processObj.env?.USERPROFILE : processObj.env?.HOME;
        const nodePath = processObj.platform === 'win32' ? processObj.env?.NODE_PATH : processObj.env?.NODE_PATH;
        const prefixDir = processObj.platform === 'win32'
          ? path.resolve(processObj.execPath, '..')
          : path.resolve(processObj.execPath, '..', '..');
        const paths = [path.resolve(prefixDir, 'lib', 'node')];
        if (homeDir) {
          paths.unshift(path.resolve(homeDir, '.node_libraries'));
          paths.unshift(path.resolve(homeDir, '.node_modules'));
        }
        if (nodePath) paths.unshift(...String(nodePath).split(path.delimiter).filter(Boolean));
        globalPaths.splice(0, globalPaths.length, ...paths);
        moduleApi.globalPaths = [...globalPaths];
      };
      const isRelativeModuleRequest = (request) => request[0] === '.'
        && (request.length === 1 || request === '..' || request.startsWith('./')
          || request.startsWith('../') || request.startsWith('.\\') || request.startsWith('..\\'));
      const moduleFindPath = (request, paths, isMain, _conditions) => {
        const absoluteRequest = path.isAbsolute(request);
        if (absoluteRequest) paths = [''];
        else if (!paths || paths.length === 0) return false;

        const cacheKey = `${request}\x00${paths.join('\x00')}`;
        const cached = modulePathCache[cacheKey];
        if (cached) return cached;

        const trailingSlash = request.length > 0 && (request.endsWith('/') || request === '.'
          || request.endsWith('/.') || request === '..' || request.endsWith('/..'));
        let insidePath = true;
        if (isRelativeModuleRequest(request) && path.normalize(request).startsWith('..')) insidePath = false;
        const extensions = Object.keys(moduleExtensions);
        for (const currentPath of paths) {
          if (typeof currentPath !== 'string') throw moduleArgumentTypeError('paths', 'array of strings', paths);
          if (insidePath && currentPath && stat(currentPath) < 1) continue;
          const basePath = path.resolve(currentPath, request);
          const result = !trailingSlash
            ? tryModuleFile(basePath, isMain) || tryModuleExtensions(basePath, extensions, isMain)
            : false;
          const directoryResult = result || (stat(basePath) === 1
            ? tryModulePackage(basePath, extensions, isMain, request)
            : false);
          if (directoryResult) {
            modulePathCache[cacheKey] = directoryResult;
            return directoryResult;
          }
        }
        return false;
      };
      const stat = (filename) => {
        if (typeof filename !== 'string') throw moduleArgumentTypeError('filename', 'string', filename);
        try {
          const stats = fs.statSync(filename);
          return stats.isDirectory?.() ? 1 : stats.isFile?.() ? 0 : -1;
        } catch {
          return -2;
        }
      };
      const readPackage = (requestPath) => {
        if (typeof requestPath !== 'string') throw moduleArgumentTypeError('requestPath', 'string', requestPath);
        const pjsonPath = path.resolve(requestPath, 'package.json');
        let parsed;
        try {
          const source = readSource(pjsonPath);
          parsed = JSON.parse(typeof source === 'string' ? source : new TextDecoder().decode(source));
        } catch (error) {
          if (error?.code === 'ENOENT') return Object.assign(Object.create(null), {
            type: 'none',
            exists: false,
            pjsonPath,
          });
          const invalid = new Error(`Invalid package config '${pjsonPath}'`);
          invalid.code = 'ERR_INVALID_PACKAGE_CONFIG';
          invalid.path = pjsonPath;
          invalid.cause = error;
          throw invalid;
        }
        const result = Object.create(null);
        for (const key of ['name', 'main', 'type', 'imports', 'exports']) {
          if (parsed[key] !== undefined) result[key] = parsed[key];
        }
        result.exists = true;
        result.pjsonPath = pjsonPath;
        return result;
      };
      const resolveLookupPaths = (request, parent) => {
        if (typeof request !== 'string') throw moduleArgumentTypeError('request', 'string', request);
        if (BUILTIN_NAMES.includes(builtinName(request))) return null;
        const relative = request[0] === '.'
          && (request.length === 1 || request[1] === '.' || request[1] === '/' || request[1] === '\\');
        if (!relative) {
          const parentPaths = parent?.paths?.length ? [...parent.paths] : [];
          const paths = [...parentPaths, ...globalPaths];
          return paths.length ? paths : null;
        }
        if (!parent?.id || !parent.filename) return ['.'];
        return [path.dirname(parent.filename)];
      };
      const resolveFilename = (request, parent, isMain, options) => {
        if (typeof request !== 'string') throw moduleArgumentTypeError('request', 'string', request);
        if (BUILTIN_NAMES.includes(builtinName(request))) return request;
        if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
          throw moduleArgumentTypeError('options', 'object', options);
        }
        const importer = typeof parent === 'string' ? parent : parent?.filename || sourcePath;
        const conditions = options?.conditions || ['node', 'require'];
        let resolved;
        try {
          if (options?.paths !== undefined && !Array.isArray(options.paths)) {
            const error = new TypeError(`The \"options.paths\" property must be an array of strings. Received ${String(options.paths)}`);
            error.code = 'ERR_INVALID_ARG_VALUE';
            throw error;
          }
          if (options?.paths?.length && !request.startsWith('.') && !request.startsWith('/')) {
            const candidates = [];
            for (const lookupPath of options.paths) {
              if (typeof lookupPath !== 'string') throw moduleArgumentTypeError('options.paths', 'an array of strings', options.paths);
              const fakeImporter = path.join(normalizePath(lookupPath, processObj.cwd?.() || '/node'), 'index.js');
              candidates.push(esmLoader.resolve(request, fakeImporter, conditions));
            }
            resolved = candidates.find((candidate) => candidate && (candidate.startsWith('/') || candidate.startsWith('file:')));
          } else {
            resolved = esmLoader.resolve(request, importer, conditions);
          }
        } catch (error) {
          if (error?.code && error.code !== 'MODULE_NOT_FOUND') throw error;
        }
        if (resolved?.startsWith('file:')) resolved = fileURLToPath(resolved);
        if (resolved && (resolved.startsWith('/') || resolved.startsWith('file:'))) {
          const candidate = moduleCandidates(resolved).find((pathname) => vfs.files.has(pathname));
          if (candidate) return candidate;
        }
        const requireStack = [];
        for (let cursor = typeof parent === 'object' ? parent : null; cursor; cursor = cursor.parent) {
          requireStack.push(cursor.filename || cursor.id);
        }
        const error = new Error(`Cannot find module '${request}'${requireStack.length ? `\nRequire stack:\n- ${requireStack.join('\n- ')}` : ''}`);
        error.code = 'MODULE_NOT_FOUND';
        error.requireStack = requireStack;
        throw error;
      };
      const moduleApi = Object.assign(Module, {
        builtinModules: BUILTIN_NAMES,
        globalPaths,
        _debug: moduleDeprecatedDebug,
        _extensions: moduleExtensions,
        _findPath: moduleFindPath,
        _initPaths: moduleInitPaths,
        _nodeModulePaths: moduleNodePaths,
        _pathCache: modulePathCache,
        _preloadModules: (requests) => {
          if (!Array.isArray(requests)) return;
          processObj.__bnhModuleIsPreloading = true;
          const parent = new Module('internal/preload', null);
          try {
            parent.paths = moduleApi._nodeModulePaths(processObj.cwd?.() || '/node');
            for (const request of requests) parent.require(request);
          } finally {
            processObj.__bnhModuleIsPreloading = false;
          }
        },
        _readPackage: readPackage,
        _stat: stat,
        _resolveLookupPaths: resolveLookupPaths,
        _resolveFilename: resolveFilename,
        _load: (name, parent, isMain) => runtimeRequire(
          name,
          typeof parent === 'string' ? parent : parent?.filename || sourcePath,
        ),
        wrap: (script) => `${currentModuleWrapper[0]}${script}${currentModuleWrapper[1]}`,
        createRequire: (filename) => {
          const importer = typeof filename === 'string' && filename.startsWith('file:')
            ? fileURLToPath(filename)
            : String(filename || sourcePath);
          return (name) => BUILTIN_NAMES.includes(builtinName(name))
            ? moduleApi._load(name, importer)
            : runtimeRequire(name, importer);
        },
        isBuiltin: (name) => BUILTIN_NAMES.includes(builtinName(name)),
        findSourceMap,
        getSourceMapsSupport,
        runMain: (main = processObj.argv?.[1]) => {
          const entryPath = main === undefined ? sourcePath : String(main);
          const normalized = entryPath.startsWith('file:') ? fileURLToPath(entryPath) : normalizePath(entryPath, processObj.cwd?.() || '/node');
          if (normalized === normalizePath(sourcePath, processObj.cwd?.() || '/node')) return undefined;
          return moduleApi._load(normalized, null, true);
        },
        findPackageJSON: (specifier, parentLocation) => {
          if (specifier === undefined) {
            const error = new TypeError('The "specifier" argument must be specified');
            error.code = 'ERR_MISSING_ARGS';
            throw error;
          }
          if (parentLocation !== undefined
            && typeof parentLocation !== 'string'
            && !(parentLocation instanceof URL)) {
            const error = new TypeError('The "parentURL" argument must be a string or URL');
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
          }
          const parentPath = parentLocation === undefined
            ? sourcePath
            : parentLocation instanceof URL || String(parentLocation).startsWith('file:')
              ? fileURLToPath(parentLocation)
              : normalizePath(parentLocation, processObj.cwd?.() || '/node');
          const value = specifier instanceof URL ? String(specifier) : String(specifier);
          let resolved;
          if (!value.startsWith('.') && !value.startsWith('/') && !value.startsWith('file:')) {
            const packageName = value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0];
            let directory = path.dirname(parentPath);
            while (true) {
              const packageRoot = path.join(directory, 'node_modules', packageName);
              if (vfs.files.has(path.join(packageRoot, 'package.json'))) return path.join(packageRoot, 'package.json');
              if (directory === '/') break;
              directory = path.dirname(directory);
            }
          }
          resolved = value.startsWith('file:')
            ? fileURLToPath(value)
            : value.startsWith('.')
              ? normalizePath(value, path.dirname(parentPath))
              : normalizePath(value, processObj.cwd?.() || '/node');
          if (resolved.startsWith('node:') || resolved.startsWith('data:')) return undefined;
          let directory = path.dirname(resolved);
          while (true) {
            const packagePath = path.join(directory, 'package.json');
            if (vfs.files.has(packagePath)) return packagePath;
            if (directory === '/') return undefined;
            directory = path.dirname(directory);
          }
        },
        enableCompileCache,
        getCompileCacheDir: () => processObj.env?.NODE_COMPILE_CACHE,
        flushCompileCache: () => {},
        constants: { compileCacheStatus },
        register: (specifier, options = {}) => {
          if (specifier === undefined) {
            const error = new TypeError('The "specifier" argument must be specified');
            error.code = 'ERR_MISSING_ARGS';
            throw error;
          }
          if (options === null || typeof options !== 'object') {
            const error = new TypeError('The "options" argument must be of type object');
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
          }
          const registrations = processObj.__bnhModuleRegistrations || [];
          registrations.push({ specifier, options, parentURL: sourcePath });
          processObj.__bnhModuleRegistrations = registrations;
        },
        registerHooks,
        syncBuiltinESMExports: () => syncBuiltinESMExportsImpl(),
        SourceMap,
        setSourceMapsSupport: (enabled, options = {}) => {
          if (typeof enabled !== 'boolean') throw moduleArgumentTypeError('enabled', 'boolean', enabled);
          if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw moduleArgumentTypeError('options', 'object', options);
          }
          const nodeModules = options.nodeModules ?? false;
          const generatedCode = options.generatedCode ?? false;
          if (typeof nodeModules !== 'boolean') {
            throw modulePropertyTypeError('options.nodeModules', 'boolean', nodeModules);
          }
          if (typeof generatedCode !== 'boolean') {
            throw modulePropertyTypeError('options.generatedCode', 'boolean', generatedCode);
          }
          sourceMapsSupport = Object.freeze({ enabled, nodeModules, generatedCode });
        },
        stripTypeScriptTypes: (code, options = {}) => {
          if (typeof code !== 'string') throw moduleArgumentTypeError('code', 'string', code);
          if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw moduleArgumentTypeError('options', 'object', options);
          }
          const mode = options.mode === undefined ? 'strip' : options.mode;
          if (mode !== 'strip' && mode !== 'transform') {
            const error = new TypeError(`The property 'options.mode' must be one of: 'strip', 'transform'. Received ${String(mode)}`);
            error.code = 'ERR_INVALID_ARG_VALUE';
            throw error;
          }
          const sourceMap = options.sourceMap === undefined ? false : options.sourceMap;
          if (typeof sourceMap !== 'boolean') {
            throw modulePropertyTypeError('options.sourceMap', 'boolean', sourceMap);
          }
          const sourceUrl = options.sourceUrl === undefined ? '' : options.sourceUrl;
          if (typeof sourceUrl !== 'string') {
            throw modulePropertyTypeError('options.sourceUrl', 'string', sourceUrl);
          }
          if (mode === 'strip' && sourceMap) {
            const error = new TypeError("The property 'options.sourceMap' must be one of: false, undefined. Received true");
            error.code = 'ERR_INVALID_ARG_VALUE';
            throw error;
          }
          if (mode === 'transform' && sourceMap) {
            const error = new Error('TypeScript source-map generation is unavailable in the browser runtime');
            error.code = 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';
            throw error;
          }
          const transformed = stripTypeScriptSource(code);
          return sourceUrl ? `${transformed}\n\n//# sourceURL=${sourceUrl}` : transformed;
        },
      });
      moduleApi.Module = Module;
      Object.defineProperties(moduleApi, {
        wrapper: {
          configurable: true,
          enumerable: true,
          get: () => currentModuleWrapper,
          set: (value) => { currentModuleWrapper = value; },
        },
      });
      Object.defineProperty(moduleApi, '_bnhSetSyncBuiltinESMExports', {
        configurable: true,
        value: (implementation) => { syncBuiltinESMExportsImpl = implementation; },
      });
      Object.defineProperty(processObj, '__bnhModuleApi', { configurable: true, value: moduleApi });
      return moduleApi;
    };
    const moduleApi = createModuleApi(processObject);
    const callableReadable = function callableReadable(...args) {
      if (new.target) {
        const instance = new Readable(...args);
        if (new.target.prototype && new.target.prototype !== Readable.prototype) Object.setPrototypeOf(instance, new.target.prototype);
        return instance;
      }
      return new Readable(...args);
    };
    callableReadable.prototype = Readable.prototype;
    Object.setPrototypeOf(callableReadable, Readable);
    callableReadable.fromWeb = (readableStream, options) => runtimeRequire('internal/webstreams/adapters')
      .newStreamReadableFromReadableStream(readableStream, options);
    callableReadable.toWeb = (readable, options) => runtimeRequire('internal/webstreams/adapters')
      .newReadableStreamFromStreamReadable(readable, options);
    Writable.fromWeb = (writableStream, options) => runtimeRequire('internal/webstreams/adapters')
      .newStreamWritableFromWritableStream(writableStream, options);
    Writable.toWeb = (writable, options) => runtimeRequire('internal/webstreams/adapters')
      .newWritableStreamFromStreamWritable(writable, options);
    Object.assign(Stream, {
      Stream,
      Readable: callableReadable,
      Writable,
      Duplex,
      Transform,
      PassThrough,
      duplexPair,
      pipeline,
      destroy,
      compose,
      isDestroyed,
      isDisturbed,
      isErrored,
      isReadable,
      isWritable,
      promises: streamPromises,
      addAbortSignal,
      finished,
      setDefaultHighWaterMark,
      getDefaultHighWaterMark,
    });
    const streamApi = Stream;
    Duplex.fromWeb = (pair, options) => runtimeRequire('internal/webstreams/adapters')
      .newStreamDuplexFromReadableWritablePair(pair, options);
    Duplex.toWeb = (duplex) => runtimeRequire('internal/webstreams/adapters')
      .newReadableWritablePairFromDuplex(duplex);
    const streamWebApi = createNodeWebStreamModule(runtimeRequire);
    const streamConsumers = createStreamConsumers(scope, Buffer);
    const streamPromisePipeline = (...args) => new Promise((resolve, reject) => {
      pipeline(...args, (error) => error ? reject(error) : resolve());
    });
    const streamPromiseFinished = (stream, options) => finished(stream, options);
    streamPromises.pipeline = streamPromisePipeline;
    streamPromises.finished = streamPromiseFinished;
    const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
    Object.defineProperty(pipeline, promisifyCustom, {
      configurable: true,
      enumerable: true,
      value: streamPromisePipeline,
    });
    Object.defineProperty(finished, promisifyCustom, {
      configurable: true,
      enumerable: true,
      value: streamPromiseFinished,
    });
    const unsupportedBuiltins = createUnsupportedBuiltins();
    const sqlite = createSqliteModule();
    const notifyDnsLookup = () => {
      scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ = Math.max(1, Number(scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ || 0));
    };
    const dns = {
      ...dnsModule,
      lookup(...args) {
        notifyDnsLookup();
        return Reflect.apply(dnsModule.lookup, this, args);
      },
      promises: {
        ...dnsModule.promises,
        lookup(...args) {
          notifyDnsLookup();
          return Reflect.apply(dnsModule.promises.lookup, this, args);
        },
      },
      resolve(hostname, rrtype, callback) {
        scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ = Number(scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ || 0) + 1;
        const onComplete = (...result) => {
          try { actualCallback(...result); }
          finally { scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ = Math.max(0, Number(scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ || 1) - 1); }
        };
        const actualCallback = typeof rrtype === 'function' ? rrtype : callback;
        if (typeof actualCallback !== 'function') {
          // Let the DNS implementation validate rrtype before reporting a
          // missing callback, matching Node's synchronous error ordering.
          return Reflect.apply(dnsModule.resolve, this, [hostname, rrtype, actualCallback]);
        }
        return Reflect.apply(dnsModule.resolve, this, [hostname, rrtype, onComplete]);
      },
    };
    const dnsPromises = dns.promises;
    const notifyClusterListening = runtimeOptions.clusterWorker && typeof processObject.send === 'function'
      ? (address) => {
          return processObject.send({ type: 'bnh-cluster-listening', address });
        }
      : undefined;
    let cluster;
    const net = createBrowserNet({
      network: virtualNetwork,
      dns,
      BufferClass: Buffer,
      trackTask,
      getTaskTracker: () => scope.process?._bnhTaskTracker || trackTask,
      currentProcess: () => scope.process,
      runInProcessContext: (owner, callback) => {
        const previousProcess = scope.process;
        const previousTimers = {
          setTimeout: scope.setTimeout,
          clearTimeout: scope.clearTimeout,
          setInterval: scope.setInterval,
          clearInterval: scope.clearInterval,
          setImmediate: scope.setImmediate,
          clearImmediate: scope.clearImmediate,
        };
        scope.process = owner;
        if (owner?._bnhTimerContext) Object.assign(scope, owner._bnhTimerContext);
        try {
          return callback();
        } finally {
          Object.assign(scope, previousTimers);
          scope.process = previousProcess;
        }
      },
      onListening: notifyClusterListening,
      cluster: () => cluster,
    });
    const dgram = createBrowserDgram({
      network: virtualNetwork,
      BufferClass: Buffer,
      trackTask,
      diagnostics: () => scope.__BNH_DIAGNOSTICS__,
      cluster: () => cluster,
      clusterGroupId: runtimeOptions.clusterGroupId,
      onListening: notifyClusterListening,
      processOwner: processObject,
      runInProcessContext: (owner, callback) => {
        const previous = scope.process;
        scope.process = owner;
        try { return callback(); }
        finally { scope.process = previous; }
      },
    });
    const internalBindingContract = createBrowserInternalBindings({
      globalObject: scope,
      constants: createBaseConstants(),
      network: virtualNetwork,
      onWorkerMessage: (message) => {
        if (!options.workerThread || typeof processObject?.send !== 'function') return;
        processObject.send({ __bnhInternalWorkerMessage: message?.type });
      },
    });
    internalBindingContract.bindings.constants.os.signals = Object.freeze({
      ...internalBindingContract.bindings.constants.os.signals,
      ...BROWSER_SIGNAL_CONSTANTS,
    });
    installErrnoConstants(internalBindingContract.bindings.constants.os.errno, constants);
    delete internalBindingContract.bindings.constants.fs.crypto;
    processObject.binding = (name) => {
      if (name === 'test') {
        const error = new Error('No such module: test');
        error.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
        throw error;
      }
      if (name === 'util') {
        const names = [
          'isAnyArrayBuffer', 'isArrayBuffer', 'isArrayBufferView', 'isAsyncFunction',
          'isDataView', 'isDate', 'isExternal', 'isMap', 'isMapIterator', 'isNativeError',
          'isPromise', 'isRegExp', 'isSet', 'isSetIterator', 'isTypedArray', 'isUint8Array',
        ];
        return Object.fromEntries(names.map((key) => [key, utilTypes[key]]));
      }
      const binding = internalTestBinding.internalBinding(name);
      if (name === 'uv' && typeof binding.errname !== 'function') {
        binding.errname = (value) => {
          processObject.emitWarning(
            'Directly calling process.binding(\'uv\').errname(<val>) is being deprecated. ' +
            'Please make sure to use util.getSystemErrorName() instead.',
            { code: 'DEP0119' },
          );
          return String(value);
        };
      }
      return binding;
    };
    const { arrow_message_private_symbol: arrowMessageSymbol, decorated_private_symbol: decoratedSymbol } = (
      internalBindingContract.bindings.util.privateSymbols
    );
    const debugSections = () => String(processObject?.env?.NODE_DEBUG || '')
      .split(',')
      .map((section) => section.trim().toUpperCase())
      .filter(Boolean);
    const testDebugEnabled = (section) => {
      const name = String(section).toUpperCase();
      const enabled = debugSections();
      return enabled.includes(name) || enabled.includes('*') || enabled.includes('DEBUG');
    };
    const debuglog = (section, callback) => {
      const enabled = testDebugEnabled(section);
      let initialized = false;
      const logger = (...args) => {
        if (!initialized) {
          initialized = true;
          if (typeof callback === 'function') callback(logger);
        }
        if (!enabled) return;
        stderr?.(`${String(section).toUpperCase()} ${processObject?.pid || 0}: ${args.map(String).join(' ')}\n`);
      };
      Object.defineProperty(logger, 'enabled', { configurable: true, enumerable: true, get: () => enabled });
      return logger;
    };
    const internalUtil = {
      customInspectSymbol: Symbol.for('nodejs.util.inspect.custom'),
      customPromisifyArgs: Symbol.for('nodejs.util.promisify.customArgs'),
      SymbolDispose: Symbol.dispose || Symbol.for('nodejs.dispose'),
      SymbolAsyncDispose: Symbol.asyncDispose || Symbol.for('nodejs.asyncDispose'),
      kEmptyObject: Object.freeze({}),
      kEnumerableProperty: { enumerable: true },
      normalizeEncoding: (value) => String(value || 'utf8').toLowerCase(),
      isError: (value) => value instanceof Error,
      getConstructorOf: (value) => value?.constructor,
      join: (items, separator = '') => Array.from(items || []).join(separator),
      removeColors: (value) => String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''),
      getSystemErrorName: (code) => ({ [-1]: 'EPERM', [-4094]: 'UNKNOWN' }[code] || `Unknown system error ${code}`),
      getSystemErrorMessage: (code) => String(code),
      getSystemErrorMap: () => new Map(),
      isMacOS: () => false,
      isWindows: () => false,
      emitExperimentalWarning: (feature, messagePrefix = '', code) => processObject.emitWarning?.(`${messagePrefix}${feature}`, { code, type: 'ExperimentalWarning' }),
      assertCrypto: () => {},
      filterDuplicateStrings: (items, lowerCase = false) => [...new Set(
        (items || []).map((item) => lowerCase ? String(item).toLowerCase() : item),
      )].sort(),
      getDeprecationWarningEmitter: () => () => {},
      encodingsMap: Object.freeze({ utf8: 1, hex: 2, base64: 3, base64url: 4, latin1: 5, ascii: 6, buffer: 7 }),
      cachedResult: (factory) => {
        let initialized = false;
        let value;
        return (...args) => {
          if (!initialized) {
            value = factory(...args);
            initialized = true;
          }
          return value;
        };
      },
      guessHandleType: internalBindingContract.bindings.util.guessHandleType,
      privateSymbols: internalBindingContract.bindings.util.privateSymbols,
      defineLazyProperties: internalBindingContract.bindings.util.defineLazyProperties,
      sleep: internalBindingContract.bindings.util.sleep,
      assignFunctionName: internalBindingContract.bindings.util.assignFunctionName,
      deprecate: createDeprecate(processObject),
      once: onceCallback,
      promisify: createPromisify(),
      setOwnProperty: (target, key, value) => Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value }),
      pendingDeprecate: (fn) => fn,
      isPendingDeprecation: () => false,
      WeakReference: WeakRef,
      getLazy: (value) => value,
      decorateErrorStack: (error) => {
        if (!(error instanceof Error) || !error.stack || error[decoratedSymbol]) return;
        const arrowMessage = error[arrowMessageSymbol];
        if (arrowMessage) {
          error.stack = `${arrowMessage}${error.stack}`;
          error[decoratedSymbol] = true;
        }
      },
      SideEffectFreeRegExpPrototypeSymbolReplace: (pattern, value, replacement) => String.prototype.replace.call(value, pattern, replacement),
      SideEffectFreeRegExpPrototypeSymbolSplit: (pattern, value, limit) => String.prototype.split.call(value, pattern, limit),
      debuglog,
      testEnabled: testDebugEnabled,
      initializeDebugEnv: () => {},
    };
    const internalUtilTypes = {
      isAnyArrayBuffer: (value) => value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer),
      isArrayBuffer: (value) => value instanceof ArrayBuffer,
      isSharedArrayBuffer: (value) => typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer,
      isArgumentsObject: (value) => Object.prototype.toString.call(value) === '[object Arguments]',
      isAsyncFunction: (value) => Object.prototype.toString.call(value) === '[object AsyncFunction]',
      isBigIntObject: (value) => Object.prototype.toString.call(value) === '[object BigInt]',
      isBooleanObject: (value) => Object.prototype.toString.call(value) === '[object Boolean]',
      isBoxedPrimitive: (value) => ['[object BigInt]', '[object Boolean]', '[object Number]', '[object String]', '[object Symbol]'].includes(Object.prototype.toString.call(value)),
      isDataView: (value) => value instanceof DataView,
      isDate: (value) => value instanceof Date,
      isExternal: () => false,
      isGeneratorFunction: (value) => Object.prototype.toString.call(value) === '[object GeneratorFunction]',
      isMap: (value) => value instanceof Map,
      isMapIterator: (value) => Object.prototype.toString.call(value) === '[object Map Iterator]',
      isModuleNamespaceObject: (value) => Object.prototype.toString.call(value) === '[object Module]',
      isNativeError: (value) => value instanceof Error,
      isNumberObject: (value) => Object.prototype.toString.call(value) === '[object Number]',
      isPromise: (value) => value instanceof Promise,
      isRegExp: (value) => value instanceof RegExp,
      isSet: (value) => value instanceof Set,
      isSetIterator: (value) => Object.prototype.toString.call(value) === '[object Set Iterator]',
      isStringObject: (value) => Object.prototype.toString.call(value) === '[object String]',
      isArrayBufferView: (value) => ArrayBuffer.isView(value),
      isTypedArray: (value) => ArrayBuffer.isView(value) && !(value instanceof DataView),
      isUint8Array: (value) => value instanceof Uint8Array,
      isWeakMap: (value) => value instanceof WeakMap,
      isWeakSet: (value) => value instanceof WeakSet,
    };
    const internalOptions = { getOptionValue: () => undefined, getAllowUnauthorized: () => false };
    const internalDgram = {
      kStateSymbol: Symbol.for('bnh.dgram.state'),
      _createSocketHandle: dgram._createSocketHandle,
      newHandle: dgram.newHandle,
    };
    class BrowserBuiltinModule {
      static exists(name) { return BUILTIN_NAMES.includes(String(name).replace(/^node:/, '')); }
      static canBeRequiredByUsers(name) { return this.exists(name); }
      static canBeRequiredWithoutScheme(name) { return this.exists(name); }
      static normalizeRequirableId(name) {
        const value = String(name);
        const normalized = value.startsWith('node:') ? value.slice(5) : value;
        return this.exists(normalized) ? normalized : undefined;
      }
      static getSchemeOnlyModuleNames() { return []; }
      static getCanBeRequiredByUsersWithoutSchemeList() { return [...BUILTIN_NAMES]; }
      static exposeInternals() {}
    }
    class BrowserCjsModule {
      constructor(filename = '') {
        this.filename = filename;
        this.paths = [];
        this.exports = {};
        this.loaded = false;
        this.children = [];
      }
      require(name) { return runtimeRequire(name, this.filename); }
      static _nodeModulePaths() { return []; }
      static _resolveLookupPaths() { return []; }
    }
    BrowserCjsModule.builtinModules = BUILTIN_NAMES;
    BrowserCjsModule.globalPaths = [];
    BrowserCjsModule._extensions = Object.create(null);
    const internalBootstrapRealm = { BuiltinModule: BrowserBuiltinModule };
    const internalCjsLoader = { Module: BrowserCjsModule };
    const activeProxy = proxyCapability.mode === 'proxy' && proxyCapability.enabled
      && proxyCapability.capabilityGranted && proxyCapability.adapter
      ? proxyCapability
      : undefined;
    const httpCompatibility = activeProxy
      ? createHttpCompatibility(scope, {
          Buffer,
          proxy: activeProxy,
          net,
          trackTask,
          diagnostics: () => scope.__BNH_DIAGNOSTICS__,
        })
      : (() => {
          const cacheKey = '__BNH_HTTP_COMPATIBILITY_BY_NETWORK__';
          let cache = scope[cacheKey];
          if (!cache) {
            cache = new Map();
            Object.defineProperty(scope, cacheKey, { configurable: true, value: cache });
          }
          const cached = cache.get(virtualNetwork);
          const compatibility = createHttpCompatibility(scope, {
            Buffer,
            httpNetwork: cached?.httpNetwork || cached?.compatibility?.httpNetwork,
            net,
            proxyEnv: processObject.env,
            trackTask,
            diagnostics: () => scope.__BNH_DIAGNOSTICS__,
          });
          if (!runtimeOptions.clusterWorker && !cached) {
            cache.set(virtualNetwork, { httpNetwork: compatibility.httpNetwork });
          }
          return compatibility;
        })();
    const tls = createTlsModule(scope, {
      net,
      BufferClass: Buffer,
      proxy: activeProxy,
      diagnostics: diagnosticsChannels,
    });
    const http2 = createHttp2Module(scope, {
      proxy: activeProxy,
      vfs,
      diagnostics: diagnosticsChannels,
      trackTask,
    });
    cluster = createCluster({
      process: processObject,
      network: virtualNetwork,
      processFactory: (processOptions) => trackVirtualProcess(createVirtualProcess({
        ...processOptions,
        forceFallback: true,
        deferRun: true,
      })),
      scope,
      runId: runSpec?.runId,
      environment: processObject.env,
      diagnostics: diagnosticsChannels,
      childProcessClass: BrowserChildProcess,
      signalGrants: capabilities?.manifest?.signals?.allowed,
      maxChildren: capabilities?.manifest?.workers?.maxChildren,
      stdout,
      stderr,
      isWorker: Boolean(runtimeOptions.clusterWorker),
      id: runtimeOptions.clusterWorkerId,
      clusterGroupId: runtimeOptions.clusterGroupId,
      workerRun: ({ process: childProcess, signal, clusterGroupId }) => {
        const workerEntry = runtimeOptions.entry;
        if (!workerEntry) throw new Error('cluster worker entry is unavailable');
        return execute(workerEntry, {
          ...runtimeOptions,
          entry: workerEntry,
          processObject: childProcess,
          signal,
          argv: childProcess.argv,
          execArgv: childProcess.execArgv,
          env: childProcess.env,
          cwd: childProcess.cwd?.() || '/node',
          clusterWorker: true,
          clusterWorkerId: childProcess.pid,
          clusterGroupId,
        }, stdout, stderr);
      },
    });
    const v8 = createBrowserV8Module(processObject, scope);
    const internalTestBindingBase = createInternalTestBinding(processObject);
    const internalTestBinding = {
      // Keep internal/test/binding and the public internalBinding hook on the
      // same contract so stateful bindings (notably stream_wrap) are shared.
      __bnhContract: internalBindingContract,
      primordials: createPrimordials(scope),
      internalBinding(name) {
        try { return internalBindingContract.internalBinding(name); }
        catch { return internalTestBindingBase.internalBinding(name); }
      },
    };
    const internalEventTarget = createInternalEventTarget(scope);
    const assert = createAssert({ readSource, sourcePath, process: processObject });
    const scheduleTimer = (callback, delay, repeat, type, args) => processObject._bnhSetTimer(
      function timerCallback() { return callback.apply(this, args); },
      delay,
      repeat,
      type,
    );
    const scheduleLegacyTimer = (item, refed) => {
      if (item?._bnhTimer) processObject._bnhClearTimer(item._bnhTimer);
      if (item._idleTimeout < 0 || item._idleTimeout === undefined) return item;
      const handle = processObject._bnhSetTimer(
        function legacyTimerCallback() {
          item._bnhTimer = null;
          item._onTimeout?.call(item);
        },
        item._idleTimeout,
        false,
        'Timeout',
      );
      if (!refed) handle.unref?.();
      item._bnhTimer = handle;
      return item;
    };
    const timers = {
      setTimeout: (callback, delay, ...args) => scheduleTimer(callback, delay, false, 'Timeout', args),
      clearTimeout: (handle) => processObject._bnhClearTimer(handle),
      setImmediate: (callback, ...args) => scheduleTimer(callback, 0, false, 'Immediate', args),
      clearImmediate: (handle) => processObject._bnhClearTimer(handle),
      setInterval: (callback, delay, ...args) => scheduleTimer(callback, delay, true, 'Timeout', args),
      clearInterval: (handle) => processObject._bnhClearTimer(handle),
      enroll(item, msecs) {
        if (typeof msecs !== 'number') {
          const error = new TypeError('The "msecs" argument must be of type number');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (!Number.isFinite(msecs) || msecs < 0) {
          const error = new RangeError(
            `The value of "msecs" is out of range. It must be a non-negative finite number. Received ${msecs}`,
          );
          error.code = 'ERR_OUT_OF_RANGE';
          throw error;
        }
        item._idleTimeout = msecs;
        item._idleStart = Date.now();
        return item;
      },
      active(item) { return scheduleLegacyTimer(item, true); },
      _unrefActive: createDeprecate(processObject)(
        (item) => scheduleLegacyTimer(item, false),
        'timers._unrefActive() is deprecated. Please use timeout.refresh() instead.',
        'DEP0127',
      ),
      unenroll(item) {
        if (item?._bnhTimer) processObject._bnhClearTimer(item._bnhTimer);
        else processObject._bnhClearTimer(item);
        if (item) item._idleTimeout = -1;
        return item;
      },
    };
    Object.defineProperty(timers, 'promises', {
      configurable: true,
      enumerable: true,
      get() { return timerPromises; },
    });
    const timerPromises = createTimerPromises(scope, trackTask);
    const nodeTest = createNodeTest({ scope, processObject, stdout, stderr, trackTask, assert: assert.strict });
    const vm = createVmModule(scope);
    const asyncHooks = createAsyncHooksModule();
    processObject._bnhExecutionAsyncId = asyncHooks.executionAsyncId;
    Object.defineProperty(processObject, '_bnhRunWithErrorScope', {
      configurable: true,
      value: asyncHooks._bnhRunWithErrorScope,
    });
    Object.defineProperty(processObject, '_bnhRunWithPromiseScope', {
      configurable: true,
      value: asyncHooks._bnhRunWithPromiseScope,
    });
    const maxHeaderSizeArgument = (runtimeOptions.execArgv || [])
      .map(String)
      .find((argument) => argument === '--max-http-header-size' || argument.startsWith('--max-http-header-size='));
    const maxHeaderSizeValue = maxHeaderSizeArgument === '--max-http-header-size'
      ? Number((runtimeOptions.execArgv || [])[runtimeOptions.execArgv.indexOf(maxHeaderSizeArgument) + 1])
      : Number(maxHeaderSizeArgument?.slice('--max-http-header-size='.length));
    httpCompatibility.http.maxHeaderSize = Number.isInteger(maxHeaderSizeValue) && maxHeaderSizeValue > 0
      ? maxHeaderSizeValue
      : 16 * 1024;
    return {
      assert, 'assert/strict': assert.strict,
      buffer: {
        Buffer,
        Blob,
        File,
        atob: Buffer.atob,
        btoa: Buffer.btoa,
        resolveObjectURL: Buffer.resolveObjectURL,
        transcode,
        SlowBuffer: Buffer.SlowBuffer,
        constants: Buffer.constants,
        kMaxLength: Buffer.kMaxLength,
        kStringMaxLength: Buffer.kStringMaxLength,
        get INSPECT_MAX_BYTES() { return Buffer.INSPECT_MAX_BYTES; },
        set INSPECT_MAX_BYTES(value) { Buffer.INSPECT_MAX_BYTES = value; },
        isAscii,
        isUtf8,
      },
      console: createConsoleModule(processObject), constants, crypto: nodeCrypto, punycode: createPunycodeModule(),
      domain: createDomainModule(processObject),
      events: (() => {
        EventEmitter.EventEmitter = EventEmitter;
        EventEmitter.addAbortListener = addAbortListener;
        EventEmitter.getEventListeners = getEventListeners;
        EventEmitter.getMaxListeners = getMaxListeners;
        EventEmitter.once = once;
        return EventEmitter;
      })(), fs, 'fs/promises': fs.promises,
      http: httpCompatibility.http, https: httpCompatibility.https, '_http_common': httpCompatibility.httpCommon,
      '_http_outgoing': httpCompatibility.http, '_http_server': {
        ...httpCompatibility.http,
        kConnectionsCheckingInterval,
      }, http2, dns, 'dns/promises': dnsPromises,
      'internal/event_target': internalEventTarget, 'internal/async_context_frame': BrowserAsyncContextFrame,
      'internal/async_hooks': asyncHooks.internal,
      'internal/test/binding': internalTestBinding, 'internal/test/transfer': {}, module: moduleApi, os: platform.os,
      'internal/bootstrap/realm': internalBootstrapRealm, 'internal/modules/cjs/loader': internalCjsLoader,
      'internal/util': internalUtil, 'internal/util/debuglog': {
        debuglog,
        testEnabled: testDebugEnabled,
        initializeDebugEnv: () => {},
      }, 'internal/util/types': internalUtilTypes, 'internal/options': internalOptions, 'internal/dgram': internalDgram,
      'internal/modules/esm/utils': { registerModule() {}, initializeESM() {}, getDefaultConditions: () => ['node', 'import'] },
      'internal/vm/module': {
        importModuleDynamicallyWrap(callback) {
          return async (...args) => {
            const value = await callback(...args);
            return value?.namespace || value;
          };
        },
      },
      path: nodePath, 'path/posix': path.posix, 'path/win32': path.win32, process: processObject, querystring: createQuerystring(),
      stream: streamApi, 'stream/consumers': streamConsumers, 'stream/web': streamWebApi,
      'stream/promises': streamPromises,
      timers, 'timers/promises': timerPromises, string_decoder: { StringDecoder: createStringDecoder() },
      url: nodeUrl, util: (() => {
        const inspectFn = (value, options) => nodeInspect(value, options ?? {});
        inspectFn.custom = Symbol.for('nodejs.util.inspect.custom');
        const utilCompat = createUtilModule(Object.assign(Object.create(scope), {
          process: processObject,
          console: processObject._bnhConsole || scope.console,
        }));
        const getCallSites = createGetCallSites();
        const getCallSite = (...args) => {
          processObject.emitWarning?.(
            "The `util.getCallSite` API has been renamed to `util.getCallSites()`." ,
            'ExperimentalWarning',
          );
          return getCallSites(...args);
        };
        return {
          ...utilCompat,
          format: (...args) => utilCompat.format(...args),
          inspect: inspectFn,
          types: utilTypes,
          promisify: createPromisify(),
          deprecate: createDeprecate(processObject),
          _extend: (target, source) => Object.assign(target, source),
          customPromisifyArgs: Symbol.for('nodejs.util.promisify.customArgs'),
          getCallSite,
          getCallSites,
          debug: debuglog,
          debuglog,
          getSystemErrorName: utilCompat.getSystemErrorName,
          getSystemErrorMessage: utilCompat.getSystemErrorMessage,
          getSystemErrorMap: utilCompat.getSystemErrorMap,
          TextEncoder: scope.TextEncoder,
          TextDecoder: scope.TextDecoder,
          aborted: createAborted(),
        };
      })(),
      'util/types': createUtilTypes(scope),
      worker_threads: { ...createBrowserIO(scope), isMainThread: true, parentPort: null, workerData: undefined },
      zlib: createZlibShimModule(scope, Buffer), perf_hooks: performancePrimitives.perfHooks, v8,
      async_hooks: asyncHooks,
      diagnostics_channel: diagnosticsChannels,
      test: nodeTest,
      ...unsupportedBuiltins,
      sea: Object.freeze({}),
      sqlite,
      'test/reporters': Object.freeze({}),
      net, dgram, cluster, tls,
      child_process: (() => {
        let childSequence = 0;
        const compileCacheSources = new Map();

        function tokenizeShell(command, env) {
          const expanded = String(command).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
            (_, braced, plain) => String(env[braced || plain] ?? ''));
          const tokens = [];
          let token = '';
          let quote = null;
          let escaped = false;
          const push = () => { if (token) tokens.push(token); token = ''; };
          for (const character of expanded) {
            if (escaped) { token += character; escaped = false; continue; }
            if (character === '\\' && quote !== "'") { escaped = true; continue; }
            if (quote) {
              if (character === quote) quote = null;
              else token += character;
              continue;
            }
            if (character === "'" || character === '"') { quote = character; continue; }
            if (/\s/.test(character)) { push(); continue; }
            token += character;
          }
          if (escaped) token += '\\';
          if (quote) throw new Error('unterminated shell quote in browser child command');
          push();
          return tokens;
        }

        function parseShellCommand(command, env) {
          const tokens = tokenizeShell(command, env);
          const separator = tokens.indexOf('&&');
          const execIndex = tokens.indexOf('exec');
          if (tokens[0] === 'ulimit' && separator >= 0 && execIndex === separator + 1) {
            return { file: tokens[execIndex + 1], args: tokens.slice(execIndex + 2), stdinPath: null };
          }
          const args = [];
          let stdinPath = null;
          for (let index = 0; index < tokens.length; index += 1) {
            if (tokens[index] === '<') stdinPath = tokens[++index];
            else args.push(tokens[index]);
          }
          return { file: args.shift() || processObject.execPath, args, stdinPath };
        }

        const childSignalNames = new Map([
          [1, 'SIGHUP'], [2, 'SIGINT'], [3, 'SIGQUIT'], [4, 'SIGILL'], [5, 'SIGTRAP'],
          [6, 'SIGABRT'], [7, 'SIGBUS'], [8, 'SIGFPE'], [9, 'SIGKILL'], [10, 'SIGUSR1'],
          [11, 'SIGSEGV'], [12, 'SIGUSR2'], [13, 'SIGPIPE'], [14, 'SIGALRM'], [15, 'SIGTERM'],
          [17, 'SIGCHLD'], [18, 'SIGCONT'], [19, 'SIGSTOP'], [20, 'SIGTSTP'], [21, 'SIGTTIN'],
          [22, 'SIGTTOU'], [23, 'SIGURG'], [24, 'SIGXCPU'], [25, 'SIGXFSZ'], [26, 'SIGVTALRM'],
          [27, 'SIGPROF'], [28, 'SIGWINCH'], [29, 'SIGIO'], [30, 'SIGPWR'], [31, 'SIGSYS'],
        ]);
        const childSignalSet = new Set(childSignalNames.values());

        function childArgumentTypeError(name, expected, value) {
          const received = value === null
            ? 'null'
            : Array.isArray(value)
              ? 'an instance of Array'
              : `type ${typeof value}`;
          const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
          error.code = 'ERR_INVALID_ARG_TYPE';
          return error;
        }

        function childArgumentValueError(name, value) {
          const error = new TypeError(`The "${name}" argument cannot be empty. Received ${JSON.stringify(value)}`);
          error.code = 'ERR_INVALID_ARG_VALUE';
          return error;
        }

        function childRangeError(name, value) {
          const error = new RangeError(`ERR_OUT_OF_RANGE: The value of "${name}" is out of range. Received ${String(value)}`);
          error.code = 'ERR_OUT_OF_RANGE';
          return error;
        }

        function validateChildCommand(file, name = 'file') {
          if (typeof file !== 'string') throw childArgumentTypeError(name, 'string', file);
          if (file.length === 0) throw childArgumentValueError(name, file);
        }

        function normalizeChildModulePath(value) {
          const isFileUrl = value instanceof URL
            || (value && typeof value === 'object' && value.protocol !== undefined);
          if (!isFileUrl) {
            validateChildCommand(value, 'modulePath');
            return value;
          }
          if (value.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
          return fileURLToPath(value);
        }

        function normalizeChildKillSignal(value) {
          if (value === undefined || value === null) return 'SIGTERM';
          if (typeof value === 'number') {
            const name = childSignalNames.get(value);
            if (!name) {
              const error = new TypeError(`Unknown signal: ${value}`);
              error.code = 'ERR_UNKNOWN_SIGNAL';
              throw error;
            }
            return name;
          }
          if (typeof value !== 'string') throw childArgumentTypeError('options.killSignal', 'string or integer', value);
          const name = value.toUpperCase();
          if (!childSignalSet.has(name)) {
            const error = new TypeError(`Unknown signal: ${value}`);
            error.code = 'ERR_UNKNOWN_SIGNAL';
            throw error;
          }
          return name;
        }

        function validateChildOptions(options) {
          if (options === undefined) return;
          if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw childArgumentTypeError('options', 'object', options);
          }
          for (const name of ['detached', 'windowsHide', 'windowsVerbatimArguments']) {
            const value = options[name];
            if (value !== undefined && value !== null && typeof value !== 'boolean') {
              throw childArgumentTypeError(`options.${name}`, 'boolean', value);
            }
          }
          if (options.shell !== undefined && options.shell !== null
            && typeof options.shell !== 'boolean' && typeof options.shell !== 'string') {
            throw childArgumentTypeError('options.shell', 'boolean or string', options.shell);
          }
          const cwdIsFileUrl = options.cwd instanceof URL
            || (options.cwd && typeof options.cwd === 'object' && options.cwd.protocol !== undefined);
          if (options.cwd !== undefined && options.cwd !== null
            && typeof options.cwd !== 'string' && !cwdIsFileUrl) {
            throw childArgumentTypeError('options.cwd', 'string', options.cwd);
          }
          for (const name of ['uid', 'gid']) {
            const value = options[name];
            if (value !== undefined && value !== null
              && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
              throw childArgumentTypeError(`options.${name}`, 'number', value);
            }
          }
          if (options.timeout !== undefined && options.timeout !== null
            && (!Number.isInteger(options.timeout) || options.timeout < 0)) {
            throw childRangeError('options.timeout', options.timeout);
          }
          if (options.maxBuffer !== undefined && options.maxBuffer !== null
            && (typeof options.maxBuffer !== 'number' || Number.isNaN(options.maxBuffer) || options.maxBuffer < 0)) {
            throw childRangeError('options.maxBuffer', options.maxBuffer);
          }
          normalizeChildKillSignal(options.killSignal);
        }

        function normalizeChildCwd(value) {
          if (value instanceof URL || (value && typeof value === 'object' && value.protocol !== undefined)) {
            if (value.protocol !== 'file:') {
              throw new TypeError('The URL must be of scheme file');
            }
            if (value.hostname && value.hostname !== 'localhost') {
              throw new TypeError('File URL host must be "localhost" or empty on this platform');
            }
            return fileURLToPath(value);
          }
          return String(value);
        }

        function normalizeChildInvocation(file, args, options, argumentCount, {
          allowNullOptions = false,
          commandName = 'file',
        } = {}) {
          validateChildCommand(file, commandName);
          let normalizedArgs = args;
          let normalizedOptions = options;
          if (argumentCount < 3 && normalizedArgs !== undefined && normalizedArgs !== null
            && !Array.isArray(normalizedArgs)) {
            if (typeof normalizedArgs !== 'object') throw childArgumentTypeError('args', 'an array', normalizedArgs);
            normalizedOptions = normalizedArgs;
            normalizedArgs = [];
          }
          if (normalizedArgs === undefined || normalizedArgs === null) normalizedArgs = [];
          if (!Array.isArray(normalizedArgs)) throw childArgumentTypeError('args', 'an array', normalizedArgs);
          if (normalizedOptions === null) {
            if (!allowNullOptions && argumentCount >= 3) throw childArgumentTypeError('options', 'object', normalizedOptions);
            normalizedOptions = {};
          }
          normalizedOptions ??= {};
          validateChildOptions(normalizedOptions);
          return { args: normalizedArgs, options: normalizedOptions };
        }

        function prepareChild(file, args, options = {}) {
          validateChildCommand(file);
          if (args !== undefined && args !== null && !Array.isArray(args)) {
            throw childArgumentTypeError('args', 'an array', args);
          }
          validateChildOptions(options);
          const cwdValue = options?.cwd || (processObject.cwd ? processObject.cwd() : '/node');
          const cwd = normalizePath(normalizeChildCwd(cwdValue), processObject.cwd?.() || '/node');
          if (options?.argv0 !== undefined && options.argv0 !== null && typeof options.argv0 !== 'string') {
            const received = options.argv0 === null ? 'null' : options.argv0?.constructor?.name || typeof options.argv0;
            const error = new TypeError(`The "options.argv0" property must be of type string. Received ${received === 'Array' ? 'an instance of Array' : `type ${received}`}`);
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
          }
          const executable = String(file || processObject.execPath || '/browser/node');
          // This environment is copied into the in-memory browser child only.
          // The outer process.env was already assembled under the manifest, and
          // these overrides cannot reach a host subprocess or host I/O.
          const env = Object.fromEntries(
            Object.entries({ ...processObject.env, ...(options?.env || {}) })
              .filter(([, value]) => value !== undefined),
          );
          const nodeOptions = tokenizeShell(env.NODE_OPTIONS || '', env);
          const rawArgs = [...nodeOptions, ...(Array.isArray(args) ? args : [])].map(String);
          const preloads = [];
          let evalCode = null;
          let moduleInput = false;
          let interactive = false;
          let printResult = false;
          let script = null;
          let afterScript = [];
          let snapshotBlobPath = null;
          let buildSnapshot = false;
          let reportDirectory = null;
          let reportFilename = null;
          let reportCompact = false;
          let reportExcludeEnv = false;
          let reportExcludeNetwork = false;
          let reportOnFatalError = false;
          let reportOnSignal = false;
          let reportOnUncaughtException = false;
          let maxHttpHeaderSize = null;
          let stopOptions = false;
          for (let index = 0; index < rawArgs.length; index += 1) {
            const argument = rawArgs[index];
            if (!stopOptions && argument === '--') { stopOptions = true; continue; }
            if (!stopOptions && (argument === '--report-directory' || argument.startsWith('--report-directory='))) {
              reportDirectory = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : rawArgs[++index];
              continue;
            }
            if (!stopOptions && (argument === '--report-filename' || argument.startsWith('--report-filename='))) {
              reportFilename = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : rawArgs[++index];
              continue;
            }
            if (!stopOptions && argument === '--report-compact') { reportCompact = true; continue; }
            if (!stopOptions && argument === '--report-exclude-env') { reportExcludeEnv = true; continue; }
            if (!stopOptions && argument === '--report-exclude-network') { reportExcludeNetwork = true; continue; }
            if (!stopOptions && argument === '--report-on-fatalerror') { reportOnFatalError = true; continue; }
            if (!stopOptions && argument === '--report-on-signal') { reportOnSignal = true; continue; }
            if (!stopOptions && argument === '--report-uncaught-exception') { reportOnUncaughtException = true; continue; }
            if (!stopOptions && (argument === '--snapshot-blob' || argument.startsWith('--snapshot-blob='))) {
              snapshotBlobPath = argument.includes('=')
                ? argument.slice(argument.indexOf('=') + 1)
                : rawArgs[++index];
              continue;
            }
            if (!stopOptions && argument === '--build-snapshot') {
              buildSnapshot = true;
              continue;
            }
            if (!stopOptions && (argument === '-i' || argument === '--interactive')) {
              interactive = true;
              continue;
            }
            if (!stopOptions && (argument === '--max-http-header-size' || argument.startsWith('--max-http-header-size='))) {
              const value = argument.includes('=')
                ? argument.slice(argument.indexOf('=') + 1)
                : rawArgs[++index];
              maxHttpHeaderSize = Number(value);
              continue;
            }
            if (!stopOptions && argument === '-pe') {
              printResult = true;
              evalCode = rawArgs[++index];
              continue;
            }
            if (!stopOptions && (argument === '-p' || argument === '--print')) {
              printResult = true;
              if (rawArgs[index + 1] !== undefined && !rawArgs[index + 1].startsWith('-')) evalCode = rawArgs[++index];
              continue;
            }
            if (!stopOptions && argument === '--input-type') {
              moduleInput = String(rawArgs[++index] || '') === 'module';
              continue;
            }
            if (!stopOptions && argument.startsWith('--input-type=')) {
              moduleInput = argument.slice('--input-type='.length) === 'module';
              continue;
            }
            if (!stopOptions && (argument === '-e' || argument === '--eval')) {
              const code = rawArgs[++index];
              if (code !== undefined) evalCode = code;
              continue;
            }
            if (!stopOptions && (argument === '-r' || argument === '--require')) {
              const preload = rawArgs[++index];
              if (preload !== undefined) preloads.push(preload);
              continue;
            }
            if (!stopOptions && argument === '--import') {
              index += 1;
              continue;
            }
            if (!stopOptions && argument.startsWith('--import=')) continue;
            if (!stopOptions && argument.startsWith('-')) continue;
            if (script === null) script = argument;
            else afterScript.push(argument);
          }
          const executionArgv = [executable, ...rawArgs];
          const id = ++childSequence;
          const mainPath = script ? normalizePath(script, cwd) : `/node/.bnh-child-${id}.js`;
          const moduleEvalPath = normalizePath(`.bnh-child-${id}.mjs`, cwd);
          const entryPath = moduleInput && evalCode !== null
            ? moduleEvalPath
            : evalCode !== null || preloads.length ? `/node/.bnh-child-${id}.js` : mainPath;
          let source = null;
          if (evalCode !== null) {
            const expression = printResult
              ? `process.stdout.write(String(eval(${JSON.stringify(evalCode)})) + '\\n');`
              : evalCode;
            source = `${preloads.map((item) => `require(${JSON.stringify(normalizePath(item, cwd))});`).join('\n')}\n${expression}`;
          } else if (preloads.length) {
            source = `${preloads.map((item) => `require(${JSON.stringify(normalizePath(item, cwd))});`).join('\n')}\nrequire(${JSON.stringify(mainPath)});`;
          } else if (interactive) {
            source = moduleInput
              ? `process.stderr.write('Cannot specify --input-type for REPL\\n'); process.exitCode = 1;`
              : '';
          } else if (env.NODE_REPL_EXTERNAL_MODULE && !script) {
            source = `require(${JSON.stringify(normalizePath(env.NODE_REPL_EXTERNAL_MODULE, cwd))});`;
          }
          return {
            cwd,
            env,
            command: executable,
            commandArgs: (Array.isArray(args) ? args : []).map(String),
            argv: [executable, ...(Array.isArray(args) ? args : [])].map(String),
            argv0: options?.argv0 ?? executable,
            executionArgv,
            evalCode,
            moduleInput,
            interactive,
            preloads,
            entryPath,
            mainPath,
            scriptPath: script ? mainPath : null,
            snapshotBlobPath: snapshotBlobPath ? normalizePath(snapshotBlobPath, cwd) : null,
            buildSnapshot,
            source,
            reportDirectory,
            reportFilename,
            reportCompact,
            reportExcludeEnv,
            reportExcludeNetwork,
            reportOnFatalError,
            reportOnSignal,
            reportOnUncaughtException,
            maxHttpHeaderSize,
            stdinPath: options?.stdinPath || null,
            stdin: options?.input,
            afterScript,
            abortOnUncaughtException: rawArgs.includes('--abort-on-uncaught-exception'),
          };
        }

        function outputStream() {
          const events = new EventEmitter();
          const pending = [];
          let endPending = false;
          const flush = () => {
            while (pending.length && events.listenerCount('data')) events.emit('data', pending.shift());
            if (endPending && pending.length === 0 && events.listenerCount('end')) {
              endPending = false;
              events.emit('end');
            }
          };
          const addListener = events.on.bind(events);
          events.on = (name, listener) => {
            const result = addListener(name, listener);
            if (name === 'data' || name === 'end') flush();
            return result;
          };
          events.setEncoding = () => events;
          events.write = (value) => {
            pending.push(typeof value === 'string' ? value : Buffer.from(value).toString());
            flush();
            return true;
          };
          events.end = (value) => {
            if (value !== undefined) events.write(value);
            endPending = true;
            flush();
            return events;
          };
          events.pipe = (destination) => {
            if (!destination || typeof destination.write !== 'function') {
              throw new TypeError('The "destination" argument must be a writable stream');
            }
            events.on('data', (value) => destination.write(value));
            events.on('end', () => {
              if (typeof destination.end === 'function') destination.end();
            });
            flush();
            return destination;
          };
          events.destroy = () => { events.end(); return events; };
          return events;
        }

        function virtualAsync(file, args, options, callback, isExecFile = false) {
          const stdoutStream = outputStream();
          const stderrStream = outputStream();
          const child = new BrowserChildProcess();
          const emitChildMessage = (value, handle) => {
            const event = value && typeof value === 'object'
              && typeof value.cmd === 'string'
              && value.cmd.startsWith('NODE_')
              ? 'internalMessage'
              : 'message';
            child.emit(event, value, handle);
          };
          const prepared = prepareChild(file, args, options);
          const processResource = new AsyncResource('PROCESSWRAP');
          const pipeResources = [
            new AsyncResource('PIPEWRAP'),
            new AsyncResource('PIPEWRAP'),
            new AsyncResource('PIPEWRAP'),
          ];
          if (!processObject.env?.TEST_THREAD_ID && processObject._bnhSignalTriggerAsyncId === undefined) {
            processObject._bnhSignalTriggerAsyncId = pipeResources[1].asyncId();
          }
          const ipc = options?.ipc ? {
            process: null,
            queued: [],
            pendingIncoming: [],
            handleBacklog: 0,
            queuedSendCallbacks: [],
            drainScheduled: false,
            disconnectRequested: false,
            finished: false,
            referenced: true,
            ref() { this.referenced = true; return this; },
            unref() { this.referenced = false; return this; },
            hasRef() { return this.referenced; },
            onChildMessage: (value, handle) => {
              const deliver = () => runInOwnerContext(() => emitChildMessage(value, handle));
              if (ipc.process) deliver();
              else ipc.pendingIncoming.push({ value, handle });
            },
            onChildExit: (code) => finish(code, null),
            onChildDisconnect: () => {
              if (child.connected) {
                child.connected = false;
                scope.queueMicrotask(() => child.emit('disconnect'));
              }
              finish(0, null);
            },
          } : null;
          let closed = false;
          let releaseChildTask = trackTask?.() || null;
          let abortListener = null;
          let childProcess = null;
          let timeoutHandle = null;
          const childHandleCache = new Map();
          let stdout = '';
          let stderr = '';
          let stdoutEmitted = false;
          const stdoutDestination = Array.isArray(options?.stdio) && options.stdio[1]
            && typeof options.stdio[1].write === 'function' ? options.stdio[1] : null;
          const writeStdout = (value) => {
            const chunk = normalizeOutputChunk(value);
            stdoutEmitted = true;
            if (stdoutDestination) stdoutDestination.write(chunk);
            else stdoutStream.write(chunk);
          };
          const runInOwnerContext = (callback) => {
            const previous = {
              process: scope.process,
              setTimeout: scope.setTimeout,
              clearTimeout: scope.clearTimeout,
              setInterval: scope.setInterval,
              clearInterval: scope.clearInterval,
              setImmediate: scope.setImmediate,
              clearImmediate: scope.clearImmediate,
              queueMicrotask: scope.queueMicrotask,
            };
            scope.process = processObject;
            if (processObject._bnhTimerContext) Object.assign(scope, processObject._bnhTimerContext);
            try {
              return callback();
            } finally {
              Object.assign(scope, previous);
            }
          };
          const runInChildContext = (callback) => {
            const previous = {
              process: scope.process,
              setTimeout: scope.setTimeout,
              clearTimeout: scope.clearTimeout,
              setInterval: scope.setInterval,
              clearInterval: scope.clearInterval,
              setImmediate: scope.setImmediate,
              clearImmediate: scope.clearImmediate,
            };
            const childOwner = childProcess?.processObject || childProcess;
            scope.process = childOwner || scope.process;
            if (childOwner?._bnhTimerContext) Object.assign(scope, childOwner._bnhTimerContext);
            try {
              return callback();
            } finally {
              Object.assign(scope, previous);
            }
          };
          const wrapChildHandle = (handle) => {
            if (!handle || typeof handle.on !== 'function') return handle;
            const cached = childHandleCache.get(handle);
            if (cached) return cached;
            const listeners = new Map();
            const rememberListener = (name, listener) => {
              const perName = listeners.get(name) || new Map();
              const wrappedListener = (...args) => runInChildContext(() => listener(...args));
              perName.set(listener, wrappedListener);
              listeners.set(name, perName);
              return wrappedListener;
            };
            const wrapped = new Proxy(handle, {
              get(target, property) {
                if (property === '__bnhChildHandle') return true;
                if (property === 'on' || property === 'once') {
                  return (name, listener) => {
                    if (typeof listener !== 'function') return wrapped;
                    if (name === 'connection' && target.listenerCount?.(name) > 0) {
                      const perName = listeners.get(name) || new Map();
                      perName.set(listener, null);
                      listeners.set(name, perName);
                      return wrapped;
                    }
                    const wrappedListener = rememberListener(name, listener);
                    runInOwnerContext(() => target[property](name, wrappedListener));
                    return wrapped;
                  };
                }
                if (property === 'off' || property === 'removeListener') {
                  return (name, listener) => {
                    const perName = listeners.get(name);
                    if (perName?.has(listener)) {
                      const wrappedListener = perName.get(listener);
                      if (wrappedListener) runInOwnerContext(() => target[property](name, wrappedListener));
                      perName.delete(listener);
                    } else {
                      runInOwnerContext(() => target[property](name, listener));
                    }
                    return wrapped;
                  };
                }
                if (property === 'removeAllListeners') {
                  return (name) => {
                    runInOwnerContext(() => target.removeAllListeners(name));
                    if (name === undefined) listeners.clear();
                    else listeners.delete(name);
                    return wrapped;
                  };
                }
                const value = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                return (...args) => {
                  const ownerArgs = args.map((arg) => typeof arg === 'function'
                    ? (...callbackArgs) => runInChildContext(() => arg(...callbackArgs))
                    : arg);
                  return runInOwnerContext(() => value.apply(target, ownerArgs));
                };
              },
            });
            childHandleCache.set(handle, wrapped);
            return wrapped;
          };
          child.pid = 10000 + childSequence;
          const stdioEntry = (index) => Array.isArray(options?.stdio) ? options.stdio[index] : options?.stdio;
          const stdioIgnored = (index) => stdioEntry(index) === 'ignore';
          child.stdout = stdioIgnored(1) ? null : stdoutStream;
          child.stderr = stdioIgnored(2) ? null : stderrStream;
          child.stdin = stdioIgnored(0) ? null : { write() { return true; }, end() {} };
          if (prepared.interactive && prepared.scriptPath === null && prepared.evalCode === null) {
            let input = '';
            child.stdin = {
              write(value) {
                input += normalizeOutputChunk(value);
                prepared.source = input;
                return true;
              },
              end(value) {
                if (value !== undefined) this.write(value);
                prepared.source = input;
                return this;
              },
            };
          }
          child.connected = Boolean(ipc);
          const scheduleIpcDrain = () => {
            if (!ipc || ipc.drainScheduled) return;
            ipc.drainScheduled = true;
            scope.setTimeout(() => {
              ipc.handleBacklog = 0;
              ipc.drainScheduled = false;
              const callbacks = ipc.queuedSendCallbacks.splice(0);
              for (const callback of callbacks) callback(null);
            }, 0);
          };
          child.send = (value, sendHandle, sendOptions, sendCallback) => {
            if (typeof sendHandle === 'function') {
              sendCallback = sendHandle;
              sendHandle = undefined;
              sendOptions = undefined;
            } else if (typeof sendOptions === 'function') {
              sendCallback = sendOptions;
              sendOptions = undefined;
            }
            if (closed || !ipc) {
              const error = new Error('Channel closed');
              error.code = 'ERR_IPC_CHANNEL_CLOSED';
              queueMicrotask(() => {
                if (sendCallback) sendCallback(error);
                else child.emit('error', error);
              });
              return false;
            }
            const childHandle = wrapChildHandle(sendHandle);
            if (ipc.processHandle?.state === 'running') {
              return ipc.processHandle.send(value, childHandle, sendOptions, sendCallback);
            }
            const hasHandle = sendHandle !== undefined && sendHandle !== null;
            if (ipc.handleBacklog > 0) {
              if (ipc.handleBacklog < 2) {
                ipc.handleBacklog += 1;
              } else {
                ipc.queuedSendCallbacks.push(sendCallback || (() => {}));
                scheduleIpcDrain();
                return false;
              }
            } else if (hasHandle) {
              ipc.handleBacklog = 1;
              scheduleIpcDrain();
            }
            if (ipc.process) {
              runInChildContext(() => ipc.process.emit('message', value, childHandle));
            }
            else ipc.queued.push({ value, sendHandle: childHandle, sendOptions, sendCallback });
            if (!ipc.processHandle) sendCallback?.(null);
            return true;
          };
          child.disconnect = () => {
            if (!ipc) return false;
            if (closed || !child.connected || ipc.disconnectRequested) {
              const error = new Error('Channel is already disconnected');
              error.code = 'ERR_IPC_DISCONNECTED';
              throw error;
            }
            ipc.disconnectRequested = true;
            if (ipc.processHandle) ipc.processHandle.disconnect?.();
            else ipc.process?.disconnect?.();
            return true;
          };
          let killed = false;
          child.kill = (signal = 'SIGTERM') => {
            if (closed) return true;
            killed = true;
            if (ipc?.processHandle) {
              try { ipc.processHandle.kill(signal); } catch { /* already terminal */ }
            }
            finish(null, normalizeChildKillSignal(signal));
            return true;
          };
          const commandError = (code, signal) => {
            const error = new Error(`Command failed: ${[file, ...(Array.isArray(args) ? args : [])].join(' ')}`);
            error.code = code < 0 ? 'EPERM' : code;
            error.signal = signal;
            error.cmd = [file, ...(Array.isArray(args) ? args : [])].join(' ');
            if (killed) error.killed = true;
            return error;
          };
          const finish = (code, signal, error = null) => {
            if (closed) return;
            closed = true;
            child.exitCode = code;
            child.signalCode = signal;
            if (timeoutHandle !== null) {
              scope.clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            if (abortListener) options.signal.removeEventListener('abort', abortListener);
            childProcess?._markExited?.();
            childProcess = null;
            releaseChildTask?.();
            releaseChildTask = null;
            if (prepared.executionArgv.some((value) => String(value) === '--no-warnings')) {
              stderr = stderr.replace(/\[DEP0005\] DeprecationWarning: Buffer\(\) is deprecated due to security and usability issues\. Please use the Buffer\.alloc\(\), Buffer\.allocUnsafe\(\), or Buffer\.from\(\) methods instead\.\n/g, '');
            }
            try {
              processResource.runInAsyncScope(() => runInOwnerContext(() => {
                pipeResources[0].runInAsyncScope(() => {});
                pipeResources[1].runInAsyncScope(() => {});
                pipeResources[1].runInAsyncScope(() => {});
                if (stdout && !stdoutEmitted) pipeResources[1].runInAsyncScope(() => writeStdout(stdout));
                else pipeResources[1].runInAsyncScope(() => {});
                pipeResources[2].runInAsyncScope(() => {});
                if (stderr) pipeResources[2].runInAsyncScope(stderrStream.write, stderrStream, stderr);
                else pipeResources[2].runInAsyncScope(() => {});
                stdoutStream.end();
                stderrStream.end();
                if (error) child.emit('error', error);
                child.emit('exit', code, signal);
                child.emit('close', code, signal);
                if (typeof callback === 'function') {
                  const callbackError = error || (code === 0 ? null : isExecFile ? commandError(code, signal) : Object.assign(new Error(`child exited with code ${code}`), { code }));
                  callback(callbackError, stdout, stderr);
                }
              }));
            } finally {
              for (const resource of pipeResources) resource.emitDestroy();
              processResource.emitDestroy();
            }
          };
          let invalidCwdError = null;
          if (prepared.cwd !== '/dev') {
            try {
              const cwdStats = fs.statSync(prepared.cwd);
              if (!cwdStats.isDirectory?.()) {
                invalidCwdError = new Error(`ENOTDIR: not a directory, chdir '${prepared.cwd}'`);
                invalidCwdError.code = 'ENOTDIR';
                invalidCwdError.path = prepared.cwd;
                invalidCwdError.syscall = 'chdir';
              }
            } catch (error) {
              invalidCwdError = error;
            }
          }
          if (invalidCwdError) {
            child.pid = undefined;
            scope.queueMicrotask(() => finish(-1, null, invalidCwdError));
            return child;
          }
          if (options?.signal !== undefined) {
            if (!options.signal || typeof options.signal.addEventListener !== 'function' || typeof options.signal.aborted !== 'boolean') {
              const error = new TypeError('The "signal" option must be an AbortSignal');
              error.code = 'ERR_INVALID_ARG_TYPE';
              throw error;
            }
            abortListener = () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              error.code = 'ABORT_ERR';
              if (options.signal.reason !== undefined) error.cause = options.signal.reason;
              const signal = isExecFile ? null : options.killSignal || 'SIGTERM';
              finish(null, signal, error);
            };
            options.signal.addEventListener('abort', abortListener, { once: true });
            if (options.signal.aborted) scope.queueMicrotask(abortListener);
          }
          if (options.timeout > 0) {
            timeoutHandle = scope.setTimeout(
              () => child.kill(options.killSignal || 'SIGTERM'),
              options.timeout,
            );
          }
          if (prepared.command === 'cat') {
            const stdinStream = outputStream();
            child.stdin = stdinStream;
            stdinStream.on('data', (value) => {
              stdout += normalizeOutputChunk(value);
              writeStdout(value);
            });
            stdinStream.once('end', () => finish(0, null));
            releaseChildTask?.();
            releaseChildTask = null;
            return child;
          }
          scope.queueMicrotask(() => {
            if (closed) return;
            try {
              const signalCommand = file === 'kill' && args.length >= 2
                ? String(args[0]).replace(/^-/, '').toUpperCase()
                : null;
              if (signalCommand) {
                const signal = signalCommand.startsWith('SIG') ? signalCommand : `SIG${signalCommand}`;
                if (Number(args[1]) === Number(processObject.pid)) processObject.emit(signal);
                finish(0, null);
                return;
              }
              const childOptions = ipc
                ? { ...options, ipc, asyncLifecycle: true, onSignal: (signal) => finish(null, signal) }
                : { ...options, asyncLifecycle: true, onSignal: (signal) => finish(null, signal) };
              if (prepared.entryPath.endsWith('.mjs') || prepared.moduleInput
                || isRuntimeEsmModule(prepared.entryPath, prepared.executionArgv)) {
                const processHandle = runPreparedESM(prepared, childOptions, (value) => {
                  stdout += normalizeOutputChunk(value);
                  writeStdout(value);
                }, (value) => {
                  stderr += normalizeOutputChunk(value);
                });
                if (ipc) {
                  ipc.processHandle = processHandle;
                  processHandle.on('message', (value, handle) => {
                    if (value?.type === 'bnh-artifacts') return;
                    emitChildMessage(value, handle);
                  });
                  processHandle.on('spawn', () => {
                    for (const message of ipc.queued.splice(0)) processHandle.send(message.value, message.sendHandle, message.sendOptions, message.sendCallback);
                    child.emit('spawn');
                  });
                  processHandle.on('disconnect', ipc.onChildDisconnect);
                }
                child.spawn({ processHandle, file, args });
                processHandle.wait().then((terminal) => {
                  if (terminal.code !== 0 || terminal.signal) finish(terminal.code, terminal.signal);
                  else finish(0, null);
                }, (error) => finish(1, null, error));
                return;
              }
              const result = runPreparedSync(prepared, childOptions);
              const terminalSignal = result.signal
                || (prepared.abortOnUncaughtException && result.status !== 0
                  ? 'SIGABRT'
                  : null);
              const terminalCode = terminalSignal ? null : result.status;
              childProcess = result.process;
              child.spawn({ processHandle: childProcess, file, args });
              stdout = result.stdout?.toString?.() || String(result.stdout || '');
              stderr = result.stderr?.toString?.() || String(result.stderr || '');
              if (ipc) {
                ipc.process = result.process;
                for (const message of ipc.pendingIncoming.splice(0)) {
                  runInOwnerContext(() => emitChildMessage(message.value, message.handle));
                }
                for (const message of ipc.queued.splice(0)) {
                  runInChildContext(() => ipc.process?.emit('message', message.value, message.sendHandle));
                }
                if (result.status !== 0 || result.process?._exitRequested?.() || result.process?._bnhIsExited?.()) {
                  finish(terminalCode, terminalSignal);
                }
              } else if (!result.pending) {
                scope.setTimeout(() => {
                  stdout = result.stdoutChunks?.join('') ?? stdout;
                  stderr = result.stderrChunks?.join('') ?? stderr;
                  finish(terminalCode, terminalSignal);
                }, 0);
              } else if (result.process) {
                result.process.once?.('exit', (code, signal) => {
                  stdout = result.stdoutChunks?.join('') ?? stdout;
                  stderr = result.stderrChunks?.join('') ?? stderr;
                  finish(signal ? null : code, signal || null);
                });
              }
            } catch (error) {
              finish(1, null, error);
            }
          });
          return child;
        }

        function resolveFileSync(specifier, importer, processObj = null) {
          const source = String(specifier).replaceAll('\\', '/');
          if (source.startsWith('file:')) return normalizePath(fileURLToPath(source));
          const internalName = source.startsWith('node:') ? source.slice(5) : source;
          if (internalName.startsWith('internal/')) {
            const internalBase = `/node/lib/${internalName}`;
            for (const candidate of moduleCandidates(internalBase)) {
              try { readSource(candidate); return candidate; } catch { /* ignore */ }
            }
          }
          if (!source.startsWith('.') && !source.startsWith('/')) {
            const coreName = source.startsWith('node:') ? source.slice(5) : source;
            for (const candidate of moduleCandidates(`/node/lib/${coreName}`)) {
              try { readSource(candidate); return candidate; } catch { /* ignore */ }
            }
          }
          const base = specifier.startsWith('/') ? specifier : normalizePath(specifier, importer ? path.dirname(importer) : '/node');
          for (const candidate of moduleCandidates(base)) {
            try { readSource(candidate); return candidate; } catch { /* ignore */ }
          }
          if (addonsDisabled(processObj) || isNativeAddonBuildPath(base)) return nativeAddonPath(base);
          return base;
        }
        function packageType(entryPath) {
          let directory = path.dirname(entryPath);
          for (;;) {
            const packagePath = path.join(directory, 'package.json');
            try {
              const packageSource = readSource(packagePath);
              const packageText = typeof packageSource === 'string'
                ? packageSource
                : new TextDecoder().decode(packageSource);
              const packageConfig = JSON.parse(packageText);
              return packageConfig.type === 'module' ? 'module' : 'commonjs';
            } catch (error) {
              if (error?.code !== 'ENOENT') return 'commonjs';
            }
            // Unresolved specifiers ('node:nope') reach here as relative paths;
            // dirname('.') is '.', so without this guard the climb never ends.
            if (directory === '/' || directory === '.' || directory === '') return 'commonjs';
            directory = path.dirname(directory);
          }
        }

        function isEsmModule(entryPath, processObj = null, execArgv = processObj?.execArgv || []) {
          if (entryPath.endsWith('.mjs')) return true;
          if (entryPath.endsWith('.cjs') || entryPath.endsWith('.json') || entryPath.endsWith('.node')) return false;
          if (entryPath.startsWith('/node/lib/')) return false;
          if (packageType(entryPath) === 'module') return true;
          if (entryPath.includes('/node_modules/')) return false;
          return execArgv.some((argument) => String(argument) === '--experimental-default-type=module');
        }

        function hasTopLevelAwait(source) {
          const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
          let curlyDepth = 0;
          let parenDepth = 0;
          let bracketDepth = 0;
          let quote = null;
          let escaped = false;
          let lineComment = false;
          let blockComment = false;
          for (let index = 0; index < text.length; index += 1) {
            const character = text[index];
            const next = text[index + 1];
            if (lineComment) {
              if (character === '\n') lineComment = false;
              continue;
            }
            if (blockComment) {
              if (character === '*' && next === '/') {
                blockComment = false;
                index += 1;
              }
              continue;
            }
            if (quote) {
              if (escaped) escaped = false;
              else if (character === '\\') escaped = true;
              else if (character === quote) quote = null;
              continue;
            }
            if ((character === '/' && next === '/') || (character === '/' && next === '*')) {
              if (next === '/') lineComment = true;
              else blockComment = true;
              index += 1;
              continue;
            }
            if (character === '"' || character === "'" || character === '`') {
              quote = character;
              continue;
            }
            if (character === '{') curlyDepth += 1;
            else if (character === '}') curlyDepth = Math.max(0, curlyDepth - 1);
            else if (character === '(') parenDepth += 1;
            else if (character === ')') parenDepth = Math.max(0, parenDepth - 1);
            else if (character === '[') bracketDepth += 1;
            else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1);
            if (curlyDepth || parenDepth || bracketDepth || !/[A-Za-z_$]/.test(character)) continue;
            let end = index + 1;
            while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1;
            if (text.slice(index, end) === 'await') return true;
            index = end - 1;
          }
          return false;
        }

        function hasStaticEsmSyntax(source) {
          return /(?:^|[;\n])\s*export\s+(?:default\b|(?:const|let|var|function|class)\b|[*{])/.test(source);
        }

        function synchronousEsmSource(source) {
          let transformed = String(source);
          transformed = transformed.replace(
            /(^|[;\n])\s*export\s+default\s+([^;]+);?/g,
            (_, prefix, expression) => `${prefix}module.exports.default = (${expression});`,
          );
          transformed = transformed.replace(
            /(^|[;\n])\s*export\s+(const|let|var)\s+([$_A-Za-z][$_\w]*)\s*=\s*([^;\n]+);?/g,
            (_, prefix, declaration, name, expression) => `${prefix}${declaration} ${name} = ${expression}; module.exports.${name} = ${name};`,
          );
          return transformed;
        }

        function esmGraphHasTopLevelAwait(entryPath, seen = new Set()) {
          if (seen.has(entryPath)) return false;
          seen.add(entryPath);
          let source;
          try {
            source = readSource(entryPath);
          } catch {
            return false;
          }
          if (hasTopLevelAwait(source)) return true;
          const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
          const imports = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm;
          let match;
          while ((match = imports.exec(text))) {
            const specifier = match[1];
            if (specifier.startsWith('node:')) continue;
            let dependency;
            try {
              dependency = esmLoader.resolve(specifier, entryPath, ['node', 'import']);
            } catch {
              continue;
            }
            if (dependency.startsWith('file:')) dependency = fileURLToPath(dependency);
            if (dependency.startsWith('node:')) continue;
            if (esmGraphHasTopLevelAwait(dependency, seen)) return true;
          }
          return false;
        }

        function requireAsyncModuleError(entryPath, parentImport) {
          const error = new Error(
            `require() cannot be used on an ESM graph with top-level await. `
            + `Use import() instead. From ${parentImport} Requiring ${entryPath}`,
          );
          error.code = 'ERR_REQUIRE_ASYNC_MODULE';
          error.stack = `Error [ERR_REQUIRE_ASYNC_MODULE]: ${error.message}`;
          return error;
        }

        function requireEsmError(entryPath, parentImport, fromEval) {
          const basename = path.basename(entryPath);
          const message = `require() of ES Module ${entryPath} from ${parentImport} not supported.\n`;
          const packagePath = path.join(path.dirname(entryPath), 'package.json');
          const detail = fromEval
            ? `Instead either rename ${basename} to end in .cjs, change the requiring code to use dynamic import() which is available in all CommonJS modules, or change "type": "module" to "type": "commonjs" in ${packagePath} to treat all .js files as CommonJS (using .mjs for all ES modules instead).`
            : `Instead change the require of ${basename} in ${parentImport} to a dynamic import() which is available in all CommonJS modules.`;
          const error = new Error(`${message}${detail}`);
          error.code = 'ERR_REQUIRE_ESM';
          error.stack = `Error [ERR_REQUIRE_ESM]: ${error.message}`;
          return error;
        }

        function loadModuleSync(entryPath, parentImport = entryPath, processObj, scopeObj, bufferClass, stderrArr = [], sourceOverride = undefined, moduleState = { main: null }, isMain = false, compileCacheState = null, fromEval = false, syncStreamWebApi = null) {
          if (entryPath.endsWith('.node')) rejectNativeAddon(entryPath, processObj);
          const env = processObj?.env || {};
          const debugNative = env.NODE_DEBUG_NATIVE || '';
          const isCompileCacheDebug = debugNative.includes('COMPILE_CACHE') || debugNative === '1';
          const cacheDir = env.NODE_COMPILE_CACHE || '';
          let source;
          try {
            source = sourceOverride === undefined ? readSource(entryPath) : sourceOverride;
          } catch (e) {
            const argv = processObj?.argv || [];
            const evalFlags = ['-p', '-e', '--eval'];
            const evalIndex = argv.findIndex((a) => evalFlags.includes(a));
            if (entryPath === (processObj?.execPath || '') && argv.includes('--completion-bash')) {
              source = "process.stdout.write(\"_node_complete() {\\n  local cur_word options\\n  cur_word=\\\"\\${COMP_WORDS[COMP_CWORD]}\\\"\\n  if [[ \\\"\\${cur_word}\\\" == -* ]] ; then\\n    COMPREPLY=( $(compgen -W '--help --version ' -- \\\"\\${cur_word}\\\") )\\n    return 0\\n  else\\n    COMPREPLY=( $(compgen -f \\\"\\${cur_word}\\\") )\\n    return 0\\n  fi\\n}\\ncomplete -o filenames -o nospace -o bashdefault -F _node_complete node node_g\");";
            } else if (evalIndex >= 0 && argv[evalIndex + 1] !== undefined) {
              source = argv[evalIndex + 1];
            } else {
              throw e;
            }
          }
          const bytes = typeof source === 'string'
            ? null
            : source instanceof ArrayBuffer
              ? new Uint8Array(source)
              : ArrayBuffer.isView(source)
                ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
                : new Uint8Array(source || []);
          const text = typeof source === 'string' ? source : new TextDecoder().decode(bytes);
          const esmEntry = isEsmModule(entryPath, processObj) || (isMain && hasStaticEsmSyntax(text));
          if (esmEntry && !isMain) {
            if (esmGraphHasTopLevelAwait(entryPath)) throw requireAsyncModuleError(entryPath, parentImport);
            throw requireEsmError(entryPath, parentImport, fromEval);
          }
          if (esmEntry) source = synchronousEsmSource(text);
          const tagDirName = 'v22.0.0-browser-1-1';
          const tagDir = cacheDir ? (fs.mkdirSync ? (fs.mkdirSync(cacheDir, { recursive: true }), fs.mkdirSync(cacheDir + '/' + tagDirName, { recursive: true }), cacheDir + '/' + tagDirName) : '') : '';
          let compileCacheFile = '';
          if (tagDir) {
            compileCacheFile = tagDir + '/' + String(text.length) + '.cache';
          }
          let fileExistedBefore = false;
          let cacheAction = 'none';
          if (isCompileCacheDebug && tagDir) {
            const basename = entryPath.split('/').pop() || entryPath;
            fileExistedBefore = fs.existsSync ? fs.existsSync(compileCacheFile) : false;
            let cacheMatches = false;
            if (fileExistedBefore && compileCacheSources.has(compileCacheFile)) {
              const cachedSource = compileCacheSources.get(compileCacheFile);
              cacheMatches = cachedSource === text;
            }
            if (fileExistedBefore && typeof fs.readFileSync === 'function') {
              try {
                const cached = fs.readFileSync(compileCacheFile, 'utf8');
                cacheMatches = cacheMatches || String(cached) === text;
              } catch {
                cacheMatches = false;
              }
            }
            if (fileExistedBefore && cacheMatches) {
              cacheAction = 'same';
              stderrArr.push(`[compile cache] cache for ${basename} was accepted, keeping the in-memory entry\n`);
            } else if (fileExistedBefore) {
              cacheAction = 'updated';
              stderrArr.push(`[compile cache] reading cache from ${cacheDir} for ${basename} code hash mismatch: source changed\n`);
            } else {
              cacheAction = 'initialized';
              stderrArr.push(`[compile cache] ${basename} was not initialized, initializing the in-memory entry\n`);
            }
            if (compileCacheState && entryPath === compileCacheState.entryPath) compileCacheState.primaryAction = cacheAction;
          }
          const moduleExports = {};
          const moduleRecord = new moduleApi(entryPath, moduleState.cache?.get?.(parentImport) || null);
          moduleRecord.filename = entryPath;
          moduleRecord.paths = moduleSearchPaths(entryPath);
          moduleRecord.exports = moduleExports;
          moduleState.cache ||= new Map();
          moduleState.cache.set(entryPath, moduleRecord);
          if (isMain) moduleState.main = moduleRecord;
          const requireFn = (name) => {
            const builtin = builtinName(name);
            if (BUILTIN_NAMES.includes(builtin)) {
              if (builtin === 'stream/web' && syncStreamWebApi) return syncStreamWebApi;
              if (builtin === 'repl') {
                const resolved = resolveFileSync(name, entryPath, processObj);
                return loadModuleSync(resolved, entryPath, processObj, scopeObj, bufferClass, stderrArr, undefined, moduleState, false, compileCacheState, text.includes('eval('), syncStreamWebApi);
              }
              if (builtin === 'module') return createModuleApi(processObj, (value) => stderrArr.push(value));
              if (builtin === 'process') return processObj;
              if (builtin === 'internal/test/binding') return internalTestBinding;
              if (builtin === 'dns') return dns;
              if (builtin === 'dns/promises') return dnsPromises;
              if (builtin === 'v8') return createBrowserV8Module(processObj, scopeObj);
              return runtimeRequire(name);
            }
            const resolved = resolveFileSync(name, entryPath, processObj);
            return loadModuleSync(resolved, entryPath, processObj, scopeObj, bufferClass, stderrArr, undefined, moduleState, false, compileCacheState, text.includes('eval('), syncStreamWebApi);
          };
          requireFn.resolve = (name) => BUILTIN_NAMES.includes(builtinName(name)) ? name : resolveFileSync(name, entryPath, processObj);
          requireFn.main = moduleState.main;
          requireFn.cache = new Map();
          moduleRecord.require = requireFn;
          const importFromCommonJs = (specifier, options) => {
            const name = builtinName(specifier);
            if (BUILTIN_NAMES.includes(name)) {
              const value = runtimeRequire(name, entryPath);
              return Promise.resolve({ default: value, ...value });
            }
            return esmLoader.import(specifier, entryPath, {}, options);
          };
          runCommonJSWrapper(
            typeof source === 'string' ? source : text,
            entryPath,
            [requireFn, moduleRecord, moduleExports, entryPath, path.dirname(entryPath),
              importFromCommonJs],
            moduleApi.wrapper,
          );
          moduleRecord.loaded = true;
          if (isCompileCacheDebug && tagDir && (!fileExistedBefore || cacheAction === 'updated')) {
            const basename = entryPath.split('/').pop() || entryPath;
            try {
              fs.writeFileSync ? fs.writeFileSync(compileCacheFile, text, 'utf8') : null;
              compileCacheSources.set(compileCacheFile, text);
              stderrArr.push(`[compile cache] writing cache for ${basename}...success\n`);
            } catch (e) {
              // ignore
            }
          }
          return moduleRecord.exports;
        }
        function runPreparedSync(prepared, options = {}) {
            const { cwd, env, executionArgv, argv } = prepared;
            let entryPath = prepared.entryPath;
            const stdoutArr = [];
            const stderrArr = [];
            let exitCode = 0;
            const previousState = {
              process: scope.process,
              require: scope.require,
              http: scope.http,
              hasHttp: Object.hasOwn(scope, 'http'),
              console: scope.console,
              global: scope.global,
              Buffer: scope.Buffer,
              File: scope.File,
              atob: scope.atob,
              btoa: scope.btoa,
              ReadableStream: scope.ReadableStream,
              ReadableStreamDefaultReader: scope.ReadableStreamDefaultReader,
              ReadableStreamBYOBReader: scope.ReadableStreamBYOBReader,
              ReadableStreamBYOBRequest: scope.ReadableStreamBYOBRequest,
              ReadableByteStreamController: scope.ReadableByteStreamController,
              ReadableStreamDefaultController: scope.ReadableStreamDefaultController,
              WritableStream: scope.WritableStream,
              WritableStreamDefaultWriter: scope.WritableStreamDefaultWriter,
              WritableStreamDefaultController: scope.WritableStreamDefaultController,
              TransformStream: scope.TransformStream,
              TransformStreamDefaultController: scope.TransformStreamDefaultController,
              ByteLengthQueuingStrategy: scope.ByteLengthQueuingStrategy,
              CountQueuingStrategy: scope.CountQueuingStrategy,
              TextEncoderStream: scope.TextEncoderStream,
              TextDecoderStream: scope.TextDecoderStream,
              CompressionStream: scope.CompressionStream,
              DecompressionStream: scope.DecompressionStream,
              setTimeout: scope.setTimeout,
              clearTimeout: scope.clearTimeout,
              setInterval: scope.setInterval,
              clearInterval: scope.clearInterval,
              setImmediate: scope.setImmediate,
              clearImmediate: scope.clearImmediate,
              queueMicrotask: scope.queueMicrotask,
            };
            let childProc = null;
            let originalReadFileSync = null;
            let compileCacheState = null;
            let syncStreamWebApi = null;
            let hasPendingTimers = false;
            let hasPendingTasks = false;
            let childHttpModule = null;
            let previousHttpMaxHeaderSize;
            const abortOnUncaughtException = prepared.abortOnUncaughtException;
            try {
            childProc = createProcess(scope, {
                argv,
                argv0: prepared.argv0,
                env,
                cwd,
                abortOnUncaughtException,
                onSignal: options.onSignal,
                synchronousWarnings: true,
                }, (value) => stdoutArr.push(value), (value) => stderrArr.push(value), () => () => {});
            childHttpModule = runtimeRequire('http');
            previousHttpMaxHeaderSize = childHttpModule.maxHeaderSize;
            if (prepared.maxHttpHeaderSize !== null) {
              childHttpModule.maxHeaderSize = prepared.maxHttpHeaderSize;
            }
            scope.http = childHttpModule;
            childProc.processObject.loadEnvFile = (pathValue = '.env') => {
              const source = fs.readFileSync(pathValue, 'utf8');
              for (const line of String(source).split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const assignment = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
                const separator = assignment.indexOf('=');
                if (separator <= 0) continue;
                const key = assignment.slice(0, separator).trim();
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(childProc.processObject.env, key)) continue;
                let value = assignment.slice(separator + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
                childProc.processObject.env[key] = value;
              }
            };
            childProc.processObject.report = createProcessReport({
              processObject: childProc.processObject,
              os: platform.os,
              fs,
              path: nodePath,
              stdout: (value) => stdoutArr.push(value),
              stderr: (value) => stderrArr.push(value),
            });
            if (prepared.reportDirectory !== null) childProc.processObject.report.directory = prepared.reportDirectory;
            if (prepared.reportFilename !== null) childProc.processObject.report.filename = prepared.reportFilename;
            if (prepared.reportCompact) childProc.processObject.report.compact = true;
            if (prepared.reportExcludeEnv) childProc.processObject.report.excludeEnv = true;
            if (prepared.reportExcludeNetwork) childProc.processObject.report.excludeNetwork = true;
            if (prepared.reportOnFatalError) childProc.processObject.report.reportOnFatalError = true;
            if (prepared.reportOnSignal) childProc.processObject.report.reportOnSignal = true;
            if (prepared.reportOnUncaughtException) childProc.processObject.report.reportOnUncaughtException = true;
            const childTaskReleases = new Set();
            const nativeQueueMicrotask = scope.queueMicrotask.bind(scope);
            let childExitCheckQueued = false;
            const tryExitChild = () => {
              if (childExitCheckQueued) return;
              childExitCheckQueued = true;
              nativeQueueMicrotask(() => {
                childExitCheckQueued = false;
                childProc.processObject._bnhRunInContext?.(() => {
                  if (childProc.processObject._bnhIsExited?.()
                    || childProc.processObject._exitRequested?.()
                    || childProc.processObject._timers?.size
                    || childProc.processObject._bnhHasPendingTasks?.()
                    || childProc.processObject._bnhHasPendingAbortWorker?.()) return;
                  if (['message', 'disconnect'].some((name) => childProc.processObject.listenerCount(name) > 0)) return;
                  childProc.processObject._emitBeforeExit?.();
                  childProc.processObject._markExited?.();
                });
              });
            };
            const childTrackTask = () => {
              const release = trackTask();
              let released = false;
              const releaseChildTask = () => {
                if (released) return;
                released = true;
                childTaskReleases.delete(releaseChildTask);
                release();
                if (childTaskReleases.size === 0) tryExitChild();
              };
              childTaskReleases.add(releaseChildTask);
              return releaseChildTask;
            };
            childProc.processObject._bnhTaskTracker = childTrackTask;
            childProc.processObject._bnhHasPendingTasks = () => childTaskReleases.size > 0;
            childProc.processObject._bnhRunInContext = (callback) => {
              const previousProcess = scope.process;
              const previousConsole = scope.console;
              const previousTimers = {
                setTimeout: scope.setTimeout,
                clearTimeout: scope.clearTimeout,
                setInterval: scope.setInterval,
                clearInterval: scope.clearInterval,
                setImmediate: scope.setImmediate,
                clearImmediate: scope.clearImmediate,
              };
              scope.process = childProc.processObject;
              if (childProc.processObject._bnhConsole) scope.console = childProc.processObject._bnhConsole;
              if (childProc.processObject._bnhTimerContext) Object.assign(scope, childProc.processObject._bnhTimerContext);
              try {
                return callback();
              } finally {
                Object.assign(scope, previousTimers);
                scope.console = previousConsole;
                scope.process = previousProcess;
              }
            };
            childProc.processObject._bnhReleaseTasks = () => {
              for (const release of [...childTaskReleases]) release();
              tryExitChild();
            };
            childProc.processObject.argv = prepared.evalCode !== null
              ? [executionArgv[0], ...prepared.afterScript]
              : [executionArgv[0], ...(prepared.scriptPath ? [prepared.scriptPath] : []), ...prepared.afterScript];
            childProc.processObject.execArgv = prepared.evalCode !== null
              ? executionArgv.slice(1)
              : executionArgv.slice(1).filter((value) => String(value).startsWith('-'));
            let pendingAbortWorkers = 0;
            childProc.processObject._bnhWorkerCreated = () => {
              if (abortOnUncaughtException) pendingAbortWorkers += 1;
            };
            childProc.processObject._bnhWorkerError = () => {
              if (!abortOnUncaughtException || pendingAbortWorkers === 0) return;
              pendingAbortWorkers -= 1;
              options.onSignal?.('SIGABRT');
            };
            childProc.processObject._bnhHasPendingAbortWorker = () => abortOnUncaughtException && pendingAbortWorkers > 0;
            if (options.ipc) {
              childProc.processObject.connected = true;
              childProc.processObject.channel = options.ipc;
              childProc.processObject.send = (value, sendHandle, sendOptions, sendCallback) => {
                if (typeof sendHandle === 'function') {
                  sendCallback = sendHandle;
                  sendHandle = undefined;
                  sendOptions = undefined;
                } else if (typeof sendOptions === 'function') {
                  sendCallback = sendOptions;
                  sendOptions = undefined;
                }
                options.ipc.onChildMessage(value, sendHandle);
                sendCallback?.(null);
                return true;
              };
              childProc.processObject.disconnect = () => {
                childProc.processObject.connected = false;
                scope.queueMicrotask(() => childProc.processObject._bnhRunInContext?.(() => childProc.processObject.emit('disconnect')));
                options.ipc.onChildDisconnect();
                return true;
              };
              const originalExit = childProc.processObject.exit;
              childProc.processObject.exit = (code = 0) => {
                originalExit(code);
                options.ipc.onChildExit(code);
              };
            }
              scope.process = childProc.processObject;
              scope.console = createConsole((value) => stdoutArr.push(value), (value) => stderrArr.push(value), scope.console || {});
              childProc.processObject._bnhConsole = scope.console;
              scope.global = scope;
              scope.Buffer = Buffer;
              scope.File = File;
              scope.atob = Buffer.atob;
              scope.btoa = Buffer.btoa;
              scope.setTimeout = (callback, delay, ...args) => {
                return childProc.setTimer(() => callback(...args), delay);
              };
              scope.clearTimeout = childProc.clearTimer;
              scope.setInterval = (callback, delay, ...args) => childProc.setTimer(() => callback(...args), delay, true);
              scope.clearInterval = childProc.clearTimer;
              scope.setImmediate = (callback, ...args) => childProc.setTimer(() => callback(...args), 1);
              scope.clearImmediate = childProc.clearTimer;
              if (!options.ipc) {
                scope.queueMicrotask = (callback) => {
                  const release = childTrackTask();
                  nativeQueueMicrotask(() => {
                    try {
                      childProc.processObject._bnhRunInContext?.(callback);
                    } finally {
                      release();
                    }
                  });
                };
              }
              childProc.processObject._bnhTimerContext = {
                setTimeout: scope.setTimeout,
                clearTimeout: scope.clearTimeout,
                setInterval: scope.setInterval,
                clearInterval: scope.clearInterval,
                setImmediate: scope.setImmediate,
                clearImmediate: scope.clearImmediate,
                queueMicrotask: scope.queueMicrotask,
              };
              originalReadFileSync = fs.readFileSync;
              if (prepared.stdin !== undefined || prepared.stdinPath) {
                let stdinValue = prepared.stdin;
                if (stdinValue === undefined && prepared.stdinPath) stdinValue = readSource(prepared.stdinPath);
                const stdinBuffer = Buffer.from(stdinValue instanceof Uint8Array ? stdinValue : String(stdinValue ?? ''));
                fs.readFileSync = (pathValue, readOptions) => {
                  if (String(pathValue) === '/dev/stdin') {
                    const encoding = typeof readOptions === 'string' ? readOptions : readOptions?.encoding;
                    return encoding ? stdinBuffer.toString(encoding) : Buffer.from(stdinBuffer);
                  }
                  return originalReadFileSync(pathValue, readOptions);
                };
              }
              const moduleState = { main: null };
              compileCacheState = { entryPath: prepared.mainPath || entryPath, primaryPath: prepared.mainPath || entryPath, primaryAction: 'none' };
              const loadSyncInternal = (name) => loadModuleSync(
                `/node/lib/${name}.js`,
                entryPath,
                childProc.processObject,
                scope,
                Buffer,
                stderrArr,
                undefined,
                moduleState,
                false,
                compileCacheState,
              );
              const syncReadable = loadSyncInternal('internal/webstreams/readablestream');
              const syncWritable = loadSyncInternal('internal/webstreams/writablestream');
              const syncTransform = loadSyncInternal('internal/webstreams/transformstream');
              const syncQueuing = loadSyncInternal('internal/webstreams/queuingstrategies');
              const syncEncoding = loadSyncInternal('internal/webstreams/encoding');
              const syncCompression = loadSyncInternal('internal/webstreams/compression');
              syncStreamWebApi = {
                ReadableStream: syncReadable.ReadableStream,
                ReadableStreamDefaultReader: syncReadable.ReadableStreamDefaultReader,
                ReadableStreamBYOBReader: syncReadable.ReadableStreamBYOBReader,
                ReadableStreamBYOBRequest: syncReadable.ReadableStreamBYOBRequest,
                ReadableByteStreamController: syncReadable.ReadableByteStreamController,
                ReadableStreamDefaultController: syncReadable.ReadableStreamDefaultController,
                WritableStream: syncWritable.WritableStream,
                WritableStreamDefaultWriter: syncWritable.WritableStreamDefaultWriter,
                WritableStreamDefaultController: syncWritable.WritableStreamDefaultController,
                TransformStream: syncTransform.TransformStream,
                TransformStreamDefaultController: syncTransform.TransformStreamDefaultController,
                ByteLengthQueuingStrategy: syncQueuing.ByteLengthQueuingStrategy,
                CountQueuingStrategy: syncQueuing.CountQueuingStrategy,
                TextEncoderStream: syncEncoding.TextEncoderStream,
                TextDecoderStream: syncEncoding.TextDecoderStream,
                CompressionStream: syncCompression.CompressionStream,
                DecompressionStream: syncCompression.DecompressionStream,
              };
              // Node exposes its internal Web Streams classes globally. The
              // browser's native classes have different private brands, so
              // Node's internal adapters reject them even though their public
              // methods look identical. Install the Node-compatible classes
              // only after the internal modules have been loaded, then restore
              // the browser globals in the finally block below.
              scope.ReadableStream = syncStreamWebApi.ReadableStream;
              scope.ReadableStreamDefaultReader = syncStreamWebApi.ReadableStreamDefaultReader;
              scope.ReadableStreamBYOBReader = syncStreamWebApi.ReadableStreamBYOBReader;
              scope.ReadableStreamBYOBRequest = syncStreamWebApi.ReadableStreamBYOBRequest;
              scope.ReadableByteStreamController = syncStreamWebApi.ReadableByteStreamController;
              scope.ReadableStreamDefaultController = syncStreamWebApi.ReadableStreamDefaultController;
              scope.WritableStream = syncStreamWebApi.WritableStream;
              scope.WritableStreamDefaultWriter = syncStreamWebApi.WritableStreamDefaultWriter;
              scope.WritableStreamDefaultController = syncStreamWebApi.WritableStreamDefaultController;
              scope.TransformStream = syncStreamWebApi.TransformStream;
              scope.TransformStreamDefaultController = syncStreamWebApi.TransformStreamDefaultController;
              scope.ByteLengthQueuingStrategy = syncStreamWebApi.ByteLengthQueuingStrategy;
              scope.CountQueuingStrategy = syncStreamWebApi.CountQueuingStrategy;
              scope.TextEncoderStream = syncStreamWebApi.TextEncoderStream;
              scope.TextDecoderStream = syncStreamWebApi.TextDecoderStream;
              scope.CompressionStream = syncStreamWebApi.CompressionStream;
              scope.DecompressionStream = syncStreamWebApi.DecompressionStream;
              if (prepared.snapshotBlobPath && !prepared.buildSnapshot && !prepared.scriptPath) {
                const snapshot = JSON.parse(String(fs.readFileSync(prepared.snapshotBlobPath, 'utf8')));
                entryPath = normalizePath(snapshot.entry, cwd);
              }
              const commandName = prepared.command.split('/').pop();
              if (commandName === 'echo') {
                childProc.processObject.stdout.write(`${prepared.commandArgs.join(' ')}\n`);
              } else if (commandName === 'pwd') {
                childProc.processObject.stdout.write(`${prepared.cwd}\n`);
              } else if (commandName === 'env') {
                childProc.processObject.stdout.write(
                  `${Object.entries(prepared.env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
                );
              } else {
                if (prepared.source === null) {
                  childProc.processObject.__bnhModuleIsPreloading = true;
                  try {
                    for (const preload of prepared.preloads) {
                      loadModuleSync(normalizePath(preload, cwd), entryPath, childProc.processObject, scope, Buffer, stderrArr, undefined, moduleState, false, compileCacheState, false, syncStreamWebApi);
                    }
                  } finally {
                    childProc.processObject.__bnhModuleIsPreloading = false;
                  }
                }
                const childSource = prepared.source === null ? undefined : prepared.source;
                loadModuleSync(entryPath, entryPath, childProc.processObject, scope, Buffer, stderrArr, childSource, moduleState, true, compileCacheState, false, syncStreamWebApi);
                if (prepared.buildSnapshot && prepared.snapshotBlobPath) {
                  fs.writeFileSync(
                    prepared.snapshotBlobPath,
                    JSON.stringify({ version: 1, entry: prepared.scriptPath || prepared.mainPath }),
                    'utf8',
                  );
                }
              }
              hasPendingTimers = Boolean(options.asyncLifecycle && childProc.processObject._timers?.size);
              const hasIpcListeners = Boolean(options.ipc)
                && ['message', 'disconnect'].some((name) => childProc.processObject.listenerCount(name) > 0);
              hasPendingTasks = childProc.processObject._bnhHasPendingTasks?.() === true;
              if (!childProc.processObject._exitRequested?.()
                && !hasPendingTimers
                && !hasIpcListeners
                && !hasPendingTasks
                && !childProc.processObject._bnhHasPendingAbortWorker?.()) {
                childProc.processObject._emitBeforeExit?.();
                childProc.processObject._markExited?.();
              }
            } catch (error) {
              stderrArr.push(`${error?.stack || error}\n`);
              if (abortOnUncaughtException) childProc.processObject._bnhAbort?.('SIGABRT');
              else childProc.processObject.exit(1);
            } finally {
              if (compileCacheState?.primaryAction === 'same') {
                const basename = (compileCacheState.primaryPath || entryPath).split('/').pop() || entryPath;
                stderrArr.push(`[compile cache] skip ${basename} because cache was the same\n`);
              }
              scope.process = previousState.process;
              scope.require = previousState.require;
              scope.console = previousState.console;
              scope.global = previousState.global;
              scope.Buffer = previousState.Buffer;
              scope.File = previousState.File;
              scope.atob = previousState.atob;
              scope.btoa = previousState.btoa;
              scope.ReadableStream = previousState.ReadableStream;
              scope.ReadableStreamDefaultReader = previousState.ReadableStreamDefaultReader;
              scope.ReadableStreamBYOBReader = previousState.ReadableStreamBYOBReader;
              scope.ReadableStreamBYOBRequest = previousState.ReadableStreamBYOBRequest;
              scope.ReadableByteStreamController = previousState.ReadableByteStreamController;
              scope.ReadableStreamDefaultController = previousState.ReadableStreamDefaultController;
              scope.WritableStream = previousState.WritableStream;
              scope.WritableStreamDefaultWriter = previousState.WritableStreamDefaultWriter;
              scope.WritableStreamDefaultController = previousState.WritableStreamDefaultController;
              scope.TransformStream = previousState.TransformStream;
              scope.TransformStreamDefaultController = previousState.TransformStreamDefaultController;
              scope.ByteLengthQueuingStrategy = previousState.ByteLengthQueuingStrategy;
              scope.CountQueuingStrategy = previousState.CountQueuingStrategy;
              scope.TextEncoderStream = previousState.TextEncoderStream;
              scope.TextDecoderStream = previousState.TextDecoderStream;
              scope.CompressionStream = previousState.CompressionStream;
              scope.DecompressionStream = previousState.DecompressionStream;
              scope.setTimeout = previousState.setTimeout;
              scope.clearTimeout = previousState.clearTimeout;
              scope.setInterval = previousState.setInterval;
              scope.clearInterval = previousState.clearInterval;
              scope.setImmediate = previousState.setImmediate;
              scope.clearImmediate = previousState.clearImmediate;
              scope.queueMicrotask = previousState.queueMicrotask;
              if (previousState.hasHttp) scope.http = previousState.http;
              else delete scope.http;
              if (typeof originalReadFileSync === 'function') fs.readFileSync = originalReadFileSync;
              if (childHttpModule) childHttpModule.maxHeaderSize = previousHttpMaxHeaderSize;
            }
            let timeoutError = null;
            if (!options.asyncLifecycle && options.timeout > 0 && hasPendingTimers) {
              for (const timer of childProc.processObject._timers || []) {
                childProc.processObject._bnhClearTimer?.(timer);
              }
              hasPendingTimers = false;
              const timeoutSignal = normalizeChildKillSignal(options.killSignal);
              childProc.processObject._bnhAbort?.(timeoutSignal);
              timeoutError = new Error('spawnSync timed out');
              timeoutError.code = 'ETIMEDOUT';
            }
            const encoding = options?.encoding;
            const stdoutValue = encoding && encoding !== 'buffer' ? stdoutArr.join('') : Buffer.from(stdoutArr.join(''));
            const stderrValue = encoding && encoding !== 'buffer' ? stderrArr.join('') : Buffer.from(stderrArr.join(''));
          return {
              pid: childProc.processObject.pid,
              stdout: stdoutValue,
              stderr: stderrValue,
              stdoutChunks: stdoutArr,
              stderrChunks: stderrArr,
              status: childProc.processObject.getSignal?.() ? null : childProc.processObject.getCode(),
              pending: hasPendingTimers || hasPendingTasks
                || childProc.processObject._bnhHasPendingAbortWorker?.() || false,
              signal: childProc.processObject.getSignal?.() || null,
              error: timeoutError,
              process: options.asyncLifecycle || options.ipc ? childProc.processObject : null,
          };
        }

        function runPreparedESM(prepared, options, writeStdout, writeStderr) {
          const snapshot = vfs.snapshot();
          const files = Object.fromEntries(
            snapshot.artifacts.map(({ path, bytes }) => [path, bytes]),
          );
          if (prepared.source !== null) {
            files[prepared.entryPath] = new TextEncoder().encode(prepared.source);
          }
          const suppressWarnings = prepared.executionArgv.some((value) => String(value) === '--no-warnings');
          const forwardStderr = (value) => {
            let text = normalizeOutputChunk(value);
            if (suppressWarnings) {
              text = text.replace(/\[DEP0005\] DeprecationWarning: Buffer\(\) is deprecated due to security and usability issues\. Please use the Buffer\.alloc\(\), Buffer\.allocUnsafe\(\), or Buffer\.from\(\) methods instead\.\n/g, '');
            }
            if (text) writeStderr(text);
          };
          const childArgv = prepared.evalCode !== null
            ? [prepared.executionArgv[0], ...prepared.afterScript]
            : [prepared.executionArgv[0], ...(prepared.scriptPath ? [prepared.scriptPath] : []), ...prepared.afterScript];
          const scriptIndex = prepared.scriptPath
            ? prepared.executionArgv.indexOf(prepared.scriptPath)
            : prepared.executionArgv.length;
          const childExecArgv = [];
          const optionEnd = scriptIndex < 0 ? prepared.executionArgv.length : scriptIndex;
          const valueTakingFlags = new Set(['--import', '--experimental-loader', '--loader', '--require', '--input-type']);
          for (let index = 1; index < optionEnd; index += 1) {
            const argument = String(prepared.executionArgv[index]);
            if (!argument.startsWith('-')) continue;
            childExecArgv.push(argument);
            if (valueTakingFlags.has(argument) && index + 1 < optionEnd) {
              childExecArgv.push(String(prepared.executionArgv[++index]));
            }
          }
          const childProxy = proxyCapability.adapter ? proxyCapability : capabilities.manifest.proxy;
          return createVirtualProcess({
            scope,
            runId: runSpec?.runId,
            childId: `child-${childSequence}`,
            entry: prepared.entryPath,
            argv: childArgv,
            env: prepared.env,
            cwd: prepared.cwd,
            signal: options.signal,
            signalGrants: capabilities.manifest.signals.allowed,
            workerSource: new URL('./runtime/process-entry.js', import.meta.url).href,
            workerType: 'module',
            vfs: {
              capabilities: capabilities.manifest,
              files,
              entry: prepared.entryPath,
              execArgv: childExecArgv,
              proxy: childProxy,
              virtualNetwork: {
                shared: true,
                network: virtualNetwork,
              },
            },
            // Child processes may create a server after they start. Keep them
            // in this realm so later siblings can share the live registry.
            forceFallback: true,
            preserveReferences: true,
            stdout: writeStdout,
            stderr: forwardStderr,
          });
        }

        return {
          ChildProcess: BrowserChildProcess,
          spawnSync(file, args, options = {}) {
            const normalized = normalizeChildInvocation(file, args, options, arguments.length);
            args = normalized.args;
            options = normalized.options;
            if (options?.shell === true) {
              const parsed = parseShellCommand([file, ...args].join(' '), { ...processObject.env, ...(options?.env || {}) });
              file = parsed.file;
              args = parsed.args;
            }
            return runPreparedSync(prepareChild(file, args, options), options);
          },
          execFileSync(file, args, options = {}) {
            const normalized = normalizeChildInvocation(file, args, options, arguments.length, { allowNullOptions: true });
            args = normalized.args;
            options = normalized.options;
            if (options?.shell === true) {
              const parsed = parseShellCommand([file, ...args].join(' '), { ...processObject.env, ...(options?.env || {}) });
              file = parsed.file;
              args = parsed.args;
            }
            const prepared = prepareChild(file, args, options);
            const result = runPreparedSync(prepared, options);
            if (options.stdio === 'inherit') {
              if (result.stdout) processObject.stdout.write(result.stdout);
              if (result.stderr) processObject.stderr.write(result.stderr);
            }
            if (result.status !== 0) {
              const error = Object.assign(new Error(`Command failed: ${file}`), result);
              throw error;
            }
            return result.stdout;
          },
          execSync(command, options = {}) {
            validateChildCommand(command, 'command');
            validateChildOptions(options);
            const parsed = parseShellCommand(command, { ...processObject.env, ...(options?.env || {}) });
            return this.execFileSync(parsed.file, parsed.args, { ...options, stdinPath: parsed.stdinPath });
          },
          execFile(file, args, options, callback) {
            validateChildCommand(file);
            if (typeof args === 'function') {
              callback = args;
              args = [];
              options = {};
            } else if (typeof options === 'function') {
              callback = options;
              if (args && typeof args === 'object' && !Array.isArray(args)) {
                options = args;
                args = [];
              } else {
                options = {};
              }
            } else if (args === undefined || args === null) {
              args = [];
              options ||= {};
            } else if (args && typeof args === 'object' && !Array.isArray(args)) {
              if (options !== undefined && options !== null) {
                throw childArgumentTypeError('callback', 'function', options);
              }
              options = args;
              args = [];
            }
            if (args !== undefined && args !== null && !Array.isArray(args)) {
              throw childArgumentTypeError('args', 'an array', args);
            }
            if (options === null) options = {};
            validateChildOptions(options);
            if (options?.shell === true) {
              const parsed = parseShellCommand([file, ...(args || [])].join(' '), { ...processObject.env, ...(options?.env || {}) });
              file = parsed.file;
              args = parsed.args;
            }
            return virtualAsync(file, args || [], options || {}, callback, true);
          },
          exec(command, options, callback) {
            if (typeof options === 'function') { callback = options; options = {}; }
            validateChildCommand(command, 'command');
            validateChildOptions(options);
            const parsed = parseShellCommand(command, { ...processObject.env, ...(options?.env || {}) });
            return virtualAsync(parsed.file, parsed.args, { ...options, stdinPath: parsed.stdinPath }, callback, true);
          },
          spawn(file, args, options) {
            const normalized = normalizeChildInvocation(file, args, options, arguments.length);
            const spawnOptions = normalized.options;
            const hasIpcStdio = Array.isArray(spawnOptions.stdio)
              && spawnOptions.stdio.some((entry) => entry === 'ipc');
            return virtualAsync(file, normalized.args, hasIpcStdio
              ? { ...spawnOptions, ipc: true }
              : spawnOptions);
          },
          fork(modulePath, args = [], options = {}) {
            modulePath = normalizeChildModulePath(modulePath);
            const normalized = normalizeChildInvocation(modulePath, args, options, arguments.length, {
              allowNullOptions: true,
              commandName: 'modulePath',
            });
            const childOptions = { ...normalized.options, ipc: true };
            args = normalized.args;
            if (modulePath === '-e') return virtualAsync(processObject.execPath, ['-e', ...args], childOptions);
            return virtualAsync(processObject.execPath, [modulePath, ...args], childOptions);
          },
          _forkChild(fd, serializationMode) {
            const channel = fd && typeof fd === 'object' ? fd : processObject.channel;
            if (!channel) {
              const error = new Error('IPC channel is unavailable');
              error.code = 'ERR_IPC_CHANNEL_CLOSED';
              throw error;
            }
            processObject.channel = channel;
            processObject.connected = true;
            let channelDisconnected = false;
            const onChannelMessage = (value, handle) => processObject.emit('message', value, handle);
            const onChannelDisconnect = () => {
              if (channelDisconnected) return;
              channelDisconnected = true;
              processObject.connected = false;
              processObject.emit('disconnect');
            };
            channel.on?.('message', onChannelMessage);
            channel.on?.('disconnect', onChannelDisconnect);
            channel.on?.('peerDisconnect', onChannelDisconnect);
            processObject.send = (value, sendHandle, sendOptions, callback) => {
              if (typeof sendHandle === 'function') {
                callback = sendHandle;
                sendHandle = undefined;
                sendOptions = undefined;
              } else if (typeof sendOptions === 'function') {
                callback = sendOptions;
                sendOptions = undefined;
              }
              const send = channel.sendWithHandle || channel.send;
              if (typeof send !== 'function') {
                const error = new Error('IPC channel is unavailable');
                error.code = 'ERR_IPC_CHANNEL_CLOSED';
                if (callback) {
                  queueMicrotask(() => callback(error));
                  return false;
                }
                throw error;
              }
              return send.call(channel, value, sendHandle, sendOptions, callback);
            };
            processObject.disconnect = () => {
              if (channelDisconnected || !processObject.connected) return false;
              const result = channel.disconnect?.() ?? false;
              if (result) onChannelDisconnect();
              return result;
            };
            const refOnListener = (name) => {
              if (name === 'message' || name === 'disconnect') channel.ref?.();
            };
            const unrefOnListener = (name) => {
              if (name === 'message' || name === 'disconnect') channel.unref?.();
            };
            processObject.on?.('newListener', refOnListener);
            processObject.on?.('removeListener', unrefOnListener);
            channel.unref?.();
            return undefined;
          },
        };
      })(),
      vm,
    };
  }

  async function execute(entry, options, stdout, stderr) {
    installBrowserAbortSignalCompatibility(scope);
    scope.__BNH_BROWSER_WORKERS__ ||= new Set();
    if (options.workerThread) {
      environmentData.clear();
      for (const [key, value] of options.environmentData || []) environmentData.set(key, value);
    }
    let pending = 0;
    const trackTask = () => {
      pending += 1;
      return () => { pending = Math.max(0, pending - 1); };
    };
    const injectedProcess = options.processObject;
    const timerHandles = new Set();
    const nativeSetTimeout = scope.setTimeout.bind(scope);
    const nativeClearTimeout = scope.clearTimeout.bind(scope);
    const nativeSetInterval = scope.setInterval.bind(scope);
    const nativeClearInterval = scope.clearInterval.bind(scope);
    if (!scope.__BNH_NATIVE_TIMERS__) {
      Object.defineProperty(scope, '__BNH_NATIVE_TIMERS__', {
        configurable: true,
        value: { setTimeout: nativeSetTimeout, clearTimeout: nativeClearTimeout, setInterval: nativeSetInterval, clearInterval: nativeClearInterval },
      });
    }
    const injectedSetTimer = (callback, delay, repeat = false) => {
      const handle = repeat
        ? nativeSetInterval(callback, delay)
        : nativeSetTimeout(callback, delay);
      timerHandles.add(handle);
      return handle;
    };
    const injectedClearTimer = (handle) => {
      nativeClearTimeout(handle);
      nativeClearInterval(handle);
      timerHandles.delete(handle);
    };
    const hasReferencedTimers = (handles) => [...handles].some((handle) => {
      if (typeof handle?.hasRef === 'function') return handle.hasRef();
      return handle?._refed !== false;
    });
    const hasLiveVirtualProcess = () => {
      const registry = scope.__BNH_VIRTUAL_PROCESS_REGISTRY__;
      const currentPid = Number(injectedProcess?.pid);
      if (registry) {
        for (const handle of registry.values()) {
          // A same-realm fallback child is registered before its entry starts.
          // Do not count that child itself as an external live process or its
          // event loop can never reach the idle shutdown condition.
          if (Number.isInteger(currentPid) && Number(handle?.pid) === currentPid) continue;
          if (!handle.terminal && !['exited', 'failed'].includes(handle.state)) return true;
        }
      }
      for (const worker of scope.__BNH_BROWSER_WORKERS__ || []) {
        if (worker.terminal || ['exited', 'failed'].includes(worker.state)) continue;
        if (typeof worker.hasRef === 'function' && !worker.hasRef()) continue;
        return true;
      }
      return false;
    };
    const hasReferencedIpc = () => {
      const channel = processObject?.channel;
      return Boolean(processObject?.connected && channel && channel.hasRef?.() !== false);
    };
    const hasReferencedWorkerParentPort = () => {
      if (!options.workerThread || !workerThreadParentPort) return false;
      return workerThreadParentPort.listenerCount?.('message') > 0
        || typeof workerThreadParentPort.onmessage === 'function';
    };
    const fullProcessData = createProcess(scope, { ...options, isPidAlive: isVirtualPidAlive }, stdout, stderr, trackTask);
    const processData = injectedProcess
      ? (() => {
          const processObject = fullProcessData.processObject;
          // Preserve injected process identity and capabilities (stdout, stderr, exit control, IPC)
          processObject.stdout = injectedProcess.stdout || processObject.stdout;
          processObject.stderr = injectedProcess.stderr || processObject.stderr;
          processObject.stdin = injectedProcess.stdin || processObject.stdin;
          processObject.exit = (code) => {
            processObject.exitCode = Number(code) || 0;
            processObject.emit('exit', processObject.exitCode);
            if (typeof injectedProcess.exit === 'function') return injectedProcess.exit(code);
          };
          const injectedKill = injectedProcess.kill;
          processObject.kill = (pid, signal = 'SIGTERM') => {
            const targetPid = Number(pid);
            const requestedSignal = String(signal || 'SIGTERM').toUpperCase();
            if (requestedSignal === 'SIGCONT') {
              const alive = isVirtualPidAlive(targetPid);
              if (targetPid === Number(processObject.pid) || alive) return true;
              const error = new Error(`kill ESRCH ${targetPid}`);
              error.code = 'ESRCH';
              throw error;
            }
            if (typeof injectedKill === 'function') return injectedKill(pid, signal);
            return true;
          };
          processObject.send = (value, sendHandle, sendOptions, callback) => { if (typeof injectedProcess.send === 'function') return injectedProcess.send(value, sendHandle, sendOptions, callback); throw new Error('process.send is unavailable'); };
          processObject.connected = Boolean(injectedProcess.connected);
          processObject.disconnect = () => {
            if (typeof injectedProcess.disconnect !== 'function') return false;
            const disconnected = injectedProcess.disconnect();
            processObject.connected = Boolean(injectedProcess.connected);
            return disconnected;
          };
          processObject.channel = injectedProcess.channel || processObject.channel;
          if (typeof injectedProcess.on === 'function') {
            injectedProcess.on('message', (message, handle) => processObject.emit('message', message, handle));
            injectedProcess.on('disconnect', () => {
              processObject.connected = false;
              processObject.emit('disconnect');
            });
            injectedProcess.on('exit', (...args) => processObject.emit('exit', ...args));
          }
          processObject.exitCode = (injectedProcess.exitCode !== undefined) ? injectedProcess.exitCode : processObject.exitCode;
          processObject.env = injectedProcess.env || processObject.env;
          processObject.argv = injectedProcess.argv || processObject.argv;
          processObject.cwd = (injectedProcess.cwd) ? (() => injectedProcess.cwd()) : processObject.cwd;
          processObject.chdir = (value) => { if (injectedProcess.chdir) return injectedProcess.chdir(value); processObject.cwd = () => normalizePath(value, processObject.cwd()); };
          processObject.config = BROWSER_PROCESS_CONFIG;
          processObject.features = BROWSER_PROCESS_FEATURES;
          processObject.versions = browserProcessVersions(scope);
          return { processObject, setTimer: fullProcessData.setTimer, clearTimer: fullProcessData.clearTimer };
        })()
      : fullProcessData;
    const processObject = processData.processObject;
    processObject._bnhShouldRunUnref = () => pending > 0
      || hasReferencedTimers(processObject._timers || timerHandles)
      || hasLiveVirtualProcess()
      || hasReferencedIpc()
      || hasReferencedWorkerParentPort();
    if (Array.isArray(options.execArgv)) processObject.execArgv = [...options.execArgv];
    const setTimer = processData.setTimer;
    const clearTimer = processData.clearTimer;
    vfs.setTaskTracker?.(trackTask);
    vfs.setWarningEmitter?.(processObject.emitWarning?.bind(processObject));
    const diagnosticsChannels = createDiagnosticsModule();
    scope.__BNH_DIAGNOSTICS__ = diagnosticsChannels;
    const performancePrimitives = createPerformancePrimitives(scope, { fallback: 'virtual' });
    // Node exposes the same Performance object through the global and
    // perf_hooks surfaces. Keep that identity in the browser realm too.
    scope.performance = performancePrimitives.perfHooks.performance;
    Object.assign(processObject, performancePrimitives.processMetadata);
    class FSReqCallback {}
    const activeFsRequests = new Set();
    const trackActiveFsRequest = () => {
      const request = new FSReqCallback();
      activeFsRequests.add(request);
      return () => activeFsRequests.delete(request);
    };
    processObject._getActiveRequests = () => [...activeFsRequests];
    processObject.getActiveResourcesInfo = () => [...activeFsRequests].map(() => 'FSReqCallback');
    vfs.setActiveRequestTracker?.(trackActiveFsRequest);
    const browserIO = createBrowserIO(scope);
    const createRuntimeWorker = typeof scope.Worker === 'function'
      ? createWorkerFactory(scope, { bootstrap: WORKER_BOOTSTRAP })
      : undefined;
    const workerThreadParentPort = options.workerThread
      ? (() => {
          const parentPort = new EventEmitter();
          let assignedOnMessage = null;
          const onMessage = (value, handle) => {
            if (value?.__bnhThreadMessage || value?.__bnhThreadMessageResult) return;
            const adaptedValue = adaptWorkerData(value, scope);
            parentPort.emit('message', adaptedValue, handle);
            assignedOnMessage?.({
              type: 'message',
              data: adaptedValue,
              target: parentPort,
              currentTarget: parentPort,
              origin: '',
              lastEventId: '',
              source: null,
              ports: [],
            });
          };
          processObject.on('message', onMessage);
          parentPort.postMessage = (value, transferList) => processObject.send(value, transferList);
          parentPort.start = () => parentPort;
          parentPort.ref = () => parentPort;
          parentPort.unref = () => parentPort;
          Object.defineProperty(parentPort, 'onmessage', {
            configurable: true,
            get: () => assignedOnMessage,
            set: (listener) => { assignedOnMessage = typeof listener === 'function' ? listener : null; },
          });
          parentPort.close = () => {
            processObject.removeListener('message', onMessage);
            processObject.disconnect?.();
          };
          return parentPort;
        })()
      : null;
    processObject.on('message', (message) => {
      if (!message?.__bnhThreadMessage) return;
      processObject.emit('workerMessage', message.value, Number(message.source));
    });
    const createBrowserWorker = (source, workerOptions, threadId, ownerProcess) => {
      if (workerOptions.env !== undefined
        && workerOptions.env !== browserIO.SHARE_ENV
        && (workerOptions.env === null || typeof workerOptions.env !== 'object' || Array.isArray(workerOptions.env))) {
        throw workerMethodError('ERR_INVALID_ARG_TYPE', 'The "options.env" property must be of type object');
      }
      const isEval = Boolean(workerOptions.eval);
      const requestedTransferList = workerOptions.transferList === undefined
        ? undefined
        : Array.from(workerOptions.transferList);
      const workerDataTransferList = requestedTransferList?.map((item) => item?.raw || item);
      const requiredPorts = collectMessagePorts(workerOptions.workerData, scope);
      const grantedPorts = new Set(workerDataTransferList || []);
      if (requiredPorts.some((port) => !grantedPorts.has(port))) throw workerDataTransferError(scope);
      const [workerData] = prepareTransferPayload(workerOptions.workerData, requestedTransferList);
      const workerEnvironment = workerOptions.env === browserIO.SHARE_ENV
        ? ownerProcess.env
        : workerOptions.env === undefined
          ? { ...(ownerProcess.env || {}) }
          : { ...workerOptions.env };
      const workerPath = isEval
        ? `/node/.bnh-worker-eval-${threadId}.js`
        : normalizePath(source, ownerProcess.cwd?.() || '/node');
      const allowedEntries = capabilities.manifest.workers.entryModules;
      if (!isEval && !allowedEntries.includes(workerPath) && !allowedEntries.includes('*')) {
        const error = new Error(`worker entry is not granted: ${workerPath}`);
        error.code = 'ERR_CAPABILITY_DENIED';
        throw error;
      }
      const files = Object.fromEntries(
        vfs.snapshot({ copy: false }).artifacts.map(({ path, bytes }) => [path, bytes]),
      );
      if (isEval) files[workerPath] = new scope.TextEncoder().encode(String(source));
      const child = createBrowserProcess({
        scope,
        runId: `${runSpec?.runId || 'browser'}-thread-${threadId}`,
        childId: `thread-${threadId}-${Date.now()}`,
        argv: ['node', workerPath],
        execArgv: workerOptions.execArgv || ownerProcess.execArgv,
        env: workerEnvironment,
        cwd: ownerProcess.cwd?.() || '/node',
        ppid: ownerProcess.pid,
        signalGrants: capabilities.manifest.signals.allowed,
        workerSource: new URL('./runtime/process-entry.js', import.meta.url).href,
        workerType: 'module',
        runSource: '((context) => globalThis.__bnhRun(context))',
        vfs: {
          capabilities: capabilities.manifest,
          files,
          entry: workerPath,
          execArgv: workerOptions.execArgv || ownerProcess.execArgv,
          proxy: capabilities.manifest.proxy,
          workerThread: true,
          threadId,
          threadName: workerOptions.name ? String(workerOptions.name).trim() : '',
          workerData,
          environmentData: [...environmentData].map(([key, value]) => [cloneForWorker(key, scope), cloneForWorker(value, scope)]),
          resourceLimits: workerOptions.resourceLimits,
        },
        workerDataTransferList,
      });
      child.on('message', (message) => {
        const request = message?.__bnhThreadMessageRequest;
        if (!request) return;
        let delivered = false;
        if (Number(request.destination) === 0) {
          delivered = ownerProcess.emit('workerMessage', request.value, Number(request.source));
        } else {
          const target = [...scope.__BNH_BROWSER_WORKERS__ || []]
            .find((candidate) => Number(candidate.threadId) === Number(request.destination));
          if (target) {
            target.postMessage({
              __bnhThreadMessage: true,
              value: request.value,
              source: Number(request.source),
            }, request.transferList);
            delivered = true;
          }
        }
        child.send({
          __bnhThreadMessageResult: {
            requestId: request.requestId,
            delivered,
          },
        });
      });
      const workerStdout = new Readable({ read() {} });
      const workerStderr = new Readable({ read() {} });
      const workerStdin = workerOptions.stdin === true
        ? new Writable({
            write(chunk, _encoding, callback) {
              try {
                child.send({ __bnhWorkerStdin: true, value: new Uint8Array(chunk) }, undefined, callback);
              } catch (error) {
                callback(error);
              }
            },
            final(callback) {
              try {
                child.send({ __bnhWorkerStdinEnd: true }, undefined, callback);
              } catch (error) {
                callback(error);
              }
            },
          })
        : null;
      child.stdout = workerStdout;
      child.stderr = workerOptions.stderr === true ? workerStderr : null;
      child.stdin = workerStdin;
      child.once('exit', () => workerStdout.push(null));
      child.once('exit', () => workerStderr.push(null));
      if (workerOptions.stdout !== true) {
        workerStdout.on('data', (chunk) => ownerProcess.stdout?.write?.(chunk));
      }
      if (workerOptions.stderr !== true) {
        workerStderr.on('data', (chunk) => ownerProcess.stderr?.write?.(chunk));
      }
      child.threadId = threadId;
      child.postMessage = (value, transferList) => child.send(value, transferList);
      child.terminate = async () => {
        try { child.kill('SIGKILL'); } catch (error) {
          if (error?.code !== 'ERR_PROCESS_EXITED') throw error;
        }
        const terminal = await child.wait();
        return terminal?.code ?? 1;
      };
      child.ref = () => child;
      child.unref = () => child;
      return child;
    };
    const runtimeWorkerStates = new WeakMap();
    function RuntimeWorker(...args) {
      const ownerProcess = scope.process || processObject;
      if (ownerProcess._bnhNextWorkerThreadId === undefined) ownerProcess._bnhNextWorkerThreadId = 1;
      const threadId = ownerProcess._bnhNextWorkerThreadId++;
      const [source, workerOptions = {}] = args;
      const worker = typeof source === 'string'
        ? createBrowserWorker(source, workerOptions, threadId, ownerProcess)
        : createRuntimeWorker(...args);
      if (worker.stdout === undefined) worker.stdout = new Readable({ read() {} });
      if (worker.stdin === undefined) worker.stdin = null;
      if (worker.stderr === undefined) worker.stderr = workerOptions.stderr === true ? new Readable({ read() {} }) : null;
      const workerResource = new AsyncResource('WORKER');
      let workerRefed = true;
      let workerExited = false;
      let workerResourceDestroyed = false;
      let messagePortResource = null;
      const workerThreadName = workerOptions.name ? String(workerOptions.name).trim() : '';
      const resourceLimits = workerOptions.resourceLimits === undefined
        ? {}
        : workerOptions.resourceLimits && typeof workerOptions.resourceLimits === 'object' && !Array.isArray(workerOptions.resourceLimits)
          ? { ...workerOptions.resourceLimits }
          : (() => { throw workerMethodError('ERR_INVALID_ARG_TYPE', 'The "resourceLimits" option must be an object'); })();
      workerResource.hasRef = () => workerResourceDestroyed ? undefined : workerRefed;
      const refWorker = worker.ref?.bind(worker);
      const unrefWorker = worker.unref?.bind(worker);
      worker.ref = () => {
        if (workerExited) return;
        workerRefed = true;
        if (!messagePortResource) {
          messagePortResource = new AsyncResource('MESSAGEPORT');
          messagePortResource.hasRef = () => workerRefed && !workerExited;
        }
        refWorker?.();
      };
      worker.unref = () => {
        if (workerExited) return;
        workerRefed = false;
        messagePortResource?.unref?.();
        unrefWorker?.();
      };
      worker.hasRef = () => workerRefed;
      const postMessage = worker.postMessage?.bind(worker);
      worker.postMessage = (value, transferList) => {
        if (workerExited) return;
        return postMessage?.(value, transferList);
      };
      const terminate = worker.terminate?.bind(worker);
      worker.terminate = (...terminateArgs) => {
        if (workerExited) return Promise.resolve(undefined);
        worker.ref();
        return Promise.resolve(terminate?.(...terminateArgs));
      };
      runtimeWorkerStates.set(worker, {
        postMessage: worker.postMessage,
        terminate: worker.terminate,
        ref: worker.ref,
        unref: worker.unref,
        get threadId() { return workerExited ? -1 : threadId; },
        get threadName() { return workerExited ? null : workerThreadName; },
        stdin: worker.stdin,
        stdout: worker.stdout,
        stderr: worker.stderr,
        resourceLimits,
      });
      worker.once('spawn', () => worker.emit('online'));
      worker.once('exit', () => {
        workerExited = true;
        messagePortResource?.emitDestroy?.();
        scope.setTimeout?.(() => {
          workerResourceDestroyed = true;
          workerResource.emitDestroy();
        }, 0);
      });
      scope.__BNH_BROWSER_WORKERS__?.add(worker);
      worker.once('exit', () => scope.__BNH_BROWSER_WORKERS__?.delete(worker));
      Object.defineProperties(worker, {
        threadId: {
          configurable: true,
          enumerable: true,
          get: () => workerExited ? -1 : threadId,
        },
        threadName: {
          configurable: true,
          enumerable: true,
          get: () => workerExited ? null : workerThreadName,
        },
      });
      if (typeof ownerProcess._bnhWorkerCreated === 'function') {
        ownerProcess._bnhWorkerCreated();
        worker.once('error', (error) => ownerProcess._bnhWorkerError?.(error));
      }
      worker.on('message', (message) => {
        if (message?.__bnhInternalWorkerMessage !== 'couldNotSerializeError') return;
        const error = new Error('Unserializable error in worker');
        error.code = 'ERR_WORKER_UNSERIALIZABLE_ERROR';
        worker.emit('error', error);
      });
      if (worker && Object.getPrototypeOf(worker) !== RuntimeWorker.prototype) {
        Object.setPrototypeOf(worker, RuntimeWorker.prototype);
      }
      ownerProcess.emit('worker', worker);
      diagnosticsChannels.channel('worker_threads').publish({ worker });
      return worker;
    }
    Object.defineProperties(RuntimeWorker.prototype, {
      postMessage: {
        configurable: true,
        writable: true,
        value(value, transferList) {
          return runtimeWorkerStates.get(this)?.postMessage?.(value, transferList);
        },
      },
      terminate: {
        configurable: true,
        writable: true,
        value(...terminateArgs) {
          return runtimeWorkerStates.get(this)?.terminate?.(...terminateArgs);
        },
      },
      ref: {
        configurable: true,
        writable: true,
        value() {
          return runtimeWorkerStates.get(this)?.ref?.();
        },
      },
      unref: {
        configurable: true,
        writable: true,
        value() {
          return runtimeWorkerStates.get(this)?.unref?.();
        },
      },
      threadId: {
        configurable: true,
        get() {
          return runtimeWorkerStates.get(this)?.threadId;
        },
      },
      threadName: {
        configurable: true,
        get() {
          return runtimeWorkerStates.get(this)?.threadName;
        },
      },
      stdin: {
        configurable: true,
        get() {
          return runtimeWorkerStates.get(this)?.stdin;
        },
      },
      stdout: {
        configurable: true,
        get() {
          return runtimeWorkerStates.get(this)?.stdout;
        },
      },
      stderr: {
        configurable: true,
        get() {
          return runtimeWorkerStates.get(this)?.stderr;
        },
      },
      resourceLimits: {
        configurable: true,
        get() {
          return runtimeWorkerStates.get(this)?.resourceLimits;
        },
      },
      getHeapSnapshot: {
        configurable: true,
        writable: true,
        value() {
          const state = runtimeWorkerStates.get(this);
          if (!state || this.threadId === -1) return Promise.reject(workerMethodError('ERR_WORKER_NOT_RUNNING', 'Worker instance not running'));
          return Promise.resolve(createWorkerHeapSnapshot(scope));
        },
      },
      getHeapStatistics: {
        configurable: true,
        writable: true,
        value() {
          const state = runtimeWorkerStates.get(this);
          if (!state || this.threadId === -1) return Promise.reject(workerMethodError('ERR_WORKER_NOT_RUNNING', 'Worker instance not running'));
          return Promise.resolve(workerHeapStatistics());
        },
      },
      cpuUsage: {
        configurable: true,
        writable: true,
        value(previous) {
          if (previous !== undefined && previous !== null && typeof previous !== 'object') {
            return Promise.reject(workerMethodError('ERR_INVALID_ARG_TYPE', 'The "prev" argument must be of type object'));
          }
          const state = runtimeWorkerStates.get(this);
          if (!state || this.threadId === -1) return Promise.reject(workerMethodError('ERR_WORKER_NOT_RUNNING', 'Worker instance not running'));
          return Promise.resolve({ user: 0, system: 0 });
        },
      },
      startCpuProfile: {
        configurable: true,
        writable: true,
        value(options = {}) {
          if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            return Promise.reject(workerMethodError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object'));
          }
          const state = runtimeWorkerStates.get(this);
          if (!state || this.threadId === -1) return Promise.reject(workerMethodError('ERR_WORKER_NOT_RUNNING', 'Worker instance not running'));
          return Promise.resolve({ stop: async () => ({}) });
        },
      },
    });
    const workerThreads = {
      ...browserIO,
      Worker: createRuntimeWorker ? RuntimeWorker : undefined,
      isMainThread: !options.workerThread,
      threadId: options.workerThread ? Number(options.threadId ?? 1) : 0,
      parentPort: workerThreadParentPort,
      workerData: adaptWorkerData(options.workerData, scope),
      resourceLimits: options.workerThread ? { ...(options.resourceLimits || {}) } : {},
      getEnvironmentData(key) {
        return environmentData.get(key);
      },
      setEnvironmentData(key, value) {
        if (value === undefined) environmentData.delete(key);
        else environmentData.set(key, value);
      },
      isInternalThread: false,
      threadName: options.workerThread ? String(options.threadName || '') : '',
      postMessageToThread(threadId, value, transferList, timeout) {
        if (typeof transferList === 'number' && timeout === undefined) {
          timeout = transferList;
          transferList = [];
        }
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
          return Promise.reject(workerMethodError('ERR_OUT_OF_RANGE', 'The value of "timeout" is out of range. It must be >= 0.'));
        }
        if (threadId === workerThreads.threadId) {
          return Promise.reject(workerMethodError('ERR_WORKER_MESSAGING_SAME_THREAD', 'Cannot send a message to the same thread'));
        }
        if (options.workerThread) {
          const requestId = `${workerThreads.threadId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          return new Promise((resolve, reject) => {
            const onResult = (message) => {
              if (message?.__bnhThreadMessageResult?.requestId !== requestId) return;
              processObject.removeListener('message', onResult);
              if (message.__bnhThreadMessageResult.delivered) resolve();
              else reject(workerMethodError('ERR_WORKER_MESSAGING_FAILED', 'Cannot find the destination thread or listener'));
            };
            processObject.on('message', onResult);
            try {
              processObject.send({
                __bnhThreadMessageRequest: {
                  requestId,
                  source: workerThreads.threadId,
                  destination: Number(threadId),
                  value,
                  transferList,
                },
              });
            } catch (error) {
              processObject.removeListener('message', onResult);
              reject(error);
            }
          });
        }
        const target = [...scope.__BNH_BROWSER_WORKERS__ || []]
          .find((candidate) => Number(candidate.threadId) === Number(threadId));
        if (!target) return Promise.reject(workerMethodError('ERR_WORKER_MESSAGING_FAILED', 'Cannot find the destination thread or listener'));
        try {
          target.postMessage({ __bnhThreadMessage: true, value, source: workerThreads.threadId }, transferList);
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
    const builtins = makeBuiltins(
      processObject,
      (name, importer = entry) => loadModule(name, importer),
      diagnosticsChannels,
      options,
      performancePrimitives,
      trackTask,
      stdout,
      stderr,
      (pathname) => vfs.read(pathname),
      entry,
    );
    builtins.sys = builtins.util;
    processObject.getBuiltinModule = function getBuiltinModule(id) {
      if (typeof id !== 'string') throw moduleArgumentTypeError('id', 'of type string', id);
      const name = builtinName(id);
      return BUILTIN_NAMES.includes(name) ? builtins[name] : undefined;
    };
    builtins.module._cache = new Map();
    builtins.module._main = null;
    builtins.module._resolve = (name, parent) => {
      const importer = typeof parent === 'string' ? parent : parent?.filename || entry;
      return BUILTIN_NAMES.includes(builtinName(name)) ? name : resolveFile(name, importer, processObject);
    };
    builtins.module._load = (name, parent) => {
      const builtin = builtinName(name);
      const importer = typeof parent === 'string' ? parent : parent?.filename || entry;
      return BUILTIN_NAMES.includes(builtin) ? builtins[builtin] ?? {} : loadModule(name, importer);
    };
    const streamWebApi = builtins['stream/web'];
    const internalBindings = builtins['internal/test/binding'].__bnhContract;
    const internalUtil = {
      customInspectSymbol: Symbol.for('nodejs.util.inspect.custom'),
      customPromisifyArgs: Symbol.for('nodejs.util.promisify.customArgs'),
      SymbolDispose: Symbol.dispose || Symbol.for('nodejs.dispose'),
      SymbolAsyncDispose: Symbol.asyncDispose || Symbol.for('nodejs.asyncDispose'),
      kEmptyObject: Object.freeze({}),
      kEnumerableProperty: { enumerable: true },
      normalizeEncoding: (value) => String(value || 'utf8').toLowerCase(),
      isError: (value) => value instanceof Error,
      getConstructorOf: (value) => value?.constructor,
      join: (items, separator = '') => Array.from(items || []).join(separator),
      removeColors: (value) => String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''),
      getSystemErrorName: (code) => ({ [-1]: 'EPERM', [-4094]: 'UNKNOWN' }[code] || `Unknown system error ${code}`),
      getSystemErrorMessage: (code) => String(code),
      getSystemErrorMap: () => new Map(),
      isMacOS: () => false,
      isWindows: () => false,
      emitExperimentalWarning: (feature, messagePrefix = '', code) => processObject.emitWarning?.(`${messagePrefix}${feature}`, { code, type: 'ExperimentalWarning' }),
      assertCrypto: () => {},
      filterDuplicateStrings: (items, lowerCase = false) => [...new Set(
        (items || []).map((item) => lowerCase ? String(item).toLowerCase() : item),
      )].sort(),
      getDeprecationWarningEmitter: () => () => {},
      encodingsMap: Object.freeze({ utf8: 1, hex: 2, base64: 3, base64url: 4, latin1: 5, ascii: 6, buffer: 7 }),
      cachedResult: (factory) => {
        let initialized = false;
        let value;
        return (...args) => {
          if (!initialized) {
            value = factory(...args);
            initialized = true;
          }
          return value;
        };
      },
      guessHandleType: internalBindings.bindings.util.guessHandleType,
      privateSymbols: internalBindings.bindings.util.privateSymbols,
      defineLazyProperties: internalBindings.bindings.util.defineLazyProperties,
      sleep: internalBindings.bindings.util.sleep,
      assignFunctionName: internalBindings.bindings.util.assignFunctionName,
      deprecate: createDeprecate(processObject),
      once: onceCallback,
      promisify: createPromisify(),
      setOwnProperty: (target, key, value) => Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value }),
      pendingDeprecate: (fn) => fn,
      isPendingDeprecation: () => false,
      WeakReference: WeakRef,
      getLazy: (value) => value,
    };
    const internalUtilTypes = {
      isArrayBuffer: (value) => value instanceof ArrayBuffer,
      isSharedArrayBuffer: (value) => typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer,
      isArrayBufferView: (value) => ArrayBuffer.isView(value),
      isTypedArray: (value) => ArrayBuffer.isView(value) && !(value instanceof DataView),
      isUint8Array: (value) => value instanceof Uint8Array,
    };
    const internalOptions = { getOptionValue: () => undefined, getAllowUnauthorized: () => false };
    const internalDgram = {
      kStateSymbol: Symbol.for('bnh.dgram.state'),
      _createSocketHandle: () => null,
      newHandle: () => ({ close() {} }),
    };
    const nativeFetch = browserIO.fetch;
    let virtualFetchDepth = 0;
    const responseFromNodeResponse = (response, url) => new Promise((resolve, reject) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(new scope.Response(body, {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: response.headers,
        }));
      });
    });
    const virtualHttpFetch = (input, init = {}) => {
      const url = String(input?.url || input);
      if (virtualFetchDepth || !/^https?:/i.test(url)) return nativeFetch(input, init);
      virtualFetchDepth += 1;
      const headers = init.headers && typeof init.headers.entries === 'function'
        ? Object.fromEntries(init.headers.entries())
        : init.headers;
      const protocolModule = /^https:/i.test(url) ? builtins.https : builtins.http;
      const request = protocolModule.request(url, {
        method: init.method || 'GET',
        headers,
      });
      return new Promise((resolve, reject) => {
        request.once('response', (response) => {
          responseFromNodeResponse(response, url).then(resolve, reject);
        });
        request.once('error', reject);
        request.end(init.body);
      }).finally(() => { virtualFetchDepth -= 1; });
    };
    const virtualProxyFetch = (input, init, proxyUrl) => {
      const target = new scope.URL(String(input?.url || input));
      const proxy = new scope.URL(proxyUrl);
      const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
      const proxyPort = Number(proxy.port || 80);
      const socket = builtins.net.createConnection({ host: proxy.hostname, port: proxyPort });
      const encoder = new scope.TextEncoder();
      const decoder = new scope.TextDecoder();
      const append = (left, right) => {
        const result = new Uint8Array(left.byteLength + right.byteLength);
        result.set(left);
        result.set(right, left.byteLength);
        return result;
      };
      const headerEnd = (bytes) => {
        for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
          if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
        }
        return -1;
      };
      const parseHeaders = (bytes) => {
        const end = headerEnd(bytes);
        if (end < 0) return null;
        const lines = decoder.decode(bytes.slice(0, end)).split('\r\n');
        const statusLine = lines.shift() || '';
        const status = Number(statusLine.split(' ')[1] || 0);
        const headers = {};
        for (const line of lines) {
          const separator = line.indexOf(':');
          if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
        return { end: end + 4, status, statusLine, headers };
      };
      const tunnelError = (message) => {
        const error = new Error(message);
        error.code = 'ERR_PROXY_TUNNEL';
        return error;
      };
      return new Promise((resolve, reject) => {
        let stage = 'connect';
        let bytes = new Uint8Array();
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          socket.destroy?.();
          reject(error);
        };
        const finish = (status, headers, body) => {
          if (settled) return;
          settled = true;
          socket.destroy?.();
          resolve(new scope.Response(body, { status, headers }));
        };
        socket.once('connect', () => {
          socket.write(`CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\nConnection: close\r\n\r\n`);
        });
        socket.on('data', (chunk) => {
          bytes = append(bytes, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
          if (stage === 'connect') {
            const response = parseHeaders(bytes);
            if (!response) return;
            if (response.status !== 200) {
              fail(tunnelError(
                `Failed to establish tunnel to ${target.hostname}:${targetPort} via ${proxy.origin} ${response.statusLine}`,
              ));
              return;
            }
            bytes = bytes.slice(response.end);
            stage = 'response';
            // Browser virtual HTTPS endpoints are protocol-labelled HTTP
            // endpoints. This keeps the local CONNECT contract explicit
            // without pretending to implement arbitrary TLS in the browser.
            socket.write(`GET ${target.pathname || '/'}${target.search} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\nConnection: close\r\n\r\n`);
          }
          if (stage !== 'response') return;
          const response = parseHeaders(bytes);
          if (!response) return;
          const length = Number(response.headers['content-length']);
          if (!Number.isInteger(length) || bytes.byteLength < response.end + length) return;
          finish(response.status, response.headers, bytes.slice(response.end, response.end + length));
        });
        socket.once('error', fail);
        socket.once('end', () => {
          if (settled) return;
          if (stage === 'connect') {
            fail(tunnelError('Connection to establish proxy tunnel ended unexpectedly'));
            return;
          }
          const response = parseHeaders(bytes);
          if (!response) return fail(new Error('proxy response ended before headers'));
          finish(response.status, response.headers, bytes.slice(response.end));
        });
      });
    };
    const runtimeFetch = (input, init = {}) => {
      if (scope.__BNH_HTTP_CLIENT_FETCH__) return nativeFetch(input, init);
      const env = processObject.env || {};
      const target = String(input?.url || input);
      const useEnvProxy = /^(?:1|true)$/i.test(String(env.NODE_USE_ENV_PROXY || ''));
      const targetIsHttps = /^https:/i.test(target);
      const proxyUrl = targetIsHttps
        ? (env.https_proxy || env.HTTPS_PROXY)
        : (env.http_proxy || env.HTTP_PROXY);
      if (useEnvProxy && proxyUrl && /^https?:/i.test(target) && !virtualFetchDepth) {
        return virtualProxyFetch(input, init, proxyUrl);
      }
      return virtualHttpFetch(input, init);
    };
    builtins.worker_threads = workerThreads;
    const cache = new Map();
    const executionGlobal = createExecutionGlobal(scope);
    const moduleHookContext = (importer) => ({
      conditions: ['node', 'require'],
      parentURL: pathToFileURL(importer).href,
      importAttributes: {},
    });
    const runModuleHook = (kind, value, context, fallback) => {
      const hooks = processObject.__bnhModuleHooks || [];
      const invoke = (index, currentValue, currentContext) => {
        if (index < 0) return fallback(currentValue, currentContext);
        const hook = hooks[index]?.[kind];
        if (typeof hook !== 'function') return invoke(index - 1, currentValue, currentContext);
        const next = (nextValue = currentValue, nextContext = currentContext) => (
          invoke(index - 1, nextValue, nextContext)
        );
        const result = hook(currentValue, currentContext, next);
        return result === undefined ? next() : result;
      };
      return invoke(hooks.length - 1, value, context);
    };
    let mainModule = null;
    let sysWarningEmitted = false;
    const esmSourceHasTopLevelAwait = (source) => {
      const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
      return /(?:^|[;\n])\s*(?:await\b|(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=\s*await\b)/.test(text);
    };
    const esmGraphRequiresAsync = (entryPath, seen = new Set()) => {
      const normalizedEntry = entryPath.startsWith('file:') ? fileURLToPath(entryPath) : entryPath;
      if (seen.has(normalizedEntry)) return false;
      seen.add(normalizedEntry);
      let source;
      try {
        source = vfs.read(normalizedEntry);
      } catch {
        return false;
      }
      if (esmSourceHasTopLevelAwait(source)) return true;
      const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
      const imports = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm;
      let match;
      while ((match = imports.exec(text))) {
        if (match[1].startsWith('node:')) continue;
        let dependency;
        try {
          dependency = esmLoader.resolve(match[1], normalizedEntry, ['node', 'import']);
        } catch {
          continue;
        }
        if (dependency.startsWith('file:')) dependency = fileURLToPath(dependency);
        if (dependency.startsWith('node:')) continue;
        if (esmGraphRequiresAsync(dependency, seen)) return true;
      }
      return false;
    };
    const requireAsyncEsmError = (entryPath, parentImport) => {
      const error = new Error(
        `require() cannot be used on an ESM graph with top-level await. `
        + `Use import() instead. From ${parentImport} Requiring ${entryPath}`,
      );
      error.code = 'ERR_REQUIRE_ASYNC_MODULE';
      error.stack = `Error [ERR_REQUIRE_ASYNC_MODULE]: ${error.message}`;
      return error;
    };
    const loadModule = (specifier, importer = entry, skipResolve = false) => {
      const name = builtinName(specifier);
      if (name === 'sys' && !sysWarningEmitted) {
        sysWarningEmitted = true;
        processObject.emitWarning?.('sys is deprecated. Use util instead.', {
          code: 'DEP0025',
          type: 'DeprecationWarning',
        });
      }
      if (name === 'repl') return loadModule('/node/lib/repl.js', importer);
      if (BUILTIN_NAMES.includes(name)) {
        if (name === 'dns') scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ = Math.max(1, Number(scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ || 0));
        const context = moduleHookContext(importer);
        const resolved = runModuleHook('resolve', specifier, context, (currentSpecifier) => ({
          url: `node:${builtinName(currentSpecifier)}`,
          format: 'builtin',
        }));
        const url = resolved?.url || `node:${name}`;
        const loaded = runModuleHook('load', url, context, () => ({ format: 'builtin', source: null }));
        if (loaded?.format === 'builtin') return builtins[builtinName(url)] ?? {};
        if (loaded?.source !== undefined && loaded?.source !== null) {
          const source = typeof loaded.source === 'string'
            ? loaded.source
            : new TextDecoder().decode(loaded.source);
          if (loaded.format === 'json') return JSON.parse(source);
          if (loaded.format === 'module') {
            let transformed = source;
            transformed = transformed.replace(
              /export\s+default\s+([^;]+);?/,
              'const __bnhDefault = $1;',
            );
            transformed = transformed.replace(
              /export\s*\{\s*([$_A-Za-z][$_\w]*)\s+as\s+["']module\.exports["']\s*\};?/,
              '__bnhModuleExports = $1;',
            );
            const evaluateModule = new Function(
              '__bnhImport',
              `let __bnhModuleExports;\n${transformed}\nreturn __bnhModuleExports ?? __bnhDefault;`,
            );
            return evaluateModule((specifier) => esmLoader.import(specifier, importer));
          }
          const overrideModule = { exports: {} };
          const overrideRequire = (specifier) => loadModule(specifier, importer);
          runCommonJSWrapper(
            source,
            url,
            [overrideRequire, overrideModule, overrideModule.exports, url, '/node', undefined],
            moduleApi.wrapper,
          );
          return overrideModule.exports;
        }
        return builtins[name] ?? {};
      }
      const context = moduleHookContext(importer);
      const resolvedResult = skipResolve
        ? {
            url: specifier.startsWith('file:') ? specifier : pathToFileURL(specifier).href,
            format: specifier.endsWith('.json') ? 'json' : isRuntimeEsmModule(specifier, processObject.execArgv) ? 'module' : 'commonjs',
          }
        : runModuleHook('resolve', specifier, context, (currentSpecifier) => {
            const candidate = esmLoader.resolve(currentSpecifier, importer, ['node', 'require']);
            return {
              url: pathToFileURL(candidate).href,
              format: candidate.endsWith('.json') ? 'json' : isRuntimeEsmModule(candidate, processObject.execArgv) ? 'module' : 'commonjs',
            };
          });
      if (resolvedResult?.url?.startsWith('node:') && resolvedResult.shortCircuit !== true) {
        const error = new Error('"shortCircuit" must be true when a resolve hook does not call nextResolve');
        error.code = 'ERR_INVALID_RETURN_PROPERTY_VALUE';
        throw error;
      }
      const resolvedURL = resolvedResult?.url || pathToFileURL(resolveFile(specifier, importer, processObject)).href;
      let resolved = resolvedURL.startsWith('file:') ? fileURLToPath(resolvedURL) : resolvedURL;
      if (isNativeAddonBuildPath(resolved) || (resolved.endsWith('.node') && addonsDisabled(processObject))) {
        rejectNativeAddon(nativeAddonPath(resolved), processObject);
      }
      let loaded;
      try {
        loaded = runModuleHook('load', resolvedURL, context, (url) => {
          const candidate = url.startsWith('file:') ? fileURLToPath(url) : url;
          if (candidate.endsWith('.node')) rejectNativeAddon(candidate, processObject);
          const source = vfs.read(candidate);
          return {
            url,
            format: candidate.endsWith('.json') ? 'json' : isRuntimeEsmModule(candidate, processObject.execArgv) ? 'module' : 'commonjs',
            source: typeof source === 'string' ? source : new TextDecoder().decode(source),
          };
        });
      } catch (error) {
        if (error?.code === 'ENOENT') error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
          if (loaded?.url?.startsWith('file:')) {
            resolved = fileURLToPath(loaded.url);
          }
          if (resolved.startsWith('data:')) return {};
          if (resolved.endsWith('.node')) rejectNativeAddon(resolved, processObject);
          if (cache.has(resolved)) return cache.get(resolved).exports;
      const source = loaded?.source ?? vfs.read(resolved);
      const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
          if (resolved.endsWith('.mjs')
            && (esmSourceHasTopLevelAwait(text) || esmGraphRequiresAsync(resolved))) {
            throw requireAsyncEsmError(resolved, importer);
          }
      const parentModule = typeof importer === 'string' ? cache.get(importer) : importer;
      const module = new builtins.module(resolved, parentModule || null);
      module.filename = resolved;
      module.paths = moduleSearchPaths(resolved);
      if (!mainModule && resolved === entry) {
        mainModule = module;
        processObject.mainModule = module;
      }
      builtins.module._main = mainModule;
      cache.set(resolved, module);
      builtins.module._cache = cache;
      if (resolved.endsWith('.json')) module.exports = JSON.parse(text);
      else {
        const require = (name) => loadModule(esmLoader.resolve(name, resolved, ['node', 'require']), resolved);
        require.resolve = (name) => BUILTIN_NAMES.includes(builtinName(name))
          ? name
          : esmLoader.resolve(name, resolved, ['node', 'require']);
        require.main = mainModule;
        require.cache = cache;
        module.require = require;
        module._compile(text, resolved, loaded?.format === 'module' || moduleHasStaticEsmSyntax(text)
          ? 'module' : loaded?.format);
      }
      module.loaded = true;
      return module.exports;
    };
    const esmLoader = createModuleLoader({
      files: {
        has: (pathname) => vfs.files.has(pathname),
        get: (pathname) => vfs.read(pathname),
      },
      builtins,
      globalObject: scope,
      evaluateCommonJS: (specifier, importer) => loadModule(specifier, importer, true),
      runModuleHook,
      defaultModuleType: processObject.execArgv?.some(
        (argument) => String(argument) === '--experimental-default-type=module',
      ) ? 'module' : 'commonjs',
    });
    processObject.__bnhModuleImport = (specifier, importer, options) => (
      esmLoader.import(specifier, importer, {}, options)
    );
    builtins.module._bnhSetSyncBuiltinESMExports(esmLoader.syncBuiltinESMExports);
    const loadModuleRegistrations = async () => {
      const registrations = processObject.__bnhModuleRegistrations || [];
      processObject.__bnhModuleRegistrations = [];
      for (const registration of registrations) {
        const hook = await esmLoader.import(registration.specifier, registration.parentURL || entry);
        await hook?.initialize?.(registration.options?.data);
        const resolve = typeof hook?.resolve === 'function' && hook.resolve.constructor?.name === 'AsyncFunction'
          ? new Function(`return (${String(hook.resolve).replace(/^async\s+/, '').replace(/\bawait\s+/g, '')})`)()
          : hook?.resolve;
        const hooks = processObject.__bnhModuleHooks || [];
        hooks.push({ resolve, load: hook?.load });
        processObject.__bnhModuleHooks = hooks;
      }
    };
    const importPreloads = async () => {
      const execArgv = processObject.execArgv || [];
      const preloadImporter = path.posix.join(processObject.cwd?.() || '/node', '.bnh-preload.mjs');
      for (let index = 0; index < execArgv.length; index += 1) {
        const argument = String(execArgv[index]);
        const preload = argument === '--import'
          ? execArgv[++index]
          : argument.startsWith('--import=') ? argument.slice('--import='.length) : undefined;
        if (preload !== undefined) await esmLoader.import(String(preload), preloadImporter);
      }
      await loadModuleRegistrations();
    };
    scope.__bnhModuleLoader = { resolvePackageExport: (name) => name, require: loadModule };
    const previous = {
      process: scope.process,
      Buffer: scope.Buffer,
      File: scope.File,
      atob: scope.atob,
      btoa: scope.btoa,
      console: scope.console,
      global: scope.global,
      MessageEvent: scope.MessageEvent,
      MessageChannel: scope.MessageChannel,
      Crypto: scope.Crypto,
      CryptoKey: scope.CryptoKey,
      SubtleCrypto: scope.SubtleCrypto,
      structuredClone: scope.structuredClone,
      ReadableStream: scope.ReadableStream,
      ReadableStreamDefaultReader: scope.ReadableStreamDefaultReader,
      ReadableStreamBYOBReader: scope.ReadableStreamBYOBReader,
      ReadableStreamBYOBRequest: scope.ReadableStreamBYOBRequest,
      ReadableByteStreamController: scope.ReadableByteStreamController,
      ReadableStreamDefaultController: scope.ReadableStreamDefaultController,
      WritableStream: scope.WritableStream,
      WritableStreamDefaultWriter: scope.WritableStreamDefaultWriter,
      WritableStreamDefaultController: scope.WritableStreamDefaultController,
      TransformStream: scope.TransformStream,
      TransformStreamDefaultController: scope.TransformStreamDefaultController,
      ByteLengthQueuingStrategy: scope.ByteLengthQueuingStrategy,
      CountQueuingStrategy: scope.CountQueuingStrategy,
      TextEncoderStream: scope.TextEncoderStream,
      TextDecoderStream: scope.TextDecoderStream,
      CompressionStream: scope.CompressionStream,
      DecompressionStream: scope.DecompressionStream,
      WebAssembly: scope.WebAssembly,
      URL: scope.URL,
      URLSearchParams: scope.URLSearchParams,
      setTimeout: scope.setTimeout,
      clearTimeout: scope.clearTimeout,
      setInterval: scope.setInterval,
      clearInterval: scope.clearInterval,
      setImmediate: scope.setImmediate,
      clearImmediate: scope.clearImmediate,
      fetch: scope.fetch,
      __bnh: scope.__bnh,
      primordials: scope.primordials,
      internalBinding: scope.internalBinding,
      getInternalBinding: scope.getInternalBinding,
    };
    const deterministicEnvironment = Object.freeze({
      variant: options.variant || 'browser',
      platform: processObject.platform,
      arch: processObject.arch,
    });
    const childConsole = createConsole(stdout, stderr, scope.console || {});
    // The console builtin is also the global console object in Node. Reuse
    // the browser output facade while giving it the shared Console prototype
    // and stateful methods implemented by the compatibility module.
    const consoleModule = builtins.console;
    if (consoleModule?.Console) {
      Object.setPrototypeOf(childConsole, consoleModule.Console.prototype);
      childConsole.Console = consoleModule.Console;
      childConsole._stdout = { write: (value) => { stdout(value); return true; } };
      childConsole._stderr = { write: (value) => { stderr(value); return true; } };
      installConsoleErrorHandlers(childConsole);
      childConsole._ignoreErrors = true;
      childConsole._inspectOptions = {};
      childConsole._colorMode = undefined;
      childConsole._groupIndentation = 2;
      childConsole._groupIndent = 0;
      childConsole._times = new Map();
      childConsole._counts = new Map();
      builtins.console = childConsole;
    }
    const onUnhandledRejection = (event) => {
      const dispatch = () => {
        const handled = processObject.emit('unhandledRejection', event.reason, event.promise);
        if (!handled) processObject._bnhDispatchUncaughtException?.(event.reason, 'unhandledRejection');
      };
      const runWithPromiseScope = processObject._bnhRunWithPromiseScope;
      if (typeof runWithPromiseScope === 'function') runWithPromiseScope(event.promise, dispatch);
      else dispatch();
      event.preventDefault?.();
    };
    if (typeof scope.addEventListener === 'function') scope.addEventListener('unhandledrejection', onUnhandledRejection);
    if (processObject.execArgv?.some((argument) => String(argument) === '--expose-gc')) {
      scope.gc = () => {
        collectAsyncResources();
        vfs.collectGarbage?.();
      };
    } else {
      delete scope.gc;
    }
    const injectedSetTimeout = (callback, delay, ...args) => setTimer(function timerCallback() {
      return callback.apply(this, args);
    }, delay);
    Object.defineProperty(injectedSetTimeout, Symbol.for('nodejs.util.promisify.custom'), {
      configurable: true,
      value: (delay, ...args) => new Promise((resolve) => injectedSetTimeout(resolve, delay, ...args)),
    });
    Object.assign(scope, {
      process: processObject,
      require: loadModule,
      Buffer,
      File,
      atob: Buffer.atob,
      btoa: Buffer.btoa,
      console: childConsole,
      global: scope,
      MessageEvent: createMessageEvent(scope, {
        MessagePortClass: browserIO.MessagePort,
        NativeMessagePort: scope.MessagePort,
      }),
      MessageChannel: browserIO.MessageChannel,
      structuredClone: browserIO.structuredClone,
      URL: builtins.url.URL,
      URLSearchParams: builtins.url.URLSearchParams,
      __bnh: { deterministicEnvironment },
      setTimeout: injectedSetTimeout,
      clearTimeout: clearTimer,
      setInterval: (callback, delay, ...args) => setTimer(function intervalCallback() {
        return callback.apply(this, args);
      }, delay, true),
      clearInterval: clearTimer,
      setImmediate: (callback, ...args) => setTimer(function immediateCallback() {
        return callback.apply(this, args);
      }, 1, false, 'Immediate'),
      clearImmediate: clearTimer,
      fetch: runtimeFetch,
      primordials: createPrimordials(scope),
      internalBinding: internalBindings.internalBinding,
      getInternalBinding: internalBindings.internalBinding,
    });
    const internalWebCrypto = loadModule('internal/crypto/webcrypto', entry);
    if (internalWebCrypto?.CryptoKey && scope.CryptoKey?.prototype) {
      Object.setPrototypeOf(scope.CryptoKey.prototype, internalWebCrypto.CryptoKey.prototype);
    }
    if (internalWebCrypto?.Crypto) scope.Crypto = internalWebCrypto.Crypto;
    if (internalWebCrypto?.CryptoKey) scope.CryptoKey = internalWebCrypto.CryptoKey;
    if (internalWebCrypto?.SubtleCrypto) scope.SubtleCrypto = internalWebCrypto.SubtleCrypto;
    Object.assign(scope, {
      ReadableStream: streamWebApi.ReadableStream,
      ReadableStreamDefaultReader: streamWebApi.ReadableStreamDefaultReader,
      ReadableStreamBYOBReader: streamWebApi.ReadableStreamBYOBReader,
      ReadableStreamBYOBRequest: streamWebApi.ReadableStreamBYOBRequest,
      ReadableByteStreamController: streamWebApi.ReadableByteStreamController,
      ReadableStreamDefaultController: streamWebApi.ReadableStreamDefaultController,
      WritableStream: streamWebApi.WritableStream,
      WritableStreamDefaultWriter: streamWebApi.WritableStreamDefaultWriter,
      WritableStreamDefaultController: streamWebApi.WritableStreamDefaultController,
      TransformStream: streamWebApi.TransformStream,
      TransformStreamDefaultController: streamWebApi.TransformStreamDefaultController,
      ByteLengthQueuingStrategy: streamWebApi.ByteLengthQueuingStrategy,
      CountQueuingStrategy: streamWebApi.CountQueuingStrategy,
      TextEncoderStream: streamWebApi.TextEncoderStream,
      TextDecoderStream: streamWebApi.TextDecoderStream,
      CompressionStream: streamWebApi.CompressionStream,
      DecompressionStream: streamWebApi.DecompressionStream,
      WebAssembly: createWasmContract(scope),
    });
    vfs.mkdir('/node/deps/corepack', { recursive: true });
    vfs.writeFile('/node/deps/corepack/package.json', JSON.stringify({ version: '0.34.6' }));
    try {
      await importPreloads();
      if (isRuntimeEsmModule(entry, processObject.execArgv)) await esmLoader.import(entry, entry);
      else loadModule(entry, entry);
      await Promise.resolve();
      let idleRounds = 0;
      while (!options.isCancelled?.() && !options.signal?.aborted && !processObject._exitRequested?.()) {
        const activeTimers = processObject._timers || timerHandles;
        if (pending === 0 && !hasReferencedTimers(activeTimers) && !hasLiveVirtualProcess()
          && !hasReferencedIpc() && !hasReferencedWorkerParentPort()) {
          idleRounds += 1;
          // Browser fetch, worker, and rejection events settle on later task turns.
          // Give beforeExit listeners a chance to revive the event loop once,
          // matching Node's natural shutdown lifecycle.
          if (idleRounds >= 32) {
            if (processObject._emitBeforeExit?.()) {
              idleRounds = 0;
              continue;
            }
            break;
          }
        } else {
          idleRounds = 0;
        }
        await new Promise((resolve) => nativeSetTimeout(resolve, 0));
      }
      if (options.isCancelled?.() || options.signal?.aborted) return null;
      return processObject.getCode();
    } catch (error) {
      stderr(`${error?.stack || error}\n`);
      processObject.exitCode = 1;
      if (injectedProcess && typeof injectedProcess.exit === 'function') {
        try { injectedProcess.exit(1); } catch { /* ignore */ }
      }
      if (String(error?.code || '').startsWith('ERR_UNSUPPORTED_')) throw error;
      return 1;
    } finally {
      for (const handle of timerHandles) clearTimer?.(handle);
      vfs.setTaskTracker?.(null);
      if (typeof scope.removeEventListener === 'function') scope.removeEventListener('unhandledrejection', onUnhandledRejection);
      esmLoader.dispose();
      processObject._markExited?.();
      Object.assign(scope, previous);
      delete scope.__bnhModuleLoader;
    }
  }

  const runtime = {
    version,
    contracts: createBrowserRuntimeContracts({ globalObject: scope }),
    async reset(context = {}) {
      if (activeChild) await activeChild.kill();
      activeChild = null;
      virtualProcessLiveness.clear();
      environmentData.clear();
      if (context.signal?.aborted) return;
      runSpec = {
        runId: String(context.runId || context.metadata?.runId || `browser-${Date.now()}`),
        capabilities: validateCapabilityManifest(context.capabilities),
        fixtures: context.fixtures,
      };
      capabilities = assembleBrowserCapabilities(runSpec, { globalObject: scope });
      const manifestProxy = capabilities.manifest.proxy || { mode: 'virtual', enabled: false, capabilityKey: 'proxy', capabilityGranted: false };
      const requestedProxy = context.proxy && typeof context.proxy === 'object' ? context.proxy : {};
      const configuredAdapter = requestedProxy.adapter
        || scope.__BNH_PROXY_ADAPTER__
        || scope.__BROWSER_NODE_HARNESS_PROXY__;
      proxyCapability = createProxyCapability({
        ...manifestProxy,
        ...requestedProxy,
        ...(configuredAdapter ? { adapter: configuredAdapter } : {}),
        capability: requestedProxy.capability || {
          key: manifestProxy.capabilityKey,
          granted: manifestProxy.capabilityGranted,
        },
      });
      const proxyTransport = proxyCapability.mode === 'proxy' && proxyCapability.enabled
        && proxyCapability.capabilityGranted && proxyCapability.adapter
        ? {
            connect: (request) => proxyCapability.connect(request),
            send: (request) => proxyCapability.send(request),
          }
        : undefined;
      const preserveSharedNetwork = context.virtualNetwork?.shared === true;
      const inheritedNetwork = context.virtualNetwork?.network;
      if (proxyTransport) virtualNetwork = createVirtualNetwork({ transport: proxyTransport });
      else if (preserveSharedNetwork) virtualNetwork = inheritedNetwork || getSharedVirtualNetwork(scope);
      else virtualNetwork = replaceSharedVirtualNetwork(scope);
      dnsModule = createBrowserDns({ proxy: proxyCapability });
      scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ = 0;
      vfs = capabilities.vfs;
      mounted = false;
    },
    async mount(files, context = {}) {
      if (context.signal?.aborted) return;
      if (!capabilities) {
        await runtime.reset({ runId: 'direct-runtime', capabilities: DEFAULT_RUNTIME_CAPABILITIES });
      }
      const mount = capabilities.manifest.vfs.mounts.find((item) => item.path === '/node');
      if (!mount) {
        const error = new Error('the /node VFS mount is required for a browser entry');
        error.code = 'ERR_CAPABILITY_DENIED';
        throw error;
      }
      vfs.mount(files, { ...mount, path: '/node' });
      mounted = true;
    },
    async executeEntry(entry, options, stdout, stderr) {
      if (!mounted) throw new Error('runtime.mount() must be called before runtime.executeEntry()');
      return execute(entry, { ...options, entry }, stdout, stderr);
    },
    exportArtifacts() {
      return vfs.exportArtifacts();
    },
    async spawn(argv, options = {}) {
      if (!mounted) throw new Error('runtime.mount() must be called before runtime.spawn()');
      const entry = normalizePath(argv.at(-1), options.cwd || '/node');
      const allowedEntries = capabilities.manifest.workers.entryModules;
      if (!allowedEntries.includes(entry) && !allowedEntries.includes('*')) {
        const error = new Error(`worker entry is not granted: ${entry}`);
        error.code = 'ERR_CAPABILITY_DENIED';
        throw error;
      }
      const allowedEnvironment = new Set(capabilities.manifest.envVars.allowed);
      for (const key of Object.keys(options.env || {})) {
        if (!allowedEnvironment.has(key)) {
          const error = new Error(`environment key is not granted: ${key}`);
          error.code = 'ERR_CAPABILITY_DENIED';
          throw error;
        }
      }
      const stdout = capabilities.output.stdout;
      const stderr = capabilities.output.stderr;
      const workerSource = new URL('./runtime/process-entry.js', import.meta.url).href;
      const files = Object.fromEntries(
        vfs.snapshot({ copy: false }).artifacts.map(({ path, bytes }) => [path, bytes]),
      );
      const spawnProxy = proxyCapability.adapter ? proxyCapability : capabilities.manifest.proxy;
      const childExecArgv = [];
      const valueTakingFlags = new Set(['--import', '--experimental-loader', '--loader', '--require', '--input-type']);
      for (let index = 1; index < argv.length - 1; index += 1) {
        const argument = String(argv[index]);
        if (!argument.startsWith('-')) continue;
        childExecArgv.push(argument);
        if (valueTakingFlags.has(argument) && index + 1 < argv.length - 1) {
          childExecArgv.push(String(argv[++index]));
        }
      }
      const processOptions = {
        runId: runSpec.runId,
        childId: `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        entry,
        argv,
        execArgv: childExecArgv,
        env: options.env,
        cwd: options.cwd || '/node',
        signalGrants: capabilities.manifest.signals.allowed,
        workerSource,
        workerType: 'module',
        timeout: options.timeout,
        runSource: '((context) => globalThis.__bnhRun(context))',
        vfs: {
          capabilities: capabilities.manifest,
          files,
          entry,
          execArgv: childExecArgv,
          proxy: spawnProxy,
        },
        stdout: capabilities.output.stdout,
        stderr: capabilities.output.stderr,
      };
      const worker = proxyCapability.adapter
        ? createVirtualProcess({ ...processOptions, scope, forceFallback: true })
        : capabilities.process.create(processOptions);
      let artifacts = {};
      worker.on('message', (message) => {
        if (message?.type === 'bnh-artifacts') artifacts = message.artifacts || {};
      });
      const child = {
        exit: worker.wait().then((terminal) => terminal.code),
        stdoutText: async () => { await worker.wait(); return new TextDecoder().decode(capabilities.output.stdoutBytes); },
        stderrText: async () => { await worker.wait(); return new TextDecoder().decode(capabilities.output.stderrBytes); },
        structuredResult: null,
        output: capabilities.output,
        async kill() {
          try { worker.kill('SIGKILL'); } catch { /* already terminal */ }
          await worker.wait();
        },
      };
      activeChild = child;
      worker.wait().then((terminal) => {
        stdout.end();
        stderr.end();
        child.structuredResult = {
          runId: runSpec.runId,
          outcome: terminal.status === 'exited' && terminal.code === 0
            ? 'passed'
            : String(terminal.error?.code || '').startsWith('ERR_UNSUPPORTED_') ? 'unsupported' : 'failed',
          phase: terminal.kind === 'timeout' ? 'shutdown' : terminal.status === 'exited' ? 'running' : 'launch',
          exit: { code: terminal.code, signal: terminal.signal, reason: terminal.kind },
          error: terminal.error,
          stdout: capabilities.output.stdoutBytes,
          stderr: capabilities.output.stderrBytes,
          outputEvents: capabilities.output.records(),
          lifecycleEvents: [...worker.stateHistory],
          details: {
            network_mode: proxyCapability.mode,
            proxy_enabled: Boolean(proxyCapability.enabled && proxyCapability.capabilityGranted && proxyCapability.adapter),
            virtual_network: true,
          },
          artifacts,
        };
      });
      return child;
    },
  };
  return runtime;
}

export const runtime = createRuntime();
