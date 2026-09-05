import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { browserAssetPath, browserAssetContentType, harnessPage } from '../static-assets.mjs';

const adapterRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = createServer(async (request, response) => {
  try {
    const { relative, absolute } = browserAssetPath(request.url || '/', adapterRoot);
    let body;
    if (relative === 'harness.html') body = harnessPage;
    else body = await readFile(absolute);
    response.writeHead(200, {
      'content-type': browserAssetContentType(relative),
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
    'tests/als-scheduling-proof.spec.mjs',
    'tests/als-messageport-proof.spec.mjs',
    'tests/als-write-scope-proof.spec.mjs',
    'tests/als-promise-pressure.spec.mjs',
    'tests/als-extent-proof.spec.mjs',
    'tests/als-fastpath-proof.spec.mjs',
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
