Two lists. The first makes the existing claims true; the second is what proves the system.

## Making the README real

**1. Fix the export lists in `build-wasm-release.mjs`.** Each broken target needs `-sEXPORTED_FUNCTIONS` the way sqlite and zlib already have it:
- brotli → `_BrotliEncoderCreateInstance,_BrotliEncoderCompressStream,_BrotliEncoderDestroyInstance,_BrotliDecoderCreateInstance,_BrotliDecoderDecompressStream,_BrotliDecoderDestroyInstance,_malloc,_free`
- zstd → `_ZSTD_compress,_ZSTD_decompress,_ZSTD_compressBound,_ZSTD_getFrameContentSize,_ZSTD_isError`
- llhttp → `_llhttp_init,_llhttp_execute,_llhttp_finish,_llhttp_settings_init,_llhttp_get_error_reason`
- ada → `_ada_parse,_ada_get_href,_ada_get_pathname,_ada_get_search,_ada_free`
- simdutf, nghttp2, cares, uvwasi — same treatment or drop them; see item 4.

**2. Make the build fail on an empty module.** Count the export section entries after each `emcc` call and throw below a per-target floor. The current pipeline wrote six 194-byte artifacts and recorded `"failures": []`. That check is ~15 lines and it's the thing that would have caught all of this.

**3. Stop the sqlite copy.** `better_sqlite3.wasm` and `sqlite3.wasm` are `copyFileSync` of `sqlite.wasm` but declared `entry: "napi"`, and a raw `sqlite3.c` build exports no `napi_register_wasm_v1`. Those need the actual addon sources (`better-sqlite3/src/*.cpp`, `node-sqlite3/src/*.cc`) compiled and linked against sqlite — which is what `addon_build.py` already knows how to do.

**4. Wire the artifacts to something.** This is the real gap. Nothing currently consumes them: `zlib.js` uses `CompressionStream`, `http.js` parses in JS, and `sqlite.js:46` throws `unsupportedBoundary` unconditionally regardless of the 1.2MB working sqlite.wasm sitting next to it. A correct brotli.wasm changes zero behavior until `zlib.js` calls into it. Pick the two or three where wasm actually beats the Web API (sqlite, zstd, brotli-sync) and wire those; delete the rest of the manifest.

**5. Then remove the `deflate-raw` substitution** at `zlib.js:228`. Until brotli.wasm is wired, make it throw rather than emit mislabeled deflate.

## Demos that prove the long tail

Ordered so each one isolates a subsystem before the ones that combine them.

**HTTP client, not server.** `undici` and `got` against a real origin. Redirects, chunked bodies, and `Accept-Encoding: br, zstd` — real servers send brotli, so this is the demo that makes the brotli work load-bearing instead of decorative. Your `http.js` is 173KB of server-side work; the client path is comparatively unproven.

**`bcrypt`.** Smallest possible test of the N-API wasm ABI: pure compute, no fs, no network. If the napi bridge is wrong, this fails cleanly instead of ambiguously. Do this before better-sqlite3.

**`better-sqlite3` + `drizzle-orm`.** The hard part is that better-sqlite3's API is synchronous and wasm instantiation isn't, so you need the module resolved before user code runs. This is the demo that proves `node:sqlite` and the napi path together.

**Full `tsc`, not type stripping.** `ts.createProgram` over a multi-file project. Heavy synchronous fs, large heap, real module resolution. Your current TypeScript demo tests `stripTypeScriptTypes()`, which is a much smaller claim.

**`vitest`.** Hits `vm.js`, `process-worker.js`, and worker_threads simultaneously, with module mocking. Different and harder than Vite's dev server, which mostly exercises resolution and serving.

**`webpack 5`.** Sync fs at volume, content hashing, a worker pool, watch mode. Vite passing doesn't imply webpack passes — different fs access patterns entirely.

**`ws` or `socket.io`.** Real HTTP upgrade against a real client. You have `http-connect.spec.mjs`, but not an upgrade handshake with a browser WebSocket on the other end.

**`pg` or `mysql2`.** Raw TCP through `virtual-network.js` and out via the proxy. This is the case that justifies Nacelle+ existing, and right now nothing demonstrates it end to end.

**`esbuild-wasm` / `@swc/wasm`.** WebAssembly instantiated by user code inside the runtime, going through your module loader rather than your addon manifest. Different path from the one above.

**Next.js dev server.** The boss fight, and worth attempting early even if it fails — the failure list is the roadmap. It combines sync fs, workers, swc, resolution, an http server, and HMR sockets.

**`npm install` of a package with a real postinstall script.** Shell + `child_process` + `tar` together, which is the seam most likely to be quietly broken.

One structural note: run each of these under `scripts/parity-report.mjs --require-native` with a native-Node reference and compare output bytes, not just exit status. The brotli bug survives any test that only checks a round-trip inside Nacelle.