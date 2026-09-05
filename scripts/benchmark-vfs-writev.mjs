import assert from 'node:assert/strict';
import { createVfs } from '../src/runtime/vfs.js';

const vfs = createVfs();
vfs.mount({ '/node/cache': '' });
const fd = vfs.fs.openSync('/node/cache', 'w');
let mutationBytes = 0;
vfs.subscribeMutations(update => { mutationBytes += update.bytes?.byteLength || 0; });
const buffers = Array.from({ length: 2048 }, () => new Uint8Array(4096));
const started = performance.now();
const written = vfs.fs.writevSync(fd, buffers);
const elapsedMs = performance.now() - started;
assert.equal(written, 8 * 1024 * 1024);
assert.equal(vfs.fs.statSync('/node/cache').size, written);
vfs.fs.closeSync(fd);
console.log(JSON.stringify({ written, elapsedMs, mutationBytes }));
