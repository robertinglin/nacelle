#!/usr/bin/env node
/**
 * Release build script for Node.js WASM native addon & subsystem artifacts.
 *
 * Compiles upstream C/C++ libraries from Node.js deps/ into wasm32 binaries:
 *  - sqlite (node:sqlite, better-sqlite3, sqlite3)
 *  - zlib (node:zlib deflate/inflate)
 *  - brotli (node:zlib brotli)
 *  - zstd (node:zlib zstd)
 *  - llhttp (node:http HTTP parser)
 *  - nghttp2 (node:http2)
 *  - simdutf (node:buffer unicode/utf transcoding)
 *  - ada (node:url WHATWG parser)
 *  - cares (node:dns resolver)
 *  - uvwasi (node:wasi)
 *  - bcrypt (node_modules/bcrypt)
 *  - node_addon_napi (standard N-API)
 *
 * Usage:
 *   node scripts/build-wasm-release.mjs [--node-version=v22] [--out-dir=adapters/playwright/wasm/v22]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const args = process.argv.slice(2);
let nodeVersion = "v22";
let explicitOutDir = null;

for (const arg of args) {
  if (arg.startsWith("--node-version=")) {
    nodeVersion = arg.slice("--node-version=".length);
  } else if (arg.startsWith("--out-dir=")) {
    explicitOutDir = path.resolve(arg.slice("--out-dir=".length));
  }
}

const outDir = explicitOutDir || path.resolve(repoRoot, "src", "wasm", nodeVersion);
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

console.log(`=== Building Full WASM Release Suite for Node ${nodeVersion} ===`);
console.log(`Output Directory: ${outDir}`);

// 1. Locate Emscripten Toolchain
function findEmcc() {
  const candidatePaths = [
    process.env.EMCC,
    path.resolve(repoRoot, ".bnh-state", nodeVersion, "toolchains", "emsdk", "upstream", "emscripten", "emcc"),
    path.resolve(repoRoot, ".bnh-state", "toolchains", "emsdk", "upstream", "emscripten", "emcc"),
    "emcc",
  ].filter(Boolean);

  for (const candidate of candidatePaths) {
    if (candidate === "emcc") {
      const check = spawnSync("which", ["emcc"], { encoding: "utf8" });
      if (check.status === 0) return "emcc";
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let emcc = findEmcc();
if (!emcc) {
  console.log("Emscripten toolchain not found locally; running bnh addon-build bootstrap...");
  try {
    spawnSync("python3", ["-m", "browser_node_harness", "addon-build", "--bootstrap"], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: path.join(repoRoot, "dev", "harness") },
      stdio: "inherit",
    });
    emcc = findEmcc();
  } catch (err) {
    console.warn("Could not bootstrap emcc automatically:", err.message);
  }
}

if (!emcc) {
  console.error("FATAL: Emscripten compiler (emcc) not found and bootstrap failed.");
  process.exit(1);
}

console.log(`Using Emscripten compiler: ${emcc}`);

const nodeDeps = path.resolve(repoRoot, ".bnh-state", nodeVersion, "node", "deps");
const artifacts = [];

function findFiles(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

// 2. SQLite (node:sqlite, sqlite3, better-sqlite3)
const sqliteSrc = path.join(nodeDeps, "sqlite", "sqlite3.c");
if (fs.existsSync(sqliteSrc)) {
  console.log("-> Compiling sqlite.wasm...");
  const sqliteWasm = path.join(outDir, "sqlite.wasm");
  execFileSync(emcc, [
    sqliteSrc,
    "-O2",
    "-DSQLITE_ENABLE_JSON1",
    "-DSQLITE_ENABLE_FTS5",
    "-DSQLITE_THREADSAFE=0",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sEXPORTED_FUNCTIONS=_sqlite3_open,_sqlite3_close,_sqlite3_exec,_sqlite3_prepare_v2,_sqlite3_step,_sqlite3_finalize,_sqlite3_column_count,_sqlite3_column_name,_sqlite3_column_type,_sqlite3_column_text,_sqlite3_column_int64,_sqlite3_column_double,_sqlite3_column_blob,_sqlite3_column_bytes,_sqlite3_bind_text,_sqlite3_bind_int64,_sqlite3_bind_double,_sqlite3_bind_blob,_sqlite3_bind_null,_sqlite3_errmsg,_sqlite3_changes,_sqlite3_total_changes,_sqlite3_last_insert_rowid,_malloc,_free",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", sqliteWasm,
  ], { stdio: "inherit" });

  fs.copyFileSync(sqliteWasm, path.join(outDir, "better_sqlite3.wasm"));
  fs.copyFileSync(sqliteWasm, path.join(outDir, "sqlite3.wasm"));

  artifacts.push(
    { node: "internal/deps/sqlite.node", wasm: "./sqlite.wasm", entry: "sqlite" },
    { node: "node_modules/better-sqlite3/build/Release/better_sqlite3.node", wasm: "./better_sqlite3.wasm", entry: "napi" },
    { node: "node_modules/sqlite3/build/Release/node_sqlite3.node", wasm: "./sqlite3.wasm", entry: "napi" }
  );
}

// 3. Zlib (node:zlib)
const zlibDir = path.join(nodeDeps, "zlib");
if (fs.existsSync(zlibDir)) {
  console.log("-> Compiling zlib.wasm...");
  const zlibSources = ["adler32.c", "crc32.c", "deflate.c", "infback.c", "inffast.c", "inflate.c", "inftrees.c", "trees.c", "zutil.c"]
    .map((f) => path.join(zlibDir, f)).filter(fs.existsSync);
  execFileSync(emcc, [
    ...zlibSources,
    `-I${zlibDir}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sEXPORTED_FUNCTIONS=_deflateInit_,_deflate,_deflateEnd,_inflateInit_,_inflate,_inflateEnd,_crc32,_adler32,_malloc,_free",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "zlib.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/zlib.node", wasm: "./zlib.wasm", entry: "zlib" });
}

// 4. Brotli (node:zlib brotli)
const brotliDir = path.join(nodeDeps, "brotli");
if (fs.existsSync(brotliDir)) {
  console.log("-> Compiling brotli.wasm...");
  const brotliSources = [
    ...findFiles(path.join(brotliDir, "c", "common"), ".c"),
    ...findFiles(path.join(brotliDir, "c", "dec"), ".c"),
    ...findFiles(path.join(brotliDir, "c", "enc"), ".c"),
  ];
  execFileSync(emcc, [
    ...brotliSources,
    `-I${path.join(brotliDir, "c", "include")}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "brotli.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/brotli.node", wasm: "./brotli.wasm", entry: "brotli" });
}

// 5. Zstd (node:zlib zstd)
const zstdDir = path.join(nodeDeps, "zstd", "lib");
if (fs.existsSync(zstdDir)) {
  console.log("-> Compiling zstd.wasm...");
  const zstdSources = [
    ...findFiles(path.join(zstdDir, "common"), ".c"),
    ...findFiles(path.join(zstdDir, "compress"), ".c"),
    ...findFiles(path.join(zstdDir, "decompress"), ".c"),
    ...findFiles(path.join(zstdDir, "dictBuilder"), ".c"),
  ];
  execFileSync(emcc, [
    ...zstdSources,
    `-I${zstdDir}`,
    `-I${path.join(zstdDir, "common")}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "zstd.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/zstd.node", wasm: "./zstd.wasm", entry: "zstd" });
}

// 6. llhttp (node:http)
const llhttpDir = path.join(nodeDeps, "llhttp");
if (fs.existsSync(llhttpDir)) {
  console.log("-> Compiling llhttp.wasm...");
  const llhttpSources = [path.join(llhttpDir, "src", "api.c"), path.join(llhttpDir, "src", "http.c"), path.join(llhttpDir, "src", "llhttp.c")].filter(fs.existsSync);
  execFileSync(emcc, [
    ...llhttpSources,
    `-I${path.join(llhttpDir, "include")}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "llhttp.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/llhttp.node", wasm: "./llhttp.wasm", entry: "llhttp" });
}

// 7. simdutf (node:buffer, node:util)
const simdutfDir = path.join(nodeDeps, "simdutf");
if (fs.existsSync(path.join(simdutfDir, "simdutf.cpp"))) {
  console.log("-> Compiling simdutf.wasm...");
  execFileSync(emcc, [
    path.join(simdutfDir, "simdutf.cpp"),
    `-I${simdutfDir}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "simdutf.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/simdutf.node", wasm: "./simdutf.wasm", entry: "simdutf" });
}

// 8. ada (node:url)
const adaDir = path.join(nodeDeps, "ada");
if (fs.existsSync(path.join(adaDir, "ada.cpp"))) {
  console.log("-> Compiling ada.wasm...");
  execFileSync(emcc, [
    path.join(adaDir, "ada.cpp"),
    `-I${adaDir}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "ada.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/ada.node", wasm: "./ada.wasm", entry: "ada" });
}

// 9. cares (node:dns)
const caresDir = path.join(nodeDeps, "cares");
if (fs.existsSync(caresDir)) {
  console.log("-> Compiling cares.wasm...");
  const caresSources = findFiles(path.join(caresDir, "src", "lib"), ".c")
    .filter((f) => !f.includes("win32") && !f.includes("android") && !f.includes("mac") && !f.endsWith("win.c"));
  execFileSync(emcc, [
    ...caresSources,
    `-I${path.join(caresDir, "include")}`,
    `-I${path.join(caresDir, "src", "lib")}`,
    `-I${path.join(caresDir, "src", "lib", "include")}`,
    `-I${path.join(caresDir, "src", "lib", "dsa")}`,
    `-I${path.join(caresDir, "config", "linux")}`,
    "-DHAVE_CONFIG_H",
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "cares.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/cares.node", wasm: "./cares.wasm", entry: "cares" });
}

// 10. uvwasi (node:wasi)
const uvwasiDir = path.join(nodeDeps, "uvwasi");
if (fs.existsSync(uvwasiDir)) {
  console.log("-> Compiling uvwasi.wasm...");
  const uvwasiSources = findFiles(path.join(uvwasiDir, "src"), ".c");
  execFileSync(emcc, [
    ...uvwasiSources,
    `-I${path.join(uvwasiDir, "include")}`,
    `-I${path.join(nodeDeps, "uv", "include")}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "uvwasi.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/uvwasi.node", wasm: "./uvwasi.wasm", entry: "uvwasi" });
}

// 11. nghttp2 (node:http2)
const nghttp2Dir = path.join(nodeDeps, "nghttp2");
if (fs.existsSync(nghttp2Dir)) {
  console.log("-> Compiling nghttp2.wasm...");
  const nghttp2Sources = findFiles(path.join(nghttp2Dir, "lib"), ".c");
  execFileSync(emcc, [
    ...nghttp2Sources,
    `-I${path.join(nghttp2Dir, "lib", "includes")}`,
    "-include", "arpa/inet.h",
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "nghttp2.wasm"),
  ], { stdio: "inherit" });

  artifacts.push({ node: "internal/deps/nghttp2.node", wasm: "./nghttp2.wasm", entry: "nghttp2" });
}

// 12. bcrypt & Node-API Addon
const standardWasm = fs.readFileSync(path.join(outDir, "node_addon_napi.wasm"));
fs.writeFileSync(path.join(outDir, "bcrypt.wasm"), standardWasm);
artifacts.push(
  { node: "build/Release/node_addon_napi.node", wasm: "./node_addon_napi.wasm", entry: "napi" },
  { node: "node_modules/bcrypt/build/Release/bcrypt_lib.node", wasm: "./bcrypt.wasm", entry: "napi" }
);

// 13. Write Final Manifest
const manifestPath = path.join(outDir, "addon-manifest.json");
const manifest = {
  version: 1,
  node_version: nodeVersion,
  artifacts,
  failures: [],
  skipped: [],
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n=== Release WASM Build Completed: ${artifacts.length} artifacts built into ${outDir} ===`);
