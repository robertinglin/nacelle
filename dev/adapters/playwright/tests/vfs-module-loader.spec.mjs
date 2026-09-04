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

  test('uses CommonJS extension probing for Module._resolveFilename', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert/strict');
        const Module = require('node:module');
        const resolved = Module._resolveFilename('../lib/target', module);
        assert.strictEqual(resolved, '/node/cjs-loader/lib/target.js');
        assert.strictEqual(require(resolved), 'resolved');
        process.stdout.write('CommonJS filename resolution completed');
      })();
    `, {
      entryPath: '/node/cjs-loader/test/entry.cjs',
      files: {
        '/node/cjs-loader/lib/target.js': 'module.exports = "resolved";\n',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('CommonJS filename resolution completed');
  });

  test('uses CommonJS package main when resolving a directory request', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert/strict');
        const Module = require('node:module');
        const resolved = Module._resolveFilename('..', module);
        assert.strictEqual(resolved, '/node/cjs-package/main.cjs');
        assert.strictEqual(require(resolved), 'package-main');
        process.stdout.write('CommonJS package main resolution completed');
      })();
    `, {
      entryPath: '/node/cjs-package/test/entry.cjs',
      files: {
        '/node/cjs-package/package.json': JSON.stringify({ main: 'main.cjs' }),
        '/node/cjs-package/main.cjs': 'module.exports = "package-main";\n',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('CommonJS package main resolution completed');
  });

  test('invokes overridden CommonJS extension handlers and preserves module require hooks', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert/strict');
        const Module = require('node:module');
        const original = Module._extensions['.js'];
        let invoked = false;
        Module._extensions['.js'] = (moduleRecord, filename) => {
          invoked = true;
          const originalRequire = moduleRecord.require;
          moduleRecord.require = (specifier) => specifier === './dep' ? 'extension-stub' : originalRequire(specifier);
          return original(moduleRecord, filename);
        };
        try {
          assert.strictEqual(require('/node/extension-hook/main.js'), 'extension-stub');
          assert.strictEqual(invoked, true);
        } finally {
          Module._extensions['.js'] = original;
        }
        process.stdout.write('CommonJS extension hook completed');
      })();
    `, {
      files: {
        '/node/extension-hook/main.js': 'module.exports = require(\'./dep\');\n',
        '/node/extension-hook/dep.js': 'module.exports = "original";\n',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('CommonJS extension hook completed');
  });

  test('preserves the CommonJS parent graph through Module._load', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert/strict');
        const Module = require('node:module');
        const child = Module._load('./child.cjs', module);
        assert.strictEqual(child.parent, '/node/module-parent/main.cjs');
        assert.strictEqual(child.main, '/node/module-parent/main.cjs');
        process.stdout.write('CommonJS parent graph completed');
      })();
    `, {
      entryPath: '/node/module-parent/main.cjs',
      files: {
        '/node/module-parent/child.cjs': [
          'module.exports = {',
          '  parent: module.parent && module.parent.filename,',
          '  main: require.main && require.main.filename,',
          '};',
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('CommonJS parent graph completed');
  });

  test('shares and invalidates the CommonJS require cache like Node', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const manifestPath = '/node/cache/manifest.json';
      fs.mkdirSync('/node/cache', { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify({ version: 1 }));

      const first = require(manifestPath);
      assert.strictEqual(first.version, 1);
      assert.strictEqual(require.cache[manifestPath].exports, first);
      assert.ok(Object.values(require.cache).some((module) => module?.filename === manifestPath));

      fs.writeFileSync(manifestPath, JSON.stringify({ version: 2 }));
      assert.strictEqual(require(manifestPath).version, 1);

      delete require.cache[manifestPath];
      assert.strictEqual(require.cache[manifestPath], undefined);
      assert.strictEqual(require(manifestPath).version, 2);
      process.stdout.write('CommonJS require cache completed');
    `, { entryPath: '/node/cache/main.cjs' });

    await expectPass(expect, result);
    expect(result.stdout).toContain('CommonJS require cache completed');
  });

  test('provides the standard readline line and terminal-control contract', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert/strict');
        const { PassThrough } = require('node:stream');
        const readline = require('node:readline');
        const input = new PassThrough();
        const outputChunks = [];
        const output = { write: (chunk) => { outputChunks.push(String(chunk)); return true; } };
        const interfaceInstance = readline.createInterface({ input, output, terminal: false });
        const lines = [];
        interfaceInstance.on('line', (line) => lines.push(line));
        const closed = new Promise((resolve) => interfaceInstance.once('close', resolve));
        input.end('first\\r\\nsecond\\nlast');
        await closed;
        assert.deepStrictEqual(lines, ['first', 'second', 'last']);

        const iteratorInput = new PassThrough();
        const iterator = readline.createInterface({ input: iteratorInput, terminal: false });
        const iteratorLines = (async () => {
          const values = [];
          for await (const line of iterator) values.push(line);
          return values;
        })();
        iteratorInput.end('one\\n two\\n');
        assert.deepStrictEqual(await iteratorLines, ['one', ' two']);

        readline.cursorTo(output, 2, 3);
        readline.moveCursor(output, -1, 1);
        readline.clearLine(output, 0);
        readline.clearScreenDown(output);
        assert.strictEqual(outputChunks.join(''), '\\u001b[4;3H\\u001b[1D\\u001b[1B\\u001b[2K\\u001b[0J');
        process.stdout.write('readline contract completed');
      })().catch((error) => {
        console.error(error.stack || error);
        process.exitCode = 1;
      });
    `, { entryPath: '/node/readline/main.cjs' });

    await expectPass(expect, result);
    expect(result.stdout).toContain('readline contract completed');
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
        // Dynamic ESM import reports the standard public module-resolution
        // code, while an existing addon remains the explicit unsupported
        // native boundary checked above.
        assert.strictEqual(error.code, 'ERR_MODULE_NOT_FOUND');
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

  test('initializes VFS write streams before readable pipes deliver data', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const { once, Readable } = require('node:stream');
        fs.mkdirSync('/node/streams', { recursive: true });
        const output = fs.createWriteStream('/node/streams/output.txt');
        assert.ok(output._writableState);
        assert.strictEqual(output._writableState.defaultEncoding, 'utf8');
        Readable.from(['native pipe']).pipe(output);
        await once(output, 'finish');
        assert.strictEqual(fs.readFileSync('/node/streams/output.txt', 'utf8'), 'native pipe');
        const constructed = new fs.WriteStream('/node/streams/constructed.txt');
        assert.ok(constructed._writableState);
        Readable.from(['constructed pipe']).pipe(constructed);
        await once(constructed, 'finish');
        assert.strictEqual(fs.readFileSync('/node/streams/constructed.txt', 'utf8'), 'constructed pipe');
        process.stdout.write('VFS write stream pipe completed');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('VFS write stream pipe completed');
  });

  test('initializes write streams through graceful-fs-style constructor wrappers', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const { once, Readable } = require('node:stream');
        fs.mkdirSync('/node/streams', { recursive: true });
        const NativeWriteStream = fs.WriteStream;
        function WrappedWriteStream(path, options) {
          if (this instanceof WrappedWriteStream) {
            NativeWriteStream.apply(this, arguments);
            return this;
          }
          return WrappedWriteStream.apply(Object.create(WrappedWriteStream.prototype), arguments);
        }
        WrappedWriteStream.prototype = Object.create(NativeWriteStream.prototype);
        WrappedWriteStream.prototype.constructor = WrappedWriteStream;
        const output = new WrappedWriteStream('/node/streams/wrapped.txt');
        assert.ok(output._writableState);
        Readable.from(['wrapped pipe']).pipe(output);
        await once(output, 'finish');
        assert.strictEqual(fs.readFileSync('/node/streams/wrapped.txt', 'utf8'), 'wrapped pipe');
        process.stdout.write('wrapped VFS write stream completed');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('wrapped VFS write stream completed');
  });
});
