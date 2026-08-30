# nacelle

**Self-contained Node.js execution engine and virtual runtime in the browser.**

Powered by WebAssembly, Web Workers, Virtual Filesystems (VFS), and in-browser networking, `nacelle` lets you run Node.js code, standard libraries, and npm packages directly inside client browsers with zero server execution.

---

## Installation & Release Channels

Install `nacelle` using your preferred package manager and release channel:

```bash
# Install the latest Node v22 browser runtime build
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

// Run a script in an isolated Web Worker child process
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
- ⚡ **WebAssembly C/C++ Addon Engine**: Precompiled native dependencies including `sqlite3`, `better-sqlite3`, `zlib`, `brotli`, `zstd`, `llhttp`, `nghttp2`, `simdutf`, `ada`, `cares`, `uvwasi`, and standard N-API (`node_addon_napi`).
- 📁 **Virtual POSIX Filesystem (VFS)**: Isolated in-memory filesystem with synchronous and asynchronous operations, streams, and file descriptors.
- 🧵 **Web Worker Isolation**: True multi-threaded process execution via Web Workers with IPC and structured stdout/stderr streams.
- 📦 **In-Browser NPM Installer**: Direct npm package resolution, tarball downloading, and untarring right inside the browser VFS.
- 🔒 **Security & Isolation**: Strict capability boundary architecture with zero server-side dependencies.

---

## Subpath Exports

- `nacelle` -> Main bundle (`Nacelle`, `createRuntime`, `runtime`)
- `nacelle/v22` -> Explicit Node v22 runtime entry
- `nacelle/runtime` -> Low-level runtime assembly and module loader
- `nacelle/worker` -> Dedicated Web Worker process script
- `nacelle/sw` -> Virtual network gateway Service Worker
- `nacelle/wasm/*` -> Precompiled native WebAssembly modules

---

## Examples & Demos

Try out the interactive in-browser examples included in `examples/`:

```bash
# Start local examples server (Express in-browser IDE)
npm run examples

# Run Vite + React in-browser IDE example
npm run examples:vite-react

# Run Native WASM Addons example
npm run examples:wasm
```

Each example page includes a navigation menu (☰) at the top to easily switch between examples.

---

## License

MIT © Nacelle Contributors
