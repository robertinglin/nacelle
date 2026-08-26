import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('routes the max-listener warning through the active process once', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const assert = require('node:assert');
    const EventEmitter = require('node:events');
    const warningText = /EventEmitter memory leak detected\\. 2 hello listeners/;
    const oldDefault = EventEmitter.defaultMaxListeners;
    let writes = 0;
    let warningEvents = 0;
    process.on('warning', (warning) => {
      assert.strictEqual(warning.name, 'MaxListenersExceededWarning');
      assert.strictEqual(warning.count, 2);
      assert.strictEqual(warning.type, 'hello');
      assert.strictEqual(writes, 1);
      warningEvents++;
    });
    process.stderr.write = (data) => {
      assert.match(data, warningText);
      writes++;
    };
    EventEmitter.defaultMaxListeners = 1;
    const emitter = new EventEmitter();
    emitter.on('hello', () => {});
    emitter.on('hello', () => {});
    emitter.on('hello', () => {});
    assert.strictEqual(writes, 1);
    assert.strictEqual(warningEvents, 1);
    EventEmitter.defaultMaxListeners = oldDefault;
  `);

  await expectPass(expect, result);
});
