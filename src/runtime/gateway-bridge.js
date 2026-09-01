export function installGatewayBridge({ net, globalObject = globalThis } = {}) {
  if (!globalObject.navigator?.serviceWorker) return () => {};

  globalObject.__bnhActiveGatewayNet = net;
  if (globalObject.__bnhGatewayBridgeInstalled) {
    return () => {
      if (globalObject.__bnhActiveGatewayNet === net) {
        globalObject.__bnhActiveGatewayNet = null;
      }
    };
  }
  globalObject.__bnhGatewayBridgeInstalled = true;

  const onMessage = async (event) => {
    const data = event.data;
    if (!data || data.type !== 'bnh-vnet-request') return;

    const currentNet = globalObject.__bnhActiveGatewayNet || net;
    if (!currentNet) return;

    const { port, method, url, headers = {}, body } = data;
    const responsePort = event.ports && event.ports[0];
    if (!responsePort) return;

    try {
      const socket = currentNet.connect({ port, host: '127.0.0.1' });

      let headersParsed = false;
      let rawHeaderBuffer = new Uint8Array(0);
      let isChunked = false;
      let chunkRemaining = 0;
      let chunkState = 'size'; // 'size' | 'data' | 'crlf'

      const concat = (a, b) => {
        const out = new Uint8Array(a.byteLength + b.byteLength);
        out.set(a, 0);
        out.set(b, a.byteLength);
        return out;
      };

      const findHeaderEnd = (buffer) => {
        for (let i = 0; i < buffer.byteLength - 3; i += 1) {
          if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
            return i;
          }
        }
        for (let i = 0; i < buffer.byteLength - 1; i += 1) {
          if (buffer[i] === 10 && buffer[i + 1] === 10) {
            return i;
          }
        }
        return -1;
      };

      const parseHeaders = (headerText) => {
        const lines = headerText.split(/\r?\n/);
        const statusLine = lines[0] || 'HTTP/1.1 200 OK';
        const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)(?:\s+(.*))?$/);
        const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;
        const statusText = statusMatch ? statusMatch[2] || 'OK' : 'OK';

        const parsedHeaders = {};
        for (let i = 1; i < lines.length; i += 1) {
          const line = lines[i];
          if (!line) continue;
          const colon = line.indexOf(':');
          if (colon !== -1) {
            const key = line.slice(0, colon).trim().toLowerCase();
            const val = line.slice(colon + 1).trim();
            if (key === 'set-cookie') {
              if (!parsedHeaders[key]) parsedHeaders[key] = [];
              parsedHeaders[key].push(val);
            } else {
              parsedHeaders[key] = val;
            }
          }
        }

        if (parsedHeaders['transfer-encoding']?.toLowerCase() === 'chunked') {
          isChunked = true;
          delete parsedHeaders['transfer-encoding'];
        }

        return { statusCode, statusText, headers: parsedHeaders };
      };

      const processChunkedData = (bytes) => {
        let offset = 0;
        const chunks = [];
        while (offset < bytes.byteLength) {
          if (chunkState === 'size') {
            const crlf = findCRLF(bytes, offset);
            if (crlf === -1) break;
            const sizeStr = new TextDecoder().decode(bytes.subarray(offset, crlf)).trim().split(';')[0];
            const chunkSize = parseInt(sizeStr, 16);
            offset = crlf + 2;
            if (chunkSize === 0) {
              chunkState = 'trailer';
              break;
            }
            chunkRemaining = chunkSize;
            chunkState = 'data';
          } else if (chunkState === 'data') {
            const available = bytes.byteLength - offset;
            const toRead = Math.min(available, chunkRemaining);
            chunks.push(bytes.subarray(offset, offset + toRead));
            offset += toRead;
            chunkRemaining -= toRead;
            if (chunkRemaining === 0) {
              chunkState = 'crlf';
            }
          } else if (chunkState === 'crlf') {
            if (offset + 1 < bytes.byteLength && bytes[offset] === 13 && bytes[offset + 1] === 10) {
              offset += 2;
            } else if (offset < bytes.byteLength && bytes[offset] === 10) {
              offset += 1;
            }
            chunkState = 'size';
          }
        }
        return chunks;
      };

      const findCRLF = (buffer, start) => {
        for (let i = start; i < buffer.byteLength - 1; i += 1) {
          if (buffer[i] === 13 && buffer[i + 1] === 10) return i;
          if (buffer[i] === 10) return i;
        }
        return -1;
      };

      let contentLength = null;
      let receivedBytes = 0;
      let ended = false;

      globalObject.__bnhGatewayLogs = globalObject.__bnhGatewayLogs || [];
      globalObject.__bnhGatewayLogs.push({ type: 'sw-request', url, port, method });

      const finishResponse = () => {
        if (ended) return;
        ended = true;
        globalObject.__bnhGatewayLogs.push({ type: 'finish-response', receivedBytes, contentLength });
        responsePort.postMessage({ type: 'bnh-vnet-response-end' });
        try { socket.destroy?.(); } catch {}
      };

      socket.on('data', (chunk) => {
        const chunkBytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        globalObject.__bnhGatewayLogs.push({
          type: 'socket-data',
          len: chunkBytes.byteLength,
          headersParsed,
          textSample: new TextDecoder('latin1').decode(chunkBytes).slice(0, 80),
        });
        if (!headersParsed) {
          rawHeaderBuffer = concat(rawHeaderBuffer, chunkBytes);
          const endIdx = findHeaderEnd(rawHeaderBuffer);
          if (endIdx !== -1) {
            headersParsed = true;
            const headerBytes = rawHeaderBuffer.subarray(0, endIdx);
            const headerText = new TextDecoder('latin1').decode(headerBytes);
            const parsed = parseHeaders(headerText);
            contentLength = parsed.headers['content-length'] ? parseInt(parsed.headers['content-length'], 10) : null;
            globalObject.__bnhGatewayLogs.push({ type: 'headers-parsed', statusCode: parsed.statusCode, headers: parsed.headers });

            const isDoubleCRLF = rawHeaderBuffer[endIdx] === 13 && rawHeaderBuffer[endIdx + 1] === 10;
            const bodyOffset = endIdx + (isDoubleCRLF ? 4 : 2);
            const remainingBody = rawHeaderBuffer.subarray(bodyOffset);

            responsePort.postMessage({
              type: 'bnh-vnet-response-start',
              statusCode: parsed.statusCode,
              statusText: parsed.statusText,
              headers: parsed.headers,
            });

            if (remainingBody.byteLength > 0) {
              if (isChunked) {
                const dechunked = processChunkedData(remainingBody);
                for (const c of dechunked) {
                  receivedBytes += c.byteLength;
                  const ab = c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength);
                  responsePort.postMessage({ type: 'bnh-vnet-response-chunk', chunk: ab }, [ab]);
                }
                if (chunkState === 'trailer') {
                  finishResponse();
                }
              } else {
                receivedBytes += remainingBody.byteLength;
                const ab = remainingBody.buffer.slice(remainingBody.byteOffset, remainingBody.byteOffset + remainingBody.byteLength);
                responsePort.postMessage({ type: 'bnh-vnet-response-chunk', chunk: ab }, [ab]);
                if (contentLength !== null && receivedBytes >= contentLength) {
                  finishResponse();
                }
              }
            } else if (contentLength === 0) {
              finishResponse();
            }
          }
        } else {
          if (isChunked) {
            const dechunked = processChunkedData(chunkBytes);
            for (const c of dechunked) {
              receivedBytes += c.byteLength;
              const ab = c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength);
              responsePort.postMessage({ type: 'bnh-vnet-response-chunk', chunk: ab }, [ab]);
            }
            if (chunkState === 'trailer') {
              finishResponse();
            }
          } else {
            receivedBytes += chunkBytes.byteLength;
            const ab = chunkBytes.buffer.slice(chunkBytes.byteOffset, chunkBytes.byteOffset + chunkBytes.byteLength);
            responsePort.postMessage({ type: 'bnh-vnet-response-chunk', chunk: ab }, [ab]);
            if (contentLength !== null && receivedBytes >= contentLength) {
              finishResponse();
            }
          }
        }
      });

      socket.on('connect', () => {
        globalObject.__bnhGatewayLogs.push({ type: 'socket-connect' });
      });

      socket.on('end', () => {
        globalObject.__bnhGatewayLogs.push({ type: 'socket-end' });
        finishResponse();
      });

      socket.on('close', (hadError) => {
        globalObject.__bnhGatewayLogs.push({ type: 'socket-close', hadError });
        if (!ended && headersParsed) finishResponse();
      });

      socket.on('error', (err) => {
        globalObject.__bnhGatewayLogs.push({ type: 'socket-error', message: err?.message });
        if (!ended) {
          ended = true;
          responsePort.postMessage({
            type: 'bnh-vnet-response-error',
            error: err?.message || 'Virtual socket error',
          });
        }
      });

      // Write client request to server
      const reqLines = [`${method} ${url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'connection') continue;
        if (Array.isArray(v)) {
          for (const item of v) reqLines.push(`${k}: ${item}`);
        } else {
          reqLines.push(`${k}: ${v}`);
        }
      }
      if (!headers.host) {
        reqLines.push(`host: 127.0.0.1:${port}`);
      }
      reqLines.push('connection: close');
      if (body && body.byteLength > 0 && !headers['content-length']) {
        reqLines.push(`content-length: ${body.byteLength}`);
      }
      reqLines.push('');
      reqLines.push('');

      socket.write(new TextEncoder().encode(reqLines.join('\r\n')));
      if (body && body.byteLength > 0) {
        socket.write(body);
      }
      responsePort.start?.();
    } catch (err) {
      responsePort.postMessage({
        type: 'bnh-vnet-response-error',
        error: err?.message || 'Failed to dispatch to virtual server',
      });
    }
  };

  globalObject.navigator.serviceWorker.addEventListener('message', onMessage);
  return () => {
    globalObject.navigator.serviceWorker.removeEventListener('message', onMessage);
  };
}
