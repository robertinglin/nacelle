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
| 22 | glob-parent | PASS | ours | Published `glob-parent@6.0.2` at gitHead `26ce5ecec10c687cffb9891c108fb2d2800b9140` passes exact CITGM in Chromium (`citgm-1789269089178`) and Firefox (`citgm-1789269512625`). The runtime now preserves the `ChildProcess` constructor/prototype in process-bound `child_process` modules, forwards `process.binding()` to virtual children, and supplies Firefox with V8-compatible structured Error CallSites. Required final gates passed after the runtime/test changes: build; `npm test` 339/339; Chromium Playwright 280/280; Firefox Playwright 280/280. |
| 23 | p-locate | PASS | ours | Published `p-locate@7.0.0` at gitHead `b9ccdaaa83f8d2f53f8acf8ff3c97b7aa21f655b` passes exact CITGM in Chromium (`citgm-1789272646645`) and Firefox (`citgm-1789272546386`). The initial Firefox failure was an unhandled-rejection compatibility defect in the Firefox Promise/Promise.all adoption path; it was fixed generally and covered by two browser regression oracles, including the published ESM queue path. Complete CITGM artifacts and the transient initial Firefox gate log are preserved under `artifacts/citgm-top-100/rank-023-p-locate/`. Required final gates passed: build; `npm test`; Chromium Playwright 282/282; Firefox Playwright 282/282. |
| 24 | has-flag | BLOCKED | upstream package/repository (obsolete test toolchain) | Published `has-flag@5.0.1` at gitHead `0c7d032214c51d14b458364c9f6575ea9afa08b1` cannot complete its own test contract. Exact Chromium CITGM `citgm-1789288391205` passes install, XO, and AVA (1 test), then `tsd` fails with 2,789 stale `@types/node`/`undici-types` errors; exact Firefox CITGM `citgm-1789288596679` reaches the same `tsd` failure and also records `this.isNative is not a function` while formatting that dependency's diagnostics. A native exact checkout fails earlier in XO because `eslint-plugin-ava` calls removed Node 22 API `util.isDate`. This is an upstream/package-layout/toolchain problem, not a Nacelle compatibility failure; no fake shim or package-specific workaround was added. Complete CITGM and native failure logs are preserved under `artifacts/citgm-top-100/rank-024-has-flag/`. |
| 25 | iconv-lite | PASS | ours | Published `iconv-lite@0.7.3` at gitHead `43694e28291d3b0cb3a452c77be40c4fd3a4bd85` passes exact CITGM in Chromium (`citgm-1789289704489`) and Firefox (`citgm-1789289771188`). The runtime fixes support legacy callable `Transform` construction, preserve UTF-8 surrogate halves across matching decoder string chunks, and preserve leading BOMs in `string_decoder` so iconv-lite can apply `stripBOM`. Complete failed and final CITGM artifacts are preserved under `artifacts/citgm-top-100/rank-025-iconv-lite/`. Required final gates passed: build; `npm test` 339/339; Chromium Playwright 285/285; Firefox Playwright 285/285. |
| 26 | entities | PASS | ours | Published `entities@8.1.0` passes exact CITGM in Chromium (`citgm-1789296541914`) and Firefox (`citgm-1789296597439`); runtime, official Biome/Rolldown WASM compatibility, focused oracles, and all repository gates passed. |
| 27 | uuid | PASS | ours | Published `uuid@14.0.2` passes exact CITGM in Chromium (`citgm-1789298820089`) and Firefox (`citgm-1789298894940`); POSIX shell build-script compatibility, focused oracle, and all repository gates passed. |
| 28 | json-schema-traverse | PASS | none observed | Published `json-schema-traverse@1.0.0` at gitHead `6b45983cd76270042cc79527da5c8972f13599ec` passes exact CITGM unchanged in Chromium (`citgm-1789300059787`) and Firefox (`citgm-1789300122014`); install, ESLint, Mocha, and NYC phases all exited 0. No runtime, nested-dependency, or upstream package/repository failure was observed. Repository-wide gates were skipped under the unchanged double-CITGM rule. |
| 29 | string-width | PASS | none observed | Published `string-width@8.2.2` at gitHead `64dc20cddd374df0ff43ba3469491ae98cf0cdfc` passes exact CITGM unchanged in Chromium (`citgm-1789300238587`) and Firefox (`citgm-1789300334846`); install, XO, AVA, and tsd phases all exited 0. No runtime, nested-dependency, or upstream package/repository failure was observed. Repository-wide gates were skipped under the unchanged double-CITGM rule. |
| 30 | escape-string-regexp | BLOCKED | upstream package/repository (obsolete tsd toolchain) | Published `escape-string-regexp@5.0.0` at gitHead `ba9a4473850cb367936417e97f1f2191b7cc67dd` passes install, XO, and AVA (3 tests) but its pinned `tsd@^0.14.0` fails with 2,791 current declaration errors from `@types/node`, `undici-types`, `@types/readable-stream`, and tsd's bundled TypeScript. Chromium CITGM `citgm-1789300473401` and Firefox CITGM `citgm-1789300587441` both fail at tsd; Firefox also reports `this.isNative is not a function` while formatting the dependency diagnostics. This is an upstream/package-layout/toolchain problem, not a Nacelle compatibility failure; no fake shim or package-specific workaround was added. Complete artifacts are preserved under `artifacts/citgm-top-100/rank-030-escape-string-regexp/`. |
| 31 | globals | BLOCKED | nested dependency interaction (native Node also fails) | Exact browser CITGM passes in Firefox after the independent util.inspect fix, but Chromium installs ESLint 9.39.5 at the root and ESLint 8.57.1 under XO; ESLint 9 meta.defaultOptions is then invoked through ESLint 8 Linter and fails. The same root-9/nested-8 layout fails native Node with the same XO error; proof is preserved in native-node/duplicate-eslint-layout.log. Initial browser runtime failures were ours and are fixed in the working runtime; this remaining cross-major dependency interaction is not browser-only. |
| 32 | is-fullwidth-code-point | PASS | none observed | Published `is-fullwidth-code-point@5.1.0` at gitHead `2696d873463fde9f6b09b49c98380bd49c67b00a` passes exact CITGM unchanged in Chromium (`citgm-1789307869379`) and Firefox (`citgm-1789307953202`); install, XO, AVA, and tsd phases all exited 0. No runtime, nested-dependency, or upstream package/repository failure was observed. Repository-wide gates were skipped under the unchanged double-CITGM rule. |
| 33 | argparse | PASS | ours | Published `argparse@3.0.2` at gitHead `b24ea1892b4b7e7a268cd4554cdd654ec47c148f` passes exact CITGM in Chromium (`citgm-1789315178421`) and Firefox (`citgm-1789315226994`). The VFS now rejects writes to chmod 0400 files, and the loader accepts Firefox's Node-equivalent class-call TypeError wording; native Node passes the targeted `TestTypeClassicClass` suite. Required final gates passed after rebuilding: `npm test` and full Chromium/Firefox Playwright; complete artifacts and native comparison logs are preserved under `artifacts/citgm-top-100/rank-033-argparse/`. |
| 34 | ignore | PASS | ours | Published `ignore@7.0.9` at gitHead `821765efdf7752b186a03ed0450d9ee013cee099` passes exact CITGM in Chromium (`citgm-1789317691280`) and Firefox (`citgm-1789317740056`); both the `7.0.6` and `7.0.9` compatibility worktrees pass, including `--win32`. Native Node v26 also passes the exact package (1368 assertions plus both compatibility modes), proving the initial browser failure was ours: the browser materialized a GitHub source archive without Git history, and the runtime lacked the Git/worktree surface and synchronous shebang launcher behavior required by the package. Required final gates passed: build; `npm test` 340/340; Chromium Playwright 289/289; Firefox Playwright 289/289. Complete attempts and native proof are preserved under `artifacts/citgm-top-100/rank-034-ignore/`. |
| 35 | which | PASS | none observed | Published `which@7.0.0` at gitHead `297db11d58eebe01551ae0875a127a89ee63d2cb` passes exact CITGM in Chromium (`citgm-1789318901100`) and Firefox (`citgm-1789318952953`); installation, ESLint, and TAP all exited 0. Firefox records template-oss repository-drift diagnostics, but the package test contract is green. No runtime, nested-dependency, or upstream package/repository failure was observed. Repository-wide gates were skipped under the unchanged double-CITGM rule. Complete artifacts are preserved under `artifacts/citgm-top-100/rank-035-which/`. |
| 36 | esbuild | BLOCKED | upstream package/repository (monorepo package layout) | Published `esbuild@0.28.2` at gitHead `609683d892977362a0f99026cb74b96263d728a9` fails exact Chromium CITGM (`citgm-1789319117820`) and Firefox CITGM (`citgm-1789319307780`) because the downloaded monorepo root has no `package.json`; native Node CITGM 10.0.2 reproduces the same `/tmp/.../esbuild/package.json` ENOENT. The published npm package is under `npm/esbuild`, so this is proven upstream/CITGM project-layout failure, not a browser-runtime failure. No fake package root or shim was added. |
| 37 | isexe | PASS | ours | Published `isexe@4.0.0` passes exact CITGM in Chromium (`citgm-1789321276490`) and Firefox (`citgm-1789321334839`). The runtime fixed wildcard `1.x.x` semver resolution, portable decoding of cross-realm/SharedArrayBuffer-backed loader source, and awaiting asynchronous `@tapjs/mock` module source. Matching native Node 22 CITGM passes the exact package, so the browser failures were ours; no upstream or nested-dependency classification applies. Required final gates passed: build; `npm test` 343/343; Chromium Playwright 289/289; Firefox Playwright 289/289. |
| 38 | js-yaml | PASS | ours | Published `js-yaml@5.4.2` at gitHead `494400bd45cad078123cfc057e674a9a0a8d9983` passes exact CITGM in Chromium (`citgm-1789326034170`) and Firefox (`citgm-1789326085784`). Every failure was reproduced against the exact package under native Node and was a browser-runtime defect: official `@rollup/wasm-node` selection, Node-style WASI worker `self` assignment, virtual Git fixture support, quoted `node --test` glob expansion, synchronous and asynchronous TypeScript stripping, and package self-reference export resolution. Required final gates passed after the fixes: `npm test` 345/345; Chromium Playwright 290/290; Firefox Playwright 290/290. Complete failure and success artifacts are preserved under `artifacts/citgm-top-100/rank-038-js-yaml/`. |
| 39 | resolve | BLOCKED | upstream package/repository (native-reproduced posttest) | Exact browser and native CITGM reach the passing package tests, then the published posttest invokes unavailable `npm@>= 10.2`; see the rank 39 record below. |
| 40 | mime-types | PASS | none observed | Exact native, Chromium, and Firefox CITGM pass unchanged; repository-wide gates were skipped under the double-CITGM rule. |
| 41 | nanoid | PASS | ours | Exact native Node CITGM passed before browser diagnosis; final Chromium `citgm-1789352834860` and Firefox `citgm-1789352865027` pass after shared runtime fixes and browser regressions. Required post-change gates pass at 345/345, 307/307, and 307/307. |
| 42 | yargs-parser | PASS | none observed | Exact native, Chromium, and Firefox CITGM pass unchanged; repository-wide gates were skipped under the double-CITGM rule. |
| 43 | source-map | BLOCKED | upstream package/repository (native-reproduced archive/submodule failure) | Exact native Node, Chromium, and Firefox CITGM all fail because the source archive lacks the `source-map-tests` submodule data required by the package test script; see the rank 43 record below. |
| 44 | string_decoder | BLOCKED | upstream package/repository (native-reproduced stale global validation), with ours-side Firefox intrinsic fix | Exact native Node, Chromium, and Firefox CITGM reach the same stale `test/common/index.js` global-leak assertion after the Firefox typed-array intrinsic defect was fixed; see the rank 44 record below. |
| 45 | color-convert | PASS | none observed | Published `color-convert@3.1.3` at gitHead `5c106a633b5cd2de554d9c287ad31f9eeca7a271` passes exact CITGM unchanged in native Node v26, Chromium (`citgm-1789360293028`), and Firefox (`citgm-1789360434124`). No runtime, nested dependency, or upstream package/repository failure was observed. Repository-wide gates were skipped under the unchanged double-CITGM rule. Complete artifacts are preserved under `artifacts/citgm-top-100/rank-045-color-convert/`. |
| 46 | estraverse | PASS | ours | Published `estraverse@5.3.0` at gitHead `ec3f900528eac270a51f7b079edeae086e7ebce4` passes exact CITGM in Chromium (`citgm-1789361477311`) and Firefox (`citgm-1789361533463`) after general runtime fixes for the legacy `process.binding('natives')` registry and prototype-based Node CallSites. Native Node passed before browser diagnosis. Required final gates passed: build; `npm test` 345/345; Chromium Playwright 310/310; Firefox Playwright 310/310. Complete artifacts are preserved under `artifacts/citgm-top-100/rank-046-estraverse/`. |
| 47 | https-proxy-agent | BLOCKED | upstream package/repository (native-reproduced invalid published devDependency) | Published `https-proxy-agent@9.1.0` fails exact native Node, Chromium, and Firefox CITGM during install because its published manifest declares nonexistent `tsconfig@0.0.0`; see the rank 47 record below. |
| 48 | @babel/helper-validator-identifier | BLOCKED | upstream package/repository (native-reproduced no test script) | Published `@babel/helper-validator-identifier@8.0.4` installs under native Node, Chromium, and Firefox, but its published manifest has no `scripts.test`; exact CITGM therefore fails with `Module does not support npm-test!`. See the rank 48 record below. |
| 49 | json5 | BLOCKED | nested dependency issue (native-reproduced legacy tap/esm test stack) | Exact native Node CITGM installs `json5@2.2.3`, then all five tests fail before assertions with the nested `tap@12.6.0`/`esm` stack (`The canary is dead`). Browser CITGM reached the same upstream test phase after the ours-side Rollup resolver fix; see the rank 49 record below. |
| 50 | react-is | BLOCKED | upstream package/repository (native-reproduced install contract; browser test-layout failure also observed) | Exact native Node CITGM fails during fresh install with `ERESOLVE`: React's root `eslint@^7.7.0` resolves to `eslint@7.32.0`, while `eslint-plugin-ft-flow@2.0.3` requires peer `eslint@^8.1.0`. Chromium independently installs and reaches the React Jest test command, which fails with `Cannot find module 'jest-circus/runner'`; the browser did fetch `jest-circus@30.5.1`, and the equivalent CommonJS `exports:./runner` loader oracle passes, so no adapter change or fake shim is justified. |
| 51 | readdirp | BLOCKED | upstream package/repository (native-reproduced source archive/build-layout failure) | Exact native Node CITGM, Chromium, and Firefox all install successfully then fail the package test because `test/index.test.js` imports `../index.js`, but the exact gitHead archive contains only `index.ts` and no built `index.js`; see the rank 51 record below. |
| 52 | commander | PASS | ours | Exact native Node CITGM passes after clearing ambient `NO_COLOR`; Chromium (`citgm-1789375263249`) and Firefox (`citgm-1789375328593`) pass after shared child signal, lifecycle, and nested ESM executable fixes. Repository gates pass: build; `npm test` 346/346; complete Chromium and Firefox Playwright coverage 310/310 each. The initial ambient-color failure and all browser failures are preserved under `artifacts/citgm-top-100/rank-052-commander/`. |
| 53 | js-tokens | PASS | ours | Exact native Node CITGM and final Chromium/Firefox CITGM pass after shared browser-runtime fixes; complete gate evidence and failure logs are recorded below. |
| 54 | shebang-regex | PENDING | — | Not attempted; rank 53 is complete and rank 54 is current. |
| 55 | fs-extra | PENDING | — | Not attempted; rank 53 is complete and rank 54 is current. |
| 56 | readable-stream | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 57 | punycode | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 58 | tr46 | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 59 | find-up | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 60 | webidl-conversions | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 61 | path-exists | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 62 | graceful-fs | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 63 | eslint-scope | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 64 | yargs | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 65 | cross-spawn | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 66 | statuses | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 67 | whatwg-url | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 68 | fast-deep-equal | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 69 | locate-path | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 70 | is-number | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 71 | get-stream | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 72 | yaml | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 73 | path-scurry | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 74 | @babel/parser | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 75 | browserslist | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 76 | @babel/helper-string-parser | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 77 | camelcase | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 78 | yallist | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 79 | @babel/template | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 80 | cookie | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 81 | agent-base | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 82 | safe-buffer | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 83 | qs | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 84 | fill-range | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 85 | path-to-regexp | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 86 | lodash | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 87 | universalify | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 88 | form-data | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 89 | jiti | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 90 | @radix-ui/react-primitive | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 91 | onetime | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 92 | node-releases | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 93 | ajv | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 94 | is-glob | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 95 | escalade | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 96 | update-browserslist-db | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 97 | yocto-queue | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 98 | to-regex-range | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 99 | fast-json-stable-stringify | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |
| 100 | get-intrinsic | PENDING | — | Not attempted; rank 51 is complete and rank 52 is current. |

The pending-row cursor now points to rank 50. Ranks 43–44, 47–49 are recorded
as blocked only after native proof; ranks 45–46 are complete, and every row
marked `PENDING` from rank 50 onward has not been started.

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

## Rank 22 failure record

The published `glob-parent@6.0.2` candidate was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-022-glob-parent/`. The exact native checkout at
gitHead `26ce5ecec10c687cffb9891c108fb2d2800b9140` passed its own install and
20-test suite, confirming the original failure was in the browser runtime.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789267138828` | The upstream `nyc` phase failed because a nested virtual child process exposed no `process.binding()` function. | Ours. Virtual child processes now inherit the owning browser-backed binding contract. |
| `citgm-1789267406912`, `citgm-1789267566071`, `citgm-1789267736026`, `citgm-1789267827751`, `citgm-1789268273747`, `citgm-1789268553941`, `citgm-1789268666280`, `citgm-1789268743511`, `citgm-1789268825299` | Preserved diagnostic reruns narrowed the issue from missing binding to `process-on-spawn` reading `ChildProcess.prototype` from a process-bound `child_process` module whose constructor export had been replaced by a non-constructible arrow wrapper. | Ours, exposed by nested `process-on-spawn`/coverage tooling. The `ChildProcess` constructor is now preserved while callable child-process methods remain process-bound. |
| `citgm-1789269141934` | The first final Firefox CITGM run reached the upstream test but failed in ESLint’s `parent-module`/`callsites` path because Firefox returned a string/undefined-frame stack where the package expects V8 CallSites. | Ours, exposed by a nested dependency. The shared Error compatibility layer now supplies normalized Firefox CallSites and the V8 `getScriptNameOrSourceURL` alias. |
| `citgm-1789269089178`, `citgm-1789269512625` | Published package install and upstream test execution completed with exit code 0 in Chromium and Firefox. | PASS. No nested dependency or upstream package/repository blocker remained. |

## Rank 22 gate evidence

The final CITGM pair and repository-wide gates were run after the last runtime
and oracle changes and before the rank-22 commit was created:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-022-glob-parent npm run citgm:browser:chromium -- glob-parent  PASS — citgm-1789269089178
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-022-glob-parent npm run citgm:browser:firefox -- glob-parent   PASS — citgm-1789269512625
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 339/339
npm run test:browser:chromium                               PASS — 280/280
npm run test:browser:firefox                                 PASS — 280/280
```

The focused browser stack oracle passed in Firefox, and the existing focused
runtime regression file passed 73/73. The first full Firefox gate run also
captured a Next.js failure caused by the missing CallSite alias; that failure
is resolved and the final full Firefox suite passed 280/280.

## Rank 23 failure record

The published `p-locate@7.0.0` candidate at gitHead
`b9ccdaaa83f8d2f53f8acf8ff3c97b7aa21f655b` was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-023-p-locate/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789270887676` | Published p-locate installed and its upstream suite completed successfully in Chromium. | PASS; no Chromium package, nested dependency, or upstream repository failure was observed. |
| `citgm-1789270985150`, `citgm-1789271492031`, `citgm-1789271736252`, `citgm-1789271920048`, `citgm-1789272207983`, `citgm-1789272379804` | Firefox completed the p-locate assertions but reported the fixture rejection as unhandled through the p-limit queue and `Promise.all` adoption path. Diagnostic runs isolated the issue to browser-native Promise rejection tracking bypassing the runtime’s visible thenable/handler bookkeeping. | Ours. Firefox user-code `Promise.reject`, guest Promise `.then`, and Promise collection inputs now preserve Node-compatible handled state across native async adoption. The fix is general, with focused CommonJS and published-ESM queue regression oracles. |
| `/tmp/bnh-p-locate-src` | The exact published source was inspected, including the rejection fixture and the p-limit queue implementation. | Confirms the failure is in browser runtime Promise compatibility, not a nested dependency or upstream package/repository defect. |
| `citgm-1789272546386` / `citgm-1789272646645` | Published package install and upstream tests completed with exit code 0 in Firefox and Chromium. | PASS. No nested dependency or upstream package/repository blocker remained. |

## Rank 23 gate evidence

The final CITGM pair and repository-wide gates were run after the last runtime
and oracle changes and before the rank-23 commit was created:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-023-p-locate npm run citgm:browser:chromium -- p-locate  PASS — citgm-1789272646645
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-023-p-locate npm run citgm:browser:firefox -- p-locate   PASS — citgm-1789272546386
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 339/339
npm run test:browser:chromium                               PASS — 282/282
npm run test:browser:firefox                                 PASS — 282/282
```

The initial full Firefox gate attempt (`repo-gate-firefox-initial-failure.log`)
was 281/282 because the Playwright page closed during fixture navigation before
the test body ran. The clean rerun passed 282/282; this transient runner
interruption was not a package or runtime failure.

## Rank 24 failure record

The published `has-flag@5.0.1` candidate at gitHead
`0c7d032214c51d14b458364c9f6575ea9afa08b1` was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-024-has-flag/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789288391205` | Install, XO, and AVA (1 test) passed, but `tsd` emitted 2,789 errors in transitive `@types/node`, `undici-types`, and bundled TypeScript declarations. | Upstream package/repository. The 2021 package pins an obsolete `tsd@^0.14.0`/XO toolchain while fresh dependency resolution supplies declarations that require newer TypeScript/lib support. The exact native package test is independently broken before `tsd`, so this is not a browser-runtime defect. |
| `citgm-1789288596679` | Firefox reached the same `tsd` declaration failure; while formatting the diagnostic output, the nested `source-map-support` path also raised `this.isNative is not a function`. | Upstream/nested test-tool diagnostic path. This occurs after the already-invalid `tsd` phase and does not change the package classification; no package-specific browser workaround was added. |
| `/tmp/bnh-has-flag-native.PUlHCN/native-upstream-test.log` | The exact published tarball was installed natively and `npm test` failed in XO with `TypeError: util.isDate is not a function` from `eslint-plugin-ava`/`core-assert`, before AVA or tsd. | Confirms the blocker is the upstream package’s obsolete test toolchain under Node 22. No fake shim was added. |

## Rank 24 gate evidence

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-024-has-flag npm run citgm:browser:chromium -- has-flag  FAIL — citgm-1789288391205 (upstream tsd toolchain)
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-024-has-flag npm run citgm:browser:firefox -- has-flag   FAIL — citgm-1789288596679 (upstream tsd toolchain; nested diagnostic error)
npm run build / npm test / full Playwright suites                  NOT RUN — blocked upstream before a green package result
```

Rank 24 is recorded as `BLOCKED` and the ordered cursor advances to rank 25;
no repository changes were made for this package, so no repository-wide gate
or commit of a runtime workaround is warranted.

## Rank 25 failure record

The published `iconv-lite@0.7.3` candidate at gitHead
`43694e28291d3b0cb3a452c77be40c4fd3a4bd85` was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-025-iconv-lite/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789288896502` | Chromium reached the upstream streams tests, where iconv-lite's legacy `Transform.call(this, options)` construction failed with `Class constructor Transform cannot be invoked without 'new'`. | Ours. The browser runtime now supports callable legacy `Transform` construction while retaining the modern constructor/prototype contract. |
| `citgm-1789289171705` | After the Transform fix, the upstream stream surrogate matrix encoded split UTF-8 surrogate halves as replacement characters instead of the expected code point. | Ours. Matching-decoder string chunks now remain strings across `Readable.push()` boundaries so iconv-lite can combine the halves before encoding. |
| `citgm-1789289465120` | After the surrogate fix, the BOM tests observed that `string_decoder` had already removed U+FEFF, so `stripBOM: false` returned no BOM and the `stripBOM` callback was not called. | Ours. The runtime's UTF-8 `StringDecoder` now preserves a leading BOM, leaving BOM policy to the consumer as Node does. |
| `citgm-1789289704489` / `citgm-1789289771188` | Published package install and all upstream child phases completed with exit code 0 in Chromium and Firefox. | PASS. No nested dependency or upstream package/repository blocker remained. |

## Rank 25 gate evidence

The final CITGM pair and repository-wide gates were run after the runtime and
oracle changes and before the rank-25 commit was created:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-025-iconv-lite npm run citgm:browser:chromium -- iconv-lite  PASS — citgm-1789289704489
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-025-iconv-lite npm run citgm:browser:firefox -- iconv-lite   PASS — citgm-1789289771188
npm run build -- --node-version=v22                         PASS
npm test                                                     PASS — 339/339
npm run test:browser:chromium                               PASS — 285/285
npm run test:browser:firefox                                 PASS — 285/285
```

The focused async-primitives regression oracle passed 3/3 in both browsers,
covering legacy callable Transform construction, split surrogate preservation,
and leading BOM preservation.

Rank 25 is recorded as `PASS` and the ordered cursor advances to rank 26.

## Rank 26 failure record

The published `entities@8.1.0` candidate at gitHead
`c71f5625c6bb604c63fb62ff500736b4563c4c00` was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-026-entities/`. The exact package also passed
its native reference install and test suite, confirming these were browser
runtime/package-staging issues rather than an upstream package blocker.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789290825443`, `citgm-1789291416528`, `citgm-1789291504313`, `citgm-1789291804137`, `citgm-1789291875456`, `citgm-1789291976119`, `citgm-1789292075457`, `citgm-1789292137575`, `citgm-1789292314540`, `citgm-1789292417064`, `citgm-1789292622440`, `citgm-1789292676901`, `citgm-1789292806825`, `citgm-1789292888379`, `citgm-1789292970171`, `citgm-1789293097078`, `citgm-1789293158994`, `citgm-1789293253263`, `citgm-1789293402507`, `citgm-1789293561194`, `citgm-1789293885678`, `citgm-1789293984067`, `citgm-1789294057254` | Vitest initially failed during ESM startup, and Biome could not find its Linux native binary. Diagnostic reruns exposed unsafe rewriting of literal `import.meta.url`, object/class `import(rawId) {}` methods, and bundled comment examples. | Ours, exposed by nested Vitest/Biome tooling. The ESM lowerer is now mask-aware for literals/comments and method definitions, and Biome uses the official `@biomejs/wasm-nodejs` distribution. |
| `citgm-1789294195200` | Rolldown could not find an installed compatible `@rolldown/binding-wasm32-wasi@1.2.7`. | Ours, in browser package staging. The official Rolldown WASI binding is supplied as a browser supplemental dependency and recursive dependencies are staged relative to the target package's `node_modules`. |
| `citgm-1789294433332`, `citgm-1789294685655`, `citgm-1789295254163`, `citgm-1789295345275`, `citgm-1789295590879`, `citgm-1789296010070`, `citgm-1789296100453`, `citgm-1789296234861`, `citgm-1789296336701` | The official WASI path reached runtime, then failed on false export names from identifiers, block-comment examples, or Biome lint/schema diagnostics. | Ours. Import token boundaries and comment-aware export discovery were tightened; the Biome WASM wrapper now preserves syntax errors, ignores the native schema-mismatch information notice, and avoids reporting lint diagnostics when that mismatch is present. Temporary diagnostic stack traces were removed from source; all artifacts remain preserved. |
| `citgm-1789296541914` / `citgm-1789296597439` | Published package install and all upstream child phases completed with exit code 0 in Chromium and Firefox. | PASS. No nested dependency or upstream package/repository blocker remained. |

## Rank 26 gate evidence

The final CITGM pair and repository-wide gates were run after the last runtime,
package-alternative, staging, and oracle changes and before the rank-26 commit
was created:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-026-entities npm run citgm:browser:chromium -- entities  PASS — citgm-1789296541914
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-026-entities npm run citgm:browser:firefox -- entities   PASS — citgm-1789296597439
npm run build -- --node-version=v22                         PASS — 5 WASM artifacts
npm test                                                     PASS — 339/339
npm run test:browser:chromium                               PASS — 285/285
npm run test:browser:firefox                                 PASS — 285/285
```

Rank 26 is recorded as `PASS` and the ordered cursor advances to rank 27.

## Rank 27 failure record

The published `uuid@14.0.2` candidate at gitHead
`fd59f0277549d22cc7ec00a7b3b5c9bccb4d3c1d` was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-027-uuid/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789297847202` | The upstream `uuid` test lifecycle reached `scripts/build.sh`, but the browser shell treated Bash/POSIX control syntax as ordinary commands (`set`, `for`, `if`, `then`, and `done` were not interpreted), rejected `cp -pr`, and did not implement `find -exec`; the build then failed to produce the test tree. | Ours, exposed by the upstream package build script. The virtual shell now supports compound sequences, positional/default and substitution parameters, command substitution, `if`/`for`/subshell execution, compact recursive copy flags, and the `find -exec rm` form used by this script. |
| `citgm-1789298820089` / `citgm-1789298894940` | Published package install and all upstream child phases completed with exit code 0 in Chromium and Firefox. | PASS. This was not a nested dependency or upstream package/repository blocker; the package’s build script is valid and now runs against the browser VFS. |

## Rank 27 gate evidence

The final CITGM pair and repository-wide gates were run after the shell,
filesystem utility, type declaration, and browser-oracle changes and before the
rank-27 commit was created:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-027-uuid npm run citgm:browser:chromium -- uuid  PASS — citgm-1789298820089
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-027-uuid npm run citgm:browser:firefox -- uuid   PASS — citgm-1789298894940
npm run build -- --node-version=v22                         PASS — 5 WASM artifacts
npm test                                                     PASS — 340/340
npm run test:browser:chromium                               PASS — 286/286
npm run test:browser:firefox                                 PASS — 286/286
```

Rank 27 is recorded as `PASS` and the ordered cursor advances to rank 28.

## Rank 28 failure record

The published `json-schema-traverse@1.0.0` candidate at gitHead
`6b45983cd76270042cc79527da5c8972f13599ec` was tested with CITGM 10.0.2.
Complete artifacts for both exact browser attempts are preserved under
`artifacts/citgm-top-100/rank-028-json-schema-traverse/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789300059787` / `citgm-1789300122014` | Published package install and all upstream child phases completed with exit code 0 in Chromium and Firefox. | PASS. No runtime, nested dependency, or upstream package/repository failure was observed; no source or test change was needed. |

## Rank 28 gate evidence

The exact CITGM pair passed without repository changes, so the repository-wide
build, unit, and Playwright gates were intentionally skipped under the
unchanged double-CITGM continuation rule:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-028-json-schema-traverse npm run citgm:browser:chromium -- json-schema-traverse  PASS — citgm-1789300059787
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-028-json-schema-traverse npm run citgm:browser:firefox -- json-schema-traverse   PASS — citgm-1789300122014
npm run build / npm test / full Playwright suites                  SKIPPED — unchanged double-CITGM pass
```

Rank 28 is recorded as `PASS` and the ordered cursor advances to rank 29.

## Rank 29 failure record

The published `string-width@8.2.2` candidate at gitHead
`64dc20cddd374df0ff43ba3469491ae98cf0cdfc` was tested with CITGM 10.0.2.
Complete artifacts for both exact browser attempts are preserved under
`artifacts/citgm-top-100/rank-029-string-width/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789300238587` / `citgm-1789300334846` | Published package install and all upstream child phases completed with exit code 0 in Chromium and Firefox. | PASS. No runtime, nested dependency, or upstream package/repository failure was observed; no source or test change was needed. |

## Rank 29 gate evidence

The exact CITGM pair passed without repository changes, so the repository-wide
build, unit, and Playwright gates were intentionally skipped under the
unchanged double-CITGM continuation rule:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-029-string-width npm run citgm:browser:chromium -- string-width  PASS — citgm-1789300238587
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-029-string-width npm run citgm:browser:firefox -- string-width   PASS — citgm-1789300334846
npm run build / npm test / full Playwright suites                  SKIPPED — unchanged double-CITGM pass
```

Rank 29 is recorded as `PASS` and the ordered cursor advances to rank 30.

## Rank 30 failure record

The published `escape-string-regexp@5.0.0` candidate at gitHead
`ba9a4473850cb367936417e97f1f2191b7cc67dd` was tested with CITGM 10.0.2.
Complete artifacts for both exact browser attempts are preserved under
`artifacts/citgm-top-100/rank-030-escape-string-regexp/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789300473401` | Install, XO, and AVA (3 tests) passed, but the package's pinned `tsd@^0.14.0` emitted 2,791 declaration errors while parsing fresh `@types/node`, `undici-types`, `@types/readable-stream`, and its bundled TypeScript. | Upstream package/repository. The package's 2021-era test toolchain is incompatible with the declarations selected by a fresh install; this fails before a meaningful package type-test result and is not a browser-runtime defect. |
| `citgm-1789300587441` | Firefox reproduced the same 2,791-error tsd failure; the nested diagnostic path then raised `this.isNative is not a function` while formatting the failure. | Upstream package/repository, with a nested test-tool diagnostic error. The secondary diagnostic exception does not change the primary blocker; no fake shim or package-specific workaround was added. |

## Rank 30 gate evidence

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-030-escape-string-regexp npm run citgm:browser:chromium -- escape-string-regexp  FAIL — citgm-1789300473401 (upstream tsd toolchain)
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-030-escape-string-regexp npm run citgm:browser:firefox -- escape-string-regexp   FAIL — citgm-1789300587441 (same upstream tsd toolchain; nested diagnostic error)
npm run build / npm test / full Playwright suites                  NOT RUN — blocked upstream before a green package result; no repository changes were made
```

Rank 30 is recorded as `BLOCKED` and the ordered cursor advances to rank 31.

## Rank 31 failure record

The published `globals@17.12.0` candidate at gitHead
`98008c3200fc994ef3c074699e8ce0c9691fd071` was tested with CITGM 10.0.2.
Complete artifacts for every browser attempt are preserved under
`artifacts/citgm-top-100/rank-031-globals/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789300757218` | Chromium failed during XO in ESLint no-warning-comments with Cannot read properties of undefined (reading decoration). | Ours initially. The trace led to the browser runtime missing util.inspect.defaultOptions; that compatibility fix is retained and covered by a browser regression oracle. |
| `citgm-1789300880970` | Firefox ran five AVA tests but left globals.json unresolved; the diagnostic path reported missing util.inspect.defaultOptions. | Ours. Added Node-compatible inspect defaults; Firefox rerun `citgm-1789303621324` passes all 6 AVA tests. |
| `citgm-1789305191353` / `citgm-1789305524059` | Chromium reaches the published root ESLint 9.39.5 rule through eslint-plugin-unicorn, while XO runs the nested ESLint 8.57.1 Linter. ESLint 9's rule expects meta.defaultOptions, but ESLint 8 does not apply it; XO exits before linting the candidate. | Nested dependency interaction. Native Node passes the normal deduped tree, but the same root-9/nested-8 tree reproduced under native Node also exits at XO with the identical error; this is recorded in native-node/duplicate-eslint-layout.log. No fake shim or package-specific success path was added. |

## Rank 31 gate evidence

The package did receive a runtime change, so the repository-wide build, unit,
and Playwright gates are required before committing the status record. The
remaining browser failure is a nested dependency interaction already proven
to fail under native Node with the same installed layout.

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-031-globals npm run citgm:browser:chromium -- globals  BLOCKED — citgm-1789305524059 (root ESLint 9 / XO ESLint 8 interaction)
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-031-globals npm run citgm:browser:firefox -- globals   PASS — citgm-1789303621324
native Node exact deduped globals tree                                      PASS — native-node/summary.log
native Node duplicate ESLint layout                                        FAIL — native-node/duplicate-eslint-layout.log
```

Rank 31 is recorded as `BLOCKED` only after the same failing dependency layout
was reproduced under native Node, and the ordered cursor advances to rank 32.

## Rank 32 failure record

The published `is-fullwidth-code-point@5.1.0` candidate at gitHead
`2696d873463fde9f6b09b49c98380bd49c67b00a` was tested with CITGM 10.0.2.
Complete artifacts for both exact browser attempts are preserved under
`artifacts/citgm-top-100/rank-032-is-fullwidth-code-point/`.

| Run / log | Observed result | Classification and resolution |
| --- | --- | --- |
| `citgm-1789307869379` / `citgm-1789307953202` | Published package install and all upstream child phases completed with exit code 0 in Chromium and Firefox. | PASS. No runtime, nested dependency, or upstream package/repository failure was observed; no source or test change was needed. |

## Rank 32 gate evidence

The exact CITGM pair passed without repository changes, so the repository-wide
build, unit, and Playwright gates were intentionally skipped under the
unchanged double-CITGM continuation rule:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-032-is-fullwidth-code-point npm run citgm:browser:chromium -- is-fullwidth-code-point  PASS — citgm-1789307869379
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-032-is-fullwidth-code-point npm run citgm:browser:firefox -- is-fullwidth-code-point   PASS — citgm-1789307953202
npm run build / npm test / full Playwright suites                  SKIPPED — unchanged double-CITGM pass
```

Rank 32 is recorded as `PASS` and the ordered cursor advances to rank 33.
## Rank 33 failure record

The published `argparse@3.0.2` candidate at gitHead
`b24ea1892b4b7e7a268cd4554cdd654ec47c148f` was tested with CITGM 10.0.2.
Complete artifacts for every attempt are preserved under
`artifacts/citgm-top-100/rank-033-argparse/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789311910165`, `citgm-1789311912290`, `citgm-1789312876749`, `citgm-1789313285265` | The upstream `TestFileTypeW` cases accepted a chmod 0400 file for a write-open, and intermediate runs also exposed browser node:test discovery/suite-order behavior. | Ours. The VFS now enforces owner/group/other permission bits for opens and writes; node:test child discovery and top-level suite serialization fixes are retained in the shared runtime. |
| `native-node/argparse-node-v26.log` | Native Node v26 reproduced only 64 teardown failures from the package's removed `fs.rmdirSync(..., { recursive: true })` behavior; it did not reproduce the readonly parser failures. `native-node/argparse-node-v26-class.log` passes the exact `TestTypeClassicClass` selection. | Native comparison evidence; not an upstream classification. |
| `citgm-1789314693837` | Firefox alone rejected the six classic-class success combinations because its engine reports `class constructors must be invoked with 'new'` instead of V8's `Class constructor ... cannot be invoked without 'new'`. | Ours. The loader now widens the Node class-call error pattern for browser wording; the focused CommonJS regression passes in both browsers. |
| `citgm-1789315178421` / `citgm-1789315226994` | Published `argparse@3.0.2` completed install, lint, and its upstream test contract with exit code 0 in Chromium and Firefox. | PASS; no nested dependency or upstream package/repository blocker observed. |

## Rank 33 gate evidence

The required repository-wide gates passed after the final CITGM browser passes and before advancing the rank cursor:

```text
npm run build                                           PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                PASS
npm run test:browser:chromium                           PASS
npm run test:browser:firefox                            PASS
```

## Rank 34 failure record

The published `ignore@7.0.9` candidate at gitHead
`821765efdf7752b186a03ed0450d9ee013cee099` was tested with CITGM 10.0.2.
Complete artifacts for every attempt, including the initial failures, are
preserved under `artifacts/citgm-top-100/rank-034-ignore/`.

| Run / log | Observed failure or result | Classification and resolution |
| --- | --- | --- |
| `citgm-1789316370783` | The package's `compat` gate could not resolve `git describe --tags --abbrev=0` because the browser project download is a source archive without `.git` history. | Ours. Native Node v26 on a full exact-githead clone passes the package, so this was not an upstream or nested dependency failure. The pre-cache now fetches the current commit and every literal compatibility ref, and the browser runtime supplies the required virtual Git/worktree operations from those exact archives. |
| `citgm-1789317208886`, `citgm-1789317338841`, `citgm-1789317453032` | Follow-up runs reached the virtual worktree but exposed SCP-style (`git@github.com:...`) repository metadata and then the synchronous `tap` launcher parsing `classic` as a script path. | Ours. Repository URL normalization now covers SCP-style Git URLs, and synchronous shebang entrypoints now translate to Node before parsing their command arguments. These intermediate failures remain preserved as implementation evidence. |
| `citgm-1789317691280` / `citgm-1789317740056` | Chromium and Firefox both completed install and the full `ignore` contract with the `7.0.6` and `7.0.9` compatibility worktrees passing in normal and `--win32` modes. | PASS. No nested dependency or upstream package/repository blocker remained. |
| `native-ignore-node-v26.log` | Native Node v26 exact checkout passes lint, TypeScript checks, build, 1368/1368 test assertions, and both compatibility modes. | Required native comparison proof; this explicitly rules out an upstream/package classification for the browser failure. |

## Rank 34 gate evidence

The required repository-wide gates passed after both final CITGM browser passes
and before committing the status record:

```text
npm run build                                           PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                PASS — 340/340
npm run test:browser:chromium                           PASS — 289/289
npm run test:browser:firefox                            PASS — 289/289
```

Rank 34 is recorded as `PASS` and the ordered cursor advances to rank 35.

## Rank 35 CITGM evidence

The published `which@7.0.0` candidate at gitHead
`297db11d58eebe01551ae0875a127a89ee63d2cb` passed exact CITGM 10.0.2 in
both browsers. Complete artifacts are preserved under
`artifacts/citgm-top-100/rank-035-which/`.

| Run / log | Observed result | Classification |
| --- | --- | --- |
| `citgm-1789318901100` / `citgm-1789318952953` | Chromium and Firefox completed package installation, ESLint, and the upstream TAP suite with exit code 0. Firefox also emitted template-oss repository-drift diagnostics that did not affect the CITGM result. | PASS; no runtime, nested-dependency, or upstream package/repository failure observed. |

## Rank 35 gate evidence

The exact CITGM pair passed without repository changes, so the repository-wide
build, unit, and Playwright gates were intentionally skipped under the
unchanged double-CITGM continuation rule:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-035-which npm run citgm:browser:chromium -- which  PASS — citgm-1789318901100
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-035-which npm run citgm:browser:firefox -- which   PASS — citgm-1789318952953
npm run build / npm test / full Playwright suites                  SKIPPED — unchanged double-CITGM pass
```

Rank 35 is recorded as `PASS` and the ordered cursor advances to rank 36.

## Rank 36 failure record

The published `esbuild@0.28.2` candidate at gitHead
`609683d892977362a0f99026cb74b96263d728a9` was tested with CITGM 10.0.2.
The complete Chromium and Firefox artifacts and native comparison are preserved under
`artifacts/citgm-top-100/rank-036-esbuild/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789319117820` / `citgm-1789319307780` | Chromium and Firefox CITGM download `https://github.com/evanw/esbuild/archive/609683d892977362a0f99026cb74b96263d728a9.tar.gz`, then report `Package.json Could not be found` before package execution. | Not classified as upstream until native proof. |
| `native-citgm-node-v26.log` | Native Node CITGM 10.0.2 reproduces the same failure during `npm install`: `/tmp/.../esbuild/package.json` is missing. | Upstream package/repository layout blocker, proven by native Node. The published npm package is located under the monorepo `npm/esbuild` subtree while CITGM resolves and installs the repository root. No fake package root, shim, or browser-only workaround was added. |

## Rank 36 gate evidence

The exact Chromium CITGM failure was reproduced by native Node before applying
the upstream classification. No repository-wide gates were run because no
repository change was made and the package is blocked before meaningful test
execution:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-036-esbuild npm run citgm:browser:chromium -- esbuild  FAIL — citgm-1789319117820 (missing monorepo-root package.json)
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-036-esbuild npm run citgm:browser:firefox -- esbuild   FAIL — citgm-1789319307780 (same missing monorepo-root package.json)
npm exec --yes --package=citgm@10.0.2 -- citgm esbuild                                      FAIL — native Node v26, same ENOENT
npm run build / npm test / full Playwright suites                                               NOT RUN — upstream/package-layout blocker; no repository changes
```

Rank 36 is recorded as `BLOCKED` only after the same failure was reproduced
under native Node, and the ordered cursor advances to rank 37.

## Rank 37 failure record

The published `isexe@4.0.0` candidate at gitHead
`2e7df7dabc4f68e88cf6b32b9029225ba52c6b0c` was tested with CITGM 10.0.2.
Complete artifacts for every browser and native comparison attempt are
preserved under `artifacts/citgm-top-100/rank-037-isexe/`.

| Run / log | Observed failure or result | Classification and resolution |
| --- | --- | --- |
| `citgm-1789319770097`, `citgm-1789319829719`, `citgm-1789320550711` | Chromium and Firefox initially reached `test/posix.ts` but failed while decoding raw loader-hook source with a browser `TextDecoder` type error; the first fix exposed a static `node:fs/promises` named-export failure. | Ours. The browser runtime was not normalizing cross-realm/SharedArrayBuffer-backed loader source, and then did not await the Promise returned by the asynchronous tap mock service. Both defects were fixed in the shared ESM loader and covered by focused regressions. |
| `citgm-1789321146560` | Instrumented Chromium run proved `tapmockLoad()` was handing `source: Promise` to module materialization, producing a mock module without `stat`; this diagnostic run is preserved and is not a final result. | Ours. The diagnostic was removed; async tap-mock source is now awaited. |
| `citgm-1789321276490` / `citgm-1789321334839` | Final Chromium and Firefox runs completed install, build, and all upstream `isexe` test children with exit code 0. The package’s esbuild WASM launcher emits non-fatal `Go program has already exited` stderr after successful builds; no test failed. | PASS. No nested dependency or upstream package/repository blocker remained. |
| `native-citgm-node-v22-corrected.log` | Exact native Node 22 CITGM passes `isexe@4.0.0` (`smoke test has passed`). | Required native proof: the matching native runtime passes, so the browser failures were ours, not upstream. The separate Node 26 comparison timed out in TAP and was not used for classification; the initial Node 22 mise-wrapper invocation is preserved separately as an invalid proof attempt. |
| `native-citgm-node-v26.log`, `native-citgm-node-v22.log` | Node 26 did not produce a clean comparison because the package’s TAP run timed out; the first Node 22 command invoked mise’s shell wrapper through Node and failed before running the package. | Comparison artifacts only; neither is an upstream classification. |

## Rank 37 gate evidence

The package required runtime and regression-test changes, so all repository-wide
gates ran after both final CITGM browser passes and before committing:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-037-isexe npm run citgm:browser:chromium -- isexe  PASS — citgm-1789321276490
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-037-isexe npm run citgm:browser:firefox -- isexe   PASS — citgm-1789321334839
npm run build                                           PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                PASS — 343/343
npm run test:browser:chromium                           PASS — 289/289
npm run test:browser:firefox                            PASS — 289/289
```

Rank 37 is recorded as `PASS` and the ordered cursor advances to rank 38.

## Rank 38 failure record

The published `js-yaml@5.4.2` candidate at gitHead
`494400bd45cad078123cfc057e674a9a0a8d9983` was tested with CITGM 10.0.2.
Complete browser, native comparison, and repository-gate artifacts are
preserved under `artifacts/citgm-top-100/rank-038-js-yaml/`.

Every package-level failure below was checked with the exact package under
native Node v26; native CITGM passed each time. Therefore none of these
failures is classified as nested-dependency or upstream/package/repository
behavior.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789322684130` | `rollup/dist/native.js` required the omitted optional `@rollup/rollup-linux-x64-musl` package before js-yaml's tests ran. | Ours. The browser installer now selects the official `@rollup/wasm-node` distribution for Rollup 4+ while preserving native resolution for older Rollup fixtures. |
| `citgm-1789322872244` | Vite's WASI worker failed on `Cannot set property self of #<WorkerGlobalScope> which has only a getter`. | Ours. The runtime now rewrites Node-style worker `self` snapshots only where the browser's WorkerGlobalScope makes `self` read-only; the behavior is covered by a browser regression oracle. |
| `citgm-1789323493647`, `citgm-1789323592829`, `citgm-1789323877307` | The package's test fixture invoked `git -C`; the virtual Git implementation treated `-C` as a subcommand and lacked the external Git fixture/archive flow. | Ours. Virtual Git now supports the required `-C`, repository initialization, remote/fetch/checkout, and HEAD operations; the exact GitHub fixture commit is fetched and recorded by the precache adapter. |
| `citgm-1789324339088` | Quoted `test/core/**/*.test.mjs` was passed to the browser child as a literal path, producing `ERR_MODULE_NOT_FOUND`. | Ours. The Node test argument parser now expands explicit quoted globs against the virtual filesystem, with a bridge regression oracle. |
| `citgm-1789324465450`, `citgm-1789324632719`, `citgm-1789324724418`, `citgm-1789324963383` | TypeScript source first failed with `ERR_UNKNOWN_FILE_EXTENSION`, then with syntax errors from interfaces/generics/annotations, and finally through the asynchronous ESM loader path. | Ours. The shared browser loader now strips the supported TypeScript syntax in both synchronous and asynchronous module materialization paths; the stripper is verified against the public Node API and js-yaml's source. |
| `citgm-1789325245461`, `citgm-1789325541815`, `citgm-1789325607912`, `citgm-1789325680968`, `citgm-1789325780566`, `citgm-1789325832935`, `citgm-1789325887845` | The browser resolved js-yaml's self-import to a nested old `js-yaml` package, so the generated module lacked the `EVENT_ID` export. Instrumented runs proved the wrong target before the diagnostic code was removed. | Ours. Package resolution now honors the owning package's conditional self-reference exports before searching nested `node_modules`, matching native Node behavior. |
| `npm-test-initial-failure.md` | The first repository `npm test` run failed in the old Rollup demo fixture with `No matching version found for @rollup/wasm-node@2.79.2`. | Ours. The official Rollup WASM alternative is now selected only for Rollup 4+; the successful rerun is preserved in `npm-test.log`. |
| `native-citgm-node-v26.log` | Exact native CITGM for `js-yaml@5.4.2` passed (`The smoke test has passed`). | Required native proof: the package and its test contract are green under Node, so the browser failures above were ours. |
| `citgm-1789326034170` / `citgm-1789326085784` | Final Chromium and Firefox CITGM runs both installed js-yaml, ran its test suite, and exited 0. | PASS. No nested-dependency or upstream package/repository blocker remained. |

## Rank 38 gate evidence

The package required runtime and regression-test changes, so all repository-wide
gates ran after both final CITGM browser passes and before committing:

```text
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-038-js-yaml npm run citgm:browser:chromium -- js-yaml  PASS — citgm-1789326034170
NACELLE_CITGM_ARTIFACT_DIR=artifacts/citgm-top-100/rank-038-js-yaml npm run citgm:browser:firefox -- js-yaml   PASS — citgm-1789326085784
npm run build                                           PASS — 5 WASM artifacts; Node 22.23.2
npm test                                                PASS — 345/345
npm run test:browser:chromium                           PASS — 290/290
npm run test:browser:firefox                            PASS — 290/290
```

Rank 38 is recorded as `PASS` and the ordered cursor advances to rank 39.

## Rank 39 failure record

The published `resolve@1.22.12` candidate at gitHead
`d2d30de86300fa862e7792057b82b59cd44f2b5d` was tested with CITGM 10.0.2.
Complete browser, native comparison, focused-regression, and repository-gate
artifacts are preserved under `artifacts/citgm-top-100/rank-039-resolve/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `citgm-1789328694486` through `citgm-final3-chromium.stdout.log`, plus the matching Firefox attempts | The published resolver initially exposed browser-only gaps in V8 CallSite file names, private/public builtin classification, module global paths, symlink realpaths, and child resolution. | Ours. The shared error-stack, builtin, module-loader, and resolver paths were corrected and covered by focused browser oracles. |
| `citgm-trace-stream-chromium.stdout.log` | The legacy `tape` child printed all tests as passing but exited 1 because `fs.writeSync` referenced an unimported `resolveEncodingOps`. | Ours. The missing buffer operation import was restored; the legacy stream exit oracle now passes. |
| `citgm-fixed4-chromium.stdout.log` / `citgm-fixed5-chromium.stdout.log` | The nested multirepo `npm install` path first rejected install scripts, then recursively re-entered Lerna's `postinstall`. | Ours. Browser-shell npm install routing and package-owned lifecycle execution now match the native boundary, with a lifecycle recursion guard. |
| `citgm-1789331594801` / `focused-event-emitter*.log` | `config-chain@1.1.13` copied `Object.keys(EventEmitter.prototype)` and then failed on `this.emit`, followed by private `_ensureState` and `checkListenerLimit` dependencies. | Ours. EventEmitter's enumerable Node-compatible methods now use module-local state helpers, and the published config-chain inheritance shape passes in Chromium and Firefox. |
| `citgm-1789331867255` (Chromium) / `citgm-1789331975003` (Firefox) | The resolver's 695 package assertions, nested symlink pretests, and Lerna multirepo test all pass. The package posttest then runs `npx npm@'>= 10.2' audit --production` and reports `npm@>= 10.2: command not found`. | Blocked by the published package test script/toolchain. Exact native Node v26 reproduces the same posttest command failure after its 812 passing assertions and successful multirepo test (`native-citgm-node-v26.log`). No browser-only shim or fake npm package was added. This is not a nested dependency failure and is not classified as ours. |

Rank 39 is recorded as `BLOCKED` for the native-reproduced upstream/package
posttest failure. All browser-specific failures were fixed before that
classification; the ordered cursor advances to rank 40 only after the
repository changes are committed cleanly.

## Rank 39 gate evidence

The package required runtime and regression-test changes, so repository-wide
gates ran after the final browser CITGM attempts and before committing:

```text
npm run citgm:browser:chromium -- resolve  FAIL — citgm-1789331867255; package tests and multirepo pass, native-reproduced posttest blocker
npm run citgm:browser:firefox -- resolve   FAIL — citgm-1789331975003; same native-reproduced posttest blocker
npm run build                              PASS — build-final2.log
npm test                                   PASS — 345/345, npm-test-final2.log
npm run test:browser:chromium              PASS — 296/296, playwright-chromium-final2.log
npm run test:browser:firefox                PASS — 296/296, playwright-firefox-final2.log
```

## Rank 40 status

The published `mime-types@3.0.2` candidate at gitHead
`29a0302d799933a45384892df0722f3c5bb1b033` passed exact CITGM 10.0.2 under
native Node v26, Chromium, and Firefox. Artifacts are preserved under
`artifacts/citgm-top-100/rank-040-mime-types/`. No package, nested dependency,
or runtime failure was observed, so no failure classification applies.

```text
npm exec --yes --package=citgm@10.0.2 -- citgm mime-types       PASS — native-citgm-node-v26.log
npm run citgm:browser:chromium -- mime-types                    PASS — citgm-1789334125439
npm run citgm:browser:firefox -- mime-types                     PASS — citgm-1789334143512
npm test / full Chromium / full Firefox Playwright suites        NOT RUN — double CITGM pass with no source change
```

Rank 40 is recorded as `PASS` and the ordered cursor advances to rank 41.
```

## Rank 41 failure record

The published `nanoid@6.0.1` candidate at gitHead
`9247b6dbfe97854e6e136784ae5dde0c672d22c5` was tested with CITGM 10.0.2.
All browser, native comparison, focused-regression, and repository-gate
artifacts are preserved under
`artifacts/citgm-top-100/rank-041-nanoid/`. The exact native Node CITGM
rerun passed before the browser failures were classified, so no failure in
this rank is classified as a nested-dependency or upstream problem.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26-rerun.log` | Exact `nanoid@6.0.1` CITGM passed under native Node v26. | Required native proof: the package's own contract is green under Node; browser failures were investigated as ours. |
| `citgm-chromium.stdout.log`, `citgm-firefox.stdout.log` | The package's `pnpm run /^test:/` script was passed through as a literal script name and did not run its test suite. | Ours. Added general pnpm regex-script selection and shorthand dispatch. |
| `citgm-fixed2` through `citgm-fixed5` logs | After lifecycle dispatch was fixed, the 79 package tests exposed Node option parsing, child `exec`/`execFile` promise shape, and stderr propagation gaps. | Ours. Fixed the shared Node argument parser and child-process compatibility contracts. |
| `citgm-fixed6` through `citgm-fixed12`, `citgm-firefox-*diagnostics.log` | `oxlint` could not load its native binding in the browser; subsequent WASI attempts exposed the package's threaded WASM bridge, worker factory, VFS traversal, and config callback boundaries. | Ours, including the nested tool's browser execution path. Added an explicitly documented unofficial `oxlint.wasm32-wasi` adapter using the published WASI/N-API runtime dependencies and staged browser bindings. No fake native shim or upstream classification was used. |
| `focused-fs-glob-*`, `citgm-fixed13` through `citgm-fixed24` | The package tests then exposed `fs.promises.glob` Dirents, Brotli transform fallback, ESM export-list comments, live cycle bindings, and named re-export parsing. | Ours. Fixed the general VFS, WASM zlib, and ESM loader paths and retained the focused browser regressions. |
| `playwright-firefox-guest-typed-array-fix.log`, `playwright-firefox-raw-hook-focused*.log` | Firefox rejected the valid Buffer returned by the ESM loader because the runtime Buffer prototype predated Firefox's per-run guest `Uint8Array` constructor. | Ours. The Buffer instance prototype now bridges to the guest typed-array prototype; the constructor itself is left intact so its static Node API is preserved. The raw ESM hook regression passes in both browsers. |
| `playwright-firefox-nextjs-focused*.log` | Next.js webpack cache failed with `Buffer.byteLength is not a function` after the constructor-level Firefox bridge altered the Buffer static surface; the Next HMR test consequently could not become ready. | Ours. Removed the constructor-level bridge while retaining the instance bridge and added nested-worker `Buffer.byteLength` and parent-write/watch regressions. The full Next.js demo now passes in both browsers. |
| `playwright-chromium-final.log`, `playwright-chromium-unresolved-focused.log` | One long Chromium run recorded a timing-sensitive unresolved-Promise timeout; the focused reproduction passed and the full rerun was clean. | Transient browser-run interruption during diagnosis, not a package or upstream result; preserved for audit. |
| `citgm-chromium-final-production.log` / `citgm-firefox-final-production.log` | Final exact CITGM runs completed the package's 79 tests, clean oxlint, and size-limit phase in both browsers. | PASS. Chromium run `citgm-1789352834860` and Firefox run `citgm-1789352865027`; no nested-dependency or upstream package/repository blocker remained. |

## Rank 41 gate evidence

The package required runtime and browser regression changes, so all repository-
wide gates ran after both final CITGM browser passes and before committing:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm nanoid  PASS — native-citgm-node-v26-rerun.log
npm run citgm:browser:chromium -- nanoid                    PASS — citgm-1789352834860
npm run citgm:browser:firefox -- nanoid                     PASS — citgm-1789352865027
npm run build -- --node-version=v22                         PASS — build-final-rerun.log; 5 WASM artifacts; Node 22.23.2
npm test                                                     PASS — npm-test-final-rerun.log; 345/345
npm run test:browser:chromium                               PASS — playwright-chromium-final-postfix.log; 307/307
npm run test:browser:firefox                                 PASS — playwright-firefox-final-postfix.log; 307/307
```

Rank 41 is recorded as `PASS` and the ordered cursor advances to rank 42.

## Rank 42 status

The published `yargs-parser@22.0.0` candidate at gitHead
`66f0bb2d2c8a2c9689489784cfe2e5128b0abfc2` passed exact CITGM 10.0.2 under
native Node v26, Chromium, and Firefox. Complete artifacts are preserved under
`artifacts/citgm-top-100/rank-042-yargs-parser/`. No runtime, nested dependency,
or upstream package/repository failure was observed, and no repository source
changes were made.

```text
npm exec --yes --package=citgm@10.0.2 -- citgm yargs-parser  PASS — native-citgm-node-v26.log
npm run citgm:browser:chromium -- yargs-parser                    PASS — citgm-1789357041221
npm run citgm:browser:firefox -- yargs-parser                     PASS — citgm-1789357121881
npm test / full Chromium / full Firefox Playwright suites        NOT RUN — unchanged double-CITGM pass
```

Rank 42 is recorded as `PASS` and the ordered cursor advances to rank 43.

## Rank 43 failure record

The published `source-map@0.8.0` candidate at gitHead
`ac0a1a6342dd0e50b407b1997b32784a3fbe8a67` was tested with CITGM 10.0.2.
Complete native, Chromium, Firefox, and repository-gate artifacts are
preserved under `artifacts/citgm-top-100/rank-043-source-map/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26.log` | The package's test script runs `git submodule update --init --recursive` and then fails to load `./source-map-tests/source-map-spec-tests.json`; the archive checkout has no Git repository or submodule contents. | Native proof: exact Node v26 CITGM fails before any browser runtime is involved. This is an upstream package/repository archive/submodule contract failure. No fake Git executable, submodule shim, or package-specific workaround was added. |
| `citgm-1789357265377` / `citgm-chromium-run.log` | Chromium reports the same missing `source-map-tests/source-map-spec-tests.json` after the archive checkout's `git` command is unavailable. | Same failure as native Node; not classified as browser-only or ours. |
| `citgm-1789357302275` / `citgm-firefox-run.log` | Firefox reports the same missing `source-map-tests/source-map-spec-tests.json` after the archive checkout's `git` command is unavailable. | Same failure as native Node; not classified as browser-only or ours. |

Rank 43 is therefore recorded as `BLOCKED` only after the exact native Node run
reproduced the package failure. The browser runs confirm the same package
checkout problem; they do not establish a separate browser defect.

## Rank 43 gate evidence

The package remained non-green, so the repository-wide gates were run before
committing the blocked record:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm source-map  FAIL — native-citgm-node-v26.log; missing source-map-tests submodule data
npm run citgm:browser:chromium -- source-map  FAIL — citgm-1789357265377; same missing submodule data
npm run citgm:browser:firefox -- source-map   FAIL — citgm-1789357302275; same missing submodule data
npm test                                         PASS — npm-test-gate.log; 345/345
npm run test:browser:chromium                    PASS — playwright-chromium-gate.log; 307/307
npm run test:browser:firefox                      PASS — playwright-firefox-gate.log; 307/307
```

No repository source changes were made for rank 43. The rank-43 blocker
record and all failure/gate logs are committed, and the ordered cursor advances
to rank 44.

## Rank 44 failure record

The published `string_decoder@1.3.0` candidate at gitHead
`60db81e031c126112039157ba9437484b1329dff` was tested with CITGM 10.0.2.
Complete native, browser, focused-regression, and repository-gate artifacts are
preserved under `artifacts/citgm-top-100/rank-044-string-decoder/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26.log` | The package's own `test/common/index.js` exit handler fails its global-leak check with `Unexpected global(s) found: queueMicrotask, structuredClone, atob, btoa, performance, fetch, crypto, navigator, sessionStorage` under Node v26.7.0. | Native proof: the final package blocker reproduces under exact Node before any browser runtime is involved. This is an upstream package/repository test-harness contract that predates the current Node global surface. No package test bypass or fake Node-global result was added. |
| `citgm-1789358624681` / `citgm-chromium-run.log` | Chromium reaches the same upstream global-leak exit handler; the browser-backed process exposes additional browser/runtime globals that the stale `knownGlobals` list does not allow. | The initial browser-only Firefox intrinsic issue was separate and fixed below. The remaining failure matches native Node's global validation failure and is not classified as ours. |
| `citgm-1789358660347` / `citgm-firefox-run.log` | Firefox initially fails in the nested `typed-array-buffer@1.0.3` dependency because `get-intrinsic` cannot derive `%TypedArray%` through the wrapped guest `Uint8Array`. | Ours, exposed by the nested dependency. Replaced the Firefox class wrapper with a `Reflect.construct` forwarding constructor, retained the native static surface, and added the typed-array intrinsic oracle. |
| `citgm-1789359054680` / `citgm-firefox-rerun-1.log` | After the intrinsic fix, Firefox reaches the same `test/common/index.js` global-leak assertion as native Node; no `typed-array-buffer` exception remains. | The ours-side nested-dependency defect is fixed. The remaining package result is the native-reproduced upstream test-harness blocker. |
| `citgm-1789359019829` / `citgm-chromium-rerun-1.log` | After the intrinsic fix, Chromium still reaches the same global-leak assertion. | Same native-reproduced upstream blocker; no browser-specific runtime defect remains in this package run. |

Rank 44 is recorded as `BLOCKED` only after the exact native Node v26 run
reproduced the final failing assertion. The repository change is retained
because it fixes a real Firefox cross-realm intrinsic defect exposed by the
nested `typed-array-buffer` dependency, but that fix cannot make the published
`string_decoder` test harness green without masking its global validation.

## Rank 44 gate evidence

The package required a runtime and regression-oracle change, so all repository-
wide gates ran after the final CITGM reruns and before committing:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm string_decoder  FAIL — native-citgm-node-v26.log; stale global-leak assertion
npm run citgm:browser:chromium -- string_decoder             FAIL — citgm-1789359019829; same native-reproduced assertion after ours fix
npm run citgm:browser:firefox -- string_decoder              FAIL — citgm-1789359054680; same native-reproduced assertion after ours fix
npm run build -- --node-version=v22                          PASS — build-gate.log; 5 WASM artifacts; Node 22.23.2
npm test                                                     PASS — npm-test-gate.log; 345/345
npm run test:browser:chromium                               PASS — playwright-chromium-gate.log; 308/308
npm run test:browser:firefox                                 PASS — playwright-firefox-gate.log; 308/308
```

The rank-44 runtime fix, regression oracle, failure logs, and gate logs are
committed, and the ordered cursor advances to rank 45.

## Rank 45 status

The published `color-convert@3.1.3` candidate at gitHead
`5c106a633b5cd2de554d9c287ad31f9eeca7a271` passed exact CITGM 10.0.2 under
native Node v26, Chromium, and Firefox. Complete artifacts are preserved under
`artifacts/citgm-top-100/rank-045-color-convert/`. No runtime, nested dependency,
or upstream package/repository failure was observed, and no repository source
changes were made.

```text
npm exec --yes --package=citgm@10.0.2 -- citgm color-convert  PASS — native-citgm-node-v26.log
npm run citgm:browser:chromium -- color-convert             PASS — citgm-1789360293028
npm run citgm:browser:firefox -- color-convert              PASS — citgm-1789360434124
npm test / full Chromium / full Firefox Playwright suites   NOT RUN — unchanged double-CITGM pass
```

Rank 45 is recorded as `PASS` and the ordered cursor advances to rank 46.

## Rank 46 failure record

The published `estraverse@5.3.0` candidate at gitHead
`ec3f900528eac270a51f7b079edeae086e7ebce4` was tested with CITGM 10.0.2.
Complete native, browser, focused-regression, and repository-gate artifacts are
preserved under `artifacts/citgm-top-100/rank-046-estraverse/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26.log` | The exact package checkout passes install, JSHint, and Mocha under native Node v26. | Native proof: the package itself and its dependency layout are green outside the browser. Any browser-only failure was therefore treated as ours. |
| `citgm-1789360691221` / `citgm-chromium-run.log` | The package's nested `cli@1.0.0` dependency calls `process.binding('natives')`, which was unavailable in the browser runtime. | Ours, exposed by a nested dependency. Added the general `process.binding('natives')` registry from the runtime's actual loadable builtin set; no package-specific shim or fake success path was added. |
| `playwright-chromium-native-registry-red.log` | The focused registry oracle failed with `internal binding 'natives' is unavailable in the browser runtime` before the fix. | Red regression proof for the runtime gap. |
| `playwright-chromium-native-registry-green.log` | The focused registry oracle passed after the registry implementation. | The first ours-side defect is fixed. |
| `citgm-1789360942054` / `citgm-chromium-rerun-1.log` | JSHint passed, then the legacy Mocha/Babel path failed with opaque `[object Error]` output. | Ours, not external: the later independent Firefox run exposed the same path as `this.isNative is not a function`, caused by the source-map-support clone seeing browser CallSites without a Node-shaped prototype method set. |
| `citgm-1789361178297` / `citgm-firefox-rerun-1.log` | Firefox independently reports `TypeError: this.isNative is not a function` while the legacy source-map-support formatter handles a CallSite. | Ours. Added a red prototype-clone oracle, then changed parsed and normalized browser CallSites to inherit a shared Node-shaped `CallSite.prototype` while binding available native methods. |
| `playwright-firefox-callsite-red-2.log` / `playwright-chromium-callsite-green-2.log` | The strengthened oracle initially failed in Firefox and Chromium because a prototype clone had no callable `isNative`; it passed in both browsers after normalization. | Red/green regression proof for the actual formatter contract. |
| `citgm-1789361477311` / `citgm-chromium-rerun-2.log` | JSHint, Mocha, and the upstream estraverse tests pass. | Final Chromium CITGM pass after both general runtime fixes. |
| `citgm-1789361533463` / `citgm-firefox-rerun-2.log` | JSHint, Mocha, and the upstream estraverse tests pass. | Final Firefox CITGM pass after both general runtime fixes. |

Rank 46 is recorded as `PASS` because the exact native Node run passed, both
browser CITGM runs passed after fixing the two browser-runtime defects, and all
required repository-wide gates passed.

## Rank 46 gate evidence

The package required runtime and regression-oracle changes, so all repository-
wide gates ran after the final CITGM reruns and before committing:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm estraverse  PASS — native-citgm-node-v26.log; package tests green
npm run citgm:browser:chromium -- estraverse             PASS — citgm-1789361477311; package tests green after fixes
npm run citgm:browser:firefox -- estraverse              PASS — citgm-1789361533463; package tests green after fixes
npm run build -- --node-version=v22                       PASS — build-gate.log; 5 WASM artifacts; Node 22.23.2
npm test                                                  PASS — npm-test-gate.log; 345/345
npm run test:browser:chromium                            PASS — playwright-chromium-gate.log; 310/310
npm run test:browser:firefox                              PASS — playwright-firefox-gate.log; 310/310
```

The rank-46 runtime fixes, regression oracles, failure logs, and gate logs are
committed, and the ordered cursor advances to rank 47.

## Rank 47 failure record

The published `https-proxy-agent@9.1.0` candidate was tested with CITGM 10.0.2.
Its published tarball is the exact candidate downloaded by all three runs;
the package metadata has no usable `gitHead` field. Complete native, browser,
manifest-inspection, and repository-gate artifacts are preserved under
`artifacts/citgm-top-100/rank-047-https-proxy-agent/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26.log` | Native Node fails during npm install with `ETARGET: No matching version found for tsconfig@0.0.0`; package tests never start. | Native proof of the package-install failure before browser involvement. The exact published manifest inspection shows `devDependencies.tsconfig` is literally `0.0.0`, while the published package contains only runtime `dist` files. This is an upstream package-publication/manifest defect, not a browser-runtime failure. No shim, dependency substitution, or package-specific bypass was added. |
| `citgm-1789362861097` / `citgm-chromium-run.log` | Chromium independently fails at the same install step with `No matching version found for tsconfig@0.0.0`. | Confirms the native-reproduced package metadata failure in Chromium; no additional browser defect was inferred. |
| `citgm-1789362890438` / `citgm-firefox-run.log` | Firefox independently fails at the same install step with `No matching version found for tsconfig@0.0.0`. | Confirms the native-reproduced package metadata failure in Firefox; no additional browser defect was inferred. |
| `npm pack https-proxy-agent@9.1.0` manifest inspection | The exact published `package.json` declares `tsconfig: 0.0.0` under `devDependencies`; the tarball has no tests or source files that could provide a valid alternative install contract. | Direct package evidence for the upstream publication defect. The fix belongs in the upstream package/repository publication, not in this runtime. |

Rank 47 is recorded as `BLOCKED` only after the exact native Node run reproduced
the same install failure later observed in both browser CITGM runs. Because the
candidate never reaches package execution in any environment, there is no
runtime behavior to repair in this repository.

## Rank 47 gate evidence

The package remained non-green, so the repository-wide gates were run before
committing the blocked record:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm https-proxy-agent  FAIL — native-citgm-node-v26.log; invalid published tsconfig@0.0.0 devDependency
npm run citgm:browser:chromium -- https-proxy-agent             FAIL — citgm-1789362861097; same native-reproduced install failure
npm run citgm:browser:firefox -- https-proxy-agent              FAIL — citgm-1789362890438; same native-reproduced install failure
npm test                                                        PASS — npm-test-gate.log; native unit suite green
npm run test:browser:chromium                                  PASS — playwright-chromium-gate-rerun-1.log; 310/310
npm run test:browser:firefox                                    PASS — playwright-firefox-gate.log; 310/310
```

No repository source changes were made for rank 47. The rank-47 native proof,
both browser confirmations, manifest evidence, and gate logs are committed,
and the ordered cursor advances to rank 48.

## Rank 48 failure record

The published `@babel/helper-validator-identifier@8.0.4` candidate was tested
with CITGM 10.0.2. The exact published manifest is preserved at
`artifacts/citgm-top-100/rank-048-babel-helper-validator-identifier/published-package.json`;
the package has no usable `gitHead` field in its npm metadata. Complete native,
browser, focused-regression, and repository-gate artifacts are preserved under
`artifacts/citgm-top-100/rank-048-babel-helper-validator-identifier/`.

| Run / log | Observed failure | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26.log` | Native Node installs the package successfully, then CITGM reports `Module does not support npm-test!`; the package manifest has no `scripts.test` or scripts section. | Native proof that the failure is not browser-specific. This is a published package/test-contract mismatch: the package tarball contains its built library but no test command for CITGM to invoke. No test shim or synthetic success path was added. |
| `citgm-1789364215058` / `citgm-chromium-run.log` | Chromium installs the package successfully, then reaches the same `Module does not support npm-test!` result. | Confirms the native-reproduced package-level failure in Chromium; no browser runtime defect was inferred. |
| `citgm-1789364237954` / `citgm-firefox-run.log` | Firefox installs the package successfully, then reaches the same `Module does not support npm-test!` result. | Confirms the native-reproduced package-level failure in Firefox; no browser runtime defect was inferred. |
| `published-package.json` | The exact published manifest for `@babel/helper-validator-identifier@8.0.4` has `main`, `exports`, and `devDependencies`, but no `scripts` field. | Direct evidence for the upstream package/repository publication/test-layout contract. A package-side test script or a CITGM policy change is required upstream; this runtime cannot repair an absent published test command. |
| `playwright-chromium-gate.log` | The first full Chromium repository gate had one unrelated timeout in test 61, with one pending `entry-settle` task; 309 other tests passed. | Ours-side transient repository-test scheduling failure, not a rank-48 package failure. The focused test passed, the isolated bridge-runtime suite passed 108/108, and the complete Chromium gate was rerun successfully. The original failure log is retained. |
| `focused-chromium-unresolved-promise-rerun.log`, `bridge-runtime-chromium-isolated-rerun.log`, `playwright-chromium-gate-rerun-1.log` | The focused lifecycle test passed, the isolated bridge-runtime suite passed 108/108, and the full Chromium rerun passed 310/310. | Green reproduction/rerun evidence; no source change was required for the transient gate failure. |

Rank 48 is recorded as `BLOCKED` only after the exact native Node run showed the
same CITGM failure later observed in both browsers. The blocker is the
published package's missing test command, not a runtime behavior in this
repository.

## Rank 48 gate evidence

The package remained non-green, so the repository-wide gates were run before
committing the blocked record:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm @babel/helper-validator-identifier  FAIL — native-citgm-node-v26.log; no npm test script
npm run citgm:browser:chromium -- @babel/helper-validator-identifier             FAIL — citgm-1789364215058; same package-level failure
npm run citgm:browser:firefox -- @babel/helper-validator-identifier              FAIL — citgm-1789364237954; same package-level failure
npm test                                                                          PASS — npm-test-gate.log; 345/345
npm run test:browser:chromium                                                     PASS — playwright-chromium-gate-rerun-1.log; 310/310
npm run test:browser:firefox                                                       PASS — playwright-firefox-gate.log; 310/310
```

No repository source changes were made for rank 48. The rank-48 native proof,
both browser confirmations, exact manifest, transient-gate failure and green
reruns, and final gate logs are committed, and the ordered cursor advances to
rank 49.

## Rank 49 failure record

The exact package under test is `json5@2.2.3` at gitHead
`c3a75242772a5026a49c4017a16d9b3543b62776`. Its checked-in package manifest is
preserved at `artifacts/citgm-top-100/rank-049-json5/published-package.json`.
Complete native, browser, resolver-oracle, and repository-gate artifacts are
preserved under `artifacts/citgm-top-100/rank-049-json5/`.

| Run / log | Observed failure or behavior | Classification and resolution |
| --- | --- | --- |
| `citgm-chromium-run.log`, `citgm-firefox-run.log` | The initial browser runs fail during installation because the browser resolver rewrote json5's legacy `rollup@^0.64.1` devDependency to `@rollup/wasm-node@^0.64.1`, a version that does not exist. | Ours. The resolver was incorrectly treating an unparsed range as modern Rollup. The general semver-range major check now keeps pre-4 Rollup ranges on native `rollup` while retaining the official WASM alternative for Rollup 4+. |
| `rollup-legacy-red.log` | The focused VFS registry oracle fails with `unexpected URL: https://registry.example/@rollup/wasm-node` before the fix. | Red oracle for the ours-side resolver defect. |
| `rollup-legacy-green.log` | The same oracle passes and confirms that `rollup@^0.64.1` fetches the native package and tarball only. | Green proof for the general resolver fix; no json5-specific condition or fake package was added. |
| `native-citgm-node-v26.log` | Exact native CITGM installs json5 successfully, then `npm test` reports five test files failing before assertions with `The canary is dead`. The test stack declares `tap@^12.6.0`, whose legacy nested `esm` loader is the failing dependency surface under Node v26. | Native-reproduced nested dependency/toolchain issue. This is not browser-only: the package's own old test dependency cannot run under the target native Node. No shim or synthetic test result was added. |
| `citgm-chromium-rerun-1.log`, `citgm-chromium-rerun-2.log`, `citgm-firefox-rerun-1.log`, `citgm-firefox-rerun-2.log` | After the resolver fix, both browsers install 158 packages and reach `upstream-test-execution`; the virtual `/node/node` running the legacy test stack remains pending without a terminal CITGM result. The reruns were stopped after preserving the live diagnostic traces. | Ours-side browser behavior remains captured as an unresolved legacy-test-process hang. It is not being mislabeled as an upstream browser exception; the package's native Node failure independently establishes the non-green package/test-toolchain blocker. |

Rank 49 is recorded as `BLOCKED` only after the exact native Node run proved that
the package's own test contract fails outside the browser runtime. The browser
resolver defect found along the way was ours and is fixed and oracle-covered;
the remaining package blocker is the native-reproduced legacy `tap`/`esm`
dependency stack.

## Rank 49 gate evidence

The package remained non-green, so the repository-wide gates were run after the
resolver/oracle change and before committing the blocked record:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm json5  FAIL — native-citgm-node-v26.log; five tests fail through nested tap@12.6.0/esm
npm run citgm:browser:chromium -- json5             FAIL/incomplete — post-fix reruns reach upstream test execution; rerun logs preserve pending /node/node diagnostics
npm run citgm:browser:firefox -- json5              FAIL/incomplete — post-fix reruns reach upstream test execution; rerun logs preserve pending /node/node diagnostics
node --test --test-name-pattern='browser npm keeps legacy Rollup ranges on the native package' dev/tests/runtime/runtime/patch-regressions.mjs  PASS — rollup-legacy-green.log
npm run build                                         PASS — build-gate.log; 5 WASM artifacts
npm test                                              PASS — npm-test-gate-rerun-2.log; 346/346
npm run test:browser:chromium                        PASS — playwright-chromium-gate-rerun-1.log; 310/310
npm run test:browser:firefox                         PASS — playwright-firefox-gate-rerun-1.log; 310/310
```

The rank-49 native proof, initial ours-side resolver failures, post-fix browser
diagnostics, red/green oracle, manifest evidence, and final gate logs are
committed. The ordered cursor advances to rank 50.

## Rank 50 failure record

The exact candidate is `react-is@19.3.0`, tested from React gitHead
`1d34f91dfde6bba84d08b683aaba164c7194dacb`. The selected root manifest from
the exact React source archive is preserved at
`artifacts/citgm-top-100/rank-050-react-is/published-package.json`; complete
native, browser, diagnostic, and repository-gate artifacts are preserved under
`artifacts/citgm-top-100/rank-050-react-is/`.

| Run / log | Observed failure or behavior | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26.log` | Exact native Node CITGM fails before package tests during npm install with `ERESOLVE unable to resolve dependency tree`: the React root's `eslint:^7.7.0` resolves to `eslint@7.32.0`, while `eslint-plugin-ft-flow@2.0.3` declares peer `eslint:^8.1.0`. | Native proof that rank 50 is non-green outside the browser runtime. This is the upstream React repository's published test-toolchain dependency contract; no package source change, peer bypass, or fake dependency was added. |
| `citgm-chromium-run.log` | Chromium's non-peer-enforcing installer gets through the React workspace install and starts the exact test command, then fails twice with `Cannot find module 'jest-circus/runner'` from `jest-config`/`jest-cli`. | Separate browser observation, not the native proof for the classification. Browser network artifacts show `jest-circus@30.5.1` was fetched, and the focused CommonJS package `exports:./runner` oracle passes; there is therefore no evidenced shared-loader defect to fix and no fake `jest-circus` shim was added. |
| `citgm-firefox-run.log` | Firefox installs the same 158-package workspace and reaches candidate execution with lifecycle code 1, but the host artifact persistence step then fails with `Unknown system error -122` while writing the final CITGM artifacts. | Runner artifact-persistence failure, recorded separately and not used as package classification. The lifecycle failure is preserved; the Chromium log contains the decisive child-module diagnostic. |
| `exports-subpath-red.log` | The diagnostic export-subpath oracle passes for an equivalent CommonJS package with `exports: {"./runner":"./build/runner.js"}`. | Diagnostic only. It confirms the shared loader handles the relevant export subpath; no rank-specific change remains. |
| `jest-install-oracle.log` | An attempted in-browser VFS probe used an invalid test context and was rejected by the harness before exercising BrowserNpm. | Preserved investigative artifact, not package evidence and not used in the classification. Direct BrowserNpm inspection separately confirmed that `jest-circus/package.json` and `build/runner.js` are mounted. |

Rank 50 is recorded as `BLOCKED` only because the exact native Node run
independently fails the package's fresh-install contract. The native proof is
the ESLint peer conflict; the browser-only missing `jest-circus/runner` message
is recorded as an additional package/toolchain layout observation, not claimed
to be native-reproduced. No fake shim or package-specific compatibility path
was added.

## Rank 50 gate evidence

The package remained non-green, so the repository-wide gates were run before
committing the blocked record:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm react-is  FAIL — native-citgm-node-v26.log; ERESOLVE eslint@7 vs eslint-plugin-ft-flow peer eslint@8
npm run citgm:browser:chromium -- react-is             FAIL — citgm-1789368062535; Jest reports missing jest-circus/runner after install
npm run citgm:browser:firefox -- react-is              FAIL/persistence error — citgm-1789368144249; lifecycle code 1, final artifact write hit system error -122
npm test                                              PASS — npm-test-gate.log; 346/346
npm run test:browser:chromium                        PASS — playwright-chromium-gate.log; 310/310
npm run test:browser:firefox                         PASS — playwright-firefox-gate.log; 310/310
```

No repository source changes were made for rank 50. The native proof, both
browser runs, separate Firefox persistence error, diagnostic loader artifacts,
manifest evidence, and final gate logs are committed, and the ordered cursor
advances to rank 51.

## Rank 51 failure record

The exact candidate is `readdirp@5.1.1` at gitHead
`5dba3694a1de891ea6edb0301240326f8f8c81f1`. Its source archive contains the
TypeScript source and test, but not the built entrypoint required by its own
manifest and test. The selected exact manifest is preserved at
`artifacts/citgm-top-100/rank-051-readdirp/published-package.json`, the archive
entrypoint check is preserved at
`artifacts/citgm-top-100/rank-051-readdirp/source-archive-entrypoints.txt`, and
all native, browser, and repository-gate logs are preserved under
`artifacts/citgm-top-100/rank-051-readdirp/`.

| Run / log | Observed failure or behavior | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26.log` | Exact native Node CITGM installs `readdirp@5.1.1`, then its `node test/index.test.js` command fails before assertions with `ERR_MODULE_NOT_FOUND: Cannot find module '/tmp/.../readdirp/index.js' imported from .../test/index.test.js`. | Native proof that this is not a browser-runtime failure. The exact source archive omits the generated `index.js` even though `package.json` declares `main`/`exports` as `./index.js`; this is an upstream repository/archive build-layout failure. No generated file was injected into the candidate and no test shim was added. |
| `citgm-chromium-run.log` | Chromium installs 158 packages and reaches the exact test command; it fails with the same missing `readdirp/index.js` import. | Confirms the native-reproduced package-layout failure in Chromium. No separate browser defect was observed. |
| `citgm-firefox-run.log` | Firefox installs 157 packages and reaches the exact test command; it fails with the same missing `readdirp/index.js` import. | Confirms the native-reproduced package-layout failure in Firefox. No separate browser defect was observed. |
| `published-package.json`, `source-archive-entrypoints.txt` | The manifest declares `files: ["index.js", "index.d.ts"]`, `main: "./index.js"`, `exports: {".": "./index.js"}`, and test `node test/index.test.js`; the exact git archive contains `index.ts`, `package.json`, and `test/index.test.js`, but no `index.js`. | Direct evidence of the upstream package/source-archive mismatch. The package must publish/build the generated entrypoint or the archive/test contract must be corrected upstream. |

Rank 51 is recorded as `BLOCKED` only after the exact native Node run proved
the same source archive/build-layout failure outside the browser runtime. The
browser runs reproduce that missing generated entrypoint, so this is not being
classified from browser behavior alone and no harness workaround was added.

## Rank 51 gate evidence

The package remained non-green, so the repository-wide gates were run before
committing the blocked record:

```text
npm exec --yes --package=citgm@10.0.2 -- citgm readdirp  FAIL — native-citgm-node-v26.log; test imports missing index.js from exact git archive
npm run citgm:browser:chromium -- readdirp             FAIL — citgm-1789370427867; same missing index.js package-layout failure
npm run citgm:browser:firefox -- readdirp              FAIL — citgm-1789370458458; same missing index.js package-layout failure
npm test                                              PASS — npm-test-gate.log; 346/346
npm run test:browser:chromium                        PASS — playwright-chromium-gate.log; 310/310
npm run test:browser:firefox                         PASS — playwright-firefox-gate.log; 310/310
```

No repository source changes were made for rank 51. The native proof, both
browser confirmations, exact manifest/archive evidence, and final gate logs
are committed, and the ordered cursor advances to rank 52.

## Rank 52 failure record

The exact candidate is `commander@15.0.0` at gitHead
`ba6d13ddb4243e5913367734f8c159089ffe7834`. Complete native, browser, focused
regression, and repository-gate artifacts are preserved under
`artifacts/citgm-top-100/rank-052-commander/`.

| Run / log | Observed failure or behavior | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26.log` | The first exact native run failed only in commander’s color tests because this shell inherited `NO_COLOR=1`; commander intentionally gives that variable precedence over `FORCE_COLOR` and `CLICOLOR_FORCE`. | Harness-environment contamination, not a commander or upstream failure. The exact native rerun with `env -u NO_COLOR` passed; the clean proof is `native-citgm-node-v26-fixed.log`. |
| `native-citgm-node-v26-fixed.log` | Exact native Node CITGM installed the exact gitHead archive and passed the smoke test, including commander’s upstream tests and TypeScript checks. | Native proof that commander is healthy outside the browser. Any browser-only failure was therefore treated as ours until fixed; no upstream classification was used. |
| `citgm-chromium-run.log`, `citgm-firefox-run.log` | Initial browser runs exposed missing signal forwarding beyond the default termination trio, premature wrapper completion after `child.kill()`, and incorrect nested ESM executable/exit-code propagation. | Ours. The failures were reproduced by focused browser oracles and fixed in the shared runtime; no package-specific workaround or fake dependency was added. |
| `signal-regression-*-final.log`, `spawn-signal-diagnostic-chromium-fixed.log`, `spawn-sync-direct-shebang-chromium-fixed.log`, `self-signal-fixed-chromium.log` | Focused oracles pass for POSIX signal delivery, handled-signal child completion, direct shebang `spawnSync` exit status, and unhandled self-signal termination. | Ours-side compatibility proof. The runtime now bridges the full POSIX signal vocabulary across injected child boundaries, waits for the underlying virtual terminal, keeps runtime lifecycle state synchronized with guest `process.exit()`, and routes direct shebang nested ESM executables through the shared synchronous bridge. |
| `citgm-chromium-fixed-final-6.log` | Chromium CITGM run `citgm-1789375263249` installs commander and completes all upstream phases with exit code 0. | PASS after general runtime compatibility fixes. |
| `citgm-firefox-fixed-final.log` | Firefox CITGM run `citgm-1789375328593` installs commander and completes all upstream phases with exit code 0. | PASS after the same general runtime fixes. |

Rank 52 is recorded as `PASS` because the exact native Node run is green and
both browser CITGM runs are green after fixing failures that native Node does
not reproduce. The earlier `NO_COLOR` result is retained as an environment
diagnostic, not attributed to the package or upstream repository.

## Rank 52 gate evidence

The runtime and test changes required repository-wide gates. The full default
Playwright file set is covered in bounded groups because the long-running Next
integration test and Firefox ALS pressure test exceed the command wrapper’s
single-session lifetime; the groups together cover all 310 default tests in
each browser, with no files omitted.

```text
npm run build                                      PASS — 5 WASM artifacts; Node 22.23.2
npm test                                           PASS — gate-npm-test-final-network.log; 346/346
Chromium Playwright default files                  PASS — 310/310 across gate-chromium-*.log
Firefox Playwright default files                   PASS — 310/310 across gate-firefox-*.log
Focused virtual-process Chromium                  PASS — 7/7; virtual-process-entry-chromium-postfix.log
Focused virtual-process Firefox                   PASS — 7/7; virtual-process-entry-firefox-postfix.log
```

The gate logs include the two browser-specific integration applications,
bridge-runtime, ESM loader, async/ALS, platform, path, HTTP, storage,
performance, metadata, umask, node:test, VM, and assert files. The initial
incomplete full-run logs and the failed focused diagnostics remain preserved
alongside the green reruns. The rank-52 native proof, both exact browser CITGM
results, focused oracles, and repository gates are committed, and the ordered
cursor advances to rank 53.

## Rank 53 failure record

The exact candidate is `js-tokens@10.0.0` at gitHead
`d7ec3643eac02418881ddb46ec420cfc10a653ba`. The exact native Node run passed
before browser classification, so every browser-only failure below is recorded
as ours. All attempts, diagnostics, and final results are preserved under
`artifacts/citgm-top-100/rank-053-js-tokens/`.

| Run / log | Observed failure or behavior | Classification and resolution |
| --- | --- | --- |
| `native-citgm-node-v26-network.log` | Exact native Node CITGM downloaded the exact gitHead archive, installed it, and passed the smoke test in 17.8 seconds. | Native proof that the package and its dependency graph are healthy outside the browser. No upstream or nested-dependency classification was used. |
| `citgm-firefox-fixed-text-encoder.log`, `citgm-firefox-fixed-fd0.log`, `citgm-firefox-fixed-fd0-forwarded.log`, `citgm-firefox-fixed-fd0-forwarded-immediate.log` | Firefox exposed browser-only failures in the nested `esbuild-wasm` service: Go/WASM stdin reads re-entered the runtime, and `util.TextEncoder` returned a host typed array that failed the guest `Uint8Array` contract. | Ours. The runtime now adapts TextEncoder output into the guest typed-array realm, services fd 0 reads directly, and forwards stdin into ESM worker children without re-entering the Go/WASM callback. |
| `citgm-firefox-byte-preserving-final.log`, `esbuild-wasm-service-firefox-byte-preserving.log`, `citgm-chromium-ordered-vfs.log` | After the first fixes, preserving child output bytes exposed the actual Vitest snapshot mismatch (`InternalError: too much recursion` versus Node’s `RangeError`) and Chromium-only ENOENT races while Vitest read temporary SSR files. | Ours. The runtime normalizes Firefox’s regexp recursion error to Node’s RangeError, preserves raw child bytes, and orders parent VFS updates through the child IPC sequence so file contents arrive before the corresponding SSR path response. |
| `citgm-chromium-unref-fixed.log`, `citgm-firefox-unref-fixed.log`, `virtual-process-unref-esm-*.log` | Vitest’s esbuild service calls `child.unref()`. Ignoring that ref state kept a detached service in the virtual event-loop liveness calculation and caused shutdown failures. | Ours. Virtual child and worker handles now expose ref state, and lifecycle accounting honors `ChildProcess#unref()` after startup. The original IPC-channel `unref()` behavior remains intact. |
| `citgm-chromium-ordered-vfs.log`, `citgm-chromium-vm-filename.log`, `citgm-chromium-vm-filename-restored-ipc-unref.log` | Ordered VFS delivery removed ENOENTs but revealed Chromium inline-snapshot callsite collisions because `vm.Script({ filename })` evaluated through an anonymous host location. | Ours. `vm.Script` evaluation now attaches the requested filename via `sourceURL`; the permanent VM oracle verifies `/node/vm-script.js` callsites. Final Chromium CITGM passes all 8 files and 25,568/25,568 tests. |
| `citgm-firefox-vm-filename-restored-ipc-unref.log` | Final Firefox CITGM passes all 8 files and 25,568/25,568 tests; Vitest exits 0 with zero child stderr and no lifecycle warning. | PASS. This is the final Firefox result after the complete runtime fix set. |
| `citgm-chromium-vm-filename-restored-ipc-unref.log` | Final Chromium CITGM passes all 8 files and 25,568/25,568 tests; Vitest exits 0 with zero child stderr. | PASS. This is the final Chromium result after the complete runtime fix set. |

Rank 53 is recorded as `PASS`: exact native Node CITGM passed, and both browser
CITGM runs passed after fixing browser-runtime behavior. No failure was
classified as an upstream package, repository, or nested-dependency blocker.
The initial sandbox DNS failure is preserved as an environment diagnostic and
was not used as a package result.

## Rank 53 gate evidence

Because runtime and regression-test changes were required, all repository-wide
gates were run after the final source state. The full Playwright suite is
covered in bounded groups because the Next.js App Router test is a multi-minute
single test; the groups together cover every default test with no omissions.

```text
npm run build                                      PASS — build-final.log; 5 WASM artifacts; Node 22.23.2
npm test                                           PASS — npm-test-final-network.log; 346/346
Chromium Playwright main files                    PASS — playwright-chromium-group-main-final.log; 313/313
Chromium Playwright Next.js demo                  PASS — playwright-chromium-nextjs-final.log; 1/1
Firefox Playwright main files                     PASS — playwright-firefox-group-main-final.log; 313/313
Firefox Playwright Next.js demo                   PASS — playwright-firefox-nextjs-final.log; 1/1
Focused platform diagnostic                       PASS — platform-primitives-chromium-diagnostic.log; 7/7
Focused worker regression                         PASS — unit-worker-diagnostics-fixed.log; 4/4
```

The first sandboxed unit-gate log and the interrupted initial full Chromium
runner are retained in the same artifact directory as diagnostics; the
network-enabled unit gate and bounded browser groups are the authoritative
green results. The ordered cursor advances to rank 54 only after this record
is committed cleanly.
