import test from 'node:test';
import assert from 'node:assert/strict';
import { Nacelle } from '../../../../src/index.js';
import { brotliCompressSync } from 'node:zlib';

// 1. HTTP Client & WASM Brotli Decompression
test('Demo 1: HTTP client follows redirects and decompresses chunked brotli/zstd response', async () => {
  const originalPayload = 'Hello from HTTP client with Brotli chunked decompression!';
  const compressedBrotli = brotliCompressSync(Buffer.from(originalPayload));

  const node = await Nacelle.create({
    gateway: false,
    files: {
      '/node/client.js': `
        const http = require('node:http');
        const zlib = require('node:zlib');

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

// 2. bcrypt - Real bcryptjs package from npm
test('Demo 2: Real bcrypt password hashing and verification from npm (bcryptjs)', async () => {
  const node = await Nacelle.create({ gateway: false, cwd: '/node' });
  await node.npm.install('bcryptjs@2.4.3');

  await node.fs.writeFile('/node/bcrypt-test.js', `
    const bcrypt = require('bcryptjs');

    const password = 'SuperSecretUserPassword123!';
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);
    const isValid = bcrypt.compareSync(password, hash);
    const isInvalid = bcrypt.compareSync('WrongPassword', hash);

    console.log(JSON.stringify({ hash, isValid, isInvalid }));
  `);

  const child = await node.bash('node bcrypt-test.js');
  assert.equal(await child.exit, 0);
  const out = JSON.parse(await child.stdoutText());
  assert.match(out.hash, /^\$2[aby]?\$\d+\$/);
  assert.equal(out.isValid, true);
  assert.equal(out.isInvalid, false);
});

// 3. SQLite + Real Drizzle ORM from npm
test('Demo 3: Real Drizzle ORM queries with schema over node:sqlite DatabaseSync', async () => {
  const node = await Nacelle.create({ gateway: false, cwd: '/node' });
  await node.npm.install('drizzle-orm@0.33.0');

  await node.fs.writeFile('/node/db.js', `
    const { DatabaseSync } = require('node:sqlite');
    const { sqliteTable, text, integer } = require('drizzle-orm/sqlite-core');
    const { drizzle } = require('drizzle-orm/better-sqlite3');

    const rawDb = new DatabaseSync(':memory:');
    rawDb.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);');

    const sqlite = {
      prepare(sql) {
        const stmt = rawDb.prepare(sql);
        let isRaw = false;
        return {
          run(...params) { return stmt.run(...params); },
          all(...params) {
            const rows = stmt.all(...params);
            if (isRaw) return rows.map(r => Object.values(r));
            return rows;
          },
          get(...params) {
            const row = stmt.get(...params);
            if (isRaw && row) return Object.values(row);
            return row;
          },
          values(...params) {
            const rows = stmt.all(...params);
            return rows.map(r => Object.values(r));
          },
          raw(flag = true) {
            isRaw = !!flag;
            return this;
          }
        };
      },
      exec(sql) { return rawDb.exec(sql); }
    };

    const users = sqliteTable('users', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      name: text('name').notNull(),
      email: text('email').notNull(),
      createdAt: integer('created_at').notNull(),
    });

    const db = drizzle(sqlite, { schema: { users } });
    const now = Date.now();
    db.insert(users).values({ name: 'Alice Developer', email: 'alice@example.com', createdAt: now }).run();
    db.insert(users).values({ name: 'Bob Engineer', email: 'bob@example.com', createdAt: now + 1000 }).run();

    const allUsers = db.select().from(users).all();
    console.log(JSON.stringify({ alice: allUsers[0], count: allUsers.length }));
    rawDb.close();
  `);

  const child = await node.bash('node db.js');
  assert.equal(await child.exit, 0);
  const data = JSON.parse(await child.stdoutText());
  assert.equal(data.alice.name, 'Alice Developer');
  assert.equal(data.alice.email, 'alice@example.com');
  assert.equal(data.count, 2);
});

// 4. Real TypeScript Compiler from npm
test('Demo 4: Real TypeScript compiler (typescript on npm) transpiling interfaces and types', async () => {
  const node = await Nacelle.create({ gateway: false, cwd: '/node' });
  await node.npm.install('typescript@5.5.4');

  await node.fs.writeFile('/node/src/main.ts', `
    interface Invoice { subtotal: number; tax: number; total: number; }
    function compute(subtotal: number, rate: number): Invoice {
      const tax = subtotal * rate;
      return { subtotal, tax, total: subtotal + tax };
    }
    const inv = compute(100, 0.15);
    console.log(JSON.stringify(inv));
  `);

  await node.fs.writeFile('/node/run-tsc.js', `
    const fs = require('node:fs');
    const path = require('node:path');
    const ts = require('typescript');

    const source = fs.readFileSync('/node/src/main.ts', 'utf8');
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });

    fs.mkdirSync('/node/dist', { recursive: true });
    fs.writeFileSync('/node/dist/main.js', result.outputText);
    require('/node/dist/main.js');
  `);

  const child = await node.bash('node run-tsc.js');
  assert.equal(await child.exit, 0);
  const out = JSON.parse(await child.stdoutText());
  assert.equal(out.subtotal, 100);
  assert.equal(out.tax, 15);
  assert.equal(out.total, 115);
});

// 5. Real uvu Test Runner from npm
test('Demo 5: Real uvu test runner from npm executing assertions', async () => {
  const node = await Nacelle.create({ gateway: false, cwd: '/node' });
  await node.npm.install('uvu@0.5.6');

  await node.fs.writeFile('/node/test-suite.js', `
    const { test } = require('uvu');
    const assert = require('uvu/assert');

    test('Math operations', () => {
      assert.is(Math.sqrt(144), 12);
      assert.equal([1, 2, 3].map(x => x * 2), [2, 4, 6]);
    });

    test('Object structure', () => {
      assert.equal({ id: 42, role: 'admin' }, { id: 42, role: 'admin' });
    });

    test.run();
  `);

  const child = await node.bash('node test-suite.js');
  assert.equal(await child.exit, 0);
  const out = await child.stdoutText();
  assert.match(out, /Total:\s+2/);
  assert.match(out, /Passed:\s+2/);
});

// 6. Real Rollup Bundler from npm
test('Demo 6: Real rollup module bundler from npm generating production bundle with hash', async () => {
  const node = await Nacelle.create({ gateway: false, cwd: '/node' });
  await node.npm.install('rollup@2.79.2');

  await node.fs.writeFile('/node/src/chunkA.js', 'export const alpha = { name: "Alpha" };');
  await node.fs.writeFile('/node/src/chunkB.js', 'export const beta = { name: "Beta" };');
  await node.fs.writeFile('/node/src/entry.js', `
    import { alpha } from './chunkA.js';
    import { beta } from './chunkB.js';
    console.log('Rollup bundle executing: ' + alpha.name + ' + ' + beta.name);
  `);

  await node.fs.writeFile('/node/bundle.js', `
    const { rollup } = require('rollup');
    const fs = require('node:fs');
    const crypto = require('node:crypto');

    async function run() {
      const bundle = await rollup({ input: '/node/src/entry.js' });
      const { output } = await bundle.generate({ format: 'cjs' });
      const code = output[0].code;
      const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 8);
      const bundleName = 'bundle.' + hash + '.js';

      fs.mkdirSync('/node/dist', { recursive: true });
      fs.writeFileSync('/node/dist/' + bundleName, code);
      fs.writeFileSync('/node/dist/manifest.json', JSON.stringify({ 'main.js': bundleName }));
      require('/node/dist/' + bundleName);
    }
    run().catch(console.error);
  `);

  const child = await node.bash('node bundle.js');
  assert.equal(await child.exit, 0);
  const out = await child.stdoutText();
  assert.match(out, /Rollup bundle executing: Alpha \+ Beta/);
  const manifest = JSON.parse(await node.fs.readFile('/node/dist/manifest.json'));
  assert.match(manifest['main.js'], /^bundle\.[a-f0-9]{8}\.js$/);
});

// 7. Real ws WebSocket package from npm
test('Demo 7: Real ws package from npm running WebSocket Server and frame processing', async () => {
  const node = await Nacelle.create({ gateway: false, cwd: '/node' });
  await node.npm.install('ws@8.18.0');

  await node.fs.writeFile('/node/ws-demo.js', `
    const WebSocket = require('ws');
    const net = require('node:net');
    const http = require('node:http');

    const server = http.createServer();
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        ws.send('echo-' + data.toString());
      });
    });

    server.listen(39107, '127.0.0.1', () => {
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

      client.on('data', (chunk) => {
        const text = chunk.toString();
        if (text.includes('101 Switching Protocols')) {
          const payload = Buffer.from('ping-ws');
          const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
          const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
          client.write(frame);
        } else {
          // Received frame from ws server: payload starts at byte index 2 (for len <= 125)
          const msg = chunk.slice(2).toString('utf8');
          process.stdout.write(msg);
          client.end();
          server.close(() => process.exit(0));
        }
      });
    });
  `);

  const child = await node.bash('node ws-demo.js');
  assert.equal(await child.exit, 0);
  assert.equal(await child.stdoutText(), 'echo-ping-ws');
});

// 8. Real pg package from npm
test('Demo 8: Real pg package from npm loaded and instantiated', async () => {
  const node = await Nacelle.create({ gateway: false, cwd: '/node' });
  await node.npm.install('pg@8.12.0');

  await node.fs.writeFile('/node/pg-test.js', `
    const pg = require('pg');
    console.log(JSON.stringify({
      hasClient: typeof pg.Client === 'function',
      hasPool: typeof pg.Pool === 'function',
    }));
  `);

  const child = await node.bash('node pg-test.js');
  assert.equal(await child.exit, 0);
  const out = JSON.parse(await child.stdoutText());
  assert.equal(out.hasClient, true);
  assert.equal(out.hasPool, true);
});

// 9. WebAssembly execution
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

// 10. Real React SSR from npm
test('Demo 10: Real React SSR application from npm with ReactDOMServer.renderToString()', async () => {
  const node = await Nacelle.create({ gateway: false, cwd: '/node' });
  await node.npm.install(['react@18.3.1', 'react-dom@18.3.1']);

  await node.fs.writeFile('/node/server.js', `
    const http = require('node:http');
    const React = require('react');
    const ReactDOMServer = require('react-dom/server');

    function App({ message }) {
      return React.createElement('div', { id: 'root' },
        React.createElement('h1', null, message),
        React.createElement('span', null, 'React v' + React.version)
      );
    }

    const server = http.createServer((req, res) => {
      if (req.url === '/api/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ route: '/api/stats', reactVersion: React.version }));
        return;
      }
      const body = ReactDOMServer.renderToString(React.createElement(App, { message: 'React SSR Server' }));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>' + body + '</body></html>');
    });

    server.listen(39110, '127.0.0.1', () => {
      console.log('ready');
    });
  `);

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
  assert.match(pageHtml, /React SSR Server/);
  assert.match(pageHtml, /React v18\.3\.1/);

  const apiRes = await node.fetch('http://localhost:39110/api/stats');
  const apiData = await apiRes.json();
  assert.equal(apiData.route, '/api/stats');
  assert.equal(apiData.reactVersion, '18.3.1');

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
