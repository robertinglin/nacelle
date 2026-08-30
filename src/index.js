import { createRuntime, runtime as defaultRuntime } from './runtime.js';
import { BrowserNpm, BrowserNpmCache, parseScriptCommand } from './runtime/npm.js';
import { createShellProcess } from './runtime/shell.js';
import { parseShellScript, tokenizeShellScript } from './runtime/shell-parser.js';
import { createNacellePlusAdapter, createNacellePlusTransport } from './runtime/nacelle-plus.js';
import { createProxyConfig } from './runtime/proxy-config.js';
import { createNegotiatedTransport, isBrowserFetchFailure } from './runtime/transport.js';
import { installGatewayBridge } from './runtime/gateway-bridge.js';
import { watchFrameAddress } from './runtime/frame-address.js';
import { createBrowserNet } from './runtime/net.js';
import { createBufferClass } from './runtime/buffer.js';
import { createWasmAddonManager } from './runtime/wasm-addons.js';
import {
  listNodeVersionProfiles,
  listSupportedNodeVersions,
  nodeVersionAliases,
  resolveNodeVersionProfile,
  resolveNodeVersionRecord,
} from './versions/index.js';

export {
  createRuntime,
  defaultRuntime as runtime,
  BrowserNpm,
  BrowserNpmCache,
  createBrowserNet,
  createBufferClass,
  parseScriptCommand,
  parseShellScript,
  tokenizeShellScript,
  createNacellePlusAdapter,
  createNacellePlusTransport,
  createProxyConfig,
  createNegotiatedTransport,
  isBrowserFetchFailure,
  listNodeVersionProfiles,
  listSupportedNodeVersions,
  nodeVersionAliases,
  resolveNodeVersionProfile,
  resolveNodeVersionRecord,
};

/**
 * High-level In-Browser Node.js Execution Engine
 */
export class Nacelle {
  static get supportedVersions() {
    return listSupportedNodeVersions();
  }

  static resolveVersion(value = 'lts') {
    return resolveNodeVersionRecord(value);
  }

  /**
   * Helper to register the Service Worker HTTP Gateway
   * @param {string} [swPath='/runtime/gateway-sw.js']
   * @param {string} [scope='/']
   * @param {Object} [globalObject=globalThis] Browser realm that owns the Service Worker API
   */
  static async initServiceWorker(swPath = '/runtime/gateway-sw.js', scope = '/', globalObject = globalThis) {
    const browserNavigator = globalObject.navigator;
    if (!browserNavigator || !('serviceWorker' in browserNavigator)) {
      return null;
    }
    const controllerChange = new Promise((resolve) => {
      let timeout;
      const finish = () => {
        globalObject.clearTimeout(timeout);
        browserNavigator.serviceWorker.removeEventListener('controllerchange', finish);
        resolve();
      };
      browserNavigator.serviceWorker.addEventListener('controllerchange', finish);
      timeout = globalObject.setTimeout(finish, 2000);
    });

    const registration = await browserNavigator.serviceWorker.register(swPath, {
      scope,
      updateViaCache: 'none',
    });
    await registration.update().catch(() => {});
    await browserNavigator.serviceWorker.ready;
    if (!browserNavigator.serviceWorker.controller || registration.installing || registration.waiting) {
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
   * @param {Object|boolean} [options.nacellePlus] Optional privileged transport companion
   */
  static async create(options = {}) {
    const cwd = options.cwd || '/node';
    const globalObject = options.globalObject || globalThis;
    const nodeProfile = resolveNodeVersionProfile(options.version || 'lts');
    const proxyConfig = options.proxy ? createProxyConfig(options.proxy, globalObject) : null;
    const env = {
      NODE_ENV: 'development',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      ...(proxyConfig?.env || {}),
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
      await this.initServiceWorker(swPath, scope, globalObject).catch((err) => {
        console.warn('[Nacelle] Service Worker registration skipped:', err.message);
      });
    }

    const wasmBaseUrl = options.wasmBaseUrl
      || new URL(`./wasm/${nodeProfile.id}/`, import.meta.url).href;
    const runtime = createRuntime({
      globalObject,
      nodeProfile,
      wasmBaseUrl,
    });

    const mounts = [
      { path: '/node', mode: 'read-write' },
      { path: '/', mode: 'read-write' },
    ];
    if (cwd && cwd !== '/node' && cwd !== '/') {
      mounts.unshift({ path: cwd, mode: 'read-write' });
    }

    const nacellePlusOptions = options.nacellePlus === true
      ? {}
      : options.nacellePlus && typeof options.nacellePlus === 'object'
        ? options.nacellePlus
        : null;
    const transport = nacellePlusOptions
      ? createNacellePlusTransport({ ...nacellePlusOptions, globalObject })
      : null;
    const proxy = proxyConfig
      ? { ...proxyConfig, ...(transport && !proxyConfig.adapter ? { adapter: transport.adapter } : {}) }
      : { mode: 'virtual', enabled: false };

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
        proxy: { mode: proxy.mode || 'virtual', enabled: proxy.enabled === true },
      },
      proxy,
    });

    // Install Gateway Bridge with proper createBrowserNet instance
    if (runtime.virtualNetwork) {
      const netModule = createBrowserNet({
        network: runtime.virtualNetwork,
        BufferClass,
      });
      installGatewayBridge({ net: netModule, globalObject });
    }

    const instance = new this(runtime, {
      cwd,
      env,
      globalObject,
      transport,
      nodeProfile,
    });

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
    this._transport = config.transport || null;
    this._nodeProfile = config.nodeProfile;
    this._listeners = new Map();
    this._npmCache = new BrowserNpmCache({ globalObject: this._globalObject });
    this._wasm = createWasmAddonManager({
      baseUrl: this._runtime.wasmBaseUrl,
      profile: this._nodeProfile,
      globalObject: this._globalObject,
      writeFile: (path, bytes) => this.fs.writeFile(path, bytes),
      execute: (source) => this.execute(source),
    });
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

  /** Optional negotiated transport, when Nacelle+ or another adapter is enabled. */
  get transport() {
    return this._transport;
  }

  /** Selected, immutable Node release-line profile. */
  get nodeProfile() {
    return this._nodeProfile;
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
      writeFile: async (filePath, data, opts) => {
        const lastSlash = filePath.lastIndexOf('/');
        if (lastSlash > 0) {
          const dir = filePath.slice(0, lastSlash);
          try {
            await vfs.fs.promises.mkdir(dir, { recursive: true });
          } catch {}
        }
        return vfs.fs.promises.writeFile(filePath, data, opts);
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
   * In-Browser NPM package manager & script runner
   */
  get npm() {
    const npmClient = new BrowserNpm({
      vfs: this._runtime.vfs,
      cache: this._npmCache,
      globalObject: this._globalObject,
    });

    return {
      /**
       * Install npm packages directly into the browser VFS.
       * If packages is omitted, installs dependencies from package.json in cwd.
       * @param {string|string[]|Object} [packages] Package specifier(s) or options object
       * @param {Object} [options]
       * @param {string} [options.cwd] Target directory (defaults to instance cwd)
       * @param {Function} [options.onProgress] Callback for install progress events
       */
      install: async (packages, options = {}) => {
        let actualPackages = packages;
        let actualOpts = options;
        if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
          actualOpts = packages;
          actualPackages = null;
        }
        const pkgList = actualPackages ? (Array.isArray(actualPackages) ? actualPackages : [actualPackages]) : null;
        return npmClient.install(pkgList, {
          cwd: actualOpts.cwd || this._cwd,
          onProgress: actualOpts.onProgress,
        });
      },

      /**
       * Get parsed package.json object from working directory
       * @param {string} [cwd]
       */
      getPackageJson: async (cwd = this._cwd) => {
        return npmClient.readPackageJson(cwd);
      },

      /**
       * Get available scripts from package.json
       * @param {string} [cwd]
       */
      getScripts: async (cwd = this._cwd) => {
        const pkg = await npmClient.readPackageJson(cwd);
        return pkg?.scripts || {};
      },

      /**
       * Execute an npm script defined in package.json
       * @param {string} scriptName Name of the script (e.g. 'start', 'dev', 'build')
       * @param {Object} [options]
       * @param {string[]} [options.args=[]] Additional CLI arguments to pass to the script
       * @param {Record<string, string>} [options.env={}] Additional environment variables
       * @param {string} [options.cwd] Target directory
       * @param {Function} [options.onStdout]
       * @param {Function} [options.onStderr]
       * @param {AbortSignal} [options.signal]
       */
      run: async (scriptName, options = {}) => {
        const targetCwd = options.cwd || this._cwd;
        const pkg = await npmClient.readPackageJson(targetCwd);
        if (!pkg) {
          throw new Error(`ENOENT: package.json not found in ${targetCwd}`);
        }
        const scripts = pkg.scripts || {};
        const scriptCmd = scripts[scriptName];
        if (!scriptCmd) {
          throw new Error(`Missing script: "${scriptName}"`);
        }

        const scriptEnv = {
          ...this._env,
          npm_lifecycle_event: scriptName,
          npm_lifecycle_script: scriptCmd,
          npm_package_name: pkg.name || '',
          npm_package_version: pkg.version || '',
          PATH: `${targetCwd}/node_modules/.bin:/node/node_modules/.bin:${this._env.PATH || ''}`,
          ...options.env,
        };

        return this._createShellProcess(scriptCmd, {
          ...options,
          cwd: targetCwd,
          env: scriptEnv,
          npmRun: (name, nestedOptions) => this.npm.run(name, nestedOptions),
        });
      },

      getCacheStats: () => this._npmCache.getStats(),
      clearCache: () => this._npmCache.clear(),
    };
  }

  /**
   * Convenience alias for node.npm.run(scriptName, options)
   */
  async runScript(scriptName, options = {}) {
    return this.npm.run(scriptName, options);
  }

  /**
   * Execute shell lines directly inside the virtual filesystem.
   * @param {string} command Shell command or command list
   * @param {Object} [options]
   */
  async bash(command, options = {}) {
    return this._createShellProcess(command, options);
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
    return this._globalObject.fetch(targetUrl, options);
  }

  /**
   * WASM Addon Engine
   */
  get wasm() {
    return this._wasm;
  }

  /**
   * Run a script inside the in-browser Node runtime
   * @param {Object} runOptions
   * @param {string} runOptions.entry Absolute path to entry script
   * @param {string[]} [runOptions.argv=[]] Command-line arguments
   * @param {Record<string, string>} [runOptions.env] Environment variables
   * @param {string} [runOptions.cwd] Working directory
   * @param {string|Uint8Array} [runOptions.stdin] Initial standard input
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
    stdin,
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
        stdin,
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

  _createShellProcess(command, options = {}) {
    const targetCwd = options.cwd || this._cwd;
    const shellEnv = {
      ...this._env,
      PATH: `${targetCwd}/node_modules/.bin:/node/node_modules/.bin:${this._env.PATH || ''}`,
      ...options.env,
    };
    const runCommand = async ({ entry, argv, env, cwd, stdin, signal, timeout }) => {
      const stdout = [];
      const stderr = [];
      const child = await this.run({
        entry,
        argv,
        env,
        cwd,
        stdin,
        timeout,
        signal,
        onStdout: (chunk) => stdout.push(String(chunk)),
        onStderr: (chunk) => stderr.push(String(chunk)),
      });
      const code = await child.exit;
      return { code: code ?? 1, stdout: stdout.join(''), stderr: stderr.join('') };
    };
    const runInline = async ({ source, argv, env, cwd, stdin, signal, timeout }) => {
      const stdout = [];
      const stderr = [];
      const child = await this.execute(source, {
        argv,
        env,
        cwd,
        stdin,
        timeout,
        signal,
        onStdout: (chunk) => stdout.push(String(chunk)),
        onStderr: (chunk) => stderr.push(String(chunk)),
      });
      const code = await child.exit;
      return { code: code ?? 1, stdout: stdout.join(''), stderr: stderr.join('') };
    };
    const shellFs = {
      exists: this.fs.exists,
      stat: this.fs.stat,
      readFile: this.fs.readFile,
      writeFile: this.fs.writeFile,
      mkdir: this.fs.mkdir,
      readdir: this.fs.readdir,
      remove: (pathname, removeOptions) => this._runtime.vfs.fs.rmSync(pathname, removeOptions),
      copy: (source, destination, copyOptions) => this._runtime.vfs.fs.cpSync(source, destination, copyOptions),
      rename: (source, destination) => this._runtime.vfs.fs.renameSync(source, destination),
      glob: async (pattern, cwd) => this._runtime.vfs.fs.globSync(pattern, { cwd }),
    };
    return createShellProcess(command, {
      args: options.args,
      cwd: targetCwd,
      env: shellEnv,
      stdin: options.stdin,
      fs: shellFs,
      npmRun: options.npmRun || ((name, nestedOptions) => this.npm.run(name, nestedOptions)),
      runCommand,
      runNode: (nodeOptions) => runInline({
        source: nodeOptions.print
          ? `process.stdout.write(String(eval(${JSON.stringify(nodeOptions.code)})) + '\\n');`
          : nodeOptions.code,
        argv: nodeOptions.args,
        env: nodeOptions.env,
        cwd: nodeOptions.cwd,
        stdin: nodeOptions.input,
        signal: nodeOptions.signal,
        timeout: nodeOptions.timeout,
      }),
      nodeVersion: this._nodeProfile.runtimeVersion,
      signal: options.signal,
      timeout: options.timeout,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
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

export default Nacelle;
