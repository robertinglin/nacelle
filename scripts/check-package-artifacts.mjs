#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const targetList = [];
const collect = (value) => {
  if (typeof value === 'string') targetList.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(collect);
};
collect(packageJson.exports);
for (const target of targetList) {
  if (!target.startsWith('./dist/')) continue;
  const targetPath = path.join(root, target.slice(2).replace(/\/\*$/, ''));
  if (!fs.existsSync(targetPath)) throw new Error(`missing published artifact: ${target}`);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const rawReport = Buffer.concat(chunks).toString('utf8').trim();
if (!rawReport) throw new Error('npm pack report is required on stdin');
let report;
try {
  const parsed = JSON.parse(rawReport);
  report = Array.isArray(parsed) ? parsed.at(-1) : parsed;
} catch {
  throw new Error('npm pack did not produce JSON output');
}
const packed = new Set((report?.files || []).map((file) => file.path));
for (const target of targetList) {
  if (!target.startsWith('./dist/') || target.endsWith('/*')) continue;
  const relative = target.slice(2);
  if (![...packed].some((file) => file === relative)) throw new Error(`published export was omitted from npm pack: ${target}`);
}
console.log(`package artifacts passed: ${packed.size} files in npm pack dry-run`);
