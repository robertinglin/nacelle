import { createAssert, inspect as nodeInspect } from './runtime/assert.js';
import { createBufferClass, isAscii, isUtf8 } from './runtime/buffer.js';
import {
  createAsyncLocalStorage,
  assembleBrowserCapabilities,
  createBrowserIO,
  createBrowserRuntimeContracts,
  createDiagnosticsModule,
  createWorkerFactory,
  validateCapabilityManifest,
} from './runtime/index.js';
import { createAsyncHooksModule } from './runtime/async-hooks.js';
import { EventEmitter, getEventListeners, once } from './runtime/events.js';
import { createVfs, fileURLToPath, pathToFileURL } from './runtime/vfs.js';
import { path } from './runtime/path.js';
import { Readable, Writable, Duplex, Transform, PassThrough, pipeline } from './runtime/streams.js';
import { createPlatformContract } from './runtime/os-platform.js';
import { createHttpCompatibility } from './runtime/http.js';
import { createTlsModule } from './runtime/tls.js';
import { createHttp2Module } from './runtime/http2.js';
import { createPerformancePrimitives } from './runtime/perf.js';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  createHashShim,
  createHmacShim,
  pbkdf2,
  pbkdf2Sync,
  randomUUID as createRandomUUID,
  sign,
  verify,
} from './runtime/crypto.js';
import {
  createConsoleModule,
  createConstants,
  createPromisify,
  createQuerystring,
  createStreamConsumers,
  createStringDecoder,
  createUtilTypes,
  createWebStreamModule,
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
import { createVirtualNetwork, getSharedVirtualNetwork, replaceSharedVirtualNetwork } from './runtime/virtual-network.js';
import { createCluster } from './runtime/cluster.js';
import { createVirtualProcess } from './runtime/virtual-process.js';
import { createProxyCapability } from './runtime/proxy.js';
import { createV8Module } from './runtime/v8.js';
import { createModuleLoader } from './runtime/module-loader.js';
import { createUrlModule } from './runtime/url.js';

const BUILTIN_NAMES = Object.freeze([
  'assert', 'assert/strict', 'buffer', 'console', 'constants', 'crypto', 'domain', 'events', 'fs', 'fs/promises', 'http', 'https', 'module', 'os',
  'path', 'path/posix', 'path/win32', 'process', 'querystring', 'stream', 'stream/consumers', 'stream/promises', 'stream/web',
  'string_decoder', 'timers', 'timers/promises', 'url', 'util', 'util/types', 'worker_threads', 'zlib', 'perf_hooks', 'async_hooks', 'diagnostics_channel',
  'child_process', 'cluster', 'dgram', 'dns', 'dns/promises', 'http2', 'net', 'tls', 'test', 'v8', 'vm',
  'internal/test/binding', 'internal/test/transfer',
]);

function builtinName(name) {
  return name.startsWith('node:') ? name.slice(5) : name;
}

function createInternalTestBinding() {
  return Object.freeze({
    internalBinding(name) {
      if (name === 'util') return { arrayBufferViewHasBuffer: (value) => Boolean(value?.buffer) };
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
  const source = String(value).replaceAll('\\', '/');
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

function emitChildIpcMessage(child, value, handle) {
  const event = typeof value?.cmd === 'string' && value.cmd.startsWith('NODE_')
    ? 'internalMessage'
    : 'message';
  child.emit(event, value, handle);
}

const COMMONJS_WRAPPER_PARAMETERS = Object.freeze([
  'require', 'module', 'exports', '__filename', '__dirname',
]);
let commonJsWrapperSequence = 0;

function runCommonJSWrapper(source, sourceURL, commonJsValues, injectedValues) {
  const sourceText = `${source}\n//# sourceURL=${sourceURL}`;
  for (;;) {
    const sequence = commonJsWrapperSequence++;
    const injectedNames = [
      `__bnh_process_${sequence}`,
      `__bnh_global_${sequence}`,
      `__bnh_globalThis_${sequence}`,
      `__bnh_setTimeout_${sequence}`,
      `__bnh_clearTimeout_${sequence}`,
      `__bnh_setImmediate_${sequence}`,
      `__bnh_clearImmediate_${sequence}`,
      `__bnh_vm_${sequence}`,
    ];
    let wrapped;
    try {
      wrapped = new Function(
        ...COMMONJS_WRAPPER_PARAMETERS,
        ...injectedNames,
        sourceText,
      );
    } catch (error) {
      const duplicate = String(error?.message || '').match(/^Identifier '([^']+)' has already been declared$/);
      if (!(duplicate && injectedNames.includes(duplicate[1]))) throw error;
      continue;
    }
    return wrapped(...commonJsValues, ...injectedValues);
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

function installAbortSignalCompatibility(scope) {
  const AbortSignalClass = scope.AbortSignal;
  if (typeof AbortSignalClass?.any !== 'function') return;
  const receivedType = (value) => value === null ? 'null' : value === undefined ? 'undefined' : typeof value;
  const nativeAny = AbortSignalClass.any.bind(AbortSignalClass);
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
    `${pathname}/index.js`, `${pathname}/index.cjs`, `${pathname}/index.mjs`, `${pathname}/index.json`];
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
  v8: '12.0.0',
  browser: '1',
  // The browser crypto shim is safe and available, but it is not host OpenSSL.
});

function createProcess(scope, options, stdout, stderr, trackTask) {
  const env = Object.fromEntries(Object.entries(options.env || {}).map(([key, value]) => [key, String(value)]));
  const timers = new Set();
  const nativeSetTimeout = scope.setTimeout.bind(scope);
  const nativeClearTimeout = scope.clearTimeout.bind(scope);
  const nativeSetInterval = scope.setInterval.bind(scope);
  const nativeClearInterval = scope.clearInterval.bind(scope);
  let exitCode = 0;
  let umask = 0o022;
  let uid = 1000;
  let gid = 1000;
  let exited = false;
  let exitRequested = false;
  let exitEventEmitted = false;
  let beforeExitEventEmitted = false;
  const setTimer = (callback, delay, repeat = false) => {
    const handle = {
      id: null,
      repeat,
      referenced: true,
      ref() { this.referenced = true; return this; },
      unref() { this.referenced = false; return this; },
      hasRef() { return this.referenced; },
    };
    const run = () => {
      if (exited) return;
      const previousProcess = scope.process;
      const previousTimers = {
        setTimeout: scope.setTimeout,
        clearTimeout: scope.clearTimeout,
        setInterval: scope.setInterval,
        clearInterval: scope.clearInterval,
        setImmediate: scope.setImmediate,
        clearImmediate: scope.clearImmediate,
      };
      const timerContext = processObject._bnhTimerContext;
      scope.process = processObject;
      if (timerContext) Object.assign(scope, timerContext);
      try {
        try { callback(); } catch (error) {
          let handled = false;
          if (typeof processObject.getUncaughtExceptionCaptureCallback === 'function') {
            const captureFn = processObject.getUncaughtExceptionCaptureCallback();
            if (typeof captureFn === 'function') {
              handled = captureFn(error);
            }
          }
          if (!handled) {
            handled = processObject.emit('uncaughtException', error);
          }
          if (!handled) {
            stderr(`${error?.stack || error}\n`);
            exitCode ||= 1;
          }
        }
      } finally {
        Object.assign(scope, previousTimers);
        scope.process = previousProcess;
      }
      if (!repeat) {
        timers.delete(handle);
      }
    };
    handle.id = repeat ? nativeSetInterval(run, delay) : nativeSetTimeout(run, delay);
    timers.add(handle);
    return handle;
  };
  const clearTimer = (handle) => {
    if (!handle) return;
    if (handle.repeat) nativeClearInterval(handle.id);
    else nativeClearTimeout(handle.id);
    timers.delete(handle);
  };
  const processObject = new EventEmitter();
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
  Object.assign(processObject, {
    argv: [...(options.argv || ['node'])],
    argv0: options.argv0 ?? 'node',
    env,
    pid: 1,
    ppid: 0,
    platform: 'linux',
    arch: 'x64',
    version: 'v22.0.0-browser',
    config: BROWSER_PROCESS_CONFIG,
    features: BROWSER_PROCESS_FEATURES,
    versions: BROWSER_PROCESS_VERSIONS,
    title: 'browser-node',
    execPath: '/browser/node',
    execArgv: [],
    stdin: { isTTY: false, on: (...args) => processObject.on(...args), resume() {}, pause() {} },
    stdout: { isTTY: false, write: (value) => { stdout(normalizeOutputChunk(value)); return true; }, on: (...args) => processObject.on(...args) },
    stderr: { isTTY: false, write: (value) => { stderr(normalizeOutputChunk(value)); return true; }, on: (...args) => processObject.on(...args) },
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
    setuid: (value) => { uid = normalizeCredential(value, 'User'); },
    seteuid: (value) => { uid = normalizeCredential(value, 'User'); },
    setgid: (value) => { gid = normalizeCredential(value, 'Group'); },
    setegid: (value) => { gid = normalizeCredential(value, 'Group'); },
    nextTick: (callback, ...args) => {
      const release = trackTask();
      scope.queueMicrotask(() => {
        try { callback(...args); } finally { release?.(); }
      });
    },
    uptime: () => (scope.performance?.now?.() || 0) / 1000,
    hrtime: (previous) => { const now = Math.floor((scope.performance?.now?.() || 0) * 1e6); const result = [Math.floor(now / 1e9), now % 1e9]; return previous ? [result[0] - previous[0], result[1] - previous[1]] : result; },
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    exit: (code = 0) => {
      exitCode = Number(code) || 0;
      exitRequested = true;
      if (!exitEventEmitted) {
        exitEventEmitted = true;
        processObject.emit('exit', exitCode);
      }
      exited = true;
    },
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
    getCode: () => exitCode,
    _timers: timers,
    _hasActiveReferencedTimers: () => [...timers].some((handle) => handle.hasRef?.() !== false),
    _clearTimer: clearTimer,
    _exitRequested: () => exitRequested,
    _emitBeforeExit: () => {
      if (beforeExitEventEmitted || exitRequested || exited) return false;
      beforeExitEventEmitted = true;
      processObject.emit('beforeExit', exitCode);
      return true;
    },
    _markExited: () => {
      if (!exitEventEmitted) {
        exitEventEmitted = true;
        processObject.emit('exit', exitCode);
      }
      exited = true;
      for (const handle of [...timers]) clearTimer(handle);
    },
  });
  Object.defineProperty(processObject, 'exitCode', {
    configurable: true,
    enumerable: true,
    get: () => exitCode,
    set: (value) => { exitCode = Number(value) || 0; },
  });
  return { processObject, setTimer, clearTimer };
}

function createCryptoShim(scope, Buffer) {
  const crypto = scope.crypto;
  const wrapBuffer = (operation) => (...args) => operation(...args).then((value) => new Buffer(value));
  const nodePbkdf2 = (password, salt, iterations, keyLength, digest, callback) => {
    const operation = pbkdf2(password, salt, iterations, keyLength, digest);
    if (typeof callback !== 'function') return operation.then((value) => new Buffer(value));
    operation.then((value) => callback(null, new Buffer(value)), (error) => callback(error));
  };
  return {
    webcrypto: crypto,
    subtle: crypto?.subtle,
    randomUUID: (options) => createRandomUUID(scope, options),
    randomBytes: (size) => {
      const output = new Buffer(size);
      crypto.getRandomValues(output);
      return output;
    },
    createHash: createHashShim(Buffer),
    createHmac: createHmacShim(Buffer),
    pbkdf2: nodePbkdf2,
    pbkdf2Sync: (...args) => new Buffer(pbkdf2Sync(...args)),
    aesGcmEncrypt: wrapBuffer(aesGcmEncrypt),
    aesGcmDecrypt: wrapBuffer(aesGcmDecrypt),
    sign: wrapBuffer(sign),
    verify,
  };
}

function createZlibShim(scope, BufferClass) {
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
  return {
    constants: Object.freeze({ Z_FINISH: 4 }),
    gzip: (value, callback) => operation(value, 'gzip', scope.CompressionStream, callback),
    gunzip: (value, callback) => operation(value, 'gzip', scope.DecompressionStream, callback),
    deflate: (value, callback) => operation(value, 'deflate', scope.CompressionStream, callback),
    inflate: (value, callback) => operation(value, 'deflate', scope.DecompressionStream, callback),
    gzipSync() { throw new Error('synchronous compression is unavailable in a browser; use zlib.gzip'); },
    gunzipSync() { throw new Error('synchronous decompression is unavailable in a browser; use zlib.gunzip'); },
    brotliCompressSync() { throw new Error('Brotli sync compression is unavailable in a browser'); },
    brotliDecompressSync() { throw new Error('Brotli sync decompression is unavailable in a browser'); },
  };
}

function createTimerPromises(scope) {
  const abortError = () => new DOMException('The operation was aborted', 'AbortError');
  const wait = (delay, value, options = {}) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason || abortError()); return; }
    let timer;
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = () => {
      scope.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
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
function require(name) {
  if (name === 'node:worker_threads' || name === 'worker_threads') {
    return { parentPort: __bnhParentPort, isMainThread: false, workerData: undefined };
  }
  throw new Error('browser worker cannot require ' + name);
}
`;

export function createRuntime({ globalObject = globalThis, version = 'browser-native-runtime/v1' } = {}) {
  const scope = globalObject;
  let vfs = createVfs();
  const Buffer = createBufferClass();
  let mounted = false;
  let activeChild = null;
  let capabilities = null;
  let runSpec = null;
  let virtualNetwork = getSharedVirtualNetwork(scope);
  let dnsModule = createBrowserDns();
  let proxyCapability = createProxyCapability();
  const virtualProcessLiveness = new Map();

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

  function resolveFile(specifier, importer) {
    if (specifier.startsWith('data:')) return specifier;
    if (specifier.startsWith('file:')) return normalizePath(fileURLToPath(specifier));
    const base = specifier.startsWith('/') ? specifier : normalizePath(specifier, importer ? path.dirname(importer) : '/node');
    return moduleCandidates(base).find((candidate) => vfs.files.has(candidate)) || base;
  }

  function makeBuiltins(processObject, runtimeRequire, diagnosticsChannels, runtimeOptions, performancePrimitives, trackTask, stdout, stderr, readSource, sourcePath) {
    const fs = vfs.fs;
    const platform = createPlatformContract({ variant: runtimeOptions.variant || 'browser', env: processObject.env });
    const nodeCrypto = createCryptoShim(scope, Buffer);
    const nodePath = { ...path };
    const nodeUrl = createUrlModule(scope, { pathToFileURL, fileURLToPath });
    const createModuleApi = (processObj = processObject, childStderr = stderr) => {
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
      return {
        builtinModules: BUILTIN_NAMES,
        createRequire: (filename) => {
          const importer = typeof filename === 'string' && filename.startsWith('file:')
            ? fileURLToPath(filename)
            : String(filename || sourcePath);
          return (name) => runtimeRequire(name, importer);
        },
        isBuiltin: (name) => BUILTIN_NAMES.includes(builtinName(name)),
        enableCompileCache,
        getCompileCacheDir: () => processObj.env?.NODE_COMPILE_CACHE,
        flushCompileCache: () => {},
        constants: { compileCacheStatus },
      };
    };
    const moduleApi = createModuleApi(processObject);
    const streamApi = { Readable, Writable, Duplex, Transform, PassThrough, pipeline, addAbortSignal, finished };
    const streamWebApi = createWebStreamModule(scope);
    const streamConsumers = createStreamConsumers(scope, Buffer);
    const unsupportedBuiltins = createUnsupportedBuiltins();
    const dns = dnsModule;
    const dnsPromises = dns.promises;
    const notifyClusterListening = runtimeOptions.clusterWorker && typeof processObject.send === 'function'
      ? (address) => {
          return processObject.send({ type: 'bnh-cluster-listening', address });
        }
      : undefined;
    const clusterGroupId = processObject._bnhClusterGroupId;
    const processOwner = runtimeOptions.processObject || processObject;
    const net = createBrowserNet({ network: virtualNetwork, dns, BufferClass: Buffer, trackTask, onListening: notifyClusterListening, clusterGroupId, processOwner });
    const dgram = createBrowserDgram({ network: virtualNetwork, BufferClass: Buffer, trackTask, clusterGroupId, processOwner });
    processOwner.on?.('disconnect', () => virtualNetwork.unbindProcess?.(processOwner));
    const activeProxy = proxyCapability.mode === 'proxy' && proxyCapability.enabled
      && proxyCapability.capabilityGranted && proxyCapability.adapter
      ? proxyCapability
      : undefined;
    const httpCompatibility = activeProxy
      ? createHttpCompatibility(scope, { Buffer, proxy: activeProxy, net, trackTask })
      : (() => {
          const cacheKey = '__BNH_HTTP_COMPATIBILITY_BY_NETWORK__';
          let cache = scope[cacheKey];
          if (!cache) {
            cache = new Map();
            Object.defineProperty(scope, cacheKey, { configurable: true, value: cache });
          }
          let compatibility = runtimeOptions.clusterWorker ? null : cache.get(virtualNetwork);
          if (!compatibility) {
            compatibility = createHttpCompatibility(scope, { Buffer, net, trackTask });
            if (!runtimeOptions.clusterWorker) cache.set(virtualNetwork, compatibility);
          }
          return compatibility;
        })();
    const tls = createTlsModule(scope, { net, BufferClass: Buffer, proxy: activeProxy });
    const http2 = createHttp2Module(scope, { proxy: activeProxy });
    const cluster = createCluster({
      process: processObject,
      processFactory: (processOptions) => trackVirtualProcess(createVirtualProcess({
        ...processOptions,
        forceFallback: true,
        deferRun: true,
      })),
      scope,
      runId: runSpec?.runId,
      environment: processObject.env,
      signalGrants: capabilities?.manifest?.signals?.allowed,
      maxChildren: capabilities?.manifest?.workers?.maxChildren,
      stdout,
      stderr,
      isWorker: Boolean(runtimeOptions.clusterWorker),
      id: runtimeOptions.clusterWorkerId,
      workerRun: ({ process: childProcess, signal }) => {
        const workerEntry = runtimeOptions.entry;
        if (!workerEntry) throw new Error('cluster worker entry is unavailable');
        return execute(workerEntry, {
          ...runtimeOptions,
          entry: workerEntry,
          processObject: childProcess,
          signal,
          argv: childProcess.argv,
          env: childProcess.env,
          cwd: childProcess.cwd?.() || '/node',
          clusterWorker: true,
          clusterWorkerId: childProcess.pid,
        }, stdout, stderr);
      },
    });
    const v8 = createV8Module(processObject);
    const internalTestBinding = createInternalTestBinding();
    const assert = createAssert({ readSource, sourcePath });
    const timers = { setTimeout: scope.setTimeout.bind(scope), clearTimeout: scope.clearTimeout.bind(scope), setImmediate: scope.setTimeout.bind(scope), clearImmediate: scope.clearTimeout.bind(scope), setInterval: scope.setInterval.bind(scope), clearInterval: scope.clearInterval.bind(scope) };
    const timerPromises = createTimerPromises(scope);
    const nodeTest = createNodeTest({ scope, processObject, stdout, stderr, trackTask });
    const vm = createVmModule(scope);
    return {
      assert, 'assert/strict': assert.strict, buffer: { Buffer, isAscii, isUtf8 }, console: createConsoleModule(processObject), constants: createConstants(), crypto: nodeCrypto,
      domain: createDomainModule(processObject),
      events: (() => {
        EventEmitter.EventEmitter = EventEmitter;
        EventEmitter.getEventListeners = getEventListeners;
        EventEmitter.once = once;
        return EventEmitter;
      })(), fs, 'fs/promises': fs.promises,
      http: httpCompatibility.http, https: httpCompatibility.https, http2, dns, 'dns/promises': dnsPromises,
      'internal/test/binding': internalTestBinding, 'internal/test/transfer': {}, module: moduleApi, os: platform.os,
      path: nodePath, 'path/posix': path.posix, 'path/win32': path.win32, process: processObject, querystring: createQuerystring(),
      stream: streamApi, 'stream/consumers': streamConsumers, 'stream/web': streamWebApi,
      'stream/promises': { pipeline: (...args) => new Promise((resolve, reject) => pipeline(...args, (error) => error ? reject(error) : resolve())) },
      timers, 'timers/promises': timerPromises, string_decoder: { StringDecoder: createStringDecoder() },
      url: nodeUrl, util: (() => {
        const inspectFn = (value, options) => nodeInspect(value, options);
        inspectFn.custom = Symbol.for('nodejs.util.inspect.custom');
        return { format: (format, ...args) => String(format).replace(/%[sdifoO%]/g, (token) => token === '%%' ? '%' : String(args.shift())), inspect: inspectFn, types: createUtilTypes(scope), promisify: createPromisify(), customPromisifyArgs: Symbol.for('nodejs.util.promisify.customArgs'), getSystemErrorName: (code) => ({ [-1]: 'EPERM' }[code] || `Unknown system error ${code}`), getCallSites: createGetCallSites(), debuglog: (section) => { const sections = (String(processObject?.env?.NODE_DEBUG || '')).split(',').map((s) => s.trim()).filter(Boolean); const enabled = sections.includes(section) || sections.includes('DEBUG') || sections.some((s) => s.includes(section)); return (...args) => { if (enabled) console?.error ? console.error(...args) : console?.log ? console.log(...args) : null; }; }, TextEncoder: scope.TextEncoder, TextDecoder: scope.TextDecoder, aborted: createAborted() };
      })(),
      'util/types': createUtilTypes(scope),
      worker_threads: { ...createBrowserIO(scope), isMainThread: true, parentPort: null, workerData: undefined },
      zlib: createZlibShim(scope, Buffer), perf_hooks: performancePrimitives.perfHooks, v8,
      async_hooks: createAsyncHooksModule(),
      diagnostics_channel: diagnosticsChannels,
      test: nodeTest,
      ...unsupportedBuiltins,
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
          const args = [];
          let stdinPath = null;
          for (let index = 0; index < tokens.length; index += 1) {
            if (tokens[index] === '<') stdinPath = tokens[++index];
            else args.push(tokens[index]);
          }
          return { file: args.shift() || processObject.execPath, args, stdinPath };
        }

        function normalizeChildScript(value, cwd) {
          const source = String(value);
          return normalizePath(source.startsWith('file:') ? fileURLToPath(source) : source, cwd);
        }

        function prepareChild(file, args, options = {}) {
          const cwd = options?.cwd || (processObject.cwd ? processObject.cwd() : '/node');
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
          let printResult = false;
          let script = null;
          let afterScript = [];
          let snapshotBlobPath = null;
          let buildSnapshot = false;
          let stopOptions = false;
          for (let index = 0; index < rawArgs.length; index += 1) {
            const argument = rawArgs[index];
            if (!stopOptions && argument === '--') { stopOptions = true; continue; }
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
            if (!stopOptions && (argument === '-p' || argument === '--print')) {
              printResult = true;
              if (rawArgs[index + 1] !== undefined && !rawArgs[index + 1].startsWith('-')) evalCode = rawArgs[++index];
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
            if (!stopOptions && argument.startsWith('-')) continue;
            if (script === null) script = argument;
            else afterScript.push(argument);
          }
          const executionArgv = [executable, ...rawArgs];
          const id = ++childSequence;
          const mainPath = script ? normalizeChildScript(script, cwd) : `/node/.bnh-child-${id}.js`;
          const entryPath = evalCode !== null || preloads.length ? `/node/.bnh-child-${id}.js` : mainPath;
          let source = null;
          if (evalCode !== null) {
            const expression = printResult
              ? `process.stdout.write(String(eval(${JSON.stringify(evalCode)})) + '\\n');`
              : evalCode;
            source = `${preloads.map((item) => `require(${JSON.stringify(normalizePath(item, cwd))});`).join('\n')}\n${expression}`;
          } else if (preloads.length) {
            source = `${preloads.map((item) => `require(${JSON.stringify(normalizePath(item, cwd))});`).join('\n')}\nrequire(${JSON.stringify(mainPath)});`;
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
            preloads,
            entryPath,
            mainPath,
            scriptPath: script ? mainPath : null,
            snapshotBlobPath: snapshotBlobPath ? normalizePath(snapshotBlobPath, cwd) : null,
            buildSnapshot,
            source,
            stdinPath: options?.stdinPath || null,
            stdin: options?.input,
            afterScript,
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
          events.destroy = () => { events.end(); return events; };
          return events;
        }

        function virtualAsync(file, args, options, callback, isExecFile = false) {
          const stdoutStream = outputStream();
          const stderrStream = outputStream();
          const child = new EventEmitter();
          const prepared = prepareChild(file, args, options);
          const ipc = options?.ipc ? {
            process: null,
            queued: [],
            finished: false,
            referenced: true,
            ref() { this.referenced = true; return this; },
            unref() { this.referenced = false; return this; },
            hasRef() { return this.referenced; },
            onChildMessage: (value, handle) => runInOwnerContext(() => emitChildIpcMessage(child, value, handle)),
            onChildExit: (code) => finish(code, null),
            onChildDisconnect: () => {
              if (child.connected) {
                child.connected = false;
                child.emit('disconnect');
              }
              finish(0, null);
            },
          } : null;
          let closed = false;
          let releaseChildTask = trackTask?.() || null;
          let abortListener = null;
          let childProcess = null;
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
          child.stdout = stdoutStream;
          child.stderr = stderrStream;
          child.stdin = { write() { return true; }, end() {} };
          child.connected = Boolean(ipc);
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
              if (sendCallback) { sendCallback(error); return false; }
              throw error;
            }
            if (ipc.processHandle?.state === 'running') {
              return ipc.processHandle.send(value, sendHandle, sendOptions, sendCallback);
            }
            const childHandle = wrapChildHandle(sendHandle);
            if (ipc.process) runInChildContext(() => ipc.process.emit('message', value, childHandle));
            else ipc.queued.push({ value, sendHandle: childHandle, sendOptions, sendCallback });
            if (!ipc.processHandle) sendCallback?.(null);
            return true;
          };
          child.disconnect = () => {
            if (!ipc || closed) return false;
            child.connected = false;
            if (ipc.processHandle) ipc.processHandle.disconnect?.();
            else ipc.process?.disconnect?.();
            return true;
          };
          let killed = false;
          child.kill = () => {
            if (closed) return true;
            killed = true;
            if (ipc?.processHandle) {
              try { ipc.processHandle.kill(isExecFile ? 'SIGKILL' : 'SIGTERM'); } catch { /* already terminal */ }
            }
            if (isExecFile) finish(-1, null);
            else finish(null, 'SIGTERM');
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
            releaseChildTask?.();
            releaseChildTask = null;
            if (abortListener) options.signal.removeEventListener('abort', abortListener);
            if (prepared.executionArgv.some((value) => String(value) === '--no-warnings')) {
              stderr = stderr.replace(/\[DEP0005\] DeprecationWarning: Buffer\(\) is deprecated due to security and usability issues\. Please use the Buffer\.alloc\(\), Buffer\.allocUnsafe\(\), or Buffer\.from\(\) methods instead\.\n/g, '');
            }
            runInOwnerContext(() => {
              if (stdout && !stdoutEmitted) writeStdout(stdout);
              if (stderr) stderrStream.write(stderr);
              stdoutStream.end();
              stderrStream.end();
              if (error) child.emit('error', error);
              child.emit('exit', code, signal);
              child.emit('close', code, signal);
              if (typeof callback === 'function') {
                const callbackError = error || (code === 0 ? null : isExecFile ? commandError(code, signal) : Object.assign(new Error(`child exited with code ${code}`), { code }));
                callback(callbackError, stdout, stderr);
              }
            });
          };
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
              finish(null, null, error);
            };
            options.signal.addEventListener('abort', abortListener, { once: true });
            if (options.signal.aborted) abortListener();
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
            try {
              const childOptions = ipc
                ? { ...options, ipc, onSignal: (signal) => finish(null, signal) }
                : { ...options, onSignal: (signal) => finish(null, signal) };
              if (prepared.entryPath.endsWith('.mjs')) {
                const processHandle = runPreparedESM(prepared, childOptions, (value) => {
                  stdout += normalizeOutputChunk(value);
                  writeStdout(value);
                }, (value) => { stderr += normalizeOutputChunk(value); });
                if (ipc) {
                  ipc.processHandle = processHandle;
                  processHandle.on('message', (value, handle) => {
                    if (value?.type === 'bnh-artifacts') return;
                    emitChildIpcMessage(child, value, handle);
                  });
                  processHandle.on('spawn', () => {
                    for (const message of ipc.queued.splice(0)) processHandle.send(message.value, message.sendHandle, message.sendOptions, message.sendCallback);
                    child.emit('spawn');
                  });
                }
                processHandle.wait().then((terminal) => {
                  if (terminal.code !== 0 || terminal.signal) finish(terminal.code, terminal.signal);
                  else finish(0, null);
                }, (error) => finish(1, null, error));
                return;
              }
              const result = runPreparedSync(prepared, childOptions);
              stdout = result.stdout?.toString?.() || String(result.stdout || '');
              stderr = result.stderr?.toString?.() || String(result.stderr || '');
              if (ipc) {
                childProcess = result.process;
                ipc.process = result.process;
                for (const message of ipc.queued.splice(0)) {
                  runInChildContext(() => ipc.process?.emit('message', message.value, message.sendHandle));
                }
                if (result.status !== 0 || result.process?._exitRequested?.()) finish(result.status, result.signal);
              } else if (!result.pending) {
                finish(result.status, result.signal);
              }
            } catch (error) {
              finish(1, null, error);
            }
          });
          return child;
        }

        function resolveFileSync(specifier, importer) {
          const source = String(specifier).replaceAll('\\', '/');
          const base = specifier.startsWith('/') ? specifier : normalizePath(specifier, importer ? path.dirname(importer) : '/node');
          for (const candidate of moduleCandidates(base)) {
            try { readSource(candidate); return candidate; } catch { /* ignore */ }
          }
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
            if (directory === '/') return 'commonjs';
            directory = path.dirname(directory);
          }
        }

        function isEsmModule(entryPath) {
          return entryPath.endsWith('.mjs')
            || (entryPath.endsWith('.js') && packageType(entryPath) === 'module');
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

        function loadModuleSync(entryPath, parentImport = entryPath, processObj, scopeObj, bufferClass, stderrArr = [], sourceOverride = undefined, moduleState = { main: null }, isMain = false, compileCacheState = null, fromEval = false) {
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
          if (isEsmModule(entryPath)) throw requireEsmError(entryPath, parentImport, fromEval);
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
              typeof stderr === 'function' ? stderr(`[compile cache] cache for ${basename} was accepted, keeping the in-memory entry\n`) : null;
            } else if (fileExistedBefore) {
              cacheAction = 'updated';
              stderrArr.push(`[compile cache] reading cache from ${cacheDir} for ${basename} code hash mismatch: source changed\n`);
              typeof stderr === 'function' ? stderr(`[compile cache] reading cache from ${cacheDir} for ${basename} code hash mismatch: source changed\n`) : null;
            } else {
              cacheAction = 'initialized';
              stderrArr.push(`[compile cache] ${basename} was not initialized, initializing the in-memory entry\n`);
              typeof stderr === 'function' ? stderr(`[compile cache] ${basename} was not initialized, initializing the in-memory entry\n`) : null;
            }
            if (compileCacheState && entryPath === compileCacheState.entryPath) compileCacheState.primaryAction = cacheAction;
          }
          const moduleExports = {};
          const moduleRecord = {
            exports: moduleExports,
            id: entryPath,
            filename: entryPath,
            loaded: false,
            parent: null,
            children: [],
          };
          if (isMain) moduleState.main = moduleRecord;
          const requireFn = (name) => {
            const builtin = builtinName(name);
            if (BUILTIN_NAMES.includes(builtin)) {
              if (builtin === 'module') return createModuleApi(processObj, (value) => stderrArr.push(value));
              if (builtin === 'process') return processObj;
              if (builtin === 'dns') return dnsModule;
              if (builtin === 'dns/promises') return dnsModule.promises;
              if (builtin === 'v8') return createV8Module(processObj);
              return runtimeRequire(name);
            }
            const resolved = resolveFileSync(name, entryPath);
            return loadModuleSync(resolved, entryPath, processObj, scopeObj, bufferClass, stderrArr, undefined, moduleState, false, compileCacheState, text.includes('eval('));
          };
          requireFn.resolve = (name) => BUILTIN_NAMES.includes(builtinName(name)) ? name : resolveFileSync(name, entryPath);
          requireFn.main = moduleState.main;
          requireFn.cache = new Map();
          moduleRecord.require = requireFn;
          runCommonJSWrapper(
            text,
            entryPath,
            [requireFn, moduleRecord, moduleExports, entryPath, path.dirname(entryPath)],
            [
              processObj, scopeObj, scopeObj, scopeObj.setTimeout, scopeObj.clearTimeout,
              scopeObj.setImmediate, scopeObj.clearImmediate, vm,
            ],
          );
          moduleRecord.loaded = true;
          if (isCompileCacheDebug && tagDir && (!fileExistedBefore || cacheAction === 'updated')) {
            const basename = entryPath.split('/').pop() || entryPath;
            try {
              fs.writeFileSync ? fs.writeFileSync(compileCacheFile, text, 'utf8') : null;
              compileCacheSources.set(compileCacheFile, text);
              stderrArr.push(`[compile cache] writing cache for ${basename}...success\n`);
              typeof stderr === 'function' ? stderr(`[compile cache] writing cache for ${basename}...success\n`) : null;
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
              console: scope.console,
              global: scope.global,
              Buffer: scope.Buffer,
              setTimeout: scope.setTimeout,
              clearTimeout: scope.clearTimeout,
              setInterval: scope.setInterval,
              clearInterval: scope.clearInterval,
              setImmediate: scope.setImmediate,
              clearImmediate: scope.clearImmediate,
            };
            let childProc = null;
            let originalReadFileSync = null;
            let compileCacheState = null;
            try {
              childProc = createProcess(scope, {
                argv,
                argv0: prepared.argv0,
                env,
                cwd,
              }, (value) => stdoutArr.push(value), (value) => stderrArr.push(value), () => () => {});
            childProc.processObject.argv = prepared.evalCode !== null
              ? [executionArgv[0], ...prepared.afterScript]
              : [executionArgv[0], ...(prepared.scriptPath ? [prepared.scriptPath] : []), ...prepared.afterScript];
            childProc.processObject.execArgv = prepared.evalCode !== null
              ? executionArgv.slice(1)
              : executionArgv.slice(1).filter((value) => String(value).startsWith('-'));
            let pendingAbortWorkers = 0;
            const abortOnUncaughtException = childProc.processObject.execArgv.includes('--abort-on-uncaught-exception');
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
              scope.global = scope;
              scope.Buffer = Buffer;
              scope.setTimeout = (callback, delay, ...args) => {
                return childProc.setTimer(() => callback(...args), delay);
              };
              scope.clearTimeout = childProc.clearTimer;
              scope.setInterval = (callback, delay, ...args) => childProc.setTimer(() => callback(...args), delay, true);
              scope.clearInterval = childProc.clearTimer;
              scope.setImmediate = (callback, ...args) => childProc.setTimer(() => callback(...args), 1);
              scope.clearImmediate = childProc.clearTimer;
              childProc.processObject._bnhTimerContext = {
                setTimeout: scope.setTimeout,
                clearTimeout: scope.clearTimeout,
                setInterval: scope.setInterval,
                clearInterval: scope.clearInterval,
                setImmediate: scope.setImmediate,
                clearImmediate: scope.clearImmediate,
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
              if (prepared.snapshotBlobPath && !prepared.buildSnapshot && !prepared.scriptPath) {
                const snapshot = JSON.parse(String(fs.readFileSync(prepared.snapshotBlobPath, 'utf8')));
                entryPath = normalizePath(snapshot.entry, cwd);
              }
              if (prepared.command === 'echo') {
                childProc.processObject.stdout.write(`${prepared.commandArgs.join(' ')}\n`);
              } else {
                if (prepared.source === null) {
                  for (const preload of prepared.preloads) {
                    loadModuleSync(normalizePath(preload, cwd), entryPath, childProc.processObject, scope, Buffer, stderrArr, undefined, moduleState, false, compileCacheState);
                  }
                }
                const childSource = prepared.source === null ? undefined : prepared.source;
                loadModuleSync(entryPath, entryPath, childProc.processObject, scope, Buffer, stderrArr, childSource, moduleState, true, compileCacheState);
                if (prepared.buildSnapshot && prepared.snapshotBlobPath) {
                  fs.writeFileSync(
                    prepared.snapshotBlobPath,
                    JSON.stringify({ version: 1, entry: prepared.scriptPath || prepared.mainPath }),
                    'utf8',
                  );
                }
              }
              if (!childProc.processObject._exitRequested?.() && !options.ipc && !childProc.processObject._bnhHasPendingAbortWorker?.()) {
                childProc.processObject._emitBeforeExit?.();
                childProc.processObject._markExited?.();
              }
            } catch (error) {
              stderrArr.push(`${error?.stack || error}\n`);
              childProc.processObject.exit(1);
            } finally {
              if (compileCacheState?.primaryAction === 'same') {
                const basename = (compileCacheState.primaryPath || entryPath).split('/').pop() || entryPath;
                stderrArr.push(`[compile cache] skip ${basename} because cache was the same\n`);
                typeof stderr === 'function' ? stderr(`[compile cache] skip ${basename} because cache was the same\n`) : null;
              }
              scope.process = previousState.process;
              scope.console = previousState.console;
              scope.global = previousState.global;
              scope.Buffer = previousState.Buffer;
              scope.setTimeout = previousState.setTimeout;
              scope.clearTimeout = previousState.clearTimeout;
              scope.setInterval = previousState.setInterval;
              scope.clearInterval = previousState.clearInterval;
              scope.setImmediate = previousState.setImmediate;
              scope.clearImmediate = previousState.clearImmediate;
              if (typeof originalReadFileSync === 'function') fs.readFileSync = originalReadFileSync;
            }
            const encoding = options?.encoding;
            const stdoutValue = encoding && encoding !== 'buffer' ? stdoutArr.join('') : Buffer.from(stdoutArr.join(''));
            const stderrValue = encoding && encoding !== 'buffer' ? stderrArr.join('') : Buffer.from(stderrArr.join(''));
          return {
              pid: childProc.processObject.pid,
              stdout: stdoutValue,
              stderr: stderrValue,
              status: childProc.processObject.getCode(),
              pending: childProc.processObject._bnhHasPendingAbortWorker?.() || false,
              signal: null,
              error: null,
              process: options.ipc ? childProc.processObject : null,
          };
        }

        function runPreparedESM(prepared, options, writeStdout, writeStderr) {
          const snapshot = vfs.snapshot();
          const files = Object.fromEntries(
            snapshot.artifacts.map(({ path, bytes }) => [path, new Uint8Array(bytes)]),
          );
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
          const childExecArgv = prepared.executionArgv
            .slice(1, scriptIndex < 0 ? prepared.executionArgv.length : scriptIndex)
            .filter((value) => String(value).startsWith('-'));
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
                network: virtualNetwork.hasBindings?.() ? virtualNetwork : undefined,
              },
            },
            // Live virtual socket owners cannot cross a structured-cloned
            // Worker boundary. Keep children that may reach a parent-owned
            // server in this browser realm so they can use its registry.
            forceFallback: Boolean(proxyCapability.adapter || virtualNetwork.hasBindings?.()),
            stdout: writeStdout,
            stderr: forwardStderr,
          });
        }

        return {
          spawnSync(file, args, options = {}) {
            return runPreparedSync(prepareChild(file, args, options), options);
          },
          execFileSync(file, args, options = {}) {
            if (!Array.isArray(args)) { options = args || {}; args = []; }
            if (options?.shell === true) {
              const parsed = parseShellCommand([file, ...args].join(' '), { ...processObject.env, ...(options?.env || {}) });
              file = parsed.file;
              args = parsed.args;
            }
            const result = runPreparedSync(prepareChild(file, args, options), options);
            if (result.status !== 0) {
              const error = Object.assign(new Error(`Command failed: ${file}`), result);
              throw error;
            }
            return result.stdout;
          },
          execSync(command, options = {}) {
            const parsed = parseShellCommand(command, { ...processObject.env, ...(options?.env || {}) });
            return this.execFileSync(parsed.file, parsed.args, { ...options, stdinPath: parsed.stdinPath });
          },
          execFile(file, args, options, callback) {
            if (typeof args === 'function') { callback = args; args = []; options = {}; }
            else if (typeof options === 'function') { callback = options; options = {}; }
            if (options?.shell === true) {
              const parsed = parseShellCommand([file, ...(args || [])].join(' '), { ...processObject.env, ...(options?.env || {}) });
              file = parsed.file;
              args = parsed.args;
            }
            return virtualAsync(file, args || [], options || {}, callback, true);
          },
          exec(command, options, callback) {
            if (typeof options === 'function') { callback = options; options = {}; }
            const parsed = parseShellCommand(command, { ...processObject.env, ...(options?.env || {}) });
            return virtualAsync(parsed.file, parsed.args, { ...options, stdinPath: parsed.stdinPath }, callback, true);
          },
          spawn(file, args, options) {
            if (!Array.isArray(args)) { options = args || {}; args = []; }
            return virtualAsync(file, args || [], options || {});
          },
          fork(modulePath, args = [], options = {}) {
            if (!Array.isArray(args)) { options = args || {}; args = []; }
            const childOptions = { ...options, ipc: true };
            if (modulePath === '-e') return virtualAsync(processObject.execPath, ['-e', ...args], childOptions);
            return virtualAsync(processObject.execPath, [modulePath, ...args], childOptions);
          },
        };
      })(),
      vm,
    };
  }

  async function execute(entry, options, stdout, stderr) {
    installAbortSignalCompatibility(scope);
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
    const hasLiveVirtualProcess = () => {
      const registry = scope.__BNH_VIRTUAL_PROCESS_REGISTRY__;
      if (!registry) return false;
      const currentPid = Number(injectedProcess?.pid);
      for (const handle of registry.values()) {
        // A same-realm fallback child is registered before its entry starts.
        // Do not count that child itself as an external live process or its
        // event loop can never reach the idle shutdown condition.
        if (Number.isInteger(currentPid) && Number(handle?.pid) === currentPid) continue;
        if (!handle.terminal && !['exited', 'failed'].includes(handle.state)) return true;
      }
      return false;
    };
    const fullProcessData = createProcess(scope, { ...options, isPidAlive: isVirtualPidAlive }, stdout, stderr, trackTask);
    const processData = injectedProcess
      ? (() => {
          const processObject = fullProcessData.processObject;
          // Preserve injected process identity and capabilities (stdout, stderr, exit control, IPC)
          processObject.stdout = injectedProcess.stdout || processObject.stdout;
          processObject.stderr = injectedProcess.stderr || processObject.stderr;
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
          processObject.channel = injectedProcess.channel || processObject.channel;
          processObject.disconnect = () => { if (typeof injectedProcess.disconnect === 'function') return injectedProcess.disconnect(); return false; };
          processObject.exitCode = (injectedProcess.exitCode !== undefined) ? injectedProcess.exitCode : processObject.exitCode;
          processObject.env = injectedProcess.env || processObject.env;
          processObject.argv = injectedProcess.argv || processObject.argv;
          processObject._bnhClusterGroupId = injectedProcess._bnhClusterGroupId;
          processObject.cwd = (injectedProcess.cwd) ? (() => injectedProcess.cwd()) : processObject.cwd;
          processObject.chdir = (value) => { if (injectedProcess.chdir) return injectedProcess.chdir(value); processObject.cwd = () => normalizePath(value, processObject.cwd()); };
          processObject.config = BROWSER_PROCESS_CONFIG;
          processObject.features = BROWSER_PROCESS_FEATURES;
          processObject.versions = BROWSER_PROCESS_VERSIONS;
          return { processObject, setTimer: fullProcessData.setTimer, clearTimer: fullProcessData.clearTimer };
        })()
      : fullProcessData;
    const processObject = processData.processObject;
    if (Array.isArray(options.execArgv)) processObject.execArgv = [...options.execArgv];
    const setTimer = processData.setTimer;
    const clearTimer = processData.clearTimer;
    vfs.setTaskTracker?.(trackTask);
    const diagnosticsChannels = createDiagnosticsModule();
    const performancePrimitives = createPerformancePrimitives(scope, { fallback: 'virtual' });
    Object.assign(processObject, performancePrimitives.processMetadata);
    const browserIO = createBrowserIO(scope);
    const createRuntimeWorker = typeof scope.Worker === 'function'
      ? createWorkerFactory(scope, { bootstrap: WORKER_BOOTSTRAP })
      : undefined;
    function RuntimeWorker(...args) {
      const worker = createRuntimeWorker(...args);
      const ownerProcess = scope.process || processObject;
      if (typeof ownerProcess._bnhWorkerCreated === 'function') {
        ownerProcess._bnhWorkerCreated();
        worker.once('error', (error) => ownerProcess._bnhWorkerError?.(error));
      }
      return worker;
    }
    const workerThreads = {
      ...browserIO,
      Worker: createRuntimeWorker ? RuntimeWorker : undefined,
      isMainThread: true,
      parentPort: null,
      workerData: undefined,
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
      const request = builtins.http.request(url, {
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
        const status = Number(lines.shift()?.split(' ')[1] || 0);
        const headers = {};
        for (const line of lines) {
          const separator = line.indexOf(':');
          if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
        return { end: end + 4, status, headers };
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
              fail(new Error(`proxy CONNECT failed with status ${response.status}`));
              return;
            }
            bytes = bytes.slice(response.end);
            stage = 'response';
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
          if (settled || stage !== 'response') return;
          const response = parseHeaders(bytes);
          if (!response) return fail(new Error('proxy response ended before headers'));
          finish(response.status, response.headers, bytes.slice(response.end));
        });
      });
    };
    const runtimeFetch = (input, init = {}) => {
      const env = processObject.env || {};
      const target = String(input?.url || input);
      const useEnvProxy = /^(?:1|true)$/i.test(String(env.NODE_USE_ENV_PROXY || ''));
      const proxyUrl = env.http_proxy || env.HTTP_PROXY;
      if (useEnvProxy && proxyUrl && /^http:/i.test(target) && !virtualFetchDepth) {
        return virtualProxyFetch(input, init, proxyUrl);
      }
      return virtualHttpFetch(input, init);
    };
    builtins.worker_threads = workerThreads;
    const cache = new Map();
    const executionGlobal = createExecutionGlobal(scope);
    let mainModule = null;
    const loadModule = (specifier, importer = entry) => {
      const name = builtinName(specifier);
      if (BUILTIN_NAMES.includes(name)) return builtins[name];
      const resolved = resolveFile(specifier, importer);
      if (resolved.startsWith('data:')) return {};
      if (cache.has(resolved)) return cache.get(resolved).exports;
      const source = vfs.read(resolved);
      const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
      const module = {
        exports: {},
        id: resolved,
        filename: resolved,
        loaded: false,
        parent: null,
        children: [],
      };
      if (!mainModule && resolved === entry) mainModule = module;
      cache.set(resolved, module);
      if (resolved.endsWith('.json')) module.exports = JSON.parse(text);
      else {
        const require = (name) => loadModule(name, resolved);
        require.resolve = (name) => BUILTIN_NAMES.includes(builtinName(name)) ? name : resolveFile(name, resolved);
        require.main = mainModule;
        require.cache = cache;
        module.require = require;
        runCommonJSWrapper(
          text,
          resolved,
          [require, module, module.exports, resolved, path.dirname(resolved)],
          [
            processObject, executionGlobal, executionGlobal, scope.setTimeout, scope.clearTimeout,
            scope.setImmediate, scope.clearImmediate, builtins.vm,
          ],
        );
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
      evaluateCommonJS: (specifier, importer) => loadModule(specifier, importer),
    });
    scope.__bnhModuleLoader = { resolvePackageExport: (name) => name, require: loadModule };
    const previous = {
      process: scope.process,
      Buffer: scope.Buffer,
      console: scope.console,
      global: scope.global,
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
    };
    const deterministicEnvironment = Object.freeze({
      variant: options.variant || 'browser',
      platform: processObject.platform,
      arch: processObject.arch,
    });
    const childConsole = createConsole(stdout, stderr, scope.console || {});
    const onUnhandledRejection = (event) => {
      const handled = processObject.emit('unhandledRejection', event.reason, event.promise);
      if (!handled) {
        stderr(`${event.reason?.stack || event.reason}\n`);
        processObject.exitCode ||= 1;
      }
      event.preventDefault?.();
    };
    if (typeof scope.addEventListener === 'function') scope.addEventListener('unhandledrejection', onUnhandledRejection);
    if (typeof scope.gc !== 'function') scope.gc = () => {};
    Object.assign(scope, {
      process: processObject,
      Buffer,
      console: childConsole,
      global: scope,
      URL: builtins.url.URL,
      URLSearchParams: builtins.url.URLSearchParams,
      __bnh: { deterministicEnvironment },
      setTimeout: (callback, delay, ...args) => setTimer(() => callback(...args), delay),
      clearTimeout: clearTimer,
      setInterval: (callback, delay, ...args) => setTimer(() => callback(...args), delay, true),
      clearInterval: clearTimer,
      setImmediate: (callback, ...args) => setTimer(() => callback(...args), 1),
      clearImmediate: clearTimer,
      fetch: runtimeFetch,
    });
    vfs.mkdir('/node/deps/corepack', { recursive: true });
    vfs.writeFile('/node/deps/corepack/package.json', JSON.stringify({ version: '0.34.6' }));
    try {
      if (entry.endsWith('.mjs')) await esmLoader.import(entry, entry);
      else loadModule(entry, entry);
      await Promise.resolve();
      let idleRounds = 0;
      while (!options.isCancelled?.() && !options.signal?.aborted && !processObject._exitRequested?.()) {
        const activeTimers = processObject._timers || timerHandles;
        const hasActiveTimers = processObject._hasActiveReferencedTimers?.() ?? activeTimers.size > 0;
        if (pending === 0 && !hasActiveTimers && !hasLiveVirtualProcess()) {
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
      for (const handle of [...timerHandles]) clearTimer?.(handle);
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
        vfs.snapshot().artifacts.map(({ path, bytes }) => [path, new Uint8Array(bytes)]),
      );
      const spawnProxy = proxyCapability.adapter ? proxyCapability : capabilities.manifest.proxy;
      const processOptions = {
        runId: runSpec.runId,
        childId: `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        entry,
        argv,
        env: options.env,
        cwd: options.cwd || '/node',
        signalGrants: capabilities.manifest.signals.allowed,
        workerSource,
        workerType: 'module',
        timeout: options.timeout,
        runSource: '((context) => globalThis.__bnhRun(context))',
        vfs: { capabilities: capabilities.manifest, files, entry, proxy: spawnProxy },
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
