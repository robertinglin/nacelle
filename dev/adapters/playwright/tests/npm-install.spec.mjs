import { expect, test } from 'playwright/test';
import { packTar, unpackTar, packTarGz, unpackTarGz } from '../runtime/tar.js';
import { BrowserNpm, satisfiesSemver, parsePackageSpec } from '../runtime/npm.js';
import { createVfs } from '../runtime/vfs.js';
import { createModuleLoader } from '../runtime/module-loader.js';

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
    ]);

    const cache = new Map();
    cache.set('pkg-tarball:mini-express@1.0.0', miniExpressTarball);

    const npm = new BrowserNpm({ vfs, cache });
    const result = await npm.install(['mini-express@1.0.0'], { cwd: '/node' });

    expect(result.packages.length).toBe(1);
    expect(result.packages[0].name).toBe('mini-express');
    expect(vfs.files.has('/node/node_modules/mini-express/package.json')).toBe(true);
    expect(vfs.files.has('/node/node_modules/mini-express/lib/index.js')).toBe(true);

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
