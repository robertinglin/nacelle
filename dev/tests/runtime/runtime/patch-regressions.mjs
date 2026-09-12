import assert from 'node:assert/strict';
import test from 'node:test';
import { Nacelle, createBrowserNet, createBufferClass } from '../../../../src/index.js';
import { createVfs } from '../../../../src/runtime/vfs.js';
import { BrowserNpm, satisfiesSemver } from '../../../../src/runtime/npm.js';
import { packTarGz } from '../../../../src/runtime/tar.js';
import { runShellScript } from '../../../../src/runtime/shell.js';
import { parseShellScript } from '../../../../src/runtime/shell-parser.js';

// Keep watchdogs outside the guest's timer/process shims.
const host = { Promise, setTimeout, clearTimeout };
async function run(source, files = {}) {
  const node = await Nacelle.create({ gateway: false, files: {
    '/node/entry.cjs': source, ...files,
  } });
  const controller = new AbortController();
  const timer = host.setTimeout(() => controller.abort(new Error('regression fixture timed out')), 3000);
  try {
    const child = await node.run({ entry: '/node/entry.cjs', timeout: 2500, signal: controller.signal });
    const code = await child.exit;
    const stdout = await child.stdoutText();
    const stderr = await child.stderrText();
    assert.equal(code, 0, stderr || stdout);
    return { stdout, stderr, node };
  } finally { host.clearTimeout(timer); }
}

const valueFiles = { '/node/value.cjs': 'module.exports = 42;' };

test('child Module._load resolves package subpaths and a nested package main', async () => {
  const { stdout } = await run(`
    const { spawnSync } = require('child_process');
    const c = spawnSync(process.execPath, ['-e', 'console.log(require("fixture/dist/shared/lib/wrapper"))']);
    if (c.status) throw new Error(String(c.stderr));
    process.stdout.write(c.stdout);
  `, {
    '/node/node_modules/fixture/package.json': '{"name":"fixture","main":"index.js"}',
    '/node/node_modules/fixture/dist/shared/lib/wrapper.js': `module.exports = require('module')._load('fixture/dist/compiled/value', module);`,
    '/node/node_modules/fixture/dist/compiled/value/package.json': '{"main":"index.cjs"}',
    '/node/node_modules/fixture/dist/compiled/value/index.cjs': 'module.exports = 42;',
  });
  assert.equal(stdout, '42\n');
});

test('CommonJS require honors an overridden public Module._resolveFilename', async () => {
  const { stdout } = await run(`
    const M = require('module'); const resolve = M._resolveFilename;
    M._resolveFilename = function (name, ...args) {
      return resolve.call(this, name === 'alias' ? './value.cjs' : name, ...args);
    };
    console.log(require('alias'));
  `, valueFiles);
  assert.equal(stdout, '42\n');
});

test('failed CommonJS and JSON modules do not leave usable cache entries', async () => {
  const { stdout } = await run(`
    for (let i = 0; i < 2; i++) try { require('./bad.cjs'); } catch (e) { console.log(e.message); }
    for (let i = 0; i < 2; i++) try { require('./bad.json'); } catch (e) { console.log(e.name); }
  `, { '/node/bad.cjs': 'throw new Error("BOOM")', '/node/bad.json': '{bad' });
  assert.equal(stdout, 'BOOM\nBOOM\nSyntaxError\nSyntaxError\n');
});

test('Function-created dynamic imports use the virtual module loader', async () => {
  const { stdout } = await run(`
    const load = new Function('return import("./value.mjs")');
    load().then(m => console.log(m.default));
  `, { '/node/value.mjs': 'export default 42;' });
  assert.equal(stdout, '42\n');
});

test('nested guest Function constructors do not duplicate the import parameter', async () => {
  const { stdout } = await run(`
    require('./nested.cjs');
    console.log('ok');
  `, {
    '/node/nested.cjs': `
      const generated = 'const value = go.importObject;';
      new Function('require', 'WebAssembly', generated);
    `,
  });
  assert.equal(stdout, 'ok\n');
});

test('async filesystem callbacks retain the owning child working directory', async () => {
  const { stdout } = await run(`
    const fs = require('fs');
    process.chdir('/node/work');
    setTimeout(() => fs.stat('missing.txt', (error) => {
      if (process.cwd() !== '/node/work') throw new Error('child cwd was lost');
      if (error?.code !== 'ENOENT' || error.path !== '/node/work/missing.txt') throw error;
      console.log('ok');
    }), 0);
  `, { '/node/work/placeholder': '' });
  assert.equal(stdout, 'ok\n');
});

test('process-bound fs resolves WASM-style relative paths after child bootstrap', async () => {
  const { stdout } = await run(`
    const fs = require('fs');
    process.chdir('/node/work');
    setTimeout(() => fs.stat('present.txt', (error, stats) => {
      if (error || !stats.isFile()) throw error || new Error('relative stat failed');
      console.log('ok');
    }), 0);
  `, { '/node/work/present.txt': 'ok' });
  assert.equal(stdout, 'ok\n');
});

test('high-volume unobserved timers do not pay destroy grace per callback', async () => {
  const { stdout } = await run(`
    (async () => {
      const work = [];
      for (let i = 0; i < 10_000; i++) {
        work.push(new Promise(resolve => setTimeout(resolve, 0)));
      }
      await Promise.all(work);
      console.log('timers done');
    })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
  `);
  assert.equal(stdout, 'timers done\n');
});

test('unref timers still run while a process-owned refed timer keeps the loop alive', async () => {
  const { stdout } = await run(`
    const unrefed = setTimeout(() => console.log('unref fired'), 0);
    unrefed.unref();
    setTimeout(() => console.log('ref fired'), 20);
  `);
  assert.equal(stdout, 'unref fired\nref fired\n');
});

test('process-bound fs preserves stream and promisifier behavior', async () => {
  const { stdout } = await run(`
    const fs = require('fs');
    const { promisify } = require('util');
    process.chdir('/node/work');
    (async () => {
      const exists = await promisify(fs.exists)('present.txt');
      if (!exists) throw new Error('promisified exists failed');
      const chunks = [];
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream('present.txt');
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      if (Buffer.concat(chunks).toString() !== 'stream-ok') throw new Error('relative stream read failed');
      console.log('ok');
    })().catch((error) => { throw error; });
  `, { '/node/work/present.txt': 'stream-ok' });
  assert.equal(stdout, 'ok\n');
});

test('WebAssembly promise callbacks retain the owning child process', async () => {
  const { stdout } = await run(`
    process.chdir('/node/work');
    const bytes = Buffer.from('0061736d01000000', 'hex');
    WebAssembly.instantiate(bytes).then(() => {
      if (process.cwd() !== '/node/work') throw new Error('WASM promise lost child cwd');
      console.log('ok');
    });
  `, { '/node/work/placeholder': '' });
  assert.equal(stdout, 'ok\n');
});

test('nested virtual children receive process-bound fs modules', async () => {
  const { stdout } = await run(`
    const { spawnSync } = require('child_process');
    const child = spawnSync(process.execPath, ['-e',
      'const fs = require("fs"); if (!fs.statSync("present.txt").isFile()) process.exit(2); console.log(process.cwd())',
    ], { cwd: '/node/work', encoding: 'utf8' });
    if (child.status !== 0) throw new Error(child.stderr || 'nested fs child failed');
    process.stdout.write(child.stdout);
  `, { '/node/work/present.txt': 'ok' });
  assert.equal(stdout, '/node/work\n');
});

test('async ESM child filesystem mutations return to the parent VFS', async () => {
  const { stdout } = await run(`
    const fs = require('fs');
    const child = require('child_process').spawn(process.execPath, ['/node/write.mjs'], { cwd: '/node/work' });
    child.on('error', (error) => { throw error; });
    child.on('close', (code) => {
      if (code !== 0) throw new Error('ESM child failed: ' + code);
      console.log(fs.readFileSync('/node/work/generated.txt', 'utf8'));
    });
  `, {
    '/node/write.mjs': `import { writeFile } from 'node:fs/promises'; await writeFile('generated.txt', 'child-ok');`,
    '/node/work/placeholder': '',
  });
  assert.equal(stdout, 'child-ok\n');
});

test('ESM children settle concurrent fs.promises probes during top-level await', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(
      process.execPath,
      ['/node/probe.mjs'],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (error) => { throw error; });
    child.on('close', (code) => { if (code !== 0) throw new Error('probe child failed: ' + code); });
  `, {
    '/node/probe.mjs': `
      import { lstat, readdir, readFile } from 'node:fs/promises';
      const results = await Promise.all([
        lstat('/node/probe.mjs'),
        readdir('/node'),
        readFile('/node/probe.mjs', 'utf8'),
        lstat('/node/probe.mjs'),
      ]);
      if (!results[0].isFile() || !results[1].includes('probe.mjs') || !results[2].includes('Promise.all')) throw new Error('probe mismatch');
      console.log('probes done');
    `,
  });
  assert.equal(stdout, 'probes done\n');
});

test('ordinary ESM children do not expose the internal runtime channel as process.send', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['/node/check-ipc.mjs']);
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.on('error', (error) => { throw error; });
  `, { '/node/check-ipc.mjs': `console.log(typeof process.send);` });
  assert.equal(stdout, 'undefined\n');
});

test('guest WebAssembly contracts allow standard loader child overrides', async () => {
  const { stdout } = await run(`
    const child = Object.create(WebAssembly);
    const instantiate = () => 'custom';
    Object.assign(child, { instantiate });
    if (child.instantiate !== instantiate) throw new Error('WebAssembly child override was blocked');
    console.log('ok');
  `);
  assert.equal(stdout, 'ok\n');
});

test('HTTP agents tolerate subclasses with post-super protocol accessors', async () => {
  const { stdout } = await run(`
    const http = require('http');
    const state = Symbol('state');
    class AgentBase extends http.Agent {
      constructor(options) {
        super(options);
        this[state] = {};
      }
      get protocol() { return this[state].protocol || 'http:'; }
      set protocol(value) { if (this[state]) this[state].protocol = value; }
    }
    const agent = new AgentBase({ protocol: 'http:' });
    if (agent.defaultPort !== 80 || agent.protocol !== 'http:') throw new Error('agent defaults were lost');
    console.log('ok');
  `);
  assert.equal(stdout, 'ok\n');
});

test('HTTP requests normalize omitted URL ports before custom agents connect', async () => {
  const { stdout } = await run(`
    const http = require('http');
    const https = require('https');
    class Agent extends http.Agent {
      createSocket(request, options, callback) {
        if (options.port !== 443) throw new Error('omitted HTTPS port was not normalized');
        const error = new Error('stop');
        error.code = 'TEST_STOP';
        callback(error);
      }
    }
    const request = https.request({
      hostname: 'registry.npmjs.org',
      port: '',
      path: '/@tapjs%2fclock',
      agent: new Agent({ protocol: 'https:' }),
    });
    request.once('error', (error) => {
      if (error.code !== 'TEST_STOP') throw error;
      console.log('ok');
    });
    request.end();
  `);
  assert.equal(stdout, 'ok\n');
});

test('HTTP responses do not double-decompress already decoded gzip bodies', async () => {
  const { stdout } = await run(`
    const http = require('http');
    const { EventEmitter } = require('events');
    const payload = 'already decoded';
    class Agent extends http.Agent {
      createConnection() {
        const socket = new EventEmitter();
        socket.writable = true;
        socket.destroyed = false;
        socket.setTimeout = () => socket;
        socket.setNoDelay = () => socket;
        socket.setKeepAlive = () => socket;
        socket.ref = () => socket;
        socket.unref = () => socket;
        socket.destroy = () => { socket.destroyed = true; socket.writable = false; socket.emit('close'); };
        socket.write = () => {
          setTimeout(() => socket.emit(
            'data',
            Buffer.from('HTTP/1.1 200 OK\\r\\nContent-Encoding: gzip\\r\\nContent-Length: 15\\r\\n\\r\\nalready decoded'),
          ), 0);
          return true;
        };
        return socket;
      }
    }
    http.get('http://decoded.test/', { agent: new Agent() }, (res) => {
      if (res.headers['content-encoding'] !== undefined) throw new Error('stale gzip metadata');
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (Buffer.concat(chunks).toString() !== payload) throw new Error('decoded body changed');
        console.log('ok');
      });
    }).on('error', (error) => { throw error; });
  `);
  assert.equal(stdout, 'ok\n');
});

test('child process wrappers can observe virtual spawn contracts', async () => {
  const { stdout } = await run(`
    const childProcess = require('child_process');
    const spawnSyncBinding = process.binding('spawn_sync');
    const originalSync = spawnSyncBinding.spawn;
    spawnSyncBinding.spawn = function (options) {
      options.envPairs.push('BNH_SPAWN_SYNC=observed');
      return originalSync.call(this, options);
    };
    const sync = childProcess.spawnSync(process.execPath, [
      '-e', 'process.stdout.write(process.env.BNH_SPAWN_SYNC || "missing")',
    ], { encoding: 'utf8' });
    if (sync.status !== 0 || sync.stdout !== 'observed') throw new Error(sync.stderr || sync.stdout);

    const originalAsync = childProcess.ChildProcess.prototype.spawn;
    childProcess.ChildProcess.prototype.spawn = function (options) {
      if (!Array.isArray(options.envPairs)) throw new Error('spawn envPairs missing');
      return originalAsync.call(this, options);
    };
    const child = childProcess.spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.once('close', (code) => {
      if (code !== 0) throw new Error('virtual child failed');
      process.stdout.write('spawn wrappers completed');
    });
  `);
  assert.equal(stdout, 'spawn wrappers completed');
});

test('same-realm children that call process.exit close promptly', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['-e', 'process.exit(0)']);
    child.on('error', (error) => { throw error; });
    child.on('close', (code, signal) => console.log(code, signal));
  `);
  assert.equal(stdout, '0 null\n');
});

test('ESM children with Node flags and IPC close promptly', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(
      process.execPath,
      ['--no-warnings', '--expose-gc', '/node/exit.mjs'],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    child.on('error', (error) => { throw error; });
    child.on('message', () => {});
    child.on('close', (code, signal) => console.log(code, signal));
  `, { '/node/exit.mjs': `console.log('child');` });
  assert.equal(stdout, '0 null\n');
});

test('IPC ESM children can finish after a synchronous nested spawn', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(
      process.execPath,
      ['--no-warnings', '--expose-gc', '/node/build.mjs'],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    child.on('error', (error) => { throw error; });
    child.stdout.on('data', (chunk) => process.stdout.write('stdout:' + chunk));
    child.stderr.on('data', (chunk) => process.stdout.write('stderr:' + chunk));
    child.on('close', (code, signal) => console.log(code, signal));
  `, {
    '/node/build.mjs': `
      await Promise.resolve();
      import { spawnSync } from 'node:child_process';
      const nested = spawnSync(process.execPath, ['-e', 'process.stdout.write("nested" + String.fromCharCode(10))'], { stdio: 'inherit' });
      if (nested.status !== 0) throw new Error(nested.stderr?.toString() || 'nested spawn failed');
      console.log('built');
    `,
  });
  // The nested same-realm child's inherited stdout is intentionally not
  // replayed through the outer worker stream; the contract under test is that
  // the synchronous spawn does not strand the ESM child before close.
  assert.match(stdout, /stdout:built\n0 null\n/);
});

test('ESM children with foreground-child stdio inherit and close', async () => {
  const { stdout } = await run(`
    const runner = require('child_process').spawn(
      process.execPath,
      ['/node/runner.mjs'],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    runner.on('error', (error) => { throw error; });
    runner.stdout.on('data', (chunk) => process.stdout.write(chunk));
    runner.stderr.on('data', (chunk) => process.stdout.write(chunk));
    runner.on('close', (code, signal) => console.log('runner', code, signal));
  `, {
    '/node/runner.mjs': `
      import { spawn } from 'node:child_process';
      process.on('message', () => {});
      const watched = spawn(process.execPath, ['--no-warnings', '--expose-gc', '/node/build.mjs'], { stdio: [0, 1, 2, 'ipc'] });
      const watchdog = spawn(process.execPath, ['-e', 'const timer = setInterval(() => {}, 60000);'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let watchedClosed = false;
      watched.on('error', (error) => { throw error; });
      watchdog.on('error', (error) => { throw error; });
      watched.on('close', (code, signal) => {
        watchedClosed = true;
        watchdog.kill('SIGKILL');
        console.log('watched', code, signal);
      });
      watchdog.on('close', (code, signal) => {
        if (!watchedClosed) throw new Error('watchdog closed first');
        console.log('watchdog', code, signal);
        process.exit(0);
      });
    `,
    '/node/build.mjs': `
      import { spawnSync } from 'node:child_process';
      const nested = spawnSync(process.execPath, ['-e', 'process.stdout.write("nested" + String.fromCharCode(10))'], { stdio: 'inherit' });
      if (nested.status !== 0) throw new Error(nested.stderr?.toString() || 'nested spawn failed');
      console.log('built');
    `,
  });
  assert.match(stdout, /built\nwatched 0 null\nwatchdog null SIGKILL\n/);
});

test('ESM export-star cycles do not deadlock module graph preparation', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['/node/entry.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('close', (code) => { if (code !== 0) throw new Error('cycle child failed: ' + code); });
  `, {
    '/node/entry.mjs': `import { plugin } from '@tapjs/chdir'; console.log(typeof plugin);`,
    '/node/node_modules/@tapjs/chdir/package.json': JSON.stringify({ type: 'module', exports: { '.': './index.js' } }),
    '/node/node_modules/@tapjs/chdir/index.js': `import { cwd, proc } from '@tapjs/core'; export const plugin = () => [cwd, proc];`,
    '/node/node_modules/@tapjs/core/package.json': JSON.stringify({ type: 'module', exports: { '.': './index.js' } }),
    '/node/node_modules/@tapjs/core/index.js': `export * from './tap.js'; export const cwd = 'cwd'; export const proc = {};`,
    '/node/node_modules/@tapjs/core/tap.js': `import { Test } from '@tapjs/test'; export const tap = Test;`,
    '/node/node_modules/@tapjs/test/package.json': JSON.stringify({ type: 'module', exports: { '.': './index.js' } }),
    '/node/node_modules/@tapjs/test/index.js': `export * from './test-built.js';`,
    '/node/node_modules/@tapjs/test/test-built.js': `import { cwd } from '@tapjs/core'; export const Test = cwd;`,
  });
  assert.equal(stdout, 'function\n');
});

test('dynamic ESM import settles when its graph contains a static back-edge', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['/node/entry.mjs'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('close', (code) => { if (code !== 0) throw new Error('dynamic cycle child failed: ' + code); });
  `, {
    '/node/entry.mjs': `const value = await import('./plugin.mjs'); console.log(value.plugin);`,
    '/node/plugin.mjs': `import { core } from './core.mjs'; export const plugin = core + '-plugin';`,
    '/node/core.mjs': `import { plugin } from './plugin.mjs'; export const core = 'core'; void plugin;`,
  });
  assert.equal(stdout, 'core-plugin\n');
});

test('nested ESM createRequire plus concurrent file URL imports settle', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['/node/entry.mjs'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('close', (code) => { if (code !== 0) throw new Error('nested file import child failed: ' + code); });
  `, {
    '/node/entry.mjs': `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      require('./preload.cjs');
      const files = ['one', 'two', 'three', 'four'];
      await Promise.all(files.map((name) => import(new URL('./' + name + '.mjs', import.meta.url).href)));
      console.log('file imports done');
    `,
    '/node/preload.cjs': `module.exports = { ok: true };`,
    '/node/one.mjs': `export const one = true;`,
    '/node/two.mjs': `export const two = true;`,
    '/node/three.mjs': `export const three = true;`,
    '/node/four.mjs': `export const four = true;`,
  });
  assert.equal(stdout, 'file imports done\n');
});

test('dual package ESM imports can follow CJS preloads through a cyclic graph', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['/node/entry.mjs'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stdout.write('stderr:' + chunk));
    child.on('close', (code) => { if (code !== 0) throw new Error('dual package child failed: ' + code); });
  `, {
    '/node/entry.mjs': `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      try {
        for (const name of ['spawn', 'stdin', 'typescript', 'worker']) require('@tapjs/' + name);
        await Promise.all(['spawn', 'stdin', 'typescript', 'worker'].map((name) => import('file:///node/node_modules/@tapjs/' + name + '/index.js')));
        console.log('dual imports done');
      } catch (error) { console.log('dual imports error:' + (error.stack || error)); }
    `,
    '/node/node_modules/@tapjs/core/package.json': JSON.stringify({ type: 'module', main: './common.cjs', exports: { '.': { import: './index.js', require: './common.cjs' } } }),
    '/node/node_modules/@tapjs/core/common.cjs': `module.exports = { cwd: 'cwd', Spawn: class Spawn {}, Stdin: class Stdin {}, Worker: class Worker {} };`,
    '/node/node_modules/@tapjs/core/index.js': `export * from './proc.js'; export * from './tap.js'; export const cwd = 'cwd'; export class Spawn {} export class Stdin {} export class Worker {}`,
    '/node/node_modules/@tapjs/core/proc.js': `export const proc = typeof process === 'object' && process ? process : undefined;`,
    '/node/node_modules/@tapjs/core/tap.js': `import { Test } from '@tapjs/test'; export const tap = Test;`,
    '/node/node_modules/@tapjs/test/package.json': JSON.stringify({ type: 'module', exports: { '.': './index.js' } }),
    '/node/node_modules/@tapjs/test/index.js': `export * from './test-built.js';`,
    '/node/node_modules/@tapjs/test/test-built.js': `import { cwd } from '@tapjs/core'; import * as SpawnPlugin from '@tapjs/spawn'; import * as StdinPlugin from '@tapjs/stdin'; import * as TypescriptPlugin from '@tapjs/typescript'; import * as WorkerPlugin from '@tapjs/worker'; export const Test = cwd; export { SpawnPlugin, StdinPlugin, TypescriptPlugin, WorkerPlugin };`,
    ...Object.fromEntries(['spawn', 'stdin', 'typescript', 'worker'].map((name) => [
      `/node/node_modules/@tapjs/${name}/package.json`,
      JSON.stringify({ type: 'module', main: './common.cjs', exports: { '.': { import: './index.js', require: './common.cjs' } } }),
    ])),
    ...Object.fromEntries(['spawn', 'stdin', 'typescript', 'worker'].map((name) => [
      `/node/node_modules/@tapjs/${name}/common.cjs`,
      `module.exports = require('@tapjs/core');`,
    ])),
    '/node/node_modules/@tapjs/spawn/index.js': `import { Spawn, proc } from '@tapjs/core'; if (!proc) throw new Error('missing process'); export const plugin = () => Spawn;`,
    '/node/node_modules/@tapjs/stdin/index.js': `import { Stdin, proc } from '@tapjs/core'; if (!proc) throw new Error('missing process'); export const plugin = () => Stdin;`,
    '/node/node_modules/@tapjs/typescript/index.js': `import { cwd, proc } from '@tapjs/core'; if (!proc) throw new Error('missing process'); export const plugin = () => cwd;`,
    '/node/node_modules/@tapjs/worker/index.js': `import { Worker, proc } from '@tapjs/core'; if (!proc) throw new Error('missing process'); export const plugin = () => Worker;`,
  });
  assert.match(stdout, /dual imports done\n/);
});

test('conditional ESM plugin packages retain their named plugin export', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['/node/entry.mjs'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stdout.write('stderr:' + chunk));
    child.on('close', (code) => { if (code !== 0) throw new Error('plugin child failed: ' + code); });
  `, {
    '/node/entry.mjs': `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      require('@tapjs/node-serialize');
      const namespace = await import('@tapjs/node-serialize');
      console.log(typeof namespace.plugin, typeof (await import('file:///node/node_modules/@tapjs/node-serialize/dist/esm/index.js')).plugin);
    `,
    '/node/node_modules/@tapjs/core/package.json': JSON.stringify({ type: 'module', exports: { '.': { import: './index.js', require: './common.cjs' } } }),
    '/node/node_modules/@tapjs/core/common.cjs': `module.exports = { env: {} };`,
    '/node/node_modules/@tapjs/core/index.js': `export const env = {};`,
    '/node/node_modules/@tapjs/node-serialize/package.json': JSON.stringify({ type: 'module', main: './dist/commonjs/index.js', exports: { '.': { import: './dist/esm/index.js', require: './dist/commonjs/index.js' } } }),
    '/node/node_modules/@tapjs/node-serialize/dist/esm/index.js': `import { env } from '@tapjs/core'; export const plugin = () => env;`,
    '/node/node_modules/@tapjs/node-serialize/dist/commonjs/index.js': `exports.plugin = () => require('@tapjs/core').env;`,
  });
  assert.equal(stdout, 'function function\n');
});

test('killing a referenced async child does not race its close event', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)']);
    child.on('error', (error) => { throw error; });
    child.on('close', (code, signal) => console.log(code, signal));
    setTimeout(() => child.kill('SIGKILL'), 5);
  `);
  assert.equal(stdout, 'null SIGKILL\n');
});

test('child exit cleanup can kill a sibling without preceding its close event', async () => {
  const { stdout } = await run(`
    const childProcess = require('child_process');
    const watched = childProcess.spawn(process.execPath, ['-e', '']);
    const watchdog = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)']);
    let watchedClosed = false;
    watched.on('exit', () => watchdog.kill('SIGKILL'));
    watched.on('close', () => { watchedClosed = true; });
    watchdog.on('close', () => {
      if (!watchedClosed) throw new Error('watchdog closed before watched child');
      console.log('ok');
    });
  `);
  assert.equal(stdout, 'ok\n');
});

test('worker-backed ESM child cleanup preserves watched close before watchdog close', async () => {
  const { stdout } = await run(`
    const childProcess = require('child_process');
    const watched = childProcess.spawn(process.execPath, ['/node/watched.mjs']);
    const watchdog = childProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60000)'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let watchedClosed = false;
    watched.on('error', (error) => { throw error; });
    watchdog.on('error', (error) => { throw error; });
    watched.on('exit', () => watchdog.kill('SIGKILL'));
    watched.on('close', () => { watchedClosed = true; });
    watchdog.on('close', () => {
      if (!watchedClosed) throw new Error('watchdog closed before watched ESM child');
      console.log('ok');
    });
  `, { '/node/watched.mjs': `console.log('watched');` });
  assert.equal(stdout, 'ok\n');
});

test('foreground-child watchdog keeps its exact worker child alive until watched exit', async () => {
  const { stdout } = await run(`
    const { spawn } = require('child_process');
    const watched = spawn(process.execPath, ['-e', '']);
    const watchdogCode = ${JSON.stringify(`
      const pid = parseInt(process.argv[1], 10);
      process.title = 'node (foreground-child watchdog pid=' + pid + ')';
      if (!isNaN(pid)) {
        let barked = false;
        const interval = setInterval(() => {}, 60000);
        const bark = () => {
          clearInterval(interval);
          if (barked) return;
          barked = true;
          process.removeListener('SIGHUP', bark);
          setTimeout(() => {
            try {
              process.kill(pid, 'SIGKILL');
              setTimeout(() => process.exit(), 200);
            } catch (_) {}
          }, 500);
        };
        process.on('SIGHUP', bark);
      }
    `)};
    const dog = spawn(process.execPath, ['-e', watchdogCode, String(watched.pid)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let watchedClosed = false;
    let dogExited = false;
    watched.on('exit', (code, signal) => {
      console.log('watched-exit', code, signal);
      if (!dogExited) dog.kill('SIGKILL');
    });
    watched.on('close', () => { watchedClosed = true; console.log('watched-close'); });
    dog.on('exit', (code, signal) => { dogExited = true; console.log('dog-exit', code, signal); });
    dog.on('close', (code, signal) => {
      console.log('dog-close', code, signal);
      if (!watchedClosed) throw new Error('exact watchdog closed before watched child');
      console.log('ok');
    });
  `);
  assert.match(stdout, /watched-exit 0 null\nwatched-close\n/);
  assert.match(stdout, /dog-exit null SIGKILL\ndog-close null SIGKILL\nok\n/);
});

test('watchdog-style ignored stdio children stay alive until killed', async () => {
  const { stdout } = await run(`
    const childProcess = require('child_process');
    const watched = childProcess.spawn(process.execPath, ['-e', '']);
    const watchdog = childProcess.spawn(
      process.execPath,
      ['-e', "const interval = setInterval(() => {}, 60000); process.on('SIGHUP', () => clearInterval(interval));"],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let watchedClosed = false;
    watchdog.on('close', () => {
      if (!watchedClosed) throw new Error('watchdog closed before watched child');
      console.log('ok');
    });
    watched.on('exit', () => watchdog.kill('SIGKILL'));
    watched.on('close', () => { watchedClosed = true; });
  `);
  assert.equal(stdout, 'ok\n');
});

test('beforeExit follows the complete microtask queue and pending filesystem work', async () => {
  const { stdout, node } = await run(`
    let complete = false; let pending = Promise.resolve();
    for (let i = 0; i < 128; i++) pending = pending.then(() => {});
    pending.then(() => require('fs').promises.writeFile('/node/manifest.json', '{"ok":true}'))
      .then(() => { complete = true; });
    process.once('beforeExit', () => {
      if (!complete) throw new Error('Unexpected early exit');
      console.log('COMPLETE');
    });
  `);
  assert.equal(stdout, 'COMPLETE\n');
  assert.equal(await node.fs.readFile('/node/manifest.json', 'utf8'), '{"ok":true}');
});

test('beforeExit can schedule new work and is emitted again after it completes', async () => {
  const { stdout } = await run(`
    let round = 0;
    process.on('beforeExit', () => {
      console.log(++round);
      if (round < 3) setTimeout(() => {}, 1);
    });
  `);
  assert.equal(stdout, '1\n2\n3\n');
});

for (const [name, childSource, expected] of [
  ['child beforeExit work', `process.once('beforeExit', () => setTimeout(() => console.log('LATE'), 1));`, 'LATE\nEXIT 0\n'],
  ['unresolved user promises', `async function work() { await new Promise(() => {}); console.log('NEVER'); } work(); process.once('beforeExit', () => console.log('IDLE'));`, 'IDLE\nEXIT 0\n'],
  ['unreferenced child timers', `setInterval(() => console.log('NEVER'), 1000).unref(); console.log('DONE');`, 'DONE\nEXIT 0\n'],
]) {
  test(`child lifecycle preserves ${name}`, async () => {
    const { stdout } = await run(`
      const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}]);
      c.stdout.on('data', d => process.stdout.write(d));
      c.on('exit', n => console.log('EXIT', n));
    `);
    assert.equal(stdout, expected);
  });
}

test('unref detached children do not pin the parent lifecycle', async () => {
  const { stdout } = await run(`
    const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log('PARENT-DONE');
  `);
  assert.equal(stdout, 'PARENT-DONE\n');
});

test('parallel child filesystem requests do not leak sibling lifecycle tokens', async () => {
  const { stdout } = await run(`
    for (let i = 0; i < 2; i++) {
      const c = require('child_process').spawn(process.execPath, ['-e',
        "require('fs').promises.readFile('/node/value.cjs').then(() => console.log('DONE'))"]);
      c.stdout.on('data', d => process.stdout.write(d));
      c.on('exit', n => console.log('EXIT', n));
    }
  `, valueFiles);
  assert.deepEqual(stdout.trim().split('\n').sort(), ['DONE', 'DONE', 'EXIT 0', 'EXIT 0']);
});

test('unused and autoClose:false file streams do not pin the event loop', async () => {
  const { stdout } = await run(`
    const fs = require('fs');
    fs.createReadStream('/node/value.cjs');
    const out = fs.createWriteStream('/node/out', { autoClose: false });
    out.end('done'); out.on('finish', () => console.log('DONE'));
  `, valueFiles);
  assert.equal(stdout, 'DONE\n');
});

test('finished() waits for both sides of a duplex', async () => {
  const { stdout } = await run(`
    const { PassThrough, finished } = require('stream'); const s = new PassThrough();
    s.write('x'); finished(s, e => { if (e) throw e; console.log('FINISHED'); });
    s.end(); setTimeout(() => { console.log('DRAIN'); s.resume(); }, 5);
  `);
  assert.equal(stdout, 'DRAIN\nFINISHED\n');
});

test('finished() observes errors without explicitly supplied options', async () => {
  const { stdout } = await run(`
    const { PassThrough, finished } = require('stream'); const s = new PassThrough();
    finished(s, e => console.log(e.message)); s.destroy(new Error('BROKEN'));
  `);
  assert.equal(stdout, 'BROKEN\n');
});

test('finished() detects premature closure even when registered late', async () => {
  const { stdout } = await run(`
    const { PassThrough, finished } = require('stream'); const s = new PassThrough();
    s.destroy(); setTimeout(() => finished(s, e => console.log(e.code)), 1);
  `);
  assert.equal(stdout, 'ERR_STREAM_PREMATURE_CLOSE\n');
});

test('public VFS mounts and writes retain their own bytes', () => {
  const vfs = createVfs();
  const mounted = Uint8Array.of(1, 2, 3); vfs.mount({ '/node/input': mounted }); mounted[0] = 9;
  assert.deepEqual([...vfs.fs.readFileSync('/node/input')], [1, 2, 3]);
  const written = Uint8Array.of(4, 5, 6); vfs.fs.writeFileSync('/node/input', written); written[0] = 9;
  assert.deepEqual([...vfs.fs.readFileSync('/node/input')], [4, 5, 6]);
});

test('VFS preserves Linux stat behavior for WASM Windows-platform probes', async () => {
  const vfs = createVfs();
  assert.throws(() => vfs.fs.statSync('C:\\'), (error) => error.code === 'ENOENT');
  assert.equal(vfs.fs.statSync('C:\\', { throwIfNoEntry: false }), undefined);
  await assert.rejects(new Promise((resolve, reject) => {
    vfs.fs.stat('C:\\', (error) => error ? reject(error) : resolve());
  }), (error) => error.code === 'ENOENT');
});

test('VFS source versions change on mutation and large appends preserve bytes', () => {
  const vfs = createVfs(); vfs.mount({ '/node/source': 'first' });
  const before = vfs.fileVersion('/node/source');
  assert.equal(vfs.fileVersion('/node/source'), before);
  vfs.fs.writeFileSync('/node/source', 'second');
  assert.notEqual(vfs.fileVersion('/node/source'), before);
  assert.equal(vfs.readSource('/node/source'), 'second');
  const bytes = new Uint8Array(256 * 1024).fill(7);
  vfs.fs.appendFileSync('/node/source', bytes);
  const result = vfs.fs.readFileSync('/node/source');
  assert.equal(result.length, bytes.length + 6);
  assert.equal(result.at(-1), 7);
});

test('VFS rename replaces an existing file like Node fs.rename', () => {
  const vfs = createVfs();
  vfs.mount({ '/node/source': 'new', '/node/destination': 'old' });
  vfs.fs.renameSync('/node/source', '/node/destination');
  assert.equal(vfs.fs.readFileSync('/node/destination', 'utf8'), 'new');
  assert.equal(vfs.fs.existsSync('/node/source'), false);
});

test('npm seeds installed packages without descending into package payloads', async () => {
  const vfs = createVfs();
  vfs.mount({
    '/node/node_modules/pkg/package.json': '{"name":"pkg","version":"1.2.3"}',
    '/node/node_modules/pkg/dist/deep/file.js': '',
    '/node/node_modules/pkg/node_modules/dep/package.json': '{"name":"dep","version":"2.0.0"}',
    '/node/node_modules/@scope/pkg/package.json': '{"name":"@scope/pkg","version":"3.0.0"}',
  });
  const visited = []; const entries = vfs.entries.bind(vfs);
  vfs.entries = p => { visited.push(p); return entries(p); };
  const npm = new BrowserNpm({ vfs, fetchFn: () => { throw new Error('unexpected network request'); } });
  await npm.seedInstalledLocations('/node/node_modules');
  assert.equal(npm.installedLocations.get('/node/node_modules/pkg'), '1.2.3');
  assert.equal(npm.installedLocations.get('/node/node_modules/pkg/node_modules/dep'), '2.0.0');
  assert.equal(npm.installedLocations.get('/node/node_modules/@scope/pkg'), '3.0.0');
  assert.equal(visited.some(p => p.includes('/dist')), false);
  assert.ok(visited.length <= 6, JSON.stringify(visited));
});

test('npm install honors a package-lock dependency graph', async () => {
  const vfs = createVfs();
  vfs.mount({
    '/node/package.json': JSON.stringify({
      name: 'lockfile-fixture',
      version: '1.0.0',
      devDependencies: { fixture: '^1.0.0' },
    }),
    '/node/package-lock.json': JSON.stringify({
      name: 'lockfile-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'lockfile-fixture', version: '1.0.0', devDependencies: { fixture: '^1.0.0' } },
        'node_modules/fixture': {
          version: '1.0.0',
          resolved: 'https://registry.example/fixture-1.0.0.tgz',
        },
      },
    }),
  });
  const lockedTarball = await packTarGz([{
    path: 'package/package.json',
    data: new TextEncoder().encode(JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js' })),
  }, {
    path: 'package/index.js',
    data: new TextEncoder().encode('module.exports = "locked";'),
  }]);
  const selectedUrls = [];
  const npm = new BrowserNpm({
    vfs,
    fetchFn: async (url) => {
      selectedUrls.push(String(url));
      if (String(url).endsWith('/fixture-1.0.0.tgz')) return new Response(lockedTarball);
      return new Response(JSON.stringify({
        name: 'fixture',
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.1.0': { version: '1.1.0', dist: { tarball: 'https://registry.example/fixture-1.1.0.tgz' } },
        },
      }), { headers: { 'content-type': 'application/json' } });
    },
  });

  await npm.install();

  assert.equal(npm.installed.get('fixture'), '1.0.0');
  assert.equal(vfs.fs.readFileSync('/node/node_modules/fixture/index.js', 'utf8'), 'module.exports = "locked";');
  assert.deepEqual(selectedUrls, ['https://registry.example/fixture-1.0.0.tgz']);
});

test('browser npm uses an official WASM alternative for esbuild', async () => {
  const vfs = createVfs();
  const wasmTarball = await packTarGz([{
    path: 'package/package.json',
    data: new TextEncoder().encode(JSON.stringify({
      name: 'esbuild-wasm',
      version: '0.28.0',
      main: 'lib/main.js',
      directories: { bin: 'bin' },
    })),
  }, {
    path: 'package/bin/esbuild',
    data: new TextEncoder().encode('#!/usr/bin/env node\nprocess.stdout.write("wasm");'),
  }, {
    path: 'package/lib/main.js',
    data: new TextEncoder().encode('module.exports = { version: "0.28.0" };'),
  }]);
  const selectedUrls = [];
  const npm = new BrowserNpm({
    vfs,
    registry: 'https://registry.example',
    fetchFn: async (url) => {
      selectedUrls.push(String(url));
      if (String(url) === 'https://registry.example/esbuild-wasm') {
        return new Response(JSON.stringify({
          name: 'esbuild-wasm',
          versions: {
            '0.28.0': {
              version: '0.28.0',
              bin: { esbuild: 'bin/esbuild' },
              dist: { tarball: 'https://registry.example/esbuild-wasm-0.28.0.tgz' },
            },
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === 'https://registry.example/esbuild-wasm-0.28.0.tgz') return new Response(wasmTarball);
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  await npm.install('esbuild@0.28.0');

  assert.equal(npm.installed.get('esbuild'), '0.28.0');
  assert.equal(vfs.fs.readFileSync('/node/node_modules/esbuild/package.json', 'utf8'), JSON.stringify({
    name: 'esbuild-wasm',
    version: '0.28.0',
    main: 'lib/main.js',
    directories: { bin: 'bin' },
  }));
  assert.match(vfs.fs.readFileSync('/node/node_modules/.bin/esbuild', 'utf8'), /node_modules\/esbuild\/bin\/esbuild/);
  assert.deepEqual(selectedUrls, [
    'https://registry.example/esbuild-wasm',
    'https://registry.example/esbuild-wasm-0.28.0.tgz',
  ]);
});

test('wildcard caret and tilde ranges keep their respective upper bounds', () => {
  assert.equal(satisfiesSemver('1.9.0', '^1.2.x'), true);
  assert.equal(satisfiesSemver('2.0.0', '^1.2.x'), false);
  assert.equal(satisfiesSemver('1.3.0', '~1.2.x'), false);
  assert.equal(satisfiesSemver('12.1.0', '>=*'), true);
});

test('npm script streaming one output channel preserves returned output on the other', async () => {
  const stdout = [], stderr = [];
  await runShellScript('npm run demo', {
    cwd: '/node', env: {}, fs: {},
    onStdout: x => stdout.push(x), onStderr: x => stderr.push(x),
    npmRun: async (_name, options) => {
      options.onStdout('streamed\n');
      return { exit: host.Promise.resolve(0), stdoutText: async () => 'streamed\n', stderrText: async () => 'returned error\n' };
    },
  });
  assert.equal(stdout.join(''), 'streamed\n');
  assert.equal(stderr.join(''), 'returned error\n');
});

test('command substitution handles escaped and nested quoted parentheses', async () => {
  const stdout = [];
  await runShellScript(String.raw`echo $(printf '\)'); echo "$(printf "%s" "$(printf ')')")"`, {
    cwd: '/node', env: {}, fs: {}, onStdout: x => stdout.push(x),
  });
  assert.equal(stdout.join(''), '\\)\n)\n');
  assert.throws(() => parseShellScript('echo "$(echo unfinished'), { code: 'ERR_SHELL_SYNTAX' });
});

for (const [status, method] of [[204, 'GET'], [205, 'GET'], [304, 'GET'], [200, 'HEAD']]) {
  test(`direct virtual fetch accepts a bodyless ${method} ${status} response`, async () => {
    const node = await Nacelle.create({ gateway: false });
    const net = createBrowserNet({ network: node._runtime.virtualNetwork, BufferClass: createBufferClass(globalThis) });
    const server = net.createServer(socket => socket.once('data', () => socket.end(`HTTP/1.1 ${status} OK\r\nContent-Length: 0\r\n\r\n`)));
    await new host.Promise(resolve => server.listen(3000, resolve));
    try {
      const response = await node.fetch('http://localhost:3000/', { method });
      assert.equal(response.status, status); assert.equal(await response.text(), '');
    } finally { server.close(); }
  });
}

test('node:test run reports skipped and todo tests without synthetic failures', async () => {
  const { stdout } = await run(`
    const runner = require('node:test').run({ files: ['/node/cases.cjs'] });
    runner.on('test:fail', e => { throw new Error('unexpected failure: ' + e.name); });
    runner.on('test:summary', e => console.log(JSON.stringify(e.counts)));
    runner.resume();
  `, { '/node/cases.cjs': `const test = require('node:test'); test.skip('skip', () => {}); test.todo('todo'); test('ok', () => {});` });
  const counts = JSON.parse(stdout.trim());
  assert.equal(counts.failed, 0); assert.equal(counts.passed, 1);
  assert.equal(counts.skipped, 1); assert.equal(counts.todo, 1);
});

test('filesystem streams honor emitClose:false without leaking active work', async () => {
  const { stdout } = await run(`
    const out = require('fs').createWriteStream('/node/out', { emitClose: false });
    out.on('close', () => { throw new Error('unexpected close'); });
    out.on('finish', () => console.log('DONE')); out.end('x');
  `);
  assert.equal(stdout, 'DONE\n');
});

test('source-map lookup and internal test binding use their owning process', async () => {
  const { stdout } = await run(`
    console.log(require('module').findSourceMap('missing.js'));
    console.log(typeof require('internal/test/binding').internalBinding);
  `);
  assert.equal(stdout, 'undefined\nfunction\n');
});

test('an exception from beforeExit propagates a nonzero shell status', async () => {
  const node = await Nacelle.create({ gateway: false, files: { '/node/fail.cjs': `process.once('beforeExit', () => { throw new Error('Unexpected early exit'); });` } });
  const child = await node.bash('node /node/fail.cjs');
  assert.equal(await child.exit, 1);
  assert.match(await child.stderrText(), /Unexpected early exit/);
});

test('Function imports accept comments between the keyword and opening parenthesis', async () => {
  const { stdout } = await run(`new Function('return import /* loader */ ("./value.mjs")')().then(m => console.log(m.default));`, { '/node/value.mjs': 'export default 42;' });
  assert.equal(stdout, '42\n');
});

test('guest fetch constructs a valid bodyless response from the virtual HTTP client', async () => {
  const { stdout } = await run(`
    const server = require('http').createServer((req, res) => { res.writeHead(204); res.end(); });
    server.listen(3000, async () => {
      try { const res = await fetch('http://localhost:3000'); console.log(res.status, JSON.stringify(await res.text())); }
      finally { server.close(); }
    });
  `);
  assert.equal(stdout, '204 ""\n');
});

test('fetch response bodies do not retain a token when the caller only reads headers', async () => {
  const original = globalThis.fetch;
  const response = new Response('unused finite body');
  globalThis.fetch = async () => response;
  try {
    const { stdout } = await run(`fetch('data:text/plain,fixture').then(r => console.log(r.status));`);
    assert.equal(stdout, '200\n');
  } finally { globalThis.fetch = original; }
});

for (const consumer of ['text', 'reader', 'iterator', 'clone']) {
  test(`fetch ${consumer} consumption retains pending body I/O until completion`, async () => {
    const original = globalThis.fetch;
    const NativeResponse = Response, NativeReadableStream = ReadableStream;
    globalThis.fetch = async () => new NativeResponse(new NativeReadableStream({ start(controller) {
      host.setTimeout(() => { controller.enqueue(new TextEncoder().encode('BODY')); controller.close(); }, 15);
    } }));
    const consume = {
      text: `console.log(await response.text());`,
      reader: `const reader = response.body.getReader(); let text = ''; for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); } reader.releaseLock(); console.log(text);`,
      iterator: `let text = ''; for await (const part of response.body) text += new TextDecoder().decode(part); console.log(text);`,
      clone: `console.log(await response.clone().text());`,
    }[consumer];
    try {
      const { stdout } = await run(`fetch('data:text/plain,fixture').then(async response => { ${consume} });`);
      assert.equal(stdout, 'BODY\n');
    } finally { globalThis.fetch = original; }
  });
}
