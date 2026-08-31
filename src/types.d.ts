export type SupportedNodeVersion = 22 | '22' | '22.23.2' | 'v22' | 'n22' | 'node22' | 'node@22' | 'latest' | 'lts';

export interface NodeVersionRecord {
  readonly id: 'v22';
  readonly major: 22;
  readonly nodeRef: 'v22.x';
  readonly referenceVersion: '22.23.2';
  readonly status: 'maintenance-lts';
  readonly maturity: 'alpha';
  readonly codename: 'Jod';
  readonly endOfLife: '2027-04-30';
  readonly npmTag: 'n22';
  readonly wasmDirectory: 'src/wasm/v22';
}

export interface NodeVersionProfile extends NodeVersionRecord {
  readonly runtimeVersion: 'v22.23.2';
  readonly release: Readonly<{ name: 'node'; lts: 'Jod'; sourceUrl: string; headersUrl: string }>;
  readonly versions: Readonly<Record<string, string>>;
  readonly features: Readonly<Record<string, boolean | string>>;
  readonly config: Readonly<Record<string, any>>;
  readonly wasm: Readonly<{ directory: string; manifest: string; modules: string; napi: string }>;
}

export interface NacelleOptions {
  /** Node.js alpha target. Node 22 is the only shipped release line. */
  version?: SupportedNodeVersion;
  /** Working directory (default: '/node') */
  cwd?: string;
  /** Initial environment variables */
  env?: Record<string, string>;
  /** Initial virtual filesystem files */
  files?: Record<string, string | Uint8Array>;
  /** Enable Service Worker & iframe gateway (default: true) */
  gateway?: boolean | { swPath?: string; scope?: string; sessionScoped?: boolean; clientId?: string; port?: number };
  /** Custom base URL for WASM binary fetching */
  wasmBaseUrl?: string;
  /** Global execution scope */
  globalObject?: any;
  /** Guest-code execution boundary; browser worker isolation is fail-closed when unavailable */
  isolation?: 'inline' | 'worker';
  /** Optional Nacelle+ privileged transport companion */
  nacellePlus?: boolean | NacellePlusOptions;
  /** Explicit Nacelle capability grant for privileged transport */
  proxy?: ProxyConfig;
  /** Immutable, run-scoped capability manifest extensions */
  capabilities?: CapabilityManifest;
}

export interface CapabilityManifest {
  vfs?: Record<string, any>;
  workers?: Record<string, any>;
  ipc?: Record<string, any>;
  signals?: Record<string, any>;
  output?: Record<string, number>;
  envVars?: { allowed: string[] };
  proxy?: ProxyConfig;
  network?: { origins: string[]; methods?: string[]; [key: string]: any };
  npm?: { registries?: string[]; lifecycleScripts?: boolean; allowedScripts?: string[]; [key: string]: any };
  secrets?: { names: string[]; [key: string]: any };
  hostBridge?: { apis: string[]; [key: string]: any };
  persistence?: { enabled?: boolean; namespaces?: string[]; [key: string]: any };
  preview?: { ports?: number[]; [key: string]: any };
  budgets?: Record<string, number>;
  [key: string]: any;
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
  /** Initial standard input for shell pipelines and Node scripts */
  stdin?: string | Uint8Array;
  /** Timeout in milliseconds */
  timeout?: number;
}

export interface BashOptions {
  /** Additional positional arguments available to the final shell command */
  args?: string[];
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Callback for stdout stream chunks */
  onStdout?: (chunk: string) => void;
  /** Callback for stderr stream chunks */
  onStderr?: (chunk: string) => void;
  /** Abort signal to cancel execution */
  signal?: AbortSignal;
  /** Initial standard input */
  stdin?: string | Uint8Array;
  /** Timeout in milliseconds */
  timeout?: number;
}

export interface NacellePlusOptions {
  /** Extension identifier carried through the page bridge when multiple companions are installed */
  extensionId?: string;
  /** Custom request adapter for an embedding-specific privileged transport */
  adapter?: ((request: any) => Promise<any> | any) | { request(request: any): Promise<any> | any };
  /** Try ordinary page fetch before using the privileged adapter (default: true) */
  fallback?: boolean;
  /** Timeout for page/extension bridge requests in milliseconds */
  timeout?: number;
  /** Guest-code isolation mode; browser pages fail closed when workers are unavailable */
  isolation?: 'inline' | 'worker';
  /** Emit secret-free structured transport diagnostics when enabled */
  debug?: boolean | ((event: NacellePlusDiagnosticEvent) => void) | { enabled?: boolean; onEvent?: (event: NacellePlusDiagnosticEvent) => void };
}

export interface ProxyConfig {
  /** Existing run-scoped proxy capability mode */
  mode?: 'virtual' | 'proxy';
  /** Enable the selected proxy capability */
  enabled?: boolean;
  /** Explicit capability grant */
  capability?: boolean | Record<string, boolean>;
  capabilityKey?: string;
  adapter?: any;
  /** Shared HTTP(S) proxy URL */
  url?: string;
  proxyUrl?: string;
  /** Per-scheme proxy URLs */
  httpProxy?: string;
  httpsProxy?: string;
  /** Hosts that bypass environment proxy routing */
  noProxy?: string | string[];
  /** Disable environment proxy routing while retaining configured URLs */
  useEnvProxy?: boolean;
  /** Additional process environment values */
  env?: Record<string, string>;
}

export interface NacellePlusDiagnosticEvent {
  transport: 'nacelle-plus';
  phase: 'start' | 'response' | 'finish';
  request_id: string;
  origin: string;
  target: string;
  fallback_reason: string;
  grant: string;
  stream: boolean;
  bytes_in: number;
  duration_ms?: number;
  status?: number;
  termination?: 'completed' | 'aborted' | 'revoked' | 'transport_lost' | 'failed';
}

export function createProxyConfig(options?: ProxyConfig): ProxyConfig;
export function createCapabilityManifest(manifest: CapabilityManifest): Readonly<CapabilityManifest>;
export function capabilityDelta(previous: CapabilityManifest, next: CapabilityManifest): { added: Partial<CapabilityManifest>; removed: Partial<CapabilityManifest> };
export function createCheckpointStore(options: { snapshot: () => any | Promise<any>; restore: (snapshot: any) => void | Promise<void>; metadata?: Record<string, any> }): any;
export function createTraceRecorder(options?: { traceId?: string; maxEvents?: number }): any;
export class NacelleError extends Error { code: string; details: Record<string, any>; traceId?: string; }
export function createSecretBroker(options?: Record<string, any>): any;
export function createGatewayRouteRegistry(options?: Record<string, any>): any;
export function createCompatibilityLab(options: Record<string, any>): any;

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
  /** Initial standard input */
  stdin?: string | Uint8Array;
  /** Retain no complete output transcript when false */
  capture?: boolean;
  /** Retain only the final number of bytes per stream */
  tailBytes?: number;
}

export type ExecuteOptions = Omit<ProcessRunOptions, 'entry'>;

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
  structuredResult?: any;
  /** Bounded output collector */
  output?: any;
  /** Output accounting for one stream */
  stats?(stream: 'stdout' | 'stderr'): { stream: string; bytes: number; droppedBytes: number; limit: number; retainedBytes: number; tailBytes: number };
  /** Present when the handle was created by wasm.probe(). */
  wasmArtifact?: WasmArtifact;
}

export interface WasmArtifact {
  module: string;
  path: string;
  url: string;
  bytes: number;
  entry: string;
}

export interface WasmArtifactManifest {
  version: number;
  node_version: 'v22';
  reference_version: '22.23.2';
  abi: Readonly<{ modules: '127'; napi: '10' }>;
  artifact_compatibility: string;
  artifact_set_sha256?: string;
  artifacts: readonly Readonly<{
    node: string;
    wasm: string;
    entry: string;
    exports?: readonly string[];
    bytes?: number;
    sha256?: string;
  }>[];
  failures: readonly any[];
  skipped: readonly any[];
}

export class Nacelle {
  static readonly supportedVersions: readonly NodeVersionRecord[];
  static resolveVersion(value?: SupportedNodeVersion): NodeVersionRecord;
  static initServiceWorker(swPath?: string, scope?: string, globalObject?: any): Promise<ServiceWorkerRegistration | null>;
  static create(options?: NacelleOptions): Promise<Nacelle>;
  readonly rawRuntime: any;
  readonly vfs: any;
  readonly virtualNetwork: any;
  readonly transport: any;
  readonly nodeProfile: NodeVersionProfile;
  readonly capabilities: Readonly<CapabilityManifest>;
  readonly secretBroker: any;
  readonly trace: any;
  readonly gatewayRoute: Readonly<{ routeId: string; clientId: string; port: number; version: number; expiresAt: number }> | null;
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
    readonly baseUrl: string;
    list(): string[];
    manifest(): Promise<WasmArtifactManifest>;
    load(moduleName: string): Promise<WasmArtifact>;
    probe(moduleName: string): Promise<ProcessHandle>;
  };
  getVirtualUrl(port?: number, pathname?: string): string;
  connectIframe(iframe: HTMLIFrameElement, options?: ConnectIframeOptions): () => void;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  run(options: ProcessRunOptions): Promise<ProcessHandle>;
  runScript(scriptName: string, options?: RunScriptOptions): Promise<ProcessHandle>;
  bash(command: string, options?: BashOptions): Promise<ProcessHandle>;
  execute(code: string, options?: ExecuteOptions): Promise<ProcessHandle>;
  checkpoint(metadata?: Record<string, any>): Promise<any>;
  rollback(checkpointId: string): Promise<any>;
  diff(checkpointId: string, snapshot?: any): string;
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

export interface ShellWordPart {
  text: string;
  expandVariables: boolean;
  glob: boolean;
}

export interface ShellWord {
  type: 'word';
  parts: ShellWordPart[];
}

export type ShellToken = ShellWord | {
  type: 'operator';
  value: string;
};

export interface ShellRedirect {
  operator: string;
  target?: ShellWord;
}

export interface ShellCommand {
  words: ShellWord[];
  redirects: ShellRedirect[];
}

export interface ShellPipeline {
  connector: null | '&&' | '||' | ';';
  commands: ShellCommand[];
}

export function tokenizeShellScript(command: string): ShellToken[];
export function parseShellScript(command: string): ShellPipeline[];

export function listSupportedNodeVersions(): readonly NodeVersionRecord[];
export function listNodeVersionProfiles(): readonly NodeVersionProfile[];
export function nodeVersionAliases(): Readonly<{ latest: 'v22'; lts: 'v22' }>;
export function resolveNodeVersionRecord(value?: SupportedNodeVersion): NodeVersionRecord;
export function resolveNodeVersionProfile(value?: SupportedNodeVersion): NodeVersionProfile;

export function createRuntime(options?: {
  globalObject?: any;
  version?: SupportedNodeVersion;
  nodeVersion?: SupportedNodeVersion;
  nodeProfile?: NodeVersionProfile;
  wasmBaseUrl?: string;
}): any;
export const runtime: any;
export default Nacelle;
