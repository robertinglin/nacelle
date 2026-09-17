import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync as nativeStatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGlob } from '../../../../src/runtime/fs-glob.js';
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

test('stat APIs return Node-compatible BigInt metadata when requested', () => {
  const vfs = createVfs();
  vfs.mount({ '/node/package.json': '{}' });
  const nativeStats = nativeStatSync(new URL(import.meta.url), { bigint: true });
  const fields = [
    'dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size',
    'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs',
    'atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs',
  ];

  for (const stats of [
    vfs.fs.statSync('/node/package.json', { bigint: true }),
    vfs.fs.lstatSync('/node/package.json', { bigint: true }),
  ]) {
    for (const field of fields) assert.equal(typeof stats[field], typeof nativeStats[field], field);
    assert.equal(stats.isFile(), true);
    assert.equal(stats.isDirectory(), false);
    assert.equal(stats.isSymbolicLink(), false);
    assert.equal(stats.isBlockDevice(), false);
    assert.equal(stats.isCharacterDevice(), false);
    assert.equal(stats.isFIFO(), false);
    assert.equal(stats.isSocket(), false);
    assert.equal(stats.atimeMs, stats.atimeNs / 1_000_000n);
    assert.equal(stats.mtimeMs, stats.mtimeNs / 1_000_000n);
    assert.equal(stats.ctimeMs, stats.ctimeNs / 1_000_000n);
    assert.equal(stats.birthtimeMs, stats.birthtimeNs / 1_000_000n);
  }
});

test('read-only virtual root is visible above a scoped mount', () => {
  const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write' }] });

  assert.equal(vfs.fs.statSync('/').isDirectory(), true);
  assert.deepEqual(vfs.fs.readdirSync('/'), ['node']);
  assert.throws(() => vfs.fs.readFileSync('/package.json'), { code: 'ENOENT' });
  assert.throws(() => vfs.fs.mkdirSync('/outside'), { code: 'ERR_CAPABILITY_DENIED' });
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

test('glob excludes prune ignored directory trees', () => {
  const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write' }] });
  vfs.mount({
    '/node/project/index.js': 'export default 1;',
    '/node/project/node_modules/dependency/index.js': 'export default 2;',
  });

  assert.deepEqual(
    vfs.fs.globSync('**/*.js', { cwd: '/node/project', exclude: ['node_modules'] }),
    ['index.js'],
  );
});

test('glob traversal does not visit unrelated subtrees', () => {
  const tree = new Map([
    ['/node/project', ['index.js', 'node_modules', 'src']],
    ['/node/project/src', ['nested.js']],
    ['/node/project/node_modules', ['dependency']],
    ['/node/project/node_modules/dependency', ['index.js']],
  ]);
  const files = new Set(['/node/project/index.js', '/node/project/src/nested.js', '/node/project/node_modules/dependency/index.js']);
  let listCalls = 0;
  const entries = (path) => {
    listCalls += 1;
    return (tree.get(path) || []).map((name) => ({ name }));
  };
  const stats = (path) => ({
    isFile: () => files.has(path),
    isDirectory: () => tree.has(path),
    isSymbolicLink: () => false,
  });
  const glob = createGlob({
    resolvePath: (path) => String(path),
    listEntries: entries,
    statPath: (path) => {
      if (!files.has(path) && !tree.has(path)) throw new Error('ENOENT');
      return stats(path);
    },
    lstatPath: (path) => stats(path),
    roots: () => ['/node'],
    makeDirent: () => null,
    invalidType: (name, value, expected) => new TypeError(`${name} must be ${expected}: ${value}`),
  });

  assert.deepEqual(glob.globSync('*.js', { cwd: '/node/project' }), ['index.js']);
  assert.equal(listCalls, 1, 'a direct glob must not crawl nested or ignored directories');
});
