import { expect, test } from 'playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(adapterRoot, '../../..');
const srcRoot = path.join(repoRoot, 'src');
const npmCacheDir = path.join(repoRoot, '.npm_cache');

const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
};

let localServer;
let serverUrl;

function setIsolationHeaders(response) {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Access-Control-Allow-Origin', '*');
}

test.describe('Next.js SWC package selection', () => {
  test.beforeAll(async () => {
    localServer = http.createServer(async (request, response) => {
      setIsolationHeaders(response);
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;

      if (pathname.startsWith('/__npm_proxy__/')) {
        const targetUrl = decodeURIComponent(pathname.slice('/__npm_proxy__/'.length));
        const cacheKey = crypto.createHash('sha256').update(targetUrl).digest('hex');
        const cachePath = path.join(npmCacheDir, `${cacheKey}${targetUrl.endsWith('.tgz') ? '.tgz' : '.json'}`);
        if (fs.existsSync(cachePath)) {
          response.writeHead(200, { 'Content-Type': targetUrl.endsWith('.tgz') ? 'application/octet-stream' : 'application/json; charset=utf-8' });
          response.end(await fs.promises.readFile(cachePath));
          return;
        }
        const upstream = await fetch(targetUrl);
        const bytes = Buffer.from(await upstream.arrayBuffer());
        await fs.promises.mkdir(npmCacheDir, { recursive: true });
        await fs.promises.writeFile(cachePath, bytes);
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' });
        response.end(bytes);
        return;
      }

      if (pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><body>Next.js SWC selection test</body></html>');
        return;
      }

      const filePath = path.resolve(srcRoot, pathname.replace(/^\/+/, ''));
      if (filePath.startsWith(`${srcRoot}${path.sep}`) && fs.existsSync(filePath)) {
        response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
        response.end(await fs.promises.readFile(filePath));
        return;
      }

      response.writeHead(404);
      response.end('Not Found');
    });

    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${localServer.address().port}/`;
  });

  test.afterAll(async () => {
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  });

  test('stock Next.js 16 checks WebContainer before loading native SWC', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
        capabilities: {
          envVars: { allowed: ['NODE_ENV', 'PATH', '__NEXT_VERSION'] },
          network: {
            origins: ['https://registry.npmjs.org'],
            methods: ['GET', 'HEAD'],
          },
        },
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({
        name: 'next-swc-selection-test',
        private: true,
      }));
      await node.fs.writeFile('/node/env-probe.js', "import('/node/env-module.js').then((module) => process.send({ value: process.env.__NEXT_DEV_SERVER || null, imported: module.default.value }), (error) => process.send({ error: String(error) }));");
      await node.fs.writeFile('/node/env-module.js', "module.exports = { value: process.env.__NEXT_DEV_SERVER || null };");
      const installEvents = [];
      await node.npm.install([
        'next@16.3.3',
        'typescript@5.9.3',
        '@types/node@26.4.0',
        '@types/react@19.2.18',
      ], {
        onProgress: (event) => installEvents.push(event),
      });
      const installedNativeEvents = installEvents.filter((event) => (
        event.phase === 'downloading-tarball' || event.phase === 'unpacking'
      ));
      if (installedNativeEvents.some((event) => event.name.startsWith('@next/swc-linux-'))) {
        throw new Error('Nacelle downloaded a native Next.js SWC optional package');
      }
      if (installedNativeEvents.some((event) => event.name.startsWith('@img/sharp-linux'))) {
        throw new Error('Nacelle downloaded a native sharp optional package');
      }
      const networkEvents = [];
      const child = await node.execute(`
        (async () => {
        const assert = require('node:assert/strict');
        const { execSync, fork, spawn } = require('node:child_process');
        const fs = require('node:fs');
        const Module = require('node:module');
        const { resolveFrom } = require('next/dist/lib/resolve-from');

        const envProbe = fork('/node/env-probe.js', {
          cwd: '/node',
          env: { ...process.env, __NEXT_DEV_SERVER: '1' },
        });
        const envProbeValue = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('forked environment probe timed out')), 5000);
          envProbe.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          envProbe.once('exit', (code, signal) => {
            if (code === 0 && signal === null) return;
            clearTimeout(timeout);
            reject(new Error('forked environment probe exited before sending a message: code='
              + code + ' signal=' + signal));
          });
          envProbe.once('message', (message) => {
            clearTimeout(timeout);
            resolve(message);
          });
        });
        if (envProbe.connected) envProbe.disconnect();
        if (envProbe.exitCode === null && envProbe.signalCode === null) {
          await new Promise((resolve) => envProbe.once('exit', resolve));
        }
        assert.strictEqual(envProbeValue.value, '1');
        assert.strictEqual(envProbeValue.imported, '1');

        assert.strictEqual(process.versions.webcontainer, '1.0.0');
        assert.strictEqual(typeof process.hrtime?.bigint, 'function');
        assert.strictEqual(execSync('npm config get registry --no-workspaces', { encoding: 'utf8' }), 'https://registry.npmjs.org/\\n');
        assert.strictEqual(typeof globalThis.caches?.open, 'function');
        assert.strictEqual(typeof require('@swc/helpers/_/_interop_require_default')._, 'function');
        assert.strictEqual(require.resolve('typescript/package.json'), '/node/node_modules/typescript/package.json');
        assert.strictEqual(require.resolve('typescript/lib/typescript.js'), '/node/node_modules/typescript/lib/typescript.js');
        assert.strictEqual(require.resolve('@types/node/package.json'), '/node/node_modules/@types/node/package.json');
        assert.strictEqual(require.resolve('@types/react/package.json'), '/node/node_modules/@types/react/package.json');
        assert.deepStrictEqual(Module._nodeModulePaths('/node'), ['/node/node_modules', '/node_modules']);
        assert.strictEqual(Module._findPath('typescript/package.json', Module._nodeModulePaths('/node')), '/node/node_modules/typescript/package.json');
        assert.strictEqual(resolveFrom('/node', 'typescript/package.json'), '/node/node_modules/typescript/package.json');
        assert.strictEqual(resolveFrom('/node', '@types/node/package.json'), '/node/node_modules/@types/node/package.json');
        assert.strictEqual(resolveFrom('/node', '@types/react/package.json'), '/node/node_modules/@types/react/package.json');
        assert.strictEqual(fs.realpathSync('/node/node_modules/typescript/package.json'), '/node/node_modules/typescript/package.json');
        const npmChild = spawn('npm', [
          'install', '--save-exact', '--save-dev', '@types/react-dom@19.2.5',
        ], { cwd: '/node' });
        let npmChildStderr = '';
        npmChild.stderr.on('data', (chunk) => { npmChildStderr += String(chunk); });
        const npmChildExit = await new Promise((resolve, reject) => {
          npmChild.once('error', reject);
          npmChild.once('close', resolve);
        });
        assert.strictEqual(npmChildExit, 0, npmChildStderr);
        assert.strictEqual(
          fs.existsSync('/node/node_modules/@types/react-dom/package.json'),
          true,
          '@types/react-dom package was not installed',
        );
        assert.strictEqual(require.resolve('@types/react-dom/package.json'), '/node/node_modules/@types/react-dom/package.json');
        const updatedPackageJson = JSON.parse(fs.readFileSync('/node/package.json', 'utf8'));
        assert.strictEqual(updatedPackageJson.devDependencies['@types/react-dom'], '19.2.5');
        const installBindings = require('next/dist/build/swc/install-bindings.js');
        const swc = require('next/dist/build/swc/index.js');

        const nativeAttempts = [];
        const originalDlopen = process.dlopen;
        process.dlopen = (module, filename) => {
          nativeAttempts.push(String(filename));
          return originalDlopen(module, filename);
        };
        const wasmRequests = [];
        const originalFetch = globalThis.fetch;
        let nativeAttemptsBeforeWasm = null;
        globalThis.fetch = (input, init) => {
          const url = String(input?.url || input);
          if (url.includes('@next/swc-wasm-nodejs')) {
            nativeAttemptsBeforeWasm ??= nativeAttempts.length;
            wasmRequests.push(url);
          }
          return originalFetch(input, init);
        };

        const keepAlive = setInterval(() => {}, 1000);
        try {
          await swc.loadBindings(true);
          assert.strictEqual(swc.getBindingsSync().isWasm, true);
          const wasmUrl = 'https://registry.npmjs.org/@next/swc-wasm-nodejs/-/swc-wasm-nodejs-16.3.3.tgz';
          assert.strictEqual(wasmRequests[0], wasmUrl);
          assert.strictEqual(nativeAttemptsBeforeWasm, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
          const firstCacheProbe = await originalFetch(wasmUrl);
          await firstCacheProbe.arrayBuffer();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const secondCacheProbe = await originalFetch(wasmUrl);
          assert.strictEqual(secondCacheProbe.ok, true);
          await secondCacheProbe.arrayBuffer();
          process.stdout.write('NEXT_SWC_SELECTION:' + JSON.stringify({ wasmRequests, nativeAttemptsBeforeWasm }) + '\\n');
        } finally {
          globalThis.fetch = originalFetch;
          process.dlopen = originalDlopen;
          clearInterval(keepAlive);
        }
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `, { onNetwork: (event) => networkEvents.push(event) });
      const childResult = {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };

      return {
        childResult,
        networkEvents,
      };
    });

    expect(result.childResult.exitCode, `${result.childResult.stdout}\n${result.childResult.stderr}`).toBe(0);
    expect(result.childResult.stdout, `${result.childResult.stdout}\n${result.childResult.stderr}`).toContain('NEXT_SWC_SELECTION:');
    expect(result.networkEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'request',
        source: 'guest-fetch',
        transport: 'npm-proxy',
        method: 'GET',
        url: 'https://registry.npmjs.org/@next/swc-wasm-nodejs/-/swc-wasm-nodejs-16.3.3.tgz',
      }),
      expect.objectContaining({
        phase: 'response',
        source: 'guest-fetch',
        transport: 'npm-proxy',
        status: 200,
        url: 'https://registry.npmjs.org/@next/swc-wasm-nodejs/-/swc-wasm-nodejs-16.3.3.tgz',
      }),
      expect.objectContaining({
        phase: 'cache-hit',
        source: 'guest-fetch',
        transport: 'npm-cache',
        status: 200,
        url: 'https://registry.npmjs.org/@next/swc-wasm-nodejs/-/swc-wasm-nodejs-16.3.3.tgz',
      }),
    ]));
  });

  test('runtime npm downloads remain visible to an existing worker thread', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
        capabilities: {
          network: {
            origins: ['https://registry.npmjs.org'],
            methods: ['GET', 'HEAD'],
          },
        },
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({
        name: 'next-swc-live-worker-test',
        private: true,
      }));
      await node.npm.install('next@16.3.3');
      await node.fs.writeFile('/node/next-wasm-worker.js', `
        const { parentPort } = require('node:worker_threads');
        parentPort.postMessage({ type: 'ready' });
        parentPort.once('message', async () => {
          try {
            const fs = require('node:fs');
            parentPort.postMessage({
              type: 'prepared',
              wasmJs: fs.existsSync('/node/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm.js'),
              wasmBinary: fs.existsSync('/node/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm_bg.wasm'),
            });
            const installBindings = require('next/dist/build/swc/install-bindings.js');
            const swc = require('next/dist/build/swc/index.js');
            await installBindings.installBindings();
            parentPort.postMessage({ type: 'loaded', isWasm: swc.getBindingsSync().isWasm });
          } catch (error) {
            parentPort.postMessage({ type: 'error', error: String(error?.stack || error) });
          }
        });
      `);
      const child = await node.execute(`
        (async () => {
          const assert = require('node:assert/strict');
          const { Worker } = require('node:worker_threads');
          const installBindings = require('next/dist/build/swc/install-bindings.js');
          const worker = new Worker('/node/next-wasm-worker.js');
          const nextMessage = (type) => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('worker message timed out: ' + type)), 30000);
            worker.on('message', (message) => {
              if (message?.type === 'error') {
                clearTimeout(timeout);
                reject(new Error(message.error));
              } else if (message?.type === type) {
                clearTimeout(timeout);
                resolve(message);
              }
            });
            worker.once('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
          });
          try {
            await nextMessage('ready');
            await installBindings.installBindings();
            worker.postMessage('load');
            const prepared = await nextMessage('prepared');
            assert.equal(prepared.wasmJs, true, 'worker package files: ' + JSON.stringify(prepared));
            assert.equal(prepared.wasmBinary, true, 'worker package files: ' + JSON.stringify(prepared));
            const loaded = await nextMessage('loaded');
            assert.equal(loaded.isWasm, true);
            process.stdout.write('NEXT_LIVE_WORKER_WASM:ok\\n');
          } finally {
            await worker.terminate();
          }
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `);
      return {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('NEXT_LIVE_WORKER_WASM:ok');
  });

  test('runtime npm downloads remain visible to a package-script child process', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
        capabilities: {
          network: {
            origins: ['https://registry.npmjs.org'],
            methods: ['GET', 'HEAD'],
          },
        },
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({
        name: 'next-swc-live-child-test',
        private: true,
        scripts: { probe: 'node probe.js' },
      }));
      await node.npm.install('next@16.3.3');
      await node.fs.writeFile('/node/probe.js', `
        const fs = require('node:fs');
        (async () => {
          const installBindings = require('next/dist/build/swc/install-bindings.js');
          const swc = require('next/dist/build/swc/index.js');
          await installBindings.installBindings();
          if (!fs.existsSync('/node/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm.js')) throw new Error('downloaded wasm.js is missing');
          if (!fs.existsSync('/node/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm_bg.wasm')) throw new Error('downloaded wasm binary is missing');
          if (!swc.getBindingsSync().isWasm) throw new Error('downloaded SWC did not load as WASM');
          process.stdout.write('NEXT_CHILD_WASM:ok\\n');
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `);
      const child = await node.npm.run('probe');
      return {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\\n${result.stderr}`).toBe(0);
    expect(result.stdout, `${result.stdout}\\n${result.stderr}`).toContain('NEXT_CHILD_WASM:ok');
  });

  test('runtime npm downloads remain visible to an IPC fork child process', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
        capabilities: {
          network: {
            origins: ['https://registry.npmjs.org'],
            methods: ['GET', 'HEAD'],
          },
        },
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({
        name: 'next-swc-live-fork-test',
        private: true,
      }));
      await node.npm.install('next@16.3.3');
      await node.fs.writeFile('/node/probe.js', `
        const fs = require('node:fs');
        (async () => {
          const installBindings = require('next/dist/build/swc/install-bindings.js');
          const swc = require('next/dist/build/swc/index.js');
          await installBindings.installBindings();
          if (!fs.existsSync('/node/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm.js')) throw new Error('downloaded wasm.js is missing');
          if (!fs.existsSync('/node/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm_bg.wasm')) throw new Error('downloaded wasm binary is missing');
          if (!swc.getBindingsSync().isWasm) throw new Error('downloaded SWC did not load as WASM');
          process.send({ type: 'ok' });
        })().catch((error) => {
          process.send({ type: 'error', error: String(error?.stack || error) });
          process.exitCode = 1;
        });
      `);
      const child = await node.execute(`
        (async () => {
          const assert = require('node:assert/strict');
          const { fork } = require('node:child_process');
          const worker = fork('/node/probe.js', [], { cwd: '/node' });
          const message = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('forked SWC probe timed out')), 30000);
            worker.once('error', (error) => { clearTimeout(timeout); reject(error); });
            worker.on('message', (value) => {
              if (value?.type === 'ok' || value?.type === 'error') { clearTimeout(timeout); resolve(value); }
            });
          });
          assert.deepEqual(message, { type: 'ok' }, JSON.stringify(message));
          await new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('fork exit: ' + code)));
            worker.disconnect();
          });
          process.stdout.write('NEXT_FORK_WASM:ok\\n');
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `);
      return {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\\n${result.stderr}`).toBe(0);
    expect(result.stdout, `${result.stdout}\\n${result.stderr}`).toContain('NEXT_FORK_WASM:ok');
  });

  test('fetched Web Streams complete through a VFS WriteStream', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
        capabilities: {
          network: {
            origins: ['https://registry.npmjs.org'],
            methods: ['GET', 'HEAD'],
          },
        },
      });
      const child = await node.execute(`
        (async () => {
          const assert = require('node:assert/strict');
          const fs = require('node:fs');
          const keepAlive = setInterval(() => {}, 1000);
          const url = 'https://registry.npmjs.org/@next/swc-wasm-nodejs/-/swc-wasm-nodejs-16.3.3.tgz';
          try {
            const response = await fetch(url);
            assert.equal(response.ok, true);
            assert.ok(response.body);
            const output = fs.createWriteStream('/node/swc-wasm-nodejs.tgz');
            let bytesWritten = 0;
            await response.body.pipeTo(new WritableStream({
              write(chunk) {
                bytesWritten += chunk.byteLength;
                return new Promise((resolve, reject) => {
                  output.write(chunk, (error) => error ? reject(error) : resolve());
                });
              },
              close() {
                return new Promise((resolve, reject) => {
                  output.close((error) => error ? reject(error) : resolve());
                });
              },
              abort(error) {
                output.destroy(error);
              },
            }));
            assert.equal(fs.statSync('/node/swc-wasm-nodejs.tgz').size, bytesWritten);
            assert.ok(bytesWritten > 0);
            process.stdout.write('NEXT_WASM_STREAM_DOWNLOAD:' + bytesWritten + '\\n');
          } finally {
            clearInterval(keepAlive);
          }
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `);
      return {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('NEXT_WASM_STREAM_DOWNLOAD:');
  });

  test('Next.js Watchpack completes its initial VFS scan', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({
        name: 'next-watchpack-test',
        private: true,
      }));
      await node.npm.install('next@16.3.3');
      const child = await node.execute(`
        (async () => {
          const assert = require('node:assert/strict');
          const Watchpack = require('next/dist/compiled/watchpack');
          const watchpack = new Watchpack({ aggregateTimeout: 5 });
          const keepAlive = setInterval(() => {}, 1000);
          try {
            const aggregated = new Promise((resolve) => watchpack.once('aggregated', resolve));
            watchpack.watch({ directories: ['/node/app'], startTime: 0 });
            await Promise.race([
              aggregated,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Watchpack initial scan timed out')), 5000)),
            ]);
            assert.ok(watchpack.getTimeInfoEntries());
            process.stdout.write('NEXT_WATCHPACK_SCAN_COMPLETED\\n');
          } finally {
            watchpack.close();
            clearInterval(keepAlive);
          }
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `, { files: { '/node/app/page.tsx': 'export default function Page() { return null; }' } });
      return {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('NEXT_WATCHPACK_SCAN_COMPLETED');
  });

  test('Next.js 16 dev app route matcher discovers the root page from VFS', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({
        name: 'next-route-matcher-test',
        private: true,
      }));
      await node.npm.install('next@16.3.3');
      await node.fs.writeFile('/node/app/layout.tsx', 'export default function Layout({ children }) { return children; }');
      await node.fs.writeFile('/node/app/page.tsx', 'export default function Page() { return null; }');
      const child = await node.execute(`
        (async () => {
          const assert = require('node:assert/strict');
          const { DefaultFileReader } = require('next/dist/server/route-matcher-providers/dev/helpers/file-reader/default-file-reader');
          const { DevAppPageRouteMatcherProvider } = require('next/dist/server/route-matcher-providers/dev/dev-app-page-route-matcher-provider');
          const reader = new DefaultFileReader({});
          const provider = new DevAppPageRouteMatcherProvider('/node/app', ['js', 'jsx', 'ts', 'tsx'], reader, false);
          const files = await reader.read('/node/app');
          const matchers = await provider.matchers();
          process.stdout.write('NEXT_APP_ROUTE_MATCHER_DEBUG:' + JSON.stringify({
            files,
            matchers: matchers.map((matcher) => matcher.definition),
          }) + '\\n');
          const root = matchers.find((matcher) => matcher.definition.pathname === '/');
          assert.ok(root, 'Next did not discover app/page.tsx');
          assert.equal(root.definition.filename, '/node/app/page.tsx');
          process.stdout.write('NEXT_APP_ROUTE_MATCHER_ROOT:' + root.definition.pathname + '\\n');
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `);
      return {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('NEXT_APP_ROUTE_MATCHER_ROOT:/');
  });

  test('manifest installs expose TypeScript exactly as Next resolves it', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
        capabilities: {
          network: {
            origins: ['https://registry.npmjs.org'],
            methods: ['GET', 'HEAD'],
          },
        },
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({
        name: 'next-typescript-manifest-test',
        private: true,
        dependencies: {
          next: '16.3.3',
          react: '19.2.8',
          'react-dom': '19.2.8',
        },
        devDependencies: {
          typescript: '5.9.3',
          '@types/node': '26.4.0',
          '@types/react': '19.2.18',
          '@types/react-dom': '19.2.5',
        },
      }));
      const progress = [];
      await node.npm.install({ onProgress: (event) => progress.push(event) });
      const child = await node.execute(`
        const assert = require('node:assert/strict');
        const { resolveFrom } = require('next/dist/lib/resolve-from');
        const { hasNecessaryDependencies } = require('next/dist/lib/has-necessary-dependencies');
        assert.strictEqual(require.resolve('typescript/package.json'), '/node/node_modules/typescript/package.json');
        assert.strictEqual(require.resolve('typescript/lib/typescript.js'), '/node/node_modules/typescript/lib/typescript.js');
        assert.strictEqual(resolveFrom('/node', 'typescript/package.json'), '/node/node_modules/typescript/package.json');
        assert.strictEqual(resolveFrom('/node', 'typescript/lib/typescript.js'), '/node/node_modules/typescript/lib/typescript.js');
        const dependencyCheck = hasNecessaryDependencies('/node', [
          { file: 'typescript/lib/typescript.js', pkg: 'typescript', exportsRestrict: true },
          { file: '@types/react/index.d.ts', pkg: '@types/react', exportsRestrict: true },
          { file: '@types/node/index.d.ts', pkg: '@types/node', exportsRestrict: true },
        ]);
        assert.deepStrictEqual(dependencyCheck.missing, []);
        process.stdout.write('NEXT_TYPESCRIPT_MANIFEST:' + JSON.stringify({
          typescript: require('/node/node_modules/typescript/package.json').version,
          typePackages: [
            require('/node/node_modules/@types/node/package.json').version,
            require('/node/node_modules/@types/react/package.json').version,
            require('/node/node_modules/@types/react-dom/package.json').version,
          ],
        }) + '\\n');
      `);
      return {
        packages: progress.filter((event) => event.phase === 'installed').map((event) => event.name),
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('NEXT_TYPESCRIPT_MANIFEST:');
    expect(result.packages).toEqual(expect.arrayContaining([
      'typescript', '@types/node', '@types/react', '@types/react-dom',
    ]));
  });

  test('stock React DOM renderer preserves request storage while streaming', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
        capabilities: {
          envVars: { allowed: ['NODE_ENV', 'PATH'] },
          network: { origins: ['https://registry.npmjs.org'], methods: ['GET', 'HEAD'] },
        },
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({ name: 'react-stream-test', private: true }));
      await node.npm.install(['next@16.3.3']);
      const child = await node.execute(`
        (async () => {
          const assert = require('node:assert/strict');
          const { AsyncLocalStorage } = require('node:async_hooks');
          const React = require('next/dist/compiled/react');
          const ReactDOMServer = require('next/dist/compiled/react-dom/server.node');
          const storage = new AsyncLocalStorage();
          const streamPromise = storage.run('request', () => ReactDOMServer.renderToReadableStream(
            React.createElement('h1', null, 'hello'),
          ));
          const stream = await streamPromise;
          const reader = stream.getReader();
          const chunks = [];
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            chunks.push(new TextDecoder().decode(result.value));
          }
          assert.match(chunks.join(''), /hello/);
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `);
      return {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('stock React DOM stream closes a native Web Stream writable', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
        capabilities: {
          network: { origins: ['https://registry.npmjs.org'], methods: ['GET', 'HEAD'] },
        },
      });
      await node.fs.writeFile('/node/package.json', JSON.stringify({ name: 'react-pipe-test', private: true }));
      await node.npm.install(['next@16.3.3']);
      const child = await node.execute(`
        (async () => {
          const assert = require('node:assert/strict');
          const React = require('next/dist/compiled/react');
          const ReactDOMServer = require('next/dist/compiled/react-dom/server.node');
          const stream = await ReactDOMServer.renderToReadableStream(
            React.createElement('h1', null, 'hello'),
          );
          const chunks = [];
          let closed = false;
          await stream.pipeTo(new WritableStream({
            write(chunk) { chunks.push(new TextDecoder().decode(chunk)); },
            close() { closed = true; },
          }));
          assert.equal(closed, true);
          assert.match(chunks.join(''), /hello/);
        })().catch((error) => {
          console.error(error.stack || error);
          process.exitCode = 1;
        });
      `);
      return {
        exitCode: await child.exit,
        stdout: await child.stdoutText(),
        stderr: await child.stderrText(),
      };
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('worker-isolated HTTP servers share the parent virtual network', async ({ page }) => {
    test.setTimeout(30000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
      });
      const milestones = ['created'];
      await node.fs.writeFile('/node/server.js', `
        const http = require('node:http');
        process.env.BNH_OWNER_CONTEXT = 'worker-context';
        const server = http.createServer(async (_request, response) => {
          await Promise.resolve();
          response.end(process.env.BNH_OWNER_CONTEXT || 'missing');
        });
        server.listen(3000);
      `);
      milestones.push('file-written');
      const child = await node.run({ entry: '/node/server.js', timeout: 20000 });
      milestones.push('run-returned');
      const deadline = Date.now() + 5000;
      let response;
      while (!response) {
        milestones.push('requesting');
        try {
          response = await node.fetch('http://127.0.0.1:3000/');
        } catch (error) {
          if (error?.code !== 'ECONNREFUSED' || Date.now() >= deadline) {
            throw new Error(`${error.message} (${milestones.join(',')})`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      const body = await response.text();
      milestones.push('response');
      await Promise.race([child.kill(), new Promise((resolve) => setTimeout(resolve, 1000))]);
      return { status: response.status, body, milestones };
    });

    expect(result).toMatchObject({ status: 200, body: 'worker-context' });
  });

  test('Web Stream responses complete through the virtual HTTP server', async ({ page }) => {
    test.setTimeout(30000);
    await page.goto(serverUrl);

    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        cwd: '/node',
        globalObject: window,
        isolation: 'worker',
        gateway: false,
      });
      await node.fs.writeFile('/node/server.js', `
        const http = require('node:http');
        const server = http.createServer(async (_request, response) => {
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('stream response'));
              controller.close();
            },
          });
          await body.pipeTo(new WritableStream({
            write(chunk) { response.write(chunk); },
            close() { response.end(); },
          }));
        });
        server.listen(3000);
      `);
      const child = await node.run({ entry: '/node/server.js', timeout: 20000 });
      const deadline = Date.now() + 5000;
      let response;
      while (!response) {
        try {
          response = await node.fetch('http://127.0.0.1:3000/');
        } catch (error) {
          if (error?.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      const body = await response.text();
      await Promise.race([child.kill(), new Promise((resolve) => setTimeout(resolve, 1000))]);
      return { status: response.status, body };
    });

    expect(result).toEqual({ status: 200, body: 'stream response' });
  });

  test('settles a shell-backed npm process when its worker is cancelled', async ({ page }) => {
    await page.goto(serverUrl);
    const result = await page.evaluate(async () => {
      const { Nacelle } = await import('/index.js');
      const node = await Nacelle.create({
        gateway: false,
        globalObject: window,
        isolation: 'worker',
        files: {
          '/node/package.json': JSON.stringify({
            name: 'kill-fixture',
            version: '1.0.0',
            scripts: { start: 'node server.js' },
          }),
          '/node/server.js': "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
        },
      });
      const child = await node.npm.run('start');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const kill = child.kill();
      const killResult = await Promise.race([
        kill.then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 1000)),
      ]);
      const exit = await Promise.race([
        child.exit,
        new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
      return { killResult, exit };
    });

    expect(result.killResult, JSON.stringify(result)).toBe('settled');
    expect(result.exit, JSON.stringify(result)).toBe(1);
  });
});
