#!/usr/bin/env node
/**
 * Production build script for browser-node
 *
 * Bundles the core runtime, public API, and target Node version WASM binaries.
 *
 * Usage:
 *   node scripts/build.mjs [--node-version=v22]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.resolve(repoRoot, 'src');
const distDir = path.resolve(repoRoot, 'dist');

const args = process.argv.slice(2);
let nodeVersion = 'v22';

for (const arg of args) {
  if (arg.startsWith('--node-version=')) {
    nodeVersion = arg.slice('--node-version='.length);
    if (!nodeVersion.startsWith('v')) nodeVersion = `v${nodeVersion}`;
  }
}

console.log(`\n======================================================`);
console.log(`  📦 Building nacelle for Node ${nodeVersion}`);
console.log(`======================================================\n`);

// 1. Clean dist directory
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
const distWasmDir = path.join(distDir, 'wasm');
fs.mkdirSync(distWasmDir, { recursive: true });

// 2. Bundle ONLY the target version's WASM binaries
const versionWasmDir = path.join(srcDir, 'wasm', nodeVersion);
if (fs.existsSync(versionWasmDir)) {
  const wasmFiles = fs.readdirSync(versionWasmDir).filter(f => f.endsWith('.wasm') || f.endsWith('.json'));
  for (const file of wasmFiles) {
    fs.copyFileSync(path.join(versionWasmDir, file), path.join(distWasmDir, file));
  }
  console.log(`  ✓ Bundled ${wasmFiles.length} WASM binaries from src/wasm/${nodeVersion}/ into dist/wasm/`);
} else {
  console.warn(`  ⚠ Warning: No WASM binaries found at src/wasm/${nodeVersion}/`);
}

// 3. Copy runtime tree to dist/runtime/ and root runtime.js
fs.cpSync(path.join(srcDir, 'runtime'), path.join(distDir, 'runtime'), { recursive: true });
fs.copyFileSync(path.join(srcDir, 'runtime.js'), path.join(distDir, 'runtime.js'));
fs.copyFileSync(path.join(srcDir, 'runtime.js'), path.join(distDir, 'runtime.mjs'));
console.log(`  ✓ Staged runtime modules in dist/runtime/ and dist/runtime.mjs`);

// 4. Copy worker & service worker assets
const workerSrc = path.join(srcDir, 'runtime', 'process-worker.js');
if (fs.existsSync(workerSrc)) {
  fs.copyFileSync(workerSrc, path.join(distDir, 'process-worker.js'));
}
const swSrc = path.join(srcDir, 'runtime', 'gateway-sw.js');
if (fs.existsSync(swSrc)) {
  fs.copyFileSync(swSrc, path.join(distDir, 'gateway-sw.js'));
}

// 5. Emit ESM & CJS entry bundles and TypeScript definitions
fs.copyFileSync(path.join(srcDir, 'index.js'), path.join(distDir, 'index.mjs'));
fs.copyFileSync(path.join(srcDir, 'index.js'), path.join(distDir, 'index.js'));
fs.copyFileSync(path.join(srcDir, 'types.d.ts'), path.join(distDir, 'index.d.ts'));

// CJS wrapper
const cjsWrapper = `
// nacelle CJS wrapper
module.exports = require('./index.js');
`;
fs.writeFileSync(path.join(distDir, 'index.cjs'), cjsWrapper.trim() + '\n');

// Version metadata
const versionMeta = {
  name: 'nacelle',
  nodeTargetVersion: nodeVersion,
  buildTime: new Date().toISOString(),
};
fs.writeFileSync(path.join(distDir, 'version.json'), JSON.stringify(versionMeta, null, 2) + '\n');

console.log(`  ✓ Emitted dist/index.mjs, dist/index.cjs, dist/index.d.ts, dist/version.json`);
console.log(`\n  ✨ Build completed successfully for ${nodeVersion}!\n`);
