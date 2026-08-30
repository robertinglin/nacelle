import { expect, test } from 'playwright/test';
import { createRuntime } from '../runtime.js';

const capabilities = {
  vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
  workers: { entryModules: ['*'], maxChildren: 2 },
  ipc: { enabled: true },
  signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
  output: { maxBytes: 4096, stdoutBytes: 4096, stderrBytes: 4096 },
  envVars: { allowed: [] },
};

function runSource(source) {
  const runtime = createRuntime();
  const stdout = [];
  const stderr = [];
  return runtime.reset({ runId: 'runtime-network-integration', capabilities })
    .then(() => runtime.mount({ '/node/network.js': source }))
    .then(() => runtime.executeEntry('/node/network.js', {}, (value) => stdout.push(value), (value) => stderr.push(value)))
    .then((code) => ({ code, stdout: stdout.join(''), stderr: stderr.join('') }));
}

test.describe('runtime builtin network integration', () => {
  test('uses virtual TCP and UDP modules by default', async () => {
    const result = await runSource(`
      (async () => {
      const assert = require('node:assert');
      const net = require('node:net');
      const dgram = require('node:dgram');
      assert.strictEqual(net.isIP('127.0.0.1'), 4);
      const server = net.createServer((socket) => socket.end('tcp-ok'));
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43301, '127.0.0.1', resolve); });
      const client = net.createConnection({ port: 43301, host: 'localhost' });
      const received = await new Promise((resolve, reject) => {
        client.once('error', reject);
        client.on('data', (chunk) => resolve(chunk.toString()));
      });
      assert.strictEqual(received, 'tcp-ok');
      client.destroy();
      await new Promise((resolve) => server.close(resolve));

      const receiver = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => { receiver.once('error', reject); receiver.bind(43302, '127.0.0.1', resolve); });
      const message = new Promise((resolve) => receiver.once('message', (chunk) => resolve(chunk.toString())));
      const sender = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => sender.send('udp-ok', 43302, '127.0.0.1', (error) => error ? reject(error) : resolve()));
      assert.strictEqual(await message, 'udp-ok');
      sender.close();
      receiver.close();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    expect(result.code, result.stderr).toBe(0);
  });

  test('keeps proxy mode opt-in and does not require an adapter in virtual mode', async () => {
    const result = await runSource(`
      (async () => {
      const assert = require('node:assert');
      const dns = require('node:dns');
      assert.deepStrictEqual(await dns.promises.lookup('localhost'), { address: '127.0.0.1', family: 4 });
      assert.strictEqual(require('node:net').isIPv6('::1'), true);
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    expect(result.code, result.stderr).toBe(0);
  });

  test('routes Node-shaped HTTP requests through the runtime virtual server', async () => {
    const result = await runSource(`
      (async () => {
      const assert = require('node:assert');
      const http = require('node:http');
      const server = http.Server((request, response) => {
        assert.strictEqual(request.url, '/runtime-http');
        response.end('runtime-http-ok');
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43303, '127.0.0.1', resolve); });
      const response = await new Promise((resolve, reject) => {
        const request = http.get({ port: 43303, host: 'localhost', path: '/runtime-http' }, resolve);
        request.once('error', reject);
      });
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      await new Promise((resolve, reject) => { response.once('end', resolve); response.once('error', reject); });
      assert.strictEqual(body, 'runtime-http-ok');
      await new Promise((resolve) => server.close(resolve));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    expect(result.code, result.stderr).toBe(0);
  });

  test('exposes HTTP servers through the virtual TCP socket path', async () => {
    const result = await runSource(`
      (async () => {
      const assert = require('node:assert');
      const http = require('node:http');
      const net = require('node:net');
      let requests = 0;
      const server = http.createServer((request, response) => {
        requests += 1;
        response.end(request.url);
        if (requests === 2) server.close();
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43304, '127.0.0.1', resolve); });
      const client = net.createConnection({ port: 43304, host: 'localhost' });
      let output = '';
      client.setEncoding('utf8');
      client.on('data', (chunk) => { output += chunk; });
      await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
      client.write('GET /one HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\nGET /two HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n');
      client.end();
      await new Promise((resolve, reject) => { client.once('close', resolve); client.once('error', reject); });
      assert.strictEqual(requests, 2);
      assert.match(output, /\\/one/);
      assert.match(output, /\\/two/);
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    expect(result.code, result.stderr).toBe(0);
  });

  test('keeps pipelined HTTP connections alive until delayed responses finish', async () => {
    const result = await runSource(`
      (() => {
      const assert = require('node:assert');
      const net = require('node:net');
      const http = require('node:http');
      let requestNumber = 0;
      let requestsSent = 0;
      let responseText = '';
      let clientGotEof = false;
      const server = http.createServer((request, response) => {
        requestNumber += 1;
        setTimeout(() => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write(request.url); response.end(); }, 1);
        if (requestNumber === 4) server.close();
      });
      server.listen(43305);
      server.on('listening', () => {
        const client = net.createConnection(server.address().port);
        client.setEncoding('utf8');
        client.on('connect', () => {
          client.write('GET /one HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n');
          requestsSent += 1;
        });
        client.on('data', (chunk) => {
          responseText += chunk;
          if (requestsSent === 1) {
            client.write('POST /two HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n');
            requestsSent += 1;
          }
          if (requestsSent === 2) {
          client.write('GET /three HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\nGET /four HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n');
          client.end();
          assert.strictEqual(client.readyState, 'readOnly');
          requestsSent += 2;
          }
        });
        client.on('end', () => { clientGotEof = true; });
        client.on('close', () => {
          assert.strictEqual(requestNumber, 4);
          assert.strictEqual(requestsSent, 4);
          assert.strictEqual(clientGotEof, true);
          assert.match(responseText, /\\/one/);
          assert.match(responseText, /\\/four/);
        });
      });
      process.on('exit', () => {
        assert.strictEqual(requestNumber, 4);
        assert.strictEqual(requestsSent, 4);
        assert.strictEqual(clientGotEof, true);
        assert.strictEqual(server.close(), server);
      });
      })();
    `);
    expect(result.code, result.stderr).toBe(0);
  });

});
