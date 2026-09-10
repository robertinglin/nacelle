import assert from 'node:assert/strict';
import test from 'node:test';
import { createModuleLoader } from '../../../../src/runtime/module-loader.js';

for (const value of ['export default "café";', new TextEncoder().encode('export default "café";')]) {
  test(`load hooks receive a UTF-8 Buffer from ${typeof value} VFS source`, async () => {
    let seen = false;
    const loader = createModuleLoader({
      files: new Map([['/node/value.mjs', value]]),
      builtins: { buffer: { Buffer } },
      readSource: () => 'decoded source must not replace the raw hook input',
      runModuleHook(name, url, context, next) {
        const result = next(url, context);
        if (name === 'load') {
          assert.ok(Buffer.isBuffer(result.source));
          assert.equal(result.source.toString(), 'export default "café";');
          seen = true;
        }
        return result;
      },
    });
    try {
      assert.equal((await loader.import('/node/value.mjs')).default, 'café');
      assert.ok(seen);
    } finally {
      loader.dispose();
    }
  });
}

test('rewrites export-from specifiers when an exported name contains from', async () => {
  const loader = createModuleLoader({
    files: new Map([
      ['/node/index.mjs', "export {default as 'prefer-export-from'} from './dependency.mjs';"],
      ['/node/dependency.mjs', 'export default 42;'],
    ]),
    builtins: {},
    defaultModuleType: 'module',
  });
  try {
    const namespace = await loader.import('/node/index.mjs');
    assert.equal(namespace['prefer-export-from'], 42);
  } finally {
    loader.dispose();
  }
});
