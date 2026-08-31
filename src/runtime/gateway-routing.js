const DEFAULT_LEASE_MS = 30_000;
const PROTOCOL_VERSION = 1;

function routeId() {
  try {
    if (globalThis.crypto?.randomUUID) return `r-${globalThis.crypto.randomUUID()}`;
  } catch {}
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** In-memory registry for unguessable, client-bound gateway routes. */
export function createGatewayRouteRegistry({ now = () => Date.now(), leaseMs = DEFAULT_LEASE_MS, protocolVersion = PROTOCOL_VERSION } = {}) {
  const routes = new Map();
  const sweep = () => {
    const timestamp = now();
    for (const [id, route] of routes) if (route.expiresAt <= timestamp) routes.delete(id);
  };
  return {
    protocolVersion,
    register({ clientId, port, version = protocolVersion } = {}) {
      sweep();
      if (!clientId || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw Object.assign(new TypeError('clientId and a valid port are required'), { code: 'ERR_GATEWAY_ROUTE' });
      }
      if (version !== protocolVersion) throw Object.assign(new Error('gateway protocol version mismatch'), { code: 'ERR_GATEWAY_PROTOCOL_VERSION' });
      const id = routeId();
      const route = { routeId: id, clientId: String(clientId), port, version, createdAt: now(), expiresAt: now() + leaseMs };
      routes.set(id, route);
      return Object.freeze({ ...route });
    },
    renew(id, clientId) {
      const route = this.resolve(id, clientId);
      if (!route) return false;
      route.expiresAt = now() + leaseMs;
      return true;
    },
    resolve(id, clientId, version = protocolVersion) {
      sweep();
      const route = routes.get(String(id));
      if (!route || route.clientId !== String(clientId) || route.version !== version) return null;
      return Object.freeze({ ...route });
    },
    unregister(id, clientId) {
      const route = this.resolve(id, clientId);
      if (!route) return false;
      return routes.delete(String(id));
    },
    list() { sweep(); return [...routes.values()].map((route) => Object.freeze({ ...route })); },
    sweep,
  };
}

export { DEFAULT_LEASE_MS, PROTOCOL_VERSION };
