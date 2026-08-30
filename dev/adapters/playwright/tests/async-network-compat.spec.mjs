import { expect } from 'playwright/test';
import { expectPass, test as harnessTest } from './harness-test-helpers.mjs';

const testWithHarness = harnessTest;

testWithHarness('reproduces reverse DNS and logical pipe async resources in Chromium', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (async () => {
      const assert = require('node:assert');
      const dns = require('node:dns');
      const net = require('node:net');
      const { createHook } = require('node:async_hooks');
      const activities = [];
      const hook = createHook({
        init(asyncId, type, triggerAsyncId) {
          if (['GETNAMEINFOREQWRAP', 'PIPESERVERWRAP', 'PIPEWRAP', 'PIPECONNECTWRAP', 'SHUTDOWNWRAP'].includes(type)) {
            activities.push({ asyncId, type, triggerAsyncId, before: 0, after: 0, destroy: 0 });
          }
        },
        before(asyncId) { const entry = activities.find((item) => item.asyncId === asyncId); if (entry) entry.before += 1; },
        after(asyncId) { const entry = activities.find((item) => item.asyncId === asyncId); if (entry) entry.after += 1; },
        destroy(asyncId) { const entry = activities.find((item) => item.asyncId === asyncId); if (entry) entry.destroy += 1; },
      }).enable();

      const service = await new Promise((resolve, reject) => {
        dns.lookupService('127.0.0.1', 80, (error, hostname, name) => {
          if (error) reject(error);
          else resolve({ hostname, service: name });
        });
      });
      assert.deepStrictEqual(service, { hostname: 'localhost', service: 'http' });
      await assert.rejects(dns.promises.lookupService('192.0.2.1', 80), { code: 'ENOTFOUND', syscall: 'getnameinfo' });

      const pipePath = '/node/.bnh-logical-pipe';
      const server = net.createServer((socket) => socket.end('pipe-ok'));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipePath, resolve);
      });
      assert.strictEqual(server.address(), pipePath);

      const client = net.connect(pipePath);
      const received = await new Promise((resolve, reject) => {
        client.once('error', reject);
        client.once('data', (chunk) => resolve(chunk.toString()));
      });
      assert.strictEqual(received, 'pipe-ok');
      assert.strictEqual(client.path, pipePath);
      client.destroy();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => queueMicrotask(resolve));
      hook.disable();

      const getnameinfo = activities.find((entry) => entry.type === 'GETNAMEINFOREQWRAP');
      const pipeServer = activities.find((entry) => entry.type === 'PIPESERVERWRAP');
      const pipeWraps = activities.filter((entry) => entry.type === 'PIPEWRAP');
      const pipeConnect = activities.find((entry) => entry.type === 'PIPECONNECTWRAP');
      const shutdown = activities.find((entry) => entry.type === 'SHUTDOWNWRAP');
      assert.ok(getnameinfo?.before >= 1);
      assert.ok(pipeServer?.before >= 1);
      assert.strictEqual(pipeWraps.length, 2);
      assert.strictEqual(pipeWraps[0].triggerAsyncId, pipeServer.asyncId);
      assert.strictEqual(pipeConnect.triggerAsyncId, pipeWraps[0].asyncId);
      assert.strictEqual(pipeWraps[1].triggerAsyncId, pipeServer.asyncId);
      assert.strictEqual(shutdown.triggerAsyncId, pipeWraps[1].asyncId);
      assert.ok(pipeConnect.before >= 1);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `);
  await expectPass(expect, result);
});
