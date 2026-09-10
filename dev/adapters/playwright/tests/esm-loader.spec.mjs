import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';
import { createModuleLoader } from '../runtime/module-loader.js';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('preserves the node: prefix for builtin module identity', () => {
  const loader = createModuleLoader({
    files: new Map(),
    builtins: { assert: {} },
    globalObject: {},
  });

  expect(loader.resolve('assert')).toBe('assert');
  expect(loader.resolve('node:assert')).toBe('node:assert');
  expect(loader.moduleURL('assert')).not.toBe(loader.moduleURL('node:assert'));

  loader.dispose();
});

test.describe('browser ESM loader', () => {
  test('runs a mounted mjs entry with VFS-relative modules and builtins', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { answer, moduleURL } from './answer.mjs';
      import cjsValue from './fixture.cjs';
      const dynamic = await import('./dynamic.mjs');
      assert.strictEqual(answer, 42);
      assert.strictEqual(cjsValue, 'from commonjs');
      assert.strictEqual(dynamic.value, 84);
      assert.strictEqual(moduleURL, '/node/esm/answer.mjs');
      process.stdout.write('esm entry completed');
    `, {
      entryPath: '/node/esm/main.mjs',
      files: {
        '/node/esm/answer.mjs': `
          import { fileURLToPath } from 'node:url';
          export const answer = 42;
          export const moduleURL = fileURLToPath(import.meta.url);
        `,
        '/node/esm/dynamic.mjs': 'export const value = 84;',
        '/node/esm/fixture.cjs': "module.exports = 'from commonjs';",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('esm entry completed');
  });

  test('provides a Node-shaped virtual URL when a package receives bare import.meta', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { filenameFromMeta } from './meta-helper.mjs';
      assert.strictEqual(filenameFromMeta(import.meta), '/node/esm/meta-entry.mjs');
      process.stdout.write('bare import.meta completed');
    `, {
      entryPath: '/node/esm/meta-entry.mjs',
      files: {
        '/node/esm/meta-helper.mjs': `
          import { fileURLToPath } from 'node:url';
          export const filenameFromMeta = (sourceModule) => fileURLToPath(sourceModule.url);
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('bare import.meta completed');
  });

  test('maps generated Blob paths through node:url back to their VFS source path', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const [blobURL, virtualPath] = [...globalThis.__BNH_BLOB_VIRTUAL_PATHS__.entries()]
        .find(([, path]) => path.endsWith('/stack-source.mjs'));
      assert.equal(fileURLToPath(pathToFileURL(blobURL + '#stack')), virtualPath);
      process.stdout.write('Blob path completed');
    `, {
      entryPath: '/node/esm/stack-source.mjs',
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('Blob path completed');
  });

  test('keeps file URL queries as distinct ESM module identities', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      process.env.BNH_QUERY_IDENTITY = 'first';
      const first = await import('./query-identity.mjs?first');
      process.env.BNH_QUERY_IDENTITY = 'second';
      const second = await import('./query-identity.mjs?second');
      assert.equal(first.value, 'first');
      assert.equal(second.value, 'second');
      assert.notStrictEqual(first, second);
      process.stdout.write('query identity completed');
    `, {
      entryPath: '/node/esm/query-identity-entry.mjs',
      files: {
        '/node/esm/query-identity.mjs': 'export const value = process.env.BNH_QUERY_IDENTITY;',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('query identity completed');
  });

  test('provides structured capture stacks to V8-compatible consumers', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { externalConstructor } from './external-stack-helper.mjs';
      function captureFromHere() {
        const target = {};
        Error.captureStackTrace(target, captureFromHere);
        return target.stack;
      }
      const originalPrepare = Error.prepareStackTrace;
      Error.prepareStackTrace = (_error, callSites) => callSites;
      const stack = captureFromHere();
      Error.prepareStackTrace = originalPrepare;
      assert.ok(Array.isArray(stack), typeof stack);
      assert.ok(stack.length > 0);
      assert.equal(typeof stack[0].getFileName, 'function');
      function tapStyleCapture(limit, fn = tapStyleCapture) {
        const previousPrepare = Error.prepareStackTrace;
        const previousLimit = Error.stackTraceLimit;
        Error.prepareStackTrace = (_error, callSites) => callSites;
        Error.stackTraceLimit = limit + 10;
        const object = { stack: [] };
        Error.captureStackTrace(object, fn);
        const captured = object.stack;
        Error.prepareStackTrace = previousPrepare;
        Error.stackTraceLimit = previousLimit;
        return captured.filter(Boolean).slice(0, limit);
      }
      assert.ok(tapStyleCapture(1, captureFromHere).length > 0);
      const previousPrepare = Error.prepareStackTrace;
      Error.prepareStackTrace = (_error, callSites) => callSites;
      const crossModuleTarget = { stack: [] };
      Error.captureStackTrace(crossModuleTarget, externalConstructor);
      const crossModuleStack = crossModuleTarget.stack;
      Error.prepareStackTrace = previousPrepare;
      assert.ok(Array.isArray(crossModuleStack));
      process.stdout.write('structured stack completed');
    `, {
      entryPath: '/node/esm/structured-stack.mjs',
      files: { '/node/esm/external-stack-helper.mjs': 'export function externalConstructor() {}' },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('structured stack completed');
  });

  test('preserves structured capture stacks in nested ESM node processes', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      const child = spawnSync('node', ['/node/esm/nested-structured-stack.mjs'], {
        encoding: 'utf8',
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'nested structured stack completed');
      process.stdout.write('nested structured stack completed');
    `, {
      entryPath: '/node/esm/nested-structured-stack-entry.mjs',
      files: {
        '/node/esm/nested-structured-stack.mjs': `
          import assert from 'node:assert/strict';
          function caller() {}
          const previousPrepare = Error.prepareStackTrace;
          Error.prepareStackTrace = (_error, callSites) => callSites;
          const target = { stack: [] };
          Error.captureStackTrace(target, caller);
          const stack = target.stack;
          Error.prepareStackTrace = previousPrepare;
          assert.ok(Array.isArray(stack));
          assert.ok(stack.length > 0);
          assert.equal(typeof stack[0].getFileName, 'function');
          process.stdout.write('nested structured stack completed');
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('nested structured stack completed');
  });

  test('preserves structured capture stacks in asynchronously spawned ESM processes', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      const child = spawn('node', ['/node/esm/async-nested-structured-stack.mjs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const read = (stream) => new Promise((resolve, reject) => {
        let value = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => { value += chunk; });
        stream.once('end', () => resolve(value));
        stream.once('error', reject);
      });
      const status = new Promise((resolve) => child.once('close', (code) => resolve(code)));
      const [exitCode, stdout, stderr] = await Promise.all([
        status,
        read(child.stdout),
        read(child.stderr),
      ]);
      assert.equal(exitCode, 0, stderr);
      assert.equal(stdout, 'async nested structured stack completed');
      process.stdout.write('async nested structured stack completed');
    `, {
      entryPath: '/node/esm/async-nested-structured-stack-entry.mjs',
      files: {
        '/node/esm/async-nested-structured-stack.mjs': `
          import assert from 'node:assert/strict';
          function caller() {}
          const previousPrepare = Error.prepareStackTrace;
          Error.prepareStackTrace = (_error, callSites) => callSites;
          const target = { stack: [] };
          Error.captureStackTrace(target, caller);
          const stack = target.stack;
          Error.prepareStackTrace = previousPrepare;
          assert.ok(Array.isArray(stack));
          assert.ok(stack.length > 0);
          assert.equal(typeof stack[0].getFileName, 'function');
          process.stdout.write('async nested structured stack completed');
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('async nested structured stack completed');
  });

  test('preserves structured capture stacks in IPC-backed ESM processes', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      const child = spawn('node', ['/node/esm/ipc-nested-structured-stack.mjs'], {
        stdio: [0, 'pipe', 'pipe', 'ipc'],
      });
      const read = (stream) => new Promise((resolve, reject) => {
        let value = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => { value += chunk; });
        stream.once('end', () => resolve(value));
        stream.once('error', reject);
      });
      const exitCode = new Promise((resolve) => child.once('close', (code) => resolve(code)));
      const [code, stdout, stderr] = await Promise.all([
        exitCode,
        read(child.stdout),
        read(child.stderr),
      ]);
      assert.equal(code, 0, stderr);
      assert.equal(stdout, 'ipc nested structured stack completed');
      process.stdout.write('ipc nested structured stack completed');
    `, {
      entryPath: '/node/esm/ipc-nested-structured-stack-entry.mjs',
      files: {
        '/node/esm/ipc-nested-structured-stack.mjs': `
          import assert from 'node:assert/strict';
          function caller() {}
          const previousPrepare = Error.prepareStackTrace;
          Error.prepareStackTrace = (_error, callSites) => callSites;
          const target = { stack: [] };
          Error.captureStackTrace(target, caller);
          const stack = target.stack;
          Error.prepareStackTrace = previousPrepare;
          assert.ok(Array.isArray(stack));
          assert.ok(stack.length > 0);
          assert.equal(typeof stack[0].getFileName, 'function');
          process.stdout.write('ipc nested structured stack completed');
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('ipc nested structured stack completed');
  });

  test('exposes the default export of a JSON ESM import', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import irregularPlurals from './irregular-plurals.json' with { type: 'json' };
      assert.deepStrictEqual(irregularPlurals, { person: 'people', mouse: 'mice' });
      process.stdout.write('json default completed');
    `, {
      entryPath: '/node/esm/json-entry.mjs',
      files: {
        '/node/esm/irregular-plurals.json': JSON.stringify({ person: 'people', mouse: 'mice' }),
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('json default completed');
  });

  test('resolves dynamic imports of builtin modules inside ESM', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const fs = await import('fs');
      if (typeof fs.readFileSync !== 'function') throw new Error('fs builtin was not loaded');
      process.stdout.write('dynamic builtin completed');
    `, { entryPath: '/node/esm/dynamic-builtin.mjs' });

    await expectPass(expect, result);
    expect(result.stdout).toContain('dynamic builtin completed');
  });

  test('does not rewrite import call text inside string literals', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      const diagnostic = 'invalid import() specifier';
      const loaded = await import('./dynamic-string-target.mjs');
      assert.strictEqual(diagnostic, 'invalid import() specifier');
      assert.strictEqual(loaded.value, 17);
      process.stdout.write('dynamic import string completed');
    `, {
      entryPath: '/node/esm/dynamic-import-string.mjs',
      files: { '/node/esm/dynamic-string-target.mjs': 'export const value = 17;' },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('dynamic import string completed');
  });

  test('routes global ESM console errors to the child stderr stream', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      console.error('esm child diagnostic');
      process.exitCode = 1;
    `, { entryPath: '/node/esm/console-error.mjs' });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('esm child diagnostic');
  });

  test('routes deferred eval imports from an ESM module through the virtual loader', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      const dynamicImport = eval('(url) => import(url)');
      const loaded = await dynamicImport('./loaded.mjs');
      assert.strictEqual(loaded.answer, 43);
      process.stdout.write('esm eval dynamic import completed');
    `, {
      entryPath: '/node/esm/eval-dynamic-import.mjs',
      files: { '/node/esm/loaded.mjs': 'export const answer = 43;' },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('esm eval dynamic import completed');
  });

  test('rewrites minified static imports with no whitespace around from', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import marker from './minified.mjs';
      if (marker !== 'minified builtin completed') throw new Error(marker);
      process.stdout.write(marker);
    `, {
      entryPath: '/node/esm/minified-entry.mjs',
      files: {
        '/node/esm/minified.mjs': 'var marker=1;import fs from"fs";export default typeof fs.readFileSync === "function" ? "minified builtin completed" : "wrong";',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('minified builtin completed');
  });

  test('rewrites minified static imports after a closing brace', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import marker from './minified-boundary.mjs';
      if (marker !== 'brace boundary completed') throw new Error(marker);
      process.stdout.write(marker);
    `, {
      entryPath: '/node/esm/minified-boundary-entry.mjs',
      files: {
        '/node/esm/minified-boundary.mjs': 'if(true){}import fs from"fs";export default typeof fs.readFileSync === "function" ? "brace boundary completed" : "wrong";',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('brace boundary completed');
  });

  test('rewrites minified imports in a package-scoped .js ESM module', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import marker from './package/index.js';
      if (marker !== 'package builtin completed') throw new Error(marker);
      process.stdout.write(marker);
    `, {
      entryPath: '/node/esm/package-entry.mjs',
      files: {
        '/node/esm/package/package.json': JSON.stringify({ type: 'module' }),
        '/node/esm/package/index.js': 'const quoted=/["\']/;import fs from"fs";export default typeof fs.readFileSync === "function" ? "package builtin completed" : "wrong";',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('package builtin completed');
  });

  test('preserves conditional package imports and ESM named exports', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { marker } from 'conditional-esm-package';
      assert.strictEqual(marker, 'node-condition');
      process.stdout.write('conditional ESM package completed');
    `, {
      entryPath: '/node/conditional-entry.mjs',
      files: {
        '/node/node_modules/conditional-esm-package/package.json': JSON.stringify({
          type: 'module',
          imports: {
            '#runtime': {
              node: './node-runtime.js',
              default: './default-runtime.js',
            },
          },
          exports: { '.': './index.js' },
        }),
        '/node/node_modules/conditional-esm-package/index.js': "export { marker } from '#runtime';",
        '/node/node_modules/conditional-esm-package/node-runtime.js': "export const marker = 'node-condition';",
        '/node/node_modules/conditional-esm-package/default-runtime.js': "export const marker = 'default-condition';",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('conditional ESM package completed');
  });

  test('exposes named exports re-exported through a conditional package entry', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { extraFromError } from 'star-export-package';
      assert.strictEqual(extraFromError, 're-exported');
      process.stdout.write('star export completed');
    `, {
      entryPath: '/node/star-export-entry.mjs',
      files: {
        '/node/node_modules/star-export-package/package.json': JSON.stringify({
          type: 'module',
          exports: {
            '.': {
              import: { default: './dist/esm/index.js' },
              require: { default: './dist/commonjs/index.js' },
            },
          },
        }),
        '/node/node_modules/star-export-package/dist/esm/package.json': JSON.stringify({ type: 'module' }),
        '/node/node_modules/star-export-package/dist/esm/index.js': "export * from './extra.js';",
        '/node/node_modules/star-export-package/dist/esm/extra.js': "export const extraFromError = 're-exported';",
        '/node/node_modules/star-export-package/dist/commonjs/index.js': "module.exports = { extraFromError: 'cjs' };",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('star export completed');
  });

  test('rewrites imports after nested template literals in ESM dependencies', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { marker } from 'template-after-export-package';
      assert.strictEqual(marker, 'after-template');
      process.stdout.write('template import completed');
    `, {
      entryPath: '/node/template-after-export-entry.mjs',
      files: {
        '/node/node_modules/template-after-export-package/package.json': JSON.stringify({
          type: 'module',
          exports: { '.': './index.js' },
        }),
        '/node/node_modules/template-after-export-package/index.js': [
          'const getDirectoryGlob = ({directoryPath, files, extensions}) => {',
          "  const extensionGlob = extensions?.length > 0 ? `.${extensions.length > 1 ? `{${extensions.join(',')}}` : extensions[0]}` : '';",
          '  return files',
          '    ? files.map(file => nodePath.posix.join(directoryPath, `**/${nodePath.extname(file) ? file : `${file}${extensionGlob}`}`))',
          "    : [nodePath.posix.join(directoryPath, `**${extensionGlob ? `/*${extensionGlob}` : ''}`)];",
          '};',
          "export { marker } from './marker.js';",
        ].join('\n'),
        '/node/node_modules/template-after-export-package/marker.js': "export const marker = 'after-template';",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('template import completed');
  });

  test('rewrites imports after regex literals following line comments', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { marker } from 'regex-after-comment-package';
      assert.strictEqual(marker, 'after-regex');
      process.stdout.write('regex import completed');
    `, {
      entryPath: '/node/regex-after-comment-entry.mjs',
      files: {
        '/node/node_modules/regex-after-comment-package/package.json': JSON.stringify({
          type: 'module',
          exports: { '.': './index.js' },
        }),
        '/node/node_modules/regex-after-comment-package/index.js': [
          '// Keep regex detection anchored after a line comment.',
          "const quotedToken = /(?<=^Unexpected token )(?<quote>')?(.)\\k<quote>/;",
          'export { marker } from \'./marker.js\';',
          'void quotedToken;',
        ].join('\n'),
        '/node/node_modules/regex-after-comment-package/marker.js': "export const marker = 'after-regex';",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('regex import completed');
  });

  test('exposes named exports forwarded by a CommonJS __exportStar helper', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { extraFromError } from 'cjs-export-star-package';
      assert.strictEqual(extraFromError, 'forwarded');
      process.stdout.write('CommonJS export star completed');
    `, {
      entryPath: '/node/cjs-export-star-entry.mjs',
      files: {
        '/node/node_modules/cjs-export-star-package/package.json': JSON.stringify({
          type: 'module',
          exports: { '.': { import: './dist/commonjs/index.js' } },
        }),
        '/node/node_modules/cjs-export-star-package/dist/commonjs/package.json': JSON.stringify({ type: 'commonjs' }),
        '/node/node_modules/cjs-export-star-package/dist/commonjs/index.js': `
          "use strict";
          var __createBinding = (this && this.__createBinding) || function (o, m, k, k2) {
            if (k2 === undefined) k2 = k;
            Object.defineProperty(o, k2, { enumerable: true, get: function () { return m[k]; } });
          };
          var __exportStar = (this && this.__exportStar) || function (m, exports) {
            for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
          };
          Object.defineProperty(exports, "__esModule", { value: true });
          __exportStar(require("./extra.js"), exports);
        `,
        '/node/node_modules/cjs-export-star-package/dist/commonjs/extra.js': `
          exports.extraFromError = 'forwarded';
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('CommonJS export star completed');
  });

  test('exposes named exports from nested CommonJS __exportStar chains', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { TSESTree } from 'nested-cjs-export-star-package';
      assert.strictEqual(TSESTree, 'forwarded through a nested chain');
      process.stdout.write('nested CommonJS export star completed');
    `, {
      entryPath: '/node/nested-cjs-export-star-entry.mjs',
      files: {
        '/node/node_modules/nested-cjs-export-star-package/package.json': JSON.stringify({
          type: 'module',
          exports: { '.': { import: './dist/index.js' } },
        }),
        '/node/node_modules/nested-cjs-export-star-package/dist/package.json': JSON.stringify({ type: 'commonjs' }),
        '/node/node_modules/nested-cjs-export-star-package/dist/index.js': `
          "use strict";
          Object.defineProperty(exports, "__esModule", { value: true });
          var __exportStar = (this && this.__exportStar) || function (m, exports) {
            for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) exports[p] = m[p];
          };
          __exportStar(require("./ts-estree.js"), exports);
        `,
        '/node/node_modules/nested-cjs-export-star-package/dist/ts-estree.js': `
          "use strict";
          Object.defineProperty(exports, "__esModule", { value: true });
          var ast_spec_1 = require("./generated/ast-spec.js");
          Object.defineProperty(exports, "TSESTree", { enumerable: true, get: function () { return ast_spec_1.TSESTree; } });
        `,
        '/node/node_modules/nested-cjs-export-star-package/dist/generated/ast-spec.js': `
          "use strict";
          exports.TSESTree = 'forwarded through a nested chain';
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('nested CommonJS export star completed');
  });

  test('exposes TSESTree from the TypeScript ESLint CommonJS build shape', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { TSESTree } from '@typescript-eslint/types';
      assert.strictEqual(TSESTree.TSESTreeMarker, 'typescript-eslint shape');
      process.stdout.write('typescript-eslint CommonJS exports completed');
    `, {
      entryPath: '/node/typescript-eslint-entry.mjs',
      files: {
        '/node/node_modules/@typescript-eslint/types/package.json': JSON.stringify({
          name: '@typescript-eslint/types',
          main: 'dist/index.js',
        }),
        '/node/node_modules/@typescript-eslint/types/dist/index.js': `
          "use strict";
          /*
           * This comment mirrors the ESM usage examples in typescript-eslint's
           * generated CommonJS entry point.
           * import tseslint from '@typescript-eslint/types';
           * export default tseslint;
           */
          var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
            if (k2 === undefined) k2 = k;
            var desc = Object.getOwnPropertyDescriptor(m, k);
            if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
              desc = { enumerable: true, get: function() { return m[k]; } };
            }
            Object.defineProperty(o, k2, desc);
          }) : (function(o, m, k, k2) { if (k2 === undefined) k2 = k; o[k2] = m[k]; }));
          var __exportStar = (this && this.__exportStar) || function(m, exports) {
            for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
          };
          Object.defineProperty(exports, "__esModule", { value: true });
          __exportStar(require("./ts-estree"), exports);
        `,
        '/node/node_modules/@typescript-eslint/types/dist/ts-estree.js': `
          "use strict";
          var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
            if (k2 === undefined) k2 = k;
            var desc = Object.getOwnPropertyDescriptor(m, k);
            if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
              desc = { enumerable: true, get: function() { return m[k]; } };
            }
            Object.defineProperty(o, k2, desc);
          }) : (function(o, m, k, k2) { if (k2 === undefined) k2 = k; o[k2] = m[k]; }));
          var __setModuleDefault = (this && this.__setModuleDefault) || function(o, v) {
            Object.defineProperty(o, "default", { enumerable: true, value: v });
          };
          var __importStar = (this && this.__importStar) || function (mod) {
            if (mod && mod.__esModule) return mod;
            var result = {};
            if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
            __setModuleDefault(result, mod);
            return result;
          };
          Object.defineProperty(exports, "__esModule", { value: true });
          exports.TSESTree = void 0;
          exports.TSESTree = __importStar(require("./generated/ast-spec"));
        `,
        '/node/node_modules/@typescript-eslint/types/dist/generated/ast-spec.js': `
          "use strict";
          Object.defineProperty(exports, "__esModule", { value: true });
          exports.TSESTreeMarker = 'typescript-eslint shape';
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('typescript-eslint CommonJS exports completed');
  });

  test('keeps export-star names available through an ESM cycle', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { extraFromError, proc, cycleMarker } from 'cycle-star-package';
      assert.strictEqual(extraFromError, 'cycle value');
      assert.strictEqual(typeof proc, 'object');
      assert.strictEqual(cycleMarker, 'cycle marker');
      process.stdout.write('cyclic export star completed');
    `, {
      entryPath: '/node/cycle-star-entry.mjs',
      files: {
        '/node/node_modules/cycle-star-package/package.json': JSON.stringify({
          type: 'module',
          exports: { '.': './index.js' },
        }),
        '/node/node_modules/cycle-star-package/index.js': `
          export * from './value.js';
          export * from './cycle.js';
        `,
        '/node/node_modules/cycle-star-package/value.js': "export const extraFromError = 'cycle value'; export const proc = typeof process === 'object' && process ? process : undefined;",
        '/node/node_modules/cycle-star-package/cycle.js': `
          import { extraFromError, proc } from 'cycle-star-package';
          if (!proc || extraFromError !== 'cycle value') throw new Error('cycle bindings were not initialized');
          export const cycleMarker = 'cycle marker';
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('cyclic export star completed');
  });

  test('preserves named exports through dynamic conditional ESM imports', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      const module = await import('dynamic-conditional-package');
      assert.deepStrictEqual(module.supportsColor, { level: 0 });
      assert.deepStrictEqual(module.supportsColorNamed, { level: 0 });
      process.stdout.write('dynamic conditional ESM package completed');
    `, {
      entryPath: '/node/dynamic-conditional-entry.mjs',
      files: {
        '/node/node_modules/dynamic-conditional-package/package.json': JSON.stringify({
          type: 'module',
          imports: {
            '#supports-color': {
              node: './node-supports-color.js',
              default: './browser-supports-color.js',
            },
          },
          exports: './source/index.js',
        }),
        '/node/dynamic-conditional-entry.mjs': `
          import assert from 'node:assert/strict';
          const module = await import('dynamic-conditional-package');
          assert.deepStrictEqual(module.supportsColor, { level: 0 });
          assert.deepStrictEqual(module.supportsColorNamed, { level: 0 });
          process.stdout.write('dynamic conditional ESM package completed');
        `,
        '/node/node_modules/dynamic-conditional-package/source/index.js': `
          import supportsColor from '#supports-color';
          const { stdout } = supportsColor;
          export { stdout as supportsColor, stdout as supportsColorNamed };
        `,
        '/node/node_modules/dynamic-conditional-package/node-supports-color.js': 'export default { stdout: { level: 0 } };',
        '/node/node_modules/dynamic-conditional-package/browser-supports-color.js': 'export default { stdout: { level: 3 } };',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('dynamic conditional ESM package completed');
  });

  test('runs a forked unknown-extension entry through an async module.register loader hook', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert/strict');
      const { fork } = require('node:child_process');

      const child = fork('/node/node_modules/loader-fixture/worker.ts', [], {
        cwd: '/node',
        env: { ...process.env, NODE_OPTIONS: '--import=loader-fixture/register' },
        silent: true,
      });
      child.once('error', (error) => {
        process.stderr.write(error.stack + '\\n');
        process.exitCode = 1;
      });
      child.once('message', (message) => {
        assert.deepStrictEqual(message, { answer: 42 });
      });
      child.once('close', (code, signal) => {
        assert.strictEqual(code, 0);
        assert.strictEqual(signal, null);
        process.stdout.write('async loader fork contract passed');
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({ type: 'module' }),
        '/node/node_modules/loader-fixture/package.json': JSON.stringify({
          name: 'loader-fixture',
          type: 'module',
          exports: { './register': './register.mjs' },
        }),
        '/node/node_modules/loader-fixture/register.mjs': `
          import { register } from 'node:module';
          register('./hooks.mjs', import.meta.url);
        `,
        '/node/node_modules/loader-fixture/hooks.mjs': `
          export async function resolve(specifier, context, nextResolve) {
            const result = await nextResolve(specifier, context);
            // Some production loaders (including ts-node's current ESM hook)
            // intentionally omit the format field from a short-circuit result.
            // The following load hook still supplies the format and source.
            if (String(result.url).endsWith('.ts')) {
              return { shortCircuit: true, url: result.url };
            }
            return result;
          }
          export async function load(url, context, nextLoad) {
            if (!url.endsWith('.ts')) return nextLoad(url, context);
            const result = await nextLoad(url, { ...context, format: 'module' });
            const source = typeof result.source === 'string'
              ? result.source
              : new TextDecoder().decode(result.source);
            return { format: 'module', shortCircuit: true, source: source.replace(/: number\\b/g, '') };
          }
        `,
        '/node/node_modules/loader-fixture/worker.ts': `
          import assert from 'node:assert/strict';
          const answer: number = 42;
          assert.strictEqual(answer, 42);
          process.send({ answer });
          process.disconnect();
        `,
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('async loader fork contract passed');
  });

  test('passes raw ESM hook source with Node Buffer string semantics', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { register } from 'node:module';

      register('./source-shape-hooks.mjs', import.meta.url);
      const loaded = await import('./source-shape-target.ts');
      assert.strictEqual(loaded.value, 42);
      process.stdout.write('raw source shape contract passed');
    `, {
      entryPath: '/node/source-shape-entry.mjs',
      files: {
        '/node/source-shape-hooks.mjs': `
          export async function load(url, context, nextLoad) {
            if (!url.endsWith('.ts')) return nextLoad(url, context);
            const result = await nextLoad(url, { ...context, format: 'module' });
            if (!(result.source instanceof Uint8Array)) throw new Error('load hook source must remain byte-backed');
            if (result.source.toString() !== 'export const value: number = 42;') {
              throw new Error('load hook source must use Node Buffer string semantics');
            }
            return {
              format: 'module',
              shortCircuit: true,
              source: result.source.toString().replace(': number', ''),
            };
          }
        `,
        '/node/source-shape-target.ts': 'export const value: number = 42;',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('raw source shape contract passed');
  });

  test('lets an async resolve hook map a missing JavaScript spelling to a source file', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import assert from 'node:assert/strict';
      import { register } from 'node:module';

      register('./extension-fallback-loader.mjs', import.meta.url);
      const loaded = await import('./virtual-entry.js');
      assert.strictEqual(loaded.value, 'resolved through hook');
      process.stdout.write('extension fallback resolve completed');
    `, {
      entryPath: '/node/extension-fallback-entry.mjs',
      files: {
        '/node/extension-fallback-loader.mjs': `
          export async function resolve(specifier, context, nextResolve) {
            try {
              return await nextResolve(specifier, context);
            } catch (error) {
              if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !error.url?.endsWith('/virtual-entry.js')) throw error;
              return nextResolve(error.url.slice(0, -3) + '.ts', context);
            }
          }

          export async function load(url, context, nextLoad) {
            if (!url.endsWith('.ts')) return nextLoad(url, context);
            const result = await nextLoad(url, { ...context, format: 'module' });
            const source = typeof result.source === 'string'
              ? result.source
              : new TextDecoder().decode(result.source);
            return {
              format: 'module',
              shortCircuit: true,
              source: source.replace(': string', ''),
            };
          }
        `,
        '/node/virtual-entry.ts': "export const value: string = 'resolved through hook';",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('extension fallback resolve completed');
  });

  test('loads a cyclic ESM graph without deadlocking URL materialization', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      import { value } from './cycle-a.mjs';
      if (value !== 'ab') throw new Error(value);
      process.stdout.write(value);
    `, {
      entryPath: '/node/esm/cycle-entry.mjs',
      files: {
        '/node/esm/cycle-a.mjs': "import { value as other } from './cycle-b.mjs'; export const value = 'a' + other;",
        '/node/esm/cycle-b.mjs': "import { value as other } from './cycle-a.mjs'; export const value = 'b'; void other;",
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('ab');
  });

  test('loads hashbang ESM and exposes events.once as a named export', async ({ harnessPage }) => {
    const source = `#! }]) // isn't js
      import assert from 'node:assert/strict';
      import { EventEmitter, once } from 'node:events';
      import marker from '../common/index.mjs';
      const emitter = new EventEmitter();
      const event = once(emitter, 'value');
      emitter.emit('value', marker, 42);
      assert.deepStrictEqual(await event, ['common', 42]);
      assert.strictEqual(typeof once, 'function');
      process.stdout.write('hashbang esm completed');
`;
    const result = await harnessPage.run(source, {
      entryPath: '/node/esm/test-esm-shebang.mjs',
      files: {
        '/node/common/index.mjs': 'export default "common";',
      },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('hashbang esm completed');
  });
});
