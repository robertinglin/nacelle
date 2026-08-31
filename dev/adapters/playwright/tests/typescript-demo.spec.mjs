import { expect, test } from 'playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(adapterRoot, '../../..');
const canonicalExample = path.join(repoRoot, 'examples', 'typescript.html');
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

test.describe('TypeScript multi-compiler browser demo', () => {
  test.beforeAll(async () => {
    localServer = http.createServer(async (request, response) => {
      setIsolationHeaders(response);
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;

      if (pathname === '/' || pathname === '/typescript.html') {
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
    serverUrl = `http://127.0.0.1:${localServer.address().port}/typescript.html`;
  });

  test.afterAll(async () => {
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  });

  test('loads TypeScript demo and executes Node 22, Vite, and tsc compilation pipelines', async ({ page }) => {
    test.setTimeout(60000);
    const consoleErrors = [];
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    // 1. Initial Page Load (Node.js Type Stripping Mode)
    await page.goto(serverUrl);
    const status = page.locator('#status');
    const exitStatus = page.locator('#exit-status');
    const compiled = page.locator('#compiled');
    const resultCaption = page.locator('#result');

    // Wait for initial compilation to complete
    await expect(status).toHaveText(/compiled via Node 22 stripTypeScriptTypes/, { timeout: 25000 });
    await expect(exitStatus).toHaveText('exit 0');
    expect(await compiled.textContent()).toContain('Ada Lovelace');
    expect(await resultCaption.textContent()).toContain('Ada Lovelace');

    // 2. Switch to Vite Transform Mode
    await page.locator('.engine-tab[data-engine="vite"]').click();
    await expect(status).toHaveText(/compiled via Vite \(esbuild\)/, { timeout: 25000 });
    await expect(exitStatus).toHaveText('exit 0');
    const viteEmitted = await compiled.textContent();
    expect(viteEmitted).toContain('[vite:esbuild]');
    expect(viteEmitted).toContain('Ada Lovelace');
    expect(await resultCaption.textContent()).toContain('Ada Lovelace');

    // 3. Switch to Official TypeScript Compiler (tsc) Mode
    await page.locator('.engine-tab[data-engine="tsc"]').click();
    await expect(status).toHaveText(/compiled via tsc v5.5.4/, { timeout: 25000 });
    await expect(exitStatus).toHaveText('exit 0');
    const tscEmitted = await compiled.textContent();
    expect(tscEmitted).toContain('Emitted by Microsoft TypeScript Compiler (tsc v5.5.4)');
    expect(tscEmitted).toContain('Object.defineProperty(exports, "__esModule"');
    expect(await resultCaption.textContent()).toContain('Ada Lovelace');

    // 4. Switch to 3-Way Comparison Matrix Mode
    await page.locator('.engine-tab[data-engine="all"]').click();
    const compView = page.locator('#comparison-view');
    await expect(compView).toBeVisible();

    const nodeCol = page.locator('#comp-node-out');
    const viteCol = page.locator('#comp-vite-out');
    const tscCol = page.locator('#comp-tsc-out');

    await expect(nodeCol).toContainText('Ada Lovelace');
    await expect(viteCol).toContainText('[vite:esbuild]');
    await expect(tscCol).toContainText('Emitted by Microsoft TypeScript Compiler');

    // 5. Test Switching Presets (Generics & Enums)
    await page.locator('.btn-preset[data-preset="enums"]').click();
    await expect(status).toHaveText(/all 3 compiled/, { timeout: 25000 });
    await expect(exitStatus).toHaveText('exit 0');

    await expect(nodeCol).toContainText('TaskStatus');
    await expect(viteCol).toContainText('TaskStatus');
    await expect(tscCol).toContainText('var TaskStatus');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
