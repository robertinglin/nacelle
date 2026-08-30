export interface BrowserNodeOptions {
  /** Node.js target version (e.g. '22') */
  version?: '22' | string;
  /** Working directory (default: '/workspace') */
  cwd?: string;
  /** Initial environment variables */
  env?: Record<string, string>;
  /** Initial virtual filesystem files */
  files?: Record<string, string | Uint8Array>;
  /** Custom base URL for WASM binary fetching */
  wasmBaseUrl?: string;
}

export interface ProcessRunOptions {
  /** Absolute path to entry script (e.g. '/workspace/index.js') */
  entry: string;
  /** Command-line arguments */
  argv?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
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
  static create(options?: BrowserNodeOptions): Promise<BrowserNode>;
  readonly rawRuntime: any;
  readonly vfs: any;
  readonly fs: {
    readFile(path: string, encoding?: string): Promise<string | Uint8Array>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string, opts?: any): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<any>;
    unlink(path: string): Promise<void>;
  };
  readonly npm: {
    install(packageName: string, opts?: any): Promise<any>;
  };
  run(options: ProcessRunOptions): Promise<ProcessHandle>;
}

export function createRuntime(options?: any): any;
export const runtime: any;
export default BrowserNode;
