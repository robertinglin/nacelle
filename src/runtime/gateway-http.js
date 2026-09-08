import { gatewayError } from './gateway-selection.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');
const concat = (a, b) => { const result = new Uint8Array(a.length + b.length); result.set(a); result.set(b, a.length); return result; };
const lineEnd = bytes => { for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) return i; return -1; };

/** Incremental HTTP/1 response framing for virtual TCP transports, not host fetch. */
export function createGatewayHttpParser({ method = 'GET', maxBodyBytes = 16 * 1024 * 1024,
  onStart, onChunk, onEnd, filterHeaders = true }) {
  let buffer = new Uint8Array();
  let phase = 'headers';
  let remaining = 0;
  let received = 0;
  let trailerBytes = 0;
  const fail = message => { throw gatewayError('ERR_GATEWAY_PROTOCOL', message); };
  const finish = () => { if (phase !== 'done') { phase = 'done'; onEnd(); } };
  const chunk = bytes => {
    received += bytes.length;
    if (received > maxBodyBytes) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'Response exceeds maxBodyBytes');
    if (bytes.length) onChunk(bytes);
  };
  return {
    write(bytes) {
      if (phase === 'done') return;
      buffer = concat(buffer, bytes);
      while (phase !== 'done') {
        if (phase === 'headers') {
          let end = -1;
          for (let i = 0; i + 3 < buffer.length; i++) {
            if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) { end = i; break; }
          }
          if (end < 0) { if (buffer.length > 32768) fail('Response headers exceed 32 KiB'); return; }
          if (end > 32768) fail('Response headers exceed 32 KiB');
          const lines = decoder.decode(buffer.subarray(0, end)).split('\r\n');
          const status = /^HTTP\/1\.[01] (\d{3})(?: ([\x20-\x7e\x80-\xff]*))?$/.exec(lines.shift());
          if (!status || +status[1] < 100 || +status[1] > 599) fail('Invalid HTTP status');
          const headers = Object.create(null);
          for (const line of lines) {
            const match = /^([!#$%&'*+.^_`|~\da-z-]+):[\t ]*([^\r\n]*)$/i.exec(line);
            if (!match || /[^\t\x20-\x7e\x80-\xff]/.test(match[2])) fail('Invalid response header');
            const name = match[1].toLowerCase();
            if (headers[name] !== undefined && ['content-length', 'transfer-encoding'].includes(name)) fail('Ambiguous response framing');
            if (!filterHeaders && name === 'set-cookie') (headers[name] ||= []).push(match[2]);
            else headers[name] = headers[name] === undefined ? match[2] : `${headers[name]}, ${match[2]}`;
          }
          buffer = buffer.slice(end + 4);
          const code = +status[1];
          if (code < 200) { if (code === 101) fail('Unexpected HTTP upgrade'); continue; }
          const length = headers['content-length'];
          const encoding = headers['transfer-encoding'];
          if (encoding && (encoding.toLowerCase() !== 'chunked' || length !== undefined)) fail('Unsupported response framing');
          if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(+length))) fail('Invalid Content-Length');
          if (length !== undefined && +length > maxBodyBytes && method !== 'HEAD') {
            throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'Response exceeds maxBodyBytes');
          }
          phase = encoding ? 'size' : length === undefined ? 'eof' : 'fixed';
          remaining = Number(length || 0);
          if (filterHeaders) {
            for (const name of String(headers.connection || '').split(',')) delete headers[name.trim().toLowerCase()];
            for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'trailer', 'upgrade', 'set-cookie', 'set-cookie2']) delete headers[name];
          } else delete headers['transfer-encoding'];
          onStart({ status: code, statusText: status[2] || '', headers, contentType: headers['content-type'] || '' });
          if (method === 'HEAD' || [204, 205, 304].includes(code) || (phase === 'fixed' && remaining === 0)) finish();
        } else if (phase === 'size' || phase === 'trailers') {
          const end = lineEnd(buffer);
          if (end < 0) { if (buffer.length > 8192) fail('Oversized HTTP chunk line'); return; }
          const line = decoder.decode(buffer.subarray(0, end));
          buffer = buffer.slice(end + 2);
          if (phase === 'trailers') {
            trailerBytes += end + 2;
            if (trailerBytes > 32768) fail('Oversized HTTP trailers');
            if (!line) finish();
            else if (!/^[!#$%&'*+.^_`|~\da-z-]+:/i.test(line)) fail('Invalid HTTP trailer');
          } else {
            const size = line.split(';', 1)[0];
            if (!/^[\da-f]+$/i.test(size) || !Number.isSafeInteger(parseInt(size, 16))) fail('Invalid HTTP chunk size');
            remaining = parseInt(size, 16);
            if (remaining + received > maxBodyBytes) throw gatewayError('ERR_GATEWAY_BODY_LIMIT', 'Response exceeds maxBodyBytes');
            phase = remaining ? 'data' : 'trailers';
          }
        } else if (phase === 'crlf') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 13 || buffer[1] !== 10) fail('Invalid HTTP chunk terminator');
          buffer = buffer.slice(2); phase = 'size';
        } else {
          if (!buffer.length) return;
          const size = phase === 'eof' ? buffer.length : Math.min(remaining, buffer.length);
          chunk(buffer.slice(0, size)); buffer = buffer.slice(size); remaining -= size;
          if (phase === 'fixed' && !remaining) finish();
          else if (phase === 'data' && !remaining) phase = 'crlf';
        }
      }
    },
    end() {
      if (phase === 'eof') finish();
      else if (phase !== 'done') fail('Truncated HTTP response');
    },
  };
}

export function openGatewayHttp({ net, port, request, signal, maxBodyBytes, onStart, onChunk }) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket?.destroy();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason || gatewayError('ERR_GATEWAY_CLOSED', 'Request cancelled'));
    if (signal?.aborted) { abort(); return; }
    const parser = createGatewayHttpParser({ method: request.method, maxBodyBytes, onStart, onChunk, onEnd: () => finish() });
    try {
      socket = net.connect({ port, host: '127.0.0.1' });
      signal?.addEventListener('abort', abort, { once: true });
      socket.on('error', finish);
      socket.on('data', bytes => { if (!settled) { try { parser.write(new Uint8Array(bytes)); } catch (error) { finish(error); } } });
      const end = () => { if (!settled) { try { parser.end(); } catch (error) { finish(error); } } };
      socket.on('end', end);
      socket.on('close', end);
      const headers = Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`);
      headers.push(`host: localhost:${port}`, 'connection: close', `content-length: ${request.body.length}`);
      const path = request.path.split('#', 1)[0];
      socket.write(encoder.encode(`${request.method} ${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`));
      if (request.body.length) socket.write(request.body);
    } catch (error) { finish(error); }
  });
}
