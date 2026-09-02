// The supplied bridge uses the shared browser-native runtime as its base.
// Keep this page-side layer thin; target projects extend the runtime library.
import { createRuntime } from './runtime.js';
import { resolveNodeVersionProfile } from './versions/index.js';
import { createProgressReporter } from './progress-protocol.mjs';

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

function byteLength(value) {
  if (value instanceof Uint8Array) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return new TextEncoder().encode(String(value ?? '')).byteLength;
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
    let livenessTimer;
    let currentStage = 'runtime-reset';
    const outputCounters = {
      stdout: { bytes: 0, chunks: 0 },
      stderr: { bytes: 0, chunks: 0 },
    };

    const runtimeContext = { env, variant, metadata, signal: controller.signal };
    const runId = String(request.context?.run_id || request.metadata?.runId || `browser-${Date.now()}`);
    const progress = createProgressReporter({
      binding: request.progress?.binding,
      runId,
    });
    const childActive = () => {
      const state = child?.state || child?._worker?.state;
      return state === 'starting' || state === 'running';
    };
    const counters = () => ({
      networkEvents: 0,
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
      progress.emit(phase, event, {
        stage: currentStage,
        childActive: childActive(),
        counters: counters(),
        ...fields,
      });
    };
    const recordOutput = (stream, value) => {
      const target = outputCounters[stream];
      target.bytes += byteLength(value);
      target.chunks += 1;
      progress.output(stream, value, {
        stage: currentStage,
        childActive: childActive(),
        counters: counters(),
      });
    };
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
        currentStage = 'timeout';
        report('lifecycle', 'timeout', { timedOut: true, childActive: childActive() });
        controller.abort();
        void stopChild();
        resolve({ timedOut: true });
      }, timeoutMs);
    });
    const execute = (async () => {
      report('lifecycle', 'started', {
        stage: 'runtime-reset',
        browser: String(request.browser || env.BNH_BROWSER || 'unknown'),
        timeoutMs,
        entry: request.entry,
        childActive: false,
      });
      runtime = runtimeFor(variant);
      if (controller.signal.aborted) {
        report('lifecycle', 'cancelled');
        return { exitCode: null, cancelled: true };
      }
      report('setup', 'reset-started');
      await runtime.reset(runtimeContext);
      report('setup', 'reset-complete');
      if (controller.signal.aborted) {
        report('lifecycle', 'cancelled');
        return { exitCode: null, cancelled: true };
      }
      currentStage = 'runtime-materialize';
      report('setup', 'materialize-started', { files: request.files?.manifest?.length || 0 });
      const files = await materialize(request.files, request.metadata?.sourceSha256 || '');
      report('setup', 'materialize-complete', { files: Object.keys(files).length });
      if (controller.signal.aborted) {
        report('lifecycle', 'cancelled');
        return { exitCode: null, cancelled: true };
      }
      currentStage = 'runtime-mount';
      report('setup', 'mount-started');
      await runtime.mount(files, runtimeContext);
      report('setup', 'mount-complete');
      if (controller.signal.aborted) {
        report('lifecycle', 'cancelled');
        return { exitCode: null, cancelled: true };
      }
      child = await runtime.spawn(
        ['node', ...(request.flags || []), request.entry],
        {
          cwd: '/node',
          env,
          variant,
          metadata,
          signal: controller.signal,
          onStdout: (value) => recordOutput('stdout', value),
          onStderr: (value) => recordOutput('stderr', value),
        },
      );
      currentStage = 'child-launch';
      report('execution', 'child-started', {
        command: 'node',
        entry: request.entry,
        argumentCount: 1 + (request.flags || []).length,
        childActive: childActive(),
      });
      currentStage = 'upstream-test-execution';
      report('execution', 'upstream-test-started');
      livenessTimer = setInterval(() => {
        if (!controller.signal.aborted && childActive()) report('execution', 'child-running');
      }, 5000);
      if (timedOut) {
        await stopChild();
        return { exitCode: null, stdout: '', stderr: '' };
      }
      const result = await readChild(child);
      await progress.flush();
      currentStage = 'completion';
      report('lifecycle', 'completed', { code: result.exitCode ?? null, childActive: false });
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
          details: { runtimeVersion: runtime ? runtime.version : null, variant, metadata, tty_supported: false },
        };
      }
      const runResult = result.structuredResult || failureResult(runId, 'running', new Error('browser runtime returned no structured result'));
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: false,
        runResult,
          details: { runtimeVersion: runtime ? runtime.version : null, variant, metadata, tty_supported: false },
      };
    } catch (error) {
      report('lifecycle', 'failed', { code: error?.code || 'ERR_BROWSER_RUNTIME' });
      const phase = error?.code === 'ERR_CAPABILITY_DENIED' || error?.code === 'ERR_INVALID_CAPABILITY'
        ? 'setup'
        : 'launch';
      const runResult = failureResult(runId, phase, error, error?.code === 'ERR_NOT_SUPPORTED' ? 'unsupported' : 'failed');
      return { exitCode: null, stdout: '', stderr: String(error?.stack || error), timedOut: false, runResult, details: { runtimeVersion: runtime ? runtime.version : null, variant, metadata, tty_supported: false } };
    } finally {
      clearTimeout(timeoutTimer);
      clearInterval(livenessTimer);
      await progress.flush();
    }
  },
};
