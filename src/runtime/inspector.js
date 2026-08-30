import { EventEmitter } from './events.js';

const disposeSymbol = Symbol.dispose || Symbol.for('nodejs.dispose');

function inspectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isLoopback(host) {
  const value = String(host || '127.0.0.1').toLowerCase();
  return value === 'localhost'
    || value === '::1'
    || value === '127.0.0.1'
    || value === '0.0.0.0'
    || value === '::';
}

function receivedType(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'number' || typeof value === 'boolean') return `type ${typeof value} (${value})`;
  if (typeof value === 'bigint') return `type bigint (${value}n)`;
  if (typeof value === 'symbol') return `type symbol (${String(value)})`;
  return `an instance of ${value?.constructor?.name || typeof value}`;
}

function inspectorArgumentType(name, expected, value) {
  return Object.assign(
    new TypeError(`The "${name}" argument must be ${expected}. Received ${receivedType(value)}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

function validateString(value, name) {
  if (typeof value !== 'string') throw inspectorArgumentType(name, 'of type string', value);
}

function validateObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw inspectorArgumentType(name, 'of type object', value);
  }
}

function validateSessionPost(method, params, callback) {
  if (typeof method !== 'string') throw inspectorArgumentType('method', 'of type string', method);
  if (!callback && typeof params === 'function') {
    callback = params;
    params = null;
  }
  if (params && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    throw inspectorArgumentType('params', 'of type object', params);
  }
  if (callback && typeof callback !== 'function') {
    throw inspectorArgumentType('callback', 'of type function', callback);
  }
  return { params, callback };
}

function currentScriptUrl(processObject) {
  const argv = Array.isArray(processObject?.argv) ? processObject.argv : [];
  return [...argv].reverse().find((value) => typeof value === 'string' && /\.(?:c|m)?js$/.test(value)) || '';
}

function remoteObject(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'object', value: null };
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { type: 'number', unserializableValue: String(value) };
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    return { type: typeof value, value };
  }
  return { type: typeof value };
}

function browserProtocolResult(method, params, processObject) {
  switch (method) {
    case 'Runtime.evaluate': {
      try {
        const expression = String(params?.expression ?? '');
        const value = Function(`"use strict"; return (${expression});`)();
        if (params?.awaitPromise && value && typeof value.then === 'function') {
          return Promise.resolve(value).then((resolved) => ({ result: remoteObject(resolved) }));
        }
        return { result: remoteObject(value) };
      } catch (error) {
        return {
          result: { type: 'undefined' },
          exceptionDetails: { text: String(error?.message || error) },
        };
      }
    }
    case 'Profiler.enable':
    case 'Profiler.start':
    case 'Profiler.disable':
      return {};
    case 'Profiler.stop':
      return {
        profile: {
          nodes: [{
            id: 1,
            callFrame: {
              functionName: '(root)',
              scriptId: '0',
              url: currentScriptUrl(processObject),
              lineNumber: 0,
              columnNumber: 0,
            },
          }],
          startTime: 0,
          endTime: 0,
          samples: [],
        },
      };
    default:
      return {};
  }
}

function createProtocolDispatcher(scope, processObject) {
  const configured = scope?.__BNH_INSPECTOR_PROTOCOL__ || processObject?.__bnhInspectorProtocol;
  const dispatch = typeof configured === 'function'
    ? configured
    : configured && typeof configured.dispatch === 'function'
      ? configured.dispatch.bind(configured)
      : null;
  return (message) => dispatch
    ? dispatch(message)
    : browserProtocolResult(message.method, message.params, processObject);
}

function defer(processObject, callback, ...args) {
  if (typeof processObject?.nextTick === 'function') processObject.nextTick(callback, ...args);
  else if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(() => callback(...args));
  else setTimeout(() => callback(...args), 0);
}

class InspectorSession extends EventEmitter {
  #connected = false;
  #nextId = 1;
  #messageCallbacks = new Map();
  #processObject;
  #isWorker;
  #onConnect;
  #onDisconnect;
  #dispatch;

  constructor(processObject, isWorker, onConnect, onDisconnect, dispatch) {
    super();
    // Node's EventEmitter keeps _maxListeners on the prototype until a
    // caller configures it. BrowserEventEmitter initializes the field as an
    // own property for convenience, so remove that implementation detail
    // here to preserve the inspector.Session surface.
    this._events = Object.create(null);
    this._eventsCount = 0;
    delete this._maxListeners;
    this.#processObject = processObject;
    this.#isWorker = isWorker;
    this.#onConnect = onConnect;
    this.#onDisconnect = onDisconnect;
    this.#dispatch = dispatch;
  }

  connect() {
    if (this.#connected) throw inspectorError('ERR_INSPECTOR_ALREADY_CONNECTED', 'The inspector session is already connected');
    this.#connected = true;
    this.#onConnect?.(this);
  }

  connectToMainThread() {
    if (!this.#isWorker) {
      throw inspectorError('ERR_INSPECTOR_NOT_WORKER', 'Current thread is not a worker');
    }
    if (this.#connected) throw inspectorError('ERR_INSPECTOR_ALREADY_CONNECTED', 'The inspector session is already connected');
    this.#connected = true;
    this.#onConnect?.(this);
  }

  post(method, params, callback) {
    const validated = validateSessionPost(method, params, callback);
    if (!this.#connected) throw inspectorError('ERR_INSPECTOR_NOT_CONNECTED', 'Session is not connected');

    const id = this.#nextId++;
    const message = { id, method };
    if (validated.params) message.params = validated.params;
    if (validated.callback) this.#messageCallbacks.set(id, validated.callback);

    const complete = (error, result = {}) => {
      const handler = this.#messageCallbacks.get(id);
      if (!handler) return;
      this.#messageCallbacks.delete(id);
      defer(this.#processObject, () => {
        try { handler(error, result); }
        catch (callbackError) { this.#processObject?.emitWarning?.(callbackError); }
      });
    };

    try {
      const result = this.#dispatch(message);
      if (result && typeof result.then === 'function') {
        result.then((value) => complete(null, value || {}), (error) => complete(error));
      } else {
        complete(null, result || {});
      }
    } catch (error) {
      complete(error);
      if (!validated.callback) throw error;
    }
    return undefined;
  }

  disconnect() {
    if (!this.#connected) return;
    this.#connected = false;
    this.#onDisconnect?.(this);
    this.#nextId = 1;
    for (const callback of this.#messageCallbacks.values()) {
      defer(this.#processObject, callback, inspectorError('ERR_INSPECTOR_CLOSED', 'Session is closed'));
    }
    this.#messageCallbacks.clear();
  }
}

function createNetworkResources(processObject) {
  const resources = new Map();
  const experimentalFlag = '--experimental-inspector-network-resource';

  const put = (url, data) => {
    if (!processObject?.execArgv?.some((argument) => String(argument) === experimentalFlag)) {
      processObject?.emitWarning?.(
        'The --experimental-inspector-network-resource option is not enabled. '
          + 'Please enable it to use the putNetworkResource function',
      );
      return;
    }
    validateString(url, 'url');
    validateString(data, 'data');
    resources.set(url, data);
  };

  return { put, resources };
}

function promisifyPost(basePost) {
  return function post(method, params, callback) {
    return new Promise((resolve, reject) => {
      const args = Array.from(arguments);
      args.push((error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
      try {
        basePost.apply(this, args);
      } catch (error) {
        reject(error);
      }
    });
  };
}

/** Browser-native inspector lifecycle facade.
 *
 * Chromium owns the actual debugging transport. The Node inspector module is
 * still useful to code that probes or conditionally enables inspector hooks,
 * so keep its lifecycle and callable surface available without opening a host
 * listener or blocking the browser event loop.
 */
export function createInspectorModule({ processObject, isWorker = false, scope = globalThis } = {}) {
  let active = false;
  const sessions = new Set();
  const networkResources = createNetworkResources(processObject);
  const dispatch = createProtocolDispatcher(scope, processObject);

  const broadcastToFrontend = (eventName, params = Object.create(null)) => {
    validateString(eventName, 'eventName');
    validateObject(params, 'params');
    const message = { method: eventName, params };
    for (const session of sessions) {
      try {
        session.emit(eventName, message);
        session.emit('inspectorNotification', message);
      } catch (error) {
        processObject?.emitWarning?.(error);
      }
    }
  };

  const Network = {
    requestWillBeSent: (params) => broadcastToFrontend('Network.requestWillBeSent', params),
    responseReceived: (params) => broadcastToFrontend('Network.responseReceived', params),
    loadingFinished: (params) => broadcastToFrontend('Network.loadingFinished', params),
    loadingFailed: (params) => broadcastToFrontend('Network.loadingFailed', params),
    dataSent: (params) => broadcastToFrontend('Network.dataSent', params),
    dataReceived: (params) => broadcastToFrontend('Network.dataReceived', params),
  };
  const createConsoleContext = (_name) => ({
    dir() {},
    dirXml() {},
    table() {},
    groupEnd() {},
    clear() {},
    count() {},
    countReset() {},
    profile() {},
    profileEnd() {},
    debug() {},
    error() {},
    info() {},
    log() {},
    warn() {},
    trace() {},
    group() {},
    groupCollapsed() {},
    assert() {},
    time() {},
    timeLog() {},
    timeEnd() {},
    timeStamp() {},
  });
  const inspectorConsole = {
    debug() {},
    error() {},
    info() {},
    log() {},
    warn() {},
    dir() {},
    dirxml() {},
    table() {},
    trace() {},
    group() {},
    groupCollapsed() {},
    groupEnd() {},
    clear() {},
    count() {},
    countReset() {},
    assert() {},
    profile() {},
    profileEnd() {},
    time() {},
    timeLog() {},
    timeEnd() {},
    timeStamp() {},
    context: createConsoleContext,
  };
  Object.defineProperty(inspectorConsole, Symbol.toStringTag, {
    configurable: true,
    enumerable: false,
    value: 'console',
    writable: false,
  });

  const open = (port, host, wait = false) => {
    if (active) throw inspectorError('ERR_INSPECTOR_ALREADY_ACTIVATED', 'Inspector is already activated');
    if (Number.isInteger(port) && port >= 0 && port > 65535) {
      throw Object.assign(
        new RangeError(`The value of "port" is out of range. It must be >= 0 && <= 65535. Received ${port}`),
        { code: 'ERR_OUT_OF_RANGE' },
      );
    }
    if (host !== undefined && host !== null && !isLoopback(host)) {
      processObject?.emitWarning?.(
        'Binding the inspector to a public IP with an open port is insecure, '
          + 'as it allows external hosts to connect to the inspector and perform a remote code execution attack. '
          + 'Documentation can be found at https://nodejs.org/api/cli.html#--inspecthostport',
        'SecurityWarning',
      );
    }
    active = true;
    if (wait) waitForDebugger();
    return {
      __proto__: null,
      [disposeSymbol]() { close(); },
    };
  };

  const close = () => {
    active = false;
  };

  const url = () => undefined;

  const waitForDebugger = () => {
    if (!active) throw inspectorError('ERR_INSPECTOR_NOT_ACTIVE', 'Inspector is not active');
  };

  class Session extends InspectorSession {
    constructor() {
      super(processObject, isWorker, (session) => sessions.add(session), (session) => sessions.delete(session), dispatch);
    }
  }
  return {
    open,
    close,
    url,
    waitForDebugger,
    console: inspectorConsole,
    Session,
    Network,
    NetworkResources: { put: networkResources.put },
  };
}

export function createInspectorPromisesModule(inspector) {
  const PromisesSession = class Session extends inspector.Session {};
  PromisesSession.prototype.post = promisifyPost(inspector.Session.prototype.post);
  return {
    ...inspector,
    Session: PromisesSession,
  };
}

export default createInspectorModule;
