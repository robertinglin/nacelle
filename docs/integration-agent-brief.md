You are a direct implementation agent. Do not delegate and do not commit.
The three browser-native primitive implementations already exist in the v22
integration worktree. Your job is to wire them into the actual browser runner
and harness so upstream conversion can use them instead of recreating them.

## Current primitive baseline
The target checkout is:
`.bnh-state/v22/worktrees/integration-v22`
It contains the committed VFS, byte-stream/output, and worker-process/IPC/
signal contract implementations and focused tests. Read
`docs/browser-substrate-foundation-design.md` for the contract, then inspect
the target checkout and the Python harness before editing.

## Ownership
You may modify:
- `.bnh-state/v22/worktrees/integration-v22/runtime/index.js`
- `.bnh-state/v22/worktrees/integration-v22/runtime/compat.js`
- `.bnh-state/v22/worktrees/integration-v22/runtime.js` and the minimal browser
  adapter files needed to assemble the capabilities
- `src/browser_node_harness/orchestrator.py`, `scheduler.py`, `runner.py`,
  `validation.py`, and their focused tests
- new uniquely named integration/regression tests

Do not rewrite the primitive ownership files (`runtime/vfs.js`,
`runtime/streams.js`, `runtime/process.js`, `runtime/messaging.js`,
`runtime/process-worker.js`) except for a minimal import/export correction that
cannot be made at the assembly boundary. Do not change provider/model ranking,
dashboard UI, oracle caching, or upstream test implementations.

## Required outcome
1. Assemble the existing VFS, streams/output collector, messaging, and
   worker-process contracts from one validated per-run capability manifest.
   `envVars` and `process.env` must resolve through the same explicit key.
   Missing/invalid grants fail structurally before a test body starts.
2. Bind the worker process to injected VFS and stdout/stderr seams. Return one
   structured browser result for setup, launch, runtime, timeout, unsupported,
   and shutdown failures. Do not proxy test code to host Node or use host fs,
   child_process, shell, or remote execution as a fallback.
3. Add a substrate-prerequisite phase to the harness. It should run the small
   browser contract suite from the current integration/runtime checkout before
   selecting upstream tests. A green cached prerequisite result may be reused
   only for the exact integration identity and relevant runtime/config scope;
   a changed integration head or substrate test invalidates it. The phase must
   be visible in existing structured events and must not launch compatibility
   agents for already-implemented primitives.
4. Gate upstream assignment on that phase. If a capability is missing or the
   prerequisite suite is red, report a structured infrastructure/substrate
   result and stop upstream assignment with a useful reason. Do not silently
   turn the failure into an agent rewrite prompt.
5. Preserve the persistent v22 workspace and variant sharing. The runtime
   substrate is one shared implementation; do not copy it once per test or
   once per Node minor version.

## Tests and checks
Add focused tests for capability-manifest validation, prerequisite caching and
invalidation, structured failure classification, and the browser runtime
assembly seams. Run only relevant Python/unit/browser contract tests while
developing. Run the existing project test command for touched Python modules,
the three primitive contract tests, syntax/diff checks, and any adapter smoke
test that can run locally. Do not launch the 3,600-test upstream suite.
If a dependency download is attempted, report the exact network limitation and
continue with installed checks.

## Acceptance
- A fresh v22 integration can run the substrate contract suite once and
  records the exact identity; a resume with the same identity reuses it.
- Changing the integration head or relevant runtime/config scope invalidates
  the prerequisite result.
- Upstream scheduling cannot dispatch an agent before prerequisites are green.
- The three existing primitive tests remain green together.
- Focused harness tests are green and no new host-execution fallback exists.

End your final response with: files changed (paths only); what changed;
test/check results; deviations or environment limitations.
