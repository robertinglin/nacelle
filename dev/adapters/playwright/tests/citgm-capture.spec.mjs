import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSerializedCaptureQueue } from '../citgm-capture.mjs';
import { npmCacheSnapshot } from '../citgm-cache.mjs';

test('batches complete capture payloads, preserves order, and isolates binding errors', async () => {
  const order = [];
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const queue = createSerializedCaptureQueue({
    capture: async (payload) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      calls += 1;
      const payloads = Array.isArray(payload?.events) ? payload.events : [payload];
      order.push(...payloads.map((item) => item.index));
      if (payloads.some((item) => item.index === 2)) throw new Error('consumer failed');
    },
  });

  for (let index = 0; index < 32; index += 1) queue('capture', { index });
  await queue.flush();

  assert.equal(maximum, 1);
  assert.equal(calls, 1);
  assert.deepEqual(order, Array.from({ length: 32 }, (_, index) => index));
});

test('keeps worker npm cache descriptors fetchable without cloning package contents', () => {
  const cache = {
    memoryMeta: new Map([['large-package', { versions: { '1.0.0': { name: 'large-package' } } }]]),
    memoryTarballs: new Map([['pkg-tarball:large-package@1.0.0', new Uint8Array(1024 * 1024)]]),
    artifactManifest: {
      metadata: { 'large-package': 'metadata/large.json' },
      tarballs: { 'pkg-tarball:large-package@1.0.0': 'tarballs/large.tgz' },
    },
    artifactBaseUrl: new URL('https://example.test/cache/'),
  };

  const snapshot = npmCacheSnapshot(cache);
  assert.deepEqual(snapshot.metadata, {});
  assert.deepEqual(snapshot.tarballs, {});
  assert.deepEqual(snapshot.artifact, {
    baseUrl: 'https://example.test/cache/',
    metadata: { 'large-package': 'metadata/large.json' },
    tarballs: { 'pkg-tarball:large-package@1.0.0': 'tarballs/large.tgz' },
  });
});
