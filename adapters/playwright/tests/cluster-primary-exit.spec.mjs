import assert from 'node:assert/strict';
import { expect, test } from 'playwright/test';
import { createRuntime } from '../runtime.js';

const capabilities = {
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 2 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4096, stdoutBytes: 4096, stderrBytes: 4096 },
  envVars: { allowed: [] },
};

test('terminates cluster workers before the outer process exit event', async () => {
  const runtime = createRuntime();
  const stderr = [];
  await runtime.reset({ runId: 'cluster-primary-exit-order', capabilities });
  await runtime.mount({
    '/node/cluster-primary-exit.js': `
      const assert = require('node:assert');
      const cluster = require('node:cluster');

      if (cluster.isWorker) {
        setInterval(() => {}, 1000);
      } else {
        const worker = cluster.fork();
        const pid = worker.process.pid;
        worker.once('online', () => setTimeout(() => process.exit(0), 0));
        process.once('exit', () => {
          assert.throws(() => process.kill(pid, 'SIGCONT'), { code: 'ESRCH' });
        });
      }
    `,
  });

  const exitCode = await runtime.executeEntry(
    '/node/cluster-primary-exit.js',
    {},
    () => {},
    (value) => stderr.push(value),
  );

  expect(exitCode, stderr.join('')).toBe(0);
});
