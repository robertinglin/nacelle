#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(sourceDir, 'extension');
const outputDir = path.join(sourceDir, 'dist');
const sharedFiles = ['background.js', 'content-script.js', 'popup.html', 'popup.js'];

fs.rmSync(outputDir, { recursive: true, force: true });

for (const [browser, manifest] of [['chrome', 'manifest.chrome.json'], ['firefox', 'manifest.firefox.json']]) {
  const browserDir = path.join(outputDir, browser);
  fs.mkdirSync(browserDir, { recursive: true });
  for (const file of sharedFiles) fs.copyFileSync(path.join(extensionDir, file), path.join(browserDir, file));
  fs.copyFileSync(path.join(extensionDir, manifest), path.join(browserDir, 'manifest.json'));
}

console.log(`Built Chrome and Firefox extensions in ${path.relative(process.cwd(), outputDir)}/`);
