import { expect, test } from 'playwright/test';
import {
  checkServerIdentity,
  createTlsContract,
} from '../runtime/tls.js';
import {
  constants as http2Constants,
  createHttp2Contract,
} from '../runtime/http2.js';

function waitFor(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args));
    emitter.once('error', reject);
  });
}

function collect(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.once('end', () => resolve(new TextDecoder().decode(new Uint8Array(chunks.flatMap((item) => [...item])))));
    readable.once('error', reject);
    readable.on('data', (chunk) => chunks.push(chunk));
  });
}

test.describe('browser-native virtual TLS and HTTP/2 contracts', () => {
  test('provides deterministic TLS metadata and Node-shaped certificate checks', async () => {
    const tls = createTlsContract();
    const socket = tls.connect({ host: 'api.example.test', port: 443, ALPNProtocols: ['h2'] });
    await waitFor(socket, 'secureConnect');

    expect(socket.authorized).toBe(true);
    expect(socket.encrypted).toBe(true);
    expect(socket.alpnProtocol).toBe('h2');
    expect(socket.getCipher()).toMatchObject({ name: 'TLS_AES_128_GCM_SHA256', version: 'TLSv1.3' });
    expect(socket.getPeerCertificate()).toMatchObject({ subject: { CN: 'api.example.test' } });
    expect(tls.getCiphers()).toEqual([
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
    ]);

    expect(checkServerIdentity('a.example.test', { subjectaltname: 'DNS:*.example.test' })).toBeUndefined();
    expect(checkServerIdentity('a.b.example.test', { subjectaltname: 'DNS:*.example.test' })).toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    expect(() => tls.createSecureContext(null)).toThrow(TypeError);
  });

  test('keeps TLS certificate and abort failures observable', async () => {
    const tls = createTlsContract();
    const mismatch = tls.connect({
      host: 'service.example.test',
      peerCertificate: { subjectaltname: 'DNS:other.example.test' },
    });
    const [mismatchError] = await waitFor(mismatch, 'error');
    expect(mismatchError).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const aborted = tls.connect({ host: 'service.example.test', signal: controller.signal });
    const [abortError] = await waitFor(aborted, 'error');
    expect(abortError.message).toBe('cancelled');
  });

  test('runs a virtual TLS server over the in-memory TCP network', async () => {
    const tls = createTlsContract();
    const server = tls.createServer({ cert: 'server-cert', key: 'server-key' });
    const secureConnection = waitFor(server, 'secureConnection');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const client = tls.connect({
      host: '127.0.0.1',
      port: server.address().port,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });
    await Promise.all([waitFor(client, 'secureConnect'), secureConnection]);
    expect(client.getPeerCertificate()).toMatchObject({ subject: { CN: 'agent10.example.com' } });
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  test('reports a missing client certificate through virtual TLS errors', async () => {
    const tls = createTlsContract();
    const server = tls.createServer({ cert: 'server-cert', key: 'server-key', requestCert: true });
    const serverError = waitFor(server, 'tlsClientError');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const client = tls.connect({
      host: '127.0.0.1',
      port: server.address().port,
      checkServerIdentity: () => undefined,
    });
    const [clientError] = await waitFor(client, 'error');
    const [reportedError] = await serverError;
    expect(clientError).toMatchObject({ code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED' });
    expect(reportedError).toMatchObject({ code: 'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE' });
    await new Promise((resolve) => server.close(resolve));
  });

  test('only invokes an explicitly enabled and granted TLS proxy', async () => {
    const calls = [];
    const tls = createTlsContract({
      proxy: {
        mode: 'proxy',
        capability: { proxy: true },
        adapter: { tls(request) { calls.push(request); return { authorized: true, alpnProtocol: 'h2' }; } },
      },
    });
    const socket = tls.connect({ host: 'proxy.example.test', port: 443 });
    await waitFor(socket, 'secureConnect');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: 'tls', target: 'proxy.example.test:443' });

    const denied = createTlsContract({ proxy: { mode: 'proxy', adapter: { tls() { return {}; } } } }).connect({ host: 'denied.example.test' });
    const [error] = await waitFor(denied, 'error');
    expect(error).toMatchObject({ code: 'ERR_CAPABILITY_DENIED' });
  });

  test('creates a virtual HTTP/2 session with deterministic fallback responses', async () => {
    const http2 = createHttp2Contract();
    const session = http2.connect('https://unserved.example.test:443');
    await waitFor(session, 'connect');
    const request = session.request({ ':method': 'GET', ':path': '/virtual' });
    request.end();
    const [headers] = await waitFor(request, 'response');
    expect(headers).toEqual({ ':status': 200, 'x-bnh-virtual': '1' });
    await expect(collect(request)).resolves.toBe('');
    expect(session.remoteSettings.maxFrameSize).toBe(http2Constants.DEFAULT_SETTINGS_MAX_FRAME_SIZE);
    await new Promise((resolve, reject) => session.ping(new Uint8Array(8), (error, duration, payload) => {
      if (error) reject(error);
      else {
        expect(duration).toBe(0);
        expect(payload.byteLength).toBe(8);
        resolve();
      }
    }));
    expect(() => session.ping(new Uint8Array(7), () => {})).toThrow(/exactly 8 bytes/);
    session.close();
  });

  test('routes HTTP/2 streams through a virtual server and preserves request bodies', async () => {
    const http2 = createHttp2Contract();
    const server = http2.createSecureServer((stream, headers) => {
      expect(headers[':path']).toBe('/echo');
      stream.respond({ ':status': 201, 'content-type': 'text/plain' });
      stream.end('browser h2');
    });
    await new Promise((resolve) => server.listen({ host: 'virtual.test', port: 0 }, resolve));
    const session = http2.connect(`https://virtual.test:${server.address().port}`);
    await waitFor(session, 'connect');
    const request = session.request({ ':method': 'POST', ':path': '/echo' });
    request.end('request body');
    const [headers] = await waitFor(request, 'response');
    expect(headers).toMatchObject({ ':status': 201, 'content-type': 'text/plain' });
    await expect(collect(request)).resolves.toBe('browser h2');
    session.close();
    await new Promise((resolve) => server.close(resolve));
  });

  test('rejects invalid HTTP/2 headers and closed-session requests', async () => {
    const http2 = createHttp2Contract();
    const session = http2.connect('https://edge.example.test');
    expect(() => session.request({ Connection: 'keep-alive' })).toThrow(expect.objectContaining({
      code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS',
    }));
    session.close();
    expect(() => session.request({ ':method': 'GET' })).toThrow(expect.objectContaining({
      code: 'ERR_HTTP2_INVALID_SESSION',
    }));
  });
});
