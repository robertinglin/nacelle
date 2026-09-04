import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

// Mirrors Next 16's render pattern: an awaited als.run() whose callback does
// internal awaits (payload generation), then a fire-and-forget als.run() whose
// callback awaits the first run's result (flight render). Node keeps the store
// inside both callback continuation trees; the harness must match.
const guestSource = `
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();
  const results = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  const immediate = () => new Promise((resolve) => setImmediate(resolve));
  const interop = (fn) => (arg) => fn(arg);

  async function loadModule(label) {
    await tick();
    results.push(['loadModule-' + label, als.getStore() && als.getStore().v]);
    await immediate();
    return { default: { label } };
  }

  async function getLayoutOrPageModule(tree) {
    const layout = tree[2].layout;
    const mod = await layout[0]();
    results.push(['getLayoutOrPageModule-after', als.getStore() && als.getStore().v]);
    return { mod, modType: 'layout' };
  }

  async function collectMetadata(tree) {
    const collected = await (0, getLayoutOrPageModule)(tree);
    results.push(['collectMetadata-after', als.getStore() && als.getStore().v]);
    const loaded = await (0, loadModule)('meta');
    return { collected, loaded };
  }

  async function generatePayload(tree) {
    await immediate();
    const meta = await (0, collectMetadata)(tree);
    results.push(['generatePayload-after-meta', als.getStore() && als.getStore().v]);
    await tick();
    return meta;
  }

  async function renderStream(p) {
    await immediate();
    const payload = await p;
    results.push(['renderStream-after-outer', als.getStore() && als.getStore().v]);
    return 'rendered:' + payload.collected.modType;
  }

  (async () => {
    const tree = [null, null, { layout: [() => (0, loadModule)('layout'), 'app/layout.js'] }];
    const p1 = als.run({ v: 7 }, () => (0, generatePayload)(tree));
    const p2 = als.run({ v: 7 }, (x) => (0, renderStream)(x), p1);
    const out = await p2;
    results.push(['A-final', als.getStore() && als.getStore().v]);
    let failed = false;
    for (const [where, v] of results) {
      console.log('extent ' + where + ' -> ' + (v === undefined ? 'LOST' : v));
      if (v === undefined && where !== 'A-final') failed = true;
    }
    if (out !== 'rendered:layout') {
      console.log('extent unexpected output: ' + out);
      failed = true;
    }
    if (failed) process.exitCode = 1;
  })().catch((error) => {
    console.error('extent run failed', error && error.stack || error);
    process.exitCode = 1;
  });
`;

test('keeps ALS store across awaited and fire-and-forget run extents', async ({ harnessPage }) => {
  const result = await harnessPage.run(guestSource, { timeoutMs: 30000 });
  await expectPass(expect, result);
});
