import { installGatewayWebSocketBridge } from './gateway-websocket-bridge.js';
import { createGatewayHttpParser } from './gateway-http.js';

/** Service Worker delivery adapter; HTTP framing is shared with direct mode. */
export function installGatewayBridge({ net, globalObject = globalThis } = {}) {
  const serviceWorker = globalObject.navigator?.serviceWorker;
  if (!serviceWorker) return () => {};
  const owner = { net };
  let state = globalObject.__bnhGatewayBridgeState;
  if (!state) {
    state = { owners: [], requests: new Set() };
    globalObject.__bnhGatewayBridgeState = state;
    globalObject.__bnhGatewayBridgeInstalled = true;
    const currentNet = () => globalObject.__bnhActiveGatewayNet;
    const closeWebSockets = installGatewayWebSocketBridge(globalObject, currentNet);
    const logs = globalObject.__bnhGatewayLogs ||= [];
    const log = entry => { logs.push(entry); if (logs.length > 128) logs.shift(); };
    const onMessage = event => {
      const data = event.data;
      const responsePort = event.ports?.[0];
      if (data?.type !== 'bnh-vnet-request' || !responsePort || !currentNet()) return;
      const { port, method = 'GET', url, headers = {}, body } = data;
      let socket;
      let ended = false;
      let receivedBytes = 0;
      const finish = error => {
        if (ended) return;
        ended = true;
        state.requests.delete(cancel);
        try {
          responsePort.postMessage(error ? { type: 'bnh-vnet-response-error', error: error.message || String(error) }
            : { type: 'bnh-vnet-response-end' });
        } finally { socket?.destroy(); responsePort.close?.(); }
        log({ type: 'finish-response', receivedBytes });
      };
      const cancel = () => finish(new Error('Gateway bridge closed'));
      const parser = createGatewayHttpParser({ method, maxBodyBytes: Infinity, filterHeaders: false,
        onStart({ status, statusText, headers }) {
          responsePort.postMessage({ type: 'bnh-vnet-response-start', statusCode: status, statusText, headers });
        },
        onChunk(bytes) {
          receivedBytes += bytes.length;
          const chunk = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          responsePort.postMessage({ type: 'bnh-vnet-response-chunk', chunk }, [chunk]);
        }, onEnd: () => finish(),
      });
      try {
        socket = currentNet().connect({ port, host: '127.0.0.1' });
        state.requests.add(cancel);
        log({ type: 'sw-request', url, port, method });
        socket.on('data', bytes => { if (!ended) { try { parser.write(new Uint8Array(bytes)); } catch (error) { finish(error); } } });
        const end = () => { if (!ended) { try { parser.end(); } catch (error) { finish(error); } } };
        socket.on('end', end); socket.on('close', end); socket.on('error', finish);
        const lines = [`${method} ${url} HTTP/1.1`];
        for (const [name, value] of Object.entries(headers)) {
          if (name.toLowerCase() !== 'connection') for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
        }
        if (!headers.host) lines.push(`host: 127.0.0.1:${port}`);
        lines.push('connection: close');
        if (body?.byteLength && !headers['content-length']) lines.push(`content-length: ${body.byteLength}`);
        socket.write(new TextEncoder().encode([...lines, '', ''].join('\r\n')));
        if (body?.byteLength) socket.write(body);
        responsePort.start?.();
      } catch (error) { finish(error); }
    };
    serviceWorker.addEventListener('message', onMessage);
    state.close = () => {
      for (const cancel of [...state.requests]) cancel();
      closeWebSockets();
      serviceWorker.removeEventListener('message', onMessage);
      delete globalObject.__bnhGatewayBridgeState;
      globalObject.__bnhGatewayBridgeInstalled = false;
    };
  }
  state.owners.push(owner);
  globalObject.__bnhActiveGatewayNet = net;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    state.owners.splice(state.owners.indexOf(owner), 1);
    globalObject.__bnhActiveGatewayNet = state.owners.at(-1)?.net || null;
    if (!state.owners.length) state.close();
  };
}
