import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommonJsSourcePreparer } from '../../../../src/runtime/commonjs-source.js';

test('reuses prepared source across launches without caching module execution', () => {
  const prepare = createCommonJsSourcePreparer();
  const source = 'module.exports = { value: 1 };';
  const first = prepare(source);
  assert.equal(prepare(source), first);
  const execute = () => {
    const module = { exports: {} };
    new Function('module', first.source)(module);
    return module.exports;
  };
  assert.notEqual(execute(), execute());
  assert.ok(Object.isFrozen(first));
});

test('source edits invalidate preparation even when their lengths match', () => {
  const prepare = createCommonJsSourcePreparer();
  const first = prepare('module.exports = 1;');
  const second = prepare('module.exports = 2;');
  assert.notEqual(first, second);
  assert.equal(second.source, 'module.exports = 2;');
});

test('evicts oldest entries to bound retained source and handles oversized modules', () => {
  const prepare = createCommonJsSourcePreparer({ maxCharacters: 40 });
  const first = prepare('module.exports = 1;');
  prepare('module.exports = 2;');
  prepare('module.exports = 3;');
  assert.notEqual(prepare('module.exports = 1;'), first);
  const large = ' '.repeat(41);
  assert.notEqual(prepare(large), prepare(large));
});

test('preserves import, async, eval, shebang, and process binding preparation', () => {
  const prepare = createCommonJsSourcePreparer();
  const imported = prepare('module.exports = import("./value.mjs");');
  assert.match(imported.source, /__bnhImport\(/);
  const async = prepare('async function read() { return await Promise.resolve(1); }');
  assert.equal(async.bindAsync, true);
  assert.match(async.source, /yield/);
  const evaluated = prepare(`eval('async function read() { return await Promise.resolve(1); }');`);
  assert.equal(evaluated.bindAsync, true);
  assert.match(evaluated.source, /yield/);
  assert.equal(prepare('#!/usr/bin/env node\nmodule.exports = 1;').source, '\nmodule.exports = 1;');
  assert.equal(prepare('#!/usr/bin/env node').source, '');
  assert.equal(prepare('const process = {};').hasProcessBinding, true);
  assert.equal(prepare('const { process } = {};').hasProcessBinding, true);
  assert.equal(prepare('module.exports = process.pid;').hasProcessBinding, false);
  assert.equal(prepare('// const process = {};\nmodule.exports = "const process = {};";').hasProcessBinding, false);
});

test('cache budget includes expanded transformed source', () => {
  const source = 'module.exports = import("x");';
  const prepare = createCommonJsSourcePreparer({ maxCharacters: 80 });
  const first = prepare(source);
  assert.equal(prepare(source), first);
  prepare('module.exports = "another module";');
  assert.notEqual(prepare(source), first);
  const tooSmall = createCommonJsSourcePreparer({ maxCharacters: source.length });
  assert.notEqual(tooSmall(source), tooSmall(source));
});
