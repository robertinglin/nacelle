import assert from 'node:assert/strict';
import test from 'node:test';
import { Nacelle } from '../../../../src/index.js';

test('prepared modules execute afresh and source edits take effect on later launches', async () => {
  const node = await Nacelle.create({ gateway: false, files: {
    '/node/main.cjs': `const value = require('./value.cjs'); console.log(value.count++, process.env.CACHE_TEST);`,
    '/node/value.cjs': 'module.exports = { count: 1 };',
  } });
  for (const [label, count] of [['first', 1], ['second', 1], ['edited', 2]]) {
    if (label === 'edited') await node.fs.writeFile('/node/value.cjs', 'module.exports = { count: 2 };');
    const child = await node.run({ entry: '/node/main.cjs', env: { CACHE_TEST: label } });
    assert.equal(await child.exit, 0, await child.stderrText());
    assert.equal((await child.stdoutText()).trim(), `${count} ${label}`);
  }
});

test('nested module compilation does not re-enter the guest Function constructor', async () => {
  const node = await Nacelle.create({ gateway: false, files: {
    '/node/main.cjs': `
      const original = globalThis.Function;
      let calls = 0;
      globalThis.Function = function (...args) { calls++; return original(...args); };
      try { require('./value.cjs'); } finally { globalThis.Function = original; }
      console.log(calls);
    `,
    '/node/value.cjs': 'module.exports = "import compiler fixture";',
  } });
  const child = await node.run({ entry: '/node/main.cjs' });
  assert.equal(await child.exit, 0, await child.stderrText());
  assert.equal((await child.stdoutText()).trim(), '0');
});
