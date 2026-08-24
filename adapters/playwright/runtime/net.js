import { EventEmitter } from './events.js';
import { Duplex } from './streams.js';
import { createBrowserDns } from './dns.js';
import { AsyncResource } from './async-hooks.js';
import { createVirtualNetwork, sharedVirtualNetwork, normalizeVirtualAddress, virtualAddressFamily } from './virtual-network.js';

let nextClientPort = 62000;

function schedule(callback) {
  queueMicrotask(callback);
}

function isIPv4Literal(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIPv6Literal(value) {
  const text = String(value).toLowerCase();
  if (!text || text.includes(':::')) return false;
  const sections = text.split('::');
  if (sections.length > 2) return false;
  const groups = sections.flatMap((section) => section ? section.split(':') : []);
  const ipv4Tail = groups.at(-1)?.includes('.') || false;
  if (ipv4Tail && !isIPv4Literal(groups.at(-1))) return false;
  const count = groups.length - (ipv4Tail ? 1 : 0) + (ipv4Tail ? 2 : 0);
  if (count > 8 || !groups.every((group, index) => ipv4Tail && index === groups.length - 1
    ? true
    : /^[\da-f]{1,4}$/.test(group))) return false;
  return sections.length === 2 ? count < 8 : count === 8;
}

export function isIP(input) {
  if (isIPv4Literal(input)) return 4;
  if (isIPv6Literal(input)) return 6;
  return 0;
}

export const isIPv4 = (input) => isIP(input) === 4;
export const isIPv6 = (input) => isIP(input) === 6;

function socketError(code, syscall, address, port) {
  const error = new Error(`${syscall} ${code} ${address}:${port}`);
  error.code = code;
  error.errno = code;
  error.syscall = syscall;
  error.address = address;
  error.port = port;
  return error;
}

function nodeBytes(bytes, BufferClass) {
  return typeof BufferClass?.from === 'function' ? BufferClass.from(bytes) : bytes;
}

function validatePort(port, allowZero = false) {
  const value = Number(port);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65535) {
    const error = new RangeError(`Port should be ${allowZero ? 'between 0 and 65535' : 'between 1 and 65535'}. Received ${port}.`);
    error.code = 'ERR_SOCKET_BAD_PORT';
    throw error;
  }
  return value;
}

function parseConnectArgs(args) {
  let options;
  let callback;
  if (typeof args.at(-1) === 'function') callback = args.pop();
  if (typeof args[0] === 'object' && args[0] !== null) options = { ...args[0] };
  else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) options = { path: args[0] };
  else options = { port: args[0], host: args[1] };
  return { options, callback };
}

function parseListenArgs(args) {
  let callback;
  if (typeof args.at(-1) === 'function') callback = args.pop();
  let options;
  if (typeof args[0] === 'object' && args[0] !== null) options = { ...args[0] };
  else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) options = { path: args[0] };
  else options = { port: args[0], host: args[1] };
  return { options, callback };
}

function nextLocalPort() {
  nextClientPort += 1;
  if (nextClientPort > 65000) nextClientPort = 62000;
  return nextClientPort;
}

/** A Node-shaped Duplex socket whose transport is entirely browser-local. */
export class Socket extends Duplex {
  constructor(options = {}, internal = {}) {
    super({ highWaterMark: options.highWaterMark });
    this._network = internal.network || sharedVirtualNetwork;
    this._dns = internal.dns || createBrowserDns();
    this._bufferClass = internal.BufferClass;
    this._transport = internal.transport;
    this.allowHalfOpen = options.allowHalfOpen ?? true;
    this.connecting = false;
    this.pending = true;
    this.readyState = 'open';
    this.localAddress = undefined;
    this.localPort = undefined;
    this.localFamily = undefined;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
    this.remoteFamily = undefined;
    this.path = undefined;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._peer = null;
    this._transportPeer = null;
    this._pendingWrite = null;
    this._pendingFinal = null;
    this._timeout = null;
    this._closing = false;
    this._writable._write = (bytes, encoding, callback) => this._write(bytes, encoding, callback);
    this._writable._final = (callback) => this._final(callback);
  }

  on(name, listener) {
    const result = super.on(name, listener);
    if (name === 'data') this.resume();
    return result;
  }

  connect(...args) {
    const { options, callback } = parseConnectArgs(args);
    if (callback) this.once('connect', callback);
    if (this.connecting || !this.pending) {
      schedule(() => this.emit('error', socketError('ERR_SOCKET_ALREADY_CONNECTED', 'connect', options.host || 'localhost', options.port)));
      return this;
    }
    if (options.path !== undefined) return this._connectPipe(options.path, options);
    const port = validatePort(options.port);
    const host = String(options.host || options.hostname || 'localhost');
    const family = Number(options.family || 0);
    this.connecting = true;
    this.pending = true;
    this.readyState = 'opening';
    this._connectOptions = { ...options, port, host, family };
    const completeLookup = (error, address, resolvedFamily) => {
      if (error) {
        this._failConnect(error);
        return;
      }
      const targetFamily = resolvedFamily || virtualAddressFamily(address);
      const localAddress = options.localAddress
        ? normalizeVirtualAddress(options.localAddress, targetFamily)
        : (targetFamily === 6 ? '::1' : '127.0.0.1');
      const localPort = options.localPort === undefined ? nextLocalPort() : validatePort(options.localPort, true);
      this._network.connectTcp({
        address,
        port,
        client: this,
        localAddress,
        localPort,
        onConnected: (connection) => this._establish(connection, targetFamily),
        onError: (connectError) => this._failConnect(connectError),
      });
    };
    if (isIP(host)) completeLookup(null, host, isIP(host));
    else this._dns.lookup(host, { family, all: false }, completeLookup);
    return this;
  }

  _createPipeResource(type, parent) {
    const triggerAsyncId = parent?.asyncId?.();
    return new AsyncResource(type, triggerAsyncId === undefined ? {} : { triggerAsyncId });
  }

  _connectPipe(path, options) {
    if (typeof path !== 'string' || path.length === 0) {
      const error = new TypeError('options.path must be a non-empty string');
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    if (this.connecting || !this.pending) {
      schedule(() => this.emit('error', socketError('ERR_SOCKET_ALREADY_CONNECTED', 'connect', path)));
      return this;
    }
    this.connecting = true;
    this.pending = true;
    this.readyState = 'opening';
    this.path = path;
    this._connectOptions = { ...options, path };
    this._network.connectPipe({
      path,
      client: this,
      onConnected: (connection) => this._establish(connection),
      onError: (error) => this._failConnect(error),
    });
    return this;
  }

  _establish(connection, family) {
    if (this.destroyed) return;
    this.connecting = false;
    this.pending = false;
    this.readyState = 'open';
    this.localAddress = connection.localAddress || undefined;
    this.localPort = connection.localPort || undefined;
    this.localFamily = this.localAddress ? (virtualAddressFamily(this.localAddress) === 6 ? 'IPv6' : 'IPv4') : undefined;
    this.remoteAddress = connection.remoteAddress;
    this.remotePort = connection.remotePort;
    this.remoteFamily = family ? (family === 6 ? 'IPv6' : 'IPv4') : undefined;
    this.path = connection.path;
    this._pipeResource = connection.pipeResource;
    this._pipeConnectResource = connection.pipeConnectResource;
    if (connection.transport) this._attachTransport(connection.transport);
    else this._peer = connection.serverSocket;
    const emitConnect = () => this.emit('connect');
    if (this._pipeConnectResource) {
      this._pipeConnectResource.runInAsyncScope(emitConnect, this);
      queueMicrotask(() => this._pipeConnectResource.emitDestroy());
    } else emitConnect();
    this._flushPendingWrite();
    if (this._pendingFinal) {
      const done = this._pendingFinal;
      this._pendingFinal = null;
      this._finishTransport(done);
    }
  }

  _failConnect(error) {
    if (this.destroyed) return;
    this.connecting = false;
    this.pending = false;
    this.readyState = 'closed';
    this.destroy(error);
  }

  _attachTransport(peer) {
    this._transportPeer = peer;
    peer.on?.('data', (bytes) => {
      const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.bytesRead += value.byteLength;
      this.push(nodeBytes(value, this._bufferClass));
    });
    peer.on?.('end', () => this.push(null));
    peer.on?.('error', (error) => this.destroy(error));
  }

  _flushPendingWrite() {
    if (!this._pendingWrite) return;
    const { bytes, callback } = this._pendingWrite;
    this._pendingWrite = null;
    this._send(bytes, callback);
  }

  _write(bytes, _encoding, callback) {
    if (this._peer || this._transportPeer) this._send(bytes, callback);
    else if (this.connecting) this._pendingWrite = { bytes, callback };
    else callback(socketError('EPIPE', 'write', this.remoteAddress || 'socket', this.remotePort || 0));
  }

  end(...args) {
    if (!this.destroyed && this.readyState === 'open') this.readyState = 'readOnly';
    return super.end(...args);
  }

  _send(bytes, callback) {
    const peer = this._peer;
    const transport = this._transportPeer;
    schedule(() => {
      if (peer) {
        if (peer.destroyed) {
          callback(socketError('EPIPE', 'write', this.remoteAddress || 'socket', this.remotePort || 0));
          return;
        }
        this.bytesWritten += bytes.byteLength;
        peer.bytesRead += bytes.byteLength;
        peer.push(nodeBytes(bytes, peer._bufferClass));
        callback();
        return;
      }
      if (transport?.write) {
        try {
          const result = transport.write(bytes, callback);
          if (result && typeof result.then === 'function') result.then(() => callback(), callback);
        } catch (error) {
          callback(error);
        }
        return;
      }
      callback(socketError('EPIPE', 'write', this.remoteAddress || 'socket', this.remotePort || 0));
    });
  }

  _final(callback) {
    if (this.connecting) {
      this._pendingFinal = callback;
      return;
    }
    this._finishTransport(callback);
  }

  _finishTransport(callback) {
    if (!this.destroyed && this.readyState === 'open') this.readyState = 'readOnly';
    const shutdownResource = this._pipeResource ? this._createPipeResource('SHUTDOWNWRAP', this._pipeResource) : null;
    const complete = (error) => {
      const finish = () => error ? callback(error) : callback();
      if (shutdownResource) shutdownResource.runInAsyncScope(finish, this);
      else finish();
      if (shutdownResource) queueMicrotask(() => shutdownResource.emitDestroy());
    };
    if (this._transportPeer?.end) {
      try { this._transportPeer.end(complete); } catch (error) { complete(error); }
      return;
    }
    const peer = this._peer;
    if (peer && !peer.destroyed) schedule(() => peer.push(null));
    schedule(complete);
  }

  address() {
    if (!this.localPort) return null;
    return { address: this.localAddress, family: this.localFamily, port: this.localPort };
  }

  setTimeout(milliseconds, callback) {
    if (this._timeout) clearTimeout(this._timeout);
    if (callback) this.once('timeout', callback);
    if (milliseconds > 0) this._timeout = setTimeout(() => this.emit('timeout'), milliseconds);
    return this;
  }

  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  destroySoon() { return this.destroy(); }

  destroy(error) {
    if (this._closing) return this;
    this._closing = true;
    if (this._timeout) clearTimeout(this._timeout);
    // Node tears down destinations attached with socket.pipe(destination)
    // when the source socket is destroyed. This matters for CONNECT proxies:
    // the client-side tunnel can close before either side sends EOF, so
    // leaving the opposite pipe alive would keep the upstream socket and its
    // child process open indefinitely.
    for (const destination of this._pipes.keys()) destination.destroy?.(error);
    this.unpipe();
    const peer = this._peer;
    this._peer = null;
    if (peer && !peer.destroyed) peer._peerClosed(true);
    if (this._transportPeer?.destroy) this._transportPeer.destroy();
    this._pipeConnectResource?.emitDestroy();
    this._pipeResource?.emitDestroy();
    this.connecting = false;
    this.pending = false;
    this.readyState = 'closed';
    return super.destroy(error);
  }

  _peerClosed(forceClose = false) {
    this._peer = null;
    this.push(null);
    if (!forceClose && this.readyState === 'open') this.readyState = 'writeOnly';
    if (forceClose || !this.allowHalfOpen) this.destroy();
  }
}

export class Server extends EventEmitter {
  constructor(options = {}, connectionListener, internal = {}) {
    super();
    if (typeof options === 'function') {
      connectionListener = options;
      options = {};
    }
    this._config = internal;
    this._network = internal.network || sharedVirtualNetwork;
    this._SocketClass = internal.SocketClass || Socket;
    this._allowHalfOpen = options.allowHalfOpen ?? true;
    this._pauseOnConnect = Boolean(options.pauseOnConnect);
    this._activeSockets = new Set();
    this._boundPort = null;
    this._boundAddress = null;
    this._pipeName = null;
    this._pipeResource = null;
    this._taskRelease = null;
    this.listening = false;
    this.maxConnections = undefined;
    if (typeof connectionListener === 'function') this.on('connection', connectionListener);
  }

  listen(...args) {
    const { options, callback } = parseListenArgs(args);
    if (callback) this.once('listening', callback);
    if (options.path !== undefined) return this._listenPipe(options.path, callback);
    if (options.port === undefined) {
      const error = new Error('listen requires a port in the browser virtual network');
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    const port = validatePort(options.port, true);
    const family = options.host && isIP(options.host) === 6 ? 6 : 4;
    const address = normalizeVirtualAddress(options.host || (family === 6 ? '::' : '0.0.0.0'), family);
    schedule(() => {
      if (this.listening) return;
      try {
        const result = this._network.bindTcp(this, address, port);
        this._boundPort = result.port;
        this._boundAddress = result.address;
        this._taskRelease = this._config.trackTask?.() || null;
        this.listening = true;
        this.emit('listening');
        try { this._config.onListening?.(this.address()); } catch { /* parent may already be terminal */ }
      } catch (error) {
        this.emit('error', error);
        callback?.call(this, error);
      }
    });
    return this;
  }

  _listenPipe(path, callback) {
    if (typeof path !== 'string' || path.length === 0) {
      const error = new TypeError('options.path must be a non-empty string');
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    if (this.listening) return this;
    this._pipeName = path;
    this._pipeResource = new AsyncResource('PIPESERVERWRAP');
    schedule(() => {
      if (this.listening) return;
      try {
        this._network.bindPipe(this, path);
        this._taskRelease = this._config.trackTask?.() || null;
        this.listening = true;
        this.emit('listening');
        try { this._config.onListening?.(path); } catch { /* parent may already be terminal */ }
      } catch (error) {
        this._pipeResource?.emitDestroy();
        this._pipeResource = null;
        this._pipeName = null;
        this.emit('error', error);
      }
    });
    return this;
  }

  address() {
    if (!this.listening) return null;
    if (this._pipeName) return this._pipeName;
    return {
      address: this._boundAddress,
      family: virtualAddressFamily(this._boundAddress) === 6 ? 'IPv6' : 'IPv4',
      port: this._boundPort,
    };
  }

  close(callback) {
    if (callback) this.once('close', callback);
    if (!this.listening) {
      schedule(() => this.emit('close'));
      return this;
    }
    this._network.unbindTcp(this);
    this._network.unbindPipe?.(this);
    this._taskRelease?.();
    this._taskRelease = null;
    this.listening = false;
    this._boundPort = null;
    this._boundAddress = null;
    for (const socket of [...this._activeSockets]) socket.destroy();
    const pipeResource = this._pipeResource;
    this._pipeResource = null;
    this._pipeName = null;
    queueMicrotask(() => pipeResource?.emitDestroy());
    schedule(() => this.emit('close'));
    return this;
  }

  getConnections(callback) {
    schedule(() => callback?.(null, this._activeSockets.size));
  }

  _createAcceptedSocket() {
    return new this._SocketClass({ allowHalfOpen: this._allowHalfOpen }, this._config);
  }

  _createPipeResource(type, parent) {
    const triggerAsyncId = parent?.asyncId?.();
    return new AsyncResource(type, triggerAsyncId === undefined ? {} : { triggerAsyncId });
  }

  _acceptConnection(connection) {
    const accepted = connection.serverSocket;
    accepted._peer = connection.client;
    accepted.path = connection.path;
    accepted._pipeResource = connection.serverPipeResource;
    accepted.connecting = false;
    accepted.pending = false;
    accepted.readyState = 'open';
    accepted.localAddress = connection.remoteAddress;
    accepted.localPort = this._boundPort;
    accepted.localFamily = connection.remoteAddress
      ? (virtualAddressFamily(connection.remoteAddress) === 6 ? 'IPv6' : 'IPv4')
      : undefined;
    accepted.remoteAddress = connection.localAddress;
    accepted.remotePort = connection.localPort;
    accepted.remoteFamily = accepted.localFamily;
    this._activeSockets.add(accepted);
    accepted.once('close', () => this._activeSockets.delete(accepted));
    const emitConnection = () => this.emit('connection', accepted);
    if (this._pipeResource) this._pipeResource.runInAsyncScope(emitConnection, this);
    else emitConnection();
    if (this._pauseOnConnect) accepted.pause();
  }

  ref() { return this; }
  unref() { return this; }
}

class BrowserBlockList {
  constructor() { this._entries = []; }
  addAddress(address, type = 'ipv4') { this._entries.push({ kind: 'address', address: String(address), type }); }
  addRange(start, end, type = 'ipv4') { this._entries.push({ kind: 'range', start: String(start), end: String(end), type }); }
  addSubnet(network, prefix, type = 'ipv4') { this._entries.push({ kind: 'subnet', network: String(network), prefix: Number(prefix), type }); }
  check(address, type = 'ipv4') { return this._entries.some((entry) => entry.type === type && (entry.address === address || entry.network === address)); }
}

const defaultConfig = { network: sharedVirtualNetwork, dns: createBrowserDns() };

export function createBrowserNet({ network = sharedVirtualNetwork, dns = createBrowserDns(), transport, BufferClass, trackTask, onListening } = {}) {
  const configuredNetwork = transport && network === sharedVirtualNetwork ? createVirtualNetwork({ transport }) : network;
  const config = { network: configuredNetwork, dns, transport, BufferClass, trackTask, onListening };
  const ConfiguredSocket = class BrowserNetSocket extends Socket {
    constructor(options = {}) { super(options, config); }
  };
  const ConfiguredServer = class BrowserNetServer extends Server {
    constructor(options = {}, listener) { super(options, listener, { ...config, SocketClass: ConfiguredSocket }); }
  };
  return {
    Socket: ConfiguredSocket,
    Stream: ConfiguredSocket,
    Server: ConfiguredServer,
    createServer(options, listener) {
      return new ConfiguredServer(options, listener);
    },
    createConnection(...args) {
      return new ConfiguredSocket().connect(...args);
    },
    connect(...args) {
      return new ConfiguredSocket().connect(...args);
    },
    isIP,
    isIPv4,
    isIPv6,
    BlockList: BrowserBlockList,
    getDefaultAutoSelectFamily: () => false,
    setDefaultAutoSelectFamily: () => undefined,
    getDefaultAutoSelectFamilyAttemptTimeout: () => 250,
    setDefaultAutoSelectFamilyAttemptTimeout: () => undefined,
    constants: Object.freeze({}),
  };
}

const defaultNet = createBrowserNet(defaultConfig);
export const createServer = (...args) => defaultNet.createServer(...args);
export const createConnection = (...args) => defaultNet.createConnection(...args);
export const connect = (...args) => defaultNet.connect(...args);
export const constants = defaultNet.constants;
export const BlockList = defaultNet.BlockList;
export const getDefaultAutoSelectFamily = defaultNet.getDefaultAutoSelectFamily;
export const setDefaultAutoSelectFamily = defaultNet.setDefaultAutoSelectFamily;
export const getDefaultAutoSelectFamilyAttemptTimeout = defaultNet.getDefaultAutoSelectFamilyAttemptTimeout;
export const setDefaultAutoSelectFamilyAttemptTimeout = defaultNet.setDefaultAutoSelectFamilyAttemptTimeout;

export default {
  ...defaultNet,
  Socket,
  Server,
  isIP,
  isIPv4,
  isIPv6,
};
