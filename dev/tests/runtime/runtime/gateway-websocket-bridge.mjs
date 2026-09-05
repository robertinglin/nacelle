import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { installGatewayWebSocketBridge } from '../../../../src/runtime/gateway-websocket-bridge.js';

test('gateway WebSockets relay duplex bytes and release sockets on close or disposal', () => {
  let onMessage;
  const scope = {
    location: new URL('http://example.test/'),
    addEventListener(name, callback) { assert.equal(name, 'message'); onMessage = callback; },
    removeEventListener(name, callback) { assert.equal(name, 'message'); assert.equal(callback, onMessage); },
  };
  const sockets = [];
  const close = installGatewayWebSocketBridge(scope, () => ({
    connect(address) {
      assert.deepEqual(address, { port: 3000, host: '127.0.0.1' });
      const socket = new EventEmitter();
      socket.write = bytes => { socket.written = bytes; };
      socket.destroy = () => { socket.emit('close'); socket.destroyed = true; };
      sockets.push(socket);
      return socket;
    },
  }));
  const messages = [];
  const channel = { postMessage: data => messages.push(data), close() { this.closed = true; }, start() {} };
  const request = {
    origin: 'http://example.test', data: { type: 'bnh-vnet-websocket', port: 3000 },
    source: { location: { href: 'http://example.test/__vhost__/r-owner/3000/' } }, ports: [channel],
  };
  onMessage({ ...request, origin: 'http://foreign.test' });
  onMessage({ ...request, data: {} });
  onMessage({ ...request, ports: [] });
  assert.equal(sockets.length, 0);
  onMessage(request);
  const socket = sockets[0];
  socket.emit('connect');
  socket.emit('data', new Uint8Array([1, 2]));
  channel.onmessage({ data: { type: 'data', bytes: new Uint8Array([3, 4]) } });
  assert.deepEqual([...socket.written], [3, 4]);
  assert.deepEqual(messages.slice(0, 2), [{ type: 'connect' }, { type: 'data', bytes: new Uint8Array([1, 2]) }]);
  socket.emit('error', new Error('connection failed'));
  assert.equal(messages.at(-1).message, 'connection failed');
  channel.onmessage({ data: { type: 'close' } });
  assert.ok(socket.destroyed && channel.closed);
  onMessage(request);
  close();
  assert.ok(sockets[1].destroyed);
});

test('gateway rejects non-virtual sources and reports connection setup failures', () => {
  let onMessage;
  const scope = {
    location: new URL('http://example.test/'),
    addEventListener(_name, callback) { onMessage = callback; }, removeEventListener() {},
  };
  const close = installGatewayWebSocketBridge(scope, () => ({ connect() { throw new Error('connection unavailable'); } }));
  const messages = [];
  const channel = { postMessage: data => messages.push(data), close() {} };
  for (const pathname of ['/', '/__vhost__/4000/', '/__vhost__/3000/']) {
    onMessage({
      origin: 'http://example.test', data: { type: 'bnh-vnet-websocket', port: 3000 },
      source: { location: { href: 'http://example.test' + pathname } }, ports: [channel],
    });
    assert.equal(messages.at(-1).type, 'error');
  }
  assert.equal(messages.at(-1).message, 'connection unavailable');
  close();
});
