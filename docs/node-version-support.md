# Node version support and upgrade plan

## Current audit

The runtime is a strong v22 implementation with shared browser compatibility
modules, a virtual filesystem, workers, npm/script orchestration, browser
networking, and the optional Nacelle+ HTTP transport. The recent compatibility
work also has focused coverage for shell execution, TypeScript compilation,
crossenv-style scripts, proxy routing, transport negotiation, streaming,
revocation, and hostile redirect behavior.

The remaining versioning gap is structural:

- `src/wasm/v22/` is the only checked-in versioned WASM artifact directory.
- The build copies one selected WASM directory into a flat `dist/wasm/`, so a
  build is target-specific but the package layout does not retain the matrix.
- `process.version`, `process.versions`, shell `node --version`, and several
  metadata paths are v22-centered even though `Nacelle.create({ version })`
  accepts a string.
- The package has a `./v22` export and v22 release scripts, but no registry of
  supported lines, no current/non-LTS alias, and no automated parity matrix.
- The conformance tests added for Nacelle+ are deterministic contract tests;
  they do not replace real Chrome/Firefox lifecycle tests.
- The full repository test command is not currently a reliable gate: some
  contract tests import missing Playwright runtime fixtures, and runtime tests
  that share a realm must be run as isolated processes. This needs to be fixed
  before using the suite as a version release gate.

These are product and release-engineering gaps, not reasons to expand Nacelle+
beyond its fetch-only boundary. The documented DNS-rebinding limitation and
the lack of WebSocket/raw-socket support remain intentional for this tier.

## Support policy

Support is defined by Node release lines, not arbitrary patch versions. At any
release, the support registry will contain:

1. every upstream LTS line still within its supported maintenance window;
2. the latest upstream non-LTS/current line; and
3. a short-lived migration line when a new LTS line replaces the active one.

The package aliases are:

- `latest`: the default supported LTS build;
- `lts`: the same active LTS line, as an explicit stable alias;
- `current`: the latest non-LTS line;
- `nXX`: an immutable Node-major channel such as `n22` or `n24`;
- `nacelle/vXX`: the matching explicit package export when shipped in the
  aggregate package.

An upstream-EOL line may remain installable through its immutable `nXX` build
for a documented period, but it is not part of the supported parity matrix.
No line is promoted to an alias until its browser, npm, shell, networking,
TypeScript, and WASM gates are green.

## Implementation plan

### 1. Establish a version registry

Add one checked-in registry, for example `versions/support.json`, with one
record per Node major:

```json
{
  "v22": {
    "status": "maintenance-lts",
    "nodeRef": "v22.x",
    "wasmDirectory": "src/wasm/v22",
    "npmTag": "n22",
    "profile": "src/versions/v22/profile.js"
  }
}
```

The registry is the source for build validation, package exports, CI matrix
generation, documentation, and release aliases. A command should report the
resolved set (`lts`, `current`, EOL lines) from this registry rather than
scattering version constants through scripts.

### 2. Separate version profiles from shared runtime code

Create a small profile interface under `src/versions/`. A profile owns only
version-sensitive facts and shims:

- `process.version` and `process.versions` values;
- Node feature flags and experimental feature availability;
- builtin/module surface differences;
- `node --version` and shell-visible version output;
- `module.stripTypeScriptTypes()` behavior and its supported options;
- WASM artifact manifest and addon ABI expectations;
- explicit compatibility notes where browser behavior intentionally differs.

The shared runtime, VFS, worker model, HTTP compatibility layer, npm client,
shell parser, and Nacelle+ transport should consume the profile interface. Do
not fork `runtime.js` per major. If a version genuinely needs a different
implementation, isolate that branch behind a named profile capability and add
an issue/test for removing it later.

### 3. Make version selection real and observable

At `Nacelle.create()` time:

- normalize `22`, `v22`, and supported aliases to one registry record;
- reject an unknown, EOL, or unbuilt target with a deterministic error;
- load the matching profile and artifact base URL;
- make `process.version`, `node --version`, `process.versions`, and build
  metadata agree;
- expose the selected profile in a read-only runtime diagnostic;
- keep `version` out of capability grants so changing Node major cannot widen
  permissions.

Add a version-independent `node --version` contract test and a profile-specific
metadata test so a release cannot accidentally report v22 while loading a
different WASM set.

### 4. Change the artifact and package layout

The first implementation can continue publishing one target per `nXX` channel,
but the build output must retain its identity:

```text
dist/
  v22/
    index.mjs
    index.cjs
    runtime/
    wasm/
    version.json
  v24/
    ...
```

Build commands should support both:

```sh
npm run build -- --node-version=v22
npm run build:all-supported
```

`build:all-supported` validates that every registry line has its profile,
WASM manifest, package metadata, and passing test selection. A clean build
must be reproducible apart from an explicitly generated build timestamp; use a
stable source revision and profile hash in `version.json`.

### 5. Build a parity contract before adding the next major

Parameterize the existing tests over the registry. Every supported profile
must pass the same required contract for:

- Nacelle create/run/execute and process metadata;
- VFS, workers, signals, environment capability keys, and lifecycle;
- npm metadata/install/script execution;
- shell assignments, pipelines, redirects, globbing, common builtins, and
  `cross-env` patterns;
- TypeScript strip/compile/run behavior;
- HTTP/HTTPS response, proxy, abort, and streaming semantics;
- WASM addon load/probe and ABI manifest checks;
- Nacelle+ negotiation where the browser transport is enabled.

Expected differences belong in a small profile exception file with a reason,
reference behavior, and removal condition. A missing implementation is a
failure, not an exception. Keep the 80% minimum coverage requirement per
profile and for the shared runtime.

For each Node major, compare the browser runtime against a native reference
of that same major. The comparison should record `pass`, `unsupported`, or
`semantic-drift`; it should never silently treat an unsupported API as parity.

### 6. Add browser and release CI gates

The CI matrix should expand over:

```text
node major × browser (Chrome, Firefox) × test group
```

The test groups are shared unit/contract tests, browser smoke tests, npm/script
workloads, WASM probes, and Nacelle+ extension tests. Run isolated runtime
processes for tests that mutate browser-global compatibility state. Before
release, also run the workload corpus: provider SSE, npm metadata/tarballs,
GitHub raw/API, Vite traffic, large downloads, redirects, 429 responses, slow
endpoints, aborts, and extension restart/reconnect.

The release job must build every supported line, verify package exports and
`version.json`, run the parity report, and refuse alias updates if any required
line is red. Publish immutable `nXX` tags first; update `latest`, `lts`, and
`current` only after the matrix completes.

### 7. Upgrade sequence

For the next major upgrade:

1. add the upstream Node ref, release status, profile skeleton, and artifact
   directory to the registry;
2. generate the new WASM/addon manifest and verify its ABI against the profile;
3. run the shared parity suite and classify every failure against the native
   reference;
4. implement only version-owned differences in the new profile or a small
   adapter module;
5. run Chrome and Firefox smoke/lifecycle tests plus the real workload corpus;
6. publish the immutable `nXX` channel and keep it in migration status;
7. promote it to `latest`/`lts` only when the upstream release status and all
   gates agree;
8. move the prior active LTS to maintenance and remove it from aliases only
   at upstream EOL, with a documented deprecation window.

The first concrete upgrade should be selected from the registry at execution
time, not hard-coded into this document. That prevents a stale plan from
confusing the latest non-LTS line with the latest LTS line.

## Definition of done

Node-version support is complete when a contributor can run one command to
list supported lines, one command to build all supported artifacts, and one
command to produce a parity report. For every listed line, the selected version
is visible and consistent in runtime metadata, the package export and WASM
manifest match, the shared contract suite is green in Chrome and Firefox, and
any intentional deviation is documented with a test and an owner.
