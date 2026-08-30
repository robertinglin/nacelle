import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('routes Node internal fork messages separately from user messages', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert');
    const { fork } = require('node:child_process');

    if (process.argv[2] === 'child') {
      process.send({ cmd: 'fooNODE_bar' });
      process.send({ cmd: 'NODE_bar' });
      process.exit(0);
    } else {
      const child = fork(process.argv[1], ['child']);
      let messageCount = 0;
      let internalMessageCount = 0;
      child.once('message', (message) => {
        messageCount += 1;
        assert.deepStrictEqual(message, { cmd: 'fooNODE_bar' });
      });
      child.once('internalMessage', (message) => {
        internalMessageCount += 1;
        assert.deepStrictEqual(message, { cmd: 'NODE_bar' });
      });
      child.once('close', () => {
        assert.strictEqual(messageCount, 1);
        assert.strictEqual(internalMessageCount, 1);
        process.stdout.write('child-ipc-contract-passed');
      });
    }
  `);

  await expectPass(expect, result);
  expect(result.stdout).toContain('child-ipc-contract-passed');
});

test('accepts a file URL as a fork entry point', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    import assert from 'node:assert';
    import { fork } from 'node:child_process';

    if (process.argv[2] === 'child') {
      process.disconnect();
    } else {
      const child = fork(new URL(import.meta.url), ['child']);
      child.once('disconnect', () => assert.strictEqual(child.connected, false));
      child.once('exit', (code, signal) => {
        assert.strictEqual(code, 0);
        assert.strictEqual(signal, null);
      });
    }
  `, {
    entryPath: '/node/fork-url-contract.mjs',
    files: {
      '/node/fork-url-contract.mjs': '',
    },
  });

  await expectPass(expect, result);
});
