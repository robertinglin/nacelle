import { EventEmitter } from './events.js';
import { AsyncResource } from './async-hooks.js';
import { createBrowserDns } from './dns.js';
import {
  createVirtualNetwork,
  sharedVirtualNetwork,
  normalizeVirtualAddress,
  virtualAddressFamily,
  virtualNetworkConstants,
} from './virtual-network.js';

const UDP_CONSTANTS = Object.freeze({
  UV_UDP_REUSEADDR: 4,
  UV_UDP_REUSEPORT: 2,
  IPV6_ONLY: 27,
});

const VIRTUAL_DGRAM_STATE = Symbol.for('bnh.dgram.state');
const DGRAM_OWNER = Symbol.for('bnh.dgram.owner');
const SymbolNodeAsyncDispose = Symbol.for('nodejs.asyncDispose');
const SymbolAsyncDispose = Symbol.asyncDispose || SymbolNodeAsyncDispose;
const BIND_STATE_UNBOUND = 0;
const BIND_STATE_BINDING = 1;
const BIND_STATE_BOUND = 2;
const UV_EBADF = -9;
const UV_EINVAL = -22;
const UV_EADDRNOTAVAIL = -99;
const UV_EADDRINUSE = -98;
let nextVirtualDescriptor = 1000;

function invalidArgumentType(name, expected, value) {
  let received;
  if (value === null || value === undefined) {
    received = String(value);
  } else if (typeof value === 'object') {
    received = `an instance of ${value.constructor?.name || 'Object'}`;
  } else if (typeof value === 'function') {
    received = `function ${value.name || ''}`.trim();
  } else {
    const inspected = typeof value === 'string' ? `'${value}'` : String(value);
    received = `type ${typeof value} (${inspected})`;
  }
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateNumber(value, name) {
  if (typeof value !== 'number') throw invalidArgumentType(name, 'number', value);
}

function missingArgument(name) {
  const error = new TypeError(`The "${name}" argument must be specified`);
  error.code = 'ERR_MISSING_ARGS';
  return error;
}

function bufferOutOfBounds(name) {
  const error = new RangeError(`"${name}" is outside of buffer bounds`);
  error.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
  return error;
}

const DGRAM_BUFFER_EXPECTED = 'string or an instance of Buffer, TypedArray, or DataView';

function asBytes(value, offset = 0, length = undefined) {
  let bytes;
  if (typeof value === 'string') bytes = new TextEncoder().encode(value);
  else if (Array.isArray(value)) {
    const parts = [];
    for (const part of value) {
      if (typeof part !== 'string' && !ArrayBuffer.isView(part)) {
        throw invalidArgumentType('buffer list arguments', DGRAM_BUFFER_EXPECTED, value);
      }
      parts.push(asBytes(part));
    }
    bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let cursor = 0;
    for (const part of parts) {
      bytes.set(part, cursor);
      cursor += part.byteLength;
    }
  }
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw invalidArgumentType('buffer', DGRAM_BUFFER_EXPECTED, value);
  if (!Number.isInteger(offset) || offset < 0) throw bufferOutOfBounds('offset');
  if (offset > bytes.byteLength) throw bufferOutOfBounds('offset');
  if (length === undefined) length = bytes.byteLength - offset;
  if (!Number.isInteger(length) || length < 0) throw bufferOutOfBounds('length');
  if (offset + length > bytes.byteLength) throw bufferOutOfBounds('length');
  return bytes.slice(offset, offset + length);
}

function validatePort(port, allowZero = true) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) {
    throw new RangeError(`port must be an integer between ${allowZero ? 0 : 1} and 65535: ${port}`);
  }
  return value;
}

function networkError(code, syscall, address, port) {
  const error = new Error(`${syscall} ${code} ${address}:${port}`);
  error.code = code;
  error.errno = code;
  error.syscall = syscall;
  error.address = address;
  error.port = port;
  return error;
}

function socketError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function handleError(error, syscall) {
  const code = error === UV_EINVAL
    ? 'EINVAL'
    : error === UV_EADDRNOTAVAIL ? 'EADDRNOTAVAIL' : 'UNKNOWN';
  const exception = new Error(`${syscall} ${code}`);
  exception.code = code;
  exception.errno = error;
  exception.syscall = syscall;
  return exception;
}

function validateBufferSize(size) {
  if (!Number.isInteger(size) || size < 0 || size > 0xffffffff) {
    const error = new TypeError('Buffer size must be a positive integer');
    error.code = 'ERR_SOCKET_BAD_BUFFER_SIZE';
    throw error;
  }
  return size;
}

function bufferSizeError(receive, errno) {
  const syscall = `uv_${receive ? 'recv' : 'send'}_buffer_size`;
  const code = errno === UV_EBADF ? 'EBADF' : 'EINVAL';
  const message = errno === UV_EBADF ? 'bad file descriptor' : 'invalid argument';
  const error = new Error(
    `Could not get or set buffer size: ${syscall} returned ${code} (${message})`,
  );
  error.name = 'SystemError';
  error.code = 'ERR_SOCKET_BUFFER_SIZE';
  error.info = { code, message, errno, syscall };
  error.errno = errno;
  error.syscall = syscall;
  return error;
}

function virtualBufferSize(state, size, receive, bound) {
  if (!bound) return UV_EBADF;
  const key = receive ? 'recvBufferSize' : 'sendBufferSize';
  if (size === 0) return state[key];
  if (size > 0x7fffffff) return UV_EINVAL;
  // Linux doubles the requested socket buffer in the kernel. The virtual
  // runtime exposes linux platform semantics without using a host socket.
  state[key] = globalThis.process?.platform === 'linux' ? size * 2 : size;
  return state[key];
}

function virtualTTL(state, value) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 255) {
    return UV_EINVAL;
  }
  state.ttl = value;
  return 0;
}

function deprecatedSocketApi(message, operation) {
  let warned = false;
  return function deprecatedSocketApiWrapper(...args) {
    if (!warned) {
      warned = true;
      globalThis.process?.emitWarning?.(message, {
        type: 'DeprecationWarning',
        code: 'DEP0112',
      });
    }
    return operation.call(this, ...args);
  };
}

function healthCheck(socket) {
  if (socket._closed || !socket[VIRTUAL_DGRAM_STATE]?.handle) {
    throw socketError('ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
  }
}

function stopReceiving(socket) {
  const state = socket[VIRTUAL_DGRAM_STATE];
  if (!state?.receiving) return;
  state.handle?.recvStop?.();
  state.receiving = false;
}

function enqueue(socket, operation) {
  const state = socket[VIRTUAL_DGRAM_STATE];
  if (state.queue === undefined) {
    state.queue = [];
    socket.once(EventEmitter.errorMonitor, () => {
      state.queue = undefined;
    });
    socket.once('listening', () => {
      const queue = state.queue;
      state.queue = undefined;
      for (const queuedOperation of queue || []) queuedOperation();
    });
  }
  state.queue.push(operation);
}

function makeNodeBytes(bytes, BufferClass) {
  return typeof BufferClass?.from === 'function' ? BufferClass.from(bytes) : bytes;
}

function isInt32(value) {
  return Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
}

function socketTypeError(type) {
  const error = new TypeError(`Bad socket type: ${type}`);
  error.code = 'ERR_SOCKET_BAD_TYPE';
  return error;
}

function allocateHandleFd() {
  const descriptors = globalThis.__BNH_VIRTUAL_FD_TYPES__;
  let fd = nextVirtualDescriptor++;
  while (descriptors?.has(fd)) fd = nextVirtualDescriptor++;
  return fd;
}

function createDgramHandle(type, { dns, network, lookup, BufferClass, cluster, clusterGroupId, trackTask } = {}) {
  if (type !== 'udp4' && type !== 'udp6') throw socketTypeError(type);

  const family = type === 'udp6' ? 6 : 4;
  const resolver = lookup || dns?.lookup?.bind(dns) || createBrowserDns().lookup;
  const descriptors = globalThis.__BNH_VIRTUAL_FD_TYPES__;
  const udpHandles = globalThis.__BNH_VIRTUAL_UDP_HANDLES__;
  const state = {
    address: family === 6 ? '::' : '0.0.0.0',
    family: family === 6 ? 'IPv6' : 'IPv4',
    port: 0,
    bound: false,
    closed: false,
    owner: null,
    recvBufferSize: 0,
    sendBufferSize: 0,
    sendQueueCount: 0,
    sendQueueSize: 0,
    broadcast: 0,
    ttl: 64,
    multicastTTL: 1,
    multicastLoopback: 1,
    multicastInterface: undefined,
    memberships: new Map(),
    sourceMemberships: new Map(),
    refed: true,
    messageListeners: [],
    nextMessageListener: 0,
  };
  const handle = {
    fd: allocateHandleFd(),
    lookup(address, callback) {
      return resolver(address || (family === 6 ? '::1' : '127.0.0.1'), { family }, callback);
    },
    bind(address = family === 6 ? '::' : '0.0.0.0', port = 0, flags = 0) {
      if (state.closed || state.bound) return UV_EINVAL;
      if (typeof address !== 'string' || virtualAddressFamily(address) !== family) return UV_EINVAL;
      const normalizedAddress = normalizeVirtualAddress(address, family);
      try {
        const clusterObject = typeof cluster === 'function' ? cluster() : cluster;
        const groupId = clusterGroupId ?? clusterObject?._bnhGroupId;
        const bind = groupId !== undefined && clusterObject?.isPrimary
          ? network?.bindClusterUdp?.bind(network, groupId)
          : network?.bindUdp?.bind(network);
        const binding = bind?.(groupId !== undefined && clusterObject?.isPrimary
          ? groupId
          : handle, normalizedAddress, validatePort(port), {
          reuseAddr: (Number(flags) & UDP_CONSTANTS.UV_UDP_REUSEADDR) !== 0,
          reusePort: (Number(flags) & UDP_CONSTANTS.UV_UDP_REUSEPORT) !== 0,
          ipv6Only: false,
          socket: handle,
        });
        if (!binding) return UV_EINVAL;
        state.address = binding.address;
        state.family = family === 6 ? 'IPv6' : 'IPv4';
        state.port = binding.port;
        state.bound = true;
        state.owner = handle;
        state.taskRelease = state.refed ? trackTask?.() || null : null;
        udpHandles?.set(handle.fd, { handle, ...state });
        return 0;
      } catch (error) {
        return error?.code === 'EADDRINUSE' ? UV_EADDRINUSE : UV_EINVAL;
      }
    },
    getsockname(address) {
      if (address) Object.assign(address, state);
      return state.bound ? 0 : UV_EINVAL;
    },
    open(fd) {
      const descriptorType = descriptors?.get(fd);
      const descriptor = udpHandles?.get(fd);
      if (descriptorType !== 'udp' || !descriptor) return UV_EINVAL;
      state.address = descriptor.address;
      state.family = descriptor.family;
      state.port = descriptor.port;
      state.bound = Boolean(descriptor.bound);
      state.owner = descriptor.owner || descriptor.handle;
      return 0;
    },
    recvStart() {
      if (state.closed) return UV_EINVAL;
      state.receiving = true;
      return 0;
    },
    recvStop() { state.receiving = false; return 0; },
    getSendQueueCount() { return state.sendQueueCount; },
    getSendQueueSize() { return state.sendQueueSize; },
    setBroadcast(value) { state.broadcast = value ? 1 : 0; return 0; },
    setTTL(value) { return virtualTTL(state, value); },
    setMulticastTTL(value) { state.multicastTTL = value; return 0; },
    setMulticastLoopback(value) { state.multicastLoopback = value ? 1 : 0; return 0; },
    setMulticastInterface(value) { state.multicastInterface = value; return 0; },
    addMembership(multicastAddress, interfaceAddress) {
      state.memberships.set(`${multicastAddress}\u0000${interfaceAddress ?? ''}`, {
        multicastAddress,
        interfaceAddress,
      });
      return 0;
    },
    dropMembership(multicastAddress, interfaceAddress) {
      const key = `${multicastAddress}\u0000${interfaceAddress ?? ''}`;
      if (!state.memberships.delete(key)) return UV_EADDRNOTAVAIL;
      return 0;
    },
    addSourceSpecificMembership(sourceAddress, groupAddress, interfaceAddress) {
      state.sourceMemberships.set(`${sourceAddress}\u0000${groupAddress}\u0000${interfaceAddress ?? ''}`, {
        sourceAddress,
        groupAddress,
        interfaceAddress,
      });
      return 0;
    },
    dropSourceSpecificMembership(sourceAddress, groupAddress, interfaceAddress) {
      state.sourceMemberships.delete(`${sourceAddress}\u0000${groupAddress}\u0000${interfaceAddress ?? ''}`);
      return 0;
    },
    bufferSize(size, receive) {
      return virtualBufferSize(state, size, receive, state.bound);
    },
    ref() {
      state.refed = true;
      if (state.bound && !state.taskRelease) state.taskRelease = trackTask?.() || null;
      return handle;
    },
    unref() {
      state.refed = false;
      state.taskRelease?.();
      state.taskRelease = null;
      return handle;
    },
    hasRef() { return state.refed; },
    connect(address, port) {
      if (state.closed || !state.bound) return UV_EINVAL;
      state.remoteAddress = {
        address: normalizeVirtualAddress(address, family),
        port: validatePort(port),
      };
      return 0;
    },
    disconnect() {
      state.remoteAddress = null;
      return 0;
    },
    getpeername(address) {
      if (!state.remoteAddress) return UV_EINVAL;
      if (address) Object.assign(address, {
        ...state.remoteAddress,
        family: family === 6 ? 'IPv6' : 'IPv4',
      });
      return 0;
    },
    _bnhBindCluster(groupId, address, port, options = {}) {
      if (state.closed || state.bound) return UV_EINVAL;
      try {
        const binding = network?.bindClusterUdp?.(groupId, address, validatePort(port), {
          ...options,
          socket: handle,
        });
        if (!binding) return UV_EINVAL;
        state.address = binding.address;
        state.family = family === 6 ? 'IPv6' : 'IPv4';
        state.port = binding.port;
        state.bound = true;
        state.owner = handle;
        state.taskRelease = state.refed ? trackTask?.() || null : null;
        udpHandles?.set(handle.fd, { handle, ...state });
        return 0;
      } catch (error) {
        return error?.code === 'EADDRINUSE' ? UV_EADDRINUSE : UV_EINVAL;
      }
    },
    _receiveDatagram(bytes, rinfo) {
      if (state.closed || !state.receiving) return;
      const buffer = makeNodeBytes(bytes, BufferClass);
      const listeners = state.messageListeners.filter(({ owner }) => !owner?._closed);
      if (!listeners.length) return;
      const listener = listeners[state.nextMessageListener % listeners.length];
      state.nextMessageListener = (state.nextMessageListener + 1) % listeners.length;
      const receiver = Object.create(handle);
      Object.defineProperty(receiver, DGRAM_OWNER, { configurable: true, value: listener.owner });
      listener.callback.call(receiver, buffer.byteLength, receiver, buffer, rinfo);
    },
    send(request, buffer, offset, length, port, address) {
      request?._bnhInitialize?.();
      const list = Array.isArray(buffer) ? buffer : [buffer];
      const bytes = list.reduce((result, item) => {
        const part = asBytes(item);
        const next = new Uint8Array(result.byteLength + part.byteLength);
        next.set(result);
        next.set(part, result.byteLength);
        return next;
      }, new Uint8Array(0));
      const targetPort = Array.isArray(buffer)
        ? (typeof length === 'number' && length > 0 ? length : state.remoteAddress?.port)
        : port;
      const targetAddress = Array.isArray(buffer)
        ? (typeof port === 'string' ? port : state.remoteAddress?.address)
        : address;
      const size = bytes.byteLength;
      state.sendQueueCount += 1;
      state.sendQueueSize += size;
      queueMicrotask(() => {
        state.sendQueueCount = Math.max(0, state.sendQueueCount - 1);
        state.sendQueueSize = Math.max(0, state.sendQueueSize - size);
        if (state.bound && targetPort !== undefined) {
          network?.sendUdp?.({
            source: handle,
            address: targetAddress || (family === 6 ? '::1' : '127.0.0.1'),
            port: targetPort,
            bytes,
          });
        }
        request?.oncomplete?.call(request, 0, size);
      });
      return 0;
    },
    close(callback) {
      if (state.closed) return 0;
      if (state.bound) network?.unbindUdp?.(handle);
      state.taskRelease?.();
      state.taskRelease = null;
      state.bound = false;
      state.closed = true;
      descriptors?.delete(handle.fd);
      udpHandles?.delete(handle.fd);
      callback?.();
      return 0;
    },
  };
  Object.defineProperty(handle, 'owner', {
    configurable: true,
    enumerable: false,
    get() { return handle[DGRAM_OWNER]; },
    set(value) {
      handle[DGRAM_OWNER] = value;
      if (value && !state.messageListeners.some(({ owner }) => owner === value)) {
        state.messageListeners.push({ owner: value, callback: handle.onmessage });
      }
    },
  });
  Object.defineProperty(handle, 'onmessage', {
    configurable: true,
    enumerable: false,
    get() { return state.messageListeners.at(-1)?.callback; },
    set(callback) {
      if (typeof callback !== 'function') return;
      const owner = handle[DGRAM_OWNER];
      const existing = state.messageListeners.find((listener) => listener.owner === owner);
      if (existing) existing.callback = callback;
      else if (owner) state.messageListeners.push({ owner, callback });
    },
  });
  Object.defineProperties(handle, {
    boundAddress: { configurable: true, enumerable: false, get: () => state.address },
    boundPort: { configurable: true, enumerable: false, get: () => state.port },
  });
  handle.bind6 = handle.bind;
  handle.connect = () => 0;
  handle.connect6 = handle.connect;
  handle.send6 = handle.send;
  descriptors?.set(handle.fd, 'udp');
  udpHandles?.set(handle.fd, { handle, ...state });
  return handle;
}

function createSocketHandle(address, port, addressType, fd, flags, options) {
  const handle = createDgramHandle(addressType, options);
  let error;
  if (isInt32(fd) && fd > 0) {
    const descriptors = globalThis.__BNH_VIRTUAL_FD_TYPES__;
    const udpHandles = globalThis.__BNH_VIRTUAL_UDP_HANDLES__;
    if (descriptors?.get(fd) !== 'udp' || !udpHandles?.has(fd)) error = UV_EINVAL;
    else error = handle.open(fd);
  } else if (port || address) {
    error = handle.bind(address || (addressType === 'udp6' ? '::' : '0.0.0.0'), port || 0, flags);
  }
  if (error) {
    handle.close();
    return error;
  }
  handle._bnhRawUdpHandle = false;
  return handle;
}

/** Browser-native UDP socket backed by the shared virtual socket registry. */
export class Socket extends EventEmitter {
  constructor(type = 'udp4', listener, internal = {}) {
    super();
    this._events = Object.create(null);
    this._eventsCount = 0;
    this._maxListeners = undefined;
    if (typeof type === 'object') {
      const options = type;
      internal = { ...options, ...internal };
      type = options.type || 'udp4';
      listener = options.callback || listener;
    }
    if (type !== 'udp4' && type !== 'udp6') throw new TypeError(`invalid dgram type: ${type}`);
    this.type = type;
    this._network = internal.network || sharedVirtualNetwork;
    this._dns = internal.dns || createBrowserDns();
    this._bufferClass = internal.BufferClass;
    this._trackTask = internal.trackTask;
    this._diagnostics = internal.diagnostics;
    this._reusePort = Boolean(internal.reusePort);
    this._ipv6Only = Boolean(internal.ipv6Only);
    this._cluster = internal.cluster;
    this._clusterGroupId = internal.clusterGroupId;
    this._onListening = internal.onListening;
    this._processOwner = internal.processOwner || globalThis.process;
    this._runInProcessContext = internal.runInProcessContext;
    this._sendBlockList = internal.sendBlockList;
    this._receiveBlockList = internal.receiveBlockList;
    this._bound = false;
    this._binding = false;
    this._connecting = false;
    this._closed = false;
    this._connected = false;
    this._remoteAddress = null;
    this._refed = true;
    this.boundPort = null;
    this.boundAddress = null;
    this._taskRelease = null;
    this._sendResources = new Set();
    this._pendingSends = new Set();
    this._sendQueueCount = 0;
    this._sendQueueSize = 0;
    // A UDP socket is an async resource whose callbacks inherit the context
    // in which the socket was created, including an active AsyncLocalStorage.
    const createReceiveResource = () => new AsyncResource('UDPWRAP');
    this._receiveResource = typeof this._runInProcessContext === 'function'
      ? this._runInProcessContext(this._processOwner, createReceiveResource)
      : createReceiveResource();
    const state = this[VIRTUAL_DGRAM_STATE] = {
      handle: {
        fd: nextVirtualDescriptor++,
        lookup: (address, callback) => this._dns.lookup(
          address,
          { family: this.type === 'udp6' ? 6 : 4 },
          callback,
        ),
      },
      receiving: false,
      bindState: BIND_STATE_UNBOUND,
      queue: undefined,
      closeQueued: false,
      reuseAddr: internal.reuseAddr,
      fdClusterGroupId: undefined,
      recvBufferSize: internal.recvBufferSize === undefined
        ? 0
        : validateBufferSize(internal.recvBufferSize),
      sendBufferSize: internal.sendBufferSize === undefined
        ? 0
        : validateBufferSize(internal.sendBufferSize),
      broadcast: 0,
      ttl: 64,
      multicastTTL: 1,
      multicastLoopback: 1,
      multicastInterface: undefined,
      memberships: new Map(),
      sourceMemberships: new Map(),
      refed: true,
    };
    state.handle[DGRAM_OWNER] = this;
    Object.defineProperty(state.handle, 'owner', {
      configurable: true,
      enumerable: false,
      get() { return state.handle[DGRAM_OWNER]; },
      set(value) { state.handle[DGRAM_OWNER] = value; },
    });
    state.handle.recvStart = () => {
      state.receiving = true;
      return 0;
    };
    state.handle.recvStop = () => {
      state.receiving = false;
      return 0;
    };
    state.handle.connect = (address, port) => {
      if (this._closed || !this._bound) return UV_EINVAL;
      state.remoteAddress = {
        address: normalizeVirtualAddress(address, this.type === 'udp6' ? 6 : 4),
        port: validatePort(port),
      };
      return 0;
    };
    state.handle.disconnect = () => {
      state.remoteAddress = null;
      return 0;
    };
    state.handle.getpeername = (address) => {
      if (!state.remoteAddress) return UV_EINVAL;
      if (address) Object.assign(address, {
        ...state.remoteAddress,
        family: this.type === 'udp6' ? 'IPv6' : 'IPv4',
      });
      return 0;
    };
    state.handle.getsockname = (address) => {
      if (!this._bound) return UV_EINVAL;
      if (address) Object.assign(address, {
        address: this.boundAddress,
        port: this.boundPort,
        family: this.type === 'udp6' ? 'IPv6' : 'IPv4',
      });
      return 0;
    };
    state.handle.getSendQueueCount = () => this._sendQueueCount;
    state.handle.getSendQueueSize = () => this._sendQueueSize;
    state.handle.setBroadcast = (value) => {
      state.broadcast = value ? 1 : 0;
      return 0;
    };
    state.handle.setTTL = (value) => virtualTTL(state, value);
    state.handle.setMulticastTTL = (value) => {
      state.multicastTTL = value;
      return 0;
    };
    state.handle.setMulticastLoopback = (value) => {
      state.multicastLoopback = value ? 1 : 0;
      return 0;
    };
    state.handle.setMulticastInterface = (value) => {
      state.multicastInterface = value;
      return 0;
    };
    state.handle.addMembership = (multicastAddress, interfaceAddress) => {
      state.memberships.set(`${multicastAddress}\u0000${interfaceAddress ?? ''}`, {
        multicastAddress,
        interfaceAddress,
      });
      return 0;
    };
    state.handle.dropMembership = (multicastAddress, interfaceAddress) => {
      const key = `${multicastAddress}\u0000${interfaceAddress ?? ''}`;
      if (!state.memberships.delete(key)) return UV_EADDRNOTAVAIL;
      return 0;
    };
    state.handle.addSourceSpecificMembership = (sourceAddress, groupAddress, interfaceAddress) => {
      state.sourceMemberships.set(`${sourceAddress}\u0000${groupAddress}\u0000${interfaceAddress ?? ''}`, {
        sourceAddress,
        groupAddress,
        interfaceAddress,
      });
      return 0;
    };
    state.handle.dropSourceSpecificMembership = (sourceAddress, groupAddress, interfaceAddress) => {
      state.sourceMemberships.delete(`${sourceAddress}\u0000${groupAddress}\u0000${interfaceAddress ?? ''}`);
      return 0;
    };
    state.handle.bufferSize = (size, receive) => virtualBufferSize(state, size, receive, this._bound);
    state.handle.ref = () => {
      state.refed = true;
      this._refed = true;
      if (this._bound && !this._taskRelease) this._taskRelease = this._trackTask?.() || null;
      return state.handle;
    };
    state.handle.unref = () => {
      state.refed = false;
      this._refed = false;
      this._taskRelease?.();
      this._taskRelease = null;
      return state.handle;
    };
    state.handle.hasRef = () => state.refed;
    const diagnostics = typeof this._diagnostics === 'function' ? this._diagnostics() : this._diagnostics;
    const channel = diagnostics?.channel?.('udp.socket');
    if (channel?.hasSubscribers) channel.publish({ socket: this });
    if (typeof listener === 'function') this.on('message', listener);
  }

  on(name, listener) {
    return super.on(name, listener);
  }

  off(name, listener) {
    return super.off(name, listener);
  }

  emit(name, ...args) {
    return super.emit(name, ...args);
  }

  eventNames() {
    return super.eventNames();
  }

  getMaxListeners() {
    return super.getMaxListeners();
  }

  listenerCount(name) {
    return super.listenerCount(name);
  }

  listeners(name) {
    return super.listeners(name);
  }

  once(name, listener) {
    return super.once(name, listener);
  }

  prependListener(name, listener) {
    return super.prependListener(name, listener);
  }

  prependOnceListener(name, listener) {
    return super.prependOnceListener(name, listener);
  }

  rawListeners(name) {
    return super.rawListeners(name);
  }

  removeAllListeners(name) {
    return super.removeAllListeners(name);
  }

  removeListener(name, listener) {
    return super.removeListener(name, listener);
  }

  bind(port_, address_, callback_) {
    healthCheck(this);
    const state = this[VIRTUAL_DGRAM_STATE];
    if (state.bindState !== BIND_STATE_UNBOUND) {
      throw socketError('ERR_SOCKET_ALREADY_BOUND', 'Socket is already bound');
    }
    let options = {};
    let port = port_;
    let address = address_;
    let callback = callback_;
    if (port_ && typeof port_ === 'object') {
      options = { ...port_ };
      port = options.port ?? 0;
      address = options.address;
      callback = address_;
      if (Object.hasOwn(options, 'reuseAddr')) state.reuseAddr = options.reuseAddr;
      if (Object.hasOwn(options, 'reusePort')) this._reusePort = Boolean(options.reusePort);
      if (Object.hasOwn(options, 'ipv6Only')) this._ipv6Only = Boolean(options.ipv6Only);
      if (options.fd !== undefined) {
        const fd = Number(options.fd);
        const descriptors = globalThis.__BNH_VIRTUAL_FD_TYPES__;
        const descriptorType = descriptors?.get(fd);
        const fdGroupId = `browser-udp-fd-${fd}`;
        const sharedBinding = this._network.getClusterUdpBinding?.(fdGroupId);
        if (descriptorType !== 'udp' && !sharedBinding) {
          const error = new Error(descriptorType === 'tcp' ? 'Unsupported fd type: TCP' : 'open EEXIST');
          error.code = descriptorType === 'tcp' ? 'ERR_INVALID_FD_TYPE' : 'EEXIST';
          error.name = descriptorType === 'tcp' ? 'TypeError' : 'Error';
          throw error;
        }
        const descriptor = globalThis.__BNH_VIRTUAL_UDP_HANDLES__?.get(fd);
        if (!descriptor?.bound && !sharedBinding) throw socketError('EEXIST', 'open EEXIST');
        address = descriptor?.address ?? sharedBinding.address;
        port = descriptor?.port ?? sharedBinding.port;
        state.fdClusterGroupId = fdGroupId;
      }
    }
    if (typeof port === 'function') {
      callback = port;
      port = 0;
    }
    if (typeof address === 'function') {
      callback = address;
      address = undefined;
    }
    if (typeof callback !== 'function') callback = undefined;
    const family = this.type === 'udp6' ? 6 : 4;
    let normalizedAddress = normalizeVirtualAddress(address || (family === 6 ? '::' : '0.0.0.0'), family);
    const requestedPort = validatePort(port ?? 0);
    this._binding = true;
    state.bindState = BIND_STATE_BINDING;
    this._taskRelease = this._refed ? this._trackTask?.() || null : null;
    const completeBind = (lookupError, resolvedAddress, resolvedFamily) => {
      if (this._closed) return;
      if (lookupError) {
        this._taskRelease?.();
        this._taskRelease = null;
        this._binding = false;
        this[VIRTUAL_DGRAM_STATE].bindState = BIND_STATE_UNBOUND;
        this.emit('error', lookupError);
        return;
      }
      normalizedAddress = normalizeVirtualAddress(
        resolvedAddress || normalizedAddress,
        resolvedFamily || family,
      );
      try {
        const cluster = typeof this._cluster === 'function' ? this._cluster() : this._cluster;
        const groupId = this._clusterGroupId || cluster?.worker?.process?.ppid;
        const useClusterBinding = state.fdClusterGroupId !== undefined
          || ((cluster?.isWorker || this._clusterGroupId !== undefined)
            && typeof this._network.bindClusterUdp === 'function');
        const result = useClusterBinding
          ? this._network.bindClusterUdp(state.fdClusterGroupId ?? groupId, normalizedAddress, requestedPort, {
              reuseAddr: state.reuseAddr,
              reusePort: this._reusePort,
              ipv6Only: this._ipv6Only,
              socket: this,
            })
          : this._network.bindUdp(this, normalizedAddress, requestedPort, {
              reuseAddr: state.reuseAddr,
              reusePort: this._reusePort,
              ipv6Only: this._ipv6Only,
              processOwner: this._processOwner,
            });
        this.boundPort = result.port;
        this.boundAddress = result.address;
        if (!this._taskRelease && this._refed) this._taskRelease = this._trackTask?.() || null;
        this._binding = false;
        this._bound = true;
        state.bindState = BIND_STATE_BOUND;
        state.handle.recvStart?.();
        this.emit('listening');
        this._onListening?.(this.address());
        callback?.call(this);
      } catch (error) {
        this._taskRelease?.();
        this._taskRelease = null;
        this._binding = false;
        this[VIRTUAL_DGRAM_STATE].bindState = BIND_STATE_UNBOUND;
        this.emit('error', error);
      }
    };
    // A literal address is already resolved. Complete this virtual bind now
    // so a child fork queued earlier cannot run and synchronously answer the
    // first IPC message before the parent has installed its message listener.
    // Hostname binds retain the normal asynchronous lookup path.
    if (address_ !== undefined && virtualAddressFamily(normalizedAddress) === family) {
      queueMicrotask(() => completeBind(null, normalizedAddress, family));
    } else {
      queueMicrotask(() => {
        if (this._closed) return;
        const handle = this[VIRTUAL_DGRAM_STATE].handle;
        handle.lookup.call(handle, normalizedAddress, completeBind);
      });
    }
    return this;
  }

  address() {
    healthCheck(this);
    const result = {};
    const error = this[VIRTUAL_DGRAM_STATE].handle.getsockname(result);
    if (error) throw handleError(error, 'getsockname');
    return result;
  }

  send(message, ...args) {
    healthCheck(this);
    let offset = 0;
    let length;
    let port;
    let address;
    let callback;
    const connected = this._connected;
    if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const options = args.shift();
      offset = options.offset || 0;
      length = options.length;
      port = options.port;
      address = options.address;
      callback = options.callback;
      if (typeof args[0] === 'function') callback = args.shift();
    } else if (typeof args[0] === 'number' && typeof args[1] === 'number'
      && (!connected || typeof args[2] === 'function' || args[2] === undefined)) {
      offset = args.shift();
      length = args.shift();
      if (connected) {
        callback = args.shift();
        port = args.shift();
        address = args.shift();
      } else {
        port = args.shift();
        address = args.shift();
        callback = args.shift();
      }
    } else {
      if (connected) {
        callback = args.shift();
        port = args.shift();
        address = args.shift();
      } else {
        port = args.shift();
        if (typeof args[0] === 'function') callback = args.shift();
        else {
          address = args.shift();
          callback = args.shift();
        }
      }
    }
    if (typeof port === 'function') {
      callback = port;
      port = undefined;
    }
    if (typeof address === 'function') {
      callback = address;
      address = undefined;
    }
    if (connected && (port !== undefined || address !== undefined)) {
      throw socketError('ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected');
    }
    address = address ?? this._remoteAddress?.address ?? (this.type === 'udp6' ? virtualNetworkConstants.LOOPBACK_V6 : virtualNetworkConstants.LOOPBACK_V4);
    if (address === '') address = this.type === 'udp6' ? virtualNetworkConstants.LOOPBACK_V6 : virtualNetworkConstants.LOOPBACK_V4;
    if (typeof address !== 'string') {
      const received = address === null || address === undefined
        ? String(address)
        : typeof address === 'object'
          ? `an instance of ${address.constructor?.name || 'Object'}`
          : `type ${typeof address} (${String(address)})`;
      const error = new TypeError(`The "address" argument must be of type string. Received ${received}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    const callbackProvided = typeof callback === 'function';
    if (typeof callback !== 'function') callback = () => {};
    const bytes = asBytes(message, offset, length);
    port = port ?? this._remoteAddress?.port;
    if (port === undefined) {
      throw socketError('ERR_SOCKET_BAD_PORT', 'Port should be specified');
    }
    port = validatePort(port, false);
    const sendState = {
      bytes: bytes.byteLength,
      resource: null,
      finished: false,
    };
    this._pendingSends.add(sendState);
    this._sendQueueCount += 1;
    this._sendQueueSize += bytes.byteLength;
    const releaseSend = () => {
      if (sendState.finished) return false;
      sendState.finished = true;
      this._pendingSends.delete(sendState);
      this._sendQueueCount = Math.max(0, this._sendQueueCount - 1);
      this._sendQueueSize = Math.max(0, this._sendQueueSize - sendState.bytes);
      return true;
    };
    sendState.release = releaseSend;
    const transmit = (defer = true) => {
      const run = () => {
        if (this._closed || !this[VIRTUAL_DGRAM_STATE].handle) {
          releaseSend();
          return;
        }
        const family = this.type === 'udp6' ? 'ipv6' : 'ipv4';
        if (this._sendBlockList?.check?.(address, family)) {
          const error = networkError('ERR_IP_BLOCKED', 'send', address, port);
          if (callbackProvided) callback(error);
          else this.emit('error', error);
          releaseSend();
          return;
        }
        const resource = new AsyncResource('UDPSENDWRAP');
        sendState.resource = resource;
        this._sendResources.add(resource);
        const runCallback = (...callbackArgs) => {
          if (!releaseSend()) return undefined;
          return resource.runInAsyncScope(callback, this, ...callbackArgs);
        };
        const handleSend = this[VIRTUAL_DGRAM_STATE].handle.send;
        if (typeof handleSend === 'function') {
          let result;
          try {
            result = handleSend.call(this[VIRTUAL_DGRAM_STATE].handle, bytes, port, address);
          } catch (error) {
            if (!callbackProvided) this.emit('error', error);
            runCallback(error);
            return;
          }
          if (result !== undefined && result !== 0) {
            const error = networkError('UNKNOWN', 'send', address, port);
            error.errno = -4094;
            if (!callbackProvided) this.emit('error', error);
            runCallback(error);
            return;
          }
        }
        this._network.sendUdp({
          source: this,
          address,
          port,
          bytes,
          onDelivered: (size) => runCallback(null, size),
          onError: (error) => {
            if (!callbackProvided) this.emit('error', error);
            runCallback(error);
          },
        });
      };
      if (defer) queueMicrotask(run);
      else run();
    };
    const sendAfterBinding = () => {
      if (!this._bound) {
        if (!this._binding) this.bind(0, this.type === 'udp6' ? '::' : '0.0.0.0');
        if (this._bound) transmit();
        else enqueue(this, () => transmit(false));
      } else {
        transmit();
      }
    };
    if (virtualAddressFamily(address) === 0) {
      const lookup = this[VIRTUAL_DGRAM_STATE].handle.lookup;
      lookup.call(this[VIRTUAL_DGRAM_STATE].handle, address, (error, resolvedAddress, resolvedFamily) => {
        if (this._closed || !this[VIRTUAL_DGRAM_STATE].handle) return;
        if (error) {
          if (callbackProvided) callback(error);
          else this.emit('error', error);
          releaseSend();
          return;
        }
        address = normalizeVirtualAddress(resolvedAddress, resolvedFamily || (this.type === 'udp6' ? 6 : 4));
        sendAfterBinding();
      });
      return undefined;
    }
    address = normalizeVirtualAddress(address, this.type === 'udp6' ? 6 : 4);
    sendAfterBinding();
    return undefined;
  }

  sendto(buffer, offset, length, port, address, callback) {
    if (typeof offset !== 'number') throw invalidArgumentType('offset', 'number', offset);
    if (typeof length !== 'number') throw invalidArgumentType('length', 'number', length);
    if (typeof port !== 'number') throw invalidArgumentType('port', 'number', port);
    if (typeof address !== 'string') throw invalidArgumentType('address', 'string', address);
    this.send(buffer, offset, length, port, address, callback);
  }

  setMaxListeners(value) {
    return super.setMaxListeners(value);
  }

  connect(port, address, callback) {
    healthCheck(this);
    const family = this.type === 'udp6' ? 6 : 4;
    const requestedPort = validatePort(port);
    if (requestedPort === 0) {
      const error = new RangeError('Port should be > 0 and < 65536');
      error.code = 'ERR_SOCKET_BAD_PORT';
      throw error;
    }
    if (this._connected || this._connecting) throw socketError('ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected');
    if (typeof address === 'function') {
      callback = address;
      address = undefined;
    }
    const requestedAddress = address === undefined || address === ''
      ? (family === 6 ? '::1' : '127.0.0.1')
      : address;
    if (typeof requestedAddress !== 'string') {
      throw invalidArgumentType('address', 'string', requestedAddress);
    }
    this._connecting = true;
    const finish = (error, resolvedAddress = requestedAddress, resolvedFamily = family) => {
      if (this._closed || !this[VIRTUAL_DGRAM_STATE].handle) return;
      if (error) {
        this._connecting = false;
        if (callback) callback.call(this, error);
        else queueMicrotask(() => this.emit('error', error));
        return;
      }
      if (this._sendBlockList?.check?.(resolvedAddress, resolvedFamily === 6 ? 'ipv6' : 'ipv4')) {
        const blocked = networkError('ERR_IP_BLOCKED', 'connect', resolvedAddress, requestedPort);
        this._connecting = false;
        if (callback) callback.call(this, blocked);
        else queueMicrotask(() => this.emit('error', blocked));
        return;
      }
      const remote = {
        port: requestedPort,
        address: normalizeVirtualAddress(resolvedAddress, resolvedFamily),
      };
      const complete = (bindError) => {
        if (this._closed || !this[VIRTUAL_DGRAM_STATE].handle) return;
        if (bindError) {
          finish(bindError);
          return;
        }
        const connectError = this[VIRTUAL_DGRAM_STATE].handle.connect(remote.address, remote.port);
        if (connectError) {
          finish(networkError('UNKNOWN', 'connect', requestedAddress, requestedPort));
          return;
        }
        this._remoteAddress = remote;
        this._connecting = false;
        this._connected = true;
        this.emit('connect');
        callback?.call(this);
      };
      if (this._bound) queueMicrotask(complete);
      else this.bind(0, family === 6 ? '::' : '0.0.0.0', complete);
    };
    if (virtualNetworkConstants.LOOPBACK_V4 === requestedAddress
      || virtualNetworkConstants.LOOPBACK_V6 === requestedAddress
      || requestedAddress === '0.0.0.0' || requestedAddress === '::') {
      finish(null);
    } else {
      this._dns.lookup(requestedAddress, { family, all: false }, finish);
    }
    return undefined;
  }

  disconnect() {
    healthCheck(this);
    if (!this._connected) throw socketError('ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected');
    const error = this[VIRTUAL_DGRAM_STATE].handle.disconnect?.() || 0;
    if (error) throw networkError('UNKNOWN', 'connect', this._remoteAddress.address, this._remoteAddress.port);
    this._remoteAddress = null;
    this._connected = false;
  }

  close(callback) {
    if (typeof callback === 'function') this.once('close', callback);
    const state = this[VIRTUAL_DGRAM_STATE];
    if (state.queue !== undefined && !state.closeQueued) {
      state.closeQueued = true;
      state.queue.push(() => {
        state.closeQueued = false;
        this.close();
      });
      return this;
    }
    if (state.closeQueued) return this;
    if (this._closed) return this;
    healthCheck(this);
    this._closed = true;
    this._binding = false;
    if (this._bound) this._network.unbindUdp(this);
    stopReceiving(this);
    this._taskRelease?.();
    this._taskRelease = null;
    this._processOwner?._bnhTryExit?.();
    this._bound = false;
    this[VIRTUAL_DGRAM_STATE].bindState = BIND_STATE_UNBOUND;
    this[VIRTUAL_DGRAM_STATE].closeQueued = false;
    this[VIRTUAL_DGRAM_STATE].queue = undefined;
    for (const sendState of this._pendingSends) {
      sendState.release?.();
    }
    this[VIRTUAL_DGRAM_STATE].handle = null;
    this.boundPort = null;
    this.boundAddress = null;
    queueMicrotask(() => {
      this.emit('close');
      queueMicrotask(() => {
        for (const resource of this._sendResources) resource.emitDestroy();
        this._sendResources.clear();
        this._receiveResource.emitDestroy();
      });
    });
    return this;
  }

  _networkClosed() {
    if (this._closed) return;
    this._closed = true;
    this._binding = false;
    this._bound = false;
    this[VIRTUAL_DGRAM_STATE].bindState = BIND_STATE_UNBOUND;
    this.boundPort = null;
    this.boundAddress = null;
    stopReceiving(this);
    this._taskRelease?.();
    this._taskRelease = null;
    queueMicrotask(() => this.emit('close'));
  }

  async [SymbolNodeAsyncDispose]() {
    if (!this[VIRTUAL_DGRAM_STATE].handle) return;
    await new Promise((resolve, reject) => {
      this.close((error) => error ? reject(error) : resolve());
    });
  }

  remoteAddress() {
    healthCheck(this);
    if (!this._connected) throw socketError('ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected');
    return {
      address: this._remoteAddress.address,
      port: this._remoteAddress.port,
      family: this.type === 'udp6' ? 'IPv6' : 'IPv4',
    };
  }

  _receiveDatagram(bytes, rinfo) {
    if (this._closed || !this[VIRTUAL_DGRAM_STATE].receiving) return;
    const family = rinfo?.family === 'IPv6' ? 'ipv6' : 'ipv4';
    if (this._receiveBlockList?.check?.(rinfo?.address, family)) return;
    const deliver = () => this._receiveResource.runInAsyncScope(
      () => this.emit('message', makeNodeBytes(bytes, this._bufferClass), rinfo),
      this,
    );
    if (typeof this._runInProcessContext === 'function') this._runInProcessContext(this._processOwner, deliver);
    else deliver();
  }

  dropSourceSpecificMembership(sourceAddress, groupAddress, interfaceAddress) {
    healthCheck(this);
    if (typeof sourceAddress !== 'string') throw invalidArgumentType('sourceAddress', 'string', sourceAddress);
    if (typeof groupAddress !== 'string') throw invalidArgumentType('groupAddress', 'string', groupAddress);
    const error = this[VIRTUAL_DGRAM_STATE].handle.dropSourceSpecificMembership(
      sourceAddress,
      groupAddress,
      interfaceAddress,
    );
    if (error) throw handleError(error, 'dropSourceSpecificMembership');
  }

  getRecvBufferSize() {
    const result = this[VIRTUAL_DGRAM_STATE].handle?.bufferSize?.(0, true) ?? UV_EBADF;
    if (result < 0) throw bufferSizeError(true, result);
    return result;
  }

  getSendBufferSize() {
    const result = this[VIRTUAL_DGRAM_STATE].handle?.bufferSize?.(0, false) ?? UV_EBADF;
    if (result < 0) throw bufferSizeError(false, result);
    return result;
  }

  getSendQueueSize() {
    return this._sendQueueSize;
  }

  getSendQueueCount() { return this._sendQueueCount; }
  setRecvBufferSize(size) {
    validateBufferSize(size);
    const result = this[VIRTUAL_DGRAM_STATE].handle?.bufferSize?.(size, true) ?? UV_EBADF;
    if (result < 0) throw bufferSizeError(true, result);
  }

  setSendBufferSize(size) {
    validateBufferSize(size);
    const result = this[VIRTUAL_DGRAM_STATE].handle?.bufferSize?.(size, false) ?? UV_EBADF;
    if (result < 0) throw bufferSizeError(false, result);
  }
  setBroadcast(arg) {
    const error = this[VIRTUAL_DGRAM_STATE].handle.setBroadcast(arg ? 1 : 0);
    if (error) throw handleError(error, 'setBroadcast');
  }

  setTTL(ttl) {
    validateNumber(ttl, 'ttl');
    const error = this[VIRTUAL_DGRAM_STATE].handle.setTTL(ttl);
    if (error) throw handleError(error, 'setTTL');
    return ttl;
  }

  setMulticastTTL(ttl) {
    validateNumber(ttl, 'ttl');
    const error = this[VIRTUAL_DGRAM_STATE].handle.setMulticastTTL(ttl);
    if (error) throw handleError(error, 'setMulticastTTL');
    return ttl;
  }

  setMulticastLoopback(arg) {
    const error = this[VIRTUAL_DGRAM_STATE].handle.setMulticastLoopback(arg ? 1 : 0);
    if (error) throw handleError(error, 'setMulticastLoopback');
    return arg;
  }

  setMulticastInterface(interfaceAddress) {
    healthCheck(this);
    if (typeof interfaceAddress !== 'string') {
      throw invalidArgumentType('interfaceAddress', 'string', interfaceAddress);
    }
    const error = this[VIRTUAL_DGRAM_STATE].handle.setMulticastInterface(interfaceAddress);
    if (error) throw handleError(error, 'setMulticastInterface');
  }

  addMembership(multicastAddress, interfaceAddress) {
    healthCheck(this);
    if (!multicastAddress) throw missingArgument('multicastAddress');
    const error = this[VIRTUAL_DGRAM_STATE].handle.addMembership(
      multicastAddress,
      interfaceAddress,
    );
    if (error) throw handleError(error, 'addMembership');
  }

  dropMembership(multicastAddress, interfaceAddress) {
    healthCheck(this);
    if (!multicastAddress) throw missingArgument('multicastAddress');
    const error = this[VIRTUAL_DGRAM_STATE].handle.dropMembership(
      multicastAddress,
      interfaceAddress,
    );
    if (error) throw handleError(error, 'dropMembership');
  }

  addSourceSpecificMembership(sourceAddress, groupAddress, interfaceAddress) {
    healthCheck(this);
    if (typeof sourceAddress !== 'string') {
      throw invalidArgumentType('sourceAddress', 'string', sourceAddress);
    }
    if (typeof groupAddress !== 'string') {
      throw invalidArgumentType('groupAddress', 'string', groupAddress);
    }
    const error = this[VIRTUAL_DGRAM_STATE].handle.addSourceSpecificMembership(
      sourceAddress,
      groupAddress,
      interfaceAddress,
    );
    if (error) throw handleError(error, 'addSourceSpecificMembership');
  }
  ref() {
    this[VIRTUAL_DGRAM_STATE].handle?.ref?.();
    return this;
  }

  unref() {
    this[VIRTUAL_DGRAM_STATE].handle?.unref?.();
    return this;
  }
}

// Keep the EventEmitter alias on Socket itself as well. The native dgram
// wrapper exposes addListener as the same callable as on, and callers can
// inspect this surface directly on Socket.prototype.
Object.defineProperty(Socket.prototype, 'addListener', {
  configurable: true,
  enumerable: false,
  value: Socket.prototype.on,
  writable: true,
});

if (SymbolAsyncDispose !== SymbolNodeAsyncDispose) {
  Object.defineProperty(Socket.prototype, SymbolAsyncDispose, {
    configurable: true,
    enumerable: false,
    value: Socket.prototype[SymbolNodeAsyncDispose],
    writable: true,
  });
}

// Deprecated private APIs retained for compatibility with Node's dgram
// wrapper. The browser implementation stores the same state on its virtual
// handle instead of exposing host socket internals.
Object.defineProperty(Socket.prototype, '_handle', {
  configurable: false,
  enumerable: false,
  get: deprecatedSocketApi(
    'Socket.prototype._handle is deprecated',
    function getHandle() { return this[VIRTUAL_DGRAM_STATE]?.handle || null; },
  ),
  set: deprecatedSocketApi(
    'Socket.prototype._handle is deprecated',
    function setHandle(value) { this[VIRTUAL_DGRAM_STATE].handle = value; },
  ),
});

Object.defineProperty(Socket.prototype, '_receiving', {
  configurable: false,
  enumerable: false,
  get: deprecatedSocketApi(
    'Socket.prototype._receiving is deprecated',
    function getReceiving() { return this[VIRTUAL_DGRAM_STATE].receiving; },
  ),
  set: deprecatedSocketApi(
    'Socket.prototype._receiving is deprecated',
    function setReceiving(value) { this[VIRTUAL_DGRAM_STATE].receiving = value; },
  ),
});

Object.defineProperty(Socket.prototype, '_bindState', {
  configurable: false,
  enumerable: false,
  get: deprecatedSocketApi(
    'Socket.prototype._bindState is deprecated',
    function getBindState() { return this[VIRTUAL_DGRAM_STATE].bindState; },
  ),
    set: deprecatedSocketApi(
      'Socket.prototype._bindState is deprecated',
      function setBindState(value) {
        this[VIRTUAL_DGRAM_STATE].bindState = value;
      },
    ),
});

Object.defineProperty(Socket.prototype, '_queue', {
  configurable: false,
  enumerable: false,
  get: deprecatedSocketApi(
    'Socket.prototype._queue is deprecated',
    function getQueue() { return this[VIRTUAL_DGRAM_STATE].queue; },
  ),
  set: deprecatedSocketApi(
    'Socket.prototype._queue is deprecated',
    function setQueue(value) { this[VIRTUAL_DGRAM_STATE].queue = value; },
  ),
});

Object.defineProperty(Socket.prototype, '_reuseAddr', {
  configurable: false,
  enumerable: false,
  get: deprecatedSocketApi(
    'Socket.prototype._reuseAddr is deprecated',
    function getReuseAddr() { return this[VIRTUAL_DGRAM_STATE].reuseAddr; },
  ),
  set: deprecatedSocketApi(
    'Socket.prototype._reuseAddr is deprecated',
    function setReuseAddr(value) { this[VIRTUAL_DGRAM_STATE].reuseAddr = value; },
  ),
});

Socket.prototype._healthCheck = deprecatedSocketApi(
  'Socket.prototype._healthCheck() is deprecated',
  function _healthCheck() { healthCheck(this); },
);

Socket.prototype._stopReceiving = deprecatedSocketApi(
  'Socket.prototype._stopReceiving() is deprecated',
  function _stopReceiving() { stopReceiving(this); },
);

export function createBrowserDgram({ network = sharedVirtualNetwork, transport, dns = createBrowserDns(), BufferClass, trackTask, diagnostics, cluster, clusterGroupId, onListening, runInProcessContext, processOwner } = {}) {
  const configuredNetwork = transport && network === sharedVirtualNetwork ? createVirtualNetwork({ transport }) : network;
  const sockets = new Set();
  const closeProcessSockets = () => {
    for (const socket of [...sockets]) {
      if (!socket._closed) socket.close();
    }
    sockets.clear();
  };
  closeProcessSockets._bnhInternal = true;
  const unbindProcess = () => configuredNetwork.unbindProcess?.(processOwner);
  unbindProcess._bnhInternal = true;
  processOwner?.once?.('disconnect', closeProcessSockets);
  processOwner?.once?.('exit', closeProcessSockets);
  processOwner?.once?.('disconnect', unbindProcess);
  processOwner?.once?.('exit', unbindProcess);
  const createHandle = (address, port, addressType, fd, flags) => createSocketHandle(
    address,
    port,
    addressType,
    fd,
    flags,
    { dns, network: configuredNetwork, BufferClass, cluster, clusterGroupId, trackTask },
  );
  const SocketWithDefaults = class BrowserDgramSocket extends Socket {
    constructor(type, listener) {
      super(type, listener, {
        network: configuredNetwork,
        dns,
        BufferClass,
        trackTask,
        diagnostics,
        cluster,
        clusterGroupId,
        onListening,
        runInProcessContext,
        processOwner,
      });
    }
  };
  return {
    createSocket: function createSocket(type, listener) {
      const socket = new SocketWithDefaults(type, listener);
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      return socket;
    },
    Socket: SocketWithDefaults,
    constants: UDP_CONSTANTS,
    _createSocketHandle: createHandle,
    newHandle: (type, lookup) => createDgramHandle(type, {
      dns,
      network: configuredNetwork,
      lookup,
      BufferClass,
      cluster,
      clusterGroupId,
      trackTask,
    }),
  };
}

export const constants = UDP_CONSTANTS;

export function _createSocketHandle(address, port, addressType, fd, flags) {
  return createSocketHandle(address, port, addressType, fd, flags, {
    dns: createBrowserDns(),
    network: sharedVirtualNetwork,
    BufferClass: undefined,
  });
}

export function newHandle(type, lookup) {
  return createDgramHandle(type, {
    dns: createBrowserDns(),
    network: sharedVirtualNetwork,
    BufferClass: undefined,
    lookup,
  });
}

export function createSocket(type, listener) {
  return new Socket(type, listener);
}

export default { createSocket, Socket, constants, _createSocketHandle, newHandle };
