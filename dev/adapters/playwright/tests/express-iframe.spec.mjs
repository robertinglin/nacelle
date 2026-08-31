import { expect, test } from 'playwright/test';
import { packTarGz } from '../runtime/tar.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let localServer = null;
let serverUrl = process.env.BNH_TEST_URL || '';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

test.beforeAll(async () => {
  if (!serverUrl) {
    localServer = createServer(async (req, res) => {
      try {
        let pathname = new URL(req.url, 'http://localhost').pathname || '/';
        if (pathname === '/' || pathname === '/harness.html' || pathname === '/index.html') {
          const data = await readFile(path.resolve(adapterRoot, 'express-demo.html'));
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Service-Worker-Allowed': '/',
          });
          res.end(data);
          return;
        }

        const safeRelative = pathname.replace(/^\/+/, '');
        const filePath = path.resolve(adapterRoot, safeRelative);

        if (!filePath.startsWith(adapterRoot)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        const data = await readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Service-Worker-Allowed': '/',
        });
        res.end(data);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found: ' + req.url);
      }
    });

    await new Promise((resolve, reject) => {
      localServer.once('error', reject);
      localServer.listen(0, '127.0.0.1', resolve);
    });

    const port = localServer.address().port;
    serverUrl = `http://127.0.0.1:${port}/harness.html`;
  }
});

test.afterAll(() => {
  if (localServer) localServer.close();
});

test.describe('Real Browser Test: NPM Install Express & Live Iframe Rendering', () => {
test('installs Express into browser VFS, runs HTTP server, and renders in live iframe', async ({ page }, testInfo) => {
    // 1. Build a self-contained Express npm package tarball fixture
    const encoder = new TextEncoder();
    const expressPackageJson = JSON.stringify({
      name: 'express',
      version: '4.19.2',
      description: 'Fast, unopinionated, minimalist web framework',
      main: 'lib/express.js',
    });

    const expressLibSource = `
      const http = require('node:http');
      const { EventEmitter } = require('node:events');

      function createApplication() {
        const middlewares = [];

        function app(req, res) {
          app.handle(req, res);
        }

        Object.assign(app, EventEmitter.prototype);
        EventEmitter.call(app);

        app.use = function(pathOrFn, maybeFn) {
          const route = typeof pathOrFn === 'string' ? pathOrFn : '/';
          const fn = typeof pathOrFn === 'function' ? pathOrFn : maybeFn;
          middlewares.push({ route, fn, isRoute: false });
          return app;
        };

        app.get = function(path, fn) {
          middlewares.push({ route: path, method: 'GET', fn, isRoute: true });
          return app;
        };

        app.post = function(path, fn) {
          middlewares.push({ route: path, method: 'POST', fn, isRoute: true });
          return app;
        };

        app.handle = function(req, res) {
          const parsedUrl = new URL(req.url, 'http://localhost');
          const pathname = parsedUrl.pathname;
          req.path = pathname;
          req.query = Object.fromEntries(parsedUrl.searchParams.entries());

          res.status = function(code) {
            res.statusCode = code;
            return res;
          };

          res.set = function(field, val) {
            res.setHeader(field, val);
            return res;
          };

          res.send = function(body) {
            if (typeof body === 'object' && body !== null && !(body instanceof Uint8Array)) {
              return res.json(body);
            }
            if (typeof body === 'string' && !res.getHeader('content-type')) {
              res.setHeader('content-type', 'text/html; charset=utf-8');
            }
            res.end(body);
            return res;
          };

          res.json = function(obj) {
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(obj));
            return res;
          };

          let index = 0;
          function next(err) {
            if (err) {
              res.statusCode = 500;
              return res.end('Internal Server Error: ' + (err.message || err));
            }
            if (index >= middlewares.length) {
              res.statusCode = 404;
              return res.end('Cannot ' + req.method + ' ' + pathname);
            }
            const layer = middlewares[index++];
            if (layer.isRoute) {
              const methodMatches = !layer.method || layer.method === req.method;
              const pathMatches = layer.route === '*' || layer.route === pathname;
              if (methodMatches && pathMatches) {
                try {
                  return layer.fn(req, res, next);
                } catch (e) {
                  return next(e);
                }
              }
              return next();
            } else {
              if (pathname.startsWith(layer.route)) {
                try {
                  return layer.fn(req, res, next);
                } catch (e) {
                  return next(e);
                }
              }
              return next();
            }
          }

          next();
        };

        app.listen = function(port, ...args) {
          const server = http.createServer(app);
          return server.listen(port, ...args);
        };

        return app;
      }

      module.exports = createApplication;
      module.exports.default = createApplication;
    `;

    const expressTarball = await packTarGz([
      { path: 'package/package.json', data: encoder.encode(expressPackageJson) },
      { path: 'package/lib/express.js', data: encoder.encode(expressLibSource) },
    ]);

    // Base64 encode the tarball to pass into the browser page context
    const tarballBase64 = Buffer.from(expressTarball).toString('base64');

    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', (err) => console.error('PAGE ERROR:', err));

    // 2. Navigate to the browser harness page
    await page.goto(serverUrl);

    // 3. Register the Service Worker Gateway and set up the browser Node runtime
    const bootstrapResult = await page.evaluate(async ({ tarballB64 }) => {
      // Decode the tarball
      const bin = atob(tarballB64);
      const tarballBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) tarballBytes[i] = bin.charCodeAt(i);

      // Import browser runtime modules dynamically
      const { createRuntime } = await import('/runtime.js');
      const { BrowserNpm } = await import('/runtime/npm.js');
      const { createBrowserNet } = await import('/runtime/net.js');
      const { installGatewayBridge } = await import('/runtime/gateway-bridge.js');

      // Register Service Worker and ensure it controls the page
      let swRegistration = null;
      if ('serviceWorker' in navigator) {
        swRegistration = await navigator.serviceWorker.register('/runtime/gateway-sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise((resolve) => {
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
            setTimeout(resolve, 500);
          });
        }
      }

      // Initialize runtime and VFS
      const runtime = createRuntime({ globalObject: window });
      await runtime.reset({
        runId: 'express-test',
        capabilities: {
          vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
          workers: { entryModules: ['*'], maxChildren: 8 },
          signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
          envVars: { allowed: [] },
          ipc: { enabled: true },
          output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
        },
      });

      // Mount base structure
      await runtime.mount({
        '/node/app.js': `
          const express = require('express');
          const app = express();

          app.use((req, res, next) => {
            res.set('X-Powered-By', 'Browser-Express');
            next();
          });

          app.get('/', (req, res) => {
            res.send(\`
              <!DOCTYPE html>
              <html>
                <head><title>Express in Browser</title></head>
                <body>
                  <h1 id="greeting">Hello from Browser Express!</h1>
                  <p id="status">Running in browser-native Node.js</p>
                  <a href="/__vhost__/3000/api/info?linktest=1">View JSON API</a>
                </body>
              </html>
            \`);
          });

          app.get('/api/info', (req, res) => {
            res.json({ framework: 'express', browser: true, status: 'ok' });
          });

          const server = app.listen(3000, () => {
            console.log('Browser Express listening on virtual port 3000');
          });
        `,
      });

      // Use BrowserNpm to install Express from our tarball cache
      const cache = new Map();
      cache.set('pkg-tarball:express@4.19.2', tarballBytes);
      const npm = new BrowserNpm({ vfs: runtime.vfs, cache, globalObject: window });
      const installResult = await npm.install(['express@4.19.2'], { cwd: '/node' });

      // Install Service Worker gateway bridge to forward requests to the virtual network
      const netModule = createBrowserNet({
        network: runtime.virtualNetwork,
        BufferClass: window.Buffer,
      });
      installGatewayBridge({ net: netModule, globalObject: window });

      // Execute app.js in the browser Node runtime
      let appOutput = '';
      const appPromise = runtime.executeEntry('/node/app.js', { cwd: '/node' }, (out) => {
        appOutput += out;
      }, (err) => {
        appOutput += err;
      });

      // Wait for server to bind
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Expose state for inspection
      window.__bnhExpressReady = true;
      window.__bnhAppPromise = appPromise;
      window.__bnhCreateRuntime = createRuntime;
      window.__bnhBrowserNpm = BrowserNpm;
      window.__bnhNpmCache = cache;
      window.__bnhCreateNet = createBrowserNet;
      window.__bnhInstallGatewayBridge = installGatewayBridge;
      return {
        installed: installResult.packages,
        hasExpress: runtime.vfs.files.has('/node/node_modules/express/package.json'),
        swActive: Boolean(swRegistration),
      };
    }, { tarballB64: tarballBase64 });

    expect(bootstrapResult.hasExpress).toBe(true);
    expect(bootstrapResult.installed.length).toBe(1);
    expect(bootstrapResult.installed[0].name).toBe('express');

    // 4. Create and mount a real <iframe> pointing to the virtual Express server
    await page.evaluate(() => {
      let iframe = document.getElementById('app-preview');
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'app-preview';
        iframe.style.width = '600px';
        iframe.style.height = '400px';
        document.body.appendChild(iframe);
      }
      iframe.src = '/__vhost__/3000/';
    });

    // Test direct fetch
    const directFetch = await page.evaluate(async () => {
      try {
        const res = await fetch('/__vhost__/3000/');
        const text = await res.text();
        return { status: res.status, text, headers: Object.fromEntries(res.headers.entries()) };
      } catch (err) {
        return { error: err.message };
      }
    });
    console.log('DIRECT FETCH RESULT:', directFetch);

    // 5. Wait for the iframe DOM to render and assert on the contents
    const iframe = page.frameLocator('#app-preview');
    const greeting = iframe.locator('#greeting');
    await expect(greeting).toBeVisible({ timeout: 10000 });
    await expect(greeting).toHaveText('Hello from Browser Express!');

    const status = iframe.locator('#status');
    await expect(status).toContainText('Running');

    // 6. Test the JSON API route within the browser context
    const jsonResponse = await page.evaluate(async () => {
      const res = await fetch('/__vhost__/3000/api/info');
      const poweredBy = res.headers.get('x-powered-by');
      const data = await res.json();
      return { status: res.status, poweredBy, data };
    });

    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.poweredBy).toContain('Browser-Express');
    expect(jsonResponse.data.status).toBe('ok');
    expect(jsonResponse.data.framework).toBe('express');

    const repeatedApiUrl = '/__vhost__/3000/api/info?linktest=1';
    const repeatedApi = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return {
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
      };
    }, repeatedApiUrl);
    expect(repeatedApi.status).toBe(200);
    expect(repeatedApi.cacheControl).toBe('no-store');

    const linkNavigation = page.waitForResponse(
      (response) => response.url().endsWith(repeatedApiUrl) && response.request().resourceType() === 'document',
      { timeout: 3000 },
    );
    await page.evaluate((url) => {
      const link = document.getElementById('app-preview').contentDocument.querySelector('a[href]');
      link.setAttribute('href', url);
      link.click();
    }, repeatedApiUrl);
    const linkResponse = await linkNavigation;
    expect(linkResponse.status()).toBe(200);
    expect(linkResponse.headers()['cache-control']).toBe('no-store');

    await page.evaluate(() => {
      document.getElementById('app-preview').src = '/__vhost__/3000/';
    });
    await expect(iframe.locator('#greeting')).toHaveText('Hello from Browser Express!');

    const publicApiUrl = '/api/info?linktest=2';
    const publicRedirect = testInfo.project.name === 'firefox'
      ? null
      : page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return `${url.pathname}${url.search}` === publicApiUrl
            && response.request().resourceType() === 'document';
        },
        { timeout: 3000 },
      );
    const virtualApiResponse = page.waitForResponse(
      (response) => response.url().endsWith('/__vhost__/3000/api/info?linktest=2')
        && response.request().resourceType() === 'document',
      { timeout: 3000 },
    );
    await page.evaluate((url) => {
      const link = document.getElementById('app-preview').contentDocument.querySelector('a[href]');
      link.setAttribute('href', url);
      link.click();
    }, publicApiUrl);
    if (publicRedirect) {
      const redirectResponse = await publicRedirect;
      expect(redirectResponse.status()).toBe(307);
      expect(redirectResponse.headers().location).toMatch(/\/__vhost__\/3000\/api\/info\?linktest=2$/);
    }
    const virtualResponse = await virtualApiResponse;
    expect(virtualResponse.status()).toBe(200);
    await expect.poll(() => page.locator('#app-preview').evaluate((frame) => frame.contentWindow.location.pathname))
      .toBe('/__vhost__/3000/api/info');

    // 7. Verify Hot-Reloading: Reset runtime, re-mount updated code, and re-execute
    const hotEval = await page.evaluate(async () => {
      const runtime = window.__bnhCreateRuntime({ globalObject: window });
      await runtime.reset({
        runId: 'express-hot-reload',
        capabilities: {
          vfs: { mounts: [{ path: '/node', mode: 'read-write' }] },
          workers: { entryModules: ['*'], maxChildren: 8 },
          signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
          envVars: { allowed: [] },
          ipc: { enabled: true },
          output: { maxBytes: 4 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, stderrBytes: 2 * 1024 * 1024 },
        },
      });

      const npm = new window.__bnhBrowserNpm({
        vfs: runtime.vfs,
        cache: window.__bnhNpmCache,
        globalObject: window,
      });
      await npm.install(['express@4.19.2'], { cwd: '/node' });

      await runtime.mount({
        '/node/app.js': `
          const express = require('express');
          const app = express();
          app.use((req, res, next) => {
            res.set('X-Powered-By', 'Browser-Express');
            next();
          });
          app.get('/', (req, res) => {
            res.send('<h1 id="greeting">Live Hot-Reloaded Express!</h1>');
          });
          app.listen(3000);
        `,
      });

      const netModule = window.__bnhCreateNet({
        network: runtime.virtualNetwork,
        BufferClass: window.Buffer,
      });
      window.__bnhInstallGatewayBridge({ net: netModule, globalObject: window });
      let hotOut = '';
      let hotErr = '';
      runtime.executeEntry('/node/app.js', { cwd: '/node' }, (o) => { hotOut += o; }, (e) => { hotErr += e; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      document.getElementById('app-preview').src = '/__vhost__/3000/?_t=' + Date.now();
      return { hotOut, hotErr, hasExpress: runtime.vfs.files.has('/node/node_modules/express/package.json') };
    });
    console.log('HOT EVAL RESULT:', hotEval);

    const hotFetch = await page.evaluate(async () => {
      try {
        const res = await fetch('/__vhost__/3000/');
        return { status: res.status, text: await res.text() };
      } catch (err) {
        return { error: err.message };
      }
    });
    console.log('HOT RELOAD DIRECT FETCH:', hotFetch);

    // Wait for the iframe to re-render with the newly edited code
    const updatedGreeting = iframe.locator('#greeting');
    await expect(updatedGreeting).toHaveText('Live Hot-Reloaded Express!', { timeout: 10000 });
  });
});
