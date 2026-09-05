import { pathToFileURL } from 'node:url';

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run with node --expose-gc scripts/benchmark-promise-retention.mjs [async-hooks module]');
}
const moduleUrl = process.argv[2]
  ? pathToFileURL(process.argv[2])
  : new URL('../src/runtime/async-hooks.js', import.meta.url);
const { createAsyncHooksModule } = await import(moduleUrl.href);
createAsyncHooksModule();
globalThis.__bnhUserCode = true;
const started = performance.now();
const iterations = 2000;
for (let index = 0; index < iterations; index += 1) {
  await Promise.resolve(new Uint8Array(32768)).then(() => {});
}
// Collect within the same job: an unnecessary WeakRef keeps each discarded
// promise (and its buffer) alive until the microtask checkpoint ends.
// A second synchronous collection finishes backing-store sweeping from the
// first before memoryUsage samples it. Keep both in this job: yielding would
// hide the WeakRef retention this benchmark is intended to catch.
globalThis.gc({ type: 'major', execution: 'sync' });
globalThis.gc({ type: 'major', execution: 'sync' });
console.log(JSON.stringify({
  iterations,
  milliseconds: performance.now() - started,
  retainedArrayBufferBytes: process.memoryUsage().arrayBuffers,
}));
delete globalThis.__bnhUserCode;
