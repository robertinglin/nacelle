import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const adapterRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const server = createServer(async (request, response) => {
  const relative = request.url === '/' || request.url === '/harness.html' ? 'harness.html' : request.url.slice(1);
  const body = relative === 'harness.html'
    ? '<!doctype html><script type="module" src="/target-bridge.example.js"></script>'
    : await readFile(path.join(adapterRoot, relative));
  response.writeHead(200, { 'content-type': relative.endsWith('.html') ? 'text/html' : 'text/javascript' });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const child = spawn(process.execPath, [path.join(adapterRoot, 'node_modules/playwright/cli.js'), 'test', 'tests/node-test.spec.mjs', '--workers=1'], {
  cwd: adapterRoot,
  env: { ...process.env, BNH_TEST_URL: `http://127.0.0.1:${port}/harness.html` },
  stdio: 'inherit',
});
const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
server.close();
process.exitCode = exitCode;
