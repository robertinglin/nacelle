import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

function commonjsSource(label, body) {
  return `
    (async () => {
      ${body}
    })().catch((error) => {
      console.error('http-compat: ${label}', error?.stack || error);
      process.exitCode = 1;
    });
  `;
}

async function runContract(expectObject, harnessPage, label, body) {
  const result = await harnessPage.run(commonjsSource(label, body));
  await expectPass(expectObject, result);
  return result;
}

test.describe('browser-native http compatibility', () => {
  test('keeps data payload bytes stable when URL query parameters change', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'data-url-query', `
      const assert = require('node:assert');
      const url = new URL('data:text/plain,bnh%20network');
      url.searchParams.set('mode', 'browser');
      const response = await fetch(url);
      assert.strictEqual(await response.text(), 'bnh network');
    `);
  });

  test('supports request/get lifecycle, response metadata, readable bodies, and async iteration', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'request/get', `
      const assert = require('node:assert');
      const http = require('node:http');

      const lifecycle = [];
      const requested = await new Promise((resolve, reject) => {
        const request = http.request('data:text/plain,browser%20http', (response) => {
          lifecycle.push('response');
          assert.strictEqual(response.statusCode, 200);
          assert.strictEqual(response.headers['content-type'], 'text/plain');
          (async () => {
            const chunks = [];
            for await (const chunk of response) chunks.push(chunk.toString('utf8'));
            resolve(chunks.join(''));
          })().catch(reject);
        });
        request.once('finish', () => lifecycle.push('finish'));
        request.once('close', () => lifecycle.push('close'));
        request.once('error', reject);
        request.end();
      });
      assert.strictEqual(requested, 'browser http');
      assert.ok(lifecycle.includes('finish'));
      assert.ok(lifecycle.includes('response'));
      assert.ok(lifecycle.includes('close'));

      const fetched = await new Promise((resolve, reject) => {
        http.get({
          href: 'data:text/plain,browser%20get',
          headers: { 'X-BNH-Request': 'present' },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.once('end', () => resolve(body));
          response.once('error', reject);
        }).once('error', reject);
      });
      assert.strictEqual(fetched, 'browser get');
    `);
  });

  test('flushes implicit headers before a final body on raw net sockets', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'raw-net-http-end', `
      const assert = require('node:assert');
      const http = require('node:http');
      const net = require('node:net');

      const server = http.createServer((_request, response) => response.end('raw-body'));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const wire = await new Promise((resolve, reject) => {
          const socket = net.connect(server.address().port, '127.0.0.1');
          let output = '';
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => { output += chunk; });
          socket.once('connect', () => socket.end(
            'GET /raw HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n',
          ));
          socket.once('error', reject);
          socket.once('close', () => resolve(output));
        });
        assert.match(wire, /^HTTP\\/1\\.1 200 /);
        assert.match(wire, /\\r\\n\\r\\n(?:raw-body|8\\r\\nraw-body\\r\\n0\\r\\n\\r\\n)$/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('keeps pipelined raw HTTP requests on a reusable connection', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'raw-net-http-keep-alive', `
      const assert = require('node:assert');
      const http = require('node:http');
      const net = require('node:net');

      let requests = 0;
      const server = http.createServer((_request, response) => {
        requests += 1;
        response.end('response-' + requests);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const wire = await new Promise((resolve, reject) => {
          const socket = net.connect(server.address().port, '127.0.0.1');
          let output = '';
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => { output += chunk; });
          socket.once('connect', () => {
            socket.write('GET /one HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n');
            socket.write('GET /two HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n');
          });
          socket.once('error', reject);
          socket.once('close', () => resolve(output));
        });
        assert.strictEqual(requests, 2);
        assert.strictEqual((wire.match(/HTTP\\/1\\.1 200 OK/g) || []).length, 2);
        assert.ok(wire.includes('response-1'));
        assert.ok(wire.includes('response-2'));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('routes IPv6 loopback fetches to the virtual HTTP server', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'ipv6-loopback-http', `
      const assert = require('node:assert');
      const http = require('node:http');

      const server = http.createServer((_request, response) => response.end('ipv6-ok'));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '::1', resolve);
      });

      try {
        const response = await fetch('http://[::1]:' + server.address().port + '/');
        assert.strictEqual(response.status, 200);
        assert.strictEqual(await response.text(), 'ipv6-ok');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('uses Node socket port errors for invalid HTTP listen ports', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'invalid-http-listen-port', `
      const assert = require('node:assert');
      const http = require('node:http');

      for (const port of ['hello-world', '1234hello']) {
        const server = http.createServer();
        assert.throws(() => server.listen({ port }), (error) => error.code === 'ERR_SOCKET_BAD_PORT');
      }
    `);
  });

  test('rejects a missing HTTP/1.1 Host header before dispatching the request', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'raw-net-http-host', `
      const assert = require('node:assert');
      const http = require('node:http');
      const net = require('node:net');

      const server = http.createServer(() => {
        assert.fail('a request without Host must not reach the handler');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const wire = await new Promise((resolve, reject) => {
          const socket = net.connect(server.address().port, '127.0.0.1');
          let output = '';
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => { output += chunk; });
          socket.once('connect', () => socket.end('GET / HTTP/1.1\\r\\nConnection: close\\r\\n\\r\\n'));
          socket.once('error', reject);
          socket.once('close', () => resolve(output));
        });
        assert.match(wire, /^HTTP\\/1\\.1 400 Bad Request/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('preserves numeric fetch status and streamed response bodies', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'fetch/stream-status', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { Readable } = require('node:stream');

      const server = http.createServer((_request, response) => {
        const source = new Readable({ read() {} });
        response.setHeader('content-type', 'application/json');
        source.pipe(response);
        source.push('[{"hello":"world"}');
        source.push(',{"a":42}]');
        source.push(null);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const response = await fetch('http://localhost:' + server.address().port);
        assert.strictEqual(typeof response.status, 'number');
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.ok, true);
        assert.strictEqual(response.headers.get('content-type'), 'application/json');
        assert.deepStrictEqual(JSON.parse(await response.text()), [
          { hello: 'world' },
          { a: 42 },
        ]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('preserves status when a piped stream writes after the route returns', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'fetch/async-stream-status', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { PassThrough } = require('node:stream');

      const server = http.createServer((_request, response) => {
        const source = new PassThrough();
        response.setHeader('content-type', 'application/json');
        source.pipe(response);
        setImmediate(() => {
          source.write('[{"hello":"world"}]');
          source.end(',{"a":42}]');
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const response = await fetch('http://localhost:' + server.address().port);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'application/json');
        assert.strictEqual(await response.text(), '[{"hello":"world"}],{"a":42}]');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('destroys the response socket before starting a replacement request', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'request-destroy-reconnect', `
      const assert = require('node:assert');
      const http = require('node:http');

      let requests = 0;
      const server = http.createServer((_request, response) => {
        requests += 1;
        response.setHeader('transfer-encoding', 'chunked');
        response.write('first');
        if (requests === 1) {
          setTimeout(() => {
            if (!response.destroyed) response.end('late');
          }, 25);
        } else {
          response.end('second');
        }
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        await new Promise((resolve, reject) => {
          const request = http.get('http://localhost:' + server.address().port, (response) => {
            response.once('error', () => {});
            response.once('data', () => {
              request.destroy();
              resolve();
            });
          });
          request.once('error', reject);
        });
        const body = await new Promise((resolve, reject) => {
          const request = http.get('http://localhost:' + server.address().port, (response) => {
            let output = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { output += chunk; });
            response.once('end', () => resolve(output));
            response.once('error', reject);
          });
          request.once('error', reject);
        });
        assert.strictEqual(requests, 2);
        assert.strictEqual(body, 'firstsecond');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('preserves status for an object-mode transform piped as a response', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'fetch/object-mode-transform-status', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { Transform } = require('node:stream');

      const server = http.createServer((_request, response) => {
        const payload = new Transform({
          writableObjectMode: true,
          transform(value, _encoding, callback) {
            callback(null, JSON.stringify(value));
          },
        });
        response.setHeader('content-type', 'application/json');
        payload.write({ hello: 'world' });
        payload.end({ a: 42 });
        payload.pipe(response);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const response = await fetch('http://localhost:' + server.address().port);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'application/json');
        assert.strictEqual(await response.text(), '{"hello":"world"}{"a":42}');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('preserves status for a buffered legacy stream piped as a response', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'fetch/legacy-stream-status', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { Stream } = require('node:stream');

      const server = http.createServer((_request, response) => {
        const source = new Stream();
        let writableEnded = false;
        let readableEnded = false;
        let destroyed = false;
        source.readable = true;
        source.writable = true;
        source.paused = false;
        source.autoDestroy = true;
        const buffer = [];
        const drain = () => {
          while (buffer.length && !source.paused) {
            const chunk = buffer.shift();
            if (chunk === null) source.emit('end');
            else source.emit('data', chunk);
          }
        };
        source.queue = (chunk) => {
          if (readableEnded) return source;
          if (chunk === null) readableEnded = true;
          buffer.push(chunk);
          drain();
          return source;
        };
        source.write = (chunk) => {
          source.queue(chunk);
          return !source.paused;
        };
        source.end = (chunk) => {
          if (writableEnded) return source;
          writableEnded = true;
          if (chunk !== undefined) source.write(chunk);
          source.writable = false;
          source.queue(null);
          return source;
        };
        source.pause = () => { source.paused = true; return source; };
        source.resume = () => { source.paused = false; drain(); source.emit('drain'); return source; };
        source.destroy = () => {
          if (destroyed) return source;
          destroyed = true;
          source.readable = false;
          source.writable = false;
          source.emit('close');
          return source;
        };
        source.once('end', () => {
          source.readable = false;
          if (!source.writable && source.autoDestroy) queueMicrotask(() => source.destroy());
        });
        response.setHeader('content-type', 'application/json');
        source.pipe(response);
        source.write('[{"hello":"world"}]');
        source.end(',{"a":42}]');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const response = await fetch('http://localhost:' + server.address().port);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'application/json');
        assert.strictEqual(await response.text(), '[{"hello":"world"}],{"a":42}]');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('preserves status when finished observes a legacy stream send lifecycle', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'fetch/legacy-stream-finished-status', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { Stream, finished } = require('node:stream');

      const server = http.createServer((_request, response) => {
        const source = new Stream();
        let writableEnded = false;
        let readableEnded = false;
        let destroyed = false;
        source.readable = true;
        source.writable = true;
        source.paused = false;
        source.autoDestroy = true;
        const buffer = [];
        const drain = () => {
          while (buffer.length && !source.paused) {
            const chunk = buffer.shift();
            if (chunk === null) source.emit('end');
            else source.emit('data', chunk);
          }
        };
        source.queue = (chunk) => {
          if (readableEnded) return source;
          if (chunk === null) readableEnded = true;
          buffer.push(chunk);
          drain();
          return source;
        };
        source.write = (chunk) => { source.queue(chunk); return true; };
        source.end = (chunk) => {
          if (writableEnded) return source;
          writableEnded = true;
          if (chunk !== undefined) source.write(chunk);
          source.writable = false;
          source.queue(null);
          return source;
        };
        source.destroy = () => {
          if (destroyed) return source;
          destroyed = true;
          source.readable = false;
          source.writable = false;
          source.emit('close');
          return source;
        };
        source.once('end', () => {
          source.readable = false;
          if (!source.writable && source.autoDestroy) queueMicrotask(() => source.destroy());
        });

        finished(source, { readable: true, writable: false }, (error) => {
          if (error) response.destroy(error);
        });
        finished(response, (error) => {
          if (error && !response.headersSent) response.destroy(error);
        });
        response.setHeader('content-type', 'application/json');
        source.pipe(response);
        source.write('[{"hello":"world"}]');
        source.end(',{"a":42}]');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const response = await fetch('http://localhost:' + server.address().port);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get('content-type'), 'application/json');
        assert.strictEqual(await response.text(), '[{"hello":"world"}],{"a":42}]');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('propagates AbortSignal cancellation and exposes virtual server boundaries', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'abort/boundaries', `
      const assert = require('node:assert');
      const http = require('node:http');
      const https = require('node:https');

      const controller = new AbortController();
      controller.abort();
      const aborted = await new Promise((resolve) => {
        const request = http.get('data:text/plain,aborted', { signal: controller.signal });
        request.once('error', (error) => resolve(error));
      });
      assert.ok(aborted.name === 'AbortError' || aborted.code === 'ABORT_ERR');

      const server = http.createServer();
      assert.strictEqual(server.listening, false);
      assert.strictEqual(typeof server.listen, 'function');
      server.close();
      const agent = new https.Agent();
      assert.strictEqual(agent.protocol, 'https:');
      agent.destroy();
    `);
  });

  test('maps request timeout to abortable fetch cancellation', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'timeout', `
      const assert = require('node:assert');
      const http = require('node:http');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });

      try {
        const result = await new Promise((resolve, reject) => {
          const request = http.request('data:text/plain,delayed');
          let sawTimeout = false;
          request.setTimeout(5, () => { sawTimeout = true; });
          request.once('error', (error) => resolve({ error, sawTimeout }));
          request.once('close', () => {});
          request.end();
          setTimeout(() => reject(new Error('timeout contract did not finish')), 500);
        });
        assert.strictEqual(result.sawTimeout, true);
        assert.ok(result.error.name === 'TimeoutError' || result.error.code === 'ETIMEDOUT');
      } finally {
        globalThis.fetch = originalFetch;
      }
    `);
  });
});
