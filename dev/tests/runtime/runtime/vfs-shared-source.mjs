import assert from 'node:assert/strict';
import test from 'node:test';
import { createVfs } from '../../../../src/runtime/vfs.js';

test('source reads decode shared worker snapshots using unshared bytes', (t) => {
  const source = 'module.exports = "héllo 🌍";';
  const encoded = new TextEncoder().encode(source);
  const shared = new Uint8Array(new SharedArrayBuffer(encoded.length + 8));
  shared.fill(33);
  shared.set(encoded, 4);
  const bytes = shared.subarray(4, 4 + encoded.length);
  const files = new Map();
  const vfs = createVfs({ backend: { files } });
  vfs.mount({ '/node/shared.cjs': bytes, '/node/plain.cjs': source }, { copyBuffers: false });
  assert.equal(files.get('/node/shared.cjs').buffer, shared.buffer);
  const version = vfs.fileVersion('/node/shared.cjs');
  const NativeTextDecoder = globalThis.TextDecoder;
  // Node accepts shared input, but browser TextDecoder rejects it.
  t.mock.method(globalThis, 'TextDecoder', function () {
    const decoder = new NativeTextDecoder();
    return {
      decode(input) {
        assert.equal(input.buffer instanceof SharedArrayBuffer, false);
        return decoder.decode(input);
      },
    };
  });
  assert.equal(vfs.readSource('/node/shared.cjs'), source);
  assert.equal(vfs.readSource('/node/plain.cjs'), source);
  assert.equal(vfs.fileVersion('/node/shared.cjs'), version);
  assert.equal(files.get('/node/shared.cjs'), bytes);
});
