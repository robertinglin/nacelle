import { expect } from 'playwright/test';
import { expectPass, test } from './harness-test-helpers.mjs';

test('forwards a raw CONNECT tunnel and preserves the initial head bytes', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (() => {
      const assert = require('node:assert');
      const http = require('node:http');
      const net = require('node:net');
      const target = http.createServer((request, response) => response.end('through-tunnel'));
      const proxy = http.createServer();
      let observedHead = '';
      proxy.on('connect', (request, socket, head) => {
        assert.strictEqual(request.method, 'CONNECT');
        observedHead = head.toString();
        socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
        const upstream = net.createConnection(target.address().port, '127.0.0.1');
        socket.once('close', () => upstream.destroy());
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });

      target.listen(0, '127.0.0.1', () => proxy.listen(0, '127.0.0.1', () => {
        const client = net.createConnection(proxy.address().port, '127.0.0.1');
        let response = '';
        client.setEncoding('utf8');
        client.once('connect', () => {
          const port = target.address().port;
          client.write(
            'CONNECT target.test:' + port + ' HTTP/1.1\\r\\n'
              + 'Host: target.test:' + port + '\\r\\n\\r\\n'
              + 'GET /via-head HTTP/1.1\\r\\nHost: target.test\\r\\nConnection: close\\r\\n\\r\\n',
          );
        });
        client.on('data', (chunk) => {
          response += chunk;
          if (response.includes('through-tunnel')) client.destroy();
        });
        client.on('close', () => {
          proxy.close(() => target.close(() => process.stdout.write(JSON.stringify({
            response,
            observedHead,
          }))));
        });
      }));
    })();
  `, { timeoutMs: 10_000 });

  await expectPass(expect, result);
  const output = JSON.parse(result.stdout);
  expect(output.observedHead).toContain('GET /via-head HTTP/1.1');
  expect(output.response).toContain('HTTP/1.1 200 Connection Established');
  expect(output.response).toContain('through-tunnel');
});
