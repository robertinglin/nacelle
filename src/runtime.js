import { createAssert, inspect as nodeInspect } from './runtime/assert.js';
import {
  createBufferClass,
  createTranscode,
  createFileClass,
  installBlobCompatibility,
  installBlobStreamClass,
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
  createMessageChannel,
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
  isPromiseHandled,
  isPromiseRejectionReported,
  registerAsyncCompletion,
  runAsyncGenerator,
  setPromiseRejectionObserver,
} from './runtime/async-hooks.js';
import { transformAsyncSource } from './runtime/async-transform.js';
import { EventEmitter, addAbortListener, getEventListeners, getMaxListeners, once } from './runtime/events.js';
import { createVfs, fileURLToPath, pathToFileURL } from './runtime/vfs.js';
import { path } from './runtime/path.js';
import { runShellScript } from './runtime/shell.js';
import {
  Readable, initializeCallableReadable, Writable, Duplex, Transform, PassThrough, Stream, duplexPair, pipeline, destroy,
  compose, isDestroyed, isDisturbed, isErrored, isReadable, isWritable, promises as streamPromises,
  setDefaultHighWaterMark, getDefaultHighWaterMark,
} from './runtime/streams.js';
import { createStreamAdapters } from './runtime/stream-adapters.js';
import { createPlatformContract } from './runtime/os-platform.js';
import { createHttpCompatibility } from './runtime/http.js';
import { createTlsModule } from './runtime/tls.js';
import { createHttp2Module } from './runtime/http2.js';
import { createPerformancePrimitives } from './runtime/perf.js';
import { createWasmContract } from './runtime/wasm.js';
import { installErrorStackCompatibility } from './runtime/error-stack.js';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  createHashShim,
  createHmacShim,
  createSignClass,
  createVerifyClass,
  createKeyObjectContract,
  createSecretKeyShim,
  installCryptoKeyMaterialTracking,
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
  generateKeySync,
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
  validateScryptArguments,
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
  installTextEncoderInspect,
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
import {
  createVirtualNetwork,
  createWorkerNetworkBridge,
  getSharedVirtualNetwork,
  replaceSharedVirtualNetwork,
} from './runtime/virtual-network.js';
import { createCluster } from './runtime/cluster.js';
import { createVirtualProcess } from './runtime/virtual-process.js';
import { createBrowserExecve, createBrowserProcess } from './runtime/process.js';
import { resolveNodeVersionProfile } from './versions/index.js';
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
import { loadWasmAddon, isWasmModuleBytes } from './runtime/addon-napi.js';
import { createSqliteModule } from './runtime/sqlite.js';
import { createInspectorModule, createInspectorPromisesModule } from './runtime/inspector.js';
import { createTraceEventsModule, traceEventsUnavailableError } from './runtime/trace-events.js';
import { createSeaModule } from './runtime/sea.js';
import { createTtyModule } from './runtime/tty.js';
import { createBrowserReadline } from './runtime/readline.js';
import { createVersionedModuleCache } from './runtime/module-cache.js';
import { BrowserNpm, parsePackageSpec } from './runtime/npm.js';

const BUILTIN_NAMES = Object.freeze([
  'assert', 'assert/strict', 'buffer', 'console', 'constants', 'crypto', 'domain', 'events', 'fs', 'fs/promises', 'http', 'https', 'module', 'os',
  'path', 'path/posix', 'path/win32', 'process', 'querystring', 'stream', 'stream/consumers', 'stream/promises', 'stream/web',
  'string_decoder', 'timers', 'timers/promises', 'url', 'util', 'sys', 'util/types', 'worker_threads', 'zlib', 'perf_hooks', 'async_hooks', 'diagnostics_channel', 'punycode',
  'child_process', 'cluster', 'dgram', 'dns', 'dns/promises', 'http2', 'inspector', 'inspector/promises', 'net', 'readline', 'readline/promises', 'repl', 'tls', 'test', 'v8', 'vm', '_http_server',
  'sea', 'sqlite', 'test/reporters', '_http_common', '_http_outgoing', 'trace_events', 'tty',
  'internal/event_target', 'internal/async_context_frame', 'internal/async_hooks', 'internal/test/binding', 'internal/test/transfer',
  'internal/bootstrap/realm', 'internal/modules/cjs/loader', 'internal/modules/esm/utils', 'internal/vm/module',
  'internal/webstreams/adapters',
  'internal/util', 'internal/util/debuglog', 'internal/util/types', 'internal/options', 'internal/dgram', 'internal/crypto/x509', 'internal/crypto/keys',
]);

function builtinName(name) {
  return name.startsWith('node:') ? name.slice(5) : name;
}

function ensureReplDispose(replModule) {
  const prototype = replModule?.REPLServer?.prototype;
  if (!prototype) return replModule;
  const disposeSymbol = Symbol.for('nodejs.dispose');
  if (typeof prototype[disposeSymbol] === 'function') return replModule;
  const nativeDispose = Symbol.dispose;
  const dispose = nativeDispose && typeof prototype[nativeDispose] === 'function'
    ? prototype[nativeDispose]
    : function dispose() { this.close(); };
  Object.defineProperty(prototype, disposeSymbol, {
    configurable: true,
    value: dispose,
    writable: true,
  });
  return replModule;
}

const BROWSER_SIGNAL_CONSTANTS = Object.freeze({
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGFPE: 8,
  SIGHUP: 1,
  SIGILL: 4,
  SIGIO: 29,
  SIGIOT: 6,
  SIGPOLL: 29,
  SIGPROF: 27,
  SIGPWR: 30,
  SIGQUIT: 3,
  SIGSEGV: 11,
  SIGSTKFLT: 16,
  SIGSTOP: 19,
  SIGSYS: 31,
  SIGTRAP: 5,
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
    ENGINE_METHOD_RSA: 1,
    RSA_NO_PADDING: 3,
    RSA_PKCS1_OAEP_PADDING: 4,
    RSA_PKCS1_PADDING: 1,
    RSA_PKCS1_PSS_PADDING: 6,
    RSA_PSS_SALTLEN_AUTO: -2,
    RSA_PSS_SALTLEN_DIGEST: -1,
    RSA_PSS_SALTLEN_MAX_SIGN: -2,
    RSA_X931_PADDING: 5,
    POINT_CONVERSION_UNCOMPRESSED: 4,
    POINT_CONVERSION_HYBRID: 6,
    PRIORITY_LOW: 19,
    PRIORITY_BELOW_NORMAL: 10,
    PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7,
    PRIORITY_HIGH: -14,
    PRIORITY_HIGHEST: -20,
    EACCES: 13,
    EADDRINUSE: 98,
    EADDRNOTAVAIL: 99,
    EAFNOSUPPORT: 97,
    EAGAIN: 11,
    EALREADY: 114,
    EBADF: 9,
    EBADMSG: 74,
    E2BIG: 7,
    EBUSY: 16,
    ECANCELED: 125,
    ECHILD: 10,
    ECONNABORTED: 103,
    ECONNREFUSED: 111,
    ECONNRESET: 104,
    EDEADLK: 35,
    EDESTADDRREQ: 89,
    EDOM: 33,
    EDQUOT: 122,
    EEXIST: 17,
    EFAULT: 14,
    EFBIG: 27,
    EHOSTUNREACH: 113,
    EIDRM: 43,
    EILSEQ: 84,
    ENOBUFS: 105,
    ENODATA: 61,
    ENODEV: 19,
    ENOENT: 2,
    ENOEXEC: 8,
    ENOLCK: 37,
    ENOLINK: 67,
    EINPROGRESS: 115,
    EINTR: 4,
    EINVAL: 22,
    EIO: 5,
    EISCONN: 106,
    ELOOP: 40,
    EMFILE: 24,
    EMLINK: 31,
    EMSGSIZE: 90,
    EMULTIHOP: 72,
    ENAMETOOLONG: 36,
    ENETDOWN: 100,
    ENETRESET: 102,
    ENETUNREACH: 101,
    ENFILE: 23,
    ENOTDIR: 20,
    ENOTEMPTY: 39,
    ENOTSOCK: 88,
    ENOTSUP: 95,
    ENOTTY: 25,
    ENXIO: 6,
    EROFS: 30,
    ESPIPE: 29,
    ENOMEM: 12,
    ENOMSG: 42,
    ENOPROTOOPT: 92,
    ENOSPC: 28,
    ENOSR: 63,
    ENOSTR: 60,
    ENOSYS: 38,
    ENOTCONN: 107,
    EISDIR: 21,
    EOPNOTSUPP: 95,
    EOVERFLOW: 75,
    EPERM: 1,
    EPIPE: 32,
    EPROTO: 71,
    EPROTONOSUPPORT: 93,
    EPROTOTYPE: 91,
    ERANGE: 34,
    ESRCH: 3,
    ESTALE: 116,
    ETIME: 62,
    ETIMEDOUT: 110,
    ETXTBSY: 26,
    EWOULDBLOCK: 11,
    EXDEV: 18,
  });
}

const ERRNO_CONSTANT_NAMES = Object.freeze([
  'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EAGAIN', 'EALREADY', 'EBADF', 'EBADMSG',
  'E2BIG', 'EBUSY', 'ECANCELED', 'ECHILD', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EDEADLK',
  'EDESTADDRREQ', 'EDOM', 'EDQUOT', 'EEXIST', 'EFAULT', 'EFBIG', 'EHOSTUNREACH', 'EIDRM', 'EILSEQ',
  'ENOBUFS', 'ENODATA', 'ENODEV', 'ENOENT', 'ENOEXEC', 'ENOLCK', 'ENOLINK',
  'EINPROGRESS', 'EINTR', 'EINVAL', 'EIO', 'EISCONN', 'ELOOP', 'EMFILE', 'EMLINK',
  'EMSGSIZE', 'EMULTIHOP', 'ENAMETOOLONG', 'ENETDOWN',
  'ENETRESET', 'ENETUNREACH', 'ENFILE', 'ENOTDIR', 'ENOTEMPTY', 'ENOTSOCK', 'ENOTSUP', 'ENOTTY',
  'ENXIO', 'EROFS', 'ESPIPE', 'EISDIR', 'EOPNOTSUPP', 'EOVERFLOW', 'EPERM', 'EPIPE',
  'ENOMEM', 'ENOMSG', 'ENOPROTOOPT', 'ENOSPC', 'ENOSR', 'ENOSTR', 'ENOSYS', 'ENOTCONN',
  'EPROTO', 'EPROTONOSUPPORT', 'EPROTOTYPE', 'ERANGE', 'ESRCH', 'ESTALE',
  'ETIME', 'ETIMEDOUT', 'ETXTBSY', 'EWOULDBLOCK', 'EXDEV',
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

function createNodeWebStreamModule(runtimeRequire, scope = globalThis) {
  const module = {};
  const kWebStreamClosed = Symbol.for('nodejs.webstream.isClosedPromise');
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
  const readableStreamWrappers = new WeakMap();
  const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
  const bindReadableStreamSource = (source, lifecycle) => {
    if (source === null || typeof source !== 'object') return source;
    const wrapped = { ...source };
    let resource;
    const wrapController = (controller) => {
      if (!controller || typeof controller !== 'object') return controller;
      return new Proxy(controller, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'close' && typeof value === 'function') {
            return (...args) => {
              lifecycle.resolve();
              return value.apply(target, args);
            };
          }
          if (property === 'error' && typeof value === 'function') {
            return (reason) => {
              lifecycle.reject(reason || new Error('ReadableStream errored'));
              return value.call(target, reason);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    for (const name of ['start', 'pull', 'cancel']) {
      const callback = source[name];
      if (typeof callback !== 'function') continue;
      resource ||= new AsyncResource('ReadableStream');
      wrapped[name] = function boundReadableStreamCallback(...args) {
        const callbackArgs = name === 'cancel'
          ? args
          : [wrapController(args[0]), ...args.slice(1)];
        return resource.runInAsyncScope(callback, this, ...callbackArgs);
      };
    }
    return resource ? wrapped : source;
  };
  const wrapReadableStream = (NativeReadableStream) => {
    if (typeof NativeReadableStream !== 'function') return NativeReadableStream;
    const existing = readableStreamWrappers.get(NativeReadableStream);
    if (existing) return existing;
    class NodeReadableStream extends NativeReadableStream {
      constructor(source, strategy) {
        if (source !== undefined && (source === null || typeof source !== 'object')) {
          const error = new TypeError('The "source" argument must be of type object');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (strategy !== undefined && strategy !== null && typeof strategy !== 'object') {
          const error = new TypeError('The "strategy" argument must be of type object');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (strategy && strategy.size !== undefined && typeof strategy.size !== 'function') {
          const error = new TypeError('The "strategy.size" property must be of type function');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (strategy && strategy.highWaterMark !== undefined
            && (typeof strategy.highWaterMark !== 'number'
              || Number.isNaN(strategy.highWaterMark) || strategy.highWaterMark < 0)) {
          const error = new TypeError('The property "strategy.highWaterMark" is invalid');
          error.code = 'ERR_INVALID_ARG_VALUE';
          throw error;
        }
        let resolveClosed;
        let rejectClosed;
        const lifecycle = {
          promise: new Promise((resolve, reject) => {
            resolveClosed = resolve;
            rejectClosed = reject;
          }),
          resolve() { resolveClosed(); },
          reject(error) { rejectClosed(error); },
        };
        lifecycle.promise.catch(() => {});
        super(
          bindReadableStreamSource(source, lifecycle),
          Array.isArray(strategy) || strategy === null ? undefined : strategy,
        );
        Object.defineProperty(this, kWebStreamClosed, {
          configurable: true,
          enumerable: false,
          value: lifecycle,
        });
      }
      getReader(options) {
        if (options !== undefined) {
          if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            const error = new TypeError('The "options" argument must be of type object');
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
          }
          if (options.mode !== undefined && options.mode !== 'byob') {
            const error = new TypeError(`The property 'options.mode' is invalid. Received ${options.mode}`);
            error.code = 'ERR_INVALID_ARG_VALUE';
            throw error;
          }
        }
        return super.getReader(options);
      }
      tee() {
        const branches = super.tee();
        for (const branch of branches) {
          if (!(branch instanceof NodeReadableStream)) {
            Object.setPrototypeOf(branch, NodeReadableStream.prototype);
          }
        }
        return branches;
      }
    }
    readableStreamWrappers.set(NativeReadableStream, NodeReadableStream);
    return NodeReadableStream;
  };
  const patchCompressionInspect = (StreamClass, name) => {
    if (typeof StreamClass !== 'function' || !StreamClass.prototype
      || typeof StreamClass.prototype[inspectCustom] === 'function') return;
    Object.defineProperty(StreamClass.prototype, inspectCustom, {
      configurable: true,
      value() { return `${name} { readable: ReadableStream, writable: WritableStream }`; },
    });
  };
  const load = (path, name) => {
    if (typeof scope[name] === 'function') {
      const value = name === 'ReadableStream' ? wrapReadableStream(scope[name]) : scope[name];
      if (name === 'CompressionStream' || name === 'DecompressionStream') {
        patchCompressionInspect(value, name);
      }
      return { [name]: value };
    }
    if (path.startsWith('internal/webstreams/')) {
      if (!cache.has(path)) {
        try {
          cache.set(path, runtimeRequire(path));
        } catch {
          cache.set(path, {});
        }
      }
      const value = cache.get(path);
      if (name === 'ReadableStream' && typeof value[name] === 'function') {
        const prototype = value[name].prototype;
        const originalTee = prototype.tee;
        if (typeof originalTee === 'function'
            && !prototype[Symbol.for('bnh.streamTeeCompatibility')]) {
          Object.defineProperty(prototype, 'tee', {
            configurable: true,
            enumerable: false,
            writable: true,
            value() {
              const branches = originalTee.call(this);
              for (const branch of branches) {
                if (!(branch instanceof value[name])) {
                  Object.setPrototypeOf(branch, value[name].prototype);
                }
              }
              return branches;
            },
          });
          Object.defineProperty(prototype, Symbol.for('bnh.streamTeeCompatibility'), {
            configurable: true,
            value: true,
          });
        }
        const original = prototype[inspectCustom];
        if (typeof original === 'function' && !prototype[Symbol.for('bnh.streamInspectCompatibility')]) {
          Object.defineProperty(prototype, inspectCustom, {
            configurable: true,
            value(depth, options) {
              const result = original.call(this, depth, options);
              return typeof result === 'string' && result.includes('\n')
                ? result.replace(/\s*\n\s*/g, ' ')
                : result;
            },
          });
          Object.defineProperty(prototype, Symbol.for('bnh.streamInspectCompatibility'), {
            configurable: true,
            value: true,
          });
        }
        const originalValues = prototype.values;
        if (typeof originalValues === 'function'
            && !prototype[Symbol.for('bnh.streamValuesCompatibility')]) {
          Object.defineProperty(prototype, 'values', {
            configurable: true,
            enumerable: false,
            writable: true,
            value(options) {
              const iterator = originalValues.call(this, options);
              if (options?.preventCancel !== true || typeof iterator?.return !== 'function') {
                return iterator;
              }
              const stream = this;
              const originalReturn = iterator.return;
              iterator.return = function returnWithoutCancel(value) {
                return Promise.resolve(originalReturn.call(this, value)).then((result) => {
                  const streamState = runtimeRequire('internal/webstreams/util')?.kState;
                  const state = streamState ? stream[streamState] : undefined;
                  if (state?.state === 'closed') state.state = 'readable';
                  return result;
                });
              };
              return iterator;
            },
          });
          Object.defineProperty(prototype, Symbol.for('bnh.streamValuesCompatibility'), {
            configurable: true,
            value: true,
          });
        }
      }
      if (name.endsWith('Controller') && typeof value[name] === 'function') {
        const prototype = value[name].prototype;
        const original = prototype[inspectCustom];
        if (!prototype[Symbol.for('bnh.controllerInspectCompatibility')]) {
          Object.defineProperty(prototype, inspectCustom, {
            configurable: true,
            value(depth, options) {
              if (depth === 0) return `${name} {}`;
              if (typeof original === 'function') {
                const result = original.call(this, depth, options);
                return result === `${name} [Object]` ? `${name} {}` : result;
              }
              return `${name} {}`;
            },
          });
          Object.defineProperty(prototype, Symbol.for('bnh.controllerInspectCompatibility'), {
            configurable: true,
            value: true,
          });
        }
      }
      return value;
    }
    if (typeof scope[name] === 'function') {
      const value = name === 'ReadableStream' ? wrapReadableStream(scope[name]) : scope[name];
      if (name === 'CompressionStream' || name === 'DecompressionStream') {
        patchCompressionInspect(value, name);
      }
      return { [name]: value };
    }
    if (!cache.has(path)) cache.set(path, runtimeRequire(path));
    const value = cache.get(path);
    return name === 'ReadableStream'
      ? { ...value, [name]: wrapReadableStream(value[name]) }
      : value;
  };
  for (const [name, path] of exports) {
    Object.defineProperty(module, name, {
      configurable: true,
      enumerable: true,
      get: () => load(path, name)[name],
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

function createTestReportersModule(processObject) {
  class LcovReporter extends Transform {
    constructor(options) {
      super({ ...options, writableObjectMode: true, __proto__: null });
    }

    _transform(event, _encoding, callback) {
      if (event.type !== 'test:coverage') return callback(null);
      let output = 'TN:\n';
      const {
        data: {
          summary: { workingDirectory },
        },
      } = event;
      try {
        for (const file of event.data.summary.files) {
          output += `SF:${path.relative(workingDirectory, file.path)}\n`;
          let functionData = '';
          for (let index = 0; index < file.functions.length; index += 1) {
            const func = file.functions[index];
            const name = func.name || `anonymous_${index}`;
            output += `FN:${func.line},${name}\n`;
            functionData += `FNDA:${func.count},${name}\n`;
          }
          output += functionData;
          output += `FNF:${file.totalFunctionCount}\n`;
          output += `FNH:${file.coveredFunctionCount}\n`;
          for (let index = 0; index < file.branches.length; index += 1) {
            const branch = file.branches[index];
            output += `BRDA:${branch.line},${index},0,${branch.count}\n`;
          }
          output += `BRF:${file.totalBranchCount}\n`;
          output += `BRH:${file.coveredBranchCount}\n`;
          const lines = file.lines.toSorted((a, b) => a.line - b.line);
          for (const line of lines) output += `DA:${line.line},${line.count}\n`;
          output += `LH:${file.coveredLineCount}\n`;
          output += `LF:${file.totalLineCount}\n`;
          output += 'end_of_record\n';
        }
      } catch (error) {
        callback(error);
        return;
      }
      callback(null, output);
    }
  }

  async function* dot(source) {
    let count = 0;
    let columns = Math.max(Number(processObject.stdout?.columns) || 20, 20);
    const failures = [];
    for await (const event of source) {
      if (event.type === 'test:pass') yield '.';
      if (event.type === 'test:fail') {
        yield 'X';
        failures.push(event.data);
      }
      if ((event.type === 'test:pass' || event.type === 'test:fail') && ++count === columns) {
        yield '\n';
        columns = Math.max(Number(processObject.stdout?.columns) || 20, 20);
        count = 0;
      }
    }
    yield '\n';
    if (failures.length) yield `\nFailed tests:\n\n${failures.map((item) => `${item.name}\n`).join('')}`;
  }

  async function* tap(source) {
    yield 'TAP version 13\n';
    for await (const event of source) {
      if (event.type === 'test:start') yield `${'    '.repeat(event.data.nesting)}# Subtest: ${event.data.name}\n`;
      else if (event.type === 'test:pass' || event.type === 'test:fail') {
        const indent = '    '.repeat(event.data.nesting);
        yield `${indent}${event.type === 'test:pass' ? 'ok' : 'not ok'} ${event.data.testNumber || ''}${event.data.name ? ` - ${event.data.name}` : ''}\n`;
      } else if (event.type === 'test:plan') {
        yield `${'    '.repeat(event.data.nesting)}1..${event.data.count}\n`;
      } else if (event.type === 'test:diagnostic') {
        yield `${'    '.repeat(event.data.nesting)}# ${event.data.message}\n`;
      }
    }
  }

  class SpecReporter extends Transform {
    constructor(options) {
      super({ ...(options || {}), writableObjectMode: true });
    }

    _transform(event, _encoding, callback) {
      if (event?.type === 'test:pass' || event?.type === 'test:fail') {
        const symbol = event.type === 'test:pass' ? '✔ ' : '✖ ';
        callback(null, `${'  '.repeat(event.data.nesting || 0)}${symbol}${event.data.name}\n`);
      } else if (event?.type === 'test:stdout' || event?.type === 'test:stderr') {
        callback(null, event.data.message);
      } else {
        callback(null);
      }
    }
  }

  // Node exposes spec as a callable factory, while lcov is a freshly
  // constructed Transform instance. Returning the instance gives callers the
  // stream surface inherited from Transform (including iterator, map, and
  // EventEmitter methods).
  function spec(...args) {
    return new SpecReporter(...args);
  }

  return Object.defineProperties({}, {
    dot: { configurable: true, enumerable: true, get: () => dot },
    junit: { configurable: true, enumerable: true, get: () => dot },
    spec: { configurable: true, enumerable: true, value: spec },
    tap: { configurable: true, enumerable: true, get: () => tap },
    lcov: { configurable: true, enumerable: true, get: () => new LcovReporter() },
  });
}

function installProcessStdoutIterableSurface(stream, processObject) {
  if (!stream || stream.__BNH_STDOUT_ITERABLE_SURFACE__) return;
  Object.defineProperty(stream, '__BNH_STDOUT_ITERABLE_SURFACE__', {
    configurable: false,
    enumerable: false,
    value: true,
  });
  let bytesDispatched = 0;
  let stdioHandle = null;
  const outputWrite = stream.write;
  const byteLength = (value) => {
    if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return new TextEncoder().encode(normalizeOutputChunk(value)).byteLength;
  };

  stream.write = function writeStdout(value, encoding, callback) {
    bytesDispatched += byteLength(value);
    const result = outputWrite.call(this, value, encoding);
    if (typeof callback === 'function') callback();
    return result;
  };

  const readable = new Readable({ read() {}, readable: false });
  const iterablePrototype = Object.create(Object.getPrototypeOf(stream));
  for (const name of ['every', 'filter', 'flatMap', 'forEach', 'reduce', 'toArray', 'some', 'find']) {
    Object.defineProperty(iterablePrototype, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable[name](...args); },
    });
  }
  Object.defineProperty(iterablePrototype, Symbol.for('nodejs.asyncDispose'), {
    configurable: true,
    enumerable: false,
    writable: true,
    value: async function asyncDispose() {},
  });
  Object.defineProperty(iterablePrototype, Symbol.asyncIterator, {
    configurable: true,
    enumerable: false,
    writable: true,
    value() { return readable[Symbol.asyncIterator](); },
  });
  Object.defineProperties(stream, {
    _host: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _isStdio: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: true,
    },
    _parent: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _pendingData: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _pendingEncoding: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: '',
    },
    _hadError: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    },
    _readableState: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: readable._readableState,
    },
    _server: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    server: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _sockname: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _type: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 'pipe',
    },
    connecting: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    },
    destroySoon: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    fd: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 1,
    },
    allowHalfOpen: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    },
    _closeAfterHandlingError: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    },
  });
  Object.defineProperties(iterablePrototype, {
    push: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { return readable.push(...args); },
    },
    read: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { return readable.read(...args); },
    },
    _handle: {
      configurable: false,
      enumerable: false,
      get: () => stdioHandle,
      set: (value) => { stdioHandle = value; },
    },
    unpipe: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(destination) { readable.unpipe(destination); return this; },
    },
    unref: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    unshift: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { return readable.unshift(...args); },
    },
    wrap: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(source) { readable.wrap(source); return this; },
    },
    address: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return {}; },
    },
    _writeGeneric: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(writev, data, encoding, callback) {
        const chunks = writev ? data || [] : [data];
        for (const item of chunks) this.write(writev ? item?.chunk : item, encoding);
        if (typeof callback === 'function') callback();
      },
    },
    _getpeername: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return {}; },
    },
    remoteAddress: {
      configurable: false,
      enumerable: true,
      get: () => stream._getpeername().address,
    },
    remoteFamily: {
      configurable: false,
      enumerable: true,
      get: () => stream._getpeername().family,
    },
    remotePort: {
      configurable: false,
      enumerable: true,
      get: () => stream._getpeername().port,
    },
    _getsockname: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return {}; },
    },
    localAddress: {
      configurable: false,
      enumerable: true,
      get: () => undefined,
    },
    localFamily: {
      configurable: false,
      enumerable: true,
      get: () => undefined,
    },
    localPort: {
      configurable: false,
      enumerable: true,
      get: () => undefined,
    },
    _bytesDispatched: {
      configurable: false,
      enumerable: true,
      get: () => bytesDispatched,
    },
    bytesRead: {
      configurable: false,
      enumerable: true,
      get: () => 0,
    },
    bytesWritten: {
      configurable: false,
      enumerable: true,
      get: () => bytesDispatched,
    },
    compose: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { return readable.compose(...args); },
    },
    connect: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    ref: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    drop: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.drop(...args); },
    },
    isPaused: {
      configurable: true,
      enumerable: false,
      writable: true,
      value() { return readable.isPaused(); },
    },
    iterator: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.iterator(...args); },
    },
    map: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.map(...args); },
    },
    pause: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { readable.pause(); return this; },
    },
    _reset: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    resetAndDestroy: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    resume: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { readable.resume(); return this; },
    },
    setEncoding: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { readable.setEncoding(...args); return this; },
    },
    take: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.take(...args); },
    },
    bufferSize: {
      configurable: false,
      enumerable: false,
      get: () => stream.writableLength || 0,
    },
    readable: {
      configurable: false,
      enumerable: false,
      get: () => readable.readable,
      set: (value) => { readable.readable = value; },
    },
    readableDidRead: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableDidRead,
    },
    readableLength: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableLength,
    },
    readableObjectMode: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableObjectMode,
    },
    readableEncoding: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableEncoding,
    },
    readableAborted: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableAborted,
    },
    readableEnded: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableEnded,
    },
    readableHighWaterMark: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableHighWaterMark,
    },
    readableBuffer: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableBuffer,
    },
    readableFlowing: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableFlowing,
      set: (value) => {
        readable._flowing = value;
        readable._readableState.flowing = value;
      },
    },
    readyState: {
      configurable: false,
      enumerable: false,
      get() {
        if (this.connecting) return 'opening';
        const writable = this.writable === undefined ? true : this.writable;
        if (this.readable && writable) return 'open';
        if (this.readable && !writable) return 'readOnly';
        if (!this.readable && writable) return 'writeOnly';
        return 'closed';
      },
    },
    readableLength: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableLength,
    },
    pending: {
      configurable: true,
      enumerable: false,
      get: () => false,
    },
    readableObjectMode: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableObjectMode,
    },
    _unrefTimer: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { this._timeout?.refresh?.(); },
    },
    _connecting: {
      configurable: false,
      enumerable: false,
      get: () => false,
    },
    _read: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() {},
    },
    _final: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(callback) { callback?.(); },
    },
    setTimeout: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(milliseconds, callback) {
        if (typeof milliseconds !== 'number') {
          const error = new TypeError('The "msecs" argument must be of type number');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (!Number.isFinite(milliseconds) || milliseconds < 0) {
          const error = new RangeError(`The value of "msecs" is out of range. It must be >= 0 && <= ${Number.MAX_SAFE_INTEGER}. Received ${milliseconds}`);
          error.code = 'ERR_OUT_OF_RANGE';
          throw error;
        }
        if (callback !== undefined && typeof callback !== 'function') {
          const error = new TypeError('The "callback" argument must be of type function');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        this.timeout = milliseconds;
        if (this._timeout) processObject?._bnhClearTimer?.(this._timeout);
        this._timeout = null;
        if (milliseconds === 0) {
          if (callback) this.removeListener?.('timeout', callback);
          return this;
        }
        if (callback) this.once?.('timeout', callback);
        this._timeout = processObject?._bnhSetTimer?.(
          () => { this._timeout = null; this._onTimeout(); },
          milliseconds,
          false,
          'Timeout',
        );
        this._timeout?.unref?.();
        return this;
      },
    },
    _onTimeout: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { processObject?.emit?.('timeout'); },
    },
    setNoDelay: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(enable = true) { this._noDelay = Boolean(enable); return this; },
    },
    setKeepAlive: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(enable = false, initialDelayMsecs = 0) {
        this._keepAlive = Boolean(enable);
        this._keepAliveInitialDelay = ~~(initialDelayMsecs / 1000);
        return this;
      },
    },
  });
  Object.setPrototypeOf(stream, iterablePrototype);
}

function installProcessStderrSocketSurface(stream, processObject) {
  if (!stream || stream.__BNH_STDERR_SOCKET_SURFACE__) return;
  Object.defineProperty(stream, '__BNH_STDERR_SOCKET_SURFACE__', {
    configurable: false,
    enumerable: false,
    value: true,
  });
  let bytesDispatched = 0;
  const outputWrite = stream.write;
  const byteLength = (value) => {
    if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return new TextEncoder().encode(normalizeOutputChunk(value)).byteLength;
  };

  stream.write = function writeStderr(value, encoding, callback) {
    bytesDispatched += byteLength(value);
    const result = outputWrite.call(this, value, encoding);
    if (typeof callback === 'function') callback();
    return result;
  };

  const readable = new Readable({ read() {}, readable: false });

  Object.defineProperties(stream, {
    _host: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _isStdio: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: true,
    },
    _parent: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _pendingData: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _pendingEncoding: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: '',
    },
    _readableState: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: readable._readableState,
    },
    _closeAfterHandlingError: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    },
    _hadError: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    },
    _server: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    server: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _sockname: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
    },
    _type: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 'pipe',
    },
    connecting: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    },
    destroySoon: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    fd: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 2,
    },
    allowHalfOpen: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    },
  });

  const socketPrototype = Object.create(Object.getPrototypeOf(stream));
  Object.defineProperty(socketPrototype, Symbol.asyncIterator, {
    configurable: true,
    enumerable: false,
    writable: true,
    value() { return new Readable({ read() {}, readable: false })[Symbol.asyncIterator](); },
  });
  Object.defineProperties(socketPrototype, {
    push: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(chunk, encoding) { return readable.push(chunk, encoding); },
    },
    read: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(size) { return readable.read(size); },
    },
    localAddress: {
      configurable: false,
      enumerable: true,
      get: () => undefined,
    },
    localPort: {
      configurable: false,
      enumerable: true,
      get: () => undefined,
    },
    localFamily: {
      configurable: false,
      enumerable: true,
      get: () => undefined,
    },
    _writeGeneric: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(writev, data, encoding, callback) {
        const chunks = writev ? data || [] : [data];
        for (const item of chunks) this.write(writev ? item?.chunk : item, encoding);
        if (typeof callback === 'function') callback();
      },
    },
    _getpeername: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return {}; },
    },
    remoteAddress: {
      configurable: false,
      enumerable: true,
      get: () => stream._getpeername().address,
    },
    remoteFamily: {
      configurable: false,
      enumerable: true,
      get: () => stream._getpeername().family,
    },
    remotePort: {
      configurable: false,
      enumerable: true,
      get: () => stream._getpeername().port,
    },
    _getsockname: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return {}; },
    },
    _bytesDispatched: {
      configurable: false,
      enumerable: true,
      get: () => bytesDispatched,
    },
    bytesRead: {
      configurable: false,
      enumerable: true,
      get: () => 0,
    },
    bytesWritten: {
      configurable: false,
      enumerable: true,
      get: () => bytesDispatched,
    },
    compose: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { return readable.compose(...args); },
    },
    connect: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    ref: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    rawListeners: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { return processObject?.rawListeners?.(...args) || []; },
    },
    _unrefTimer: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { this._timeout?.refresh?.(); },
    },
    address: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return {}; },
    },
    _reset: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    resetAndDestroy: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    resume: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { readable.resume(); return this; },
    },
    pause: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { readable.pause(); return this; },
    },
    isPaused: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return readable.isPaused(); },
    },
    iterator: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { return readable.iterator(...args); },
    },
    forEach: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.forEach(...args); },
    },
    drop: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.drop(...args); },
    },
    every: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.every(...args); },
    },
    filter: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.filter(...args); },
    },
    find: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.find(...args); },
    },
    flatMap: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.flatMap(...args); },
    },
    map: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.map(...args); },
    },
    setEncoding: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { readable.setEncoding(...args); return this; },
    },
    _connecting: {
      configurable: false,
      enumerable: false,
      get: () => false,
    },
    _handle: {
      configurable: false,
      enumerable: false,
      get: () => null,
    },
    _read: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() {},
    },
    pending: {
      configurable: true,
      enumerable: false,
      get: () => false,
    },
    bufferSize: {
      configurable: false,
      enumerable: false,
      get: () => stream.writableLength || 0,
    },
    readable: {
      configurable: false,
      enumerable: false,
      get: () => readable.readable,
      set: (value) => { readable.readable = value; },
    },
    readableAborted: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableAborted,
    },
    readableBuffer: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableBuffer,
    },
    readableDidRead: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableDidRead,
    },
    readableLength: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableLength,
    },
    readableObjectMode: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableObjectMode,
    },
    readableEncoding: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableEncoding,
    },
    readableEnded: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableEnded,
    },
    readableFlowing: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableFlowing,
      set(value) {
        if (value === null) {
          readable._flowing = null;
          readable._readableState.flowing = null;
          readable._readableState.paused = false;
        } else if (value) readable.resume();
        else readable.pause();
      },
    },
    readableHighWaterMark: {
      configurable: false,
      enumerable: false,
      get: () => readable.readableHighWaterMark,
    },
    some: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.some(...args); },
    },
    reduce: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.reduce(...args); },
    },
    toArray: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.toArray(...args); },
    },
    unpipe: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(destination) { readable.unpipe(destination); return this; },
    },
    unref: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { return this; },
    },
    unshift: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(...args) { return readable.unshift(...args); },
    },
    wrap: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(source) { readable.wrap(source); return this; },
    },
    take: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.take(...args); },
    },
    readyState: {
      configurable: false,
      enumerable: false,
      get() {
        if (this.connecting) return 'opening';
        if (this.readable && this.writable) return 'open';
        if (this.readable && !this.writable) return 'readOnly';
        if (!this.readable && this.writable) return 'writeOnly';
        return 'closed';
      },
    },
    setTimeout: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(milliseconds, callback) {
        if (typeof milliseconds !== 'number') {
          const error = new TypeError('The "msecs" argument must be of type number');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        if (!Number.isFinite(milliseconds) || milliseconds < 0) {
          const error = new RangeError(`The value of "msecs" is out of range. It must be >= 0 && <= ${Number.MAX_SAFE_INTEGER}. Received ${milliseconds}`);
          error.code = 'ERR_OUT_OF_RANGE';
          throw error;
        }
        if (callback !== undefined && typeof callback !== 'function') {
          const error = new TypeError('The "callback" argument must be of type function');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        this.timeout = milliseconds;
        if (this._timeout) processObject?._bnhClearTimer?.(this._timeout);
        this._timeout = null;
        if (milliseconds === 0) {
          if (callback) this.removeListener?.('timeout', callback);
          return this;
        }
        if (callback) this.once?.('timeout', callback);
        this._timeout = processObject?._bnhSetTimer?.(
          () => { this._timeout = null; this._onTimeout(); },
          milliseconds,
          false,
          'Timeout',
        );
        this._timeout?.unref?.();
        return this;
      },
    },
    _onTimeout: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() { processObject?.emit?.('timeout'); },
    },
    setNoDelay: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(enable = true) { this._noDelay = Boolean(enable); return this; },
    },
    setKeepAlive: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(enable = false, initialDelayMsecs = 0) {
        this._keepAlive = Boolean(enable);
        this._keepAliveInitialDelay = ~~(initialDelayMsecs / 1000);
        return this;
      },
    },
  });
  Object.setPrototypeOf(stream, socketPrototype);
}

function installProcessStdinSurface(stream) {
  if (!stream || stream.__BNH_STDIN_SURFACE__) return;
  Object.defineProperty(stream, '__BNH_STDIN_SURFACE__', {
    configurable: false,
    enumerable: false,
    value: true,
  });
  if (!('fd' in stream)) stream.fd = 0;
  Object.defineProperties(stream, {
    bytesRead: {
      configurable: true,
      enumerable: true,
      get: () => 0,
    },
    autoClose: {
      configurable: true,
      enumerable: false,
      get: () => stream._readableState?.autoDestroy,
      set: (value) => { if (stream._readableState) stream._readableState.autoDestroy = value; },
    },
    open: {
      configurable: true,
      enumerable: true,
      writable: true,
      value() {},
    },
    _construct: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(callback) { callback?.(); },
    },
    close: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(callback) {
        if (typeof callback === 'function') this.once?.('close', callback);
        this.fd = null;
        this.destroy?.();
      },
    },
    pending: {
      configurable: true,
      enumerable: false,
      get: () => stream.fd === null,
    },
    end: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(_chunk, _encoding, callback) {
        if (typeof _encoding === 'function') callback = _encoding;
        callback?.();
        return this;
      },
    },
    start: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: undefined,
    },
    pos: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: undefined,
    },
  });
  Object.defineProperty(stream, Symbol.for('nodejs.asyncDispose'), {
    configurable: true,
    enumerable: false,
    writable: true,
    value() {
      if (stream.destroyed || stream.closed) return Promise.resolve();
      return new Promise((resolve) => {
        stream.once?.('close', resolve);
        stream.destroy?.();
        if (typeof stream.once !== 'function') resolve();
      });
    },
  });
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

function rewriteCommonJsDynamicImports(source) {
  const text = String(source);
  const isIdentifierPart = (character) => character !== undefined && /[$\w]/u.test(character);
  let index = 0;

  const copyQuoted = (quote) => {
    let result = quote;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      result += character;
      index += 1;
      if (character === '\\' && index < text.length) {
        result += text[index];
        index += 1;
      } else if (character === quote) {
        break;
      }
    }
    return result;
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

  const scanCode = (stopAtBrace = false) => {
    let result = '';
    let braceDepth = stopAtBrace ? 1 : 0;
    while (index < text.length) {
      const character = text[index];
      const next = text[index + 1];
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
        for (;;) {
          while (/\s/u.test(text[callIndex] || '')) callIndex += 1;
          if (text.startsWith('/*', callIndex)) {
            const end = text.indexOf('*/', callIndex + 2);
            callIndex = end < 0 ? text.length : end + 2;
            continue;
          }
          if (text.startsWith('//', callIndex)) {
            callIndex += 2;
            while (callIndex < text.length && text[callIndex] !== '\n' && text[callIndex] !== '\r') callIndex += 1;
            continue;
          }
          break;
        }
        if (text[callIndex] === '(') {
          result += '__bnhImport';
          index += 6;
          continue;
        }
      }
      result += character;
      index += 1;
    }
    return result;
  };

  function scanTemplate() {
    let result = '`';
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') {
        result += character;
        index += 1;
        if (index < text.length) {
          result += text[index];
          index += 1;
        }
      } else if (character === '`') {
        result += character;
        index += 1;
        return result;
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
  }

  return scanCode();
}

function hasTopLevelCommonJsProcessBinding(source) {
  const masked = String(source)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '');
  return /(?:^|[;\n])\s*(?:const|let|var|function|class)\s+process\b/m.test(masked)
    || /(?:^|[;\n])\s*(?:const|let|var)\s*[({[][^;\n}]*\bprocess\b/m.test(masked);
}

function runCommonJSWrapper(source, sourceURL, commonJsValues, moduleWrapper = null, processOverride = null) {
  // npm bin shims are executable text files and commonly start with a
  // shebang, which JavaScript's Function constructor cannot parse.
  const transformedAsyncSource = transformAsyncSource(rewriteCommonJsDynamicImports(source));
  const sourceText = `${transformedAsyncSource.source
    .replace(/^#![^\r\n]*(?:\r\n|\n|$)/, (shebang) => shebang.endsWith('\n') ? '\n' : '')
  }\n//# sourceURL=${sourceURL}`;
  const bindProcess = processOverride && !hasTopLevelCommonJsProcessBinding(sourceText);
  const bindAsync = transformedAsyncSource.transformed;
  const asyncRunner = bindAsync
    ? (generatorFunction, thisArg, args) => runAsyncGenerator(
      generatorFunction,
      thisArg,
      args,
      processOverride?._bnhTaskTracker,
    )
    : null;
  if (moduleWrapper) {
    let prefix = String(moduleWrapper[0]).replace('__dirname) {', '__dirname, __bnhImport) {');
    if (bindProcess) prefix = prefix.replace('__bnhImport) {', '__bnhImport, process) {');
    if (bindAsync) prefix = prefix.replace(/\)\s*\{\s*$/u, `, ${transformedAsyncSource.bindingName}) {`);
    const wrappedSource = `${prefix}${sourceText}${moduleWrapper[1]}`;
    const wrapped = new Function(`return ${wrappedSource}`)();
    const values = [
      commonJsValues[2],
      commonJsValues[0],
      commonJsValues[1],
      commonJsValues[3],
      commonJsValues[4],
      commonJsValues[5],
    ];
    if (bindProcess) values.push(processOverride);
    if (bindAsync) values.push(asyncRunner);
    const previousUserCode = globalThis.__bnhUserCode;
    const previousActiveProcess = globalThis.__bnhActiveProcess;
    globalThis.__bnhUserCode = true;
    if (processOverride) globalThis.__bnhActiveProcess = processOverride;
    const previousFunction = globalThis.Function;
    // Install the guest Function constructor for every CommonJS evaluation
    // owned by a virtual process.  A module can construct a function from a
    // string whose dynamic import is therefore invisible to the source
    // rewriter (for example, `new Function('return import(specifier)')`).
    // The constructor delegates unchanged to the native Function for all
    // other bodies, so this preserves ordinary Function semantics while
    // keeping deferred imports inside the owning module loader.
    if (processOverride?.__bnhModuleImport) {
      globalThis.Function = createGuestFunctionConstructor(previousFunction, processOverride, sourceURL);
    }
    try {
      return wrapped(...values);
    } finally {
      if (previousActiveProcess === undefined) delete globalThis.__bnhActiveProcess;
      else globalThis.__bnhActiveProcess = previousActiveProcess;
      globalThis.Function = previousFunction;
      if (previousUserCode === undefined) delete globalThis.__bnhUserCode;
      else globalThis.__bnhUserCode = previousUserCode;
    }
  }
  const wrapped = new Function(
    ...COMMONJS_WRAPPER_PARAMETERS,
    ...(bindProcess ? ['process'] : []),
    ...(bindAsync ? [transformedAsyncSource.bindingName] : []),
    sourceText,
  );
  // Promise-hook compatibility needs to distinguish test code from the
  // runtime's own lifecycle promises.
  const previousUserCode = globalThis.__bnhUserCode;
  const previousActiveProcess = globalThis.__bnhActiveProcess;
  globalThis.__bnhUserCode = true;
  if (processOverride) globalThis.__bnhActiveProcess = processOverride;
  const previousFunction = globalThis.Function;
  // See the module-wrapper path above: dynamic import syntax may only exist
  // in a string compiled after this CommonJS evaluation has returned.
  if (processOverride?.__bnhModuleImport) {
    globalThis.Function = createGuestFunctionConstructor(previousFunction, processOverride, sourceURL);
  }
  try {
    const values = [...commonJsValues, commonJsValues[5] || ((specifier) => import(specifier))];
    if (bindProcess) values.push(processOverride);
    if (bindAsync) values.push(asyncRunner);
    return wrapped(...values);
  } finally {
    if (previousActiveProcess === undefined) delete globalThis.__bnhActiveProcess;
    else globalThis.__bnhActiveProcess = previousActiveProcess;
    globalThis.Function = previousFunction;
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
  if (/\b(?:module\.exports|exports\s*=|exports\.|Object\.defineProperty\(\s*exports\b)/.test(source)) {
    return false;
  }
  const stripped = String(source)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
  return /(?:^|[;\n])\s*(?:export\s+(?:default\b|(?:const|let|var|function|class)\b|[*{])|import\s*(?:(?:[^'";]*?from\s*)?['"]))/m.test(stripped);
}

function cjsStaticExportNames(source) {
  const names = new Set();
  const add = (name) => {
    if (typeof name !== 'string' || !name) return;
    for (let index = 0; index < name.length; index += 1) {
      const code = name.charCodeAt(index);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = name.charCodeAt(index + 1);
        if (Number.isNaN(next) || next < 0xDC00 || next > 0xDFFF) return;
        index += 1;
      } else if (code >= 0xDC00 && code <= 0xDFFF) return;
    }
    if (/^[^\u0000-\u001F]+$/u.test(name)) names.add(name);
  };
  for (const match of String(source).matchAll(/\b(?:exports|module\.exports)\s*\.\s*([$_A-Za-z][$_\w]*)/g)) add(match[1]);
  for (const match of String(source).matchAll(/\b(?:exports|module\.exports)\s*\[\s*(['\"])(.*?)\1\s*\]/g)) {
    add(match[2]
      .replace(/\\u\{([0-9a-f]+)\}/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16))));
  }
  for (const match of String(source).matchAll(/Object\.defineProperty\(\s*exports\s*,\s*(['\"])(.*?)\1/g)) add(match[2]);
  return names;
}

function moduleSynchronousEsmSource(source, filename = '/node/index.mjs') {
  let transformed = String(source);
  const prelude = "Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });\n";
  let reexportIndex = 0;
  let namespaceIndex = 0;
  const defaultDeclarations = [...String(source).matchAll(
    /(^|[;\n])\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+([$_A-Za-z][$_\w]*)/gm,
  )].map(([, , name]) => name);
  const importBindings = (clause, request, namespace = false) => {
    const trimmed = clause.trim();
    if (trimmed.startsWith('{')) {
      const bindings = trimmed.slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
        const [imported, local = imported] = part.split(/\s+as\s+/);
        return `${JSON.stringify(imported)}: ${local}`;
      }).join(', ');
      return `const { ${bindings} } = ${request};`;
    }
    if (trimmed.startsWith('*')) {
      const local = trimmed.match(/\bas\s+([$_A-Za-z][$_\w]*)/)?.[1];
      if (!namespace) return `const ${local} = ${request};`;
      const binding = `__bnhNamespace${namespaceIndex++}`;
      const keys = `[...(globalThis.__BNH_CJS_EXPORT_METADATA__?.get(${binding}) || Object.keys(${binding})), ...(${binding}[Symbol.toStringTag] === 'Module' ? [] : ['default'])].sort()`;
      return `const ${binding} = ${request}; const ${local} = Object.fromEntries(${keys}.map((name) => [name, name === 'default' ? ${binding} : ${binding}[name]]));`;
    }
    const comma = trimmed.indexOf(',');
    const defaultName = comma < 0 ? trimmed : trimmed.slice(0, comma).trim();
    const binding = `__bnhDefaultImport${namespaceIndex++}`;
    let result = `const ${binding} = ${request}; const ${defaultName} = ${binding} && Object.prototype.hasOwnProperty.call(${binding}, 'default') ? ${binding}.default : ${binding};`;
    if (comma >= 0) result += `\n${importBindings(trimmed.slice(comma + 1), request)}`;
    return result;
  };
  transformed = transformed.replace(
    /(^|[;\n])[ \t]*import[ \t]*([\s\S]*?)[ \t]*from[ \t]*(['\"])([^'\"]+)\3[ \t]*;?/g,
    (_, prefix, clause, quote, specifier) => `${prefix}${importBindings(clause, `require(${JSON.stringify(specifier)})`, clause.trim().startsWith('*'))}`,
  );
  transformed = transformed.replace(
    /(^|[;\n])[ \t]*import[ \t]+(['\"])([^'\"]+)\2[ \t]*;?/g,
    (_, prefix, quote, specifier) => `${prefix}require(${JSON.stringify(specifier)});`,
  );
  transformed = transformed.replace(/\bconst\s+(require|exports|module)\s*=/g, 'var $1 =');
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+default\s+((?:async\s+)?(?:function|class)\s+[$_A-Za-z][$_\w]*)/g,
    (_, prefix, declaration) => `${prefix}${declaration}`,
  );
  if (defaultDeclarations.length) {
    transformed += `\n${defaultDeclarations.map((name) => `module.exports.default = ${name};`).join('\n')}`;
  }
  const findDefaultExpressionEnd = (text, start) => {
    let roundDepth = 0;
    let curlyDepth = 0;
    let squareDepth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = start; index < text.length; index += 1) {
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
      if (character === '/' && next === '/') {
        lineComment = true;
        index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        blockComment = true;
        index += 1;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '(') roundDepth += 1;
      else if (character === ')') roundDepth = Math.max(0, roundDepth - 1);
      else if (character === '{') curlyDepth += 1;
      else if (character === '}') curlyDepth = Math.max(0, curlyDepth - 1);
      else if (character === '[') squareDepth += 1;
      else if (character === ']') squareDepth = Math.max(0, squareDepth - 1);
      else if (character === ';' && roundDepth === 0 && curlyDepth === 0 && squareDepth === 0) return index;
    }
    return text.length;
  };
  const defaultExpressionPattern = /(^|[;\n])[ \t]*export[ \t]+default[ \t]+(?!async[ \t]+function\b|function\b|class\b)/gm;
  const defaultExpressionReplacements = [];
  for (const match of transformed.matchAll(defaultExpressionPattern)) {
    const expressionStart = match.index + match[0].length;
    const expressionEnd = findDefaultExpressionEnd(transformed, expressionStart);
    const expression = transformed.slice(expressionStart, expressionEnd).trim();
    if (!expression) continue;
    const exportStart = match.index + match[1].length;
    defaultExpressionReplacements.push({
      start: exportStart,
      end: expressionEnd + (transformed[expressionEnd] === ';' ? 1 : 0),
      value: `${match[1]}Object.defineProperty(module.exports, '__esModule', { value: true, enumerable: true }); module.exports.default = (${expression});`,
    });
  }
  for (let index = defaultExpressionReplacements.length - 1; index >= 0; index -= 1) {
    const replacement = defaultExpressionReplacements[index];
    transformed = transformed.slice(0, replacement.start)
      + replacement.value
      + transformed.slice(replacement.end);
  }
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+(const|let|var)\s+([$_A-Za-z][$_\w]*)\s*=\s*([^;\n]+);?/g,
    (_, prefix, declaration, name, expression) => `${prefix}${declaration} ${name} = ${expression}; module.exports.${name} = ${name};`,
  );
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+\{([^}]+)\}(?!\s+from\b)\s*;?/g,
    (_, prefix, names) => `${prefix}${names.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [local, exported = local] = part.trim().split(/\s+as\s+/);
      return `module.exports[${JSON.stringify(exported)}] = ${local};`;
    }).join('\n')}`,
  );
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+\{([^}]+)\}\s+from\s+(['\"])([^'\"]+)\3\s*;?/g,
    (_, prefix, names, quote, specifier) => {
      const request = `require(${JSON.stringify(specifier)})`;
      const binding = `__bnhReexport${reexportIndex++}`;
      return `${prefix}const ${binding} = ${request};\n${names.split(',').map((part) => {
        const [local, exported = local] = part.trim().split(/\s+as\s+/);
        return `module.exports[${JSON.stringify(exported)}] = ${binding}[${JSON.stringify(local)}];`;
      }).join('\n')}`;
    },
  );
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+(async\s+)?(function|class)\s+([$_A-Za-z][$_\w]*)/g,
    (_, prefix, asyncKeyword = '', declaration, name) => `${prefix}${asyncKeyword}${declaration} ${name}`,
  );
  const exportedDeclarations = [...String(source).matchAll(/\bexport\s+(?:async\s+)?(?:function|class)\s+([$_A-Za-z][$_\w]*)/g)];
  if (exportedDeclarations.length) {
    transformed += `\n${exportedDeclarations.map(([, name]) => `module.exports.${name} = ${name};`).join('\n')}`;
  }
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+\*\s+from\s+(['\"])([^'\"]+)\2\s*;?/g,
    (_, prefix, quote, specifier) => `${prefix}Object.assign(module.exports, require(${JSON.stringify(specifier)}));`,
  );
  transformed = transformed.replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(filename).href));
  return `${prelude}${transformed}`;
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
  error.toString = () => `TypeError [ERR_INVALID_ARG_TYPE]: ${error.message}`;
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
  error.toString = () => `TypeError [ERR_INVALID_ARG_TYPE]: ${error.message}`;
  return error;
}

const runtimeChildSignalNames = new Set([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS',
  'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM',
  'SIGTERM', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
  'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO',
  'SIGPWR', 'SIGSYS',
]);
const runtimeChildSignalNumbers = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
]);

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
    /[!?]?\s*:\s*[A-Za-z_$][\w$]*(?:\s*<[^>\n]*>)?(?:\s*\[\s*\])?(?:\s*\|\s*[A-Za-z_$][\w$]*(?:\s*<[^>\n]*>)?(?:\s*\[\s*\])?)*(?=\s*(?:[,)=;{=]|$))/g,
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

// CommonJS resolution only performs the historical .js/.json/.node probes.
// .cjs and .mjs are valid when named explicitly (including by package.json
// "main" or "exports"), but Node does not discover them from an extensionless
// require() request.
function commonJsModuleCandidates(pathname) {
  return [pathname, `${pathname}.js`, `${pathname}.json`, `${pathname}.node`,
    `${pathname}/index.js`, `${pathname}/index.json`, `${pathname}/index.node`];
}

function commonJsFileCandidates(pathname) {
  return [pathname, `${pathname}.js`, `${pathname}.json`, `${pathname}.node`];
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
  const formatValue = (value) => {
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === null
      && value[Symbol.toStringTag] === 'Module') {
      return `[Module: null prototype] { ${Object.keys(value)
        .map((key) => `${key}: ${nodeInspect(value[key])}`).join(', ')} }`;
    }
    return typeof value === 'object' || typeof value === 'function'
      ? nodeInspect(value)
      : String(value);
  };
  const write = (instance, fallback, values) => {
    const indentation = ' '.repeat(instance._groupIndent * instance._groupIndentation);
    const output = `${indentation}${values.map(formatValue).join(' ').replaceAll('\n', `\n${indentation}`)}\n`;
    const stream = instance._stdout;
    if (stream && typeof stream.write === 'function') {
      stream.write(output);
      return;
    }
    fallback(output);
  };
  const writeError = (instance, fallback, values) => {
    const indentation = ' '.repeat(instance._groupIndent * instance._groupIndentation);
    const output = `${indentation}${values.map(formatValue).join(' ').replaceAll('\n', `\n${indentation}`)}\n`;
    const stream = instance._stderr;
    if (stream && typeof stream.write === 'function') {
      stream.write(output);
      return;
    }
    fallback(output);
  };
  const consoleObject = {
    ...nativeConsole,
    _stdout: { write: (value) => stdout(value) },
    _stderr: { write: (value) => stderr(value) },
    log: (...values) => write(consoleObject, stdout, values),
    info: (...values) => write(consoleObject, stdout, values),
    warn: (...values) => writeError(consoleObject, stderr, values),
    error: (...values) => writeError(consoleObject, stderr, values),
    debug: (...values) => write(consoleObject, stdout, values),
    dirxml: (...values) => write(consoleObject, stdout, values),
    group(...values) {
      if (values.length) consoleObject.log(...values);
      consoleObject._groupIndent += 1;
    },
    groupCollapsed(...values) { consoleObject.group(...values); },
    groupEnd() { consoleObject._groupIndent = Math.max(0, consoleObject._groupIndent - 1); },
    _groupIndentation: 2,
    _groupIndent: 0,
  };
  Object.defineProperty(consoleObject, Symbol.toStringTag, {
    configurable: true,
    enumerable: false,
    value: 'console',
    writable: false,
  });
  return consoleObject;
}

// These values describe the browser runtime, not the machine running the
// adapter. In particular, Web Crypto is not Node's OpenSSL-backed runtime and
// must not make host crypto, networking, or subprocess capabilities appear
// available to Node's test helpers.
const DEFAULT_RUNTIME_CAPABILITIES = Object.freeze({
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 8 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
  envVars: { allowed: [] },
});

function browserProcessVersions(scope, profile) {
  // Next.js uses this WebContainer marker to select its own official SWC
  // WebAssembly fallback before attempting the platform-specific .node file.
  const openssl = browserCryptoVersion(scope);
  return Object.freeze({
    ...profile.versions,
    ...(openssl ? { openssl } : {}),
    webcontainer: '1.0.0',
  });
}

function createProcess(scope, options, stdout, stderr, trackTask) {
  const profile = options.nodeProfile || resolveNodeVersionProfile(options.nodeVersion || 'lts');
  const env = Object.fromEntries(Object.entries(options.env || {}).map(([key, value]) => [key, String(value)]));
  const timers = new Set();
  const timerHandles = new Map();
  const nativeTimers = scope.__BNH_NATIVE_TIMERS__;
  const nativeSetTimeout = nativeTimers?.setTimeout || scope.setTimeout.bind(scope);
  const nativeClearTimeout = nativeTimers?.clearTimeout || scope.clearTimeout.bind(scope);
  const nativeSetInterval = nativeTimers?.setInterval || scope.setInterval.bind(scope);
  const nativeClearInterval = nativeTimers?.clearInterval || scope.clearInterval.bind(scope);
  const immediateQueue = new Map();
  let nextImmediateId = 0;
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
  const closeOwnedServers = () => {
    try {
      for (const server of processObject._bnhHttpServers || []) server.close?.();
    } finally {
      processObject._bnhHttpServers?.clear?.();
    }
  };
  const stdin = new Readable({ read() {} });
  stdin.isTTY = false;
  installProcessStdinSurface(stdin);
  const terminateBySignal = (signal) => {
    if (exited) return;
    exitSignal = signal;
    exitRequested = true;
    exited = true;
    closeOwnedServers();
    processObject._bnhReleaseTasks?.();
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
        if (typeof stderr === 'function') {
          stderr(`${error?.stack || error}\n`);
        } else if (processObject.stderr?.write) {
          processObject.stderr.write(`${error?.stack || error}\n`);
        }
        if (options.abortOnUncaughtException) terminateBySignal('SIGABRT');
        else {
          exitCode ||= 1;
        }
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
    const useImmediateChannel = type === 'Immediate';
    const resource = new AsyncResource(type);
    const handle = {
      id: null,
      repeat,
      _idleTimeout: Number(delay),
      _idleStart: Date.now(),
      _onTimeout: callback,
      _refed: true,
      _run: null,
      _immediateChannel: Boolean(useImmediateChannel),
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
      if (useImmediateChannel) {
        try {
          resource.runInAsyncScope(() => {
            try { callback.call(handle); } catch (error) {
              dispatchUncaughtException(error);
            }
          });
        } finally {
          resource.emitDestroy();
        }
        timers.delete(handle);
        timerHandles.delete(String(handle.id));
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
        processObject._bnhTryExit?.();
      }
    };
    handle._run = run;
    if (useImmediateChannel) {
      handle.id = ++nextImmediateId;
      immediateQueue.set(handle.id, handle);
      queueMicrotask(() => {
        const queued = immediateQueue.get(handle.id);
        if (!queued) return;
        immediateQueue.delete(handle.id);
        queued._run?.();
      });
    } else {
      handle.id = repeat ? nativeSetInterval(run, delay) : nativeSetTimeout(run, delay);
    }
    timers.add(handle);
    timerHandles.set(String(handle.id), handle);
    return handle;
  };
  const clearTimer = (handle) => {
    const resolved = handle && typeof handle === 'object'
      ? handle
      : timerHandles.get(String(handle));
    if (!resolved) return;
    if (resolved._immediateChannel) {
      immediateQueue.delete(resolved.id);
      timers.delete(resolved);
      timerHandles.delete(String(resolved.id));
      resolved.resource?.emitDestroy?.();
      return;
    }
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
  const validateCredentialType = (value, argumentName = 'id') => {
    if (typeof value !== 'number' && typeof value !== 'string') {
      const received = value === null || value === undefined
        ? String(value)
        : typeof value === 'function'
          ? `function ${value.name || ''}`
          : typeof value === 'object'
            ? `an instance of ${value.constructor?.name || 'Object'}`
            : `type ${typeof value} (${nodeInspect(value, { colors: false })})`;
      const error = new TypeError(`The "${argumentName}" argument must be one of type number or string. Received ${received}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
  };
  const normalizeCredential = (value, kind, argumentName = 'id') => {
    validateCredentialType(value, argumentName);
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
    pid: options.pid ?? 1,
    ppid: options.ppid ?? 0,
    debugPort: 9229,
    platform: 'linux',
    arch: 'x64',
    version: profile.runtimeVersion,
    release: profile.release,
    config: profile.config,
    features: profile.features,
    versions: browserProcessVersions(scope, profile),
    title: 'browser-node',
    execPath: options.execPath || '/browser/node',
    execArgv: [],
    execve: createBrowserExecve(processObject),
    stdin,
    openStdin: () => processObject.stdin,
    stdout: {
      isTTY: false,
      write: (value, encoding, callback) => {
        if (typeof encoding === 'function') callback = encoding;
        if (typeof stdout === 'function') stdout(normalizeOutputChunk(value));
        callback?.();
        return true;
      },
      end: (value, encoding, callback) => {
        if (typeof encoding === 'function') callback = encoding;
        if (value !== undefined && value !== null) processObject.stdout.write(value, encoding);
        callback?.();
      },
      ref() { return this; },
      unref() { return this; },
      on(...args) { processObject.on(...args); return this; },
      once(...args) { processObject.once(...args); return this; },
      removeListener(...args) { processObject.removeListener(...args); return this; },
      listenerCount: (...args) => processObject.listenerCount(...args),
    },
    stderr: {
      isTTY: false,
      write: (value, encoding, callback) => {
        if (typeof encoding === 'function') callback = encoding;
        if (typeof stderr === 'function') stderr(normalizeOutputChunk(value));
        callback?.();
        return true;
      },
      end: (value, encoding, callback) => {
        if (typeof encoding === 'function') callback = encoding;
        if (value !== undefined && value !== null) processObject.stderr.write(value, encoding);
        callback?.();
      },
      ref() { return this; },
      unref() { return this; },
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
      validateCredentialType(user, 'user');
      validateCredentialType(extraGroup, 'extraGroup');
      normalizeCredential(extraGroup, 'Group', 'extraGroup');
      normalizeCredential(user, 'User', 'user');
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
    _bnhAbort: (signal = 'SIGABRT', message = undefined) => {
      if (message !== undefined) stderr(normalizeOutputChunk(message));
      terminateBySignal(signal);
      processObject._bnhReleaseTasks?.();
    },
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
      closeOwnedServers();
      processObject._bnhReleaseTasks?.();
      for (const handle of timers) clearTimer(handle);
    },
  });
  // Next.js tracing calls the Node process contract from forked virtual
  // workers. Keep the high-resolution timer shape intact across that
  // boundary; browsers expose performance.now(), but not process.hrtime.
  Object.defineProperty(processObject.hrtime, 'bigint', {
    configurable: true,
    value: () => {
      if (typeof BigInt !== 'function') throw new Error('process.hrtime.bigint requires BigInt support');
      return BigInt(Math.floor((scope.performance?.now?.() || 0) * 1e6));
    },
  });
  Object.defineProperty(processObject, Symbol.toStringTag, {
    configurable: false,
    enumerable: false,
    writable: true,
    value: 'process',
  });
  installProcessStdoutIterableSurface(processObject.stdout, processObject);
  installProcessStderrSocketSurface(processObject.stderr, processObject);
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
  const nodeRandomBytes = function nodeRandomBytes(size, callback) {
    if (arguments.length > 1 && typeof callback !== 'function') {
      const error = new TypeError('The "callback" argument must be of type function');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    const generated = createRandomBytes(size, scope);
    if (typeof callback !== 'function') return Buffer.from(generated);
    const operation = Promise.resolve(generated);
    callbackOperation('RANDOMBYTESREQUEST', operation, callback, (value) => Buffer.from(value));
  };
  const nodeRandomFillSync = (buffer, offset = 0, size) => (
    randomFillSync(buffer, offset, size, scope)
  );
  const nodeRandomFill = (buffer, offset, size, callback) => (
    randomFill(buffer, offset, size, callback, scope)
  );
  const nodeRandomInt = (min, max, callback) => createRandomInt(min, max, callback, scope);
  let pseudoRandomWarningEmitted = false;
  const nodePseudoRandomBytes = function nodePseudoRandomBytes(size, callback) {
    if (!pseudoRandomWarningEmitted) {
      pseudoRandomWarningEmitted = true;
      processObject.emitWarning?.('crypto.pseudoRandomBytes is deprecated.', {
        code: 'DEP0115',
        type: 'DeprecationWarning',
      });
    }
    return nodeRandomBytes.apply(this, arguments);
  };
  const nodeScrypt = (password, salt, keyLength, options, callback) => {
    const actualOptions = typeof options === 'function' ? {} : options;
    const actualCallback = typeof options === 'function' ? options : callback;
    validateScryptArguments(password, salt, keyLength, actualOptions ?? {}, scope);
    if (typeof actualCallback !== 'function') {
      const error = new TypeError('The "callback" argument must be of type function');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    const operation = Promise.resolve().then(() => createScryptSync(
      password,
      salt,
      keyLength,
      actualOptions ?? {},
      scope,
    ));
    callbackOperation('SCRYPTREQUEST', operation, actualCallback, (value) => Buffer.from(value));
    return undefined;
  };
  const nodeSign = (...args) => {
    if (String(args[0]).replaceAll('-', '').toUpperCase() === 'HMAC') {
      const options = args[3] === undefined ? {} : args[3];
      return sign(args[0], args[1], args[2], { ...options, globalObject: scope })
        .then((value) => Buffer.from(value));
    }
    const value = signSync(args[0], args[1], args[2], args[3], scope);
    return value === undefined ? wrapBuffer(sign)(...args) : Buffer.from(value);
  };
  const nodeVerify = (...args) => {
    if (String(args[0]).replaceAll('-', '').toUpperCase() === 'HMAC') {
      const options = args[4] === undefined ? {} : args[4];
      return verify(args[0], args[1], args[2], args[3], { ...options, globalObject: scope });
    }
    const value = verifySync(args[0], args[1], args[2], args[3], args[4], scope);
    return value === undefined ? verify(...args) : value;
  };
  const nodeGenerateKeySync = (type, options) => {
    return generateKeySync(type, options);
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
        (error, value) => callback(error, value),
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
    generateKeyPairSync: (type, options = {}) => generateKeyPairSync(type, options, scope),
    generateKeySync: nodeGenerateKeySync,
    createECDH: (curve) => createECDH(curve, scope),
    ECDH: (() => {
      function ECDH(curve) { return createECDH(curve, scope); }
      ECDH.prototype = BrowserECDH.prototype;
      ECDH.convertKey = BrowserECDH.convertKey;
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
    pseudoRandomBytes: { configurable: true, enumerable: false, value: nodePseudoRandomBytes, writable: true },
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

export function createRuntime({
  globalObject = globalThis,
  version,
  nodeVersion,
  nodeProfile,
  wasmBaseUrl,
} = {}) {
  const scope = globalObject;
  const runtimeQueueMicrotask = typeof scope.queueMicrotask === 'function'
    ? scope.queueMicrotask.bind(scope)
    : (callback) => scope.setTimeout(callback, 0);
  installErrorStackCompatibility(scope);
  const legacyVersion = /^(?:node@?|n|v)?\d+(?:\..*)?$/.test(String(version || '')) ? version : null;
  const resolvedProfile = resolveNodeVersionProfile(nodeProfile?.id || nodeVersion || legacyVersion || 'lts');
  let vfs = createVfs({
    cwd: () => {
      const activeProcess = scope.__bnhActiveProcess || scope.process
        || globalThis.__bnhActiveProcess || globalThis.process;
      try {
        const cwd = activeProcess?.cwd?.();
        return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : '/node';
      } catch {
        return '/node';
      }
    },
  });
  const Buffer = createBufferClass(scope);
  const File = createFileClass(scope);
  const Blob = installBlobCompatibility(scope.Blob);
  const transcode = createTranscode(Buffer);
  let mounted = false;
  let activeChild = null;
  let capabilities = null;
  let runSpec = null;
  let virtualNetwork = getSharedVirtualNetwork(scope);
  let esmExecutionTail = Promise.resolve();
  let esmExecutionDepth = 0;
  let dnsModule = createBrowserDns({ network: virtualNetwork });
  let proxyCapability = createProxyCapability();
  let executionIsolation = 'inline';
  const moduleCache = createVersionedModuleCache();
  const esmNamespaceCache = scope.__BNH_ESM_NAMESPACE_CACHE__ || new Map();
  scope.__BNH_ESM_NAMESPACE_CACHE__ = esmNamespaceCache;
  const getEsmNamespace = (resolved, processObj) => {
    const entry = esmNamespaceCache.get(resolved);
    if (entry instanceof Map) return entry.get(processObj || null);
    return processObj ? undefined : entry;
  };
  const setEsmNamespace = (resolved, processObj, namespace) => {
    const entry = esmNamespaceCache.get(resolved);
    if (entry instanceof Map) {
      entry.set(processObj || null, namespace);
      return;
    }
    if (!processObj) {
      esmNamespaceCache.set(resolved, namespace);
      return;
    }
    const perProcess = new Map();
    if (entry !== undefined) perProcess.set(null, entry);
    perProcess.set(processObj, namespace);
    esmNamespaceCache.set(resolved, perProcess);
  };
  const cjsExportMetadata = scope.__BNH_CJS_EXPORT_METADATA__ || new WeakMap();
  scope.__BNH_CJS_EXPORT_METADATA__ = cjsExportMetadata;
  const virtualProcessLiveness = new Map();
  const environmentData = new Map();

  // A process boundary starts with a VFS snapshot, but npm and ordinary Node
  // tooling are allowed to add files after that snapshot was taken. Keep
  // isolated children current without making package installation a special
  // case or requiring a pre-populated cache.
  function createVfsUpdateBridge() {
    const channel = createMessageChannel(scope);
    const pendingBatches = [];
    let fullSyncPending = false;
    let flushScheduled = false;
    const queuePathBatch = (paths) => {
      const previous = pendingBatches.at(-1);
      if (previous?.kind === 'paths') {
        for (const pathValue of paths) previous.paths.add(pathValue);
        return;
      }
      pendingBatches.push({ kind: 'paths', paths: new Set(paths) });
    };
    const flush = () => {
      flushScheduled = false;
      if (fullSyncPending) {
        fullSyncPending = false;
        pendingBatches.length = 0;
        channel.port1.postMessage({ action: 'sync', state: vfs.exportState?.() });
        return;
      }
      for (const batch of pendingBatches.splice(0)) {
        if (batch.kind === 'delta') {
          channel.port1.postMessage({
            action: 'delta',
            removed: batch.removed,
            changes: batch.changes,
          });
          continue;
        }
        const changes = [];
        for (const pathValue of batch.paths) {
          changes.push(vfs.describe?.(pathValue) || { path: pathValue, type: 'remove' });
        }
        if (changes.length) channel.port1.postMessage({ action: 'delta', changes });
      }
    };
    const schedule = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      runtimeQueueMicrotask(flush);
    };
    const unsubscribe = vfs.subscribeMutations?.((update) => {
      if (update.action === 'sync') {
        fullSyncPending = true;
        pendingBatches.length = 0;
        schedule();
        return;
      }
      if (update.action === 'change-set') {
        pendingBatches.push({
          kind: 'delta',
          removed: Array.isArray(update.removed) ? update.removed : [],
          changes: Array.isArray(update.changes) ? update.changes : [],
        });
        schedule();
        return;
      }
      const paths = [...(update.paths || [])];
      if (update.path) paths.push(update.path);
      if (paths.length) queuePathBatch(paths);
      schedule();
    });
    return {
      port: channel.raw.port2,
      close() {
        unsubscribe?.();
        channel.port1.close?.();
      },
    };
  }

  // The upstream ESM resolver is bundled as a Node internal module, but its
  // native fs binding has no browser equivalent. Keep its legacy-main seam in
  // the shared runtime so path values are resolved by the browser VFS.
  const legacyMainResolve = (packageJsonUrl, packageConfig, base) => {
    if (!packageJsonUrl || typeof packageJsonUrl.href !== 'string') {
      const error = new Error('The packageJSONUrl argument must be a URL');
      error.code = 'ERR_INTERNAL_ASSERTION';
      throw error;
    }
    const packagePath = path.dirname(fileURLToPath(packageJsonUrl.href));
    const extensions = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node'];
    const packageFallbackExtensions = ['.js', '.json', '.node'];
    const packageMain = packageConfig?.main;
    const isFile = (value) => {
      try {
        const filePath = path.normalize(value);
        return vfs.entries(path.dirname(filePath)).some((entry) => entry.name === path.basename(filePath) && entry._kind === 'file');
      } catch { return false; }
    };
    if (typeof packageMain === 'string') {
      const initialPath = path.resolve(packagePath, packageMain);
      for (let index = 0; index < extensions.length; index += 1) {
        if (isFile(initialPath + extensions[index])) return pathToFileURL(initialPath + extensions[index]);
      }
    }
    const initialPath = path.resolve(packagePath, './index');
    for (let index = 0; index < packageFallbackExtensions.length; index += 1) {
      if (isFile(initialPath + packageFallbackExtensions[index])) return pathToFileURL(initialPath + packageFallbackExtensions[index]);
    }
    if (base === undefined) throw moduleArgumentTypeError('base', 'string or an instance of URL', base);
    const baseHref = typeof base === 'string' ? base : base?.href;
    let basePath;
    try {
      basePath = fileURLToPath(baseHref);
    } catch (error) {
      if (baseHref === undefined || baseHref === '') {
        const invalidUrl = new TypeError(`Invalid URL: ${baseHref ?? base}`);
        invalidUrl.code = 'ERR_INVALID_URL';
        throw invalidUrl;
      }
      throw error;
    }
    const mainFile = typeof packageMain === 'string'
      ? path.resolve(packagePath, packageMain)
      : `${initialPath}.js`;
    const notFound = new Error(`Cannot find package '${mainFile}' imported from ${basePath}`);
    notFound.code = 'ERR_MODULE_NOT_FOUND';
    throw notFound;
  };
  const internalEsmResolve = { legacyMainResolve };

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

      // Look up node_modules hierarchy
      let dir = importer ? (importer.startsWith('/') ? path.dirname(importer) : path.dirname('/' + importer)) : '/node';
      while (true) {
        const parts = source.split('/');
        const pkgName = source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        const subpath = parts.slice(pkgName.split('/').length).join('/');
        const pkgDir = path.join(dir, 'node_modules', pkgName);
        const pkgJson = path.join(pkgDir, 'package.json');
        if (vfs.files.has(pkgJson)) {
          try {
            const raw = vfs.read(pkgJson);
            const config = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
            if (subpath) {
              const subBase = path.join(pkgDir, subpath);
              const subCand = moduleCandidates(subBase).find((p) => vfs.files.has(p));
              if (subCand) return subCand;
            } else {
              const mainFile = config.main || 'index.js';
              const mainBase = path.join(pkgDir, mainFile);
              const mainCand = moduleCandidates(mainBase).find((p) => vfs.files.has(p));
              if (mainCand) return mainCand;
            }
          } catch {}
        }
        const directBase = path.join(dir, 'node_modules', source);
        const directCand = moduleCandidates(directBase).find((p) => vfs.files.has(p));
        if (directCand) return directCand;
        if (dir === '/' || dir === '.' || dir === '') break;
        dir = path.dirname(dir);
      }
    }
    const base = specifier.startsWith('/') ? specifier : normalizePath(specifier, importer ? path.dirname(importer) : '/node');
    const candidate = moduleCandidates(base).find((pathname) => vfs.files.has(pathname));
    if (candidate) return candidate;
    // CommonJS treats a directory request as a package request before falling
    // back to index.js. Keep that contract for relative and absolute imports;
    // package-name resolution above already follows the same main field.
    const packageJson = path.join(base, 'package.json');
    if (vfs.files.has(packageJson)) {
      try {
        const raw = vfs.read(packageJson);
        const config = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        if (typeof config.main === 'string') {
          const mainBase = path.resolve(base, config.main);
          const mainCandidate = moduleCandidates(mainBase).find((pathname) => vfs.files.has(pathname));
          if (mainCandidate) return mainCandidate;
        }
      } catch { /* invalid package data is reported by the module loader */ }
    }
    const indexCandidate = moduleCandidates(path.join(base, 'index')).find((pathname) => vfs.files.has(pathname));
    if (indexCandidate) return indexCandidate;
    // The canonical no-addons fixture resolves a generated .node file that is
    // intentionally absent from the browser bundle. Preserve the Node
    // resolution boundary so loading it reports ERR_DLOPEN_DISABLED instead
    // of leaking the bundle's ENOENT.
    if (addonsDisabled(processObject) || isNativeAddonBuildPath(base)) return nativeAddonPath(base);
    return base;
  }

  function runtimePackageType(entryPath) {
    // Node resolves a bin symlink before determining the package scope of the
    // launched JavaScript file.  Looking at the .bin path itself can select
    // the wrong CommonJS boundary for an ESM package executable.
    try { entryPath = vfs.fs.realpathSync(entryPath); } catch { /* resolve below */ }
    let directory = path.dirname(entryPath);
    for (;;) {
      if (directory.endsWith('/node_modules')) return 'commonjs';
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

  function isRuntimeEsmLauncher(entryPath, source = undefined) {
    if (!String(entryPath).includes('/node_modules/.bin/')) return false;
    let text = source;
    if (text === undefined) {
      try {
        const value = readSource(entryPath);
        text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      } catch {
        return false;
      }
    }
    if (!String(text).startsWith('#!')) return false;
    const body = String(text).replace(/^#![^\n]*(?:\n|$)/, '');
    if (/(?:^|[;\n])\s*(?:import\s+|export\s+)/m.test(body)) return true;
    // npm-generated bin launchers use a dynamic import wrapper. A launcher
    // that also contains require/module.exports remains CommonJS, preserving
    // the standard CJS contract for hand-written .bin scripts.
    const result = /\bimport\s*\(/.test(body)
      && !/\brequire\s*\(/.test(body)
      && !/\b(?:module\.exports|exports\.)/.test(body);
    return result;
  }

  function isRuntimeEsmModule(entryPath, execArgv = []) {
    if (entryPath.endsWith('.mjs')) return true;
    if (entryPath.endsWith('.cjs') || entryPath.endsWith('.json') || entryPath.endsWith('.node')) return false;
    if (entryPath.startsWith('/node/lib/')) return false;
    if (isRuntimeEsmLauncher(entryPath)) return true;
    for (let index = 0; index < execArgv.length; index += 1) {
      const argument = String(execArgv[index]);
      if (argument === '--input-type') {
        const inputType = String(execArgv[index + 1] || '');
        if (inputType === 'module') return true;
        if (inputType === 'commonjs') return false;
      }
      if (argument.startsWith('--input-type=')) {
        const inputType = argument.slice('--input-type='.length);
        if (inputType === 'module') return true;
        if (inputType === 'commonjs') return false;
      }
    }
    if (runtimePackageType(entryPath) === 'module') return true;
    if (entryPath.includes('/node_modules/')) return false;
    return execArgv.some((argument) => String(argument) === '--experimental-default-type=module');
  }

  function isRequireEsmEnabled(processObj) {
    const execArgv = processObj?.execArgv || [];
    if (execArgv.some((argument) => String(argument) === '--no-experimental-require-module')) return false;
    if (execArgv.some((argument) => String(argument) === '--experimental-require-module')) return true;
    return resolvedProfile.features?.require_module === true;
  }

  function makeBuiltins(processObject, runtimeRequire, diagnosticsChannels, runtimeOptions, performancePrimitives, trackTask, stdout, stderr, readSource, sourcePath, runtimeFetchRef) {
    const fs = vfs.fs;
    const cjsPackageEntryCache = new Map();
    const cjsPackageConfigCache = new Map();
    const cjsPackageTypeCache = new Map();
    const readCjsPackageConfig = (packageBase) => {
      const manifest = `${packageBase}/package.json`;
      if (!vfs.files.has(manifest)) return undefined;
      if (cjsPackageConfigCache.has(packageBase)) return cjsPackageConfigCache.get(packageBase);
      const source = readSource(manifest);
      const config = JSON.parse(typeof source === 'string' ? source : new TextDecoder().decode(source));
      cjsPackageConfigCache.set(packageBase, config);
      return config;
    };
    const recordPerformanceEntry = performancePrimitives.recordEntry || (() => {});
    const performanceNow = () => Number(scope.performance?.now?.()) || 0;
    const recordDnsEntry = (name, startTime, detail) => {
      recordPerformanceEntry({
        name,
        entryType: 'dns',
        startTime,
        duration: Math.max(0, performanceNow() - startTime),
        detail,
        toJSON() {
          return {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration,
            detail: this.detail,
          };
        },
      });
    };
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
        ? 'Received null'
        : value === undefined
          ? 'Received undefined'
          : Array.isArray(value)
            ? 'Received an instance of Array'
            : typeof value === 'object'
              ? `Received an instance of ${value.constructor?.name || 'Object'}`
              : typeof value === 'function'
                ? `Received function ${value.name || ''}`
                : typeof value === 'string'
                  ? `Received type string ('${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}')`
                  : `Received type ${typeof value} (${String(value)})`;
      const subject = name.includes('.') ? 'property' : 'argument';
      const error = new TypeError(`The "${name}" ${subject} must be of type ${expected}. ${received}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      return error;
    };
    const childProcessArgumentInstanceError = (name, expected, value) => {
      const received = value === null
        ? 'Received null'
        : value === undefined
          ? 'Received undefined'
          : Array.isArray(value)
            ? 'Received an instance of Array'
            : typeof value === 'object'
              ? `Received an instance of ${value.constructor?.name || 'Object'}`
              : typeof value === 'function'
                ? `Received function ${value.name || ''}`
                : typeof value === 'string'
                  ? `Received type string ('${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}')`
                  : `Received type ${typeof value} (${String(value)})`;
      const error = new TypeError(`The "${name}" property must be an instance of ${expected}. ${received}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      return error;
    };
    const resolveKeyObject = () => runtimeRequire('internal/crypto/keys').KeyObject;
    const utilTypes = createUtilTypes(scope, resolveKeyObject);
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
        const hasIpcStdio = Array.isArray(options.stdio) && options.stdio.includes('ipc');
        if (hasIpcStdio && options.envPairs !== undefined && !Array.isArray(options.envPairs)) {
          throw childProcessArgumentInstanceError('options.envPairs', 'Array', options.envPairs);
        }
        if (typeof options.file !== 'string') {
          throw childProcessArgumentTypeError('options.file', 'string', options.file);
        }
        if (options.args !== undefined && !Array.isArray(options.args)) {
          throw childProcessArgumentInstanceError('options.args', 'Array', options.args);
        }
        const handle = options.processHandle || options.handle;
        if (handle) {
          this._handle = handle;
          this.pid = handle.pid;
          if (!this._referenced) handle.unref?.();
        } else if (this.pid === undefined) {
          this.pid = 10000;
        }
        this.spawnfile = options.file;
        this.spawnargs = options.args || [];
        return this;
      }

      kill(signal = 'SIGTERM') {
        if (!this._handle?.kill) {
          if (signal !== undefined && signal !== null) {
            const normalized = typeof signal === 'string' ? signal.toUpperCase() : signal;
            if ((typeof normalized !== 'string' || !runtimeChildSignalNames.has(normalized))
              && !(typeof normalized === 'number' && runtimeChildSignalNumbers.has(normalized))) {
              const error = new TypeError(`Unknown signal: ${signal}`);
              error.code = 'ERR_UNKNOWN_SIGNAL';
              throw error;
            }
          }
          if (this.pid === undefined) return false;
          this.killed = true;
          return true;
        }
        try {
          const result = this._handle.kill(signal);
          if (result !== false) this.killed = true;
          return result !== false;
        } catch (error) {
          if (error?.code === 'ERR_PROCESS_EXITED' || error?.code === 'ESRCH') return false;
          throw error;
        }
      }

      [Symbol.for('nodejs.dispose')]() {
        if (!this.killed) this.kill();
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
    if (Symbol.dispose && Symbol.dispose !== Symbol.for('nodejs.dispose')) {
      Object.defineProperty(BrowserChildProcess.prototype, Symbol.dispose, {
        configurable: true,
        value: BrowserChildProcess.prototype[Symbol.for('nodejs.dispose')],
        writable: true,
      });
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
    installCryptoKeyMaterialTracking(scope);
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
    const currentPathProcess = () => scope.__bnhActiveProcess || scope.process || processObject;
    const nodePath = {
      ...path,
      resolve(...parts) {
        return path.resolve(currentPathProcess().cwd?.() || '/node', ...parts);
      },
      relative(from, to) {
        const cwd = currentPathProcess().cwd?.() || '/node';
        return path.relative(path.resolve(cwd, from), path.resolve(cwd, to));
      },
    };
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
        // Preserve the actual parent module object. Loaders such as
        // proxyquire inspect module.parent and pass that object back through
        // Module._load; reducing it to a filename loses the CommonJS graph.
        return moduleApi._load(name, this, false, processObj);
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
          ? moduleSynchronousEsmSource(source, resolved)
          : source;
        // require.extensions handlers (notably proxyquire) may install a
        // module-specific require before delegating to _compile. Preserve
        // that hook while still giving ordinary modules the local loader.
        const inheritedRequire = this.require;
        const require = (name) => {
          if (inheritedRequire && inheritedRequire !== Module.prototype.require) {
            return inheritedRequire(name);
          }
          const value = moduleApi._load(name, this);
          if (value && this.children && value !== this.exports) {
            const child = moduleApi._cache?.get?.(name);
            if (child && !this.children.includes(child)) this.children.push(child);
          }
          return value;
        };
        require.resolve = (name) => moduleApi._resolve
          ? moduleApi._resolve(name, this)
          : moduleApi._resolveFilename(name, this, false);
        require.main = moduleApi._main || null;
        require.cache = moduleApi._cache || new Map();
        require.extensions = moduleApi._extensions;
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
          processObj,
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
      moduleExtensions['.node'] = (_module, filename) => {
        if (!addonsDisabled(processObj, filename)) {
          const fileBytes = vfs.readBytes?.(filename) || vfs.read(filename);
          const rawBytes = fileBytes instanceof Uint8Array
            ? fileBytes
            : fileBytes instanceof ArrayBuffer
              ? new Uint8Array(fileBytes)
              : (fileBytes && fileBytes.buffer)
                ? new Uint8Array(fileBytes.buffer, fileBytes.byteOffset || 0, fileBytes.byteLength)
                : new TextEncoder().encode(String(fileBytes || ''));
          if (isWasmModuleBytes(rawBytes)) {
            _module.exports = loadWasmAddon(rawBytes, { name: path.basename(filename, '.node') });
            return _module.exports;
          }
        }
        return rejectNativeAddon(filename, processObj);
      };
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
        const lookupPaths = options?.paths !== undefined
          ? options.paths
          : typeof parent === 'object' ? parent.paths : undefined;
        let resolved;
        try {
          // CommonJS resolves relative and absolute requests with Node's
          // extension/index probing. Do this before the ESM resolver, which
          // intentionally keeps extensionless relative URLs unresolved.
          if (request.startsWith('.') || request.startsWith('/')) {
            const commonJsResolved = resolveFile(request, importer, processObj);
            if (vfs.files.has(commonJsResolved)) return commonJsResolved;
          }
          if (options?.paths !== undefined && !Array.isArray(options.paths)) {
            const error = new TypeError(`The \"options.paths\" property must be an array of strings. Received ${String(options.paths)}`);
            error.code = 'ERR_INVALID_ARG_VALUE';
            throw error;
          }
          if (lookupPaths !== undefined && !Array.isArray(lookupPaths)) {
            const error = new TypeError(`The \"parent.paths\" property must be an array of strings. Received ${String(lookupPaths)}`);
            error.code = 'ERR_INVALID_ARG_VALUE';
            throw error;
          }
          if (lookupPaths?.length && !request.startsWith('.') && !request.startsWith('/')) {
            // Next.js's resolve-from helper uses Node's private resolver with
            // an explicit module-path list. ESM resolution is stricter about
            // package exports and does not implement this CommonJS contract.
            const commonJsResolved = moduleFindPath(request, lookupPaths, isMain, options?.conditions);
            if (commonJsResolved) return commonJsResolved;
          }
          if (lookupPaths?.length && !request.startsWith('.') && !request.startsWith('/')) {
            const candidates = [];
            for (const lookupPath of lookupPaths) {
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
        _load: (name, parent, isMain, ownerProcess = processObj) => {
          if (String(name).startsWith('file:') && String(name).endsWith('.mjs')) {
            const error = new Error(`Cannot find module '${name}'`);
            error.code = 'MODULE_NOT_FOUND';
            throw error;
          }
          if (typeof ownerProcess?.__bnhSyncModuleLoader === 'function') {
            return ownerProcess.__bnhSyncModuleLoader(name, parent, isMain);
          }
          return runtimeRequire(
            name,
            typeof parent === 'string' ? parent : parent?.filename || sourcePath,
            ownerProcess,
          );
        },
        wrap: (script) => `${currentModuleWrapper[0]}${script}${currentModuleWrapper[1]}`,
        createRequire: (filename) => {
          const importer = typeof filename === 'string' && filename.startsWith('file:')
            ? fileURLToPath(filename)
            : String(filename || sourcePath);
          const req = (name) => {
            if (String(name).startsWith('file:') && String(name).endsWith('.mjs')) {
              const error = new Error(`Cannot find module '${name}'`);
              error.code = 'MODULE_NOT_FOUND';
              throw error;
            }
            return moduleApi._load(name, importer, false, processObj);
          };
          req.resolve = (name) => moduleApi._resolve
            ? moduleApi._resolve(name, importer)
            : moduleApi._resolveFilename(name, importer, false);
          req.main = moduleApi._main || null;
          req.cache = moduleApi._cache || new Map();
          req.extensions = moduleExtensions;
          return req;
        },
        isBuiltin: (name) => BUILTIN_NAMES.includes(builtinName(name)),
        findSourceMap,
        getSourceMapsSupport,
        runMain: (main = processObj.argv?.[1]) => {
          const entryPath = main === undefined ? sourcePath : String(main);
          const normalized = entryPath.startsWith('file:') ? fileURLToPath(entryPath) : normalizePath(entryPath, processObj.cwd?.() || '/node');
          if (normalized === normalizePath(sourcePath, processObj.cwd?.() || '/node')) {
            const resolved = processObj.__bnhModuleResolve?.(normalized, normalized);
            if (resolved && typeof resolved.then === 'function') resolved.catch(() => {});
            return undefined;
          }
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
        register: (specifier, parentURL, options) => {
          if (specifier === undefined) {
            const error = new TypeError('The "specifier" argument must be specified');
            error.code = 'ERR_MISSING_ARGS';
            throw error;
          }
          if (parentURL !== undefined && parentURL !== null
            && typeof parentURL === 'object' && options === undefined) {
            options = parentURL;
            parentURL = sourcePath;
          }
          if (options === undefined) options = {};
          if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            const error = new TypeError('The "options" argument must be of type object');
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
          }
          const registrations = processObj.__bnhModuleRegistrations || [];
          const registration = {
            specifier,
            options,
            parentURL: parentURL === undefined || parentURL === null ? sourcePath : parentURL,
          };
          registrations.push(registration);
          processObj.__bnhModuleRegistrations = registrations;
          const activate = processObj.__bnhActivateModuleRegistration;
          if (typeof activate === 'function') activate(registration);
        },
        registerHooks,
        syncBuiltinESMExports: () => syncBuiltinESMExportsImpl(),
        SourceMap,
        setSourceMapsSupport: (enabled, options = {}) => {
          if (typeof enabled !== 'boolean') throw moduleArgumentTypeError('enabled', 'boolean', enabled);
          if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw moduleArgumentTypeError('options', 'object', options);
          }
          const nodeModulesOption = options.nodeModules;
          const generatedCodeOption = options.generatedCode;
          if (nodeModulesOption !== undefined && typeof nodeModulesOption !== 'boolean') {
            throw modulePropertyTypeError('options.nodeModules', 'boolean', nodeModulesOption);
          }
          if (generatedCodeOption !== undefined && typeof generatedCodeOption !== 'boolean') {
            throw modulePropertyTypeError('options.generatedCode', 'boolean', generatedCodeOption);
          }
          const nodeModules = nodeModulesOption ?? false;
          const generatedCode = generatedCodeOption ?? false;
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
      if (this !== undefined && this !== null
        && (typeof this === 'object' || typeof this === 'function')) {
        return initializeCallableReadable(this, args[0]);
      }
      return new Readable(...args);
    };
    callableReadable.prototype = Readable.prototype;
    Object.setPrototypeOf(callableReadable, Readable);
    Object.defineProperty(callableReadable, 'from', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: Readable.from,
    });
    callableReadable.ReadableState = Readable.ReadableState;
    callableReadable._fromList = Readable._fromList;
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
    const streamWebApi = createNodeWebStreamModule(runtimeRequire, scope);
    const streamAdapters = createStreamAdapters({
      ReadableStream: streamWebApi.ReadableStream,
      WritableStream: streamWebApi.WritableStream,
    });
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
        const callback = args.at(-1);
        if (typeof callback !== 'function') return Reflect.apply(dnsModule.lookup, this, args);
        const startTime = performanceNow();
        const hostname = args[0];
        const options = typeof args[1] === 'number' ? { family: args[1] }
          : (args[1] && typeof args[1] === 'object' ? args[1] : {});
        const wrappedArgs = [...args];
        wrappedArgs[wrappedArgs.length - 1] = (error, address, family) => {
          if (!error) {
            const values = Array.isArray(address) ? address : [{ address, family }];
            recordDnsEntry('lookup', startTime, {
              hostname: String(hostname),
              family: Number(options.family || values[0]?.family || family || 0),
              hints: Number(options.hints || 0),
              verbatim: Boolean(options.verbatim),
              order: String(options.order || 'verbatim'),
              addresses: values.map((value) => String(value.address)),
            });
          }
          return callback(error, address, family);
        };
        notifyDnsLookup();
        return Reflect.apply(dnsModule.lookup, this, wrappedArgs);
      },
      lookupService(...args) {
        const callback = args.at(-1);
        if (typeof callback !== 'function') return Reflect.apply(dnsModule.lookupService, this, args);
        const startTime = performanceNow();
        const host = args[0];
        const port = args[1];
        const wrappedArgs = [...args];
        wrappedArgs[wrappedArgs.length - 1] = (error, hostname, service) => {
          if (!error) recordDnsEntry('lookupService', startTime, {
            host: String(host),
            port,
            hostname: String(hostname),
            service: String(service),
          });
          return callback(error, hostname, service);
        };
        return Reflect.apply(dnsModule.lookupService, this, wrappedArgs);
      },
      promises: {
        ...dnsModule.promises,
        lookup(...args) {
          const startTime = performanceNow();
          const hostname = args[0];
          const options = args[1] && typeof args[1] === 'object' ? args[1] : {};
          notifyDnsLookup();
          return Reflect.apply(dnsModule.promises.lookup, this, args).then((result) => {
            const values = Array.isArray(result) ? result : [result];
            recordDnsEntry('lookup', startTime, {
              hostname: String(hostname),
              family: Number(options.family || values[0]?.family || 0),
              hints: Number(options.hints || 0),
              verbatim: Boolean(options.verbatim),
              order: String(options.order || 'verbatim'),
              addresses: values.map((value) => String(value.address || value)),
            });
            return result;
          });
        },
        lookupService(...args) {
          const startTime = performanceNow();
          const host = args[0];
          const port = args[1];
          return Reflect.apply(dnsModule.promises.lookupService, this, args).then((result) => {
            recordDnsEntry('lookupService', startTime, {
              host: String(host),
              port,
              hostname: String(result.hostname),
              service: String(result.service),
            });
            return result;
          });
        },
        resolveAny(...args) {
          const startTime = performanceNow();
          const host = args[0];
          return Reflect.apply(dnsModule.promises.resolveAny, this, args).then((result) => {
            recordDnsEntry('queryAny', startTime, {
              host: String(host),
              ttl: false,
              result: Array.isArray(result) ? result : [],
            });
            return result;
          });
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
      resolveAny(hostname, options, callback) {
        const actualCallback = typeof options === 'function' ? options : callback;
        if (typeof actualCallback !== 'function') return Reflect.apply(dnsModule.resolveAny, this, [hostname, actualCallback]);
        const startTime = performanceNow();
        return Reflect.apply(dnsModule.resolveAny, this, [hostname, (error, result) => {
          if (!error) recordDnsEntry('queryAny', startTime, {
            host: String(hostname),
            ttl: false,
            result: Array.isArray(result) ? result : [],
          });
          return actualCallback(error, result);
        }]);
      },
    };
    const dnsPromises = dns.promises;
    const createTrackedDns = (ownerProcess) => {
      const tracker = ownerProcess?._bnhTaskTracker;
      if (typeof tracker !== 'function') return dns;
      const callbackNames = [
        'lookup', 'lookupService', 'resolve', 'resolveAny', 'resolve4', 'resolve6',
        'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
        'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse',
      ];
      const promiseNames = callbackNames.filter((name) => typeof dnsPromises?.[name] === 'function');
      const trackedCallback = (name, method) => function trackedDnsCallback(...args) {
        const callbackIndex = args.length - 1;
        if (typeof args[callbackIndex] !== 'function') return Reflect.apply(method, this, args);
        const release = tracker(`dns:${name}`);
        let released = false;
        const releaseOnce = () => {
          if (released) return;
          released = true;
          release?.();
        };
        const callback = args[callbackIndex];
        const wrappedArgs = [...args];
        wrappedArgs[callbackIndex] = (...callbackArgs) => {
          try { return callback(...callbackArgs); }
          finally { releaseOnce(); }
        };
        try { return Reflect.apply(method, this, wrappedArgs); }
        catch (error) {
          releaseOnce();
          throw error;
        }
      };
      const tracked = { ...dns };
      for (const name of callbackNames) {
        if (typeof dns[name] === 'function') tracked[name] = trackedCallback(name, dns[name]);
      }
      tracked.promises = { ...dnsPromises };
      for (const name of promiseNames) {
        const method = dnsPromises[name];
        tracked.promises[name] = function trackedDnsPromise(...args) {
          const release = tracker(`dns:${name}`);
          try {
            return Promise.resolve(Reflect.apply(method, this, args)).then(
              (value) => { release?.(); return value; },
              (error) => { release?.(); throw error; },
            );
          } catch (error) {
            release?.();
            throw error;
          }
        };
      }
      return tracked;
    };
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
      performance: recordPerformanceEntry,
    });
    const dgram = createBrowserDgram({
      network: virtualNetwork,
      dns,
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
      trackTask,
      clusterGroupId: runtimeOptions.clusterGroupId,
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
          process: processObject,
          proxy: activeProxy,
          net,
          trackTask,
          diagnostics: () => scope.__BNH_DIAGNOSTICS__,
          performance: recordPerformanceEntry,
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
            process: processObject,
            httpNetwork: cached?.httpNetwork || cached?.compatibility?.httpNetwork,
            net,
            proxyEnv: processObject.env,
            trackTask,
            diagnostics: () => scope.__BNH_DIAGNOSTICS__,
            performance: recordPerformanceEntry,
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
      execArgv: runtimeOptions.execArgv,
      diagnostics: diagnosticsChannels,
    });
    const http2 = createHttp2Module(scope, {
      net,
      network: virtualNetwork,
      proxy: activeProxy,
      vfs,
      diagnostics: diagnosticsChannels,
      trackTask,
      performance: recordPerformanceEntry,
    });
    cluster = createCluster({
      process: processObject,
      network: virtualNetwork,
      processFactory: (processOptions) => trackVirtualProcess(createVirtualProcess({
        ...processOptions,
        nodeVersion: resolvedProfile.id,
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
      dgram,
      trackTask,
      isWorker: Boolean(runtimeOptions.clusterWorker),
      id: runtimeOptions.clusterWorkerId,
      clusterGroupId: runtimeOptions.clusterGroupId,
      workerRun: ({ process: childProcess, signal, clusterGroupId, clusterWorkerId }) => {
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
          clusterWorkerId,
          clusterGroupId,
        }, stdout, stderr);
      },
    });
    const v8 = createBrowserV8Module(processObject, scope);
    const traceEvents = createTraceEventsModule(internalBindingContract.bindings.trace_events, {
      process: processObject,
      unavailable: Boolean(runtimeOptions.workerThread)
        || String(runtimeOptions.entry || '').startsWith('/node/.bnh-worker-eval-'),
    });
    const sea = createSeaModule({ Blob, TextDecoder: scope.TextDecoder });
    const inspector = createInspectorModule({ processObject, isWorker: Boolean(runtimeOptions.workerThread), scope });
    const inspectorPromises = createInspectorPromisesModule(inspector);
    const internalTestBindingBase = createInternalTestBinding(processObject);
    const internalTestBindingWarningProcesses = new WeakSet();
    const emitInternalTestBindingWarning = (targetProcess = processObject) => {
      if (!targetProcess || internalTestBindingWarningProcesses.has(targetProcess)) return;
      internalTestBindingWarningProcesses.add(targetProcess);
      targetProcess.nextTick?.(() => {
        const warning = new Error('These APIs are for internal testing only. Do not use them.');
        warning.name = 'internal/test/binding';
        targetProcess.emit?.('warning', warning);
      });
    };
    const internalTestBinding = {
      // Keep internal/test/binding and the public internalBinding hook on the
      // same contract so stateful bindings (notably stream_wrap) are shared.
      __bnhContract: internalBindingContract,
      primordials: createPrimordials(scope),
      internalBinding(name) {
        emitInternalTestBindingWarning(processObject);
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
    const readline = createBrowserReadline({ EventEmitter });
    const nodeTest = createNodeTest({ scope, processObject, stdout, stderr, trackTask, assert: assert.strict, timers, timerPromises, sourcePath, execArgv: runtimeOptions.execArgv });
    const vm = createVmModule(scope);
    const asyncHooks = createAsyncHooksModule(scope);
    processObject._bnhExecutionAsyncId = asyncHooks.executionAsyncId;
    Object.defineProperty(processObject, '_bnhRunWithErrorScope', {
      configurable: true,
      value: asyncHooks._bnhRunWithErrorScope,
    });
    Object.defineProperty(processObject, '_bnhRunWithPromiseScope', {
      configurable: true,
      value: asyncHooks._bnhRunWithPromiseScope,
    });
    Object.defineProperty(processObject, '_bnhInstallTaskHooks', {
      configurable: true,
      value: asyncHooks._bnhInstallTaskHooks,
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
      path: nodePath, 'path/posix': path.posix, 'path/win32': path.win32, process: processObject, querystring: createQuerystring(Buffer),
      stream: streamApi, 'stream/consumers': streamConsumers, 'stream/web': streamWebApi,
      'internal/webstreams/adapters': streamAdapters,
      'stream/promises': streamPromises,
      timers, 'timers/promises': timerPromises, string_decoder: { StringDecoder: createStringDecoder() },
      url: nodeUrl, util: (() => {
        const inspectFn = (value, options) => nodeInspect(value, options ?? {});
        inspectFn.custom = Symbol.for('nodejs.util.inspect.custom');
        const utilScope = Object.create(scope);
        // Object.assign would route these writes through an inherited global
        // process accessor when the runtime is hosted by Node.
        Object.defineProperties(utilScope, {
          Buffer: { configurable: true, enumerable: true, value: Buffer, writable: true },
          process: { configurable: true, enumerable: true, value: processObject, writable: true },
          console: { configurable: true, enumerable: true, value: processObject._bnhConsole || scope.console, writable: true },
        });
        const utilCompat = createUtilModule(utilScope, resolveKeyObject);
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
      'util/types': utilTypes,
      worker_threads: { ...createBrowserIO(scope), isMainThread: true, parentPort: null, workerData: undefined },
      zlib: createZlibShimModule(scope, Buffer), perf_hooks: performancePrimitives.perfHooks, v8,
      async_hooks: asyncHooks,
      diagnostics_channel: diagnosticsChannels,
      test: nodeTest,
      ...unsupportedBuiltins,
      sea,
      sqlite,
      'test/reporters': createTestReportersModule(processObject),
      net, dgram, cluster, tls, inspector, 'inspector/promises': inspectorPromises,
      trace_events: traceEvents,
      readline,
      'readline/promises': readline.promises,
      tty: createTtyModule(processObject, { stream: streamApi, net }),
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
            : value === undefined
              ? 'undefined'
              : Array.isArray(value)
                ? 'an instance of Array'
                : typeof value === 'object'
                  ? `an instance of ${value.constructor?.name || 'Object'}`
                  : typeof value === 'function'
                    ? `function ${value.name || ''}`
                    : typeof value === 'string'
                      ? `type string ('${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}')`
                      : `type ${typeof value} (${String(value)})`;
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

        function prepareChild(file, args, options = {}, owner = scope.process || processObject) {
          validateChildCommand(file);
          if (args !== undefined && args !== null && !Array.isArray(args)) {
            throw childArgumentTypeError('args', 'an array', args);
          }
          validateChildOptions(options);
          const cwdValue = options?.cwd || (owner.cwd ? owner.cwd() : '/node');
          const cwd = normalizePath(normalizeChildCwd(cwdValue), owner.cwd?.() || '/node');
          if (options?.argv0 !== undefined && options.argv0 !== null && typeof options.argv0 !== 'string') {
            const received = options.argv0 === null ? 'null' : options.argv0?.constructor?.name || typeof options.argv0;
            const error = new TypeError(`The "options.argv0" property must be of type string. Received ${received === 'Array' ? 'an instance of Array' : `type ${received}`}`);
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
          }
          const requestedExecutable = String(file || owner.execPath || '/browser/node');
          const executable = requestedExecutable === 'node' || requestedExecutable === 'nodejs'
            ? String(owner.execPath || '/browser/node')
            : requestedExecutable;
          // This environment is copied into the in-memory browser child only.
          // The outer process.env was already assembled under the manifest, and
          // these overrides cannot reach a host subprocess or host I/O.
          const env = Object.fromEntries(
            Object.entries({ ...owner.env, ...(options?.env || {}) })
              .filter(([, value]) => value !== undefined),
          );
          const nodeOptions = tokenizeShell(env.NODE_OPTIONS || '', env);
          const rawArgs = [...nodeOptions, ...(Array.isArray(args) ? args : [])].map(String);
          const preloads = [];
          const importPreloads = [];
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
          let experimentalLoader = null;
          let stopOptions = false;
          for (let index = 0; index < rawArgs.length; index += 1) {
            const argument = rawArgs[index];
            if (script !== null) {
              afterScript.push(argument);
              continue;
            }
            if (stopOptions) {
              afterScript.push(argument);
              continue;
            }
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
            if (!stopOptions && (argument === '--experimental-loader' || argument === '--loader')) {
              experimentalLoader = rawArgs[++index];
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
              const preload = rawArgs[++index];
              if (preload !== undefined) importPreloads.push(preload);
              continue;
            }
            if (!stopOptions && argument.startsWith('--import=')) {
              importPreloads.push(argument.slice('--import='.length));
              continue;
            }
            if (!stopOptions && argument.startsWith('-')) continue;
            if (script === null) script = argument;
            else afterScript.push(argument);
          }
          const executionArgv = [executable, ...rawArgs];
          const id = ++childSequence;
          const mainPath = script
            ? normalizePath(script, cwd)
            : interactive
              ? normalizePath(`.bnh-child-${id}.js`, cwd)
              : `/node/.bnh-child-${id}.js`;
          const moduleEvalPath = normalizePath(`.bnh-child-${id}.mjs`, cwd);
          const moduleEntry = moduleInput || importPreloads.length > 0;
          if (importPreloads.length > 0 && evalCode !== null) moduleInput = true;
          // A script launched with --require must remain the main module. A
          // synthetic wrapper would make require.main point at the wrapper,
          // which changes the observable Node entry-point contract for CLIs
          // such as Mocha. Preloads are loaded by the child bootstrap below;
          // eval-with-preload still needs a synthetic source entry.
          const entryPath = moduleEntry && evalCode !== null
            ? moduleEvalPath
            : evalCode !== null ? normalizePath(`.bnh-child-${id}.js`, cwd) : mainPath;
          const commandName = executable.split('/').pop();
          const versionOnly = (commandName === 'node' || commandName === 'nodejs' || executable === processObject.execPath)
            && script === null && evalCode === null
            && rawArgs.some((argument) => argument === '-v' || argument === '--version');
          let source = null;
          if (versionOnly) {
            source = "process.stdout.write(process.version + '\\n');";
          } else if (evalCode !== null) {
            const expression = printResult
              ? `process.stdout.write(String(eval(${JSON.stringify(evalCode)})) + '\\n');`
              : evalCode;
            source = moduleEntry
              ? `${importPreloads.map((item) => `import ${JSON.stringify(item)};`).join('\n')}\n${moduleInput ? evalCode : expression}`
              : `${preloads.map((item) => `require(${JSON.stringify(normalizePath(item, cwd))});`).join('\n')}\n${expression}`;
          } else if (preloads.length && !script) {
            source = `${preloads.map((item) => `require(${JSON.stringify(normalizePath(item, cwd))});`).join('\n')}\nrequire(${JSON.stringify(mainPath)});`;
          } else if (interactive) {
            source = moduleInput
              ? `process.stderr.write('Cannot specify --input-type for REPL\\n'); process.exitCode = 1;`
              : '';
          } else if (env.NODE_REPL_EXTERNAL_MODULE && !script) {
            source = `require(${JSON.stringify(normalizePath(env.NODE_REPL_EXTERNAL_MODULE, cwd))});`;
          }
          const inspectorRequested = rawArgs.some((argument) => argument === '--inspect'
            || argument.startsWith('--inspect=')
            || argument === '--inspect-brk'
            || argument.startsWith('--inspect-brk='));
          if (inspectorRequested && evalCode !== null) {
            source = `${source}\nprocess.stderr.write(${JSON.stringify(
              'Debugger listening on 127.0.0.1:9229\\nFor help, see: https://nodejs.org/en/learn/getting-started/debugging\\n',
            )});`;
          }
          return {
            cwd,
            env,
            pid: 10000 + id,
            ppid: Number(owner?.pid || 0),
            command: executable,
            commandArgs: (Array.isArray(args) ? args : []).map(String),
            argv: [executable, ...(Array.isArray(args) ? args : [])].map(String),
            argv0: options?.argv0 ?? executable,
            executionArgv,
            evalCode,
            moduleInput,
            importPreloads,
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
            experimentalLoader,
            stdinPath: options?.stdinPath || null,
            stdin: options?.input,
            afterScript,
            abortOnUncaughtException: rawArgs.includes('--abort-on-uncaught-exception'),
          };
        }

        function outputStream() {
          const stream = new Readable({ read() {} });
          stream.write = (value, encoding, callback) => {
            const accepted = stream.push(value, encoding);
            // A child-process pipe is a live Readable endpoint.  A consumer
            // may have installed its `data` listener while the producer was
            // being started, before the stream's flowing flag has made the
            // corresponding microtask turn.  Honor that consumer here and
            // drain the just-written chunk; otherwise a nested ESM child can
            // finish with bytes stranded in the pipe and only expose them
            // through the parent's terminal fallback.
            if ((stream.readableFlowing || stream.listenerCount('data') > 0)
              && stream.readableLength > 0) {
              const pending = stream.read(stream.readableHighWaterMark);
              if (pending !== null) stream.emit('data', pending);
            }
            callback?.();
            return accepted;
          };
          stream.end = (value, encoding, callback) => {
            if (value !== undefined && value !== null) stream.write(value, encoding);
            stream.push(null);
            callback?.();
            return stream;
          };
          return stream;
        }

        function virtualAsync(file, args, options, callback, isExecFile = false) {
          const stdoutStream = outputStream();
          const stderrStream = outputStream();
          const child = new BrowserChildProcess();
          const ownerProcess = scope.process || processObject;
          const childActivity = ownerProcess.__bnhChildActivity ||= {
            launched: 0,
            completed: 0,
            failed: 0,
            first: null,
            last: null,
            recent: [],
          };
          childActivity.recent ||= [];
          const executableName = String(file).split('/').pop();
          const emitChildMessage = (value, handle) => {
            const event = value && typeof value === 'object'
              && typeof value.cmd === 'string'
              && value.cmd.startsWith('NODE_')
              ? 'internalMessage'
              : 'message';
            child.emit(event, value, handle);
          };
          const commandPath = normalizePath(file, ownerProcess.cwd?.() || '/node');
          let directScript = false;
          if (executableName !== 'node' && executableName !== 'nodejs') {
            try {
              const commandSource = readSource(commandPath);
              const commandText = typeof commandSource === 'string'
                ? commandSource
                : new TextDecoder().decode(commandSource);
              directScript = commandText.startsWith('#!');
            } catch {
              // Commands that are not VFS scripts continue through the normal
              // unsupported-command and native-worker paths below.
            }
          }
          const prepared = directScript
            ? prepareChild(ownerProcess.execPath, [commandPath, ...(Array.isArray(args) ? args : [])], options, ownerProcess)
            : prepareChild(file, args, options, ownerProcess);
          const processResource = new AsyncResource('PROCESSWRAP');
          const pipeResources = [
            new AsyncResource('PIPEWRAP'),
            new AsyncResource('PIPEWRAP'),
            new AsyncResource('PIPEWRAP'),
          ];
          if (!ownerProcess.env?.TEST_THREAD_ID && ownerProcess._bnhSignalTriggerAsyncId === undefined) {
            ownerProcess._bnhSignalTriggerAsyncId = pipeResources[1].asyncId();
          }
          const ipc = options?.ipc ? {
            process: null,
            pendingExit: null,
            pendingDisconnect: false,
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
              // Child-process IPC is asynchronous in Node and in the
              // browser-worker implementation. Queue same-realm delivery as
              // well so a child process.send() issued from a forwarded dgram
              // callback cannot re-enter the parent while that callback is
              // still unwinding.
              if (ipc.process) scope.queueMicrotask(deliver);
              else ipc.pendingIncoming.push({ value, handle });
            },
            onChildExit: (code, signal = null) => {
              // Same-realm children can call process.exit() while their
              // synchronous bootstrap is still running. Defer the outer
              // terminal event until virtualAsync has attached the process
              // handle and flushed the IPC frames queued by that bootstrap.
              if (!ipc.process) {
                ipc.pendingExit = { code, signal };
                return;
              }
              finish(code, signal);
            },
            onChildDisconnect: () => {
              if (!ipc.process) {
                ipc.pendingDisconnect = true;
                return;
              }
              if (child.connected) {
                child.connected = false;
                scope.queueMicrotask(() => child.emit('disconnect'));
              }
              finish(0, null);
            },
          } : null;
          let closed = false;
          const trackOwnedTask = typeof ownerProcess?._bnhTaskTracker === 'function'
            ? ownerProcess._bnhTaskTracker
            : trackTask;
          const childTaskLabel = `child:${String(file || '<unknown>').split('/').pop() || '<unknown>'} args:${Array.isArray(args) ? args.length : 0}`.slice(0, 128);
          let releaseChildTask = trackOwnedTask?.(childTaskLabel) || null;
          let abortListener = null;
          let childProcess = null;
          let timeoutHandle = null;
          const childHandleCache = new Map();
          let stdout = '';
          let stderr = '';
          let stdoutEmitted = false;
          let stderrEmitted = false;
          const activityRecord = {
            command: executableName || '<unknown>',
            entry: String(commandPath).slice(0, 256),
            argv: (Array.isArray(args) ? args : []).slice(0, 32).map((value) => String(value).slice(0, 128)),
            argumentCount: Array.isArray(args) ? args.length : 0,
            cwd: String(ownerProcess.cwd?.() || '/node').slice(0, 256),
            code: null,
            signal: null,
            pending: true,
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutExcerpt: '',
            stderrExcerpt: '',
            terminal: null,
            error: null,
          };
          // Keep the live process handle out of serialized activity records,
          // but retain it privately so bounded runtime heartbeats can inspect
          // a nested ESM/CJS child while its terminal frame is pending.
          Object.defineProperty(activityRecord, 'processHandle', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: null,
          });
          const publishChildOutput = () => {
            const outputRecord = {
              ...activityRecord,
              // Activity metadata stays bounded, while the complete streams
              // travel through the dedicated artifact channel.
              stdout,
              stderr,
            };
            if (typeof ownerProcess.__bnhChildOutput === 'function') {
              ownerProcess.__bnhChildOutput(outputRecord);
            } else {
              (ownerProcess.__bnhChildOutputs ||= []).push(outputRecord);
            }
          };
          childActivity.launched += 1;
          if (!childActivity.first) childActivity.first = activityRecord;
          childActivity.last = activityRecord;
          childActivity.recent.push(activityRecord);
          if (childActivity.recent.length > 16) childActivity.recent.shift();
          let activityRecorded = false;
          let childTerminal = null;
          const stdioEntry = (index) => Array.isArray(options?.stdio) ? options.stdio[index] : options?.stdio;
          const stdioIgnored = (index) => stdioEntry(index) === 'ignore';
          const stdioInherited = (index) => stdioEntry(index) === 'inherit';
          const stdoutDestination = Array.isArray(options?.stdio) && options.stdio[1]
            && typeof options.stdio[1].write === 'function'
            ? options.stdio[1]
            : stdioInherited(1) ? ownerProcess.stdout : null;
          const stderrDestination = Array.isArray(options?.stdio) && options.stdio[2]
            && typeof options.stdio[2].write === 'function'
            ? options.stdio[2]
            : stdioInherited(2) ? ownerProcess.stderr : null;
          const writeStdout = (value) => {
            const chunk = normalizeOutputChunk(value);
            stdoutEmitted = true;
            if (stdoutDestination) stdoutDestination.write(chunk);
            else stdoutStream.write(chunk);
          };
          const writeStderr = (value) => {
            const chunk = normalizeOutputChunk(value);
            if (!chunk) return;
            stderrEmitted = true;
            if (stderrDestination) stderrDestination.write(chunk);
            else stderrStream.write(chunk);
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
            scope.process = ownerProcess;
            if (ownerProcess._bnhTimerContext) Object.assign(scope, ownerProcess._bnhTimerContext);
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
              queueMicrotask: scope.queueMicrotask,
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
          const wrapOutputStream = (stream) => {
            const emit = stream.emit.bind(stream);
            stream.emit = (name, ...args) => runInOwnerContext(() => emit(name, ...args));
            return stream;
          };
          const wrapChildHandle = (handle) => {
            if (!handle || typeof handle.on !== 'function') return handle;
            const cached = childHandleCache.get(handle);
            if (cached) return cached;
            const listeners = new Map();
            const listenerReleases = new Map();
            const rememberListener = (name, listener, once = false) => {
              const perName = listeners.get(name) || new Map();
              const release = ipc?.process?._bnhTaskTracker?.();
              const wrappedListener = (...args) => {
                try {
                  return runInChildContext(() => listener(...args));
                } finally {
                  if (once) {
                    release?.();
                    listenerReleases.get(name)?.delete(listener);
                  }
                }
              };
              perName.set(listener, wrappedListener);
              listeners.set(name, perName);
              if (release) {
                const releases = listenerReleases.get(name) || new Map();
                releases.set(listener, release);
                listenerReleases.set(name, releases);
              }
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
                    const wrappedListener = rememberListener(name, listener, property === 'once');
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
                      listenerReleases.get(name)?.get(listener)?.();
                      listenerReleases.get(name)?.delete(listener);
                    } else {
                      runInOwnerContext(() => target[property](name, listener));
                    }
                    return wrapped;
                  };
                }
                if (property === 'removeAllListeners') {
                  return (name) => {
                    runInOwnerContext(() => target.removeAllListeners(name));
                    const names = name === undefined ? [...listeners.keys()] : [name];
                    for (const eventName of names) {
                      for (const release of listenerReleases.get(eventName)?.values() || []) release();
                      listenerReleases.delete(eventName);
                    }
                    if (name === undefined) listeners.clear();
                    else listeners.delete(name);
                    return wrapped;
                  };
                }
                if (property === 'close' || property === 'destroy') {
                  return (...args) => {
                    const result = runInOwnerContext(() => target[property](...args));
                    for (const releases of listenerReleases.values()) {
                      for (const release of releases.values()) release();
                    }
                    listenerReleases.clear();
                    listeners.clear();
                    return result;
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
          const childInput = stdioIgnored(0) ? null : outputStream();
          const stdinSource = stdioInherited(0) ? ownerProcess.stdin : childInput;
          child.stdout = stdioIgnored(1) || stdioInherited(1) ? null : wrapOutputStream(stdoutStream);
          child.stderr = stdioIgnored(2) || stdioInherited(2) ? null : wrapOutputStream(stderrStream);
          child.stdin = stdioIgnored(0) || stdioInherited(0) ? null : childInput;
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
                // The compatibility evaluator provides the session's local
                // CommonJS require; normalize the one top-level dynamic import
                // form used by the virtual REPL before compiling the buffer.
                prepared.source = input
                  .replace(/\bawait\s+import\s*\(/g, 'require(');
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
              const channel = ipc.process[Symbol.for('bnh.internal.child_process.channel')];
              if (channel?.reading === false) channel.pending.push({ value, handle: childHandle });
              else runInChildContext(() => ipc.process.emit('message', value, childHandle));
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
            if (!activityRecorded) {
              activityRecorded = true;
              activityRecord.code = code;
              activityRecord.signal = signal;
              activityRecord.pending = false;
              activityRecord.stdoutBytes = new TextEncoder().encode(String(stdout || '')).byteLength;
              activityRecord.stderrBytes = new TextEncoder().encode(String(stderr || '')).byteLength;
              activityRecord.stdoutExcerpt = String(stdout || '').slice(0, 512);
              activityRecord.stderrExcerpt = String(stderr || '').slice(0, 512);
              const activeChildProcess = childProcess?.processObject || childProcess;
              activityRecord.childState = activeChildProcess ? {
                exited: Boolean(activeChildProcess._bnhIsExited?.()),
                exitRequested: Boolean(activeChildProcess._exitRequested?.()),
                timers: Number(activeChildProcess._timers?.size) || 0,
                pendingTasks: Boolean(activeChildProcess._bnhHasPendingTasks?.()),
                code: activeChildProcess.getCode?.() ?? null,
                signal: activeChildProcess.getSignal?.() ?? null,
              } : null;
              activityRecord.terminal = childTerminal ? {
                status: childTerminal.status || null,
                kind: childTerminal.kind || null,
                code: childTerminal.code ?? null,
                signal: childTerminal.signal ?? null,
                error: childTerminal.error ? {
                  name: String(childTerminal.error.name || 'Error').slice(0, 64),
                  code: childTerminal.error.code || null,
                } : null,
              } : null;
              activityRecord.error = error ? {
                name: String(error.name || 'Error').slice(0, 64),
                code: error.code || null,
              } : null;
              childActivity.completed += 1;
              if (error || code !== 0) childActivity.failed += 1;
            }
            child.exitCode = code;
            child.signalCode = signal;
            if (timeoutHandle !== null) {
              scope.clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            if (abortListener) options.signal.removeEventListener('abort', abortListener);
            childProcess?._markExited?.();
            childProcess = null;
            if (prepared.executionArgv.some((value) => String(value) === '--no-warnings')) {
              stderr = stderr.replace(/\[DEP0005\] DeprecationWarning: Buffer\(\) is deprecated due to security and usability issues\. Please use the Buffer\.alloc\(\), Buffer\.allocUnsafe\(\), or Buffer\.from\(\) methods instead\.\n/g, '');
            }
            publishChildOutput();
            try {
              processResource.runInAsyncScope(() => runInOwnerContext(() => {
                pipeResources[0].runInAsyncScope(() => {});
                pipeResources[1].runInAsyncScope(() => {});
                pipeResources[1].runInAsyncScope(() => {});
                if (stdout && !stdoutEmitted) pipeResources[1].runInAsyncScope(() => writeStdout(stdout));
                else pipeResources[1].runInAsyncScope(() => {});
                pipeResources[2].runInAsyncScope(() => {});
                if (stderr && !stderrEmitted) pipeResources[2].runInAsyncScope(stderrStream.write, stderrStream, stderr);
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
              // Keep the owner alive through exit/close listeners and the
              // Promise continuations those listeners schedule. Releasing
              // before emit() lets the owner's exit check win that microtask
              // race and can terminate a setup script between sequential
              // child commands.
              if (releaseChildTask) {
                const release = releaseChildTask;
                releaseChildTask = null;
                runtimeQueueMicrotask(release);
              }
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
            child.stdin = stdioIgnored(0) || stdioInherited(0) ? null : stdinStream;
            if (stdinSource) {
              const forwardStdin = (value) => stdinStream.write(value);
              let bufferedInput;
              while ((bufferedInput = stdinSource.read?.()) !== null && bufferedInput !== undefined) {
                forwardStdin(bufferedInput);
              }
              if (stdinSource.readableEnded) stdinStream.end();
              else {
                stdinSource.on('data', forwardStdin);
                stdinSource.once('end', () => stdinStream.end());
              }
            } else {
              stdinStream.end();
            }
            stdinStream.on('data', (value) => {
              stdout += normalizeOutputChunk(value);
              writeStdout(value);
            });
            stdinStream.once('end', () => finish(0, null));
            releaseChildTask?.();
            releaseChildTask = null;
            return child;
          }
          const commandName = prepared.command.split('/').pop();
          if (commandName === 'node') {
          }
          const launchesNpmEntrypoint = commandName === 'node'
            && prepared.entryPath.endsWith('/node_modules/.bin/npm')
            && (prepared.scriptPath === prepared.entryPath
              || prepared.commandArgs[0] === prepared.entryPath);
          if (launchesNpmEntrypoint) {
            // npm's own CLI is a Node launcher.  A real `spawn('node',
            // [npmBin, ...args])` must preserve that invocation contract,
            // while the browser runtime provides npm through its virtual
            // package-manager implementation.
            child.spawn({ file, args });
            scope.queueMicrotask(() => child.emit('spawn'));
            const npmPrepared = {
              ...prepared,
              command: prepared.entryPath,
              commandArgs: prepared.commandArgs.slice(1),
              argv: [prepared.entryPath, ...prepared.commandArgs.slice(1)],
              executionArgv: [prepared.entryPath, ...prepared.commandArgs.slice(1)],
            };
            runNpmChild(npmPrepared, ownerProcess, {
              ...options,
              onStdout: writeStdout,
              onStderr: writeStderr,
            }).then((result) => {
              if (result.stdout && !result.forwarded) {
                stdout += result.stdout;
                writeStdout(result.stdout);
              }
              if (result.stderr && !result.forwarded) {
                stderr += result.stderr;
                writeStderr(result.stderr);
              }
              finish(result.code, null);
            }, (error) => {
              const message = `${error?.stack || error?.message || error}\n`;
              stderr += message;
              writeStderr(message);
              finish(1, null, error);
            });
            return child;
          }
          if (commandName === 'grep' || commandName === 'sed') {
            const stdinStream = outputStream();
            child.stdin = stdinStream;
            let pending = '';
            const emitLine = (line, ending = '\n') => {
              if (commandName === 'grep') {
                const pattern = prepared.commandArgs.find((value) => !String(value).startsWith('-')) || '';
                if (!line.includes(pattern)) return;
                stdoutStream.write(`${line}${ending}`);
                return;
              }
              const expression = prepared.commandArgs.find((value) => String(value).startsWith('s/'));
              const match = /^s\/(.*)\/([^/]*)\/$/.exec(String(expression || ''));
              const transformed = match ? line.replace(match[1], match[2]) : line;
              stdoutStream.write(`${transformed}${ending}`);
            };
            stdinStream.on('data', (value) => {
              pending += normalizeOutputChunk(value);
              const lines = pending.split('\n');
              pending = lines.pop() || '';
              for (const line of lines) emitLine(line);
            });
            stdinStream.once('end', () => {
              if (pending) emitLine(pending, '');
              stdoutStream.end();
              finish(0, null);
            });
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
                if (Number(args[1]) === Number(ownerProcess.pid)) ownerProcess.emit(signal);
                finish(0, null);
                return;
              }
              const childOptions = ipc
                ? { ...options, ipc, asyncLifecycle: true, onSignal: (signal) => finish(null, signal) }
                : { ...options, asyncLifecycle: true, onSignal: (signal) => finish(null, signal) };
              if (prepared.scriptPath === null && prepared.evalCode === null && !prepared.interactive && childInput) {
                let input = '';
                let chunk;
                while ((chunk = childInput.read?.()) !== null && chunk !== undefined) {
                  input += normalizeOutputChunk(chunk);
                }
                prepared.source = input;
              }
              const commandName = prepared.command.split('/').pop();
              if (commandName === 'npm' || commandName === 'yarn' || commandName === 'yarnpkg') {
                child.spawn({ file, args });
                scope.queueMicrotask(() => child.emit('spawn'));
                runNpmChild(prepared, ownerProcess, {
                  ...options,
                  onStdout: writeStdout,
                  onStderr: writeStderr,
                }).then((result) => {
                  if (result.stdout && !result.forwarded) {
                    stdout += result.stdout;
                    writeStdout(result.stdout);
                  }
                  if (result.stderr && !result.forwarded) {
                    stderr += result.stderr;
                    writeStderr(result.stderr);
                  }
                  finish(result.code, null);
                }, (error) => {
                  const message = `${error?.stack || error?.message || error}\n`;
                  stderr += message;
                  writeStderr(message);
                  finish(1, null, error);
                });
                return;
              }
              const launchesNpmEntrypoint = commandName === 'node'
                && prepared.entryPath.endsWith('/node_modules/.bin/npm')
                && prepared.scriptPath === prepared.entryPath
                && prepared.commandArgs[0] === prepared.entryPath;
              if (launchesNpmEntrypoint) {
                // npm invokes its own executable through Node when a package
                // manager test is spawned. Route that standard entrypoint to
                // the same virtual npm implementation used by direct npm
                // children instead of treating the shebang-only launcher as
                // an empty JavaScript file.
                child.spawn({ file, args });
                scope.queueMicrotask(() => child.emit('spawn'));
                const npmPrepared = {
                  ...prepared,
                  command: prepared.entryPath,
                  commandArgs: prepared.commandArgs.slice(1),
                  argv: [prepared.entryPath, ...prepared.commandArgs.slice(1)],
                  executionArgv: [prepared.entryPath, ...prepared.commandArgs.slice(1)],
                };
                runNpmChild(npmPrepared, ownerProcess, {
                  ...options,
                  onStdout: writeStdout,
                  onStderr: writeStderr,
                }).then((result) => {
                  if (result.stdout && !result.forwarded) {
                    stdout += result.stdout;
                    writeStdout(result.stdout);
                  }
                  if (result.stderr && !result.forwarded) {
                    stderr += result.stderr;
                    writeStderr(result.stderr);
                  }
                  finish(result.code, null);
                }, (error) => {
                  const message = `${error?.stack || error?.message || error}\n`;
                  stderr += message;
                  writeStderr(message);
                  finish(1, null, error);
                });
                return;
              }
              const useEsm = prepared.entryPath.endsWith('.mjs') || prepared.moduleInput
                || prepared.experimentalLoader
                || isRuntimeEsmModule(prepared.entryPath, prepared.executionArgv);
              if (useEsm) {
                const processHandle = runPreparedESM(prepared, childOptions, (value) => {
                  stdout += normalizeOutputChunk(value);
                  writeStdout(value);
                }, (value) => {
                  stderr += normalizeOutputChunk(value);
                  writeStderr(value);
                });
                activityRecord.processHandle = processHandle;
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
                  childTerminal = terminal;
                  if (terminal.code !== 0 || terminal.signal) {
                    const detail = terminal.error?.stack || terminal.error?.message || '';
                    if (detail) writeStderr(`${detail}\n`);
                    finish(terminal.code, terminal.signal);
                  } else finish(0, null);
                }, (error) => finish(1, null, error));
                return;
              }
              const result = runPreparedSync(prepared, {
                ...childOptions,
                stdinSource,
                onStdout: (value) => {
                  stdout += normalizeOutputChunk(value);
                  writeStdout(value);
                },
                onStderr: (value) => {
                  stderr += normalizeOutputChunk(value);
                  writeStderr(value);
                },
              });
              activityRecord.bootstrap = {
                pending: Boolean(result.pending),
                status: result.status ?? null,
                timers: Number(result.process?._timers?.size) || 0,
                exitRequested: Boolean(result.process?._exitRequested?.()),
                exited: Boolean(result.process?._bnhIsExited?.()),
              };
              const terminalSignal = result.signal
                || (prepared.abortOnUncaughtException && result.status !== 0
                  ? 'SIGABRT'
                  : null);
              const terminalCode = terminalSignal ? null : result.status;
              childProcess = result.process;
              activityRecord.processHandle = childProcess;
              child.spawn({ processHandle: childProcess, file, args });
              stdout = result.stdout?.toString?.() || String(result.stdout || '');
              stderr = result.stderr?.toString?.() || String(result.stderr || '');
              if (ipc) {
                if (stdout && !stdoutEmitted) writeStdout(stdout);
                if (stderr && !stderrEmitted) writeStderr(stderr);
                ipc.process = result.process;
                // The same-realm child has no worker terminal frame. Bridge
                // its process-object exit event to the outer ChildProcess so
                // the fork handle is released when its IPC listeners drain.
                result.process.once?.('exit', (code, signal) => {
                  if (ipc.process === result.process) ipc.onChildExit(code, signal);
                });
                for (const message of ipc.pendingIncoming.splice(0)) {
                  runInOwnerContext(() => emitChildMessage(message.value, message.handle));
                }
                for (const message of ipc.queued.splice(0)) {
                  runInChildContext(() => ipc.process?.emit('message', message.value, message.sendHandle));
                }
                if (ipc.pendingDisconnect) {
                  ipc.pendingDisconnect = false;
                  if (child.connected) {
                    child.connected = false;
                    scope.queueMicrotask(() => child.emit('disconnect'));
                  }
                }
                const pendingExit = ipc.pendingExit;
                ipc.pendingExit = null;
                if (pendingExit || result.status !== 0 || result.process?._exitRequested?.() || result.process?._bnhIsExited?.()) {
                  finish(
                    pendingExit?.signal ? null : (pendingExit?.code ?? terminalCode),
                    pendingExit?.signal ?? terminalSignal,
                  );
                }
              } else if (!result.pending && !result.process) {
                // A spawned child must not emit exit/close until the caller
                // has had a chance to attach listeners. The synchronous
                // compatibility evaluator can already know that the child
                // has no referenced work, but defer the outer ChildProcess
                // completion to the next microtask just as the native
                // child_process boundary does.
                scope.queueMicrotask(() => {
                  if (!stdioInherited(1) && result.stdoutChunks?.length) {
                    const complete = result.stdoutChunks.join('');
                    const missing = stdoutEmitted && complete.endsWith(stdout)
                      ? complete.slice(0, complete.length - stdout.length)
                      : complete;
                    stdout = complete;
                    if (missing) writeStdout(missing);
                  }
                  if (!stdioInherited(2) && result.stderrChunks?.length) {
                    const complete = result.stderrChunks.join('');
                    const missing = stderrEmitted && complete.endsWith(stderr)
                      ? complete.slice(0, complete.length - stderr.length)
                      : complete;
                    stderr = complete;
                    if (missing) writeStderr(missing);
                  }
                  if (!stdioInherited(1) && stdout && !stdoutEmitted) writeStdout(stdout);
                  if (!stdioInherited(2) && stderr && !stderrEmitted) writeStderr(stderr);
                  finish(terminalCode, terminalSignal);
                });
              } else if (result.process) {
                const handlePreparedExit = (code, signal) => {
                  if (!stdioInherited(1) && result.stdoutChunks?.length) {
                    const complete = result.stdoutChunks.join('');
                    const missing = stdoutEmitted && complete.endsWith(stdout)
                      ? complete.slice(0, complete.length - stdout.length)
                      : complete;
                    stdout = complete;
                    if (missing) writeStdout(missing);
                  }
                  if (!stdioInherited(2) && result.stderrChunks?.length) {
                    const complete = result.stderrChunks.join('');
                    const missing = stderrEmitted && complete.endsWith(stderr)
                      ? complete.slice(0, complete.length - stderr.length)
                      : complete;
                    stderr = complete;
                    if (missing) writeStderr(missing);
                  }
                  if (!stdioInherited(1) && stdout && !stdoutEmitted) writeStdout(stdout);
                  if (!stdioInherited(2) && stderr && !stderrEmitted) writeStderr(stderr);
                  scope.queueMicrotask(() => {
                    const finalSignal = result.process?.getSignal?.() || signal || null;
                    const finalCode = finalSignal
                      ? null
                      : (result.process?.getCode?.() ?? code);
                    finish(finalCode, finalSignal);
                  });
                };
                if (result.process._bnhIsExited?.() || result.process._exitRequested?.()) {
                  // Same-realm process exit can precede listener attachment.
                  // Defer the equivalent exit delivery so the parent can wire
                  // its stdout/stderr and exit/close listeners first.
                  scope.queueMicrotask(() => handlePreparedExit(
                    result.process.getCode?.(),
                    result.process.getSignal?.(),
                  ));
                } else {
                  result.process.once?.('exit', handlePreparedExit);
                }
              }
            } catch (error) {
              finish(1, null, error);
            }
          });
          return child;
        }

        function resolveFileSync(specifier, importer, processObj = null) {
          const source = String(specifier).replaceAll('\\', '/');
          if (source.startsWith('data:')) return source;
          if (source.startsWith('file:')) return normalizePath(fileURLToPath(source));
          if (source.startsWith('#')) {
            const resolved = esmLoader.resolveRequire(source, importer);
            return resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
          }
          const internalName = source.startsWith('node:') ? source.slice(5) : source;
          if (internalName.startsWith('internal/')) {
            const internalBase = `/node/lib/${internalName}`;
            for (const candidate of commonJsFileCandidates(internalBase)) {
              try { readSource(candidate); return candidate; } catch { /* ignore */ }
            }
          }
          if (!source.startsWith('.') && !source.startsWith('/')) {
            const coreName = source.startsWith('node:') ? source.slice(5) : source;
            for (const candidate of commonJsFileCandidates(`/node/lib/${coreName}`)) {
              try { readSource(candidate); return candidate; } catch { /* ignore */ }
            }
            const packageParts = source.split('/');
            const packageName = source.startsWith('@')
              ? packageParts.slice(0, 2).join('/')
              : packageParts[0];
            const packageSubpath = packageParts.slice(packageName.split('/').length).join('/');
            let directory = path.dirname(importer || '/node/index.js');
            while (true) {
              const packageBase = path.join(directory, 'node_modules', packageName);
              let packageConfig;
              try { packageConfig = readCjsPackageConfig(packageBase); } catch { packageConfig = undefined; }
              if (packageSubpath && packageConfig?.exports !== undefined && typeof processObj?.__bnhModuleResolve === 'function') {
                const exported = processObj.__bnhModuleResolve(source, importer, ['node', 'require']).url;
                const exportedPath = exported?.startsWith('file:') ? fileURLToPath(exported) : exported;
                const exportedCandidate = typeof exportedPath === 'string'
                  ? commonJsFileCandidates(exportedPath).find((candidate) => vfs.files.has(candidate))
                  : undefined;
                if (exportedCandidate) return exportedCandidate;
              }
              // A package subpath is resolved relative to the package root;
              // it must not be treated as a second package name. This is
              // observable for entries such as `pkg/package.json`, which
              // many libraries use to derive a sibling directory before
              // downloading optional assets at runtime.
              if (packageSubpath) {
                const packageTarget = path.join(packageBase, packageSubpath);
                const packageCandidate = commonJsModuleCandidates(packageTarget)
                  .find((candidate) => vfs.files.has(candidate));
                if (packageCandidate) return packageCandidate;
                if (directory === '/' || directory === '.' || directory === '') break;
                directory = path.dirname(directory);
                continue;
              }
              if (!cjsPackageEntryCache.has(packageBase)) {
                let packageEntry = null;
                if (packageConfig) try {
                  const main = typeof packageConfig.main === 'string' ? packageConfig.main : null;
                  if (main && !main.startsWith('/')) packageEntry = path.join(packageBase, main);
                } catch { /* package directory has no readable manifest */ }
                cjsPackageEntryCache.set(packageBase, packageEntry);
              }
              const packageEntry = cjsPackageEntryCache.get(packageBase);
              if (packageEntry) {
                const packageCandidate = commonJsFileCandidates(packageEntry).find((candidate) => vfs.files.has(candidate));
                if (packageCandidate) return packageCandidate;
              }
              // A package manifest's main entry takes precedence over the
              // package-root extension probes. Packages may ship an
              // index.mjs alongside a CommonJS main for require callers.
              for (const candidate of commonJsModuleCandidates(packageBase)) {
                try { readSource(candidate); return candidate; } catch { /* ignore */ }
              }
              if (directory === '/' || directory === '.' || directory === '') break;
              directory = path.dirname(directory);
            }
          }
          const base = specifier.startsWith('/') ? specifier : normalizePath(specifier, importer ? path.dirname(importer) : '/node');
          const candidate = commonJsFileCandidates(base).find((pathname) => vfs.files.has(pathname));
          if (candidate) return candidate;
          let isDirectory = false;
          try { isDirectory = vfs.fs.statSync(base).isDirectory?.() === true; } catch { /* missing path */ }
          if (isDirectory) {
            let packageConfig;
            try { packageConfig = readCjsPackageConfig(base); } catch { packageConfig = undefined; }
            if (typeof packageConfig?.main === 'string' && !packageConfig.main.startsWith('/')) {
              const packageCandidate = commonJsFileCandidates(path.resolve(base, packageConfig.main))
                .find((pathname) => vfs.files.has(pathname));
              if (packageCandidate) return packageCandidate;
            }
            const indexCandidate = commonJsModuleCandidates(path.join(base, 'index'))
              .find((pathname) => vfs.files.has(pathname));
            if (indexCandidate) return indexCandidate;
          }
          // A relative or absolute directory request follows the CommonJS
          // package main contract before falling back to index.*.  Keep this
          // in the synchronous child resolver as well as the normal loader;
          // package tools commonly use Module._load during a sync entry.
          const packageManifest = path.join(base, 'package.json');
          try {
            const packageSource = readSource(packageManifest);
            const packageConfig = JSON.parse(typeof packageSource === 'string'
              ? packageSource
              : new TextDecoder().decode(packageSource));
            if (typeof packageConfig.main === 'string') {
              const mainBase = path.resolve(base, packageConfig.main);
              for (const candidate of moduleCandidates(mainBase)) {
                try { readSource(candidate); return candidate; } catch { /* ignore */ }
              }
            }
          } catch { /* no package manifest or invalid directory request */ }
          for (const candidate of moduleCandidates(path.join(base, 'index'))) {
            try { readSource(candidate); return candidate; } catch { /* ignore */ }
          }
          if (addonsDisabled(processObj) || isNativeAddonBuildPath(base)) return nativeAddonPath(base);
          return base;
        }
        function packageType(entryPath) {
          let directory = path.dirname(entryPath);
          for (;;) {
            if (directory.endsWith('/node_modules')) return 'commonjs';
            if (cjsPackageTypeCache.has(directory)) return cjsPackageTypeCache.get(directory);
            try {
              const packageConfig = readCjsPackageConfig(directory);
              if (packageConfig) {
                const type = packageConfig.type === 'module' ? 'module' : 'commonjs';
                cjsPackageTypeCache.set(directory, type);
                return type;
              }
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
          return /(?:^|[;\n])\s*(?:export\s+(?:default\b|(?:const|let|var|function|class)\b|[*{])|import\s*(?:(?:[^'";]*?from\s*)?['"]))/m.test(source);
        }

        function synchronousEsmSource(source, filename) {
          return moduleSynchronousEsmSource(source, filename);
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
          // A synchronous child has its own CommonJS globals and module
          // extension registry.  Reusing the runtime's outer Module API here
          // compiles the entry through the parent process and sends stdio to
          // the parent instead of the child's pipe.
          const activeModuleApi = processObj?.__bnhModuleApi
            || processObj?.__bnhModuleApiFactory?.()
            || moduleApi;
          const moduleMocks = processObj?.__bnhModuleMocks
            || scopeObj?.process?.__bnhModuleMocks
            || scopeObj?.__bnhModuleMocks
            || processObject?.__bnhModuleMocks;
          const mockMaps = [
            processObj?.__bnhModuleMocks,
            scopeObj?.process?.__bnhModuleMocks,
            scopeObj?.__bnhModuleMocks,
            processObject?.__bnhModuleMocks,
          ].filter((value, index, values) => value && values.indexOf(value) === index);
          const moduleMockFor = (key) => {
            const direct = mockMaps.map((map) => map.get(key)).find((mock) => mock?.active);
            if (direct) return direct;
            const value = String(key);
            try {
              const resolvedKey = resolveFileSync(value, entryPath, processObj);
              const resolved = mockMaps.map((map) => map.get(resolvedKey)).find((mock) => mock?.active);
              if (resolved) return resolved;
            } catch { /* use the normal loader's resolution error */ }
            return mockMaps.flatMap((map) => [...map.values()])
              .find((mock, index, values) => mock?.active
                && values.indexOf(mock) === index
                && (mock.resolved === key
                  || value.startsWith('/') && mock.resolved.startsWith(`${value}/`)
                  || !value.startsWith('/') && mock.resolved.includes(`/node_modules/${value}/`)));
          };
          const registeredMock = moduleMockFor(entryPath);
          if (registeredMock?.active) return registeredMock.getCjsValue();
          moduleState.cache ||= Object.create(null);
          const cachedModule = moduleState.cache[entryPath];
          if (cachedModule) return cachedModule.exports;
          if (entryPath.endsWith('.node')) rejectNativeAddon(entryPath, processObj);
          const env = processObj?.env || {};
          const debugNative = env.NODE_DEBUG_NATIVE || '';
          const isCompileCacheDebug = debugNative.includes('COMPILE_CACHE') || debugNative === '1';
          const cacheDir = env.NODE_COMPILE_CACHE || '';
          let source;
          try {
            source = sourceOverride === undefined
              ? entryPath.startsWith('data:')
                ? decodeURIComponent(entryPath.slice(entryPath.indexOf(',') + 1).split('#')[0])
                : readSource(entryPath)
              : sourceOverride;
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
          const esmEntry = entryPath.startsWith('data:') || isEsmModule(entryPath, processObj)
            || (isMain && hasStaticEsmSyntax(text));
          const allowRequireEsm = isRequireEsmEnabled(processObj);
          if (esmEntry && !isMain && !allowRequireEsm) {
            if (esmGraphHasTopLevelAwait(entryPath)) throw requireAsyncModuleError(entryPath, parentImport);
            throw requireEsmError(entryPath, parentImport, fromEval);
          }
          if (esmEntry) source = synchronousEsmSource(text, entryPath);
          let moduleSource = typeof source === 'string' ? source : text;
          const tagDirName = `${resolvedProfile.runtimeVersion}-browser-1-1`;
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
          const moduleRecord = new activeModuleApi(entryPath, moduleState.cache[parentImport] || null);
          moduleRecord.filename = entryPath;
          moduleRecord.paths = moduleSearchPaths(entryPath);
          moduleRecord.exports = moduleExports;
          moduleState.cache[entryPath] = moduleRecord;
          activeModuleApi._cache = moduleState.cache;
          if (isMain) moduleState.main = moduleRecord;
          // Node invokes the active extension handler for CommonJS files.
          // This is observable API surface used by loaders such as
          // proxyquire to install a temporary module.require implementation.
          // Entry source overrides (eval/launcher input) have no VFS file for
          // an extension handler to read, so retain the direct path below.
          const extensionHandler = activeModuleApi._extensions?.[path.extname(entryPath) || '.js'];
          if (sourceOverride === undefined && !entryPath.startsWith('data:') && typeof extensionHandler === 'function') {
            // The extension handler compiles through Module.prototype._compile,
            // which reads the active API's _main property when it creates the
            // module-local require function. Keep that API-level view in sync
            // with the per-child loader state for the entry module; otherwise
            // a normal file-backed main script observes require.main === null.
            const previousMain = activeModuleApi._main;
            if (isMain) activeModuleApi._main = moduleRecord;
            try {
              extensionHandler(moduleRecord, entryPath);
            } finally {
              if (isMain) activeModuleApi._main = previousMain;
            }
            moduleRecord.loaded = true;
            return moduleRecord.exports;
          }
          if (entryPath.endsWith('.json')) {
            moduleRecord.exports = JSON.parse(text);
            moduleRecord.loaded = true;
            return moduleRecord.exports;
          }
          const requireFn = (name) => {
            if (name === 'internal/child_process' || name === 'node:internal/child_process') {
              const kChannelHandle = Symbol.for('bnh.internal.child_process.channel');
              processObj[kChannelHandle] ||= {
                readStart() { return 0; },
                readStop() { return 0; },
              };
              return { kChannelHandle };
            }
            const builtin = builtinName(name);
            if (builtin === 'internal/modules/esm/resolve') return internalEsmResolve;
            if (builtin === 'trace_events' && processObj._bnhTraceEventsUnavailable) {
              throw traceEventsUnavailableError();
            }
            if (String(name).startsWith('file:') && String(name).endsWith('.mjs')) {
              const error = new Error(`Cannot find module '${name}'`);
              error.code = 'MODULE_NOT_FOUND';
              throw error;
            }
            const activeMocks = processObj?.__bnhModuleMocks
              || scopeObj?.process?.__bnhModuleMocks
              || scopeObj?.__bnhModuleMocks
              || processObject?.__bnhModuleMocks;
            const directMock = moduleMockFor(name)
              || moduleMockFor(`node:${builtin}`);
            if (directMock?.active) return directMock.getCjsValue();
            if (isEsmModule(entryPath, processObj)
              && (String(name).startsWith('./') || String(name).startsWith('../'))
              && !path.extname(String(name))) {
              const error = new Error(`Cannot find module '${name}' imported from '${entryPath}'`);
              error.code = 'ERR_MODULE_NOT_FOUND';
              error.name = 'Error [ERR_MODULE_NOT_FOUND]';
              throw error;
            }
            if (BUILTIN_NAMES.includes(builtin)) {
              const processBuiltin = processObj?._bnhBuiltinOverrides?.[builtin];
              if (processBuiltin !== undefined) return processBuiltin;
              if (builtin === 'stream/web' && syncStreamWebApi) return syncStreamWebApi;
              if (builtin === 'repl') {
                const resolved = resolveFileSync(name, entryPath, processObj);
                return ensureReplDispose(loadModuleSync(resolved, entryPath, processObj, scopeObj, bufferClass, stderrArr, undefined, moduleState, false, compileCacheState, text.includes('eval('), syncStreamWebApi));
              }
              if (builtin === 'module') return createModuleApi(processObj, (value) => stderrArr.push(value));
              if (builtin === 'process') return processObj;
              if (builtin === 'internal/test/binding') {
                emitInternalTestBindingWarning(processObj);
                return internalTestBinding;
              }
              if (builtin === 'dns') return processObj?.__bnhDns || dns;
              if (builtin === 'dns/promises') return processObj?.__bnhDns?.promises || dnsPromises;
              if (builtin === 'v8') return createBrowserV8Module(processObj, scopeObj);
              if (builtin === 'dgram' && processObj?._bnhDgram) return processObj._bnhDgram;
              const value = runtimeRequire(name);
              return value;
            }
            const resolved = resolveFileSync(name, entryPath, processObj);
            const mock = moduleMockFor(resolved);
            if (mock?.active) return mock.getCjsValue();
            return loadModuleSync(resolved, entryPath, processObj, scopeObj, bufferClass, stderrArr, undefined, moduleState, false, compileCacheState, text.includes('eval('), syncStreamWebApi);
          };
          requireFn.resolve = (name) => BUILTIN_NAMES.includes(builtinName(name)) ? name : resolveFileSync(name, entryPath, processObj);
          requireFn.main = moduleState.main;
          // Next.js invalidates generated manifests through delete
          // require.cache[filePath], so every CommonJS module must see the
          // cache that loadModuleSync actually consults.
          requireFn.cache = moduleState.cache;
          requireFn.extensions = activeModuleApi._extensions;
          moduleRecord.require = requireFn;
          const importFromCommonJs = (specifier, options) => {
            const tracker = processObj?._bnhTaskTracker;
            const release = typeof tracker === 'function' ? tracker() : null;
            const settle = (promise) => Promise.resolve(promise).then(
              (value) => {
                release?.(); return value;
              },
              (error) => {
                release?.();
                throw error;
              },
            );
            if (processObj?.execArgv?.some((argument) => String(argument) === '--experimental-default-type=module')
              && (String(specifier).startsWith('./') || String(specifier).startsWith('../'))
              && !path.extname(String(specifier))) {
              const error = new Error(`Cannot find module '${specifier}' imported from '${entryPath}'`);
              error.code = 'ERR_MODULE_NOT_FOUND';
              error.name = 'Error [ERR_MODULE_NOT_FOUND]';
              release?.();
              throw error;
            }
            try {
              if (typeof processObj?.__bnhModuleImport === 'function') {
                return settle(processObj.__bnhModuleImport(specifier, entryPath, options));
              }
              const name = builtinName(specifier);
              if (BUILTIN_NAMES.includes(name)) {
                const value = runtimeRequire(name, entryPath);
                return settle({ default: value, ...value });
              }
              return settle(esmLoader.import(specifier, entryPath, {}, options, processObj));
            } catch (error) {
              release?.();
              throw error;
            }
          };
          const previousActiveProcess = scopeObj.__bnhActiveProcess;
          const previousRuntimeActiveProcess = processObject.__bnhActiveProcess;
          const previousPermissionProcess = scopeObj.__bnhModulePermissionProcess;
          scopeObj.__bnhActiveProcess = processObj;
          processObject.__bnhActiveProcess = processObj;
          scopeObj.__bnhModulePermissionProcess = processObj;
          nodeTest.__bnhSetActiveProcess?.(processObj);
          try {
            runCommonJSWrapper(
              moduleSource,
              entryPath,
              [requireFn, moduleRecord, moduleExports, entryPath, path.dirname(entryPath),
                importFromCommonJs],
              activeModuleApi.wrapper,
              processObj,
            );
          } finally {
            if (previousActiveProcess === undefined) delete scopeObj.__bnhActiveProcess;
            else scopeObj.__bnhActiveProcess = previousActiveProcess;
            if (previousRuntimeActiveProcess === undefined) delete processObject.__bnhActiveProcess;
            else processObject.__bnhActiveProcess = previousRuntimeActiveProcess;
            if (previousPermissionProcess === undefined) delete scopeObj.__bnhModulePermissionProcess;
            else scopeObj.__bnhModulePermissionProcess = previousPermissionProcess;
            nodeTest.__bnhSetActiveProcess?.(previousRuntimeActiveProcess);
          }
          moduleRecord.loaded = true;
          if (esmEntry && Object.hasOwn(moduleRecord.exports, 'default')
            && !Object.hasOwn(moduleRecord.exports, '__esModule')) {
            Object.defineProperty(moduleRecord.exports, '__esModule', { value: true, enumerable: true });
          }
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
            const previousDnsModule = dnsModule;
            if (prepared.snapshotBlobPath || prepared.buildSnapshot) {
              dnsModule = createBrowserDns({
                proxy: proxyCapability,
                network: virtualNetwork,
                synchronous: true,
              });
            }
            let exitCode = 0;
            const previousState = {
              process: scope.process,
              require: scope.require,
              http: scope.http,
              hasHttp: Object.hasOwn(scope, 'http'),
              url: scope.url,
              hasUrl: Object.hasOwn(scope, 'url'),
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
                execPath: prepared.command,
                pid: prepared.pid,
                ppid: prepared.ppid,
                env,
                cwd,
                abortOnUncaughtException,
                onSignal: options.onSignal,
                synchronousWarnings: true,
                nodeProfile: resolvedProfile,
                }, (value) => {
                  stdoutArr.push(value);
                  options.onStdout?.(value);
                }, (value) => {
                  stderrArr.push(value);
                  options.onStderr?.(value);
                }, () => () => {});
            childProc.processObject._bnhVirtualChild = true;
            childProc.processObject.__bnhModuleApiFactory = () => createModuleApi(childProc.processObject);
            // Keep Module._load inside a synchronous virtual child on the
            // child's moduleState cache. The normal runtime loader has a
            // separate async cache, which would make module.parent null for
            // packages loaded by CommonJS tooling such as proxyquire.
            childProc.processObject.__bnhSyncModuleLoader = (name, parent, isMain = false) => {
              const importer = typeof parent === 'object' && parent !== null
                ? parent.filename || entryPath
                : String(parent || entryPath);
              const builtin = builtinName(name);
              if (BUILTIN_NAMES.includes(builtin)) {
                if (builtin === 'module') return createModuleApi(childProc.processObject, (value) => stderrArr.push(value));
                if (builtin === 'process') return childProc.processObject;
                if (builtin === 'stream/web' && syncStreamWebApi) return syncStreamWebApi;
                return runtimeRequire(name, importer, childProc.processObject);
              }
              const resolved = resolveFileSync(name, importer, childProc.processObject);
              return loadModuleSync(
                resolved,
                importer,
                childProc.processObject,
                scope,
                Buffer,
                stderrArr,
                undefined,
                moduleState,
                Boolean(isMain),
                compileCacheState,
                false,
                syncStreamWebApi,
              );
            };
            if (typeof processObject.__bnhModuleResolve === 'function') {
              childProc.processObject.__bnhModuleResolve = processObject.__bnhModuleResolve;
            }
            if (typeof processObject.__bnhModuleImport === 'function') {
              const parentModuleImport = processObject.__bnhModuleImport;
              childProc.processObject.__bnhModuleImport = (specifier, importer, importOptions) => (
                parentModuleImport(specifier, importer, importOptions, childProc.processObject)
              );
            }
            if (options.stdinSource && childProc.processObject.stdin?.push) {
              const forwardStdin = (value) => {
                const stdin = childProc.processObject.stdin;
                stdin.push(value);
                if (stdin.readableFlowing && stdin.readableLength > 0) {
                  const pending = stdin.read(stdin.readableHighWaterMark);
                  if (pending !== null) childProc.processObject._bnhRunInContext?.(() => stdin.emit('data', pending));
                }
                const channel = childProc.processObject[Symbol.for('bnh.internal.child_process.channel')];
                if (channel?.reading === false && channel.pending?.length) {
                  nativeQueueMicrotask(() => {
                    if (channel.reading === false && channel.pending.length) channel.readStart();
                  });
                }
              };
              let bufferedInput;
              while ((bufferedInput = options.stdinSource.read?.()) !== null && bufferedInput !== undefined) {
                forwardStdin(bufferedInput);
              }
              if (options.stdinSource.readableEnded) childProc.processObject.stdin.push(null);
              else {
                options.stdinSource.on?.('data', forwardStdin);
                options.stdinSource.once?.('end', () => childProc.processObject.stdin.push(null));
              }
            }
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
            const childTaskRecords = new Map();
            let childTaskSequence = 0;
            const publishChildLifecycle = () => {
              childProc.processObject.__bnhRuntimeLifecycle = {
                pending: childTaskReleases.size,
                tasks: [...childTaskRecords.values()].slice(-8),
              };
            };
            const nativeQueueMicrotask = runtimeQueueMicrotask;
            // A same-realm child has to drain the current Promise/microtask
            // turn before its implicit beforeExit check. Node runs all
            // already-queued promise reactions before deciding that a
            // process is idle; checking from a microtask can otherwise close
            // a child between two `await` continuations and lose its final
            // stdout. Use the host timer surface so this check is not itself
            // registered as child work.
            const nativeSetTimeout = scope.__BNH_NATIVE_TIMERS__?.setTimeout
              || scope.setTimeout.bind(scope);
            let childExitCheckQueued = false;
            const tryExitChild = () => {
              if (childExitCheckQueued) return;
              childExitCheckQueued = true;
              nativeSetTimeout(() => {
                childExitCheckQueued = false;
                childProc.processObject._bnhRunInContext?.(() => {
                  if (childProc.processObject._bnhIsExited?.()
                    || childProc.processObject._exitRequested?.()
                    || childProc.processObject._timers?.size
                    || childProc.processObject._bnhHasPendingTasks?.()
                    || childProc.processObject._bnhHasPendingAbortWorker?.()) return;
                  const hasIpcListeners = childProc.processObject.connected
                    && ['message', 'disconnect'].some((name) => (
                      childProc.processObject.listeners?.(name)?.some((listener) => !listener._bnhInternal)
                      ?? childProc.processObject.listenerCount(name) > 0
                    ));
                  if (hasIpcListeners) return;
                  childProc.processObject._emitBeforeExit?.();
                  childProc.processObject._markExited?.();
                });
              });
            };
            const childTrackTask = (label = null) => {
              const release = trackTask(label);
              const taskId = ++childTaskSequence;
              childTaskRecords.set(taskId, {
                id: taskId,
                label: label == null ? null : String(label).slice(0, 128),
                stack: String(new Error().stack || '').split('\n')[2]?.trim().slice(0, 160) || null,
              });
              let released = false;
              const releaseChildTask = () => {
                if (released) return;
                released = true;
                childTaskReleases.delete(releaseChildTask);
                childTaskRecords.delete(taskId);
                release();
                publishChildLifecycle();
                if (childTaskReleases.size === 0) tryExitChild();
              };
              childTaskReleases.add(releaseChildTask);
              publishChildLifecycle();
              return releaseChildTask;
            };
            // VFS promise helpers are shared by the runtime and same-realm
            // child processes. Count a child's asynchronous filesystem work
            // in that child's liveness set as well as the parent runtime's
            // set, so an async package download cannot be cut off by the
            // child's implicit beforeExit check.
            const previousVfsTaskTracker = vfs.getTaskTracker?.();
            let vfsTaskTrackerRestored = false;
            const childVfsTaskTracker = (label = null) => {
              const parentRelease = previousVfsTaskTracker?.(label);
              const childRelease = childTrackTask(label);
              let released = false;
              return () => {
                if (released) return;
                released = true;
                childRelease?.();
                parentRelease?.();
              };
            };
            vfs.setTaskTracker(childVfsTaskTracker);
            const restoreVfsTaskTracker = () => {
              if (vfsTaskTrackerRestored) return;
              vfsTaskTrackerRestored = true;
              vfs.setTaskTracker(previousVfsTaskTracker);
            };
            const childHttpCompatibility = createHttpCompatibility(scope, {
              Buffer,
              process: childProc.processObject,
              proxy: activeProxy,
              httpNetwork: activeProxy ? undefined : httpCompatibility.httpNetwork,
              net,
              proxyEnv: childProc.processObject.env,
              trackTask: childTrackTask,
              diagnostics: () => scope.__BNH_DIAGNOSTICS__,
              performance: recordPerformanceEntry,
            });
            childProc.processObject._bnhBuiltinOverrides = {
              http: childHttpCompatibility.http,
              https: childHttpCompatibility.https,
              _http_common: childHttpCompatibility.httpCommon,
              _http_outgoing: childHttpCompatibility.http,
              _http_server: childHttpCompatibility.http,
            };
            childHttpModule = childHttpCompatibility.http;
            previousHttpMaxHeaderSize = childHttpModule.maxHeaderSize;
            if (prepared.maxHttpHeaderSize !== null) {
              childHttpModule.maxHeaderSize = prepared.maxHttpHeaderSize;
            }
            scope.http = childHttpModule;
            childProc.processObject._bnhTaskTracker = childTrackTask;
            const childDns = createTrackedDns(childProc.processObject);
            childProc.processObject.__bnhDns = childDns;
            childProc.processObject._bnhBuiltinOverrides.dns = childDns;
            childProc.processObject._bnhBuiltinOverrides['dns/promises'] = childDns.promises;
            childProc.processObject._bnhDgram = createBrowserDgram({
              network: virtualNetwork,
              BufferClass: Buffer,
              trackTask: childTrackTask,
              processOwner: childProc.processObject,
              runInProcessContext: (owner, callback) => {
                const previousProcess = scope.process;
                scope.process = owner;
                try { return callback(); }
                finally { scope.process = previousProcess; }
              },
            });
            childProc.processObject._bnhHasPendingTasks = () => childTaskReleases.size > 0;
            childProc.processObject._bnhTryExit = () => tryExitChild();
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
                queueMicrotask: scope.queueMicrotask,
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
              const channelKey = Symbol.for('bnh.internal.child_process.channel');
              const channel = childProc.processObject[channelKey] || {
                reading: true,
                pending: [],
                readStart() {
                  this.reading = true;
                  const messages = this.pending.splice(0);
                  for (const message of messages) {
                    childProc.processObject._bnhRunInContext?.(() => childProc.processObject.emit('message', message.value, message.handle));
                  }
                  return 0;
                },
                readStop() {
                  this.reading = false;
                  return 0;
                },
              };
              childProc.processObject[channelKey] = channel;
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
            const releaseGlobalProcess = () => {
              if (scope.process === childProc.processObject) scope.process = previousState.process;
            };
            const releaseGlobalConsole = () => {
              if (scope.console === childProc.processObject._bnhConsole) scope.console = previousState.console;
            };
            const originalChildExit = childProc.processObject.exit;
            childProc.processObject.exit = (code = 0) => {
              try {
                return originalChildExit(code);
              } finally {
                restoreVfsTaskTracker();
                releaseGlobalProcess();
                releaseGlobalConsole();
              }
            };
            const originalMarkExited = childProc.processObject._markExited;
            childProc.processObject._markExited = (...args) => {
              try {
                return originalMarkExited?.(...args);
              } finally {
                restoreVfsTaskTracker();
                releaseGlobalProcess();
                releaseGlobalConsole();
              }
            };
            childProc.processObject._bnhReleaseGlobalProcess = releaseGlobalProcess;
              scope.process = childProc.processObject;
              scope.console = createConsole((value) => {
                stdoutArr.push(value);
                options.onStdout?.(value);
              }, (value) => {
                stderrArr.push(value);
                options.onStderr?.(value);
              }, scope.console || {});
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
              // Promise continuations in a same-realm child can schedule
              // microtasks after the synchronous bootstrap has restored the
              // parent's globals. IPC children need the same context bridge
              // as ordinary children; leaving the host queueMicrotask in
              // place makes async module loading observe the wrong process
              // and VFS owner.
              scope.queueMicrotask = (callback) => {
                nativeQueueMicrotask(() => {
                  const runInContext = childProc.processObject._bnhRunInContext;
                  if (typeof runInContext === 'function') runInContext.call(childProc.processObject, callback);
                  else callback();
                });
              };
              childProc.processObject._bnhInstallTaskHooks?.();
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
              const nativeStreamWebApi = [
                'ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader',
                'ReadableStreamBYOBRequest', 'ReadableByteStreamController',
                'ReadableStreamDefaultController', 'WritableStream', 'WritableStreamDefaultWriter',
                'WritableStreamDefaultController', 'TransformStream',
                'TransformStreamDefaultController', 'ByteLengthQueuingStrategy',
                'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream',
                'CompressionStream', 'DecompressionStream',
              ].every((name) => typeof scope[name] === 'function')
                ? Object.fromEntries([
                  'ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader',
                  'ReadableStreamBYOBRequest', 'ReadableByteStreamController',
                  'ReadableStreamDefaultController', 'WritableStream', 'WritableStreamDefaultWriter',
                  'WritableStreamDefaultController', 'TransformStream',
                  'TransformStreamDefaultController', 'ByteLengthQueuingStrategy',
                  'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream',
                  'CompressionStream', 'DecompressionStream',
                ].map((name) => [name, scope[name]]))
                : null;
              if (nativeStreamWebApi) {
                // Keep the browser-native implementation for the auxiliary
                // constructors, but use the runtime's tracked ReadableStream
                // wrapper. Node's `stream.finished()` must observe a web
                // stream without acquiring its reader; the wrapper exposes
                // the non-consuming closed lifecycle used by that contract.
                syncStreamWebApi = {
                  ...nativeStreamWebApi,
                  ReadableStream: typeof streamWebApi?.ReadableStream === 'function'
                    ? streamWebApi.ReadableStream
                    : nativeStreamWebApi.ReadableStream,
                };
              } else {
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
              }
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
              installTextEncoderInspect(scope);
              if (prepared.snapshotBlobPath && !prepared.buildSnapshot && !prepared.scriptPath) {
                const snapshot = JSON.parse(String(fs.readFileSync(prepared.snapshotBlobPath, 'utf8')));
                entryPath = normalizePath(snapshot.entry, cwd);
              }
              // Node's CLI resolves a script argument with the same legacy
              // file probes as CommonJS when the exact argument is absent;
              // for example, `node tools/check` loads `tools/check.js`.
              // Keep the original argv intact while using the resolved file
              // as the module identity and source path.
              if (prepared.scriptPath && !vfs.files.has(entryPath)) {
                const scriptCandidate = resolveFileSync(
                  prepared.scriptPath,
                  path.join(cwd, '.bnh-child.js'),
                  childProc.processObject,
                );
                if (vfs.files.has(scriptCandidate)) entryPath = scriptCandidate;
              }
              const commandName = prepared.command.split('/').pop();
              if (prepared.experimentalLoader) {
                const loaderPath = resolveFileSync(prepared.experimentalLoader, entryPath, childProc.processObject);
                try {
                  readSource(loaderPath);
                } catch {
                  const error = new Error(`Cannot find package '${prepared.experimentalLoader}' imported from ${entryPath}`);
                  error.code = 'ERR_MODULE_NOT_FOUND';
                  error.name = 'Error [ERR_MODULE_NOT_FOUND]';
                  throw error;
                }
              }
              if (commandName === 'echo') {
                childProc.processObject.stdout.write(`${prepared.commandArgs.join(' ')}\n`);
              } else if (commandName === 'pwd') {
                childProc.processObject.stdout.write(`${prepared.cwd}\n`);
              } else if (commandName === 'env') {
                childProc.processObject.stdout.write(
                  `${Object.entries(prepared.env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
                );
              } else if (commandName === 'npm'
                && prepared.commandArgs[0] === 'config'
                && prepared.commandArgs[1] === 'get') {
                const key = String(prepared.commandArgs[2] || '');
                if (key === 'registry') {
                  const registry = String(prepared.env.npm_config_registry || 'https://registry.npmjs.org/');
                  childProc.processObject.stdout.write(`${registry.replace(/\/+$/, '')}/\n`);
                } else if (key === 'https-proxy') {
                  childProc.processObject.stdout.write(`${prepared.env.npm_config_https_proxy || 'null'}\n`);
                } else {
                  throw new Error(`npm config key is not available in the browser runtime: ${key}`);
                }
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
                const childSource = prepared.source === null ? undefined
                  : prepared.source.replace(/\bawait\s+(?:import|__bnhImport)\s*\(/g, 'require(');
                loadModuleSync(entryPath, entryPath, childProc.processObject, scope, Buffer, stderrArr, childSource, moduleState, true, compileCacheState, false, syncStreamWebApi);
                if (prepared.executionArgv.some((value) => String(value) === '--test')) {
                  for (const extraPath of prepared.afterScript.filter((value) => String(value).endsWith('.js'))) {
                    loadModuleSync(normalizePath(extraPath, prepared.cwd), entryPath, childProc.processObject, scope, Buffer, stderrArr, undefined, moduleState, true, compileCacheState, false, syncStreamWebApi);
                  }
                }
                childProc.processObject.__bnhNodeTestSourceLoaded?.();
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
                && ['message', 'disconnect'].some((name) => childProc.processObject.listeners?.(name)
                  ?.some((listener) => !listener?._bnhInternal && !listener?.__bnhInternalClusterListener));
              hasPendingTasks = childProc.processObject._bnhHasPendingTasks?.() === true;
              if (!childProc.processObject._exitRequested?.()
                && !hasPendingTimers
                && !hasIpcListeners
                && !hasPendingTasks
                && !childProc.processObject._bnhHasPendingAbortWorker?.()) {
                tryExitChild();
              }
            } catch (error) {
              if (compileCacheState?.primaryAction === 'initialized'
                && (childProc?.processObject?.env?.NODE_DEBUG_NATIVE || '').includes('COMPILE_CACHE')) {
                const basename = (compileCacheState.primaryPath || entryPath).split('/').pop() || entryPath;
                const initialMessage = `[compile cache] ${basename} was not initialized, initializing the in-memory entry\n`;
                const index = stderrArr.lastIndexOf(initialMessage);
                if (index >= 0) stderrArr.splice(index, 1);
                stderrArr.push(`[compile cache] skip ${basename} because the cache was not initialized\n`);
              }
              const traceUncaught = executionArgv.some((value) => String(value) === '--trace-uncaught');
              if (traceUncaught) {
                stderrArr.push('Thrown at:\n    at [eval]:1:1\n');
              } else {
                let detail;
                try { detail = error?.stack || String(error); } catch { detail = Object.prototype.toString.call(error); }
                const message = `${detail}\n`;
                stderrArr.push(message);
                options.onStderr?.(message);
              }
              if (abortOnUncaughtException) childProc.processObject._bnhAbort?.('SIGABRT');
              else childProc.processObject.exit(1);
            } finally {
              if (compileCacheState?.primaryAction === 'same') {
                const basename = (compileCacheState.primaryPath || entryPath).split('/').pop() || entryPath;
                stderrArr.push(`[compile cache] skip ${basename} because cache was the same\n`);
              }
              // Async callbacks re-enter their owning child through the
              // timer/stream context hooks above. Never leave a child’s
              // logical process or console installed globally after this
              // synchronous bootstrap; doing so contaminates the parent
              // runner while the child remains alive.
              scope.process = previousState.process;
              scope.console = previousState.console;
              scope.require = previousState.require;
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
              if (previousState.hasUrl) scope.url = previousState.url;
              else delete scope.url;
              if (typeof originalReadFileSync === 'function') fs.readFileSync = originalReadFileSync;
              if (childHttpModule) childHttpModule.maxHeaderSize = previousHttpMaxHeaderSize;
              dnsModule = previousDnsModule;
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
          let esmEntryPath = prepared.entryPath;
          try { esmEntryPath = vfs.fs.realpathSync(esmEntryPath); } catch { /* preserve unresolved diagnostics */ }
          const esmPrepared = esmEntryPath === prepared.entryPath
            ? prepared
            : {
              ...prepared,
              entryPath: esmEntryPath,
              mainPath: prepared.mainPath === prepared.entryPath ? esmEntryPath : prepared.mainPath,
              scriptPath: prepared.scriptPath === prepared.entryPath ? esmEntryPath : prepared.scriptPath,
            };
          // An asynchronous ESM child is a separate Node process and must not
          // share its parent's module-loader cache or lifecycle event loop.
          // Keep the VFS and network capabilities shared through the normal
          // worker bridge, but give every async ESM child its own realm. This
          // also prevents a parent waiting on a child from blocking that
          // child's module evaluation and terminal frame.
          const workerIsolation = Boolean(
            options.ipc
            || options.asyncLifecycle
            || esmExecutionDepth > 0
            || processObject.__bnhEsmNested,
          );
          // The child process boundary owns the transferred/shared bytes. A
          // copied snapshot here needlessly duplicates the complete virtual
          // filesystem before prepareWorkerVfs can share it with the child
          // realm. Keep the snapshot as a view of the current VFS, matching
          // runtime.spawn() and worker_threads.Worker().
          const snapshot = vfs.snapshot({ copy: false });
          const files = Object.fromEntries(
            snapshot.artifacts.map(({ path, bytes }) => [path, bytes]),
          );
          if (esmPrepared.source !== null) {
            files[esmPrepared.entryPath] = new TextEncoder().encode(esmPrepared.source);
          }
          const networkChannel = workerIsolation ? createMessageChannel(scope) : null;
          const workerNetworkBridge = networkChannel
            ? createWorkerNetworkBridge({ network: virtualNetwork, port: networkChannel.port1 })
            : null;
          const suppressWarnings = esmPrepared.executionArgv.some((value) => String(value) === '--no-warnings');
          const forwardStdout = (value) => {
            const text = normalizeOutputChunk(value);
            if (text) writeStdout(text);
          };
          const forwardStderr = (value) => {
            let text = normalizeOutputChunk(value);
            if (suppressWarnings) {
              text = text.replace(/\[DEP0005\] DeprecationWarning: Buffer\(\) is deprecated due to security and usability issues\. Please use the Buffer\.alloc\(\), Buffer\.allocUnsafe\(\), or Buffer\.from\(\) methods instead\.\n/g, '');
            }
            if (text) writeStderr(text);
          };
          const childArgv = esmPrepared.evalCode !== null
            ? [esmPrepared.executionArgv[0], ...esmPrepared.afterScript]
            : [esmPrepared.executionArgv[0], ...(esmPrepared.scriptPath ? [esmPrepared.scriptPath] : []), ...esmPrepared.afterScript];
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
          const proxyOperations = proxyCapability.adapter
            ? typeof proxyCapability.adapter === 'function' || typeof proxyCapability.adapter.handle === 'function'
              ? ['request', 'connect', 'send', 'resolve', 'tls']
              : ['request', 'connect', 'send', 'resolve', 'tls'].filter((operation) => (
                  typeof proxyCapability.adapter[operation] === 'function'
                ))
            : [];
          const childProxy = workerIsolation
            ? proxyCapability.adapter
              ? { ...(capabilities.manifest.proxy || {}), operations: proxyOperations, rpc: true }
              : capabilities.manifest.proxy
            : proxyCapability.adapter ? proxyCapability : capabilities.manifest.proxy;
          const esmDescriptor = {
            capabilities: capabilities.manifest,
            nodeVersion: resolvedProfile.id,
            files,
            symlinks: snapshot.symlinks,
            entry: esmPrepared.entryPath,
            execArgv: childExecArgv,
            proxy: childProxy,
            virtualNetwork: workerIsolation ? { shared: true } : { shared: true, network: virtualNetwork },
            esmNested: workerIsolation,
          };
          const vfsUpdateBridge = workerIsolation ? createVfsUpdateBridge() : null;
          const run = async (context) => {
            const previous = esmExecutionTail;
            let release;
            esmExecutionTail = new Promise((resolve) => { release = resolve; });
            await previous;
            esmExecutionDepth += 1;
            try {
              const { runProcessEntry } = await import('./runtime/process-entry.js');
              const result = await runProcessEntry({ ...context, vfs: esmDescriptor });
              return result;
            } finally {
              esmExecutionDepth = Math.max(0, esmExecutionDepth - 1);
              release();
            }
          };
          const processHandle = createVirtualProcess({
            scope,
            nodeVersion: resolvedProfile.id,
            runId: runSpec?.runId,
            childId: `child-${childSequence}`,
            entry: esmPrepared.entryPath,
            argv: childArgv,
            env: esmPrepared.env,
            cwd: esmPrepared.cwd,
            signal: options.signal,
            signalGrants: capabilities.manifest.signals.allowed,
            workerSource: new URL('./runtime/process-entry.js', import.meta.url).href,
            workerType: 'module',
            execArgv: childExecArgv,
            vfs: esmDescriptor,
            run,
            // Child processes may create a server after they start. Keep them
            // in this realm so later siblings can share the live registry.
            forceFallback: !workerIsolation,
            preserveReferences: true,
            networkPort: networkChannel?.raw.port2,
            vfsUpdatePort: vfsUpdateBridge?.port,
            proxyAdapter: workerIsolation ? proxyCapability.adapter : undefined,
            stdout: forwardStdout,
            stderr: forwardStderr,
          });
          if (workerNetworkBridge) {
            processHandle.wait().then(
              () => workerNetworkBridge.close(),
              () => workerNetworkBridge.close(),
            );
          }
          if (vfsUpdateBridge) {
            processHandle.wait().then(
              () => vfsUpdateBridge.close(),
              () => vfsUpdateBridge.close(),
            );
          }
          return processHandle;
        }

        function execFileSync(file, args, options = {}) {
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
        }

        function execSync(command, options = {}) {
          validateChildCommand(command, 'command');
          validateChildOptions(options);
          const parsed = parseShellCommand(command, { ...processObject.env, ...(options?.env || {}) });
          return execFileSync(parsed.file, parsed.args, { ...options, stdinPath: parsed.stdinPath });
        }

          const runNpmChild = async (prepared, ownerProcess, childOptions = {}) => {
          const args = prepared.commandArgs.map(String);
          const optionsWithValues = new Set([
            '--cache', '--prefix', '--registry', '--userconfig', '--loglevel', '--workspace', '-w',
          ]);
          const command = (() => {
            for (let index = 0; index < args.length; index += 1) {
              const argument = String(args[index]);
              if (argument === '--') return { name: args[index + 1] || '', index: index + 1 };
              if (!argument.startsWith('-')) return { name: argument, index };
              if (!argument.includes('=') && optionsWithValues.has(argument)) index += 1;
            }
            return { name: '', index: -1 };
          })();
          // Package managers receive the environment assembled for this
          // child. Reading only the owner drops child-specific npm/TMP
          // settings from nested lifecycle commands.
          const env = prepared.env || ownerProcess.env || processObject.env || {};
          for (const key of ['npm_config_tmp', 'TMPDIR', 'TMP', 'TEMP']) {
            const configuredPath = env[key];
            if (typeof configuredPath === 'string' && configuredPath.startsWith('/')) {
              vfs.fs.mkdirSync(configuredPath, { recursive: true });
            }
          }
          const registry = String(env.npm_config_registry || env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org');
          if (command.name === 'config' && args[command.index + 1] === 'get') {
            const key = args[command.index + 2];
            if (key === 'registry') return { code: 0, stdout: `${registry.replace(/\/+$/, '')}\n`, stderr: '' };
            if (key === 'https-proxy') return { code: 0, stdout: `${env.npm_config_https_proxy || 'null'}\n`, stderr: '' };
          }

          const createNpm = (clientRegistry = registry) => new BrowserNpm({
            vfs,
            registry: clientRegistry,
            cache: scope.__BNH_NPM_CACHE__,
            globalObject: scope,
            fetchFn: (url, init) => runtimeFetchRef.current(url, init),
            proxyUrl: null,
            lifecycleScripts: false,
            platform: 'browser',
            arch: 'browser',
            libc: 'browser',
          });

          const commandArguments = args.slice(command.index + 1);
          const positionalArguments = () => {
            const values = [];
            let stopOptions = false;
            for (let index = 0; index < commandArguments.length; index += 1) {
              const argument = String(commandArguments[index]);
              if (!stopOptions && argument === '--') {
                stopOptions = true;
                continue;
              }
              if (!stopOptions && argument.startsWith('-')) {
                if (!argument.includes('=') && optionsWithValues.has(argument)) index += 1;
                continue;
              }
              values.push(argument);
            }
            return values;
          };

          const resolvePackage = async (spec, clientRegistry = registry) => {
            const parsed = parsePackageSpec(spec);
            if (!parsed.name || /^https?:\/\//i.test(parsed.name)) {
              throw new Error(`npm ${command.name} only supports registry package specs in the browser runtime`);
            }
            const npm = createNpm(clientRegistry);
            const metadata = await npm.fetchPackageMetadata(parsed.name);
            const resolved = npm.resolveVersion(metadata, parsed.range);
            return { npm, metadata, parsed, ...resolved };
          };

          const childActivity = processObject.__bnhChildActivity ||= {
            launched: 0,
            completed: 0,
            failed: 0,
            first: null,
            last: null,
            recent: [],
          };
          childActivity.recent ||= [];
          const runVirtualCommandInternal = ({ entry, argv, cwd, commandEnv, stdin, signal, timeout, onStdout, onStderr }) => {
            const isNodeExecutable = (pathname) => /(?:^|\/)node(?:js)?$/.test(String(pathname));
            const commandName = String(entry).split('/').pop();
            if (['npm', 'yarn', 'yarnpkg'].includes(commandName)) {
              const managerPrepared = prepareChild(entry, argv || [], {
                cwd,
                env: commandEnv,
                input: stdin,
                signal,
                timeout,
              }, ownerProcess);
              return (async () => {
                let streamedOutput = false;
                const result = await runNpmChild(managerPrepared, ownerProcess, {
                  signal,
                  timeout,
                  stdin: stdin,
                  onStdout: (value) => {
                    streamedOutput = true;
                    onStdout?.(value);
                  },
                  onStderr: (value) => {
                    streamedOutput = true;
                    onStderr?.(value);
                  },
                });
                if (!streamedOutput) {
                  if (result.stdout) onStdout?.(result.stdout);
                  if (result.stderr) onStderr?.(result.stderr);
                }
                return result;
              })();
            }
            let shebangScript = false;
            try {
              const source = readSource(normalizePath(entry, cwd || ownerProcess.cwd?.() || '/node'));
              const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
              shebangScript = text.startsWith('#!');
            } catch {
              // The virtual child path below handles commands that are not
              // executable files mounted in the VFS.
            }
            if (shebangScript && entry !== processObject.execPath && !isNodeExecutable(entry)) {
              const prepared = prepareChild(processObject.execPath, [entry, ...(argv || [])], {
                cwd,
                env: commandEnv,
                input: stdin,
                signal,
                timeout,
              }, ownerProcess);
              const useEsm = prepared.entryPath.endsWith('.mjs') || prepared.moduleInput
                || prepared.experimentalLoader
                || isRuntimeEsmModule(prepared.entryPath, prepared.executionArgv);
              if (useEsm) {
                const stdout = [];
                const stderr = [];
                const processHandle = runPreparedESM(prepared, {
                  signal,
                  timeout,
                  // A shell-launched ESM script is an asynchronous child
                  // process even when its launcher has no explicit IPC. Keep
                  // its module cache, event loop, and terminal frame in the
                  // child realm so the parent cannot block module evaluation
                  // or strand the child result in the same-realm lifecycle.
                  asyncLifecycle: true,
                }, (value) => {
                  const chunk = normalizeOutputChunk(value);
                  stdout.push(chunk);
                  onStdout?.(chunk);
                }, (value) => {
                  const chunk = normalizeOutputChunk(value);
                  stderr.push(chunk);
                  onStderr?.(chunk);
                });
                return processHandle.wait().then((terminal) => {
                  const code = terminal.signal ? null : terminal.code ?? 1;
                  if (code !== 0 || terminal.signal || terminal.error) {
                    const detail = terminal.error?.stack || terminal.error?.message || '';
                    const message = detail ? `${detail}\n` : '';
                    if (message) {
                      stderr.push(message);
                      onStderr?.(message);
                    }
                  }
                  return {
                    code,
                    stdout: stdout.join(''),
                    stderr: stderr.join(''),
                    streamed: Boolean((onStdout && stdout.length) || (onStderr && stderr.length)),
                    terminal,
                    runtimeState: terminal.runtimeState || null,
                  };
                });
              }
              const stdout = [];
              const stderr = [];
              const result = runPreparedSync(prepared, {
                asyncLifecycle: true,
                encoding: 'utf8',
                onStdout: (value) => {
                  const chunk = normalizeOutputChunk(value);
                  stdout.push(chunk);
                  onStdout?.(chunk);
                },
                onStderr: (value) => {
                  const chunk = normalizeOutputChunk(value);
                  stderr.push(chunk);
                  onStderr?.(chunk);
                },
              });
              const forwardReturnedOutput = (value, target, callback) => {
                const returned = normalizeOutputChunk(value);
                if (!returned) return;
                const streamed = target.join('');
                if (streamed === returned || streamed.endsWith(returned)) return;
                const missing = returned.startsWith(streamed)
                  ? returned.slice(streamed.length)
                  : returned;
                if (!missing) return;
                target.push(missing);
                callback?.(missing);
              };
              forwardReturnedOutput(result.stdout, stdout, onStdout);
              forwardReturnedOutput(result.stderr, stderr, onStderr);
              const complete = (code, signalValue) => {
                const finalCode = signalValue ? null : code ?? result.status ?? 1;
                if (finalCode !== 0) {
                  const terminalError = result.process?.terminalRecord?.error
                    || result.process?.terminal?.error
                    || result.process?.__bnhUncaughtException;
                  const detail = terminalError?.stack || terminalError?.message
                    || `child exited with code ${finalCode} (runtime exitCode=${result.process?.exitCode ?? 'unknown'})`;
                  const message = `${detail}\n`;
                  stderr.push(message);
                  onStderr?.(message);
                }
                return {
                  code: finalCode,
                  stdout: stdout.join(''),
                  stderr: stderr.join(''),
                  streamed: Boolean((onStdout && stdout.length) || (onStderr && stderr.length)),
                  terminal: result.process?.terminalRecord || result.process?.terminal || null,
                  runtimeState: result.process?.terminalRecord?.runtimeState
                    || result.process?.terminal?.runtimeState
                    || result.process?.__bnhNodeTestState
                    || null,
                };
              };
              if (!result.pending || !result.process) {
                return Promise.resolve(complete(result.status, result.signal));
              }
              return new Promise((resolve) => {
                result.process.once('exit', (code, signalValue) => {
                  scope.queueMicrotask(() => {
                    const finalSignal = result.process.getSignal?.() || signalValue || null;
                    const finalCode = finalSignal
                      ? null
                      : (result.process.getCode?.() ?? code);
                    resolve(complete(finalCode, finalSignal));
                  });
                });
              });
            }
            if ((entry === processObject.execPath || isNodeExecutable(entry)) && Array.isArray(argv) && argv[0] === '-e') {
              const prepared = prepareChild(entry, argv, {
                cwd,
                env: commandEnv,
                input: stdin,
                signal,
                timeout,
              }, ownerProcess);
              const result = runPreparedSync(prepared, {
                encoding: 'utf8',
                onStdout,
                onStderr,
              });
              const stdout = String(result.stdout || '');
              const stderr = String(result.stderr || '');
              if (!result.stdoutChunks?.length && stdout) onStdout?.(stdout);
              if (!result.stderrChunks?.length && stderr) onStderr?.(stderr);
              return Promise.resolve({
                code: result.status ?? 1,
                stdout,
                stderr,
                streamed: Boolean((onStdout && stdout) || (onStderr && stderr)),
              });
            }
            // A shell's `node script.js` command is a real child launch. Run
            // the script through the same prepared-process path as spawn so
            // its exit, output, and pending lifecycle are observed directly;
            // routing back through virtualAsync would create a second child
            // boundary and can lose the terminal event between sequential
            // package lifecycle commands.
            if ((entry === processObject.execPath || isNodeExecutable(entry))
              && Array.isArray(argv) && typeof argv[0] === 'string' && !argv[0].startsWith('-')) {
              const prepared = prepareChild(entry, argv, {
                cwd,
                env: commandEnv,
                input: stdin,
                signal,
                timeout,
              }, ownerProcess);
              const stdout = [];
              const stderr = [];
              const result = runPreparedSync(prepared, {
                asyncLifecycle: true,
                encoding: 'utf8',
                onStdout: (value) => {
                  const chunk = normalizeOutputChunk(value);
                  stdout.push(chunk);
                  onStdout?.(chunk);
                },
                onStderr: (value) => {
                  const chunk = normalizeOutputChunk(value);
                  stderr.push(chunk);
                  onStderr?.(chunk);
                },
              });
              const complete = (code, signalValue) => {
                const finalCode = signalValue ? null : code ?? result.status ?? 1;
                if (finalCode !== 0) {
                  const terminalError = result.process?.terminalRecord?.error
                    || result.process?.terminal?.error
                    || result.process?.__bnhUncaughtException;
                  const detail = terminalError?.stack || terminalError?.message
                    || `child exited with code ${finalCode} (runtime exitCode=${result.process?.exitCode ?? 'unknown'})`;
                  const message = `${detail}\n`;
                  if (!stderr.join('').includes(message)) {
                    stderr.push(message);
                    onStderr?.(message);
                  }
                }
                return {
                  code: finalCode,
                  stdout: stdout.join(''),
                  stderr: stderr.join(''),
                  streamed: Boolean((onStdout && stdout.length) || (onStderr && stderr.length)),
                  terminal: result.process?.terminalRecord || result.process?.terminal || null,
                  runtimeState: result.process?.terminalRecord?.runtimeState
                    || result.process?.terminal?.runtimeState
                    || result.process?.__bnhNodeTestState
                    || null,
                };
              };
              if (!result.pending || !result.process) return Promise.resolve(complete(result.status, result.signal));
              return new Promise((resolve) => {
                result.process.once('exit', (code, signalValue) => {
                  scope.queueMicrotask(() => {
                    const finalSignal = result.process.getSignal?.() || signalValue || null;
                    const finalCode = finalSignal ? null : (result.process.getCode?.() ?? code);
                    resolve(complete(finalCode, finalSignal));
                  });
                });
              });
            }
            return new Promise((resolve) => {
              const output = [];
              const errors = [];
              let callbackOutput = '';
              let callbackError = '';
              let settled = false;
              const text = (value) => normalizeOutputChunk(value);
              const finish = (code) => {
                if (settled) return;
                settled = true;
                const stdout = output.length ? output.join('') : callbackOutput;
                const stderr = errors.length ? errors.join('') : callbackError;
                resolve({
                  code: code ?? 1,
                  stdout,
                  stderr,
                  streamed: Boolean((onStdout && output.length) || (onStderr && errors.length)),
                });
              };
              const child = virtualAsync(entry, argv, {
                cwd,
                env: commandEnv,
                input: stdin,
                signal,
                timeout,
              }, (_error, stdout, stderr) => {
                callbackOutput = String(stdout || '');
                callbackError = String(stderr || '');
              });
              child.stdout?.on('data', (value) => {
                const chunk = text(value);
                output.push(chunk);
                onStdout?.(chunk);
              });
              child.stderr?.on('data', (value) => {
                const chunk = text(value);
                errors.push(chunk);
                onStderr?.(chunk);
              });
              child.once('close', (code) => {
                finish(code);
              });
              child.stdin?.end(stdin === undefined ? undefined : stdin);
            });
          };

          const summarizeChildRuntimeState = (value) => {
            if (!value || typeof value !== 'object') return null;
            const nodeTest = value.nodeTest && typeof value.nodeTest === 'object'
              ? value.nodeTest
              : value;
            const boundedText = (input, limit = 512) => String(input || '').slice(0, limit);
            const listSummary = (items) => {
              if (!Array.isArray(items)) return null;
              return {
                count: items.length,
                first: items.length ? boundedText(items[0], 256) : null,
                last: items.length > 1 ? boundedText(items.at(-1), 256) : items.length ? boundedText(items[0], 256) : null,
              };
            };
            return {
              exitCode: value.exitCode ?? null,
              runtimeCode: value.runtimeCode ?? null,
              nodeTest: {
                registered: Number(nodeTest.registered) || 0,
                completed: Number(nodeTest.completed) || 0,
                activeTest: nodeTest.activeTest ? {
                  name: boundedText(nodeTest.activeTest.name, 160) || null,
                  fullName: boundedText(nodeTest.activeTest.fullName, 240) || null,
                  file: boundedText(nodeTest.activeTest.file, 256) || null,
                  state: boundedText(nodeTest.activeTest.state, 32) || 'running',
                } : null,
                requestedFiles: listSummary(nodeTest.requestedFiles),
                files: listSummary(nodeTest.files),
                streamEvents: listSummary(nodeTest.streamEvents),
                streamError: nodeTest.streamError ? {
                  name: boundedText(nodeTest.streamError.name || 'Error', 64),
                  message: boundedText(nodeTest.streamError.message || nodeTest.streamError),
                } : null,
                streamTerminal: nodeTest.streamTerminal == null ? null : boundedText(nodeTest.streamTerminal, 64),
              },
            };
          };
          const recordChildActivity = (options, result, error = null) => {
            childActivity.completed += 1;
            if (error || result?.code !== 0) childActivity.failed += 1;
            const terminal = result?.terminal;
            const boundedText = (value, limit = 512) => String(value || '').slice(0, limit);
            const outputBytes = (value) => {
              if (value instanceof ArrayBuffer) return value.byteLength;
              if (ArrayBuffer.isView(value)) return value.byteLength;
              return new TextEncoder().encode(String(value || '')).byteLength;
            };
            const record = {
              entry: boundedText(options.entry, 256),
              argv: (options.argv || []).slice(0, 32).map((value) => boundedText(value, 128)),
              argumentCount: Array.isArray(options.argv) ? options.argv.length : 0,
              cwd: boundedText(options.cwd, 256),
              code: result?.code ?? null,
              pending: Boolean(result?.pending),
              stdoutBytes: outputBytes(result?.stdout || ''),
              stderrBytes: outputBytes(result?.stderr || ''),
              stdoutExcerpt: boundedText(result?.stdout),
              stderrExcerpt: boundedText(result?.stderr),
              terminal: terminal ? {
                status: boundedText(terminal.status, 64) || null,
                kind: boundedText(terminal.kind, 64) || null,
                code: terminal.code ?? null,
                signal: terminal.signal ?? null,
                error: terminal.error ? {
                  name: boundedText(terminal.error.name, 64) || 'Error',
                  message: boundedText(terminal.error.message || terminal.error),
                  code: boundedText(terminal.error.code, 64) || null,
                } : null,
              } : null,
              runtimeState: summarizeChildRuntimeState(result?.runtimeState || terminal?.runtimeState),
              error: error ? {
                name: boundedText(error.name, 64) || 'Error',
                message: boundedText(error.message || error),
                code: boundedText(error.code, 64) || null,
              } : null,
            };
            if (!childActivity.first) childActivity.first = record;
            childActivity.last = record;
            childActivity.recent.push(record);
            if (childActivity.recent.length > 16) childActivity.recent.shift();
            const completeOutput = {
              ...record,
              stdout: normalizeOutputChunk(result?.stdout || ''),
              stderr: normalizeOutputChunk(result?.stderr || ''),
            };
            if (typeof ownerProcess.__bnhChildOutput === 'function') {
              ownerProcess.__bnhChildOutput(completeOutput);
            } else {
              (ownerProcess.__bnhChildOutputs ||= []).push(completeOutput);
            }
          };
          const runVirtualCommand = (options) => {
            childActivity.launched += 1;
            let result;
            try {
              result = runVirtualCommandInternal(options);
            } catch (error) {
              recordChildActivity(options, null, error);
              throw error;
            }
            return Promise.resolve(result).then((value) => {
              recordChildActivity(options, value);
              return value;
            }, (error) => {
              recordChildActivity(options, null, error);
              throw error;
            });
          };

          const shellFs = {
            exists: async (pathname) => vfs.fs.existsSync(pathname),
            stat: (...fsArgs) => vfs.fs.promises.stat(...fsArgs),
            readFile: async (pathname, ...fsArgs) => {
              const bytes = await vfs.fs.promises.readFile(pathname, ...fsArgs);
              return typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
            },
            writeFile: (...fsArgs) => vfs.fs.promises.writeFile(...fsArgs),
            mkdir: (...fsArgs) => vfs.fs.promises.mkdir(...fsArgs),
            readdir: (...fsArgs) => vfs.fs.promises.readdir(...fsArgs),
            remove: (pathname, removeOptions) => vfs.fs.rmSync(pathname, removeOptions),
            copy: (source, destination, copyOptions) => vfs.fs.cpSync(source, destination, copyOptions),
            rename: (source, destination) => vfs.fs.renameSync(source, destination),
            glob: async (pattern, cwd) => vfs.fs.globSync(pattern, { cwd }),
          };

          const runNodeCommand = (nodeOptions) => {
            const argv = nodeOptions.script
              ? [nodeOptions.script, ...(nodeOptions.args || [])]
              : [nodeOptions.print ? '-p' : '-e', nodeOptions.code, ...(nodeOptions.args || [])];
            const prepared = prepareChild(processObject.execPath, argv, {
              cwd: nodeOptions.cwd,
              env: nodeOptions.env,
              input: nodeOptions.input,
              signal: nodeOptions.signal,
              timeout: nodeOptions.timeout,
            }, ownerProcess);
            if (!isRuntimeEsmModule(prepared.entryPath, prepared.executionArgv)) {
              return runVirtualCommand({
                entry: processObject.execPath,
                argv,
                cwd: nodeOptions.cwd,
                commandEnv: nodeOptions.env,
                stdin: nodeOptions.input,
                signal: nodeOptions.signal,
                timeout: nodeOptions.timeout,
                onStdout: nodeOptions.onStdout,
                onStderr: nodeOptions.onStderr,
              });
            }
            const stdout = [];
            const stderr = [];
            const processHandle = runPreparedESM(prepared, {
              signal: nodeOptions.signal,
              timeout: nodeOptions.timeout,
              asyncLifecycle: true,
            }, (value) => {
              const chunk = normalizeOutputChunk(value);
              stdout.push(chunk);
              nodeOptions.onStdout?.(chunk);
            }, (value) => {
              const chunk = normalizeOutputChunk(value);
              stderr.push(chunk);
              nodeOptions.onStderr?.(chunk);
            });
            return processHandle.wait().then(
              (terminal) => ({
                code: terminal.signal ? null : terminal.code ?? 1,
                stdout: stdout.join(''),
                stderr: stderr.join(''),
                streamed: Boolean((nodeOptions.onStdout && stdout.length) || (nodeOptions.onStderr && stderr.length)),
              }),
              (error) => {
                const message = `${error?.stack || error?.message || error}\n`;
                if (!stderr.length) {
                  stderr.push(message);
                  nodeOptions.onStderr?.(message);
                }
                return {
                  code: 1,
                  stdout: stdout.join(''),
                  stderr: stderr.join(''),
                  streamed: Boolean((nodeOptions.onStdout && stdout.length) || (nodeOptions.onStderr && stderr.length)),
                };
              },
            );
          };

          const runScriptBody = async (scriptName, packageJson, scriptOptions = {}) => {
            const script = packageJson?.scripts?.[scriptName];
            if (typeof script !== 'string' || !script) {
              return { code: 0, stdout: '', stderr: '', streamed: false };
            }
            const scriptCwd = scriptOptions.cwd || prepared.cwd;
            const baseEnv = scriptOptions.env || env;
            const scriptEnv = {
              ...baseEnv,
              npm_lifecycle_event: scriptName,
              npm_lifecycle_script: script,
              npm_package_name: packageJson.name || '',
              npm_package_version: packageJson.version || '',
              npm_execpath: '/node/node_modules/.bin/npm',
              npm_node_execpath: '/node/node_modules/.bin/node',
              PATH: `${scriptCwd}/node_modules/.bin:/node/node_modules/.bin:${baseEnv.PATH || ''}`,
            };
            const stdout = [];
            const stderr = [];
            let forwarded = false;
            const result = await runShellScript(script, {
              args: scriptOptions.args,
              cwd: scriptCwd,
              env: scriptEnv,
              stdin: scriptOptions.stdin,
              fs: shellFs,
              signal: scriptOptions.signal,
              timeout: scriptOptions.timeout,
              onNetwork: scriptOptions.onNetwork,
              onStdout: (chunk) => {
                const textChunk = String(chunk);
                stdout.push(textChunk);
                if (typeof scriptOptions.onStdout === 'function') {
                  forwarded = true;
                  scriptOptions.onStdout(textChunk);
                }
              },
              onStderr: (chunk) => {
                const textChunk = String(chunk);
                stderr.push(textChunk);
                if (typeof scriptOptions.onStderr === 'function') {
                  forwarded = true;
                  scriptOptions.onStderr(textChunk);
                }
              },
              npmRun: (nestedName, nestedOptions) => runPackageScript(nestedName, {
                ...nestedOptions,
                cwd: nestedOptions?.cwd || scriptCwd,
                env: nestedOptions?.env || scriptEnv,
                onNetwork: nestedOptions?.onNetwork || scriptOptions.onNetwork,
                onStdout: nestedOptions?.onStdout || scriptOptions.onStdout,
                onStderr: nestedOptions?.onStderr || scriptOptions.onStderr,
              }),
              runCommand: (commandOptions) => runVirtualCommand({
                entry: commandOptions.entry,
                argv: commandOptions.argv,
                stage: scriptName,
                cwd: commandOptions.cwd,
                commandEnv: commandOptions.env,
                stdin: commandOptions.stdin,
                signal: commandOptions.signal,
                timeout: commandOptions.timeout,
                onStdout: commandOptions.onStdout,
                onStderr: commandOptions.onStderr,
              }),
              runNode: runNodeCommand,
              nodeVersion: resolvedProfile.runtimeVersion,
            });
            return {
              code: result.code,
              stdout: stdout.join(''),
              stderr: stderr.join(''),
              streamed: Boolean(stdout.length || stderr.length),
              forwarded,
            };
          };

          const runPackageScript = async (scriptName, scriptOptions = {}) => {
            const npm = createNpm();
            const packageJson = await npm.readPackageJson(scriptOptions.cwd || prepared.cwd);
            if (!packageJson?.scripts?.[scriptName]) {
              return {
                code: 1,
                stdout: '',
                stderr: `npm error Missing script: "${scriptName}"\n`,
                streamed: false,
              };
            }
            const lifecycle = [`pre${scriptName}`, scriptName, `post${scriptName}`];
            const stdout = [];
            const stderr = [];
            let forwarded = false;
            for (const name of lifecycle) {
              let result;
              try {
                result = await runScriptBody(name, packageJson, {
                  ...scriptOptions,
                  args: name === scriptName ? scriptOptions.args : [],
                });
              } catch (error) {
                const message = `${error?.stack || error?.message || error}\n`;
                scriptOptions.onStderr?.(message);
                return {
                  code: 1,
                  stdout: stdout.join(''),
                  stderr: `${stderr.join('')}${message}`,
                  streamed: true,
                  forwarded: Boolean(stdout.length || stderr.length),
                };
              }
              stdout.push(result.stdout);
              stderr.push(result.stderr);
              forwarded ||= result.forwarded;
              if (result.code !== 0) {
                return {
                  code: result.code,
                  stdout: stdout.join(''),
                  stderr: stderr.join(''),
                  streamed: true,
                  forwarded,
                };
              }
            }
            return { code: 0, stdout: stdout.join(''), stderr: stderr.join(''), streamed: true, forwarded };
          };

          const packageManagerName = String(prepared.command).split('/').pop();
          const isYarn = packageManagerName === 'yarn' || packageManagerName === 'yarnpkg';
          if (isYarn && command.name && !new Set([
            '--version', '-v', 'add', 'config', 'info', 'install', 'link', 'pack', 'remove', 'run', 'run-script', 'test', 'upgrade',
          ]).has(command.name)) {
            const separator = commandArguments.indexOf('--');
            const scriptArgs = separator >= 0 ? commandArguments.slice(separator + 1) : commandArguments;
            return runPackageScript(command.name, {
              cwd: prepared.cwd,
              env,
              args: scriptArgs,
              stdin: prepared.stdin,
              signal: childOptions.signal,
              timeout: childOptions.timeout,
              onStdout: childOptions.onStdout,
              onStderr: childOptions.onStderr,
            });
          }

          if (command.name === '--version' || command.name === '-v'
            || commandArguments.includes('--version') || commandArguments.includes('-v')) {
            return { code: 0, stdout: '10.0.0-browser\n', stderr: '' };
          }

          if (isYarn && command.name === 'link') {
            const linkedPackage = positionalArguments()[0];
            const links = scope.__BNH_YARN_LINKS__ ||= new Map();
            if (!linkedPackage) {
              const packageJson = await createNpm().readPackageJson(prepared.cwd);
              if (!packageJson?.name) {
                return { code: 1, stdout: '', stderr: 'yarn error package name is required\n' };
              }
              links.set(packageJson.name, prepared.cwd);
              return { code: 0, stdout: '', stderr: '' };
            }
            const target = links.get(linkedPackage);
            if (!target) {
              return { code: 1, stdout: '', stderr: `yarn error linked package not found: ${linkedPackage}\n` };
            }
            const linkPath = path.join(prepared.cwd, 'node_modules', linkedPackage);
            await vfs.fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
            try { await vfs.fs.promises.rm(linkPath, { recursive: true, force: true }); } catch { /* absent link */ }
            vfs.fs.symlinkSync(target, linkPath);
            return { code: 0, stdout: '', stderr: '' };
          }

          if (command.name === 'view' || command.name === 'info') {
            const spec = positionalArguments()[0];
            if (!spec) return { code: 1, stdout: '', stderr: 'npm error package name is required\n' };
            const resolved = await resolvePackage(spec);
            const document = {
              ...(resolved.doc || {}),
              name: resolved.doc?.name || resolved.parsed.name,
              version: resolved.version,
              ...(resolved.metadata['dist-tags'] ? { 'dist-tags': resolved.metadata['dist-tags'] } : {}),
            };
            return { code: 0, stdout: `${JSON.stringify(document)}\n`, stderr: '' };
          }

          if (command.name === 'pack') {
            const spec = positionalArguments()[0];
            if (!spec) return { code: 1, stdout: '', stderr: 'npm error package name is required\n' };
            const resolved = await resolvePackage(spec);
            const tarballUrl = resolved.doc?.dist?.tarball;
            if (!tarballUrl) throw new Error(`Missing tarball URL for ${resolved.parsed.name}@${resolved.version}`);
            const bytes = await resolved.npm.fetchTarball(tarballUrl, {
              name: resolved.parsed.name,
              version: resolved.version,
              integrity: resolved.doc?.dist?.integrity,
            });
            const filename = `${resolved.parsed.name.replace(/^@/, '').replaceAll('/', '-')}-${resolved.version}.tgz`;
            await vfs.fs.promises.writeFile(path.join(prepared.cwd, filename), bytes);
            return { code: 0, stdout: `${filename}\n`, stderr: '' };
          }

          if (command.name === 'run' || command.name === 'run-script' || command.name === 'test') {
            const scriptName = command.name === 'test' ? 'test' : commandArguments[0];
            const separator = commandArguments.indexOf('--');
            const scriptArgs = separator >= 0 ? commandArguments.slice(separator + 1) : command.name === 'test' ? [] : commandArguments.slice(1);
            return runPackageScript(scriptName, {
              cwd: prepared.cwd,
              env,
              args: scriptArgs,
              stdin: prepared.stdin,
              signal: childOptions.signal,
              timeout: childOptions.timeout,
              onStdout: childOptions.onStdout,
              onStderr: childOptions.onStderr,
            });
          }

          if (!['install', 'i', 'add'].includes(command.name)) {
            return {
              code: 1,
              stdout: '',
              stderr: `npm ${command.name || '(empty command)'} is not available in the browser runtime\n`,
            };
          }

          const specs = [];
          let requestedRegistry = null;
          let saveDev = false;
          let saveExact = false;
          let noSave = false;
          let stopOptions = false;
          for (let index = command.index + 1; index < args.length; index += 1) {
            const argument = String(args[index]);
            if (!stopOptions && argument === '--') {
              stopOptions = true;
              continue;
            }
            if (!stopOptions && argument.startsWith('--registry=')) {
              requestedRegistry = argument.slice('--registry='.length);
              continue;
            }
            if (!stopOptions && argument === '--registry') {
              requestedRegistry = String(args[++index] || '');
              continue;
            }
            if (!stopOptions && (argument === '--save-dev' || argument === '-D')) {
              saveDev = true;
              continue;
            }
            if (!stopOptions && argument === '--save-exact') {
              saveExact = true;
              continue;
            }
            if (!stopOptions && (argument === '--no-save' || argument === '--package-lock-only')) {
              noSave = true;
              continue;
            }
            if (!stopOptions && argument.startsWith('-')) {
              if (!argument.includes('=') && optionsWithValues.has(argument)) index += 1;
              continue;
            }
            specs.push(argument);
          }

          const npm = createNpm(requestedRegistry || registry);
          const packageJson = await npm.readPackageJson(prepared.cwd);
          const resolvedSpecs = specs.map((spec) => {
            const parsed = parsePackageSpec(spec);
            if (String(spec).trim() !== parsed.name) return spec;
            const declaredRange = packageJson?.devDependencies?.[parsed.name]
              || packageJson?.dependencies?.[parsed.name];
            return declaredRange ? `${parsed.name}@${declaredRange}` : spec;
          });
          const installSpecs = resolvedSpecs.length
            ? resolvedSpecs
            : Object.entries({
              ...packageJson?.dependencies,
              ...packageJson?.devDependencies,
              ...packageJson?.optionalDependencies,
            }).map(([name, range]) => `${name}@${range}`);
          const result = await npm.install(installSpecs, { cwd: prepared.cwd });
          if (!noSave && specs.length > 0) {
            if (packageJson) {
              const section = saveDev ? 'devDependencies' : 'dependencies';
              packageJson[section] ||= {};
              for (const spec of specs) {
                const { name, range } = parsePackageSpec(spec);
                const installed = result.packages.find((item) => item.name === name);
                if (!installed) continue;
                packageJson[section][name] = saveExact
                  ? installed.version
                  : range === 'latest' ? `^${installed.version}` : range;
              }
              await vfs.fs.promises.writeFile(
                path.join(prepared.cwd, 'package.json'),
                `${JSON.stringify(packageJson, null, 2)}\n`,
              );
            }
          }
          return { code: 0, stdout: '', stderr: '' };
        };

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
          execFileSync,
          execSync,
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
            try {
              return virtualAsync(file, normalized.args, hasIpcStdio
                ? { ...spawnOptions, ipc: true }
                : spawnOptions);
            } catch (error) {
              throw error;
            }
          },
          fork(modulePath, args = [], options = {}) {
            modulePath = normalizeChildModulePath(modulePath);
            const normalized = normalizeChildInvocation(modulePath, args, options, arguments.length, {
              allowNullOptions: true,
              commandName: 'modulePath',
            });
            const childOptions = { ...normalized.options, ipc: true };
            const execPath = childOptions.execPath || processObject.execPath;
            args = normalized.args;
            if (modulePath === '-e') return virtualAsync(execPath, ['-e', ...args], childOptions);
            return virtualAsync(execPath, [modulePath, ...args], childOptions);
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
    // The browser compatibility layer patches host AbortSignal methods. Keep
    // Node-side consumers isolated because Node already provides these APIs.
    const usesHostNodeGlobals = scope === globalThis
      && scope.process?.release?.name === 'node'
      && typeof scope.process?.versions?.node === 'string';
    if (!usesHostNodeGlobals) installBrowserAbortSignalCompatibility(scope);
    scope.__BNH_BROWSER_WORKERS__ ||= new Set();
    if (options.workerThread) {
      environmentData.clear();
      for (const [key, value] of options.environmentData || []) environmentData.set(key, value);
    }
    let pending = 0;
    const pendingTaskRecords = new Map();
    let nextPendingTaskId = 0;
    const publishLifecycleState = () => {
      if (!injectedProcess) return;
      injectedProcess.__bnhRuntimeLifecycle = {
        pending,
        tasks: [...pendingTaskRecords.values()].slice(-4),
      };
      injectedProcess.__bnhReportRuntimeState?.();
    };
    const trackTask = (label = null) => {
      pending += 1;
      const taskId = ++nextPendingTaskId;
      const stackLine = String(new Error().stack || '').split('\n')[2]?.trim().slice(0, 160) || null;
      pendingTaskRecords.set(taskId, {
        id: taskId,
        label: label == null ? null : String(label).slice(0, 128),
        stack: stackLine,
      });
      publishLifecycleState();
      return () => {
        pending = Math.max(0, pending - 1);
        pendingTaskRecords.delete(taskId);
        publishLifecycleState();
      };
    };
    const injectedProcess = options.processObject;
    const reportExecutePhase = (phase) => {
      if (injectedProcess) {
        injectedProcess.__bnhRuntimePhase = phase;
        injectedProcess.__bnhReportRuntimeState?.();
      }
    };
    const timerHandles = new Set();
    const rootTimers = scope.__BNH_NATIVE_TIMERS__;
    const nativeSetTimeout = rootTimers?.setTimeout || scope.setTimeout.bind(scope);
    const nativeClearTimeout = rootTimers?.clearTimeout || scope.clearTimeout.bind(scope);
    const nativeSetInterval = rootTimers?.setInterval || scope.setInterval.bind(scope);
    const nativeClearInterval = rootTimers?.clearInterval || scope.clearInterval.bind(scope);
    const nativeQueueMicrotask = typeof scope.queueMicrotask === 'function'
      ? scope.queueMicrotask.bind(scope)
      : (callback) => nativeSetTimeout(callback, 0);
    let pendingMicrotasks = 0;
    const trackedQueueMicrotask = (callback) => {
      if (typeof callback !== 'function') return nativeQueueMicrotask(callback);
      pendingMicrotasks += 1;
      try {
        nativeQueueMicrotask(() => {
          try {
            callback();
          } finally {
            pendingMicrotasks = Math.max(0, pendingMicrotasks - 1);
          }
        });
      } catch (error) {
        pendingMicrotasks = Math.max(0, pendingMicrotasks - 1);
        throw error;
      }
    };
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
    // `execute()` owns the timers installed on the browser-global surface,
    // while the process contract owns timers created through its internal
    // timer API. Injected and same-realm children can use both surfaces;
    // treating only one set as authoritative lets a pending child callback
    // disappear at the lifecycle idle check.
    const allRuntimeTimers = () => new Set([
      ...timerHandles,
      ...(processObject?._timers || []),
    ]);
    const lifecycleWaitTimer = Symbol('bnh.lifecycleWaitTimer');
    const hasReferencedRuntimeTimers = (handles) => [...handles]
      .some((handle) => !handle?.[lifecycleWaitTimer]
        && (typeof handle?.hasRef === 'function' ? handle.hasRef() : handle?._refed !== false));
    const hasLiveVirtualProcess = () => {
      const registry = scope.__BNH_VIRTUAL_PROCESS_REGISTRY__;
      const currentPid = Number(injectedProcess?.pid);
      if (registry) {
        for (const handle of registry.values()) {
          // A same-realm fallback child is registered before its entry starts.
          // Do not count that child itself as an external live process or its
          // event loop can never reach the idle shutdown condition.
          if (Number.isInteger(currentPid) && Number(handle?.pid) === currentPid) continue;
          // Same-realm cluster workers share the outer process registry, but
          // sibling workers are not children of one another. Counting a
          // same-parent sibling here makes both workers wait forever after
          // their own servers and IPC channels have closed. A subprocess
          // spawned by this worker still has this worker's pid as its ppid and
          // remains a referenced child.
          if (options.clusterWorker
            && Number(handle?.ppid) === Number(injectedProcess?.ppid)) continue;
          if (!handle.terminal && !['exited', 'failed'].includes(handle.state)) return true;
        }
      }
      for (const worker of scope.__BNH_BROWSER_WORKERS__ || []) {
        if (worker.threadId === -1) continue;
        if (worker.terminal || ['exited', 'failed'].includes(worker.state)) continue;
        if (typeof worker.hasRef === 'function' && !worker.hasRef()) continue;
        return true;
      }
      return false;
    };
    const hasReferencedIpc = () => {
      const channel = processObject?.channel;
      const hasUserIpcListener = ['message', 'disconnect'].some((name) => processObject?.listeners?.(name)
        ?.some((listener) => !listener?._bnhInternal && !listener?.__bnhInternalClusterListener));
      return Boolean(processObject?.connected && channel && channel.hasRef?.() !== false && hasUserIpcListener);
    };
    const hasReferencedWorkerParentPort = () => {
      if (!options.workerThread || !workerThreadParentPort) return false;
      return workerThreadParentPort.listenerCount?.('message') > 0
        || typeof workerThreadParentPort.onmessage === 'function';
    };
    reportExecutePhase('process-create');
    const fullProcessData = createProcess(scope, {
      ...options,
      nodeProfile: resolvedProfile,
      isPidAlive: isVirtualPidAlive,
    }, stdout, stderr, trackTask);
    reportExecutePhase('process-created');
    const processData = injectedProcess
      ? (() => {
          const processObject = fullProcessData.processObject;
          // Preserve injected process identity and capabilities (stdout, stderr, exit control, IPC)
          processObject.stdout = injectedProcess.stdout || processObject.stdout;
          processObject.stderr = injectedProcess.stderr || processObject.stderr;
          installProcessStdoutIterableSurface(processObject.stdout, processObject);
          installProcessStderrSocketSurface(processObject.stderr, processObject);
          const injectedStdin = injectedProcess.stdin;
          if (injectedStdin && [
            'readableLength', 'readableObjectMode', 'readableEncoding', 'errored',
            'closed', 'destroyed', 'readableEnded', 'drop',
          ].some((property) => !(property in injectedStdin))) {
            const wrappedStdin = Readable.wrap(injectedStdin, { objectMode: false });
            wrappedStdin.isTTY = injectedStdin.isTTY;
            processObject.stdin = wrappedStdin;
          } else {
            processObject.stdin = injectedStdin || processObject.stdin;
          }
          installProcessStdinSurface(processObject.stdin);
          let injectedExitEventEmitted = false;
          processObject.exit = (code) => {
            processObject.exitCode = Number(code) || 0;
            if (injectedExitEventEmitted) return;
            injectedExitEventEmitted = true;
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
          if (typeof injectedProcess.__bnhChildOutput === 'function') {
            processObject.__bnhChildOutput = injectedProcess.__bnhChildOutput;
          }
          processObject.connected = Boolean(injectedProcess.connected);
          processObject.disconnect = () => {
            if (typeof injectedProcess.disconnect !== 'function') return false;
            const disconnected = injectedProcess.disconnect();
            processObject.connected = Boolean(injectedProcess.connected);
            return disconnected;
          };
          processObject.channel = injectedProcess.channel || processObject.channel;
          if (typeof injectedProcess.on === 'function') {
            // Queue browser IPC until the runtime's user-facing process listeners are installed.
            const pendingInjectedMessages = [];
            let injectedMessageFlushQueued = false;
            const isInternalMessageListener = (listener) => listener?._bnhInternal
              || listener?.__bnhInternalClusterListener
              || listener?.listener?._bnhInternal
              || listener?.listener?.__bnhInternalClusterListener;
            const hasUserMessageListener = () => processObject.listeners?.('message')
              ?.some((listener) => !isInternalMessageListener(listener));
            const flushInjectedMessages = () => {
              injectedMessageFlushQueued = false;
              if (options.workerThread && typeof processObject._bnhDeliverWorkerMessage !== 'function') return;
              if (!options.workerThread && !hasUserMessageListener()) return;
              for (const [message, handle] of pendingInjectedMessages.splice(0)) {
                if (options.workerThread) processObject._bnhDeliverWorkerMessage?.(message, handle);
                else processObject.emit('message', message, handle);
              }
            };
            processObject.on('newListener', (name) => {
              if (name !== 'message' || injectedMessageFlushQueued) return;
              injectedMessageFlushQueued = true;
              queueMicrotask(flushInjectedMessages);
            });
            const onInjectedMessage = (message, handle) => {
              if (options.workerThread) {
                if (typeof processObject._bnhDeliverWorkerMessage === 'function') processObject._bnhDeliverWorkerMessage(message, handle);
                else pendingInjectedMessages.push([message, handle]);
              } else if (hasUserMessageListener()) processObject.emit('message', message, handle);
              else pendingInjectedMessages.push([message, handle]);
            };
            onInjectedMessage._bnhInternal = true;
            injectedProcess.on('message', (message, handle) => {
              onInjectedMessage(message, handle);
            });
            processObject._bnhFlushInjectedMessages = flushInjectedMessages;
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
          processObject.version = resolvedProfile.runtimeVersion;
          processObject.release = resolvedProfile.release;
          processObject.config = resolvedProfile.config;
          processObject.features = resolvedProfile.features;
          processObject.versions = browserProcessVersions(scope, resolvedProfile);
          return { processObject, setTimer: fullProcessData.setTimer, clearTimer: fullProcessData.clearTimer };
        })()
      : fullProcessData;
    reportExecutePhase('process-bound');
    const processObject = processData.processObject;
    const childActivity = processObject.__bnhChildActivity ||= {
      launched: 0,
      completed: 0,
      failed: 0,
      first: null,
      last: null,
    };
    // Builtins such as node:test attach their run state while the runtime
    // process is being constructed. Mirror that state onto an injected child
    // immediately so both natural and exceptional terminal paths can report
    // it, including runners that finish before the lifecycle idle loop.
    if (injectedProcess && processObject.__bnhNodeTestState) {
      injectedProcess.__bnhNodeTestState = processObject.__bnhNodeTestState;
    }
    if (injectedProcess) injectedProcess.__bnhChildActivity = childActivity;
    if (typeof injectedProcess?.__bnhNetworkEvent === 'function') {
      processObject.__bnhNetworkEvent = injectedProcess.__bnhNetworkEvent;
    }
    if (options.stdin !== undefined && processObject.stdin?.push) {
      processObject.stdin.push(options.stdin);
      processObject.stdin.push(null);
    }
    Object.defineProperty(processObject, '_bnhTraceEventsUnavailable', {
      configurable: true,
      enumerable: false,
      value: Boolean(options.workerThread)
        || String(options.entry || '').startsWith('/node/.bnh-worker-eval-'),
    });
    processObject._bnhShouldRunUnref = () => pending > 0
      || hasReferencedTimers(allRuntimeTimers())
      || hasLiveVirtualProcess()
      || hasReferencedIpc()
      || hasReferencedWorkerParentPort();
    if (Array.isArray(options.execArgv)) processObject.execArgv = [...options.execArgv];
    const setTimer = processData.setTimer;
    const clearTimer = processData.clearTimer;
    vfs.setTaskTracker?.(trackTask);
    vfs.setWarningEmitter?.(processObject.emitWarning?.bind(processObject));
    vfs.setWatcherOwner?.(processObject);
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
          const pendingMessages = [];
          let pendingMessageFlushQueued = false;
          const hasMessageListener = () => parentPort.listenerCount('message') > 0
            || typeof assignedOnMessage === 'function';
          const flushPendingMessages = () => {
            pendingMessageFlushQueued = false;
            if (!hasMessageListener()) return;
            for (const [value, handle] of pendingMessages.splice(0)) {
              parentPort.emit('message', value, handle);
              assignedOnMessage?.({
                type: 'message',
                data: value,
                target: parentPort,
                currentTarget: parentPort,
                origin: '',
                lastEventId: '',
                source: null,
                ports: [],
              });
            }
          };
          const queuePendingMessageFlush = () => {
            if (pendingMessageFlushQueued) return;
            pendingMessageFlushQueued = true;
            queueMicrotask(flushPendingMessages);
          };
          const onMessage = (value, handle) => {
            if (value?.__bnhThreadMessage || value?.__bnhThreadMessageResult) return;
            const adaptedValue = adaptWorkerData(value, scope);
            if (hasMessageListener()) {
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
            } else {
              pendingMessages.push([adaptedValue, handle]);
            }
          };
          onMessage._bnhInternal = true;
          processObject.on('message', onMessage);
          processObject._bnhDeliverWorkerMessage = (value, handle) => {
            const adaptedValue = adaptWorkerData(value, scope);
            if (hasMessageListener()) {
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
            } else {
              pendingMessages.push([adaptedValue, handle]);
            }
          };
          processObject._bnhFlushInjectedMessages?.();
          parentPort.on('newListener', (name) => {
            if (name === 'message') {
              processObject._bnhFlushInjectedMessages?.();
              queuePendingMessageFlush();
            }
          });
          parentPort.postMessage = (value, transferList) => processObject.send(value, transferList);
          parentPort.start = () => parentPort;
          parentPort.ref = () => parentPort;
          parentPort.unref = () => parentPort;
          Object.defineProperty(parentPort, 'onmessage', {
            configurable: true,
            get: () => assignedOnMessage,
            set: (listener) => {
              assignedOnMessage = typeof listener === 'function' ? listener : null;
              if (assignedOnMessage) queuePendingMessageFlush();
            },
          });
          parentPort.close = () => {
            processObject.removeListener('message', onMessage);
            processObject.disconnect?.();
          };
          return parentPort;
        })()
      : null;
    const onWorkerMessage = (message) => {
      if (!message?.__bnhThreadMessage) return;
      processObject.emit('workerMessage', message.value, Number(message.source));
    };
    onWorkerMessage._bnhInternal = true;
    processObject.on('message', onWorkerMessage);
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
      const vfsUpdateBridge = createVfsUpdateBridge();
      const child = createBrowserProcess({
        scope,
        nodeVersion: resolvedProfile.id,
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
          nodeVersion: resolvedProfile.id,
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
        vfsUpdatePort: vfsUpdateBridge.port,
        workerDataTransferList,
      });
      child.once('exit', () => {
        vfsUpdateBridge.close();
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
      const workerEvents = new EventEmitter();
      const forwardedEvents = new Set();
      const originalOn = worker.on?.bind(worker);
      const originalEmit = worker.emit?.bind(worker);
      const forwardEvent = (name) => {
        if (forwardedEvents.has(name) || typeof originalOn !== 'function') return;
        forwardedEvents.add(name);
        originalOn(name, (...args) => workerEvents.emit(name, ...args));
      };
      worker.on = (name, listener) => { forwardEvent(name); workerEvents.on(name, listener); return worker; };
      worker.addListener = worker.on;
      worker.prependListener = (name, listener) => {
        forwardEvent(name);
        workerEvents.prependListener(name, listener);
        return worker;
      };
      worker.once = (name, listener) => { forwardEvent(name); workerEvents.once(name, listener); return worker; };
      worker.prependOnceListener = (name, listener) => {
        forwardEvent(name);
        workerEvents.prependOnceListener(name, listener);
        return worker;
      };
      worker.emit = (name, ...args) => {
        const result = originalEmit?.(name, ...args) ?? false;
        if (!forwardedEvents.has(name)) workerEvents.emit(name, ...args);
        return result;
      };
      worker.off = (name, listener) => { workerEvents.off(name, listener); return worker; };
      worker.removeListener = worker.off;
      worker.removeAllListeners = (name) => { workerEvents.removeAllListeners(name); return worker; };
      worker.listeners = (name) => workerEvents.listeners(name);
      worker.rawListeners = (name) => workerEvents.rawListeners(name);
      worker.listenerCount = (name) => workerEvents.listenerCount(name);
      worker.eventNames = () => workerEvents.eventNames();
      worker.setMaxListeners = (value) => { workerEvents.setMaxListeners(value); return worker; };
      worker.getMaxListeners = () => workerEvents.getMaxListeners();
      Object.defineProperties(worker, {
        _events: {
          configurable: true,
          enumerable: true,
          get: () => workerEvents._events,
        },
        _eventsCount: {
          configurable: true,
          enumerable: true,
          get: () => workerEvents._eventsCount,
        },
        _maxListeners: {
          configurable: true,
          enumerable: true,
          get: () => workerEvents._maxListeners,
          set: (value) => { workerEvents._maxListeners = value; },
        },
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
      [Symbol.for('nodejs.asyncDispose')]: {
        configurable: true,
        writable: true,
        async value() {
          await this.terminate();
        },
      },
    });
    Object.setPrototypeOf(RuntimeWorker.prototype, EventEmitter.prototype);
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
    let x509Module = null;
    const runtimeFetchRef = { current: null };
    const builtins = makeBuiltins(
      processObject,
      (name, importer = entry, processOverride) => loadModule(
        name,
        importer,
        false,
        processOverride || scope.__bnhActiveProcess || scope.process || processObject,
      ),
      diagnosticsChannels,
      options,
      performancePrimitives,
      trackTask,
      stdout,
      stderr,
      (pathname) => vfs.read(pathname),
      entry,
      runtimeFetchRef,
    );
    reportExecutePhase('builtins-ready');
    if (options.workerThread || String(options.entry || '').startsWith('/node/.bnh-worker-eval-')) {
      Object.defineProperty(builtins, 'trace_events', {
        configurable: true,
        enumerable: true,
        get() { throw traceEventsUnavailableError(); },
      });
    }
    builtins.sys = builtins.util;
    x509Module = Object.freeze({
      X509Certificate: builtins.crypto.X509Certificate,
      InternalX509Certificate: builtins.crypto.X509Certificate,
      isX509Certificate: (value) => value instanceof builtins.crypto.X509Certificate,
    });
    builtins['internal/crypto/x509'] = x509Module;
    builtins['internal/crypto/keys'] = createKeyObjectContract(Buffer);
    processObject.getBuiltinModule = function getBuiltinModule(id) {
      if (typeof id !== 'string') throw moduleArgumentTypeError('id', 'of type string', id);
      const name = builtinName(id);
      return BUILTIN_NAMES.includes(name) ? builtins[name] : undefined;
    };
    reportExecutePhase('builtin-api-ready');
    builtins.module._cache = new Map();
    builtins.module._main = null;
    builtins.module._resolve = (name, parent) => {
      const importer = typeof parent === 'string' ? parent : parent?.filename || entry;
      return BUILTIN_NAMES.includes(builtinName(name)) ? name : esmLoader.resolveRequire(name, importer);
    };
    builtins.module._load = (name, parent) => {
      if (String(name).startsWith('file:') && String(name).endsWith('.mjs')) {
        const error = new Error(`Cannot find module '${name}'`);
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      const builtin = builtinName(name);
      const importer = typeof parent === 'string' ? parent : parent?.filename || entry;
      const moduleMock = processObject.__bnhModuleMocks?.get(name)
        || processObject.__bnhModuleMocks?.get(`node:${builtin}`);
      if (moduleMock?.active) return moduleMock.getCjsValue();
      if (builtin === 'trace_events' && processObject._bnhTraceEventsUnavailable) {
        throw traceEventsUnavailableError();
      }
      if (BUILTIN_NAMES.includes(builtin)) return builtins[builtin] ?? {};
      return loadModule(name, importer, false, processObject);
    };
    const streamWebApi = builtins['stream/web'];
    reportExecutePhase('stream-api-ready');
    installBlobStreamClass(() => streamWebApi.ReadableStream);
    reportExecutePhase('blob-stream-ready');
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
    const responseFromNodeResponse = (response, url, method = 'GET') => new Promise((resolve, reject) => {
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
        try {
          processObject.__bnhNetworkEvent?.({
            source: 'guest-http',
            method: String(method || 'GET').toUpperCase(),
            url: String(url || ''),
            phase: 'body',
            status: Number(response.statusCode || 0),
            bodyBytes: body.byteLength,
            bodyExcerpt: new (scope.TextDecoder || TextDecoder)().decode(body).slice(0, 512),
          });
        } catch {
          // Network diagnostics must never change HTTP response delivery.
        }
        const result = new scope.Response(body, {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: response.headers,
        });
        Object.defineProperty(result, '__bnhURL', { configurable: true, value: url });
        if (response._response?.body?._bnhTerminated === true) {
          Object.defineProperty(result, '__bnhTerminated', { configurable: true, value: true });
        }
        resolve(result);
      });
    });
    const virtualHttpFetch = (input, init = {}) => {
      const url = String(input?.url || input);
      if (!/^https?:/i.test(url)) return nativeFetch(input, init);
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
          responseFromNodeResponse(response, url, init.method).then(resolve, reject);
        });
        request.once('error', reject);
        request.end(init.body);
      });
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
        // Resolve the logical owner at request time. A CommonJS child can
        // outlive the synchronous module bootstrap, so capturing the runtime
        // process when the builtins are created would attach its network
        // work to the parent and allow the child to reach beforeExit while
        // npm/Node is still consuming the response body.
        const activeFetchProcess = scope.__bnhActiveProcess || scope.process || processObject;
        const env = processObject.env || {};
        const target = String(input?.url || input);
        const method = String(init.method || 'GET').toUpperCase();
        const httpClientFetch = Boolean(scope.__BNH_HTTP_CLIENT_FETCH__);
        let targetOrigin = null;
        try { targetOrigin = new scope.URL(target).origin; } catch { /* virtual fetch reports the normal URL error */ }
        const reportNetwork = (event) => {
          try {
            const sink = options.onNetwork || processObject.__bnhNetworkEvent;
            if (typeof sink !== 'function') return;
            sink({
              source: 'guest-fetch',
              method,
              url: target,
              ...event,
            });
          } catch {
            // Observability must never change the guest request's behavior.
          }
        };
      const fetchWithTelemetry = (transport, operation) => {
        const sink = options.onNetwork || processObject.__bnhNetworkEvent;
        if (typeof sink !== 'function') return operation();
        const startTime = Number(scope.performance?.now?.()) || 0;
        let result;
        try {
          reportNetwork({ phase: 'request', transport, startTime });
          result = operation();
        } catch (error) {
          reportNetwork({
            phase: 'error',
            transport,
            duration: Math.max(0, (Number(scope.performance?.now?.()) || startTime) - startTime),
            error: { name: error?.name, message: String(error?.message || error), code: error?.code || null },
          });
          throw error;
        }
        void Promise.resolve(result).then(
          (response) => {
            const contentLength = response?.headers?.get?.('content-length');
            reportNetwork({
              phase: 'response',
              transport,
              status: Number(response?.status || 0),
              statusType: typeof response?.status,
              statusValue: String(response?.status ?? ''),
              ok: Boolean(response?.ok),
              contentLength: contentLength === null || contentLength === undefined ? null : Number(contentLength) || 0,
              duration: Math.max(0, (Number(scope.performance?.now?.()) || startTime) - startTime),
            });
          },
          (error) => {
            reportNetwork({
              phase: 'error',
              transport,
              duration: Math.max(0, (Number(scope.performance?.now?.()) || startTime) - startTime),
              error: { name: error?.name, message: String(error?.message || error), code: error?.code || null },
            });
          },
        );
        return result;
      };
      const npmRegistryOrigins = new Set([
        'https://registry.npmjs.org',
        ...(capabilities?.manifest?.npm?.registries || []),
      ]);
      const isNpmRegistryRequest = npmRegistryOrigins.has(targetOrigin)
        && ['GET', 'HEAD'].includes(method);
      const npmProxyOrigin = typeof scope.location?.origin === 'string'
        && /^https?:$/i.test(scope.location.protocol || '')
        ? scope.location.origin
        : null;
      const npmProxyUrl = npmProxyOrigin && isNpmRegistryRequest
        ? `${npmProxyOrigin}/__npm_proxy__/${encodeURIComponent(target)}`
        : null;
      const canCacheNpmRequest = method === 'GET' && npmRegistryOrigins.has(targetOrigin)
        && typeof scope.caches?.open === 'function';
      let npmCachePromise;
      const getNpmCache = () => {
        if (!canCacheNpmRequest) return Promise.resolve(null);
        npmCachePromise ||= Promise.resolve(scope.caches.open('bnh-npm-registry-v1')).catch(() => null);
        return npmCachePromise;
      };
      const cacheNpmFetch = (operation) => {
        if (!canCacheNpmRequest) return operation();
        return getNpmCache().then((cache) => {
          if (!cache) return operation();
          return Promise.resolve(cache.match(target)).catch(() => null).then((cached) => {
            if (cached) {
              reportNetwork({
                phase: 'cache-hit',
                transport: 'npm-cache',
                status: Number(cached.status || 0),
                ok: Boolean(cached.ok),
                contentLength: Number(cached.headers?.get?.('content-length') || 0) || null,
              });
              return cached;
            }
            const result = operation();
            void Promise.resolve(result).then((response) => {
              if (!response?.ok || typeof response.clone !== 'function') return;
              let copy;
              try { copy = response.clone(); } catch { return; }
              void Promise.resolve(cache.put(target, copy))
                .then(() => reportNetwork({ phase: 'cache-store', transport: 'npm-cache' }))
                .catch(() => {});
            }).catch(() => {});
            return result;
          });
        });
      };
      const fetchNetwork = () => {
        if (httpClientFetch) return fetchWithTelemetry('browser-native', () => nativeFetch(input, init));
        if (npmProxyUrl) {
          // npm registry responses are cross-origin and many registry routes do
          // not opt into CORS. Use the same-origin download proxy when the
          // runtime is hosted in a browser, while keeping the guest URL in the
          // telemetry and cache identity.
          return fetchWithTelemetry('npm-proxy', () => nativeFetch(npmProxyUrl, init));
        }
        const useEnvProxy = /^(?:1|true)$/i.test(String(env.NODE_USE_ENV_PROXY || ''));
        const targetIsHttps = /^https:/i.test(target);
        const proxyUrl = targetIsHttps
          ? (env.https_proxy || env.HTTPS_PROXY)
          : (env.http_proxy || env.HTTP_PROXY);
        if (useEnvProxy && proxyUrl && /^https?:/i.test(target)) {
          return fetchWithTelemetry('http-proxy', () => virtualProxyFetch(input, init, proxyUrl));
        }
        const networkGrant = capabilities?.manifest?.network;
        if (targetOrigin && networkGrant?.origins?.includes(targetOrigin)
          && networkGrant.methods.includes(method)) {
          // This is the browser-native egress route granted to the guest. It
          // is required by stock tools such as Next.js' own WASM downloader
          // and does not rewrite or intercept the guest request.
          return fetchWithTelemetry('browser-native', () => nativeFetch(input, init));
        }
        return fetchWithTelemetry('virtual-network', () => virtualHttpFetch(input, init));
      };
      const fetchTracker = activeFetchProcess?._bnhTaskTracker
        || (activeFetchProcess === processObject ? trackTask : null);
      const releaseFetchTask = typeof fetchTracker === 'function'
        ? fetchTracker('fetch')
        : null;
      let fetchTaskReleased = false;
      const releaseFetch = () => {
        if (fetchTaskReleased) return;
        fetchTaskReleased = true;
        releaseFetchTask?.();
      };
      const holdForResponseBody = (response) => {
        const body = response?.body;
        if (!body || typeof body.pipeTo !== 'function') {
          releaseFetch();
          return response;
        }
        const originalPipeTo = body.pipeTo;
        let restored = false;
        const restorePipeTo = () => {
          if (restored) return;
          restored = true;
          try { body.pipeTo = originalPipeTo; } catch { /* host streams may be sealed */ }
        };
        try {
          body.pipeTo = (...args) => {
            let result;
            try {
              result = originalPipeTo.apply(body, args);
            } catch (error) {
              releaseFetch();
              restorePipeTo();
              throw error;
            }
            return Promise.resolve(result).finally(() => {
              releaseFetch();
              restorePipeTo();
            });
          };
        } catch {
          releaseFetch();
        }
        return response;
      };
      let result;
      try {
        result = cacheNpmFetch(fetchNetwork);
      } catch (error) {
        releaseFetch();
        throw error;
      }
      return Promise.resolve(result).then(holdForResponseBody, (error) => {
        releaseFetch();
        throw error;
      });
    };
      runtimeFetchRef.current = runtimeFetch;

    builtins.worker_threads = workerThreads;
    const cache = Object.create(null);
    const cjsResolutionCache = new Map();
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
      const pending = processObject.__bnhModuleRegistrationPromises;
      if (!processObject.__bnhModuleRegistrationLoading && pending?.length) {
        return Promise.all([...pending]).then(() => invoke(hooks.length - 1, value, context));
      }
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
    const moduleMockFor = (specifier, importer = entry, processObj = processObject) => {
      const state = processObj.__bnhModuleMocks || processObject.__bnhModuleMocks;
      if (!state) return undefined;
      const raw = String(specifier);
      const name = builtinName(raw);
      const candidates = [raw, name, raw.startsWith('file:') ? fileURLToPath(raw) : undefined];
      if (raw.startsWith('/')) candidates.push(raw);
      try { candidates.push(resolveFile(raw, importer, processObj)); } catch { /* resolution errors belong to the normal loader */ }
      return candidates.filter((candidate) => candidate !== undefined)
        .map((candidate) => state.get(candidate))
        .find((mock) => mock?.active);
    };

    const loadModule = (specifier, importer = entry, skipResolve = false, ownerProcess = processObject) => {
      const processObj = ownerProcess || processObject;
      const moduleCache = processObj === processObject
        ? cache
        : (processObj.__bnhEsmCjsCache ||= Object.create(null));
      const activeModuleApi = processObj === processObject
        ? builtins.module
        : processObj.__bnhModuleApi || processObj.__bnhModuleApiFactory?.()
          || builtins.module;
      const runInProcessContext = (callback) => {
        const previousProcess = scope.process;
        const previousActiveProcess = scope.__bnhActiveProcess;
        scope.process = processObj;
        scope.__bnhActiveProcess = processObj;
        try { return callback(); }
        finally {
          scope.__bnhActiveProcess = previousActiveProcess;
          scope.process = previousProcess;
        }
      };
      if (String(specifier).startsWith('file:') && String(specifier).endsWith('.mjs')) {
        const error = new Error(`Cannot find module '${specifier}'`);
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      const mock = moduleMockFor(specifier, importer, processObj);
      if (mock?.active) return mock.getCjsValue();
      const shimPath = String(specifier).startsWith('file:') ? fileURLToPath(specifier) : specifier;
      if (x509Module && shimPath === '/node/lib/internal/crypto/x509.js') return x509Module;
      if (String(specifier).startsWith('data:text/javascript')) {
        const dataPath = String(specifier);
        const comma = dataPath.indexOf(',');
        const source = decodeURIComponent(dataPath.slice(comma + 1).split('#')[0]);
        const dataModule = { exports: {} };
        const dataRequire = (child) => loadModule(child, dataPath, false, processObj);
        runInProcessContext(() => runCommonJSWrapper(
          moduleSynchronousEsmSource(source, dataPath),
          dataPath,
          [dataRequire, dataModule, dataModule.exports, dataPath, '/', undefined],
          null,
          processObj,
        ));
        return dataModule.exports;
      }
      if (shimPath === '/node/lib/dgram.js') return processObj._bnhBuiltinOverrides?.dgram || builtins.dgram;
      if (shimPath === '/node/lib/cluster.js') return processObj._bnhBuiltinOverrides?.cluster || builtins.cluster;
      const name = builtinName(specifier);
      if (name === 'internal/modules/esm/resolve') return internalEsmResolve;
      if (name === 'trace_events' && processObj._bnhTraceEventsUnavailable) {
        throw traceEventsUnavailableError();
      }
      if (name === 'sys' && !sysWarningEmitted) {
        sysWarningEmitted = true;
        processObj.emitWarning?.('sys is deprecated. Use util instead.', {
          code: 'DEP0025',
          type: 'DeprecationWarning',
        });
      }
      if (name === 'repl') return ensureReplDispose(loadModule('/node/lib/repl.js', importer, false, processObj));
      if (BUILTIN_NAMES.includes(name)) {
        if (name === 'internal/test/binding') emitInternalTestBindingWarning(processObj);
        if (name === 'dns') scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ = Math.max(1, Number(scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ || 0));
        const context = moduleHookContext(importer);
        const resolved = runModuleHook('resolve', specifier, context, (currentSpecifier) => ({
          url: `node:${builtinName(currentSpecifier)}`,
          format: 'builtin',
        }));
        const url = resolved?.url || `node:${name}`;
        const loaded = runModuleHook('load', url, context, () => ({ format: 'builtin', source: null }));
        if (loaded?.format === 'builtin') {
          return processObj._bnhBuiltinOverrides?.[builtinName(url)]
            ?? (builtinName(url) === 'process' ? processObj : builtins[builtinName(url)] ?? {});
        }
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
          const overrideRequire = (specifier) => loadModule(specifier, importer, false, processObj);
          runInProcessContext(() => runCommonJSWrapper(
            source,
            url,
            [overrideRequire, overrideModule, overrideModule.exports, url, '/node', undefined],
            activeModuleApi.wrapper,
            processObj,
          ));
          return overrideModule.exports;
        }
        return processObj._bnhBuiltinOverrides?.[name]
          ?? (name === 'process' ? processObj : builtins[name] ?? {});
      }
      const context = moduleHookContext(importer);
      const resolutionCache = processObj === processObject
        ? cjsResolutionCache
        : (processObj.__bnhCjsResolutionCache ||= new Map());
      const requestCacheKey = skipResolve
        ? null
        : `${typeof importer === 'string' ? importer : importer?.filename || entry}\x00${String(specifier)}`;
      const requestCachedPath = requestCacheKey ? resolutionCache.get(requestCacheKey) : null;
      if (requestCachedPath && Object.hasOwn(moduleCache, requestCachedPath)) {
        return moduleCache[requestCachedPath].exports;
      }
      const resolvedResult = skipResolve
        ? {
            url: specifier.startsWith('file:') ? specifier : pathToFileURL(specifier).href,
            format: specifier.endsWith('.json') ? 'json' : isRuntimeEsmModule(specifier, processObj.execArgv) ? 'module' : 'commonjs',
          }
        : runModuleHook('resolve', specifier, context, (currentSpecifier) => {
            const candidate = esmLoader.resolve(currentSpecifier, importer, ['node', 'require']);
            if (candidate.startsWith('http:') || candidate.startsWith('https:')) {
              return { url: candidate, format: 'module' };
            }
            if (candidate.startsWith('data:')) {
              return { url: candidate, format: 'module' };
            }
            return {
              url: pathToFileURL(candidate).href,
              format: candidate.endsWith('.json') ? 'json' : isRuntimeEsmModule(candidate, processObj.execArgv) ? 'module' : 'commonjs',
            };
          });
      if (resolvedResult?.url?.startsWith('node:') && resolvedResult.shortCircuit !== true) {
        const error = new Error('"shortCircuit" must be true when a resolve hook does not call nextResolve');
        error.code = 'ERR_INVALID_RETURN_PROPERTY_VALUE';
        throw error;
      }
      const resolvedURL = resolvedResult?.url || pathToFileURL(resolveFile(specifier, importer, processObj)).href;
      let resolved = resolvedURL.startsWith('file:') ? fileURLToPath(resolvedURL) : resolvedURL;
      if (requestCacheKey && resolved.startsWith('/')) resolutionCache.set(requestCacheKey, resolved);
      if (isRuntimeEsmModule(resolved, processObj.execArgv) && isRequireEsmEnabled(processObj)) {
        const cachedNamespace = getEsmNamespace(resolved, processObj);
        if (cachedNamespace) {
          if (!Object.hasOwn(cachedNamespace, 'default') || Object.hasOwn(cachedNamespace, '__esModule')) {
            return cachedNamespace;
          }
          const requiredNamespace = { ...cachedNamespace };
          Object.defineProperty(requiredNamespace, '__esModule', { value: true, enumerable: true });
          Object.defineProperty(requiredNamespace, Symbol.toStringTag, { value: 'Module' });
          return requiredNamespace;
        }
      }
      if (isNativeAddonBuildPath(resolved) || (resolved.endsWith('.node') && addonsDisabled(processObj))) {
        rejectNativeAddon(nativeAddonPath(resolved), processObj);
      }
      if (Object.hasOwn(moduleCache, resolved)) {
        return moduleCache[resolved].exports;
      }
      let loaded;
      try {
        loaded = runModuleHook('load', resolvedURL, context, (url) => {
          const candidate = url.startsWith('file:') ? fileURLToPath(url) : url;
          // An explicit missing .node path is still a module-resolution
          // failure. Only an existing native boundary should reach the
          // unsupported-addon contract; otherwise vfs.read() supplies the
          // normal MODULE_NOT_FOUND/ERR_MODULE_NOT_FOUND error.
          if (candidate.endsWith('.node') && vfs.files.has(candidate)) {
            rejectNativeAddon(candidate, processObj);
          }
          const source = vfs.read(candidate);
          return {
            url,
            format: candidate.endsWith('.json') ? 'json' : isRuntimeEsmModule(candidate, processObj.execArgv) ? 'module' : 'commonjs',
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
          if (resolved.endsWith('.node')) {
            if (!addonsDisabled(processObj, resolved)) {
              const fileBytes = vfs.readBytes?.(resolved) || vfs.read(resolved);
              const rawBytes = fileBytes instanceof Uint8Array
                ? fileBytes
                : fileBytes instanceof ArrayBuffer
                  ? new Uint8Array(fileBytes)
                  : (fileBytes && fileBytes.buffer)
                    ? new Uint8Array(fileBytes.buffer, fileBytes.byteOffset || 0, fileBytes.byteLength)
                    : new TextEncoder().encode(String(fileBytes || ''));
              if (isWasmModuleBytes(rawBytes)) {
                const exports = loadWasmAddon(rawBytes, { name: path.basename(resolved, '.node') });
                moduleCache[resolved] = { exports };
                return exports;
              }
            }
            rejectNativeAddon(resolved, processObj);
          }
          if (Object.hasOwn(moduleCache, resolved)) {
            const cachedExports = moduleCache[resolved].exports;
            if (loaded?.format === 'module' && cachedExports && Object.hasOwn(cachedExports, 'default')
              && !Object.hasOwn(cachedExports, '__esModule')) {
              Object.defineProperty(cachedExports, '__esModule', { value: true, enumerable: true });
            }
            return cachedExports;
          }
      const source = loaded?.source ?? vfs.read(resolved);
      const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
      const compileText = text;
          if (resolved.endsWith('.mjs')
            && (esmSourceHasTopLevelAwait(text) || esmGraphRequiresAsync(resolved))) {
            throw requireAsyncEsmError(resolved, importer);
          }
      const parentModule = typeof importer === 'string' ? moduleCache[importer] : importer;
      const module = new activeModuleApi(resolved, parentModule || null);
      module.filename = resolved;
      module.paths = moduleSearchPaths(resolved);
      if (!mainModule && resolved === entry) {
        mainModule = module;
        processObj.mainModule = module;
      }
      activeModuleApi._main = mainModule;
      moduleCache[resolved] = module;
      activeModuleApi._cache = moduleCache;
      if (resolved.endsWith('.json')) module.exports = JSON.parse(text);
      else {
        const require = (name) => loadModule(name, resolved, false, processObj);
        require.resolve = (name) => BUILTIN_NAMES.includes(builtinName(name))
          ? name
          : esmLoader.resolveRequire(name, resolved);
        require.main = mainModule;
        require.cache = moduleCache;
        require.extensions = activeModuleApi._extensions;
        module.require = require;
        try {
          const extensionHandler = activeModuleApi._extensions?.[path.extname(resolved)];
          if (typeof extensionHandler === 'function' && loaded?.format !== 'module') {
            // CommonJS consumers can replace require.extensions handlers to
            // install a module-local require (proxyquire is one example).
            // Invoke the active handler at the same boundary as Node's CJS
            // loader instead of bypassing it with a direct _compile call.
            runInProcessContext(() => extensionHandler(module, resolved));
          } else {
            runInProcessContext(() => module._compile(
              compileText,
              resolved,
              loaded?.format === 'module' || moduleHasStaticEsmSyntax(compileText) ? 'module' : loaded?.format,
            ));
          }
        } catch (error) {
          throw error;
        }
      }
      module.loaded = true;
      if (loaded?.format === 'module' && module.exports && Object.hasOwn(module.exports, 'default')
        && !Object.hasOwn(module.exports, '__esModule')) {
        Object.defineProperty(module.exports, '__esModule', { value: true, enumerable: true });
      }
      if (loaded?.format === 'module') setEsmNamespace(resolved, processObj, module.exports);
      if (loaded?.format === 'commonjs' || (!loaded?.format && !resolved.endsWith('.json'))) {
        const exportNames = cjsStaticExportNames(text);
        for (const match of text.matchAll(/\bmodule\.exports\s*=\s*require\(\s*(['\"])(.*?)\1\s*\)/g)) {
          try {
            const child = esmLoader.resolve(match[2], resolved, ['node', 'require']);
            const childSource = vfs.read(child);
            for (const name of cjsStaticExportNames(typeof childSource === 'string'
              ? childSource : new TextDecoder().decode(childSource))) exportNames.add(name);
            } catch { /* static metadata is best effort */ }
        }
        for (const match of text.matchAll(/\b(?:var|let|const)\s+([$_A-Za-z][$_\w]*)\s*=\s*require\(\s*(['\"])(.*?)\2\s*\)/g)) {
          if (!text.includes(`Object.keys(${match[1]})`)) continue;
          try {
            const child = esmLoader.resolve(match[3], resolved, ['node', 'require']);
            const childSource = vfs.read(child);
            for (const name of cjsStaticExportNames(typeof childSource === 'string'
              ? childSource : new TextDecoder().decode(childSource))) exportNames.add(name);
          } catch { /* static metadata is best effort */ }
        }
        if (module.exports && (typeof module.exports === 'object' || typeof module.exports === 'function')
          && exportNames.size > 0) cjsExportMetadata.set(module.exports, [...exportNames]);
      }
      return module.exports;
    };
    Object.defineProperty(builtins, 'repl', {
      configurable: true,
      enumerable: true,
      get: () => ensureReplDispose(loadModule('/node/lib/repl.js', entry)),
    });
    const esmLoader = createModuleLoader({
      files: {
        has: (pathname) => vfs.files.has(pathname),
        get: (pathname) => vfs.read(pathname),
      },
      builtins,
      globalObject: scope,
      evaluateCommonJS: (specifier, importer, processOverride) => loadModule(
        specifier,
        importer,
        true,
        processOverride || processObject,
      ),
      resolveBuiltin: (name, processOverride) => processOverride?._bnhBuiltinOverrides?.[name]
        ?? (name === 'process' ? processOverride : undefined),
      runModuleHook,
      defaultModuleType: processObject.execArgv?.some(
        (argument) => String(argument) === '--experimental-default-type=module',
      ) ? 'module' : 'commonjs',
    });
    processObject.__bnhModuleResolve = (specifier, importer) => (
      esmLoader.resolveWithHooks(specifier, importer)
    );
    processObject.__bnhModuleImport = (specifier, importer, options, ownerProcess = processObject) => {
      const release = ownerProcess?._bnhTaskTracker?.() || trackTask();
      let importPromise;
      try {
        importPromise = esmLoader.import(specifier, importer, {}, options, ownerProcess);
      } catch (error) {
        release();
        throw error;
      }
      const importResult = Promise.resolve(importPromise);
      return registerAsyncCompletion(importResult, release);
    };
    const activateModuleRegistration = (registration) => {
      if (registration.activation) return registration.activation;
      const activation = (async () => {
        processObject.__bnhModuleRegistrationLoading = true;
        const registrationParent = registration.parentURL || entry;
        try {
          const hook = await esmLoader.import(registration.specifier, registrationParent, {}, undefined, processObject);
          await hook?.initialize?.(registration.options?.data);
          const hooks = processObject.__bnhModuleHooks || [];
          hooks.push({ resolve: hook?.resolve, load: hook?.load });
          processObject.__bnhModuleHooks = hooks;
        } finally {
          processObject.__bnhModuleRegistrationLoading = false;
        }
      })();
      registration.activation = activation;
      const pending = processObject.__bnhModuleRegistrationPromises || [];
      pending.push(activation);
      processObject.__bnhModuleRegistrationPromises = pending;
      return activation;
    };
    processObject.__bnhActivateModuleRegistration = activateModuleRegistration;
    builtins.module._bnhSetSyncBuiltinESMExports(esmLoader.syncBuiltinESMExports);
    const loadModuleRegistrations = async () => {
      const registrations = processObject.__bnhModuleRegistrations || [];
      processObject.__bnhModuleRegistrations = [];
      for (const registration of registrations) await activateModuleRegistration(registration);
    };
    const importPreloads = async () => {
      const execArgv = processObject.execArgv || [];
      const preloadImporter = path.posix.join(processObject.cwd?.() || '/node', '.bnh-preload.mjs');
      // Register experimental loader hooks before evaluating --import modules.
      // The browser ESM evaluator has no native Node loader chain; the
      // browser-native module loader invokes these hooks explicitly for
      // remote URL graphs.
      for (let index = 0; index < execArgv.length; index += 1) {
        const argument = String(execArgv[index]);
        const loader = argument === '--loader' || argument === '--experimental-loader'
          ? execArgv[++index]
          : argument.startsWith('--loader=')
            ? argument.slice('--loader='.length)
            : argument.startsWith('--experimental-loader=')
              ? argument.slice('--experimental-loader='.length)
              : undefined;
        if (loader === undefined) continue;
        const hook = await esmLoader.import(String(loader), preloadImporter, {}, undefined, processObject);
        const hooks = processObject.__bnhModuleHooks || [];
        hooks.push({ resolve: hook?.resolve, load: hook?.load });
        processObject.__bnhModuleHooks = hooks;
      }
      for (let index = 0; index < execArgv.length; index += 1) {
        const argument = String(execArgv[index]);
        const preload = argument === '--import'
          ? execArgv[++index]
          : argument.startsWith('--import=') ? argument.slice('--import='.length) : undefined;
        if (preload !== undefined) await esmLoader.import(String(preload), preloadImporter, {}, undefined, processObject);
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
      AsyncLocalStorage: scope.AsyncLocalStorage,
      WebAssembly: scope.WebAssembly,
      URL: scope.URL,
      URLSearchParams: scope.URLSearchParams,
      setTimeout: scope.setTimeout,
      clearTimeout: scope.clearTimeout,
      setInterval: scope.setInterval,
      clearInterval: scope.clearInterval,
      setImmediate: scope.setImmediate,
      clearImmediate: scope.clearImmediate,
      queueMicrotask: scope.queueMicrotask,
      fetch: scope.fetch,
      __bnh: scope.__bnh,
      __BNH_VFS__: scope.__BNH_VFS__,
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
    // HTTP compatibility instances retain the run's process object across
    // asynchronous response delivery. Publish the matching console on that
    // object before user modules can construct a request.
    processObject._bnhConsole = childConsole;
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
    const earlyUnhandledRejections = new WeakSet();
    const dispatchUnhandledRejection = (promise, reason) => {
      if (promise && (earlyUnhandledRejections.has(promise) || isPromiseHandled(promise))) return;
      if (promise) earlyUnhandledRejections.add(promise);
      const dispatch = () => {
        const handled = processObject.emit('unhandledRejection', reason, promise);
        if (!handled) processObject._bnhDispatchUncaughtException?.(reason, 'unhandledRejection');
      };
      const runWithPromiseScope = processObject._bnhRunWithPromiseScope;
      if (typeof runWithPromiseScope === 'function') runWithPromiseScope(promise, dispatch);
      else dispatch();
    };
    const restorePromiseRejectionObserver = setPromiseRejectionObserver((promise, reason) => {
      nativeQueueMicrotask(() => dispatchUnhandledRejection(promise, reason));
    });
    const onUnhandledRejection = (event) => {
      if (event.promise && (earlyUnhandledRejections.has(event.promise)
        || isPromiseRejectionReported(event.promise) || isPromiseHandled(event.promise))) {
        event.preventDefault?.();
        return;
      }
      dispatchUnhandledRejection(event.promise, event.reason);
      event.preventDefault?.();
    };
    if (typeof scope.addEventListener === 'function') scope.addEventListener('unhandledrejection', onUnhandledRejection);
    const exposeGc = processObject.execArgv?.some((argument) => {
      const flag = String(argument);
      return flag === '--expose-gc' || flag === '--expose_gc';
    });
    if (exposeGc) {
      scope.gc = (options = undefined) => {
        const abortSignalState = scope[Symbol.for('bnh.abort-signal-compatibility')];
        if (abortSignalState?.gc) abortSignalState.gc();
        else if (abortSignalState) abortSignalState.gcGeneration += 1;
        collectAsyncResources();
        vfs.collectGarbage?.();
        performancePrimitives.recordGC?.();
        if (options?.execution === 'async') return Promise.resolve();
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
      url: builtins.url,
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
      }, 0, false, 'Immediate'),
      // Node's stream and event primitives use next-turn microtasks. Keep
      // those callbacks inside the entry lifecycle so a buffered stream is
      // not abandoned when no timer or child process is otherwise referenced.
      queueMicrotask: trackedQueueMicrotask,
      clearImmediate: clearTimer,
      fetch: runtimeFetch,
      primordials: createPrimordials(scope),
      internalBinding: internalBindings.internalBinding,
      getInternalBinding: internalBindings.internalBinding,
    });
    const nativeStructuredClone = scope.structuredClone;
    if (typeof nativeStructuredClone === 'function') {
      scope.structuredClone = (value, options) => {
        if (value instanceof Blob && value[Symbol.for('bnh.blobCloneParts')]) {
          return new Blob(value[Symbol.for('bnh.blobCloneParts')], { type: value.type });
        }
        return nativeStructuredClone(value, options);
      };
    }
    const internalWebCrypto = scope.Crypto && scope.CryptoKey && scope.SubtleCrypto
      ? null
      : loadModule('internal/crypto/webcrypto', entry);
    if (internalWebCrypto?.Crypto) scope.Crypto = internalWebCrypto.Crypto;
    if (internalWebCrypto?.CryptoKey) scope.CryptoKey = internalWebCrypto.CryptoKey;
    if (internalWebCrypto?.SubtleCrypto) scope.SubtleCrypto = internalWebCrypto.SubtleCrypto;
    Object.assign(scope, {
      AsyncLocalStorage: builtins.async_hooks.AsyncLocalStorage,
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
    });
    scope.__BNH_VFS__ = vfs;
    Object.defineProperty(scope, 'WebAssembly', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: createWasmContract(scope),
    });
    reportExecutePhase('before-corepack');
    vfs.mkdir('/node/deps/corepack', { recursive: true });
    reportExecutePhase('corepack-ready');
    vfs.writeFile('/node/deps/corepack/package.json', JSON.stringify({ version: '0.34.6' }));
    reportExecutePhase('preload');
    try {
      await importPreloads();
      reportExecutePhase('preloaded');
      reportExecutePhase('entry-format');
      const entryIsEsm = isRuntimeEsmModule(entry, processObject.execArgv);
      reportExecutePhase(entryIsEsm ? 'entry-esm-load' : 'entry-cjs-load');
      if (entryIsEsm) await esmLoader.import(entry, entry, {}, undefined, processObject);
      else loadModule(entry, entry);
      reportExecutePhase('entry-loaded');
      builtins.test?.__bnhSourceLoaded?.();
      reportExecutePhase('entry-source-notified');
      await Promise.resolve();
      reportExecutePhase('entry-microtask');
      reportExecutePhase(`lifecycle:p${pending}:t${hasReferencedRuntimeTimers(allRuntimeTimers()) ? 1 : 0}:v${hasLiveVirtualProcess() ? 1 : 0}:i${hasReferencedIpc() ? 1 : 0}:w${hasReferencedWorkerParentPort() ? 1 : 0}`);
      while (!options.isCancelled?.() && !options.signal?.aborted && !processObject._exitRequested?.()) {
        const activeTimers = allRuntimeTimers();
        if (pending === 0 && pendingMicrotasks === 0
          && !hasReferencedRuntimeTimers(activeTimers) && !hasLiveVirtualProcess()
          && !hasReferencedIpc() && !hasReferencedWorkerParentPort()) {
          // Node exits when no referenced work remains. beforeExit is the
          // lifecycle signal that gives listeners one chance to create more
          // work; any such work is observed by the predicates above on the
          // next iteration.
          if (!processObject._emitBeforeExit?.()) break;
          continue;
        }
        await new Promise((resolve) => {
          const handle = nativeSetTimeout(resolve, 0);
          if (handle && (typeof handle === 'object' || typeof handle === 'function')) {
            handle[lifecycleWaitTimer] = true;
          }
        });
      }
      if (options.isCancelled?.() || options.signal?.aborted) return null;
      // A worker-backed child reports its logical runtime state through the
      // injected process object. Keep this generic handoff adjacent to the
      // natural lifecycle result so node:test discovery and stream terminal
      // state cannot disappear with the worker realm.
      if (injectedProcess && processObject.__bnhNodeTestState) {
        injectedProcess.__bnhNodeTestState = processObject.__bnhNodeTestState;
      }
      if (injectedProcess && processObject.__bnhChildActivity) {
        injectedProcess.__bnhChildActivity = processObject.__bnhChildActivity;
      }
      const naturalCode = processObject.getCode();
      return naturalCode;
    } catch (error) {
      stderr(`${error?.stack || error}\n`);
      processObject.exitCode = 1;
      // Preserve the uncaught boundary for process-entry. Browser Worker
      // callers must receive an error event rather than only exit code 1.
      processObject.__bnhUncaughtException = error;
      if (injectedProcess) injectedProcess.__bnhUncaughtException = error;
      if (!options.workerThread && injectedProcess && typeof injectedProcess.exit === 'function') {
        try { injectedProcess.exit(1); } catch { /* ignore */ }
      }
      if (String(error?.code || '').startsWith('ERR_UNSUPPORTED_')
        || error?.code === 'ERR_TRACE_EVENTS_UNAVAILABLE') throw error;
      return 1;
    } finally {
      for (const handle of timerHandles) clearTimer?.(handle);
      vfs.setTaskTracker?.(null);
      if (typeof scope.removeEventListener === 'function') scope.removeEventListener('unhandledrejection', onUnhandledRejection);
      restorePromiseRejectionObserver();
      esmLoader.dispose();
      processObject._markExited?.();
      builtins.async_hooks.cleanup();
      Object.assign(scope, previous);
      delete scope.__bnhModuleLoader;
    }
  }

  const runtime = {
    version: resolvedProfile.runtimeVersion,
    profile: resolvedProfile,
    wasmBaseUrl: wasmBaseUrl || `./${resolvedProfile.id}/wasm/`,
    contracts: createBrowserRuntimeContracts({ globalObject: scope }),
    async reset(context = {}) {
      if (activeChild) await activeChild.kill();
      activeChild = null;
      virtualProcessLiveness.clear();
      environmentData.clear();
      esmNamespaceCache.clear();
      for (const key of Object.keys(moduleCache)) delete moduleCache[key];
      executionIsolation = context.isolation || 'inline';
      if (context.signal?.aborted) return;
      runSpec = {
        runId: String(context.runId || context.metadata?.runId || `browser-${Date.now()}`),
        variant: context.variant || context.metadata?.variant || null,
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
            bindTcp: typeof proxyCapability.adapter.bindTcp === 'function'
              ? (request) => proxyCapability.adapter.bindTcp(request)
              : undefined,
            unbindTcp: typeof proxyCapability.adapter.unbindTcp === 'function'
              ? (request) => proxyCapability.adapter.unbindTcp(request)
              : undefined,
          }
        : undefined;
      const preserveSharedNetwork = context.virtualNetwork?.shared === true;
      const inheritedNetwork = context.virtualNetwork?.network;
      // An inherited network owns the process-local listener registry. Keep
      // it when crossing an IPC child boundary so bind/accept traffic can
      // return through the parent bridge; its transport also carries any
      // outbound proxy hooks supplied by that boundary.
      if (preserveSharedNetwork && inheritedNetwork) virtualNetwork = inheritedNetwork;
      else if (proxyTransport) virtualNetwork = createVirtualNetwork({ transport: proxyTransport });
      else if (preserveSharedNetwork) virtualNetwork = getSharedVirtualNetwork(scope);
      else virtualNetwork = replaceSharedVirtualNetwork(scope);
      dnsModule = createBrowserDns({ proxy: proxyCapability, network: virtualNetwork });
      scope.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ = 0;
      vfs = capabilities.vfs;
      mounted = false;
    },
    async mount(files, context = {}) {
      if (context.signal?.aborted) return;
      if (!capabilities) {
        await runtime.reset({ runId: 'direct-runtime', capabilities: DEFAULT_RUNTIME_CAPABILITIES });
      }

      const declaredMounts = [...capabilities.manifest.vfs.mounts]
        .sort((left, right) => right.path.length - left.path.length);
      const groups = new Map(declaredMounts.map((mount) => [mount.path, {
        files: {},
        mount,
        symlinks: [],
      }]));
      const owningMount = (entry) => {
        const path = normalizePath(entry, '/node');
        const mount = declaredMounts.find((candidate) => candidate.path === '/'
          || path === candidate.path || path.startsWith(`${candidate.path}/`));
        if (!mount) {
          const error = new Error(`path is outside the granted VFS mounts: ${path}`);
          error.code = 'ERR_CAPABILITY_DENIED';
          throw error;
        }
        return groups.get(mount.path);
      };

      const entries = files instanceof Map ? files.entries() : Object.entries(files || {});
      for (const [entry, value] of entries) owningMount(entry).files[entry] = value;
      for (const [link, target] of context.symlinks || []) {
        owningMount(link).symlinks.push([link, target]);
      }
      for (const group of groups.values()) {
        if (Object.keys(group.files).length || group.symlinks.length) {
          vfs.mount(group.files, { ...group.mount, symlinks: group.symlinks });
        }
      }
      mounted = true;
    },
    applyVfsUpdate(update) {
      vfs.applyUpdate?.(update);
    },
    async executeEntry(entry, options, stdout, stderr) {
      if (!mounted) throw new Error('runtime.mount() must be called before runtime.executeEntry()');
      if (executionIsolation === 'worker' && !options.workerThread) {
        // `spawn()` needs the entry as its final worker-entry argument, while
        // the process itself must retain the complete Node argv. In
        // particular, npm scripts such as `next dev --webpack` put the
        // bundler flag after the entry and it must cross this boundary.
        const child = await runtime.spawn(['node', entry], {
          ...options,
          cwd: options.cwd || '/node',
          env: options.env || {},
          processArgv: options.argv || ['node', entry],
          onStdout: stdout,
          onStderr: stderr,
        });
        const terminal = await child._worker?.wait?.();
        const code = terminal ? terminal.code : await child.exit;
        if (activeChild === child) activeChild = null;
        return code;
      }
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
      // The bridge injects this metadata key for every versioned browser run;
      // it is not an ambient user-controlled environment grant.
      if (runSpec?.variant) allowedEnvironment.add('BNH_VARIANT');
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
        vfs.snapshot({ copy: false }).artifacts.map(({ path, bytes }) => [path, {
          data: bytes,
          mode: vfs.stat(path).mode & 0o777,
        }]),
      );
      const workerIsolation = executionIsolation === 'worker';
      const proxyOperations = proxyCapability.adapter
        ? typeof proxyCapability.adapter === 'function' || typeof proxyCapability.adapter.handle === 'function'
          ? ['request', 'connect', 'send', 'resolve', 'tls']
          : ['request', 'connect', 'send', 'resolve', 'tls'].filter((operation) => (
              typeof proxyCapability.adapter[operation] === 'function'
            ))
        : [];
      const spawnProxy = workerIsolation && proxyCapability.adapter
        ? { ...capabilities.manifest.proxy, operations: proxyOperations, rpc: true }
        : proxyCapability.adapter ? proxyCapability : capabilities.manifest.proxy;
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
      const networkChannel = workerIsolation ? createMessageChannel(scope) : null;
      const workerNetworkBridge = networkChannel
        ? createWorkerNetworkBridge({ network: virtualNetwork, port: networkChannel.port1 })
        : null;
      const processOptions = {
        runId: runSpec.runId,
        nodeVersion: resolvedProfile.id,
        childId: `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        entry,
        argv: Array.isArray(options.processArgv) ? options.processArgv : argv,
        execArgv: childExecArgv,
        env: options.env,
        cwd: options.cwd || '/node',
        signalGrants: capabilities.manifest.signals.allowed,
        workerSource,
        workerType: 'module',
        timeout: options.timeout,
        signal: options.signal,
        runSource: '((context) => globalThis.__bnhRun(context))',
        vfs: {
          capabilities: capabilities.manifest,
          nodeVersion: resolvedProfile.id,
          files,
          npmCache: options.npmCache,
          entry,
          execArgv: childExecArgv,
          proxy: spawnProxy,
          // Same-realm children must inherit the owning process' network
          // registry, including a registry that is itself bridged to the
          // parent browser realm. A structured-cloned worker cannot carry
          // that live object, so worker children keep the shared marker and
          // establish their own remote bridge in process-entry.
          virtualNetwork: !workerIsolation && proxyCapability.adapter
            ? { shared: true, network: virtualNetwork }
            : { shared: true },
          networkTelemetry: typeof options.onNetwork === 'function',
        },
        stdout: capabilities.output.stdout,
        stderr: capabilities.output.stderr,
        networkPort: networkChannel?.raw.port2,
        proxyAdapter: workerIsolation ? proxyCapability.adapter : undefined,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        onNetwork: options.onNetwork,
      };
      const vfsUpdateBridge = workerIsolation ? createVfsUpdateBridge() : null;
      if (vfsUpdateBridge) processOptions.vfsUpdatePort = vfsUpdateBridge.port;
      const worker = proxyCapability.adapter && !workerIsolation
        ? createVirtualProcess({ ...processOptions, scope, forceFallback: true })
        : capabilities.process.create(processOptions);
      if (vfsUpdateBridge) {
        worker.wait().then(
          () => vfsUpdateBridge.close(),
          () => vfsUpdateBridge.close(),
        );
      }
      const outputListener = (record) => {
        if (record.stream === 'stdout') processOptions.onStdout?.(record.bytes);
        else processOptions.onStderr?.(record.bytes);
      };
      capabilities.output.on('data', outputListener);
      let artifacts = {};
      let runtimeState = null;
      worker.on('message', (message) => {
        if (message?.type === 'bnh-artifacts') artifacts = message.artifacts || {};
        if (message?.type === 'bnh-runtime-state') runtimeState = message.state || null;
      });
      const workerExit = worker.wait();
      const child = {
        exit: null,
        _worker: worker,
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
      child.exit = workerExit.then((terminal) => {
        workerNetworkBridge?.close();
        if (activeChild === child) activeChild = null;
        capabilities.output.off('data', outputListener);
        stdout.end();
        stderr.end();
        child.structuredResult = {
          runId: runSpec.runId,
          outcome: terminal.status === 'exited' && terminal.code === 0
            ? 'passed'
            : String(terminal.error?.code || '').startsWith('ERR_UNSUPPORTED_') ? 'unsupported' : 'failed',
          phase: terminal.kind === 'timeout' ? 'shutdown' : terminal.status === 'exited' ? 'complete' : 'launch',
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
            // The terminal control frame is the authoritative process
            // boundary. The runtime-state IPC message is retained for
            // compatibility, but may arrive after terminal on independent
            // MessagePorts.
            runtime_state: runtimeState || terminal.runtimeState || null,
            child_outputs: worker.childOutputs || [],
          },
          artifacts,
        };
        return terminal.code;
      });
      return child;
    },
    get vfs() { return vfs; },
    get capabilities() { return capabilities; },
    get virtualNetwork() { return virtualNetwork; },
  };
  return runtime;
}

export const runtime = createRuntime();
