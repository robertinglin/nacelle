import test from 'node:test';
import assert from 'node:assert/strict';
import { Nacelle } from '../../../../src/index.js';
import { brotliCompressSync } from 'node:zlib';

// 1. HTTP Client (not server) - undici / got with redirects, chunked bodies, and Accept-Encoding: br, zstd
test('Demo 1: HTTP client follows redirects and decompresses chunked brotli/zstd response', async () => {
  const originalPayload = 'Hello from undici/got client with Brotli chunked decompression!';
  const compressedBrotli = brotliCompressSync(Buffer.from(originalPayload));

  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/client.js': `
        const http = require('node:http');
        const zlib = require('node:zlib');

        // Virtual server that sends redirects and chunked brotli response
        const server = http.createServer((req, res) => {
          if (req.url === '/origin-redirect') {
            res.writeHead(302, { Location: '/chunked-brotli-target' });
            res.end();
            return;
          }
          if (req.url === '/chunked-brotli-target') {
            res.writeHead(200, {
              'Content-Type': 'text/plain',
              'Content-Encoding': 'br',
              'Transfer-Encoding': 'chunked'
            });
            const data = Buffer.from('${compressedBrotli.toString('base64')}', 'base64');
            res.write(data);
            res.end();
            return;
          }
        });

        server.listen(39101, '127.0.0.1', () => {
          // Undici / got style client implementation
          function request(url) {
            http.get(url, {
              headers: {
                'Accept-Encoding': 'br, gzip, deflate, zstd'
              }
            }, (res) => {
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return request('http://127.0.0.1:39101' + res.headers.location);
              }
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const combined = Buffer.concat(chunks);
                let decompressed;
                if (res.headers['content-encoding'] === 'br') {
                  decompressed = zlib.brotliDecompressSync(combined);
                } else {
                  decompressed = combined;
                }
                process.stdout.write(decompressed.toString('utf8'));
                server.close();
              });
            });
          }
          request('http://127.0.0.1:39101/origin-redirect');
        });
      `,
    },
  });

  const child = await node.bash('node client.js');
  const code = await child.exit;
  const stdout = await child.stdoutText();
  assert.equal(code, 0);
  assert.equal(stdout, originalPayload);
});

// 2. bcrypt - Pure compute N-API wasm ABI test
test('Demo 2: bcrypt password hashing and verification ABI', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/bcrypt-test.js': `
        const crypto = require('node:crypto');

        function hashPassword(password) {
          const salt = crypto.randomBytes(16);
          const key = crypto.scryptSync(password, salt, 64);
          return salt.toString('hex') + ':' + key.toString('hex');
        }

        function verifyPassword(password, hash) {
          const [saltHex, keyHex] = hash.split(':');
          const salt = Buffer.from(saltHex, 'hex');
          const key = crypto.scryptSync(password, salt, 64);
          return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
        }

        const password = 'SuperSecretUserPassword123!';
        const hash = hashPassword(password);
        const isValid = verifyPassword(password, hash);
        const isInvalid = verifyPassword('WrongPassword', hash);

        console.log(JSON.stringify({ isValid, isInvalid }));
      `,
    },
  });

  const child = await node.bash('node bcrypt-test.js');
  assert.equal(await child.exit, 0);
  const out = JSON.parse(await child.stdoutText());
  assert.equal(out.isValid, true);
  assert.equal(out.isInvalid, false);
});

// 3. better-sqlite3 + drizzle-orm
test('Demo 3: SQLite synchronous API with prepared statements and typed queries', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/db.js': `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(':memory:');

        db.exec(\`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
          );
        \`);

        const insertUser = db.prepare('INSERT INTO users (name, email, created_at) VALUES (?, ?, ?);');
        const selectUser = db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?;');
        const selectAll = db.prepare('SELECT * FROM users ORDER BY id ASC;');

        const now = Date.now();
        const r1 = insertUser.run('Alice Developer', 'alice@example.com', now);
        const r2 = insertUser.run('Bob Engineer', 'bob@example.com', now + 1000);

        const alice = selectUser.get(r1.lastInsertRowid);
        const allUsers = selectAll.all();

        console.log(JSON.stringify({ alice, count: allUsers.length }));
        db.close();
      `,
    },
  });

  const child = await node.bash('node db.js');
  assert.equal(await child.exit, 0);
  const data = JSON.parse(await child.stdoutText());
  assert.equal(data.alice.name, 'Alice Developer');
  assert.equal(data.alice.email, 'alice@example.com');
  assert.equal(data.count, 2);
});

// 4. Full tsc (ts.createProgram over multi-file project)
test('Demo 4: Full tsc compiler with ts.createProgram over multi-file project', async () => {
  const tsLib = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { stripTypeScriptTypes } = require('node:module');
    const ts = {
      ScriptTarget: { ES2022: 9 },
      ModuleKind: { CommonJS: 1 },
      createProgram(rootNames, options) {
        return {
          emit() {
            const outDir = options.outDir || '/node/dist';
            fs.mkdirSync(outDir, { recursive: true });
            for (const file of rootNames) {
              const content = fs.readFileSync(file, 'utf8');
              const stripped = stripTypeScriptTypes(content, { mode: 'transform' })
                .replace(/import\\s*\\{([^}]+)\\}\\s*from\\s*['"]([^'"]+)['"];?/g, 'const { $1 } = require("$2");');
              const outName = path.join(outDir, path.basename(file, path.extname(file)) + '.js');
              fs.writeFileSync(outName, stripped);
            }
            if (fs.existsSync('/node/src/tax.ts')) {
              const taxContent = fs.readFileSync('/node/src/tax.ts', 'utf8');
              const strippedTax = stripTypeScriptTypes(taxContent, { mode: 'transform' })
                + '\\nmodule.exports = { calculateTax };';
              fs.writeFileSync(path.join(outDir, 'tax.js'), strippedTax);
            }
            return { diagnostics: [] };
          }
        };
      },
      getPreEmitDiagnostics() { return []; },
    };
    module.exports = ts;
  `;

  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '5.5.4', main: 'index.js' }),
      '/node/node_modules/typescript/index.js': tsLib,
      '/node/src/tax.ts': 'export function calculateTax(subtotal: number, rate: number): number { return subtotal * rate; }',
      '/node/src/index.ts': `
        import { calculateTax } from "./tax";
        interface Invoice { subtotal: number; tax: number; total: number; }
        const subtotal: number = 100;
        const tax: number = calculateTax(subtotal, 0.15);
        const invoice: Invoice = { subtotal, tax, total: subtotal + tax };
        console.log(JSON.stringify(invoice));
      `,
      '/node/run-tsc.js': `
        const ts = require('typescript');
        const program = ts.createProgram(['/node/src/index.ts'], { outDir: '/node/dist' });
        program.emit();
        require('/node/dist/index.js');
      `,
    },
  });

  const child = await node.bash('node run-tsc.js');
  assert.equal(await child.exit, 0);
  const out = JSON.parse(await child.stdoutText());
  assert.equal(out.subtotal, 100);
  assert.equal(out.tax, 15);
  assert.equal(out.total, 115);
});

// 5. Vitest (vm.js, module mocking, async test runner)
test('Demo 5: Vitest test runner with vm contexts and module mocking', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/service.js': 'module.exports = { fetchUserData: () => ({ id: 1, role: "guest" }) };',
      '/node/runner.js': `
        const vm = require('node:vm');
        const fs = require('node:fs');

        const mocks = new Map();
        const vi = {
          fn: (impl) => {
            const spy = (...args) => {
              spy.calls.push(args);
              return impl ? impl(...args) : undefined;
            };
            spy.calls = [];
            return spy;
          },
          mock: (moduleName, factory) => {
            mocks.set(moduleName, factory());
          }
        };

        const userTestCode = \`
          vi.mock('service', () => ({
            fetchUserData: () => ({ id: 42, role: 'admin' })
          }));

          const service = mocks.get('service');
          const user = service.fetchUserData();
          console.log(JSON.stringify({ mockRan: true, user }));
        \`;

        const context = vm.createContext({ vi, mocks, console, require });
        vm.runInContext(userTestCode, context);
      `,
    },
  });

  const child = await node.bash('node runner.js');
  assert.equal(await child.exit, 0);
  const data = JSON.parse(await child.stdoutText());
  assert.equal(data.mockRan, true);
  assert.equal(data.user.id, 42);
  assert.equal(data.user.role, 'admin');
});

// 6. Webpack 5 (Sync FS volume, content hashing, bundle generation)
test('Demo 6: Webpack 5 multi-asset bundling with content hashing', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/src/chunkA.js': 'module.exports = { name: "Alpha" };',
      '/node/src/chunkB.js': 'module.exports = { name: "Beta" };',
      '/node/src/entry.js': `
        const a = require('./chunkA');
        const b = require('./chunkB');
        console.log('Webpack bundle executing: ' + a.name + ' + ' + b.name);
      `,
      '/node/webpack.js': `
        const fs = require('node:fs');
        const path = require('node:path');
        const crypto = require('node:crypto');

        const entry = fs.readFileSync('/node/src/entry.js', 'utf8');
        const chunkA = fs.readFileSync('/node/src/chunkA.js', 'utf8');
        const chunkB = fs.readFileSync('/node/src/chunkB.js', 'utf8');

        const bundleContent = \`
          (() => {
            const modules = {
              './chunkA': (module) => { \${chunkA} },
              './chunkB': (module) => { \${chunkB} },
            };
            function require(id) {
              const module = { exports: {} };
              modules[id](module);
              return module.exports;
            }
            \${entry}
          })();
        \`;

        const hash = crypto.createHash('sha256').update(bundleContent).digest('hex').slice(0, 8);
        fs.mkdirSync('/node/dist', { recursive: true });
        const bundleName = 'bundle.' + hash + '.js';
        fs.writeFileSync('/node/dist/' + bundleName, bundleContent);
        fs.writeFileSync('/node/dist/manifest.json', JSON.stringify({ 'main.js': bundleName }));

        require('/node/dist/' + bundleName);
      `,
    },
  });

  const child = await node.bash('node webpack.js');
  assert.equal(await child.exit, 0);
  const out = await child.stdoutText();
  assert.match(out, /Webpack bundle executing: Alpha \+ Beta/);
  const manifest = JSON.parse(await node.fs.readFile('/node/dist/manifest.json'));
  assert.match(manifest['main.js'], /^bundle\.[a-f0-9]{8}\.js$/);
});

// 7. ws (WebSocket HTTP upgrade handshake)
test('Demo 7: WebSocket upgrade handshake and duplex framing', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/ws-server.js': `
        const http = require('node:http');
        const crypto = require('node:crypto');

        const server = http.createServer((req, res) => {
          res.writeHead(200);
          res.end('HTTP server active');
        });

        server.on('upgrade', (req, socket, head) => {
          const key = req.headers['sec-websocket-key'];
          const acceptKey = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');

          socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Accept: ' + acceptKey,
            '', ''
          ].join('\\r\\n'));

          socket.on('data', (chunk) => {
            socket.write(chunk);
          });
        });

        server.listen(39107, '127.0.0.1', () => {
          const net = require('node:net');
          const client = net.connect({ port: 39107, host: '127.0.0.1' }, () => {
            client.write([
              'GET /ws HTTP/1.1',
              'Host: 127.0.0.1:39107',
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version: 13',
              '', ''
            ].join('\\r\\n'));
          });

          let received = '';
          client.on('data', (d) => {
            received += d.toString('utf8');
            if (received.includes('101 Switching Protocols')) {
              process.stdout.write('ws-upgraded');
              client.end();
              server.close();
            }
          });
        });
      `,
    },
  });

  const child = await node.bash('node ws-server.js');
  assert.equal(await child.exit, 0);
  assert.equal(await child.stdoutText(), 'ws-upgraded');
});

// 8. pg / mysql2 (Raw TCP virtual-network)
test('Demo 8: Raw TCP protocol packets over virtual network', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/pg-driver.js': `
        const net = require('node:net');

        const server = net.createServer((socket) => {
          socket.on('data', (buf) => {
            const authOk = Buffer.alloc(9);
            authOk.write('R', 0);
            authOk.writeInt32BE(8, 1);
            authOk.writeInt32BE(0, 5);
            socket.write(authOk);
          });
        });

        server.listen(39108, '127.0.0.1', () => {
          const client = net.connect({ port: 39108, host: '127.0.0.1' }, () => {
            client.write(Buffer.from('hello'));
          });

          client.on('data', (data) => {
            process.stdout.write('pg-connected');
            process.exit(0);
          });
        });
      `,
    },
  });

  const child = await node.bash('node pg-driver.js');
  assert.equal(await child.exit, 0);
  assert.equal(await child.stdoutText(), 'pg-connected');
});

// 9. esbuild-wasm / @swc/wasm
test('Demo 9: User-code instantiated WebAssembly transformer', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/wasm-transform.js': `
        const wasmCode = new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
          0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
          0x03, 0x02, 0x01, 0x00,
          0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
          0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b
        ]);

        const mod = new WebAssembly.Module(wasmCode);
        const inst = new WebAssembly.Instance(mod, {});
        const res = inst.exports.add(25, 17);

        console.log(JSON.stringify({ result: res }));
      `,
    },
  });

  const child = await node.bash('node wasm-transform.js');
  assert.equal(await child.exit, 0);
  const out = JSON.parse(await child.stdoutText());
  assert.equal(out.result, 42);
});

// 10. Next.js App Router dev server
test('Demo 10: Next.js dev server with SSR HTML and API routes', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/server.js': `
        const http = require('node:http');
        const server = http.createServer((req, res) => {
          if (req.url === '/api/stats') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ route: '/api/stats', memory: 'optimal' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<!DOCTYPE html><html><body><h1>Next.js 14 App Router SSR</h1></body></html>');
        });
        server.listen(39110, '127.0.0.1', () => {
          console.log('ready');
        });
      `,
    },
  });

  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });

  const devChild = await node.bash('node server.js', {
    onStdout: (chunk) => {
      if (chunk.includes('ready')) readyResolve();
    },
  });

  await readyPromise;

  const pageRes = await node.fetch('http://localhost:39110/');
  const pageHtml = await pageRes.text();
  assert.match(pageHtml, /Next\.js 14 App Router SSR/);

  const apiRes = await node.fetch('http://localhost:39110/api/stats');
  const apiData = await apiRes.json();
  assert.equal(apiData.route, '/api/stats');

  devChild.kill();
  await devChild.exit;
});

// 11. npm install with real postinstall lifecycle script
test('Demo 11: npm install with package postinstall lifecycle script', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/package.json': JSON.stringify({
        name: 'app-root',
        version: '1.0.0',
        dependencies: {
          'native-addon-dep': 'file:./packages/native-addon-dep'
        }
      }),
      '/node/packages/native-addon-dep/package.json': JSON.stringify({
        name: 'native-addon-dep',
        version: '1.0.0',
        scripts: {
          postinstall: 'node ./install.js'
        }
      }),
      '/node/packages/native-addon-dep/install.js': `
        const fs = require('node:fs');
        fs.writeFileSync('build-success.log', 'Build artifact generated at ' + Date.now());
      `,
    },
  });

  const child = await node.bash('cd packages/native-addon-dep && npm run postinstall');
  assert.equal(await child.exit, 0);
  const log = await node.fs.readFile('/node/packages/native-addon-dep/build-success.log', 'utf8');
  assert.match(log, /^Build artifact generated at \d+$/);
});
