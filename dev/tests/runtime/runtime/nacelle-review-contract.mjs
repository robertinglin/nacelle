import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { BrowserNpm, Nacelle, createNegotiatedTransport } from '../../../../src/index.js';
import { createOutputCollector } from '../../../../src/runtime/streams.js';
import { packTar, unpackTar, packTarGz, unpackTarGz } from '../../../../src/runtime/tar.js';
import { createVfs } from '../../../../src/runtime/vfs.js';
import { createCapabilityManifest, capabilityDelta } from '../../../../src/runtime/policy.js';
import { createCheckpointStore } from '../../../../src/runtime/checkpoints.js';
import { createTraceRecorder, NacelleError } from '../../../../src/runtime/tracing.js';
import { createSecretBroker } from '../../../../src/runtime/secrets.js';
import { createVersionedModuleCache } from '../../../../src/runtime/module-cache.js';
import { createGatewayRouteRegistry } from '../../../../src/runtime/gateway-routing.js';
import { createCompatibilityLab } from '../../../../src/runtime/compatibility-lab.js';

test('unsafe negotiated requests use the privileged transport before native fetch', async () => {
  let nativeCalls = 0;
  let privilegedCalls = 0;
  const transport = createNegotiatedTransport({
    globalObject: { fetch: async () => { nativeCalls += 1; throw new TypeError('CORS'); } },
    adapter: { request: async (request) => { privilegedCalls += 1; return new Response(request.body); } },
  });

  const response = await transport.request({
    target: 'https://api.example.test/charge',
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'charge-once',
  });
  assert.equal(await response.text(), 'charge-once');
  assert.equal(nativeCalls, 0);
  assert.equal(privilegedCalls, 1);
  transport.close();
});

test('Nacelle+ can fail closed when a browser worker boundary is unavailable', async () => {
  await assert.rejects(
    Nacelle.create({
      gateway: false,
      isolation: 'worker',
      globalObject: { fetch: globalThis.fetch },
      nacellePlus: { adapter: { request: async () => new Response('unused') } },
    }),
    { code: 'ERR_NACELLE_ISOLATION_UNAVAILABLE' },
  );
  await assert.rejects(
    Nacelle.create({
      gateway: false,
      globalObject: { navigator: {}, fetch: globalThis.fetch },
      nacellePlus: { adapter: { request: async () => new Response('unused') } },
    }),
    { code: 'ERR_NACELLE_ISOLATION_UNAVAILABLE' },
  );
});

test('nested synchronous children restore host scheduling globals before the next run', async () => {
  const hostQueueMicrotask = globalThis.queueMicrotask;
  const node = await Nacelle.create({ gateway: false });
  const child = await node.execute(`
    const { spawnSync } = require('node:child_process');
    spawnSync('node', ['-e', 'process.stdout.write("child")']);
  `);
  assert.equal(await child.exit, 0);
  assert.equal(globalThis.queueMicrotask, hostQueueMicrotask);
});

test('gateway initialization waits until the service worker controls the page', async () => {
  const serviceWorker = new EventTarget();
  const registration = {
    active: { state: 'activated' },
    update: async () => {},
  };
  serviceWorker.controller = null;
  serviceWorker.register = async () => registration;
  serviceWorker.ready = Promise.resolve(registration);

  let settled = false;
  const initialization = Nacelle.initServiceWorker('/runtime/gateway-sw.js', '/', {
    navigator: { serviceWorker },
  }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  serviceWorker.controller = { state: 'activated' };
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  assert.equal(await initialization, registration);
});

test('tar extraction rejects traversal, absolute paths, symlinks, and resource exhaustion', async () => {
  const traversal = packTar([{ path: 'package/../../escape.txt', data: new Uint8Array([1]) }]);
  assert.throws(() => unpackTar(traversal, { stripPrefix: 'package/', targetDir: '/app' }), { code: 'ERR_ARCHIVE_PATH' });

  const absolute = packTar([{ path: '/package/absolute.txt', data: new Uint8Array([1]) }]);
  assert.throws(() => unpackTar(absolute, { stripPrefix: 'package/', targetDir: '/app' }), { code: 'ERR_ARCHIVE_PATH' });

  const many = packTar([
    { path: 'package/a', data: new Uint8Array([1]) },
    { path: 'package/b', data: new Uint8Array([2]) },
  ]);
  assert.throws(() => unpackTar(many, { maxEntries: 1 }), { code: 'ERR_ARCHIVE_LIMIT' });
  assert.throws(() => unpackTar(many, { maxExpandedBytes: 1 }), { code: 'ERR_ARCHIVE_LIMIT' });

  const compressed = await packTarGz([{ path: 'package/large.txt', data: new Uint8Array(64 * 1024).fill(65) }]);
  await assert.rejects(
    unpackTarGz(compressed, { maxCompressionRatio: 2 }),
    { code: 'ERR_ARCHIVE_LIMIT' },
  );

  const npmDirectoryHeader = packTar([
    { path: 'package', type: 'directory' },
    { path: 'package/package.json', data: new TextEncoder().encode('{"name":"fixture"}') },
  ]);
  const extracted = unpackTar(npmDirectoryHeader, { stripPrefix: 'package/', targetDir: '/app' });
  assert.deepEqual(extracted.map(({ path }) => path), ['/app/package.json']);
});

test('output capture is bounded and reports dropped bytes without retaining the full stream', async () => {
  const output = createOutputCollector({ limits: { total: 4, stdout: 4, stderr: 4 }, tailBytes: 2 });
  output.stdout.write(new TextEncoder().encode('abcd'));
  output.stdout.write(new TextEncoder().encode('efgh'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...output.stdoutBytes], [97, 98, 99, 100]);
  assert.equal(output.stats('stdout').droppedBytes, 4);
  assert.deepEqual([...output.tail('stdout')], [103, 104]);
});

test('gateway routes are session-scoped and expire when their lease is not renewed', () => {
  let now = 1000;
  const registry = createGatewayRouteRegistry({ now: () => now, leaseMs: 100 });
  const first = registry.register({ clientId: 'tab-a', port: 3000 });
  const second = registry.register({ clientId: 'tab-b', port: 3000 });
  assert.notEqual(first.routeId, second.routeId);
  assert.equal(registry.resolve(first.routeId, 'tab-a').port, 3000);
  assert.equal(registry.resolve(first.routeId, 'tab-b'), null);
  now += 101;
  assert.equal(registry.resolve(first.routeId, 'tab-a'), null);
});

test('run cache keys invalidate all module data when the workspace revision changes', () => {
  const cache = createVersionedModuleCache();
  cache.set('/node/app.js', 'revision-a', 'workspace-a');
  assert.equal(cache.get('/node/app.js', 'workspace-a'), 'revision-a');
  assert.equal(cache.get('/node/app.js', 'workspace-b'), undefined);
  assert.equal(cache.size, 0);
});

test('capability policy exposes inspectable grants and reports only deltas', () => {
  const base = createCapabilityManifest({
    vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
    workers: { entryModules: ['*'], maxChildren: 2 },
    ipc: { enabled: true },
    signals: { allowed: ['SIGTERM'] },
    output: { maxBytes: 1000 },
    network: { origins: ['https://api.example.test'], methods: ['GET'] },
    npm: { lifecycleScripts: false },
    secrets: { names: ['model-token'] },
    preview: { ports: [3000] },
  });
  const expanded = createCapabilityManifest({ ...base, network: { origins: ['https://api.example.test', 'https://cdn.example.test'], methods: ['GET', 'POST'] } });
  assert.equal(base.network.origins.includes('https://cdn.example.test'), false);
  assert.deepEqual(capabilityDelta(base, expanded), {
    added: { network: { origins: ['https://cdn.example.test'], methods: ['POST'] } },
    removed: {},
  });
});

test('checkpoints rollback and diff workspace changes using content-addressed snapshots', async () => {
  const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write' }] });
  vfs.writeFile('/node/app.js', new TextEncoder().encode('one'));
  const checkpoints = createCheckpointStore({ snapshot: () => vfs.snapshot(), restore: (snapshot) => vfs.reset() || vfs.mount(snapshot.files, { path: '/node' }) });
  const checkpoint = await checkpoints.create({ runtimeVersion: 'v22.23.2', capabilities: { vfs: true } });
  vfs.writeFile('/node/app.js', new TextEncoder().encode('two'));
  assert.match(checkpoints.diff(checkpoint.id), /app\.js/);
  await checkpoints.rollback(checkpoint.id);
  assert.equal(new TextDecoder().decode(vfs.read('/node/app.js')), 'one');
});

test('trace recorder emits stable failure taxonomy with one trace id', () => {
  const trace = createTraceRecorder({ maxEvents: 3 });
  const id = trace.start({ phase: 'run' });
  trace.event('network', { secret: 'must-redact', origin: 'https://api.example.test' });
  const error = new NacelleError('ERR_NACELLE_NETWORK', 'request failed', { traceId: id });
  trace.finish(error);
  const bundle = trace.export();
  assert.equal(bundle.traceId, id);
  assert.equal(bundle.events.every((event) => event.traceId === id), true);
  assert.equal(JSON.stringify(bundle).includes('must-redact'), false);
  assert.equal(error.code, 'ERR_NACELLE_NETWORK');
});

test('secret broker only signs named, origin-bound requests and never returns raw secrets', async () => {
  const broker = createSecretBroker({ secrets: { model: 'super-secret' }, origins: ['https://api.example.test'] });
  await assert.rejects(broker.get('model'), { code: 'ERR_SECRET_RAW_ACCESS' });
  const signed = await broker.signRequest({ name: 'model', origin: 'https://api.example.test', method: 'POST', path: '/v1/chat' });
  assert.equal(typeof signed.signature, 'string');
  assert.equal(Object.hasOwn(signed, 'secret'), false);
  await assert.rejects(
    broker.signRequest({ name: 'model', origin: 'https://evil.example.test', method: 'POST', path: '/v1/chat' }),
    { code: 'ERR_SECRET_ORIGIN_DENIED' },
  );
});

test('compatibility lab compares observable bytes against an independent oracle', async () => {
  const lab = createCompatibilityLab({
    runner: async (input) => new Uint8Array(input.map((value) => value + 1)),
    oracle: async (input) => Uint8Array.from(input, (value) => value + 1),
    cases: [{ name: 'increment', input: [1, 2, 3] }],
  });
  const report = await lab.run();
  assert.deepEqual(report.metrics, { total: 1, passed: 1, mismatched: 0, failed: 0, unsupported: 0 });
  assert.deepEqual([...report.results[0].actual], [2, 3, 4]);
});

test('npm verifies tarball integrity and refuses lifecycle scripts by default', async () => {
  const tarball = await packTarGz([{ path: 'package/package.json', data: new TextEncoder().encode(JSON.stringify({ name: 'safe-pkg', version: '1.0.0', scripts: { postinstall: 'touch escaped' } })) }]);
  const digest = await crypto.webcrypto.subtle.digest('SHA-512', tarball);
  const integrity = `sha512-${Buffer.from(digest).toString('base64')}`;
  const cache = new Map([['pkg-tarball:safe-pkg@1.0.0', tarball]]);
  const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write' }] });
  const npm = new BrowserNpm({ vfs, cache, globalObject: globalThis });
  const result = await npm.install(['safe-pkg@1.0.0']);
  assert.equal(result.packages[0].name, 'safe-pkg');
  const badCache = new Map([['tarball:https://registry.example/safe.tgz', tarball]]);
  const badNpm = new BrowserNpm({ vfs, cache: badCache, globalObject: globalThis });
  await assert.rejects(badNpm.fetchTarball('https://registry.example/safe.tgz', { integrity: 'sha512-invalid' }), { code: 'ERR_NPM_INTEGRITY' });
  assert.equal(vfs.fs.existsSync('/node/escaped'), false);
  assert.equal(typeof integrity, 'string');
});

test('VFS watcher quotas and owner exit close resources', async () => {
  const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write' }], watchQuota: 1 });
  vfs.writeFile('/node/app.js', new TextEncoder().encode('one'));
  const owner = new (class extends EventTarget {})();
  const watcher = vfs.fs.watch('/node/app.js', { owner });
  assert.throws(() => vfs.fs.watch('/node/app.js'), { code: 'ERR_FS_WATCH_LIMIT' });
  owner.dispatchEvent(new Event('exit'));
  assert.deepEqual(await watcher[Symbol.asyncIterator]().next(), { value: undefined, done: true });
});

test('high-level process handles abort and bound output capture', async () => {
  const node = await Nacelle.create({
    gateway: false,
    files: { '/node/long.js': "setInterval(() => process.stdout.write('xxxxxxxx'), 1);" },
    capabilities: { output: { maxBytes: 32, stdoutBytes: 16, stderrBytes: 16 } },
  });
  const child = await node.run({ entry: '/node/long.js', tailBytes: 4 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await child.kill();
  assert.equal(await Promise.race([child.exit, new Promise((_, reject) => setTimeout(() => reject(new Error('kill hung')), 500))]), 1);
  assert.equal((await child.stdoutText()).length <= 16, true);
  assert.equal(child.stats('stdout').bytes <= 16, true);
});

test('published exports are backed by built artifacts', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'));
  for (const target of Object.values(packageJson.exports).flatMap((entry) => typeof entry === 'string' ? [entry] : Object.values(entry))) {
    if (!target || !target.startsWith('./dist/')) continue;
    const relative = target.slice(2).replace(/\/\*$/, '');
    assert.equal(fs.existsSync(new URL(relative, new URL('../../../../', import.meta.url))), true, target);
  }
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(packageJson.exports)).digest('hex').length, 64);
});
