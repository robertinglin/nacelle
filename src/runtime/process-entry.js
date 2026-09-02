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
  return cache;
}

export async function runProcessEntry(context) {
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
  const { profile, runtime } = runtimeFor(descriptor.nodeVersion);
  installProcessContract(context.process, { nodeProfile: profile });
  if (descriptor.npmCache?.rpc) {
    globalThis.__BNH_NPM_CACHE__ = createRemoteNpmCache(context);
  } else if (descriptor.npmCache) {
    const cache = new BrowserNpmCache({ globalObject: globalThis });
    cache.memoryMeta = new Map(Object.entries(descriptor.npmCache.metadata || {}));
    cache.memoryTarballs = new Map(Object.entries(descriptor.npmCache.tarballs || {}).map(([key, bytes]) => [
      key,
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    ]));
    globalThis.__BNH_NPM_CACHE__ = cache;
  } else {
    delete globalThis.__BNH_NPM_CACHE__;
  }
  const remoteVirtualNetwork = context.networkPort
    ? createRemoteVirtualNetwork({ port: context.networkPort })
    : null;
  // Network telemetry uses a control frame, not guest IPC. It cannot affect
  // the guest's own channel lifecycle or ordering when a process exits.
  if (descriptor.networkTelemetry !== true) delete context.process.__bnhNetworkEvent;
  await runtime.reset({
    runId: context.process.runId,
    capabilities: descriptor.capabilities,
    proxy: descriptor.proxy,
    vfsBackend: descriptor.vfsBackend,
    virtualNetwork: remoteVirtualNetwork
      ? { shared: true, network: remoteVirtualNetwork.network }
      : descriptor.virtualNetwork,
  });
  if (descriptor.vfsBackend) await runtime.mount({});
  else await runtime.mount(descriptor.files, { symlinks: descriptor.symlinks });
  let code;
  try {
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
  if (descriptor.capabilities.ipc.enabled && context.process.connected) {
    const declared = descriptor.capabilities.vfs.mounts.some((mount) => mount.artifacts?.length);
    const artifacts = declared ? runtime.exportArtifacts() : { version: 1, artifacts: [] };
    await context.process.send({ type: 'bnh-artifacts', artifacts });
  }
  return code;
}

// The process contract owns the bootstrap and lifecycle protocol. This module
// only supplies the browser runtime entry that the registered worker invokes.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.__bnhRun = runProcessEntry;
  eval(PROCESS_WORKER_SOURCE);
}
