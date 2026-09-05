# nacelle

**Self-contained Node.js execution engine and virtual runtime in the browser.**

Powered by WebAssembly, Web Workers, Virtual Filesystems (VFS), and in-browser networking, `nacelle` lets you run Node.js code, standard libraries, and npm packages directly inside client browsers with zero server execution.

---

## Node 22 Alpha

The alpha ships one target: Node 22, referenced against native Node 22.23.2
(module ABI 127, Node-API 10). `latest`, `lts`, `n22`, and the `nacelle/v22`
subpath all select that same runtime. Other majors and the `current` alias are
rejected instead of silently falling back.

## Installation & Release Channels

Install `nacelle` using your preferred package manager and release channel:

```bash
# Install the Node 22 major channel
npm install nacelle@n22

# Or install the latest default release
npm install nacelle@latest
```

### CDN / Direct Browser Import (ESM)

You can import `nacelle` directly in browser scripts via modern CDNs:

```html
<script type="module">
  import { Nacelle } from 'https://esm.sh/nacelle@n22';

  const node = await Nacelle.create({
    files: {
      '/app/index.js': `console.log('Hello from Node ' + process.version + ' in your browser!');`
    }
  });

  const proc = await node.run({ entry: '/app/index.js' });
  console.log(await proc.stdoutText());

  // Run shell lines directly in the virtual filesystem
  const shell = await node.bash('NODE_ENV=production echo "$NODE_ENV" | sed \'s/production/ready/\'');
  console.log(await shell.stdoutText());
</script>
```

---

## Quick Start

### 1. High-Level API (`Nacelle`)

```javascript
import { Nacelle } from 'nacelle';

// Initialize an in-browser Node engine instance
const node = await Nacelle.create({
  cwd: '/workspace',
  env: { NODE_ENV: 'development' },
  files: {
    '/workspace/server.js': `
      const http = require('http');
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Hello from in-browser HTTP server!' }));
      });
      server.listen(3000, () => {
        console.log('Server listening on http://localhost:3000');
      });
    `
  }
});

// Run a script in an isolated Web Worker child process (browser runtimes)
const proc = await node.run({ entry: '/workspace/server.js' });

// Read stdout
console.log(await proc.stdoutText());

// File System (VFS) Operations
await node.fs.writeFile('/workspace/data.txt', 'Hello VFS');
const content = await node.fs.readFile('/workspace/data.txt', 'utf8');

// In-Browser NPM package installation
await node.npm.install('express');
```

---

## Features

- 🌐 **60+ Node Built-in Modules**: `node:fs`, `node:http`, `node:http2`, `node:tls`, `node:crypto`, `node:buffer`, `node:stream`, `node:events`, `node:path`, `node:process`, `node:child_process`, `node:worker_threads`, `node:zlib`, `node:sqlite`, `node:net`, `node:dgram`, `node:dns`, `node:test`, `node:vm`, `node:v8`, `node:os`, `node:assert`, and more.
- ⚡ **WebAssembly Artifact Loader**: Integrity-checked, export-validated low-level `sqlite`, `zlib`, and standard Node-API bridge artifacts. A listed artifact is not described as a working Node binding until a subsystem parity test wires and verifies it.
- 📁 **Virtual POSIX Filesystem (VFS)**: Isolated in-memory filesystem with synchronous and asynchronous operations, streams, and file descriptors.
- 🧵 **Web Worker Isolation**: Optional true multi-threaded process execution via Web Workers with IPC; browser Nacelle+ requests fail closed when the boundary is unavailable.
- 📦 **In-Browser NPM Installer**: Direct npm package resolution, tarball downloading, and untarring right inside the browser VFS.
- 🔒 **Run-Scoped Capability Policy**: Immutable grants for VFS, workers, network, npm, preview, persistence, host bridges, and named secrets, with auditable grant deltas.
- 🧰 **Bounded Process Output**: Streaming callbacks plus byte limits, tail retention, and dropped-byte accounting for untrusted workloads.
- ⏪ **Content-Addressed Checkpoints**: Workspace snapshots with metadata, diffs, rollback, and deterministic content identities.
- 🔎 **Structured Failure Traces**: Stable error codes, bounded event history, and secret-redacted run diagnostics.
- 🔑 **Named Secret Broker**: Origin-bound request signatures without exposing raw secret material to guest code.
- 🔒 **Security & Isolation**: Strict capability boundary architecture with zero server-side dependencies.

---

## Subpath Exports

- `nacelle` -> Main bundle (`Nacelle`, `createRuntime`, `runtime`)
- `nacelle/v22` -> Explicit Node v22 runtime entry
- `nacelle/latest` / `nacelle/lts` -> Alpha aliases for the v22 entry
- `nacelle/runtime` -> Low-level runtime assembly and module loader
- `nacelle/worker` -> Dedicated Web Worker process script
- `nacelle/sw` -> Virtual network gateway Service Worker
- `nacelle/wasm/*` -> Integrity-checked WebAssembly artifacts listed by the selected release manifest
- `nacelle/support` / `nacelle/version` -> Shipped aliases, profile hashes, and
  WASM artifact-set identity

WASM adapters load lazily from the selected v22 manifest. A custom CDN or
application path can be supplied with `wasmBaseUrl`:

```javascript
const node = await Nacelle.create({
  wasmBaseUrl: new URL('/nacelle/v22/wasm/', location.href).href,
});
const artifact = await node.wasm.load('node_addon_napi');
console.log(artifact.path, artifact.bytes);
```

---

## Examples & Demos

Try out the interactive in-browser examples included in `examples/`:

```bash
# Start local examples server (Express in-browser IDE)
npm run examples

# Run Vite + React in-browser IDE example
npm run examples:vite-react

# Inspect the shipped WASM artifacts and export contracts
npm run check:wasm

# Build and inspect every published package export
npm run verify:package

# Run Native WASM Addons example
npm run examples:wasm

# Try the inline bash compatibility demo
npm run examples:bash

# Try the TypeScript strip-and-run demo
npm run examples:typescript

# Try the browser proxy configuration demo
npm run examples:proxy

# Run the native Node-compatible proxy example without a browser
npm run examples:proxy-native
```

Each example page includes a navigation menu (☰) at the top to easily switch between examples.

### Optional Nacelle+ transport

For APIs that reject ordinary browser requests because of CORS, the optional
`nacelle-plus/extension` companion provides a capability-gated HTTP transport
for Chrome and Firefox. Nacelle remains the only runtime: native page fetch is
attempted first only for replay-safe `GET` and `HEAD` requests. Unsafe methods
are sent to the privileged adapter before any page fetch, because a browser
failure does not prove that a non-idempotent request was not sent. The Nacelle
run must explicitly grant its proxy capability; the extension's per-origin
permission is a separate check. See
[`nacelle-plus/README.md`](nacelle-plus/README.md) for setup, streaming, and
permission handling.

The supported Node release-line audit and upgrade policy are in
[`docs/node-version-support.md`](docs/node-version-support.md).

### Run policy and recovery

Capabilities are validated once when a runtime is created and are available as
`node.capabilities`. Network methods are selected before a request is issued:
`GET` and `HEAD` may try the page fetch before a privileged fallback, while
unsafe methods go directly to the privileged adapter. Process output is bounded
by the run manifest; `handle.stats('stdout')` reports retained and dropped
bytes. Checkpoints are exposed through `node.checkpoint()`, `node.diff()`, and
`node.rollback()`. Secrets are available through `node.secretBroker` only as
named, origin-bound signatures.

### Alpha build and release commands

```bash
npm run versions
npm run build
npm run validate:versions
npm run check:wasm
npm run verify:package
npm run parity
npm run test:full
```

`npm run publish:n22 -- --dry-run` exercises the release path without
uploading. The live command publishes the major-scoped `n22` tag first and promotes `latest` and
`lts` only after the explicit release gate.

### Inline shell execution

`node.bash(command, options)` runs the supported POSIX shell subset against the virtual filesystem and returns a normal `ProcessHandle`. It supports npm-style command lists, environment assignments, PATH lookup, pipes, redirects, globbing, and common commands including `mv`, `cp`, `ls`, `ps`, `grep`, `cat`, `find`, `cut`, `tr`, `sort`, `uniq`, `tee`, `head`, `tail`, `wc`, `mkdir`, `rm`, and `touch`:

```javascript
const proc = await node.bash(`
  mkdir -p dist &&
  echo "built in $NODE_ENV" > dist/status.txt &&
  cat dist/status.txt
`, { env: { NODE_ENV: 'production' } });

console.log(await proc.stdoutText());
```

The TypeScript demo showcases three conversion pipelines from inline bash build scripts: Node.js 22 built-in `module.stripTypeScriptTypes()`, Vite's fast transform pipeline (`vite build`), and the official Microsoft TypeScript compiler (`tsc`), then executes the emitted JavaScript.

### Run CITGM in Chromium or Firefox

The Playwright adapter preloads the pinned CITGM CLI and the candidate package's
registry metadata, tarballs, and dependency graph into Nacelle's browser-side
npm cache, then executes CITGM itself as a Nacelle child process. Preloading
does not run candidate tests. Playwright only hosts the browser page and selects
the browser engine; CITGM, the candidate package, npm commands, and package
tests stay inside the browser runtime.

Install the adapter dependencies and browser binaries once:

```bash
npm --prefix dev/adapters/playwright install
npx --prefix dev/adapters/playwright playwright install chromium firefox
```

Generate the host-side artifact once per CITGM version, candidate package, and
registry. This uses host npm only to fetch package data with lifecycle scripts
disabled; it does not run the candidate. The generated cache is ignored by git
and is consumed as local assets by the browser page:

```bash
npm run citgm:precache -- express
```

Run one registry package through either engine:

```bash
npm run citgm:browser:chromium -- express
npm run citgm:browser:firefox -- express
```

If no matching artifact exists, the runner falls back to direct browser registry
fetches. Arguments after the module are forwarded to CITGM. The runner currently
targets registry packages; local-directory and native-addon cases need an
explicit browser-safe fixture or capability before they can be meaningful.
Use `NACELLE_CITGM_VERSION` to select a different CITGM release and
`NACELLE_CITGM_TIMEOUT_MS` to change the outer browser-run timeout.
Set `NACELLE_NPM_REGISTRY` when generating and consuming an
alternate registry artifact.

### Next.js 16 App Router

Nacelle runs full Next.js App Router applications entirely in-browser without host subprocesses. The Next.js demo (`npm run examples:next`) demonstrates Server-Side Rendering (SSR), file-system routing (`app/page.tsx`, `app/about/page.tsx`, `app/dashboard/page.tsx`), Server Actions & API endpoints (`app/api/hello/route.ts`), and Next.js CLI orchestration (`next dev`, `next build`, `next start`). Nacelle advertises the WebContainer runtime signal that makes stock Next.js select its own official SWC WebAssembly fallback (`@next/swc-wasm-nodejs`) instead of its platform `.node` package.

The demo's **next start** button builds the current sources when needed, then starts the production server. **next build** can also run separately. Production builds use one worker with worker threads to fit the browser's memory budget, and generated files remain available between commands.

### Proxy configuration

`createProxyConfig()` provides one small, explicit configuration for HTTP(S)
environment proxy routing. It normalizes proxy URLs, mirrors upper- and
lower-case environment keys, supports `NO_PROXY`, and enables routing for the
virtual Node process:

```javascript
import { Nacelle, createProxyConfig } from 'nacelle';

const node = await Nacelle.create({
  proxy: createProxyConfig({
    httpProxy: 'http://127.0.0.1:3128',
    httpsProxy: 'http://127.0.0.1:3128',
    noProxy: ['localhost', '127.0.0.1:3000'],
  }),
});
```

The native example uses standard `node:http` `createServer()` and `get()` calls
inside Nacelle. The first request is routed to the proxy, while the proxy's
upstream request temporarily disables environment routing to avoid a loop.

---

## License

MIT © Nacelle Contributors
