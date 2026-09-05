import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';

const filename = fileURLToPath(new URL('../../../../src/runtime/gateway-websocket-client.js', import.meta.url));
const source = fs.readFileSync(filename, 'utf8');
const once = (target, name) => new Promise(resolve => target.addEventListener(name, resolve, { once: true }));

function preview(options = {}) {
  const received = [];
  const listeners = {};
  let transport;
  class Port {
    postMessage(data) { queueMicrotask(() => this.peer.onmessage?.({ data })); }
    close() {}
  }
  class Channel {
    constructor() {
      this.port1 = new Port();
      this.port2 = new Port();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  function frame(opcode, payload, final = true) {
    payload = Buffer.from(payload);
    const size = payload.length;
    const extra = size < 126 ? 0 : size <= 65535 ? 2 : 8;
    const bytes = Buffer.alloc(2 + extra + size);
    bytes[0] = (final ? 128 : 0) | opcode;
    bytes[1] = extra === 0 ? size : extra === 2 ? 126 : 127;
    if (extra === 2) bytes.writeUInt16BE(size, 2);
    if (extra === 8) bytes.writeBigUInt64BE(BigInt(size), 2);
    payload.copy(bytes, 2 + extra);
    transport.postMessage({ type: 'data', bytes });
  }
  const scope = {
    location: new URL(options.location || 'http://example.test/__vhost__/3000/'),
    URL, TextEncoder, TextDecoder, crypto: webcrypto, Headers, EventTarget, Event,
    MessageEvent, Blob, ArrayBuffer, Uint8Array, DataView, DOMException,
    CloseEvent: class extends Event { constructor(type, values) { super(type); Object.assign(this, values); } },
    MessageChannel: Channel, btoa, setTimeout, clearTimeout,
    WebSocket: class NativeWebSocket { constructor(...args) { this.args = args; } },
    addEventListener(name, callback) { listeners[name] = callback; },
    parent: {
      postMessage(message, origin, ports) {
        assert.equal(message.port, 3000);
        assert.equal(origin, 'http://example.test');
        transport = ports[0];
        let connected = false;
        transport.onmessage = ({ data }) => {
          if (data.type === 'close') return;
          const bytes = Buffer.from(data.bytes);
          if (!connected) {
            connected = true;
            const request = bytes.toString();
            const key = request.match(/Sec-WebSocket-Key: (.*)\r/)[1];
            const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            const response = Buffer.from(options.handshake ?? `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${options.protocol ? `Sec-WebSocket-Protocol: ${options.protocol}\r\n` : ''}\r\n`);
            transport.postMessage({ type: 'data', bytes: response.subarray(0, 10) });
            transport.postMessage({ type: 'data', bytes: response.subarray(10) });
            return;
          }
          assert.ok(bytes[1] & 128, 'client frames must be masked');
          let size = bytes[1] & 127;
          let offset = 2;
          if (size === 126) { size = bytes.readUInt16BE(2); offset = 4; }
          else if (size === 127) { size = Number(bytes.readBigUInt64BE(2)); offset = 10; }
          const payload = Buffer.alloc(size);
          for (let i = 0; i < size; i++) payload[i] = bytes[offset + 4 + i] ^ bytes[offset + i % 4];
          const opcode = bytes[0] & 15;
          received.push({ opcode, payload });
          if (opcode !== 10) frame(opcode, payload);
        };
        transport.postMessage({ type: 'connect' });
      },
    },
  };
  vm.runInNewContext(source, scope, { filename });
  return { scope, received, frame, listeners, raw: data => transport.postMessage(data) };
}

test('virtual WebSockets preserve protocols, ordered text and binary messages, and clean close', async () => {
  const { scope, received } = preview({ protocol: 'chat' });
  const socket = new scope.WebSocket('/echo', ['chat']);
  assert.equal(socket.readyState, socket.CONNECTING);
  assert.throws(() => socket.send('early'), { name: 'InvalidStateError' });
  await once(socket, 'open');
  assert.equal(socket.url, 'ws://example.test/echo');
  assert.equal(socket.protocol, 'chat');
  assert.equal(socket.extensions, '');
  socket.binaryType = 'invalid';
  assert.equal(socket.binaryType, 'blob');
  socket.binaryType = 'arraybuffer';
  for (const value of ['', 'x'.repeat(126), 'y'.repeat(70000), new Uint8Array([0, 1, 255]), new ArrayBuffer(3), new Blob(['blob'])]) {
    const message = once(socket, 'message');
    socket.send(value);
    assert.ok(socket.bufferedAmount >= 0);
    const { data } = await message;
    if (typeof value === 'string') assert.equal(data, value);
    else assert.deepEqual(Buffer.from(data), value instanceof Blob ? Buffer.from('blob') : Buffer.from(value));
  }
  assert.equal(socket.bufferedAmount, 0);
  assert.throws(() => socket.close(1001), { name: 'InvalidAccessError' });
  assert.throws(() => socket.close(1000, 'x'.repeat(124)), { name: 'SyntaxError' });
  const closed = once(socket, 'close');
  socket.close(3001, 'complete');
  socket.close();
  socket.send('ignored');
  const event = await closed;
  assert.equal(event.code, 3001);
  assert.equal(event.reason, 'complete');
  assert.ok(event.wasClean);
  assert.equal(socket.readyState, scope.WebSocket.CLOSED);
  assert.equal(received.at(-1).opcode, 8);
});

test('fragmented messages survive interleaved ping frames and default binary messages are Blobs', async () => {
  const { scope, frame, received, listeners } = preview();
  const socket = new scope.WebSocket('ws://localhost:3000/__vhost__/3000/echo');
  await once(socket, 'open');
  const message = once(socket, 'message');
  frame(1, 'hel', false);
  frame(9, 'ping');
  frame(0, 'lo');
  assert.equal((await message).data, 'hello');
  await Promise.resolve();
  assert.equal(received.at(-1).opcode, 10);
  const binary = once(socket, 'message');
  frame(2, [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await (await binary).data.arrayBuffer())], [1, 2, 3]);
  const closed = once(socket, 'close');
  listeners.pagehide();
  assert.equal((await closed).code, 1001);
});

test('invalid URLs and protocols fail synchronously while external hosts retain native WebSockets', () => {
  const { scope } = preview();
  for (const url of ['ftp://example.test/', 'ws://example.test/#fragment']) assert.throws(() => new scope.WebSocket(url), { name: 'SyntaxError' });
  assert.throws(() => new scope.WebSocket('/echo', ['duplicate', 'duplicate']), { name: 'SyntaxError' });
  assert.throws(() => new scope.WebSocket('/echo', 'invalid protocol'), { name: 'SyntaxError' });
  assert.deepEqual(new scope.WebSocket('wss://external.test/', 'chat').args, ['wss://external.test/', 'chat']);
  assert.equal(preview({ location: 'http://example.test/' }).scope.WebSocket.name, 'NativeWebSocket');
});

test('failed handshakes and invalid server frames report error and abnormal close', async () => {
  for (const invalid of [null, [0xc1, 0], [0x81, 0x80], [0x83, 0], [0x80, 0], [0x09, 0], [0x88, 1, 0]]) {
    const { scope, raw } = preview(invalid === null ? { handshake: 'HTTP/1.1 403 Forbidden\r\n\r\n' } : {});
    const socket = new scope.WebSocket('/echo');
    const error = once(socket, 'error');
    const closed = once(socket, 'close');
    if (invalid !== null) { await once(socket, 'open'); raw({ type: 'data', bytes: new Uint8Array(invalid) }); }
    await error;
    assert.equal((await closed).code, 1006);
  }
});
