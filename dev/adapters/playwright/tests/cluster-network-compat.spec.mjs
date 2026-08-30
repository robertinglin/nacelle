import { expect } from 'playwright/test';
import { expectPass, test as harnessTest } from './harness-test-helpers.mjs';

const capabilities = {
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 8 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4096, stdoutBytes: 4096, stderrBytes: 4096 },
  envVars: { allowed: [] },
};

harnessTest.describe('browser virtual cluster networking', () => {
  harnessTest('transfers a virtual TCP socket to a worker HTTP connection', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const cluster = require('node:cluster');
      const http = require('node:http');
      const net = require('node:net');

      if (cluster.isPrimary) {
        const worker = cluster.fork();
        const server = net.createServer((socket) => worker.send('socket', socket));
        worker.once('exit', (code) => {
          assert.strictEqual(code, 0);
          server.close();
        });
        server.listen(0, () => net.createConnection(server.address().port));
      } else {
        const server = http.createServer();
        server.on('connection', (socket) => {
          assert.strictEqual(socket.server, server);
          socket.destroy();
          cluster.worker.disconnect();
        });
        process.on('message', (message, socket) => server.emit('connection', socket));
      }
    `, { capabilities });
    await expectPass(expect, result);
  });

  for (const schedulingPolicy of ['SCHED_NONE', 'SCHED_RR']) {
    harnessTest(`shares an IPv6-only listener across ${schedulingPolicy} workers`, async ({ harnessPage }) => {
      const result = await harnessPage.run(`
        const assert = require('node:assert');
        const cluster = require('node:cluster');
        const net = require('node:net');
        cluster.schedulingPolicy = cluster.${schedulingPolicy};
        const port = ${schedulingPolicy === 'SCHED_NONE' ? 44002 : 44003};

        if (cluster.isPrimary) {
          const workers = [];
          let listening = 0;
          let address;
          for (let index = 0; index < 3; index += 1) {
            const worker = cluster.fork();
            workers.push(worker);
            worker.once('error', (error) => { console.error(error); process.exitCode = 1; });
            worker.once('listening', (workerAddress) => {
              assert.strictEqual(workerAddress.addressType, 6);
              assert.strictEqual(workerAddress.address, '::');
              assert.strictEqual(workerAddress.port, port);
              address ||= workerAddress;
              assert.deepStrictEqual(workerAddress, address);
              listening += 1;
              if (listening !== workers.length || listening !== 3) return;
              const server = net.createServer();
              server.once('error', (error) => { console.error(error); process.exitCode = 1; });
              server.listen({ host: '0.0.0.0', port }, () => {
                server.close();
                for (const child of workers) child.kill('SIGKILL');
              });
            });
          }
        } else {
          const server = net.createServer();
          server.once('error', (error) => { console.error(error); process.exitCode = 1; });
          server.listen({ host: '::', port, ipv6Only: true });
        }
      `, { capabilities });
      await expectPass(expect, result);
    });
  }
});
