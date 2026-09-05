import assert from 'node:assert/strict';
import test from 'node:test';
import { createVfs } from '../../../../src/runtime/vfs.js';

test('vector writes publish complete bytes once and preserve explicit and implicit positions', () => {
  const vfs = createVfs();
  vfs.mount({ '/node/file': 'abcdef' });
  const fd = vfs.fs.openSync('/node/file', 'r+');
  const updates = [];
  vfs.subscribeMutations(update => updates.push(update));
  const bytes = new Uint8Array([0, 88, 89, 0]);
  const views = [bytes.subarray(1, 2), new Uint8Array(0), new DataView(bytes.buffer, 2, 1)];
  assert.equal(vfs.fs.writevSync(fd, views, 2), 2);
  assert.equal(vfs.fs.readFileSync('/node/file', 'utf8'), 'abXYef');
  assert.equal(updates.length, 1);
  assert.equal(new TextDecoder().decode(updates[0].bytes), 'abXYef');
  assert.equal(vfs.fs.writevSync(fd, [new Uint8Array([49]), new Uint8Array([50])]), 2);
  assert.equal(vfs.fs.writevSync(fd, [new Uint8Array([51])]), 1);
  assert.equal(vfs.fs.readFileSync('/node/file', 'utf8'), '123Yef');
  assert.equal(vfs.fs.writevSync(fd, [], 8), 0);
  assert.equal(vfs.fs.statSync('/node/file').size, 6);
  assert.throws(() => vfs.fs.writevSync(fd, [new Uint8Array([1]), 'invalid']), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(vfs.fs.readFileSync('/node/file', 'utf8'), '123Yef');
  vfs.fs.closeSync(fd);
});

test('asynchronous vector writes preserve callback identity and zero-fill file extension', async () => {
  const vfs = createVfs();
  vfs.mount({ '/node/file': 'A' });
  const fd = vfs.fs.openSync('/node/file', 'r+');
  const buffers = [new Uint8Array([66]), new Uint16Array([0x1234])];
  await new Promise((resolve, reject) => vfs.fs.writev(fd, buffers, 3, (error, written, returned) => {
    if (error) return reject(error);
    assert.equal(written, 3);
    assert.equal(returned, buffers);
    resolve();
  }));
  assert.deepEqual([...vfs.fs.readFileSync('/node/file')], [65, 0, 0, 66, ...new Uint8Array(buffers[1].buffer)]);
  vfs.fs.closeSync(fd);
});
