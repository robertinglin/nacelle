import { BrowserNpm, BrowserNpmCache } from './runtime/npm.js';
import { createRuntime } from './runtime.js';
import { decompressGzipBytes, unpackTar, unpackTarGz } from './runtime/tar.js';
import { compress } from './runtime/compression.js';
import { createProgressReporter } from './progress-protocol.mjs';
import { createCitgmProcessArgv } from './citgm-argv.mjs';
import { createSerializedCaptureQueue } from './citgm-capture.mjs';
import { npmCacheSnapshot } from './citgm-cache.mjs';

const DEFAULT_CITGM_VERSION = '10.0.2';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const CITGM_ENTRY = '/node/node_modules/citgm/bin/citgm.js';
const NODE_BIN = new TextEncoder().encode('#!/usr/bin/env node\n');
const NPM_BIN = new TextEncoder().encode('#!/usr/bin/env node\n');
const browserFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const encoder = new TextEncoder();

// A synchronous ESM child may block its owning dedicated worker in
// Atomics.wait. Chromium does not schedule a worker created from that blocked
// worker, so route nested workers through a page-owned broker just as the
// regular harness bridge does.
const NativeMessageChannel = globalThis.MessageChannel;
const NativeWorker = globalThis.Worker;

function createWorkerBrokerPort() {
  if (typeof NativeMessageChannel !== 'function' || typeof NativeWorker !== 'function') return undefined;
  const channel = new NativeMessageChannel();
  const brokerPort = channel.port1;
  brokerPort.onmessage = (event) => {
    const request = event.data;
    if (request?.type !== 'create' || !request.port) return;
    const worker = new NativeWorker(request.source, request.options || {});
    const clientPort = request.port;
    let initialized = false;
    clientPort.onmessage = (clientEvent) => {
      const message = clientEvent.data;
      if (message?.type === 'postMessage') {
        const transfers = [...(message.transfers || [])];
        let value = message.value;
        if (!initialized) {
          initialized = true;
          const childBrokerPort = createWorkerBrokerPort();
          value = { ...value, workerBrokerPort: childBrokerPort };
          transfers.push(childBrokerPort);
        }
        worker.postMessage(value, transfers);
      } else if (message?.type === 'terminate') {
        worker.terminate();
        clientPort.close();
      }
    };
    clientPort.start?.();
    worker.addEventListener('message', (workerEvent) => {
      clientPort.postMessage({ type: 'message', value: workerEvent.data });
    });
    worker.addEventListener('messageerror', (workerEvent) => {
      clientPort.postMessage({ type: 'messageerror', error: { message: String(workerEvent?.message || 'worker message error') } });
    });
    worker.addEventListener('error', (workerEvent) => {
      clientPort.postMessage({
        type: 'error',
        error: {
          name: workerEvent?.error?.name || workerEvent?.name || 'Error',
          message: String(workerEvent?.error?.message || workerEvent?.message || 'worker failed'),
          stack: workerEvent?.error?.stack || workerEvent?.error?.stack || null,
        },
      });
    });
  };
  brokerPort.start?.();
  return channel.port2;
}

globalThis.__BNH_CREATE_WORKER_BROKER_PORT__ = createWorkerBrokerPort;

function concatBytes(chunks) {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function headerEnd(bytes) {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10
      && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index + 4;
  }
  return -1;
}

function byteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => /^\d+$/.test(key)).sort((left, right) => Number(left) - Number(right));
    if (keys.length) return Uint8Array.from(keys.map((key) => Number(value[key])));
  }
  return new Uint8Array();
}

function headerObject(value) {
  if (!value) return {};
  if (typeof value.entries === 'function') return Object.fromEntries(value.entries());
  if (Array.isArray(value)) return Object.fromEntries(value);
  return { ...value };
}

async function responseBytes(response) {
  if (response?.bodyBytes !== undefined) return byteView(response.bodyBytes);
  if (typeof response?.arrayBuffer === 'function') return new Uint8Array(await response.arrayBuffer());
  return new Uint8Array();
}

async function fetchProxyTarget(url, init = {}) {
  // The CITGM page cannot read arbitrary registry or source-host responses
  // through browser CORS. The host bridge is an explicit network capability,
  // so use it when the runner supplies one; this remains available after the
  // runtime and any child workers have already started.
  if (typeof globalThis.__bnhFetchExternal === 'function') {
    const body = init.body === undefined || init.body === null
      ? undefined
      : [...byteView(init.body)];
    const result = await globalThis.__bnhFetchExternal({
      url: String(url),
      method: init.method || 'GET',
      headers: headerObject(init.headers),
      body,
    });
    if (!result || !Number.isInteger(result.status)) throw new Error('external fetch returned an invalid response');
    return {
      url: result.url || String(url),
      status: result.status,
      statusText: result.statusText || '',
      headers: headerObject(result.headers),
      bodyBytes: byteView(result.bodyBytes),
    };
  }
  if (!browserFetch) throw new Error('browser fetch is unavailable');
  return browserFetch(url, init);
}

function createFetchTransport(host, port, loadCachedProject) {
  const listeners = new Map();
  const requestChunks = [];
  const controller = new AbortController();
  let requestEnded = false;
  let dispatched = false;
  let closed = false;

  const transport = {
    virtualTls: Number(port) === 443,
    on(name, listener) {
      const values = listeners.get(name) || [];
      values.push(listener);
      listeners.set(name, values);
      return transport;
    },
    once(name, listener) {
      const wrapped = (...args) => {
        transport.off(name, wrapped);
        listener(...args);
      };
      return transport.on(name, wrapped);
    },
    off(name, listener) {
      const values = listeners.get(name);
      if (!values) return transport;
      const remaining = values.filter((value) => value !== listener);
      if (remaining.length) listeners.set(name, remaining);
      else listeners.delete(name);
      return transport;
    },
    emit(name, ...args) {
      for (const listener of [...listeners.get(name) || []]) listener(...args);
    },
    write(bytes, callback) {
      if (closed) {
        callback?.(new Error('write after close'));
        return false;
      }
      requestChunks.push(bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes));
      callback?.();
      void dispatch();
      return true;
    },
    end(callback) {
      requestEnded = true;
      callback?.();
      void dispatch();
      return transport;
    },
    destroy(error) {
      if (closed) return transport;
      closed = true;
      controller.abort();
      if (error && listeners.has('error')) transport.emit('error', error);
      transport.emit('end');
      return transport;
    },
  };

  async function dispatch() {
    if (dispatched) return;
    dispatched = true;
    const requestBytes = concatBytes(requestChunks);
    const requestEnd = headerEnd(requestBytes);
    if (requestEnd < 0) {
      dispatched = false;
      return;
    }
    const requestHeaderText = new TextDecoder().decode(requestBytes.slice(0, requestEnd));
    const contentLengthLine = requestHeaderText.split('\r\n').find((line) => /^content-length:/i.test(line));
    const contentLength = Number(contentLengthLine?.split(':', 2)[1] || 0);
    const chunked = /(?:^|\r\n)transfer-encoding:\s*chunked(?:\r\n|$)/i.test(requestHeaderText);
    if ((chunked && !requestEnded) || (!chunked && requestBytes.byteLength < requestEnd + contentLength)) {
      dispatched = false;
      return;
    }
    try {
      const end = requestEnd;
      const headerText = requestHeaderText;
      const lines = headerText.slice(0, -4).split('\r\n');
      const [method, requestTarget] = lines.shift()?.split(' ', 2) || [];
      if (!method || !requestTarget) throw new Error('invalid HTTP request line');
      const headers = {};
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator > 0) {
          const name = line.slice(0, separator).trim().toLowerCase();
          if (!['connection', 'content-length', 'host', 'keep-alive', 'proxy-connection', 'transfer-encoding'].includes(name)) {
            headers[name] = line.slice(separator + 1).trim();
          }
        }
      }
      const lengthLine = lines.find((line) => /^content-length:/i.test(line));
      const contentLength = Number(lengthLine?.split(':', 2)[1] || 0);
      const body = contentLength > 0 ? requestBytes.slice(end, end + contentLength) : undefined;
      const protocol = Number(port) === 443 ? 'https:' : 'http:';
      const url = new URL(requestTarget, `${protocol}//${host}`).href;
      const cachedBody = method === 'GET' ? await loadCachedProject?.(url) : null;
      const response = cachedBody
        ? {
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-length': String(cachedBody.byteLength) }),
            async arrayBuffer() { return cachedBody.slice().buffer; },
          }
        : await fetchProxyTarget(url, {
            method,
            headers,
            body: body?.byteLength ? body : undefined,
            signal: controller.signal,
            redirect: 'follow',
          });
      if (closed) return;
      const responseBody = await responseBytes(response);
      const responseHeaders = [`HTTP/1.1 ${response.status} ${response.statusText || ''}`.trim()];
      for (const [name, value] of Object.entries(headerObject(response.headers))) {
        if (name.toLowerCase() !== 'connection') responseHeaders.push(`${name}: ${value}`);
      }
      if (!Object.hasOwn(headerObject(response.headers), 'content-length')) responseHeaders.push(`content-length: ${responseBody.byteLength}`);
      responseHeaders.push('connection: close', '', '');
      transport.emit('data', concatBytes([encoder.encode(responseHeaders.join('\r\n')), responseBody]));
      transport.emit('end');
    } catch (error) {
      if (!closed) {
        closed = true;
        transport.emit('error', error);
        transport.emit('end');
      }
    }
  }

  return transport;
}

function createBrowserProxyAdapter(loadCachedProject) {
  const loopbackBindings = new Map();
  const loopbackByBindingKey = new Map();
  const loopbackConnections = new Map();
  return {
    async request(request = {}) {
      if (request.__bnhNpmCache === true) {
        if (request.type === 'metadata' && request.name) {
          const metadata = await npmCache.getMetadata(String(request.name));
          return metadata ? { metadata } : null;
        }
        if (request.type === 'tarball' && request.key) {
          const bytes = await npmCache.getTarball(String(request.key));
          return bytes ? { bytes } : null;
        }
        if (request.type === 'package-entries' && request.name && request.version) {
          const entries = npmCache.getUnpackedPackage(String(request.name), String(request.version));
          return entries ? { entries } : null;
        }
        if (request.type === 'set-metadata' && request.name && request.metadata !== undefined) {
          await npmCache.setMetadata(String(request.name), request.metadata);
          return { stored: true };
        }
        if (request.type === 'set-tarball' && request.key && request.bytes) {
          const bytes = request.bytes instanceof Uint8Array
            ? request.bytes
            : new Uint8Array(request.bytes);
          await npmCache.setTarball(String(request.key), bytes, {
            name: String(request.name || ''),
            version: String(request.version || ''),
          });
          return { stored: true };
        }
        return null;
      }

      // A proxy capability serves both cache RPCs and ordinary Node HTTP
      // requests. Returning null for a normal request makes the HTTP client
      // interpret the response as a closed connection, which breaks archive
      // downloads and any other live request after the cache is cold.
      const target = String(request.url || request.target || '');
      if (!target || !browserFetch) return null;
      const cachedBody = String(request.method || 'GET').toUpperCase() === 'GET'
        ? await loadCachedProject?.(target)
        : null;
      if (cachedBody) {
        return {
          status: 200,
          headers: { 'content-length': String(cachedBody.byteLength) },
          bodyBytes: cachedBody,
        };
      }
      const response = await fetchProxyTarget(target, {
        method: request.method || 'GET',
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: 'follow',
      });
      const headers = headerObject(response.headers);
      // Proxy calls can cross an isolated child boundary. Do not return a
      // live Response/stream object that cannot survive structured clone;
      // materialize the normal HTTP response as its serializable wire shape.
      return {
        url: response.url || target,
        status: response.status,
        statusText: response.statusText || '',
        headers,
        bodyBytes: await responseBytes(response),
      };
    },
    resolve() {
      // The transport uses the original hostname from client._connectOptions;
      // this address only gives the virtual socket a routable placeholder.
      return { addresses: [{ address: '127.0.0.1', family: 4 }] };
    },
    connect(request) {
      const clientHost = request.hostname
        || request.host
        || request.address;
      return {
        transport: createFetchTransport(String(clientHost), Number(request.port), loadCachedProject),
        localAddress: '127.0.0.1',
        localPort: 0,
        remoteAddress: String(clientHost),
        remotePort: Number(request.port),
      };
    },
    bindTcp(request = {}) {
      const bindingKey = String(request.bindingKey || '');
      const registration = {
        id: null,
        listener: request.onConnection,
        error: request.onError,
        onConnection(listener) {
          registration.listener = listener;
          return registration;
        },
        close() {
          for (const [connectionId, connection] of loopbackConnections) {
            if (connection.registration === registration) {
              connection.socket?.destroy?.();
              loopbackConnections.delete(connectionId);
            }
          }
          if (registration.id === null) return;
          loopbackBindings.delete(registration.id);
          if (loopbackByBindingKey.get(bindingKey) === registration) loopbackByBindingKey.delete(bindingKey);
          globalThis.__bnhCloseLoopback?.({ id: registration.id });
          registration.id = null;
        },
      };
      loopbackByBindingKey.set(bindingKey, registration);
      const open = globalThis.__bnhOpenLoopback;
      if (typeof open !== 'function') {
        const error = new Error('external loopback capability is unavailable');
        error.code = 'ERR_NETWORK_CAPABILITY_UNAVAILABLE';
        registration.error?.(error);
        return registration;
      }
      Promise.resolve(open({
        bindingKey,
        address: request.address,
        port: request.port,
      })).then((result) => {
        if (!result || result.id === undefined) throw new Error('external loopback listener did not return an id');
        registration.id = String(result.id);
        loopbackBindings.set(registration.id, registration);
      }).catch((error) => registration.error?.(error));
      return registration;
    },
    unbindTcp(request = {}) {
      loopbackByBindingKey.get(String(request.bindingKey || ''))?.close();
    },
    deliverLoopback(id, event, value) {
      if (event === 'connect') {
        const registration = loopbackBindings.get(String(value?.listenerId || id));
        if (!registration) return false;
        const connectionId = String(value?.socketId || id);
        const peer = {
          destroyed: false,
          _runTcpResource(callback) { return callback(); },
          push(bytes) {
            if (this.destroyed) return false;
            const valueBytes = bytes === null
              ? null
              : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
            globalThis.__bnhWriteLoopback?.({
              id: connectionId,
              operation: valueBytes === null ? 'end' : 'data',
              bytes: valueBytes === null ? undefined : [...valueBytes],
            });
            return true;
          },
          destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            globalThis.__bnhWriteLoopback?.({ id: connectionId, operation: 'close' });
          },
        };
        const socket = registration.listener?.({
          client: peer,
          localAddress: value?.remoteAddress || '127.0.0.1',
          localPort: Number(value?.remotePort || 0),
          remoteAddress: value?.localAddress || '127.0.0.1',
          remotePort: Number(value?.localPort || 0),
        }) || null;
        if (!socket) return false;
        loopbackConnections.set(connectionId, { registration, peer, socket });
        return true;
      }
      const connection = loopbackConnections.get(String(id));
      if (!connection) return false;
      if (event === 'data') return Boolean(connection.socket?.push?.(new Uint8Array(value || [])));
      if (event === 'end') return Boolean(connection.socket?.push?.(null));
      if (event === 'close') {
        const error = new Error('read ECONNRESET');
        error.code = 'ECONNRESET';
        error.errno = 'ECONNRESET';
        error.syscall = 'read';
        connection.socket?.destroy?.(error);
        loopbackConnections.delete(String(id));
        return true;
      }
      return false;
    },
    tls() {
      return { authorized: true, protocol: 'TLSv1.3' };
    },
  };
}

function artifactId(citgmVersion, module, registry) {
  let binary = '';
  for (const byte of new TextEncoder().encode(`${citgmVersion}\u0000${module}\u0000${registry}`)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

class ArtifactNpmCache extends BrowserNpmCache {
  constructor(options) {
    super(options);
    this.artifactManifest = null;
    this.artifactBaseUrl = null;
  }

  async loadArtifact(citgmVersion, module, registry) {
    this.artifactManifest = null;
    this.artifactBaseUrl = null;
    const manifestUrl = new URL(`./.cache/citgm/${artifactId(citgmVersion, module, registry)}/manifest.json`, location.href);
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) return false;
      const manifest = await response.json();
      if (manifest.schemaVersion !== 1 || manifest.citgmVersion !== citgmVersion
        || manifest.module !== module || manifest.registry !== registry) return false;
      this.artifactManifest = manifest;
      this.artifactBaseUrl = new URL('./', manifestUrl);
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(packageName) {
    const relative = this.artifactManifest?.metadata?.[packageName];
    if (relative && this.artifactBaseUrl) {
      const response = await fetch(new URL(relative, this.artifactBaseUrl));
      if (response.ok) {
        const metadata = await response.json();
        this.memoryMeta.set(packageName, metadata);
        return metadata;
      }
    }
    return super.getMetadata(packageName);
  }

  async getTarball(key) {
    const rawKey = key.replace(/^(?:pkg-tarball:|tarball:|pkg:)/, '');
    const candidateKeys = [key, rawKey, `tarball:${rawKey}`, `pkg-tarball:${rawKey}`, `pkg:${rawKey}`];
    const relative = candidateKeys.map((candidate) => this.artifactManifest?.tarballs?.[candidate]).find(Boolean);
    if (relative && this.artifactBaseUrl) {
      const response = await fetch(new URL(relative, this.artifactBaseUrl));
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        this.memoryTarballs.set(key, bytes);
        return bytes;
      }
    }
    return super.getTarball(key);
  }

  async getProject(url) {
    const relative = this.artifactManifest?.projects?.[url];
    if (!relative || !this.artifactBaseUrl) return null;
    const response = await fetch(new URL(relative, this.artifactBaseUrl));
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  }

  projectUrls() {
    return Object.keys(this.artifactManifest?.projects || {});
  }

  gitRepositoryForArchive(url) {
    const repositories = this.artifactManifest?.gitRepositories || {};
    for (const [repository, descriptor] of Object.entries(repositories)) {
      if (descriptor?.archiveUrl === url) return { repository, ...descriptor };
    }
    return null;
  }
}

function gitRepositoryFromManifest(manifest) {
  const repository = typeof manifest?.repository === 'string'
    ? manifest.repository
    : manifest?.repository?.url;
  if (typeof repository !== 'string') return null;
  return repository
    .replace(/^git\+/, '')
    .replace(/^git:/, 'https:')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

function projectArchiveRef(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/archive\/([^/]+)\.tar\.gz$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function materializeGitProjectArchives(cache) {
  const projects = [];
  for (const url of cache.projectUrls()) {
    const archive = await cache.getProject(url);
    if (!archive) continue;
    let entries;
    try {
      entries = await unpackTarGz(archive, { stripPrefix: '', allowSymlinks: true }, globalThis);
    } catch {
      continue;
    }
    const firstPath = entries.find((entry) => entry.type === 'file')?.path || '';
    const root = firstPath.includes('/') ? `${firstPath.slice(0, firstPath.indexOf('/'))}/` : '';
    const files = entries
      .filter((entry) => (entry.type === 'file' && entry.data) || entry.type === 'symlink')
      .map((entry) => ({
        path: root && entry.path.startsWith(root) ? entry.path.slice(root.length) : entry.path,
        data: entry.data,
        target: entry.target,
        type: entry.type,
        mode: entry.mode,
      }))
      .filter((entry) => entry.path && !entry.path.startsWith('/') && !entry.path.split('/').includes('..'));
    const packageJson = files.find((entry) => entry.path === 'package.json');
    let manifest = null;
    try {
      manifest = JSON.parse(new TextDecoder().decode(packageJson.data));
    } catch {
      // External Git fixture repositories are not npm packages and therefore
      // do not have package.json. Their repository identity comes from the
      // precache manifest instead.
    }
    const repository = gitRepositoryFromManifest(manifest) || cache.gitRepositoryForArchive?.(url)?.repository;
    if (!repository) continue;
    const gitDescriptor = cache.gitRepositoryForArchive?.(url);
    projects.push({
      url,
      repository,
      ref: projectArchiveRef(url),
      latestTag: manifest?.version || null,
      head: gitDescriptor?.head || null,
      files,
    });
  }
  return projects;
}

const runtime = createRuntime({ globalObject: globalThis, nodeVersion: 'v22' });
const npmCache = new ArtifactNpmCache({ globalObject: globalThis });
const projectArchiveWithGitCache = new Map();

async function githubProjectArchiveWithGitDirectory(url, archive) {
  const key = String(url);
  if (!/github\.com\/[^/]+\/[^/]+\/archive\/[^/]+\.tar\.gz(?:$|[?#])/i.test(key)) return archive;
  const cached = projectArchiveWithGitCache.get(key);
  if (cached) return cached;
  const tarBytes = await decompressGzipBytes(archive, globalThis);
  const entries = unpackTar(tarBytes, { stripPrefix: '', allowSymlinks: true });
  const firstPath = entries.find((entry) => entry.path)?.path || '';
  const separator = firstPath.indexOf('/');
  const root = separator > 0 ? firstPath.slice(0, separator) : '';
  if (!root || entries.some((entry) => entry.path === `${root}/.git` || entry.path === `${root}/.git/`)) return archive;

  // CITGM downloads GitHub source archives, while the same package tests run
  // against a real Git checkout under Node. Preserve the archive bytes and
  // append only the empty .git directory that a GitHub checkout would expose;
  // tests that inspect repository presence must see the same filesystem shape.
  let terminalOffset = tarBytes.byteLength;
  const isZeroBlock = (offset) => {
    for (let index = offset; index < offset + 512; index += 1) {
      if (tarBytes[index] !== 0) return false;
    }
    return true;
  };
  while (terminalOffset >= 512 && isZeroBlock(terminalOffset - 512)) terminalOffset -= 512;
  const header = new Uint8Array(512);
  header.set(encoder.encode(`${root}/.git/`).subarray(0, 100), 0);
  header.set(encoder.encode('0000755\0'), 100);
  header.set(encoder.encode('0000000\0'), 108);
  header.set(encoder.encode('0000000\0'), 116);
  header.set(encoder.encode('00000000000\0'), 124);
  header.set(encoder.encode('00000000000\0'), 136);
  header[156] = 53;
  header.set(encoder.encode('ustar\0'), 257);
  header.set(encoder.encode('00'), 263);
  for (let index = 148; index < 156; index += 1) header[index] = 32;
  let checksum = 0;
  for (const value of header) checksum += value;
  header.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
  const output = new Uint8Array(terminalOffset + 512 + 1024);
  output.set(tarBytes.subarray(0, terminalOffset), 0);
  output.set(header, terminalOffset);
  const result = await compress(output, 'gzip', globalThis);
  projectArchiveWithGitCache.set(key, result);
  return result;
}

const browserProxyAdapter = createBrowserProxyAdapter(async (url) => {
  const project = await npmCache.getProject(url);
  if (project) return githubProjectArchiveWithGitDirectory(url, project);
  if (/github\.com\/[^/]+\/[^/]+\/archive\/[^/]+\.tar\.gz(?:$|[?#])/i.test(String(url))) {
    const response = await fetchProxyTarget(url, { method: 'GET', redirect: 'follow' });
    if (!response || response.status < 200 || response.status >= 300) return null;
    return githubProjectArchiveWithGitDirectory(url, await responseBytes(response));
  }
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const registryOrigin = npmCache.artifactManifest?.registry
    ? String(npmCache.artifactManifest.registry).replace(/\/+$/, '')
    : DEFAULT_REGISTRY;
  if (parsed.origin !== registryOrigin) return null;
  if (/\/[^/]+\/[-][^/]+\.tgz$/.test(parsed.pathname)) {
    return npmCache.getTarball(`tarball:${url}`);
  }
  const packageName = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ''));
  if (!packageName || packageName.includes('/-/')) return null;
  const metadata = await npmCache.getMetadata(packageName);
  return metadata ? new TextEncoder().encode(JSON.stringify(metadata)) : null;
});
Object.defineProperty(globalThis, '__BNH_EXTERNAL_TCP_DELIVER__', {
  configurable: true,
  value: (id, event, value) => browserProxyAdapter.deliverLoopback(id, event, value),
});
globalThis.__BNH_NPM_CACHE__ = npmCache;
let running = false;

function capabilitiesFor(env) {
  const pageOrigin = typeof location?.origin === 'string' && /^https?:$/i.test(location.protocol || '')
    ? location.origin
    : null;
  return {
    // CITGM packages expect the ordinary POSIX root to be available for
    // temporary fixtures such as /tmp. This is still an isolated in-memory
    // mount; it does not expose the adapter's host filesystem.
    vfs: {
      mounts: [
        { path: '/node', mode: 'read-write' },
        { path: '/', mode: 'read-write' },
      ],
    },
    // CITGM's npm test can materialize a very large package VFS in each
    // child. Keep the browser-side fan-out bounded so buffered test output
    // cannot exhaust the page before the package reports its result.
    workers: { entryModules: ['*'], maxChildren: 8 },
    ipc: { enabled: true },
    // CITGM exercises ordinary POSIX child-process behavior, including
    // signal forwarding. Grant the full browser-supported signal vocabulary
    // for compatibility tests; application manifests can remain narrower.
    signals: { allowed: [
      'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS',
      'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM',
      'SIGTERM', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
      'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO',
      'SIGPWR', 'SIGSYS',
    ] },
    output: { maxBytes: 16 * 1024 * 1024, stdoutBytes: 8 * 1024 * 1024, stderrBytes: 8 * 1024 * 1024 },
    envVars: { allowed: Object.keys(env) },
    proxy: { mode: 'proxy', enabled: true, capability: true },
    network: {
      origins: [DEFAULT_REGISTRY, 'https://github.com', 'https://codeload.github.com', ...(pageOrigin ? [pageOrigin] : [])],
      methods: ['GET', 'HEAD', 'OPTIONS'],
    },
    npm: { registries: [DEFAULT_REGISTRY], lifecycleScripts: false, allowedScripts: [] },
  };
}

function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

function byteLength(value) {
  if (value instanceof Uint8Array) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return new TextEncoder().encode(String(value ?? '')).byteLength;
}

function structuredCitgmStage(value) {
  const textValue = text(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const line of textValue.split(/\r?\n/)) {
    const normalized = line.trim();
    if (!/^(?:info|notice|citgm)\s*[:|-]/i.test(normalized)) continue;
    if (/\b(?:start(?:ing)?|run(?:ning)?|test(?:ing)?|execut(?:e|ing))\b/i.test(normalized)
      && /\b(?:citgm|test|candidate)\b/i.test(normalized)) {
      return 'upstream-test-execution';
    }
    if (/\b(?:pass(?:ed)?|fail(?:ed)?|complete(?:d)?|finish(?:ed)?)\b/i.test(normalized)
      && /\b(?:citgm|test|candidate)\b/i.test(normalized)) {
      return 'upstream-test-completion';
    }
  }
  return null;
}

async function runCitgm({ module, args = [], env = {}, timeoutMs = 15 * 60 * 1000, citgmVersion = DEFAULT_CITGM_VERSION, browser = 'unknown', progress: progressConfig = null, capture: captureConfig = null }) {
  if (running) throw new Error('a CITGM run is already active in this browser page');
  if (!module || typeof module !== 'string') throw new TypeError('module is required');
  running = true;

  const registry = String(env.npm_config_registry || DEFAULT_REGISTRY).replace(/\/+$/, '');
  const runEnv = {
    PATH: '/browser:/node/node_modules/.bin',
    // Keep the synthetic CITGM workspace out of a dot-prefixed directory.
    // Upstream packages such as send inspect every path component when
    // applying dotfile rules; placing the checkout under `.citgm` makes
    // ordinary fixtures look like hidden files.
    HOME: '/node/citgm/home',
    USERPROFILE: '/node/citgm/home',
    TEMP: '/node/citgm/tmp',
    TMP: '/node/citgm/tmp',
    TMPDIR: '/node/citgm/tmp',
    npm_config_registry: registry,
    npm_config_loglevel: 'error',
    // Chromium does not expose V8 precise-coverage data. Keep tap's
    // functional CITGM result authoritative instead of turning that missing
    // optional coverage report into a package-test failure.
    TAP_ALLOW_EMPTY_COVERAGE: '1',
    ...env,
  };
  const controller = new AbortController();
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15 * 60 * 1000;
  const runId = `citgm-${Date.now()}`;
  const retainProgressTrace = captureConfig?.progressBinding === undefined;
  const progressTrace = retainProgressTrace ? [] : null;
  const progressReporter = createProgressReporter({
    binding: progressConfig?.binding,
    runId,
    onEvent: (event) => progressTrace?.push(event),
  });
  const progress = {
    bootstrap: { events: 0, phases: {}, last: null },
    preload: { events: 0, phases: {}, last: null },
  };
  const retainNetworkTrace = typeof captureConfig?.networkBinding !== 'string';
  const networkEvents = retainNetworkTrace ? [] : null;
  let networkEventCount = 0;
  const outputCounters = {
    stdout: { bytes: 0, chunks: 0 },
    stderr: { bytes: 0, chunks: 0 },
  };
  const retainOutputChunks = typeof captureConfig?.outputBinding !== 'string';
  const outputChunks = retainOutputChunks ? { stdout: [], stderr: [] } : null;
  const capturePromises = new Set();
  const captureQueue = createSerializedCaptureQueue(globalThis);
  let installStats = null;
  let child = null;
  let timer = null;
  let livenessTimer = null;
  let currentStage = 'runtime-reset';

  const childActive = () => {
    const state = child?.state || child?._worker?.state;
    return state === 'starting' || state === 'running';
  };
  const childRuntimeState = () => {
    const worker = child?._worker;
    const runtimeState = worker?.runtimeState || child?.runtimeState;
    const boundedText = (value, limit = 256) => value == null ? null : String(value).slice(0, limit);
    const nodeTest = runtimeState?.nodeTest;
    const activity = runtimeState?.childActivity;
    const compactNestedState = (record) => {
      const handle = record?.processHandle;
      const state = handle?.runtimeState || handle?.terminalRecord?.runtimeState || handle?.__bnhRuntimeState;
      const nestedNodeTest = state?.nodeTest || handle?.__bnhNodeTestState;
      const lifecycle = state?.lifecycle || handle?.__bnhRuntimeLifecycle;
      if (!handle && !state && !nestedNodeTest && !lifecycle) return null;
      return {
        state: boundedText(handle?.state, 32),
        runtimePhase: boundedText(handle?.__bnhRuntimePhase || state?.phase, 64),
        nodeTest: nestedNodeTest ? {
          registered: Number(nestedNodeTest.registered) || 0,
          completed: Number(nestedNodeTest.completed) || 0,
          activeRun: Boolean(nestedNodeTest.activeRun),
          activeTest: nestedNodeTest.activeTest ? {
            name: boundedText(nestedNodeTest.activeTest.name, 160),
            fullName: boundedText(nestedNodeTest.activeTest.fullName, 240),
            file: boundedText(nestedNodeTest.activeTest.file, 256),
            state: boundedText(nestedNodeTest.activeTest.state, 32),
          } : null,
          streamTerminal: boundedText(nestedNodeTest.streamTerminal, 32),
          streamError: nestedNodeTest.streamError ? {
            name: boundedText(nestedNodeTest.streamError.name, 64),
            message: boundedText(nestedNodeTest.streamError.message || nestedNodeTest.streamError, 512),
          } : null,
        } : null,
        lifecycle: lifecycle ? {
          pending: Number(lifecycle.pending) || 0,
          tasks: Array.isArray(lifecycle.tasks) ? {
            count: lifecycle.tasks.length,
            first: lifecycle.tasks[0] ? {
              id: Number(lifecycle.tasks[0].id) || 0,
              label: boundedText(lifecycle.tasks[0].label, 128),
              stack: boundedText(lifecycle.tasks[0].stack, 160),
            } : null,
            last: lifecycle.tasks.at(-1) ? {
              id: Number(lifecycle.tasks.at(-1).id) || 0,
              label: boundedText(lifecycle.tasks.at(-1).label, 128),
              stack: boundedText(lifecycle.tasks.at(-1).stack, 160),
            } : null,
          } : null,
        } : null,
      };
    };
    return {
      state: boundedText(child?.state || worker?.state, 32),
      lifecycle: Array.isArray(child?.stateHistory || worker?.stateHistory)
        ? (child?.stateHistory || worker?.stateHistory).slice(-6).map((value) => boundedText(value, 32))
        : [],
      runtimePhase: boundedText(runtimeState?.phase, 64),
      nodeTest: nodeTest ? {
        registered: Number(nodeTest.registered) || 0,
        completed: Number(nodeTest.completed) || 0,
        activeRun: Boolean(nodeTest.activeRun),
        activeTest: nodeTest.activeTest ? {
          name: boundedText(nodeTest.activeTest.name, 160),
          fullName: boundedText(nodeTest.activeTest.fullName, 240),
          file: boundedText(nodeTest.activeTest.file, 256),
          state: boundedText(nodeTest.activeTest.state, 32),
        } : null,
        streamTerminal: boundedText(nodeTest.streamTerminal, 32),
        streamError: nodeTest.streamError ? {
          name: boundedText(nodeTest.streamError.name, 64),
          message: boundedText(nodeTest.streamError.message || nodeTest.streamError, 512),
        } : null,
      } : null,
      childActivity: activity ? {
        launched: Number(activity.launched) || 0,
        completed: Number(activity.completed) || 0,
        failed: Number(activity.failed) || 0,
        activeEsmChildren: Array.isArray(activity.activeEsmChildren)
          ? activity.activeEsmChildren.slice(-4).map((child) => ({
              entry: boundedText(child.entry, 256),
              cwd: boundedText(child.cwd, 256),
              mode: boundedText(child.mode, 32),
              state: boundedText(child.state, 32),
              runtimePhase: boundedText(child.runtimePhase, 64),
              files: Number(child.files) || 0,
              bytes: Number(child.bytes) || 0,
              nestedActivity: child.runtimeState?.childActivity ? {
                launched: Number(child.runtimeState.childActivity.launched) || 0,
                completed: Number(child.runtimeState.childActivity.completed) || 0,
                failed: Number(child.runtimeState.childActivity.failed) || 0,
                active: Array.isArray(child.runtimeState.childActivity.active)
                  ? child.runtimeState.childActivity.active.slice(-4).map((record) => ({
                    entry: boundedText(record.entry || record.command, 256),
                    argumentCount: Number(record.argumentCount) || 0,
                    phase: boundedText(record.phase, 64),
                    pending: Boolean(record.pending),
                    ipcMessageCount: Number(record.ipcMessageCount) || 0,
                    childState: record.childState || null,
                  }))
                  : [],
                recent: Array.isArray(child.runtimeState.childActivity.recent)
                  ? child.runtimeState.childActivity.recent.slice(-4).map((record) => ({
                    entry: boundedText(record.entry || record.command, 256),
                    argumentCount: Number(record.argumentCount) || 0,
                    phase: boundedText(record.phase, 64),
                    pending: Boolean(record.pending),
                    code: record.code ?? null,
                    signal: record.signal ?? null,
                    childState: record.childState || null,
                  }))
                  : [],
                liveVirtualProcesses: Array.isArray(child.runtimeState.childActivity.liveVirtualProcesses)
                  ? child.runtimeState.childActivity.liveVirtualProcesses.slice(-8).map((record) => ({
                    pid: Number(record.pid) || 0,
                    state: boundedText(record.state, 32),
                    terminal: Boolean(record.terminal),
                    ppid: Number(record.ppid) || 0,
                    cwd: boundedText(record.cwd, 256),
                    argv: Array.isArray(record.argv) ? record.argv.slice(0, 12).map((value) => boundedText(value, 256)) : [],
                    runtimePhase: boundedText(record.runtimePhase, 64),
                    lifecycle: record.lifecycle || null,
                  }))
                  : [],
                liveBrowserWorkers: Array.isArray(child.runtimeState.childActivity.liveBrowserWorkers)
                  ? child.runtimeState.childActivity.liveBrowserWorkers.slice(-8).map((record) => ({
                    threadId: Number(record.threadId) || -1,
                    state: boundedText(record.state, 32),
                    refed: record.refed == null ? null : Boolean(record.refed),
                    terminal: Boolean(record.terminal),
                  }))
                  : [],
              } : null,
              lifecycle: child.lifecycle ? {
                pending: Number(child.lifecycle.pending) || 0,
                tasks: Array.isArray(child.lifecycle.tasks) ? {
                  count: child.lifecycle.tasks.length,
                  first: child.lifecycle.tasks[0] ? {
                    id: Number(child.lifecycle.tasks[0].id) || 0,
                    label: boundedText(child.lifecycle.tasks[0].label, 128),
                    stack: boundedText(child.lifecycle.tasks[0].stack, 512),
                  } : null,
                  last: child.lifecycle.tasks.at(-1) ? {
                    id: Number(child.lifecycle.tasks.at(-1).id) || 0,
                    label: boundedText(child.lifecycle.tasks.at(-1).label, 128),
                    stack: boundedText(child.lifecycle.tasks.at(-1).stack, 512),
                  } : null,
                } : null,
              } : null,
            }))
          : [],
        recent: Array.isArray(activity.recent) ? activity.recent.slice(-4).map((record) => ({
          entry: boundedText(record.entry || record.command, 256),
          argumentCount: Number(record.argumentCount) || 0,
          code: record.code ?? null,
          signal: record.signal ?? null,
          pending: Boolean(record.pending),
          stdoutBytes: Number(record.stdoutBytes) || 0,
          stderrBytes: Number(record.stderrBytes) || 0,
          stdoutExcerpt: boundedText(record.stdoutExcerpt, 512) || '',
          stderrExcerpt: boundedText(record.stderrExcerpt, 512) || '',
          nestedState: record.nestedState || compactNestedState(record),
        })) : [],
        liveVirtualProcesses: Array.isArray(activity.liveVirtualProcesses)
          ? activity.liveVirtualProcesses.slice(-8).map((record) => ({
            pid: Number(record.pid) || 0,
            state: boundedText(record.state, 32),
            terminal: Boolean(record.terminal),
            ppid: Number(record.ppid) || 0,
            cwd: boundedText(record.cwd, 256),
            argv: Array.isArray(record.argv) ? record.argv.slice(0, 12).map((value) => boundedText(value, 256)) : [],
            runtimePhase: boundedText(record.runtimePhase, 64),
            lifecycle: record.lifecycle || null,
          }))
          : [],
        liveBrowserWorkers: Array.isArray(activity.liveBrowserWorkers)
          ? activity.liveBrowserWorkers.slice(-8).map((record) => ({
            threadId: Number(record.threadId) || -1,
            state: boundedText(record.state, 32),
            refed: record.refed == null ? null : Boolean(record.refed),
            terminal: Boolean(record.terminal),
          }))
          : [],
      } : null,
      terminal: child?.terminal || worker?.terminal ? {
        code: child?.terminal?.code ?? worker?.terminal?.code ?? null,
        signal: child?.terminal?.signal ?? worker?.terminal?.signal ?? null,
        kind: boundedText(child?.terminal?.kind || worker?.terminal?.kind, 32),
      } : null,
    };
  };
  const counters = () => ({
    npm: {
      citgmInstallEvents: progress.bootstrap.events,
      candidatePreloadEvents: progress.preload.events,
      citgmInstallPackages: installStats?.packages?.length || 0,
      citgmInstallFiles: installStats?.totalFiles || 0,
      candidatePreloadPackages: 0,
      candidatePreloadFiles: 0,
    },
    networkEvents: networkEventCount || networkEvents?.length || 0,
    output: {
      stdoutBytes: outputCounters.stdout.bytes,
      stdoutChunks: outputCounters.stdout.chunks,
      stderrBytes: outputCounters.stderr.bytes,
      stderrChunks: outputCounters.stderr.chunks,
      totalBytes: outputCounters.stdout.bytes + outputCounters.stderr.bytes,
      totalChunks: outputCounters.stdout.chunks + outputCounters.stderr.chunks,
    },
  });
  const report = (phase, event, fields = {}) => {
    progressReporter.emit(phase, event, {
      stage: currentStage,
      childActive: childActive(),
      counters: counters(),
      ...(event === 'child-running' || event === 'child-started' || event === 'upstream-test-started'
        ? { childState: childRuntimeState() } : {}),
      ...fields,
    });
  };
  const recordOutput = (stream, value) => {
    const target = outputCounters[stream];
    const bytes = value instanceof Uint8Array
      ? value.slice()
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
        : encoder.encode(text(value));
    outputChunks?.[stream].push(bytes);
    if (typeof captureConfig?.outputBinding === 'string') {
      try {
        const pending = captureQueue(captureConfig.outputBinding, {
          runId,
          stream,
          text: text(value),
        });
        capturePromises.add(pending);
        void pending.finally(() => capturePromises.delete(pending));
      } catch { /* capture is observational */ }
    }
    target.bytes += byteLength(value);
    target.chunks += 1;
    progressReporter.output(stream, value, {
      stage: currentStage,
      childActive: childActive(),
      counters: counters(),
    });
    const label = structuredCitgmStage(value);
    if (label) report('execution', 'stage-label', { label });
  };

  const recordProgress = (target, event) => {
    target.events += 1;
    target.phases[event.phase] = (target.phases[event.phase] || 0) + 1;
    target.last = { phase: event.phase };
    report(target === progress.bootstrap ? 'bootstrap' : 'preload', `npm-${event.phase}`, { events: target.events });
  };

  try {
    report('lifecycle', 'started', {
      stage: 'runtime-reset',
      module,
      spec: module,
      citgmVersion,
      browser: String(browser || 'unknown'),
      timeoutMs: timeout,
      childActive: false,
    });
    report('setup', 'runtime-reset-started');
    await runtime.reset({
      runId,
      variant: 'v22',
      env: runEnv,
      signal: controller.signal,
      capabilities: capabilitiesFor(runEnv),
      isolation: 'worker',
      proxy: { mode: 'proxy', enabled: true, capability: true, adapter: browserProxyAdapter },
    });
    report('setup', 'runtime-reset-complete');
    await runtime.mount({
      '/node/node_modules/.bin/node': NODE_BIN,
      '/node/node_modules/.bin/npm': NPM_BIN,
    });
    runtime.vfs.fs.chmodSync('/node/node_modules/.bin/node', 0o755);
    runtime.vfs.fs.chmodSync('/node/node_modules/.bin/npm', 0o755);

    const npm = new BrowserNpm({
      vfs: runtime.vfs,
      registry,
      cache: npmCache,
      globalObject: globalThis,
      proxyUrl: null,
      platform: 'browser',
      arch: 'browser',
      libc: 'browser',
    });
    const precacheUsed = await npmCache.loadArtifact(citgmVersion, module, registry);
    globalThis.__BNH_GIT_PROJECT_ARCHIVES__ = precacheUsed
      ? await materializeGitProjectArchives(npmCache)
      : [];
    currentStage = 'citgm-install';
    report('setup', 'citgm-install-started');
    timer = setTimeout(() => {
      currentStage = 'timeout';
      report('lifecycle', 'timeout', { timedOut: true, childActive: childActive() });
      controller.abort();
      void child?.kill();
    }, timeout);

    installStats = await npm.install(`citgm@${citgmVersion}`, {
      cwd: '/node',
      onProgress: (event) => recordProgress(progress.bootstrap, event),
    });
    await progressReporter.flush();
    report('setup', 'citgm-install-complete', { events: progress.bootstrap.events });

    // The candidate package and its dependencies are installed by the real
    // CITGM child after its worker is active. Persistent metadata/tarball
    // artifacts remain an acceleration layer, but execution must also work
    // on a cold cache through the live proxy/RPC fetch path.
    report('setup', 'candidate-dependency-preload-skipped', {
      reason: 'candidate-install-runs-on-demand-in-active-child',
    });
    npmCache.clearMemory();
    await runtime.mount({});
    const processArgv = createCitgmProcessArgv(CITGM_ENTRY, module, args);
    currentStage = 'child-launch';
    child = await runtime.spawn(
      ['node', CITGM_ENTRY],
      {
        cwd: '/node',
        env: runEnv,
        signal: controller.signal,
        timeout,
        npmCache: npmCacheSnapshot(npmCache),
        processArgv,
        onNetwork: (event) => {
          networkEventCount += 1;
          networkEvents?.push(event);
          if (typeof captureConfig?.networkBinding === 'string') {
            try {
            const pending = captureQueue(captureConfig.networkBinding, { runId, event });
              capturePromises.add(pending);
              void pending.finally(() => capturePromises.delete(pending));
            } catch { /* capture is observational */ }
          }
          report('execution', 'network-activity', { events: networkEventCount });
        },
        onStdout: (value) => recordOutput('stdout', value),
        onStderr: (value) => recordOutput('stderr', value),
      },
    );
    report('execution', 'child-started', {
      command: 'node',
      entry: CITGM_ENTRY,
      module,
      spec: module,
      script: 'citgm',
      argumentCount: Math.max(0, processArgv.length - 2),
      childActive: childActive(),
    });
    currentStage = 'upstream-test-execution';
    report('execution', 'upstream-test-started', {
      command: 'node',
      entry: CITGM_ENTRY,
      module,
      spec: module,
      script: 'citgm',
    });
    livenessTimer = setInterval(() => {
      if (!controller.signal.aborted && childActive()) report('execution', 'child-running');
    }, 5000);
    const exitCode = await child.exit;
    await progressReporter.flush();
    currentStage = 'completion';
    report('lifecycle', 'completed', { code: exitCode ?? null, childActive: false });
    await Promise.resolve();
    const [stdout, stderr] = await Promise.all([child.stdoutText(), child.stderrText()]);
    await Promise.all([...capturePromises]);
    const stdoutBytes = outputChunks ? concatBytes(outputChunks.stdout) : new Uint8Array();
    const stderrBytes = outputChunks ? concatBytes(outputChunks.stderr) : new Uint8Array();
    return {
      module,
      citgmVersion,
      exitCode,
      timedOut: controller.signal.aborted,
      stdout: text(stdout),
      stderr: text(stderr),
      stdoutBytes,
      stderrBytes,
      outputCounters: {
        stdout: { ...outputCounters.stdout },
        stderr: { ...outputCounters.stderr },
      },
      outputStats: {
        stdout: child.output?.stats?.('stdout') || null,
        stderr: child.output?.stats?.('stderr') || null,
      },
      runResult: child.structuredResult,
      precache: { used: precacheUsed, packages: npmCache.artifactManifest?.packageCount || 0 },
      install: { packages: installStats?.packages?.length || 0, files: installStats?.totalFiles || 0 },
      preload: { packages: 0, files: 0, enabled: false },
      output: {
        stdout: { ...outputCounters.stdout },
        stderr: { ...outputCounters.stderr },
      },
      progress,
      progressTrace,
      networkEvents: networkEvents || [],
    };
  } catch (error) {
    report('lifecycle', 'failed', { code: error?.code || 'ERR_CITGM_RUN' });
    return {
      module,
      citgmVersion,
      exitCode: 1,
      timedOut: controller.signal.aborted,
      stdout: '',
      stderr: '',
      stdoutBytes: outputChunks ? concatBytes(outputChunks.stdout) : new Uint8Array(),
      stderrBytes: outputChunks ? concatBytes(outputChunks.stderr) : new Uint8Array(),
      outputCounters: {
        stdout: { ...outputCounters.stdout },
        stderr: { ...outputCounters.stderr },
      },
      outputStats: { stdout: null, stderr: null },
      error: { name: error.name || 'Error', message: String(error.message || error), code: error.code || null },
      precache: { used: Boolean(npmCache.artifactManifest), packages: npmCache.artifactManifest?.packageCount || 0 },
      progress,
      progressTrace,
      networkEvents: networkEvents || [],
    };
  } finally {
    clearTimeout(timer);
    clearInterval(livenessTimer);
    await progressReporter.flush();
    await Promise.all([...capturePromises]);
    running = false;
  }
}

globalThis.__NACELLE_CITGM__ = Object.freeze({ run: runCitgm });
