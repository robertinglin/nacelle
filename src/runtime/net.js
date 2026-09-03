import { EventEmitter } from './events.js';
import { Duplex } from './streams.js';
import { createBrowserDns } from './dns.js';
import { AsyncResource, ownerSymbol } from './async-hooks.js';
import { createVirtualNetwork, sharedVirtualNetwork, normalizeVirtualAddress, virtualAddressFamily } from './virtual-network.js';

let nextClientPort = 62000;
let nextReusePortGroup = 1;
const reusePortGroups = new WeakMap();
const socketHandle = Symbol('socketHandle');
// Keep the Node compatibility symbol stable across realms. Some runtimes
// expose Symbol.asyncDispose as a distinct symbol, while Node's fallback API
// is observable through Symbol.for('nodejs.asyncDispose').
const SymbolAsyncDispose = Symbol.for('nodejs.asyncDispose');
const NativeSymbolAsyncDispose = Symbol.asyncDispose;
const inspectCustomSymbol = Symbol.for('nodejs.util.inspect.custom');

function exposeNativeAsyncDispose(ctor) {
  if (!NativeSymbolAsyncDispose || NativeSymbolAsyncDispose === SymbolAsyncDispose) return;
  Object.defineProperty(ctor.prototype, NativeSymbolAsyncDispose, {
    value: ctor.prototype[SymbolAsyncDispose],
    writable: true,
    configurable: true,
  });
}

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

function socketAbortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function waitForSocketClose(socket, expectedError) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.off?.('close', onClose);
      socket.off?.('error', onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error && error !== expectedError) reject(error);
      else resolve(null);
    };
    const onError = (error) => {
      if (error !== expectedError) finish(error);
    };
    const onClose = () => {
      const streamError = socket.errored;
      if (streamError && streamError !== expectedError) {
        finish(streamError);
        return;
      }
      if (!expectedError && !socket.readableEnded) {
        const error = new Error('Premature close');
        error.code = 'ERR_STREAM_PREMATURE_CLOSE';
        finish(error);
        return;
      }
      finish();
    };
    socket.once('close', onClose);
    socket.once('error', onError);
    if (socket.closed) queueMicrotask(onClose);
  });
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

function receivedArgument(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `type ${typeof value} (${value})`;
  }
  return `an instance of ${value?.constructor?.name || typeof value}`;
}

function invalidArgumentType(name, expected, value) {
  const expectation = Array.isArray(expected)
    ? `one of type ${expected.join(' or ')}`
    : `type ${expected}`;
  const error = new TypeError(
    `The "${name}" argument must be ${expectation}. Received ${receivedArgument(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidAddressFamilyError(family, host, port) {
  const error = new Error(`Invalid address family: ${family} ${host}:${port}`);
  error.code = 'ERR_INVALID_ADDRESS_FAMILY';
  error.host = host;
  error.port = port;
  return error;
}

function validateConnectPort(port) {
  if ((typeof port !== 'number' && typeof port !== 'string')
    || (typeof port === 'string' && port.trim().length === 0)) {
    throw invalidArgumentType('options.port', ['number', 'string'], port);
  }
  return validatePort(port, true);
}

function serverNotRunningError() {
  const error = new Error('Server is not running');
  error.code = 'ERR_SERVER_NOT_RUNNING';
  return error;
}

function parseConnectArgs(args) {
  const normalized = normalizeArgs(args);
  return { options: normalized[0], callback: normalized[1] };
}

function parseListenArgs(args) {
  const normalized = normalizeArgs(args);
  return { options: normalized[0], callback: normalized[1] };
}

function isPipeName(value) {
  return typeof value === 'string' && !(Number(value) >= 0);
}

function resolvePipePath(path, processObject) {
  if (typeof path !== 'string' || path.length === 0) return path;
  const cwd = String(processObject?.cwd?.() || '/node').replace(/\/+$/, '') || '/';
  const source = path.startsWith('/') ? path : `${cwd}/${path}`;
  const parts = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function normalizeArgs(args) {
  if (args.length === 0) return [{}, null];
  const arg0 = args[0];
  let options = {};
  if (typeof arg0 === 'object' && arg0 !== null) options = arg0;
  else if (isPipeName(arg0)) options.path = arg0;
  else {
    options.port = arg0;
    if (typeof args[1] === 'string') options.host = args[1];
  }
  const callback = typeof args.at(-1) === 'function' ? args.at(-1) : null;
  return [options, callback];
}

function nextLocalPort() {
  nextClientPort += 1;
  if (nextClientPort > 65000) nextClientPort = 62000;
  return nextClientPort;
}

function reusePortEndpointKey(address, port) {
  return `${address}:${port}`;
}

function reusePortGroupId(network, address, port) {
  // A fixed endpoint gets one browser-local fan-out group, matching the
  // kernel's SO_REUSEPORT behavior without opening a host socket. Ephemeral
  // listeners must remain independent because their selected ports differ.
  const groups = reusePortGroups.get(network) || new Map();
  reusePortGroups.set(network, groups);
  if (port) {
    const key = reusePortEndpointKey(address, port);
    const existing = groups.get(key);
    if (existing) return existing;
    const groupId = `bnh-reuse-port:${address}:${port}`;
    groups.set(key, groupId);
    return groupId;
  }
  return `bnh-reuse-port:${address}:ephemeral:${nextReusePortGroup++}`;
}

/** A Node-shaped Duplex socket whose transport is entirely browser-local. */
export class Socket extends Duplex {
  constructor(options = {}, internal = {}) {
    super({ highWaterMark: options.highWaterMark, autoDestroy: false });
    this._network = internal.network || sharedVirtualNetwork;
    this._dns = internal.dns || createBrowserDns();
    this._bufferClass = internal.BufferClass;
    this._handle = options.handle || null;
    if (this._handle && typeof this._handle === 'object') this._handle[ownerSymbol] = this;
    this._transport = internal.transport;
    this._performance = internal.performance;
    this._taskTracker = internal.getTaskTracker?.() || internal.trackTask || null;
    this._taskRelease = null;
    this._unrefed = false;
    this.allowHalfOpen = options.allowHalfOpen ?? true;
    this.connecting = false;
    this._pending = true;
    this._readyState = 'open';
    this._noDelay = Boolean(options.noDelay);
    this._keepAlive = Boolean(options.keepAlive);
    this._keepAliveInitialDelay = ~~(options.keepAliveInitialDelay / 1000);
    this._peername = null;
    this._sockname = null;
    this.autoSelectFamilyAttemptedAddresses = undefined;
    this.path = undefined;
    this._bytesRead = 0;
    this._bytesWritten = 0;
    this._peer = null;
    this._transportPeer = null;
    this._tcpResource = null;
    this._tcpConnectResource = null;
    this._tcpConnectResources = new Set();
    this._connectAttempt = null;
    this._pendingWrite = null;
    this._writeDispatched = false;
    this._timeout = null;
    this._closing = false;
    this._writable._write = (bytes, encoding, callback) => this._write(bytes, encoding, callback);
    this._writable._final = (callback) => this._final(callback);
  }

  _activateTask() {
    if (!this._unrefed && !this._taskRelease) this._taskRelease = this._taskTracker?.() || null;
  }

  _releaseTask() {
    this._taskRelease?.();
    this._taskRelease = null;
  }

  on(name, listener) {
    const result = super.on(name, listener);
    if (name === 'data') this.resume();
    return result;
  }

  connect(...args) {
    const { options, callback } = parseConnectArgs(args);
    if (callback) this.once('connect', callback);
    if (options.port === undefined && options.path == null) {
      const error = new TypeError('The "options" or "port" or "path" argument must be specified');
      error.code = 'ERR_MISSING_ARGS';
      throw error;
    }
    if (options.timeout) this.setTimeout(options.timeout);
    if (this.connecting || !this.pending) {
      schedule(() => this.emit('error', socketError('ERR_SOCKET_ALREADY_CONNECTED', 'connect', options.host || 'localhost', options.port)));
      return this;
    }
    const attempt = { settled: false };
    this._connectAttempt = attempt;
    if (options.path !== undefined) return this._connectPipe(options.path, options);
    if (!this._tcpResource) this._tcpResource = new AsyncResource('TCPWRAP');
    const port = validateConnectPort(options.port);
    if (options.lookup != null && typeof options.lookup !== 'function') {
      throw invalidArgumentType('options.lookup', 'function', options.lookup);
    }
    const host = String(options.host || options.hostname || 'localhost');
    const family = Number(options.family || 0);
    this.connecting = true;
    this._pending = true;
    this._readyState = 'opening';
    this._activateTask();
    this._connectOptions = { ...options, port, host, family };
    this._performanceStart = this._performance ? (this._network.performance?.now?.() || globalThis.performance?.now?.() || 0) : 0;
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
        if (candidates[0].family !== 4 && candidates[0].family !== 6) {
          this._failConnect(invalidAddressFamilyError(candidates[0].family, host, port));
          return;
        }
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
        if (candidateFamily !== 4 && candidateFamily !== 6) {
          settled = true;
          this._failConnect(invalidAddressFamilyError(candidateFamily, host, port));
          return;
        }
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
    const attempt = this._connectAttempt;
    let connectResource = null;
    // Documentation-only networks are intentionally unroutable. Keep their
    // connection pending when the browser-local network has no egress route,
    // so Socket#setTimeout can deliver the observable timeout event instead
    // of converting the black hole into ECONNREFUSED. Let a configured
    // network transport see the request first; it is the only browser-native
    // route that can connect an external address.
    const preserveBlackholeTimeout = !options.autoSelectFamily && isVirtualBlackholeAddress(address);
    const reportError = (error) => {
      this._releaseConnectResource(connectResource);
      if (this.destroyed || this._connectAttempt !== attempt || attempt?.settled) return;
      if (preserveBlackholeTimeout && error?.code === 'ECONNREFUSED') return;
      onError(error);
    };
    if (options.blockList?.check?.(address, family === 6 ? 'ipv6' : 'ipv4')) {
      schedule(() => reportError(socketError('ERR_IP_BLOCKED', 'connect', address, port)));
      return;
    }
    const localAddress = options.localAddress
      ? normalizeVirtualAddress(options.localAddress, family)
      : (family === 6 ? '::1' : '127.0.0.1');
    const localPort = options.localPort === undefined ? nextLocalPort() : validatePort(options.localPort, true);
    schedule(() => {
      if (this.destroyed || this._connectAttempt !== attempt || attempt?.settled) return;
      connectResource = new AsyncResource('TCPCONNECTWRAP', {
        triggerAsyncId: this._tcpResource?.asyncId(),
      });
      this._tcpConnectResource = connectResource;
      this._tcpConnectResources.add(connectResource);
      this._network.connectTcp({
        address,
        port,
        hostname: this._connectOptions?.host || this._connectOptions?.hostname || address,
        client: this,
        localAddress,
        localPort,
        onConnected: (connection) => {
          if (this.destroyed || this._connectAttempt !== attempt || attempt?.settled) {
            this._releaseConnectResource(connectResource);
            return false;
          }
          if (onConnected(connection) === false) {
            this._releaseConnectResource(connectResource);
            return false;
          }
          return this._establish(connection, family, attempt, connectResource);
        },
        onError: reportError,
      });
    });
  }

  _createPipeResource(type, parent) {
    const triggerAsyncId = parent?.asyncId?.();
    return new AsyncResource(type, triggerAsyncId === undefined ? {} : { triggerAsyncId });
  }

  _connectPipe(path, options) {
    if (typeof path !== 'string') {
      throw invalidArgumentType('options.path', 'string', path);
    }
    if (path.length === 0) {
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
    this._activateTask();
    const resolvedPath = resolvePipePath(path, this._ownerProcess);
    this.path = resolvedPath;
    this._connectOptions = { ...options, path: resolvedPath };
    this._network.connectPipe({
      path: resolvedPath,
      client: this,
      onConnected: (connection) => this._establish(connection, undefined, this._connectAttempt),
      onError: (error) => {
        if (error?.code === 'ECONNREFUSED') {
          const missing = new Error(`connect ENOENT ${resolvedPath}`);
          missing.code = 'ENOENT';
          missing.errno = 'ENOENT';
          missing.syscall = 'connect';
          missing.address = resolvedPath;
          this._failConnect(missing);
          return;
        }
        this._failConnect(error);
      },
    });
    return this;
  }

  _releaseConnectResource(resource) {
    if (!resource || !this._tcpConnectResources.delete(resource)) return;
    if (this._tcpConnectResource === resource) this._tcpConnectResource = null;
    queueMicrotask(() => resource.emitDestroy());
  }

  _establish(connection, family, attempt = this._connectAttempt, connectResource = this._tcpConnectResource) {
    if (this.destroyed || this._connectAttempt !== attempt || attempt?.settled) return false;
    if (attempt) attempt.settled = true;
    for (const resource of [...this._tcpConnectResources]) this._releaseConnectResource(resource);
    this._timeout && clearTimeout(this._timeout);
    this._timeout = null;
    this.connecting = false;
    this._pending = false;
    this._readyState = 'open';
    this._sockname = {
      address: connection.localAddress || undefined,
      family: connection.localAddress
        ? (virtualAddressFamily(connection.localAddress) === 6 ? 'IPv6' : 'IPv4')
        : undefined,
      port: connection.localPort || undefined,
    };
    this._peername = {
      address: connection.remoteAddress,
      port: connection.remotePort,
      family: family ? (family === 6 ? 'IPv6' : 'IPv4') : undefined,
    };
    this.path = connection.path;
    if (this._performance && !this._performanceRecorded && this._connectOptions?.path === undefined) {
      this._performanceRecorded = true;
      const now = globalThis.performance?.now?.() || this._performanceStart;
      this._performance({
        name: 'connect',
        entryType: 'net',
        startTime: this._performanceStart,
        duration: Math.max(0, now - this._performanceStart),
        detail: {
          host: String(this._connectOptions.host || this._connectOptions.hostname || ''),
          port: Number(this._connectOptions.port),
        },
        toJSON() {
          return {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration,
            detail: this.detail,
          };
        },
      });
    }
    this._pipeResource = connection.pipeResource;
    this._pipeConnectResource = connection.pipeConnectResource;
    this._bnhVirtualTransport = Boolean(connection.transport?.virtualTls);
    if (connection.transport) this._attachTransport(connection.transport);
    else this._peer = connection.serverSocket;
    const handle = this._handle || this._transportPeer;
    if (this._noDelay && handle?.setNoDelay) handle.setNoDelay(true);
    if (this._keepAlive && handle?.setKeepAlive) {
      handle.setKeepAlive(true, this._keepAliveInitialDelay);
    }
    const emitConnect = () => this.emit('connect');
    const pipeConnectResource = this._pipeConnectResource;
    const establishedResource = pipeConnectResource || connectResource;
    this._pipeConnectResource = null;
    this._tcpConnectResource = null;
    if (establishedResource) {
      if (pipeConnectResource) queueMicrotask(() => establishedResource.emitDestroy());
      establishedResource.runInAsyncScope(emitConnect, this);
      if (!pipeConnectResource) this._releaseConnectResource(establishedResource);
    } else emitConnect();
    this._flushPendingWrite();
    return true;
  }

  _runTcpResource(callback) {
    if (this._tcpResource) return this._tcpResource.runInAsyncScope(callback, this);
    return callback();
  }

  _failConnect(error) {
    if (this.destroyed || (this._connectAttempt?.settled && !this.connecting)) return;
    if (this._connectAttempt) this._connectAttempt.settled = true;
    this.connecting = false;
    this._pending = false;
    this._readyState = 'closed';
    this.destroy(error);
  }

  _attachTransport(peer) {
    this._transportPeer = peer;
    peer.on?.('data', (bytes) => {
      const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this._bytesRead += value.byteLength;
      this._runTcpResource(() => this.push(nodeBytes(value, this._bufferClass)));
    });
    peer.on?.('end', () => this._runTcpResource(() => this.push(null)));
    peer.on?.('error', (error) => this.destroy(error));
  }

  _flushPendingWrite() {
    if (this._pendingWrite) {
      const { bytes, callback } = this._pendingWrite;
      this._pendingWrite = null;
      this._send(bytes, callback);
    }
    if (this._pendingWrites?.length) {
      const writes = this._pendingWrites.splice(0);
      for (const { bytes, callback } of writes) {
        this._send(bytes, callback);
      }
    }
  }

  _writeGeneric(writev, data, _encoding, callback) {
    let bytes;
    if (writev) {
      const chunks = data.map(({ chunk }) => chunk instanceof Uint8Array
        ? chunk
        : typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk || 0));
      bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data && typeof data.byteLength === 'number') {
      bytes = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
    } else {
      bytes = new Uint8Array(0);
    }

    if (this._peer || this._transportPeer) this._send(bytes, callback);
    else if (this.connecting) {
      if (!this._pendingWrites) this._pendingWrites = [];
      this._pendingWrites.push({ bytes, callback });
    }
    else callback(socketError('EPIPE', 'write', this.remoteAddress || 'socket', this.remotePort || 0));
  }

  _write(bytes, encoding, callback) {
    return this._writeGeneric(false, bytes, encoding, callback);
  }

  _writev(chunks, callback) {
    const values = chunks.map(({ chunk }) => chunk instanceof Uint8Array
      ? chunk
      : new TextEncoder().encode(String(chunk)));
    const total = values.reduce((size, value) => size + value.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const value of values) {
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    this._write(bytes, 'buffer', callback);
  }

  end(...args) {
    if (!this.destroyed && this.readyState === 'open') this._readyState = 'readOnly';
    return super.end(...args);
  }

  _send(bytes, callback) {
    const peer = this._peer;
    const transport = this._transportPeer;
    this._writeDispatched = false;
    schedule(() => {
      if (peer) {
        if (peer.destroyed) {
          callback(socketError('EPIPE', 'write', this.remoteAddress || 'socket', this.remotePort || 0));
          return;
        }
        this._bytesWritten += bytes.byteLength;
        this._writeDispatched = true;
        peer._bytesRead += bytes.byteLength;
        globalThis.__bnhGatewayLogs?.push?.({ type: 'net-send', len: bytes.byteLength, sample: new TextDecoder().decode(bytes).slice(0, 50) });
        peer._runTcpResource?.(() => peer.push(nodeBytes(bytes, peer._bufferClass)));
        callback();
        return;
      }
      if (transport?.write) {
        this._bytesWritten += bytes.byteLength;
        this._writeDispatched = true;
        let completed = false;
        const complete = (error) => {
          if (completed) return;
          completed = true;
          callback(error);
        };
        try {
          const result = transport.write(bytes, complete);
          if (result && typeof result.then === 'function') result.then(() => complete(), complete);
        } catch (error) {
          complete(error);
        }
        return;
      }
      callback(socketError('EPIPE', 'write', this.remoteAddress || 'socket', this.remotePort || 0));
    });
  }

  _final(callback) {
    if (this.connecting) {
      this.once('connect', () => this._final(callback));
      return;
    }
    if (!this._handle && !this._peer && !this._transportPeer) {
      callback();
      return;
    }
    this._finishTransport(callback);
  }

  _finishTransport(callback) {
    globalThis.__bnhGatewayLogs?.push?.({ type: 'net-finish-transport', stack: new Error().stack, bytesWritten: this._bytesWritten });
    if (!this.destroyed && this.readyState === 'open') this._readyState = 'readOnly';
    const shutdownParent = this._pipeResource || this._tcpResource;
    const shutdownResource = shutdownParent ? this._createPipeResource('SHUTDOWNWRAP', shutdownParent) : null;
    let completed = false;
    const complete = (error) => {
      if (completed) return;
      completed = true;
      const finish = () => error ? callback(error) : callback();
      if (shutdownResource) shutdownResource.runInAsyncScope(finish, this);
      else finish();
      if (shutdownResource) queueMicrotask(() => shutdownResource.emitDestroy());
    };
    if (this._transportPeer?.end) {
      try {
        const result = this._transportPeer.end(complete);
        if (result && typeof result.then === 'function') result.then(() => complete(), complete);
      } catch (error) { complete(error); }
      return;
    }
    const peer = this._peer;
    if (peer && !peer.destroyed) {
      // A TLS wrapper can finish its raw socket while the connect event is
      // still flushing a write queued by tlsSocket.end(data). Let that write
      // dispatch before delivering the peer's EOF; otherwise the peer drops
      // the application bytes as push-after-EOF.
      schedule(() => schedule(() => {
        if (!peer.destroyed) peer.push(null);
      }));
    }
    schedule(() => {
      if (this._tcpResource) this._tcpResource.runInAsyncScope(complete, this);
      else complete();
    });
  }

  _onTimeout() {
    this._timeout = null;
    this.emit('timeout');
  }

  _unrefTimer() {
    for (let stream = this; stream !== null; stream = stream._parent) {
      stream._timeout?.refresh?.();
    }
  }

  _read(n) {
    if (this.connecting) this.once('connect', () => this._read(n));
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
    return this._getsockname();
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

  pause() {
    const handle = this._handle;
    if (handle?.reading && !this.connecting) {
      handle.reading = false;
      if (!this.destroyed && handle.readStop) {
        const error = handle.readStop();
        if (error) this.destroy(socketError('EIO', 'read', this.remoteAddress || 'socket', this.remotePort || 0));
      }
    }
    return super.pause();
  }

  resume() {
    const handle = this._handle;
    if (handle && !this.connecting && !handle.reading && handle.readStart) {
      handle.reading = true;
      const error = handle.readStart();
      if (error) this.destroy(socketError('EIO', 'read', this.remoteAddress || 'socket', this.remotePort || 0));
    }
    return super.resume();
  }

  read(size) {
    const handle = this._handle;
    if (handle && !this.connecting && !handle.reading && handle.readStart) {
      handle.reading = true;
      const error = handle.readStart();
      if (error) this.destroy(socketError('EIO', 'read', this.remoteAddress || 'socket', this.remotePort || 0));
    }
    return super.read(size);
  }

  setTimeout(milliseconds, callback) {
    if (this.destroyed) return this;
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
    this.timeout = milliseconds;
    if (this._timeout) clearTimeout(this._timeout);
    this._timeout = null;
    if (milliseconds === 0) {
      if (callback !== undefined) this.removeListener('timeout', callback);
      return this;
    }
    if (callback) this.once('timeout', callback);
    this._timeout = setTimeout(() => this._onTimeout(), milliseconds);
    this._timeout?.unref?.();
    return this;
  }

  ref() {
    this._unrefed = false;
    if (!this.destroyed && (this.connecting || !this.pending)) this._activateTask();
    this._handle?.ref?.();
    return this;
  }
  unref() {
    this._unrefed = true;
    this._releaseTask();
    this._handle?.unref?.();
    return this;
  }
  destroySoon() {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
    else this.once('finish', this.destroy);
  }
  _reset() { return this.resetAndDestroy(); }

  _getpeername() {
    if (!this._handle || !this._handle.getpeername || this.connecting) {
      return this._peername || {};
    }
    if (!this._peername) {
      const out = {};
      const error = this._handle.getpeername(out);
      if (error) return out;
      this._peername = out;
    }
    return this._peername;
  }

  _getsockname() {
    if (!this._handle || !this._handle.getsockname) {
      return this._sockname || {};
    }
    if (!this._sockname) {
      this._sockname = {};
      this._handle.getsockname(this._sockname);
    }
    return this._sockname;
  }

  get bytesRead() { return this._handle ? this._handle.bytesRead : this._bytesRead; }
  get _bytesDispatched() { return this._handle ? this._handle.bytesWritten : this._bytesWritten; }
  get bytesWritten() {
    let bytes = this._bytesDispatched;
    const current = this._writable?._current;
    if (this._pendingWrite) bytes += this._pendingWrite.bytes?.byteLength ?? this._pendingWrite.bytes?.length ?? 0;
    else if (current && !current.settled && !this._writeDispatched) {
      bytes += current.bytes?.byteLength ?? current.bytes?.length ?? 0;
    }
    for (const request of this._writable?._queue || []) {
      bytes += request.bytes?.byteLength ?? request.bytes?.length ?? 0;
    }
    return bytes;
  }
  get remoteAddress() { return this._getpeername().address; }
  get remoteFamily() { return this._getpeername().family; }
  get remotePort() { return this._getpeername().port; }
  get localAddress() { return this._getsockname().address; }
  get localPort() { return this._getsockname().port; }
  get localFamily() { return this._getsockname().family; }

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

  _destroy(error, callback) {
    if (this._timeout) clearTimeout(this._timeout);
    this._timeout = null;
    if (this._connectAttempt) this._connectAttempt.settled = true;
    for (const resource of [...this._tcpConnectResources]) this._releaseConnectResource(resource);
    this._releaseTask();
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
    callback(error);
  }

  destroy(error) {
    if (this._closing) return this;
    this._closing = true;
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

  async [SymbolAsyncDispose]() {
    let error;
    if (!this.destroyed) {
      error = this.readableEnded ? null : socketAbortError();
      this.destroy(error);
    }
    await waitForSocketClose(this, error);
  }
}

exposeNativeAsyncDispose(Socket);

Object.defineProperty(Socket.prototype, '_handle', {
  configurable: false,
  enumerable: false,
  get() { return this[socketHandle] || null; },
  set(value) { this[socketHandle] = value; },
});

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
    this._taskTracker = null;
    this._closeRequested = false;
    this._clusterHandle = null;
    this._reusePortBinding = null;
    this._handle = null;
    this._unref = false;
    this._connections = 0;
    this._usingWorkers = false;
    this._workers = [];
    this._closeEmitted = false;
    this._ownerProcess = internal.currentProcess?.() || null;
    this._ownerDisconnectListener = null;
    this._listening = false;
    this.maxConnections = undefined;
    if (typeof connectionListener === 'function') this.on('connection', connectionListener);
  }

  _runWithOwner(callback) {
    if (!this._ownerProcess || !this._config.runInProcessContext) return callback();
    return this._config.runInProcessContext(this._ownerProcess, callback);
  }

  _listen2(address, port, addressType) {
    const family = addressType === 6 ? 6 : 4;
    const host = address || (family === 6 ? '::' : '0.0.0.0');
    return this.listen({ port: port ?? 0, host });
  }

  listen(...args) {
    if (this._handle) {
      const error = new Error('Server is already listening');
      error.code = 'ERR_SERVER_ALREADY_LISTEN';
      throw error;
    }
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
    this._closeEmitted = false;
    if (configuredCluster(this._config)?._getServer) return this._listenCluster(options, address, family, callback);
    const trackTask = this._config.getTaskTracker?.() || this._config.trackTask;
    this._taskTracker = trackTask;
    const taskRelease = this._unref ? null : trackTask?.() || null;
    const tcpResource = new AsyncResource('TCPSERVERWRAP');
    this._tcpResource = tcpResource;
    try {
      let result;
      if (options.reusePort && typeof this._network.bindClusterTcp === 'function') {
        const groupId = reusePortGroupId(this._network, address, port);
        result = this._network.bindClusterTcp(groupId, address, port, {
          ipv6Only: options.ipv6Only === true,
        });
        result.addServer?.(this);
        if (!port) {
          const groups = reusePortGroups.get(this._network);
          groups?.set(reusePortEndpointKey(address, result.port), groupId);
        }
        this._reusePortBinding = result;
      } else {
        result = this._network.bindTcp(this, address, port);
      }
      this._boundPort = result.port;
      this._boundAddress = result.address;
      this._handle = this._createServerHandle();
      this._taskRelease = taskRelease;
      this._listening = true;
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
    const resolvedPath = resolvePipePath(path, this._ownerProcess);
    if (configuredCluster(this._config)?._getServer) return this._listenClusterPipe(resolvedPath, callback);
    const trackTask = this._config.getTaskTracker?.() || this._config.trackTask;
    this._taskTracker = trackTask;
    const taskRelease = this._unref ? null : trackTask?.() || null;
    this._pipeName = resolvedPath;
    this._pipeResource = new AsyncResource('PIPESERVERWRAP');
    schedule(() => {
      if (this.listening || this._closeRequested) {
        taskRelease?.();
        this._pipeResource?.emitDestroy();
        this._pipeResource = null;
        this._pipeName = null;
        return;
      }
      try {
        this._network.bindPipe(this, resolvedPath);
        this._taskRelease = taskRelease;
        this._listening = true;
        this._runWithOwner(() => {
          this.emit('listening');
          try { this._config.onListening?.(resolvedPath); } catch { /* parent may already be terminal */ }
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
    const trackTask = this._config.getTaskTracker?.() || this._config.trackTask;
    this._taskTracker = trackTask;
    let settled = false;
    schedule(() => {
      if (this.listening || this._closeRequested) return;
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
          if (settled) return;
          settled = true;
          if (error) {
            this.emit('error', error);
            callback?.call(this, error);
            return;
          }
          if (this._closeRequested) {
            handle.close?.();
            return;
          }
          this._clusterHandle = handle;
          this._handle = handle;
          this._boundAddress = handle.address || address;
          this._boundPort = handle.port;
          this._taskRelease = this._unref ? null : trackTask?.() || null;
          this._listening = true;
          this._ownerDisconnectListener = () => {
            this._ownerDisconnectListener = null;
            if (this.listening) this.close();
          };
          this._ownerProcess?.once?.('disconnect', this._ownerDisconnectListener);
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
    path = resolvePipePath(path, this._ownerProcess);
    const trackTask = this._config.getTaskTracker?.() || this._config.trackTask;
    this._taskTracker = trackTask;
    let settled = false;
    schedule(() => {
      if (this.listening || this._closeRequested) return;
      try {
        configuredCluster(this._config)._getServer(this, { address: path, port: -1, addressType: -1, fd: -1 }, (error, handle) => {
          if (settled) return;
          settled = true;
          if (error) {
            this.emit('error', error);
            callback?.call(this, error);
            return;
          }
          if (this._closeRequested) {
            handle.close?.();
            return;
          }
          this._clusterHandle = handle;
          this._handle = handle;
          this._pipeName = handle.path || path;
          this._pipeResource = new AsyncResource('PIPESERVERWRAP');
          this._taskRelease = this._unref ? null : trackTask?.() || null;
          this._listening = true;
          this._ownerDisconnectListener = () => {
            this._ownerDisconnectListener = null;
            if (this.listening) this.close();
          };
          this._ownerProcess?.once?.('disconnect', this._ownerDisconnectListener);
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

  get listening() {
    return this._listening;
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
    const wasListening = this.listening;
    if (typeof callback === 'function') {
      this.once('close', () => callback(wasListening ? undefined : serverNotRunningError()));
    }
    this._closeRequested = true;
    if (this._ownerDisconnectListener) {
      this._ownerProcess?.off?.('disconnect', this._ownerDisconnectListener);
      this._ownerDisconnectListener = null;
    }
    if (!wasListening) {
      this._emitCloseIfDrained();
      return this;
    }
    this._clusterHandle?.close();
    this._clusterHandle = null;
    this._handle?.unref?.();
    this._handle = null;
    const tcpResource = this._tcpResource;
    this._tcpResource = null;
    if (this._reusePortBinding) {
      this._reusePortBinding.removeServer?.(this);
      this._reusePortBinding = null;
    } else {
      this._network.unbindTcp(this);
    }
    this._network.unbindPipe?.(this);
    this._taskRelease?.();
    this._taskRelease = null;
    this._listening = false;
    this._boundPort = null;
    this._boundAddress = null;
    const pipeResource = this._pipeResource;
    this._pipeResource = null;
    this._pipeName = null;
    queueMicrotask(() => pipeResource?.emitDestroy());
    queueMicrotask(() => tcpResource?.emitDestroy());
    if (this._ownerProcess && this._ownerProcess.connected === false) {
      for (const socket of [...this._activeSockets]) socket.destroy();
    }
    this._emitCloseIfDrained();
    return this;
  }

  getConnections(callback) {
    const workers = this._usingWorkers ? [...this._workers] : [];
    if (!workers.length) {
      schedule(() => callback?.(null, this._connections));
      return this;
    }
    let remaining = workers.length;
    let total = this._connections;
    let finished = false;
    const done = (error, count = 0) => {
      if (finished) return;
      if (error) {
        finished = true;
        schedule(() => callback?.(error));
        return;
      }
      total += count;
      if (--remaining === 0) {
        finished = true;
        schedule(() => callback?.(null, total));
      }
    };
    for (const worker of workers) {
      try {
        if (typeof worker.getConnections === 'function') worker.getConnections(done);
        else done(null, 0);
      } catch (error) {
        done(error);
      }
    }
    return this;
  }

  _emitCloseIfDrained() {
    if (!this._closeRequested || this._handle || this._connections || this._closeEmitted) return;
    this._closeEmitted = true;
    schedule(() => this._runWithOwner(() => this.emit('close')));
  }

  _setupWorker(socketList) {
    this._usingWorkers = true;
    this._workers.push(socketList);
    socketList?.once?.('exit', () => {
      const index = this._workers.indexOf(socketList);
      if (index !== -1) this._workers.splice(index, 1);
    });
    return this;
  }

  _createAcceptedSocket() {
    return new this._SocketClass({ allowHalfOpen: this._allowHalfOpen }, this._config);
  }

  _createPipeResource(type, parent) {
    const triggerAsyncId = parent?.asyncId?.();
    return new AsyncResource(type, triggerAsyncId === undefined ? {} : { triggerAsyncId });
  }

  _acceptConnection(connection) {
    globalThis.__bnhGatewayLogs?.push?.({
      type: 'net-accept-server',
      port: this._boundPort,
      listeners: this.listenerCount?.('connection'),
      socket: Boolean(connection.serverSocket),
    });
    const family = virtualAddressFamily(connection.localAddress) === 6 ? 'ipv6' : 'ipv4';
    if (this._blockList?.check?.(connection.localAddress, family)) {
      connection.client?.destroy?.();
      return;
    }
    const accepted = connection.serverSocket || this._createAcceptedSocket(connection);
    accepted.server = this;
    accepted._server = this;
    accepted._peer = connection.client;
    if (connection.client?._tlsClientOptions) {
      accepted._tlsClientOptions = connection.client._tlsClientOptions;
    }
    if (connection.client && !connection.client._transportPeer && !connection.client.destroyed) {
      connection.client._peer = accepted;
    }
    accepted.path = connection.path;
    accepted._pipeResource = connection.serverPipeResource;
    accepted.connecting = false;
    accepted._pending = false;
    accepted._readyState = 'open';
    accepted._activateTask?.();
    accepted._sockname = {
      address: connection.remoteAddress || '127.0.0.1',
      family: connection.remoteAddress
        ? (virtualAddressFamily(connection.remoteAddress) === 6 ? 'IPv6' : 'IPv4')
        : 'IPv4',
      port: this._boundPort,
    };
    accepted._peername = {
      address: connection.localAddress || '127.0.0.1',
      port: connection.localPort,
      family: connection.localAddress
        ? accepted.localFamily
        : 'IPv4',
    };
    this._activeSockets.add(accepted);
    this._connections += 1;
    accepted.once('close', () => {
      this._activeSockets.delete(accepted);
      this._connections = Math.max(0, this._connections - 1);
      this._emitCloseIfDrained();
    });
    accepted._tcpResource = new AsyncResource('TCPWRAP', {
      triggerAsyncId: this._tcpResource?.asyncId(),
    });
    const cluster = configuredCluster(this._config);
    if (cluster?.isWorker && this._ownerProcess?.listenerCount?.('internalMessage') > 0) {
      const handle = {
        close: (callback) => {
          if (typeof callback === 'function') accepted.once('close', callback);
          accepted.destroy();
        },
      };
      this._runWithOwner(() => this._ownerProcess.emit('internalMessage', { act: 'newconn' }, handle));
      if (this._closeRequested || !this.listening) {
        handle.close();
        return;
      }
    }
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

  ref() {
    if (this._unref) {
      this._unref = false;
      if (this.listening && !this._taskRelease) this._taskRelease = this._taskTracker?.() || null;
    }
    if (this._handle) this._handle.ref();
    return this;
  }

  unref() {
    if (!this._unref) {
      this._unref = true;
      this._taskRelease?.();
      this._taskRelease = null;
    }
    if (this._handle) this._handle.unref();
    return this;
  }

  async [SymbolAsyncDispose]() {
    if (!this._handle) return;
    await new Promise((resolve, reject) => {
      this.close((error) => error ? reject(error) : resolve());
    });
  }
}

exposeNativeAsyncDispose(Server);

function createDetachedServerHandle(network, config, address, port, addressType, fd) {
  if (typeof fd === 'number' && fd >= 0) return -1;
  const server = new Server({}, undefined, config);
  if (port === -1 && addressType === -1) {
    const resolvedPath = resolvePipePath(address, server._ownerProcess);
    server._pipeName = resolvedPath;
    network.bindPipe(server, resolvedPath);
  } else {
    const family = addressType === 6 ? 6 : 4;
    const bindAddress = normalizeVirtualAddress(address || (family === 6 ? '::' : '0.0.0.0'), family);
    const result = network.bindTcp(server, bindAddress, port ?? 0);
    server._boundAddress = result.address;
    server._boundPort = result.port;
  }
  server.listening = true;
  server._handle = server._createServerHandle();
  return server._handle;
}

const blockListCloneMarker = Symbol.for('bnh.messaging.cloneablePrototype');
const socketAddressAddress = Symbol('socketAddressAddress');
const socketAddressPort = Symbol('socketAddressPort');
const socketAddressFamily = Symbol('socketAddressFamily');
const socketAddressFlowlabel = Symbol('socketAddressFlowlabel');

class BrowserSocketAddress {
  constructor(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw blockListError('ERR_INVALID_ARG_TYPE', 'options must be an object');
    }
    const family = options.family === undefined ? 'ipv4' : options.family;
    if (typeof family !== 'string' || !['ipv4', 'ipv6'].includes(family.toLowerCase())) {
      throw blockListError('ERR_INVALID_ARG_VALUE', `invalid address family: ${family}`);
    }
    this[socketAddressFamily] = family.toLowerCase();
    const defaultAddress = this[socketAddressFamily] === 'ipv6' ? '::' : '127.0.0.1';
    const address = options.address === undefined ? defaultAddress : options.address;
    if (typeof address !== 'string'
      || (this[socketAddressFamily] === 'ipv4' ? !isIPv4Literal(address) : !isIPv6Literal(address))) {
      throw blockListError('ERR_INVALID_ARG_TYPE', 'address must be a valid IP address');
    }
    this[socketAddressAddress] = address;
    const port = options.port === undefined ? 0 : options.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw blockListError('ERR_SOCKET_BAD_PORT', `port must be between 0 and 65535: ${port}`, RangeError);
    }
    this[socketAddressPort] = port;
    const flowlabel = options.flowlabel === undefined ? 0 : options.flowlabel;
    if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xfffff) {
      throw blockListError('ERR_OUT_OF_RANGE', `flowlabel must be between 0 and 1048575: ${flowlabel}`, RangeError);
    }
    this[socketAddressFlowlabel] = flowlabel;
  }

  get address() { return this[socketAddressAddress]; }
  get port() { return this[socketAddressPort]; }
  get family() { return this[socketAddressFamily]; }

  get flowlabel() { return this[socketAddressFlowlabel]; }

  toJSON() {
    return {
      address: this.address,
      port: this.port,
      family: this.family,
      flowlabel: this.flowlabel,
    };
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

  [inspectCustomSymbol](depth, options = {}) {
    if (depth < 0) return this;
    const stylize = typeof options.stylize === 'function' ? options.stylize : (value) => value;
    const quote = (value) => `'${String(value)
      .replaceAll('\\', '\\\\')
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r')
      .replaceAll('\t', '\\t')
      .replaceAll("'", "\\'")}'`;
    const number = (value) => {
      const text = String(value);
      return options.numericSeparator ? text.replace(/\B(?=(\d{3})+(?!\d))/g, '_') : text;
    };
    const fields = [
      `address: ${stylize(quote(this.address), 'string')}`,
      `port: ${stylize(number(this.port), 'number')}`,
      `family: ${stylize(quote(this.family), 'string')}`,
      `flowlabel: ${stylize(number(this.flowlabel), 'number')}`,
    ];
    const oneLine = `SocketAddress { ${fields.join(', ')} }`;
    const breakLength = options.breakLength ?? 80;
    if (oneLine.length <= breakLength) return oneLine;
    return `SocketAddress {\n${fields.map((field) => `  ${field}`).join(',\n')}\n}`;
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

export function createBrowserNet({ network = sharedVirtualNetwork, dns = createBrowserDns(), transport, BufferClass, trackTask, getTaskTracker = () => trackTask, currentProcess, runInProcessContext, onListening, cluster, performance } = {}) {
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
    performance,
  };
  const ConfiguredSocket = class BrowserNetSocket extends Socket {
    constructor(options = {}) { super(options, config); }
  };
  Object.defineProperties(ConfiguredSocket.prototype, {
    _writev: {
      value: Socket.prototype._writev,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _write: {
      value: Socket.prototype._write,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _bytesDispatched: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, '_bytesDispatched').get,
      enumerable: true,
      configurable: false,
    },
    bytesWritten: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'bytesWritten').get,
      enumerable: true,
      configurable: false,
    },
    connect: {
      value: Socket.prototype.connect,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _reset: {
      value: Socket.prototype._reset,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _getpeername: {
      value: Socket.prototype._getpeername,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _getsockname: {
      value: Socket.prototype._getsockname,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    bytesRead: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'bytesRead').get,
      enumerable: true,
      configurable: false,
    },
    remoteAddress: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'remoteAddress').get,
      enumerable: true,
      configurable: false,
    },
    remoteFamily: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'remoteFamily').get,
      enumerable: true,
      configurable: false,
    },
    remotePort: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'remotePort').get,
      enumerable: true,
      configurable: false,
    },
    localAddress: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'localAddress').get,
      enumerable: true,
      configurable: false,
    },
    pause: {
      value: Socket.prototype.pause,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    resume: {
      value: Socket.prototype.resume,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    read: {
      value: Socket.prototype.read,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    destroySoon: {
      value: Socket.prototype.destroySoon,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _destroy: {
      value: Socket.prototype._destroy,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    localPort: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'localPort').get,
      enumerable: true,
      configurable: false,
    },
    localFamily: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'localFamily').get,
      enumerable: true,
      configurable: false,
    },
    _writeGeneric: {
      value: Socket.prototype._writeGeneric,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _onTimeout: {
      value: Socket.prototype._onTimeout,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    setNoDelay: {
      value: Socket.prototype.setNoDelay,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    setKeepAlive: {
      value: Socket.prototype.setKeepAlive,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    address: {
      value: Socket.prototype.address,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _connecting: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, '_connecting').get,
      enumerable: false,
      configurable: false,
    },
    pending: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'pending').get,
      enumerable: false,
      configurable: true,
    },
    readyState: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'readyState').get,
      enumerable: false,
      configurable: false,
    },
    bufferSize: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, 'bufferSize').get,
      enumerable: false,
      configurable: false,
    },
    _handle: {
      get: Object.getOwnPropertyDescriptor(Socket.prototype, '_handle').get,
      set: Object.getOwnPropertyDescriptor(Socket.prototype, '_handle').set,
      enumerable: false,
      configurable: false,
    },
    ref: {
      value: Socket.prototype.ref,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    unref: {
      value: Socket.prototype.unref,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _unrefTimer: {
      value: Socket.prototype._unrefTimer,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _final: {
      value: Socket.prototype._final,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    setTimeout: {
      value: Socket.prototype.setTimeout,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    _read: {
      value: Socket.prototype._read,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    end: {
      value: Socket.prototype.end,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    resetAndDestroy: {
      value: Socket.prototype.resetAndDestroy,
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });
  const ConfiguredServer = class BrowserNetServer extends Server {
    constructor(options = {}, listener) { super(options, listener, { ...config, SocketClass: ConfiguredSocket }); }
  };
  for (const name of [
    '_listen2',
    'listen',
    'listening',
    'address',
    'getConnections',
    'close',
    'ref',
    'unref',
    '_emitCloseIfDrained',
    '_setupWorker',
  ]) {
    Object.defineProperty(ConfiguredServer.prototype, name, {
      ...Object.getOwnPropertyDescriptor(Server.prototype, name),
    });
  }
  function CallableSocket(...args) {
    const receiver = this;
    if (receiver && receiver instanceof ConfiguredSocket) {
      const instance = new ConfiguredSocket(...args);
      for (const key of Reflect.ownKeys(instance)) {
        Object.defineProperty(receiver, key, Object.getOwnPropertyDescriptor(instance, key));
      }
      receiver._writable._owner = receiver;
      receiver._writable._write = (bytes, encoding, callback) => receiver._write(bytes, encoding, callback);
      receiver._writable._final = (callback) => receiver._final(callback);
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
    _createServerHandle: (...args) => createDetachedServerHandle(configuredNetwork, config, ...args),
    _normalizeArgs: normalizeArgs,
    _setSimultaneousAccepts: () => undefined,
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
export const _createServerHandle = defaultNet._createServerHandle;
export const _normalizeArgs = defaultNet._normalizeArgs;
export const _setSimultaneousAccepts = defaultNet._setSimultaneousAccepts;

export default {
  ...defaultNet,
  Socket,
  Server,
  isIP,
  isIPv4,
  isIPv6,
  SocketAddress,
};
