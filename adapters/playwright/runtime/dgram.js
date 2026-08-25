import { EventEmitter } from './events.js';
import { createVirtualNetwork, sharedVirtualNetwork, normalizeVirtualAddress, virtualNetworkConstants } from './virtual-network.js';

const UDP_CONSTANTS = Object.freeze({
  UV_UDP_REUSEADDR: 4,
  IPV6_ONLY: 27,
});

function asBytes(value, offset = 0, length = undefined) {
  let bytes;
  if (typeof value === 'string') bytes = new TextEncoder().encode(value);
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
    this._bufferClass = internal.BufferClass;
    this._trackTask = internal.trackTask;
    this._clusterGroupId = internal.clusterGroupId;
    this._processOwner = internal.processOwner;
    this._reuseAddr = Boolean(internal.reuseAddr);
    this._bound = false;
    this._closed = false;
    this._connected = false;
    this._remoteAddress = null;
    this.boundPort = null;
    this.boundAddress = null;
    this._taskRelease = null;
    if (typeof listener === 'function') this.on('message', listener);
  }

  bind(port_, address_, callback_) {
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
    const normalizedAddress = normalizeVirtualAddress(address || (family === 6 ? '::' : '0.0.0.0'), family);
    const requestedPort = validatePort(port ?? 0);
    queueMicrotask(() => {
      if (this._closed) return;
      if (this._bound) {
        callback?.call(this);
        return;
      }
      try {
        const result = this._network.bindUdp(this, normalizedAddress, requestedPort, {
          reuseAddr: this._reuseAddr,
          clusterGroupId: this._clusterGroupId,
          processOwner: this._processOwner,
        });
        this.boundPort = result.port;
        this.boundAddress = result.address;
        this._taskRelease = this._trackTask?.() || null;
        this._bound = true;
        this.emit('listening');
        callback?.call(this);
      } catch (error) {
        this.emit('error', error);
        callback?.call(this, error);
      }
    });
    return this;
  }

  address() {
    if (!this._bound) throw new Error('Not running');
    return {
      address: this.boundAddress,
      port: this.boundPort,
      family: this.type === 'udp6' ? 'IPv6' : 'IPv4',
    };
  }

  send(message, ...args) {
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
    if (typeof callback !== 'function') callback = () => {};
    let bytes;
    try {
      bytes = asBytes(message, offset, length);
      port = port ?? this._remoteAddress?.port;
      address = address ?? this._remoteAddress?.address ?? (this.type === 'udp6' ? virtualNetworkConstants.LOOPBACK_V6 : virtualNetworkConstants.LOOPBACK_V4);
      port = validatePort(port);
      address = normalizeVirtualAddress(address, this.type === 'udp6' ? 6 : 4);
    } catch (error) {
      queueMicrotask(() => callback(error));
      return false;
    }
    const transmit = () => {
      this._network.sendUdp({
        source: this,
        address,
        port,
        bytes,
        onDelivered: (size) => callback(null, size),
        onError: (error) => {
          this.emit('error', error);
          callback(error);
        },
      });
    };
    if (!this._bound) {
      this.bind(0, this.type === 'udp6' ? '::' : '0.0.0.0', (error) => {
        if (error) callback(error);
        else transmit();
      });
    } else {
      transmit();
    }
    return true;
  }

  connect(port, address, callback) {
    if (typeof address === 'function') {
      callback = address;
      address = undefined;
    }
    const family = this.type === 'udp6' ? 6 : 4;
    const remote = { port: validatePort(port), address: normalizeVirtualAddress(address || (family === 6 ? '::1' : '127.0.0.1'), family) };
    const complete = () => {
      this._remoteAddress = remote;
      this._connected = true;
      this.emit('connect');
      callback?.call(this);
    };
    if (this._bound) queueMicrotask(complete);
    else this.bind(0, family === 6 ? '::' : '0.0.0.0', complete);
    return this;
  }

  disconnect() {
    this._remoteAddress = null;
    this._connected = false;
    return this;
  }

  close(callback) {
    if (typeof callback === 'function') this.once('close', callback);
    if (this._closed) return this;
    this._closed = true;
    if (this._bound) this._network.unbindUdp(this);
    this._taskRelease?.();
    this._taskRelease = null;
    this._bound = false;
    this.boundPort = null;
    this.boundAddress = null;
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  _receiveDatagram(bytes, rinfo) {
    if (this._closed) return;
    this.emit('message', makeNodeBytes(bytes, this._bufferClass), rinfo);
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
  _networkClosed() {
    if (!this._bound) return;
    this._bound = false;
    this.boundPort = null;
    this.boundAddress = null;
    this._taskRelease?.();
    this._taskRelease = null;
    queueMicrotask(() => this.emit('close'));
  }
  ref() { return this; }
  unref() { return this; }
}

export function createBrowserDgram({ network = sharedVirtualNetwork, transport, BufferClass, trackTask, clusterGroupId, processOwner } = {}) {
  const configuredNetwork = transport && network === sharedVirtualNetwork ? createVirtualNetwork({ transport }) : network;
  const SocketWithDefaults = class BrowserDgramSocket extends Socket {
    constructor(type, listener) {
      super(type, listener, { network: configuredNetwork, BufferClass, trackTask, clusterGroupId, processOwner });
    }
  };
  return {
    createSocket(type, listener) { return new SocketWithDefaults(type, listener); },
    Socket: SocketWithDefaults,
    constants: UDP_CONSTANTS,
  };
}

export const constants = UDP_CONSTANTS;

export function createSocket(type, listener) {
  return new Socket(type, listener);
}

export default { createSocket, Socket, constants };
