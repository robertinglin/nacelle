import { createRuntime } from '../runtime.js';
import { PROCESS_WORKER_SOURCE } from './process-worker.js';
import { installProcessContract } from './process.js';
import { BrowserNpmCache } from './npm.js';
import { resolveNodeVersionProfile } from '../versions/index.js';
import { createRemoteVirtualNetwork } from './virtual-network.js';

const runtimes = new Map();

function runtimeFor(nodeVersion) {
  const profile = resolveNodeVersionProfile(nodeVersion || 'lts');
  let runtime = runtimes.get(profile.id);
  if (!runtime) {
    runtime = createRuntime({ globalObject: globalThis, nodeProfile: profile });
    runtimes.set(profile.id, runtime);
  }
  return { profile, runtime };
}

function createRemoteNpmCache(context) {
  const cache = new BrowserNpmCache({ globalObject: globalThis });
  const request = (resource) => context.process.__bnhProxyRequest('request', {
    __bnhNpmCache: true,
    ...resource,
  });
  cache.getMetadata = async (name) => {
    const result = await request({ type: 'metadata', name });
    return result?.metadata || null;
  };
  cache.getTarball = async (key) => {
    const result = await request({ type: 'tarball', key });
    if (!result?.bytes) return null;
    return result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
  };
  cache.getUnpackedPackage = async (name, version) => {
    const result = await request({ type: 'package-entries', name, version });
    if (!result?.entries) return null;
    return result.entries.map((entry) => ({
      ...entry,
      data: entry.data instanceof Uint8Array ? entry.data : entry.data ? new Uint8Array(entry.data) : entry.data,
    }));
  };
  // A worker may need to download a package after it has started. Publish
  // newly fetched cache records to the owning page, but do not retain a
  // second worker-local copy of the tarball or unpacked package graph.
  cache.setMetadata = async (name, metadata) => {
    await request({ type: 'set-metadata', name, metadata });
  };
  cache.setTarball = async (key, bytes, meta = {}) => {
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await request({
      type: 'set-tarball',
      key,
      bytes: value,
      name: meta.name || '',
      version: meta.version || '',
    });
  };
  cache.setUnpackedPackage = () => {};
  return cache;
}

export async function runProcessEntry(context) {
  const setRuntimePhase = (phase) => {
    if (context.process) {
      context.process.__bnhRuntimePhase = phase;
      context.process.__bnhReportRuntimeState?.();
    }
  };
  setRuntimePhase('bootstrap');
  const sourceDescriptor = context.vfs;
  const proxyOperations = new Set(sourceDescriptor?.proxy?.operations || []);
  const descriptor = sourceDescriptor?.proxy?.rpc
    ? {
        ...sourceDescriptor,
        proxy: {
          ...sourceDescriptor.proxy,
          adapter: {
            ...(proxyOperations.has('request') ? {
              request: async (request) => {
                if (typeof context.process?.__bnhProxyRequest !== 'function') {
                  const error = new Error('proxy RPC is unavailable in this worker');
                  error.code = 'ERR_NACELLE_PROXY_RPC_UNAVAILABLE';
                  throw error;
                }
                return context.process.__bnhProxyRequest('request', request);
              },
            } : {}),
            ...(proxyOperations.has('connect') ? {
              connect: (request) => context.process.__bnhProxyRequest('connect', { ...request, client: undefined }),
            } : {}),
            ...(proxyOperations.has('send') ? {
              send: (request) => context.process.__bnhProxyRequest('send', request),
            } : {}),
            ...(proxyOperations.has('resolve') ? {
              resolve: (request) => context.process.__bnhProxyRequest('resolve', request),
            } : {}),
            ...(proxyOperations.has('tls') ? {
              tls: (request) => context.process.__bnhProxyRequest('tls', request),
            } : {}),
          },
        },
      }
    : sourceDescriptor;
  if (!descriptor?.capabilities || !descriptor.files) {
    const error = new Error('worker VFS descriptor is missing');
    error.code = 'ERR_INVALID_CAPABILITY';
    throw error;
  }
  const profile = resolveNodeVersionProfile(descriptor.nodeVersion || 'lts');
  const runtime = context.runtimeInstance || runtimeFor(profile.id).runtime;
  setRuntimePhase('install-process');
  installProcessContract(context.process, { nodeProfile: profile });
  if (descriptor.esmNested) context.process.__bnhEsmNested = true;
  if (descriptor.npmCache) {
    const cache = new BrowserNpmCache({ globalObject: globalThis });
    cache.memoryMeta = new Map(Object.entries(descriptor.npmCache.metadata || {}));
    cache.memoryTarballs = new Map(Object.entries(descriptor.npmCache.tarballs || {}).map(([key, bytes]) => [
      key,
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    ]));
    const artifact = descriptor.npmCache.artifact;
    const artifactBaseUrl = typeof artifact?.baseUrl === 'string' ? artifact.baseUrl : null;
    const artifactFetch = async (relative) => {
      if (!artifactBaseUrl || typeof relative !== 'string' || typeof globalThis.fetch !== 'function') return null;
      try {
        const response = await globalThis.fetch(new URL(relative, artifactBaseUrl));
        if (!response.ok) return null;
        return response;
      } catch {
        return null;
      }
    };
    if (artifactBaseUrl) {
      const getMetadata = cache.getMetadata.bind(cache);
      cache.getMetadata = async (packageName) => {
        const relative = artifact.metadata?.[packageName];
        const response = await artifactFetch(relative);
        if (response) {
          const metadata = await response.json();
          cache.memoryMeta.set(packageName, metadata);
          return metadata;
        }
        return getMetadata(packageName);
      };
      const getTarball = cache.getTarball.bind(cache);
      cache.getTarball = async (key) => {
        const rawKey = key.replace(/^(?:pkg-tarball:|tarball:|pkg:)/, '');
        const candidateKeys = [key, rawKey, `tarball:${rawKey}`, `pkg-tarball:${rawKey}`, `pkg:${rawKey}`];
        const relative = candidateKeys.map((candidate) => artifact.tarballs?.[candidate]).find(Boolean);
        const response = await artifactFetch(relative);
        if (response) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          cache.memoryTarballs.set(key, bytes);
          return bytes;
        }
        return getTarball(key);
      };
    }
    globalThis.__BNH_NPM_CACHE__ = cache;
  } else {
    delete globalThis.__BNH_NPM_CACHE__;
  }
  const remoteVirtualNetwork = context.networkPort
    ? createRemoteVirtualNetwork({
        port: context.networkPort,
        transport: descriptor.proxy?.rpc ? descriptor.proxy.adapter : undefined,
      })
    : null;
  // Network telemetry uses a control frame, not guest IPC. It cannot affect
  // the guest's own channel lifecycle or ordering when a process exits.
  if (descriptor.networkTelemetry !== true) delete context.process.__bnhNetworkEvent;
  setRuntimePhase('reset');
  await runtime.reset({
    runId: context.process.runId,
    capabilities: descriptor.capabilities,
    proxy: descriptor.proxy,
    vfsBackend: descriptor.vfsBackend,
    virtualNetwork: remoteVirtualNetwork
      ? { shared: true, network: remoteVirtualNetwork.network }
      : descriptor.virtualNetwork,
  });
  setRuntimePhase('mount');
  if (descriptor.vfsBackend) {
    await runtime.mount({});
    // A same-realm child normally sees the shared backend immediately. Keep
    // the serialized file view as a generic fallback for runtimes that are
    // attached before that backend becomes visible; only missing entries are
    // mounted, so existing files and live handles retain their identity.
    const missingFiles = Object.fromEntries(
      Object.entries(descriptor.files || {}).filter(([path, value]) => (
        value?.type !== 'directory' && !runtime.vfs.files.has(path)
      )),
    );
    const missingSymlinks = (descriptor.symlinks || []).filter(([path]) => !runtime.vfs.files.has(path));
    if (Object.keys(missingFiles).length || missingSymlinks.length) {
      await runtime.mount(missingFiles, { symlinks: missingSymlinks, copyBuffers: false });
    }
  } else await runtime.mount(descriptor.files, { symlinks: descriptor.symlinks, copyBuffers: false });
  const vfsUpdatePort = context.vfsUpdatePort || descriptor.vfsUpdatePort;
  const onVfsUpdate = (event) => {
    const update = event?.data ?? event;
    if (update && typeof update === 'object') runtime.applyVfsUpdate?.(update);
  };
  if (vfsUpdatePort) {
    if (typeof vfsUpdatePort.addEventListener === 'function') vfsUpdatePort.addEventListener('message', onVfsUpdate);
    else if (typeof vfsUpdatePort.on === 'function') vfsUpdatePort.on('message', onVfsUpdate);
    vfsUpdatePort.start?.();
  }
  let code;
  try {
    setRuntimePhase('execute');
    code = await runtime.executeEntry(
      descriptor.entry,
      {
        processObject: context.process,
        argv: context.process.argv,
        execArgv: descriptor.execArgv || [],
        env: context.process.env,
        cwd: context.process.cwd(),
        workerThread: Boolean(descriptor.workerThread),
        threadId: descriptor.threadId,
        threadName: descriptor.threadName,
        workerData: descriptor.workerData,
        environmentData: descriptor.environmentData,
        resourceLimits: descriptor.resourceLimits,
      },
      (value) => context.stdout(value),
      (value) => context.stderr(value),
    );
  } catch (error) {
    context.stderr(`${error?.stack || error}\n`);
    throw error;
  } finally {
    setRuntimePhase('cleanup');
    vfsUpdatePort?.removeEventListener?.('message', onVfsUpdate);
    vfsUpdatePort?.off?.('message', onVfsUpdate);
    vfsUpdatePort?.close?.();
    remoteVirtualNetwork?.close();
  }
  const uncaught = context.process?.__bnhUncaughtException;
  if (uncaught) {
    const error = Object.assign(new Error(String(uncaught.message || uncaught)), {
      name: uncaught.name || 'Error',
      stack: uncaught.stack,
      code: uncaught.code || 'ERR_WORKER_EXCEPTION',
    });
    delete context.process.__bnhUncaughtException;
    throw error;
  }
  // The outer browser worker owns the terminal frame. Preserve the code
  // computed by the injected runtime process so natural completion reports
  // process.exitCode instead of the bootstrap default of zero.
  if (context.process && Number.isInteger(code)) context.process.exitCode = code;
  setRuntimePhase('terminal-state');
  if (descriptor.capabilities.ipc.enabled && context.process.connected) {
    const runtimeState = {
      exitCode: context.process.exitCode,
      runtimeCode: code,
      nodeTest: context.process.__bnhNodeTestState || null,
      childActivity: context.process.__bnhChildActivity || null,
      child_outputs: context.process.__bnhChildOutputs || [],
    };
    context.process.__bnhRuntimeState = runtimeState;
    const sendRuntimeState = context.process.__bnhSendInternal || context.process.send;
    await sendRuntimeState.call(context.process, { type: 'bnh-runtime-state', state: runtimeState });
    const declared = descriptor.capabilities.vfs.mounts.some((mount) => mount.artifacts?.length);
    const artifacts = declared ? runtime.exportArtifacts() : { version: 1, artifacts: [] };
    const sendInternal = context.process.__bnhSendInternal || context.process.send;
    await sendInternal.call(context.process, { type: 'bnh-artifacts', artifacts });
  }
  return code;
}

// The process contract owns the bootstrap and lifecycle protocol. This module
// only supplies the browser runtime entry that the registered worker invokes.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.__bnhRun = runProcessEntry;
  eval(PROCESS_WORKER_SOURCE);
}
