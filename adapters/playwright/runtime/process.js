import { EventEmitter } from './events.js';
import { Writable, ensureOutputStream } from './streams.js';
import { adaptMessagePort, adaptWorker, createIpcError, createMessageChannel, createScopedIpcEndpoint, createWorkerFactory } from './messaging.js';
import { createProcessWorkerSource } from './process-worker.js';
import { browserCryptoVersion } from './crypto.js';
import { installWarningContract } from './warnings.js';

export { PROCESS_WORKER_SOURCE } from './process-worker.js';

const SIGNALS = Object.freeze(new Set(['SIGTERM', 'SIGINT', 'SIGKILL']));
const STATES = Object.freeze(['created', 'starting', 'running', 'stopping', 'exited', 'failed']);
let nextProcessId = 1000;
let nextRunId = 1;
const sharedFileBuffers = new WeakMap();

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

function prepareWorkerVfs(vfs, scope) {
  if (!vfs?.files || scope.crossOriginIsolated !== true
    || typeof scope.SharedArrayBuffer !== 'function') return vfs;
  const files = Object.fromEntries(
    Object.entries(vfs.files).map(([path, bytes]) => [path, shareFileBytes(bytes, scope)]),
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

const PROCESS_CONFIG = Object.freeze({
  variables: Object.freeze({ v8_enable_i18n_support: 1, openssl_quic: false, asan: 0 }),
  target_defaults: Object.freeze({ default_configuration: 'Release' }),
});

const PROCESS_FEATURES = Object.freeze({ inspector: false, debug: false });

function processVersions(scope = globalThis) {
  const versions = { node: '22.0.0', v8: '12.0.0' };
  const openssl = browserCryptoVersion(scope);
  if (openssl) versions.openssl = openssl;
  return versions;
}

function credentialError(kind, value) {
  const error = new Error(`${kind} identifier does not exist: ${value}`);
  error.code = 'ERR_UNKNOWN_CREDENTIAL';
  return error;
}

function invalidCredentialType(value) {
  const received = value === null ? 'null' : value?.constructor?.name || typeof value;
  const error = new TypeError(`The "id" argument must be one of type number or string. Received ${received === 'Object' ? 'an instance of Object' : `type ${received}`}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function normalizeCredential(value, kind) {
  if (typeof value !== 'number' && typeof value !== 'string') throw invalidCredentialType(value);
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
export function installProcessContract(process, { uid = 1000, gid = 1000, umask = 0o022, scope = globalThis } = {}) {
  let currentUid = uid;
  let currentGid = gid;
  let currentUmask = umask & 0o777;
  process.config ||= PROCESS_CONFIG;
  process.features ||= PROCESS_FEATURES;
  process.execPath ||= '/browser/node';
  process.argv0 ||= 'node';
  process.versions ||= processVersions(scope);
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
  if (process.stdout) process.stdout = ensureOutputStream(process.stdout);
  if (process.stderr) process.stderr = ensureOutputStream(process.stderr);
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

function makeWritableEndpoint(endpoint) {
  if (endpoint && typeof endpoint.write === 'function') return ensureOutputStream(endpoint);
  if (Array.isArray(endpoint)) return new Writable({ write(chunk, _encoding, callback) { endpoint.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)); callback(); } });
  return new Writable({ write(chunk, _encoding, callback) { outputWrite(endpoint, chunk); callback(); } });
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
  return {
    runId,
    childId,
    pid: options.pid ?? nextProcessId++,
    ppid: Number(options.ppid ?? options.parentPid ?? options.parent?.pid ?? 0),
    argv: (Array.isArray(options.argv) ? options.argv : ['browser-worker']).map(String),
    env: stringEnvironment(options.env),
    cwd: String(options.cwd || '/node'),
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
  });
}

/** Create the compatibility process object used inside a browser realm. */
export function createProcess({ argv, env, cwd, execArgv, output = {}, platform = 'linux', arch = 'x64', exit, pid = 1, ppid = 0, ipc, signalGrants, scope = globalThis } = {}) {
  let logicalCwd = String(cwd || '/node');
  let exitCode = 0;
  let exited = false;
  let exitRequested = false;
  const grants = new Set(signalGrants || SIGNALS);
  const process = new EventEmitter();
  process.version = 'v22.0.0-browser';
  process.versions = processVersions(scope);
  process.platform = platform;
  process.arch = arch;
  process.pid = pid;
  process.ppid = ppid;
  process.argv = [...(argv || ['node'])].map(String);
  process.execArgv = [...(execArgv || [])].map(String);
  process.env = stringEnvironment(env);
  process.exitCode = 0;
  process.title = 'node';
  process.connected = Boolean(ipc);
  if (ipc) process.channel = ipc;
  process.state = 'running';
  process.cwd = () => logicalCwd;
  process.chdir = (value) => { logicalCwd = String(value); };
  process.nextTick = (callback, ...args) => queueMicrotask(() => callback(...args));
  process.hrtime = (previous) => {
    const now = performance.now();
    const seconds = Math.floor(now / 1000);
    const nanos = Math.floor((now % 1000) * 1e6);
    return previous ? [seconds - previous[0], nanos - previous[1]] : [seconds, nanos];
  };
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
  process.disconnect = () => {
    if (!ipc) return false;
    process.connected = false;
    const result = ipc.disconnect();
    if (result) process.emit('disconnect');
    return result;
  };
  process.stdout = makeWritableEndpoint(output.stdout);
  process.stderr = makeWritableEndpoint(output.stderr);
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
  installProcessContract(process, { scope });
  installWarningContract(process);
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
        const termination = worker?.terminate?.();
        finalize({ status: 'failed', kind: 'signal', code: null, signal: name, forced: true, error: null });
        return termination ?? true;
      }
      moveTo('stopping');
      sendControl('signal', { signal: name });
      return true;
    },
    signal(signal = 'SIGTERM') { return child.kill(signal); },
    terminate() { return child.kill('SIGKILL'); },
    wait() { return completion; },
  };

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
    control?.close?.();
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
    if (frame.type === 'child-signal-request') { try { child.kill(frame.signal); } catch (error) { events.emit('error', error); } return; }
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
    if (options.vfs !== undefined) initialData.vfs = prepareWorkerVfs(options.vfs, scope);
    const transferList = [
      controlChannel.raw.port2,
      userChannel.raw.port2,
      ...(options.workerDataTransferList || []),
    ];
    worker.postMessage(initialData, transferList);
    const timeout = options.startupTimeout ?? options.timeout;
    if (timeout !== undefined) startupTimer = setTimeout(() => { worker?.terminate?.(); finalize({ status: 'failed', kind: 'timeout', code: null, signal: 'SIGKILL', forced: true, error: { name: 'TimeoutError', message: 'worker startup timed out', code: 'ERR_PROCESS_TIMEOUT' } }); }, timeout);
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
