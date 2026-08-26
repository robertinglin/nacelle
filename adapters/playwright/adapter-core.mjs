import { readFile, readdir, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';

const browserTypes = { chromium, firefox, webkit };
const dependencyPattern = /(?:require\s*\(\s*|from\s+|import\s*\(\s*|new\s+Worker\s*\(\s*|fork\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;
const BROWSER_LAUNCH_RETRY_DELAY_MS = 100;

function browserLaunchErrorText(error) {
  const message = error?.stack || error?.message || String(error);
  if (!Array.isArray(error?.log)) return message;
  const logs = error.log.join('\n');
  return message.includes(logs) ? message : `${message}\n${logs}`;
}

export function isTransientBrowserLaunchFailure(error, browserName) {
  if (browserName !== 'chromium') return false;
  const message = browserLaunchErrorText(error);
  return /sandbox_host_linux/i.test(message) && /\bSIGTRAP\b/i.test(message);
}

export async function launchBrowser(browserType, browserName, { retryDelayMs = BROWSER_LAUNCH_RETRY_DELAY_MS } = {}) {
  try {
    return await browserType.launch({ headless: true });
  } catch (initialError) {
    if (!isTransientBrowserLaunchFailure(initialError, browserName)) throw initialError;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      return await browserType.launch({ headless: true });
    } catch (retryError) {
      const combined = new Error(
        `${browserName} launch failed after one transient-startup retry\n` +
        `initial launch error:\n${browserLaunchErrorText(initialError)}\n` +
        `retry launch error:\n${browserLaunchErrorText(retryError)}`,
        { cause: retryError },
      );
      combined.initialError = initialError;
      throw combined;
    }
  }
}

function normalizeRelative(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized.split('/').includes('..')) throw new Error(`unsafe path: ${value}`);
  return normalized;
}

function virtualPath(relative) {
  return `/node/${normalizeRelative(relative)}`;
}

async function isFile(value) {
  try {
    return (await stat(value)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveRelative(root, importer, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (base.startsWith('../') || base === '..') return null;
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.json`,
    path.posix.join(base, 'index.js'),
    path.posix.join(base, 'index.cjs'),
    path.posix.join(base, 'index.mjs'),
    path.posix.join(base, 'index.json'),
  ];
  for (const candidate of candidates) {
    if (await isFile(path.join(root, candidate))) return normalizeRelative(candidate);
  }
  return null;
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function substitute(value, replacements) {
  let result = value;
  for (const [key, replacement] of Object.entries(replacements)) {
    result = result.replaceAll(`{${key}}`, String(replacement));
  }
  return result;
}

function decodeOutput(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return new TextDecoder().decode(Uint8Array.from(value));
  }
  return String(value);
}

async function waitForURL(url, child, timeoutMs, logs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`target server exited early with code ${child.exitCode}\n${logs.join('\n')}`);
    }
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`target server did not become ready at ${url}: ${lastError}\n${logs.join('\n')}`);
}

const runtimeExternalAssets = [
  {
    source: 'deps/acorn/acorn/dist/acorn.js',
    virtual: 'lib/internal/deps/acorn/acorn/dist/acorn.js',
  },
  {
    source: 'deps/acorn/acorn-walk/dist/walk.js',
    virtual: 'lib/internal/deps/acorn/acorn-walk/dist/walk.js',
  },
];

// The host addon-build pipeline maps each expected build/Release/*.node path
// to a compiled wasm32 artifact. Those artifacts are not in either checkout,
// so they are registered directly against their virtual .node paths.
async function loadAddonManifest(request) {
  const explicit = process.env.BNH_ADDON_MANIFEST;
  const candidate = explicit
    ? path.resolve(explicit)
    : path.resolve(request.paths.state_dir || '.', 'addon-manifest.json');
  let raw;
  try {
    raw = await readFile(candidate, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || Number(parsed.version) !== 1 || !Array.isArray(parsed.artifacts)) return null;
  return parsed;
}

export async function collectBundle(request) {
  const root = path.resolve(request.paths.node_repo);
  const targetRoot = path.resolve(request.paths.worktree);
  const entry = normalizeRelative(request.test.path);
  const bundleMode = process.env.BNH_BUNDLE_MODE || 'common';
  const maxBundleBytes = Number(process.env.BNH_BUNDLE_MAX_BYTES || 96 * 1024 * 1024);
  const maxFileBytes = Number(process.env.BNH_BUNDLE_MAX_FILE_BYTES || maxBundleBytes);
  const included = new Map();
  const omitted = [];
  let totalBytes = 0;

  async function add(relative, override = undefined, sourceRelative = relative) {
    const safe = normalizeRelative(relative);
    const source = normalizeRelative(sourceRelative);
    if (included.has(safe)) {
      if (override !== undefined) included.get(safe).override = override;
      return true;
    }
    const targetCandidate = path.join(targetRoot, safe);
    const useTargetLib = source === safe && safe.startsWith('lib/');
    let absolute = useTargetLib ? targetCandidate : path.join(root, source);
    let size;
    if (override !== undefined) size = Buffer.byteLength(override);
    else {
      try {
        size = (await stat(absolute)).size;
      } catch (error) {
        if (error?.code !== 'ENOENT' || !useTargetLib) return false;
        absolute = path.join(root, source);
        try {
          size = (await stat(absolute)).size;
        } catch (fallbackError) {
          if (fallbackError?.code === 'ENOENT') return false;
          throw fallbackError;
        }
      }
    }
    if (size > maxFileBytes) {
      omitted.push({ path: safe, reason: 'file-too-large', bytes: size });
      return false;
    }
    if (totalBytes + size > maxBundleBytes) {
      throw new Error(`test bundle exceeded BNH_BUNDLE_MAX_BYTES=${maxBundleBytes}`);
    }
    totalBytes += size;
    included.set(safe, { relative: safe, absolute, size, override });
    return true;
  }

  async function walk(relative) {
    const safe = normalizeRelative(relative);
    let entries;
    try {
      entries = await readdir(path.join(root, safe), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const item of entries) {
      const child = normalizeRelative(path.posix.join(safe, item.name));
      if (item.isDirectory()) await walk(child);
      else if (item.isFile()) await add(child);
    }
  }

  async function dependencies(relative, override = undefined, seen = new Set()) {
    const safe = normalizeRelative(relative);
    if (seen.has(safe)) return;
    seen.add(safe);
    if (!(await add(safe, override))) return;
    const record = included.get(safe);
    if (!record || !/\.(?:[cm]?js|json)$/.test(safe)) return;
    let source;
    try {
      source = override !== undefined ? override : await readFile(record.absolute, 'utf8');
    } catch {
      return;
    }
    for (const match of source.matchAll(dependencyPattern)) {
      const resolved = await resolveRelative(root, safe, match[1]);
      if (resolved) await dependencies(resolved, undefined, seen);
    }
  }

  await dependencies(entry, request.test.source_override ?? undefined);
  const addonManifest = await loadAddonManifest(request);
  if (addonManifest) {
    for (const artifact of addonManifest.artifacts) {
      if (!artifact?.node || !artifact?.wasm) continue;
      const safe = normalizeRelative(artifact.node);
      if (included.has(safe)) continue;
      const absolute = path.resolve(String(artifact.wasm));
      let size;
      try {
        size = (await stat(absolute)).size;
      } catch {
        omitted.push({ path: safe, reason: 'addon-artifact-missing', bytes: 0 });
        continue;
      }
      if (size > maxFileBytes) {
        omitted.push({ path: safe, reason: 'file-too-large', bytes: size });
        continue;
      }
      if (totalBytes + size > maxBundleBytes) {
        throw new Error(`test bundle exceeded BNH_BUNDLE_MAX_BYTES=${maxBundleBytes}`);
      }
      totalBytes += size;
      included.set(safe, { relative: safe, absolute, size, override: undefined });
    }
  }
  if (bundleMode !== 'entry') {
    await walk('test/common');
    await walk('test/fixtures');
  }
  if (bundleMode === 'runtime' || bundleMode === 'full') {
    await walk('lib');
    for (const asset of runtimeExternalAssets) {
      await add(asset.virtual, undefined, asset.source);
    }
  }
  if (bundleMode === 'full') {
    await walk(path.posix.dirname(entry));
  }

  const manifest = [...included.values()].map((record) => ({
    path: virtualPath(record.relative),
    bytes: record.size,
  }));
  const byVirtual = new Map([...included.values()].map((record) => [virtualPath(record.relative), record]));
  return {
    entry: virtualPath(entry),
    manifest,
    omitted,
    totalBytes,
    async read(virtual) {
      const record = byVirtual.get(String(virtual));
      if (!record) throw new Error(`browser requested a file outside the manifest: ${virtual}`);
      const bytes = record.override !== undefined
        ? Buffer.from(record.override, 'utf8')
        : await readFile(record.absolute);
      return { encoding: 'base64', data: bytes.toString('base64') };
    },
  };
}

export async function createAdapter() {
  const browserName = process.env.BNH_BROWSER || 'chromium';
  if (!browserTypes[browserName]) {
    throw new Error(`unsupported BNH_BROWSER=${browserName}; expected chromium, firefox, or webkit`);
  }
  const browser = await launchBrowser(browserTypes[browserName], browserName);
  const reusePage = /^(?:1|true|yes)$/i.test(process.env.BNH_REUSE_PAGE || '');
  let reusableContext = null;
  let reusablePage = null;
  let reusablePageReady = false;
  let reusableBindingInstalled = false;
  let activeBundle = null;
  let server = null;
  let serverURL = null;
  let serverWorktree = null;
  const serverLogs = [];

  function appendLog(collection, value, limit = 300) {
    collection.push(value);
    if (collection.length > limit) collection.splice(0, collection.length - limit);
  }

  async function serverIsReady(url) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  async function ensureServer(request, { forceRestart = false } = {}) {
    const worktree = path.resolve(request.paths.worktree);
    if (serverURL !== null) {
      if (serverWorktree !== worktree) throw new Error('one adapter process cannot serve multiple worktrees');
      const serverExited = server !== null && server.exitCode !== null;
      if (!forceRestart && !serverExited && await serverIsReady(serverURL)) return serverURL;
      appendLog(serverLogs, `[server:restart] target server was not reachable at ${serverURL}`);
      await stopServer();
      server = null;
      serverURL = null;
      serverWorktree = null;
    }
    const port = await allocatePort();
    const replacements = { port, worktree };
    const urlTemplate = process.env.BNH_BROWSER_URL || 'http://127.0.0.1:{port}/harness.html';
    serverURL = substitute(urlTemplate, replacements);
    serverWorktree = worktree;
    const rawCommand = process.env.BNH_SERVER_COMMAND;
    if (rawCommand) {
      let command;
      try {
        command = JSON.parse(rawCommand);
      } catch (error) {
        throw new Error(`BNH_SERVER_COMMAND must be a JSON array: ${error.message}`);
      }
      if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === 'string')) {
        throw new Error('BNH_SERVER_COMMAND must be a non-empty JSON array of strings');
      }
      const argv = command.map((item) => substitute(item, replacements));
      const needsNode = argv[0] === 'node' || argv[0] === 'npm' || argv[0] === 'npx';
      let execPath, execArgs;
      if (needsNode) {
        execPath = process.execPath;
        if (argv[0] === 'npm' || argv[0] === 'npx') {
          execArgs = argv;
        } else {
          execArgs = argv.slice(1);
        }
      } else {
        execPath = argv[0];
        execArgs = argv.slice(1);
      }
      server = spawn(execPath, execArgs, {
        cwd: worktree,
        env: { ...process.env, PORT: String(port), BNH_WORKTREE: worktree },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      server.stdout?.on('data', (chunk) => appendLog(serverLogs, `[server:stdout] ${String(chunk).trimEnd()}`));
      server.stderr?.on('data', (chunk) => appendLog(serverLogs, `[server:stderr] ${String(chunk).trimEnd()}`));
      server.once('exit', (code, signal) => {
        appendLog(serverLogs, `[server:exit] code=${code ?? 'null'} signal=${signal ?? 'none'}`);
      });
    }
    await waitForURL(
      serverURL,
      server,
      Number(process.env.BNH_SERVER_START_TIMEOUT_MS || 60_000),
      serverLogs,
    );
    return serverURL;
  }

  async function execute(request) {
    const started = Date.now();
    let browserURL = await ensureServer(request);
    const bundle = await collectBundle(request);
    let context = reusableContext;
    let page = reusablePage;
    const pageIsUsable = reusePage && page && !page.isClosed();
    if (!pageIsUsable) {
      if (reusePage && reusableContext) {
        await reusableContext.close().catch(() => {});
        reusableContext = null;
        reusablePage = null;
        reusablePageReady = false;
        reusableBindingInstalled = false;
      }
      context = await browser.newContext();
      page = await context.newPage();
      if (reusePage) {
        reusableContext = context;
        reusablePage = page;
        reusablePageReady = false;
        reusableBindingInstalled = false;
      }
    }
    const consoleLines = [];
    const onConsole = (message) => appendLog(consoleLines, `[browser:${message.type()}] ${message.text()}`);
    const onPageError = (error) => appendLog(consoleLines, `[browser:pageerror] ${error.stack || error.message}`);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    if (!reusePage || !reusableBindingInstalled) {
      if (reusePage) activeBundle = bundle;
      await page.exposeBinding('__bnhReadFile', async (_source, requestedPath) => {
        const currentBundle = reusePage ? activeBundle : bundle;
        if (!currentBundle) throw new Error('browser file binding is not active');
        return await currentBundle.read(requestedPath);
      });
      if (reusePage) reusableBindingInstalled = true;
    } else {
      activeBundle = bundle;
    }
    let discardPage = false;
    try {
      const navigationOptions = {
        waitUntil: 'domcontentloaded',
        // Setup is independent of the scan execution budget. A cold dev
        // server or first browser bundle may need longer than the fast-pass
        // test deadline.
        timeout: 60_000,
      };
      if (!reusePage || !reusablePageReady) {
        try {
          await page.goto(browserURL, navigationOptions);
        } catch (error) {
          if (!/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(String(error?.message || error))) throw error;
          browserURL = await ensureServer(request, { forceRestart: true });
          await page.goto(browserURL, navigationOptions);
        }
        await page.waitForFunction(
          () => typeof globalThis.__BROWSER_NODE_HARNESS__?.run === 'function',
          { timeout: 60_000 },
        );
        if (reusePage) reusablePageReady = true;
      }
      const bridgeRequest = {
        schemaVersion: 1,
        entry: bundle.entry,
        capabilities: request.capabilities,
        proxy: request.proxy,
        fixtures: request.fixtures,
        context: request.context,
        files: {
          mode: 'playwright-binding',
          readBinding: '__bnhReadFile',
          manifest: bundle.manifest,
        },
        flags: request.test.flags || [],
        expected: request.expected || null,
        env: {
          NODE_TEST_CONTEXT: 'child-v8',
          // Browser-injected globals are intentionally outside Node's host global allowlist.
          NODE_TEST_KNOWN_GLOBALS: '0',
          BNH_BROWSER: browserName,
        },
        timeoutMs: Number(request.limits.timeout_seconds || 120) * 1000,
        metadata: {
          testPath: request.test.path,
          sourceSha256: request.test.source_sha256,
          bundleBytes: bundle.totalBytes,
          omittedFiles: bundle.omitted,
        },
      };
      const bridgeResult = await page.evaluate(async (input) => {
        const bridge = globalThis.__BROWSER_NODE_HARNESS__;
        if (!bridge || typeof bridge.run !== 'function') {
          throw new Error('page must expose globalThis.__BROWSER_NODE_HARNESS__.run(request)');
        }
        return await bridge.run(input);
      }, bridgeRequest);
      const runResult = bridgeResult?.runResult;
      const outcome = runResult?.outcome;
      const status = outcome === 'passed'
        ? 'pass'
        : outcome === 'timed_out'
          ? 'timeout'
          : outcome === 'unsupported'
            ? 'infra_error'
            : outcome === 'failed' || outcome === 'cancelled'
              ? 'fail'
              : 'infra_error';
      const exitCode = Number.isInteger(runResult?.exit?.code)
        ? runResult.exit.code
        : Number.isInteger(bridgeResult?.exitCode) ? bridgeResult.exitCode : null;
      const timedOut = outcome === 'timed_out' || Boolean(bridgeResult?.timedOut);
      discardPage = timedOut || outcome === 'unsupported';
      return {
        status,
        exit_code: exitCode,
        duration_ms: Date.now() - started,
        stdout: decodeOutput(bridgeResult?.stdout),
        stderr: [decodeOutput(bridgeResult?.stderr), ...consoleLines].filter(Boolean).join('\n'),
        details: {
          browser: browserName,
          browserURL,
          crossOriginIsolated: await page.evaluate(() => globalThis.crossOriginIsolated),
          bundleBytes: bundle.totalBytes,
          bundleFiles: bundle.manifest.length,
          omittedFiles: bundle.omitted,
          serverLogs: serverLogs.slice(-20),
          bridge: bridgeResult?.details || {},
          tty_supported: Boolean(bridgeResult?.details?.tty_supported),
          test_output: {
            stdout: decodeOutput(bridgeResult?.stdout),
            stderr: decodeOutput(bridgeResult?.stderr),
          },
          run_result: runResult || null,
          classification: runResult?.error?.code || null,
        },
      };
    } catch (error) {
      // A fatal test can crash the page itself. Never return that page to the
      // pool or the next independent test will inherit the dead target.
      discardPage = true;
      throw error;
    } finally {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      activeBundle = null;
      if (!reusePage || discardPage) {
        await context.close();
        if (reusePage) {
          reusableContext = null;
          reusablePage = null;
          reusablePageReady = false;
          reusableBindingInstalled = false;
        }
      }
    }
  }

  async function stopServer() {
    if (server && server.exitCode === null) {
      if (process.platform === 'win32') server.kill();
      else {
        try { process.kill(-server.pid, 'SIGTERM'); }
        catch { server.kill(); }
      }
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (server.exitCode === null) {
        if (process.platform === 'win32') server.kill('SIGKILL');
        else {
          try { process.kill(-server.pid, 'SIGKILL'); }
          catch { server.kill('SIGKILL'); }
        }
      }
    }
  }

  async function close() {
    await stopServer();
    if (reusableContext) {
      await reusableContext.close();
      reusableContext = null;
      reusablePage = null;
      reusablePageReady = false;
      reusableBindingInstalled = false;
    }
    await browser.close();
  }

  return { execute, close };
}

export async function executeSafely(adapter, request) {
  const started = Date.now();
  try {
    return await adapter.execute(request);
  } catch (error) {
    return {
      status: 'infra_error',
      exit_code: null,
      duration_ms: Date.now() - started,
      stdout: '',
      stderr: error?.stack || String(error),
      details: {},
    };
  }
}
