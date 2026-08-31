const KNOWN_KEYS = new Set([
  'vfs', 'workers', 'ipc', 'signals', 'output', 'envVars', 'process.env', 'proxy',
  'network', 'npm', 'secrets', 'hostBridge', 'persistence', 'preview', 'budgets',
]);
const SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGKILL']);

function policyError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'CapabilityError';
  error.code = code;
  error.details = details;
  return error;
}

function record(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw policyError('ERR_INVALID_CAPABILITY', `${key} must be an object`, { key });
  }
  return value;
}

function stringList(value, key, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && (allowEmpty || item.length > 0))) {
    throw policyError('ERR_INVALID_CAPABILITY', `${key} must be an array of strings`, { key });
  }
  return [...new Set(value)].sort();
}

function integer(value, key, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    throw policyError('ERR_INVALID_CAPABILITY', `${key} must be an integer >= ${minimum}`, { key });
  }
  return value;
}

function normalizeMounts(value) {
  const source = record(value, 'vfs');
  if (!Array.isArray(source.mounts) || source.mounts.length === 0) {
    throw policyError('ERR_INVALID_CAPABILITY', 'vfs.mounts must contain at least one mount', { key: 'vfs.mounts' });
  }
  return source.mounts.map((mount) => {
    const item = record(mount, 'vfs.mounts');
    if (typeof item.path !== 'string' || !item.path.startsWith('/')) {
      throw policyError('ERR_INVALID_CAPABILITY', 'each VFS mount needs an absolute path', { key: 'vfs.mounts' });
    }
    const mode = item.mode ?? item.permissions ?? 'read-only';
    if (!['read-only', 'read-write', 'ro', 'rw', 'read', 'write'].includes(mode)) {
      throw policyError('ERR_INVALID_CAPABILITY', `invalid VFS mount mode: ${mode}`, { key: 'vfs.mounts' });
    }
    return { ...item, path: item.path, mode };
  });
}

function normalizeOrigin(value) {
  if (typeof value !== 'string') throw policyError('ERR_INVALID_CAPABILITY', 'network origins must be strings', { key: 'network.origins' });
  let parsed;
  try { parsed = new URL(value); } catch { throw policyError('ERR_INVALID_CAPABILITY', `invalid network origin: ${value}`, { key: 'network.origins' }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value.replace(/\/$/, '')) {
    throw policyError('ERR_INVALID_CAPABILITY', `network grant must contain origins, not paths: ${value}`, { key: 'network.origins' });
  }
  return parsed.origin;
}

function normalizeOptionalGrants(manifest) {
  const result = {};
  if (manifest.network !== undefined) {
    const network = record(manifest.network, 'network');
    const origins = stringList(network.origins ?? [], 'network.origins').map(normalizeOrigin).sort();
    const methods = stringList(network.methods ?? ['GET', 'HEAD'], 'network.methods').map((method) => method.toUpperCase()).sort();
    if (methods.some((method) => !/^[A-Z]+$/.test(method))) {
      throw policyError('ERR_INVALID_CAPABILITY', 'network methods must be HTTP method names', { key: 'network.methods' });
    }
    result.network = { ...network, origins: [...new Set(origins)], methods: [...new Set(methods)] };
  }
  if (manifest.npm !== undefined) {
    const npm = record(manifest.npm, 'npm');
    if (npm.lifecycleScripts !== undefined && typeof npm.lifecycleScripts !== 'boolean') {
      throw policyError('ERR_INVALID_CAPABILITY', 'npm.lifecycleScripts must be boolean', { key: 'npm.lifecycleScripts' });
    }
    result.npm = {
      ...npm,
      registries: stringList(npm.registries ?? [], 'npm.registries').map(normalizeOrigin),
      lifecycleScripts: npm.lifecycleScripts === true,
      allowedScripts: stringList(npm.allowedScripts ?? [], 'npm.allowedScripts'),
    };
  }
  if (manifest.secrets !== undefined) {
    const secrets = record(manifest.secrets, 'secrets');
    result.secrets = { ...secrets, names: stringList(secrets.names ?? [], 'secrets.names') };
  }
  if (manifest.hostBridge !== undefined) {
    const hostBridge = record(manifest.hostBridge, 'hostBridge');
    result.hostBridge = { ...hostBridge, apis: stringList(hostBridge.apis ?? [], 'hostBridge.apis') };
  }
  if (manifest.persistence !== undefined) {
    const persistence = record(manifest.persistence, 'persistence');
    if (persistence.enabled !== undefined && typeof persistence.enabled !== 'boolean') {
      throw policyError('ERR_INVALID_CAPABILITY', 'persistence.enabled must be boolean', { key: 'persistence.enabled' });
    }
    result.persistence = { ...persistence, enabled: persistence.enabled === true, namespaces: stringList(persistence.namespaces ?? [], 'persistence.namespaces') };
  }
  if (manifest.preview !== undefined) {
    const preview = record(manifest.preview, 'preview');
    const ports = [...new Set((preview.ports ?? []).map((port) => integer(port, 'preview.ports', { minimum: 1 })))].sort((a, b) => a - b);
    result.preview = { ...preview, ports };
  }
  if (manifest.budgets !== undefined) {
    const budgets = record(manifest.budgets, 'budgets');
    result.budgets = { ...budgets };
    for (const [key, value] of Object.entries(result.budgets)) integer(value, `budgets.${key}`);
  }
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function normalizeBase(manifest) {
  const vfs = { ...record(manifest.vfs, 'vfs'), mounts: normalizeMounts(manifest.vfs) };
  const workers = record(manifest.workers, 'workers');
  const ipc = record(manifest.ipc, 'ipc');
  const signals = record(manifest.signals, 'signals');
  const output = record(manifest.output, 'output');
  if (!Array.isArray(workers.entryModules) || !workers.entryModules.every((item) => typeof item === 'string')) {
    throw policyError('ERR_INVALID_CAPABILITY', 'workers.entryModules must be an array', { key: 'workers.entryModules' });
  }
  integer(workers.maxChildren, 'workers.maxChildren', { minimum: 1 });
  if (typeof ipc.enabled !== 'boolean') throw policyError('ERR_INVALID_CAPABILITY', 'ipc.enabled must be boolean', { key: 'ipc.enabled' });
  const allowedSignals = stringList(signals.allowed ?? signals.names, 'signals.allowed');
  if (allowedSignals.some((signal) => !SIGNALS.has(signal))) throw policyError('ERR_INVALID_CAPABILITY', 'signals contains an unsupported signal', { key: 'signals.allowed' });
  for (const key of ['maxBytes', 'stdoutBytes', 'stderrBytes', 'highWaterMark']) {
    if (output[key] !== undefined) integer(output[key], `output.${key}`);
  }
  const env = manifest.envVars ?? manifest['process.env'] ?? { allowed: [] };
  const envRecord = Array.isArray(env) ? { allowed: env } : record(env, 'envVars');
  const allowedEnv = stringList(envRecord.allowed ?? envRecord.keys ?? [], 'envVars.allowed');
  const proxy = manifest.proxy ?? { mode: 'virtual', enabled: false };
  return {
    vfs,
    workers: { ...workers, entryModules: stringList(workers.entryModules, 'workers.entryModules') },
    ipc: { ...ipc },
    signals: { ...signals, allowed: allowedSignals },
    output: { ...output },
    envVars: { allowed: allowedEnv },
    proxy: typeof proxy === 'object' ? { ...proxy } : proxy,
  };
}

/** Build the immutable, inspectable policy object used by a browser run. */
export function createCapabilityManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw policyError('ERR_INVALID_CAPABILITY', 'capabilities must be an object', { key: 'capabilities' });
  }
  for (const key of Object.keys(manifest)) {
    if (!KNOWN_KEYS.has(key)) throw policyError('ERR_INVALID_CAPABILITY', `unknown capability grant: ${key}`, { key });
  }
  const base = normalizeBase(manifest);
  const optional = normalizeOptionalGrants(manifest);
  base['process.env'] = base.envVars;
  return deepFreeze({ ...base, ...optional });
}

function difference(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    const rightValues = new Set(right.map((value) => JSON.stringify(value)));
    return left.filter((value) => !rightValues.has(JSON.stringify(value)));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const result = {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const nested = difference(left[key], right[key]);
      if (nested !== undefined && (!(Array.isArray(nested)) || nested.length) && (!(nested && typeof nested === 'object') || Object.keys(nested).length)) result[key] = nested;
    }
    return Object.keys(result).length ? result : undefined;
  }
  return Object.is(left, right) ? undefined : clone(right);
}

/** Return only newly granted and revoked policy values for a prompt or audit log. */
export function capabilityDelta(previous, next) {
  const added = difference(next, previous) || {};
  const removed = difference(previous, next) || {};
  return { added, removed };
}

export { policyError };
