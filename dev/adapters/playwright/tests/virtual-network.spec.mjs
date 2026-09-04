import { expect, test } from 'playwright/test';
import { createBrowserDns } from '../runtime/dns.js';
import { createBrowserDgram } from '../runtime/dgram.js';
import * as net from '../runtime/net.js';
import { createVirtualNetwork } from '../runtime/virtual-network.js';
import { createProxyCapability } from '../runtime/proxy.js';

function waitFor(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args));
    emitter.once('error', reject);
  });
}

function text(bytes) {
  return new TextDecoder().decode(bytes);
}

test.describe('browser-native virtual networking', () => {
  test('provides deterministic asynchronous DNS and Node IP helpers', async () => {
    const dns = createBrowserDns({ records: { service: '127.0.0.1' } });
    let callbackRan = false;
    const lookup = new Promise((resolve, reject) => dns.lookup('service', (error, address, family) => {
      callbackRan = true;
      if (error) reject(error);
      else resolve({ address, family });
    }));
    expect(callbackRan).toBe(false);
    await expect(lookup).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    await expect(dns.promises.lookup('missing')).rejects.toMatchObject({ code: 'ENOTFOUND', hostname: 'missing' });
    expect(await dns.promises.resolve4('localhost')).toEqual(['127.0.0.1']);
    expect(net.isIP('127.0.0.1')).toBe(4);
    expect(net.isIP('::1')).toBe(6);
    expect(net.isIP('not-an-ip')).toBe(0);
    expect(net.isIPv4('127.0.0.1')).toBe(true);
    expect(net.isIPv6('::1')).toBe(true);
  });

  test('routes TCP sockets through an in-memory loopback server', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(43201, '127.0.0.1', resolve);
    });
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port: 43201, family: 'IPv4' });

    const client = net.createConnection({ port: 43201, host: 'localhost' });
    await waitFor(client, 'connect');
    const response = new Promise((resolve) => client.once('data', (chunk) => resolve(text(chunk))));
    client.write('browser tcp');
    await expect(response).resolves.toBe('browser tcp');
    expect(client.remoteAddress).toBe('127.0.0.1');
    expect(client.remotePort).toBe(43201);
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  test('reports EADDRINUSE, ECONNREFUSED, and ENOTFOUND asynchronously', async () => {
    const first = net.createServer();
    await new Promise((resolve, reject) => {
      first.once('error', reject);
      first.listen(43202, '127.0.0.1', resolve);
    });

    const second = net.createServer();
    const addressInUse = new Promise((resolve) => second.once('error', resolve));
    second.listen(43202, '127.0.0.1');
    await expect(addressInUse).resolves.toMatchObject({ code: 'EADDRINUSE', syscall: 'bind' });
    await new Promise((resolve) => first.close(resolve));

    const refused = net.createConnection(43203, '127.0.0.1');
    await expect(waitFor(refused, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED', syscall: 'connect' });
    const unresolved = net.createConnection(43203, 'not-in-dns');
    await expect(waitFor(unresolved, 'connect')).rejects.toMatchObject({ code: 'ENOTFOUND', syscall: 'getaddrinfo' });
  });

  test('shares cluster listeners without collapsing IPv6-only and IPv4 bindings', () => {
    const network = createVirtualNetwork();
    const firstWorker = { _networkClosed() {} };
    const secondWorker = { _networkClosed() {} };
    expect(network.bindTcp(firstWorker, '::', 43206, {
      clusterGroupId: 'cluster-contract',
      ipv6Only: true,
    })).toEqual({ address: '::', port: 43206 });
    expect(network.bindTcp(secondWorker, '::', 0, {
      clusterGroupId: 'cluster-contract',
      ipv6Only: true,
    })).toEqual({ address: '::', port: 43206 });
    expect(network.bindTcp({}, '0.0.0.0', 43206)).toEqual({ address: '0.0.0.0', port: 43206 });

    const dualStack = createVirtualNetwork();
    dualStack.bindTcp({}, '::', 43207);
    expect(() => dualStack.bindTcp({}, '0.0.0.0', 43207)).toThrow(/EADDRINUSE/);
  });

  test('shares UDP bindings only within one virtual cluster', () => {
    const network = createVirtualNetwork();
    const firstWorker = {};
    const secondWorker = {};
    expect(network.bindUdp(firstWorker, '0.0.0.0', 43208, { clusterGroupId: 'udp-cluster' })).toEqual({
      address: '0.0.0.0',
      port: 43208,
    });
    expect(network.bindUdp(secondWorker, '0.0.0.0', 0, { clusterGroupId: 'udp-cluster' })).toEqual({
      address: '0.0.0.0',
      port: 43208,
    });
    expect(() => network.bindUdp({}, '0.0.0.0', 43208)).toThrow(/EADDRINUSE/);
  });

  test('uses the virtual socket registry for UDP send and receive', async () => {
    const network = createVirtualNetwork();
    const dgram = createBrowserDgram({ network });
    const receiver = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      receiver.once('error', reject);
      receiver.bind(43204, '127.0.0.1', resolve);
    });
    const sender = dgram.createSocket('udp4');
    const message = new Promise((resolve) => receiver.once('message', (bytes, info) => resolve({ text: text(bytes), info })));
    await new Promise((resolve, reject) => sender.send('browser udp', 43204, '127.0.0.1', (error, bytes) => error ? reject(error) : resolve(bytes)));
    const result = await message;
    expect(result.text).toBe('browser udp');
    expect(result.info.port).toBe(51000);
    expect(result.info.address).toBe('127.0.0.1');
    sender.close();
    receiver.close();
  });

  test('accepts an optional transport hook without requiring one', async () => {
    let connectCalls = 0;
    const browserNet = net.createBrowserNet({
      transport: { connect() { connectCalls += 1; return false; } },
    });
    const server = browserNet.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(43205, '127.0.0.1', resolve);
    });
    const client = browserNet.createConnection(43205, '127.0.0.1');
    await waitFor(client, 'connect');
    expect(connectCalls).toBe(1);
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  test('accepts inbound connections from an explicit network transport', async () => {
    let accepted;
    const writes = [];
    const network = createVirtualNetwork({
      transport: {
        bindTcp(request) {
          queueMicrotask(() => {
            const peer = {
              destroyed: false,
              _runTcpResource(callback) { return callback(); },
              _peerClosed() { this.destroyed = true; },
              push(bytes) {
                if (bytes === null) return true;
                writes.push(text(bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes)));
                return true;
              },
              destroy() { this.destroyed = true; },
            };
            accepted = request.onConnection({
              client: peer,
              localAddress: '127.0.0.1',
              localPort: 54000,
              remoteAddress: request.address,
              remotePort: request.port,
            });
          });
          return { close() {} };
        },
        unbindTcp() {},
      },
    });
    const browserNet = net.createBrowserNet({ network });
    const server = browserNet.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(`echo:${text(chunk)}`));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(43209, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(accepted).toBeTruthy();
    accepted.push(new TextEncoder().encode('inbound'));
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(writes).toEqual(['echo:inbound']);
    accepted.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  test('uses an explicitly granted proxy only for names outside the virtual DNS table', async () => {
    const calls = [];
    const proxy = createProxyCapability({
      mode: 'proxy',
      enabled: true,
      capability: { proxy: true },
      adapter: {
        resolve(request) {
          calls.push(request.hostname);
          return { address: '198.51.100.7', family: 4 };
        },
      },
    });
    const dns = createBrowserDns({ proxy });
    await expect(dns.promises.lookup('service.example')).resolves.toEqual({ address: '198.51.100.7', family: 4 });
    await expect(dns.promises.lookup('localhost')).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    expect(calls).toEqual(['service.example']);
  });
});
