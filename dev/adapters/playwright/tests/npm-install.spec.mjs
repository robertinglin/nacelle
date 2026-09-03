import { expect, test } from 'playwright/test';
import { packTar, unpackTar, packTarGz, unpackTarGz } from '../runtime/tar.js';
import { BrowserNpm, satisfiesSemver, parsePackageSpec } from '../runtime/npm.js';
import { createVfs } from '../runtime/vfs.js';
import { createModuleLoader } from '../runtime/module-loader.js';
import { EventEmitter } from '../runtime/events.js';
import { Readable, promises as streamPromises } from '../runtime/streams.js';

test.describe('In-Browser TAR & NPM Package Management', () => {
  test('packTar and unpackTar handles files, directories and path prefixes', () => {
    const encoder = new TextEncoder();
    const inputEntries = [
      { path: 'package/package.json', data: encoder.encode('{"name":"test-pkg","version":"1.0.0"}') },
      { path: 'package/lib/index.js', data: encoder.encode('module.exports = { hello: "world" };') },
      { path: 'package/docs/', type: 'directory' },
    ];

    const tarBytes = packTar(inputEntries);
    expect(tarBytes.byteLength).toBeGreaterThan(0);
    expect(tarBytes.byteLength % 512).toBe(0);

    const unpacked = unpackTar(tarBytes, { stripPrefix: 'package/', targetDir: '/node_modules/test-pkg' });
    expect(unpacked.length).toBe(3);

    const pkgJson = unpacked.find((e) => e.path === '/node_modules/test-pkg/package.json');
    expect(pkgJson).toBeDefined();
    expect(new TextDecoder().decode(pkgJson.data)).toBe('{"name":"test-pkg","version":"1.0.0"}');

    const indexJs = unpacked.find((e) => e.path === '/node_modules/test-pkg/lib/index.js');
    expect(indexJs).toBeDefined();
    expect(new TextDecoder().decode(indexJs.data)).toContain('module.exports');
  });

  test('packTarGz and unpackTarGz compresses and decompresses archive', async () => {
    const encoder = new TextEncoder();
    const inputEntries = [
      { path: 'package/greeting.txt', data: encoder.encode('Hello Browser TarGz!') },
    ];

    const tgzBytes = await packTarGz(inputEntries);
    expect(tgzBytes.byteLength).toBeGreaterThan(0);

    const unpacked = await unpackTarGz(tgzBytes, { stripPrefix: 'package/', targetDir: '/app' });
    expect(unpacked.length).toBe(1);
    expect(unpacked[0].path).toBe('/app/greeting.txt');
    expect(new TextDecoder().decode(unpacked[0].data)).toBe('Hello Browser TarGz!');
  });

  test('pipeline accepts writable streams without Node stream state', async () => {
    const output = new EventEmitter();
    const chunks = [];
    output.write = (chunk) => {
      chunks.push(new Uint8Array(chunk));
      return true;
    };
    output.end = () => queueMicrotask(() => output.emit('finish'));
    output.destroy = () => {};

    await streamPromises.pipeline(Readable.from([new Uint8Array([1, 2]), new Uint8Array([3])]), output);
    expect(chunks).toHaveLength(2);
    expect([...chunks.flatMap((chunk) => [...chunk])]).toEqual([1, 2, 3]);
  });

  test('VFS accepts numeric open flags used by fs-minipass and tar', async () => {
    const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }] });
    const fd = vfs.fs.openSync('/node/numeric.txt', vfs.fs.constants.O_WRONLY | vfs.fs.constants.O_CREAT | vfs.fs.constants.O_TRUNC);
    vfs.fs.writeSync(fd, new Uint8Array([7, 8, 9]));
    vfs.fs.closeSync(fd);
    expect([...vfs.fs.readFileSync('/node/numeric.txt')]).toEqual([7, 8, 9]);
  });

  test('semver utilities parse and match version specs', () => {
    expect(parsePackageSpec('express@4.19.2')).toEqual({ name: 'express', range: '4.19.2' });
    expect(parsePackageSpec('@types/node@^20.0.0')).toEqual({ name: '@types/node', range: '^20.0.0' });
    expect(parsePackageSpec('lodash')).toEqual({ name: 'lodash', range: 'latest' });

    expect(satisfiesSemver('4.19.2', '^4.18.0')).toBe(true);
    expect(satisfiesSemver('5.0.0', '^4.18.0')).toBe(false);
    expect(satisfiesSemver('1.2.3', '~1.2.0')).toBe(true);
    expect(satisfiesSemver('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfiesSemver('2.0.0', '*')).toBe(true);
    expect(satisfiesSemver('2.1.2', '>= 2.1.2 < 3')).toBe(true);
    expect(satisfiesSemver('2.1.0', '>= 2.1.2 < 3')).toBe(false);
    expect(satisfiesSemver('3.0.0', '>= 2.1.2 < 3')).toBe(false);
    expect(satisfiesSemver('1.2.3', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfiesSemver('2.1.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfiesSemver('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false);
    expect(satisfiesSemver('1.5.0', '1.2.0 - 1.8.0')).toBe(true);
  });

  test('BrowserNpm requests scoped registry metadata with an unescaped scope separator', async () => {
    const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }] });
    const requests = [];
    const npm = new BrowserNpm({
      vfs,
      registry: 'https://registry.test',
      proxyUrl: null,
      fetchFn: async (url) => {
        requests.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: '@scope/package', versions: {}, 'dist-tags': {} }),
        };
      },
    });

    await npm.fetchPackageMetadata('@scope/package');

    expect(requests).toEqual(['https://registry.test/@scope/package']);
  });

  test('BrowserNpm installs packages into VFS and module-loader requires them', async () => {
    const encoder = new TextEncoder();
    const vfs = createVfs({
      mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }],
      fixtures: {},
    });

    // Create a mock npm package tarball for "mini-express"
    const miniExpressTarball = await packTarGz([
      {
        path: 'package/package.json',
        data: encoder.encode(JSON.stringify({
          name: 'mini-express',
          version: '1.0.0',
          main: 'lib/index.js',
          bin: 'lib/cli.js',
        })),
      },
      {
        path: 'package/lib/index.js',
        data: encoder.encode(`
          function createApplication() {
            return {
              _routes: {},
              get(path, handler) { this._routes[path] = handler; },
              handle(path) { return this._routes[path] ? this._routes[path]() : '404'; }
            };
          }
          module.exports = createApplication;
        `),
      },
      {
        path: 'package/lib/cli.js',
        mode: 0o755,
        data: encoder.encode('#!/usr/bin/env node\n'),
      },
    ]);

    const cache = new Map();
    cache.set('pkg-tarball:mini-express@1.0.0', miniExpressTarball);

    const npm = new BrowserNpm({ vfs, cache });
    const result = await npm.install(['mini-express@1.0.0'], { cwd: '/node' });

    expect(result.packages.length).toBe(1);
    expect(result.packages[0].name).toBe('mini-express');
    expect(vfs.files.has('/node/node_modules/mini-express/package.json')).toBe(true);
    expect(vfs.files.has('/node/node_modules/mini-express/lib/index.js')).toBe(true);
    expect(vfs.fs.statSync('/node/node_modules/mini-express/lib/cli.js').mode & 0o777).toBe(0o755);
    expect(vfs.fs.statSync('/node/node_modules/.bin/mini-express').mode & 0o777).toBe(0o755);

    // Now test module loading via createModuleLoader
    const loader = createModuleLoader({
      files: {
        has: (pathname) => vfs.files.has(pathname),
        get: (pathname) => vfs.read(pathname),
      },
      globalObject: globalThis,
      builtins: {},
    });

    const miniExpress = loader.require('mini-express', '/node/test.js');
    expect(typeof miniExpress).toBe('function');
    const app = miniExpress();
    app.get('/hello', () => 'Hello from mini-express!');
    expect(app.handle('/hello')).toBe('Hello from mini-express!');
  });

  test('BrowserNpm launches an installed ESM bin through its generated shim', async () => {
    const encoder = new TextEncoder();
    const vfs = createVfs({ mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }] });
    const esmBinTarball = await packTarGz([
      {
        path: 'package/package.json',
        data: encoder.encode(JSON.stringify({
          name: 'esm-bin-package',
          version: '1.0.0',
          type: 'module',
          bin: { 'esm-bin-command': 'bin.js' },
        })),
      },
      {
        path: 'package/bin.js',
        data: encoder.encode("#!/usr/bin/env node\nexport const ran = true;\nglobalThis.__BNH_INSTALLED_ESM_BIN_RAN__ = true;\n"),
      },
    ]);

    const npm = new BrowserNpm({
      vfs,
      cache: new Map([['pkg-tarball:esm-bin-package@1.0.0', esmBinTarball]]),
    });
    await npm.install('esm-bin-package@1.0.0', { cwd: '/node' });

    const launcher = new TextDecoder().decode(vfs.read('/node/node_modules/.bin/esm-bin-command'));
    expect(launcher).toContain('import(');
    expect(launcher).not.toContain('require(');

    const loader = createModuleLoader({
      files: {
        has: (pathname) => vfs.files.has(pathname),
        get: (pathname) => vfs.read(pathname),
      },
      globalObject: globalThis,
      builtins: {},
    });
    delete globalThis.__BNH_INSTALLED_ESM_BIN_RAN__;
    await loader.import('/node/node_modules/.bin/esm-bin-command', '/node/entry.mjs');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(globalThis.__BNH_INSTALLED_ESM_BIN_RAN__).toBe(true);
    delete globalThis.__BNH_INSTALLED_ESM_BIN_RAN__;
  });

  test('module-loader preserves named exports from an installed ESM package', async () => {
    const encoder = new TextEncoder();
    const vfs = createVfs({
      mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }],
    });
    const esmPackage = await packTarGz([
      {
        path: 'package/package.json',
        data: encoder.encode(JSON.stringify({
          name: 'esm-package',
          version: '1.0.0',
          type: 'module',
          main: 'index.js',
        })),
      },
      {
        path: 'package/index.js',
        data: encoder.encode("import'./side-effect.js';\nexport function answer() { return globalThis.__BNH_ESM_SIDE_EFFECT__ ? 42 : 0; }\n"),
      },
      {
        path: 'package/side-effect.js',
        data: encoder.encode("import fs from'fs';\nglobalThis.__BNH_ESM_SIDE_EFFECT__ = typeof fs.readFileSync === 'function';\n"),
      },
    ]);
    const npm = new BrowserNpm({ vfs, cache: new Map([['pkg-tarball:esm-package@1.0.0', esmPackage]]) });
    await npm.install('esm-package@1.0.0', { cwd: '/node' });

    const loader = createModuleLoader({
      files: {
        has: (pathname) => vfs.files.has(pathname),
        get: (pathname) => vfs.read(pathname),
      },
      globalObject: globalThis,
      builtins: { fs: { readFileSync() {} } },
    });
    const imported = await loader.import('esm-package', '/node/entry.mjs');
    expect(imported.answer()).toBe(42);
  });

  test('BrowserNpm nests incompatible concurrent dependency versions', async () => {
    const encoder = new TextEncoder();
    const vfs = createVfs({
      mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }],
    });
    const packages = new Map();
    const archives = new Map();
    const addPackage = async (name, version, dependencies = {}) => {
      const metadata = packages.get(name) || { name, 'dist-tags': {}, versions: {} };
      metadata['dist-tags'].latest = version;
      metadata.versions[version] = {
        name,
        version,
        dependencies,
        dist: { tarball: `https://registry.test/${name}/-/${name}-${version}.tgz` },
      };
      packages.set(name, metadata);
      archives.set(`${name}@${version}`, await packTarGz([{
        path: 'package/package.json',
        data: encoder.encode(JSON.stringify({ name, version, dependencies })),
      }]));
    };
    await addPackage('first', '1.0.0', { shared: '^1.0.0' });
    await addPackage('second', '1.0.0', { shared: '^2.0.0' });
    await addPackage('shared', '1.0.0');
    await addPackage('shared', '2.0.0');

    const npm = new BrowserNpm({
      vfs,
      registry: 'https://registry.test',
      proxyUrl: null,
      fetchFn: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/shared')) {
          return { ok: true, status: 200, json: async () => ({
            name: 'shared',
            'dist-tags': { latest: '2.0.0' },
            versions: {
              '1.0.0': packages.get('shared').versions['1.0.0'],
              '2.0.0': packages.get('shared').versions['2.0.0'],
            },
          }) };
        }
        const name = path.slice(1);
        if (packages.has(name)) return { ok: true, status: 200, json: async () => packages.get(name) };
        const match = path.match(/\/([^/]+)-([0-9.]+)\.tgz$/);
        if (match) return { ok: true, status: 200, arrayBuffer: async () => archives.get(`${match[1]}@${match[2]}`).buffer };
        return { ok: false, status: 404 };
      },
    });
    await npm.install(['first@1.0.0', 'second@1.0.0'], { cwd: '/node', concurrency: 8 });

    expect(vfs.files.has('/node/node_modules/shared/package.json')).toBe(true);
    expect(vfs.files.has('/node/node_modules/second/node_modules/shared/package.json')).toBe(true);
  });

  test('BrowserNpmCache saves, retrieves, and clears metadata and tarballs', async () => {
    const { BrowserNpmCache } = await import('../runtime/npm.js');
    const cache = new BrowserNpmCache({ dbName: 'test_bnh_npm_cache' });

    // Test metadata cache
    await cache.setMetadata('test-pkg', { name: 'test-pkg', version: '2.0.0' });
    const meta = await cache.getMetadata('test-pkg');
    expect(meta).toEqual({ name: 'test-pkg', version: '2.0.0' });

    // Test tarball cache
    const testBytes = new Uint8Array([1, 2, 3, 4, 5]);
    await cache.setTarball('tarball:test-pkg@2.0.0', testBytes, { name: 'test-pkg', version: '2.0.0' });
    const retrieved = await cache.getTarball('tarball:test-pkg@2.0.0');
    expect(retrieved).toEqual(testBytes);

    // Test stats
    const stats = await cache.getStats();
    expect(stats.count).toBeGreaterThanOrEqual(1);

    // Test clear
    await cache.clear();
    const afterClearMeta = await cache.getMetadata('test-pkg');
    expect(afterClearMeta).toBeNull();
    const afterClearTarball = await cache.getTarball('tarball:test-pkg@2.0.0');
    expect(afterClearTarball).toBeNull();
  });

  test('BrowserNpm installs from custom/live registry and leverages BrowserNpmCache', async () => {
    const { BrowserNpm, BrowserNpmCache } = await import('../runtime/npm.js');
    const { createVfs } = await import('../runtime/vfs.js');
    const { packTarGz } = await import('../runtime/tar.js');

    const encoder = new TextEncoder();
    const pkgTarball = await packTarGz([
      { path: 'package/package.json', data: encoder.encode('{"name":"dummy-pkg","version":"1.2.3","main":"index.js"}') },
      { path: 'package/index.js', data: encoder.encode('module.exports = 42;') },
    ]);

    let fetchCount = 0;
    const mockFetch = async (url) => {
      fetchCount += 1;
      if (url.endsWith('/dummy-pkg')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'dummy-pkg',
            'dist-tags': { latest: '1.2.3' },
            versions: {
              '1.2.3': {
                name: 'dummy-pkg',
                version: '1.2.3',
                dist: { tarball: 'https://registry.npmjs.org/dummy-pkg/-/dummy-pkg-1.2.3.tgz' },
              },
            },
          }),
        };
      }
      if (url.includes('dummy-pkg-1.2.3.tgz')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => pkgTarball.buffer,
        };
      }
      return { ok: false, status: 404 };
    };

    const cache = new BrowserNpmCache({ dbName: 'test_live_fetch_cache' });
    await cache.clear();

    const vfs1 = createVfs({ mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }] });
    const npm1 = new BrowserNpm({ vfs: vfs1, cache, fetchFn: mockFetch });

    // 1. First install: cache miss -> calls mockFetch (2 requests: metadata + tarball)
    const result1 = await npm1.install(['dummy-pkg@1.2.3'], { cwd: '/node' });
    expect(result1.packages.length).toBe(1);
    expect(fetchCount).toBe(2);
    expect(vfs1.files.has('/node/node_modules/dummy-pkg/index.js')).toBe(true);

    // 2. Second install in new VFS with same cache: cache hit -> 0 network fetches!
    const vfs2 = createVfs({ mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }] });
    const npm2 = new BrowserNpm({ vfs: vfs2, cache, fetchFn: mockFetch });
    const result2 = await npm2.install(['dummy-pkg@1.2.3'], { cwd: '/node' });
    expect(result2.packages.length).toBe(1);
    expect(fetchCount).toBe(2); // No new network requests!
    expect(vfs2.files.has('/node/node_modules/dummy-pkg/index.js')).toBe(true);

    // 3. Clear cache -> third install causes fresh network fetch!
    await cache.clear();
    const vfs3 = createVfs({ mounts: [{ path: '/node', mode: 'read-write', artifacts: [] }] });
    const npm3 = new BrowserNpm({ vfs: vfs3, cache, fetchFn: mockFetch });
    await npm3.install(['dummy-pkg@1.2.3'], { cwd: '/node' });
    expect(fetchCount).toBe(4); // 2 fresh network requests!
  });
});
