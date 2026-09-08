import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const examplesDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(examplesDir, '..');
const distDir = path.resolve(repoRoot, 'dist');
const examplePath = path.resolve(examplesDir, 'direct-iframe-cdn.html');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function writeCommonHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function resolveDistPath(pathname) {
  const prefix = '/nacelle@n22';
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;

  let relativePath = pathname.slice(prefix.length).replace(/^\/+/, '');
  if (!relativePath) relativePath = 'index.mjs';

  const candidate = path.resolve(distDir, relativePath);
  if (candidate !== distDir && !candidate.startsWith(`${distDir}${path.sep}`)) return null;
  return candidate;
}

async function serveCdn(request, response) {
  writeCommonHeaders(response);
  const pathname = new URL(request.url, 'http://cdn.local').pathname;
  if (pathname === '/nacelle@n22') {
    response.writeHead(302, { Location: '/nacelle@n22/' });
    response.end();
    return;
  }
  const filePath = resolveDistPath(pathname);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${pathname}`);
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
  });
  response.end(await readFile(filePath));
}

async function serveApp(request, response, cdnUrl) {
  writeCommonHeaders(response);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Service-Worker-Allowed', '/');

  const pathname = new URL(request.url, 'http://app.local').pathname;
  if (pathname.startsWith('/__npm_proxy__/')) {
    let targetUrl;
    try {
      targetUrl = decodeURIComponent(pathname.slice('/__npm_proxy__/'.length));
      const target = new URL(targetUrl);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('unsupported protocol');
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid NPM proxy target');
      return;
    }

    try {
      const upstream = await fetch(targetUrl, {
        headers: {
          Accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9, */*;q=0.8',
          'User-Agent': 'browser-node-harness',
        },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`NPM proxy failed: ${error.message}`);
    }
    return;
  }

  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (pathname !== '/' && pathname !== '/direct-iframe-cdn.html') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${pathname}`);
    return;
  }

  const source = await readFile(examplePath, 'utf8');
  const html = source.replace('https://esm.sh/nacelle@n22', cdnUrl);
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  });
  response.end(html);
}

function listen(server, host, requestedPort) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => resolve(server.address().port));
  });
}

let actualCdnPort;

const appServer = createServer((request, response) => {
  const cdnUrl = `http://localhost:${actualCdnPort}/nacelle@n22`;
  serveApp(request, response, cdnUrl).catch(error => {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`App server error: ${error.message}`);
  });
});

const cdnServer = createServer((request, response) => {
  serveCdn(request, response).catch(error => {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`CDN server error: ${error.message}`);
  });
});

actualCdnPort = await listen(cdnServer, '127.0.0.1', Number(process.env.BNH_CDN_PORT || 0));
const appPort = await listen(appServer, '127.0.0.1', Number(process.env.BNH_APP_PORT || 0));
const appUrl = `http://127.0.0.1:${appPort}/direct-iframe-cdn.html`;
const cdnUrl = `http://localhost:${actualCdnPort}/nacelle@n22`;

console.log('Nacelle local esm.sh simulation');
console.log(`App: ${appUrl}`);
console.log(`CDN: ${cdnUrl}`);
console.log('Press Ctrl-C to stop.');

function closeServers() {
  appServer.close();
  cdnServer.close();
}

process.once('SIGINT', closeServers);
process.once('SIGTERM', closeServers);
