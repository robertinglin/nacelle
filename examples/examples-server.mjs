import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const examplesDir = path.resolve(repoRoot, 'examples');
const srcDir = path.resolve(repoRoot, 'src');
const npmCacheDir = path.resolve(repoRoot, '.npm_cache');
if (!fs.existsSync(npmCacheDir)) fs.mkdirSync(npmCacheDir, { recursive: true });

async function getChromium() {
  const candidatePaths = [
    path.resolve(repoRoot, 'dev', 'adapters', 'playwright', 'node_modules', 'playwright', 'index.mjs'),
    path.resolve(repoRoot, 'node_modules', 'playwright', 'index.mjs'),
  ];
  for (const pwPath of candidatePaths) {
    if (fs.existsSync(pwPath)) {
      try {
        const { chromium } = await import(pathToFileURL(pwPath).href);
        return chromium;
      } catch { /* continue */ }
    }
  }
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch {
    return null;
  }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
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
      let targetUrl;
      try {
        targetUrl = decodeURIComponent(pathname.slice('/__npm_proxy__/'.length));
        const parsedTarget = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsedTarget.protocol)) throw new Error('unsupported protocol');
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid NPM proxy target');
        return;
      }
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
            'User-Agent': 'browser-node',
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

    if (pathname === '/' || pathname === '/index.html') pathname = '/express.html';
    if (pathname === '/express') pathname = '/express.html';
    if (pathname === '/vite' || pathname === '/vite-react') pathname = '/vite-react.html';
    if (pathname === '/next' || pathname === '/nextjs') pathname = '/nextjs.html';
    if (pathname === '/wasm') pathname = '/wasm.html';
    if (pathname === '/proxy') pathname = '/proxy.html';
    if (pathname === '/typescript' || pathname === '/ts') pathname = '/typescript.html';
    if (pathname === '/bash' || pathname === '/sh') pathname = '/bash.html';
    if (pathname === '/http-client' || pathname === '/client' || pathname === '/undici') pathname = '/http-client.html';
    if (pathname === '/bcrypt') pathname = '/bcrypt.html';
    if (pathname === '/sqlite' || pathname === '/drizzle' || pathname === '/sqlite-drizzle') pathname = '/sqlite-drizzle.html';
    if (pathname === '/vitest') pathname = '/vitest.html';
    if (pathname === '/webpack') pathname = '/webpack.html';
    if (pathname === '/ws' || pathname === '/websocket') pathname = '/websocket.html';
    if (pathname === '/postgres' || pathname === '/pg') pathname = '/postgres.html';
    if (pathname === '/swc' || pathname === '/swc-wasm' || pathname === '/esbuild') pathname = '/swc-wasm.html';
    if (pathname === '/npm' || pathname === '/npm-lifecycle' || pathname === '/postinstall') pathname = '/npm-lifecycle.html';

    const safeRelative = pathname.replace(/^\/+/, '');

    // Resolve location: check examples/, src/, and versioned wasm
    let filePath = path.resolve(examplesDir, safeRelative);
    if (!fs.existsSync(filePath)) {
      filePath = path.resolve(srcDir, safeRelative);
    }
    if (!fs.existsSync(filePath) && safeRelative === 'index.mjs') {
      filePath = path.resolve(srcDir, 'index.js');
    }
    if (!fs.existsSync(filePath) && safeRelative.startsWith('wasm/')) {
      filePath = path.resolve(srcDir, 'wasm', 'v22', safeRelative.slice('wasm/'.length));
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found: ' + req.url);
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
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server Error: ' + err.message);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const port = server.address().port;
const expressUrl = `http://127.0.0.1:${port}/express.html`;
const wasmUrl = `http://127.0.0.1:${port}/wasm.html`;
const viteReactUrl = `http://127.0.0.1:${port}/vite-react.html`;
const nextjsUrl = `http://127.0.0.1:${port}/nextjs.html`;
const proxyUrl = `http://127.0.0.1:${port}/proxy.html`;
const httpClientUrl = `http://127.0.0.1:${port}/http-client.html`;
const bcryptUrl = `http://127.0.0.1:${port}/bcrypt.html`;
const sqliteUrl = `http://127.0.0.1:${port}/sqlite-drizzle.html`;
const vitestUrl = `http://127.0.0.1:${port}/vitest.html`;
const webpackUrl = `http://127.0.0.1:${port}/webpack.html`;
const websocketUrl = `http://127.0.0.1:${port}/websocket.html`;
const postgresUrl = `http://127.0.0.1:${port}/postgres.html`;
const swcUrl = `http://127.0.0.1:${port}/swc-wasm.html`;
const npmUrl = `http://127.0.0.1:${port}/npm-lifecycle.html`;

const targetUrl = process.argv.includes('--wasm')
  ? wasmUrl
  : (process.argv.includes('--vite-react') || process.argv.includes('--vite'))
    ? viteReactUrl
    : (process.argv.includes('--next') || process.argv.includes('--nextjs'))
      ? nextjsUrl
      : process.argv.includes('--typescript')
        ? `http://127.0.0.1:${port}/typescript.html`
        : process.argv.includes('--bash')
          ? `http://127.0.0.1:${port}/bash.html`
          : process.argv.includes('--http-client') || process.argv.includes('--undici')
            ? httpClientUrl
            : process.argv.includes('--bcrypt')
              ? bcryptUrl
              : process.argv.includes('--sqlite') || process.argv.includes('--drizzle')
                ? sqliteUrl
                : process.argv.includes('--vitest')
                  ? vitestUrl
                  : process.argv.includes('--webpack')
                    ? webpackUrl
                    : process.argv.includes('--ws') || process.argv.includes('--websocket')
                      ? websocketUrl
                      : process.argv.includes('--postgres') || process.argv.includes('--pg')
                        ? postgresUrl
                        : process.argv.includes('--swc') || process.argv.includes('--esbuild')
                          ? swcUrl
                          : process.argv.includes('--npm') || process.argv.includes('--postinstall')
                            ? npmUrl
                            : process.argv.includes('--proxy')
                              ? proxyUrl
                              : expressUrl;

console.log('\n======================================================');
console.log('  🚀 Nacelle Examples Server');
console.log('======================================================');
console.log(`\n  Express Example:      \x1b[36m${expressUrl}\x1b[0m`);
console.log(`  HTTP Client (Brotli): \x1b[36m${httpClientUrl}\x1b[0m`);
console.log(`  bcryptjs (on NPM):    \x1b[36m${bcryptUrl}\x1b[0m`);
console.log(`  Drizzle ORM (on NPM): \x1b[36m${sqliteUrl}\x1b[0m`);
console.log(`  uvu Runner (on NPM):  \x1b[36m${vitestUrl}\x1b[0m`);
console.log(`  Rollup (on NPM):      \x1b[36m${webpackUrl}\x1b[0m`);
console.log(`  ws (on NPM):          \x1b[36m${websocketUrl}\x1b[0m`);
console.log(`  PostgreSQL Wire Proto:\x1b[36m${postgresUrl}\x1b[0m`);
console.log(`  Type Stripping:       \x1b[36m${swcUrl}\x1b[0m`);
console.log(`  React SSR (on NPM):   \x1b[36m${nextjsUrl}\x1b[0m`);
console.log(`  NPM Package Lifecycle:\x1b[36m${npmUrl}\x1b[0m`);
console.log(`  Vite + React Example: \x1b[36m${viteReactUrl}\x1b[0m`);
console.log(`  WASM Addon Example:   \x1b[36m${wasmUrl}\x1b[0m\n`);
console.log(`  Bash Shell Example:   \x1b[36mhttp://127.0.0.1:${port}/bash.html\x1b[0m`);
console.log(`  TypeScript (on NPM):  \x1b[36mhttp://127.0.0.1:${port}/typescript.html\x1b[0m\n`);
console.log(`  Proxy Config Example: \x1b[36m${proxyUrl}\x1b[0m\n`);
console.log(`  Target URL:           \x1b[32m${targetUrl}\x1b[0m\n`);

let browser = null;
try {
  const chromium = await getChromium();
  if (!chromium) throw new Error('Playwright not found');

  browser = await chromium.launch({
    headless: false,
    args: ['--enable-features=SharedArrayBuffer'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      console.error(`  [Browser ${type}] ${text}`);
    } else if (text.includes('Ready') || text.includes('listening') || text.includes('Server')) {
      console.log(`  [Browser ${type}] \x1b[32m${text}\x1b[0m`);
    }
  });

  page.on('pageerror', err => {
    console.error('  [Browser Uncaught Error]', err);
  });

  await page.goto(targetUrl, { waitUntil: 'load' });
  console.log('  Browser launched. Press Ctrl+C to close and exit.\n');

  await new Promise(() => {});
} catch (err) {
  console.log(`  (Note: automated browser launch skipped: ${err.message})`);
  console.log(`  Open ${targetUrl} in your browser to view the demo.\n`);
  console.log('  Server is running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
