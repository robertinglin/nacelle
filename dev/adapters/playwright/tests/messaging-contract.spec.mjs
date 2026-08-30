import { expect } from 'playwright/test';
import { browserRuntimeURL, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

async function openRuntime(page) {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
}

test.describe('browser worker messaging contracts', () => {
  test('rejects unsupported postMessageToThread targets with worker messaging codes', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createMessagingPrimitives } = await import('/runtime/messaging.js');
      const messaging = createMessagingPrimitives(globalThis);
      const capture = (operation) => Promise.resolve().then(operation).then(
        () => null,
        (error) => ({ name: error.name, code: error.code ?? null, message: error.message }),
      );
      return {
        threadId: messaging.threadId,
        sameThread: await capture(() => messaging.postMessageToThread(messaging.threadId, 'same-thread')),
        invalidThread: await capture(() => messaging.postMessageToThread(99, 'missing-thread')),
      };
    });

    expect(result.threadId).toBe(0);
    expect(result.sameThread).toMatchObject({ code: 'ERR_WORKER_MESSAGING_SAME_THREAD' });
    expect(result.invalidThread).toMatchObject({ code: 'ERR_WORKER_MESSAGING_FAILED' });
  });

  test('preserves BroadcastChannel invalid-state behavior and MessagePort close no-op behavior', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createMessagingPrimitives } = await import('/runtime/messaging.js');
      const messaging = createMessagingPrimitives(globalThis);
      const capture = (operation) => {
        try { return { value: operation() }; }
        catch (error) { return { error: { name: error.name, code: error.code ?? null, message: error.message } }; }
      };
      const missingName = capture(() => new messaging.BroadcastChannel());
      const broadcast = new messaging.BroadcastChannel('messaging-contract');
      const startType = typeof broadcast.start;
      broadcast.close();
      const broadcastAfterClose = capture(() => broadcast.postMessage('closed'));
      const channel = new messaging.MessageChannel();
      channel.port1.close();
      const portAfterClose = capture(() => channel.port1.postMessage('closed'));
      channel.port2.close();
      return { missingName, startType, broadcastAfterClose, portAfterClose };
    });

    expect(result.missingName.error).toMatchObject({ code: 'ERR_MISSING_ARGS' });
    expect(result.startType).toBe('undefined');
    expect(result.broadcastAfterClose.error).toMatchObject({ name: 'InvalidStateError' });
    expect(result.portAfterClose).toMatchObject({ value: undefined });
  });

  test('drains queued messages before propagating peer close', async ({ page }) => {
    await openRuntime(page);
    const result = await page.evaluate(async () => {
      const { createMessagingPrimitives } = await import('/runtime/messaging.js');
      const messaging = createMessagingPrimitives(globalThis);
      const { port1, port2 } = new messaging.MessageChannel();
      const events = [];
      port1.on('message', (value) => events.push(`message:${value}`));
      port1.on('close', () => events.push('port1-close'));
      port2.on('close', () => events.push('port2-close'));
      port2.postMessage('queued');
      port2.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return events;
    });

    expect(result).toEqual(['port2-close', 'message:queued', 'port1-close']);
  });
});
