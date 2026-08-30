#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNodeVersionProfile } from '../src/versions/index.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const packageJSON = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const channelArgument = args.find((argument) => argument.startsWith('--channel='));
const profile = resolveNodeVersionProfile(channelArgument?.slice('--channel='.length) || 'v22');
const dryRun = args.includes('--dry-run');
const promoteStable = args.includes('--set-latest');

function assertCleanWorktree() {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message || result.stderr || 'Unable to inspect the release worktree');
    process.exit(1);
  }
  const changes = result.stdout
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.slice(3).startsWith('.worktrees/'));
  if (changes.length) {
    console.error('Refusing to publish from a dirty worktree:');
    for (const change of changes) console.error(`  ${change}`);
    process.exit(1);
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: repositoryRoot, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

assertCleanWorktree();
console.log(`Publishing nacelle@${packageJSON.version} for ${profile.id} as ${profile.npmTag}${dryRun ? ' (dry run)' : ''}`);
run(process.execPath, [path.join(scriptDirectory, 'test-alpha.mjs'), '--require-native']);
assertCleanWorktree();
run('npm', ['publish', '--tag', profile.npmTag, ...(dryRun ? ['--dry-run'] : [])]);

if (promoteStable && !dryRun) {
  const packageVersion = `${packageJSON.name}@${packageJSON.version}`;
  run('npm', ['dist-tag', 'add', packageVersion, 'latest']);
  run('npm', ['dist-tag', 'add', packageVersion, 'lts']);
}

if (promoteStable && dryRun) {
  console.log(`Dry run: would promote ${packageJSON.name}@${packageJSON.version} to latest and lts`);
}

console.log(`Release gate complete for ${profile.id}.`);
