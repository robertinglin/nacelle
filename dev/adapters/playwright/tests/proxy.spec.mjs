import { expect, test } from 'playwright/test';
import {
  callProxy,
  createProxyCapability,
  normalizeProxyError,
  normalizeProxyResult,
} from '../runtime/proxy.js';
import {
  normalizeProxyOperation,
  normalizeProxyRequest,
  normalizeProxySelection,
} from '../runtime/proxy-contract.js';
import { validateCapabilityManifest } from '../runtime/index.js';

test.describe('optional proxy capability', () => {
  test('defaults each run to virtual mode without an adapter', () => {
    const selection = normalizeProxySelection({ runId: 'run-1' });

    expect(selection).toMatchObject({
      runId: 'run-1',
      mode: 'virtual',
      enabled: false,
      adapter: null,
      capabilityGranted: false,
    });
  });

  test('preserves a granted proxy when the capability manifest is canonicalized twice', () => {
    const manifest = {
      vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
      workers: { entryModules: ['*'], maxChildren: 1 },
      ipc: { enabled: true },
      signals: { allowed: ['SIGTERM'] },
      output: {},
      envVars: { allowed: [] },
      proxy: { mode: 'proxy', enabled: true, capability: true },
    };
    const first = validateCapabilityManifest(manifest);
    const second = validateCapabilityManifest(first);
    expect(first.proxy.capabilityGranted).toBe(true);
    expect(second.proxy.capabilityGranted).toBe(true);
  });

  test('accepts an adapter or callback without requiring one in virtual mode', () => {
    const adapter = () => ({ status: 200 });
    const selection = normalizeProxySelection({ adapter, runId: 'run-2' });
    const callbackSelection = normalizeProxySelection(adapter, { capability: { proxy: true } });

    expect(selection.mode).toBe('virtual');
    expect(selection.adapter).toBe(adapter);
    expect(callbackSelection).toMatchObject({ mode: 'proxy', adapter, capabilityGranted: true });
    expect(() => normalizeProxySelection({ mode: 'proxy', runId: 'run-3' })).not.toThrow();
  });

  test('requires both explicit opt-in and the proxy capability grant', async () => {
    const adapter = async () => ({ status: 204 });
    const notOptedIn = createProxyCapability({ adapter, capability: { proxy: true } });
    await expect(notOptedIn.request({ url: 'https://example.test' }))
      .rejects.toMatchObject({ code: 'ERR_PROXY_NOT_OPTED_IN' });

    const notGranted = createProxyCapability({ mode: 'proxy', adapter });
    await expect(notGranted.request({ url: 'https://example.test' }))
      .rejects.toMatchObject({ code: 'ERR_CAPABILITY_DENIED' });
  });

  test('routes only explicitly enabled operation calls to the adapter', async () => {
    const calls = [];
    const capability = createProxyCapability({
      mode: 'proxy',
      runId: 'run-4',
      capability: { proxy: true },
      adapter: async (request) => {
        calls.push(request);
        return { status: 200, headers: { 'x-test': 'yes' } };
      },
    });

    await expect(capability.request({ url: 'https://example.test', method: 'GET' }))
      .resolves.toMatchObject({ status: 200, statusCode: 200, headers: { 'x-test': 'yes' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: 'request', runId: 'run-4', target: 'https://example.test' });
  });

  test('supports operation methods needed by future network and TLS modules', async () => {
    const operations = [];
    const capability = createProxyCapability({
      mode: 'proxy',
      capability: { proxy: true },
      adapter: {
        connect(request) { operations.push(request.operation); return { connected: true }; },
        resolve(request) { operations.push(request.operation); return { address: '192.0.2.1' }; },
        tls(request) { operations.push(request.operation); return { authorized: true }; },
      },
    });

    await capability.connect({ target: 'example.test:443' });
    await capability.resolve({ hostname: 'example.test' });
    await capability.tls({ target: 'example.test:443' });
    expect(operations).toEqual(['connect', 'resolve', 'tls']);
  });

  test('normalizes adapter errors to Node-like codes and preserves network fields', () => {
    const source = Object.assign(new Error('connection refused'), {
      code: 'econnrefused',
      hostname: 'example.test',
      port: 443,
    });
    const error = normalizeProxyError(source, { operation: 'connect', target: 'example.test:443' });

    expect(error).toMatchObject({
      code: 'ECONNREFUSED',
      errno: 'ECONNREFUSED',
      hostname: 'example.test',
      port: 443,
    });
    expect(error.details).toMatchObject({ operation: 'connect', target: 'example.test:443' });
  });

  test('turns error-shaped results into normalized errors', () => {
    expect(() => normalizeProxyResult({ ok: false, error: { code: 'timeout', message: 'slow proxy' } }, {
      operation: 'request',
    })).toThrow(expect.objectContaining({ code: 'ETIMEDOUT' }));
  });

  test('rejects malformed selections and unsupported operation requests', () => {
    expect(() => normalizeProxySelection({ mode: 'host' }))
      .toThrow(expect.objectContaining({ code: 'ERR_INVALID_PROXY_MODE' }));
    expect(() => normalizeProxySelection({ adapter: {} }))
      .toThrow(expect.objectContaining({ code: 'ERR_INVALID_PROXY_ADAPTER' }));
    expect(() => normalizeProxyOperation('udp'))
      .toThrow(expect.objectContaining({ code: 'ERR_INVALID_PROXY_OPERATION' }));
    expect(() => normalizeProxyRequest('request', 'https://example.test'))
      .toThrow(expect.objectContaining({ code: 'ERR_INVALID_PROXY_REQUEST' }));
  });

  test('reports missing operation handlers and normalizes callback failures', async () => {
    const missing = createProxyCapability({ mode: 'proxy', capability: true });
    await expect(missing.request({ url: 'https://example.test' }))
      .rejects.toMatchObject({ code: 'ERR_PROXY_ADAPTER_MISSING' });

    const partial = createProxyCapability({
      mode: 'proxy',
      capability: { allowed: ['proxy'] },
      adapter: { request: () => ({ status: 200 }) },
    });
    await expect(partial.connect({ target: 'example.test:443' }))
      .rejects.toMatchObject({ code: 'ERR_PROXY_ADAPTER_INVALID' });

    const aborting = createProxyCapability({
      mode: 'proxy',
      capability: ['proxy'],
      adapter: () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
    });
    await expect(aborting.request({ url: 'https://example.test' }))
      .rejects.toMatchObject({ code: 'ABORT_ERR' });
  });

  test('normalizes successful response aliases without changing primitive results', () => {
    expect(normalizeProxyResult({ status: 201, code: 'econnreset' }))
      .toMatchObject({ status: 201, statusCode: 201, code: 'ECONNRESET' });
    expect(normalizeProxyResult('adapter-value')).toBe('adapter-value');
  });

  test('preserves a browser Response returned by an adapter', async () => {
    const response = new Response('proxied response', {
      status: 203,
      headers: { 'x-proxy': 'response' },
    });
    const capability = createProxyCapability({
      mode: 'proxy',
      enabled: true,
      capability: { proxy: true },
      adapter: () => response,
    });

    await expect(capability.request({ url: 'https://example.test' })).resolves.toBe(response);
  });

  test('does not treat an HTTP error response as an adapter error', async () => {
    const response = new Response('upstream failure', { status: 503 });
    const capability = createProxyCapability({
      mode: 'proxy',
      enabled: true,
      capability: { proxy: true },
      adapter: () => response,
    });

    await expect(capability.request({ url: 'https://example.test' })).resolves.toBe(response);
  });

  test('does not import or perform host I/O', async () => {
    let invoked = false;
    const virtual = createProxyCapability({
      mode: 'virtual',
      capability: { proxy: true },
      adapter: () => { invoked = true; },
    });

    await expect(callProxy(virtual, 'request', { url: 'https://example.test' }))
      .rejects.toMatchObject({ code: 'ERR_PROXY_NOT_OPTED_IN' });
    expect(invoked).toBe(false);
  });
});
