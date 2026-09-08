import { openGatewaySocket } from './gateway-websocket-bridge.js';
import { gatewayError } from './gateway-selection.js';

export function validateWebSocketProtocols(protocols = []) {
  if (typeof protocols === 'string') protocols = [protocols];
  if (!Array.isArray(protocols) || protocols.length > 32 || new Set(protocols).size !== protocols.length
    || protocols.some(value => typeof value !== 'string' || value.length > 256 || !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(value))) {
    throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid WebSocket protocols');
  }
  return protocols;
}

/** RFC6455 framing stays in the trusted parent; clients receive messages, not raw TCP. */
export function openDirectWebSocket({ net, port, path, protocols = [], scope = globalThis,
  maxBodyBytes, signal, onOpen, onMessage, onClose, onError }) {
  protocols = validateWebSocketProtocols(protocols);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const crypto = scope.crypto;
  if (!crypto?.getRandomValues || !crypto?.subtle?.digest) throw gatewayError('ERR_GATEWAY_SESSION', 'WebSockets require WebCrypto in a secure context');
  const socket = openGatewaySocket(net, port);
  let state = 'connecting';
  let buffer = new Uint8Array();
  let fragments = [];
  let fragmentOpcode = 0;
  let fragmentSize = 0;
  let chain = Promise.resolve();
  let closeTimer;
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const accept = crypto.subtle.digest('SHA-1', encoder.encode(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))
    .then(bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))));
  const finish = (code = 1006, reason = '', wasClean = false) => {
    if (state === 'closed') return;
    state = 'closed';
    (scope.clearTimeout || clearTimeout)(closeTimer);
    signal?.removeEventListener('abort', abort);
    buffer = new Uint8Array(); fragments = [];
    socket.destroy();
    onClose({ code, reason, wasClean });
  };
  const fail = error => {
    if (state === 'closed') return;
    onError(error.code?.startsWith('ERR_GATEWAY_') ? error : gatewayError('ERR_GATEWAY_PROTOCOL', error.message));
    finish();
  };
  accept.catch(fail);
  const abort = () => finish(1001, 'Session closed');
  const frame = (opcode, bytes) => {
    const size = bytes.byteLength;
    if (size > maxBodyBytes) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'WebSocket message exceeds maxBodyBytes');
    const extra = size < 126 ? 0 : size <= 65535 ? 2 : 8;
    const output = new Uint8Array(6 + extra + size);
    output[0] = 128 | opcode;
    output[1] = 128 | (extra === 0 ? size : extra === 2 ? 126 : 127);
    const view = new DataView(output.buffer);
    if (extra === 2) view.setUint16(2, size);
    if (extra === 8) view.setBigUint64(2, BigInt(size));
    const mask = crypto.getRandomValues(output.subarray(2 + extra, 6 + extra));
    for (let i = 0; i < size; i++) output[6 + extra + i] = bytes[i] ^ mask[i % 4];
    socket.write(output);
  };
  const drain = async () => {
    if (state === 'connecting') {
      let end = -1;
      for (let i = 0; i + 3 < buffer.length; i++) if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) { end = i; break; }
      if (end < 0) { if (buffer.length > 32768) throw new Error('WebSocket headers exceed 32 KiB'); return; }
      if (end > 32768) throw new Error('WebSocket headers exceed 32 KiB');
      const lines = new TextDecoder().decode(buffer.subarray(0, end)).split('\r\n');
      if (!/^HTTP\/1\.[01] 101\b/.test(lines.shift())) throw new Error('Invalid WebSocket upgrade');
      const headers = new Headers();
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 1) throw new Error('Invalid WebSocket header');
        headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      if (headers.get('sec-websocket-accept') !== await accept
        || headers.get('upgrade')?.toLowerCase() !== 'websocket'
        || !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade')
        || headers.has('sec-websocket-extensions')) throw new Error('Invalid WebSocket handshake');
      if (state === 'closed') return;
      const protocol = headers.get('sec-websocket-protocol') || '';
      if (protocol && !protocols.includes(protocol)) throw new Error('Unexpected WebSocket protocol');
      buffer = buffer.slice(end + 4); state = 'open'; onOpen(protocol);
    }
    while (buffer.length >= 2 && state !== 'closed') {
      const opcode = buffer[0] & 15;
      const final = Boolean(buffer[0] & 128);
      let size = buffer[1] & 127;
      let offset = 2;
      if (buffer[0] & 0x70 || buffer[1] & 128) throw new Error('Invalid WebSocket frame flags');
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      if (size === 126) { if (buffer.length < 4) return; size = view.getUint16(2); offset = 4; }
      else if (size === 127) {
        if (buffer.length < 10) return;
        const bigSize = view.getBigUint64(2);
        if (bigSize > BigInt(maxBodyBytes)) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'WebSocket frame too large');
        size = Number(bigSize); offset = 10;
      }
      if (size > maxBodyBytes || (opcode < 8 && fragmentSize + size > maxBodyBytes)) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'WebSocket message too large');
      if (opcode >= 8 && (!final || size > 125)) throw new Error('Invalid WebSocket control frame');
      if (buffer.length < offset + size) return;
      const bytes = buffer.slice(offset, offset + size);
      buffer = buffer.slice(offset + size);
      if (opcode === 8) {
        if (size === 1) throw new Error('Invalid WebSocket close payload');
        const code = size ? new DataView(bytes.buffer).getUint16(0) : 1005;
        if (size && !(code >= 3000 && code <= 4999) && ![1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code)) throw new Error('Invalid WebSocket close code');
        const reason = size ? decoder.decode(bytes.subarray(2)) : '';
        if (state === 'open') frame(8, bytes);
        finish(code, reason, true);
      } else if (opcode === 9) frame(10, bytes);
      else if (opcode !== 10) {
        if (![0, 1, 2].includes(opcode) || (opcode === 0 ? !fragmentOpcode : fragmentOpcode)) throw new Error('Invalid WebSocket continuation');
        if (opcode) fragmentOpcode = opcode;
        fragments.push(bytes); fragmentSize += bytes.length;
        if (!final) continue;
        const message = new Uint8Array(fragmentSize);
        let at = 0;
        for (const part of fragments) { message.set(part, at); at += part.length; }
        const binary = fragmentOpcode === 2;
        if (!binary) decoder.decode(message); // Reject malformed UTF-8 before exposing a text message.
        fragments = []; fragmentSize = 0; fragmentOpcode = 0;
        onMessage(message, binary);
      }
    }
  };
  socket.on('data', bytes => {
    if (state === 'closed') return;
    if (buffer.length + bytes.length > maxBodyBytes + 32768) { fail(gatewayError('ERR_GATEWAY_BODY_LIMIT', 'WebSocket input limit')); return; }
    const input = new Uint8Array(buffer.length + bytes.length);
    input.set(buffer); input.set(bytes, buffer.length); buffer = input;
    chain = chain.then(drain).catch(fail);
  });
  socket.on('error', fail);
  socket.on('close', () => finish());
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  else socket.write(encoder.encode([
    `GET ${path} HTTP/1.1`, `Host: localhost:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', 'Origin: null',
    ...(protocols.length ? [`Sec-WebSocket-Protocol: ${protocols.join(', ')}`] : []), '', '',
  ].join('\r\n')));
  return {
    send(bytes, binary) {
      if (state !== 'open') throw gatewayError('ERR_GATEWAY_PROTOCOL', 'WebSocket is not open');
      if (!(bytes instanceof Uint8Array) || typeof binary !== 'boolean') throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid WebSocket message');
      if (!binary) decoder.decode(bytes);
      frame(binary ? 2 : 1, bytes);
    },
    close(code = 1000, reason = '') {
      if (code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid WebSocket close code');
      if (typeof reason !== 'string') throw gatewayError('ERR_GATEWAY_PROTOCOL', 'Invalid WebSocket close reason');
      const bytes = encoder.encode(reason);
      if (bytes.length > 123) throw gatewayError('ERR_GATEWAY_PROTOCOL', 'WebSocket close reason exceeds 123 bytes');
      if (state === 'connecting') { finish(); return; }
      if (state !== 'open') return;
      const payload = new Uint8Array(2 + bytes.length);
      new DataView(payload.buffer).setUint16(0, code); payload.set(bytes, 2);
      state = 'closing'; frame(8, payload);
      if (state !== 'closed') closeTimer = (scope.setTimeout || setTimeout)(() => finish(), 5000);
    },
  };
}
