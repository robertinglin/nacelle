import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createVfs } from '../../../../src/runtime/vfs.js';

test('existsSync returns false when a path component is a file', () => {
  const vfs = createVfs();
  vfs.mount({ '/node/package.json': '{}' });

  assert.equal(vfs.fs.existsSync('/node/package.json/name'), false);
});

test('stat APIs honor throwIfNoEntry:false for optional package probes', async () => {
  const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write' }] });

  assert.equal(vfs.fs.statSync('/node/missing', { throwIfNoEntry: false }), undefined);
  assert.equal(vfs.fs.lstatSync('/node/missing', { throwIfNoEntry: false }), undefined);
  await new Promise((resolve, reject) => vfs.fs.stat('/node/missing', { throwIfNoEntry: false }, (error, value) => {
    if (error) reject(error);
    else {
      assert.equal(value, undefined);
      resolve();
    }
  }));
  await new Promise((resolve, reject) => vfs.fs.lstat('/node/missing', { throwIfNoEntry: false }, (error, value) => {
    if (error) reject(error);
    else {
      assert.equal(value, undefined);
      resolve();
    }
  }));
});

test('mount invalidates cached directory entries like the host filesystem', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'bnh-vfs-'));
  try {
    const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write' }] });
    vfs.mount({ '/node/first.txt': 'first' });
    writeFileSync(join(hostRoot, 'first.txt'), 'first');

    // Build the lazy index before a later package mount adds entries.
    assert.deepEqual(vfs.fs.readdirSync('/node').sort(), readdirSync(hostRoot).sort());

    vfs.mount({ '/node/second.txt': 'second', '/node/nested/entry.js': 'entry' });
    mkdirSync(join(hostRoot, 'nested'), { recursive: true });
    writeFileSync(join(hostRoot, 'second.txt'), 'second');
    writeFileSync(join(hostRoot, 'nested', 'entry.js'), 'entry');

    assert.deepEqual(vfs.fs.readdirSync('/node').sort(), readdirSync(hostRoot).sort());
    assert.deepEqual(vfs.fs.readdirSync('/node/nested').sort(), readdirSync(join(hostRoot, 'nested')).sort());
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
});
