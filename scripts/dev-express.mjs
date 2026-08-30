import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adapterRoot = path.resolve(__dirname, '..', 'adapters', 'playwright');
const npmCacheDir = path.resolve(__dirname, '..', '.npm_cache');
if (!fs.existsSync(npmCacheDir)) fs.mkdirSync(npmCacheDir, { recursive: true });

async function getChromium() {
  try {
    const pwPath = path.resolve(adapterRoot, 'node_modules', 'playwright', 'index.mjs');
    const { chromium } = await import(pathToFileURL(pwPath).href);
    return chromium;
  } catch {
    try {
      const { chromium } = await import('playwright');
      return chromium;
    } catch {
      return null;
    }
  }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Service-Worker-Allowed', '/');

    let pathname = new URL(req.url, 'http://localhost').pathname || '/';
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

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
    });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found: ' + req.url);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const port = server.address().port;
const demoUrl = `http://127.0.0.1:${port}/express-demo.html`;
const wasmDemoUrl = `http://127.0.0.1:${port}/wasm-demo.html`;
const viteReactDemoUrl = `http://127.0.0.1:${port}/vite-react-demo.html`;
const targetUrl = process.argv.includes('--wasm')
  ? wasmDemoUrl
  : (process.argv.includes('--vite-react') || process.argv.includes('--vite'))
    ? viteReactDemoUrl
    : demoUrl;

console.log('\n======================================================');
console.log('  🚀 Browser Node Harness Dev Server');
console.log('======================================================');
console.log(`\n  Express Demo:  \x1b[36m${demoUrl}\x1b[0m`);
console.log(`  Vite + React:  \x1b[36m${viteReactDemoUrl}\x1b[0m`);
console.log(`  WASM Demo:     \x1b[36m${wasmDemoUrl}\x1b[0m\n`);
console.log(`  Launching browser at ${targetUrl}...\n`);

let browser = null;
try {
  const chromium = await getChromium();
  if (!chromium) throw new Error('Playwright not found');

  browser = await chromium.launch({
    headless: false, // Open real visible browser window for interactive use
    args: ['--enable-features=SharedArrayBuffer'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    if (!text.includes('[vite]') && !text.includes('Download the Vue Devtools')) {
      console.log(`  [Browser] ${text}`);
    }
  });

  await page.goto(targetUrl);
  console.log('  ✓ Browser window opened successfully.');
  console.log('  Press Ctrl+C to stop the dev server.\n');

  // Keep server running until browser is closed or process killed
  browser.on('disconnected', () => {
    console.log('\nBrowser closed. Exiting dev server...');
    server.close();
    process.exit(0);
  });
} catch (error) {
  console.warn(`  ℹ️ Headed browser launch info: ${error.message}`);
  console.log(`  👉 You can open the live demo directly in your browser at:\n     \x1b[36;1m${targetUrl}\x1b[0m\n`);
  console.log('  Press Ctrl+C to stop the server.\n');
}

process.on('SIGINT', async () => {
  console.log('\nShutting down dev server...');
  if (browser) await browser.close().catch(() => {});
  server.close();
  process.exit(0);
});
