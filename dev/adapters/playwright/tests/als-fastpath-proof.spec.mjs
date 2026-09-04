import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

// webpack dev loads bundle modules as eval('...module...') strings. Those
// sources receive import rewriting but (as of this probe) no async transform,
// so their async functions stay native. A native await of a raw promise rides
// V8's fast path and resumes at the leftover executionId — detached from any
// ALS store entered by the caller. Real Node's promise hooks keep the store.
const guestSource = `
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();

  // eval'd module string literal — the form bundlers emit. Without eval-literal
  // transforming, mid and leaf stay native and mid's 'await leaf()' rides V8's
  // fast path, resuming with no scope wrapper at a stale executionId.
  const evalMid = eval('(function (alsRef) { async function leaf() { await new Promise((resolve) => setTimeout(resolve, 20)); return "leaf-ok"; } async function mid() { const v = await leaf(); return [v, alsRef.getStore() && alsRef.getStore().v]; } return mid; })')(als);

  (async () => {
    const out = als.run({ v: 7 }, () => evalMid());
    // Store-less churn between the native await registration and settlement:
    // tracked timers/microtasks/immediates, none under als.run.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await Promise.resolve().then(() => {});
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await out;
    console.log('evalnative value=' + result[0] + ' store=' + (result[1] === undefined ? 'LOST' : result[1]));
    if (result[0] !== 'leaf-ok' || result[1] !== 7) process.exitCode = 1;
  })().catch((error) => {
    console.error('evalnative run failed', error && error.stack || error);
    process.exitCode = 1;
  });
`;

test('keeps ALS store for eval-defined native async fn awaiting native fn promise', async ({ harnessPage }) => {
  const result = await harnessPage.run(guestSource, { timeoutMs: 30000 });
  await expectPass(expect, result);
});

// Bundlers emit the eval'd module with escaped newlines and quotes; the
// transform must decode, rewrite, and re-encode rather than tokenize the
// escaped text (which silently skipped every real bundle module).
test('keeps ALS store for webpack-style escaped eval module strings', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    const { AsyncLocalStorage } = require('node:async_hooks');
    const als = new AsyncLocalStorage();
    const factory = eval("(function (alsRef) {\\n  async function leaf() {\\n    await new Promise((resolve) => setTimeout(resolve, 20));\\n    return 'leaf-ok';\\n  }\\n  async function mid() {\\n    const v = await leaf();\\n    return [v, alsRef.getStore() && alsRef.getStore().v];\\n  }\\n  return mid;\\n})");
    (async () => {
      const out = als.run({ v: 7 }, () => factory(als)());
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await Promise.resolve().then(() => {});
        await new Promise((resolve) => setImmediate(resolve));
      }
      const value = await out;
      console.log('escaped value=' + value[0] + ' store=' + (value[1] === undefined ? 'LOST' : value[1]));
      if (value[0] !== 'leaf-ok' || value[1] !== 7) process.exitCode = 1;
    })().catch((error) => {
      console.error('escaped run failed', error && error.stack || error);
      process.exitCode = 1;
    });
  `, { timeoutMs: 30000 });
  await expectPass(expect, result);
});
