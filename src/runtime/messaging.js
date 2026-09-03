import { BrowserEventEmitter } from './events.js';

const uncloneableValues = new WeakSet();
const uncloneableErrors = new WeakMap();
const uncloneableMarker = Symbol.for('bnh.messaging.uncloneable');
const uncloneableErrorMarker = Symbol.for('bnh.messaging.uncloneableError');
const untransferableValues = new WeakSet();
const untransferableMarker = Symbol.for('nodejs.worker_threads.untransferable');
const nativeMessageChannels = new WeakMap();
const cloneablePrototypeMarker = Symbol.for('bnh.messaging.cloneablePrototype');
const messageEventData = new WeakMap();

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

export function markAsUncloneable(value, errorFactory = undefined) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) return;
  uncloneableValues.add(value);
  try {
    Object.defineProperty(value, uncloneableMarker, { configurable: true, value: true });
    if (typeof errorFactory === 'function') {
      Object.defineProperty(value, uncloneableErrorMarker, {
        configurable: true,
        value: errorFactory,
      });
    }
  } catch { /* host objects may be sealed; the WeakSet remains authoritative */ }
  if (typeof errorFactory === 'function') uncloneableErrors.set(value, errorFactory);
}

export function markAsUntransferable(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    untransferableValues.add(value);
    try { Object.defineProperty(value, untransferableMarker, { configurable: true, value: true }); } catch { /* host buffer may be sealed */ }
  }
}

export function isMarkedAsUntransferable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && (untransferableValues.has(value)
      || (Object.hasOwn(value, untransferableMarker) && value[untransferableMarker] === true));
}

function isUncloneable(value) {
  let current = value;
  let depth = 0;
  while (current && (typeof current === 'object' || typeof current === 'function') && depth < 32) {
    if (uncloneableValues.has(current) || current[uncloneableMarker] === true) return true;
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return false;
}

function uncloneableError(value) {
  let current = value;
  let depth = 0;
  while (current && (typeof current === 'object' || typeof current === 'function') && depth < 32) {
    const factory = uncloneableErrors.get(current) || current[uncloneableErrorMarker];
    if (factory) return factory();
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return dataCloneError('object could not be cloned');
}

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

function replaceTransferredValues(value, replacements, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (replacements.has(value)) return replacements.get(value);
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(replaceTransferredValues(item, replacements, seen));
    return copy;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = replaceTransferredValues(item, replacements, seen);
  }
  return copy;
}

function transferArguments(value, transferList) {
  if (transferList === undefined) return [replaceTransferredValues(value, new Map())];
  const list = Array.isArray(transferList) ? transferList : [transferList];
  const identities = new Set();
  for (const item of list) {
    const identity = item?.raw || item;
    if (isMarkedAsUntransferable(identity)) throw dataCloneError('Cannot transfer object of unsupported type.');
    if (identities.has(identity)) {
      const type = item instanceof ArrayBuffer ? 'ArrayBuffer' : item?.__bnhReceiveMessage ? 'MessagePort' : null;
      if (type) throw dataCloneError(`Transfer list contains duplicate ${type}`);
    }
    identities.add(identity);
  }
  if (list.some((item) => item?.__bnhIsClosed)) throw detachedPortError();
  const replacements = new Map(list.map((item) => [item, item?.raw || item]));
  const transfers = list.map((item) => item?.raw || item);
  return [replaceTransferredValues(value, replacements), Array.isArray(transferList) ? transfers : transfers[0]];
}

function dataCloneError(message) {
  if (typeof DOMException === 'function') return new DOMException(message, 'DataCloneError');
  return Object.assign(new Error(message), { name: 'DataCloneError', code: 25 });
}

function detachArrayBuffers(items) {
  const buffers = items.filter((item) => item instanceof ArrayBuffer);
  if (buffers.length && typeof structuredClone === 'function') structuredClone({ buffers }, { transfer: buffers });
}

function detachedPortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('MessagePort in transfer list is already detached', 'DataCloneError');
  }
  return Object.assign(new Error('MessagePort in transfer list is already detached'), {
    name: 'DataCloneError',
    code: 25,
  });
}

function normalizePortTransferList(input) {
  if (input === undefined || input === null) return undefined;
  const isOptionsObject = input && typeof input === 'object' && !Array.isArray(input)
    && typeof input[Symbol.iterator] !== 'function';
  const optionTransfer = isOptionsObject && Object.hasOwn(input, 'transfer');
  if (isOptionsObject && !optionTransfer) return undefined;
  const value = optionTransfer ? input.transfer : input;
  const label = optionTransfer ? 'Optional options.transfer argument' : 'Optional transferList argument';
  if (value === undefined) return undefined;
  if (value === null && optionTransfer) {
    const error = new TypeError(`${label} must be an iterable`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'symbol' || typeof value[Symbol.iterator] !== 'function') {
    const error = new TypeError(`${label} must be an iterable`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  try { return Array.from(value); }
  catch (cause) {
    const error = new TypeError(`${label} must be an iterable`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    error.cause = cause;
    throw error;
  }
}

function messageEventValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

let nodeMessagePortClass;
const messagePortStates = new WeakMap();

function messagePortState(receiver) {
  const state = messagePortStates.get(receiver);
  if (!state) {
    const error = new TypeError('Value of "this" must be a MessagePort');
    error.code = 'ERR_INVALID_THIS';
    throw error;
  }
  return state;
}

function messagePortAddEventListener(name, listener) {
  const state = messagePortState(this);
  if (typeof listener !== 'function') return undefined;
  const wrapped = name === 'message'
    ? (data) => listener(state.messageEvent(data, receivedMessagePorts(data, state.nativePort)))
    : (detail) => listener({ type: name, detail, target: this, currentTarget: this });
  const listeners = state.eventTargetListeners.get(name) || new Map();
  listeners.set(listener, wrapped);
  state.eventTargetListeners.set(name, listeners);
  state.events.on(name, wrapped);
  if (name === 'message') state.drainDeferredMessages();
  return undefined;
}

function messagePortRemoveEventListener(name, listener) {
  const state = messagePortState(this);
  const wrapped = state.eventTargetListeners.get(name)?.get(listener);
  if (!wrapped) return undefined;
  state.events.off(name, wrapped);
  const listeners = state.eventTargetListeners.get(name);
  listeners.delete(listener);
  if (!listeners.size) state.eventTargetListeners.delete(name);
  return undefined;
}

function messagePortDispatchEvent(event) {
  const state = messagePortState(this);
  if (!event || typeof event.type !== 'string') throw new TypeError('event must have a type');
  state.events.emit(event.type, event.detail === undefined ? event : event.detail);
  return true;
}

function messagePortOn(name, listener) {
  messagePortState(this).events.on(name, listener);
  return this;
}

function messagePortOnce(name, listener) {
  messagePortState(this).events.once(name, listener);
  return this;
}

function messagePortOff(name, listener) {
  messagePortState(this).events.off(name, listener);
  return this;
}

function messagePortRemoveAllListeners(name) {
  messagePortState(this).events.removeAllListeners(name);
  return this;
}

function messagePortEmit(name, ...args) {
  return messagePortState(this).events.emit(name, ...args);
}

function messagePortListenerCount(name) {
  return messagePortState(this).events.listenerCount(name);
}

function messagePortSetMaxListeners(value) {
  messagePortState(this).events.setMaxListeners(value);
  return this;
}

function messagePortGetMaxListeners() {
  return messagePortState(this).events.getMaxListeners();
}

function messagePortEventNames() {
  return messagePortState(this).events.eventNames();
}

const messagePortEventTargetPrototype = Object.create(Object.prototype);
Object.defineProperties(messagePortEventTargetPrototype, {
  setMaxListeners: { configurable: true, writable: true, value: messagePortSetMaxListeners },
  getMaxListeners: { configurable: true, writable: true, value: messagePortGetMaxListeners },
  eventNames: { configurable: true, writable: true, value: messagePortEventNames },
  listenerCount: { configurable: true, writable: true, value: messagePortListenerCount },
  off: { configurable: true, writable: true, value: messagePortOff },
  removeListener: { configurable: true, writable: true, value: messagePortOff },
  on: { configurable: true, writable: true, value: messagePortOn },
  addListener: { configurable: true, writable: true, value: messagePortOn },
  emit: { configurable: true, writable: true, value: messagePortEmit },
  once: { configurable: true, writable: true, value: messagePortOnce },
  removeAllListeners: { configurable: true, writable: true, value: messagePortRemoveAllListeners },
});

function isMessagePort(value, MessagePort, NativeMessagePort = MessagePort) {
  return (typeof MessagePort === 'function' && value instanceof MessagePort)
    || (typeof NativeMessagePort === 'function' && value instanceof NativeMessagePort)
    || (value?.raw && typeof MessagePort === 'function' && value.raw instanceof MessagePort);
}

function adaptReceivedMessage(value, nativePort, seen = new WeakMap()) {
  const NativeMessagePort = nativePort?.constructor;
  if (nodeMessagePortClass && value instanceof nodeMessagePortClass) return value;
  if (typeof NativeMessagePort === 'function' && value instanceof NativeMessagePort) {
    return adaptMessagePort(value);
  }
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (seen.has(value)) return seen.get(value);
  if (value[cloneablePrototypeMarker] === true) {
    const copy = Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      Object.defineProperty(copy, key, descriptor);
    }
    return copy;
  }
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(adaptReceivedMessage(item, nativePort, seen));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = adaptReceivedMessage(item, nativePort, seen);
  return copy;
}

function receivedMessagePorts(value, nativePort, ports = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return ports;
  if (nodeMessagePortClass && value instanceof nodeMessagePortClass) {
    ports.push(value);
    return ports;
  }
  const NativeMessagePort = nativePort?.constructor;
  if (typeof NativeMessagePort === 'function' && value instanceof NativeMessagePort) {
    ports.push(adaptMessagePort(value));
    return ports;
  }
  seen.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return ports;
  if (Array.isArray(value)) {
    for (const item of value) receivedMessagePorts(item, nativePort, ports, seen);
    return ports;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return ports;
  for (const item of Object.values(value)) receivedMessagePorts(item, nativePort, ports, seen);
  return ports;
}

/** Provide Node's MessageEvent validation while retaining the browser Event base. */
export function createMessageEvent(scope = globalThis, {
  MessagePortClass = scope.MessagePort,
  NativeMessagePort = scope.MessagePort,
} = {}) {
  const Event = scope.Event || class BrowserEvent {};
  const MessageEvent = class MessageEvent extends Event {
    constructor(type, init = {}) {
      super(type, init || {});
      const options = init || {};
      const source = options.source ?? null;
      if (source !== null && !isMessagePort(source, MessagePortClass, NativeMessagePort)) {
        throw new TypeError(
          `MessageEvent constructor: Expected eventInitDict.source ("${messageEventValue(source)}") to be an instance of MessagePort.`,
        );
      }
      let ports = [];
      if (options.ports !== undefined) {
        const iterable = options.ports;
        if (iterable === null || typeof iterable[Symbol.iterator] !== 'function') {
          throw new TypeError(`MessageEvent constructor: eventInitDict.ports (${messageEventValue(iterable)}) is not iterable.`);
        }
        ports = Array.from(iterable);
        for (let index = 0; index < ports.length; index += 1) {
          if (!isMessagePort(ports[index], MessagePortClass, NativeMessagePort)) {
            throw new TypeError(
              `MessageEvent constructor: Expected eventInitDict.ports[${index}] ("${messageEventValue(ports[index])}") to be an instance of MessagePort.`,
            );
          }
        }
      }
      messageEventData.set(this, {
        data: options.data === undefined ? null : options.data,
        origin: options.origin === undefined ? '' : String(options.origin),
        lastEventId: options.lastEventId === undefined ? '' : String(options.lastEventId),
        source,
        ports,
      });
    }
  };
  function getMessageEventField(field) {
    const data = messageEventData.get(this);
    if (!data) {
      const error = new TypeError('Illegal invocation');
      error.code = 'ERR_INVALID_THIS';
      throw error;
    }
    return data[field];
  }
  Object.defineProperties(MessageEvent.prototype, {
    data: {
      configurable: true,
      enumerable: true,
      get() { return getMessageEventField.call(this, 'data'); },
    },
    origin: {
      configurable: true,
      enumerable: true,
      get() { return getMessageEventField.call(this, 'origin'); },
    },
    lastEventId: {
      configurable: true,
      enumerable: true,
      get() { return getMessageEventField.call(this, 'lastEventId'); },
    },
    source: {
      configurable: true,
      enumerable: true,
      get() { return getMessageEventField.call(this, 'source'); },
    },
    ports: {
      configurable: true,
      enumerable: true,
      get() { return getMessageEventField.call(this, 'ports'); },
    },
    initMessageEvent: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function initMessageEvent(
        type,
        bubbles = false,
        cancelable = false,
        data = null,
        origin = '',
        lastEventId = '',
        source = null,
        ports = [],
      ) {
        if (arguments.length === 0) {
          throw new TypeError('MessageEvent.initMessageEvent: 1 argument required, but 0 found.');
        }
        return new MessageEvent(type, {
          bubbles,
          cancelable,
          data,
          origin,
          lastEventId,
          source,
          ports,
        });
      },
    },
  });
  return MessageEvent;
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
export function adaptMessagePort(nativePort, { MessagePortClass = nodeMessagePortClass } = {}) {
  if (!nativePort) throw new TypeError('a native MessagePort is required');
  const events = new BrowserEventEmitter();
  let assignedOnMessage = null;
  let assignedOnMessageError = null;
  let closed = false;
  let closing = false;
  let closePeer = null;
  let notifyPeerMessage = null;
  let pendingMessages = 0;
  let refed = true;
  const closeCallbacks = [];
  let peerPort = null;
  let peerCloseRequested = false;
  const queuedMessages = [];
  const deferredMessages = [];
  const eventTargetListeners = new Map();
  let port;
  const messageEvent = (data, ports = []) => ({
    type: 'message',
    data,
    target: port,
    currentTarget: port,
    origin: '',
    lastEventId: '',
    source: null,
    ports,
  });
  const deliverMessage = (data) => {
    events.emit('message', data);
    assignedOnMessage?.(messageEvent(data, receivedMessagePorts(data, nativePort)));
  };
  const drainDeferredMessages = () => {
    if (closed || (events.listenerCount('message') === 0 && !assignedOnMessage)) return;
    while (deferredMessages.length && !closed) deliverMessage(deferredMessages.shift());
  };
  const onMessage = (event) => {
    if (closed) return;
    const queued = queuedMessages.shift();
    const data = adaptReceivedMessage(
      queued?.useNative ? event?.data : queued ? queued.value : event?.data,
      nativePort,
    );
    try {
      if (queued?.consumed) return;
      if (events.listenerCount('message') === 0 && !assignedOnMessage) deferredMessages.push(data);
      else deliverMessage(data);
    } finally {
      if (pendingMessages > 0) pendingMessages -= 1;
      if (closing && pendingMessages === 0) closeLocally();
      else if (peerCloseRequested && pendingMessages === 0) closeLocally();
    }
  };
  const onMessageError = (event) => {
    if (closed) return;
    events.emit('messageerror', event);
    assignedOnMessageError?.(event);
  };

  if (typeof nativePort.addEventListener === 'function') {
    nativePort.addEventListener('message', onMessage);
    nativePort.addEventListener('messageerror', onMessageError);
  } else {
    nativePort.onmessage = onMessage;
    nativePort.onmessageerror = onMessageError;
  }
  if (typeof nativePort.start === 'function') nativePort.start();

  const finishClose = () => {
    if (closed) return;
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
    deferredMessages.length = 0;
    for (const closeCallback of closeCallbacks.splice(0)) queueMicrotask(closeCallback);
  };
  const closeLocally = (callback) => {
    if (closed) {
      callback && queueMicrotask(callback);
      return;
    }
    if (callback) closeCallbacks.push(callback);
    if (closing) {
      if (pendingMessages === 0) finishClose();
      return;
    }
    closing = true;
    if (pendingMessages === 0) finishClose();
  };

  port = {
    raw: nativePort,
    on(name, listener) { events.on(name, listener); if (name === 'message') drainDeferredMessages(); return port; },
    once(name, listener) { events.once(name, listener); if (name === 'message') drainDeferredMessages(); return port; },
    addListener(name, listener) { events.on(name, listener); if (name === 'message') drainDeferredMessages(); return port; },
    off(name, listener) { events.off(name, listener); return port; },
    removeListener(name, listener) { events.off(name, listener); return port; },
    removeAllListeners(name) { events.removeAllListeners(name); return port; },
    listenerCount(name) { return events.listenerCount(name); },
    setMaxListeners(value) { events.setMaxListeners(value); return port; },
    getMaxListeners() { return events.getMaxListeners(); },
    eventNames() { return events.eventNames(); },
    emit(name, ...args) { events.emit(name, ...args); return true; },
    addEventListener(name, listener) {
      if (typeof listener !== 'function') return;
      const wrapped = name === 'message'
        ? (data) => listener(messageEvent(data, receivedMessagePorts(data, nativePort)))
        : (detail) => listener({ type: name, detail, target: port, currentTarget: port });
      const listeners = eventTargetListeners.get(name) || new Map();
      listeners.set(listener, wrapped);
      eventTargetListeners.set(name, listeners);
      events.on(name, wrapped);
      if (name === 'message') drainDeferredMessages();
    },
    removeEventListener(name, listener) {
      const wrapped = eventTargetListeners.get(name)?.get(listener);
      if (!wrapped) return;
      events.off(name, wrapped);
      const listeners = eventTargetListeners.get(name);
      listeners.delete(listener);
      if (!listeners.size) eventTargetListeners.delete(name);
    },
    dispatchEvent(event) {
      if (!event || typeof event.type !== 'string') throw new TypeError('event must have a type');
      events.emit(event.type, event.detail === undefined ? event : event.detail);
      return true;
    },
    start() { if (typeof nativePort.start === 'function') nativePort.start(); drainDeferredMessages(); return port; },
    postMessage(value, transferList) {
      if (isUncloneable(value)) throw dataCloneError('object could not be cloned');
      const normalizedTransfers = normalizePortTransferList(transferList);
      const sourceRawPort = nativePort;
      if (normalizedTransfers?.some((item) => (item?.raw || item) === sourceRawPort)) {
        throw dataCloneError('Transfer list contains source port');
      }
      const transferIdentities = normalizedTransfers?.map((item) => item?.raw || item) || [];
      if (peerPort && transferIdentities.includes(peerPort.raw || peerPort)) {
        detachArrayBuffers(normalizedTransfers);
        globalThis.process?.emitWarning?.(
          'The target port was posted to itself, and the communication channel was lost',
          'Warning',
        );
        closeLocally();
        closePeer?.();
        return;
      }
      if (closed) {
        if (normalizedTransfers?.some((item) => item?.__bnhIsClosed)) throw detachedPortError();
        return;
      }
      const [message, transfers] = transferArguments(value, normalizedTransfers);
      const hasTransfer = Array.isArray(transfers) ? transfers.length > 0 : transfers !== undefined;
      notifyPeerMessage?.(hasTransfer ? undefined : message, hasTransfer);
      if (transfers === undefined) callNative(nativePort, 'postMessage', message);
      else callNative(nativePort, 'postMessage', message, transfers);
    },
    close(callback) {
      if (callback !== undefined && typeof callback !== 'function') {
        throw new TypeError('callback must be a function');
      }
      closeLocally(callback);
      closePeer?.();
      return port;
    },
    hasRef() { return refed && !closed; },
    ref() { refed = true; return port; },
    unref() { refed = false; return port; },
  };

  messagePortStates.set(port, {
    events,
    nativePort,
    eventTargetListeners,
    messageEvent,
    drainDeferredMessages,
  });

  Object.defineProperties(port, {
    __bnhCloseFromPeer: {
      value: () => {
        peerCloseRequested = true;
        closeLocally();
      },
    },
    __bnhSetPeerClose: {
      value: (callback) => { closePeer = callback; },
    },
    __bnhMessageQueued: {
      value: (value, useNative = false) => {
        pendingMessages += 1;
        queuedMessages.push({ value, useNative, consumed: false });
      },
    },
    __bnhReceiveMessage: {
      value: () => {
        const queued = queuedMessages.find((entry) => !entry.consumed && !entry.useNative);
        if (!queued) return undefined;
        queued.consumed = true;
        return queued.value;
      },
    },
    __bnhIsClosed: {
      get: () => closed,
    },
    __bnhSetPeerMessageQueued: {
      value: (callback) => { notifyPeerMessage = callback; },
    },
    __bnhSetPeerPort: {
      value: (value) => { peerPort = value; },
    },
    onmessage: {
      get: () => assignedOnMessage,
      set: (listener) => {
        assignedOnMessage = typeof listener === 'function' ? listener : null;
        drainDeferredMessages();
      },
    },
    onmessageerror: {
      get: () => assignedOnMessageError,
      set: (listener) => {
        assignedOnMessageError = typeof listener === 'function' ? listener : null;
      },
    },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      configurable: true,
      value: () => `MessagePort { active: ${!closed}, refed: ${refed} }`,
    },
  });
  // Keep the Node-facing adapter observable as a MessagePort while its own
  // methods continue to translate browser events into Node-style callbacks.
  try {
    const prototypeClass = MessagePortClass || nativePort.constructor;
    if (prototypeClass?.prototype) {
      Object.setPrototypeOf(port, prototypeClass.prototype);
    }
  } catch {
    // Some browser implementations expose a non-configurable prototype.
  }
  return port;
}

export function prepareTransferPayload(value, transferList) {
  return transferArguments(value, transferList);
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
  // Harness-owned metadata must share the transport but not the guest IPC
  // sequence.  In particular, a terminal control frame must not wait for a
  // bookkeeping message that is intentionally filtered from guest listeners.
  const sendInternal = (payload) => {
    if (closed) return false;
    port.postMessage({ channel: 'bnh-user-ipc', runId, childId, direction: outgoingDirection, type: 'message', internal: true, payload });
    return true;
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
    if (frame.internal !== true) {
      if (!Number.isInteger(frame.sequence) || frame.sequence <= lastReceived) return;
      lastReceived = frame.sequence;
    }
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
    sendInternal,
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
  const NativeMessageChannel = nativeMessageChannels.get(scope) || scope.MessageChannel;
  if (typeof NativeMessageChannel !== 'function') throw new TypeError('MessageChannel is unavailable');
  const channel = new NativeMessageChannel();
  const port1 = adaptMessagePort(channel.port1);
  const port2 = adaptMessagePort(channel.port2);
  port1.__bnhSetPeerClose?.(port2.__bnhCloseFromPeer);
  port2.__bnhSetPeerClose?.(port1.__bnhCloseFromPeer);
  port1.__bnhSetPeerPort?.(port2);
  port2.__bnhSetPeerPort?.(port1);
  port1.__bnhSetPeerMessageQueued?.(port2.__bnhMessageQueued);
  port2.__bnhSetPeerMessageQueued?.(port1.__bnhMessageQueued);
  return {
    raw: channel,
    port1,
    port2,
  };
}

function createMessagePortClass() {
  function MessagePort() {
    const error = new TypeError('MessagePort constructor cannot be invoked without a valid native port');
    error.code = 'ERR_CONSTRUCT_CALL_INVALID';
    throw error;
  }
  Object.defineProperties(MessagePort.prototype, {
    constructor: { configurable: true, writable: true, value: MessagePort },
    close: { configurable: true, writable: true, value() {} },
    hasRef: { configurable: true, writable: true, value() { return true; } },
    postMessage: { configurable: true, writable: true, value() {} },
    ref: { configurable: true, writable: true, value() { return this; } },
    start: { configurable: true, writable: true, value() { return this; } },
    unref: { configurable: true, writable: true, value() { return this; } },
    onmessage: { configurable: true, get() { return null; }, set(_) {} },
    onmessageerror: { configurable: true, get() { return null; }, set(_) {} },
    addEventListener: { configurable: true, writable: true, value: messagePortAddEventListener },
    removeEventListener: { configurable: true, writable: true, value: messagePortRemoveEventListener },
    dispatchEvent: { configurable: true, writable: true, value: messagePortDispatchEvent },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      configurable: true,
      value() { return 'MessagePort'; },
    },
    [Symbol.toStringTag]: {
      configurable: true,
      value: 'EventTarget',
    },
  });
  Object.setPrototypeOf(MessagePort.prototype, messagePortEventTargetPrototype);
  return MessagePort;
}

function invalidMessagePort() {
  const error = new TypeError('The "port" argument must be a MessagePort instance');
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

/** Implement the synchronous worker_threads channel helpers over queued ports. */
function createMessagePortHelpers() {
  return {
    receiveMessageOnPort(port) {
      if (!port?.__bnhReceiveMessage) throw invalidMessagePort();
      const message = port.__bnhReceiveMessage();
      return message === undefined ? undefined : { message };
    },
    moveMessagePortToContext(port) {
      if (!port?.__bnhReceiveMessage) throw invalidMessagePort();
      if (port.__bnhIsClosed) {
        const error = new Error('Cannot send data on closed MessagePort');
        error.code = 'ERR_CLOSED_MESSAGE_PORT';
        throw error;
      }
      return port;
    },
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
    // Chromium's ErrorEvent does not carry custom Error properties across the
    // worker boundary. Give the bootstrap's structured error record a chance
    // to arrive before falling back to the lossy browser event.
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
    ref() {},
    unref() {},
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
    if (options.eval && typeof source !== 'string') {
      throw new TypeError("The property 'options.eval' must be false when 'filename' is not a string.");
    }
    const inheritedNoAddons = scope.process?.execArgv?.some((argument) => String(argument) === '--no-addons')
      || options.execArgv?.some((argument) => String(argument) === '--no-addons');
    const workerBootstrap = inheritedNoAddons
      ? bootstrap.replace('const __bnhNoAddons = false;', 'const __bnhNoAddons = true;')
      : bootstrap;
    const generated = options.eval ? workerSourceURL(scope, `${workerBootstrap}\n${source}`) : null;
    const workerOptions = {};
    if (options.name !== undefined) workerOptions.name = options.name;
    if (options.type !== undefined) workerOptions.type = options.type;
    const nativeWorker = new scope.Worker(generated?.url || source, workerOptions);
    return adaptWorker(nativeWorker, { revokeURL: generated?.revokeURL });
  };
}

export function createBroadcastChannelFactory(scope = globalThis) {
  if (typeof scope.BroadcastChannel !== 'function') return undefined;
  const channelStates = new WeakMap();
  const stateFor = (receiver) => {
    const state = channelStates.get(receiver);
    if (!state) {
      const error = new TypeError('Illegal invocation');
      error.code = 'ERR_INVALID_THIS';
      throw error;
    }
    return state;
  };
  function BroadcastChannel(name) {
    if (!new.target) {
      const error = new TypeError('Class constructor BroadcastChannel cannot be invoked without \'new\'');
      error.code = 'ERR_CONSTRUCT_CALL_REQUIRED';
      throw error;
    }
    if (arguments.length === 0) {
      const error = new TypeError('The "name" argument must be specified');
      error.code = 'ERR_MISSING_ARGS';
      throw error;
    }
    const channelName = String(name);
    const channel = new scope.BroadcastChannel(channelName);
    const adapted = adaptMessagePort(channel, { MessagePortClass: BroadcastChannel });
    const nativeClose = adapted.close;
    const nativePostMessage = adapted.postMessage;
    const nativeRef = adapted.ref;
    const nativeUnref = adapted.unref;
    const onmessage = Object.getOwnPropertyDescriptor(adapted, 'onmessage');
    const onmessageerror = Object.getOwnPropertyDescriptor(adapted, 'onmessageerror');
    const postMessage = function postMessage(value) {
      if (arguments.length === 0) {
        const error = new TypeError('The "message" argument must be specified');
        error.code = 'ERR_MISSING_ARGS';
        throw error;
      }
      if (adapted.__bnhIsClosed) {
        const error = typeof scope.DOMException === 'function'
          ? new scope.DOMException('BroadcastChannel is closed.', 'InvalidStateError')
          : Object.assign(new Error('BroadcastChannel is closed.'), { name: 'InvalidStateError', code: 11 });
        throw error;
      }
      return nativePostMessage.call(adapted, value);
    };
    const ownProperties = ['close', 'hasRef', 'postMessage', 'ref', 'start', 'unref'];
    for (const property of ownProperties) delete adapted[property];
    delete adapted[Symbol.for('nodejs.util.inspect.custom')];
    channelStates.set(adapted, {
      adapted,
      channelName,
      close: () => { nativeClose.call(adapted); },
      postMessage,
      ref: () => nativeRef.call(adapted),
      unref: () => nativeUnref.call(adapted),
      onmessage,
      onmessageerror,
    });
    return adapted;
  }
  const close = function close() { stateFor(this).close(); };
  const postMessage = function postMessage(message) {
    const state = stateFor(this);
    return arguments.length === 0 ? state.postMessage() : state.postMessage(message);
  };
  const ref = function ref() { stateFor(this).ref(); return this; };
  const unref = function unref() { stateFor(this).unref(); return this; };
  Object.defineProperties(BroadcastChannel.prototype, {
    constructor: { configurable: true, writable: true, value: BroadcastChannel },
    name: {
      configurable: true,
      enumerable: true,
      get() { return stateFor(this).channelName; },
    },
    close: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: close,
    },
    postMessage: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: postMessage,
    },
    ref: {
      configurable: true,
      writable: true,
      value: ref,
    },
    unref: {
      configurable: true,
      writable: true,
      value: unref,
    },
    onmessage: {
      configurable: true,
      enumerable: true,
      get() { return stateFor(this).onmessage.get.call(stateFor(this).adapted); },
      set(value) { stateFor(this).onmessage.set.call(stateFor(this).adapted, value); },
    },
    onmessageerror: {
      configurable: true,
      enumerable: true,
      get() { return stateFor(this).onmessageerror.get.call(stateFor(this).adapted); },
      set(value) { stateFor(this).onmessageerror.set.call(stateFor(this).adapted, value); },
    },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      configurable: true,
      value(depth) {
        const state = stateFor(this);
        if (depth < 0) return 'BroadcastChannel';
        const quotedName = state.channelName.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
        return `BroadcastChannel { name: '${quotedName}', active: ${!state.adapted.__bnhIsClosed} }`;
      },
    },
  });
  if (scope.EventTarget?.prototype) Object.setPrototypeOf(BroadcastChannel.prototype, scope.EventTarget.prototype);
  Object.defineProperty(BroadcastChannel, 'prototype', { writable: false });
  return BroadcastChannel;
}

export function createMessagingPrimitives(scope = globalThis) {
  nodeMessagePortClass ||= createMessagePortClass();
  const nativeMessageChannel = nativeMessageChannels.get(scope) || scope.MessageChannel;
  if (nativeMessageChannel) nativeMessageChannels.set(scope, nativeMessageChannel);
  const nativeStructuredClone = typeof scope.structuredClone === 'function'
    ? scope.structuredClone.bind(scope)
    : undefined;
  const Worker = typeof scope.Worker === 'function' ? createWorkerFactory(scope) : undefined;
  const MessageChannel = typeof nativeMessageChannel === 'function'
    ? function MessageChannel() {
        if (!new.target) {
          const error = new TypeError('Class constructor MessageChannel cannot be invoked without \'new\'');
          error.code = 'ERR_CONSTRUCT_CALL_REQUIRED';
          throw error;
        }
        return createMessageChannel(scope);
      }
    : undefined;
  return {
    Worker,
    MessageChannel,
    BroadcastChannel: createBroadcastChannelFactory(scope),
    SHARE_ENV,
    MessagePort: nodeMessagePortClass,
    isMainThread: true,
    parentPort: null,
    workerData: undefined,
    ...createMessagePortHelpers(),
    markAsUncloneable,
    markAsUntransferable,
    isMarkedAsUntransferable,
    structuredClone(value, options) {
      if (isUncloneable(value)) throw uncloneableError(value);
      if (!nativeStructuredClone) return value;
      return nativeStructuredClone(value, options);
    },
  };
}
