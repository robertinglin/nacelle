import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformContract } from '../../../../src/runtime/os-platform.js';

test('browser os constants expose errno values used by npm filesystem packages', () => {
  const { os } = createPlatformContract();

  assert.equal(os.constants.errno.EEXIST, 17);
  assert.equal(os.constants.errno.EISDIR, 21);
  assert.equal(os.constants.errno.EINVAL, 22);
  assert.equal(os.constants.errno.ENOTDIR, 20);
});

test('browser os exposes the configured worker parallelism to Node tooling', () => {
  const { os } = createPlatformContract({ parallelism: 4 });

  assert.equal(os.availableParallelism(), 4);
  assert.equal(os.cpus().length, 4);
});
