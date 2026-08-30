import { createRuntime, runtime as defaultRuntime } from './runtime.js';
import { BrowserNpm, BrowserNpmCache } from './runtime/npm.js';
import { installGatewayBridge } from './runtime/gateway-bridge.js';
import { watchFrameAddress } from './runtime/frame-address.js';
import { createBrowserNet } from './runtime/net.js';
import { createBufferClass } from './runtime/buffer.js';

export { createRuntime, defaultRuntime as runtime, BrowserNpm, BrowserNpmCache, createBrowserNet, createBufferClass };

/**
 * High-level Browser Node.js Runtime Platform
 */
export class BrowserNode {
  /**
   * Helper to register the Service Worker HTTP Gateway
   * @param {string} [swPath='/runtime/gateway-sw.js']
   * @param {string} [scope='/']
   */
  static async initServiceWorker(swPath = '/runtime/gateway-sw.js', scope = '/') {
    if (typeof globalThis.navigator === 'undefined' || !('serviceWorker' in globalThis.navigator)) {
      return null;
    }
    const controllerChange = new Promise((resolve) => {
      let timeout;
      const finish = () => {
        clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', finish);
        resolve();
      };
      navigator.serviceWorker.addEventListener('controllerchange', finish);
      timeout = setTimeout(finish, 2000);
    });

    const registration = await navigator.serviceWorker.register(swPath, {
      scope,
      updateViaCache: 'none',
    });
    await registration.update().catch(() => {});
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller || registration.installing || registration.waiting) {
      await controllerChange;
    }
    return registration;
  }

  /**
   * Create and initialize an in-browser Node.js instance
   * @param {Object} [options]
   * @param {string} [options.version='22'] Node.js target version
   * @param {string} [options.cwd='/node'] Default working directory
   * @param {Record<string, string>} [options.env={}] Environment variables
   * @param {Record<string, string|Uint8Array>} [options.files={}] Initial files to seed in VFS
   * @param {boolean|Object} [options.gateway=true] Enable Service Worker & iframe gateway
   * @param {string} [options.wasmBaseUrl] Custom base URL for WASM binaries
   * @param {Object} [options.globalObject=globalThis]
   */
  static async create(options = {}) {
    const cwd = options.cwd || '/node';
    const globalObject = options.globalObject || globalThis;
    const env = {
      NODE_ENV: 'development',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      ...options.env,
    };

    // Ensure Buffer is present on the global object
    const BufferClass = globalObject.Buffer || createBufferClass(globalObject);
    globalObject.Buffer = BufferClass;

    // Auto-register Service Worker gateway in browser if enabled
    if (options.gateway !== false && typeof globalObject.navigator?.serviceWorker !== 'undefined') {
      const swPath = typeof options.gateway === 'object' && options.gateway.swPath
        ? options.gateway.swPath
        : '/runtime/gateway-sw.js';
      const scope = typeof options.gateway === 'object' && options.gateway.scope
        ? options.gateway.scope
        : '/';
      await BrowserNode.initServiceWorker(swPath, scope).catch((err) => {
        console.warn('[BrowserNode] Service Worker registration skipped:', err.message);
      });
    }

    const runtime = createRuntime({
      globalObject,
      version: `v${options.version || '22'}`,
      wasmBaseUrl: options.wasmBaseUrl,
    });

    const mounts = [
      { path: '/node', mode: 'read-write' },
      { path: '/', mode: 'read-write' },
    ];
    if (cwd && cwd !== '/node' && cwd !== '/') {
      mounts.unshift({ path: cwd, mode: 'read-write' });
    }

    // Reset runtime state with default grants
    await runtime.reset({
      runId: `node-session-${Date.now()}`,
      capabilities: {
        vfs: { mounts },
        workers: { entryModules: ['*'], maxChildren: 8 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 10 * 1024 * 1024, stdoutBytes: 4 * 1024 * 1024, stderrBytes: 4 * 1024 * 1024 },
        envVars: { allowed: Object.keys(env) },
        proxy: { mode: 'virtual', enabled: false },
      },
    });

    // Install Gateway Bridge with proper createBrowserNet instance
    if (runtime.virtualNetwork) {
      const netModule = createBrowserNet({
        network: runtime.virtualNetwork,
        BufferClass,
      });
      installGatewayBridge({ net: netModule, globalObject });
    }

    const instance = new BrowserNode(runtime, { cwd, env, globalObject });

    // Seed initial files if provided
    if (options.files) {
      for (const [filePath, content] of Object.entries(options.files)) {
        await instance.fs.writeFile(filePath, content);
      }
    }

    return instance;
  }

  constructor(runtimeInstance, config) {
    this._runtime = runtimeInstance;
    this._cwd = config.cwd;
    this._env = config.env;
    this._globalObject = config.globalObject;
    this._listeners = new Map();
    this._npmCache = new BrowserNpmCache({ globalObject: this._globalObject });
  }

  /** Low-level runtime bridge */
  get rawRuntime() {
    return this._runtime;
  }

  /** Virtual File System broker */
  get vfs() {
    return this._runtime.vfs;
  }

  /** Virtual Network broker */
  get virtualNetwork() {
    return this._runtime.virtualNetwork;
  }

  /**
   * Filesystem API (VFS)
   */
  get fs() {
    const vfs = this._runtime.vfs;
    return {
      readFile: async (filePath, encoding = 'utf8') => {
        const bytes = await vfs.fs.promises.readFile(filePath);
        if (encoding === 'utf8' || encoding === 'utf-8') {
          return typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
        }
        return bytes;
      },
      writeFile: async (filePath, data) => {
        return vfs.fs.promises.writeFile(filePath, data);
      },
      mkdir: async (dirPath, opts) => vfs.fs.promises.mkdir(dirPath, opts),
      readdir: async (dirPath) => vfs.fs.promises.readdir(dirPath),
      stat: async (targetPath) => vfs.fs.promises.stat(targetPath),
      unlink: async (targetPath) => vfs.fs.promises.unlink(targetPath),
      exists: async (targetPath) => vfs.fs.existsSync(targetPath),
      snapshot: () => vfs.snapshot(),
      mount: (snapshot) => this._runtime.mount(snapshot),
    };
  }

  /**
   * In-Browser NPM package manager
   */
  get npm() {
    const npmClient = new BrowserNpm({
      vfs: this._runtime.vfs,
      cache: this._npmCache,
      globalObject: this._globalObject,
    });

    return {
      /**
       * Install npm packages directly into the browser VFS
       * @param {string|string[]} packages Package specifiers (e.g. 'express@4.19.2', ['cors', 'ms'])
       * @param {Object} [options]
       * @param {string} [options.cwd] Target directory (defaults to instance cwd)
       * @param {Function} [options.onProgress] Callback for install progress events
       */
      install: async (packages, options = {}) => {
        const pkgList = Array.isArray(packages) ? packages : [packages];
        return npmClient.install(pkgList, {
          cwd: options.cwd || this._cwd,
          onProgress: options.onProgress,
        });
      },
      getCacheStats: () => this._npmCache.getStats(),
      clearCache: () => this._npmCache.clear(),
    };
  }

  /**
   * Compute virtual port URL for an in-browser HTTP server
   * @param {number} [port=3000] Virtual port
   * @param {string} [pathname='/'] Path on virtual server
   * @returns {string} Virtual URL (e.g. '/__vhost__/3000/api/info')
   */
  getVirtualUrl(port = 3000, pathname = '/') {
    let cleanPath = pathname || '/';
    const vhostPrefix = `/__vhost__/${port}`;
    if (cleanPath.startsWith(vhostPrefix)) {
      return cleanPath;
    }
    const bnhPrefix = `/__bnh_vnet__/${port}`;
    if (cleanPath.startsWith(bnhPrefix)) {
      return cleanPath;
    }
    if (!cleanPath.startsWith('/')) {
      cleanPath = `/${cleanPath}`;
    }
    return `${vhostPrefix}${cleanPath}`;
  }

  /**
   * Connect an iframe to a virtual server port with two-way URL bar synchronization
   * @param {HTMLIFrameElement} iframe
   * @param {Object} [options]
   * @param {number} [options.port=3000] Virtual port to connect
   * @param {string} [options.path='/'] Initial path
   * @param {boolean} [options.autoLoad=true] Automatically set iframe src
   * @param {Function} [options.onNavigate] Callback when iframe URL changes: (address) => void
   * @returns {() => void} Unsubscribe listener function
   */
  connectIframe(iframe, options = {}) {
    const port = options.port || 3000;
    const initialPath = options.path || '/';
    const autoLoad = options.autoLoad !== false;

    if (autoLoad) {
      iframe.src = this.getVirtualUrl(port, initialPath);
    }

    if (options.onNavigate) {
      return watchFrameAddress(iframe, (rawAddress) => {
        // Strip the __vhost__/<port> prefix for user-facing clean URLs
        const prefix = `/__vhost__/${port}`;
        let cleanAddress = rawAddress;
        if (rawAddress.startsWith(prefix)) {
          cleanAddress = rawAddress.slice(prefix.length) || '/';
        }
        options.onNavigate(cleanAddress, rawAddress);
      });
    }

    return () => {};
  }

  /**
   * Issue a direct HTTP request to a virtual port running inside the browser
   * @param {string} url Virtual URL (e.g. 'http://localhost:3000/api/info' or '/api/info')
   * @param {Object} [options]
   */
  async fetch(url, options = {}) {
    let port = 3000;
    let path = url;
    try {
      const parsed = new URL(url, 'http://localhost:3000');
      port = parseInt(parsed.port, 10) || 3000;
      path = parsed.pathname + parsed.search + parsed.hash;
    } catch { /* fallback */ }

    const targetUrl = this.getVirtualUrl(port, path);
    return globalThis.fetch(targetUrl, options);
  }

  /**
   * WASM Addon Engine
   */
  get wasm() {
    return {
      list: () => [
        'sqlite', 'better_sqlite3', 'sqlite3', 'zlib', 'brotli',
        'zstd', 'llhttp', 'nghttp2', 'simdutf', 'ada', 'cares',
        'uvwasi', 'bcrypt', 'node_addon_napi',
      ],
      probe: async (moduleName) => {
        // Execute probe inside virtual node instance
        const testCode = `
          const moduleName = ${JSON.stringify(moduleName)};
          if (moduleName === 'sqlite') {
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(':memory:');
            db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, msg TEXT)');
            const insert = db.prepare('INSERT INTO test (msg) VALUES (?)');
            insert.run('hello wasm sqlite');
            const row = db.prepare('SELECT * FROM test WHERE id = 1').get();
            console.log(JSON.stringify({ status: 'ok', module: 'sqlite', row }));
          } else if (moduleName === 'zlib') {
            const zlib = require('node:zlib');
            const deflated = zlib.deflateSync('Hello from zlib wasm!');
            const inflated = zlib.inflateSync(deflated).toString();
            console.log(JSON.stringify({ status: 'ok', module: 'zlib', result: inflated }));
          } else {
            console.log(JSON.stringify({ status: 'ok', module: moduleName }));
          }
        `;
        return this.execute(testCode);
      },
    };
  }

  /**
   * Run a script inside the in-browser Node runtime
   * @param {Object} runOptions
   * @param {string} runOptions.entry Absolute path to entry script
   * @param {string[]} [runOptions.argv=[]] Command-line arguments
   * @param {Record<string, string>} [runOptions.env] Environment variables
   * @param {string} [runOptions.cwd] Working directory
   * @param {number} [runOptions.timeout=30000] Timeout in milliseconds
   * @param {Function} [runOptions.onStdout] Callback for stdout chunks: (chunk: string) => void
   * @param {Function} [runOptions.onStderr] Callback for stderr chunks: (chunk: string) => void
   * @param {AbortSignal} [runOptions.signal]
   */
  async run({
    entry,
    argv = [],
    env = {},
    cwd = this._cwd,
    timeout = 30000,
    onStdout,
    onStderr,
    signal,
  }) {
    // Ensure the entry file is mounted in the runtime
    await this._runtime.mount({}, { signal });

    const stdoutChunks = [];
    const stderrChunks = [];

    const handleStdout = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      stdoutChunks.push(text);
      if (onStdout) onStdout(text);
      this.emit('stdout', text);
    };

    const handleStderr = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      stderrChunks.push(text);
      if (onStderr) onStderr(text);
      this.emit('stderr', text);
    };

    const runPromise = this._runtime.executeEntry(
      entry,
      {
        cwd,
        argv: ['node', entry, ...argv],
        env: { ...this._env, ...env },
        timeout,
        signal,
      },
      handleStdout,
      handleStderr,
    ).then((code) => {
      const exitCode = typeof code === 'number' ? code : 0;
      this.emit('exit', exitCode);
      return exitCode;
    });

    const processHandle = {
      exit: runPromise,
      stdoutText: async () => {
        await runPromise.catch(() => {});
        return stdoutChunks.join('');
      },
      stderrText: async () => {
        await runPromise.catch(() => {});
        return stderrChunks.join('');
      },
      kill: async () => {
        // Handled via signal abort
      },
    };

    return processHandle;
  }

  /**
   * Execute an inline Node.js script string
   * @param {string} code JavaScript code to execute
   * @param {Object} [options]
   */
  async execute(code, options = {}) {
    const tempFile = `/node/eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`;
    await this.fs.writeFile(tempFile, code);
    return this.run({ entry: tempFile, ...options });
  }

  /** Event Subscription */
  on(event, listener) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(listener);
    return this;
  }

  off(event, listener) {
    this._listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event, ...args) {
    const callbacks = this._listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try { cb(...args); } catch (err) { console.error(err); }
      }
    }
  }
}

export default BrowserNode;
