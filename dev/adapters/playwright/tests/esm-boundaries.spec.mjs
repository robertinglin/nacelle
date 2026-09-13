import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

const capabilities = {
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 8 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
  envVars: { allowed: [] },
  proxy: { mode: 'proxy', enabled: true, capability: { proxy: true } },
};

test('preserves a granted proxy adapter for an ESM child', async ({ harnessPage, page }) => {
  await page.evaluate(() => {
    globalThis.__BNH_PROXY_ADAPTER__ = async () => ({ status: 200, body: 'proxy adapter survived' });
  });
  const result = await harnessPage.run(`
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    delete globalThis.__BNH_PROXY_ADAPTER__;
    const mainRequest = http.get('http://main-proxy.test/', (res) => {
      res.resume();
      res.once('end', () => {
        const child = spawn(process.execPath, ['--no-warnings', '/node/proxy-child.mjs']);
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
        child.once('close', (code, signal) => {
          process.stdout.write(JSON.stringify({ mainResponse: res.statusCode, code, signal, output, errorOutput }));
        });
      });
    });
    mainRequest.once('error', (error) => { throw error; });
  `, {
    capabilities,
    proxy: { mode: 'proxy', enabled: true, capability: { proxy: true } },
    files: {
      '/node/proxy-child.mjs': `
        import http from 'node:http';
        const response = await new Promise((resolve, reject) => {
          const request = http.get('http://proxy-child.test/', (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk.toString(); });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
          });
          request.once('error', reject);
        });
        process.stdout.write(JSON.stringify(response));
      `,
    },
  });

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.timedOut, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({
    mainResponse: 200,
    code: 0,
    signal: null,
    output: JSON.stringify({ statusCode: 200, body: 'proxy adapter survived' }),
    errorOutput: '',
  });
});

test('transports only serializable proxy capabilities to an ESM fork child', async ({ harnessPage, page }) => {
  await page.evaluate(() => {
    globalThis.__BNH_PROXY_ADAPTER__ = async () => ({ status: 200, body: 'fork proxy survived' });
  });
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');
    const child = fork('/node/proxy-fork-child.mjs');
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.once('close', (code, signal) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(signal, null);
      assert.strictEqual(output, 'fork proxy survived');
      process.stdout.write('fork proxy transport completed');
    });
  `, {
    capabilities,
    proxy: { mode: 'proxy', enabled: true, capability: { proxy: true } },
    files: {
      '/node/proxy-fork-child.mjs': `
        process.stdout.write('fork proxy survived');
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('fork proxy transport completed');
});

test('reports the Node-like synchronous ERR_REQUIRE_ESM boundary', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, [
      '--no-experimental-require-module',
      '/node/cjs-esm.js',
    ], { encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ status: child.status, signal: child.signal, stderr: child.stderr }));
  `, {
    files: {
      '/node/cjs-esm.js': `eval("require('./package-type-module/cjs.js')");`,
      '/node/package-type-module/cjs.js': 'module.exports = 1;',
      '/node/package-type-module/package.json': '{"type":"module"}',
    },
  });

  await expectPass(expect, result);
  const child = JSON.parse(result.stdout);
  expect(child.status).toBe(1);
  expect(child.signal).toBe(null);
  expect(child.stderr).toContain('Error [ERR_REQUIRE_ESM]: require() of ES Module /node/package-type-module/cjs.js from /node/cjs-esm.js not supported.');
  expect(child.stderr).toContain('Instead either rename cjs.js to end in .cjs, change the requiring code to use dynamic import() which is available in all CommonJS modules, or change "type": "module" to "type": "commonjs" in /node/package-type-module/package.json to treat all .js files as CommonJS (using .mjs for all ES modules instead).');
});

test('supports synchronous require of an ESM graph when the Node profile enables it', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, ['/node/cjs-requires-esm.js'], { encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }));
  `, {
    files: {
      '/node/cjs-requires-esm.js': `
        const value = require('./package-type-module/synchronous.js');
        const packageValue = require('demo-package');
        if (value.default !== 'default' || value.named !== 'named' || packageValue !== 'main') process.exit(1);
        process.stdout.write(JSON.stringify({ ...value, packageValue }));
      `,
      '/node/package-type-module/synchronous.js': `
        import first from './first.js';
        import second from './second.js';
        const imports = {};
        void imports;
        // export function ignoredByTheLowerer() {}
        export const named = first.value + second;
        export default 'default';
      `,
      '/node/package-type-module/first.js': "export default { value: (() => { return 'na'; })() };",
      '/node/package-type-module/second.js': "export default 'med';",
      '/node/package-type-module/package.json': '{"type":"module"}',
      '/node/node_modules/demo-package/package.json': '{"type":"module","main":"entry.cjs"}',
      '/node/node_modules/demo-package/entry.cjs': "module.exports = 'main';",
      '/node/node_modules/demo-package/index.mjs': "export default 'wrong';",
    },
  });

  await expectPass(expect, result);
  const child = JSON.parse(result.stdout);
  expect(child.status).toBe(0);
  expect(child.signal).toBe(null);
  expect(JSON.parse(child.stdout)).toEqual({ __esModule: true, default: 'default', named: 'named', packageValue: 'main' });
});

test('uses ESM conditions for static imports lowered inside synchronously required ESM', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const value = require('conditional-esm-parent');
    assert.strictEqual(value.selected, 'node import target');
    assert.throws(() => require('conditional-esm-child'), (error) => {
      assert.strictEqual(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
      return true;
    });
    process.stdout.write('conditional ESM export conditions completed');
  `, {
    files: {
      '/node/node_modules/conditional-esm-parent/package.json': JSON.stringify({
        name: 'conditional-esm-parent',
        type: 'module',
        exports: { types: './index.d.ts', default: './index.js' },
      }),
      '/node/node_modules/conditional-esm-parent/index.js': `
        import { selected } from 'conditional-esm-child';
        export { selected };
      `,
      '/node/node_modules/conditional-esm-child/package.json': JSON.stringify({
        name: 'conditional-esm-child',
        type: 'module',
        exports: {
          node: { types: './node.d.ts', import: './node.js' },
          default: { types: './default.d.ts', import: './default.js' },
        },
      }),
      '/node/node_modules/conditional-esm-child/node.js': `export const selected = 'node import target';`,
      '/node/node_modules/conditional-esm-child/default.js': `export const selected = 'default import target';`,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('conditional ESM export conditions completed');
});

test('preserves subclass prototypes when a virtual process constructs Function subclasses', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    class FunctionBase extends Function {
      constructor() {
        super('return 42');
      }
    }
    class DerivedFunction extends FunctionBase {
      marker() { return 'prototype survived'; }
    }
    const value = new DerivedFunction();
    assert.strictEqual(value(), 42);
    assert.strictEqual(value.marker(), 'prototype survived');
    assert.strictEqual(value instanceof DerivedFunction, true);
    process.stdout.write('Function subclass prototype completed');
  `);

  await expectPass(expect, result);
  expect(result.stdout).toContain('Function subclass prototype completed');
});

test('preserves callable class error prototypes and process stream descriptors', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    function callable(cls) {
      const result = { [cls.name]: function (...args) {
        const thisClass = new.target === result || !new.target;
        return Reflect.construct(cls, args, thisClass ? cls : new.target);
      } };
      result[cls.name].prototype = cls.prototype;
      cls.prototype[Symbol.toStringTag] = cls.name;
      return result[cls.name];
    }
    const ArgumentError = callable(class ArgumentError extends Error {});
    const error = new ArgumentError('expected');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
    assert.strictEqual(error instanceof ArgumentError, true);
    assert.strictEqual(Object.getPrototypeOf(error), ArgumentError.prototype);
    assert.throws(() => { throw error; }, ArgumentError);
    assert.strictEqual(stdoutDescriptor.enumerable, true);
    assert.strictEqual(stdoutDescriptor.configurable, true);
    assert.strictEqual(typeof stdoutDescriptor.get, 'function');
    class StdIOBuffer {
      write() {}
    }
    class SystemExit extends Error {}
    class ParserError extends Error {}
    const captureParserExit = (fn) => {
      if (process.stdout instanceof StdIOBuffer || process.stderr instanceof StdIOBuffer) return fn();
      const oldStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
      const oldStderr = Object.getOwnPropertyDescriptor(process, 'stderr');
      Object.defineProperty(process, 'stdout', { value: new StdIOBuffer() });
      Object.defineProperty(process, 'stderr', { value: new StdIOBuffer() });
      try {
        try { return fn(); }
        catch (caught) {
          if (!(caught instanceof SystemExit)) throw caught;
          throw new ParserError('captured');
        }
      } finally {
        Object.defineProperty(process, 'stdout', oldStdout);
        Object.defineProperty(process, 'stderr', oldStderr);
      }
    };
    const BaseParser = callable(class BaseParser {
      parse_args() { return this.error('bad'); }
      error(message) { return this.exit(2, message); }
      exit() { throw new SystemExit(); }
    });
    class ErrorRaisingParser extends BaseParser {
      parse_args(...args) { return captureParserExit(() => super.parse_args(...args)); }
      error(...args) { return captureParserExit(() => super.error(...args)); }
      exit(...args) { return captureParserExit(() => super.exit(...args)); }
    }
    assert.throws(() => new ErrorRaisingParser().parse_args(), ParserError);
    process.stdout.write('callable error and stream descriptor completed');
  `);

  await expectPass(expect, result);
  expect(result.stdout).toContain('callable error and stream descriptor completed');
});

test('accepts browser class-call TypeError wording in CommonJS package code', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const compatible = require('/node/node_modules/class-call-wording-fixture');
    assert.strictEqual(compatible, true);
    process.stdout.write('class-call wording completed');
  `, {
    files: {
      '/node/node_modules/class-call-wording-fixture/package.json': JSON.stringify({
        name: 'class-call-wording-fixture',
        main: 'index.js',
      }),
      '/node/node_modules/class-call-wording-fixture/index.js': `
        module.exports = (() => {
          class C {}
          const nodeClassError = /Class constructor .* cannot be invoked without 'new'/;
          try { C('value'); } catch (error) { return nodeClassError.test(error.message); }
          return false;
        })();
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('class-call wording completed');
});

test('allows ESM bindings that overlap synthetic CommonJS wrapper names', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const value = require('/node/esm-binding-collision.mjs');
    assert.strictEqual(value.default, 'esm binding survived');
    assert.strictEqual(value.enumValue, 'enum-like value survived');
    process.stdout.write('ESM binding collision completed');
  `, {
    files: {
      '/node/esm-binding-collision.mjs': `
        import {enumValue} from './empty-export.js';
        const __dirname = 'an ESM-local binding';
        export default 'esm binding survived';
        export {enumValue};
      `,
      '/node/empty-export.js': `
        export {};
        export var enumValue;
        enumValue = 'enum-like value survived';
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('ESM binding collision completed');
});

test('supports the ESM module.exports interop export name', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const callable = require('/node/esm-module-exports.mjs');
    assert.strictEqual(callable(), 'callable export survived');
    process.stdout.write('ESM module.exports interop completed');
  `, {
    files: {
      '/node/esm-module-exports.mjs': `
        const callable = () => 'callable export survived';
        export {callable as 'module.exports'};
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toContain('ESM module.exports interop completed');
});

test('isolates a nested ESM fork from its parent execution gate', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { fork } = require('node:child_process');
    const child = fork('/node/parent.mjs', [], {
      cwd: '/node',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.once('message', (value) => process.stdout.write(String(value)));
    child.once('error', (error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
    child.once('exit', (code) => { if (code !== 0) process.exitCode = code ?? 1; });
  `, {
    timeoutMs: 2_000,
    files: {
      '/node/parent.mjs': `
        import { fork } from 'node:child_process';
        const child = fork('/node/leaf.mjs', [], {
          cwd: '/node',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        child.once('message', (value) => {
          process.send('parent:' + value, (error) => {
            if (error) process.exitCode = 1;
            else process.exit(0);
          });
        });
        child.once('error', (error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `,
      '/node/leaf.mjs': `
        process.send('leaf');
        setTimeout(() => process.exit(0), 10);
      `,
    },
  });

  await expectPass(expect, result);
  expect(result.stdout).toBe('parent:leaf');
});

test('keeps the owning process environment in a same-realm native ESM graph', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert/strict');
    const { fork } = require('node:child_process');
    const launch = (label, delay) => new Promise((resolve, reject) => {
      const child = fork('/node/process-env-child.js', [label, String(delay)], {
        env: { ...process.env, BNH_CHILD_ENV: label },
      });
      child.once('error', reject);
      child.once('message', (message) => {
        try {
          assert.deepStrictEqual(message, {
            label,
            before: label,
            after: label,
            pid: message.pid,
          });
          resolve(message);
        } catch (error) {
          reject(error);
        }
      });
    });
    Promise.all([launch('first', 5), launch('second', 0)]).then(
      () => {},
      (error) => {
        console.error(error.stack || error);
        process.exitCode = 1;
      },
    );
  `, {
    files: {
      '/node/process-env-child.js': `
        const label = process.argv[2];
        const delay = Number(process.argv[3]);
        setTimeout(() => {
          import('/node/process-env-route.mjs').then((module) => {
            process.send({ label, before: module.before, after: module.after, pid: module.pid });
          }, (error) => {
            process.send({ error: String(error) });
          });
        }, delay);
      `,
      '/node/process-env-route.mjs': `
        export const pid = process.pid;
        export const before = process.env.BNH_CHILD_ENV;
        await Promise.resolve();
        export const after = process.env.BNH_CHILD_ENV;
      `,
    },
  });

  await expectPass(expect, result);
});
