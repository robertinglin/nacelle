import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Nacelle, createBrowserNet, createBufferClass } from '../../../../src/index.js';
import { createVfs } from '../../../../src/runtime/vfs.js';
import { EventEmitter } from '../../../../src/runtime/events.js';

const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
const HostPromise = Promise;
const turn = () => new HostPromise((resolve) => hostSetTimeout(resolve, 0));
const example = async (name) => (await readFile(new URL(`../../../../examples/${name}.html`, import.meta.url), 'utf8'))
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/import \{ Nacelle \} from '\/index.js';/, '');

test('many FS watchers share owner cleanup and release both lifecycle listeners', () => {
  const vfs = createVfs();
  vfs.mount({ 'app/page.tsx': 'page' }, { path: '/node' });
  const owner = new EventEmitter();
  vfs.setWatcherOwner(owner);
  const watchers = Array.from({ length: 32 }, () => vfs.fs.watch('/node/app'));
  let closed = 0;
  for (const watcher of watchers) watcher.on('close', () => { closed += 1; });
  try {
    assert.equal(owner.listenerCount('exit'), 1);
    assert.equal(owner.listenerCount('close'), 1);
    watchers[0].close();
    assert.equal(owner.listenerCount('exit'), 1);
    owner.emit('exit', 0);
    assert.equal(closed, watchers.length);
    assert.equal(owner.listenerCount('exit'), 0);
    assert.equal(owner.listenerCount('close'), 0);
    // A new generation must get a fresh cleanup pair.
    const watcher = vfs.fs.watch('/node/app');
    assert.equal(owner.listenerCount('exit'), 1);
    watcher.close();
    assert.equal(owner.listenerCount('exit'), 0);
    assert.equal(owner.listenerCount('close'), 0);
  } finally {
    vfs.reset();
  }
});

test('recursive FS watch stays in its subtree and reports relative paths', () => {
  const vfs = createVfs();
  vfs.mount({ 'app/nested/page.tsx': 'page', 'app-other/page.tsx': 'other', 'dist/bundle.js': '' }, { path: '/node' });
  const changes = [];
  const direct = [];
  const watcher = vfs.fs.watch('/node/app', { recursive: true }, (type, filename) => changes.push([type, filename]));
  const nonrecursive = vfs.fs.watch('/node/app', (type, filename) => direct.push([type, filename]));
  try {
    vfs.fs.writeFileSync('/node/dist/bundle.js', 'build');
    vfs.fs.writeFileSync('/node/app-other/page.tsx', 'other update');
    vfs.fs.writeFileSync('/node/app/nested/page.tsx', 'page update');
    assert.deepEqual(changes, [['change', 'nested/page.tsx']]);
    assert.deepEqual(direct, []);
  } finally {
    watcher.close();
    nonrecursive.close();
  }
});

async function virtualServer(onConnection) {
  const node = await Nacelle.create({ gateway: false });
  const net = createBrowserNet({ network: node._runtime.virtualNetwork, BufferClass: createBufferClass(globalThis) });
  const server = net.createServer(onConnection);
  await new HostPromise((resolve) => server.listen(3000, resolve));
  return { node, server };
}

test('direct Nacelle.fetch aborts a stalled readiness socket', { timeout: 5000 }, async () => {
  let accept;
  let closed;
  const accepted = new HostPromise((resolve) => { accept = resolve; });
  const socketClosed = new HostPromise((resolve) => { closed = resolve; });
  const { node, server } = await virtualServer((socket) => {
    socket.on('close', closed);
    accept(); // Deliberately never send an HTTP response.
  });
  const controller = new AbortController();
  try {
    const request = node.fetch('http://localhost:3000/', { signal: controller.signal });
    await accepted;
    const failure = assert.rejects(request, { name: 'AbortError' });
    controller.abort();
    await failure;
    await socketClosed;
    await assert.rejects(node.fetch('http://localhost:3000/', { signal: controller.signal }), { name: 'AbortError' });
  } finally {
    server.close();
  }
});

test('an empty virtual HTTP connection is not a successful readiness response', async () => {
  const { node, server } = await virtualServer((socket) => socket.once('data', () => socket.destroy()));
  try {
    await assert.rejects(node.fetch('http://localhost:3000/'), /without a valid response/);
  } finally {
    server.close();
  }
});

async function rollupPage(node, create = async () => node) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { addEventListener() {}, classList: { toggle() {}, remove() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    Nacelle: { create },
    document: { getElementById: get, addEventListener() {} },
    window: { addEventListener() {} },
    console: { error() {} },
    performance,
    setTimeout: hostSetTimeout,
  });
  vm.runInContext(`${await example('webpack')}\nthis.buildDemo = build; this.bundlerSource = bundlerCode;`, context);
  return { context, get };
}

function rollupStub() {
  const calls = [];
  const node = {
    npm: { install: async () => { calls.push('install'); } },
    fs: {
      writeFile: async () => {},
      readFile: async () => '{"main.js":"bundle.1234.js","hash":"1234","size":140}',
    },
    bash: async (command) => {
      calls.push(command);
      return { exit: HostPromise.resolve(0), stdoutText: async () => command === 'node rollup.js' ? '' : 'Event recorded: Sum is 42\n', stderrText: async () => '' };
    },
  };
  return { node, calls };
}

test('Rollup demo consumes the manifest even when build stdout is empty', async () => {
  const { node, calls } = rollupStub();
  const { context, get } = await rollupPage(node);
  await context.buildDemo();
  assert.equal(get('global-status').textContent, 'Ready');
  assert.equal(get('metric-bundle').textContent, 'bundle.1234.js');
  assert.equal(get('btn-run').disabled, false);
  assert.deepEqual(calls, ['install', 'node rollup.js', 'node /node/dist/bundle.1234.js']);
});

test('Rollup demo ignores duplicate clicks during installation and retries failed installs', async () => {
  const { node, calls } = rollupStub();
  let release;
  const gate = new HostPromise((resolve) => { release = resolve; });
  let attempts = 0;
  node.npm.install = async () => {
    attempts += 1;
    await gate;
    if (attempts === 1) throw new Error('install failed');
  };
  const { context, get } = await rollupPage(node);
  const first = context.buildDemo();
  await turn();
  await context.buildDemo();
  assert.equal(attempts, 1);
  release();
  await first;
  assert.equal(get('global-status').textContent, 'Build failed');
  assert.equal(get('btn-run').disabled, false);
  assert.equal(calls.length, 0);
  await context.buildDemo();
  assert.equal(attempts, 2);
  assert.equal(get('global-status').textContent, 'Ready');
});

test('Rollup script closes the bundle and returns a failing exit code on generation errors', async () => {
  const { context } = await rollupPage(rollupStub().node);
  const node = await Nacelle.create({ gateway: false, files: {
    '/node/rollup.js': context.bundlerSource,
    '/node/node_modules/rollup/package.json': '{"main":"index.js"}',
    '/node/node_modules/rollup/index.js': `exports.rollup = async () => ({
      generate: async () => { throw new Error('generation failed'); },
      close: async () => { require('node:fs').writeFileSync('/node/closed', 'yes'); }
    });`,
  } });
  const child = await node.bash('node rollup.js');
  assert.equal(await child.exit, 1);
  assert.match(await child.stderrText(), /generation failed/);
  assert.equal(await node.fs.readFile('/node/closed', 'utf8'), 'yes');
});

async function nextPage(fetchImpl = async () => ({ ok: true })) {
  const events = [];
  const handles = [];
  const node = {
    fs: { writeFile: async () => { events.push('write'); } },
    npm: {
      install: async () => { events.push('install'); },
      run: async (_mode, options) => {
        let exit;
        const handle = { exit: new HostPromise((resolve) => { exit = resolve; }), kill: async () => { events.push('kill'); exit(0); }, finish: (code) => exit(code) };
        handles.push(handle);
        // stdout is allowed to split a word across chunks.
        options.onStdout('✓ Re');
        options.onStdout('ady in 656ms\n');
        return handle;
      },
    },
    fetch: async (...args) => { events.push('fetch'); return fetchImpl(...args); },
  };
  const context = vm.createContext({
    node, activeProcess: null, currentMode: 'dev', files: { 'app/page.tsx': 'page' },
    serverStatus: {}, urlInput: { value: '/' }, window: { navigateFrame: () => events.push('navigate') },
    logTerminal() {}, logNetwork() {}, logGuestNetwork() {},
    setTimeout: hostSetTimeout, clearTimeout, AbortController,
  });
  const source = await example('nextjs');
  const start = source.indexOf('    async function waitForNextServer');
  const end = source.indexOf("    document.getElementById('btn-dev')", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`let launching = false, readinessController = null;\n${source.slice(start, end)}\nthis.launchDemo = launchNextApp;`, context);
  return { context, events, handles };
}

test('Next demo probes without relying on banner chunk boundaries and kills before remounting', async () => {
  const { context, events, handles } = await nextPage();
  try {
    await context.launchDemo();
    await turn();
    assert.equal(events.filter((event) => event === 'fetch').length, 1);
    assert.equal(context.serverStatus.className, 'status-dot active');
    events.length = 0;
    await context.launchDemo();
    await turn();
    assert.equal(events[0], 'kill');
    assert.ok(events.indexOf('write') > events.indexOf('kill'));
  } finally {
    for (const handle of handles) handle.finish(0);
    await turn();
  }
});

test('Next demo cancels readiness and reports a process that exits before serving', async () => {
  let probeSignal;
  const { context, handles } = await nextPage((_url, { signal }) => {
    probeSignal = signal;
    return new HostPromise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await context.launchDemo();
  await turn();
  assert.ok(probeSignal);
  handles[0].finish(1);
  await turn();
  assert.equal(probeSignal.aborted, true);
  assert.equal(context.serverStatus.className, 'status-dot error');
});
