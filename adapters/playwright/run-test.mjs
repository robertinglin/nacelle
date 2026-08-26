#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createAdapter, executeSafely } from './adapter-core.mjs';

const raw = process.argv[2] || process.env.BNH_REQUEST_FILE;
if (!raw) throw new Error('request JSON path is required');
const requestPath = path.resolve(raw);
const request = JSON.parse(await readFile(requestPath, 'utf8'));
const adapter = await createAdapter();
try {
  const output = await executeSafely(adapter, request);
  await writeFile(request.paths.result, JSON.stringify(output), 'utf8');
} finally {
  await adapter.close();
}
