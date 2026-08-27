import { createMessagingPrimitives } from './messaging.js';
import { createBrowserProcess } from './process.js';
import { createNetworkPrimitives } from './network.js';
import { createOutputCollector } from './streams.js';
import { createStreamPrimitives } from './web-streams.js';
import { createCompressionContract } from './compression.js';
import { createCryptoContract } from './crypto.js';
import { createDiagnosticsContract } from './diagnostics.js';
import { createBoundaryContract } from './errors.js';
import { createPlatformContract } from './os-platform.js';
import { createWasmContract } from './wasm.js';
import { createHttpCompatibility } from './http.js';
import { createTlsModule } from './tls.js';
import { createHttp2Module } from './http2.js';
import { createPerformancePrimitives } from './perf.js';
import { createStorageAdapters } from './storage.js';
import { createVfs } from './vfs.js';

const CAPABILITY_KEYS = Object.freeze([
  'vfs',
  'workers',
  'ipc',
  'signals',
  'output',
  'envVars',
  'process.env',
  'proxy',
]);

const SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGKILL']);

function capabilityError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'CapabilityError';
  error.code = code;
  error.details = details;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function assertStringList(value, key) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw capabilityError('ERR_INVALID_CAPABILITY', `${key} must be an array of non-empty strings`, { key });
  }
}

function normalizeEnvironmentGrant(value) {
  if (value === undefined) return { allowed: [] };
  if (Array.isArray(value)) {
    assertStringList(value, 'envVars');
    return { allowed: [...new Set(value)].sort() };
  }
  if (!isRecord(value)) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'envVars must be an array or grant object', { key: 'envVars' });
  }
  const allowed = value.allowed ?? value.keys;
  assertStringList(allowed, 'envVars.allowed');
  return { allowed: [...new Set(allowed)].sort() };
}

function normalizeMounts(value) {
  if (!isRecord(value)) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'vfs must be a grant object', { key: 'vfs' });
  }
  const mounts = value.mounts;
  if (!Array.isArray(mounts) || !mounts.length) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'vfs.mounts must contain at least one mount', { key: 'vfs.mounts' });
  }
  return mounts.map((mount) => {
    if (!isRecord(mount) || typeof mount.path !== 'string' || !mount.path.startsWith('/')) {
      throw capabilityError('ERR_INVALID_CAPABILITY', 'each VFS mount needs an absolute path', { key: 'vfs.mounts' });
    }
    const mode = mount.mode ?? mount.permissions ?? 'read-only';
    if (!['read-only', 'read-write', 'ro', 'rw', 'read', 'write'].includes(mode)) {
      throw capabilityError('ERR_INVALID_CAPABILITY', `invalid VFS mount mode: ${mode}`, { key: 'vfs.mounts' });
    }
    return { ...mount, path: mount.path, mode };
  });
}

function proxyGrantIsEnabled(value, key = 'proxy') {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.includes(key);
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, key)) return proxyGrantIsEnabled(value[key], key);
  if (Array.isArray(value.allowed)) return value.allowed.includes(key);
  if (Array.isArray(value.keys)) return value.keys.includes(key);
  return value.enabled === true || value.allow === true || value.granted === true;
}

function normalizeProxyCapability(value) {
  if (value === undefined) {
    return { mode: 'virtual', enabled: false, capabilityKey: 'proxy', capabilityGranted: false };
  }
  if (value === false) {
    return { mode: 'virtual', enabled: false, capabilityKey: 'proxy', capabilityGranted: false };
  }
  const source = value === true ? { mode: 'proxy', enabled: true, capability: true } : value;
  if (!isRecord(source)) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'proxy must be a boolean or grant object', { key: 'proxy' });
  }
  const mode = source.mode ?? 'virtual';
  if (!['virtual', 'proxy'].includes(mode)) {
    throw capabilityError('ERR_INVALID_CAPABILITY', `invalid proxy mode: ${mode}`, { key: 'proxy' });
  }
  const capabilityKey = source.capabilityKey ?? 'proxy';
  if (typeof capabilityKey !== 'string' || !capabilityKey) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'proxy.capabilityKey must be a non-empty string', { key: 'proxy' });
  }
  const grant = source.capability ?? source.grant ?? source.granted;
  const capabilityGranted = proxyGrantIsEnabled(grant, capabilityKey);
  const enabled = source.enabled ?? source.optIn ?? mode === 'proxy';
  if (typeof enabled !== 'boolean') {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'proxy.enabled must be boolean', { key: 'proxy' });
  }
  return {
    mode,
    enabled: mode === 'proxy' && enabled,
    capabilityKey,
    capabilityGranted,
  };
}

/** Validate and canonicalize the one manifest that controls a browser run. */
export function validateCapabilityManifest(manifest) {
  if (!isRecord(manifest)) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'capabilities must be an object', { key: 'capabilities' });
  }
  for (const key of Object.keys(manifest)) {
    if (!CAPABILITY_KEYS.includes(key)) {
      throw capabilityError('ERR_INVALID_CAPABILITY', `unknown capability grant: ${key}`, { key });
    }
  }
  const envVars = normalizeEnvironmentGrant(manifest.envVars);
  if (manifest['process.env'] !== undefined) {
    const processEnv = normalizeEnvironmentGrant(manifest['process.env']);
    if (JSON.stringify(processEnv) !== JSON.stringify(envVars)) {
      throw capabilityError('ERR_INVALID_CAPABILITY', 'envVars and process.env grants conflict', { key: 'process.env' });
    }
  }
  if (manifest.vfs === undefined) {
    throw capabilityError('ERR_CAPABILITY_DENIED', 'vfs capability was not granted', { key: 'vfs' });
  }
  const vfs = { ...manifest.vfs, mounts: normalizeMounts(manifest.vfs) };
  const workers = manifest.workers;
  if (!isRecord(workers) || !Array.isArray(workers.entryModules) || !workers.entryModules.every((item) => typeof item === 'string')) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'workers.entryModules must be an array', { key: 'workers' });
  }
  if (!Number.isInteger(workers.maxChildren) || workers.maxChildren < 1) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'workers.maxChildren must be a positive integer', { key: 'workers.maxChildren' });
  }
  const ipc = manifest.ipc;
  if (!isRecord(ipc) || typeof ipc.enabled !== 'boolean') {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'ipc.enabled must be boolean', { key: 'ipc' });
  }
  const signals = manifest.signals;
  if (!isRecord(signals)) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'signals must be a grant object', { key: 'signals' });
  }
  const allowedSignals = signals.allowed ?? signals.names;
  assertStringList(allowedSignals, 'signals.allowed');
  if (allowedSignals.some((signal) => !SIGNALS.includes(signal))) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'signals contains an unsupported signal', { key: 'signals.allowed' });
  }
  const output = manifest.output;
  if (!isRecord(output)) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'output must be a grant object', { key: 'output' });
  }
  for (const key of ['maxBytes', 'stdoutBytes', 'stderrBytes', 'highWaterMark']) {
    if (output[key] !== undefined && (!Number.isInteger(output[key]) || output[key] < 0)) {
      throw capabilityError('ERR_INVALID_CAPABILITY', `output.${key} must be a non-negative integer`, { key: `output.${key}` });
    }
  }
  const proxy = normalizeProxyCapability(manifest.proxy);
  const canonical = clone({
    vfs,
    workers: { ...workers, entryModules: [...workers.entryModules] },
    ipc: { ...ipc },
    signals: { ...signals, allowed: [...new Set(allowedSignals)] },
    output: { ...output },
    envVars,
    proxy,
  });
  canonical['process.env'] = canonical.envVars;
  return Object.freeze(canonical);
}

/** Assemble the existing browser-native primitives for one validated run. */
export function assembleBrowserCapabilities(runSpec, { globalObject = globalThis, transport } = {}) {
  if (!isRecord(runSpec) || typeof runSpec.runId !== 'string' || !runSpec.runId) {
    throw capabilityError('ERR_INVALID_CAPABILITY', 'runSpec.runId is required', { key: 'runId' });
  }
  const manifest = validateCapabilityManifest(runSpec.capabilities);
  const vfs = createVfs({ mounts: manifest.vfs.mounts, fixtures: runSpec.fixtures });
  const output = createOutputCollector({
    transport,
    highWaterMark: manifest.output.highWaterMark,
    limits: {
      total: manifest.output.maxBytes,
      stdout: manifest.output.stdoutBytes,
      stderr: manifest.output.stderrBytes,
    },
  });
  return Object.freeze({
    manifest,
    vfs,
    output,
    proxy: manifest.proxy,
    messaging: createMessagingPrimitives(globalObject),
    process: { create: (options) => createBrowserProcess({ ...options, scope: globalObject, stdout: output.stdout, stderr: output.stderr }) },
  });
}

/**
 * Compose the browser-owned IO capabilities used by a runtime factory.
 * No helper in this module reaches for Node, a filesystem, or a socket.
 */
export function createBrowserIO(scope = globalThis) {
  const messaging = createMessagingPrimitives(scope);
  return {
    ...createNetworkPrimitives(scope),
    ...messaging,
    ...createStreamPrimitives(scope),
    structuredClone: messaging.structuredClone,
    TextEncoder: scope.TextEncoder,
    TextDecoder: scope.TextDecoder,
    CompressionStream: scope.CompressionStream,
    DecompressionStream: scope.DecompressionStream,
  };
}

export const createBrowserPrimitives = createBrowserIO;

export function createBrowserRuntimeContracts({ globalObject = globalThis, platform } = {}) {
  return Object.freeze({
    version: 'browser-native-capabilities/v1',
    crypto: createCryptoContract(globalObject),
    platform: createPlatformContract(platform),
    diagnostics: createDiagnosticsContract(globalObject),
    compression: createCompressionContract(globalObject),
    wasm: createWasmContract(globalObject),
    http: createHttpCompatibility(globalObject),
    tls: createTlsModule(globalObject),
    http2: createHttp2Module(globalObject),
    performance: createPerformancePrimitives(globalObject, { fallback: 'virtual' }),
    storage: createStorageAdapters({ globalObject, fallback: 'virtual' }),
    boundaries: createBoundaryContract(),
  });
}

export {
  BrowserEventEmitter,
  EventEmitter,
  getEventListeners,
  getMaxListeners,
} from './events.js';
export {
  createNetworkPrimitives,
  createBrowserNetworkGlobals,
} from './network.js';
export {
  adaptMessagePort,
  adaptWorker,
  createMessageChannel,
  createMessageEvent,
  markAsUncloneable,
  markAsUntransferable,
  isMarkedAsUntransferable,
  SHARE_ENV,
  prepareTransferPayload,
  createWorkerFactory,
  createBroadcastChannelFactory,
  createMessagingPrimitives,
} from './messaging.js';
export {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
} from './streams.js';
export {
  readableStreamFrom,
  writableStreamFrom,
  transformStream,
  streamAsAsyncIterable,
  collectStream,
  pipeStreams,
  createStreamPrimitives,
} from './web-streams.js';
export {
  compress,
  decompress,
  createCompressionContract,
} from './compression.js';
export {
  randomBytes,
  randomUUID,
  digest,
  hmac,
  pbkdf2,
  pbkdf2Sync,
  aesGcmEncrypt,
  aesGcmDecrypt,
  sign,
  verify,
  hasWebCrypto,
  browserCryptoVersion,
  createCryptoContract,
} from './crypto.js';
export {
  createDiagnosticsModule,
  createDiagnosticsChannel,
  createPerformanceContract,
  createAsyncContextContract,
  createAsyncLocalStorage,
  createDiagnosticsChannelRegistry,
  createDiagnosticsContract,
} from './diagnostics.js';
export {
  UnsupportedBrowserBoundaryError,
  UnsupportedWebCapabilityError,
  boundaryReason,
  boundaryStatus,
  unsupportedBoundary,
  createBoundaryContract,
} from './errors.js';
export { createPlatformContract } from './os-platform.js';
export { createWasmContract } from './wasm.js';
export { createHttpCompatibility } from './http.js';
export { createTlsModule, createTlsContract, TLSSocket, SecureContext } from './tls.js';
export { createHttp2Module, createHttp2Contract, ClientHttp2Session, Http2Server } from './http2.js';
export { createBrowserDns } from './dns.js';
export { createBrowserDgram } from './dgram.js';
export { createBrowserNet, Socket as NetSocket, Server as NetServer, isIP, isIPv4, isIPv6 } from './net.js';
export { createVirtualNetwork, sharedVirtualNetwork } from './virtual-network.js';
export { createCluster, createWorkerCluster, Worker as ClusterWorker } from './cluster.js';
export { createVirtualProcess, createInMemoryProcess } from './virtual-process.js';
export { createProxyCapability, callProxy, normalizeProxyError, normalizeProxyResult } from './proxy.js';
export { normalizeProxySelection, normalizeProxyOperation } from './proxy-contract.js';
export { createPerformancePrimitives } from './perf.js';
export {
  createBrowserStorage,
  createMemoryStorage,
  createStorageAdapters,
} from './storage.js';
export { createProcess, createConsole, installTimers } from './process.js';
export { createOutputCollector, OutputCollector } from './streams.js';
export { createModuleLoader } from './module-loader.js';
export { createVfs, pathToFileURL, fileURLToPath } from './vfs.js';
export {
  createCapabilityCompatibility,
  createConsoleModule,
  createConstants,
  createQuerystring,
  createStreamConsumers,
  createStringDecoder,
  createUtilTypes,
  createWebStreamModule,
} from './compat.js';
