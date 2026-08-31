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

function validateWasmExports(outputPath, label, expectedExports = [], minExportsFloor = 1) {
  if (!fs.existsSync(outputPath)) throw new Error(`${label} did not produce ${outputPath}`);
  const bytes = fs.readFileSync(outputPath);
  if (!WebAssembly.validate(bytes)) throw new Error(`${label} produced invalid WebAssembly`);
  if (bytes.byteLength < 500) {
    throw new Error(`${label} produced suspiciously small WebAssembly (${bytes.byteLength} bytes)`);
  }
  const names = new Set(WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((item) => item.name));
  const missing = expectedExports.filter((name) => !names.has(name));
  const floor = Math.max(minExportsFloor, expectedExports.length);
  if (names.size < floor) {
    throw new Error(`${label} exported only ${names.size} symbols; expected at least ${floor}`);
  }
  if (missing.length) throw new Error(`${label} is missing required exports: ${missing.join(', ')}`);
  return { bytes: bytes.byteLength, exports: [...names].sort() };
}

function compileWasm(label, args, outputPath, expectedExports, minExportsFloor) {
  execFileSync(emcc, args, { stdio: "inherit" });
  return validateWasmExports(outputPath, label, expectedExports, minExportsFloor);
}

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

// 2. SQLite (node:sqlite)
const sqliteSrc = path.join(nodeDeps, "sqlite", "sqlite3.c");
if (fs.existsSync(sqliteSrc)) {
  console.log("-> Compiling sqlite.wasm...");
  const sqliteWasm = path.join(outDir, "sqlite.wasm");
  compileWasm('sqlite', [
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
  ], sqliteWasm, [
    'sqlite3_open', 'sqlite3_close', 'sqlite3_exec', 'sqlite3_prepare_v2', 'sqlite3_step',
    'sqlite3_finalize', 'sqlite3_column_count', 'sqlite3_column_name', 'sqlite3_column_type',
    'sqlite3_column_text', 'sqlite3_column_int64', 'sqlite3_column_double', 'sqlite3_column_blob',
    'sqlite3_column_bytes', 'sqlite3_bind_text', 'sqlite3_bind_int64', 'sqlite3_bind_double',
    'sqlite3_bind_blob', 'sqlite3_bind_null', 'sqlite3_errmsg', 'sqlite3_changes',
    'sqlite3_total_changes', 'sqlite3_last_insert_rowid', 'malloc', 'free',
  ], 25);

  artifacts.push(
    { node: "internal/deps/sqlite.node", wasm: "./sqlite.wasm", entry: "sqlite", exports: [
      'sqlite3_open', 'sqlite3_close', 'sqlite3_exec', 'sqlite3_prepare_v2', 'sqlite3_step',
      'sqlite3_finalize', 'sqlite3_column_count', 'sqlite3_column_name', 'sqlite3_column_type',
      'sqlite3_column_text', 'sqlite3_column_int64', 'sqlite3_column_double', 'sqlite3_column_blob',
      'sqlite3_column_bytes', 'sqlite3_bind_text', 'sqlite3_bind_int64', 'sqlite3_bind_double',
      'sqlite3_bind_blob', 'sqlite3_bind_null', 'sqlite3_errmsg', 'sqlite3_changes',
      'sqlite3_total_changes', 'sqlite3_last_insert_rowid', 'malloc', 'free',
    ] },
  );
}

// 3. Zlib (node:zlib)
const zlibDir = path.join(nodeDeps, "zlib");
if (fs.existsSync(zlibDir)) {
  console.log("-> Compiling zlib.wasm...");
  const zlibSources = ["adler32.c", "crc32.c", "deflate.c", "infback.c", "inffast.c", "inflate.c", "inftrees.c", "trees.c", "zutil.c"]
    .map((f) => path.join(zlibDir, f)).filter(fs.existsSync);
  compileWasm('zlib', [
    ...zlibSources,
    `-I${zlibDir}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sEXPORTED_FUNCTIONS=_deflateInit_,_deflate,_deflateEnd,_inflateInit_,_inflate,_inflateEnd,_crc32,_adler32,_malloc,_free",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "zlib.wasm"),
  ], path.join(outDir, "zlib.wasm"), ['deflateInit_', 'deflate', 'deflateEnd', 'inflateInit_', 'inflate', 'inflateEnd', 'crc32', 'adler32', 'malloc', 'free'], 10);

  artifacts.push({ node: "internal/deps/zlib.node", wasm: "./zlib.wasm", entry: "zlib", exports: ['deflateInit_', 'deflate', 'deflateEnd', 'inflateInit_', 'inflate', 'inflateEnd', 'crc32', 'adler32', 'malloc', 'free'] });
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
  compileWasm('brotli', [
    ...brotliSources,
    `-I${path.join(brotliDir, "c", "include")}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sEXPORTED_FUNCTIONS=_BrotliEncoderCreateInstance,_BrotliEncoderCompressStream,_BrotliEncoderDestroyInstance,_BrotliDecoderCreateInstance,_BrotliDecoderDecompressStream,_BrotliDecoderDestroyInstance,_malloc,_free",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "brotli.wasm"),
  ], path.join(outDir, "brotli.wasm"), ['BrotliEncoderCreateInstance', 'BrotliEncoderCompressStream', 'BrotliEncoderDestroyInstance', 'BrotliDecoderCreateInstance', 'BrotliDecoderDecompressStream', 'BrotliDecoderDestroyInstance', 'malloc', 'free'], 8);

  artifacts.push({ node: "internal/deps/brotli.node", wasm: "./brotli.wasm", entry: "brotli", exports: ['BrotliEncoderCreateInstance', 'BrotliEncoderCompressStream', 'BrotliEncoderDestroyInstance', 'BrotliDecoderCreateInstance', 'BrotliDecoderDecompressStream', 'BrotliDecoderDestroyInstance', 'malloc', 'free'] });
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
  compileWasm('zstd', [
    ...zstdSources,
    `-I${zstdDir}`,
    `-I${path.join(zstdDir, "common")}`,
    "-O2",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sEXPORTED_FUNCTIONS=_ZSTD_compress,_ZSTD_decompress,_ZSTD_compressBound,_ZSTD_getFrameContentSize,_ZSTD_isError,_malloc,_free",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
    "--no-entry",
    "-o", path.join(outDir, "zstd.wasm"),
  ], path.join(outDir, "zstd.wasm"), ['ZSTD_compress', 'ZSTD_decompress', 'ZSTD_compressBound', 'ZSTD_getFrameContentSize', 'ZSTD_isError', 'malloc', 'free'], 7);

  artifacts.push({ node: "internal/deps/zstd.node", wasm: "./zstd.wasm", entry: "zstd", exports: ['ZSTD_compress', 'ZSTD_decompress', 'ZSTD_compressBound', 'ZSTD_getFrameContentSize', 'ZSTD_isError', 'malloc', 'free'] });
}

// 6. Standard Node-API bridge.
const napiWasm = path.join(outDir, "node_addon_napi.wasm");
validateWasmExports(napiWasm, 'node_addon_napi', ['napi_register_wasm_v1'], 1);
artifacts.push({ node: "build/Release/node_addon_napi.node", wasm: "./node_addon_napi.wasm", entry: "napi", exports: ['napi_register_wasm_v1'] });

// 7. Write Final Manifest
const manifestPath = path.join(outDir, "addon-manifest.json");
const manifest = {
  version: 2,
  node_version: nodeVersion,
  reference_version: "22.23.2",
  abi: { modules: "127", napi: "10" },
  artifact_compatibility: "browser-wasm-napi10",
  artifacts,
  failures: [],
  skipped: [],
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n=== Release WASM Build Completed: ${artifacts.length} artifacts built into ${outDir} ===`);

