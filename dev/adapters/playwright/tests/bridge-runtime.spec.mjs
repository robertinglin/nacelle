import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test.describe('browser runtime bridge and core primitives', () => {
  test('resets, mounts, spawns, and captures stdout and stderr in the browser', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      assert.strictEqual(typeof process.stdout.write, 'function');
      assert.strictEqual(typeof process.stderr.write, 'function');
      process.stdout.write('browser stdout\\n');
      process.stderr.write('browser stderr\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('browser stdout');
    expect(result.stderr).toContain('browser stderr');
  });

  test('keeps Buffer arrays and assert predicates Node-compatible', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        assert.deepStrictEqual([...Buffer.from([0, 127, 255])], [0, 127, 255]);
        assert.throws(
          () => { throw new TypeError('expected failure'); },
          (error) => error instanceof TypeError && error.message === 'expected failure',
        );
      })();
    `);

    await expectPass(expect, result);
  });

  test('initializes legacy function-inherited Readable receivers in place', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert');
        const util = require('node:util');
        const { Readable } = require('node:stream');
        function LegacyRequest() {
          Readable.call(this, { autoDestroy: false });
        }
        util.inherits(LegacyRequest, Readable);

        const request = new LegacyRequest();
        assert.ok(request._readableState);
        request.setEncoding('utf8');
        const body = new Promise((resolve, reject) => {
          let value = '';
          request.on('data', (chunk) => { value += chunk; });
          request.once('error', reject);
          request.once('end', () => resolve(value));
        });
        request.push(Buffer.from('legacy '));
        request.push(Buffer.from('receiver'));
        request.push(null);
        assert.strictEqual(await body, 'legacy receiver');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('marks a legacy callable ServerResponse ended before its finish event', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert/strict');
        const http = require('node:http');
        const { once, Readable } = require('node:stream');
        const raw = Object.create(http.ServerResponse.prototype);
        http.ServerResponse.call(raw, { method: 'GET', socket: null, connection: null });
        Readable.from(['response body']).pipe(raw);
        await once(raw, 'finish');
        assert.strictEqual(raw.writableEnded, true);
        assert.strictEqual(raw.finished, true);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('settles a response thenable after a legacy stream terminal sequence', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert/strict');
        const http = require('node:http');
        const { finished } = require('node:stream');
        const { Readable } = require('node:stream');
        const util = require('node:util');

        function Response(req) {
          http.ServerResponse.call(this, req);
        }
        util.inherits(Response, http.ServerResponse);
        Response.prototype.end = function (data, encoding, callback) {
          if (data) this.write(data, encoding);
          http.ServerResponse.prototype.end.call(this, callback);
          this.emit('finish');
          this.destroy();
        };
        Response.prototype.destroy = function (error) {
          if (this.destroyed) return;
          this.destroyed = true;
          if (error) process.nextTick(() => this.emit('error', error));
          process.nextTick(() => this.emit('close'));
        };

        const raw = new Response({ method: 'GET', socket: null, connection: null });
        const reply = {
          raw,
          get sent() { return raw.writableEnded === true; },
          then(onFulfilled, onRejected) {
            finished(raw, (error) => error ? onRejected(error) : onFulfilled());
          },
        };
        Readable.from(['response body']).pipe(raw);
        await reply;
        assert.strictEqual(reply.sent, true);
        assert.strictEqual(raw.writableEnded, true);
        process.stdout.write('response thenable terminal completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('response thenable terminal completed');
  });

  test('finished accepts legacy Stream instances and waits for the requested side', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert/strict');
        const { Stream, finished } = require('node:stream');
        const legacy = new Stream();
        legacy.readable = true;
        legacy.writable = true;
        let completed = false;
        const terminal = new Promise((resolve, reject) => {
          finished(legacy, { readable: true, writable: false }, (error) => {
            if (error) reject(error);
            else {
              completed = true;
              resolve();
            }
          });
        });
        await Promise.resolve();
        assert.strictEqual(completed, false);
        legacy.emit('end');
        await terminal;
        assert.strictEqual(completed, true);
        process.stdout.write('legacy stream finished contract completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('legacy stream finished contract completed');
  });

  test('keeps response sent state visible through socket-backed stream completion', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
        const assert = require('node:assert/strict');
        const http = require('node:http');
        const { finished, Readable, Writable } = require('node:stream');
        const util = require('node:util');

        function Response(req) {
          http.ServerResponse.call(this, req);
          this._lightMyRequest = { payloadChunks: [] };
          this.setHeader('foo', 'bar');
          this.removeHeader('foo');
          this.assignSocket(new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(callback); } }));
        }
        util.inherits(Response, http.ServerResponse);
        Response.prototype.write = function (data, encoding, callback) {
          http.ServerResponse.prototype.write.call(this, data, encoding, callback);
          this._lightMyRequest.payloadChunks.push(Buffer.from(data, encoding));
          return true;
        };
        Response.prototype.end = function (data, encoding, callback) {
          if (data) this.write(data, encoding);
          http.ServerResponse.prototype.end.call(this, callback);
          this.emit('finish');
          this.destroy();
        };
        Response.prototype.destroy = function (error) {
          if (this.destroyed) return;
          this.destroyed = true;
          if (error) process.nextTick(() => this.emit('error', error));
          process.nextTick(() => this.emit('close'));
        };

        const raw = new Response({ method: 'GET', socket: null, connection: null });
        const reply = {
          raw,
          get sent() { return raw.writableEnded === true; },
          then(onFulfilled, onRejected) {
            if (this.sent) return onFulfilled();
            finished(raw, (error) => error ? onRejected?.(error) : onFulfilled());
          },
        };
        Readable.from(['response body']).pipe(raw);
        await reply;
        assert.strictEqual(reply.sent, true);
        assert.strictEqual(raw.writableEnded, true);
        assert.deepStrictEqual(raw._lightMyRequest.payloadChunks.map((chunk) => chunk.toString()), ['response body']);
        process.stdout.write('socket-backed response terminal completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('socket-backed response terminal completed');
  });

  test('marks a response writableEnded at end call despite a pending write', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert/strict');
        const http = require('node:http');
        const { Writable } = require('node:stream');
        const util = require('node:util');

        function Response(req) {
          http.ServerResponse.call(this, req);
        }
        util.inherits(Response, http.ServerResponse);
        Response.prototype.end = function (data, encoding, callback) {
          if (data) this.write(data, encoding);
          http.ServerResponse.prototype.end.call(this, callback);
          this.emit('finish');
          this.destroy();
        };
        Response.prototype.destroy = function () {
          if (this.destroyed) return;
          this.destroyed = true;
          process.nextTick(() => this.emit('close'));
        };

        const raw = new Response({ method: 'GET', socket: null, connection: null });
        let observed;
        raw.once('finish', () => { observed = raw.writableEnded; });
        raw.write('pending response body');
        raw.end();
        assert.strictEqual(observed, true);
        process.stdout.write('response writableEnded timing completed\\n');
      })();
    `);

    await expectPass(expect, result);
    expect(result.stdout).toContain('response writableEnded timing completed');
  });

  test('generates synchronously encoded RSA key pairs through the browser crypto contract', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { generateKeyPairSync } = require('node:crypto');
      const pair = generateKeyPairSync('rsa', {
        modulusLength: 512,
        publicExponent: 65537,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      assert.match(pair.publicKey, /^-----BEGIN PUBLIC KEY-----\\n[\\s\\S]+\\n-----END PUBLIC KEY-----\\n$/);
      assert.match(pair.privateKey, /^-----BEGIN PRIVATE KEY-----\\n[\\s\\S]+\\n-----END PRIVATE KEY-----\\n$/);
      assert.notStrictEqual(pair.publicKey, pair.privateKey);
      assert.ok(pair.publicKey.length > 150);
      assert.ok(pair.privateKey.length > 400);
    `);

    await expectPass(expect, result);
  });

  test('reports browser output as non-TTY while preserving tty window APIs', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const tty = require('node:tty');
        assert.strictEqual(tty.isatty(1), false);
        assert.strictEqual(tty.isatty(process.stdout), false);
        assert.strictEqual(typeof tty.getWindowSize, 'function');
        assert.deepStrictEqual(tty.getWindowSize(), [80, 24]);
        assert.deepStrictEqual(new tty.WriteStream(1).getWindowSize(), [80, 24]);
      })();
    `);

    await expectPass(expect, result);
  });

  test('loads test-assert.js-style CommonJS modules that declare process locally', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (() => {
        const assert = require('node:assert');
        const fs = require('node:fs');
        fs.mkdirSync('/node/test/common', { recursive: true });
        fs.mkdirSync('/node/test/parallel', { recursive: true });
        fs.writeFileSync('/node/test/common/index.js', [
          "'use strict';",
          'const process = globalThis.process;',
          'module.exports = { version: process.version };',
        ].join('\\n'));
        fs.writeFileSync('/node/test/parallel/test-assert.js', [
          "'use strict';",
          "const common = require('../common');",
          "const assert = require('node:assert');",
          'assert.strictEqual(common.version, process.version);',
          'module.exports = true;',
        ].join('\\n'));

        assert.strictEqual(require('/node/test/parallel/test-assert.js'), true);
      })();
    `);

    await expectPass(expect, result);
  });

  test('propagates process.exitCode assignments to the bridge result', async ({ harnessPage }) => {
    const result = await harnessPage.run(`process.exitCode = 17;`);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(17);
  });

  test('does not keep a process alive for an unresolved Promise continuation', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      new Promise(() => {}).then(() => process.stdout.write('unreachable\\n'));
      process.stdout.write('done\\n');
    `, { timeoutMs: 250 });

    expect(result.timedOut, JSON.stringify(result)).toBe(false);
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toBe(['done', ''].join('\n'));
  });

  test('does not keep a nested virtual child alive for an unresolved Promise', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['/node/unresolved-child.js']);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.once('close', (code) => {
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'done\\n');
      });
    `, {
      timeoutMs: 500,
      files: {
        '/node/unresolved-child.js': [
          "new Promise(() => {}).then(() => process.stdout.write('unreachable\\n'));",
          "process.stdout.write('done\\n');",
        ].join('\n'),
      },
    });

    expect(result.timedOut, JSON.stringify(result)).toBe(false);
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
  });

  test('runs npm scripts when Node launches the npm entrypoint', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/node', [
          '/node/node_modules/.bin/npm', 'test',
        ], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (value) => {
            resolve(value);
          });
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'npm entrypoint ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({
          name: 'npm-entrypoint-fixture',
          version: '1.0.0',
          scripts: { test: "node -e \"process.stdout.write('npm entrypoint ran\\\\n')\"" },
        }),
        '/node/node_modules/.bin/node': '#!/usr/bin/env node\\n',
        '/node/node_modules/.bin/npm': '#!/usr/bin/env node\\n',
      },
    });

    await expectPass(expect, result);
  });

  test('forwards output and status through a package-manager child entrypoint', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('node', ['/node/yarn.js', 'test'], {
          cwd: '/node',
        });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0, errorOutput);
        assert.strictEqual(output, 'manager start\\npackage manager child ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/yarn.js': [
          '#!/usr/bin/env node',
          "const { spawn } = require('node:child_process');",
          "process.stdout.write('manager start\\n');",
          "const child = spawn(process.execPath, ['/node/package-manager-child.js'], { stdio: ['ignore', 'pipe', 'pipe'] });",
          "child.stdout.on('data', (chunk) => process.stdout.write(chunk));",
          "child.stderr.on('data', (chunk) => process.stderr.write(chunk));",
          "child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code); });",
        ].join('\n'),
        '/node/package-manager-child.js': "process.stdout.write('package manager child ran\\n');",
      },
    });

    await expectPass(expect, result);
  });

  test('preserves piped child output and stream listener semantics', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');
      const { Writable } = require('node:stream');

      (async () => {
        const child = spawn('node', ['/node/stream-child.js']);
        let observed = '';
        const removed = () => { observed += 'removed'; };
        child.stdout.on('data', removed);
        child.stdout.removeListener('data', removed);
        child.stdout.once('data', (chunk) => { observed += chunk.toString(); });
        const chunks = [];
        const sink = new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(chunk.toString());
            callback();
          },
        });
        child.stdout.pipe(sink);
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(observed, 'piped child output\\n');
        assert.strictEqual(chunks.join(''), 'piped child output\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/stream-child.js': "process.stdout.write('piped child output\\n');",
      },
    });

    await expectPass(expect, result);
  });

  test('runs ESM Node files from npm package scripts through the ESM lifecycle', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/npm', ['test'], { cwd: '/node' });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0, errorOutput);
        assert.strictEqual(output, 'nested esm script\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({
          name: 'npm-esm-script-fixture',
          version: '1.0.0',
          scripts: { test: '/browser/node /node/sub/nested-script.mjs' },
        }),
        '/node/node_modules/.bin/npm': '#!/usr/bin/env node\n',
        '/node/sub/package.json': JSON.stringify({ type: 'module' }),
        '/node/sub/nested-script.mjs': [
          "if (typeof import.meta.url !== 'string') process.exitCode = 1;",
          "process.stdout.write('nested esm script\\n');",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('preserves npm dispatch when Node is resolved by name', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('node', ['/node/node_modules/.bin/npm', 'run', 'citgm'], { cwd: '/node', uid: 0, gid: 0 });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'named npm entrypoint ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({
          name: 'named-npm-entrypoint-fixture',
          version: '1.0.0',
          scripts: { citgm: "node -e \"process.stdout.write('named npm entrypoint ran\\\\n')\"" },
        }),
        '/node/node_modules/.bin/npm': '#!/usr/bin/env node\\n',
      },
    });

    await expectPass(expect, result);
  });

  test('keeps CommonJS async module imports in the child process context', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { pathToFileURL } = require('node:url');
      (async () => {
        process.stdout.write('before\\n');
        const loaded = await import(pathToFileURL('/node/loaded.js'));
        assert.strictEqual(loaded.default, 'loaded');
        process.stdout.write('after\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: { '/node/loaded.js': "module.exports = 'loaded';\n" },
    });

    await expectPass(expect, result);
    expect(result.stdout).toContain('before');
    expect(result.stdout).toContain('after');
  });

  test('waits for async dynamic imports in shebang children', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');
      (async () => {
        const child = spawn('/node/node_modules/.bin/tool', [], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'child-before\\nloaded\\nchild-after\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "const { pathToFileURL } = require('node:url');",
          '(async () => {',
          "  process.stdout.write('child-before\\n');",
          "  const loaded = await import(pathToFileURL('/node/loaded.js'));",
          "  process.stdout.write(loaded.default + '\\n');",
          "  process.stdout.write('child-after\\n');",
          '})().catch((error) => { console.error(error); process.exitCode = 1; });',
        ].join('\n'),
        '/node/loaded.js': "module.exports = 'loaded';\n",
      },
    });

    await expectPass(expect, result);
  });

  test('executes an ESM shebang launcher with its terminal result', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      (async () => {
        fs.symlinkSync('../esm-pkg/bin.js', '/node/node_modules/.bin/esm-tool');
        const child = spawn('/node/node_modules/.bin/esm-tool', [], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'esm launcher ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/.keep': '',
        '/node/node_modules/esm-pkg/package.json': JSON.stringify({ type: 'module' }),
        '/node/node_modules/esm-pkg/bin.js': [
          '#!/usr/bin/env node',
          'await Promise.resolve();',
          "process.stdout.write('esm launcher ran\\n');",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('preserves resolver result shape in a virtual child process', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn(process.execPath, ['/node/dns-child.js'], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(JSON.parse(output), { address: '127.0.0.1', family: 4 });
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/dns-child.js': "const dns = require('node:dns').promises; dns.lookup('localhost').then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });",
      },
    });

    await expectPass(expect, result);
  });

  test('executes shebang scripts from the virtual filesystem', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/tool', ['argument'], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'tool ran argument\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': "#!/usr/bin/env node\nprocess.stdout.write('tool ran ' + process.argv[2] + '\\n');\n",
      },
    });

    await expectPass(expect, result);
  });

  test('runs ESM package bins from npm-style launcher files', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/esm-bin', [], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'esm bin ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/esm-bin/package.json': JSON.stringify({ name: 'esm-bin', version: '1.0.0', type: 'module', bin: { 'esm-bin': 'bin.js' } }),
        '/node/node_modules/esm-bin/bin.js': "#!/usr/bin/env node\nimport { format } from 'node:util';\nprocess.stdout.write(format('esm bin ran') + '\\n');\n",
        '/node/node_modules/.bin/esm-bin': "#!/usr/bin/env node\nimport('/node/node_modules/esm-bin/bin.js').catch((error) => { console.error(error); process.exitCode = 1; });\n",
      },
    });

    await expectPass(expect, result);
  });

  test('keeps an ESM launcher alive through an asynchronous dynamic import', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/esm-async-bin', [], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'async esm bin ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/esm-async-bin': "#!/usr/bin/env node\\nimport('/node/node_modules/esm-async-bin/bin.js').catch((error) => { console.error(error); process.exitCode = 1; });\\n",
        '/node/node_modules/esm-async-bin/package.json': JSON.stringify({ name: 'esm-async-bin', version: '1.0.0', type: 'module', bin: { 'esm-async-bin': 'bin.js' } }),
        '/node/node_modules/esm-async-bin/bin.js': "#!/usr/bin/env node\\nawait new Promise((resolve) => setTimeout(resolve, 0));\\nprocess.stdout.write('async esm bin ran\\n');\\n",
      },
    });

    await expectPass(expect, result);
  });

  test('rewrites awaited private-field access in CommonJS async methods', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/private-await', [], { cwd: '/node' });
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0, errorOutput);
        assert.strictEqual(output, 'private await completed\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/private-await': `#!/usr/bin/env node
          class PrivateValue {
            #value = Promise.resolve('private await completed');
            async read() {
              const marker = () => 'private await completed';
              await Promise.resolve();
              return await this.#value;
            }
          }
          new PrivateValue().read().then((value) => process.stdout.write(value + '\\n'));
        `,
      },
    });

    await expectPass(expect, result);
  });

  test('preserves option-looking shebang script arguments after the script path', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const { spawn } = require('node:child_process');
      const child = spawn('/node/node_modules/.bin/tool', [
        '--require', 'test/support/env', '--reporter', 'spec', 'test/',
      ], { cwd: '/node' });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.once('close', (code) => {
        process.stdout.write(JSON.stringify({ code, argv: JSON.parse(output) }));
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      },
    });

    await expectPass(expect, result);
    expect(JSON.parse(result.stdout)).toEqual({
      code: 0,
      argv: ['--require', 'test/support/env', '--reporter', 'spec', 'test/'],
    });
  });

  test('waits for shebang child processes and propagates their output and status', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/tool', [], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 7);
        assert.strictEqual(output, 'tool start\\nnested tool ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "process.stdout.write('tool start\\n');",
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['/node/tool-child.js'], { stdio: 'inherit' });",
          "child.once('error', (error) => { process.stderr.write('tool error ' + error.message + '\\n'); process.exit(2); });",
          "child.once('exit', (code, signal) => { process.on('exit', () => { if (signal) process.kill(process.pid, signal); else process.exit(code); }); });",
        ].join('\n'),
        '/node/tool-child.js': "process.stdout.write('nested tool ran\\n'); process.exitCode = 7;",
      },
    });

    await expectPass(expect, result);
  });

  test('forwards output and status through npm scripts that launch shebang children', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/node', [
          '/node/node_modules/.bin/npm', 'test',
        ], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 7);
        assert.strictEqual(output, 'npm tool start\\nnpm nested tool ran\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({
          name: 'npm-shebang-fixture',
          version: '1.0.0',
          scripts: { test: 'tool' },
        }),
        '/node/node_modules/.bin/node': '#!/usr/bin/env node\\n',
        '/node/node_modules/.bin/npm': '#!/usr/bin/env node\\n',
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "process.stdout.write('npm tool start\\n');",
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['/node/npm-tool-child.js'], { stdio: 'inherit' });",
          "child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code); });",
        ].join('\n'),
        '/node/npm-tool-child.js': "process.stdout.write('npm nested tool ran\\n'); process.exitCode = 7;",
      },
    });

    await expectPass(expect, result);
  });

  test('preserves async ESM launcher output through npm package scripts', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/node', [
          '/node/node_modules/.bin/npm', 'run', 'check',
        ], { cwd: '/node' });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0, stderr);
        assert.strictEqual(stdout, 'package script before\\npackage script after\\n');
        assert.strictEqual(stderr, '');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/package.json': JSON.stringify({
          name: 'npm-esm-launcher-fixture',
          version: '1.0.0',
          scripts: { check: 'esm-check' },
        }),
        '/node/node_modules/.bin/node': '#!/usr/bin/env node\\n',
        '/node/node_modules/.bin/npm': '#!/usr/bin/env node\\n',
        '/node/node_modules/.bin/esm-check': [
          '#!/usr/bin/env node',
          "import('/node/node_modules/esm-check/check.js').catch((error) => { console.error(error); process.exitCode = 1; });",
        ].join('\n'),
        '/node/node_modules/esm-check/package.json': JSON.stringify({
          name: 'esm-check', version: '1.0.0', type: 'module', bin: { 'esm-check': 'check.js' },
        }),
        '/node/node_modules/esm-check/check.js': [
          "process.stdout.write('package script before\\n');",
          'await new Promise((resolve) => setTimeout(resolve, 0));',
          "process.stdout.write('package script after\\n');",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('waits for asynchronous inherited-stdio children before closing', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const writes = [];
        const originalWrite = process.stdout.write;
        process.stdout.write = (chunk, ...args) => {
          writes.push(String(chunk));
          return originalWrite.call(process.stdout, chunk, ...args);
        };
        const child = spawn('/node/node_modules/.bin/tool', [], { stdio: 'inherit' });
        try {
          const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
          });
          assert.strictEqual(code, 0);
          assert.ok(writes.includes('async inherited child\\n'));
        } finally {
          process.stdout.write = originalWrite;
        }
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "setTimeout(() => process.stdout.write('async inherited child\\n'), 1);",
        ].join('\\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('runs required preloads in inherited execPath children before forwarding exit', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn('/node/node_modules/.bin/tool', [], { cwd: '/node' });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, 'preloaded\\ninner child\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/node_modules/.bin/tool': [
          '#!/usr/bin/env node',
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['--require', '/node/preload.js', '/node/inner.js'], { stdio: 'inherit' });",
          "child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code); });",
        ].join('\\n'),
        '/node/preload.js': "process.stdout.write('preloaded\\n');",
        '/node/inner.js': "const assert = require('node:assert'); assert.strictEqual(require.main, module); setTimeout(() => process.stdout.write('inner child\\n'), 1);",
      },
    });

    await expectPass(expect, result);
  });

  test('runs the upstream worker abort-on-uncaught-exception case', async ({ harnessPage }) => {
    const entryPath = '/node/test/abort/test-worker-abort-uncaught-exception.js';
    const result = await harnessPage.run(`
      'use strict';
      const common = require('../common');
      const assert = require('assert');
      const { spawn } = require('child_process');
      const { Worker } = require('worker_threads');

      if (process.argv[2] === 'child') {
        new Worker('throw new Error("foo");', { eval: true });
        return;
      }

      const child = spawn(process.execPath, [
        '--abort-on-uncaught-exception', __filename, 'child',
      ]);
      child.on('exit', common.mustCall((code, sig) => {
        if (common.isWindows) {
          assert.strictEqual(code, 0x80000003);
        } else {
          assert(['SIGABRT', 'SIGTRAP', 'SIGILL'].includes(sig),
            \`Unexpected signal \${sig}\`);
        }
      }));
    `, {
      entryPath,
      files: {
        '/node/test/common/index.js': `
          module.exports = {
            isWindows: false,
            mustCall(callback) { return (...args) => callback(...args); },
          };
        `,
      },
    });

    await expectPass(expect, result);
  });

  test('uses the mounted virtual filesystem rather than the host filesystem', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const root = path.join('.bnh-playwright-vfs', String(process.pid));
      const file = path.join(root, 'nested', 'value.txt');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'browser-vfs', 'utf8');
      assert.strictEqual(await fs.readFile(file, 'utf8'), 'browser-vfs');
      assert.strictEqual((await fs.stat(file)).isFile(), true);
      await fs.rm(root, { recursive: true, force: true });
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('resolves relative paths from each virtual process cwd', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn(process.execPath, ['/node/path-cwd-child.js'], {
          cwd: '/node/workspace',
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.strictEqual(output, '/node/workspace/test.js\\n/node\\n');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/workspace/.keep': '',
        '/node/path-cwd-child.js': [
          "const path = require('node:path');",
          "process.stdout.write(path.resolve('test.js') + '\\n');",
          "process.stdout.write(path.dirname(path.resolve('.')) + '\\n');",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('resolves relative filesystem paths from each virtual process cwd', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const { spawn } = require('node:child_process');

      (async () => {
        const child = spawn(process.execPath, ['/node/fs-cwd-child.js'], {
          cwd: '/node/workspace',
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(JSON.parse(output), {
          cwd: '/node/workspace',
          exists: true,
          entries: ['fixture.js'],
        });
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `, {
      files: {
        '/node/workspace/test/fixture.js': '',
        '/node/fs-cwd-child.js': [
          "const fs = require('node:fs');",
          "process.stdout.write(JSON.stringify({ cwd: process.cwd(), exists: fs.existsSync('test'), entries: fs.readdirSync('test') }));",
        ].join('\n'),
      },
    });

    await expectPass(expect, result);
  });

  test('uses browser fetch and transport objects without a host socket', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      (async () => {
      const assert = require('node:assert');
      const request = new Request('data:text/plain,browser-fetch', {
        headers: { 'X-BNH-Test': 'present' },
      });
      const response = await fetch(request);
      assert.strictEqual(response.ok, true);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(await response.text(), 'browser-fetch');
      assert.strictEqual(request.headers.get('x-bnh-test'), 'present');
      assert.strictEqual(typeof WebSocket, 'function');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('kills a timed-out child through the bridge lifecycle', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const timer = setInterval(() => {}, 10);
      process.stdout.write('before-timeout');
      void timer;
    `, { timeoutMs: 50 });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
  });

  test('settles cluster workers before the primary exit event returns', async ({ harnessPage }) => {
    const result = await harnessPage.run(`
      const assert = require('node:assert');
      const cluster = require('node:cluster');
      const keepAlive = setInterval(() => {}, 1000);

      if (cluster.isWorker) {
        return;
      }

      (async () => {
        const worker = cluster.fork();
        await new Promise((resolve) => worker.once('online', resolve));
        process.once('exit', () => {
          assert.strictEqual(worker.isDead(), true);
          assert.strictEqual(worker.process.connected, false);
          assert.strictEqual(worker.process.state, 'failed');
          assert.notStrictEqual(worker.process.terminal, null);
        });
        clearInterval(keepAlive);
        process.exit(0);
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);

    await expectPass(expect, result);
  });

  test('awaits cancelled execution cleanup before child.kill returns', async ({ page }) => {
    await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const { createRuntime } = await import('/runtime.js');
      const runtime = createRuntime({ globalObject: globalThis });
      const originalProcess = globalThis.process;
      await runtime.mount({
        '/node/teardown-race.js': new TextEncoder().encode('setTimeout(() => {}, 50);'),
      });
      const child = await runtime.spawn(['node', '/node/teardown-race.js']);
      const kill = child.kill();
      const exit = await Promise.race([
        child.exit.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 10)),
      ]);
      await kill;
      return { exit, globalsRestored: globalThis.process === originalProcess };
    });

    expect(result.exit).toBe('resolved');
    expect(result.globalsRestored).toBe(true);
  });

});
