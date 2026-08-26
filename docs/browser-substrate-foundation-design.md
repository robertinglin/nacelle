# First Implementation Wave: Browser-Native Node Substrate

## 1. Outcome

This wave establishes four explicit browser-native contracts before further upstream test conversion:

1. Capability-scoped virtual file access.
2. Worker-backed process and child-process lifecycle.
3. Ordered IPC and simulated signals.
4. Node-like byte streams with authoritative stdout/stderr capture.

The browser remains the execution environment. Host Node, containers, and remote runners may orchestrate browser sessions, but may not execute test bodies or provide implicit filesystem or process behavior.

Upstream conversions pause until the final readiness criteria in this design are satisfied.

## 2. Scope and non-goals

This wave supports focused substrate and regression tests. It does not attempt general Node compatibility.

In scope:

- Per-run VFS mounts seeded and inspected by the harness.
- Asynchronous file and directory operations.
- Dedicated Worker-based children running registered browser modules.
- Isolated process identity, environment, working directory, exit state, IPC, and signals.
- Byte-oriented readable and writable streams.
- Ordered stdout/stderr collection and structured lifecycle results.
- One shared implementation consumed by the existing v22 workspace.

Explicitly out of scope:

- Host filesystem paths or transparent host mounts.
- Native executables, shell parsing, `fork(2)`, process groups, or real OS signals.
- Arbitrary source strings, `eval`, or unregistered worker URLs.
- Symlinks, ownership, POSIX mode enforcement, file watching, or descriptor inheritance.
- Full `fs`, `stream`, `process`, or `child_process` parity.
- Child stdin, TTY emulation, sockets, networking, and persistent storage semantics.
- Node-version-specific copies of runtime modules.

Unsupported behavior must produce a structured `ERR_NOT_SUPPORTED` result rather than an ad hoc rewrite or silent approximation.

## 3. Run and capability contract

Every substrate or converted test receives a validated run descriptor before browser execution:

```text
RunSpec {
  runId,
  workspace: "v22",
  entryModule,
  capabilities,
  fixtures,
  limits
}
```

The capability manifest is authoritative. Absence means denial.

Minimum capability groups:

```text
vfs: mount names, logical mount paths, and read/write rights
workers: allowed entry modules and maximum child count
ipc: enabled or disabled
signals: allowed simulated signal names
output: byte limits and stream high-water marks
envVars / process.env: allowed environment keys
```

Invariants:

- Capability checks happen at the owning boundary, not only in compatibility glue.
- A child receives an explicit subset of its parent’s grants. It cannot enlarge them.
- `envVars` and `process.env` are aliases for one canonical capability record. Conflicting declarations fail validation.
- Workspace selection resolves browser modules and fixtures; it does not select a duplicated runtime implementation.
- Unknown capability keys and malformed grants fail during setup.
- Runtime assembly exposes only granted capability objects. Compatibility wrappers cannot create missing capabilities.
- Each run has isolated process state, VFS state, counters, output, and lifecycle records.

## 4. Minimal contracts

### 4.1 Virtual filesystem

The VFS presents POSIX-style logical paths independent of browser or host URL syntax.

Illustrative surface:

```text
readFile(path) -> Promise<Uint8Array>
writeFile(path, bytes, options?) -> Promise<void>
appendFile(path, bytes) -> Promise<void>
stat(path) -> Promise<VfsStat>
readdir(path) -> Promise<string[]>
mkdir(path, options?) -> Promise<void>
rename(from, to) -> Promise<void>
unlink(path) -> Promise<void>
```

Required invariants:

- Paths are absolute within a logical namespace.
- Normalization resolves `.` and `..`; traversal outside the granted mount is rejected.
- URL decoding, platform separators, and host paths never bypass normalization.
- Contents are bytes. String conversion belongs in compatibility glue and must specify an encoding.
- Directory listings use deterministic lexical ordering.
- A completed write or rename is visible to later operations on the same mount.
- File replacement and rename are atomic from the broker’s perspective.
- Concurrent mutations are serialized in broker receive order.
- Each run starts from its declared fixture snapshot and has no undeclared ambient files.
- The harness can export declared files or a final mount snapshot as structured artifacts.
- VFS operations never call host filesystem APIs.

The first required backend is an ephemeral, browser-resident mount. Its seed manifest and exported artifacts make file effects visible to the harness. The backend boundary may later admit OPFS or an already-authorized browser directory handle without changing the public VFS contract. Permission prompts and persistent-storage policy are not part of this wave.

The authoritative VFS broker lives in the browser’s supervising context. Workers receive scoped VFS clients and issue request/response operations to that broker. Authorization is associated with the worker channel; a worker-provided path or token is never trusted as proof of access.

### 4.2 Messaging and IPC

Runtime control traffic and test-visible IPC are separate logical channels.

Control traffic includes:

- VFS requests and responses.
- Lifecycle transitions.
- Output frames and acknowledgements.
- Signal delivery.
- Exit and failure records.

User IPC carries structured-clone-compatible values only.

Illustrative surface:

```text
child.send(value) -> Promise<void>
child.disconnect() -> void
process.send(value) -> Promise<void>
process.on("message", listener)
```

Invariants:

- Messages are delivered FIFO in each direction.
- Each envelope contains the run and child identity plus a monotonically increasing channel sequence.
- Runtime control message kinds cannot be forged through user IPC.
- A successful `send` means the transport accepted the message, not that application code processed it.
- Structured-clone failure rejects the send with `ERR_IPC_SERIALIZATION`.
- Disconnect is idempotent and emits at most one `disconnect` event on each side.
- Sending after disconnect fails visibly with `ERR_IPC_CLOSED`.
- Unexpected port closure becomes a lifecycle failure unless the child has already reached an allowed terminal state.
- No ordering is promised between independent control and user-IPC channels. Ordering within each channel is strict.

### 4.3 Worker-backed process lifecycle

A child process is a dedicated Web Worker or equivalent browser-native isolated worker.

Launch accepts only an entry module registered by the current workspace:

```text
spawnWorker(entryModule, {
  argv,
  env,
  cwd,
  capabilities
}) -> ChildProcess
```

No host command, shell string, or executable path is accepted.

Child state transitions are monotonic:

```text
created -> starting -> running -> stopping -> exited
                                      \----> failed
```

Required process surface:

- Stable run-local `pid` and `ppid`.
- Isolated `argv`.
- An isolated string-valued environment map.
- Logical VFS `cwd`.
- `exitCode`.
- `process.exit(code)`.
- Signal and message listeners.
- `stdout` and `stderr` writable streams.

Required child surface:

- `pid`.
- `send`, `disconnect`, and `kill`.
- Parent-side stdout and stderr readable streams.
- `spawn`, `message`, `error`, `exit`, `close`, and `disconnect` events.

Lifecycle invariants:

- PIDs are monotonically allocated within a run and are not OS process IDs.
- `spawn` occurs once, after worker bootstrap succeeds.
- Startup failure emits `error` and then `close`; it does not emit `spawn` or `exit`.
- `exit` occurs once after the terminal exit record is known.
- `close` occurs once, after exit/failure, IPC closure, and stdout/stderr completion.
- Natural completion occurs when the registered asynchronous entry function settles.
- A rejected entry function is an uncaught child failure.
- `process.exit(code)` stops admission of new work, flushes already accepted output/control frames, and then exits.
- Events attempted after the terminal transition cannot mutate the final result.
- Worker exceptions, message deserialization failures, and forced termination are captured structurally.

This deliberately uses an explicit asynchronous entry boundary rather than attempting to infer browser event-loop quiescence.

### 4.4 Simulated signals

The first signal set is:

- `SIGTERM`
- `SIGINT`
- `SIGKILL`

`SIGTERM` and `SIGINT` are cooperative events:

- The parent posts a control frame.
- The child dispatches the named signal to registered process listeners.
- If a listener exists, the child continues unless it exits itself.
- If no listener exists when dispatched, the default action terminates the child.
- Default termination reports `code: null` and the signal name.

`SIGKILL` is unconditional:

- No child listener runs.
- The supervising context terminates the Worker.
- The terminal result reports `code: null` and `signal: "SIGKILL"`.
- Output acknowledged before termination is retained; unacknowledged output is not claimed as delivered.

Additional invariants:

- `kill` returns false for an already-terminal child.
- An unknown or ungranted signal fails with `ERR_INVALID_SIGNAL` or `ERR_CAPABILITY_DENIED`.
- A cooperative signal may be delayed while child JavaScript does not yield.
- Harness deadline termination is classified as `timed_out`, not disguised as an OS signal.
- There are no signal numbers, process groups, or platform-dependent mappings in this wave.

### 4.5 Streams and output

The stream layer is byte-oriented and exposes a deliberately small Node-like subset:

```text
Readable: on, once, pause, resume, pipe, destroy
Writable: write, end, destroy
PassThrough: readable plus writable behavior
```

Required events:

- Readable: `data`, `end`, `error`, `close`.
- Writable: `drain`, `finish`, `error`, `close`.

Required behavior:

- Canonical chunks are `Uint8Array`.
- Strings accepted by writable streams are encoded as UTF-8.
- Object mode, custom encodings, corking, and arbitrary transform subclasses are out of scope.
- Chunk boundaries are preserved internally; consumers may concatenate bytes.
- `write` returns false at or above the high-water mark.
- After a false return, `drain` fires once writable pressure falls below the threshold.
- Write and end callbacks run exactly once.
- `finish` follows completion of all accepted writes.
- `end` follows delivery of all readable data.
- `close` is terminal and occurs at most once.
- `destroy(error)` is idempotent and makes the error visible to the process supervisor.
- Writes after `end` fail with a structured stream error.

Child stdout and stderr use one control transport so their frames receive a shared output sequence. This preserves their observed interleaving while also retaining separate byte buffers.

Console output may remain browser diagnostic output, but it is not authoritative test output. Compatibility work may later route selected console methods into the same sinks; tests in this wave assert against `process.stdout` and `process.stderr`.

## 5. Structured results

Every run produces exactly one result, including setup and launch failures:

```text
RunResult {
  runId,
  outcome,
  phase,
  exit,
  error,
  stdout,
  stderr,
  outputEvents,
  lifecycleEvents,
  artifacts
}
```

Required fields:

- `outcome`: `passed`, `failed`, `timed_out`, `cancelled`, or `unsupported`.
- `phase`: `setup`, `launch`, `running`, or `shutdown`.
- `exit`: `{ code, signal, reason }`.
- `error`: null or `{ code, name, message, details }`.
- `stdout` and `stderr`: exact captured bytes plus serialization metadata.
- `outputEvents`: `{ sequence, fd, bytes }` frames for cross-stream ordering.
- `lifecycleEvents`: ordered state and terminal records.
- `artifacts`: declared VFS exports or artifact errors.

Binary data remains `Uint8Array` inside the browser. The adapter converts it to a documented JSON-safe representation, such as base64, only at the orchestration boundary. Stack traces and relative timing may be included as diagnostics but are not stable contract values.

Output is bounded by the run manifest. Exceeding the limit:

1. Retains bytes through the exact configured limit.
2. Records `ERR_OUTPUT_LIMIT`.
3. Terminates the run.
4. Returns a failed structured result.

Console text alone can never be the only evidence of a failure.

## 6. Component boundaries

| Component | Owns | Must not own |
|---|---|---|
| `runtime/vfs.js` | Paths, mount rights, VFS operations, browser-resident broker/client contract, VFS error normalization | Worker lifecycle, output formatting, host files |
| `runtime/messaging.js` | Transport envelopes, request correlation, sequencing, channel closure, user IPC | Process policy, VFS semantics, stream buffering |
| `runtime/process.js` | Process identity, environment, cwd, child state machine, exit and signal semantics | Worker URL policy, stream internals, VFS storage |
| `runtime/streams.js` | Byte streams, backpressure, completion events, output capture | Process state, permission policy, result scheduling |
| `runtime/index.js` | Validated capability assembly and exports | Reimplementing individual capabilities |
| `runtime/compat.js` | Thin Node-shaped mappings over granted contracts | Capability creation or browser/host fallbacks |
| `adapters/` | Workspace module resolution, Worker creation, browser channels, run limits, result serialization | Executing test bodies outside the browser |
| Python orchestration | Scheduling substrate tests, delivering run manifests, consuming structured results | Providing filesystem/process behavior to tests |

`runtime/network.js` and `runtime/storage.js` remain unchanged unless a minimal type/import adjustment is required by runtime assembly.

## 7. End-to-end data flow

### File access

1. The harness sends fixture bytes and mount grants in the run descriptor.
2. The browser adapter creates the run-local VFS broker and seeds its ephemeral mounts.
3. Worker bootstrap receives a scoped VFS client.
4. A worker operation is normalized locally and sent as a correlated control request.
5. The broker revalidates operation, path, mount, and rights.
6. The broker performs the operation and returns bytes or a normalized error.
7. At shutdown, only declared artifacts are exported into `RunResult`.

### Worker launch and IPC

1. The adapter resolves the registered v22 browser entry module.
2. It creates the Worker plus separate control and user-IPC channels.
3. Bootstrap validates delegated capabilities and constructs the process surface.
4. Successful initialization produces the `spawn` transition.
5. Parent and child exchange structured-clone values through user IPC.
6. Transport errors or disconnects update the process state machine and final result.

### Signals and exit

1. Parent validates the requested signal against the child grant and state.
2. Cooperative signals are posted on the control channel; `SIGKILL` terminates at the supervisor.
3. The child either handles the event, takes the default action, or exits explicitly.
4. Accepted output drains before a graceful terminal record.
5. Parent emits `exit`, completes stdout/stderr and IPC, then emits `close`.
6. The adapter seals the structured result.

### Output

1. Child `stdout.write` or `stderr.write` accepts bytes into a bounded writable.
2. The output sink assigns a shared sequence and sends a control frame.
3. Parent capture appends the chunk to the appropriate byte buffer and combined event log.
4. Acknowledgements reduce child-side pressure and may trigger `drain`.
5. Exit waits for accepted graceful output to be acknowledged.
6. The final result contains both per-stream bytes and ordered frames.

## 8. Error and permission behavior

All boundary errors use stable codes with operation-specific details. Browser `DOMException` names may appear diagnostically but are not the public error contract.

Minimum codes:

- `ERR_CAPABILITY_DENIED`
- `ERR_INVALID_CAPABILITY`
- `ERR_NOT_SUPPORTED`
- `ERR_INVALID_PATH`
- `ERR_WORKER_START`
- `ERR_WORKER_TERMINATED`
- `ERR_INVALID_SIGNAL`
- `ERR_IPC_CLOSED`
- `ERR_IPC_SERIALIZATION`
- `ERR_STREAM_DESTROYED`
- `ERR_WRITE_AFTER_END`
- `ERR_OUTPUT_LIMIT`
- `ERR_RUN_TIMEOUT`
- Node-like VFS codes such as `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, and `ENOTEMPTY`

Rules:

- Setup errors fail before a Worker is launched.
- Permission denial is distinguishable from missing resources.
- Details may include logical path, operation, capability key, or child ID, but never leaked host paths.
- Child-thrown values are normalized even when they are not `Error` instances.
- Cleanup errors are recorded and cannot overwrite an earlier primary failure.
- Unsupported behavior is explicit and must not silently degrade into browser globals or host access.

## 9. Focused contract tests

All tests that claim browser behavior must execute in a real supported browser, not solely under Node or a DOM shim.

### VFS tests

- Fixture seeding and artifact export.
- Byte fidelity, empty files, overwrite, and append.
- Directory creation, listing order, rename, and deletion.
- `.`/`..`, repeated separators, mount boundaries, and hostile paths.
- Read-only versus read/write mounts.
- Missing-file and file-versus-directory errors.
- Atomic visibility after awaited mutation.
- Concurrent mutation serialization.
- Isolation across runs and children.
- Confirmation that no host path is reachable.

### Worker/process tests

- Successful bootstrap and monotonically ordered states.
- Startup exception before `spawn`.
- Natural completion, explicit exit, uncaught rejection, timeout, and forced termination.
- Exactly-once `spawn`, `exit`, `close`, and `error` behavior.
- `close` occurring only after output and IPC completion.
- PID, PPID, argv, environment, cwd, and child isolation.
- Capability subset delegation.
- Equivalent `envVars` and `process.env` permission behavior.

### IPC and signal tests

- FIFO traffic in both directions.
- Structured-clone-compatible payloads and transferables.
- Serialization rejection and unexpected port closure.
- Idempotent disconnect and send-after-disconnect.
- Handled and unhandled `SIGTERM` and `SIGINT`.
- Unconditional `SIGKILL`.
- Invalid, ungranted, duplicate, and post-exit signals.
- Busy child followed by harness timeout classification.

### Stream/output tests

- String-to-UTF-8 conversion and arbitrary byte fidelity.
- Split multibyte characters without corruption.
- Backpressure, false `write`, acknowledgement, and `drain`.
- Write callback and event ordering.
- `end`, `finish`, `error`, `destroy`, and `close` exactly once.
- Write-after-end and destroy-with-error.
- Large output within the configured limit.
- Exact output-limit failure.
- Separate stdout/stderr bytes and preserved combined ordering.
- Graceful exit flushing all accepted output.

### Browser integration tests

- Seed a file, read it in a child, transform it, and export the result.
- Exchange IPC while independently writing stdout and stderr.
- Handle a cooperative signal and exit cleanly.
- Default signal termination with correct terminal metadata.
- Startup, runtime, stream, VFS, timeout, and cleanup failures represented in `RunResult`.
- Run two substrate tests concurrently without state or output leakage.

## 10. Three independent implementer briefs

The public signatures and error codes above should be frozen before implementation begins. Each brief tests against fakes at its external seams.

### Brief A: VFS capability

Primary ownership:

- `runtime/vfs.js`
- New VFS-focused regression/contract tests

Deliver:

- Logical path and mount-rights model.
- Ephemeral browser-resident broker.
- Local and worker-client request contract.
- Deterministic operations, mutation ordering, fixture seed, and artifact export.
- VFS-specific error normalization.

Do not modify:

- `runtime/process.js`
- `runtime/messaging.js`
- `runtime/streams.js`
- Runtime assembly or adapters, except for test-local fakes.

Acceptance:

- VFS contract suite passes in a real browser.
- Mount escape and undeclared access are demonstrably denied.
- Tests cover both successful operations and every public failure class.

### Brief B: Worker, process, messaging, IPC, and signals

Primary ownership:

- `runtime/messaging.js`
- `runtime/process.js`
- Worker bootstrap module owned by the process subsystem
- New worker/process/IPC/signal contract tests

Deliver:

- Control and user-IPC transport contracts.
- Worker and child state machines.
- Process identity, environment, cwd, exit, IPC, and signal behavior.
- Capability delegation validation.
- Injectable interfaces for VFS clients and stdout/stderr streams.

Do not modify:

- `runtime/vfs.js`
- `runtime/streams.js`
- Runtime assembly or production adapters.

Acceptance:

- Tests pass with fake VFS and fake stream endpoints.
- Every terminal path produces one terminal record.
- Lifecycle and signal ordering matches this design.

### Brief C: Streams and authoritative output capture

Primary ownership:

- `runtime/streams.js`
- New stream/output contract tests

Deliver:

- Minimal readable, writable, and pass-through byte streams.
- Backpressure and lifecycle events.
- Child-side output sink and parent-side capture.
- Shared stdout/stderr sequencing.
- Output acknowledgement, graceful flush, and byte-limit enforcement.
- Injectable transport interface.

Do not modify:

- `runtime/vfs.js`
- `runtime/messaging.js`
- `runtime/process.js`
- Runtime assembly or adapters.

Acceptance:

- Stream tests pass against a fake acknowledged transport.
- Byte output and event ordering are deterministic.
- Failure and overflow paths reach a structured supervisor sink.

## 11. Final integration gate

After all three briefs pass independently, one integration change may touch the shared seams:

- `runtime/index.js`
- `runtime/compat.js`
- Relevant browser adapter files
- Focused Python scheduling, validation, and result-consumption files
- Browser integration tests

The gate must:

1. Assemble capabilities strictly from a validated run manifest.
2. Bind the VFS client to the worker control transport.
3. Bind process stdout/stderr to the stream transport.
4. Resolve v22 workspace entries without copying runtime modules.
5. Serialize every browser terminal path into `RunResult`.
6. Schedule substrate contract tests as a prerequisite phase.
7. Prevent an upstream test from running when its declared substrate prerequisites are absent.
8. Preserve existing v22 workspace and integration behavior.

Landing checks:

- Focused tests for each modified area.
- Complete substrate contract suite in the real browser.
- Existing v22 workspace/integration suite.
- Full project-scoped test command.
- At least 80% coverage for modified code, without reducing project coverage below 80%.
- Strict static analysis and lint with zero new warnings.
- No host-execution fallback detected in browser test paths.

## 12. Upstream conversion resumption criteria

The harness may resume assigning upstream tests only when all of the following are true:

- The final integration gate passes.
- Substrate tests run before upstream tests and can block their assignment.
- VFS, worker/process, IPC/signals, and stream contracts pass in the target browser.
- Every run, including setup failure and timeout, yields exactly one structured result.
- stdout/stderr are byte-reliable and not reconstructed from browser console logs.
- Converted tests declare required capabilities.
- Undeclared, denied, and unsupported capabilities receive distinct structured classifications.
- No test body is proxied to host Node, a container, or remote execution.
- The v22 workspace consumes the shared runtime without version-specific duplication.
- Existing v22 integration tests, full scoped tests, coverage, lint, and static analysis pass.
- The initial conversion queue contains only tests whose requirements are fully covered by these contracts.

After reopening conversion, a test that exposes a missing capability must be returned to capability design. It must not become a blind per-test rewrite or compatibility special case.