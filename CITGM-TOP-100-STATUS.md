# CITGM top-100 status

This is the ordered status record for `dev/adapters/playwright/citgm-top-100.json`.
`PASS` means the real upstream CITGM run passed in Chromium and the required
post-run gates passed. `PENDING` means the package has not been attempted yet.
`GATE-BLOCKED` means the package has a recorded non-green CITGM result, or a
required repository-wide gate is failing, so ordering cannot advance.
`BLOCKED` is reserved for an external package or repository blocker.

Continuation gate rule: when a package passes exact CITGM in both Chromium and
Firefox without repository changes, the repository-wide build, unit, and full
Playwright gates are skipped for that package; the two exact CITGM browser
results are the gate before committing its artifacts. If runtime or test
changes are made, all repository-wide gates remain required.

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
| 12 | lru-cache | PASS | ours | Published `lru-cache@11.5.2` now passes exact CITGM in both browsers: Firefox `citgm-1789211689248` and Chromium `citgm-1789211984176`; all 29 upstream TAP subtests and 19,628 assertions pass, including all six `esbuild-wasm` build invocations. Required final gates passed after the fix: build; `npm test` 333/333; Chromium Playwright 266/266; Firefox Playwright 266/266. The native esbuild, timer-drain, process-output, async ordering, and late post-exit rejection behaviors were fixed in the shared browser runtime; rank 13 is recorded as an upstream blocker, ranks 14–16 are complete, and rank 18 is current. |
| 13 | tslib | BLOCKED | upstream package/repository (CITGM test contract) | Published `tslib@2.8.1` installs successfully in Chromium (`citgm-1789213425873`) and Firefox (`citgm-1789213473799`), but both CITGM runs stop before package execution with `Module does not support npm-test!`. The package metadata has no `scripts.test`; there is no browser-runtime behavior to fix and no safe test shim to add. The blocker is recorded; ranks 14–17 are complete and rank 18 is current. |
| 14 | picomatch | PASS | ours | Published `picomatch@4.0.7` passes exact CITGM in Chromium (`citgm-1789215545080`) and Firefox (`citgm-1789215632195`); npm install, ESLint, and Mocha (1,983 passing tests) all exit 0. The runtime fix suppresses the private virtual-process exit sentinel at the parent unhandled-rejection boundary and preserves useful object-error formatting. Required final gates passed after rebuilding: npm test 333/333; Chromium Playwright 266/266; Firefox Playwright 266/266. Ranks 15–17 are complete and rank 18 is current. |
| 15 | glob | PASS | ours, with upstream test behavior preserved | Published `glob@13.0.6` passes exact CITGM in Chromium (`citgm-1789230527444`, 1106 pass + 1 skip) and Firefox (`citgm-1789230819617`, 1106 pass + 1 skip). The shared fixes cover empty-directory snapshots, POSIX root temporary fixtures, recursive symlink traversal/removal semantics, async directory-read ordering, and transitive `@tapjs/mock` builtin resolution. Required final gates passed: build with 5 WASM artifacts; `npm test` 336/336; Chromium Playwright 266/266; Firefox Playwright 266/266. |
| 16 | minipass | PASS | ours, with upstream package-layout blocker handled by an unofficial browser alternative | Published `minipass@7.1.3` (gitHead `ab4b3b05d0d557ac6bb178f38501b11d0c96454e`) passes exact CITGM in Chromium (`citgm-1789249717236`) and Firefox (`citgm-1789249917952`); the upstream TAP child reports 365/365 in both browsers. The published `@typescript/native-preview` dependency has no browser artifact and requires its OS-native optional package, so browser resolution uses the version-matched `tsgo-wasm` package as an explicitly documented unofficial distribution. No fake native shim was added. Required final gates passed: build with 5 WASM artifacts; `npm test` 338/338; Chromium Playwright 270/270; Firefox Playwright 270/270. |
| 17 | type-fest | BLOCKED | upstream package/repository (unbounded devDependency/tooling regression) | Published gitHead `3919b6481ab4c7a1316a6fed9da20b58e470e6a4` / `type-fest@5.9.0` completed all browser-runtime portions: `tsc`, `tsd`, the node:test linter, and the 31 snapshot tests passed. Final Chromium CITGM `citgm-1789255912771` fails only `test:xo` with four lint errors in checked-in `test-d` fixtures (`@typescript-eslint/no-meaningless-void-operator` and `new-cap`); a native run of the exact githead also exits 1. The repository declares floating `typescript-eslint:^8.47.0` and `eslint:^10.1.0`, so the fresh install resolves newer lint rules against fixtures/config that are not updated. Earlier browser-runtime and installer failures were ours and are fixed below; no package source or fake dependency was added. Complete artifacts are preserved under `artifacts/citgm-top-100/rank-017-type-fest/`. |
| 18 | color-name | PASS | none observed | Published `color-name@2.1.0` passed exact CITGM in Chromium (`citgm-1789257669941`) and Firefox (`citgm-1789257694610`); install and the upstream test suite exited 0 in both browsers. No runtime, nested-dependency, or upstream package/repository failure was observed. Required final gates passed: build with 5 WASM artifacts; `npm test` 338/338; Chromium Playwright 277/277; Firefox Playwright 277/277. |
| 19 | strip-ansi | PASS | none observed; transient runner interruption | Published `strip-ansi@7.2.0` at gitHead `38ff9f2282540422031ed523f0060c7bb575e20f` passed exact Chromium CITGM `citgm-1789258900253` and Firefox CITGM `citgm-1789259060762`; XO, AVA (8 tests), and tsd all exited 0. The first Chromium attempt `citgm-1789258810545` ended without a terminal result while the large XO worker was loading; its complete artifact is preserved as a transient runner interruption, not a package failure. Required final gates passed: build with 5 WASM artifacts; `npm test` 338/338 (run before the updated skip rule); Chromium Playwright 277/277; Firefox Playwright 277/277. |
| 20 | balanced-match | PASS | none observed | Published `balanced-match@4.0.4` passed exact Chromium CITGM `citgm-1789260264391` and Firefox CITGM `citgm-1789260316808`; its `tshy` build and TAP suite exited 0 in both browsers. No runtime, nested-dependency, or upstream package/repository failure was observed. No repository changes were made, so the repository-wide gates were skipped under the continuation gate rule. |
| 21 | p-limit | PASS | ours | Published `p-limit@7.3.2` at gitHead `783068bb9e967fd7bea8642e1bf5a3627fe38bdf` passed exact final Chromium CITGM `citgm-1789266269148` and Firefox CITGM `citgm-1789266420987`; the upstream XO, AVA, and tsd phases exited 0 in both browsers. The fix covers browser `unhandledRejection`/`rejectionHandled` delivery and Firefox ESM Promise tracking across the p-limit queue boundary. Required final gates passed after the runtime and oracle changes: build; `npm test` 338/338; Chromium Playwright 280/280; Firefox Playwright 280/280. Complete artifacts are preserved under `artifacts/citgm-top-100/rank-021-p-limit/`. |
| 22 | glob-parent | PENDING | — | Not attempted; rank 21 is complete and rank 22 is current. |
| 23 | p-locate | PENDING | — | Not attempted; rank 22 is current. |
| 24 | has-flag | PENDING | — | Not attempted; rank 22 is current. |
| 25 | iconv-lite | PENDING | — | Not attempted; rank 22 is current. |
| 26 | entities | PENDING | — | Not attempted; rank 22 is current. |
| 27 | uuid | PENDING | — | Not attempted; rank 22 is current. |
| 28 | json-schema-traverse | PENDING | — | Not attempted; rank 22 is current. |
| 29 | string-width | PENDING | — | Not attempted; rank 22 is current. |
| 30 | escape-string-regexp | PENDING | — | Not attempted; rank 22 is current. |
| 31 | globals | PENDING | — | Not attempted; rank 22 is current. |
| 32 | is-fullwidth-code-point | PENDING | — | Not attempted; rank 22 is current. |
| 33 | argparse | PENDING | — | Not attempted; rank 22 is current. |
| 34 | ignore | PENDING | — | Not attempted; rank 22 is current. |
| 35 | which | PENDING | — | Not attempted; rank 22 is current. |
| 36 | esbuild | PENDING | — | Not attempted; rank 22 is current. |
| 37 | isexe | PENDING | — | Not attempted; rank 22 is current. |
| 38 | js-yaml | PENDING | — | Not attempted; rank 22 is current. |
| 39 | resolve | PENDING | — | Not attempted; rank 22 is current. |
| 40 | mime-types | PENDING | — | Not attempted; rank 22 is current. |
| 41 | nanoid | PENDING | — | Not attempted; rank 22 is current. |
| 42 | yargs-parser | PENDING | — | Not attempted; rank 22 is current. |
| 43 | source-map | PENDING | — | Not attempted; rank 22 is current. |
| 44 | string_decoder | PENDING | — | Not attempted; rank 22 is current. |
| 45 | color-convert | PENDING | — | Not attempted; rank 22 is current. |
| 46 | estraverse | PENDING | — | Not attempted; rank 22 is current. |
| 47 | https-proxy-agent | PENDING | — | Not attempted; rank 22 is current. |
| 48 | @babel/helper-validator-identifier | PENDING | — | Not attempted; rank 22 is current. |
| 49 | json5 | PENDING | — | Not attempted; rank 22 is current. |
| 50 | react-is | PENDING | — | Not attempted; rank 22 is current. |
| 51 | readdirp | PENDING | — | Not attempted; rank 22 is current. |
| 52 | commander | PENDING | — | Not attempted; rank 22 is current. |
| 53 | js-tokens | PENDING | — | Not attempted; rank 22 is current. |
| 54 | shebang-regex | PENDING | — | Not attempted; rank 22 is current. |
| 55 | fs-extra | PENDING | — | Not attempted; rank 22 is current. |
| 56 | readable-stream | PENDING | — | Not attempted; rank 22 is current. |
| 57 | punycode | PENDING | — | Not attempted; rank 22 is current. |
| 58 | tr46 | PENDING | — | Not attempted; rank 22 is current. |
| 59 | find-up | PENDING | — | Not attempted; rank 22 is current. |
| 60 | webidl-conversions | PENDING | — | Not attempted; rank 22 is current. |
| 61 | path-exists | PENDING | — | Not attempted; rank 22 is current. |
| 62 | graceful-fs | PENDING | — | Not attempted; rank 22 is current. |
| 63 | eslint-scope | PENDING | — | Not attempted; rank 22 is current. |
| 64 | yargs | PENDING | — | Not attempted; rank 22 is current. |
| 65 | cross-spawn | PENDING | — | Not attempted; rank 22 is current. |
| 66 | statuses | PENDING | — | Not attempted; rank 22 is current. |
| 67 | whatwg-url | PENDING | — | Not attempted; rank 22 is current. |
| 68 | fast-deep-equal | PENDING | — | Not attempted; rank 22 is current. |
| 69 | locate-path | PENDING | — | Not attempted; rank 22 is current. |
| 70 | is-number | PENDING | — | Not attempted; rank 22 is current. |
| 71 | get-stream | PENDING | — | Not attempted; rank 22 is current. |
| 72 | yaml | PENDING | — | Not attempted; rank 22 is current. |
| 73 | path-scurry | PENDING | — | Not attempted; rank 22 is current. |
| 74 | @babel/parser | PENDING | — | Not attempted; rank 22 is current. |
| 75 | browserslist | PENDING | — | Not attempted; rank 22 is current. |
| 76 | @babel/helper-string-parser | PENDING | — | Not attempted; rank 22 is current. |
| 77 | camelcase | PENDING | — | Not attempted; rank 22 is current. |
| 78 | yallist | PENDING | — | Not attempted; rank 22 is current. |
| 79 | @babel/template | PENDING | — | Not attempted; rank 22 is current. |
| 80 | cookie | PENDING | — | Not attempted; rank 22 is current. |
| 81 | agent-base | PENDING | — | Not attempted; rank 22 is current. |
| 82 | safe-buffer | PENDING | — | Not attempted; rank 22 is current. |
| 83 | qs | PENDING | — | Not attempted; rank 22 is current. |
| 84 | fill-range | PENDING | — | Not attempted; rank 22 is current. |
| 85 | path-to-regexp | PENDING | — | Not attempted; rank 22 is current. |
| 86 | lodash | PENDING | — | Not attempted; rank 22 is current. |
| 87 | universalify | PENDING | — | Not attempted; rank 22 is current. |
| 88 | form-data | PENDING | — | Not attempted; rank 22 is current. |
| 89 | jiti | PENDING | — | Not attempted; rank 22 is current. |
| 90 | @radix-ui/react-primitive | PENDING | — | Not attempted; rank 22 is current. |
| 91 | onetime | PENDING | — | Not attempted; rank 22 is current. |
| 92 | node-releases | PENDING | — | Not attempted; rank 22 is current. |
| 93 | ajv | PENDING | — | Not attempted; rank 22 is current. |
| 94 | is-glob | PENDING | — | Not attempted; rank 22 is current. |
| 95 | escalade | PENDING | — | Not attempted; rank 22 is current. |
| 96 | update-browserslist-db | PENDING | — | Not attempted; rank 22 is current. |
| 97 | yocto-queue | PENDING | — | Not attempted; rank 22 is current. |
| 98 | to-regex-range | PENDING | — | Not attempted; rank 22 is current. |
| 99 | fast-json-stable-stringify | PENDING | — | Not attempted; rank 22 is current. |
| 100 | get-intrinsic | PENDING | — | Not attempted; rank 22 is current. |

The pending-row cursor now points to rank 22; no later package has been
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

## Rank 15 failure record

The published `glob@13.0.6` candidate was tested with CITGM 10.0.2. Complete
artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-015-glob/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789219852599`, `citgm-1789219909357` | Initial Chromium and Firefox runs failed during the upstream TAP suite. | Ours. The initial failures exposed missing empty-directory state in worker snapshots, root-mounted `/tmp` compatibility, and incorrect recursive symlink handling. |
| `citgm-1789220312833` through `citgm-1789221774708` | Several diagnostic reruns reported `scripts/build.sh: No such file or directory` while the candidate build was being exercised. | Ours, exposed by the package's generated build layout. The VFS mount was corrected to preserve directory entries and root-relative paths; all diagnostic logs remain preserved. |
| `citgm-1789222983286`, `citgm-1789223833121`, `citgm-1789226482018`, `citgm-1789227767490`, `citgm-1789228232177` | The failure count reduced from 15 to 4 as directory/symlink and async callback behavior were fixed; remaining cases were memfs, mocked async `realpath`, and synchronous abort handling. | Ours. These were general VFS ordering, snapshot, and loader compatibility defects, not glob-specific conditionals. |
| `citgm-1789228529931`, `citgm-1789229101503`, `citgm-1789229929305` | Loader diagnostics isolated the final issue to transitive `@tapjs/mock` builtin resolution; one experimental fallback run also recorded a `tapmock:` load-chain failure. | Ours, exposed by the nested `path-scurry`/`@tapjs/mock` graph. The final loader fix makes explicit active tapmock mappings win over builtin fallback resolution and loads generated tapmock modules directly at the VFS seam. The failed experimental run is retained as evidence and is not a package result. |
| `citgm-1789230527444` / `citgm-1789230819617` | Published `glob@13.0.6` completed CITGM with 1106 passing assertions and 1 skip in both Chromium and Firefox. | PASS. No nested dependency or upstream package/repository blocker remained. |

## Rank 15 gate evidence

The repository-wide gates passed after both final CITGM browser passes and
before the rank-15 commit was created:

```text
npm run build -- --node-version=v22                        PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                   PASS — 336/336
npm run test:browser:chromium                             PASS — 266/266
npm run test:browser:firefox                              PASS — 266/266
```

## Rank 16 failure record

The published `minipass@7.1.3` candidate, gitHead
`ab4b3b05d0d557ac6bb178f38501b11d0c96454e`, was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-016-minipass/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789233209790` | The ESM top-level-await graph scanner received resolver records as objects and called `startsWith` on them. | Ours. Normalized resolver records and added a regression oracle. |
| `citgm-1789233328813`, `citgm-1789233509536` | `tshy` reached `@typescript/native-preview@7.0.0-dev.20260218.1`, whose published package requires the OS-native optional package and has no browser/WASM artifact. | Upstream/package-layout blocker. No fake native shim was added; browser resolution uses version-matched `tsgo-wasm@2026.2.18`, an unofficial distribution explicitly documented in the resolver. |
| `citgm-1789234772393` through `citgm-1789239519220`; `citgm-1789243606678` through `citgm-1789245655961` | Development attempts exposed synchronous ESM worker/broker/VFS/output lifecycle issues and several stalled nested `tshy` runs. | Ours. Fixed in the shared runtime; all diagnostic logs remain preserved. |
| `citgm-1789247629323`, `citgm-1789249089430` | The full upstream suite reduced to one failure at `test/pipe-stdio-end-false.ts`, reported as `ERR_WORKER_EXCEPTION` (359/360). | Ours. Fixed the EventEmitter internal `newListener` dispatch path and guest process binding. |
| `citgm-1789249345671` | A diagnostic run identified `Cannot assign to read only property 'process'` when tap intercepted the global process object. | Ours. Timer/context process rebinding now uses safe `Reflect.set`, preserving explicit non-writable guest replacements. |
| `citgm-1789249669450` | An intermediate helper placement caused `setScopeProcess is not defined`. | Ours. Moved the timer-local setter into `createProcess`. |
| `citgm-1789249717236`, `citgm-1789249917952` | Full published minipass CITGM passed; the upstream TAP child reports 365/365 in Chromium and Firefox. | PASS. No remaining nested dependency or upstream package/repository blocker remained. |

## Rank 16 gate evidence

The repository-wide gates passed after both final CITGM browser passes and
before advancing the rank cursor:

```text
npm run build -- --node-version=v22                        PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                   PASS — 338/338
npm run test:browser:chromium                             PASS — 270/270
npm run test:browser:firefox                              PASS — 270/270
```

## Rank 17 failure record

The published `type-fest@5.9.0` candidate at gitHead
`3919b6481ab4c7a1316a6fed9da20b58e470e6a4` was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-017-type-fest/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789251636236` | `npm-run-all2` reached `process.stdout.setMaxListeners`, which the browser stdio endpoint did not implement. | Ours, exposed by the nested `npm-run-all2` dependency. Added Node-compatible max-listener controls to process stdout/stderr and a regression oracle. |
| `citgm-1789252330979` | The package scripts were reported missing because asynchronous nested npm children inherited `/node` instead of the package cwd. | Ours, exposed by nested package-manager execution. Bound asynchronous child-process calls to their owning virtual process and added a nested-cwd oracle. |
| `citgm-1789252789532` | `test:tsc` could not find `@tsd/typescript/bin/tsc` after a nested package manifest replaced the installed package's manifest/bin contract. | Ours, exposed by the nested `@tsd/typescript` package layout. Manifest extraction now uses the package-root manifest only; a nested-manifest regression oracle covers the fix. |
| `citgm-1789253422837`, `citgm-1789254228579` | Bare `node --test` received synthetic stdin instead of performing discovery; `pidtree` could not obtain `ps -A -o ppid,pid`; and node:test snapshot hooks were missing. | Ours, exposed by nested `npm-run-all2`/`pidtree` and the package linter. Added proper bare test discovery, a virtual POSIX process table, snapshot builtin hooks, and regression oracles. |
| `citgm-1789254949223` | The node:test linter's snapshot fixtures compared literal backticks against escaped backticks. | Ours. Snapshot serialization now preserves literal serialized values; a fixture-backed backtick oracle covers the behavior. |
| `citgm-1789255528374` | The browser target crashed during the unusually heavy concurrent TypeScript/lint workload (23,409 VFS files, about 207 MB). | Transient browser-run failure during development; the next exact run completed normally after the preceding runtime fixes. The preserved artifact is retained and is not the final package classification. |
| `citgm-1789255912771` | `tsc`, `tsd`, node:test linter, and all 31 snapshot tests passed, but `test:xo` exited 1 on four checked-in `test-d` fixtures: three `@typescript-eslint/no-meaningless-void-operator` errors and one `new-cap` error. A native run of the exact githead also exits 1 with the same unpinned tooling family. | Upstream package/repository blocker. `type-fest` declares floating `typescript-eslint:^8.47.0` and `eslint:^10.1.0`; the fresh install resolves newer lint rules that reject the repository's own fixtures. No package source, fake dependency, or browser-only success path was added. |

## Rank 17 gate evidence

The required repository-wide gates passed after the final Chromium CITGM
attempt and before the rank cursor advanced:

```text
npm run build -- --node-version=v22                        PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                   PASS — 338/338
npm run test:browser:chromium                             PASS — 277/277
npm run test:browser:firefox                              PASS — 277/277
```

## Rank 18 CITGM evidence

The published `color-name@2.1.0` candidate at gitHead
`ac6cd6f0e4105534fd8da9ce6707dfecd7dd7d93` passed exact CITGM 10.0.2 in
both browsers. Complete artifacts are preserved under
`artifacts/citgm-top-100/rank-018-color-name/`.

| Run / log | Observed result | Classification |
| --- | --- | --- |
| `citgm-1789257669941` / `citgm-1789257694610` | Chromium and Firefox both completed install and the upstream test suite with exit code 0 for `color-name@2.1.0`. | PASS; no runtime, nested-dependency, or upstream package/repository failure observed. |

## Rank 18 gate evidence

The repository-wide gates passed after both final CITGM browser passes and
before advancing the rank cursor:

```text
npm run build -- --node-version=v22                        PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                   PASS — 338/338
npm run test:browser:chromium                             PASS — 277/277
npm run test:browser:firefox                              PASS — 277/277
```

## Rank 19 CITGM evidence

The published `strip-ansi@7.2.0` candidate at gitHead
`38ff9f2282540422031ed523f0060c7bb575e20f` passed exact CITGM 10.0.2 in both
browsers. Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-019-strip-ansi/`.

| Run / log | Observed result | Classification |
| --- | --- | --- |
| `citgm-1789258810545` | The first Chromium attempt stopped after the package install while the large XO ESM worker was loading and produced no terminal result. | Transient runner interruption; the artifact is preserved and is not a package failure. |
| `citgm-1789258900253` / `citgm-1789259060762` | Chromium and Firefox completed install and the upstream `xo && ava && tsd` script with exit code 0; AVA reported 8 passing tests. | PASS; no runtime, nested-dependency, or upstream package/repository failure observed. |

## Rank 19 gate evidence

The repository-wide gates passed after both final CITGM browser passes and
before advancing the rank cursor. `npm test` was run before the continuation
gate rule was updated and is recorded for completeness:

```text
npm run build -- --node-version=v22                        PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                   PASS — 338/338
npm run test:browser:chromium                             PASS — 277/277
npm run test:browser:firefox                              PASS — 277/277
```

## Rank 20 CITGM evidence

The published `balanced-match@4.0.4` candidate passed exact CITGM 10.0.2 in
both browsers. Complete artifacts are preserved under
`artifacts/citgm-top-100/rank-020-balanced-match/`.

| Run / log | Observed result | Classification |
| --- | --- | --- |
| `citgm-1789260264391` / `citgm-1789260316808` | Chromium and Firefox completed installation, the upstream `tshy` build, and the TAP suite with exit code 0. | PASS; no runtime, nested-dependency, or upstream package/repository failure observed. |

## Rank 20 gate evidence

No repository-wide gates were run after the two exact CITGM browser passes,
per the continuation gate rule: no runtime or test changes were made.

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
its native test suite (29 TAP subtests, 19,343 assertions), so the remaining
failure is browser-runtime behavior rather than an upstream lru-cache test
failure. The native esbuild problem is handled with the official WASM
distribution; no fake binary or package shim was added.
Complete CITGM artifacts are preserved under
`artifacts/citgm-top-100/rank-012-lru-cache/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789073282313` / `citgm-initial/` | `tshy`'s TypeScript compiler returned `TS2344` for `Channel<unknown>` and `TracingChannel<unknown>`. | Ours, exposed by npm dependency resolution: the browser installer ignored the committed lockfile and selected newer `tshy`, TypeScript, and `@types/node` versions. Added general lockfile-aware package placement and a regression oracle. |
| `citgm-1789073491479` / `citgm-debug-spawn/` | The synchronous compiler spawn returned status 2 with the same TypeScript diagnostics. | Ours; the probe confirmed this was a real compiler failure, not lost child output. The temporary probe was removed. |
| `citgm-1789073754174` / `citgm-debug-install/` | Dependency probe recorded browser selections `tshy@4.1.3`, `typescript@6.0.3`, and `@types/node@26.5.1`, versus the native lockfile's `tshy@4.1.2`, `typescript@6.0.2`, and `@types/node@25.8.0`. | Ours. Lockfile resolution corrected the graph without pinning lru-cache or adding a shim. |
| `citgm-1789073980749` / `citgm-fix-1/` | `tshy` reached output generation but failed with `EEXIST` when renaming an existing generated file. | Ours. Implemented Node-compatible replacement semantics for VFS file/symlink renames and added a regression oracle. |
| `citgm-1789074100969` / `citgm-fix-2/` | The upstream build script invokes `esbuild`, which initially required the omitted native optional package `@esbuild/linux-x64`; the browser cannot execute that Linux binary. | Nested dependency compatibility issue, resolved in the harness by selecting the official `esbuild-wasm` distribution under the requested `esbuild` package contract. No fake binary or package shim was added. |
| `citgm-1789091670364` / `citgm-final-wasm-timeout/` | All six `esbuild-wasm` build commands exit 0. The subsequent upstream `npm test` remains active until CITGM's 15-minute timeout; CITGM reports `npm-test Timed Out` and two live `node` test children under tap. | Ours: the native suite passes quickly, so this is unresolved browser runtime test-process/performance behavior, not an upstream package failure. |
| `citgm-1789092331758` / `citgm-child-args-timeout/` | A bounded 120-second rerun reproduces the same state: all six WASM builds pass, tap retains two live `node` children (`args:18` and `args:3`), and the run is killed at the diagnostic timeout. | Ours, confirmed as reproducible. The temporary child-argument tracing was removed after preserving the artifact. |
| `citgm-1789199995095` / `citgm-final-adaptive-firefox-2/` | The full published suite reached one timer assertion with `actual: 1` at about 2079 ms where upstream expected `0`; the remaining 19,370 assertions passed. | Ours/browser scheduling behavior. The timer due-time margin and adaptive async-resource destroy drain were tightened; the run is preserved as the last timing flake before the final hook-window fix. |
| `citgm-1789200373194` / `citgm-final-hook-window-firefox-1/` | Full published suite passed after explicit async-hooks activity was given the shorter resource-destroy drain window. | Ours; fixed in the shared async-resource lifecycle. |
| `citgm-1789211133240` / `citgm-final-exact-firefox-1/` | All 29 upstream TAP subtests and 19,628 assertions passed, but a late browser rejection surfaced after CITGM had requested `process.exit(0)`, changing the bridge result to exit code 1. | Ours; fixed generally by ignoring late unhandled-rejection delivery after an explicit successful process exit has been requested. |
| `citgm-1789211689248` / `citgm-final-exact-firefox-2/` | Exact published `lru-cache@11.5.2` CITGM passed; six `esbuild-wasm` builds and the full upstream test child exited 0. | PASS. |
| `citgm-1789211984176` / `citgm-final-exact-chromium-1/` | Exact published `lru-cache@11.5.2` CITGM passed; six `esbuild-wasm` builds and the full upstream test child exited 0. | PASS. |

## Rank 12 gate evidence

The final repository gates passed after the exact package runs and the late
post-exit rejection fix:

```text
npm run build -- --node-version=v22                        PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                   PASS — 333/333
npm run test:browser:chromium                             PASS — 266/266
npm run test:browser:firefox                              PASS — 266/266
```

The focused runtime oracles cover the high-volume timer workload, cluster
worker termination, async dynamic imports, Promise pressure, and the six
successful `esbuild-wasm` build invocations in the real CITGM run. Historical
failures remain preserved above and are classified as harness-owned runtime
compatibility issues; no fake native package shim was added.

## Rank 13 failure record

Both browser CITGM runs used the published `tslib@2.8.1` candidate and
successfully completed npm installation. CITGM 10.0.2 then loaded its generic
package-manager test phase and rejected the candidate before launching any
tslib test command because its package metadata has no `scripts.test` entry.
The complete artifacts are preserved under
`artifacts/citgm-top-100/rank-013-tslib/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789213425873` / `citgm-chromium-1/` | Install completed, then CITGM reported `Module does not support npm-test!` for `tslib@2.8.1`; no package test command was launched. | Upstream package/repository and CITGM contract blocker. The package tarball has no `scripts.test`; adding a fake test entry would misrepresent upstream coverage, so no harness change is appropriate. |
| `citgm-1789213473799` / `citgm-firefox-1/` | Firefox reproduced the identical pre-test rejection after successful installation. | Same upstream package/repository and CITGM contract blocker; not a browser runtime or nested dependency failure. |

## Rank 13 gate evidence

The package-level CITGM result cannot become green without upstream adding a
supported test command or CITGM adding an explicit package-specific test
definition. Repository gates for this blocker record remain green:

```text
npm test                                                   PASS — 333/333
npm run test:browser:chromium                             PASS — 266/266
npm run test:browser:firefox                              PASS — 266/266
```

## Rank 14 failure record

The published `picomatch@4.0.7` candidate materialized its upstream git head
`6bb40679c218cefba5d4e9662408c5fdf699a8bb`. Its npm install, ESLint, and
Mocha test commands all passed, but the initial browser runs ended with a
private virtual-process exit sentinel being reported as an unhandled
rejection. Complete artifacts are preserved under
`artifacts/citgm-top-100/rank-014-picomatch/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789215085737` / `citgm-chromium-1/` | All package child commands passed (including 1,983 Mocha tests), but CITGM exited 1 after the parent received `{[Symbol.for('bnh.process-exit')]: true}` as an unhandled rejection; the old diagnostic rendered it as `[object Object]`. | Ours. A nested virtual process uses this private value only to unwind explicit `process.exit()` through its worker boundary. Suppressed that sentinel in the shared parent rejection observer and improved non-Error rejection formatting. |
| `citgm-1789215252725` / `citgm-firefox-1/` | Firefox reproduced the same private-sentinel failure after all child commands passed. | Ours; same shared fix. |
| `citgm-1789215545080` / `citgm-final-chromium-1/` | Exact published `picomatch@4.0.7` CITGM passed; ESLint and 1,983 Mocha tests exited 0. | PASS. |
| `citgm-1789215632195` / `citgm-final-firefox-1/` | Exact published `picomatch@4.0.7` CITGM passed; ESLint and 1,983 Mocha tests exited 0. | PASS. |

## Rank 14 gate evidence

The final post-fix gates passed after rebuilding:

```text
npm run build -- --node-version=v22                        PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                   PASS — 333/333
npm run test:browser:chromium                             PASS — 266/266
npm run test:browser:firefox                              PASS — 266/266
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

## Rank 21 failure record

The published `p-limit@7.3.2` candidate was tested with CITGM 10.0.2. Complete
artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-021-p-limit/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789260693397` | After 23 AVA tests passed, `testClearQueueRejects` surfaced an `AbortError` rejection that never reached the process-level `rejectionHandled` lifecycle. The parent then emitted a secondary AVA `normalizeError`/`depth` failure while reporting the unhandled rejection. | Ours. The browser runtime now bridges browser `unhandledrejection` and `rejectionhandled` events to the virtual process, tracks the guest and native Promise identities, and suppresses private process-exit sentinels. |
| `citgm-1789261563616`, `citgm-1789263171133`, `citgm-1789265424650`, `citgm-1789265855153` | Firefox reruns moved past the rejection case but repeatedly stalled or lost AsyncLocalStorage context at the p-limit queue's ESM `await Promise.resolve()` boundary. | Ours. Firefox guest Promise resolution now preserves observable Promise hooks, including when an active global Promise constructor crosses the ESM realm boundary. The regression oracle models the published queue boundary. |
| `/tmp/nacelle-p-limit-native-1470189` | The exact native p-limit checkout passed its upstream test suite, including the rejection and async-context cases. | Confirms the failures were browser-runtime compatibility defects, not a nested dependency or upstream package/repository problem. |
| `citgm-1789266269148` / `citgm-1789266420987` | Published p-limit install and all upstream child phases completed with exit code 0 in Chromium and Firefox. | PASS. |

## Rank 21 gate evidence

The final CITGM pair and repository-wide gates were run after the last runtime
and oracle changes and before the rank-21 commit:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-021-p-limit npm run citgm:browser:chromium -- p-limit  PASS — citgm-1789266269148
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-021-p-limit npm run citgm:browser:firefox -- p-limit   PASS — citgm-1789266420987
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 338/338
npm run test:browser:chromium                               PASS — 280/280
npm run test:browser:firefox                                 PASS — 280/280
```

The focused `async-primitives` oracle passed 10/10 in both browsers, including
the ESM queue-boundary case that reproduced p-limit's AsyncLocalStorage path.
