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
let nextVirtualDescriptor = 1000;

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
  else if (value instanceof Uint8Array) bytes = new Uint8Array(value);
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  else throw new TypeError('message must be a string, Buffer, or Uint8Array');
  return bytes.slice(offset, length === undefined ? bytes.byteLength : offset + length);
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

function healthCheck(socket) {
  if (socket._closed) throw socketError('ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
}

function makeNodeBytes(bytes, BufferClass) {
  return typeof BufferClass?.from === 'function' ? BufferClass.from(bytes) : bytes;
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
    this._reuseAddr = Boolean(internal.reuseAddr);
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
    // A UDP socket is an async resource whose callbacks inherit the context
    // in which the socket was created, including an active AsyncLocalStorage.
    this._receiveResource = new AsyncResource('UDPWRAP');
    this[VIRTUAL_DGRAM_STATE] = {
      handle: {
        fd: nextVirtualDescriptor++,
        lookup: (address, callback) => this._dns.lookup(
          address,
          { family: this.type === 'udp6' ? 6 : 4 },
          callback,
        ),
      },
    };
    const diagnostics = typeof this._diagnostics === 'function' ? this._diagnostics() : this._diagnostics;
    const channel = diagnostics?.channel?.('udp.socket');
    if (channel?.hasSubscribers) channel.publish({ socket: this });
    if (typeof listener === 'function') this.on('message', listener);
  }

  bind(port_, address_, callback_) {
    healthCheck(this);
    if (this._bound || this._binding) throw socketError('ERR_SOCKET_ALREADY_BOUND', 'Socket is already bound');
    let options = {};
    let port = port_;
    let address = address_;
    let callback = callback_;
    if (port_ && typeof port_ === 'object') {
      options = { ...port_ };
      port = options.port ?? 0;
      address = options.address;
      callback = address_;
      this._reuseAddr = Boolean(options.reuseAddr);
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
    queueMicrotask(() => {
      if (this._closed) return;
      const handle = this[VIRTUAL_DGRAM_STATE].handle;
      handle.lookup.call(handle, normalizedAddress, (lookupError, resolvedAddress, resolvedFamily) => {
        if (this._closed) return;
        if (lookupError) {
          this._binding = false;
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
          const result = cluster?.isWorker && typeof this._network.bindClusterUdp === 'function'
            ? this._network.bindClusterUdp(groupId, normalizedAddress, requestedPort, {
                reuseAddr: this._reuseAddr,
                reusePort: this._reusePort,
                ipv6Only: this._ipv6Only,
                socket: this,
              })
            : this._network.bindUdp(this, normalizedAddress, requestedPort, {
                reuseAddr: this._reuseAddr,
                reusePort: this._reusePort,
                ipv6Only: this._ipv6Only,
              });
          this.boundPort = result.port;
          this.boundAddress = result.address;
          this._taskRelease = this._refed ? this._trackTask?.() || null : null;
          this._binding = false;
          this._bound = true;
          this.emit('listening');
          this._onListening?.(this.address());
          callback?.call(this);
        } catch (error) {
          this._binding = false;
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
    if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const options = args.shift();
      offset = options.offset || 0;
      length = options.length;
      port = options.port;
      address = options.address;
      callback = options.callback;
    } else if (typeof args[0] === 'number' && typeof args[1] === 'number' && typeof args[2] === 'number') {
      offset = args.shift();
      length = args.shift();
      port = args.shift();
      address = args.shift();
      callback = args.shift();
    } else {
      port = args.shift();
      address = args.shift();
      callback = args.shift();
    }
    if (typeof port === 'function') {
      callback = port;
      port = undefined;
    }
    if (typeof address === 'function') {
      callback = address;
      address = undefined;
    }
    const connected = this._connected;
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
    let bytes;
    try {
      bytes = asBytes(message, offset, length);
      port = port ?? this._remoteAddress?.port;
      port = validatePort(port);
    } catch (error) {
      queueMicrotask(() => callback(error));
      return false;
    }
    const transmit = () => {
      queueMicrotask(() => {
        const family = this.type === 'udp6' ? 'ipv6' : 'ipv4';
        if (this._sendBlockList?.check?.(address, family)) {
          const error = networkError('ERR_IP_BLOCKED', 'send', address, port);
          if (callbackProvided) callback(error);
          else this.emit('error', error);
          return;
        }
        const resource = new AsyncResource('UDPSENDWRAP');
        this._sendResources.add(resource);
        const runCallback = (...callbackArgs) => resource.runInAsyncScope(callback, this, ...callbackArgs);
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
      });
    };
    if (virtualAddressFamily(address) === 0) {
      const lookup = this[VIRTUAL_DGRAM_STATE].handle.lookup;
      lookup.call(this[VIRTUAL_DGRAM_STATE].handle, address, (error, resolvedAddress, resolvedFamily) => {
        if (error) {
          if (callbackProvided) callback(error);
          else this.emit('error', error);
          return;
        }
        address = normalizeVirtualAddress(resolvedAddress, resolvedFamily || (this.type === 'udp6' ? 6 : 4));
        transmit();
      });
      return true;
    }
    address = normalizeVirtualAddress(address, this.type === 'udp6' ? 6 : 4);
    if (!this._bound) {
      if (!this._binding) this.bind(0, this.type === 'udp6' ? '::' : '0.0.0.0');
      if (this._bound) transmit();
      else this.once('listening', transmit);
    } else {
      transmit();
    }
    return true;
  }

  sendto(buffer, offset, length, port, address, callback) {
    if (typeof offset !== 'number') throw socketError('ERR_INVALID_ARG_TYPE', 'The "offset" argument must be of type number');
    if (typeof length !== 'number') throw socketError('ERR_INVALID_ARG_TYPE', 'The "length" argument must be of type number');
    if (typeof port !== 'number') throw socketError('ERR_INVALID_ARG_TYPE', 'The "port" argument must be of type number');
    if (typeof address !== 'string') throw socketError('ERR_INVALID_ARG_TYPE', 'The "address" argument must be of type string');
    this.send(buffer, offset, length, port, address, callback);
  }

  connect(port, address, callback) {
    healthCheck(this);
    if (this._connected || this._connecting) throw socketError('ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected');
    this._connecting = true;
    if (typeof address === 'function') {
      callback = address;
      address = undefined;
    }
    const family = this.type === 'udp6' ? 6 : 4;
    const requestedPort = validatePort(port);
    const requestedAddress = address || (family === 6 ? '::1' : '127.0.0.1');
    const finish = (error, resolvedAddress = requestedAddress, resolvedFamily = family) => {
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
        if (bindError) {
          finish(bindError);
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
    this._remoteAddress = null;
    this._connected = false;
  }

  close(callback) {
    healthCheck(this);
    if (typeof callback === 'function') this.once('close', callback);
    if (this._closed) return this;
    this._closed = true;
    this._binding = false;
    if (this._bound) this._network.unbindUdp(this);
    this._taskRelease?.();
    this._taskRelease = null;
    this._bound = false;
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
    if (this._closed) return;
    const family = rinfo?.family === 'IPv6' ? 'ipv6' : 'ipv4';
    if (this._receiveBlockList?.check?.(rinfo?.address, family)) return;
    this._receiveResource.runInAsyncScope(
      () => this.emit('message', makeNodeBytes(bytes, this._bufferClass), rinfo),
      this,
    );
  }

  getRecvBufferSize() { return 0; }
  getSendBufferSize() { return 0; }
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

export function createBrowserDgram({ network = sharedVirtualNetwork, transport, dns = createBrowserDns(), BufferClass, trackTask, diagnostics, cluster, clusterGroupId, onListening } = {}) {
  const configuredNetwork = transport && network === sharedVirtualNetwork ? createVirtualNetwork({ transport }) : network;
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
  };
}

export const constants = UDP_CONSTANTS;

export function createSocket(type, listener) {
  return new Socket(type, listener);
}

export default { createSocket, Socket, constants };
