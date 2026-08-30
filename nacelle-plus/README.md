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
- bounded response bodies and credentials omitted by default

The protocol reserves `connect`, `send`, `resolve`, and credential operations,
but this first companion release implements HTTP requests only. Raw socket
bridging and secure credential storage should be added as separately granted
capabilities when the browser APIs and threat model are settled.

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
});
```

When `nacellePlus` is enabled, Nacelle selects its existing capability-gated
proxy path. The negotiated adapter tries the ordinary page fetch first and
uses the extension only after that fetch rejects with a browser network
failure. No extension is contacted for requests that already work normally.
