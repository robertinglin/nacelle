import assert from 'node:assert/strict';
import test from 'node:test';
import { createVfs } from '../../../../src/runtime/vfs.js';

test('symlink resolution permits bounded recursive traversal', () => {
  const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write' }] });
  vfs.mount({
    '/node/a/symlink/root.txt': 'root',
  }, {
    symlinks: [['/node/a/symlink/a/b/c', '../..']],
  });

  const repeated = '/node/a/symlink/a/b/c/a/b/c/a/b/c';
  assert.deepEqual(vfs.fs.readdirSync(repeated), ['a', 'root.txt']);
  assert.equal(vfs.fs.readFileSync(`${repeated}/root.txt`, 'utf8'), 'root');
  const tooDeep = `/node/a/symlink/${'a/b/c/'.repeat(42)}`;
  assert.throws(
    () => vfs.fs.readdirSync(tooDeep),
    { code: 'ELOOP' },
  );
});
