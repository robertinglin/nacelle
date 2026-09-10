import assert from 'node:assert/strict';
import test from 'node:test';
import { Nacelle } from '../../../../src/index.js';

test('node:repl exposes the core server contract without a host core-file mount', async () => {
  const node = await Nacelle.create({ gateway: false });
  const child = await node.execute(`
    const assert = require('node:assert/strict');
    const repl = require('node:repl');
    assert.equal(typeof repl.start, 'function');
    assert.equal(typeof repl.REPLServer, 'function');
    assert.equal(typeof repl.Recoverable, 'function');
    console.log('repl contract ready');
  `);
  assert.equal(await child.exit, 0);
  assert.equal(await child.stderrText(), '');
  assert.match(await child.stdoutText(), /repl contract ready/);
});
