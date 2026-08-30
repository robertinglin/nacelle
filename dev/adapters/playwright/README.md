# Playwright target adapter

The adapter is deliberately outside the agent-editable runtime repository. For each target worktree it starts that worktree's development server, launches a persistent browser, opens the harness page, and calls:

```js
globalThis.__BROWSER_NODE_HARNESS__.run(request)
```

`target-bridge.example.js` is the supplied default bridge for the shared browser-native runtime. It imports the runtime library, materializes the manifest into the runtime's virtual filesystem, runs the requested entry, captures stdout/stderr, and returns the protocol result. Target projects should copy the example into the page bundle and provide the runtime module beside it (or change only that import to their runtime package).

The shared runtime API used by the example is:

- `reset(context)`: clear per-test process, module, VFS, and event-loop state.
- `mount(files, context)`: mount a `Record<string, Uint8Array>` keyed by virtual paths such as `/node/test/...`.
- `spawn(argv, options)`: run the entry in the browser-native runtime and return a child with `exit`, `stdoutText()`, `stderrText()`, and `kill()`.
- `version`: optional diagnostic runtime version.

The context carries the request `env`, selected `variant`, all request `metadata`, and an `AbortSignal`. The example also exposes the variant as `BNH_VARIANT` when a request supplies one. A target can extend the base runtime by wrapping these methods and forwarding the context and signal, for example to add a Node-version-specific module or fixture without changing the bridge protocol. Extensions must remain browser-native; they must not delegate test execution to host Node, a server-side container, or a remote machine.

Proxy transport is opt-in. A request may include `proxy: { mode: "proxy", enabled: true, capability: { proxy: true } }`, and a page-side bridge can supply an adapter callback/object through the runtime context. Without that selection and grant, DNS, TCP, UDP, and HTTP stay on their virtual browser-local implementations. A proxy adapter is expected to implement only the operations it supports (`request`, `connect`, `send`, `resolve`, or `tls`); an absent adapter never turns virtual mode off.

The Python harness can carry the same selection from TOML with an optional
`[target.proxy]` table. Leave it at `mode = "virtual"` (the default), or set
`mode = "proxy"`, `enabled = true`, and `capability = { proxy = true }` when the
target page has installed a compatible adapter. The selection alone never
creates host I/O and a missing page adapter leaves the virtual implementation
in place.

The timeout covers materialization, runtime reset/mount, process creation, and test execution. The bridge aborts the runtime, kills the child when one exists, and returns any output available after termination. The runtime must honor the signal for setup and make `kill()` idempotent.

The harness page receives a manifest for the upstream test entry, its static relative dependencies, `test/common`, and `test/fixtures`. Randomized source overrides are mounted at the original virtual entry path, so the actual overridden file is what executes. The adapter reads file bytes through a Playwright binding, mounts them into the browser runtime, executes the actual entry, and returns the real exit code and captured streams.

Install once:

```bash
cd adapters/playwright
npm install
npx playwright install chromium
```

Configure `BNH_SERVER_COMMAND` as a JSON argv array. `{port}` and `{worktree}` are replaced by the adapter. Configure `BNH_BROWSER_URL` with the same placeholders. In TOML, write them as `{{port}}` and `{{worktree}}` so the Python harness leaves one brace pair for the adapter. The command is started separately in every integration or candidate worktree, so parallel agents are validated against their own code rather than a shared server.

The JSONL daemon keeps one browser and development server alive for many tests. The Python harness creates a daemon pool when `target.protocol = "jsonl"`. `run-test.mjs` remains available as a slower one-shot adapter.

Serve the page with any headers required by the runtime. WebAssembly thread implementations generally need cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`).

The base browser runtime provides virtual, run-scoped implementations for the filesystem, process/worker IPC, DNS, TCP, UDP, cluster coordination, and browser-fetch HTTP paths. They never open host sockets or execute host processes. A target may explicitly opt into the `proxy` capability and provide an adapter for operations that must be fulfilled elsewhere; proxy mode is capability-gated and is never required for the browser-native path. Native addons and other privileged operating-system behavior remain explicit virtual contracts until a target supplies a browser-safe implementation.

`BNH_BUNDLE_MODE=entry` exposes only the entry and statically discovered relative dependencies. `common` also exposes `test/common` and `test/fixtures`. `full` additionally exposes the entry's whole suite directory and `lib`. File and aggregate byte limits are controlled by the variables in `harness.example.toml`.
