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

export interface ConnectIframeOptions {
  /** Virtual port to connect (default: 3000) */
  port?: number;
  /** Initial path (default: '/') */
  path?: string;
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
    install(packages: string | string[], options?: NpmInstallOptions): Promise<any>;
    getCacheStats(): Promise<{ count: number; totalBytes: number }>;
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
  execute(code: string, options?: ProcessRunOptions): Promise<ProcessHandle>;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): void;
}

export function createRuntime(options?: any): any;
export const runtime: any;
export default BrowserNode;
