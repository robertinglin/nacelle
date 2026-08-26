import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser-native VFS and module loading', () => {
  test('normalizes logical paths, preserves bytes, and keeps mount errors distinct', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const { fileURLToPath, pathToFileURL } = require('node:url');
        const file = '/node/vfs/bytes.bin';
        fs.mkdirSync('/node/vfs/dir', { recursive: true });
        fs.writeFileSync('/node/vfs/dir/../bytes.bin', new Uint8Array([0, 255, 1]));
        assert.deepStrictEqual([...fs.readFileSync('/node/vfs//./bytes.bin')], [0, 255, 1]);
        assert.strictEqual(fileURLToPath(pathToFileURL(file)), file);
        assert.throws(() => fs.readFileSync('/node/../outside'), (error) => {
          assert.strictEqual(error.code, 'ERR_CAPABILITY_DENIED');
          assert.strictEqual(error.path, '/outside');
          assert.strictEqual(error.syscall, 'open');
          return true;
        });
        assert.throws(() => fs.readFileSync('/node/vfs/missing.bin'), (error) => {
          assert.strictEqual(error.code, 'ENOENT');
          assert.strictEqual(error.path, '/node/vfs/missing.bin');
          return true;
        });
        process.stdout.write('vfs paths and errors completed');
      })();
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('vfs paths and errors completed');
  });

  test('enforces a nested read-only mount after fixture seeding', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        assert.strictEqual(fs.readFileSync('/node/readonly/seed.txt', 'utf8'), 'seeded');
        assert.throws(() => fs.writeFileSync('/node/readonly/new.txt', 'blocked'), (error) => {
          assert.strictEqual(error.code, 'ERR_CAPABILITY_DENIED');
          assert.strictEqual(error.path, '/node/readonly/new.txt');
          return true;
        });
        process.stdout.write('nested mount permissions completed');
      })();
    `, {
      files: { '/node/readonly/seed.txt': 'seeded' },
      capabilities: {
        vfs: { mounts: [
          { path: '/node', mode: 'read-write' },
          { path: '/node/readonly', mode: 'read-only' },
        ] },
        workers: { entryModules: ['*'], maxChildren: 8 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
        envVars: { allowed: [] },
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('nested mount permissions completed');
  });

  test('resolves VFS package entries and file URLs without host filesystem access', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import packageValue from 'demo-package';
      import fileValue from 'file:///node/modules/file-value.mjs';
      assert.strictEqual(packageValue.value, 7);
      assert.strictEqual(fileValue, 'file-url');
      process.stdout.write('module resolution completed');
    `, {
      entryPath: '/node/modules/main.mjs',
      files: {
        '/node/modules/node_modules/demo-package/package.json': JSON.stringify({ main: 'entry.cjs' }),
        '/node/modules/node_modules/demo-package/entry.cjs': 'module.exports = { value: 7 };',
        '/node/modules/file-value.mjs': 'export default "file-url";',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('module resolution completed');
  });

  test('reports existing native addons as a Node-style unsupported boundary', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      const native = new Uint8Array([0, 1, 2, 3]);
      try {
        await import('./fixture.node');
        assert.fail('native addon import unexpectedly succeeded');
      } catch (error) {
        assert.strictEqual(error.name, 'Error');
        assert.strictEqual(error.code, 'ERR_DLOPEN_FAILED');
        assert.strictEqual(error.path, '/node/native/fixture.node');
        assert.strictEqual(error.boundary, 'native-addons');
        assert.strictEqual(error.status, 'unsupported-boundary');
      }
      try {
        await import('./missing.node');
        assert.fail('missing native addon unexpectedly resolved');
      } catch (error) {
        assert.strictEqual(error.code, 'MODULE_NOT_FOUND');
      }
      assert.strictEqual(native[0], 0);
      process.stdout.write('native addon boundary completed');
    `, {
      entryPath: '/node/native/main.mjs',
      files: { '/node/native/fixture.node': new Uint8Array([0, 1, 2, 3]) },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('native addon boundary completed');
  });

  test('does not compile a native addon through synchronous CommonJS loading', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert/strict');
      try {
        require('./fixture.node');
        assert.fail('native addon require unexpectedly succeeded');
      } catch (error) {
        assert.strictEqual(error.name, 'Error');
        assert.strictEqual(error.code, 'ERR_DLOPEN_FAILED');
        assert.strictEqual(error.path, '/node/native/fixture.node');
        assert.strictEqual(error.boundary, 'native-addons');
        assert.strictEqual(error.status, 'unsupported-boundary');
      }
      process.stdout.write('commonjs native addon boundary completed');
    `, {
      entryPath: '/node/native/main.cjs',
      files: { '/node/native/fixture.node': new Uint8Array([0, 1, 2, 3]) },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('commonjs native addon boundary completed');
  });
});
