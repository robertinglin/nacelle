import fs from 'node:fs';
import http from 'node:http';
import process from 'node:process';
import { browserAssetPath, browserAssetContentType, harnessPage } from './static-assets.mjs';

const args = process.argv.slice(2);
let port = 3000;
let host = '127.0.0.1';
const root = process.env.BNH_WORKTREE || process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
  }
  if (args[i] === '--host' && i + 1 < args.length) {
    host = args[i + 1];
  }
}

const server = http.createServer((req, res) => {
  let relative, filePath;
  try {
    ({ relative, absolute: filePath } = browserAssetPath(req.url || '/', root));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(error.message);
    return;
  }
  const contentType = browserAssetContentType(relative);

  fs.readFile(filePath, (err, data) => {
    if (err?.code === 'ENOENT' && relative === 'harness.html') {
      err = null;
      data = harnessPage;
    }
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found: ' + relative);
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Service-Worker-Allowed': '/',
      });
      res.end(data);
    }
  });
});

server.listen(port, host, () => {
  // Silent success
});
