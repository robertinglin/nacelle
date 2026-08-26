import { expect } from 'playwright/test';
import { expectPass, test } from './harness-test-helpers.mjs';

test('spawned browser processes keep virtual HTTP servers alive through pipelined responses', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (() => {
    const assert = require('node:assert');
    const http = require('node:http');
    const net = require('node:net');
    let requestNumber = 0;
    let requestsSent = 0;
    let responseText = '';
    let clientGotEof = false;
    const server = http.createServer(function(request, response) {
      requestNumber += 1;
      if (requestNumber === 4) this.close();
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write(request.url);
        response.end();
      }, 1);
    });
    server.listen(0);
    server.httpAllowHalfOpen = true;
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
  `, { timeoutMs: 10_000 });
  await expectPass(expect, result);
});
