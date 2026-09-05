import net from 'node:net';

// The browser-local virtual TCP allocator owns this range. Host-side adapter
// listeners must stay outside it because guest servers are exposed on the
// same numeric loopback port to real browsers.
export const VIRTUAL_TCP_PORT_MIN = 41000;
export const VIRTUAL_TCP_PORT_MAX = 60000;

export function isHostPortAvailableForVirtualNetwork(port) {
  return port < VIRTUAL_TCP_PORT_MIN || port > VIRTUAL_TCP_PORT_MAX;
}

export async function allocateHostPort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const value = typeof address === 'object' && address ? address.port : null;
        server.close((error) => error ? reject(error) : resolve(value));
      });
    });
    if (Number.isInteger(port) && isHostPortAvailableForVirtualNetwork(port)) return port;
  }
}
