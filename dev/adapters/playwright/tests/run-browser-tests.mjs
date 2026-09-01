import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const adapterRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const harnessPage = '<!doctype html><script type="module" src="/target-bridge.example.js"></script>';

function safePath(value) {
  const relative = value === '/' || value === '/harness.html' ? 'harness.html' : value.slice(1);
  const absolute = path.resolve(adapterRoot, relative);
  if (absolute !== adapterRoot && !absolute.startsWith(`${adapterRoot}${path.sep}`)) {
    throw new Error(`unsafe browser test path: ${value}`);
  }
  return { relative, absolute };
}

function contentType(relative) {
  if (relative.endsWith('.html')) return 'text/html; charset=utf-8';
  if (relative.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/javascript; charset=utf-8';
}

const server = createServer(async (request, response) => {
  try {
    const { relative, absolute } = safePath(request.url || '/');
    const body = relative === 'harness.html' ? harnessPage : await readFile(absolute);
    response.writeHead(200, {
      'content-type': contentType(relative),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Service-Worker-Allowed': '/',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(error?.message?.startsWith('unsafe') ? 400 : 404);
    response.end(String(error?.message || error));
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const port = server.address().port;
const cli = path.join(adapterRoot, 'node_modules', 'playwright', 'cli.js');
const testFiles = process.env.BNH_BROWSER_TEST_FILES
  ? process.env.BNH_BROWSER_TEST_FILES.split(',').map((file) => file.trim()).filter(Boolean)
  : [
    'tests/npm-install.spec.mjs',
    'tests/express-iframe.spec.mjs',
    'tests/vite-react-demo.spec.mjs',
    'tests/typescript-demo.spec.mjs',
    'tests/nextjs-swc-selection.spec.mjs',
    'tests/nextjs-demo.spec.mjs',
    'tests/bridge-runtime.spec.mjs',
    'tests/adapter-env.spec.mjs',
    'tests/node-test-loader-boundaries.spec.mjs',
    'tests/esm-loader.spec.mjs',
    'tests/async-primitives.spec.mjs',
    'tests/missing-primitives.spec.mjs',
    'tests/platform-primitives.spec.mjs',
    'tests/path-relative.spec.mjs',
    'tests/http-compat.spec.mjs',
    'tests/storage-compat.spec.mjs',
    'tests/perf-compat.spec.mjs',
    'tests/process-metadata.spec.mjs',
    'tests/process-umask.spec.mjs',
    'tests/node-test.spec.mjs',
    'tests/vm-compat.spec.mjs',
    'tests/assert-compat.spec.mjs',
  ];
const child = spawn(process.execPath, [
  cli,
  'test',
  ...testFiles,
  '--workers=1',
  ...(process.env.BNH_BROWSER_TEST_GREP ? ['--grep', process.env.BNH_BROWSER_TEST_GREP] : []),
  `--browser=${process.env.BNH_BROWSER || 'chromium'}`,
], {
  cwd: adapterRoot,
  env: { ...process.env, BNH_TEST_URL: `http://127.0.0.1:${port}/harness.html` },
  stdio: 'inherit',
});

const exitCode = await new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
server.close();
process.exitCode = exitCode;
