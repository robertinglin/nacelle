import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { selectEntries } from '../../../../scripts/run-citgm-top-100.mjs';

const manifestUrl = new URL('../../../../dev/adapters/playwright/citgm-top-100.json', import.meta.url);

test('pins exactly the submitted top-100 package ranking', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.packages.length, 100);
  assert.deepEqual(manifest.packages.slice(0, 3).map(({ rank, name }) => ({ rank, name })), [
    { rank: 1, name: 'semver' },
    { rank: 2, name: 'minimatch' },
    { rank: 3, name: 'debug' },
  ]);
  assert.deepEqual(manifest.packages.slice(-3).map(({ rank, name }) => ({ rank, name })), [
    { rank: 98, name: 'to-regex-range' },
    { rank: 99, name: 'fast-json-stable-stringify' },
    { rank: 100, name: 'get-intrinsic' },
  ]);
  assert.equal(new Set(manifest.packages.map(({ name }) => name)).size, 100);
  assert.deepEqual(manifest.packages.map(({ rank }) => rank), Array.from({ length: 100 }, (_, index) => index + 1));
});

test('selects an inclusive rank range for resumable CITGM batches', () => {
  const manifest = {
    packages: [
      { rank: 1, name: 'first' },
      { rank: 2, name: 'second' },
      { rank: 3, name: 'third' },
    ],
  };
  assert.deepEqual(selectEntries(manifest, { from: 2, to: 3 }), manifest.packages.slice(1));
  assert.throws(() => selectEntries(manifest, { from: 0, to: 2 }), /rank range/);
  assert.throws(() => selectEntries(manifest, { from: 2, to: 4 }), /rank range/);
});
