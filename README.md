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

# Try the inline bash compatibility demo
npm run examples:bash

# Try the TypeScript strip-and-run demo
npm run examples:typescript
```

Each example page includes a navigation menu (☰) at the top to easily switch between examples.

### Optional Nacelle+ transport

For APIs that reject ordinary browser requests because of CORS, the optional
`nacelle-plus/extension` companion provides a capability-gated HTTP transport
for Chrome and Firefox. Nacelle remains the only runtime: native page fetch is
attempted first, and the extension is contacted only after a browser network
failure. The Nacelle run must explicitly grant its proxy capability; the
extension's per-origin permission is a separate check. See
[`nacelle-plus/README.md`](nacelle-plus/README.md) for setup, streaming, and
permission handling.

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

The TypeScript demo uses the browser runtime's `module.stripTypeScriptTypes()` implementation from an inline bash build script, then executes the emitted JavaScript.

---

## License

MIT © Nacelle Contributors
