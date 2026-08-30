export interface BrowserNodeOptions {
  /** Node.js target version (e.g. '22') */
  version?: '22' | string;
  /** Working directory (default: '/node') */
  cwd?: string;
  /** Initial environment variables */
  env?: Record<string, string>;
  /** Initial virtual filesystem files */
  files?: Record<string, string | Uint8Array>;
  /** Enable Service Worker & iframe gateway (default: true) */
  gateway?: boolean | { swPath?: string; scope?: string };
  /** Custom base URL for WASM binary fetching */
  wasmBaseUrl?: string;
  /** Global execution scope */
  globalObject?: any;
}

export interface NpmProgressEvent {
  phase: 'cache-hit-meta' | 'cache-hit-tarball' | 'fetching-meta' | 'downloading-tarball' | 'unpacking';
  name: string;
  version?: string;
  url?: string;
}

export interface NpmInstallOptions {
  cwd?: string;
  onProgress?: (event: NpmProgressEvent) => void;
}

export interface RunScriptOptions {
  /** Additional command-line arguments to pass to the script */
  args?: string[];
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Target working directory containing package.json (defaults to instance cwd) */
  cwd?: string;
  /** Callback for stdout stream chunks */
  onStdout?: (chunk: string) => void;
  /** Callback for stderr stream chunks */
  onStderr?: (chunk: string) => void;
  /** Abort signal to cancel or terminate execution */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
}

export interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  type?: 'module' | 'commonjs';
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  [key: string]: any;
}

export interface ConnectIframeOptions {
  /** Virtual port to connect (default: 3000) */
  port?: number;
  /** Initial path (default: '/') */
  path?: string;
  /** Automatically navigate iframe src on connect (default: true) */
  autoLoad?: boolean;
  /** Callback on iframe URL change: (cleanAddress, rawAddress) => void */
  onNavigate?: (cleanAddress: string, rawAddress: string) => void;
}

export interface ProcessRunOptions {
  /** Absolute path to entry script (e.g. '/node/server.js') */
  entry: string;
  /** Command-line arguments */
  argv?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Callback for stdout chunks */
  onStdout?: (chunk: string) => void;
  /** Callback for stderr chunks */
  onStderr?: (chunk: string) => void;
  /** Abort signal */
  signal?: AbortSignal;
}

export interface ProcessHandle {
  /** Promise resolving to process exit code */
  exit: Promise<number>;
  /** Get captured stdout text */
  stdoutText(): Promise<string>;
  /** Get captured stderr text */
  stderrText(): Promise<string>;
  /** Send signal to kill process */
  kill(signal?: string): Promise<void>;
  /** Structured execution result metadata */
  structuredResult: any;
}

export class BrowserNode {
  static initServiceWorker(swPath?: string, scope?: string): Promise<ServiceWorkerRegistration | null>;
  static create(options?: BrowserNodeOptions): Promise<BrowserNode>;
  readonly rawRuntime: any;
  readonly vfs: any;
  readonly virtualNetwork: any;
  readonly fs: {
    readFile(path: string, encoding?: string): Promise<string | Uint8Array>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string, opts?: any): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<any>;
    unlink(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    snapshot(): any;
    mount(snapshot: any): Promise<void>;
  };
  readonly npm: {
    /**
     * Install npm packages directly into VFS.
     * If packages is omitted, dependencies from package.json in cwd are automatically installed.
     */
    install(packages?: string | string[] | NpmInstallOptions, options?: NpmInstallOptions): Promise<any>;
    /** Read parsed package.json in cwd */
    getPackageJson(cwd?: string): Promise<PackageJson | null>;
    /** Get dictionary of scripts from package.json */
    getScripts(cwd?: string): Promise<Record<string, string>>;
    /** Execute a named script from package.json */
    run(scriptName: string, options?: RunScriptOptions): Promise<ProcessHandle>;
    /** Get IndexedDB tarball cache statistics */
    getCacheStats(): Promise<{ count: number; totalBytes: number }>;
    /** Clear IndexedDB tarball cache */
    clearCache(): Promise<void>;
  };
  readonly wasm: {
    list(): string[];
    probe(moduleName: string): Promise<ProcessHandle>;
  };
  getVirtualUrl(port?: number, pathname?: string): string;
  connectIframe(iframe: HTMLIFrameElement, options?: ConnectIframeOptions): () => void;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  run(options: ProcessRunOptions): Promise<ProcessHandle>;
  runScript(scriptName: string, options?: RunScriptOptions): Promise<ProcessHandle>;
  execute(code: string, options?: ProcessRunOptions): Promise<ProcessHandle>;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): void;
}

export function parseScriptCommand(cmdString: string): {
  binary: string;
  args: string[];
  env: Record<string, string>;
  tokens: string[];
};

export function createRuntime(options?: any): any;
export const runtime: any;
export default BrowserNode;
