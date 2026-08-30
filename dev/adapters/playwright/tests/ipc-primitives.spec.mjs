import { expect } from 'playwright/test';
import { browserRuntimeURL, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser-native MessageChannel IPC', () => {
  test('preserves FIFO, structured clone, transfer, and close semantics', async ({ page }) => {
    await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const { createMessageChannel, createScopedIpcEndpoint } = await import('/runtime/messaging.js');
      const channel = createMessageChannel(globalThis);
      const parent = createScopedIpcEndpoint(channel.port1, { runId: 'run-1', childId: 'child-1', direction: 'parent' });
      const child = createScopedIpcEndpoint(channel.port2, { runId: 'run-1', childId: 'child-1', direction: 'child' });
      const messages = [];
      let disconnects = 0;
      child.on('message', (message) => messages.push(message));
      child.on('disconnect', () => { disconnects += 1; });
      const callbackResults = [];
      const buffer = new ArrayBuffer(4);
      parent.send({ number: 1 });
      parent.send({ number: 2 });
      const transferAccepted = parent.send(buffer, [buffer]);
      await new Promise((resolve) => {
        const onMessage = () => {
          if (messages.length >= 3) {
            child.off('message', onMessage);
            resolve();
          }
        };
        child.on('message', onMessage);
        onMessage();
      });
      const transferByteLength = messages[2]?.byteLength ?? null;
      const childDisconnected = new Promise((resolve) => child.once('disconnect', resolve));
      parent.disconnect();
      parent.disconnect();
      const callbackResult = parent.send('after-close', (error) => callbackResults.push(error?.code || null));
      await childDisconnected;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        messages: messages.slice(0, 2),
        transferAccepted,
        transferByteLength,
        detachedByteLength: buffer.byteLength,
        callbackResult,
        callbackResults,
        childConnected: child.connected,
        disconnects,
        parentConnected: parent.connected,
      };
    });

    expect(result.messages).toEqual([{ number: 1 }, { number: 2 }]);
    expect(result.transferByteLength, JSON.stringify(result)).toBe(4);
    expect(result.detachedByteLength).toBe(0);
    expect(result.callbackResult).toBe(false);
    expect(result.callbackResults).toEqual(['ERR_IPC_CLOSED']);
    expect(result.childConnected).toBe(false);
    expect(result.disconnects).toBe(1);
    expect(result.parentConnected).toBe(false);
  });

  test('reports structured-clone failures without closing the channel', async ({ page }) => {
    await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const { createMessageChannel, createScopedIpcEndpoint } = await import('/runtime/messaging.js');
      const channel = createMessageChannel(globalThis);
      const parent = createScopedIpcEndpoint(channel.port1, { runId: 'run-2', childId: 'child-2', direction: 'parent' });
      const child = createScopedIpcEndpoint(channel.port2, { runId: 'run-2', childId: 'child-2', direction: 'child' });
      const callbackResults = [];
      let received;
      child.on('message', (message) => { received = message; });
      let thrownCode;
      try { parent.send(() => {}); } catch (error) { thrownCode = error.code; }
      const accepted = parent.send({ ok: true }, (error) => callbackResults.push(error?.code || null));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { thrownCode, accepted, callbackResults, received, connected: parent.connected && child.connected };
    });

    expect(result.thrownCode).toBe('ERR_IPC_SERIALIZATION');
    expect(result.accepted).toBe(true);
    expect(result.callbackResults).toEqual([null]);
    expect(result.received).toEqual({ ok: true });
    expect(result.connected).toBe(true);
  });
});
