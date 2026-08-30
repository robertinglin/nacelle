#!/usr/bin/env node
/**
 * Release publishing script for browser-node with release channels.
 *
 * Usage:
 *   node scripts/publish-release.mjs [--channel=v22] [--set-latest] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pkgJsonPath = path.join(repoRoot, 'package.json');
const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
let rawChannel = 'v22';
let setLatest = args.includes('--set-latest');

for (const arg of args) {
  if (arg.startsWith('--channel=')) {
    rawChannel = arg.slice('--channel='.length);
  }
}

// Convert channel input to build version (v22) and npm dist-tag (n22)
const versionDigits = rawChannel.replace(/[^\d]/g, '') || '22';
const nodeTargetVersion = `v${versionDigits}`;
const distTag = rawChannel.startsWith('n') && !rawChannel.startsWith('node') ? rawChannel : `n${versionDigits}`;

// Default setLatest to true if publishing v22 or if no explicit non-latest flag
if (!args.some(a => a.startsWith('--channel='))) {
  setLatest = true;
}

console.log(`\n======================================================`);
console.log(`  🚀 Publishing browser-node@${pkgJson.version}`);
console.log(`  Target Node Version:    \x1b[36m${nodeTargetVersion}\x1b[0m`);
console.log(`  NPM Dist-Tag:           \x1b[36m${distTag}\x1b[0m`);
console.log(`  Set as 'latest':        \x1b[33m${setLatest}\x1b[0m`);
console.log(`  Mode:                   ${isDryRun ? '\x1b[35m[DRY RUN]\x1b[0m' : '\x1b[32m[LIVE PUBLISH]\x1b[0m'}`);
console.log(`======================================================\n`);

// 1. Build package scoped to target channel version
console.log(`Step 1: Building package for ${nodeTargetVersion}...`);
spawnSync(process.execPath, [path.join(__dirname, 'build.mjs'), `--node-version=${nodeTargetVersion}`], {
  cwd: repoRoot,
  stdio: 'inherit',
});

// 2. Publish to the target release channel tag
console.log(`\nStep 2: Publishing to npm with tag '${distTag}'...`);
const publishArgs = ['publish', '--tag', distTag];
if (isDryRun) {
  console.log(`> npm ${publishArgs.join(' ')} (dry-run skipped)`);
} else {
  execFileSync('npm', publishArgs, { cwd: repoRoot, stdio: 'inherit' });
}

// 3. Update 'latest' dist-tag if requested
if (setLatest) {
  console.log(`\nStep 3: Updating 'latest' dist-tag to point to ${pkgJson.version}...`);
  const tagArgs = ['dist-tag', 'add', `browser-node@${pkgJson.version}`, 'latest'];
  if (isDryRun) {
    console.log(`> npm ${tagArgs.join(' ')} (dry-run skipped)`);
  } else {
    execFileSync('npm', tagArgs, { cwd: repoRoot, stdio: 'inherit' });
  }
}

console.log(`\n✨ Release complete for channel ${distTag} (${nodeTargetVersion})!\n`);
