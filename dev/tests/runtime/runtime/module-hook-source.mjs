import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
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

test('async loader hooks decode SharedArrayBuffer-backed source', async (t) => {
  const encoded = new TextEncoder().encode('export default "shared source";');
  const shared = new Uint8Array(new SharedArrayBuffer(encoded.length + 8));
  shared.set(encoded, 4);
  const source = shared.subarray(4, 4 + encoded.length);
  const NativeTextDecoder = globalThis.TextDecoder;
  t.mock.method(globalThis, 'TextDecoder', function () {
    const decoder = new NativeTextDecoder();
    return {
      decode(input) {
        assert.equal(input.buffer instanceof SharedArrayBuffer, false);
        return decoder.decode(input);
      },
    };
  });
  const loader = createModuleLoader({
    files: new Map([['/node/shared-hook.mjs', source]]),
    builtins: {},
    runModuleHook(name, url, context, next) {
      if (name === 'load') return { format: 'module', source };
      return next(url, context);
    },
  });
  try {
    assert.equal((await loader.import('/node/shared-hook.mjs')).default, 'shared source');
  } finally {
    loader.dispose();
  }
});

test('async loader hooks decode cross-realm source', async (t) => {
  const encoded = new TextEncoder().encode('export default "cross realm source";');
  const source = vm.runInNewContext(`Uint8Array.from(${JSON.stringify([...encoded])})`);
  const NativeTextDecoder = globalThis.TextDecoder;
  t.mock.method(globalThis, 'TextDecoder', function () {
    const decoder = new NativeTextDecoder();
    return {
      decode(input) {
        assert.equal(Object.getPrototypeOf(input), Uint8Array.prototype);
        return decoder.decode(input);
      },
    };
  });
  const loader = createModuleLoader({
    files: new Map([['/node/cross-realm-hook.mjs', source]]),
    builtins: {},
    runModuleHook(name, url, context, next) {
      if (name === 'load') return { format: 'module', source };
      return next(url, context);
    },
  });
  try {
    assert.equal((await loader.import('/node/cross-realm-hook.mjs')).default, 'cross realm source');
  } finally {
    loader.dispose();
  }
});

test('async tap mock loaders await generated module source', async () => {
  const serviceSymbol = Symbol.for('__tapmocktest$instance');
  globalThis[serviceSymbol] = {
    load: () => Promise.resolve('export const stat = 1;'),
  };
  const loader = createModuleLoader({
    files: new Map([[
      '/node/entry.mjs',
      'import { stat } from "mocked"; export default stat;',
    ]]),
    builtins: {},
    runModuleHook(name, value, context, next) {
      if (name === 'resolve' && value === 'mocked') {
        return { url: 'tapmock://test.instance/?url=node%3Afs%2Fpromises', format: 'module' };
      }
      return next(value, context);
    },
  });
  try {
    const namespace = await loader.import('/node/entry.mjs');
    assert.equal(namespace.default, 1);
  } finally {
    loader.dispose();
    delete globalThis[serviceSymbol];
  }
});

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

test('preserves the default binding when re-exporting JSON', async () => {
  const loader = createModuleLoader({
    files: new Map([
      ['/node/index.mjs', "export {default} from './package.json' with { type: 'json' };"],
      ['/node/package.json', '{"name":"fixture"}'],
    ]),
    builtins: {},
    defaultModuleType: 'module',
  });
  try {
    const namespace = await loader.import('/node/index.mjs');
    assert.deepEqual(namespace.default, { name: 'fixture' });
  } finally {
    loader.dispose();
  }
});
