import { BrowserNpm, BrowserNpmCache } from './runtime/npm.js';
import { createRuntime } from './runtime.js';
import { createVfs } from './runtime/vfs.js';
import { createProgressReporter } from './progress-protocol.mjs';

const DEFAULT_CITGM_VERSION = '10.0.2';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const CITGM_ENTRY = '/node/node_modules/citgm/bin/citgm.js';
const NODE_BIN = new TextEncoder().encode('#!/usr/bin/env node\n');
const NPM_BIN = new TextEncoder().encode('#!/usr/bin/env node\n');
const browserFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const encoder = new TextEncoder();

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
    if (!browserFetch) {
      transport.destroy(new Error('browser fetch is unavailable'));
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
        : await browserFetch(url, {
            method,
            headers,
            body: body?.byteLength ? body : undefined,
            signal: controller.signal,
            redirect: 'follow',
          });
      const responseBody = new Uint8Array(await response.arrayBuffer());
      const responseHeaders = [`HTTP/1.1 ${response.status} ${response.statusText || ''}`.trim()];
      for (const [name, value] of response.headers) {
        if (name.toLowerCase() !== 'connection') responseHeaders.push(`${name}: ${value}`);
      }
      if (!response.headers.has('content-length')) responseHeaders.push(`content-length: ${responseBody.byteLength}`);
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
  return {
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
}

const runtime = createRuntime({ globalObject: globalThis, nodeVersion: 'v22' });
const npmCache = new ArtifactNpmCache({ globalObject: globalThis });
const browserProxyAdapter = createBrowserProxyAdapter((url) => npmCache.getProject(url));
globalThis.__BNH_NPM_CACHE__ = npmCache;
let running = false;

function capabilitiesFor(env) {
  return {
    vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
    workers: { entryModules: ['*'], maxChildren: 32 },
    ipc: { enabled: true },
    signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
    output: { maxBytes: 16 * 1024 * 1024, stdoutBytes: 8 * 1024 * 1024, stderrBytes: 8 * 1024 * 1024 },
    envVars: { allowed: Object.keys(env) },
    proxy: { mode: 'proxy', enabled: true, capability: true },
    network: {
      origins: [DEFAULT_REGISTRY, 'https://github.com', 'https://codeload.github.com'],
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

function npmCacheSnapshot(cache) {
  return {
    metadata: Object.fromEntries(cache.memoryMeta),
    tarballs: Object.fromEntries([...cache.memoryTarballs.entries()].map(([key, bytes]) => [
      key,
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    ])),
  };
}

async function runCitgm({ module, args = [], env = {}, timeoutMs = 15 * 60 * 1000, citgmVersion = DEFAULT_CITGM_VERSION, progress: progressConfig = null }) {
  if (running) throw new Error('a CITGM run is already active in this browser page');
  if (!module || typeof module !== 'string') throw new TypeError('module is required');
  running = true;

  const registry = String(env.npm_config_registry || DEFAULT_REGISTRY).replace(/\/+$/, '');
  const runEnv = {
    PATH: '/node/node_modules/.bin',
    HOME: '/node/.citgm/home',
    USERPROFILE: '/node/.citgm/home',
    TEMP: '/node/.citgm/tmp',
    TMP: '/node/.citgm/tmp',
    TMPDIR: '/node/.citgm/tmp',
    npm_config_registry: registry,
    npm_config_loglevel: 'error',
    ...env,
  };
  const controller = new AbortController();
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15 * 60 * 1000;
  const runId = `citgm-${Date.now()}`;
  const progressReporter = createProgressReporter({
    binding: progressConfig?.binding,
    runId,
  });
  const progress = {
    bootstrap: { events: 0, phases: {}, last: null },
    preload: { events: 0, phases: {}, last: null },
  };
  const networkEvents = [];
  let child = null;
  let timer = null;
  let livenessTimer = null;

  const recordProgress = (target, event) => {
    target.events += 1;
    target.phases[event.phase] = (target.phases[event.phase] || 0) + 1;
    target.last = { phase: event.phase };
    progressReporter.emit(target === progress.bootstrap ? 'bootstrap' : 'preload', `npm-${event.phase}`, {
      events: target.events,
    });
  };

  try {
    progressReporter.emit('lifecycle', 'started');
    progressReporter.emit('setup', 'runtime-reset-started');
    await runtime.reset({
      runId,
      variant: 'v22',
      env: runEnv,
      signal: controller.signal,
      capabilities: capabilitiesFor(runEnv),
      isolation: 'worker',
      proxy: { mode: 'proxy', enabled: true, capability: true, adapter: browserProxyAdapter },
    });
    progressReporter.emit('setup', 'runtime-reset-complete');
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
    timer = setTimeout(() => {
      progressReporter.emit('lifecycle', 'timeout', { timedOut: true });
      controller.abort();
      void child?.kill();
    }, timeout);

    const install = await npm.install(`citgm@${citgmVersion}`, {
      cwd: '/node',
      onProgress: (event) => recordProgress(progress.bootstrap, event),
    });
    await progressReporter.flush();
    progressReporter.emit('setup', 'citgm-install-complete', { events: progress.bootstrap.events });

    let preloadSummary;
    {
      const preloadVfs = createVfs({
        mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }],
      });
      const preloadNpm = new BrowserNpm({
        vfs: preloadVfs,
        registry,
        cache: npmCache,
        globalObject: globalThis,
        proxyUrl: null,
        platform: 'browser',
        arch: 'browser',
        libc: 'browser',
      });
      const preload = await preloadNpm.install(module, {
        cwd: '/node',
        nodeModulesDir: '/node/node_modules',
        includeDevDependencies: true,
        materialize: false,
        onProgress: (event) => recordProgress(progress.preload, event),
      });
      preloadSummary = { packages: preload.packages.length, files: preload.totalFiles };
    }
    await progressReporter.flush();
    progressReporter.emit('setup', 'dependency-preload-complete', { events: progress.preload.events });
    await runtime.mount({});

    const processArgv = ['node', CITGM_ENTRY, ...args, module];
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
          networkEvents.push(event);
          progressReporter.emit('execution', 'network-activity', { events: networkEvents.length });
        },
        onStdout: (value) => progressReporter.output('stdout', value),
        onStderr: (value) => progressReporter.output('stderr', value),
      },
    );
    progressReporter.emit('execution', 'child-started');
    livenessTimer = setInterval(() => {
      const state = child?.state || child?._worker?.state;
      if (state === 'running') progressReporter.emit('execution', 'child-running');
    }, 5000);
    const exitCode = await child.exit;
    await progressReporter.flush();
    progressReporter.emit('lifecycle', 'completed', { code: exitCode ?? null });
    await Promise.resolve();
    const [stdout, stderr] = await Promise.all([child.stdoutText(), child.stderrText()]);
    return {
      module,
      citgmVersion,
      exitCode,
      timedOut: controller.signal.aborted,
      stdout: text(stdout),
      stderr: text(stderr),
      runResult: child.structuredResult,
      precache: { used: precacheUsed, packages: npmCache.artifactManifest?.packageCount || 0 },
      install: { packages: install.packages.length, files: install.totalFiles },
      preload: preloadSummary,
      progress,
      networkEvents,
    };
  } catch (error) {
    progressReporter.emit('lifecycle', 'failed', { code: error?.code || 'ERR_CITGM_RUN' });
    return {
      module,
      citgmVersion,
      exitCode: 1,
      timedOut: controller.signal.aborted,
      stdout: '',
      stderr: '',
      error: { name: error.name || 'Error', message: String(error.message || error), code: error.code || null },
      precache: { used: Boolean(npmCache.artifactManifest), packages: npmCache.artifactManifest?.packageCount || 0 },
      progress,
      networkEvents,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(livenessTimer);
    await progressReporter.flush();
    running = false;
  }
}

globalThis.__NACELLE_CITGM__ = Object.freeze({ run: runCitgm });
