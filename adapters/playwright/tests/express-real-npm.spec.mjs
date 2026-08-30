import { expect, test } from 'playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adapterRoot = path.resolve(__dirname, '..');
const npmCacheDir = path.resolve(adapterRoot, '..', '..', '.npm_cache');
if (!fs.existsSync(npmCacheDir)) fs.mkdirSync(npmCacheDir, { recursive: true });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
};

test.describe('Real Live NPM Express In-Browser Full Test', () => {
  let localServer;
  let serverUrl;

  test.beforeAll(async () => {
    localServer = http.createServer(async (req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Service-Worker-Allowed', '/');

      const parsed = new URL(req.url, 'http://127.0.0.1');
      let pathname = parsed.pathname;

      if (pathname.startsWith('/__npm_proxy__/')) {
        const targetUrl = pathname.slice('/__npm_proxy__/'.length);
        const cacheKey = crypto.createHash('sha256').update(targetUrl).digest('hex');
        const ext = targetUrl.endsWith('.tgz') ? '.tgz' : '.json';
        const cacheFile = path.join(npmCacheDir, `${cacheKey}${ext}`);
        if (fs.existsSync(cacheFile)) {
          const cachedBytes = fs.readFileSync(cacheFile);
          res.writeHead(200, {
            'Content-Type': ext === '.tgz' ? 'application/octet-stream' : 'application/json; charset=utf-8',
            'X-BNH-Disk-Cache': 'HIT',
          });
          res.end(cachedBytes);
          return;
        }

        try {
          const upstream = await fetch(targetUrl, {
            headers: {
              'Accept': 'application/vnd.npm.install-v1+json, application/json;q=0.9, */*;q=0.8',
              'User-Agent': 'browser-node-harness',
            },
          });
          if (!upstream.ok) {
            res.writeHead(upstream.status, { 'Content-Type': 'text/plain' });
            res.end(`Upstream error: ${upstream.status}`);
            return;
          }
          const buf = Buffer.from(await upstream.arrayBuffer());
          fs.writeFileSync(cacheFile, buf);
          res.writeHead(200, {
            'Content-Type': upstream.headers.get('content-type') || (ext === '.tgz' ? 'application/octet-stream' : 'application/json'),
            'X-BNH-Disk-Cache': 'MISS',
          });
          res.end(buf);
        } catch (fetchErr) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Fetch failed: ${fetchErr.message}`);
        }
        return;
      }

      if (pathname === '/' || pathname === '/index.html') pathname = '/express-demo.html';

      const safeRelative = pathname.replace(/^\/+/, '');
      const filePath = path.resolve(adapterRoot, safeRelative);

      if (!filePath.startsWith(adapterRoot) || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not Found: ${pathname}`);
        return;
      }

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });

    await new Promise((resolve) => {
      localServer.listen(0, '127.0.0.1', () => {
        const port = localServer.address().port;
        serverUrl = `http://127.0.0.1:${port}/express-demo.html`;
        console.log(`Test dev server running at: ${serverUrl}`);
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
    }
  });

  test('loads express-demo.html, installs express from npm/cache, runs server, and renders in iframe', async ({ page }) => {
    test.setTimeout(60000);

    const pageErrors = [];
    const consoleErrors = [];
    const consoleLogs = [];

    page.on('pageerror', (err) => {
      console.error('PAGE ERROR:', err.message, err.stack);
      pageErrors.push(err.message);
    });

    page.on('console', (msg) => {
      const text = msg.text();
      consoleLogs.push(text);
      if (msg.type() === 'error') {
        console.error('CONSOLE ERROR:', text);
        consoleErrors.push(text);
      } else {
        console.log('BROWSER LOG:', text);
      }
    });

    // 1. Navigate to express-demo.html
    await page.goto(serverUrl);

    // 2. Wait for server to finish initial boot or click Run
    const statusIndicator = page.locator('#status-indicator');
    await expect(statusIndicator).toHaveClass(/online/, { timeout: 30000 });

    const fetchResult = await page.evaluate(async () => {
      try {
        const res = await fetch('/__vhost__/3000/');
        const buf = await res.arrayBuffer();
        const text = new TextDecoder().decode(buf);
        const iframeDoc = document.getElementById('app-preview')?.contentDocument;
        return {
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          byteLength: buf.byteLength,
          bodySample: text.slice(0, 300),
          iframeUrl: document.getElementById('app-preview')?.src,
          iframeHtml: iframeDoc?.body?.innerHTML || 'NO_BODY',
          terminal: document.getElementById('terminal')?.innerText,
          gatewayLogs: window.__bnhGatewayLogs || [],
        };
      } catch (err) {
        return {
          error: err.message,
          terminal: document.getElementById('terminal')?.innerText,
          gatewayLogs: window.__bnhGatewayLogs || [],
        };
      }
    });
    console.log('PAGE DIAGNOSTIC FETCH:', JSON.stringify(fetchResult, null, 2));
    console.log('CAPTURED BROWSER CONSOLE LOGS:\n' + consoleLogs.join('\n'));

    // 3. Verify controlled iframe rendered the greeting
    const iframe = page.frameLocator('#app-preview');
    const greeting = iframe.locator('#greeting');
    await expect(greeting).toHaveText('Hello from Browser Express!');

    // 4. Test direct fetch from Service Worker virtual gateway
    const apiRes = await page.evaluate(async () => {
      const res = await fetch('/__vhost__/3000/api/info');
      const data = await res.json();
      return { status: res.status, data };
    });

    expect(apiRes.status).toBe(200);
    expect(apiRes.data.status).toBe('ok');
    expect(apiRes.data.framework).toBe('express');

    // 6. Test Hot-Reloading: modify editor code and click Run Express Code
    await page.evaluate(async () => {
      const editor = document.getElementById('code-editor');
      editor.value = editor.value.replace('Hello from Browser Express!', 'HOT RELOADED FROM PLAYWRIGHT!');
      await window.runServer();
    });

    // Wait for updated text in the iframe
    await expect(greeting).toHaveText('HOT RELOADED FROM PLAYWRIGHT!', { timeout: 15000 });

    // 6. Ensure no uncaught page errors occurred
    expect(pageErrors).toEqual([]);

    // 7. Hard Reload the page with warmed IndexedDB cache and verify clean boot
    await page.reload();
    await expect(statusIndicator).toHaveClass(/online/, { timeout: 20000 });
    const reloadedIframe = page.frameLocator('#app-preview');
    await expect(reloadedIframe.locator('#greeting')).toHaveText('Hello from Browser Express!', { timeout: 15000 });
    expect(pageErrors).toEqual([]);
  });
});
