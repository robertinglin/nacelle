import { EventEmitter } from './events.js';
import { Duplex } from './streams.js';
import { createBrowserDns } from './dns.js';
import { AsyncResource, ownerSymbol } from './async-hooks.js';
import { createVirtualNetwork, sharedVirtualNetwork, normalizeVirtualAddress, virtualAddressFamily } from './virtual-network.js';

let nextClientPort = 62000;

function schedule(callback) {
  queueMicrotask(callback);
}

function configuredCluster(config) {
  return typeof config.cluster === 'function' ? config.cluster() : config.cluster;
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

function isVirtualBlackholeAddress(address) {
  if (isIPv4Literal(address)) {
    const [first, second] = String(address).split('.').map(Number);
    return (first === 192 && second === 0)
      || (first === 198 && second === 51)
      || (first === 203 && second === 0);
  }
  return String(address).toLowerCase().startsWith('2001:db8:');
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

function socketErrorFromHandle(status, address, port) {
  const code = status === -51 ? 'ENETUNREACH' : 'EIO';
  return socketError(code, 'connect', address, port);
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
    this._handle = options.handle || null;
    if (this._handle && typeof this._handle === 'object') this._handle[ownerSymbol] = this;
    this._transport = internal.transport;
    this.allowHalfOpen = options.allowHalfOpen ?? true;
    this.connecting = false;
    this._pending = true;
    this._readyState = 'open';
    this._noDelay = Boolean(options.noDelay);
    this._keepAlive = Boolean(options.keepAlive);
    this._keepAliveInitialDelay = ~~(options.keepAliveInitialDelay / 1000);
    this.localAddress = undefined;
    this.localPort = undefined;
    this.localFamily = undefined;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
    this.remoteFamily = undefined;
    this.autoSelectFamilyAttemptedAddresses = undefined;
    this.path = undefined;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._peer = null;
    this._transportPeer = null;
    this._tcpResource = null;
    this._tcpConnectResource = null;
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
    if (!this._tcpResource) this._tcpResource = new AsyncResource('TCPWRAP');
    const port = validatePort(options.port);
    const host = String(options.host || options.hostname || 'localhost');
    const family = Number(options.family || 0);
    this.connecting = true;
    this._pending = true;
    this._readyState = 'opening';
    this._connectOptions = { ...options, port, host, family };
    if (this._handle?.connect) {
      let status;
      try {
        status = this._handle.connect({}, host, port);
      } catch (error) {
        schedule(() => this._failConnect(error));
        return this;
      }
      if (typeof status === 'number' && status < 0) {
        schedule(() => this._failConnect(socketErrorFromHandle(status, host, port)));
        return this;
      }
    }
    const completeLookup = (error, address, resolvedFamily) => {
      const lookupAddress = Array.isArray(address) ? address[0]?.address : address;
      const lookupFamily = Array.isArray(address)
        ? (address[0]?.family || resolvedFamily)
        : resolvedFamily;
      this.emit('lookup', error, lookupAddress, lookupFamily, host);
      if (error) {
        this._failConnect(error);
        return;
      }
      const candidates = Array.isArray(address)
        ? address
        : [{ address, family: resolvedFamily || virtualAddressFamily(address) }];
      if (!options.autoSelectFamily) {
        this._connectAddress(candidates[0].address, candidates[0].family, port, options);
        return;
      }
      this.autoSelectFamilyAttemptedAddresses = [];
      const errors = [];
      let remaining = candidates.length;
      let settled = false;
      for (const candidate of candidates) {
        const candidateAddress = candidate.address;
        const candidateFamily = candidate.family || virtualAddressFamily(candidateAddress);
        this.autoSelectFamilyAttemptedAddresses.push(
          candidateFamily === 6 ? `[${candidateAddress}]:${port}` : `${candidateAddress}:${port}`,
        );
        this._connectAddress(candidateAddress, candidateFamily, port, options, (connectError) => {
          if (settled) return;
          if (connectError?.code === 'ERR_IP_BLOCKED') {
            settled = true;
            this._failConnect(connectError);
            return;
          }
          errors.push(connectError);
          remaining -= 1;
          if (remaining === 0) {
            settled = true;
            this._failConnect(new AggregateError(errors, `connect ${options.host || options.hostname || ''} failed`));
          }
        }, () => {
          if (settled) return;
          settled = true;
        });
      }
    };
    if (isIP(host)) completeLookup(null, host, isIP(host));
    else {
      const lookup = options.lookup || this._dns.lookup.bind(this._dns);
      lookup(host, { family, all: Boolean(options.autoSelectFamily) }, completeLookup);
    }
    return this;
  }

  _connectAddress(address, family, port, options, onError = (error) => this._failConnect(error), onConnected = () => {}) {
    // Documentation-only networks are intentionally unroutable. Keep their
    // connection pending so Socket#setTimeout can deliver the observable
    // timeout event instead of converting the black hole into ECONNREFUSED.
    if (!options.autoSelectFamily && isVirtualBlackholeAddress(address)) return;
    if (options.blockList?.check?.(address, family === 6 ? 'ipv6' : 'ipv4')) {
      schedule(() => onError(socketError('ERR_IP_BLOCKED', 'connect', address, port)));
      return;
    }
    const localAddress = options.localAddress
      ? normalizeVirtualAddress(options.localAddress, family)
      : (family === 6 ? '::1' : '127.0.0.1');
    const localPort = options.localPort === undefined ? nextLocalPort() : validatePort(options.localPort, true);
    schedule(() => {
      if (this.destroyed) return;
      this._tcpConnectResource = new AsyncResource('TCPCONNECTWRAP', {
        triggerAsyncId: this._tcpResource?.asyncId(),
      });
      this._network.connectTcp({
        address,
        port,
        client: this,
        localAddress,
        localPort,
        onConnected: (connection) => {
          if (onConnected() === false) return;
          this._establish(connection, family);
        },
        onError,
      });
    });
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
    this._pending = true;
    this._readyState = 'opening';
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
    this._pending = false;
    this._readyState = 'open';
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
    const handle = this._handle || this._transportPeer;
    if (this._noDelay && handle?.setNoDelay) handle.setNoDelay(true);
    if (this._keepAlive && handle?.setKeepAlive) {
      handle.setKeepAlive(true, this._keepAliveInitialDelay);
    }
    const emitConnect = () => this.emit('connect');
    if (this._pipeConnectResource) {
      this._pipeConnectResource.runInAsyncScope(emitConnect, this);
      queueMicrotask(() => this._pipeConnectResource.emitDestroy());
    } else if (this._tcpConnectResource) {
      this._tcpConnectResource.runInAsyncScope(emitConnect, this);
    } else emitConnect();
    this._flushPendingWrite();
    if (this._pendingFinal) {
      const done = this._pendingFinal;
      this._pendingFinal = null;
      this._finishTransport(done);
    }
  }

  _runTcpResource(callback) {
    if (this._tcpResource) return this._tcpResource.runInAsyncScope(callback, this);
    return callback();
  }

  _failConnect(error) {
    if (this.destroyed) return;
    this.connecting = false;
    this._pending = false;
    this._readyState = 'closed';
    if (this._unrefed) return;
    this.destroy(error);
  }

  _attachTransport(peer) {
    this._transportPeer = peer;
    peer.on?.('data', (bytes) => {
      const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.bytesRead += value.byteLength;
      this._runTcpResource(() => this.push(nodeBytes(value, this._bufferClass)));
    });
    peer.on?.('end', () => this._runTcpResource(() => this.push(null)));
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
    if (!this.destroyed && this.readyState === 'open') this._readyState = 'readOnly';
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
        peer._runTcpResource?.(() => peer.push(nodeBytes(bytes, peer._bufferClass)));
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
    if (!this.destroyed && this.readyState === 'open') this._readyState = 'readOnly';
    const shutdownParent = this._pipeResource || this._tcpResource;
    const shutdownResource = shutdownParent ? this._createPipeResource('SHUTDOWNWRAP', shutdownParent) : null;
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
    schedule(() => {
      if (this._tcpResource) this._tcpResource.runInAsyncScope(complete, this);
      else complete();
    });
  }

  _onTimeout() {
    this.emit('timeout');
  }

  setNoDelay(enable) {
    enable = Boolean(enable === undefined ? true : enable);
    const handle = this._handle || this._transportPeer;
    if (!handle) {
      this._noDelay = enable;
      return this;
    }
    if (handle.setNoDelay && enable !== this._noDelay) {
      this._noDelay = enable;
      handle.setNoDelay(enable);
    }
    return this;
  }

  setKeepAlive(enable, initialDelayMsecs) {
    enable = Boolean(enable);
    const initialDelay = ~~(initialDelayMsecs / 1000);
    const handle = this._handle || this._transportPeer;
    if (!handle) {
      this._keepAlive = enable;
      this._keepAliveInitialDelay = initialDelay;
      return this;
    }
    if (!handle.setKeepAlive) return this;
    if (enable !== this._keepAlive
      || (enable && this._keepAliveInitialDelay !== initialDelay)) {
      this._keepAlive = enable;
      this._keepAliveInitialDelay = initialDelay;
      handle.setKeepAlive(enable, initialDelay);
    }
    return this;
  }

  address() {
    if (this._handle?.getsockname) {
      const address = {};
      this._handle.getsockname(address);
      return address;
    }
    if (this.localPort === undefined || this.localPort === null) return {};
    return { address: this.localAddress, family: this.localFamily, port: this.localPort };
  }

  get _connecting() {
    return this.connecting;
  }

  get pending() {
    return this._pending ?? (!this._handle || this.connecting);
  }

  get readyState() {
    if (this.connecting) return 'opening';
    if (this._readyState === 'closed' || this.destroyed) return 'closed';
    if (this._readyState === 'readOnly' && this.readable) return 'readOnly';
    if (this._readyState === 'writeOnly' && this.writable) return 'writeOnly';
    if (this.readable && this.writable) return 'open';
    if (this.readable && !this.writable) return 'readOnly';
    if (!this.readable && this.writable) return 'writeOnly';
    return 'closed';
  }

  get bufferSize() {
    if (this._handle || this._peer || this._transportPeer) return this.writableLength;
  }

  setTimeout(milliseconds, callback) {
    if (typeof milliseconds !== 'number') {
      const error = new TypeError('The "msecs" argument must be of type number');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      const error = new RangeError(`The value of "msecs" is out of range. It must be >= 0 && <= ${Number.MAX_SAFE_INTEGER}. Received ${milliseconds}`);
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
    if (callback !== undefined && typeof callback !== 'function') {
      const error = new TypeError('The "callback" argument must be of type function');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (this._timeout) clearTimeout(this._timeout);
    if (callback) this.once('timeout', callback);
    if (milliseconds > 0) this._timeout = setTimeout(() => this._onTimeout(), milliseconds);
    return this;
  }

  ref() { this._unrefed = false; return this; }
  unref() { this._unrefed = true; return this; }
  destroySoon() { return this.destroy(); }
  resetAndDestroy() {
    if (this.destroyed) return this;
    const error = socketError('ECONNRESET', 'read ECONNRESET', this.remoteAddress || 'socket', this.remotePort || 0);
    error.message = 'read ECONNRESET';
    this._resetDestroyed = true;
    this._writable._resetDestroyed = true;
    const peer = this._peer;
    this._peer = null;
    if (peer && !peer.destroyed) {
      peer._peer = null;
      peer.destroy(error);
    }
    this.destroy();
    return this;
  }

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
    this._tcpConnectResource?.emitDestroy();
    this._tcpResource?.emitDestroy();
    this._pipeConnectResource?.emitDestroy();
    this._pipeResource?.emitDestroy();
    this.connecting = false;
    this._pending = false;
    this._readyState = 'closed';
    if (this._tcpResource) {
      return this._tcpResource.runInAsyncScope(() => super.destroy(error), this);
    }
    return super.destroy(error);
  }

  _peerClosed(forceClose = false) {
    this._peer = null;
    this.push(null);
    if (!forceClose && this.readyState === 'open') this._readyState = 'writeOnly';
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
    this._blockList = options.blockList;
    this._allowHalfOpen = options.allowHalfOpen ?? true;
    this._pauseOnConnect = Boolean(options.pauseOnConnect);
    this._activeSockets = new Set();
    this._boundPort = null;
    this._boundAddress = null;
    this._pipeName = null;
    this._pipeResource = null;
    this._tcpResource = null;
    this._taskRelease = null;
    this._closeRequested = false;
    this._clusterHandle = null;
    this._handle = null;
    this._unref = false;
    this._ownerProcess = internal.currentProcess?.() || null;
    this.listening = false;
    this.maxConnections = undefined;
    if (typeof connectionListener === 'function') this.on('connection', connectionListener);
  }

  _runWithOwner(callback) {
    if (!this._ownerProcess || !this._config.runInProcessContext) return callback();
    return this._config.runInProcessContext(this._ownerProcess, callback);
  }

  listen(...args) {
    const { options, callback } = parseListenArgs(args);
    if (callback) this.once('listening', callback);
    if (options.path !== undefined) return this._listenPipe(options.path, callback);
    // Node allocates an ephemeral port when listen is called with only a
    // callback (or otherwise without an explicit port).
    const port = validatePort(options.port ?? 0, true);
    // Node's unspecified TCP listen host is the dual-stack IPv6 wildcard on
    // the Linux target used by this suite, so IPv6 loopback clients can use
    // the returned ephemeral port immediately.
    const family = options.host ? (isIP(options.host) === 6 ? 6 : 4) : 6;
    const address = normalizeVirtualAddress(options.host || (family === 6 ? '::' : '0.0.0.0'), family);
    this._closeRequested = false;
    if (configuredCluster(this._config)?._getServer) return this._listenCluster(options, address, family, callback);
    const trackTask = this._config.getTaskTracker?.() || this._config.trackTask;
    const taskRelease = trackTask?.() || null;
    const tcpResource = new AsyncResource('TCPSERVERWRAP');
    this._tcpResource = tcpResource;
    try {
      const result = this._network.bindTcp(this, address, port);
      this._boundPort = result.port;
      this._boundAddress = result.address;
      this._handle = this._createServerHandle();
      this._taskRelease = taskRelease;
      this.listening = true;
      schedule(() => {
        if (this._closeRequested) return;
        const emitListening = () => this._runWithOwner(() => {
          this.emit('listening');
          try { this._config.onListening?.(this.address()); } catch { /* parent may already be terminal */ }
        });
        if (this._tcpResource) this._tcpResource.runInAsyncScope(emitListening, this);
        else emitListening();
      });
    } catch (error) {
      taskRelease?.();
      this._tcpResource = null;
      tcpResource.emitDestroy();
      this.emit('error', error);
      callback?.call(this, error);
    }
    return this;
  }

  _listenPipe(path, callback) {
    if (typeof path !== 'string' || path.length === 0) {
      const error = new TypeError('options.path must be a non-empty string');
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
    if (this.listening) return this;
    if (configuredCluster(this._config)?._getServer) return this._listenClusterPipe(path, callback);
    const trackTask = this._config.getTaskTracker?.() || this._config.trackTask;
    const taskRelease = trackTask?.() || null;
    this._pipeName = path;
    this._pipeResource = new AsyncResource('PIPESERVERWRAP');
    schedule(() => {
      if (this.listening) return;
      try {
        this._network.bindPipe(this, path);
        this._taskRelease = taskRelease;
        this.listening = true;
        this._runWithOwner(() => {
          this.emit('listening');
          try { this._config.onListening?.(path); } catch { /* parent may already be terminal */ }
        });
      } catch (error) {
        taskRelease?.();
        this._pipeResource?.emitDestroy();
        this._pipeResource = null;
        this._pipeName = null;
        this.emit('error', error);
      }
    });
    return this;
  }

  _listenCluster(options, address, family, callback) {
    const port = validatePort(options.port, true);
    schedule(() => {
      if (this.listening) return;
      const query = {
        address,
        port,
        addressType: family,
        ipv6Only: options.ipv6Only === true,
        fd: -1,
        flags: 0,
        backlog: options.backlog,
      };
      try {
        configuredCluster(this._config)._getServer(this, query, (error, handle) => {
          if (error) {
            this.emit('error', error);
            callback?.call(this, error);
            return;
          }
          this._clusterHandle = handle;
          this._handle = handle;
          this._boundAddress = handle.address || address;
          this._boundPort = handle.port;
          this._taskRelease = this._config.trackTask?.() || null;
          this.listening = true;
          this._runWithOwner(() => {
            this.emit('listening');
            try { this._config.onListening?.(this.address()); } catch { /* parent may already be terminal */ }
          });
        });
      } catch (error) {
        this.emit('error', error);
        callback?.call(this, error);
      }
    });
    return this;
  }

  _listenClusterPipe(path, callback) {
    schedule(() => {
      if (this.listening) return;
      try {
        configuredCluster(this._config)._getServer(this, { address: path, port: -1, addressType: -1, fd: -1 }, (error, handle) => {
          if (error) {
            this.emit('error', error);
            callback?.call(this, error);
            return;
          }
          this._clusterHandle = handle;
          this._handle = handle;
          this._pipeName = handle.path || path;
          this._pipeResource = new AsyncResource('PIPESERVERWRAP');
          this._taskRelease = this._config.trackTask?.() || null;
          this.listening = true;
          this._runWithOwner(() => {
            this.emit('listening');
            try { this._config.onListening?.(this.address()); } catch { /* parent may already be terminal */ }
          });
        });
      } catch (error) {
        this.emit('error', error);
        callback?.call(this, error);
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
    this._closeRequested = true;
    if (!this.listening) {
      schedule(() => this.emit('close'));
      return this;
    }
    this._clusterHandle?.close();
    this._clusterHandle = null;
    this._handle?.unref?.();
    this._handle = null;
    const tcpResource = this._tcpResource;
    this._tcpResource = null;
    this._network.unbindTcp(this);
    this._network.unbindPipe?.(this);
    this._taskRelease?.();
    this._taskRelease = null;
    this.listening = false;
    this._boundPort = null;
    this._boundAddress = null;
    const activeSockets = [...this._activeSockets];
    const pipeResource = this._pipeResource;
    this._pipeResource = null;
    this._pipeName = null;
    queueMicrotask(() => pipeResource?.emitDestroy());
    queueMicrotask(() => tcpResource?.emitDestroy());
    schedule(() => {
      this.emit('close');
      schedule(() => activeSockets.forEach((socket) => socket.destroy()));
    });
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
    const family = virtualAddressFamily(connection.localAddress) === 6 ? 'ipv6' : 'ipv4';
    if (this._blockList?.check?.(connection.localAddress, family)) {
      connection.client?.destroy?.();
      return;
    }
    const accepted = connection.serverSocket || this._createAcceptedSocket(connection);
    accepted._peer = connection.client;
    accepted.path = connection.path;
    accepted._pipeResource = connection.serverPipeResource;
    accepted.connecting = false;
    accepted._pending = false;
    accepted._readyState = 'open';
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
    accepted._tcpResource = new AsyncResource('TCPWRAP', {
      triggerAsyncId: this._tcpResource?.asyncId(),
    });
    const emitConnection = () => this._runWithOwner(() => this.emit('connection', accepted));
    if (this._tcpResource) this._tcpResource.runInAsyncScope(emitConnection, this);
    else if (this._pipeResource) this._pipeResource.runInAsyncScope(emitConnection, this);
    else emitConnection();
    if (this._pauseOnConnect) accepted.pause();
  }

  _createServerHandle() {
    const server = this;
    let refed = true;
    return {
      hasRef: () => refed,
      ref() { refed = true; server._unref = false; return this; },
      unref() { refed = false; server._unref = true; return this; },
      close(callback) { refed = false; server._unref = true; server.close(callback); },
      getsockname(address) {
        const value = server.address();
        if (!value || typeof value === 'string') return -1;
        if (address && typeof address === 'object') Object.assign(address, value);
        return 0;
      },
    };
  }

  ref() { this._handle?.ref?.(); this._unref = false; return this; }
  unref() { this._handle?.unref?.(); this._unref = true; return this; }
}

const blockListCloneMarker = Symbol.for('bnh.messaging.cloneablePrototype');

class BrowserSocketAddress {
  constructor(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw blockListError('ERR_INVALID_ARG_TYPE', 'options must be an object');
    }
    const family = options.family === undefined ? 'ipv4' : options.family;
    if (typeof family !== 'string' || !['ipv4', 'ipv6'].includes(family.toLowerCase())) {
      throw blockListError('ERR_INVALID_ARG_VALUE', `invalid address family: ${family}`);
    }
    this.family = family.toLowerCase();
    const defaultAddress = this.family === 'ipv6' ? '::' : '127.0.0.1';
    const address = options.address === undefined ? defaultAddress : options.address;
    if (typeof address !== 'string'
      || (this.family === 'ipv4' ? !isIPv4Literal(address) : !isIPv6Literal(address))) {
      throw blockListError('ERR_INVALID_ARG_TYPE', 'address must be a valid IP address');
    }
    this.address = address;
    const port = options.port === undefined ? 0 : options.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw blockListError('ERR_SOCKET_BAD_PORT', `port must be between 0 and 65535: ${port}`, RangeError);
    }
    this.port = port;
    const flowlabel = options.flowlabel === undefined ? 0 : options.flowlabel;
    if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xfffff) {
      throw blockListError('ERR_OUT_OF_RANGE', `flowlabel must be between 0 and 1048575: ${flowlabel}`, RangeError);
    }
    this.flowlabel = flowlabel;
  }

  static isSocketAddress(value) { return value instanceof BrowserSocketAddress; }

  static parse(value) {
    if (typeof value !== 'string') return undefined;
    const match = value.match(/^\[([^\]]+)\](?::(\d+))?$|^([^:]+)(?::(\d+))?$/);
    if (!match) return undefined;
    const address = match[1] || match[3];
    const port = Number(match[2] || match[4] || 0);
    const family = isIPv6Literal(address) ? 'ipv6' : isIPv4Literal(address) ? 'ipv4' : null;
    if (!family || !Number.isInteger(port) || port < 0 || port > 65535) return undefined;
    return new BrowserSocketAddress({ address, family, port });
  }
}

Object.defineProperty(BrowserSocketAddress.prototype, blockListCloneMarker, {
  configurable: false,
  enumerable: false,
  value: true,
});

function blockListError(code, message, ErrorClass = TypeError) {
  const error = new ErrorClass(`${code}: ${message}`);
  error.code = code;
  return error;
}

function blockListType(type) {
  if (type === undefined) return 'ipv4';
  if (typeof type !== 'string') throw blockListError('ERR_INVALID_ARG_TYPE', 'address type must be a string');
  const normalized = type.toLowerCase();
  if (normalized !== 'ipv4' && normalized !== 'ipv6') {
    throw blockListError('ERR_INVALID_ARG_VALUE', `invalid address type: ${type}`);
  }
  return normalized;
}

function blockListAddress(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.address === 'string') return value.address;
  throw blockListError('ERR_INVALID_ARG_TYPE', 'address must be a string or SocketAddress');
}

function ipv4Number(value) {
  if (!isIPv4Literal(value)) throw blockListError('ERR_INVALID_ARG_VALUE', `invalid IPv4 address: ${value}`);
  return String(value).split('.').reduce((number, part) => (number << 8n) + BigInt(part), 0n);
}

function ipv4String(number) {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((number >> shift) & 255n))
    .join('.');
}

function ipv6Groups(value) {
  const text = String(value).toLowerCase();
  const sections = text.split('::');
  if (sections.length > 2 || !isIPv6Literal(text)) {
    throw blockListError('ERR_INVALID_ARG_VALUE', `invalid IPv6 address: ${value}`);
  }
  const expand = (section) => {
    if (!section) return [];
    const parts = section.split(':');
    const groups = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const number = ipv4Number(part);
        groups.push(Number(number >> 16n), Number(number & 0xffffn));
      } else {
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = expand(sections[0]);
  const right = expand(sections[1] || '');
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sections.length === 1 && missing !== 0)) {
    throw blockListError('ERR_INVALID_ARG_VALUE', `invalid IPv6 address: ${value}`);
  }
  return [...left, ...Array(missing).fill(0), ...right];
}

function blockListAddressValue(value, type) {
  const address = blockListAddress(value);
  if (type === 'ipv4') return { family: 'ipv4', value: ipv4Number(address), display: address };
  const groups = ipv6Groups(address);
  const number = groups.reduce((result, group) => (result << 16n) + BigInt(group), 0n);
  // Node treats IPv4-mapped IPv6 entries as IPv4 rules, including when the
  // caller supplied the IPv6 spelling and type.
  if ((number >> 32n) === 0xffffn) {
    return { family: 'ipv4', value: number & 0xffffffffn, display: ipv4String(number & 0xffffffffn) };
  }
  return { family: 'ipv6', value: number, display: address };
}

function blockListFamilyLabel(family) {
  return family === 'ipv6' ? 'IPv6' : 'IPv4';
}

function blockListPrefix(prefix, family) {
  if (typeof prefix !== 'number') {
    throw blockListError('ERR_INVALID_ARG_TYPE', 'prefix must be a number');
  }
  if (Number.isNaN(prefix)) {
    throw blockListError('ERR_OUT_OF_RANGE', 'prefix must be a number', RangeError);
  }
  const maximum = family === 'ipv6' ? 128 : 32;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
    throw blockListError('ERR_OUT_OF_RANGE', `prefix must be between 0 and ${maximum}`, RangeError);
  }
  return prefix;
}

function blockListMask(family, prefix) {
  const bits = family === 'ipv6' ? 128n : 32n;
  if (prefix === 0) return 0n;
  return ((1n << bits) - 1n) ^ ((1n << (bits - BigInt(prefix))) - 1n);
}

class BrowserBlockList {
  constructor() { this._entries = []; }

  addAddress(value, type = undefined) {
    const resolvedType = type === undefined && value?.family ? value.family : type;
    const parsed = blockListAddressValue(value, blockListType(resolvedType));
    this._entries.push({
      kind: 'address',
      family: parsed.family,
      value: parsed.value,
      display: `Address: ${blockListFamilyLabel(parsed.family)} ${parsed.display}`,
    });
  }

  addRange(start, end, type = undefined) {
    const resolvedType = type === undefined && start?.family ? start.family : type;
    const parsedStart = blockListAddressValue(start, blockListType(resolvedType));
    const parsedEnd = blockListAddressValue(end, blockListType(resolvedType));
    if (parsedStart.family !== parsedEnd.family || parsedStart.value > parsedEnd.value) {
      throw blockListError('ERR_INVALID_ARG_VALUE', 'range start must not be greater than range end');
    }
    this._entries.push({
      kind: 'range',
      family: parsedStart.family,
      start: parsedStart.value,
      end: parsedEnd.value,
      display: `Range: ${blockListFamilyLabel(parsedStart.family)} ${parsedStart.display}-${parsedEnd.display}`,
    });
  }

  addSubnet(network, prefix, type = undefined) {
    const resolvedType = type === undefined && network?.family ? network.family : type;
    const parsed = blockListAddressValue(network, blockListType(resolvedType));
    const normalizedPrefix = blockListPrefix(prefix, parsed.family);
    this._entries.push({
      kind: 'subnet',
      family: parsed.family,
      network: parsed.value & blockListMask(parsed.family, normalizedPrefix),
      prefix: normalizedPrefix,
      display: `Subnet: ${blockListFamilyLabel(parsed.family)} ${parsed.display}/${normalizedPrefix}`,
    });
  }

  check(value, type = undefined) {
    const resolvedType = type === undefined && value?.family ? value.family : type;
    const normalizedType = blockListType(resolvedType);
    const address = blockListAddress(value);
    if (normalizedType === 'ipv4' && isIPv6Literal(address)) return false;
    if (normalizedType === 'ipv6' && isIPv4Literal(address)) return false;
    const parsed = blockListAddressValue(value, normalizedType);
    return this._entries.some((entry) => {
      if (entry.family !== parsed.family) return false;
      if (entry.kind === 'address') return entry.value === parsed.value;
      if (entry.kind === 'range') return parsed.value >= entry.start && parsed.value <= entry.end;
      return (parsed.value & blockListMask(entry.family, entry.prefix)) === entry.network;
    });
  }

  get rules() { return [...this._entries].reverse().map((entry) => entry.display); }
  toJSON() { return this.rules; }

  fromJSON(value) {
    let rules = value;
    if (typeof value === 'string') {
      try { rules = JSON.parse(value); } catch { rules = null; }
    }
    if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string')) {
      throw blockListError('ERR_INVALID_ARG_TYPE', 'rules must be an array of strings');
    }
    for (const rule of rules) {
      const match = /^(Address|Range|Subnet): (IPv4|IPv6) (.+)$/.exec(rule);
      if (!match) continue;
      try {
        if (match[1] === 'Address') this.addAddress(match[3], match[2]);
        else if (match[1] === 'Range') {
          const [start, end] = match[3].split('-', 2);
          this.addRange(start, end, match[2]);
        } else {
          const [network, prefix] = match[3].split('/', 2);
          this.addSubnet(network, Number(prefix), match[2]);
        }
      } catch { /* Invalid serialized rules are ignored by Node. */ }
    }
    return this;
  }

  static isBlockList(value) { return value instanceof BrowserBlockList; }

  [Symbol.for('nodejs.util.inspect.custom')](depth) {
    if (depth < 0) return '[BlockList]';
    return `BlockList { rules: ${JSON.stringify(this.rules)} }`;
  }
}

// The messaging adapter uses this marker to make a detached BlockList clone
// while retaining the methods Node exposes on the cloned built-in.
Object.defineProperty(BrowserBlockList.prototype, blockListCloneMarker, {
  configurable: false,
  enumerable: false,
  value: true,
});

const defaultConfig = { network: sharedVirtualNetwork, dns: createBrowserDns() };

export function createBrowserNet({ network = sharedVirtualNetwork, dns = createBrowserDns(), transport, BufferClass, trackTask, getTaskTracker = () => trackTask, currentProcess, runInProcessContext, onListening, cluster } = {}) {
  const configuredNetwork = transport && network === sharedVirtualNetwork ? createVirtualNetwork({ transport }) : network;
  const config = {
    network: configuredNetwork,
    dns,
    transport,
    BufferClass,
    trackTask,
    getTaskTracker,
    currentProcess,
    runInProcessContext,
    onListening,
    cluster,
  };
  const ConfiguredSocket = class BrowserNetSocket extends Socket {
    constructor(options = {}) { super(options, config); }
  };
  const ConfiguredServer = class BrowserNetServer extends Server {
    constructor(options = {}, listener) { super(options, listener, { ...config, SocketClass: ConfiguredSocket }); }
  };
  function CallableSocket(...args) {
    const receiver = this;
    if (receiver && receiver instanceof ConfiguredSocket) {
      const instance = new ConfiguredSocket(...args);
      for (const key of Reflect.ownKeys(instance)) {
        Object.defineProperty(receiver, key, Object.getOwnPropertyDescriptor(instance, key));
      }
      return receiver;
    }
    return new ConfiguredSocket(...args);
  }
  CallableSocket.prototype = ConfiguredSocket.prototype;
  function CallableServer(...args) {
    return new ConfiguredServer(...args);
  }
  CallableServer.prototype = ConfiguredServer.prototype;
  return {
    Socket: CallableSocket,
    Stream: CallableSocket,
    Server: CallableServer,
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
    SocketAddress: BrowserSocketAddress,
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
export const SocketAddress = defaultNet.SocketAddress;
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
  SocketAddress,
};
