import { BrowserEventEmitter } from './events.js';
import { createVirtualProcess } from './virtual-process.js';
import { sharedVirtualNetwork } from './virtual-network.js';

const INTERNAL = Symbol('browser-cluster-worker');
const DEFAULT_EXEC = '/browser/node';
let nextClusterGroupId = 1;
const DEFAULT_SETTINGS = Object.freeze({
  silent: false,
});

function errorWithCode(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function nextTick(callback, ...args) {
  queueMicrotask(() => callback(...args));
}

function cloneSettings(settings = {}, defaults = DEFAULT_SETTINGS) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw errorWithCode('ERR_INVALID_ARG_TYPE', 'cluster settings must be an object');
  }
  const next = {
    ...defaults,
    ...settings,
  };
  if (next.args !== undefined) next.args = [...(next.args || [])].map(String);
  if (next.execArgv !== undefined) next.execArgv = [...(next.execArgv || [])].map(String);
  if (next.stdio !== undefined && !Array.isArray(next.stdio)) {
    throw errorWithCode('ERR_INVALID_ARG_TYPE', 'cluster settings stdio must be an array');
  }
  if (next.serialization !== undefined && next.serialization !== 'json') {
    throw errorWithCode('ERR_CLUSTER_UNSUPPORTED_SETTING', 'browser cluster supports only default JSON-compatible settings');
  }
  return next;
}

function normalizeEnvironment(environment) {
  if (environment === undefined) return {};
  if (environment === null
    || (typeof environment !== 'object' && typeof environment !== 'string')
    || Array.isArray(environment)) {
    throw errorWithCode('ERR_INVALID_ARG_TYPE', 'fork environment must be an object');
  }
  return Object.fromEntries(Object.entries(environment).map(([key, value]) => [String(key), String(value)]));
}

function unsupportedHandleError() {
  const error = errorWithCode('ERR_UNSUPPORTED_BROWSER_BOUNDARY', 'cluster worker handles require host networking');
  error.boundary = 'raw-host-networking';
  error.status = 'unsupported-boundary';
  return error;
}

function parseSendArguments(sendHandle, options, callback) {
  let handle = sendHandle;
  let sendOptions = options;
  let done = callback;
  if (typeof handle === 'function') {
    done = handle;
    handle = undefined;
    sendOptions = undefined;
  } else if (typeof sendOptions === 'function') {
    done = sendOptions;
    sendOptions = undefined;
  }
  if (handle !== undefined && handle !== null && (typeof handle !== 'object' || typeof handle === 'function')) throw unsupportedHandleError();
  return { handle, options: sendOptions, callback: done };
}

function callbackFromArguments(...values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (typeof values[index] === 'function') return values[index];
  }
  return null;
}

function normalizeListeningAddress(address) {
  if (address === null || typeof address !== 'object' || Array.isArray(address)) return address;
  const family = address.family;
  const addressType = address.addressType === 6 || family === 6 || family === 'IPv6'
    || String(address.address || '').includes(':') ? 6 : 4;
  return {
    ...address,
    addressType,
    family: addressType === 6 ? 'IPv6' : 'IPv4',
  };
}

class ClusterWorker extends BrowserEventEmitter {
  constructor(token, processHandle, id, cluster, { child = false } = {}) {
    super();
    if (token !== INTERNAL) throw errorWithCode('ERR_ILLEGAL_CONSTRUCTOR', 'cluster.Worker cannot be constructed directly');
    this.id = id;
    this.process = processHandle;
    this._cluster = cluster;
    this._child = child;
    this.exitedAfterDisconnect = false;
    this._disconnected = false;
    this._exited = false;
  }

  get suicide() {
    return this.exitedAfterDisconnect;
  }

  isConnected() {
    return Boolean(!this._disconnected && this.process?.connected && !this.isDead());
  }

  isDead() {
    return Boolean(this._exited || this.process?.terminal || ['exited', 'failed'].includes(this.process?.state));
  }

  send(message, sendHandle, options, callback) {
    let parsed;
    try {
      parsed = parseSendArguments(sendHandle, options, callback);
    } catch (error) {
      const done = callbackFromArguments(sendHandle, options, callback);
      if (!done) throw error;
      nextTick(done, error);
      return false;
    }
    if (parsed.options !== undefined && (parsed.options === null || typeof parsed.options !== 'object')) {
      throw errorWithCode('ERR_INVALID_ARG_TYPE', 'worker send options must be an object');
    }
    try {
      return this.process.send(
        message,
        parsed.handle,
        parsed.options,
        parsed.callback ? (error) => parsed.callback(error) : undefined,
      );
    } catch (error) {
      if (parsed.callback) {
        nextTick(parsed.callback, error);
        return false;
      }
      throw error;
    }
  }

  disconnect(callback) {
    if (callback !== undefined && typeof callback !== 'function') {
      throw errorWithCode('ERR_INVALID_ARG_TYPE', 'worker disconnect callback must be a function');
    }
    this.exitedAfterDisconnect = true;
    if (callback) {
      if (this._disconnected || !this.isConnected()) nextTick(callback);
      else this.once('disconnect', callback);
    }
    if (!this._disconnected) this.process.disconnect?.();
    return this;
  }

  kill(signal = 'SIGTERM') {
    return this.process.kill(signal);
  }

  destroy(signal = 'SIGTERM') {
    return this.kill(signal);
  }
}

function attachEmitterMethods(target, emitter) {
  for (const name of ['on', 'once', 'off', 'removeListener', 'removeAllListeners', 'listenerCount', 'listeners', 'emit']) {
    target[name] = emitter[name].bind(emitter);
  }
  const events = new Proxy(Object.create(null), {
    get(object, name, receiver) {
      const listeners = emitter._listeners.get(name);
      if (listeners?.size) {
        const values = [...listeners];
        return values.length === 1 ? values[0] : values;
      }
      return Reflect.get(object, name, receiver);
    },
    has(object, name) {
      return emitter._listeners.has(name) || Reflect.has(object, name);
    },
    ownKeys(object) {
      const keys = new Set(Reflect.ownKeys(object));
      for (const name of emitter._listeners.keys()) {
        keys.add(typeof name === 'symbol' ? name : String(name));
      }
      return [...keys];
    },
    getOwnPropertyDescriptor(object, name) {
      if (emitter._listeners.has(name)) {
        const listeners = emitter._listeners.get(name);
        const values = [...listeners];
        return {
          configurable: true,
          enumerable: true,
          value: values.length === 1 ? values[0] : values,
          writable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(object, name);
    },
  });
  Object.defineProperties(target, {
    _events: {
      configurable: true,
      enumerable: true,
      value: events,
      writable: true,
    },
    _eventsCount: {
      configurable: true,
      enumerable: true,
      get: () => emitter._listeners.size,
    },
    _maxListeners: {
      configurable: true,
      enumerable: true,
      get: () => emitter._maxListeners,
      set: (value) => { emitter._maxListeners = value; },
    },
  });
  return target;
}

function makeWorkerCluster(options) {
  const processObject = options.process;
  if (!processObject || typeof processObject.send !== 'function') {
    throw errorWithCode('ERR_CLUSTER_WORKER_CONTEXT', 'a connected browser process is required for cluster worker mode');
  }
  const emitter = new BrowserEventEmitter();
  const workers = Object.create(null);
  const network = options.network || sharedVirtualNetwork;
  const groupId = options.clusterGroupId ?? processObject.ppid ?? 'browser-cluster';
  const serverHandles = new Set();
  const worker = new ClusterWorker(INTERNAL, processObject, Number(options.id ?? processObject.pid ?? 1), null, { child: true });
  const cluster = attachEmitterMethods({}, emitter);
  worker._cluster = cluster;
  const closeServerHandles = () => {
    for (const handle of [...serverHandles]) handle.close();
  };
  const getServer = (server, query, callback) => {
    try {
      const binding = query.port < 0
        ? network.bindClusterPipe(groupId, query.address)
        : network.bindClusterTcp(groupId, query.address, query.port, { ipv6Only: query.ipv6Only === true });
      const handle = {
        address: binding.address,
        port: binding.port,
        path: binding.path,
        listen() { return 0; },
        ref() { return this; },
        unref() { return this; },
        close() {
          if (!serverHandles.delete(handle)) return;
          binding.removeServer(server);
        },
        getsockname(out) {
          if (binding.address !== undefined) {
            Object.assign(out, { address: binding.address, family: binding.address.includes(':') ? 'IPv6' : 'IPv4', port: binding.port });
          }
          return 0;
        },
      };
      serverHandles.add(handle);
      binding.addServer(server);
      nextTick(callback, null, handle);
    } catch (error) {
      nextTick(callback, error);
    }
  };
  processObject.on?.('disconnect', closeServerHandles);
  processObject.on?.('exit', closeServerHandles);
  Object.assign(cluster, {
    isPrimary: false,
    isMaster: false,
    isWorker: true,
    worker,
    workers,
    Worker: ClusterWorker,
    SCHED_NONE: 1,
    SCHED_RR: 2,
    schedulingPolicy: 1,
    _getServer: getServer,
    settings: cloneSettings(options.settings),
    setupPrimary(settings) {
      cluster.settings = cloneSettings(settings);
      emitter.emit('setup', cluster.settings);
    },
    setupMaster(settings) { return cluster.setupPrimary(settings); },
    fork() { throw errorWithCode('ERR_CLUSTER_WORKER_ONLY', 'cluster.fork() is only available in the primary process'); },
    disconnect(callback) {
      if (callback !== undefined && typeof callback !== 'function') throw errorWithCode('ERR_INVALID_ARG_TYPE', 'cluster disconnect callback must be a function');
      if (callback) {
        if (!worker.isConnected()) nextTick(callback);
        else worker.once('disconnect', callback);
      }
      worker.disconnect();
    },
  });
  processObject.on?.('message', (message, handle) => {
    worker.emit('message', message, handle);
    emitter.emit('message', worker, message, handle);
  });
  processObject.on?.('disconnect', () => {
    worker._disconnected = true;
    worker.emit('disconnect');
    emitter.emit('disconnect', worker);
  });
  processObject.on?.('exit', (code, signal) => {
    worker._disconnected = true;
    worker._exited = true;
    worker.emit('exit', code, signal);
    emitter.emit('exit', worker, code, signal);
  });
  return cluster;
}

function makePrimaryCluster(options) {
  const emitter = new BrowserEventEmitter();
  const processObject = options.process || null;
  const processFactory = options.processFactory || createVirtualProcess;
  const initialSettings = options.settings === undefined ? {} : cloneSettings(options.settings);
  const primaryState = {
    workers: Object.create(null),
    nextWorkerId: 1,
    closed: false,
    disconnecting: false,
    groupId: options.clusterGroupId || `browser-cluster-${nextClusterGroupId++}`,
    settings: cloneSettings(initialSettings),
  };
  const processStates = new WeakMap();
  if (processObject && typeof processObject === 'object') processStates.set(processObject, primaryState);
  const baseEnvironment = normalizeEnvironment(options.environment || processObject?.env);
  const run = options.workerRun || options.run;
  const activeProcess = () => options.scope?.process || processObject;
  const currentProcessSettings = () => {
    const currentProcess = activeProcess();
    return {
      args: Array.isArray(currentProcess?.argv) ? currentProcess.argv.slice(2) : [],
      exec: currentProcess?.argv?.[1] || DEFAULT_EXEC,
      execArgv: Array.isArray(currentProcess?.execArgv) ? [...currentProcess.execArgv] : [],
      silent: false,
    };
  };
  const runInProcessContext = (parentProcess, callback) => {
    const scope = options.scope;
    const timers = parentProcess?._bnhTimerContext;
    if (!scope || !parentProcess) return callback();
    const previous = {
      process: scope.process,
      setTimeout: scope.setTimeout,
      clearTimeout: scope.clearTimeout,
      setInterval: scope.setInterval,
      clearInterval: scope.clearInterval,
      setImmediate: scope.setImmediate,
      clearImmediate: scope.clearImmediate,
    };
    scope.process = parentProcess;
    if (timers) Object.assign(scope, timers);
    try {
      return callback();
    } finally {
      Object.assign(scope, previous);
    }
  };
  const terminateWorker = (worker, state) => {
    if (worker._primaryTerminationStarted) return;
    worker._primaryTerminationStarted = true;
    try {
      if (typeof worker.process.terminate === 'function') worker.process.terminate();
      else worker.kill('SIGKILL');
    } catch (error) {
      if (error?.code !== 'ERR_PROCESS_EXITED') throw error;
    }
    // Browser process termination is synchronous from the parent’s point of
    // view. Remove a worker immediately when its terminal state is observable;
    // the process exit listener remains responsible for the normal async path.
    if (worker.isDead()) delete state.workers[worker.id];
  };
  const watchPrimary = (parentProcess, state) => {
    parentProcess.once?.('exit', () => {
      runInProcessContext(parentProcess, () => {
        state.closed = true;
        for (const worker of Object.values(state.workers)) {
          terminateWorker(worker, state);
        }
      });
    });
  };
  const stateFor = (parentProcess) => {
    if (!parentProcess || typeof parentProcess !== 'object') return primaryState;
    let state = processStates.get(parentProcess);
    if (state) return state;
    state = {
      workers: Object.create(null),
      nextWorkerId: 1,
      closed: false,
      disconnecting: false,
      groupId: options.clusterGroupId || `browser-cluster-${nextClusterGroupId++}`,
      settings: cloneSettings(initialSettings),
    };
    processStates.set(parentProcess, state);
    watchPrimary(parentProcess, state);
    return state;
  };
  if (processObject && typeof processObject === 'object') watchPrimary(processObject, primaryState);

  const cluster = attachEmitterMethods({}, emitter);
  Object.defineProperties(cluster, {
    isPrimary: { enumerable: true, value: true },
    isMaster: { enumerable: true, value: true },
    isWorker: { enumerable: true, value: false },
    worker: { enumerable: true, value: null },
    workers: { enumerable: true, get: () => stateFor(activeProcess()).workers },
    settings: { enumerable: true, get: () => stateFor(activeProcess()).settings },
  });

  const setupPrimary = (nextSettings = {}) => {
    const state = stateFor(activeProcess());
    state.settings = cloneSettings(nextSettings, { ...currentProcessSettings(), ...state.settings });
    emitter.emit('setup', state.settings);
  };

  Object.assign(cluster, {
    Worker: ClusterWorker,
    SCHED_NONE: 1,
    SCHED_RR: 2,
    schedulingPolicy: 2,
    setupPrimary,
    setupMaster: setupPrimary,
    fork(environment) {
      setupPrimary();
      const parentProcess = activeProcess();
      const state = stateFor(parentProcess);
      const settings = state.settings;
      if (state.closed || state.disconnecting) throw errorWithCode('ERR_CLUSTER_CLOSED', 'cluster is disconnected');
      if (options.maxChildren !== undefined && Object.keys(state.workers).length >= options.maxChildren) {
        throw errorWithCode('ERR_CLUSTER_MAX_CHILDREN', 'cluster child limit has been reached');
      }
      if (typeof run !== 'function' && typeof options.runSource !== 'string') {
        throw errorWithCode('ERR_CLUSTER_ENTRY_UNAVAILABLE', 'a browser worker run function or source is required');
      }
      const id = state.nextWorkerId++;
      const env = { ...baseEnvironment, ...normalizeEnvironment(environment) };
      const processHandle = processFactory({
        ...options.workerOptions,
        scope: options.scope,
        run,
        runSource: options.runSource,
        env,
        argv: [parentProcess?.execPath || '/browser/node', settings.exec, ...settings.args],
        execArgv: settings.execArgv,
        cwd: settings.cwd || parentProcess?.cwd?.(),
        ppid: Number(parentProcess?.pid || 0),
        pid: options.pidBase === undefined ? undefined : options.pidBase + id,
        clusterGroupId: state.groupId,
        childId: `cluster-worker-${id}`,
        runId: String(options.runId || `cluster-${Date.now()}`),
        signalGrants: options.signalGrants,
        preserveReferences: true,
        stdout: settings.silent ? undefined : options.stdout,
        stderr: settings.silent ? undefined : options.stderr,
      });
      if (options.childProcessClass?.prototype) {
        Object.setPrototypeOf(processHandle, options.childProcessClass.prototype);
      }
      const diagnostics = options.diagnostics;
      const channel = diagnostics?.channel?.('child_process');
      if (channel?.hasSubscribers) channel.publish({ process: processHandle });
      const worker = new ClusterWorker(INTERNAL, processHandle, id, cluster);
      state.workers[id] = worker;
      emitter.emit('fork', worker);

      processHandle.on?.('spawn', () => {
        runInProcessContext(parentProcess, () => {
          worker.emit('online');
          emitter.emit('online', worker);
        });
      });
      processHandle.on?.('message', (message, handle) => {
        runInProcessContext(parentProcess, () => {
          if (message?.type === 'bnh-cluster-listening') {
            const address = normalizeListeningAddress(message.address);
            worker.emit('listening', address);
            emitter.emit('listening', worker, address);
            return;
          }
          worker.emit('message', message, handle);
          emitter.emit('message', worker, message, handle);
        });
      });
      processHandle.on?.('disconnect', () => {
        runInProcessContext(parentProcess, () => {
          if (worker._disconnected) return;
          worker._disconnected = true;
          worker.emit('disconnect');
          emitter.emit('disconnect', worker);
        });
      });
      processHandle.on?.('error', (error) => runInProcessContext(parentProcess, () => worker.emit('error', error)));
      processHandle.on?.('exit', (code, signal) => {
        runInProcessContext(parentProcess, () => {
          worker._disconnected = true;
          worker._exited = true;
          worker.emit('exit', code, signal);
          emitter.emit('exit', worker, code, signal);
          delete state.workers[id];
        });
      });
      return worker;
    },
    disconnect(callback) {
      if (callback !== undefined && typeof callback !== 'function') throw errorWithCode('ERR_INVALID_ARG_TYPE', 'cluster disconnect callback must be a function');
      const state = stateFor(activeProcess());
      state.disconnecting = true;
      const activeWorkers = Object.values(state.workers);
      if (!activeWorkers.length) {
        state.disconnecting = false;
        if (callback) nextTick(callback);
        return;
      }
      let remaining = activeWorkers.length;
      const done = () => {
        remaining -= 1;
        if (remaining === 0) {
          state.disconnecting = false;
          callback?.();
        }
      };
      for (const worker of activeWorkers) worker.disconnect(done);
    },
  });
  return cluster;
}

/** Construct a browser-native cluster module; it never starts or contacts a host process. */
export function createCluster(options = {}) {
  if (options.mode === 'worker' || options.isWorker) return makeWorkerCluster(options);
  return makePrimaryCluster(options);
}

export function createWorkerCluster(options = {}) {
  return makeWorkerCluster({ ...options, mode: 'worker' });
}

export const createClusterModule = createCluster;
export const createBrowserCluster = createCluster;
export { ClusterWorker as Worker };
export default createCluster;
