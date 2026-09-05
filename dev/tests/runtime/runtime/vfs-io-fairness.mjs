import assert from 'node:assert/strict';
import test from 'node:test';
import { createVfs } from '../../../../src/runtime/vfs.js';

for (const missing of [false, true]) {
  test(`long chains of ${missing ? 'failed' : 'successful'} filesystem promises allow timers to run`, async () => {
    let activeTasks = 0;
    const vfs = createVfs({ trackTask: () => {
      activeTasks += 1;
      return () => { activeTasks -= 1; };
    } });
    vfs.mount({ '/node/input': 'contents' });
    let completed = 0;
    let observed = null;
    const timer = setTimeout(() => { observed = completed; }, 0);
    try {
      while (completed < 1000) {
        if (missing) {
          await assert.rejects(vfs.fs.promises.readFile('/node/missing'), { code: 'ENOENT' });
        } else {
          assert.equal(await vfs.fs.promises.readFile('/node/input', 'utf8'), 'contents');
        }
        completed += 1;
      }
      assert.ok(observed !== null && observed > 0 && observed < completed);
      assert.equal(activeTasks, 0);
    } finally {
      clearTimeout(timer);
    }
  });
}

test('yielding filesystem completions preserve queued mutation ordering', async () => {
  const vfs = createVfs();
  vfs.mount({ '/node/input': '' });
  const writes = Array.from({ length: 300 }, (_, index) => vfs.fs.promises.appendFile('/node/input', `${index},`));
  const contents = await vfs.fs.promises.readFile('/node/input', 'utf8');
  await Promise.all(writes);
  assert.equal(contents, Array.from({ length: 300 }, (_, index) => `${index},`).join(''));
});
