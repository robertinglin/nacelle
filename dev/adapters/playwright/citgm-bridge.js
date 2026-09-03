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

function createFetchTransport(host, port, loadCachedResource) {
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
      const cachedBody = method === 'GET' ? await loadCachedResource?.(url) : null;
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

function createBrowserProxyAdapter(loadCachedResource) {
  return {
    async request(request = {}) {
      if (request.__bnhNpmCache !== true) return null;
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
      return null;
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
        transport: createFetchTransport(String(clientHost), Number(request.port), loadCachedResource),
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
    if (this.memoryMeta.has(packageName)) return this.memoryMeta.get(packageName);
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
    for (const candidate of candidateKeys) {
      if (this.memoryTarballs.has(candidate)) return this.memoryTarballs.get(candidate);
    }
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
const browserProxyAdapter = createBrowserProxyAdapter(async (url) => {
  const project = await npmCache.getProject(url);
  if (project) return project;
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

function progressIdentity(value, limit = 128) {
  return text(value).replace(/[^a-zA-Z0-9@._/:=-]/g, '_').slice(0, limit);
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

async function runCitgm({ module, args = [], env = {}, timeoutMs = 15 * 60 * 1000, citgmVersion = DEFAULT_CITGM_VERSION, browser = 'unknown', progress: progressConfig = null }) {
  if (running) throw new Error('a CITGM run is already active in this browser page');
  if (!module || typeof module !== 'string') throw new TypeError('module is required');
  running = true;
  // Unpacked package contents are an ephemeral acceleration layer. Keep it
  // scoped to this CITGM invocation so repeated runs cannot retain an
  // unbounded second copy of the persistent tarball cache.
  npmCache.clearUnpackedPackages();

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
  const childIdentity = {
    module: progressIdentity(module),
    spec: progressIdentity(module),
    citgmVersion: progressIdentity(citgmVersion),
    browser: progressIdentity(browser || 'unknown', 32),
    command: 'node',
    entry: CITGM_ENTRY,
  };
  const progressReporter = createProgressReporter({
    binding: progressConfig?.binding,
    runId,
  });
  const progress = {
    bootstrap: { events: 0, phases: {}, last: null },
    preload: { events: 0, phases: {}, last: null },
  };
  const networkEvents = [];
  const outputCounters = {
    stdout: { bytes: 0, chunks: 0 },
    stderr: { bytes: 0, chunks: 0 },
  };
  const outputChunks = { stdout: [], stderr: [] };
  let installStats = null;
  let preloadStats = null;
  let child = null;
  let timer = null;
  let livenessTimer = null;
  let currentStage = 'runtime-reset';

  const childActive = () => {
    const state = child?.state || child?._worker?.state;
    return state === 'starting' || state === 'running';
  };
  const counters = () => ({
    npm: {
      citgmInstallEvents: progress.bootstrap.events,
      candidatePreloadEvents: progress.preload.events,
      citgmInstallPackages: installStats?.packages?.length || 0,
      citgmInstallFiles: installStats?.totalFiles || 0,
      candidatePreloadPackages: preloadStats?.packages?.length || 0,
      candidatePreloadFiles: preloadStats?.totalFiles || 0,
    },
    networkEvents: networkEvents.length,
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
    outputChunks[stream].push(bytes);
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
    currentStage = 'candidate-dependency-preload';
    report('setup', 'candidate-dependency-preload-started');
    preloadStats = await preloadNpm.install(module, {
      cwd: '/node',
      nodeModulesDir: '/node/node_modules',
      includeDevDependencies: true,
      materialize: false,
      cacheUnpacked: true,
      onProgress: (event) => recordProgress(progress.preload, event),
    });
    await progressReporter.flush();
    report('setup', 'candidate-dependency-preload-complete', { events: progress.preload.events });
    await runtime.mount({});

    const processArgv = ['node', CITGM_ENTRY, ...args, module];
    currentStage = 'child-launch';
    child = await runtime.spawn(
      ['node', CITGM_ENTRY],
      {
        cwd: '/node',
        env: runEnv,
        signal: controller.signal,
        timeout,
        npmCache: { rpc: true },
        processArgv,
        onNetwork: (event) => {
          networkEvents.push(event);
          report('execution', 'network-activity', { events: networkEvents.length });
        },
        onStdout: (value) => recordOutput('stdout', value),
        onStderr: (value) => recordOutput('stderr', value),
      },
    );
    report('execution', 'child-started', {
      ...childIdentity,
      testStage: 'citgm-runner',
      script: 'citgm',
      argumentCount: Math.max(0, processArgv.length - 2),
      childActive: childActive(),
    });
    currentStage = 'upstream-test-execution';
    report('execution', 'upstream-test-started', {
      ...childIdentity,
      testStage: 'package-manager-test',
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
    const stdoutBytes = concatBytes(outputChunks.stdout);
    const stderrBytes = concatBytes(outputChunks.stderr);
    return {
      module,
      runId,
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
      preload: { packages: preloadStats?.packages?.length || 0, files: preloadStats?.totalFiles || 0 },
      output: {
        stdout: { ...outputCounters.stdout },
        stderr: { ...outputCounters.stderr },
      },
      progress,
      networkEvents,
    };
  } catch (error) {
    report('lifecycle', 'failed', { code: error?.code || 'ERR_CITGM_RUN' });
    return {
      module,
      runId,
      citgmVersion,
      exitCode: 1,
      timedOut: controller.signal.aborted,
      stdout: '',
      stderr: '',
      stdoutBytes: concatBytes(outputChunks.stdout),
      stderrBytes: concatBytes(outputChunks.stderr),
      outputCounters: {
        stdout: { ...outputCounters.stdout },
        stderr: { ...outputCounters.stderr },
      },
      outputStats: { stdout: null, stderr: null },
      error: { name: error.name || 'Error', message: String(error.message || error), code: error.code || null },
      precache: { used: Boolean(npmCache.artifactManifest), packages: npmCache.artifactManifest?.packageCount || 0 },
      output: {
        stdout: { ...outputCounters.stdout },
        stderr: { ...outputCounters.stderr },
      },
      progress,
      networkEvents,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(livenessTimer);
    await progressReporter.flush();
    npmCache.clearUnpackedPackages();
    running = false;
  }
}

globalThis.__NACELLE_CITGM__ = Object.freeze({ run: runCitgm });
