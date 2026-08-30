# Nacelle+

Nacelle+ is an optional WebExtension companion for the Nacelle runtime. It is
not another Node runtime. Nacelle continues to own the virtual filesystem,
workers, modules, and browser-native execution; Nacelle+ only supplies an
explicitly granted HTTP transport when a page request is rejected by CORS.

## Current slice

- Chrome Manifest V3 service worker and Firefox Manifest V2 background page
- page/content-script message bridge with no page code execution in the extension
- per-page-origin and target-origin permission grants
- native `fetch` first, extension fetch fallback on browser network failures
- manual redirect walking with a fresh grant check for every destination
- long-lived port streaming with incremental response limits and cancellation
- bounded request/response bodies and credentials omitted by default
- inspectable/revocable persistent grants in the extension popup
- private-network origins require a separate explicit grant

The protocol reserves `connect`, `send`, `resolve`, and credential operations,
but this first companion release implements streamed HTTP requests only. Raw
socket bridging and secure credential storage should be added as separately
granted capabilities when the browser APIs and threat model are settled.

Request headers controlled by the browser (`Host`, `Origin`, `Referer`,
`Cookie`, `Content-Length`, connection/proxy headers, and `Set-Cookie`) are
rejected. `Authorization` may be supplied explicitly for the initially
granted origin and is removed when a redirect crosses origins. Response
`Set-Cookie` headers are never exposed.

The service worker is kept active during long transfers by a content-script
heartbeat and one-chunk-at-a-time acknowledgements. If Chrome or Firefox still
disconnects the port, the in-flight request is cancelled rather than replayed;
the page may issue a new request, avoiding duplicate POSTs.

## Install for development

Build the loadable browser-specific directories first:

```sh
npm run build:nacelle-plus
```

Load `nacelle-plus/dist/chrome/` or `nacelle-plus/dist/firefox/` as an
unpacked extension. Open the extension popup on an application page, enter the
API origin, and approve the browser permission. The grant is stored by page
origin and target origin. The source manifests remain in `extension/` for
review and packaging.

## Use from Nacelle

```js
import { Nacelle } from 'nacelle';

const node = await Nacelle.create({
  nacellePlus: {
    // The page bridge also works without this informational identifier when
    // only one Nacelle+ installation is present.
    extensionId: 'your-extension-id',
    fallback: true,
  },
  proxy: { mode: 'proxy', enabled: true, capability: { proxy: true } },
});
```

When `nacellePlus` is enabled, Nacelle selects its existing capability-gated
proxy path only when the Nacelle capability is explicitly granted. The
extension's browser host permission and Nacelle's run-scoped capability are
separate checks. The negotiated adapter tries the ordinary page fetch first and uses the
extension only after that fetch rejects with a browser network failure. No
extension is contacted for requests that already work normally. Grants are
persistent until revoked from the extension popup; private-network targets
need a separate explicit checkbox grant.
