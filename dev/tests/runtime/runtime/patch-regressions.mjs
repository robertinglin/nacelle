import assert from 'node:assert/strict';
import test from 'node:test';
import { Nacelle, createBrowserNet, createBufferClass } from '../../../../src/index.js';
import { createVfs } from '../../../../src/runtime/vfs.js';
import { BrowserNpm, satisfiesSemver } from '../../../../src/runtime/npm.js';
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
