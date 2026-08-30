// The supplied bridge uses the shared browser-native runtime as its base.
// Keep this page-side layer thin; target projects extend the runtime library.
import { createRuntime } from './runtime.js';
import { resolveNodeVersionProfile } from './versions/index.js';

function decodeBase64(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const materializationCache = new Map();
const runtimes = new Map();

function runtimeFor(variant) {
  const profile = resolveNodeVersionProfile(variant || 'lts');
  let runtime = runtimes.get(profile.id);
  if (!runtime) {
    runtime = createRuntime({ globalObject: globalThis, nodeProfile: profile });
    runtimes.set(profile.id, runtime);
  }
  return runtime;
}

async function materialize(files, sourceSha256 = '') {
  const tree = {};
  const read = globalThis[files.readBinding];
  if (typeof read !== 'function') throw new Error(`missing Playwright file binding: ${files.readBinding}`);
  for (const item of files.manifest) {
    const cacheKey = item.path === files.entry
      ? `${item.path}:${item.bytes}:${sourceSha256}`
      : `${item.path}:${item.bytes}`;
    let bytes = materializationCache.get(cacheKey);
    if (!bytes) {
      const encoded = await read(item.path);
      if (encoded?.encoding !== 'base64' || typeof encoded.data !== 'string') {
        throw new Error(`invalid file binding response for ${item.path}`);
      }
      bytes = decodeBase64(encoded.data);
      materializationCache.set(cacheKey, bytes);
    }
    tree[item.path] = bytes;
  }
  return tree;
}

function requestVariant(request) {
  return request.variant
    ?? request.metadata?.variant
    ?? request.context?.variant
    ?? request.env?.BNH_VARIANT
    ?? undefined;
}

function timeoutMsFor(request) {
  const timeoutMs = Number(request.timeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
}

function failureResult(runId, phase, error, outcome = 'failed') {
  return {
    runId,
    outcome,
    phase,
    exit: { code: null, signal: null, reason: error?.code || 'browser-failure' },
    error: error ? {
      code: error.code || 'ERR_BROWSER_RUNTIME',
      name: error.name || 'Error',
      message: String(error.message || error),
      details: error.details || null,
    } : null,
    stdout: new Uint8Array(0),
    stderr: new Uint8Array(0),
    outputEvents: [],
    lifecycleEvents: [],
    artifacts: {},
  };
}

async function readChild(child, waitMs = undefined) {
  const read = async () => {
    const [exitCode, stdout, stderr] = await Promise.all([
      Promise.resolve(child.exit),
      Promise.resolve(child.stdoutText()),
      Promise.resolve(child.stderrText()),
    ]);
    return { exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  };
  if (waitMs === undefined) return await read();
  return await Promise.race([
    read(),
    new Promise((resolve) => setTimeout(() => resolve({ exitCode: null, stdout: '', stderr: '' }), waitMs)),
  ]);
}

globalThis.__BROWSER_NODE_HARNESS__ = {
  async run(request) {
    const variant = requestVariant(request);
    const env = { ...(request.env || {}) };
    if (variant && !env.BNH_VARIANT) env.BNH_VARIANT = variant;
    const metadata = { ...(request.metadata || {}), ...(variant ? { variant } : {}) };
    const controller = new AbortController();
    const timeoutMs = timeoutMsFor(request);
    let child = null;
    let runtime = null;
    let timedOut = false;
    let timeoutTimer;

    const runtimeContext = { env, variant, metadata, signal: controller.signal };
    const runId = String(request.context?.run_id || request.metadata?.runId || `browser-${Date.now()}`);
    runtimeContext.runId = runId;
    runtimeContext.capabilities = request.capabilities;
    runtimeContext.proxy = request.proxy;
    runtimeContext.fixtures = request.fixtures;
    const stopChild = async () => {
      if (!child) return;
      try { await child.kill(); } catch { /* already exited */ }
    };
    const deadline = new Promise((resolve) => {
      timeoutTimer = setTimeout(async () => {
        timedOut = true;
        controller.abort();
        void stopChild();
        resolve({ timedOut: true });
      }, timeoutMs);
    });
    const execute = (async () => {
      runtime = runtimeFor(variant);
      if (controller.signal.aborted) return { exitCode: null, cancelled: true };
      await runtime.reset(runtimeContext);
      if (controller.signal.aborted) return { exitCode: null, cancelled: true };
      const files = await materialize(request.files, request.metadata?.sourceSha256 || '');
      if (controller.signal.aborted) return { exitCode: null, cancelled: true };
      await runtime.mount(files, runtimeContext);
      if (controller.signal.aborted) return { exitCode: null, cancelled: true };
      child = await runtime.spawn(
        ['node', ...(request.flags || []), request.entry],
        { cwd: '/node', env, variant, metadata, signal: controller.signal },
      );
      if (timedOut) {
        await stopChild();
        return { exitCode: null, stdout: '', stderr: '' };
      }
      const result = await readChild(child);
      return { ...result, structuredResult: child.structuredResult };
    })();

    try {
      const result = await Promise.race([execute, deadline]);
      if (result.timedOut) {
        const partial = child
          ? await readChild(child, 250)
          : { exitCode: null, stdout: '', stderr: '' };
        return {
          exitCode: null,
          stdout: partial.stdout,
          stderr: partial.stderr,
          timedOut: true,
          runResult: failureResult(runId, 'shutdown', Object.assign(new Error('browser run timed out'), { code: 'ERR_RUN_TIMEOUT' }), 'timed_out'),
          details: { runtimeVersion: runtime?.version || null, variant, metadata, tty_supported: false },
        };
      }
      const runResult = result.structuredResult || failureResult(runId, 'running', new Error('browser runtime returned no structured result'));
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: false,
        runResult,
        details: { runtimeVersion: runtime?.version || null, variant, metadata, tty_supported: false },
      };
    } catch (error) {
      const phase = error?.code === 'ERR_CAPABILITY_DENIED' || error?.code === 'ERR_INVALID_CAPABILITY'
        ? 'setup'
        : 'launch';
      const runResult = failureResult(runId, phase, error, error?.code === 'ERR_NOT_SUPPORTED' ? 'unsupported' : 'failed');
      return { exitCode: null, stdout: '', stderr: String(error?.stack || error), timedOut: false, runResult, details: { runtimeVersion: runtime?.version || null, variant, metadata, tty_supported: false } };
    } finally {
      clearTimeout(timeoutTimer);
    }
  },
};
