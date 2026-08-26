import { BrowserEventEmitter } from './events.js';

export const IPC_ERROR_CODES = Object.freeze({
  CLOSED: 'ERR_IPC_CLOSED',
  SERIALIZATION: 'ERR_IPC_SERIALIZATION',
});

export function createIpcError(code, message, cause = undefined) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function serializationError(cause) {
  return createIpcError(IPC_ERROR_CODES.SERIALIZATION, 'message could not be structured-cloned', cause);
}

function closedError() {
  return createIpcError(IPC_ERROR_CODES.CLOSED, 'IPC channel is closed');
}

function workerMessagingError(code, message) {
  return createIpcError(code, message);
}

function missingArgumentError(name) {
  const error = new TypeError(`The "${name}" argument must be specified`);
  error.code = 'ERR_MISSING_ARGS';
  return error;
}

function broadcastClosedError() {
  if (typeof DOMException === 'function') return new DOMException('BroadcastChannel is closed.', 'InvalidStateError');
  const error = new Error('BroadcastChannel is closed.');
  error.name = 'InvalidStateError';
  return error;
}

function canStructuredClone(value, scope) {
  if (typeof scope.structuredClone !== 'function') return;
  try {
    scope.structuredClone(value);
  } catch (error) {
    throw serializationError(error);
  }
}

function callNative(target, method, ...args) {
  const fn = target?.[method];
  if (typeof fn !== 'function') throw new TypeError(`browser messaging object has no ${method}()`);
  return fn.call(target, ...args);
}

function workerError(event) {
  const source = event?.error;
  if (source instanceof Error) return source;
  const message = source?.message || event?.message || 'worker failed';
  const error = new Error(String(message));
  if (source?.name || event?.name) error.name = source?.name || event.name;
  if (source?.stack || event?.stack) error.stack = source?.stack || event.stack;
  if (source?.code || event?.code) error.code = source?.code || event.code;
  if (source?.cause) error.cause = source.cause;
  if (event?.filename) error.fileName = event.filename;
  if (event?.lineno) error.lineNumber = event.lineno;
  if (event?.colno) error.columnNumber = event.colno;
  return error;
}

function transferArguments(value, transferList) {
  return transferList === undefined ? [value] : [value, transferList];
}

function isVirtualHandle(value) {
  return value !== null && typeof value === 'object' && typeof value.on === 'function'
    && (typeof value.close === 'function' || typeof value.destroy === 'function');
}

function unsupportedHandleError() {
  const error = new TypeError('virtual process handles must be browser-native evented handles');
  error.code = 'ERR_UNSUPPORTED_BROWSER_BOUNDARY';
  return error;
}

/** Adapt a browser MessagePort to the event and transfer-list shape used by Node shims. */
export function adaptMessagePort(nativePort, { broadcast = false } = {}) {
  if (!nativePort) throw new TypeError('a native MessagePort is required');
  const events = new BrowserEventEmitter();
  let assignedOnMessage = null;
  let assignedOnMessageError = null;
  let closed = false;
  let closePeer = null;
  let notifyPeerMessage = null;
  let pendingMessages = 0;
  let peerCloseRequested = false;
  const onMessage = (event) => {
    if (closed) return;
    try {
      events.emit('message', event?.data);
      if (typeof assignedOnMessage === 'function') assignedOnMessage.call(port, event);
    } finally {
      if (pendingMessages > 0) pendingMessages -= 1;
      if (peerCloseRequested && pendingMessages === 0) closeLocally();
    }
  };
  const onMessageError = (event) => {
    if (closed) return;
    events.emit('messageerror', event);
    if (typeof assignedOnMessageError === 'function') assignedOnMessageError.call(port, event);
  };

  if (typeof nativePort.addEventListener === 'function') {
    nativePort.addEventListener('message', onMessage);
    nativePort.addEventListener('messageerror', onMessageError);
  } else {
    nativePort.onmessage = onMessage;
    nativePort.onmessageerror = onMessageError;
  }
  if (typeof nativePort.start === 'function') nativePort.start();

  const closeLocally = (callback) => {
    if (closed) {
      callback && queueMicrotask(callback);
      return;
    }
    closed = true;
    if (typeof nativePort.removeEventListener === 'function') {
      nativePort.removeEventListener('message', onMessage);
      nativePort.removeEventListener('messageerror', onMessageError);
    } else {
      nativePort.onmessage = null;
      nativePort.onmessageerror = null;
    }
    callNative(nativePort, 'close');
    events.emit('close');
    events.removeAllListeners();
    callback && queueMicrotask(callback);
  };

  const port = {
    raw: nativePort,
    on(name, listener) { events.on(name, listener); return port; },
    once(name, listener) { events.once(name, listener); return port; },
    off(name, listener) { events.off(name, listener); return port; },
    removeListener(name, listener) { events.off(name, listener); return port; },
    removeAllListeners(name) { events.removeAllListeners(name); return port; },
    listenerCount(name) { return events.listenerCount(name); },
    ...(broadcast ? {} : {
      start() { nativePort.start?.(); },
    }),
    postMessage(value, transferList) {
      if (closed) {
        if (broadcast) throw broadcastClosedError();
        return;
      }
      callNative(nativePort, 'postMessage', ...(broadcast ? [value] : transferArguments(value, transferList)));
      notifyPeerMessage?.();
    },
    close(callback) {
      closeLocally(callback);
      closePeer?.();
      return;
    },
    ref() { nativePort.ref?.(); },
    unref() { nativePort.unref?.(); },
  };

  Object.defineProperties(port, {
    __bnhCloseFromPeer: {
      value: () => {
        peerCloseRequested = true;
        if (pendingMessages === 0) closeLocally();
      },
    },
    __bnhSetPeerClose: {
      value: (callback) => { closePeer = callback; },
    },
    __bnhMessageQueued: {
      value: () => { pendingMessages += 1; },
    },
    __bnhSetPeerMessageQueued: {
      value: (callback) => { notifyPeerMessage = callback; },
    },
    onmessage: {
      get: () => assignedOnMessage,
      set: (listener) => { assignedOnMessage = listener; },
    },
    onmessageerror: {
      get: () => assignedOnMessageError,
      set: (listener) => { assignedOnMessageError = listener; },
    },
  });
  return port;
}

/**
 * Create the user-facing half of a private, run-scoped IPC protocol.
 *
 * Control frames never pass through this endpoint. The browser MessagePort
 * itself supplies FIFO delivery; the sequence number is retained so a
 * receiver can reject a frame from another run or an out-of-order sender.
 */
export function createScopedIpcEndpoint(nativePort, {
  runId,
  childId,
  direction,
  scope = globalThis,
  onMessage,
  onDisconnect,
} = {}) {
  if (!runId || !childId || !direction) throw new TypeError('runId, childId, and direction are required');
  const port = nativePort?.postMessage && typeof nativePort.on === 'function' ? nativePort : adaptMessagePort(nativePort);
  const events = new BrowserEventEmitter();
  const outgoingDirection = direction === 'parent' ? 'parent-to-child' : 'child-to-parent';
  const incomingDirection = direction === 'parent' ? 'child-to-parent' : 'parent-to-child';
  let sequence = 0;
  let lastReceived = 0;
  let closed = false;
  let disconnectSent = false;
  let nextHandleId = 1;
  const handles = new Map();
  const handleIds = new Map();

  const exposeHandle = (handle) => {
    if (!isVirtualHandle(handle)) throw unsupportedHandleError();
    const existing = handleIds.get(handle);
    if (existing) return existing;
    const id = `${childId}-handle-${nextHandleId++}`;
    handles.set(id, { handle, listeners: new Map() });
    handleIds.set(handle, id);
    return id;
  };

  const encodeHandleValue = (value) => {
    if (isVirtualHandle(value)) return { id: exposeHandle(value), kind: 'virtual' };
    if (Array.isArray(value)) return value.map(encodeHandleValue);
    return value;
  };

  const sendFrame = (type, payload) => {
    if (closed) return;
    port.postMessage({ channel: 'bnh-user-ipc', runId, childId, direction: outgoingDirection, sequence: ++sequence, type, payload });
  };

  const handleRequest = (payload) => {
    const record = handles.get(payload?.handleId);
    if (!record) return;
    if (payload.operation === 'subscribe' || payload.operation === 'unsubscribe') {
      const name = String(payload.event);
      if (payload.operation === 'subscribe' && !record.listeners.has(name)) {
        const listener = (...args) => sendFrame('handle-event', { handleId: payload.handleId, event: name, args: args.map(encodeHandleValue) });
        record.listeners.set(name, listener);
        record.handle.on(name, listener);
      } else if (payload.operation === 'unsubscribe') {
        const listener = record.listeners.get(name);
        if (listener) {
          record.handle.off?.(name, listener);
          record.handle.removeListener?.(name, listener);
          record.listeners.delete(name);
        }
      }
      return;
    }
    if (payload.operation === 'call') {
      const method = record.handle[payload.method];
      if (typeof method === 'function') method.apply(record.handle, payload.args || []);
    }
  };

  const receive = (frame) => {
    if (closed) return;
    if (frame?.channel !== 'bnh-user-ipc' || frame.runId !== runId || frame.childId !== childId || frame.direction !== incomingDirection) return;
    if (!Number.isInteger(frame.sequence) || frame.sequence <= lastReceived) return;
    lastReceived = frame.sequence;
    if (frame.type === 'handle-request') {
      handleRequest(frame.payload);
      return;
    }
    if (frame.type === 'disconnect') {
      closed = true;
      onDisconnect?.();
      events.emit('disconnect');
      queueMicrotask(() => port.close?.());
      return;
    }
    if (frame.type === 'message') {
      const handle = frame.handle?.id ? handles.get(frame.handle.id)?.handle : undefined;
      events.emit('message', frame.payload, handle);
      onMessage?.(frame.payload, handle);
    }
  };
  port.on('message', receive);

  const endpoint = {
    get connected() { return !closed; },
    get lastReceivedSequence() { return lastReceived; },
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
      let handle;
      if (transferList !== undefined && !Array.isArray(transferList)) {
        handle = { id: exposeHandle(transferList), kind: 'virtual' };
        transferList = undefined;
      }
      if (closed) {
        const error = closedError();
        if (callback) {
          queueMicrotask(() => callback(error));
          return false;
        }
        throw error;
      }
      if (!transferList) canStructuredClone(value, scope);
      const frame = {
        channel: 'bnh-user-ipc',
        runId,
        childId,
        direction: outgoingDirection,
        sequence: ++sequence,
        type: 'message',
        payload: value,
      };
      if (handle) frame.handle = handle;
      try {
        port.postMessage(frame, transferList);
      } catch (error) {
        const wrapped = serializationError(error);
        if (callback) {
          queueMicrotask(() => callback(wrapped));
          return false;
        }
        throw wrapped;
      }
      callback?.(null);
      return true;
    },
    sendAsync(value, transferList) {
      return new Promise((resolve, reject) => {
        endpoint.send(value, transferList, (error) => error ? reject(error) : resolve());
      });
    },
    disconnect() {
      if (disconnectSent || closed) return false;
      disconnectSent = true;
      closed = true;
      onDisconnect?.();
      events.emit('disconnect');
      try {
        port.postMessage({
          channel: 'bnh-user-ipc',
          runId,
          childId,
          direction: outgoingDirection,
          sequence: ++sequence,
          type: 'disconnect',
        });
      } catch {
        // The peer may already have closed its port; local disconnect is final.
      }
      queueMicrotask(() => port.close?.());
      return true;
    },
    close() {
      if (closed) return false;
      closed = true;
      onDisconnect?.();
      events.emit('disconnect');
      port.close?.();
      return true;
    },
  };
  return endpoint;
}

export const createIpcEndpoint = createScopedIpcEndpoint;

export function createMessageChannel(scope = globalThis) {
  if (typeof scope.MessageChannel !== 'function') throw new TypeError('MessageChannel is unavailable');
  const channel = new scope.MessageChannel();
  const port1 = adaptMessagePort(channel.port1);
  const port2 = adaptMessagePort(channel.port2);
  port1.__bnhSetPeerClose?.(port2.__bnhCloseFromPeer);
  port2.__bnhSetPeerClose?.(port1.__bnhCloseFromPeer);
  port1.__bnhSetPeerMessageQueued?.(port2.__bnhMessageQueued);
  port2.__bnhSetPeerMessageQueued?.(port1.__bnhMessageQueued);
  return {
    raw: channel,
    port1,
    port2,
  };
}

/** Adapt a browser Worker while keeping worker communication browser-native. */
export function adaptWorker(nativeWorker, { revokeURL = null } = {}) {
  const events = new BrowserEventEmitter();
  let deferredErrorTimer = null;
  let workerErrorReported = false;
  let workerExited = false;
  const removeNativeListeners = () => {
    nativeWorker.removeEventListener?.('message', onMessage);
    nativeWorker.removeEventListener?.('error', onError);
    nativeWorker.removeEventListener?.('messageerror', onMessageError);
  };
  const emitWorkerExit = (code) => {
    if (workerExited) return;
    workerExited = true;
    removeNativeListeners();
    events.emit('exit', code);
  };
  const emitWorkerError = (error) => {
    if (workerErrorReported) return;
    workerErrorReported = true;
    if (deferredErrorTimer !== null) clearTimeout(deferredErrorTimer);
    deferredErrorTimer = null;
    events.emit('error', error);
  };
  const onMessage = (event) => {
    if (workerExited) return;
    const value = event?.data;
    if (value?.__bnhWorkerExit) {
      emitWorkerExit(Number(value.code) || 0);
      return;
    }
    if (value?.__bnhWorkerError) {
      emitWorkerError(workerError(value.__bnhWorkerError));
      emitWorkerExit(1);
      return;
    }
    events.emit('message', value);
  };
  const onError = (event) => {
    if (workerExited) return;
    event?.preventDefault?.();
    const error = workerError(event);
    if (error.code || event?.error) {
      emitWorkerError(error);
      emitWorkerExit(1);
      return;
    }
    deferredErrorTimer = setTimeout(() => {
      emitWorkerError(error);
      emitWorkerExit(1);
    }, 50);
  };
  const onMessageError = (event) => events.emit('messageerror', event);
  nativeWorker.addEventListener('message', onMessage);
  nativeWorker.addEventListener('error', onError);
  nativeWorker.addEventListener('messageerror', onMessageError);

  const worker = {
    raw: nativeWorker,
    on(name, listener) { events.on(name, listener); return worker; },
    once(name, listener) { events.once(name, listener); return worker; },
    off(name, listener) { events.off(name, listener); return worker; },
    removeListener(name, listener) { events.off(name, listener); return worker; },
    removeAllListeners(name) { events.removeAllListeners(name); return worker; },
    postMessage(value, transferList) {
      callNative(nativeWorker, 'postMessage', ...transferArguments(value, transferList));
    },
    terminate() {
      const result = callNative(nativeWorker, 'terminate');
      if (revokeURL) revokeURL();
      if (deferredErrorTimer !== null) clearTimeout(deferredErrorTimer);
      return Promise.resolve(result).then(() => {
        emitWorkerExit(1);
        return 1;
      });
    },
    ref() { return worker; },
    unref() { return worker; },
  };
  return worker;
}

function workerSourceURL(scope, source) {
  if (typeof source !== 'string') throw new TypeError('eval Worker source must be a string');
  if (typeof scope.Blob !== 'function' || typeof scope.URL?.createObjectURL !== 'function') {
    throw new TypeError('Blob URL Worker construction is unavailable');
  }
  const url = scope.URL.createObjectURL(new scope.Blob([source], { type: 'text/javascript' }));
  return { url, revokeURL: () => scope.URL.revokeObjectURL(url) };
}

export function createWorkerFactory(scope = globalThis, { bootstrap = '' } = {}) {
  if (typeof scope.Worker !== 'function') throw new TypeError('Worker is unavailable');
  return function Worker(source, options = {}) {
    const generated = options.eval ? workerSourceURL(scope, `${bootstrap}\n${source}`) : null;
    const workerOptions = {};
    if (options.name !== undefined) workerOptions.name = options.name;
    if (options.type !== undefined) workerOptions.type = options.type;
    const nativeWorker = new scope.Worker(generated?.url || source, workerOptions);
    return adaptWorker(nativeWorker, { revokeURL: generated?.revokeURL });
  };
}

export function createBroadcastChannelFactory(scope = globalThis) {
  if (typeof scope.BroadcastChannel !== 'function') return undefined;
  return function BroadcastChannel(name) {
    if (name === undefined) throw missingArgumentError('name');
    const channel = new scope.BroadcastChannel(name);
    const adapted = adaptMessagePort(channel, { broadcast: true });
    Object.defineProperty(adapted, 'name', { configurable: false, enumerable: true, value: channel.name });
    return adapted;
  };
}

function postMessageToThread(threadId) {
  const code = threadId === 0
    ? 'ERR_WORKER_MESSAGING_SAME_THREAD'
    : 'ERR_WORKER_MESSAGING_FAILED';
  const message = threadId === 0
    ? 'Cannot sent a message to the same thread'
    : 'Cannot find the destination thread or listener';
  return Promise.reject(workerMessagingError(code, message));
}

export function createMessagingPrimitives(scope = globalThis) {
  const Worker = typeof scope.Worker === 'function' ? createWorkerFactory(scope) : undefined;
  const MessageChannel = typeof scope.MessageChannel === 'function'
    ? function MessageChannel() { return createMessageChannel(scope); }
    : undefined;
  return {
    Worker,
    MessageChannel,
    BroadcastChannel: createBroadcastChannelFactory(scope),
    MessagePort: scope.MessagePort,
    postMessageToThread,
    threadId: 0,
    isMainThread: true,
    parentPort: null,
    workerData: undefined,
  };
}
