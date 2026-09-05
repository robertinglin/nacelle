import { expect, test } from 'playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(adapterRoot, '../../..');
const canonicalExample = path.join(repoRoot, 'examples', 'nextjs.html');
const distRoot = path.join(repoRoot, 'dist');
const srcRoot = path.join(repoRoot, 'src');
const npmCacheDir = path.join(repoRoot, '.npm_cache');

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

test.describe('Next.js 16 App Router browser demo', () => {
  test.beforeAll(async () => {
    await fs.promises.mkdir(npmCacheDir, { recursive: true });
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
        const upstream = await fetch(targetUrl, { headers: { accept: 'application/json, application/octet-stream' } });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        await fs.promises.writeFile(cachePath, bytes);
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' });
        response.end(bytes);
        return;
      }

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
    test.setTimeout(660000);
    const consoleErrors = [];
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    // 1. Initial Page Load & Next.js Server Boot
    await page.addInitScript(() => { window.__bnhGatewayLogs = []; });
    await page.goto(serverUrl);
    const serverStatus = page.locator('#server-status');
    const termOutput = page.locator('#term-output');
    // Firefox can retain an about:blank automation context after a Service Worker
    // navigation. Read the live same-origin document through its owning element.
    const previewText = (selector, timeout = 10000) => expect.poll(
      () => page.locator('#app-preview').evaluate((frame, selector) => (
        frame.contentDocument?.querySelector(selector)?.textContent || ''
      ), selector),
      { timeout },
    );

    try {
      await expect(termOutput).toContainText('▲ Next.js 16.3.3', { timeout: 25000 });
    } catch (error) {
      throw new Error(`${error.message}\nPAGE ERRORS: ${JSON.stringify(pageErrors)}\nCONSOLE ERRORS: ${JSON.stringify(consoleErrors)}\nURL: ${page.url()}`);
    }
    await expect(termOutput).toContainText('Ready in');
    await page.waitForTimeout(2000);
    await page.waitForTimeout(10000);
    try {
      // Cold first compile of the App Router takes ~48s in the browser VFS,
      // and the page's server probe (waitForNextServer) polls for the full
      // compile before flipping this dot. The budget below must exceed that
      // cold path, not just the warm one.
      await expect(serverStatus).toHaveClass(/active/, { timeout: 90000 });
    } catch (error) {
      throw new Error(`${error.message}\nNEXT TERMINAL:\n${await termOutput.textContent()}`
        + `\nGATEWAY LOGS:\n${JSON.stringify(await page.evaluate(() => window.__bnhGatewayLogs || []))}`);
    }

    // Verify home page SSR in the App Router iframe.
    await previewText('body', 30000).toContain('Hello Next.js!');
    await previewText('h1').toBe('Hello Next.js!');

    const originalSource = await page.locator('#code-editor').inputValue();
    await page.locator('#app-preview').evaluate(frame => { frame.contentWindow.__bnhHmrDocument = 'original'; });
    await page.locator('#code-editor').fill(originalSource.replace('Hello Next.js!', 'Hello hot reload!'));
    await page.locator('#btn-apply-code').click();
    await previewText('h1', 60000).toBe('Hello hot reload!');
    expect(await page.locator('#app-preview').evaluate(frame => frame.contentWindow.__bnhHmrDocument)).toBe('original');
    await page.locator('#code-editor').fill(originalSource);
    await page.locator('#btn-apply-code').click();
    await previewText('h1', 60000).toBe('Hello Next.js!');

    await page.locator('.btn-route:has-text("/about")').click();
    await previewText('h1').toBe('About the Next.js runtime');

    await page.locator('.btn-route:has-text("/dashboard")').click();
    await previewText('h1').toBe('Next.js runtime diagnostics');

    await page.locator('.btn-route:has-text("/api/hello")').click();
    await previewText('body').toContain('Hello from a native Next.js route');

    await page.locator('#btn-build').click();
    try {
      await expect(termOutput).toContainText(/Next.js build exited with code \d+/, { timeout: 600000 });
      await expect(termOutput).toContainText('Next.js build exited with code 0');
    } catch (error) {
      throw new Error(`${error.message}\nNEXT TERMINAL:\n${await termOutput.textContent()}\nPAGE ERRORS: ${JSON.stringify(pageErrors)}\nCONSOLE ERRORS: ${JSON.stringify(consoleErrors)}`);
    }
    await page.locator('#btn-start').click();
    try {
      await expect(serverStatus).toHaveClass(/active/, { timeout: 30000 });
    } catch (error) {
      throw new Error(`${error.message}\nNEXT TERMINAL:\n${await termOutput.textContent()}`);
    }
    await page.locator('.btn-route[data-route="/"]').click();
    await previewText('h1', 30000).toBe('Hello Next.js!');
    await page.locator('.btn-route[data-route="/about"]').click();
    await previewText('h1').toBe('About the Next.js runtime');
    await page.locator('.btn-route[data-route="/api/hello"]').click();
    await previewText('body').toContain('Hello from a native Next.js route');
    await page.evaluate(() => window.__bnhStopNextApp?.());

    const expectedConsoleErrorFragments = [
      // The readiness probe polls / through the Service Worker gateway while
      // the dev server is still booting; each refused connection is reported
      // by the gateway as a 502 response the browser logs as a resource error.
      'the server responded with a status of 502',
    ];
    const unexpectedConsoleErrors = consoleErrors.filter((message) => (
      !expectedConsoleErrorFragments.some((fragment) => message.includes(fragment))
    ));
    expect(unexpectedConsoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
