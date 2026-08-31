function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function stable(value) {
  if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(',')}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fallbackHash(text) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

async function contentHash(value) {
  const text = stable(value);
  if (globalThis.crypto?.subtle) {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return fallbackHash(text);
}

function paths(value, prefix = '', output = new Map()) {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Array.isArray(value)) {
    for (const key of Object.keys(value)) paths(value[key], prefix ? `${prefix}/${key}` : key, output);
    if (!Object.keys(value).length) output.set(prefix, stable(value));
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => paths(item, `${prefix}/${index}`, output));
  } else {
    output.set(prefix, stable(value));
  }
  return output;
}

export function createCheckpointStore({ snapshot, restore, metadata = {} } = {}) {
  if (typeof snapshot !== 'function' || typeof restore !== 'function') throw new TypeError('checkpoint snapshot and restore functions are required');
  const records = new Map();
  return {
    async create(extra = {}) {
      const value = clone(await snapshot());
      const digest = await contentHash(value);
      const id = `checkpoint-${digest}`;
      records.set(id, { id, digest, createdAt: Date.now(), metadata: clone({ ...metadata, ...extra }), snapshot: value });
      return Object.freeze({ id, digest, createdAt: records.get(id).createdAt, metadata: clone(records.get(id).metadata) });
    },
    async commit(extra = {}) { return this.create(extra); },
    get(id) {
      const record = records.get(String(id));
      return record && Object.freeze({ id: record.id, digest: record.digest, createdAt: record.createdAt, metadata: clone(record.metadata), snapshot: clone(record.snapshot) });
    },
    list() { return [...records.values()].map(({ id, digest, createdAt, metadata: info }) => ({ id, digest, createdAt, metadata: clone(info) })); },
    diff(id, other = undefined) {
      const record = records.get(String(id));
      if (!record) throw Object.assign(new Error(`checkpoint not found: ${id}`), { code: 'ERR_CHECKPOINT_NOT_FOUND' });
      const left = paths(record.snapshot);
      const right = paths(other === undefined ? snapshot() : other);
      const changed = [];
      for (const key of new Set([...left.keys(), ...right.keys()])) if (left.get(key) !== right.get(key)) changed.push(key);
      return changed.sort().join('\n');
    },
    async rollback(id) {
      const record = records.get(String(id));
      if (!record) throw Object.assign(new Error(`checkpoint not found: ${id}`), { code: 'ERR_CHECKPOINT_NOT_FOUND' });
      await restore(clone(record.snapshot));
      return this.get(id);
    },
    clear() { records.clear(); },
  };
}
