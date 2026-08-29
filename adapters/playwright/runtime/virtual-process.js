import { BrowserEventEmitter } from './events.js';
import { createBrowserProcess, createProcess } from './process.js';

const TERMINAL_STATES = new Set(['exited', 'failed']);
const SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGKILL']);
const PROCESS_REGISTRY_KEY = '__BNH_VIRTUAL_PROCESS_REGISTRY__';

function registerProcess(scope, processHandle) {
  const registry = scope[PROCESS_REGISTRY_KEY] || new Map();
  if (!scope[PROCESS_REGISTRY_KEY]) {
    Object.defineProperty(scope, PROCESS_REGISTRY_KEY, { configurable: true, value: registry });
  }
  registry.set(Number(processHandle.pid), processHandle);
  const remove = () => {
    if (registry.get(Number(processHandle.pid)) === processHandle) registry.delete(Number(processHandle.pid));
  };
  processHandle.on?.('exit', remove);
  processHandle.on?.('close', remove);
  return processHandle;
}

function errorWithCode(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function hasVfsEntry(options) {
  return typeof options.entry === 'string'
    && options.vfs?.capabilities
    && options.vfs?.files;
}

function entryDescriptor(options) {
  return { ...options.vfs, entry: options.vfs.entry || options.entry };
}

function runVfsEntry(options, context) {
  return import('./process-entry.js').then(({ runProcessEntry }) => runProcessEntry({
    ...context,
    vfs: entryDescriptor(options),
  }));
}

function normalizeSignal(signal) {
  if (typeof signal === 'number') return ({ 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' })[signal] || String(signal);
  return String(signal || 'SIGTERM').toUpperCase();
}

function validateSignal(signal, grants) {
  const name = normalizeSignal(signal);
  if (!SIGNALS.has(name)) throw errorWithCode('ERR_INVALID_SIGNAL', `invalid signal: ${signal}`);
  if (!grants.has(name)) throw errorWithCode('ERR_CAPABILITY_DENIED', `signal capability denied: ${name}`);
  return name;
}

function cloneMessage(value, transferList, scope) {
  const clone = scope?.structuredClone || globalThis.structuredClone;
  if (typeof clone !== 'function') {
    if (transferList?.length) throw errorWithCode('ERR_IPC_SERIALIZATION', 'message transfer requires structuredClone');
    return value;
  }
  try {
    return transferList === undefined ? clone.call(scope || globalThis, value) : clone.call(scope || globalThis, value, { transfer: transferList });
  } catch (cause) {
    throw errorWithCode('ERR_IPC_SERIALIZATION', 'message could not be structured-cloned', cause);
  }
}

function makeInMemoryIpcPair(scope, { preserveReferences = false } = {}) {
  let left;
  let right;

  const makeEndpoint = () => {
    const events = new BrowserEventEmitter();
    let connected = true;
    let referenced = true;
    const endpoint = {
      get connected() { return connected; },
      ref() { referenced = true; return endpoint; },
      unref() { referenced = false; return endpoint; },
      hasRef() { return referenced; },
      on(name, listener) { events.on(name, listener); return endpoint; },
      once(name, listener) { events.once(name, listener); return endpoint; },
      off(name, listener) { events.off(name, listener); return endpoint; },
      removeListener(name, listener) { events.off(name, listener); return endpoint; },
      removeAllListeners(name) { events.removeAllListeners(name); return endpoint; },
      listenerCount(name) { return events.listenerCount(name); },
      send(value, transferList, callback) {
        if (typeof transferList === 'function') {
          callback = transferList;
          transferList = undefined;
        }
        return endpoint.sendWithHandle(value, undefined, transferList, callback);
      },
      sendWithHandle(value, handle, transferList, callback) {
        if (!connected) {
          const error = errorWithCode('ERR_IPC_CLOSED', 'IPC channel is closed');
          if (callback) {
            queueMicrotask(() => callback(error));
            return false;
          }
          throw error;
        }
        let message;
        try {
          message = cloneMessage(value, transferList, scope);
        } catch (error) {
          if (callback) {
            queueMicrotask(() => callback(error));
            return false;
          }
          throw error;
        }
        const peerWasConnected = Boolean(endpoint.peer?.connected);
        queueMicrotask(() => {
          // A queued postMessage is still delivered when the sender closes immediately after posting.
          if (peerWasConnected) endpoint.peer?.emit('message', message, preserveReferences ? handle : undefined);
        });
        callback?.(null);
        return true;
      },
      disconnect() {
        if (!connected) return false;
        connected = false;
        events.emit('disconnect');
        endpoint.peer?._peerDisconnect();
        return true;
      },
      close() { return endpoint.disconnect(); },
      _peerDisconnect() {
        if (!connected) return;
        connected = false;
        events.emit('peerDisconnect');
      },
      emit(name, ...args) { events.emit(name, ...args); },
      peer: null,
    };
    return endpoint;
  };

  left = makeEndpoint();
  right = makeEndpoint();
  left.peer = right;
  right.peer = left;
  return { parent: left, child: right };
}

function makeTerminal(identity, state, kind, code, signal, error, forced) {
  return Object.freeze({
    runId: identity.runId,
    childId: identity.childId,
    pid: identity.pid,
    ppid: identity.ppid,
    argv: [...identity.argv],
    env: { ...identity.env },
    cwd: identity.cwd,
    state,
    status: state === 'failed' ? 'failed' : 'exited',
    kind,
    code: code ?? null,
    signal: signal ?? null,
    forced: Boolean(forced),
    error: error ? { name: error.name, message: error.message, stack: error.stack, code: error.code } : null,
  });
}

function createInMemoryProcess(options) {
  const events = new BrowserEventEmitter();
  const ipcPair = makeInMemoryIpcPair(options.scope || globalThis, { preserveReferences: options.preserveReferences });
  const identity = {
    runId: String(options.runId || 'virtual-run'),
    childId: String(options.childId || 'virtual-child'),
    pid: Number(options.pid ?? 1000),
    ppid: Number(options.ppid ?? 0),
    argv: (Array.isArray(options.argv) ? options.argv : ['browser-worker']).map(String),
    env: Object.fromEntries(Object.entries(options.env || {}).map(([key, value]) => [String(key), String(value)])),
    cwd: String(options.cwd || '/node'),
  };
  let state = 'created';
  const history = ['created'];
  let terminal = null;
  let pendingFailure = null;
  let pendingSignal = null;
  const abortController = typeof AbortController === 'function' ? new AbortController() : null;
  let disconnectEmitted = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });

  const transition = (next) => {
    if (TERMINAL_STATES.has(state)) return;
    if (state === next) return;
    state = next;
    history.push(state);
  };

  const emitDisconnect = () => {
    if (disconnectEmitted) return;
    disconnectEmitted = true;
    events.emit('disconnect');
  };

  const output = {
    stdout: options.stdout || ((value) => events.emit('output', 'stdout', value)),
    stderr: options.stderr || ((value) => events.emit('output', 'stderr', value)),
  };

  const childProcess = createProcess({
    argv: [...identity.argv],
    execArgv: [...(options.execArgv || [])].map(String),
    env: { ...identity.env },
    cwd: identity.cwd,
    pid: identity.pid,
    ppid: identity.ppid,
    output,
    ipc: ipcPair.child,
    signalGrants: options.signalGrants,
    exit: () => {},
  });
  ipcPair.child.unref?.();

  const finish = (kind, code = childProcess.getCode?.() || 0, signal = null, error = null, forced = false) => {
    if (terminal) return;
    transition(error || forced ? 'failed' : 'exited');
    terminal = makeTerminal(identity, state, kind, code, signal, error, forced);
    if (childProcess.connected) childProcess.disconnect?.();
    else ipcPair.child.close();
    emitDisconnect();
    events.emit('terminal', terminal);
    events.emit('exit', terminal.code, terminal.signal, terminal);
    events.emit('close', terminal.code, terminal.signal, terminal);
    resolveCompletion(terminal);
  };

  emitDisconnect._bnhInternal = true;
  childProcess.on('disconnect', emitDisconnect);
  childProcess.on('exit', (code) => finish(pendingSignal ? 'signal' : (pendingFailure ? 'rejection' : 'exit'), pendingSignal ? null : code, pendingSignal, pendingFailure));
  ipcPair.parent.on('message', (message, handle) => {
    events.emit('message', message, handle);
  });
  ipcPair.parent.on('peerDisconnect', emitDisconnect);
  ipcPair.child.on('message', (message, handle) => childProcess.emit('message', message, handle));
  ipcPair.child.on('peerDisconnect', () => {
    if (!childProcess.connected) return;
    childProcess.connected = false;
    childProcess.emit('disconnect');
  });

  const processHandle = {
    on(name, listener) { events.on(name, listener); return processHandle; },
    once(name, listener) { events.once(name, listener); return processHandle; },
    off(name, listener) { events.off(name, listener); return processHandle; },
    removeListener(name, listener) { events.off(name, listener); return processHandle; },
    removeAllListeners(name) { events.removeAllListeners(name); return processHandle; },
    listenerCount(name) { return events.listenerCount(name); },
    get state() { return state; },
    get stateHistory() { return [...history]; },
    get connected() { return ipcPair.parent.connected; },
    get terminal() { return terminal; },
    get terminalRecord() { return terminal; },
    pid: identity.pid,
    ppid: identity.ppid,
    argv: [...identity.argv],
    execArgv: [...(options.execArgv || [])].map(String),
    env: { ...identity.env },
    cwd: () => identity.cwd,
    process: childProcess,
    stdout: options.stdout,
    stderr: options.stderr,
    send(value, sendHandle, sendOptions, callback) {
      if (typeof sendHandle === 'function') return ipcPair.parent.sendWithHandle(value, undefined, undefined, sendHandle);
      if (typeof sendOptions === 'function') return ipcPair.parent.sendWithHandle(value, sendHandle, undefined, sendOptions);
      return ipcPair.parent.sendWithHandle(value, sendHandle, undefined, callback);
    },
    disconnect() {
      if (!ipcPair.parent.connected) return false;
      queueMicrotask(() => {
        emitDisconnect();
        queueMicrotask(() => {
          if (!ipcPair.parent.connected || !ipcPair.parent.disconnect()) return;
          if (options.clusterGroupId !== undefined) {
            childProcess._markExited?.();
            if (!terminal) finish('exit', childProcess.getCode?.() || 0);
          }
        });
      });
      return true;
    },
    kill(signal = 'SIGTERM') {
      if (terminal) throw errorWithCode('ERR_PROCESS_EXITED', 'process has already exited');
      const name = validateSignal(signal, new Set(options.signalGrants || SIGNALS));
      if (name === 'SIGKILL') {
        pendingFailure = null;
        transition('stopping');
        abortController?.abort();
        finish('signal', null, name, null, true);
        return true;
      }
      transition('stopping');
      const handled = childProcess.emit(name);
      if (!handled) {
        pendingFailure = null;
        pendingSignal = name;
        childProcess._markExited();
      } else {
        pendingSignal = null;
      }
      return true;
    },
    terminate() { return processHandle.kill('SIGKILL'); },
    wait() { return completion; },
  };

  transition('starting');
  queueMicrotask(() => {
    if (terminal) return;
    transition('running');
    const startEntry = () => {
      let runResult;
      try {
        if (typeof options.run !== 'function' && !hasVfsEntry(options)) {
          throw errorWithCode('ERR_CLUSTER_ENTRY_UNAVAILABLE', 'a browser worker run function or VFS entry is required');
        }
        // Invoke the entry before online unless the owner explicitly needs a
        // stable parent context while it handles the spawn notification.
        const context = {
          process: childProcess,
          ipc: childProcess,
          stdout: output.stdout,
          stderr: output.stderr,
          vfs: options.vfs,
          signal: abortController?.signal || childProcess,
          cluster: options.cluster,
          clusterGroupId: options.clusterGroupId,
        };
        runResult = typeof options.run === 'function' ? options.run(context) : runVfsEntry(options, context);
      } catch (error) {
        pendingFailure = error;
        childProcess.exitCode = 1;
        childProcess._markExited();
        return;
      }
      Promise.resolve(runResult).then(() => {
        if (!terminal) childProcess._markExited();
      }, (error) => {
        if (terminal) return;
        pendingFailure = error;
        output.stderr?.(`${error?.stack || error}\n`);
        childProcess.exitCode = 1;
        childProcess._markExited();
      });
    };
    if (options.deferRun) {
      // Cluster exposes `online` from the spawn event. Start the entry first
      // so its process message listener exists before the parent can send the
      // first IPC message in that callback.
      startEntry();
      events.emit('spawn');
    } else {
      startEntry();
      events.emit('spawn');
    }
  });

  return processHandle;
}

/** Choose a browser Worker when available and retain a deterministic local fallback for tests and constrained pages. */
export function createVirtualProcess(options = {}) {
  const scope = options.scope || globalThis;
  const canUseBrowserWorker = !options.forceFallback
    && typeof (options.Worker || scope.Worker) === 'function'
    && typeof (options.MessageChannel || scope.MessageChannel) === 'function';
  let processHandle;
  if (canUseBrowserWorker) {
    if (!hasVfsEntry(options)) processHandle = createBrowserProcess({ ...options, scope });
    else processHandle = createBrowserProcess({
      ...options,
      scope,
      runSource: options.runSource || '((context) => globalThis.__bnhRun(context))',
      workerSource: options.workerSource || new URL('./process-entry.js', import.meta.url).href,
      workerType: 'module',
      vfs: entryDescriptor(options),
    });
  } else {
    processHandle = createInMemoryProcess({ ...options, scope });
  }
  return registerProcess(scope, processHandle);
}

export { createInMemoryProcess };
