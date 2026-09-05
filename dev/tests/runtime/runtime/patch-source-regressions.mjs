import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteDynamicImports } from '../../../../src/runtime/dynamic-imports.js';

for (const source of [
  `const pattern = /import(foo)/; pattern.source;`,
  `const pattern = /[}](import)(foo)/; pattern.source;`,
  `if (true) /import(foo)/.test('importfoo');`,
  `const value = 10 / 2; const text = 'import(foo)';`,
  `const pattern = \`raw import(foo) \${/import(foo)/.source}\`;`,
  `object.import('x'); object.eval('import("x")');`,
]) {
  test(`import rewriting preserves non-import source: ${source}`, () => {
    assert.equal(rewriteDynamicImports(source, '__load'), source);
  });
}

test('actual imports survive comments, division and nested template expressions', () => {
  const source = 'const a = 10 / 2; const b = import /* comment */ ("x"); const c = `prefix ${import("y")}`;';
  assert.equal(rewriteDynamicImports(source, '__load'), source.replaceAll('import', '__load'));
});

test('literal eval imports are decoded before rewriting and safely re-encoded', async () => {
  const source = String.raw`return eval('import(\'fixture\')');`;
  const rewritten = rewriteDynamicImports(source, '__load');
  assert.equal(await new Function('__load', rewritten)(async x => x), 'fixture');
});

for (const source of [
  `const api = { import(value) { return value; } }; api.import('x');`,
  `class API { import(value) { return value; } }`,
  `{ /* block */ } /import(foo)/.test('importfoo');`,
  `const value = { x: 1 } / 2; import('x');`,
]) {
  test(`rewriting distinguishes methods, blocks and expressions: ${source}`, () => {
    assert.equal(rewriteDynamicImports(source, '__load'), source.replace("; import('x')", "; __load('x')"));
  });
}
