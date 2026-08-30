import { expect, test } from 'playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCacheDir = path.resolve(adapterRoot, '..', '..', '.npm_cache');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

let localServer;
let serverUrl;

function setIsolationHeaders(response) {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Service-Worker-Allowed', '/');
}

async function serveNpmProxy(response, pathname) {
  const targetUrl = pathname.slice('/__npm_proxy__/'.length);
  const cacheKey = crypto.createHash('sha256').update(targetUrl).digest('hex');
  const extension = targetUrl.endsWith('.tgz') ? '.tgz' : '.json';
  const cacheFile = path.join(npmCacheDir, `${cacheKey}${extension}`);

  if (fs.existsSync(cacheFile)) {
    response.writeHead(200, {
      'Content-Type': extension === '.tgz' ? 'application/octet-stream' : 'application/json; charset=utf-8',
      'X-BNH-Disk-Cache': 'HIT',
    });
    response.end(fs.readFileSync(cacheFile));
    return;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9, */*;q=0.8',
        'User-Agent': 'browser-node-harness',
      },
    });
    if (!upstream.ok) {
      response.writeHead(upstream.status, { 'Content-Type': 'text/plain' });
      response.end(`Upstream error: ${upstream.status}`);
      return;
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    fs.writeFileSync(cacheFile, bytes);
    response.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'X-BNH-Disk-Cache': 'MISS',
    });
    response.end(bytes);
  } catch (error) {
    response.writeHead(502, { 'Content-Type': 'text/plain' });
    response.end(`Fetch failed: ${error.message}`);
  }
}

test.describe('Vite + React browser demo', () => {
  test.beforeAll(async () => {
    localServer = http.createServer(async (request, response) => {
      setIsolationHeaders(response);
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;

      if (pathname.startsWith('/__npm_proxy__/')) {
        await serveNpmProxy(response, pathname);
        return;
      }

      const relativePath = pathname === '/' ? 'vite-react-demo.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(adapterRoot, relativePath);
      if (!filePath.startsWith(`${adapterRoot}${path.sep}`) && filePath !== adapterRoot) {
        response.writeHead(403, { 'Content-Type': 'text/plain' });
        response.end('Forbidden');
        return;
      }

      try {
        const data = await fs.promises.readFile(filePath);
        response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
        response.end(data);
      } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end(`Not Found: ${pathname}`);
      }
    });

    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${localServer.address().port}/vite-react-demo.html`;
  });

  test.afterAll(async () => {
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  });

  test('renders React, serves Vite-style assets, and keeps relative navigation virtual', async ({ page }) => {
    test.setTimeout(60000);
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(serverUrl);
    const status = page.locator('#status-indicator');
    await expect(status).toHaveText(/Online/, { timeout: 30000 });

    const app = page.frameLocator('#app-preview');
    await expect(app.locator('#app-title')).toHaveText('Vite + React in Browser Node');
    await expect(app.locator('#app-status')).toContainText('React 18');
    await expect(app.locator('#increment')).toHaveText('Count: 0');
    await app.locator('#increment').click();
    await expect(app.locator('#increment')).toHaveText('Count: 1');

    await app.locator('#api-check').click();
    await expect(app.locator('#api-status')).toHaveText('API: ok / vite-react');

    const publicAbout = page.waitForResponse(
      (response) => response.url().endsWith('/about')
        && response.request().resourceType() === 'document'
        && response.status() === 307,
      { timeout: 5000 },
    );
    const virtualAbout = page.waitForResponse(
      (response) => response.url().endsWith('/__vhost__/5173/about')
        && response.request().resourceType() === 'document',
      { timeout: 5000 },
    );
    await page.evaluate(() => document.getElementById('app-preview').contentDocument.getElementById('about-link').click());
    const [aboutRedirect, aboutResponse] = await Promise.all([publicAbout, virtualAbout]);
    expect(aboutRedirect.headers().location).toMatch(/\/__vhost__\/5173\/about$/);
    expect(aboutResponse.status()).toBe(200);
    expect(aboutResponse.headers()['cache-control']).toBe('no-store');
    expect(aboutResponse.headers()['cross-origin-embedder-policy']).toBe('require-corp');
    await expect(app.locator('#app-title')).toHaveText('About the React app');

    const homeResponse = page.waitForResponse(
      (response) => response.url().endsWith('/__vhost__/5173/')
        && response.request().resourceType() === 'document',
      { timeout: 5000 },
    );
    await page.evaluate(() => document.getElementById('app-preview').contentDocument.getElementById('home-link').click());
    await homeResponse;
    await expect(app.locator('#app-title')).toHaveText('Vite + React in Browser Node');

    await page.getByRole('button', { name: 'Restart Vite Server' }).click();
    await expect(status).toHaveText(/Online/, { timeout: 20000 });
    await expect(app.locator('#app-title')).toHaveText('Vite + React in Browser Node', { timeout: 15000 });

    const restartedAbout = page.waitForResponse(
      (response) => response.url().endsWith('/__vhost__/5173/about')
        && response.request().resourceType() === 'document',
      { timeout: 5000 },
    );
    await page.evaluate(() => document.getElementById('app-preview').contentDocument.getElementById('about-link').click());
    expect((await restartedAbout).status()).toBe(200);
    await expect(app.locator('#app-title')).toHaveText('About the React app');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
