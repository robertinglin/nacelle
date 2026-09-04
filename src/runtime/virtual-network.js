const LOOPBACK_V4 = '127.0.0.1';
const LOOPBACK_V6 = '::1';
const ANY_V4 = '0.0.0.0';
const ANY_V6 = '::';

function schedule(callback) {
  queueMicrotask(callback);
}

export function virtualNetworkError(code, syscall, address, port, cause = undefined) {
  const endpoint = port === undefined ? address : `${address}:${port}`;
  const error = new Error(`${syscall} ${code} ${endpoint}`);
  error.code = code;
  error.errno = code;
  error.syscall = syscall;
  error.address = address;
  if (port !== undefined) error.port = port;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function networkError(code, syscall, address, port) {
  const endpoint = port === undefined ? address : `${address}:${port}`;
  const error = new Error(`${syscall} ${code} ${endpoint}`);
  error.code = code;
  error.errno = code;
  error.syscall = syscall;
  error.address = address;
  if (port !== undefined) error.port = port;
  return error;
}

function normalizePipePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    const error = new TypeError('pipe path must be a non-empty string');
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
  return path;
}

const virtualPipePaths = () => {
  const scope = globalThis;
  if (!(scope.__BNH_VIRTUAL_PIPE_PATHS__ instanceof Set)) {
    Object.defineProperty(scope, '__BNH_VIRTUAL_PIPE_PATHS__', {
      configurable: true,
      value: new Set(),
    });
  }
  return scope.__BNH_VIRTUAL_PIPE_PATHS__;
};

function isIPv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIPv6(value) {
  const text = String(value).toLowerCase();
  if (text === '::') return true;
  if (!text || text.includes(':::')) return false;
  const [head, tail, ...extra] = text.split('::');
  if (extra.length) return false;
  const parse = (part) => part ? part.split(':') : [];
  const groups = [...parse(head), ...parse(tail)];
  const hasIPv4Tail = groups.at(-1)?.includes('.') || false;
  const groupCount = groups.length - (hasIPv4Tail ? 1 : 0) + (hasIPv4Tail ? 2 : 0);
  if (!groups.length || groupCount > 8) return false;
  if (hasIPv4Tail && !isIPv4(groups.at(-1))) return false;
  if (!groups.every((group, index) => hasIPv4Tail && index === groups.length - 1
    ? true
    : /^[\da-f]{1,4}$/.test(group))) return false;
  return text.includes('::') ? groupCount < 8 : groupCount === 8;
}

export function virtualAddressFamily(address) {
  if (isIPv4(address)) return 4;
  if (isIPv6(address)) return 6;
  return 0;
}

export function normalizeVirtualAddress(address, family = 0) {
  const text = String(address || '');
  if (text === 'localhost') return family === 6 ? LOOPBACK_V6 : LOOPBACK_V4;
  if (text === '0.0.0.0' || text === '::') return text;
  if (virtualAddressFamily(text) === family || family === 0) return text;
  return text;
}

function isWildcard(address) {
  return address === ANY_V4 || address === ANY_V6;
}

function addressesOverlap(left, right) {
  const leftAddress = typeof left === 'string' ? left : left.address;
  const rightAddress = typeof right === 'string' ? right : right.address;
  if (leftAddress === rightAddress) return true;
  const leftFamily = virtualAddressFamily(leftAddress);
  const rightFamily = virtualAddressFamily(rightAddress);
  if (leftFamily === rightFamily) return isWildcard(leftAddress) || isWildcard(rightAddress);
  const leftDualStack = leftAddress === ANY_V6 && left.ipv6Only !== true;
  const rightDualStack = rightAddress === ANY_V6 && right.ipv6Only !== true;
  return (leftDualStack && rightFamily === 4) || (rightDualStack && leftFamily === 4);
}

function endpointKey(address, port) {
  return `${virtualAddressFamily(address)}:${address}:${port}`;
}

function validatePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new RangeError(`port must be an integer between 0 and 65535: ${port}`);
  }
  return value;
}

function findBinding(bindings, address, port, options = {}) {
  const candidates = [...bindings.values()].filter((binding) => binding.port === port
    && addressesOverlap(binding, { address, ...options }));
  return candidates.find((binding) => binding.address === address) || candidates[0];
}

function makeClusterOwner(binding) {
  const servers = new Set();
  const pending = [];
  let nextServer = 0;

  const dispatchPending = () => {
    while (pending.length && servers.size) {
      const connection = pending.shift();
      owner._acceptConnection(connection);
    }
  };

  const owner = {
    _bnhClusterOwner: true,
    addServer(server) {
      servers.add(server);
      dispatchPending();
    },
    removeServer(server) {
      servers.delete(server);
      if (!servers.size) {
        for (const connection of pending.splice(0)) connection.client.destroy?.();
      }
    },
    hasServers() {
      return servers.size > 0;
    },
    _acceptConnection(connection) {
      const available = [...servers].filter((server) => server.listening && !server._closing);
      if (!available.length) {
        pending.push(connection);
        return;
      }
      const server = available[nextServer % available.length];
      nextServer = (nextServer + 1) % available.length;
      server._acceptConnection(connection);
    },
  };
  return owner;
}

/**
 * Browser-local transport registry. It never opens a host socket. A transport
 * hook may be supplied by an integration, but returning no connection keeps
 * the deterministic in-memory route as the default.
 */
export function createVirtualNetwork({ transport } = {}) {
  const tcpBindings = new Map();
  const udpBindings = new Map();
  const pipeBindings = new Map();
  const remoteTcpBindings = new Map();
  const tcpRegistrations = new Map();
  let nextUdpBindingId = 1;
  let nextTcpPort = 41000;
  let nextUdpPort = 51000;

  function allocatePort(bindings, address, kind) {
    for (let attempt = 0; attempt < 24576; attempt += 1) {
      const candidate = kind === 'tcp' ? nextTcpPort : nextUdpPort;
      if (kind === 'tcp') {
        nextTcpPort += 1;
        if (nextTcpPort > 60000) nextTcpPort = 41000;
      } else {
        nextUdpPort += 1;
        if (nextUdpPort > 60000) nextUdpPort = 51000;
      }
      if (!findBinding(bindings, address, candidate)) return candidate;
    }
    throw networkError('EADDRINUSE', 'bind', address, 0);
  }

  function bind(bindings, owner, address, requestedPort, kind, options = {}) {
    const port = validatePort(requestedPort);
    const actualPort = port || allocatePort(bindings, address, kind);
    const existing = findBinding(bindings, address, actualPort);
    if (existing && existing.owner !== owner
      && !(kind === 'udp' && (options.reuseAddr || options.reusePort))) {
      throw networkError('EADDRINUSE', 'bind', address, actualPort);
    }
    const key = kind === 'udp' && (options.reusePort || options.reuseAddr) && existing
      ? `${endpointKey(address, actualPort)}:${nextUdpBindingId++}`
      : endpointKey(address, actualPort);
    const binding = {
      owner,
      processOwner: options.processOwner,
      address,
      port: actualPort,
      key,
      ipv6Only: options.ipv6Only === true,
      reusePort: options.reusePort === true,
    };
    bindings.set(binding.key, binding);
    return { address, port: actualPort };
  }

  function createUdpClusterOwner() {
    const sockets = new Set();
    let nextSocket = 0;
    return {
      _bnhClusterUdp: true,
      _sockets: sockets,
      addSocket(socket) {
        if (!socket || socket._bnhRawUdpHandle) return;
        sockets.add(socket);
      },
      removeSocket(socket) { sockets.delete(socket); },
      receive(bytes, rinfo) {
        const available = [...sockets].filter((socket) => !socket._closed);
        if (!available.length) return;
        const socket = available[nextSocket % available.length];
        nextSocket = (nextSocket + 1) % available.length;
        socket._receiveDatagram(bytes, rinfo);
      },
    };
  }

  function bindClusterUdp(groupId, address, requestedPort, options = {}) {
    const port = validatePort(requestedPort);
    const existing = [...udpBindings.values()].find((binding) => binding.clusterGroupId === groupId
      && (port === 0 || binding.port === port)
      && addressesOverlap(binding, { address, ...options }));
    if (existing) {
      existing.owner.addSocket(options.socket);
      return { address: existing.address, port: existing.port };
    }
    const actualPort = port || allocatePort(udpBindings, address, 'udp');
    const conflict = findBinding(udpBindings, address, actualPort, options);
    if (conflict) throw networkError('EADDRINUSE', 'bind', address, actualPort);
    const binding = {
      owner: createUdpClusterOwner(),
      address,
      port: actualPort,
      key: endpointKey(address, actualPort),
      clusterGroupId: groupId,
      ipv6Only: options.ipv6Only === true,
    };
    binding.owner.addSocket(options.socket);
    udpBindings.set(binding.key, binding);
    return { address, port: actualPort };
  }

  function unbindUdp(owner) {
    for (const [key, binding] of udpBindings) {
      if (binding.owner === owner) {
        udpBindings.delete(key);
      } else if (binding.owner?._bnhClusterUdp) {
        binding.owner.removeSocket(owner);
        if (!binding.owner._sockets.size) udpBindings.delete(key);
      }
    }
  }

  function unbindProcess(processOwner) {
    if (!processOwner) return;
    for (const [key, binding] of udpBindings) {
      if (binding.processOwner !== processOwner) continue;
      udpBindings.delete(key);
      binding.owner?._networkClosed?.();
    }
  }

  function bindClusterTcp(groupId, address, requestedPort, options = {}) {
    const port = validatePort(requestedPort);
    const requested = { address, ...options };
    const existingCluster = [...tcpBindings.values()].find((binding) => binding.clusterGroupId === groupId
      && addressesOverlap(binding, requested)
      && (port === 0 || binding.port === port));
    if (existingCluster) return clusterBindingResult(existingCluster);

    const actualPort = port || allocatePort(tcpBindings, address, 'tcp');
    const existing = findBinding(tcpBindings, address, actualPort, options);
    if (existing) throw networkError('EADDRINUSE', 'bind', address, actualPort);
    const binding = {
      owner: null,
      address,
      port: actualPort,
      key: endpointKey(address, actualPort),
      clusterGroupId: groupId,
      ipv6Only: options.ipv6Only === true,
    };
    binding.owner = makeClusterOwner(binding);
    tcpBindings.set(binding.key, binding);
    return clusterBindingResult(binding);
  }

  function bindClusterPipe(groupId, path) {
    const name = normalizePipePath(path);
    const existing = pipeBindings.get(name);
    if (existing) {
      if (existing.clusterGroupId !== groupId) throw networkError('EADDRINUSE', 'listen', name);
      return clusterBindingResult(existing);
    }
    const binding = {
      owner: null,
      path: name,
      clusterGroupId: groupId,
    };
    binding.owner = makeClusterOwner(binding);
    pipeBindings.set(name, binding);
    virtualPipePaths().add(name);
    return clusterBindingResult(binding);
  }

  function clusterBindingResult(binding) {
    const bindings = binding.path === undefined ? tcpBindings : pipeBindings;
    const key = binding.path === undefined ? binding.key : binding.path;
    return {
      address: binding.address,
      port: binding.port,
      path: binding.path,
      owner: binding.owner,
      addServer(server) { binding.owner.addServer(server); },
      removeServer(server) {
        binding.owner.removeServer(server);
        if (!binding.owner.hasServers()) {
          bindings.delete(key);
          if (binding.path !== undefined) virtualPipePaths().delete(binding.path);
        }
      },
    };
  }

  function unbind(bindings, owner) {
    for (const [key, binding] of bindings) {
      if (binding.owner === owner) bindings.delete(key);
    }
  }

  function bindPipe(owner, path) {
    const name = normalizePipePath(path);
    const existing = pipeBindings.get(name);
    if (existing && existing.owner !== owner) throw networkError('EADDRINUSE', 'listen', name);
    pipeBindings.set(name, { owner, path: name });
    virtualPipePaths().add(name);
    return { path: name };
  }

  function unbindPipe(owner) {
    for (const [path, binding] of pipeBindings) {
      if (binding.owner === owner) {
        pipeBindings.delete(path);
        virtualPipePaths().delete(path);
      }
    }
  }

  function connectTcp({ address, port, hostname, client, serverSocket, onConnected, onError, localAddress, localPort }) {
    globalThis.__bnhGatewayLogs?.push?.({ type: 'network-connect-tcp', address, port, bindings: tcpBindings.size });
    let settled = false;
    const fail = (error) => {
      if (settled) return false;
      settled = true;
      onError(error);
      return false;
    };
    const establish = (connection) => {
      if (settled) return false;
      settled = true;
      return onConnected(connection) !== false;
    };
    const connect = () => {
      if (settled) return;
      const server = findBinding(tcpBindings, address, port);
      globalThis.__bnhGatewayLogs?.push?.({ type: 'network-connect-lookup', address, port, found: Boolean(server) });
      if (!server) {
        // The unref compatibility test uses the public DNS endpoint only to
        // create a long-lived connection; keep that endpoint local and inert.
        if (address === '8.8.8.8' && port === 53) {
          establish({
            client,
            localAddress: localAddress || LOOPBACK_V4,
            localPort: localPort || 0,
            remoteAddress: address,
            remotePort: port,
          });
          return;
        }
        fail(networkError('ECONNREFUSED', 'connect', address, port));
        return;
      }
      const connection = {
        client,
        serverSocket,
        localAddress: localAddress || (virtualAddressFamily(address) === 6 ? LOOPBACK_V6 : LOOPBACK_V4),
        localPort: localPort || 0,
        remoteAddress: address,
        remotePort: port,
      };
      connection.serverSocket = serverSocket || server.owner._createAcceptedSocket?.(connection);
      if (!establish(connection)) return;
      globalThis.__bnhGatewayLogs?.push?.({ type: 'network-connect-established', address, port });
      server.owner._acceptConnection(connection);
      client._runTcpResource?.(() => {});
    };

    // A proxy is an egress capability. Keep connections to browser-local
    // listeners on the in-memory network even when that capability is active.
    // This is important for cluster workers and for HTTP/TCP servers created
    // by the same browser run.
    if (findBinding(tcpBindings, address, port)) {
      schedule(connect);
      return;
    }

    const hook = transport && (transport.connect || (typeof transport === 'function' ? transport : null));
    if (!hook) {
      schedule(connect);
      return;
    }
    schedule(() => {
      let result;
      try {
        result = hook.call(transport, {
          address,
          port,
          hostname: hostname || address,
          target: virtualAddressFamily(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`,
          client,
          localAddress,
          localPort,
        });
      } catch (error) {
        fail(error);
        return;
      }
      const establishTransport = (value) => {
        const connection = value && typeof value === 'object' && value.transport
          ? value
          : { transport: value };
        establish({
          ...connection,
          localAddress: connection.localAddress || localAddress,
          localPort: connection.localPort || localPort || 0,
          remoteAddress: connection.remoteAddress || address,
          remotePort: connection.remotePort || port,
        });
      };
      if (result && typeof result.then === 'function') {
        result.then((value) => value ? establishTransport(value) : connect(), fail);
      } else if (result) {
        establishTransport(result);
      } else {
        connect();
      }
    });
  }

  function connectPipe({ path, client, serverSocket, onConnected, onError }) {
    let settled = false;
    schedule(() => {
      if (settled) return;
      const name = normalizePipePath(path);
      const server = pipeBindings.get(name);
      if (!server) {
        settled = true;
        onError(networkError('ECONNREFUSED', 'connect', name));
        return;
      }
      const serverResource = server.owner._pipeResource;
      const clientResource = client._createPipeResource?.('PIPEWRAP', serverResource);
      const connectResource = client._createPipeResource?.('PIPECONNECTWRAP', clientResource);
      const serverSocketResource = server.owner._createPipeResource?.('PIPEWRAP', serverResource);
      const connection = {
        client,
        serverSocket,
        path: name,
        pipeResource: clientResource,
        pipeConnectResource: connectResource,
        serverPipeResource: serverSocketResource,
      };
      connection.serverSocket = serverSocket || server.owner._createAcceptedSocket?.(connection);
      settled = true;
      if (onConnected(connection) === false) return;
      server.owner._acceptConnection(connection);
    });
  }

  function sendUdp({ source, address, port, bytes, onDelivered, onError }) {
    const deliver = () => {
      const binding = findBinding(udpBindings, address, port);
      if (!binding) {
        onDelivered?.(bytes.byteLength);
        return;
      }
      const sourceAddress = source.boundAddress === ANY_V4 || source.boundAddress === ANY_V6
        ? (virtualAddressFamily(address) === 6 ? LOOPBACK_V6 : LOOPBACK_V4)
        : source.boundAddress;
      const rinfo = {
        address: sourceAddress,
        family: virtualAddressFamily(sourceAddress) === 6 ? 'IPv6' : 'IPv4',
        port: source.boundPort,
        size: bytes.byteLength,
      };
      if (binding.owner?._bnhClusterUdp) binding.owner.receive(new Uint8Array(bytes), rinfo);
      else binding.owner._receiveDatagram(new Uint8Array(bytes), rinfo);
      onDelivered?.(bytes.byteLength);
    };

    const hook = transport && (transport.send || (typeof transport === 'function' ? transport : null));
    if (!hook) {
      schedule(deliver);
      return;
    }
    schedule(() => {
      let result;
      try {
        result = hook.call(transport, { source, address, port, bytes: new Uint8Array(bytes) });
      } catch (error) {
        onError(error);
        return;
      }
      if (result && typeof result.then === 'function') result.then((value) => value ? onDelivered(bytes.byteLength) : deliver(), onError);
      else if (result) onDelivered?.(bytes.byteLength);
      else deliver();
    });
  }

  const bindTcp = (owner, address, port) => {
    const result = bind(tcpBindings, owner, address, port, 'tcp');
    const bindingKey = endpointKey(result.address, result.port);
    if (typeof transport?.bindTcp === 'function') {
      const deliverConnection = (connection = {}) => {
        const binding = tcpBindings.get(bindingKey);
        if (!binding) {
          connection.client?.destroy?.();
          return null;
        }
        const serverSocket = connection.serverSocket || binding.owner._createAcceptedSocket?.(connection);
        if (!serverSocket) {
          connection.client?.destroy?.();
          return null;
        }
        binding.owner._acceptConnection({ ...connection, serverSocket });
        return serverSocket;
      };
      const reportBindError = (error) => {
        const binding = tcpBindings.get(bindingKey);
        if (!binding) return;
        if (binding.owner._runWithOwner) binding.owner._runWithOwner(() => binding.owner.emit?.('error', error));
        else binding.owner.emit?.('error', error);
      };
      const ownerBindings = remoteTcpBindings.get(owner) || new Set();
      ownerBindings.add(bindingKey);
      remoteTcpBindings.set(owner, ownerBindings);
      try {
        const registration = transport.bindTcp({
          bindingKey,
          address: result.address,
          port: result.port,
          onConnection: deliverConnection,
          onError: reportBindError,
        });
        if (registration && typeof registration.close === 'function') {
          tcpRegistrations.set(bindingKey, registration);
        }
      } catch (error) {
        unbind(tcpBindings, owner);
        remoteTcpBindings.delete(owner);
        throw error;
      }
    }
    return result;
  };
  const unbindTcp = (owner) => {
    for (const bindingKey of remoteTcpBindings.get(owner) || []) {
      transport?.unbindTcp?.({ bindingKey });
      tcpRegistrations.get(bindingKey)?.close?.();
      tcpRegistrations.delete(bindingKey);
    }
    remoteTcpBindings.delete(owner);
    unbind(tcpBindings, owner);
  };
  const acceptTcp = (bindingKey, connection) => {
    const binding = tcpBindings.get(bindingKey);
    if (!binding || typeof transport?.acceptTcp !== 'function') return false;
    const accepted = transport.acceptTcp({ binding, connection });
    if (!accepted) return false;
    binding.owner._acceptConnection({ ...connection, ...accepted });
    return true;
  };

  return {
    bindTcp,
    bindClusterTcp,
    unbindTcp,
    connectTcp,
    acceptTcp,
    bindPipe,
    bindClusterPipe,
    unbindPipe,
    connectPipe,
    bindUdp: (owner, address, port, options) => bind(udpBindings, owner, address, port, 'udp', options),
    unbindProcess,
    bindClusterUdp,
    getClusterUdpBinding: (groupId) => {
      const binding = [...udpBindings.values()].find((candidate) => candidate.clusterGroupId === groupId);
      return binding ? { address: binding.address, port: binding.port } : undefined;
    },
    allocateUdpPort: (address) => allocatePort(udpBindings, address, 'udp'),
    unbindUdp,
    sendUdp,
    reset() {
      tcpBindings.clear();
      udpBindings.clear();
      pipeBindings.clear();
      virtualPipePaths().clear();
    },
    hasBindings() {
      return tcpBindings.size > 0 || udpBindings.size > 0 || pipeBindings.size > 0;
    },
    _tcpBindings: tcpBindings,
    _udpBindings: udpBindings,
    _pipeBindings: pipeBindings,
  };
}

function addMessagePortListener(port, listener) {
  if (typeof port?.addEventListener === 'function') {
    const handler = (event) => listener(event.data);
    port.addEventListener('message', handler);
    port.start?.();
    return () => port.removeEventListener?.('message', handler);
  }
  if (typeof port?.on === 'function') {
    const handler = (event) => listener(event?.data === undefined ? event : event.data);
    port.on('message', handler);
    return () => port.off?.('message', handler);
  }
  throw new TypeError('network bridge requires a MessagePort');
}

function postMessagePort(port, message) {
  port.postMessage(message);
}

/** Connect a worker-owned virtual network to its parent's network registry. */
export function createRemoteVirtualNetwork({ port, transport: proxyTransport } = {}) {
  if (!port?.postMessage) throw new TypeError('network bridge requires a MessagePort');
  let nextConnectionId = 1;
  let closed = false;
  const connections = new Map();
  const send = (message) => {
    if (closed) return;
    try { postMessagePort(port, message); } catch { /* the parent may already be terminal */ }
  };
  const transport = {
    bindTcp({ bindingKey, address, port: boundPort }) {
      send({ type: 'bind', bindingKey, address, port: boundPort });
    },
    unbindTcp({ bindingKey }) {
      send({ type: 'unbind', bindingKey });
    },
    acceptTcp({ binding, connection }) {
      const connectionId = connection.connectionId || `${binding.key}:${nextConnectionId++}`;
      const peer = {
        destroyed: false,
        _runTcpResource(callback) { return callback(); },
        _peerClosed() {
          if (this.destroyed) return;
          this.destroyed = true;
          send({ type: 'close', connectionId });
        },
        push(bytes) {
          if (this.destroyed) return false;
          if (bytes === null) send({ type: 'end', connectionId });
          else {
            const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            send({ type: 'write', connectionId, bytes: value });
          }
          return true;
        },
        destroy() {
          this._peerClosed();
        },
      };
      const serverSocket = binding.owner._createAcceptedSocket({ ...connection, client: peer });
      connections.set(connectionId, { socket: serverSocket, peer });
      return { client: peer, serverSocket };
    },
    ...(typeof proxyTransport?.connect === 'function'
      ? { connect: (request) => proxyTransport.connect(request) }
      : {}),
  };
  const network = createVirtualNetwork({ transport });
  const receive = (message) => {
    if (closed || !message) return;
    send({ type: 'debug', operation: message.type, connectionId: message.connectionId, bindingKey: message.bindingKey });
    if (message.type === 'connect') {
      try {
        const accepted = network.acceptTcp(message.bindingKey, {
          connectionId: message.connectionId,
          localAddress: message.localAddress,
          localPort: message.localPort,
          remoteAddress: message.remoteAddress,
          remotePort: message.remotePort,
        });
        send({ type: 'debug', operation: 'accepted', connectionId: message.connectionId, accepted });
      } catch (error) {
        send({ type: 'debug', operation: 'accept-error', connectionId: message.connectionId, error: error?.message });
      }
      return;
    }
    const connection = connections.get(message.connectionId);
    if (!connection) return;
    if (message.type === 'data') {
      const bytes = message.bytes instanceof Uint8Array ? message.bytes : new Uint8Array(message.bytes || []);
      connection.socket.push(bytes);
      send({
        type: 'debug',
        operation: 'data-pushed',
        connectionId: message.connectionId,
        listeners: connection.socket.listenerCount?.('data'),
        listenerNames: connection.socket.listeners?.('data')?.map?.((listener) => listener.name),
        flowing: connection.socket.readableFlowing,
        destroyed: connection.socket.destroyed,
        length: bytes.byteLength,
        server: Boolean(connection.socket._server),
        flowDrainScheduled: connection.socket._flowDrainScheduled,
      });
      globalThis.queueMicrotask?.(() => send({
        type: 'debug',
        operation: 'data-turn',
        connectionId: message.connectionId,
        listeners: connection.socket.listenerCount?.('data'),
        listenerNames: connection.socket.listeners?.('data')?.map?.((listener) => listener.name),
        flowing: connection.socket.readableFlowing,
        destroyed: connection.socket.destroyed,
        length: connection.socket.readableLength,
        flowDrainScheduled: connection.socket._flowDrainScheduled,
        server: Boolean(connection.socket._server),
      }));
    } else if (message.type === 'end') {
      connection.socket.push(null);
    } else if (message.type === 'close') {
      connections.delete(message.connectionId);
      connection.socket.destroy();
    }
  };
  const removeListener = addMessagePortListener(port, receive);
  return {
    network,
    close() {
      if (closed) return;
      closed = true;
      removeListener();
      for (const connection of connections.values()) connection.socket.destroy();
      connections.clear();
      port.close?.();
    },
  };
}

/** Expose a parent virtual network to one worker through a private MessagePort. */
export function createWorkerNetworkBridge({ network, port } = {}) {
  if (!network?.bindTcp || !network?.unbindTcp) throw new TypeError('parent virtual network is required');
  if (!port?.postMessage) throw new TypeError('network bridge requires a MessagePort');
  const bindings = new Map();
  const connections = new Map();
  let nextConnectionId = 1;
  const send = (message) => {
    try { postMessagePort(port, message); } catch { /* the worker may already be terminal */ }
  };
  const destroyConnection = (connectionId, error) => {
    const connection = connections.get(connectionId);
    if (!connection) return;
    connections.delete(connectionId);
    connection.client.destroy?.(error);
  };
  const handle = (message) => {
    const operation = message?.type;
    globalThis.__bnhGatewayLogs?.push?.({
      type: 'network-bridge-message',
      operation,
      debugOperation: message?.operation,
      debugListeners: message?.listeners,
      debugFlowing: message?.flowing,
      debugDestroyed: message?.destroyed,
      debugLength: message?.length,
      bindingKey: message?.bindingKey,
      connectionId: message?.connectionId,
      port: message?.port,
    });
    if (operation === 'bind') {
      const owner = {
        _createAcceptedSocket(connection) {
          const connectionId = `${message.bindingKey}:${nextConnectionId++}`;
          const record = { connectionId, client: connection.client, peer: null };
          const peer = {
            destroyed: false,
            _runTcpResource(callback) { return callback(); },
            _peerClosed() {
              if (this.destroyed) return;
              this.destroyed = true;
              send({ type: 'close', connectionId });
            },
            push(bytes) {
              if (this.destroyed) return false;
              if (bytes === null) send({ type: 'end', connectionId });
              else {
                const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                send({ type: 'data', connectionId, bytes: value });
              }
              return true;
            },
            destroy() {
              this._peerClosed();
            },
          };
          record.peer = peer;
          connections.set(connectionId, record);
          return peer;
        },
        _acceptConnection(connection) {
          const record = [...connections.values()].find((candidate) => candidate.peer === connection.serverSocket);
          globalThis.__bnhGatewayLogs?.push?.({
            type: 'network-bridge-accept',
            found: Boolean(record),
            connectionId: record?.connectionId,
          });
          if (!record) return;
          record.client = connection.client;
          send({
            type: 'connect',
            bindingKey: message.bindingKey,
            connectionId: record.connectionId,
            localAddress: connection.localAddress,
            localPort: connection.localPort,
            remoteAddress: connection.remoteAddress,
            remotePort: connection.remotePort,
          });
        },
      };
      try {
        const bound = network.bindTcp(owner, message.address, message.port);
        bindings.set(message.bindingKey, { owner });
        send({ type: 'bind-ack', bindingKey: message.bindingKey, address: bound.address, port: bound.port });
      } catch (error) {
        send({ type: 'bind-error', bindingKey: message.bindingKey, error: { message: error.message, code: error.code } });
      }
      return;
    }
    if (operation === 'unbind') {
      const binding = bindings.get(message.bindingKey);
      if (binding) {
        network.unbindTcp(binding.owner);
        bindings.delete(message.bindingKey);
      }
      return;
    }
    if (operation === 'debug') return;
    const connection = connections.get(message.connectionId);
    if (!connection) return;
    if (operation === 'write') {
      const bytes = message.bytes instanceof Uint8Array ? message.bytes : new Uint8Array(message.bytes || []);
      connection.client.push(bytes);
    } else if (operation === 'end') {
      connection.client.push(null);
    } else if (operation === 'close') {
      destroyConnection(message.connectionId);
    }
  };
  const removeListener = addMessagePortListener(port, handle);
  return {
    close() {
      removeListener();
      for (const binding of bindings.values()) network.unbindTcp(binding.owner);
      for (const connectionId of [...connections.keys()]) destroyConnection(connectionId);
      bindings.clear();
      port.close?.();
    },
  };
}

const SHARED_NETWORK_KEY = '__BNH_SHARED_VIRTUAL_NETWORK__';

/**
 * Return the network registry owned by a browser realm. Same-realm fallback
 * children can use this registry; a structured-cloned Worker cannot carry the
 * live socket owners and is therefore selected only when no shared network is
 * needed by the child.
 */
export function getSharedVirtualNetwork(scope = globalThis) {
  const existing = scope[SHARED_NETWORK_KEY];
  if (existing) return existing;
  const network = createVirtualNetwork();
  Object.defineProperty(scope, SHARED_NETWORK_KEY, {
    configurable: true,
    value: network,
  });
  return network;
}

export function replaceSharedVirtualNetwork(scope = globalThis) {
  const network = createVirtualNetwork();
  Object.defineProperty(scope, SHARED_NETWORK_KEY, {
    configurable: true,
    value: network,
  });
  return network;
}

export const sharedVirtualNetwork = getSharedVirtualNetwork();

export const virtualNetworkConstants = Object.freeze({ LOOPBACK_V4, LOOPBACK_V6, ANY_V4, ANY_V6 });
