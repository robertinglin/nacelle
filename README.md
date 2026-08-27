# Browser Node Harness

Browser Node Harness (`bnh`) is a durable, parallel coding-agent loop for driving a browser-native Node.js implementation against the upstream Node.js test suite.

It does five things continuously:

1. Runs upstream tests on a matching host Node binary to establish an oracle-eligible set.
2. Runs those tests through your browser runtime and fingerprints the failures.
3. Clusters related failures and assigns them to several independent coding-agent lanes in isolated Git worktrees.
4. Treats every agent change as an untrusted patch and validates it against assigned tests, hidden passing guards, negative controls, and source mutations.
5. Serializes accepted patches onto an integration branch, refreshes compatibility state, and repeats until a full confirmation pass is green.

The repository contains the orchestration system and a Playwright adapter. It does **not** contain a browser-native Node runtime. Your runtime must expose the small page-side bridge described below.

The sample configuration starts with Node core's `test/parallel` and `test/sequential` JavaScript programs. Discovery is glob-driven, so you can expand it to other JavaScript suites as the runtime grows. Native C++ tests, addon build tests, and platform-specific host tests need separate adapters rather than being silently counted as browser passes.

## What the loop actually guarantees

A run is marked `green` only when:

- every enabled, oracle-eligible upstream test passes through the target adapter on the integration worktree;
- randomized positive and negative controls behave correctly;
- a final full target scan still passes after all merged patches.

A target-side `skip`, timeout, or infrastructure error is unresolved, not green. Tests that do not pass on the configured host oracle are excluded from the target convergence set and remain visible in the database as oracle failures or skips.

No finite harness can guarantee that agents will discover a correct implementation for every test. This one keeps iterating until green, a configured limit is reached, all remaining tests hit an attempt ceiling, it is interrupted, or infrastructure fails.

## Architecture

```text
Node checkout ── discover + host oracle ─┐
                                        ├─ SQLite compatibility state
browser target ─ Playwright adapter ────┘             │
                                                       ▼
                                              failure clustering
                                                       │
                                    ┌──────────────────┼──────────────────┐
                                    ▼                  ▼                  ▼
                              detached worktree  detached worktree  detached worktree
                              coding agent A     coding agent B     coding agent C
                                    │                  │                  │
                                    └──────── candidate patches ─────────┘
                                                       │
                                      assigned tests + hidden guards
                                      canaries + source mutation + checks
                                                       │
                                                       ▼
                                      serialized three-way apply/retest
                                                       │
                                                       ▼
                                           bnh/integration commits
                                                       │
                                           refresh failures and repeat
```

Each candidate runs against a development server started from its own worktree. It cannot accidentally be validated against a shared integration server.

## Requirements

- Python 3.11 or newer
- Git with worktree support
- Network access for the first automatic Node.js source and target checkouts (or configured local mirrors)
- A built Node binary from that checkout, or another exact-version Node binary for the reference oracle
- A non-interactive coding-agent CLI. The example configuration uses OpenCode.
- Node.js 20 or newer and a Playwright-supported browser for the supplied browser adapter

Run agents, upstream tests, and target build commands inside a disposable VM or container. They execute code and should be treated as untrusted. See [SECURITY.md](SECURITY.md).

## Install

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e .

cd adapters/playwright
npm install
npx playwright install chromium
cd ../..
```

Install OpenCode separately if it is not already available. The launcher does
not perform login or change credentials; it uses the OpenCode configuration and
environment already present on the machine. The sample agent discovers
zero-priced OpenCode Zen, OpenRouter, and NVIDIA models from their live
catalogs. NVIDIA is optional and is enabled when `NVIDIA_API_KEY` (or the
launcher-specific `BNH_NIM_API_KEY`) is already present in the environment.

Copy the configuration. The sample pulls both the target checkout and the
clean oracle checkout from `https://github.com/nodejs/node.git`:

```bash
cp harness.example.toml harness.toml
```

The config defaults to variant `v22`. The harness clones the matching Node.js
source branch into `.bnh-state/v22/node` and the shared target checkout into
`.bnh-state/target`, including Node’s `test/`, `lib/`, and `tools/` scripts.
It fetches the selected upstream refs before each run. All run data, logs,
patches, worktrees, and cloned source stay under the project’s ignored
`.bnh-state/` directory.

The sample agent invokes `browser_node_harness.opencode_agent`. It discovers
the OpenCode Zen, OpenRouter, and optional NVIDIA NIM catalogs once per variant
and stores the ranked result in `.bnh-state/<variant>/opencode-model-catalog.json`.
OpenRouter free models are ranked using tool support, coding/agentic metadata,
and context size; later attempts reuse that ranking instead of repeatedly
querying the catalogs. Set `BNH_OPENCODE_REFRESH_CATALOG=true` to refresh it.
The launcher moves to the next cached model when OpenCode reports a quota,
rate-limit, capacity, provider-availability, or protocol error. It requires
every OpenRouter pricing field to be zero and only accepts NVIDIA models from
the configured hosted-free allowlist after they appear in NVIDIA's live
catalog, so it never selects a paid model or a model with a separately billed
tool price. Three concurrent attempts rotate their starting provider/model
slot.
Any other CLI can be used; see
[Agent command contract](#agent-command-contract).

### Keep the shared runtime linked

The committed adapter runtime is the shared source for new target worktrees.
Initialization creates relative links for `runtime.js` and `runtime/` instead
of making another runtime copy. To link an existing integration worktree, run
this from the project root:

```bash
./link-runtime.py --variant v22
```

The command is safe to rerun. It refuses to replace different target content,
and saves any matching regular copies it converts under `.bnh-state/`. Runtime
changes made through the integration path therefore update the adapter files
that can be committed on the harness branch. The target worktree will show the
links as local changes; do not commit those link replacements in the target
repository.

The same command links the target's `server.js` to the canonical
`adapters/playwright/server.js`. The server runs from the target worktree,
serves `harness.html` and its modules, and supplies the COOP/COEP headers needed
for browser isolation. A new machine therefore does not need to create a
target-specific server file.

## Start the loop with the dashboard

Run the loop and its local status page together:

```bash
bash scripts/start.sh harness.toml --variant v22
```

Open http://127.0.0.1:8787/ in a browser. The page auto-refreshes and shows
the current run, compatibility counts, live activity events, active agent
attempts, Node-oracle and browser-target runner progress, recent process
output, accepted patches, and failure clusters. Stop
the dashboard with Ctrl-C; it also stops the loop process.

For a browser-suite benchmark without the agent loop or oracle, use the
canonical runner:

```bash
bash scripts/browser-suite.sh harness.toml v22
```

It runs only the `browser_js` scope through Playwright, in the harness's
64-test batches, with five target workers, a 10-second timeout, and no
failure cap. Use the same command for future benchmark runs.

The equivalent command is:

```bash
bnh --config harness.toml start --port 8787
```

Variants share converted target work. Run `v22` first, then run:

```bash
bash scripts/start.sh harness.toml --variant v24
```

The `v24` target integration branch is based on `v22`’s integration branch,
so accepted conversion work is carried forward instead of recreated. Each
variant keeps separate source/test state, which lets later-version and
sub-variant regressions be measured independently.

Agent attempts are observable and controllable while they run. Each attempt
writes live `agent.stdout.log` and `agent.stderr.log` files under
`.bnh-state/<variant>/attempts/<attempt-id>/`. The dashboard names the active
provider/model, shows its PID, assigned tests, and live output, and exposes
Restart and Kill controls. Restart resets that candidate worktree to its base
commit before launching it again; Kill stops it and prevents its partial patch
from entering validation.

Every task also receives read-only copies of its exact upstream files under
`.bnh-context/upstream/`, along with the failing stdout/stderr, a structured
`task.json`, and a reproduction script. Configure foundational browser
capabilities in `[agent].core_features`; the prompt explicitly directs agents
to expand shared STDOUT, STDERR, VFS, network, IPC, streams, process, timer,
loader, worker, crypto, platform, diagnostics, compression, and WebAssembly
layers instead of adding test-name workarounds.

## Connect your browser runtime

Serve a page from every target worktree that exposes:

```js
globalThis.__BROWSER_NODE_HARNESS__ = {
  async run(request) {
    // Mount request.files, execute ['node', ...request.flags, request.entry],
    // and return the actual exit status and captured streams.
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      skipped: false,
      details: {},
    };
  },
};
```

`adapters/playwright/target-bridge.example.js` shows a fuller adapter for a hypothetical runtime with `reset`, `mount`, and `spawn` methods. `bridge-contract.d.ts` contains the complete page-side TypeScript contract.

The external Playwright adapter exposes upstream files lazily through a binding. The page receives a manifest and calls the named binding to read each file as base64. This avoids serializing a large Node test bundle through `page.evaluate`.

Your development server must provide any isolation headers required by the runtime. WebAssembly thread implementations usually require:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The adapter records `crossOriginIsolated` with every result so missing headers are visible in failure logs.

## Configure the target server

The sample uses a persistent JSONL adapter:

```toml
[target]
command = ["node", "{config_dir}/adapters/playwright/daemon.mjs"]
cwd = "{worktree}"
protocol = "jsonl"
timeout_seconds = 120
inherit_env = false

[target.env]
BNH_SERVER_COMMAND = '["npm","run","dev","--","--host","127.0.0.1","--port","{{port}}"]'
BNH_BROWSER_URL = "http://127.0.0.1:{{port}}/harness.html"
BNH_BROWSER = "chromium"
BNH_BUNDLE_MODE = "common"
```

There are two placeholder passes. Single braces such as `{worktree}` are expanded by the Python harness. Double braces such as `{{port}}` survive that pass and become `{port}`, which the Playwright adapter replaces after allocating a free port.

`BNH_BUNDLE_MODE` controls what the browser can request:

- `entry`: the test entry and statically discovered relative dependencies
- `common`: `entry` plus `test/common` and `test/fixtures`
- `full`: `common` plus the entry suite directory and `lib`

Start with `common`. Use `full` when tests load relative modules dynamically. Aggregate and per-file byte limits are configurable.

## Initialize and run

```bash
bnh --config harness.toml init
bnh --config harness.toml scan
bnh --config harness.toml loop
```

`init` creates the durable integration worktree, discovers tests, and runs randomized adapter controls. The controls will fail until the browser bridge can execute simple scripts correctly.

`scan` fills the initial oracle and target compatibility matrix.

`loop` resumes from the SQLite state and integration branch. With `loop.max_iterations = 0`, it has no iteration ceiling.

Useful commands:

```bash
# Force a complete baseline refresh before launching agents.
bnh --config harness.toml loop --refresh

# Bound an exploratory run without changing TOML.
bnh --config harness.toml loop --max-iterations 3

# Reproduce specific upstream tests in a candidate worktree.
bnh --config harness.toml test --worktree /path/to/worktree \
  test/parallel/test-fs-open.js test/parallel/test-stream-readable.js

# Inspect current counts and clustered failures.
bnh --config harness.toml status
bnh --config harness.toml status --json

# Write a machine-readable report.
bnh --config harness.toml report --output bnh-report.json
```

## Gap-driven work

Failing tests are symptoms, not specifications. `bnh gaps` translates the
compatibility state into named capability gaps and finite build cards:

```bash
# Probe the oracle and target API surfaces, diff them, cluster failure
# evidence, and store ranked gaps.
bnh --config harness.toml gaps

# Emit one task-card directory per gap plus WORKLIST.md.
bnh --config harness.toml gaps --emit .bnh-state/v22/gap-worklist

# Re-probe the target and mark filled missing-api gaps.
bnh --config harness.toml gaps --verify

# List stored gaps without re-probing.
bnh --config harness.toml gaps --list
```

Gap kinds:

- `missing-api`: symbols the oracle exports that the browser runtime does not
  (surface probe diff, confirmed by failing-test stderr).
- `missing-validation`: argument-validation error codes the runtime does not
  raise yet, grouped per module.
- `native-addon-wasm`: native addons that need a WASM replacement. The card
  carries a symbol-usage histogram from the failing addons' C/C++ sources.
- `host-network`: network egress that must flow through the proxy capability.

Each card's `prompt.md` states the capability to build with Node's own
implementation as the reference spec; the acceptance tests are downstream
evidence, not the definition. Re-extraction retires stale open gaps and keeps
filled ones as history; the dashboard shows open gaps.

## Native addons via WASM

Native addon suites are in scope: the host pipeline compiles Node-API addon
sources to wasm32 with Emscripten and the runtime instantiates them through a
WASM N-API import layer (`adapters/playwright/runtime/addon-napi.js`).

```bash
# One-time toolchain install under the state dir.
bnh --config harness.toml addon-build --bootstrap test/node-api/1_hello_world/test.js

# Compile the addons of failing native tests and write addon-manifest.json.
bnh --config harness.toml addon-build
```

The manifest maps each expected `build/Release/binding.node` path to its wasm
artifact. The Playwright adapter serves those artifacts at the virtual `.node`
paths (`BNH_ADDON_MANIFEST` or `<state_dir>/addon-manifest.json`), and the
module loader instantiates any `.node` file whose bytes carry the WASM magic.
Real native binaries keep the explicit unsupported-browser boundary. The
compile step prefers Node's own wasm registration symbol
(`napi_register_wasm_v1`) with a fallback to `napi_register_module_v1`.

## Prune old run logs

Each execution writes four files under `logs/<run>/`. Prune everything but the
most recent runs:

```bash
bnh --config harness.toml prune --keep 20 --dry-run
bnh --config harness.toml prune --keep 20
```


The loop command exits `0` only for a green run and nonzero for a bounded, stalled, exhausted, or failed run.

## Agent command contract

The agent process starts in an isolated detached worktree. The harness renders these placeholders in `agent.command`, `agent.cwd`, and `agent.env`:

```text
{worktree} {prompt} {prompt_file} {task_id} {run_id} {iteration}
{config} {config_dir} {target_repo} {node_repo} {state_dir}
```

The prompt transport can be:

- `stdin`: prompt text is written to standard input
- `argument`: put `{prompt}` in the command
- `file`: put `{prompt_file}` in the command

The environment also contains `BNH_TASK_ID`, `BNH_TASK_FILE`, and `BNH_CONFIG`. `.bnh-context/task.json` has structured test metadata and previous attempts. `.bnh-context/run_assigned.py` reruns exactly the assigned target tests.

Agents may leave tracked changes, untracked changes, or commits. The harness collects the complete binary diff from the task base. It excludes `.bnh-context` and rejects changes to configured forbidden paths.

Example alternate Codex command:

```toml
[agent]
command = [
  "codex", "exec", "--ephemeral",
  "--sandbox", "workspace-write",
  "--ask-for-approval", "never",
  "-"
]
cwd = "{worktree}"
prompt_transport = "stdin"
inherit_env = true
```

For another agent, replace only this command. The agent does not need a custom protocol; it edits the worktree and exits.

The OpenCode launcher accepts these optional environment settings under
`[agent.env]`:


- `BNH_OPENCODE_MODEL_ORDER`: comma-separated OpenCode model IDs, without or
  with the `opencode/`, `openrouter/`, or `nvidia/` prefix. The launcher rejects
  Zen models outside the current known free set, verifies OpenRouter models
  against its live zero-price catalog, and verifies explicit NVIDIA models
  against the live NIM catalog.
- `BNH_OPENCODE_MODELS_URL`: model-discovery endpoint; the sample points to
  OpenCode Zen's public endpoint.
- `BNH_OPENROUTER_MODELS_URL`: OpenRouter model-discovery endpoint.
- `BNH_OPENCODE_CATALOG_CACHE`: project-local JSON file containing the cached
  free-model catalog and ranking. The sample stores it under the active variant.
- `BNH_OPENCODE_REFRESH_CATALOG`: set to `true` to explicitly refresh the
  cached catalog and ranking.
- `BNH_OPENCODE_INCLUDE_OPENROUTER`: set to `false` to disable the OpenRouter
  fallback provider.
- `BNH_OPENCODE_INCLUDE_NIM`: set to `false` to disable NVIDIA NIM. NIM is
  skipped when neither `NVIDIA_API_KEY` nor `BNH_NIM_API_KEY` is set.
- `BNH_NIM_API_KEY`: optional NVIDIA API key override; `NVIDIA_API_KEY` is also
  passed through to OpenCode.
- `BNH_NIM_BASE_URL` / `BNH_NIM_MODELS_URL`: hosted or self-managed NIM base and
  model-catalog endpoints. `BNH_NIM_FREE_MODELS` restricts the explicit
  hosted-free model allowlist.
- `BNH_OPENCODE_AGENT`: OpenCode primary agent name, defaulting to `build`.
- `BNH_OPENCODE_BINARY`: alternate OpenCode executable path.
- `BNH_OPENCODE_MAX_MODELS`: maximum verified-free models in one fallback chain
  (default `6`), preventing a large live catalog from serializing an attempt.
- `BNH_OPENCODE_MODEL_IDLE_TIMEOUT_SECONDS`: terminate a provider that produces
  no output for this long and continue to the next model (default `600`).

## Candidate acceptance gate

Every patch is checked in this order:

1. Patch exists, fits size/file limits, avoids forbidden globs, and passes `git diff --check`.
2. Optional target build/lint/unit command succeeds.
3. At least one assigned failing test passes, or all assigned tests pass when partial acceptance is disabled.
4. Randomized canaries prove the adapter executes source overrides, propagates throws, and preserves nonzero exit codes.
5. A hidden sample of previously passing upstream tests remains green.
6. Passing assigned tests are source-mutated with a random immediate throw; the mutated test must fail.
7. The patch is applied with a three-way indexed apply to the current integration head.
8. Setup, checks, assigned gains, guards, canaries, and mutations run again on that current head.
9. Validation commands must not modify tracked files outside the staged patch.
10. The harness commits the accepted patch and refreshes canonical state.

This does not make malicious code safe, but it rejects common reward-hacking strategies: filename special-cases, unconditional success, skip conversion, stale-server validation, test edits, and adapters that ignore source content.

## Persistent state and recovery

The state directory contains:

```text
state.sqlite3       tests, results, runs, attempts, accepted merges
worktrees/          integration and temporary agent worktrees
patches/            every collected candidate patch
attempts/           agent stdout/stderr and validation summaries
logs/               request, stdout, stderr, result per test execution
requests/           short-lived adapter exchange files
```

When `[primitives].enabled` is true, the loop first runs the project-owned
browser primitive phase before any upstream Node test is scheduled. The default
suite contains 32 source-override contracts covering runtime globals and
errors, byte/encoding behavior, VFS I/O, fetch and transport boundaries,
streams and backpressure, workers and transferables, process/timers, module
loading, crypto, platform and diagnostics, compression, WebAssembly, and
explicit unsupported host boundaries. Primitive contracts remain inside the
harness state and do not pollute the upstream checkout.

Variant state is persistent. Starting `v22` again reopens the latest `v22` run and continues its existing integration branch, database, test results, patches, and logs. This is intended for conversions that run for weeks; the loop does not create a disposable run on every restart.

The integration branch and SQLite database are the resume points. Running `bnh loop` again keeps prior fingerprints, attempt counts, rejected approaches, and accepted commits. Use `--refresh` after changing adapter behavior, the Node revision, discovery scope, or target configuration.

Do not point two harness processes at the same state directory and integration branch simultaneously.

## Test discovery and oracle behavior

Default discovery includes:

```text
test/parallel/test-*.js
test/sequential/test-*.js
```

The harness extracts `// Flags:` lines and a best-effort list of imported built-in modules for scheduling. The reference adapter executes each selected file with the configured matching Node binary and those flags. Only host-oracle passes are target-eligible when the oracle is enabled.

Use `discovery.exclude` only for tests outside your intended compatibility boundary or tests that are not deterministic in your environment. Exclusions are scope decisions, not passes.

Some upstream tests rely on native addons, child executables, privileged operating-system behavior, timing assumptions, or harness-specific fixtures. The browser runtime may need to emulate those capabilities, the Playwright bundle may need expansion, or the test may need to be explicitly out of scope. The system records the distinction instead of silently treating it as success.

## Configuration reference

The complete annotated configuration is `harness.example.toml`. Important controls:

| Setting | Meaning |
|---|---|
| `loop.workers` | Maximum concurrent coding-agent attempts |
| `agent` | Parallel OpenCode slots start on different free models, then fall back on quota/availability errors |
| `loop.target_concurrency` | Browser adapter workers for scans |
| `loop.scan_failure_limit` | Stop loop target scans after this many actionable failures; `0` runs the full target set (default 12) |
| `loop.queue_depth` | Number of agent attempts queued per iteration; only `loop.workers` run concurrently |
| `loop.batch_size` | Related subsystem tests assigned to one agent; distinct subsystem domains are scheduled into separate slots |
| `loop.guard_tests` | Hidden passing tests checked per candidate |
| `loop.mutation_tests` | Passing assigned tests source-mutated per candidate |
| `loop.max_iterations` | `0` means no iteration ceiling |
| `loop.max_attempts_per_test` | `0` means no per-test ceiling |
| `loop.accept_partial` | Accept a generalized patch that fixes part of a batch |
| `primitives.items` | Shared browser capabilities that agents establish before upstream tests |
| `primitives.max_rounds` | Maximum agent rounds allowed before the primitive phase blocks the run |
| `validation.check` | Optional target-owned build/lint/unit gate |
| `validation.forbidden_globs` | Paths agents are never allowed to change |
| `validation.require_source_override` | Require anti-fake-execution controls |

## Adapter protocol

The Python target adapter protocol, JSONL transport, and browser bridge schemas are documented in [docs/ADAPTER_PROTOCOL.md](docs/ADAPTER_PROTOCOL.md).

A custom target adapter can replace Playwright entirely. It must execute the test against the specified candidate worktree, honor `source_override`, return real status and output, and remain outside the agent-editable repository.

## Develop and self-test

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
node --check adapters/playwright/adapter-core.mjs
node --check adapters/playwright/daemon.mjs
node --check adapters/playwright/run-test.mjs
```

The end-to-end test creates temporary Node and target repositories, launches parallel fake agents, validates their patches, resolves a competing-patch conflict by retrying from the new integration head, and confirms the suite reaches green.

## License

Apache-2.0. See [LICENSE](LICENSE).
