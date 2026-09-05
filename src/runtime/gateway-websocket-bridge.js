export function installGatewayWebSocketBridge(scope, getNet) {
  const sockets = new Set();
  const onMessage = event => {
    if (event.origin !== scope.location.origin || event.data?.type !== 'bnh-vnet-websocket') return;
    const channel = event.ports?.[0];
    if (!channel) return;
    let socket;
    try {
      const source = new URL(event.source.location.href);
      const route = source.pathname.match(/^\/(?:__vhost__|__bnh_vnet__)\/(?:r-[^/]+\/)?(\d+)(?:\/|$)/);
      if (!route || Number(route[1]) !== event.data.port) throw new Error('WebSocket source is not a virtual host');
      socket = getNet().connect({ port: Number(route[1]), host: '127.0.0.1' });
      sockets.add(socket);
      socket.on('data', bytes => channel.postMessage({ type: 'data', bytes: new Uint8Array(bytes) }));
      socket.on('error', error => channel.postMessage({ type: 'error', message: error.message }));
      socket.on('close', () => {
        sockets.delete(socket);
        channel.postMessage({ type: 'close' });
        channel.close();
      });
      channel.onmessage = message => {
        if (message.data.type === 'data') socket.write(message.data.bytes);
        else if (message.data.type === 'close') socket.destroy();
      };
      channel.start();
      socket.on('connect', () => channel.postMessage({ type: 'connect' }));
    } catch (error) {
      socket?.destroy();
      channel.postMessage({ type: 'error', message: error.message });
      channel.close();
    }
  };
  scope.addEventListener('message', onMessage);
  return () => {
    scope.removeEventListener('message', onMessage);
    for (const socket of sockets) socket.destroy();
  };
}
