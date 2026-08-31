#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv.find((value) => value.startsWith('--node-version='))?.slice('--node-version='.length) || 'v22';
const directory = path.join(root, 'src', 'wasm', version);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'addon-manifest.json'), 'utf8'));
if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('WASM manifest contains no artifacts');
for (const artifact of manifest.artifacts) {
  const file = path.join(directory, path.basename(artifact.wasm));
  if (!fs.existsSync(file)) throw new Error(`Missing WASM artifact: ${artifact.wasm}`);
  const bytes = fs.readFileSync(file);
  if (!WebAssembly.validate(bytes)) throw new Error(`Invalid WASM artifact: ${artifact.wasm}`);
  const names = new Set(WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((item) => item.name));
  const expected = artifact.exports || [];
  if (!expected.length || names.size < expected.length || expected.some((name) => !names.has(name))) {
    throw new Error(`WASM artifact ${artifact.wasm} does not satisfy its export contract`);
  }
}
console.log(`${version}: ${manifest.artifacts.length} WASM artifacts passed export validation`);
