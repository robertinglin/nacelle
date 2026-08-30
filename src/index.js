import { createRuntime, runtime as defaultRuntime } from './runtime.js';

export { createRuntime, defaultRuntime as runtime };

/**
 * High-level browser Node.js instance
 */
export class BrowserNode {
  /**
   * Create and initialize a new in-browser Node.js instance
   * @param {Object} [options]
   * @param {string} [options.version='22'] Node.js version target
   * @param {string} [options.cwd='/workspace'] Working directory
   * @param {Record<string, string>} [options.env={}] Initial environment variables
   * @param {Record<string, string|Uint8Array>} [options.files={}] Initial virtual filesystem files
   * @param {string} [options.wasmBaseUrl] Custom base URL for WASM binaries
   */
  static async create(options = {}) {
    const cwd = options.cwd || '/workspace';
    const env = {
      NODE_ENV: 'development',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      ...options.env,
    };

    const runtime = createRuntime({
      globalObject: globalThis,
      version: `v${options.version || '22'}`,
      wasmBaseUrl: options.wasmBaseUrl,
    });

    const instance = new BrowserNode(runtime, { cwd, env });

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
  }

  /** Low-level runtime bridge instance */
  get rawRuntime() {
    return this._runtime;
  }

  /** Virtual File System broker */
  get vfs() {
    return this._runtime.vfs;
  }

  /** Convenient asynchronous file system operations */
  get fs() {
    const vfs = this._runtime.vfs;
    return {
      readFile: async (filePath, encoding = 'utf8') => {
        const bytes = await vfs.readFile(filePath);
        if (encoding === 'utf8' || encoding === 'utf-8') {
          return new TextDecoder().decode(bytes);
        }
        return bytes;
      },
      writeFile: async (filePath, data) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        return vfs.writeFile(filePath, bytes);
      },
      mkdir: async (dirPath, opts) => vfs.mkdir(dirPath, opts),
      readdir: async (dirPath) => vfs.readdir(dirPath),
      stat: async (targetPath) => vfs.stat(targetPath),
      unlink: async (targetPath) => vfs.unlink(targetPath),
    };
  }

  /** In-browser NPM package loader */
  get npm() {
    return {
      install: async (packageName, opts) => {
        return this._runtime.installNpmPackage(packageName, opts);
      },
    };
  }

  /**
   * Execute a script in an isolated Web Worker child process
   * @param {Object} runOptions
   * @param {string} runOptions.entry Absolute path to entry script (e.g. /workspace/index.js)
   * @param {string[]} [runOptions.argv=[]] Command-line arguments
   * @param {Record<string, string>} [runOptions.env] Environment variables
   * @param {string} [runOptions.cwd] Working directory
   * @param {number} [runOptions.timeout=30000] Timeout in milliseconds
   */
  async run({ entry, argv = [], env = {}, cwd = this._cwd, timeout = 30000 }) {
    const runSpec = {
      runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      workspace: 'v22',
      entryModule: entry,
      capabilities: {
        vfs: { mounts: [{ path: '/', mode: 'read-write' }] },
        workers: { entryModules: [entry], maxChildren: 4 },
        ipc: { enabled: true },
        signals: { allowed: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
        output: { maxBytes: 10 * 1024 * 1024 },
        envVars: { allowed: Object.keys({ ...this._env, ...env }) },
        proxy: { mode: 'virtual', enabled: false },
      },
      fixtures: [],
      limits: { timeoutMs: timeout },
    };

    return this._runtime.run(runSpec, {
      entry,
      argv: ['node', entry, ...argv],
      env: { ...this._env, ...env },
      cwd,
      timeout,
    });
  }
}

export default BrowserNode;
