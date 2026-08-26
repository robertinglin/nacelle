# Adapter protocols

The orchestration core supports one-shot and persistent JSONL command adapters. The supplied Playwright adapter supports both. A custom adapter may be written in any language.

## Request schema

Every target or oracle execution receives a JSON object shaped like:

```json
{
  "schema_version": 1,
  "request_id": "present for JSONL transport",
  "test": {
    "path": "test/parallel/test-example.js",
    "absolute_path": "/checkout/node/test/parallel/test-example.js",
    "suite": "parallel",
    "flags": ["--expose-internals"],
    "modules": ["assert", "fs"],
    "source_sha256": "...",
    "source_override": null
  },
  "paths": {
    "node_repo": "/checkout/node",
    "target_repo": "/checkout/runtime",
    "worktree": "/state/worktrees/agents/attempt-id",
    "state_dir": "/state",
    "result": "/state/requests/request.result.json"
  },
  "limits": {
    "timeout_seconds": 120
  },
  "context": {
    "phase": "candidate-assigned",
    "run_id": "run-...",
    "iteration": 4,
    "attempt_id": "run-...-task"
  }
}
```

`source_override` is non-null for randomized canaries and mutation checks. A conforming target adapter must execute that source at the same virtual path instead of reading the original file. Ignoring this field causes candidate rejection.

The candidate code to execute is always under `paths.worktree`. Do not serve or import the original `paths.target_repo` when those paths differ.

## Result schema

Return or write:

```json
{
  "request_id": "copy for JSONL transport",
  "status": "pass",
  "exit_code": 0,
  "duration_ms": 18,
  "stdout": "",
  "stderr": "",
  "details": {
    "implementation_specific": true
  }
}
```

Valid statuses are:

- `pass`
- `fail`
- `skip`
- `timeout`
- `infra_error`

Only `pass` is green. Use `skip` only when the executed test deliberately reports a runtime skip. Adapter setup failures, missing pages, protocol errors, and browser crashes are `infra_error`.

`exit_code` may be null for timeouts and infrastructure errors. `details` must be a JSON object if present.

## One-shot command transport

Set:

```toml
[target]
protocol = "oneshot"
command = ["node", "adapter.mjs", "{request}"]
```

For each test, the harness:

1. writes the request to `{request}`;
2. sets `BNH_REQUEST_FILE` and `BNH_RESULT_FILE`;
3. launches the configured command;
4. reads `{result}` if it exists;
5. otherwise searches command stdout from the end for a JSON result line.

A result file is preferred. The adapter process exit code is transport-level information; the JSON `status` and `exit_code` describe the test.

## Persistent JSONL transport

Set:

```toml
[target]
protocol = "jsonl"
command = ["node", "daemon.mjs"]
```

The harness creates a process pool scoped to the candidate worktree. Each process receives one compact request JSON object per stdin line and must emit exactly one result JSON object per stdout line. Copy `request_id` into the response. Diagnostic logging belongs on stderr; non-JSON stdout lines are treated as protocol noise.

One process handles one request at a time. Several processes run in parallel when target concurrency is greater than one. A timeout kills and replaces that worker. Pools are closed before the integration worktree is patched or a candidate worktree is removed.

A JSONL command and its environment should be worktree-scoped, not test-scoped. The test data already arrives in each request.

## Python command placeholders

Command, cwd, and environment strings support strict Python-format placeholders:

```text
{config} {config_dir} {target_repo} {node_repo} {state_dir}
{worktree} {request} {result} {test} {test_abs}
{node_binary} {run_id} {iteration} {attempt_id}
```

Unknown placeholders are configuration errors. To pass a literal brace pair to a downstream adapter, double it in TOML: `{{port}}` becomes `{port}`.

## Browser page bridge

The Playwright adapter navigates to `BNH_BROWSER_URL`, exposes a file-read binding, then invokes:

```ts
await globalThis.__BROWSER_NODE_HARNESS__.run({
  schemaVersion: 1,
  entry: '/node/test/parallel/test-example.js',
  files: {
    mode: 'playwright-binding',
    readBinding: '__bnhReadFile',
    manifest: [{ path: '/node/test/parallel/test-example.js', bytes: 1234 }]
  },
  flags: ['--expose-internals'],
  env: {
    NODE_TEST_CONTEXT: 'child-v8',
    BNH_BROWSER: 'chromium'
  },
  timeoutMs: 120000,
  variant: 'v22',
  context: {
    phase: 'candidate-assigned',
    runId: 'run-...',
    iteration: 4,
    attemptId: 'run-...-task',
    variant: 'v22'
  },
  metadata: {
    testPath: 'test/parallel/test-example.js',
    sourceSha256: '...',
    bundleBytes: 1234,
    omittedFiles: [],
    variant: 'v22'
  }
});
```

The page reads a manifest entry with:

```js
const encoded = await globalThis.__bnhReadFile('/node/test/parallel/test-example.js');
// encoded = { encoding: 'base64', data: '...' }
```

It returns:

```ts
{
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  skipped?: boolean;
  details?: Record<string, unknown>;
}
```

The bridge must run the test body in the browser-native runtime. Do not proxy execution to host Node, a remote machine, or a server-side container if browser-native compatibility is the target being measured.

### Supplied browser runtime bridge

`adapters/playwright/target-bridge.example.js` is the default page-side bridge for the shared browser-native runtime. It imports the runtime library, mounts the manifest into a virtual filesystem, executes the requested entry, and captures stdout and stderr. A target project may extend the imported runtime for version-specific modules or fixtures, but the bridge protocol and browser-native execution boundary remain unchanged.

The runtime module imported by the example must export `runtime` with this API:

```ts
interface BrowserRuntime {
  readonly version?: string;
  reset(context?: RuntimeContext): Promise<void>;
  mount(files: Record<string, Uint8Array>, context?: RuntimeContext): Promise<void>;
  spawn(argv: string[], options: RuntimeContext & { cwd: string }): Promise<BrowserChild>;
}

interface RuntimeContext {
  env: Record<string, string>;
  variant?: string;
  metadata: Record<string, unknown>;
  signal: AbortSignal;
}

interface BrowserChild {
  exit: Promise<number | null>;
  stdoutText(): Promise<string>;
  stderrText(): Promise<string>;
  kill(): Promise<void>;
}
```

The bridge passes the request environment unchanged, derives the selected variant from `variant`, `metadata.variant`, `context.variant`, or `env.BNH_VARIANT`, and forwards the complete metadata object. When a variant is present it is also exposed as `BNH_VARIANT` unless the request already supplied that environment key. The runtime should expose the same variant through its deterministic platform metadata.

`timeoutMs` is a deadline for the complete page-side operation: file materialization, reset, mount, spawn, and execution. On expiry the bridge aborts the context, kills the child if it exists, waits briefly for available output, and returns `timedOut: true` with a null exit code. Runtime setup methods must observe the signal, and `kill()` must be safe to call more than once. A runtime that cannot cancel setup can leave a stale operation in the page and is not conforming to this supplied bridge contract.

The default browser boundary is deliberately explicit. The runtime may implement VFS, process/env/argv, stdout/stderr, timers, streams, module loading, workers/IPC, browser network transports, crypto, diagnostics, compression, and WebAssembly. Native addons, privileged OS APIs, real subprocesses, raw TCP/DNS sockets, host filesystem access, and host-process execution are unsupported unless a target supplies a browser-safe replacement. These unsupported capabilities must not be silently proxied through Node or a server.
