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

async function runContract(expectObject, harnessPage, label, body, options = undefined) {
  const result = await harnessPage.run(commonjsSource(label, body), options);
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

  test('delivers binary HTTP responses through raw virtual sockets', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'binary-http-response', `
      const assert = require('node:assert');
      const http = require('node:http');

      const payload = Buffer.from([0x00, 0xff, 0x10, 0x80, 0xc3, 0x28, 0x7f, 0x01]);
      const server = http.createServer((_request, response) => {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(payload.length),
        });
        response.end(payload);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const received = await new Promise((resolve, reject) => {
          http.get({ hostname: 'localhost', port: server.address().port, path: '/' }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.once('end', () => resolve(Buffer.concat(chunks)));
            response.once('error', reject);
          }).once('error', reject);
        });
        assert.deepStrictEqual([...received], [...payload]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('delivers VFS-streamed bodies with an explicit content length', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'vfs-streamed-http-response', `
      const assert = require('node:assert');
      const fs = require('node:fs');
      const http = require('node:http');

      const size = fs.statSync('/node/fixture.bin').size;
      const server = http.createServer((_request, response) => {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(size),
        });
        fs.createReadStream('/node/fixture.bin').pipe(response);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const received = await new Promise((resolve, reject) => {
          http.get({ hostname: 'localhost', port: server.address().port, path: '/' }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.once('end', () => resolve(Buffer.concat(chunks)));
            response.once('error', reject);
          }).once('error', reject);
        });
        assert.strictEqual(received.length, size);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `, {
      files: { '/node/fixture.bin': 'x'.repeat(19806) },
    });
  });

  test('preserves the legacy Stream inheritance contract for userland Readables', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'stream-inheritance', `
      const assert = require('node:assert');
      const { Readable, Stream, Writable } = require('node:stream');
      const { inherits } = require('node:util');

      function CustomReadable() {
        Readable.call(this);
      }
      inherits(CustomReadable, Readable);

      const custom = new CustomReadable();
      assert.ok(custom instanceof Readable);
      assert.ok(custom instanceof Stream);
      assert.ok(new Readable({ read() {} }) instanceof Stream);
      assert.ok(new Writable({ write(_chunk, _encoding, callback) { callback(); } }) instanceof Stream);
      const legacy = Object.create(Stream.prototype);
      assert.throws(() => legacy.emit('error', new Error('legacy stream error')), /legacy stream error/);
      custom.destroy();
    `);
  });

  test('exposes the origin-form path on requests created from absolute URLs', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'absolute-url-request-path', `
      const assert = require('node:assert');
      const http = require('node:http');
      const request = http.request('http://localhost/path?mode=browser');
      assert.strictEqual(request.path, '/path?mode=browser');
      request.once('error', () => {});
      request.abort();
    `);
  });

  test('drains concurrent streamed request bodies and resumable responses', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'concurrent-streamed-http', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { Readable } = require('node:stream');

      const server = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.once('end', () => response.end(String(body.length)));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const port = server.address().port;
        const lengths = await Promise.all(Array.from({ length: 10 }, (_, index) => (
          new Promise((resolve, reject) => {
            const request = http.request({
              hostname: 'localhost',
              port,
              method: 'POST',
              path: '/',
            }, (response) => {
              let output = '';
              response.setEncoding('utf8');
              response.on('data', (chunk) => { output += chunk; });
              response.once('end', () => resolve(Number(output)));
              response.once('error', reject);
              response.resume();
            });
            request.once('error', reject);
            Readable.from(['part-' + index, '-tail']).pipe(request);
          })
        )));
        assert.deepStrictEqual(lengths, [11, 11, 11, 11, 11, 11, 11, 11, 11, 11]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('frames buffered streamed request bodies for server parsers', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'streamed-request-framing', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { Readable } = require('node:stream');

      const server = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.once('end', () => {
          assert.strictEqual(request.headers['content-length'], String(Buffer.byteLength(body)));
          assert.strictEqual(request.headers['transfer-encoding'], undefined);
          response.end('framed');
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const result = await new Promise((resolve, reject) => {
          const request = http.request({
            hostname: 'localhost',
            port: server.address().port,
            method: 'POST',
            path: '/',
          }, (response) => {
            let output = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { output += chunk; });
            response.once('end', () => resolve(output));
            response.once('error', reject);
          });
          request.once('error', reject);
          Readable.from(['frame-', 'me']).pipe(request);
        });
        assert.strictEqual(result, 'framed');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('routes streamed local HTTP requests through the virtual server before proxy env', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'local-http-before-proxy', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { Readable } = require('node:stream');

      const previousProxy = process.env.HTTP_PROXY;
      const previousNoProxy = process.env.NO_PROXY;
      process.env.HTTP_PROXY = 'http://proxy.invalid:3128';
      process.env.NO_PROXY = '';
      const server = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.once('end', () => {
          assert.match(body, /name="first"/);
          assert.match(body, /name="second"/);
          response.end('local-ok');
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const result = await new Promise((resolve, reject) => {
          const request = http.request({
            hostname: 'localhost',
            port: server.address().port,
            method: 'POST',
            path: '/',
          }, (response) => {
            let output = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { output += chunk; });
            response.once('end', () => resolve(output));
            response.once('error', reject);
          });
          request.once('error', reject);
          Readable.from([
            '--bnh-boundary\\r\\nContent-Disposition: form-data; name="first"\\r\\n\\r\\none\\r\\n',
            '--bnh-boundary\\r\\nContent-Disposition: form-data; name="second"\\r\\n\\r\\ntwo\\r\\n--bnh-boundary--\\r\\n',
          ]).pipe(request);
        });
        assert.strictEqual(result, 'local-ok');
      } finally {
        await new Promise((resolve) => server.close(resolve));
        if (previousProxy === undefined) delete process.env.HTTP_PROXY;
        else process.env.HTTP_PROXY = previousProxy;
        if (previousNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = previousNoProxy;
      }
    `);
  });

  test('preserves multipart part boundaries across buffered and VFS-streamed writes', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'multipart-stream-order', `
      const assert = require('node:assert');
      const fs = require('node:fs');
      const http = require('node:http');

      const boundary = 'bnh-multipart-boundary';
      const parts = [
        { name: 'no_type', value: 'my_value' },
        { name: 'custom_type', value: 'my_value', type: 'image/png' },
        { name: 'default_type', value: Buffer.from([1, 2, 3]), type: 'application/octet-stream' },
        { name: 'implicit_type', value: fs.createReadStream('/node/stream-fixture.txt'), type: 'text/plain' },
        { name: 'overridden_type', value: fs.createReadStream('/node/stream-fixture.txt'), type: 'image/png' },
      ];
      const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.once('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const fields = body.split(boundary).slice(1, -1);
          assert.strictEqual(fields.length, parts.length, body);
          for (let index = 0; index < parts.length; index += 1) {
            assert.match(fields[index], new RegExp('name="' + parts[index].name + '"'));
            if (parts[index].type) assert.match(fields[index], new RegExp('Content-Type: ' + parts[index].type));
            else assert.strictEqual(fields[index].includes('Content-Type'), false);
          }
          response.end('multipart-ok');
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const result = await new Promise((resolve, reject) => {
          const request = http.request({
            hostname: 'localhost',
            port: server.address().port,
            method: 'POST',
            path: '/',
            headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
          }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.once('end', () => resolve(body));
            response.once('error', reject);
          });
          request.once('error', reject);
          (async () => {
            for (const part of parts) {
              request.write('--' + boundary + '\\r\\n');
              request.write('Content-Disposition: form-data; name="' + part.name + '"\\r\\n');
              if (part.type) request.write('Content-Type: ' + part.type + '\\r\\n');
              request.write('\\r\\n');
              if (typeof part.value?.pipe === 'function') {
                await new Promise((resolvePart, rejectPart) => {
                  part.value.once('error', rejectPart);
                  part.value.once('end', resolvePart);
                  part.value.pipe(request, { end: false });
                });
              } else {
                request.write(part.value);
              }
              request.write('\\r\\n');
            }
            request.end('--' + boundary + '--\\r\\n');
          })().catch(reject);
        });
        assert.strictEqual(result, 'multipart-ok');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `, {
      files: { '/node/stream-fixture.txt': 'streamed-multipart-file\\n' },
    });
  });

  test('supports legacy Stream aggregation used by multipart package dependencies', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'legacy-multipart-stream', `
      const assert = require('node:assert');
      const fs = require('node:fs');
      const http = require('node:http');
      const { Stream } = require('node:stream');

      function delayed(source) {
        const target = new Stream();
        let released = false;
        const buffered = [];
        const emit = source.emit;
        source.emit = function delayedEmit(name, ...args) {
          if (released) target.emit(name, ...args);
          else {
            if (name === 'data') target.dataSize = (target.dataSize || 0) + args[0].length;
            buffered.push([name, ...args]);
          }
          return emit.call(source, name, ...args);
        };
        source.on('error', () => {});
        source.pause();
        source.on('data', () => {});
        assert.strictEqual(source.isPaused(), true);
        target.pipe = function delayedPipe(destination, options) {
          const result = Stream.prototype.pipe.call(this, destination, options);
          this.resume();
          return result;
        };
        target.resume = () => {
          if (!released) {
            released = true;
            for (const event of buffered.splice(0)) target.emit(...event);
          }
          source.resume();
        };
        target.pause = () => source.pause();
        return target;
      }

      const boundary = 'bnh-legacy-multipart-boundary';
      const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.once('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const fields = body.split(boundary).slice(1, -1);
          assert.strictEqual(fields.length, 2, body);
          assert.match(fields[0], /name="first"/);
          assert.match(fields[1], /name="file"/);
          assert.match(fields[1], new RegExp('Content-Type: text' + String.fromCharCode(47) + 'plain'));
          response.end('legacy-multipart-ok');
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const result = await new Promise((resolve, reject) => {
          const request = http.request({
            hostname: 'localhost',
            port: server.address().port,
            method: 'POST',
            path: '/',
            headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
          }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.once('end', () => resolve(body));
            response.once('error', reject);
          });
          request.once('error', reject);

          const combined = new Stream();
          combined._released = false;
          combined._insideLoop = false;
          combined._streams = [
            '--' + boundary + '\\r\\nContent-Disposition: form-data; name="first"\\r\\n\\r\\none\\r\\n',
            '--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"\\r\\nContent-Type: text/plain\\r\\n\\r\\n',
            delayed(fs.createReadStream('/node/stream-fixture.txt')),
            '\\r\\n--' + boundary + '--\\r\\n',
          ];
          combined.pipe = function combinedPipe(destination, options) {
            Stream.prototype.pipe.call(this, destination, options);
            this.resume();
            return destination;
          };
          combined.write = (chunk) => combined.emit('data', chunk);
          combined.end = () => combined.emit('end');
          combined._getNext = () => {
            if (combined._insideLoop) {
              combined._pendingNext = true;
              return;
            }
            combined._insideLoop = true;
            do {
              combined._pendingNext = false;
              const value = combined._streams.shift();
              if (value === undefined) {
                combined.end();
                break;
              }
              combined._currentStream = value;
              if (typeof value !== 'string') {
                value.once('end', combined._getNext);
                value.pipe(combined, { end: false });
              } else {
                combined.write(value);
                combined._getNext();
              }
            } while (combined._pendingNext);
            combined._insideLoop = false;
          };
          combined.resume = () => {
            if (!combined._released) {
              combined._released = true;
              combined._getNext();
            }
          };
          setTimeout(() => combined.pipe(request), 0);
        });
        assert.strictEqual(result, 'legacy-multipart-ok');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `, {
      files: { '/node/stream-fixture.txt': 'legacy-stream-file\\n' },
    });
  });

  test('streams a VFS file from a parent HTTP server to a child request', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'cross-child-http-file-response', `
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      const runner = spawn(process.execPath, ['/node/stream-supervisor.cjs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      runner.stdout.on('data', (chunk) => { stdout += chunk; });
      runner.stderr.on('data', (chunk) => { stderr += chunk; });
      const code = await new Promise((resolve, reject) => {
        runner.once('error', reject);
        runner.once('close', resolve);
      });
      assert.strictEqual(code, 0, stderr);
      assert.strictEqual(stdout, 'field=my_field\\nmy_value\\nremote_bytes=19807\\n');
    `, {
      files: {
        '/node/stream-supervisor.cjs': [
          "const { spawn } = require('node:child_process');",
          "const runner = spawn(process.execPath, ['/node/stream-runner.cjs'], { stdio: ['ignore', 'pipe', 'pipe'] });",
          'runner.stdout.pipe(process.stdout);',
          'runner.stderr.pipe(process.stderr);',
          "runner.once('close', (code) => { process.exitCode = code; });",
        ].join('\n'),
        '/node/stream-runner.cjs': [
          "const fs = require('node:fs');",
          "const http = require('node:http');",
          "const { spawn } = require('node:child_process');",
          "fs.writeFileSync('/node/stream-fixture.txt', 'x'.repeat(19806));",
          "const server = http.createServer((request, response) => {",
          "  if (request.method === 'POST') {",
          "    let body = '';",
          "    request.setEncoding('utf8');",
          "    request.on('data', (chunk) => { body += chunk; });",
          "    request.once('end', () => {",
          "      const marker = 'field=remote_file\\n';",
          "      response.end('field=my_field\\nmy_value\\nremote_bytes=' + body.slice(body.indexOf(marker) + marker.length).length + '\\n');",
          "    });",
          '    return;',
          '  }',
          "  const source = fs.createReadStream('/node/stream-fixture.txt');",
          "  response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(fs.statSync('/node/stream-fixture.txt').size) });",
          '  source.pipe(response);',
          '});',
          "server.listen(0, '127.0.0.1', () => {",
          "  const child = spawn(process.execPath, ['/node/stream-client.cjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BNH_HTTP_PORT: String(server.address().port) } });",
          "  child.stdout.pipe(process.stdout);",
          "  child.stderr.pipe(process.stderr);",
          "  child.once('close', (code) => { server.close(() => { process.exitCode = code; }); });",
          '});',
        ].join('\n'),
        '/node/stream-client.cjs': [
          "const http = require('node:http');",
          "const Stream = require('node:stream').Stream;",
          'function DelayedStream(source) { this.source = source; this.pauseStream = true; this._released = false; this._bufferedEvents = []; }',
          'DelayedStream.create = (source) => {',
          '  const delayed = new DelayedStream(source);',
          '  const realEmit = source.emit;',
          '  source.emit = (...args) => { delayed._handleEmit(args); return realEmit.apply(source, args); };',
          "  source.on('error', () => {});",
          '  source.pause();',
          '  return delayed;',
          '};',
          'Object.setPrototypeOf(DelayedStream.prototype, Stream.prototype);',
          "Object.defineProperty(DelayedStream.prototype, 'readable', { get() { return this.source.readable; } });",
          'DelayedStream.prototype.resume = function resume() { if (!this._released) this.release(); this.source.resume(); };',
          'DelayedStream.prototype.pause = function pause() { this.source.pause(); };',
          'DelayedStream.prototype.release = function release() { this._released = true; this._bufferedEvents.forEach((args) => this.emit(...args)); this._bufferedEvents = []; };',
          'DelayedStream.prototype.pipe = function pipe(destination, options) { Stream.prototype.pipe.call(this, destination, options); this.resume(); return destination; };',
          'DelayedStream.prototype._handleEmit = function handleEmit(args) { if (this._released) this.emit(...args); else this._bufferedEvents.push(args); };',
          'function CombinedStream() { this.readable = true; this.writable = false; this.pauseStreams = true; this._released = false; this._streams = []; this._currentStream = null; }',
          'Object.setPrototypeOf(CombinedStream.prototype, Stream.prototype);',
          'CombinedStream.create = () => new CombinedStream();',
          'CombinedStream.prototype.append = function append(stream) { if (stream && typeof stream !== \'string\' && typeof stream !== \'number\') { if (!(stream instanceof DelayedStream)) { const delayed = DelayedStream.create(stream); stream.on(\'data\', () => {}); if (!stream.isPaused()) throw new Error(\'adding a data listener resumed a paused IncomingMessage\'); stream = delayed; } } this._streams.push(stream); return this; };',
          'CombinedStream.prototype.pipe = function pipe(destination, options) { Stream.prototype.pipe.call(this, destination, options); this.resume(); return destination; };',
          'CombinedStream.prototype._getNext = function getNext() { const stream = this._streams.shift(); if (stream === undefined) { this.writable = false; this.emit(\'end\'); return; } this._currentStream = stream; if (typeof stream === \'function\') { stream((value) => this._pipeNext(value)); } else { this._pipeNext(stream); } };',
          'CombinedStream.prototype._pipeNext = function pipeNext(stream) { if (stream && typeof stream !== \'string\' && typeof stream !== \'number\') { stream.on(\'end\', () => this._getNext()); stream.pipe(this, { end: false }); } else { this.emit(\'data\', stream); this._getNext(); } };',
          'CombinedStream.prototype.resume = function resume() { if (!this._released) { this._released = true; this.writable = true; this._getNext(); } if (this._currentStream?.resume) this._currentStream.resume(); };',
          'CombinedStream.prototype.write = function write(data) { this.emit(\'data\', data); };',
          'function Form() { CombinedStream.call(this); }',
          'Object.setPrototypeOf(Form.prototype, CombinedStream.prototype);',
          'Form.prototype.append = function append(field, value) { this._streams.push(\'field=\' + field + \'\\n\'); this._streams.push(value); this._streams.push((next) => next(\'\\n\')); };',
          'Form.prototype.getLength = function getLength(callback) { process.nextTick(() => callback(null, 1)); };',
          'Form.prototype.submit = function submit(callback) { const upload = http.request({ host: \'localhost\', port: Number(process.env.BNH_HTTP_PORT), method: \'POST\', path: \'/upload\' }, (uploadResponse) => callback(null, uploadResponse)); this.getLength((error, length) => { if (error) { callback(error); return; } upload.setHeader(\'content-length\', length); this.pipe(upload); }); };',
          "const request = http.request({ host: 'localhost', port: Number(process.env.BNH_HTTP_PORT), path: '/stream' }, (response) => {",
          "  if (response.client?._httpMessage?.path !== '/stream') throw new Error('IncomingMessage.client metadata missing');",
          "  const form = new Form();",
          "  form.append('my_field', 'my_value');",
          "  form.append('remote_file', response);",
          '  form.submit((error, uploadResponse) => { if (error) { console.error(error); process.exitCode = 1; return; }',
          "    let body = '';",
          "    uploadResponse.setEncoding('utf8');",
          "    uploadResponse.on('data', (chunk) => { body += chunk; });",
          "    uploadResponse.once('end', () => { process.stdout.write(body); });",
          "    uploadResponse.once('error', (error) => { console.error(error); process.exitCode = 1; });",
          '  });',
          '  response.once(\'error\', (error) => { console.error(error); process.exitCode = 1; });',
          '});',
          "request.once('error', (error) => { console.error(error); process.exitCode = 1; });",
          'request.end();',
        ].join('\n'),
      },
    });
  });

  test('flushes implicit headers before a final body on raw net sockets', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'raw-net-http-end', `
      const assert = require('node:assert');
      const http = require('node:http');
      const net = require('node:net');

      const server = http.createServer((_request, response) => {
        response.setHeader('transfer-encoding', 'chunked');
        response.write('raw-body');
        response.end();
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
          socket.once('connect', () => socket.end(
            'GET /raw HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n',
          ));
          socket.once('error', reject);
          socket.once('close', () => resolve(output));
        });
        assert.match(wire, /^HTTP\\/1\\.1 200 /);
        assert.match(wire, /\\r\\n\\r\\n8\\r\\nraw-body\\r\\n0\\r\\n\\r\\n$/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `);
  });

  test('parses chunked request bodies received on raw net sockets', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'raw-net-http-chunked-request', `
      const assert = require('node:assert');
      const http = require('node:http');
      const net = require('node:net');

      const server = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.once('end', () => {
          assert.strictEqual(request.headers['transfer-encoding'], 'chunked');
          assert.strictEqual(body, 'chunked multipart body');
          response.end('chunked-ok');
        });
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
          socket.once('connect', () => socket.end(
            'POST /chunked HTTP/1.1\\r\\n'
              + 'Host: localhost\\r\\n'
              + 'Transfer-Encoding: chunked\\r\\n'
              + 'Connection: close\\r\\n\\r\\n'
              + '8\\r\\nchunked \\r\\n'
              + 'e\\r\\nmultipart body\\r\\n'
              + '0\\r\\n\\r\\n',
          ));
          socket.once('error', reject);
          socket.once('close', () => resolve(output));
        });
        assert.match(wire, /chunked-ok/);
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

  test('aborting an async piped response permits a replacement request', async ({ harnessPage }) => {
    await runContract(expect, harnessPage, 'async-piped-request-destroy-reconnect', `
      const assert = require('node:assert');
      const http = require('node:http');
      const { Readable, finished } = require('node:stream');

      const sendStream = (source, response) => {
        let sourceOpen = true;
        finished(source, { readable: true, writable: false }, () => { sourceOpen = false; });
        finished(response, (error) => {
          if (sourceOpen && error) source.destroy();
        });
        source.pipe(response);
      };

      let requests = 0;
      const server = http.createServer(async (_request, response) => {
        requests += 1;
        const source = new Readable({ read() {} });
        const reply = {
          raw: response,
          sent: false,
          send(payload) {
            this.sent = true;
            sendStream(payload, this.raw);
            return this;
          },
          then(fulfilled, rejected) {
            if (this.sent) {
              fulfilled();
              return;
            }
            finished(this.raw, (error) => error ? rejected?.(error) : fulfilled());
          },
        };
        response.setHeader('transfer-encoding', 'chunked');
        source.push('first');
        reply.send(source);
        if (requests === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          source.push('late');
          source.push(null);
        } else {
          source.push('second');
          source.push(null);
        }
        return reply;
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const port = server.address().port;
        const warmup = http.createServer((_request, response) => {
          setTimeout(() => response.end('late'), 25);
        });
        await new Promise((resolve, reject) => {
          warmup.once('error', reject);
          warmup.listen(0, '127.0.0.1', resolve);
        });
        try {
          await new Promise((resolve, reject) => {
            const request = http.get('http://localhost:' + warmup.address().port);
            request.once('error', (error) => {
              assert.strictEqual(error.code, 'ECONNRESET');
              resolve();
            });
            setTimeout(() => request.destroy(), 1);
          });
        } finally {
          await new Promise((resolve) => warmup.close(resolve));
        }
        await new Promise((resolve, reject) => {
          const request = http.get('http://localhost:' + port, (response) => {
            response.once('error', () => {});
            response.once('data', (chunk) => {
              assert.strictEqual(chunk.toString(), 'first');
              setTimeout(() => {
                request.destroy();
                resolve();
              }, 1);
            });
          });
          request.once('error', reject);
        });
        const body = await new Promise((resolve, reject) => {
          const request = http.get('http://localhost:' + port, (response) => {
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
});
