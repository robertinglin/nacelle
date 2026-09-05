// Loaded synchronously before application scripts in virtual-host documents.
(() => {
  const route = location.pathname.match(/^\/(?:__vhost__|__bnh_vnet__)\/(?:r-[^/]+\/)?(\d+)(?:\/|$)/);
  if (!route) return;
  const port = Number(route[1]);
  const NativeWebSocket = globalThis.WebSocket;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const connections = new Set();

  class VirtualWebSocket extends EventTarget {
    constructor(address, protocols = []) {
      super();
      const url = new URL(address, location.href);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (!['ws:', 'wss:'].includes(url.protocol) || url.hash) throw new DOMException('Invalid WebSocket URL', 'SyntaxError');
      if (url.host !== location.host && !(url.port === String(port) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        return new NativeWebSocket(address, protocols);
      }
      protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
      if (new Set(protocols).size !== protocols.length || protocols.some(value => !/^[!#$%&'*+\-.^_`|~\da-z]+$/i.test(value))) {
        throw new DOMException('Invalid WebSocket protocols', 'SyntaxError');
      }
      this._url = url.href;
      this._state = 0;
      this._protocol = '';
      this._binaryType = 'blob';
      this._bufferedAmount = 0;
      this._input = new Uint8Array();
      this._fragments = [];
      this._fragmentOpcode = 0;
      this._sendQueue = Promise.resolve();
      this._processing = false;
      const channel = new MessageChannel();
      this._channel = channel.port1;
      const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      this._accept = crypto.subtle.digest('SHA-1', encoder.encode(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))
        .then(bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))));
      const target = url.pathname.replace(/^\/(?:__vhost__|__bnh_vnet__)\/(?:r-[^/]+\/)?\d+/, '') || '/';
      const request = [
        `GET ${target}${url.search} HTTP/1.1`, `Host: ${url.host}`,
        'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13', `Origin: ${location.origin}`,
        ...(protocols.length ? [`Sec-WebSocket-Protocol: ${protocols.join(', ')}`] : []), '', '',
      ].join('\r\n');
      this._channel.onmessage = event => {
        const message = event.data;
        if (message.type === 'connect') this._write(encoder.encode(request));
        else if (message.type === 'data') {
          const bytes = new Uint8Array(message.bytes);
          const input = new Uint8Array(this._input.length + bytes.length);
          input.set(this._input);
          input.set(bytes, this._input.length);
          this._input = input;
          this._drain(protocols).catch(() => this._fail());
        } else if (message.type === 'error') this._fail();
        else if (message.type === 'close') this._finish(1006, '', false);
      };
      connections.add(this);
      parent.postMessage({ type: 'bnh-vnet-websocket', port }, location.origin, [channel.port2]);
    }

    get url() { return this._url; }
    get readyState() { return this._state; }
    get protocol() { return this._protocol; }
    get extensions() { return ''; }
    get bufferedAmount() { return this._bufferedAmount; }
    get binaryType() { return this._binaryType; }
    set binaryType(value) { if (value === 'blob' || value === 'arraybuffer') this._binaryType = value; }

    _emit(event) {
      this.dispatchEvent(event);
      if (typeof this[`on${event.type}`] === 'function') this[`on${event.type}`](event);
    }

    _write(bytes) { this._channel.postMessage({ type: 'data', bytes }); }

    _frame(opcode, payload) {
      const size = payload.byteLength;
      const extra = size < 126 ? 0 : size <= 65535 ? 2 : 8;
      const frame = new Uint8Array(2 + extra + 4 + size);
      frame[0] = 0x80 | opcode;
      frame[1] = 0x80 | (extra === 0 ? size : extra === 2 ? 126 : 127);
      const view = new DataView(frame.buffer);
      if (extra === 2) view.setUint16(2, size);
      if (extra === 8) view.setBigUint64(2, BigInt(size));
      const mask = crypto.getRandomValues(frame.subarray(2 + extra, 6 + extra));
      for (let i = 0; i < size; i++) frame[6 + extra + i] = payload[i] ^ mask[i % 4];
      this._write(frame);
    }

    async _drain(protocols) {
      if (this._processing || this._state === 3) return;
      this._processing = true;
      try {
        if (this._state === 0) {
          const header = new TextDecoder().decode(this._input);
          const end = header.indexOf('\r\n\r\n');
          if (end < 0) return;
          const lines = header.slice(0, end).split('\r\n');
          const headers = new Headers(lines.slice(1).map(line => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon), line.slice(colon + 1).trim()];
          }));
          if (!/^HTTP\/1\.[01] 101\b/.test(lines[0]) || headers.get('sec-websocket-accept') !== await this._accept) throw new Error('Invalid WebSocket handshake');
          this._protocol = headers.get('sec-websocket-protocol') || '';
          if (this._protocol && !protocols.includes(this._protocol)) throw new Error('Unexpected WebSocket protocol');
          this._input = this._input.slice(end + 4);
          this._state = 1;
          this._emit(new Event('open'));
        }
        while (this._input.length >= 2 && this._state !== 3) {
          const input = this._input;
          const opcode = input[0] & 15;
          const final = Boolean(input[0] & 128);
          let size = input[1] & 127;
          let offset = 2;
          if (input[0] & 0x70 || input[1] & 128) throw new Error('Invalid server frame');
          if (size === 126) {
            if (input.length < 4) return;
            size = new DataView(input.buffer, input.byteOffset).getUint16(2);
            offset = 4;
          } else if (size === 127) {
            if (input.length < 10) return;
            const length = new DataView(input.buffer, input.byteOffset).getBigUint64(2);
            if (length > 128n * 1024n * 1024n) throw new Error('WebSocket frame too large');
            size = Number(length);
            offset = 10;
          }
          if (opcode >= 8 && (!final || size > 125)) throw new Error('Invalid control frame');
          if (input.length < offset + size) return;
          const payload = input.slice(offset, offset + size);
          this._input = input.slice(offset + size);
          if (opcode === 8) {
            if (size === 1) throw new Error('Invalid close frame');
            const code = size ? new DataView(payload.buffer).getUint16(0) : 1005;
            const reason = size ? decoder.decode(payload.subarray(2)) : '';
            if (this._state === 1) this._frame(8, payload);
            this._finish(code, reason, true);
          } else if (opcode === 9) this._frame(10, payload);
          else if (opcode !== 10) {
            if (![0, 1, 2].includes(opcode) || (opcode === 0 ? !this._fragmentOpcode : this._fragmentOpcode)) throw new Error('Invalid continuation frame');
            if (opcode) this._fragmentOpcode = opcode;
            this._fragments.push(payload);
            if (!final) continue;
            const bytes = new Uint8Array(this._fragments.reduce((length, chunk) => length + chunk.length, 0));
            let at = 0;
            for (const chunk of this._fragments) { bytes.set(chunk, at); at += chunk.length; }
            const data = this._fragmentOpcode === 1 ? decoder.decode(bytes)
              : this.binaryType === 'blob' ? new Blob([bytes]) : bytes.buffer;
            this._fragments = [];
            this._fragmentOpcode = 0;
            this._emit(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
          }
        }
      } finally { this._processing = false; }
    }

    send(data) {
      if (this._state === 0) throw new DOMException('WebSocket is connecting', 'InvalidStateError');
      if (this._state !== 1) return;
      const text = typeof data === 'string' || !(data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data));
      const value = text ? encoder.encode(String(data)) : data instanceof Blob ? data
        : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const size = value.size ?? value.byteLength;
      this._bufferedAmount += size;
      this._sendQueue = this._sendQueue.then(async () => {
        const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value;
        this._frame(text ? 1 : 2, bytes);
        this._bufferedAmount -= size;
      }).catch(() => this._fail());
    }

    close(code = 1000, reason = '') {
      if (code !== 1000 && !(code >= 3000 && code <= 4999)) throw new DOMException('Invalid close code', 'InvalidAccessError');
      const text = encoder.encode(String(reason));
      if (text.length > 123) throw new DOMException('Close reason is too long', 'SyntaxError');
      if (this._state >= 2) return;
      if (this._state === 0) { this._finish(1006, '', false); return; }
      this._state = 2;
      const payload = new Uint8Array(2 + text.length);
      new DataView(payload.buffer).setUint16(0, code);
      payload.set(text, 2);
      this._sendQueue.then(() => this._frame(8, payload));
      this._closeTimer = setTimeout(() => this._finish(1006, '', false), 5000);
    }

    _fail() {
      if (this._state === 3) return;
      this._emit(new Event('error'));
      this._finish(1006, '', false);
    }

    _finish(code, reason, wasClean) {
      if (this._state === 3) return;
      this._state = 3;
      clearTimeout(this._closeTimer);
      this._channel.postMessage({ type: 'close' });
      this._channel.close();
      connections.delete(this);
      this._emit(new CloseEvent('close', { code, reason, wasClean }));
    }
  }

  for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    Object.defineProperty(VirtualWebSocket, name, { value });
    Object.defineProperty(VirtualWebSocket.prototype, name, { value });
  }
  globalThis.WebSocket = VirtualWebSocket;
  addEventListener('pagehide', () => { for (const socket of connections) socket._finish(1001, '', false); });
})();
