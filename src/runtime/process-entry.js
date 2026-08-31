import { createRuntime } from '../runtime.js';
import { PROCESS_WORKER_SOURCE } from './process-worker.js';
import { installProcessContract } from './process.js';
import { resolveNodeVersionProfile } from '../versions/index.js';

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

export async function runProcessEntry(context) {
  const sourceDescriptor = context.vfs;
  const descriptor = sourceDescriptor?.proxy?.rpc
    ? {
        ...sourceDescriptor,
        proxy: {
          ...sourceDescriptor.proxy,
          adapter: {
            request: async (request) => {
              if (typeof context.process?.__bnhProxyRequest !== 'function') {
                const error = new Error('proxy RPC is unavailable in this worker');
                error.code = 'ERR_NACELLE_PROXY_RPC_UNAVAILABLE';
                throw error;
              }
              return context.process.__bnhProxyRequest(request);
            },
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
  await runtime.reset({
    runId: context.process.runId,
    capabilities: descriptor.capabilities,
    proxy: descriptor.proxy,
    virtualNetwork: descriptor.virtualNetwork,
  });
  await runtime.mount(descriptor.files, { symlinks: descriptor.symlinks });
  const code = await runtime.executeEntry(
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
