#!/usr/bin/env node
import readline from 'node:readline';
import process from 'node:process';
import { createAdapter, executeSafely } from './adapter-core.mjs';

const adapter = await createAdapter();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

async function shutdown() {
  try { await adapter.close(); } finally { process.exit(0); }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    const result = await executeSafely(adapter, request);
    result.request_id = request.request_id;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      request_id: request?.request_id,
      status: 'infra_error',
      exit_code: null,
      duration_ms: 0,
      stdout: '',
      stderr: error?.stack || String(error),
      details: {},
    })}\n`);
  }
}
await adapter.close();
