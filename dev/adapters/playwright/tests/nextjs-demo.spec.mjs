import { expect, test } from 'playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(adapterRoot, '../../..');
const canonicalExample = path.join(repoRoot, 'examples', 'nextjs.html');
const distRoot = path.join(repoRoot, 'dist');
const srcRoot = path.join(repoRoot, 'src');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
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

test.describe('Next.js 14 App Router browser demo', () => {
  test.beforeAll(async () => {
    localServer = http.createServer(async (request, response) => {
      setIsolationHeaders(response);
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;

      if (pathname === '/' || pathname === '/nextjs.html') {
        const data = await fs.promises.readFile(canonicalExample);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(data);
        return;
      }

      const relativePath = pathname.replace(/^\/+/, '');
      const candidatePaths = [
        path.resolve(repoRoot, relativePath),
        path.resolve(srcRoot, relativePath),
        path.resolve(distRoot, relativePath),
        path.resolve(adapterRoot, relativePath),
      ];

      for (const filePath of candidatePaths) {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const data = await fs.promises.readFile(filePath);
          response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
          response.end(data);
          return;
        }
      }

      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end(`Not Found: ${pathname}`);
    });

    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${localServer.address().port}/nextjs.html`;
  });

  test.afterAll(async () => {
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  });

  test('loads Next.js demo and executes App Router SSR, client navigation, and API routes', async ({ page }) => {
    test.setTimeout(60000);
    const consoleErrors = [];
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    // 1. Initial Page Load & Next.js Server Boot
    await page.goto(serverUrl);
    const serverStatus = page.locator('#server-status');
    const termOutput = page.locator('#term-output');
    const iframe = page.frameLocator('#app-preview');

    // Wait for server ready state
    await expect(serverStatus).toHaveClass(/active/, { timeout: 25000 });
    await expect(termOutput).toContainText('▲ Next.js 14.2.5', { timeout: 25000 });
    await expect(termOutput).toContainText('Ready in');

    // 2. Verify Home Page (app/page.tsx) SSR in Iframe
    await expect(iframe.locator('body')).toContainText('Next.js 14 App Router');
    await expect(iframe.locator('body')).toContainText('In-Browser Node 22');

    // 3. Test Navigation to /about route
    await page.locator('.btn-route:has-text("/about")').click();
    await expect(iframe.locator('body')).toContainText('About Next.js In-Browser Engine', { timeout: 10000 });
    await expect(iframe.locator('body')).toContainText('Key Architecture Highlights');

    // 4. Test Navigation to /dashboard route
    await page.locator('.btn-route:has-text("/dashboard")').click();
    await expect(iframe.locator('body')).toContainText('Next.js Analytics Dashboard', { timeout: 10000 });
    await expect(iframe.locator('body')).toContainText('Active Routes');

    // 5. Test Navigation to /api/hello JSON route
    await page.locator('.btn-route:has-text("/api/hello")').click();
    await expect(iframe.locator('body')).toContainText('Hello from Next.js 14 App Router', { timeout: 10000 });
    await expect(iframe.locator('body')).toContainText('Next.js 14.2.5');

    // 6. Test Next.js Build Mode (next build)
    await page.locator('#btn-build').click();
    await expect(termOutput).toContainText('Creating an optimized production build...', { timeout: 15000 });
    await expect(termOutput).toContainText('Emitted routes: / (SSR), /about (Static), /dashboard (SSR), /api/hello (Function)');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
