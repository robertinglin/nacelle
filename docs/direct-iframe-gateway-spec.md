# Direct Iframe Gateway

## Status

Implementation contract. This document specifies the CDN-safe iframe transport for
Nacelle. It is intentionally separate from the existing Service Worker gateway
so the current path remains stable while the direct transport is implemented and
validated.

## 1. Problem

Nacelle's virtual HTTP server is inside the browser runtime. An iframe cannot
reach that server by navigating to `http://localhost:3000` because the port is
virtual, not a host TCP port. The current solution registers a Service Worker on
the application origin. The worker intercepts a virtual-host URL, forwards the
request to the Nacelle bridge, and returns the virtual response.

That model has a hard CDN boundary:

- `Nacelle` may be imported from `https://esm.sh/...`.
- `ServiceWorkerContainer.register()` runs against the application origin.
- The default `/runtime/gateway-sw.js` URL therefore resolves on the
  application origin, not against the CDN module's package files.
- A CDN-hosted worker cannot control an unrelated application origin.

The direct iframe gateway removes the Service Worker requirement for this case.
It keeps the virtual HTTP server and the parent-page Nacelle bridge in the
same browser context and moves request interception into an explicit,
session-scoped `postMessage` protocol.

## 2. Goals

The direct transport must:

1. Run when Nacelle is imported from a CDN without requiring the application to
   copy a worker asset.
2. Preserve the existing `node.connectIframe(iframe, options)` public API.
3. Support ordinary HTTP navigation, response headers, response bodies, redirects,
   query strings, forms, and common subresources.
4. Stream stdout-independent HTTP activity without buffering an entire response
   when the virtual server is streaming.
5. Support virtual WebSockets through the same parent/iframe session.
6. Keep the virtual server in the Nacelle process and preserve existing
   capability checks.
7. Isolate untrusted application code from the host page with a sandboxed iframe.
8. Make transport choice observable and deterministic.
9. Allow callers to force either transport for testing and compatibility.

## 3. Non-goals

The first implementation does not attempt to:

- Make a virtual server reachable from arbitrary tabs or host applications.
- Expose a real host TCP port.
- Emulate browser cookies, service-worker caches, or host-origin storage inside
  the virtual application.
- Bypass CSP, CORS, or sandbox rules silently.
- Preserve every browser navigation feature before the core request path is
  stable.
- Replace the existing Service Worker gateway for same-origin deployments.
- Turn arbitrary cross-origin pages into trusted same-origin documents.

Unsupported behavior must be reported as a structured gateway error. It must
not fall back to a host network request that could leak a virtual URL or request
body.

## 4. Public configuration

`gateway` remains enabled by default.

```js
await Nacelle.create({
  gateway: true,
});
```

The option accepts either a boolean or a configuration object:

```ts
type GatewayMode = 'auto' | 'service-worker' | 'direct-iframe';

interface GatewayOptions {
  mode?: GatewayMode;
  scope?: string;
  swPath?: string;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  maxConcurrentRequests?: number;
}
```

Examples:

```js
// CDN-safe default. `auto` selects direct iframe mode for a CDN-loaded runtime.
const node = await Nacelle.create({ gateway: true });

// Force the existing worker path for an application that hosts the asset.
const node = await Nacelle.create({
  gateway: { mode: 'service-worker', swPath: '/runtime/gateway-sw.js' },
});

// Force the new path during migration or browser testing.
const node = await Nacelle.create({
  gateway: { mode: 'direct-iframe' },
});

// Disable all iframe gateway setup.
const node = await Nacelle.create({ gateway: false });
```

### 4.1 Transport selection

`auto` uses this decision table:

| Runtime and host | Selected mode |
| --- | --- |
| `gateway: false` | disabled |
| Explicit `service-worker` | Service Worker; registration failure is surfaced |
| Explicit `direct-iframe` | Direct iframe/message proxy |
| Runtime module and page are same-origin, worker asset is available | Service Worker |
| Runtime module is cross-origin from the page, including esm.sh | Direct iframe |
| Service Worker unavailable | Direct iframe |
| Same-origin worker registration fails | Direct iframe, with a diagnostic event |

CDN detection is based on the origin of the loaded Nacelle module and the page
origin, not on a hard-coded list of CDN hostnames. `import.meta.url` is the
module identity for ESM builds. The CommonJS browser entry must pass the loaded
ESM implementation's module identity through the same internal runtime record.

The selected mode is exposed in a read-only runtime diagnostic:

```js
node.gateway.mode // 'service-worker' | 'direct-iframe' | 'disabled'
```

## 5. Architecture

### 5.1 Components

The implementation is split into four small components:

1. `gateway-selection` chooses the transport and records why it was chosen.
2. `direct-iframe-gateway` owns one parent/iframe session and the request map.
3. `direct-iframe-bootstrap` is the small script injected into the sandboxed
   iframe document. It never receives the Nacelle object or a raw virtual socket.
4. `direct-iframe-resources` rewrites and loads document subresources through
   the parent bridge.

The existing `gateway-bridge` remains the Service Worker transport adapter. The
virtual network and HTTP parser remain shared; only the browser-facing delivery
transport changes.

### 5.2 Iframe lifecycle

The parent must create the iframe with a sandbox before assigning content:

```html
<iframe sandbox="allow-scripts allow-forms" src="about:blank"></iframe>
```

The direct session lifecycle is:

```text
created
  -> iframe-attached
  -> bootstrap-sent
  -> ready
  -> navigating
  -> loaded
  -> navigating ...
  -> closing
  -> closed
```

The parent creates a fresh random session nonce and a `MessageChannel`. It
assigns `iframe.srcdoc` to the bootstrap document and transfers one port to the
iframe with an `init` message. The bootstrap replies with `ready` and the same
nonce. Messages from any other source, with any other nonce, or with an invalid
protocol version are discarded and recorded as protocol errors.

The sandbox deliberately does not include `allow-same-origin`. The iframe can
execute the virtual application but cannot read or mutate the parent document,
parent storage, or parent JavaScript objects. The parent authenticates the
opaque-origin iframe using the transferred port, source identity, session nonce,
and a monotonic sequence number.

### 5.3 Navigation

The public `path` remains a clean application path such as `/`, `/api/info`, or
`/hello?name=Developer`. Internal virtual-host prefixes never appear in the
user-facing URL bar.

To navigate:

1. The parent validates and normalizes the clean path.
2. The parent sends a `navigate` message to the iframe session.
3. The parent dispatches an HTTP request to the virtual network.
4. The response is streamed to the iframe resource loader.
5. HTML is transformed with the bootstrap/resource bridge and assigned to
   `iframe.srcdoc`.
6. The iframe sends `loaded` or `navigation-error`.

Links and forms inside the sandbox are intercepted by the bootstrap before the
browser attempts a host navigation. The bootstrap sends a clean path to the
parent; it never constructs a host URL from a virtual port.

History behavior is explicit:

- `pushState` and `replaceState` are mirrored to the parent as `history` events.
- Back/forward requests are handled by the parent session.
- A route is considered committed only after the corresponding response starts.
- Failed navigations do not overwrite the last committed path.

## 6. Message protocol

Every message is a structured-clone object with this envelope:

```ts
interface GatewayEnvelope {
  protocol: 'nacelle-direct-gateway';
  version: 1;
  sessionId: string;
  nonce: string;
  sequence: number;
  type: string;
  payload: unknown;
}
```

Sequences are monotonic per sender. A duplicate sequence is ignored. A gap is
reported and causes the current request to fail closed; the session is not
silently resynchronized.

### 6.1 Session messages

```text
parent -> iframe  init       { port, path, capabilities }
iframe -> parent  ready      { bootstrapVersion }
parent -> iframe  navigate   { requestId, path, method, headers, body }
iframe -> parent  cancel     { requestId }
iframe -> parent  loaded     { requestId, path, title }
iframe -> parent  error      { requestId, code, message }
parent -> iframe  close      {}
```

The `capabilities` payload contains only client features, not Nacelle grants:

```json
{
  "fetch": true,
  "xhr": true,
  "websocket": true,
  "resourceRewrite": 1
}
```

### 6.2 HTTP request messages

```text
iframe -> parent  http-request {
  requestId,
  method,
  url,
  headers,
  body,
  mode,
  credentials,
  redirect
}
```

`url` is a clean virtual path or an absolute URL whose authority is the virtual
server. The parent rejects host-origin URLs, `javascript:`, `data:`, `file:`,
and unknown protocols. Headers are normalized to lowercase and restricted from
including browser-controlled hop-by-hop headers.

The response is streamed:

```text
parent -> iframe  http-response-start {
  requestId,
  status,
  statusText,
  headers,
  contentType,
  redirected,
  finalUrl
}
parent -> iframe  http-response-chunk { requestId, bytes }
parent -> iframe  http-response-end   { requestId }
parent -> iframe  http-response-error { requestId, code, message }
```

Bodies use `Uint8Array` transferables where possible. A chunk is detached after
transfer and cannot be reused by the sender. The parent enforces configured
body and concurrent-request limits before opening a virtual socket.

### 6.3 WebSocket messages

The bootstrap exposes a `WebSocket`-compatible class for virtual URLs. Its
frames use a separate request identifier but the same session envelope:

```text
iframe -> parent  ws-open   { socketId, url, protocols }
parent -> iframe  ws-opened { socketId, protocol }
iframe -> parent  ws-send   { socketId, bytes, binary }
parent -> iframe  ws-message { socketId, bytes, binary }
iframe -> parent  ws-close  { socketId, code, reason }
parent -> iframe  ws-error  { socketId, code, message }
parent -> iframe  ws-closed { socketId, code, reason }
```

The existing virtual WebSocket bridge is reused below this protocol. A socket
cannot outlive its iframe session.

## 7. Resource loading

An iframe document cannot rely on a Service Worker to intercept parser-created
requests. The direct transport therefore has two layers.

### 7.1 Bootstrap APIs

The injected bootstrap patches only the sandbox's own APIs:

- `fetch`
- `XMLHttpRequest`
- `WebSocket`
- navigation clicks and form submission
- `history.pushState`, `history.replaceState`, and `popstate`

These patches turn virtual requests into protocol messages. Native host URLs are
left alone only when they pass the explicit external-resource policy.

### 7.2 Parser-created resources

Before assigning an HTML response to `srcdoc`, the parent rewrites supported
resource attributes. Each virtual resource is fetched through the parent and
represented by a Blob URL owned by the parent document. The first implementation
must cover:

- `script[src]`
- `link[href]` for stylesheets and module imports
- `img[src]`, `source[src]`, and `video[src]`
- `iframe[src]` as a nested direct session or a documented unsupported case
- `form[action]`
- `a[href]` for navigation interception

Relative URLs resolve against the virtual response URL. Absolute host URLs are
not rewritten unless `allowExternalResources` is explicitly enabled in a future
option. Blob URLs are revoked when their owning document or request session is
closed.

CSS `url(...)` and `@import` references require a second rewrite pass for
stylesheet responses. The initial implementation must either rewrite them
recursively or return a visible `ERR_GATEWAY_RESOURCE_UNSUPPORTED` diagnostic;
it must not silently request the original virtual URL from the host.

## 8. Parent-side request handling

`direct-iframe-gateway` owns a `Map<requestId, RequestState>`:

```text
RequestState {
  requestId,
  kind: http | websocket,
  startedAt,
  abortController,
  bytesReceived,
  phase: queued | connected | streaming | complete | failed | cancelled
}
```

The handler:

1. Validates the envelope and session.
2. Normalizes the target path.
3. Checks request count, body size, and timeout limits.
4. Opens the virtual network connection through the existing Nacelle net
   implementation.
5. Sends response-start, chunks, and response-end in order.
6. Cancels the socket when the iframe sends `cancel`, the timeout fires, or the
   session closes.
7. Removes the request state after terminal delivery.

No request may be routed through `globalThis.fetch` unless it is an explicitly
allowed external request. This avoids accidentally sending a virtual path to
the host origin.

## 9. CDN selection and lifecycle

The browser entry records its module URL before creating the runtime:

```js
const runtimeModuleUrl = import.meta.url;
```

The selection helper receives:

```text
selectGateway({
  requestedMode,
  runtimeModuleUrl,
  pageUrl,
  serviceWorkerAvailable,
  serviceWorkerPath,
}) -> GatewaySelection
```

The result includes:

```text
GatewaySelection {
  mode,
  reason,
  runtimeOrigin,
  pageOrigin,
  workerPath,
}
```

For a CDN module, `mode: 'direct-iframe'` is the default. Nacelle must not
attempt the known-invalid page-relative worker URL first, because that creates a
misleading 404 and a delayed gateway failure. The Service Worker path is tried
only for an explicit `service-worker` request or a same-origin `auto` selection.

Creating a Nacelle runtime does not create an iframe session. The session is
created by `connectIframe` and is closed by the unsubscribe function returned by
that method. `Nacelle` shutdown/reset must close all active sessions and abort all
pending requests.

## 10. Failure behavior

Errors use stable codes:

```text
ERR_GATEWAY_MODE
ERR_GATEWAY_SESSION
ERR_GATEWAY_PROTOCOL
ERR_GATEWAY_SEQUENCE
ERR_GATEWAY_REQUEST_LIMIT
ERR_GATEWAY_BODY_LIMIT
ERR_GATEWAY_TIMEOUT
ERR_GATEWAY_NAVIGATION
ERR_GATEWAY_RESOURCE_UNSUPPORTED
ERR_GATEWAY_CLOSED
```

Rules:

- A Service Worker registration failure in forced worker mode rejects creation.
- An automatic worker failure selects direct mode only before any iframe session
  is created.
- Direct-mode protocol failure fails the affected request and records a bounded
  diagnostic; it does not fall back to host networking.
- Closing a session cancels all pending requests and emits one terminal close
  event.
- A malformed message is ignored after recording a protocol error. It cannot
  invoke a virtual network operation.
- Timeouts abort the virtual socket and return a deterministic error response.

## 11. Security model

The direct iframe is an untrusted execution surface.

Required controls:

- Use `sandbox="allow-scripts allow-forms"` without `allow-same-origin`.
- Use an unpredictable per-session nonce in every envelope.
- Validate `event.source`, transferred port identity, protocol version, nonce,
  and sequence before processing a message.
- Never expose the Nacelle object, runtime internals, capability manifest, or
  parent DOM to the iframe.
- Never forward host cookies, authorization headers, or ambient credentials.
- Default request credentials to `omit`.
- Enforce body, response, request-count, and concurrency limits.
- Keep all virtual network operations behind the existing capability boundary.
- Do not allow the iframe to choose a host destination or port.
- Revoke Blob URLs and close MessagePorts on navigation and session teardown.
- Treat all virtual response headers and HTML as untrusted data.
- Inject only the fixed, versioned bootstrap source; never interpolate user code
  into the bootstrap JavaScript.

The parent must not use `targetOrigin: '*'` for messages to a non-opaque client.
For the sandboxed `srcdoc` client, the opaque-origin exception is allowed only
when the source object and nonce checks are both present.

## 12. Implementation plan

### Phase 1: contracts and selection

- Add `GatewayMode`, `GatewayOptions`, and `GatewaySelection` types.
- Add `selectGateway` as a pure function with unit tests for same-origin,
  CDN-origin, explicit mode, unavailable Service Worker, and invalid options.
- Add a gateway diagnostic to the runtime instance.
- Preserve the current Service Worker path unchanged.

### Phase 2: direct session transport

- Add `src/runtime/direct-iframe-gateway.js`.
- Add the fixed bootstrap source as a dedicated module; keep it separate from the
  large runtime assembly.
- Implement handshake, envelope validation, sequence checks, request map, and
  teardown.
- Add HTTP request/response streaming over MessagePorts.

### Phase 3: document and resource loading

- Implement HTML navigation and clean-path history.
- Add the fetch/XHR/WebSocket bootstrap adapters.
- Add safe rewriting for the first resource attribute set.
- Add Blob URL ownership and revocation.
- Add CSS/resource diagnostics for unsupported cases.

### Phase 4: automatic CDN mode

- Route CDN-loaded browser entries to direct mode by default.
- Keep explicit `service-worker` mode for applications that host the asset.
- Add a CDN browser example that imports directly from esm.sh and runs an HTTP
  server in a sandboxed iframe.
- Update the README with both deployment modes and the security tradeoffs.

### Phase 5: hardening and rollout

- Run the direct transport behind a development feature flag first.
- Compare direct and Service Worker response traces for the same fixture suite.
- Make direct mode the `auto` result for cross-origin module imports only after
  the acceptance matrix is green.
- Remove any application-specific gateway asset workarounds from examples after
  the Nacelle package path is published and verified.

## 13. Test plan

Tests are scoped to the changed gateway components, followed by the full suite.
The direct gateway must maintain at least 80% line, branch, and function
coverage for its new modules.

### Unit tests

- Gateway mode selection and CDN detection.
- Envelope validation, nonce checks, source checks, and sequence gaps.
- URL normalization and host URL rejection.
- Header filtering and body-size limits.
- Request cancellation and timeout cleanup.
- Blob URL creation and revocation ownership.
- HTML/resource URL rewriting, including query strings and fragments.

### Browser tests

- Import Nacelle from esm.sh and confirm no `/runtime/gateway-sw.js` request is
  attempted in automatic CDN mode.
- Run a virtual Express server and load `/` in a sandboxed iframe.
- Verify stdout is independent from iframe response delivery.
- Verify `fetch`, XHR, links, forms, history, redirects, and query strings.
- Verify streamed response chunks and early cancellation.
- Verify a virtual WebSocket can open, send, receive, and close.
- Verify a malicious iframe message cannot issue a request.
- Verify the same app can force Service Worker mode when the host serves the
  worker asset.
- Verify Service Worker unavailable -> direct mode in `auto`.
- Verify all pending operations terminate when the iframe is removed.

### Acceptance criteria

1. CDN import plus `Nacelle.create()` selects direct mode without a worker 404.
2. `connectIframe` renders an Express `/` response in the sandboxed iframe.
3. The URL bar contains clean virtual paths, never `__vhost__` paths.
4. No virtual request appears as a host-origin request in browser network logs.
5. Service Worker mode remains compatible with the existing examples.
6. Forced mode failures are explicit and actionable.
7. All changed code has sane scoped tests and the full suite passes.

## 14. Open decisions

These decisions must be resolved before implementation begins:

1. Whether nested iframes are supported in Phase 3 or reported unsupported.
2. Whether external resources are always denied or allowed behind an explicit
   per-session policy.
3. The maximum default response size and concurrent request count.
4. Whether the direct bootstrap is emitted as a static string module or generated
   by the build from a source file.
5. Whether an application may provide a custom resource rewriter for frameworks
   that use non-standard asset attributes.

The implementation must not silently choose any of these policies. Each choice
belongs in the public gateway diagnostics and test fixtures.


## 15. Resolved implementation policies and browser constraints

The implementation resolves section 14 as follows: nested iframes are
unsupported; external resources are denied; limits default to 16 MiB and 32
concurrent operations; the bootstrap is a fixed, versioned function-source
module; custom resource rewriters are unsupported. These decisions are visible
in `node.gateway.policy` and covered by the contract fixtures. Requests,
responses, WebSocket messages and aggregate document assets are bounded. The
shared HTTP framing parser is used by both browser-facing adapters, with the
legacy worker response envelope and cookie-header policy retained.

Two browser constraints require explicit delivery details beyond the proposed
outline. First, an opaque sandbox cannot reliably fetch parent-origin Blob
URLs. The parent therefore retains its Blob catalog and transfers Blob objects
in the authenticated `init` payload; the bootstrap creates document-local URL
mirrors in dependency order. Both ownership sets are torn down on navigation or
close. Application markup is an inert `documentHtml` payload, not interpolated
into the fixed bootstrap or parsed before the authenticated channel is ready.
Classic scripts are activated in order after DOM staging; deferred and module
scripts follow. Inline modules are represented by local Blob scripts so their
completion is observable. Parser timing is not identical to native navigation.
Second, HTML navigation requires bounded buffering for safe resource rewriting;
fetch HTTP bodies stream independently of stdout and navigation buffering.

Complete hostile-code network-egress isolation is **not** provided by the
specified sandbox/CSP primitives. They isolate parent DOM/storage and block
unbridged fetch/subresource/form requests, but do not prohibit every script-driven
self-navigation (for example `location.href`). Unmanaged navigation closes the
session when its load is detected, which can occur after network dispatch.
Thus section 11's parent isolation and bridged-request controls are implemented,
but an absolute no-host-request guarantee for arbitrary hostile scripts needs
an additional browser-level network policy. There is no silent native-network
fallback in any gateway adapter.

The implementation reports unsupported response encodings, integrity metadata,
import maps, computed/cyclic module graphs, escaped CSS URL syntax and dynamic
unbridged resources. Response CSP/X-Frame-Options and document CSP that cannot be
preserved across rewriting fail explicitly. The host's own CSP remains in force.
No claim is made that every original acceptance item is verified: live published
CDN/Express, secure-origin worker browser parity and Firefox require the
validation environments described in the accompanying validation record.
