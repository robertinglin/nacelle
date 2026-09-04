import { EventEmitter } from './events.js';
import { Readable, Writable, ensureOutputStream } from './streams.js';
import { adaptMessagePort, adaptWorker, createIpcError, createMessageChannel, createScopedIpcEndpoint, createWorkerFactory } from './messaging.js';
import { createProcessWorkerSource } from './process-worker.js';
import { browserCryptoVersion } from './crypto.js';
import { installWarningContract } from './warnings.js';
import { installProcessFinalization } from './finalization.js';
import { unsupportedBoundary } from './errors.js';
import { inspect as nodeInspect } from './assert.js';
import { resolveNodeVersionProfile } from '../versions/index.js';

export { PROCESS_WORKER_SOURCE } from './process-worker.js';

const SIGNALS = Object.freeze(new Set(['SIGTERM', 'SIGINT', 'SIGKILL']));
const STATES = Object.freeze(['created', 'starting', 'running', 'stopping', 'exited', 'failed']);
let nextProcessId = 1000;
let nextRunId = 1;
const sharedFileBuffers = new WeakMap();

function resolveLogicalCwd(value, cwd = '/node') {
  const input = String(value);
  const source = input.startsWith('/') ? input : `${String(cwd).replace(/\/+$/, '') || '/'}/${input}`;
  const parts = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function execveTypeError(name, expected, value) {
  const received = value === null
    ? 'null'
    : value === undefined
      ? 'undefined'
      : Array.isArray(value)
        ? 'an instance of Array'
        : typeof value === 'object'
          ? `an instance of ${value.constructor?.name || 'Object'}`
          : `type ${typeof value} (${nodeInspect(value, { colors: false })})`;
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function inspectExecveValue(value, options) {
  if (options?.depth === 0 && value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value).map(([key, entry]) => (
      `${key}: ${inspectExecveValue(entry, { ...options, depth: -1 })}`
    ));
    return `{ ${entries.join(', ')} }`;
  }
  return nodeInspect(value, options).replaceAll('\u0000', '\\x00');
}

function execveValueError(name, value, reason) {
  const error = new TypeError(`The argument '${name}' must be ${reason}. Received ${inspectExecveValue(value, { colors: false, depth: 0 })}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

export function createBrowserExecve(processObject) {
  let warned = false;
  return function execve(execPath, args = [], env = processObject.env) {
    if (!warned) {
      warned = true;
      processObject.emitWarning?.(
        'process.execve is an experimental feature and might change at any time',
        { type: 'ExperimentalWarning' },
      );
    }
    if (typeof execPath !== 'string') throw execveTypeError('execPath', 'of type string', execPath);
    if (!Array.isArray(args)) throw execveTypeError('args', 'an instance of Array', args);
    for (let index = 0; index < args.length; index += 1) {
      if (typeof args[index] !== 'string' || args[index].includes('\u0000')) {
        throw execveValueError(`args[${index}]`, args[index], 'a string without null bytes');
      }
    }
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw execveTypeError('env', 'of type object', env);
    }
    for (const [key, value] of Object.entries(env)) {
      if (key.includes('\u0000') || typeof value !== 'string' || value.includes('\u0000')) {
        throw execveValueError('env', env, 'an object with string keys and values without null bytes');
      }
    }
    unsupportedBoundary('real-subprocesses', 'process.execve requires a real subprocess boundary');
  };
}

function shareFileBytes(bytes, scope) {
  if (!(bytes instanceof Uint8Array)) return bytes;
  if (bytes.buffer instanceof scope.SharedArrayBuffer) return bytes;
  let shared = sharedFileBuffers.get(bytes);
  if (!shared) {
    shared = new scope.SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(shared).set(bytes);
    sharedFileBuffers.set(bytes, shared);
  }
  return new Uint8Array(shared);
}

export function prepareWorkerVfs(vfs, scope) {
  if (!vfs?.files || scope.crossOriginIsolated !== true
    || typeof scope.SharedArrayBuffer !== 'function') return vfs;
  const shareFileValue = (value) => {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return shareFileBytes(value instanceof Uint8Array ? value : new Uint8Array(value), scope);
    }
    if (value && typeof value === 'object' && value.data !== undefined) {
      return { ...value, data: shareFileValue(value.data) };
    }
    return value;
  };
  const files = Object.fromEntries(
    Object.entries(vfs.files).map(([path, value]) => [path, shareFileValue(value)]),
  );
  const artifacts = Array.isArray(vfs.artifacts)
    ? vfs.artifacts.map((artifact) => ({ ...artifact, bytes: shareFileBytes(artifact.bytes, scope) }))
    : vfs.artifacts;
  return { ...vfs, files, artifacts };
}

function format(...values) {
  if (!values.length) return '';
  let first = String(values[0]);
  let index = 1;
  first = first.replace(/%[sdijo%]/g, (token) => token === '%%' ? '%' : index >= values.length ? token : token === '%j' ? JSON.stringify(values[index++]) : String(values[index++]));
  return [first, ...values.slice(index).map((value) => typeof value === 'object' ? JSON.stringify(value) : String(value))].join(' ');
}

function errorWithCode(code, message) {
  const error = createIpcError(code, message);
  return error;
}

function signalName(signal) {
  if (typeof signal === 'number') return ({ 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' })[signal] || String(signal);
  return String(signal || 'SIGTERM').toUpperCase();
}

function validateSignal(signal, grants) {
  const name = signalName(signal);
  if (!SIGNALS.has(name)) throw errorWithCode('ERR_INVALID_SIGNAL', `invalid signal: ${signal}`);
  if (!grants.has(name)) throw errorWithCode('ERR_CAPABILITY_DENIED', `signal capability denied: ${name}`);
  return name;
}

function stringEnvironment(env = {}) {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [String(key), String(value)]));
}

function normalizeError(value, fallbackCode) {
  const source = value?.error && value.error !== value ? value.error : value;
  if (source instanceof Error) return source;
  const message = source?.message || value?.message || (typeof value === 'string' ? value : null) || 'worker failed';
  const error = new Error(String(message));
  if (source?.name || value?.name) error.name = source?.name || value.name;
  if (source?.stack || value?.stack) error.stack = source?.stack || value.stack;
  if (source?.code || value?.code || fallbackCode) error.code = source?.code || value?.code || fallbackCode;
  if (source?.cause) error.cause = source.cause;
  if (value?.filename) error.fileName = value.filename;
  if (value?.lineno) error.lineNumber = value.lineno;
  if (value?.colno) error.columnNumber = value.colno;
  return error;
}

function selectedProfile(value) {
  return resolveNodeVersionProfile(value?.id || value || 'lts');
}

function processVersions(scope = globalThis, profile = selectedProfile()) {
  const versions = { ...profile.versions };
  // This is the runtime identity Next.js checks to enter its supported
  // WebContainer SWC-WASM fallback path.
  versions.webcontainer = '1.0.0';
  const openssl = browserCryptoVersion(scope);
  if (openssl) versions.openssl = openssl;
  return versions;
}

function credentialError(kind, value) {
  const error = new Error(`${kind} identifier does not exist: ${value}`);
  error.code = 'ERR_UNKNOWN_CREDENTIAL';
  return error;
}

function invalidCredentialType(value, argumentName = 'id') {
  const received = value === null || value === undefined
    ? String(value)
    : typeof value === 'function'
      ? `function ${value.name || ''}`
      : typeof value === 'object'
        ? `an instance of ${value.constructor?.name || 'Object'}`
        : `type ${typeof value} (${nodeInspect(value, { colors: false })})`;
  const error = new TypeError(`The "${argumentName}" argument must be one of type number or string. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateCredentialType(value, argumentName = 'id') {
  if (typeof value !== 'number' && typeof value !== 'string') throw invalidCredentialType(value, argumentName);
}

function normalizeCredential(value, kind, argumentName = 'id') {
  validateCredentialType(value, argumentName);
  if (typeof value === 'string' && !/^[0-9]+$/.test(value)) throw credentialError(kind, value);
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
    const error = new RangeError(`invalid ${kind.toLowerCase()} identifier: ${value}`);
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
  return numeric;
}

/** Add browser-local process capabilities to an injected worker process. */
export function installProcessContract(process, {
  uid = 1000,
  gid = 1000,
  umask = 0o022,
  scope = globalThis,
  nodeVersion = 'lts',
  nodeProfile,
} = {}) {
  const profile = selectedProfile(nodeProfile || nodeVersion);
  let currentUid = uid;
  let currentGid = gid;
  let currentUmask = umask & 0o777;
  process.version = profile.runtimeVersion;
  process.release = profile.release;
  process.config = profile.config;
  process.features = profile.features;
  process.execPath ||= '/browser/node';
  process.argv0 ||= 'node';
  process.versions = processVersions(scope, profile);
  if (typeof process.hrtime !== 'function') {
    const hrtime = (previous) => {
      const now = Math.floor((scope.performance?.now?.() || 0) * 1e6);
      const current = [Math.floor(now / 1e9), now % 1e9];
      if (previous === undefined) return current;
      if (!Array.isArray(previous) || previous.length < 2) {
        throw new TypeError('process.hrtime() previous value must be a [seconds, nanoseconds] array');
      }
      let seconds = current[0] - Number(previous[0]);
      let nanoseconds = current[1] - Number(previous[1]);
      if (nanoseconds < 0) {
        seconds -= 1;
        nanoseconds += 1e9;
      }
      return [seconds, nanoseconds];
    };
    Object.defineProperty(hrtime, 'bigint', {
      configurable: true,
      value: () => {
        if (typeof BigInt !== 'function') throw new Error('process.hrtime.bigint requires BigInt support');
        return BigInt(Math.floor((scope.performance?.now?.() || 0) * 1e6));
      },
    });
    process.hrtime = hrtime;
  } else if (typeof process.hrtime.bigint !== 'function') {
    try {
      Object.defineProperty(process.hrtime, 'bigint', {
        configurable: true,
        value: () => {
          if (typeof BigInt !== 'function') throw new Error('process.hrtime.bigint requires BigInt support');
          return BigInt(Math.floor((scope.performance?.now?.() || 0) * 1e6));
        },
      });
    } catch { /* preserve an immutable host implementation */ }
  }
  if (browserCryptoVersion(scope)) process.versions.openssl ||= browserCryptoVersion(scope);
  process.umask ||= (mask) => {
    const previous = currentUmask;
    if (mask === undefined) return previous;
    if (typeof mask === 'string' && !/^[0-7]+$/.test(mask)) {
      const error = new TypeError('The "mask" argument must be a valid octal string');
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    if (typeof mask !== 'number' && typeof mask !== 'string') {
      const error = new TypeError('The "mask" argument must be a number or an octal string');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    const numeric = typeof mask === 'string' ? Number.parseInt(mask, 8) : mask;
    if (!Number.isInteger(numeric) || numeric < 0) {
      const error = new RangeError('The "mask" argument must be a non-negative integer');
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    currentUmask = numeric & 0o777;
    return previous;
  };
  const installCredential = (name, kind, getter) => {
    process[`get${name}`] ||= () => getter();
    process[`set${name}`] ||= (value) => {
      const numeric = normalizeCredential(value, kind);
      if (name === 'uid' || name === 'euid') currentUid = numeric;
      else currentGid = numeric;
    };
  };
  installCredential('uid', 'User', () => currentUid);
  installCredential('euid', 'User', () => currentUid);
  installCredential('gid', 'Group', () => currentGid);
  installCredential('egid', 'Group', () => currentGid);
  process.getgroups ||= () => [currentGid];
  process.initgroups ||= (user, extraGroup) => {
    validateCredentialType(user, 'user');
    validateCredentialType(extraGroup, 'extraGroup');
    normalizeCredential(extraGroup, 'Group', 'extraGroup');
    normalizeCredential(user, 'User', 'user');
  };
  process.getBuiltinModule ||= (id) => {
    if (typeof id !== 'string') throw execveTypeError('id', 'of type string', id);
    return undefined;
  };
  if (process.stdout) process.stdout = ensureOutputStream(process.stdout);
  if (process.stderr) process.stderr = ensureOutputStream(process.stderr);
  installProcessStderrSurface(process.stderr, process);
  if (process.stdout) process.stdout.isTTY = false;
  if (process.stderr) process.stderr.isTTY = false;
  return process;
}

function outputWrite(endpoint, value) {
  if (!endpoint) return;
  if (typeof endpoint === 'function') endpoint(value);
  else if (typeof endpoint.write === 'function') endpoint.write(value);
  else if (typeof endpoint.push === 'function') endpoint.push(value);
  else throw new TypeError('output endpoint must provide write(), push(), or be a function');
}

async function serializeProxyResponse(response) {
  if (!response || typeof response.arrayBuffer !== 'function' || !Number.isInteger(response.status)) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers = response.headers && typeof response.headers.entries === 'function'
    ? Object.fromEntries(response.headers.entries())
    : {};
  return {
    __bnhResponse: true,
    status: response.status,
    statusText: response.statusText || '',
    headers,
    body: bytes,
  };
}

function makeWritableEndpoint(endpoint) {
  if (endpoint && typeof endpoint.write === 'function') return ensureOutputStream(endpoint);
  if (Array.isArray(endpoint)) return new Writable({ write(chunk, _encoding, callback) { endpoint.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)); callback(); } });
  return new Writable({ write(chunk, _encoding, callback) { outputWrite(endpoint, chunk); callback(); } });
}

function installProcessStdoutSurface(stream) {
  if (!stream) return;
  const fields = {
    _host: null,
    _isStdio: true,
    _parent: null,
    _pendingData: null,
    _pendingEncoding: '',
  };
  for (const [name, value] of Object.entries(fields)) {
    if (Object.hasOwn(stream, name)) continue;
    Object.defineProperty(stream, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
}

function installProcessStderrSurface(stream, processObject) {
  if (!stream || stream.__BNH_PROCESS_STDERR_SURFACE__) return;
  Object.defineProperty(stream, '__BNH_PROCESS_STDERR_SURFACE__', {
    configurable: false,
    enumerable: false,
    value: true,
  });
  const readable = new (class extends EventEmitter {
    constructor() {
      super();
      this.readable = false;
      this.readableEnded = true;
      this.readableEncoding = null;
    }
    resume() { return this; }
    setEncoding(encoding = 'utf8') {
      if (typeof encoding !== 'string') {
        const error = new TypeError(`Unknown encoding: ${encoding}`);
        error.code = 'ERR_UNKNOWN_ENCODING';
        throw error;
      }
      this.readableEncoding = encoding;
      return this;
    }
    async some() { return false; }
  })();
  const emptyReadable = () => new Readable({ read() {}, readable: false });
  const socketPrototype = Object.create(Object.getPrototypeOf(stream));
  Object.defineProperties(stream, {
    server: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: null,
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
  });
  Object.defineProperties(socketPrototype, {
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
    setNoDelay: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(enable = true) {
        this._noDelay = Boolean(enable);
        return this;
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
        if (milliseconds === 0) return this;
        if (callback) this.once?.('timeout', callback);
        this._timeout = processObject?._bnhSetTimer?.(
          () => { this._timeout = null; this.emit?.('timeout'); },
          milliseconds,
          false,
          'Timeout',
        );
        this._timeout?.unref?.();
        return this;
      },
    },
    some: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return readable.some(...args); },
    },
    drop: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return emptyReadable().drop(...args); },
    },
    every: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return emptyReadable().every(...args); },
    },
    filter: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return emptyReadable().filter(...args); },
    },
    find: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return emptyReadable().find(...args); },
    },
    flatMap: {
      configurable: true,
      enumerable: false,
      writable: true,
      value(...args) { return emptyReadable().flatMap(...args); },
    },
  });
  Object.setPrototypeOf(stream, socketPrototype);
}

function transition(state, next) {
  const index = STATES.indexOf(state);
  const nextIndex = STATES.indexOf(next);
  const valid = next === 'failed' ||
    (next === 'exited' && (state === 'running' || state === 'stopping')) ||
    (next === 'stopping' && (state === 'created' || state === 'starting' || state === 'running')) ||
    (nextIndex >= index && nextIndex === index + 1);
  return valid ? next : state;
}

function workerFactoryFor(options) {
  if (options.workerFactory) return options.workerFactory;
  if (options.Worker) return (source, workerOptions) => {
    const worker = new options.Worker(source, workerOptions);
    return typeof worker.on === 'function' ? worker : adaptWorker(worker);
  };
  if (typeof options.scope?.Worker === 'function') return createWorkerFactory(options.scope);
  return null;
}

function messageChannelFor(options, scope) {
  if (options.messageChannelFactory) return options.messageChannelFactory();
  if (typeof options.MessageChannel === 'function') {
    const raw = new options.MessageChannel();
    return { raw, port1: adaptMessagePort(raw.port1), port2: adaptMessagePort(raw.port2) };
  }
  return createMessageChannel(scope);
}

function makeRunSource(options) {
  if (typeof options.runSource === 'string') return options.runSource;
  if (typeof options.run === 'function') return options.run.toString();
  if (typeof options.entry === 'function') return options.entry.toString();
  if (typeof options.execute === 'function') return options.execute.toString();
  if (typeof options.script === 'string') return `(function(context) {\n${options.script}\n})`;
  throw new TypeError('a worker run function or script is required');
}

function createIdentity(options, runId, childId) {
  const profile = selectedProfile(options.nodeProfile || options.nodeVersion || options.vfs?.nodeVersion);
  return {
    runId,
    childId,
    pid: options.pid ?? nextProcessId++,
    ppid: Number(options.ppid ?? options.parentPid ?? options.parent?.pid ?? 0),
    argv: (Array.isArray(options.argv) ? options.argv : ['browser-worker']).map(String),
    env: stringEnvironment(options.env),
    cwd: String(options.cwd || '/node'),
    version: profile.runtimeVersion,
    // Child processes receive this identity verbatim. Keep the WebContainer
    // marker on that boundary so libraries such as Next.js make the same
    // WASM-first decision in forked workers as they do in the parent.
    versions: { ...profile.versions, webcontainer: '1.0.0' },
    release: { ...profile.release },
    config: profile.config,
    features: profile.features,
  };
}

function createTerminalRecord(identity, state, frame) {
  return Object.freeze({
    runId: identity.runId,
    childId: identity.childId,
    pid: identity.pid,
    ppid: identity.ppid,
    argv: [...identity.argv],
    env: { ...identity.env },
    cwd: identity.cwd,
    state,
    status: frame.status || (state === 'failed' ? 'failed' : 'exited'),
    kind: frame.kind || 'worker-error',
    code: frame.code ?? null,
    signal: frame.signal ?? null,
    forced: Boolean(frame.forced),
    error: frame.error ? { ...frame.error } : null,
    runtimeState: frame.runtimeState || null,
  });
}

/** Create the compatibility process object used inside a browser realm. */
export function createProcess({
  argv,
  env,
  cwd,
  execArgv,
  output = {},
  platform = 'linux',
  arch = 'x64',
  exit,
  pid = 1,
  ppid = 0,
  ipc,
  signalGrants,
  scope = globalThis,
  nodeVersion = 'lts',
  nodeProfile,
} = {}) {
  const profile = selectedProfile(nodeProfile || nodeVersion);
  let logicalCwd = String(cwd || '/node');
  let exitCode = 0;
  let exited = false;
  let exitRequested = false;
  const grants = new Set(signalGrants || SIGNALS);
  const process = new EventEmitter();
  process.version = profile.runtimeVersion;
  process.versions = processVersions(scope, profile);
  process.release = profile.release;
  process.platform = platform;
  process.arch = arch;
  process.pid = pid;
  process.ppid = ppid;
  process.debugPort = 9229;
  process.argv = [...(argv || ['node'])].map(String);
  process.execArgv = [...(execArgv || [])].map(String);
  process.env = stringEnvironment(env);
  process.execve = createBrowserExecve(process);
  process.exitCode = 0;
  process.title = 'node';
  process.connected = Boolean(ipc);
  if (ipc) process.channel = ipc;
  process.state = 'running';
  process.cwd = () => logicalCwd;
  process.chdir = (value) => { logicalCwd = resolveLogicalCwd(value, logicalCwd); };
  process.nextTick = (callback, ...args) => queueMicrotask(() => callback(...args));
  process.hrtime = (previous) => {
    const now = performance.now();
    const seconds = Math.floor(now / 1000);
    const nanos = Math.floor((now % 1000) * 1e6);
    return previous ? [seconds - previous[0], nanos - previous[1]] : [seconds, nanos];
  };
  Object.defineProperty(process.hrtime, 'bigint', {
    configurable: true,
    value: () => BigInt(Math.floor(performance.now() * 1e6)),
  });
  process.uptime = () => performance.now() / 1000;
  process.exit = (code = 0) => {
    if (exited) return;
    exitCode = Number(code) || 0;
    exitRequested = true;
    process.exitCode = exitCode;
    process.emit('exit', exitCode);
    exited = true;
    process.state = 'exited';
    exit?.(exitCode);
  };
  process.reallyExit = () => {
    exitCode = Number(process.exitCode) || 0;
    process.exitCode = exitCode;
    exitRequested = true;
    exited = true;
  };
  process.kill = (_pid, signal = 'SIGTERM') => {
    const name = validateSignal(signal, grants);
    if (exited) throw errorWithCode('ERR_PROCESS_EXITED', 'process has already exited');
    const handled = process.emit(name);
    if (!handled || name === 'SIGKILL') process.exit(1);
    return true;
  };
  process.send = (...args) => {
    if (!ipc) throw errorWithCode('ERR_IPC_CLOSED', 'IPC channel is closed');
    if (typeof ipc.sendWithHandle === 'function') {
      const [value, sendHandle, sendOptions, callback] = args;
      if (typeof sendHandle === 'function') return ipc.sendWithHandle(value, undefined, undefined, sendHandle);
      if (typeof sendOptions === 'function') return ipc.sendWithHandle(value, sendHandle, undefined, sendOptions);
      return ipc.sendWithHandle(value, sendHandle, undefined, callback);
    }
    return ipc.send(...args);
  };
  process.__bnhSendInternal = (value) => ipc?.sendInternal?.(value) || false;
  process.disconnect = () => {
    if (!ipc) return false;
    process.connected = false;
    const result = ipc.disconnect();
    if (result) process.emit('disconnect');
    return result;
  };
  process.stdout = makeWritableEndpoint(output.stdout);
  process.stderr = makeWritableEndpoint(output.stderr);
  installProcessStdoutSurface(process.stdout);
  Object.defineProperty(process, 'exitCode', { configurable: true, enumerable: true, get: () => exitCode, set: (value) => { exitCode = Number(value) || 0; } });
  process.getCode = () => exitCode;
  process._exitRequested = () => exitRequested;
  process._markExited = () => { if (!exited) process.exit(exitCode); };
  process.stdin = new EventEmitter();
  process.stdin.end = function end(_chunk, _encoding, callback) {
    if (typeof _encoding === 'function') callback = _encoding;
    callback?.();
    return this;
  };
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  process.stderr.isTTY = false;
  installProcessContract(process, { scope, nodeProfile: profile });
  installWarningContract(process);
  installProcessFinalization(process);
  return process;
}

export function createConsole(output = { stdout: [], stderr: [] }) {
  const write = (stream, values) => output[stream].push(format(...values) + '\n');
  return { log: (...values) => write('stdout', values), info: (...values) => write('stdout', values), debug: (...values) => write('stdout', values), warn: (...values) => write('stderr', values), error: (...values) => write('stderr', values), dir: (value) => write('stdout', [value]), time: () => {}, timeEnd: () => {}, trace: (...values) => write('stderr', values), assert: (value, ...values) => { if (!value) write('stderr', values.length ? values : ['Assertion failed']); } };
}

export function installTimers(process, output = { stderr: [] }) {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, queueMicrotask: globalThis.queueMicrotask };
  const handles = new Set();
  const clear = (clearFn, handle) => { handles.delete(handle); clearFn(handle); };
  globalThis.setTimeout = (callback, delay, ...args) => {
    let handle;
    handle = original.setTimeout(() => { handles.delete(handle); try { callback(...args); } catch (error) { process.emit('uncaughtException', error); output.stderr.push(`${error.stack || error}\n`); process.exitCode ||= 1; } }, delay);
    handles.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => clear(original.clearTimeout, handle);
  globalThis.setInterval = (callback, delay, ...args) => { const handle = original.setInterval(() => { try { callback(...args); } catch (error) { process.emit('uncaughtException', error); output.stderr.push(`${error.stack || error}\n`); process.exitCode ||= 1; } }, delay); handles.add(handle); return handle; };
  globalThis.clearInterval = (handle) => clear(original.clearInterval, handle);
  globalThis.setImmediate = (callback, ...args) => globalThis.setTimeout(callback, 0, ...args);
  globalThis.clearImmediate = globalThis.clearTimeout;
  process.nextTick = (callback, ...args) => globalThis.queueMicrotask(() => callback(...args));
  return () => { for (const handle of handles) original.clearTimeout(handle); handles.clear(); Object.assign(globalThis, original); delete globalThis.setImmediate; delete globalThis.clearImmediate; };
}

/** Start one browser Worker-backed child process. */
export function createBrowserProcess(options = {}) {
  const scope = options.scope || globalThis;
  const runId = String(options.runId || `run-${nextRunId++}`);
  const childId = String(options.childId || `child-${nextProcessId}`);
  const identity = createIdentity(options, runId, childId);
  const grants = new Set(options.signalGrants || options.signals || SIGNALS);
  const events = new EventEmitter();
  let state = 'created';
  const history = ['created'];
  let worker;
  let control;
  let ipc;
  let disconnectDone = false;
  let terminalRecord;
  let spawned = false;
  let startupTimer;
  let pendingTerminal;
  const proxyTransports = new Map();
  let nextProxyTransportId = 1;
  let abortListener;
  let completionResolve;
  let completionReject;
  const completion = new Promise((resolve, reject) => { completionResolve = resolve; completionReject = reject; });
  const child = {
    on(name, listener) { events.on(name, listener); return child; },
    once(name, listener) { events.once(name, listener); return child; },
    emit(name, ...args) { return events.emit(name, ...args); },
    off(name, listener) { events.off(name, listener); return child; },
    removeListener(name, listener) { events.off(name, listener); return child; },
    removeAllListeners(name) { events.removeAllListeners(name); return child; },
    listenerCount(name) { return events.listenerCount(name); },
    pid: identity.pid, ppid: identity.ppid, argv: [...identity.argv], env: { ...identity.env }, cwd: () => identity.cwd,
    get state() { return state; }, get stateHistory() { return [...history]; }, get connected() { return ipc?.connected || false; },
    exitCode: null, signalCode: null, terminal: null,
    get terminalRecord() { return terminalRecord; },
    stdout: options.stdout || options.output?.stdout, stderr: options.stderr || options.output?.stderr,
    send(value, transferList, callback) {
      if (!ipc) {
        const error = errorWithCode('ERR_IPC_CLOSED', 'IPC channel is closed');
        if (typeof transferList === 'function') callback = transferList;
        if (callback) { queueMicrotask(() => callback(error)); return false; }
        throw error;
      }
      return ipc.send(value, transferList, callback);
    },
    disconnect() {
      if (disconnectDone) return false;
      disconnectDone = true;
      try { sendControl('disconnect'); } catch {}
      ipc?.close();
      events.emit('disconnect');
      return true;
    },
    kill(signal = 'SIGTERM') {
      const name = validateSignal(signal, grants);
      if (terminalRecord) throw errorWithCode('ERR_PROCESS_EXITED', 'process has already exited');
      if (name === 'SIGKILL') {
        moveTo('stopping');
        finalize({ status: 'failed', kind: 'signal', code: null, signal: name, forced: true, error: null });
        return true;
      }
      moveTo('stopping');
      sendControl('signal', { signal: name });
      return true;
    },
    signal(signal = 'SIGTERM') { return child.kill(signal); },
    terminate() { return child.kill('SIGKILL'); },
    wait() { return completion; },
  };
  if (typeof options.onNetwork === 'function') events.on('network', options.onNetwork);

  function moveTo(next) {
    const updated = transition(state, next);
    if (updated !== state) { state = updated; history.push(state); }
  }

  function emitDisconnect() {
    if (disconnectDone) return;
    disconnectDone = true;
    events.emit('disconnect');
  }

  function sendControl(type, fields = {}) {
    control.postMessage({ channel: 'bnh-process-control', key, runId, childId, type, ...fields });
  }

  function terminateWorker() {
    const workerToTerminate = worker;
    worker = null;
    const termination = workerToTerminate?.terminate?.();
    if (termination && typeof termination.catch === 'function') termination.catch(() => {});
  }

  function requestWorkerCleanup(frame) {
    const deferredKinds = new Set(['natural', 'exit', 'signal', 'rejection']);
    if (!worker || frame.forced || !deferredKinds.has(frame.kind)) {
      control?.close?.();
      terminateWorker();
      return;
    }
    try {
      sendControl('cleanup');
    } catch {
      control?.close?.();
      terminateWorker();
    }
  }

  function finalize(frame) {
    if (terminalRecord) return;
    if (startupTimer) clearTimeout(startupTimer);
    if (abortListener) options.signal.removeEventListener?.('abort', abortListener);
    const terminalState = frame.status === 'failed' ? 'failed' : 'exited';
    moveTo(terminalState);
    terminalRecord = createTerminalRecord(identity, state, frame);
    child.terminal = terminalRecord;
    child.exitCode = terminalRecord.code;
    child.signalCode = terminalRecord.signal;
    emitDisconnect();
    ipc?.close();
    const error = terminalRecord.error ? normalizeError(terminalRecord.error, terminalRecord.error.code) : null;
    // A parent is allowed to terminate a worker before its ready frame arrives.
    // That is an intentional lifecycle result, not a failed browser bootstrap.
    // Resolving this path also keeps the expected primary-exit cleanup from
    // surfacing an unhandled startup rejection in the outer test process.
    const startupFailure = !spawned && (!frame.forced || frame.kind === 'timeout');
    if (startupFailure) completionReject(error || errorWithCode('ERR_PROCESS_STARTUP', 'worker failed during startup'));
    if (error && !frame.forced) events.emit('error', error);
    events.emit('terminal', terminalRecord);
    events.emit('exit', terminalRecord.code, terminalRecord.signal, terminalRecord);
    events.emit('close', terminalRecord.code, terminalRecord.signal, terminalRecord);
    requestWorkerCleanup(frame);
    completionResolve(terminalRecord);
  }

  function onControlFrame(frame) {
    if (frame?.channel !== 'bnh-process-control' || frame.key !== key || frame.runId !== runId || frame.childId !== childId) return;
    if (frame.type === 'ready') {
      if (spawned || terminalRecord) return;
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      moveTo('running'); spawned = true; events.emit('spawn'); return;
    }
    if (frame.type === 'child-disconnect') { emitDisconnect(); ipc?.close(); return; }
    if (frame.type === 'signal-result') return;
    if (frame.type === 'output') { outputWrite(frame.stream === 'stderr' ? child.stderr : child.stdout, frame.value); return; }
    if (frame.type === 'network') { events.emit('network', frame.event); return; }
    if (frame.type === 'child-signal-request') { try { child.kill(frame.signal); } catch (error) { events.emit('error', error); } return; }
    if (frame.type === 'worker-closed') {
      // process-worker sends this only after its terminal frame, queued user
      // messages, and own cleanup turn have completed. Terminate the browser
      // worker at that boundary so its VFS/module graph is released promptly.
      control?.close?.();
      terminateWorker();
      return;
    }
    if (frame.type === 'terminal') {
      if (frame.lastUserSequence && ipc?.lastReceivedSequence < frame.lastUserSequence) pendingTerminal = frame;
      else finalize(frame);
    }
  }

  const key = `key-${runId}-${childId}-${Math.random().toString(36).slice(2)}`;
  try {
    const workerFactory = workerFactoryFor(options);
    if (!workerFactory) throw new TypeError('browser Worker is unavailable');
    const controlChannel = messageChannelFor(options, scope);
    const userChannel = options.userMessageChannelFactory ? options.userMessageChannelFactory() : messageChannelFor(options, scope);
    control = controlChannel.port1;
    ipc = createScopedIpcEndpoint(userChannel.port1, {
      runId,
      childId,
      direction: 'parent',
      scope,
      onMessage: (value) => {
        if (value?.__bnhProxyRequest?.requestId && options.proxyAdapter) {
          const {
            requestId,
            operation = 'request',
            request = {},
          } = value.__bnhProxyRequest;
          const dispatchTransport = async () => {
            if (operation === 'send' && request.transportId) {
              const transport = proxyTransports.get(request.transportId);
              if (!transport) throw Object.assign(new Error('proxy transport is closed'), { code: 'ERR_PROXY_CONNECTION_FAILED' });
              if (request.action === 'write') {
                await new Promise((resolve, reject) => {
                  let settled = false;
                  const complete = (error) => {
                    if (settled) return;
                    settled = true;
                    if (error) reject(error);
                    else resolve();
                  };
                  try {
                    const result = transport.write(request.bytes, complete);
                    if (result && typeof result.then === 'function') result.then(() => complete(), complete);
                  } catch (error) {
                    complete(error);
                  }
                });
              } else if (request.action === 'end') {
                const result = transport.end();
                if (result && typeof result.then === 'function') await result;
              } else if (request.action === 'destroy') {
                transport.destroy(request.error && Object.assign(new Error(request.error.message), request.error));
                proxyTransports.delete(request.transportId);
              }
              return { ok: true };
            }
            const method = typeof options.proxyAdapter === 'function'
              ? options.proxyAdapter
              : options.proxyAdapter[operation] || options.proxyAdapter.request;
            if (typeof method !== 'function') throw new Error(`proxy adapter does not implement ${operation}()`);
            const result = await method.call(options.proxyAdapter, request);
            if (operation !== 'connect' || !result?.transport) return result;
            const transportId = `${childId}-transport-${nextProxyTransportId++}`;
            proxyTransports.set(transportId, result.transport);
            return {
              ...result,
              transport: undefined,
              __bnhTransport: { id: transportId, virtualTls: Boolean(result.transport.virtualTls) },
            };
          };
          Promise.resolve()
            .then(dispatchTransport)
            .then(serializeProxyResponse)
            .then((result) => {
              const transport = result?.__bnhTransport?.id
                ? proxyTransports.get(result.__bnhTransport.id)
                : undefined;
              const message = { __bnhProxyResponse: true, requestId, result };
              if (transport) return child.send(message, transport);
              return child.send(message);
            })
            .catch((error) => child.send({
              __bnhProxyResponse: true,
              requestId,
              error: { name: error.name, message: error.message, code: error.code || 'ERR_NACELLE_PROXY' },
            }));
          return;
        }
        events.emit('message', value);
        if (pendingTerminal && ipc.lastReceivedSequence >= pendingTerminal.lastUserSequence) {
          const frame = pendingTerminal;
          pendingTerminal = null;
          finalize(frame);
        }
      },
      onDisconnect: emitDisconnect,
    });
    control.on('message', onControlFrame);
    moveTo('starting');
    const source = options.workerSource || createProcessWorkerSource();
    worker = workerFactory(source, { eval: !options.workerSource, type: options.workerType || 'classic', name: options.name });
    worker.on('message', onControlFrame);
    worker.on('error', (error) => finalize({ status: 'failed', kind: 'worker-error', code: null, signal: null, forced: false, error: { name: error?.name, message: error?.message || String(error), stack: error?.stack, code: error?.code || 'ERR_WORKER_EXCEPTION' } }));
    worker.on('messageerror', () => finalize({ status: 'failed', kind: 'serialization', code: null, signal: null, forced: false, error: { name: 'MessageError', message: 'worker message could not be deserialized', code: 'ERR_IPC_SERIALIZATION' } }));
    const initialData = {
      type: 'bnh-process-init',
      key,
      runId,
      childId,
      identity,
      execArgv: Array.isArray(options.execArgv) ? options.execArgv.map(String) : [],
      runSource: makeRunSource(options),
      controlPort: controlChannel.raw.port2,
      userPort: userChannel.raw.port2,
    };
    if (options.networkPort) initialData.networkPort = options.networkPort;
    if (options.vfs !== undefined) initialData.vfs = prepareWorkerVfs(options.vfs, scope);
    const transferList = [
      controlChannel.raw.port2,
      userChannel.raw.port2,
      ...(options.networkPort ? [options.networkPort] : []),
      ...(options.workerDataTransferList || []),
    ];
    worker.postMessage(initialData, transferList);
    const timeout = options.startupTimeout ?? options.timeout;
    if (timeout !== undefined) startupTimer = setTimeout(() => { finalize({ status: 'failed', kind: 'timeout', code: null, signal: 'SIGKILL', forced: true, error: { name: 'TimeoutError', message: 'worker startup timed out', code: 'ERR_PROCESS_TIMEOUT' } }); }, timeout);
    if (options.signal?.addEventListener) {
      abortListener = () => {
        if (terminalRecord) return;
        try { child.kill(options.abortSignal || 'SIGTERM'); } catch (error) { if (error?.code !== 'ERR_PROCESS_EXITED') events.emit('error', error); }
      };
      if (options.signal.aborted) queueMicrotask(abortListener);
      else options.signal.addEventListener('abort', abortListener, { once: true });
    }
  } catch (error) {
    finalize({ status: 'failed', kind: 'bootstrap', code: null, signal: null, forced: false, error: { name: error.name, message: error.message, stack: error.stack, code: error.code || 'ERR_PROCESS_BOOTSTRAP' } });
  }
  return child;
}

export const spawnBrowserProcess = createBrowserProcess;
export const createWorkerProcess = createBrowserProcess;
export const createProcessBoundary = createBrowserProcess;
export const spawnProcess = createBrowserProcess;
