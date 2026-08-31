#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listNodeVersionProfiles, resolveNodeVersionProfile } from '../src/versions/index.js';
import { runVersionParity } from './version-parity-worker.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(scriptDirectory, 'version-parity-worker.mjs');
const versionArgument = process.argv.find((value) => value.startsWith('--node-version='));
const outputArgument = process.argv.find((value) => value.startsWith('--output='));
const requireNative = process.argv.includes('--require-native');
const profiles = versionArgument
  ? [resolveNodeVersionProfile(versionArgument.slice('--node-version='.length))]
  : listNodeVersionProfiles();

const reports = await Promise.all(profiles.map(async (profile) => {
  const result = spawnSync(process.execPath, [worker, `--node-version=${profile.id}`], {
    cwd: path.resolve(scriptDirectory, '..'),
    encoding: 'utf8',
  });
  if (!result.stdout.trim()) {
    if (result.error?.code === 'EPERM') return runVersionParity(profile.id);
    return {
      profile: profile.id,
      status: 'semantic-drift',
      nativeReference: { status: 'not-run' },
      error: result.error?.message || result.stderr.trim() || `parity worker exited ${result.status}`,
    };
  }
  return JSON.parse(result.stdout);
}));

const failed = reports.some((report) => report.status !== 'pass'
  || requireNative && report.nativeReference.status !== 'pass');
const output = {
  generatedBy: 'scripts/parity-report.mjs',
  requireNative,
  status: failed ? 'failed' : 'passed',
  reports,
};

if (outputArgument) {
  const outputPath = path.resolve(outputArgument.slice('--output='.length));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(output, null, 2));
} else {
  for (const report of reports) {
    console.log(`${report.profile}: ${report.status}; native=${report.nativeReference.status}`);
    for (const check of report.checks || []) console.log(`  ${check.status.padEnd(14)} ${check.name}`);
  }
}
if (failed) process.exitCode = 1;
