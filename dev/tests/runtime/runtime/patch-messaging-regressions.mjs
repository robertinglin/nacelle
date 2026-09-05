import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageChannel } from '../../../../src/runtime/messaging.js';

// Real host MessagePorts exercise structured-clone failure and deferred delivery.
test('a failed message clone does not leave a phantom pending message on close', () => {
  const channel = createMessageChannel();
  try {
    assert.throws(() => channel.port1.postMessage(() => {}), { name: 'DataCloneError' });
    channel.port1.close();
    assert.equal(channel.port1.__bnhIsClosed, true);
    assert.equal(channel.port2.__bnhIsClosed, true);
  } finally { channel.raw.port1.close(); channel.raw.port2.close(); }
});

test('once listeners do not discard additional messages from the deferred queue', async () => {
  const channel = createMessageChannel();
  try {
    channel.port1.postMessage(1); channel.port1.postMessage(2);
    // A later native message is a FIFO delivery barrier for both adapter events.
    await new Promise(resolve => { channel.raw.port2.addEventListener('message', function barrier(e) {
      if (e.data === 2) { channel.raw.port2.removeEventListener('message', barrier); resolve(); }
    }); });
    const received = [];
    channel.port2.once('message', x => received.push(x));
    channel.port2.once('message', x => received.push(x));
    assert.deepEqual(received, [1, 2]);
  } finally { channel.port1.close(); channel.port2.close(); }
});

test('synchronous message consumption does not redeliver asynchronously', async () => {
  const channel = createMessageChannel();
  try {
    channel.port1.postMessage(42);
    assert.equal(channel.port2.__bnhReceiveMessage(), 42);
    assert.equal(channel.port2.__bnhReceiveMessage(), undefined);
    let delivered = false; channel.port2.on('message', () => { delivered = true; });
    await new Promise(resolve => channel.raw.port2.addEventListener('message', resolve, { once: true }));
    assert.equal(delivered, false);
  } finally { channel.port1.close(); channel.port2.close(); }
});
