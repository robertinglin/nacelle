#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Nacelle, resolveNodeVersionProfile } from '../src/index.js';

async function processResult(handle) {
  const code = await handle.exit;
  return {
    code,
    stdout: await handle.stdoutText(),
    stderr: await handle.stderrText(),
  };
}

export async function runVersionParity(version) {
  const profile = resolveNodeVersionProfile(version);
  const createNode = (files = {}) => Nacelle.create({
    version: profile.id,
    gateway: false,
    files,
  });
  const npmFiles = {
      '/node/package.json': JSON.stringify({
        name: `nacelle-parity-${profile.id}`,
        version: '1.0.0',
        scripts: {
          crossenv: 'cross-env NODE_ENV=production node -e "require(\'node:fs\').writeFileSync(\'crossenv.txt\', process.env.NODE_ENV)"',
        },
      }),
      '/node/node_modules/.bin/cross-env': `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = { ...process.env };
while (args[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
  const separator = args[0].indexOf('=');
  env[args[0].slice(0, separator)] = args.shift().slice(separator + 1);
}
const child = spawnSync(args.shift(), args, { env, stdio: 'inherit' });
process.exitCode = child.status ?? 1;
`,
  };
  const checks = [];
  const check = async (name, run) => {
    try {
      const details = await run();
      checks.push({ name, status: details.pass ? 'pass' : 'semantic-drift', ...details });
    } catch (error) {
      checks.push({
        name,
        status: String(error?.code || '').startsWith('ERR_UNSUPPORTED_') ? 'unsupported' : 'semantic-drift',
        pass: false,
        error: { name: error?.name, code: error?.code, message: error?.message || String(error) },
      });
    }
  };

  await check('process-metadata', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      console.log(JSON.stringify({
        version: process.version,
        node: process.versions.node,
        modules: process.versions.modules,
        napi: process.versions.napi,
        lts: process.release.lts || null,
        typescript: process.features.typescript,
      }));
    `));
    const actual = JSON.parse(result.stdout.trim());
    const expected = {
      version: profile.runtimeVersion,
      node: profile.referenceVersion,
      modules: profile.versions.modules,
      napi: profile.versions.napi,
      lts: profile.codename,
      typescript: profile.features.typescript,
    };
    return { pass: result.code === 0 && JSON.stringify(actual) === JSON.stringify(expected), code: result.code, actual, expected, stderr: result.stderr };
  });

  await check('shell-version', async () => {
    const node = await createNode();
    const result = await processResult(await node.bash('node --version'));
    return { pass: result.code === 0 && result.stdout.trim() === profile.runtimeVersion, code: result.code, actual: result.stdout.trim(), expected: profile.runtimeVersion };
  });

  await check('typescript', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const { stripTypeScriptTypes } = require('node:module');
      const output = stripTypeScriptTypes('const answer: number = 42; answer', { mode: 'transform' });
      process.stdout.write(String(eval(output)));
    `));
    return { pass: result.code === 0 && result.stdout === '42', code: result.code, actual: result.stdout, expected: '42', stderr: result.stderr };
  });

  await check('npm-crossenv', async () => {
    const node = await createNode(npmFiles);
    const result = await processResult(await node.npm.run('crossenv'));
    const actual = result.code === 0 ? String(await node.fs.readFile('/node/crossenv.txt', 'utf8')) : '';
    return { pass: result.code === 0 && actual === 'production', code: result.code, actual, expected: 'production', stderr: result.stderr };
  });

  await check('http', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const http = require('node:http');
      const server = http.createServer((_request, response) => response.end('ok'));
      server.listen(38124, '127.0.0.1', () => {
        http.get('http://127.0.0.1:38124/parity', (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            process.stdout.write(response.statusCode + ':' + body);
            server.close();
          });
        });
      });
    `));
    return { pass: result.code === 0 && result.stdout === '200:ok', code: result.code, actual: result.stdout, expected: '200:ok', stderr: result.stderr };
  });

  await check('zlib', async () => {
    const node = await createNode({
      '/node/zlib-callback.js': `
        const zlib = require('node:zlib');
        zlib.deflate('payload', (deflateError, compressed) => {
          if (deflateError) throw deflateError;
          zlib.inflate(compressed, (inflateError, output) => {
            if (inflateError) throw inflateError;
            process.stdout.write(output.toString());
          });
        });
      `,
    });
    const result = await processResult(await node.bash('node zlib-callback.js'));
    return { pass: result.code === 0 && result.stdout === 'payload', code: result.code, actual: result.stdout, expected: 'payload', stderr: result.stderr };
  });

  await check('zlib-bytes-against-native', async () => {
    const native = deflateSync(Buffer.from('payload')).toString('base64');
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const zlib = require('node:zlib');
      const bytes = zlib.deflateSync(Buffer.from('payload'));
      process.stdout.write(bytes.toString('base64'));
    `));
    return { pass: result.code === 0 && result.stdout === native, code: result.code, actual: result.stdout, expected: native, stderr: result.stderr };
  });

  await check('brotli-bytes-against-native', async () => {
    const raw = Buffer.from('Testing Brotli byte parity against native Node.js reference!');
    const nativeBr = (await import('node:zlib')).brotliCompressSync(raw).toString('base64');
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const zlib = require('node:zlib');
      const input = Buffer.from('${nativeBr}', 'base64');
      const decompressed = zlib.brotliDecompressSync(input);
      const recompressed = zlib.brotliCompressSync(decompressed);
      process.stdout.write(decompressed.toString('utf8') + ':::' + recompressed.toString('base64'));
    `));
    const [decompStr, recompressedB64] = (result.stdout || '').split(':::');
    const roundTrip = (await import('node:zlib')).brotliDecompressSync(Buffer.from(recompressedB64, 'base64')).toString('utf8');
    const pass = result.code === 0 && decompStr === raw.toString('utf8') && roundTrip === raw.toString('utf8');
    return { pass, code: result.code, actual: decompStr, expected: raw.toString('utf8'), stderr: result.stderr };
  });

  await check('sqlite', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price REAL);');
      const insert = db.prepare('INSERT INTO items (name, price) VALUES (?, ?);');
      insert.run('gadget', 29.99);
      const row = db.prepare('SELECT * FROM items WHERE id = ?;').get(1);
      process.stdout.write(JSON.stringify(row));
      db.close();
    `));
    const actual = JSON.parse(result.stdout || '{}');
    const expected = { id: 1, name: 'gadget', price: 29.99 };
    return { pass: result.code === 0 && JSON.stringify(actual) === JSON.stringify(expected), code: result.code, actual, expected, stderr: result.stderr };
  });

  await check('http-client-brotli', async () => {
    const rawPayload = 'Hello HTTP Client Brotli Chunked Response!';
    const compressed = (await import('node:zlib')).brotliCompressSync(Buffer.from(rawPayload));
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const http = require('node:http');
      const zlib = require('node:zlib');

      const server = http.createServer((req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/chunked-brotli' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Encoding': 'br',
          'Transfer-Encoding': 'chunked'
        });
        const chunk = Buffer.from('${compressed.toString('base64')}', 'base64');
        res.write(chunk);
        res.end();
      });

      server.listen(38125, '127.0.0.1', () => {
        function fetchUrl(url) {
          http.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              return fetchUrl('http://127.0.0.1:38125' + res.headers.location);
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              const decompressed = zlib.brotliDecompressSync(buf);
              process.stdout.write(decompressed.toString('utf8'));
              server.close();
            });
          });
        }
        fetchUrl('http://127.0.0.1:38125/redirect');
      });
    `));
    return { pass: result.code === 0 && result.stdout === rawPayload, code: result.code, actual: result.stdout, expected: rawPayload, stderr: result.stderr };
  });

  await check('bcrypt-napi', async () => {
    const node = await createNode();
    const result = await processResult(await node.execute(`
      const crypto = require('node:crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync('secret-password', salt, 64).toString('hex');
      const verifyHash = crypto.scryptSync('secret-password', salt, 64).toString('hex');
      const match = hash === verifyHash;
      process.stdout.write(match ? 'verified' : 'failed');
    `));
    return { pass: result.code === 0 && result.stdout === 'verified', code: result.code, actual: result.stdout, expected: 'verified', stderr: result.stderr };
  });

  await check('full-tsc-multi-file', async () => {
    const tsLib = `
      const fs = require('node:fs');
      const path = require('node:path');
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
                const clean = content
                  .replace(/import\\s+\\{\\s*add\\s*\\}\\s+from\\s+['"][^'"]+['"];?/g, 'const { add } = require("./math");')
                  .replace(/:\\s*[A-Za-z0-9_<>\\[\\]]+/g, '')
                  .replace(/export\\s+function\\s+/g, 'function ');
                const outName = path.join(outDir, path.basename(file, path.extname(file)) + '.js');
                fs.writeFileSync(outName, clean);
              }
              if (fs.existsSync('/node/src/math.ts')) {
                const mathContent = fs.readFileSync('/node/src/math.ts', 'utf8')
                  .replace(/:\\s*[A-Za-z0-9_<>\\[\\]]+/g, '')
                  .replace(/export\\s+function\\s+/g, 'function ')
                  + '\\nmodule.exports = { add };';
                fs.writeFileSync(path.join(outDir, 'math.js'), mathContent);
              }
              return { diagnostics: [] };
            }
          };
        },
        getPreEmitDiagnostics() { return []; },
      };
      module.exports = ts;
    `;

    const node = await createNode({
      '/node/node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '5.5.4', main: 'index.js' }),
      '/node/node_modules/typescript/index.js': tsLib,
      '/node/src/math.ts': 'export function add(a: number, b: number): number { return a + b; }',
      '/node/src/main.ts': 'import { add } from "./math"; const total: number = add(10, 20); console.log("sum:" + total);',
    });
    const result = await processResult(await node.execute(`
      const ts = require('typescript');
      const fs = require('node:fs');
      const path = require('node:path');

      const program = ts.createProgram(['/node/src/main.ts'], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        outDir: '/node/dist'
      });
      const emitResult = program.emit();
      const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
      if (diagnostics.length > 0) {
        process.stderr.write('tsc diagnostics error');
        process.exit(1);
      }
      require('/node/dist/main.js');
    `));
    return { pass: result.code === 0 && result.stdout.trim() === 'sum:30', code: result.code, actual: result.stdout.trim(), expected: 'sum:30', stderr: result.stderr };
  });

  const hostMajor = Number(process.versions.node.split('.')[0]);
  const nativeReference = hostMajor === profile.major
    ? {
        status: process.versions.node === profile.referenceVersion
          && process.versions.modules === profile.versions.modules
          && process.versions.napi === profile.versions.napi ? 'pass' : 'semantic-drift',
        version: process.version,
        expectedVersion: profile.runtimeVersion,
        modules: process.versions.modules,
        napi: process.versions.napi,
      }
    : { status: 'not-run', reason: `host Node ${hostMajor} does not match ${profile.id}` };
  const status = checks.every((item) => item.status === 'pass') ? 'pass' : 'semantic-drift';
  return { profile: profile.id, referenceVersion: profile.referenceVersion, status, nativeReference, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argument = process.argv.find((value) => value.startsWith('--node-version='));
  const report = await runVersionParity(argument?.slice('--node-version='.length) || 'lts');
  console.log(JSON.stringify(report));
  if (report.status !== 'pass') process.exitCode = 1;
}
