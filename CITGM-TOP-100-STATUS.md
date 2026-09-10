# CITGM top-100 status

This is the ordered status record for `dev/adapters/playwright/citgm-top-100.json`.
`PASS` means the real upstream CITGM run passed in Chromium and the required
post-run gates passed. `PENDING` means the package has not been attempted yet.
`GATE-BLOCKED` means the package-level CITGM result is recorded, but a required
repository-wide gate is failing independently of that package, so ordering
cannot advance. `BLOCKED` is reserved for an external package or repository
blocker.

The continuation started from commit `0a56f2b` with ranks 1–5 already green.
Ranks 1–4 were completed before this record was introduced; rank 5
(`ansi-regex`) was reported CITGM-green at the continuation point. They are
not being reclassified as newly rerun here.

| Rank | Package | Status | Classification | Evidence / notes |
| ---: | --- | --- | --- | --- |
| 1 | semver | PASS | prior result | Green at continuation baseline (`0a56f2b`). |
| 2 | minimatch | PASS | prior result | Green at continuation baseline (`0a56f2b`). |
| 3 | debug | PASS | prior result | Green at continuation baseline (`0a56f2b`). |
| 4 | brace-expansion | PASS | prior result | Green at continuation baseline (`0a56f2b`). |
| 5 | ansi-regex | PASS | prior result | CITGM-green at continuation baseline. |
| 6 | supports-color | PASS | ours | Final Chromium CITGM run `citgm-1789059865080`; XO, AVA (55 tests), and TSD all exited 0. Required gates: build passed; `npm test` 296/296; Chromium Playwright 243/243; Firefox Playwright 243/243. |
| 7 | ms | PASS | none observed | First Chromium CITGM attempt `citgm-1789061171244` passed for published `ms@2.1.3`; npm install, upstream mocha tests, and all four child phases exited 0. No runtime defect was observed. Required gates: build passed; `npm test` 296/296; Chromium Playwright 243/243; Firefox Playwright 243/243. |
| 8 | ansi-styles | PASS | ours | First Chromium CITGM attempt `citgm-1789062097927` exposed an AVA worker-exit defect after 10 tests passed; fixed generally by tracking worker parent-port ref state. Final rerun `citgm-1789062714781` passed. Required gates: build passed; `npm test` 296/296; Chromium Playwright 243/243; Firefox Playwright 243/243. |
| 9 | chalk | PASS | ours | Published `chalk@6.0.0` initially failed in the shared ESM lowering path; six Chromium CITGM runs were preserved. Final run `citgm-1789065205654` passed after general ESM binding, export, `import.meta`, and `module.exports` interop fixes. Required gates: build passed; `npm test` 296/296; Chromium Playwright 243/243; Firefox Playwright 243/243. |
| 10 | emoji-regex | PASS | none observed | Published `emoji-regex@10.6.0` passed on the first Chromium CITGM run `citgm-1789065974177`; install and all four child phases exited 0. No runtime, nested-dependency, or upstream package/repository failure was observed. Required gates: build passed; `npm test` 296/296; Chromium Playwright 243/243; Firefox Playwright 243/243. |
| 11 | wrap-ansi | PASS | ours | Published `wrap-ansi@10.0.1` passed final Chromium CITGM `citgm-1789070077131`; the package-level failures were fixed in the shared ESM literal scanner and bare `node --test` discovery. Required gates passed after rebuilding the generated bundle: `npm test` 296/296; Chromium Playwright 246/246; Firefox Playwright 246/246. |
| 12 | lru-cache | BLOCKED | upstream package/repository (nested dependency) | Real Chromium CITGM was attempted through runs `citgm-1789073282313`, `citgm-1789073491479`, `citgm-1789073754174`, `citgm-1789073980749`, and `citgm-1789074100969`. General lockfile and VFS rename defects were fixed, but the final run reaches the upstream `scripts/build.sh` and fails because its nested native `esbuild` dependency requires omitted `@esbuild/linux-x64`; the exact native checkout passes. Repository gates for the fixes pass: build; `npm test` 298/298; Chromium 246/246; Firefox 246/246. Ordering stops here; ranks 13–100 remain pending. |
| 13 | tslib | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 14 | picomatch | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 15 | glob | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 16 | minipass | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 17 | type-fest | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 18 | color-name | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 19 | strip-ansi | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 20 | balanced-match | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 21 | p-limit | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 22 | glob-parent | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 23 | p-locate | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 24 | has-flag | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 25 | iconv-lite | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 26 | entities | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 27 | uuid | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 28 | json-schema-traverse | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 29 | string-width | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 30 | escape-string-regexp | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 31 | globals | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 32 | is-fullwidth-code-point | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 33 | argparse | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 34 | ignore | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 35 | which | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 36 | esbuild | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 37 | isexe | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 38 | js-yaml | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 39 | resolve | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 40 | mime-types | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 41 | nanoid | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 42 | yargs-parser | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 43 | source-map | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 44 | string_decoder | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 45 | color-convert | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 46 | estraverse | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 47 | https-proxy-agent | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 48 | @babel/helper-validator-identifier | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 49 | json5 | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 50 | react-is | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 51 | readdirp | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 52 | commander | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 53 | js-tokens | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 54 | shebang-regex | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 55 | fs-extra | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 56 | readable-stream | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 57 | punycode | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 58 | tr46 | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 59 | find-up | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 60 | webidl-conversions | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 61 | path-exists | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 62 | graceful-fs | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 63 | eslint-scope | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 64 | yargs | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 65 | cross-spawn | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 66 | statuses | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 67 | whatwg-url | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 68 | fast-deep-equal | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 69 | locate-path | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 70 | is-number | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 71 | get-stream | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 72 | yaml | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 73 | path-scurry | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 74 | @babel/parser | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 75 | browserslist | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 76 | @babel/helper-string-parser | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 77 | camelcase | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 78 | yallist | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 79 | @babel/template | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 80 | cookie | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 81 | agent-base | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 82 | safe-buffer | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 83 | qs | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 84 | fill-range | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 85 | path-to-regexp | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 86 | lodash | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 87 | universalify | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 88 | form-data | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 89 | jiti | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 90 | @radix-ui/react-primitive | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 91 | onetime | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 92 | node-releases | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 93 | ajv | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 94 | is-glob | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 95 | escalade | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 96 | update-browserslist-db | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 97 | yocto-queue | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 98 | to-regex-range | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 99 | fast-json-stable-stringify | PENDING | — | Not attempted; rank 11 requires a successful commit first. |
| 100 | get-intrinsic | PENDING | — | Not attempted; rank 11 requires a successful commit first. |

The pending-row cursor notes below rank 12 retain the historical rank-11
wording; rank 12 is the active external blocker, so no later package has been
started.

## Rank 6 failure record

All failures below occurred while running the real package through Chromium
CITGM 10.0.2. The nested packages were diagnostic surfaces; the fixes were
general runtime conformance fixes. No package-specific conditionals, fake
success paths, or candidate shims were added.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789057606078` / `/tmp/nacelle-citgm-top-100/citgm-1789057606078` | `@tybys/wasm-util` called `DataView.setBigUint64` with VFS `Stats` number fields. | Ours. Implemented Node-compatible `{ bigint: true }` `Stats` fields and nanosecond timestamps. |
| `citgm-1789057930325` / `/tmp/nacelle-citgm-top-100/citgm-1789057930325` | `@unrs/resolver-binding-wasm32-wasi` reached WASI but `Stats.isBlockDevice()` mixed BigInt mode with numeric constants. | Ours, exposed by a nested dependency. Updated all `Stats` mode predicates for BigInt metadata and verified the published resolver graph in isolation. |
| `citgm-1789058752375` / `/tmp/nacelle-citgm-top-100/citgm-1789058752375` | `ava` failed to import `../package.json` because the loader parsed `default}` as the export name. | Ours. Fixed the general ESM re-export parser and added a JSON default re-export oracle. |
| `citgm-1789058949225` / `/tmp/nacelle-citgm-top-100/citgm-1789058949225` | published `temp-dir` failed on `fs.realpath(os.tmpdir())` for an unmaterialized child `TMPDIR`. | Ours. Materialized configured temporary directories for runtime entries and nested children; added a child-process oracle. |
| `citgm-1789059495580` / `/tmp/nacelle-citgm-top-100/citgm-1789059495580` | AVA stalled after its Windows emulation changed `process.versions.node` and `os.release`. | Ours. Matched native configurability for `process.versions` entries and mutable `os` methods; added an override/dynamic-import oracle. |
| `citgm-1789059865080` / `artifacts/citgm-top-100/rank-006-supports-color/1789059865080.terminal-summary.json` | upstream test suite completed successfully: 55 AVA tests passed; XO and TSD exited 0. | PASS. Full stdout, stderr, child output, and terminal summaries for every attempt are preserved under `artifacts/citgm-top-100/rank-006-supports-color/`. |

## Explicit external blocker

`typescript-eslint` is `BLOCKED` outside the ranked manifest: its published
workspace package layout requires `nx` to resolve the package under test. This
is an upstream/package-layout blocker, not a Nacelle failure. No fake `nx`
shim was added.

## Rank 6 gate evidence

Commands were run from the repository root after the final CITGM pass:

```text
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 296/296
npm run test:browser:chromium                               PASS — 243/243
npm run test:browser:firefox                                 PASS — 243/243
```

## Rank 11 failure record

The published `wrap-ansi@10.0.1` package was tested through Chromium CITGM
10.0.2. Its native git-head checkout passed its own upstream tests (80
`node:test` cases, XO, and TSD), so each CITGM failure below was classified as
a browser-runtime defect. The complete artifacts are preserved under
`artifacts/citgm-top-100/rank-011-wrap-ansi/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789066607061` / `citgm-initial/` | XO's dependency graph stopped at `Failed to resolve module specifier "./ignore.js"`. | Ours, exposed through `globby`: the ESM import masker lost synchronization after nested template literals. Added a general nested-template scanner and regression oracle. |
| `citgm-1789068157823` / `citgm-rerun-1/` | Prettier's later `fs/promises` import was rewritten as a bare package specifier. | Ours, exposed through Prettier/XO: regex detection crossed a line comment and treated a quote inside the regex as a string delimiter. Fixed line-comment-aware regex-start detection and added an oracle. |
| `citgm-1789069524361` / `citgm-rerun-2/` | XO reached its upstream checks but the bare `node --test` lifecycle returned `node: no script specified`. | Ours: the shell/runtime did not implement Node's no-script test discovery. Added general `node --test` discovery rooted at the child cwd and a bridge oracle. XO's six warnings were non-fatal. |
| `citgm-1789070077131` / `citgm-rerun-3/` | Published `wrap-ansi@10.0.1` completed XO, bare `node --test`, and TSD with exit code 0. | PASS at the package/CITGM level. No nested-dependency or upstream package/repository blocker remained. |

## Rank 11 gate evidence and resolved blocker

The package-level gates completed as follows:

```text
npm test                                                     PASS — 296/296
full Chromium Playwright suite                              PASS — 246/246
full Firefox Playwright suite                               PASS — 246/246
```

The initial browser failures were the repository-wide Vite + React demo at test
243, not a wrap-ansi test. The high-level npm shell path was running a stale
ignored `dist/base-index.mjs` bundle left by an earlier source experiment; it
contained `process.execPath` in browser code while `src/index.js` had already
been restored. Rebuilding the generated bundle from current source fixed the
failure. The failed runs and shell-stack diagnostic remain preserved in
`artifacts/citgm-top-100/rank-011-wrap-ansi/playwright-chromium.log`,
`playwright-firefox.log`, `vite-intended-chromium.log`, and
`vite-shell-stack.log`; the final gates are in `npm-test-final.log`,
`playwright-chromium-final.log`, and `playwright-firefox-final.log`.

The first sandboxed `npm test` attempt was retained in the gate log and only
failed its existing network-backed demos with `EAI_AGAIN registry.npmjs.org`.
The host-network rerun above is the authoritative gate result.

## Rank 12 failure record

The exact upstream `lru-cache@11.5.2` git head was tested through Chromium
CITGM 10.0.2. Its native checkout at git head
`16b3a916662ab449d496b7b4b4f04132565d1d28` installed successfully and passed
its native test suite (29 TAP subtests, 19,645 assertions), so the final
failure is not an upstream lru-cache test failure or a fake package shim.
Complete CITGM artifacts are preserved under
`artifacts/citgm-top-100/rank-012-lru-cache/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789073282313` / `citgm-initial/` | `tshy`'s TypeScript compiler returned `TS2344` for `Channel<unknown>` and `TracingChannel<unknown>`. | Ours, exposed by npm dependency resolution: the browser installer ignored the committed lockfile and selected newer `tshy`, TypeScript, and `@types/node` versions. Added general lockfile-aware package placement and a regression oracle. |
| `citgm-1789073491479` / `citgm-debug-spawn/` | The synchronous compiler spawn returned status 2 with the same TypeScript diagnostics. | Ours; the probe confirmed this was a real compiler failure, not lost child output. The temporary probe was removed. |
| `citgm-1789073754174` / `citgm-debug-install/` | Dependency probe recorded browser selections `tshy@4.1.3`, `typescript@6.0.3`, and `@types/node@26.5.1`, versus the native lockfile's `tshy@4.1.2`, `typescript@6.0.2`, and `@types/node@25.8.0`. | Ours. Lockfile resolution corrected the graph without pinning lru-cache or adding a shim. |
| `citgm-1789073980749` / `citgm-fix-1/` | `tshy` reached output generation but failed with `EEXIST` when renaming an existing generated file. | Ours. Implemented Node-compatible replacement semantics for VFS file/symlink renames and added a regression oracle. |
| `citgm-1789074100969` / `citgm-fix-2/` | The upstream build script invokes `esbuild`, which requires the omitted native optional package `@esbuild/linux-x64`; the browser cannot execute that Linux binary. | Upstream package/repository blocker exposed by a nested dependency. The browser npm installer correctly skips OS-specific native optional packages; replacing it with a fake binary or package would hide the actual incompatibility. No such shim was added. |

## Rank 12 gate evidence

The repository gates for the general fixes passed after the final blocked CITGM
run:

```text
npm run build                                             PASS
npm test                                                   PASS — 298/298
npm run test:browser:chromium                             PASS — 246/246
npm run test:browser:firefox                              PASS — 246/246
```

## Rank 7 CITGM evidence

The real Chromium CITGM run used CITGM 10.0.2 and the published `ms@2.1.3`
package. It completed without a package, nested-dependency, or runtime
failure, so no code change was required for rank 7. The complete run output,
child output, terminal summary, and gate logs are preserved under
`artifacts/citgm-top-100/rank-007-ms/`.

## Rank 7 gate evidence

Commands were run from the repository root after the successful CITGM pass:

```text
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 296/296
npm run test:browser:chromium                               PASS — 243/243
npm run test:browser:firefox                                 PASS — 243/243
```

## Rank 8 failure record

All failures below occurred while running the real package through Chromium
CITGM 10.0.2. The package's own tests passed before the process-lifecycle
failure; the defect was in the browser runtime, not in `ansi-styles` or AVA.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789062097927` / `artifacts/citgm-top-100/rank-008-ansi-styles/citgm-initial/` | Published `ansi-styles@7.0.0` ran all 10 AVA tests successfully, then reported `Timed out while running tests` and `Failed to exit when running test/test.js`; CITGM exited 1. | Ours. An exact native checkout at `ansi-styles` git head passed its upstream `npm test`. A focused browser oracle reproduced the hang with a persistent `parentPort` message listener followed by `parentPort.unref()`. The runtime treated any message listener as a referenced parent port, so AVA's intentionally unrefed worker port kept the virtual process alive. |
| `artifacts/citgm-top-100/rank-008-ansi-styles/gates/worker-unref-red-2.log` | Focused Chromium oracle failed with `ERR_RUN_TIMEOUT`, with the worker exit code unresolved. | Ours. Added ref-state tracking to the general worker parent-port implementation; `ref()`, `unref()`, and `close()` now update lifecycle state independently of listener presence. |
| `citgm-1789062714781` / `artifacts/citgm-top-100/rank-008-ansi-styles/citgm-final/` | The same published package completed its AVA, XO, and TSD child phases with exit code 0. | PASS after the general runtime fix. No nested dependency or upstream package/repository failure was observed. |

## Rank 8 CITGM evidence

The first and final real Chromium CITGM commands were:

```text
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- ansi-styles 2>&1 | tee /tmp/ansi-styles-citgm-initial.log
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- ansi-styles 2>&1 | tee /tmp/ansi-styles-citgm-rerun.log
```

The final run used published `ansi-styles@7.0.0` and completed with exit code
0. The initial failure, final run, focused oracle logs, and child summaries
are preserved under `artifacts/citgm-top-100/rank-008-ansi-styles/`.

## Rank 8 gate evidence

Commands were run from the repository root after the final CITGM pass and
after the runtime fix:

```text
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 296/296
npm run test:browser:chromium                               PASS — 243/243
npm run test:browser:firefox                                 PASS — 243/243
```

The focused `expanded-primitives` oracle also passed 6/6 in Chromium and 6/6
in Firefox. Its pre-fix red run and post-fix build/green runs are preserved
under `artifacts/citgm-top-100/rank-008-ansi-styles/gates/`.

## Rank 9 failure record

All failures below occurred while running the real published `chalk@6.0.0`
package through Chromium CITGM 10.0.2. The exact native checkout passed its
upstream 58-test suite, so the failures were runtime compatibility defects;
nested `yargs` and `yargs-parser` only exposed the defects. No package-specific
conditionals, fake success paths, or candidate shims were added.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789063844945` / `artifacts/citgm-top-100/rank-009-chalk/citgm-initial/` | `SyntaxError: Identifier '__dirname' has already been declared` while c8 loaded the ESM dependency graph. | Ours. Synchronous ESM lowering placed legal ESM lexical bindings in the synthetic CommonJS wrapper scope. Lowered modules now execute in a block, with a focused collision oracle. |
| `citgm-1789064234996` / `artifacts/citgm-top-100/rank-009-chalk/citgm-rerun-1/` | `SyntaxError: Unexpected token 'export'` remained in a nested `yargs-parser` module. | Ours, exposed by a nested dependency. Added handling for line-form uninitialized `export var`/`let`/`const` declarations. |
| `citgm-1789064557014` / `artifacts/citgm-top-100/rank-009-chalk/citgm-rerun-2/` | The same residual `export` syntax was isolated to `export var` and `export {}` forms in the parser graph. | Ours. Completed general handling for uninitialized exports and empty export statements; the focused boundary oracle covers both. |
| `citgm-1789064809341` / `artifacts/citgm-top-100/rank-009-chalk/citgm-rerun-3/` | `Cannot use 'import.meta' outside a module` from `yargs`'s `import.meta.resolve()` path. | Ours, exposed by a nested dependency. Lowered `import.meta.url` and `import.meta.resolve()` for synchronous ESM execution. |
| `citgm-1789064961903` / `artifacts/citgm-top-100/rank-009-chalk/citgm-rerun-4/` | `TypeError: Yargs is not a function`; `export { yargsParser as 'module.exports' }` was emitted as an ordinary quoted property instead of direct CommonJS interop. | Ours, exposed by `yargs-parser`. Implemented the Node-compatible special `module.exports` export name and added a callable interop oracle. |
| `citgm-1789065205654` / `artifacts/citgm-top-100/rank-009-chalk/citgm-final/` | Published package install and upstream test execution completed with exit code 0. The artifact retains a non-fatal foreground-child watchdog probe for `/node/10006`; c8 and tsc both exited 0. | PASS. No nested dependency or upstream package/repository blocker remained. |

## Rank 9 CITGM evidence

The real Chromium CITGM commands were run in order and their complete logs
and CITGM artifacts are preserved under
`artifacts/citgm-top-100/rank-009-chalk/`:

```text
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- chalk 2>&1 | tee /tmp/chalk-citgm-initial.log
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- chalk 2>&1 | tee /tmp/chalk-citgm-rerun.log
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- chalk 2>&1 | tee /tmp/chalk-citgm-rerun-2.log
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- chalk 2>&1 | tee /tmp/chalk-citgm-rerun-3.log
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- chalk 2>&1 | tee /tmp/chalk-citgm-rerun-4.log
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- chalk 2>&1 | tee /tmp/chalk-citgm-rerun-5.log
```

The exact native checkout at chalk commit `661317e6f91fe7c90306c2c48ea9354562ee9146`
also passed its own `npm test` (58 tests, including c8, XO, and tsc). This
confirmed the CITGM failures were ours rather than an upstream package or
repository failure.

## Rank 9 gate evidence

Commands were run from the repository root after the final CITGM pass and
after the runtime fix:

```text
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 296/296
npm run test:browser:chromium                               PASS — 243/243
npm run test:browser:firefox                                 PASS — 243/243
```

The focused `esm-boundaries` oracle passed 8/8 in Chromium and 8/8 in
Firefox. Its pre-fix red run and post-fix build/green runs are preserved under
`artifacts/citgm-top-100/rank-009-chalk/`.

## Rank 10 CITGM evidence

The real Chromium CITGM command was:

```text
NACELLE_CITGM_ARTIFACT_DIR=/tmp/nacelle-citgm-top-100 npm run citgm:browser:chromium -- emoji-regex 2>&1 | tee /tmp/emoji-regex-citgm-initial.log
```

The published `emoji-regex@10.6.0` run `citgm-1789065974177` passed with
CITGM 10.0.2. Complete stdout, stderr, child output, terminal summary, and
network/progress artifacts are preserved under
`artifacts/citgm-top-100/rank-010-emoji-regex/`. No package-specific runtime
workaround or source change was needed.

## Rank 10 gate evidence

Commands were run from the repository root after the successful CITGM pass:

```text
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 296/296
npm run test:browser:chromium                               PASS — 243/243
npm run test:browser:firefox                                 PASS — 243/243
```
