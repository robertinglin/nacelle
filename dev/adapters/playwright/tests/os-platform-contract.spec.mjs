import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { expect, test } from 'playwright/test';
import { createPlatformContract as createAdapterContract } from '../runtime/os-platform.js';

const integrationSource = await readFile(
  new URL('../../../.bnh-state/v22/worktrees/integration-v22/runtime/os-platform.js', import.meta.url),
  'utf8',
);
const { createPlatformContract: createIntegrationContract } = await import(
  `data:text/javascript,${encodeURIComponent(integrationSource)}`,
);

const factories = [
  ['adapter', createAdapterContract],
  ['integration', createIntegrationContract],
];

function assertOsContract(assert, createPlatformContract, label) {
  const contract = createPlatformContract();
  const { os } = contract;

  assert.strictEqual(os.totalmem(), 512 * 1024 * 1024, `${label}: totalmem`);
  assert.strictEqual(os.freemem(), 256 * 1024 * 1024, `${label}: freemem`);
  assert.strictEqual(os.availableParallelism(), 1, `${label}: availableParallelism`);
  assert.deepStrictEqual(os.cpus(), [{
    model: 'Browser CPU',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }], `${label}: cpus`);
  assert.strictEqual(os.homedir(), '/home/browser', `${label}: homedir`);
  assert.strictEqual(os.hostname(), 'browser', `${label}: hostname`);
  assert.strictEqual(os.uptime(), 1, `${label}: uptime`);
  assert.deepStrictEqual(os.loadavg(), [0, 0, 0], `${label}: loadavg`);
  assert.deepStrictEqual(os.userInfo(), {
    uid: 0,
    gid: 0,
    username: 'browser',
    homedir: '/home/browser',
    shell: '/bin/sh',
  }, `${label}: userInfo`);
  const bufferedUser = os.userInfo({ encoding: 'buffer' });
  assert.strictEqual(bufferedUser.username.toString('utf8'), 'browser', `${label}: buffered username`);
  assert.strictEqual(bufferedUser.homedir.toString('utf8'), '/home/browser', `${label}: buffered homedir`);
  assert.strictEqual(bufferedUser.shell.toString('utf8'), '/bin/sh', `${label}: buffered shell`);
  assert.strictEqual(os.version(), 'Browser Native OS', `${label}: version`);
  assert.strictEqual(os.machine(), 'x86_64', `${label}: machine`);
  assert.strictEqual(os.devNull, '/dev/null', `${label}: devNull`);
  assert.strictEqual(`${os.hostname}`, os.hostname(), `${label}: hostname coercion`);
  assert.strictEqual(`${os.totalmem}`, String(os.totalmem()), `${label}: totalmem coercion`);
  assert.strictEqual(`${os.availableParallelism}`, String(os.availableParallelism()), `${label}: parallelism coercion`);

  assert.strictEqual(os.constants.signals.SIGTERM, 15, `${label}: SIGTERM`);
  assert.strictEqual(os.constants.signals.SIGKILL, 9, `${label}: SIGKILL`);
  assert.strictEqual(os.constants.priority.PRIORITY_NORMAL, 0, `${label}: priority`);
  assert.strictEqual(os.constants.UV_UDP_REUSEADDR, 4, `${label}: UV_UDP_REUSEADDR`);
  assert.ok(Object.isFrozen(os.constants), `${label}: constants frozen`);
  assert.ok(Object.isFrozen(os.constants.signals), `${label}: signals frozen`);

  assert.strictEqual(os.getPriority(), 0, `${label}: initial priority`);
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  assert.strictEqual(os.getPriority(), 10, `${label}: updated priority`);
}

test('keeps both browser OS contract copies deterministic and host-independent', () => {
  for (const [label, createPlatformContract] of factories) {
    assertOsContract(assert, createPlatformContract, label);
  }
});

test('uses browser-safe platform-specific null devices', () => {
  const { os } = createAdapterContract({ platform: 'win32', arch: 'arm64' });
  expect(os.devNull).toBe('\\\\.\\nul');
  expect(os.machine()).toBe('aarch64');
});
