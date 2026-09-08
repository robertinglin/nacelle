# Direct iframe gateway validation

This record distinguishes executed checks from remaining live-environment
acceptance work. It is not a claim that the complete release gate is green.

## Executed checks

The implementation was tested with Node 22 and a locally installed Chromium.

| Check | Result |
| --- | --- |
| Scoped gateway contracts | 40 passed, no failures or skips |
| Scoped gateway coverage | 98.03% lines, 94.27% branches, 90.69% functions |
| Chromium direct-mode integration | 4 passed; secure-origin Service Worker case skipped |
| Full runtime suite | 259 passed, 10 failed while downloading npm packages |
| Untouched baseline runtime suite | 219 passed, the same 10 npm-download failures |
| Node 22 build and package dry run | Passed; 144 package files validated |
| Node version/artifact validation | Passed |
| Declaration type-check | Passed with strict TypeScript and ES2022/DOM libraries |
| Changed JavaScript, test and CDN-example script syntax | Passed |
| Release-gate contract tests | 2 passed |

The ten full-suite failures are the existing registry-backed bcryptjs, Drizzle,
TypeScript, uvu, Rollup, ws, pg and React SSR demo tests, plus the npm-shell
TypeScript and React SSR tests. Each fails during registry metadata/package
fetching. The failure names were compared against an independently built,
untouched checkout. No additional runtime failures were observed.

### Coverage by production module

| Module | Lines | Branches | Functions |
| --- | ---: | ---: | ---: |
| `direct-iframe-bootstrap.js` | 100.00% | 90.97% | 90.59% |
| `direct-iframe-gateway.js` | 92.10% | 90.20% | 84.21% |
| `direct-iframe-protocol.js` | 100.00% | 99.12% | 100.00% |
| `direct-iframe-resources.js` | 100.00% | 97.45% | 95.00% |
| `direct-iframe-websocket.js` | 100.00% | 93.25% | 92.86% |
| `gateway-http.js` | 100.00% | 99.32% | 100.00% |
| `gateway-selection.js` | 100.00% | 100.00% | 100.00% |

Coverage uses Node's V8 instrumentation of the production modules. Bootstrap
contract tests execute the actual exported fixed source in a VM, preserving
source offsets for coverage attribution; they do not maintain a second
implementation. DOM fixture tests are complemented by real Chromium DOM,
opaque iframe, MessageChannel, script/module, CSS and Blob URL integration tests.

## Reproduction

```sh
npm run test:gateway
npm run test:gateway:coverage
npm test
npm run verify:package
npm run validate:versions
node --test dev/tests/runtime/runtime/release-gate.mjs
# Requires an installed TypeScript compiler:
tsc --noEmit --strict --lib es2022,dom --module nodenext \
  --moduleResolution nodenext src/types.d.ts
```

For normal browser acceptance, install the existing Playwright adapter and its
browsers. The test runner serves the checked-out runtime on localhost; its
cross-origin case uses a different host origin and verifies that automatic
selection never requests a worker asset. Its worker case serves the same
fixture through the existing Service Worker transport.

```sh
npm ci --prefix dev/adapters/playwright
npx --prefix dev/adapters/playwright playwright install chromium firefox
BNH_BROWSER=chromium npm run test:gateway:browser
BNH_BROWSER=firefox npm run test:gateway:browser
npm run test:full
```

`BNH_PLAYWRIGHT_MODULE` optionally specifies an installed Playwright module;
`BNH_BROWSER_EXECUTABLE` optionally specifies a browser executable. The local
Chromium execution used both overrides and `BNH_GATEWAY_IN_MEMORY=1`, because
managed browser policy prevented top-level navigation to the fixture origin.
In this explicit fallback, Playwright serves ESM reads in memory to an
`about:blank` host. Sandbox, DOM, channels and Blob resources still use the
actual browser. Test-only WebCrypto digest bridging supplies SHA-1 for the
WebSocket handshake because this host lacks secure-context SubtleCrypto.
Production source does not contain this shim. The secure-origin worker test is
skipped explicitly; this mode is not a substitute for normal browser acceptance.

## Scope of the fixtures

Contracts exercise mode selection and failures, immutable public diagnostics,
preview capability enforcement, native-global capture, runtime reset/shutdown,
source/nonce/version/sequence validation, malformed envelopes, URL and header
filtering, request and response limits, cancellation, timeouts, redirects,
streaming HTTP framing, WebSocket framing and upgrades, resource recursion and
limits, Blob ownership, navigation replacement and session cleanup. The shared
HTTP parser is also exercised through the legacy worker delivery adapter,
including its retained response envelope and cookie-header arrays.

Browser fixtures execute the real virtual `node:http` server and upgrade stack,
not a simulated network adapter. They verify independent stdout, response
headers, fetch/XHR, streamed bodies, early cancellation, redirects, WebSocket
text/binary exchange, links, forms, history, query strings, scripts and literal
ESM dependencies, recursive CSS, images, opaque parent isolation, unsupported
resource diagnostics, removal with pending operations, and absence of virtual
or denied-resource URLs in host request logs for these interactions.

## Outstanding acceptance checks and constraints

A live esm.sh import of a **published release containing these changes**, with
registry-installed Express, was not executed. `examples/direct-iframe-cdn.html`
provides this scenario and checks that the selected package actually exposes
the direct gateway. Its default `n22` tag must be updated/pinned after publishing;
a pre-existing package release does not include local changes. Registry access
is also required to resolve the ten baseline test failures.

Secure-origin Service Worker browser parity, Firefox integration and the
complete browser/release gate were not executed successfully in this environment.
The normal runner includes the worker case and the release gate invokes the
new gateway coverage and both browser engines without the in-memory override.

The mandated opaque sandbox protects parent DOM/storage but cannot prohibit
arbitrary script-driven self-navigation. An unmanaged navigation is detected on
load, potentially after host network dispatch. Bridged APIs never use a native
network fallback, but the spec's absolute no-host-request guarantee for arbitrary
hostile JavaScript requires an additional browser-level egress restriction.
The implementation and README expose this limitation rather than treating the
controlled-fixture network assertions as a proof of complete egress isolation.

HTML navigation is bounded-buffered for rewriting; HTTP fetch bodies stream.
Document-local Blob mirrors are necessary in the opaque sandbox, and DOM staging
is not identical to native parser-blocking script execution. Unsupported CSP,
framing, encoding, integrity and resource cases fail explicitly as described in
the spec's resolved-policy section.
