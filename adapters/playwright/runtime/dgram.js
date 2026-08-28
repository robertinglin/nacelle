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
  IPV6_ONLY: 27,
});

const VIRTUAL_DGRAM_STATE = Symbol.for('bnh.dgram.state');
const BIND_STATE_UNBOUND = 0;
const BIND_STATE_BINDING = 1;
const BIND_STATE_BOUND = 2;
const UV_EINVAL = -22;
const UV_EADDRINUSE = -98;
let nextVirtualDescriptor = 1000;

function invalidArgumentType(name, expected, value) {
  const received = value === null ? 'null' : value === undefined ? 'undefined' : `type ${typeof value}`;
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function bufferOutOfBounds(name) {
  const error = new RangeError(`The ${name} is outside the bounds of the buffer`);
  error.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
  return error;
}

function asBytes(value, offset = 0, length = undefined) {
  let bytes;
  if (typeof value === 'string') bytes = new TextEncoder().encode(value);
  else if (Array.isArray(value)) {
    const parts = value.map((part) => asBytes(part));
    bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let cursor = 0;
    for (const part of parts) {
      bytes.set(part, cursor);
      cursor += part.byteLength;
    }
  }
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw invalidArgumentType('buffer', 'Buffer, TypedArray, DataView, or string', value);
  if (!Number.isInteger(offset) || offset < 0) throw bufferOutOfBounds('offset');
  if (offset > bytes.byteLength) throw bufferOutOfBounds('offset');
  if (length === undefined) length = bytes.byteLength - offset;
  if (!Number.isInteger(length) || length < 0) throw bufferOutOfBounds('length');
  if (offset + length > bytes.byteLength) throw bufferOutOfBounds('length');
  return bytes.slice(offset, offset + length);
}

function validatePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new RangeError(`port must be an integer between 0 and 65535: ${port}`);
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

function createDgramHandle(type, { dns, network, lookup } = {}) {
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
        const binding = network?.bindUdp?.(handle, normalizedAddress, validatePort(port), {
          reuseAddr: (Number(flags) & UDP_CONSTANTS.UV_UDP_REUSEADDR) !== 0,
          ipv6Only: false,
        });
        if (!binding) return UV_EINVAL;
        state.address = binding.address;
        state.family = family === 6 ? 'IPv6' : 'IPv4';
        state.port = binding.port;
        state.bound = true;
        state.owner = handle;
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
    recvStart() { return state.closed ? UV_EINVAL : 0; },
    recvStop() { return 0; },
    getSendQueueCount() { return 0; },
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
    send(request) {
      request?._bnhInitialize?.();
      queueMicrotask(() => request?.oncomplete?.(0));
      return 0;
    },
    close(callback) {
      if (state.closed) return 0;
      if (state.bound && state.owner === handle) network?.unbindUdp?.(handle);
      state.bound = false;
      state.closed = true;
      descriptors?.delete(handle.fd);
      udpHandles?.delete(handle.fd);
      callback?.();
      return 0;
    },
  };
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
  return handle;
}

/** Browser-native UDP socket backed by the shared virtual socket registry. */
export class Socket extends EventEmitter {
  constructor(type = 'udp4', listener, internal = {}) {
    super();
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
    this._sendQueueCount = 0;
    // A UDP socket is an async resource whose callbacks inherit the context
    // in which the socket was created, including an active AsyncLocalStorage.
    this._receiveResource = new AsyncResource('UDPWRAP');
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
      reuseAddr: Boolean(internal.reuseAddr),
    };
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
    state.handle.getSendQueueCount = () => this._sendQueueCount;
    const diagnostics = typeof this._diagnostics === 'function' ? this._diagnostics() : this._diagnostics;
    const channel = diagnostics?.channel?.('udp.socket');
    if (channel?.hasSubscribers) channel.publish({ socket: this });
    if (typeof listener === 'function') this.on('message', listener);
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
      state.reuseAddr = Boolean(options.reuseAddr);
      this._reusePort = Boolean(options.reusePort);
      this._ipv6Only = Boolean(options.ipv6Only);
      if (options.fd !== undefined) {
        const descriptors = globalThis.__BNH_VIRTUAL_FD_TYPES__;
        const descriptorType = descriptors?.get(Number(options.fd));
        if (descriptorType !== 'udp') {
          const error = new Error(descriptorType === 'tcp' ? 'Unsupported fd type: TCP' : 'open EEXIST');
          error.code = descriptorType === 'tcp' ? 'ERR_INVALID_FD_TYPE' : 'EEXIST';
          error.name = descriptorType === 'tcp' ? 'TypeError' : 'Error';
          throw error;
        }
        const descriptor = globalThis.__BNH_VIRTUAL_UDP_HANDLES__?.get(Number(options.fd));
        if (!descriptor?.bound) throw socketError('EEXIST', 'open EEXIST');
        address = descriptor.address;
        port = descriptor.port;
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
    queueMicrotask(() => {
      if (this._closed) return;
      const handle = this[VIRTUAL_DGRAM_STATE].handle;
      handle.lookup.call(handle, normalizedAddress, (lookupError, resolvedAddress, resolvedFamily) => {
        if (this._closed) return;
        if (lookupError) {
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
          const useClusterBinding = (cluster?.isWorker || this._clusterGroupId !== undefined)
            && typeof this._network.bindClusterUdp === 'function';
          const result = useClusterBinding
            ? this._network.bindClusterUdp(groupId, normalizedAddress, requestedPort, {
                reuseAddr: state.reuseAddr,
                reusePort: this._reusePort,
                ipv6Only: this._ipv6Only,
                socket: this,
              })
            : this._network.bindUdp(this, normalizedAddress, requestedPort, {
                reuseAddr: state.reuseAddr,
                reusePort: this._reusePort,
                ipv6Only: this._ipv6Only,
              });
          this.boundPort = result.port;
          this.boundAddress = result.address;
          this._taskRelease = this._refed ? this._trackTask?.() || null : null;
          this._binding = false;
          this._bound = true;
          state.bindState = BIND_STATE_BOUND;
          state.handle.recvStart?.();
          this.emit('listening');
          this._onListening?.(this.address());
          callback?.call(this);
        } catch (error) {
          this._binding = false;
          this[VIRTUAL_DGRAM_STATE].bindState = BIND_STATE_UNBOUND;
          this.emit('error', error);
        }
      });
    });
    return this;
  }

  address() {
    healthCheck(this);
    if (!this._bound) throw socketError('EBADF', 'getsockname EBADF');
    return {
      address: this.boundAddress,
      port: this.boundPort,
      family: this.type === 'udp6' ? 'IPv6' : 'IPv4',
    };
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
    port = validatePort(port);
    const transmit = (defer = true) => {
      const run = () => {
        if (this._closed || !this[VIRTUAL_DGRAM_STATE].handle) return;
        const family = this.type === 'udp6' ? 'ipv6' : 'ipv4';
        if (this._sendBlockList?.check?.(address, family)) {
          const error = networkError('ERR_IP_BLOCKED', 'send', address, port);
          if (callbackProvided) callback(error);
          else this.emit('error', error);
          return;
        }
        const resource = new AsyncResource('UDPSENDWRAP');
        this._sendResources.add(resource);
        this._sendQueueCount += 1;
        let callbackFinished = false;
        const runCallback = (...callbackArgs) => {
          if (!callbackFinished) {
            callbackFinished = true;
            this._sendQueueCount = Math.max(0, this._sendQueueCount - 1);
          }
          return resource.runInAsyncScope(callback, this, ...callbackArgs);
        };
        const handleSend = this[VIRTUAL_DGRAM_STATE].handle.send;
        if (typeof handleSend === 'function') {
          let result;
          try {
            result = handleSend.call(this[VIRTUAL_DGRAM_STATE].handle, bytes, port, address);
          } catch (error) {
            this.emit('error', error);
            runCallback(error);
            return;
          }
          if (result !== undefined && result !== 0) {
            const error = networkError('UNKNOWN', 'send', address, port);
            error.errno = -4094;
            this.emit('error', error);
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
            this.emit('error', error);
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
    return this.send(buffer, offset, length, port, address, callback);
  }

  connect(port, address, callback) {
    healthCheck(this);
    if (this._connected || this._connecting) throw socketError('ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected');
    if (typeof address === 'function') {
      callback = address;
      address = undefined;
    }
    const family = this.type === 'udp6' ? 6 : 4;
    const requestedPort = validatePort(port);
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
    healthCheck(this);
    if (this._closed) return this;
    this._closed = true;
    this._binding = false;
    if (this._bound) this._network.unbindUdp(this);
    stopReceiving(this);
    this._taskRelease?.();
    this._taskRelease = null;
    this._bound = false;
    this[VIRTUAL_DGRAM_STATE].bindState = BIND_STATE_UNBOUND;
    this[VIRTUAL_DGRAM_STATE].closeQueued = false;
    this[VIRTUAL_DGRAM_STATE].queue = undefined;
    this._sendQueueCount = 0;
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
    this._receiveResource.runInAsyncScope(
      () => this.emit('message', makeNodeBytes(bytes, this._bufferClass), rinfo),
      this,
    );
  }

  getRecvBufferSize() { return 0; }
  getSendBufferSize() { return 0; }
  getSendQueueCount() { return this[VIRTUAL_DGRAM_STATE].handle.getSendQueueCount(); }
  setRecvBufferSize() { return this; }
  setSendBufferSize() { return this; }
  setBroadcast() { return this; }
  setTTL() { return this; }
  setMulticastTTL() { return this; }
  setMulticastLoopback() { return this; }
  addMembership() { return this; }
  dropMembership() { return this; }
  ref() {
    this._refed = true;
    if (this._bound && !this._taskRelease) this._taskRelease = this._trackTask?.() || null;
    return this;
  }

  unref() {
    this._refed = false;
    this._taskRelease?.();
    this._taskRelease = null;
    return this;
  }
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
      this._binding = value === BIND_STATE_BINDING;
      this._bound = value === BIND_STATE_BOUND;
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

export function createBrowserDgram({ network = sharedVirtualNetwork, transport, dns = createBrowserDns(), BufferClass, trackTask, diagnostics, cluster, clusterGroupId, onListening } = {}) {
  const configuredNetwork = transport && network === sharedVirtualNetwork ? createVirtualNetwork({ transport }) : network;
  const createHandle = (address, port, addressType, fd, flags) => createSocketHandle(
    address,
    port,
    addressType,
    fd,
    flags,
    { dns, network: configuredNetwork },
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
      });
    }
  };
  return {
    createSocket: function createSocket(type, listener) { return new SocketWithDefaults(type, listener); },
    Socket: SocketWithDefaults,
    constants: UDP_CONSTANTS,
    _createSocketHandle: createHandle,
    newHandle: (type, lookup) => createDgramHandle(type, { dns, network: configuredNetwork, lookup }),
  };
}

export const constants = UDP_CONSTANTS;

export function _createSocketHandle(address, port, addressType, fd, flags) {
  return createSocketHandle(address, port, addressType, fd, flags, {
    dns: createBrowserDns(),
    network: sharedVirtualNetwork,
  });
}

export function newHandle(type, lookup) {
  return createDgramHandle(type, {
    dns: createBrowserDns(),
    network: sharedVirtualNetwork,
    lookup,
  });
}

export function createSocket(type, listener) {
  return new Socket(type, listener);
}

export default { createSocket, Socket, constants, _createSocketHandle, newHandle };
