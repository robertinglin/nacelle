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

function compactRuntimeState(value) {
  if (!value || typeof value !== 'object') return null;
  const nodeTest = value.nodeTest && typeof value.nodeTest === 'object' ? value.nodeTest : value;
  const list = (items) => Array.isArray(items)
    ? { count: items.length, first: items[0] == null ? null : String(items[0]), last: items.at(-1) == null ? null : String(items.at(-1)) }
    : null;
  const childRecord = (record) => record && typeof record === 'object' ? {
    command: String(record.command || record.entry || '').split('/').pop().slice(0, 80),
    argumentCount: Number(record.argumentCount) || 0,
    code: record.code ?? null,
    signal: record.signal ?? record.terminal?.signal ?? null,
    pending: Boolean(record.pending),
    stdoutBytes: Number(record.stdoutBytes) || 0,
    stderrBytes: Number(record.stderrBytes) || 0,
    stdoutExcerpt: record.stdoutExcerpt == null ? '' : String(record.stdoutExcerpt).slice(0, 512),
    stderrExcerpt: record.stderrExcerpt == null ? '' : String(record.stderrExcerpt).slice(0, 512),
  } : null;
  return {
    exitCode: value.exitCode ?? null,
    runtimeCode: value.runtimeCode ?? null,
    phase: value.phase == null ? null : String(value.phase).slice(0, 64),
    nodeTest: {
      registered: Number(nodeTest.registered) || 0,
      completed: Number(nodeTest.completed) || 0,
      requestedFiles: list(nodeTest.requestedFiles),
      files: list(nodeTest.files),
      streamEvents: list(nodeTest.streamEvents),
      streamError: nodeTest.streamError ? {
        name: String(nodeTest.streamError.name || 'Error'),
        message: String(nodeTest.streamError.message || nodeTest.streamError).slice(0, 512),
      } : null,
      streamTerminal: nodeTest.streamTerminal == null ? null : String(nodeTest.streamTerminal),
    },
    childActivity: value.childActivity && typeof value.childActivity === 'object' ? {
      launched: Number(value.childActivity.launched) || 0,
      completed: Number(value.childActivity.completed) || 0,
      failed: Number(value.childActivity.failed) || 0,
      firstCommand: value.childActivity.firstCommand == null ? null : String(value.childActivity.firstCommand).slice(0, 80),
      lastCommand: value.childActivity.lastCommand == null ? null : String(value.childActivity.lastCommand).slice(0, 80),
      recent: Array.isArray(value.childActivity.recent) ? {
        count: value.childActivity.recent.length,
        first: childRecord(value.childActivity.recent[0]),
        last: childRecord(value.childActivity.recent.at(-1)),
      } : null,
    } : null,
    lifecycle: value.lifecycle && typeof value.lifecycle === 'object' ? {
      pending: Number(value.lifecycle.pending) || 0,
      tasks: Array.isArray(value.lifecycle.tasks) ? {
        count: value.lifecycle.tasks.length,
        first: value.lifecycle.tasks[0] ? {
          id: Number(value.lifecycle.tasks[0].id) || 0,
          label: value.lifecycle.tasks[0].label == null ? null : String(value.lifecycle.tasks[0].label).slice(0, 128),
          stack: value.lifecycle.tasks[0].stack == null ? null : String(value.lifecycle.tasks[0].stack).slice(0, 160),
        } : null,
        last: value.lifecycle.tasks.at(-1) ? {
          id: Number(value.lifecycle.tasks.at(-1).id) || 0,
          label: value.lifecycle.tasks.at(-1).label == null ? null : String(value.lifecycle.tasks.at(-1).label).slice(0, 128),
          stack: value.lifecycle.tasks.at(-1).stack == null ? null : String(value.lifecycle.tasks.at(-1).stack).slice(0, 160),
        } : null,
      } : null,
    } : null,
  };
}

function childLifecycleDiagnostics(child) {
  if (!child) return null;
  const worker = child._worker || child;
  const processObject = worker.process || worker.processObject;
  const records = typeof child.output?.records === 'function' ? child.output.records() : [];
  const bytes = (value) => value?.byteLength ?? (ArrayBuffer.isView(value) ? value.byteLength : 0);
  const terminal = worker.terminalRecord || worker.terminal;
  const compactTerminal = terminal ? {
    state: terminal.state || null,
    status: terminal.status || null,
    kind: terminal.kind || null,
    code: terminal.code ?? null,
    signal: terminal.signal ?? null,
    forced: Boolean(terminal.forced),
    error: terminal.error ? {
      name: String(terminal.error.name || 'Error'),
      code: terminal.error.code || null,
      message: String(terminal.error.message || terminal.error).slice(0, 512),
    } : null,
  } : null;
  return {
    state: worker.state || null,
    stateHistory: Array.isArray(worker.stateHistory)
      ? { count: worker.stateHistory.length, first: worker.stateHistory[0] || null, last: worker.stateHistory.at(-1) || null }
      : null,
    terminal: compactTerminal,
    output: {
      recordCount: records.length,
      stdoutBytes: bytes(child.output?.stdoutBytes),
      stderrBytes: bytes(child.output?.stderrBytes),
      firstStream: records[0]?.stream || null,
      lastStream: records.at(-1)?.stream || null,
    },
    runtimeState: compactRuntimeState(
      worker.runtimeState || worker.__bnhRuntimeState || processObject?.__bnhNodeTestState || processObject?.__bnhChildActivity,
    ),
  };
}

function failureResult(runId, phase, error, outcome = 'failed', details = null) {
  return {
    runId,
    outcome,
    phase,
    exit: { code: null, signal: null, reason: error?.code || 'browser-failure' },
    error: error ? {
      code: error.code || 'ERR_BROWSER_RUNTIME',
      name: error.name || 'Error',
      message: String(error.message || error),
      details: error.details || details,
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

    const runtimeContext = { env, variant, metadata, signal: controller.signal, isolation: request.isolation };
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
        const childDiagnostics = childLifecycleDiagnostics(child);
        const timeoutDetails = { child: childDiagnostics };
        return {
          exitCode: null,
          stdout: partial.stdout,
          stderr: partial.stderr,
          timedOut: true,
          runResult: failureResult(runId, 'shutdown', Object.assign(new Error('browser run timed out'), { code: 'ERR_RUN_TIMEOUT' }), 'timed_out', timeoutDetails),
          details: { runtimeVersion: runtime ? runtime.version : null, variant, metadata, tty_supported: false, ...timeoutDetails },
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
      const phase = error?.code === 'ERR_CAPABILITY_DENIED' || error?.code === 'ERR_INVALID_CAPABILITY'
        ? 'setup'
        : 'launch';
      const runResult = failureResult(runId, phase, error, error?.code === 'ERR_NOT_SUPPORTED' ? 'unsupported' : 'failed');
      return { exitCode: null, stdout: '', stderr: String(error?.stack || error), timedOut: false, runResult, details: { runtimeVersion: runtime ? runtime.version : null, variant, metadata, tty_supported: false } };
    } finally {
      clearTimeout(timeoutTimer);
    }
  },
};
