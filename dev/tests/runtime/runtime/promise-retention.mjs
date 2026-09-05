import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Nacelle } from '../../../../src/index.js';

test('settled promises release their large results before the job ends', () => {
  const benchmark = fileURLToPath(new URL('../../../../scripts/benchmark-promise-retention.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--expose-gc', benchmark], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const measured = JSON.parse(result.stdout);
  assert.ok(measured.retainedArrayBufferBytes < 1024 * 1024, JSON.stringify(measured));
});

test('promise callbacks expose the same execution resource observed by init hooks', async () => {
  const node = await Nacelle.create({ gateway: false });
  const child = await node.execute(`
    const assert = require('node:assert/strict');
    const { createHook, executionAsyncId, executionAsyncResource } = require('node:async_hooks');
    const resources = new Map();
    const hook = createHook({
      init(id, type, _trigger, resource) {
        if (type === 'PROMISE') resources.set(id, resource);
      },
    }).enable();
    Promise.resolve().then(() => {
      assert.ok(resources.has(executionAsyncId()));
      assert.equal(executionAsyncResource(), resources.get(executionAsyncId()));
      throw new Error('expected rejection');
    }).catch((error) => {
      assert.equal(error.message, 'expected rejection');
      assert.ok(resources.has(executionAsyncId()));
      assert.equal(executionAsyncResource(), resources.get(executionAsyncId()));
      hook.disable();
      console.log('resource identity preserved');
    });
  `);
  assert.equal(await child.exit, 0);
  assert.equal(await child.stderrText(), '');
  assert.match(await child.stdoutText(), /resource identity preserved/);
});
