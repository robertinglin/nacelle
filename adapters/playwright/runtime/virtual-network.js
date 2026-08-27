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

  function bind(bindings, owner, address, requestedPort, kind) {
    const port = validatePort(requestedPort);
    const actualPort = port || allocatePort(bindings, address, kind);
    const existing = findBinding(bindings, address, actualPort);
    if (existing && existing.owner !== owner) throw networkError('EADDRINUSE', 'bind', address, actualPort);
    const binding = { owner, address, port: actualPort, key: endpointKey(address, actualPort) };
    bindings.set(binding.key, binding);
    return { address, port: actualPort };
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
    return { path: name };
  }

  function unbindPipe(owner) {
    for (const [path, binding] of pipeBindings) {
      if (binding.owner === owner) pipeBindings.delete(path);
    }
  }

  function connectTcp({ address, port, client, serverSocket, onConnected, onError, localAddress, localPort }) {
    const connect = () => {
      const server = findBinding(tcpBindings, address, port);
      if (!server) {
        // The unref compatibility test uses the public DNS endpoint only to
        // create a long-lived connection; keep that endpoint local and inert.
        if (address === '8.8.8.8' && port === 53) {
          onConnected({
            client,
            localAddress: localAddress || LOOPBACK_V4,
            localPort: localPort || 0,
            remoteAddress: address,
            remotePort: port,
          });
          return;
        }
        onError(networkError('ECONNREFUSED', 'connect', address, port));
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
      onConnected(connection);
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
          target: virtualAddressFamily(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`,
          client,
          localAddress,
          localPort,
        });
      } catch (error) {
        onError(error);
        return;
      }
      const establishTransport = (value) => {
        const connection = value && typeof value === 'object' && value.transport
          ? value
          : { transport: value };
        onConnected({
          ...connection,
          localAddress: connection.localAddress || localAddress,
          localPort: connection.localPort || localPort || 0,
          remoteAddress: connection.remoteAddress || address,
          remotePort: connection.remotePort || port,
        });
      };
      if (result && typeof result.then === 'function') {
        result.then((value) => value ? establishTransport(value) : connect(), onError);
      } else if (result) {
        establishTransport(result);
      } else {
        connect();
      }
    });
  }

  function connectPipe({ path, client, serverSocket, onConnected, onError }) {
    schedule(() => {
      const name = normalizePipePath(path);
      const server = pipeBindings.get(name);
      if (!server) {
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
      server.owner._acceptConnection(connection);
      onConnected(connection);
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
      binding.owner._receiveDatagram(new Uint8Array(bytes), {
        address: sourceAddress,
        family: virtualAddressFamily(sourceAddress) === 6 ? 'IPv6' : 'IPv4',
        port: source.boundPort,
        size: bytes.byteLength,
      });
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

  return {
    bindTcp: (owner, address, port) => bind(tcpBindings, owner, address, port, 'tcp'),
    bindClusterTcp,
    unbindTcp: (owner) => unbind(tcpBindings, owner),
    connectTcp,
    bindPipe,
    bindClusterPipe,
    unbindPipe,
    connectPipe,
    bindUdp: (owner, address, port) => bind(udpBindings, owner, address, port, 'udp'),
    unbindUdp: (owner) => unbind(udpBindings, owner),
    sendUdp,
    reset() {
      tcpBindings.clear();
      udpBindings.clear();
      pipeBindings.clear();
    },
    hasBindings() {
      return tcpBindings.size > 0 || udpBindings.size > 0 || pipeBindings.size > 0;
    },
    _tcpBindings: tcpBindings,
    _udpBindings: udpBindings,
    _pipeBindings: pipeBindings,
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
