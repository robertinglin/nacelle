import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSerializedCaptureQueue } from '../citgm-capture.mjs';

test('serializes complete capture binding payloads and isolates binding errors', async () => {
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
      order.push(payload.index);
      if (payload.index === 2) throw new Error('consumer failed');
    },
  });

  for (let index = 0; index < 32; index += 1) queue('capture', { index });
  await queue.flush();

  assert.equal(maximum, 1);
  assert.equal(calls, 32);
  assert.deepEqual(order, Array.from({ length: 32 }, (_, index) => index));
});
