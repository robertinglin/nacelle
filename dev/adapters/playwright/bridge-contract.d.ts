export interface BrowserNodeHarnessManifestEntry {
  path: string;
  bytes: number;
}

export interface BrowserNodeHarnessFiles {
  mode: 'playwright-binding';
  readBinding: '__bnhReadFile';
  manifest: BrowserNodeHarnessManifestEntry[];
}

export interface BrowserNodeHarnessProxySelection {
  mode?: 'virtual' | 'proxy';
  enabled?: boolean;
  optIn?: boolean;
  capabilityKey?: string;
  capability?: boolean | string[] | Record<string, unknown>;
  /** Page-side adapter; it is intentionally not serialized across the JSONL boundary. */
  adapter?: unknown;
}

export interface BrowserNodeHarnessRequest {
  schemaVersion: 1;
  entry: string;
  files: BrowserNodeHarnessFiles;
  flags: string[];
  expected?: {
    suite: 'message' | 'pseudo-tty';
    output_path: string;
    output: string | null;
    input_path: string | null;
    input: string | null;
    required: boolean;
    requires_tty: boolean;
  } | null;
  env: Record<string, string>;
  timeoutMs: number;
  proxy?: BrowserNodeHarnessProxySelection;
  variant?: string;
  context?: {
    phase?: string;
    runId?: string;
    iteration?: number;
    attemptId?: string;
    variant?: string;
  };
  metadata: {
    testPath: string;
    sourceSha256: string;
    bundleBytes: number;
    omittedFiles: Array<{ path: string; reason: string; bytes: number }>;
    variant?: string;
    [key: string]: unknown;
  };
}

export interface BrowserNodeHarnessRuntimeContext {
  env: Record<string, string>;
  variant?: string;
  metadata: BrowserNodeHarnessRequest['metadata'];
  signal: AbortSignal;
  capabilities?: Record<string, unknown>;
  proxy?: BrowserNodeHarnessProxySelection;
}

export interface BrowserNodeHarnessChild {
  exit: Promise<number | null>;
  stdoutText(): Promise<string>;
  stderrText(): Promise<string>;
  kill(): Promise<void>;
}

/** API exported by the shared browser-native runtime imported by the example bridge. */
export interface BrowserNodeHarnessRuntime {
  readonly version?: string;
  reset(context?: BrowserNodeHarnessRuntimeContext): Promise<void>;
  mount(
    files: Record<string, Uint8Array>,
    context?: BrowserNodeHarnessRuntimeContext,
  ): Promise<void>;
  spawn(
    argv: string[],
    options: BrowserNodeHarnessRuntimeContext & { cwd: string },
  ): Promise<BrowserNodeHarnessChild>;
}

export interface BrowserNodeHarnessResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  skipped?: boolean;
  details?: Record<string, unknown>;
}

declare global {
  function __bnhReadFile(path: string): Promise<{ encoding: 'base64'; data: string }>;
  var __BROWSER_NODE_HARNESS__: {
    run(request: BrowserNodeHarnessRequest): Promise<BrowserNodeHarnessResult>;
  };
}
