function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return value;
}

/** A cache whose entries cannot cross workspace/run revisions. */
export function createVersionedModuleCache() {
  const entries = new Map();
  let activeRevision = null;
  const invalidateIfNeeded = (revision) => {
    if (activeRevision !== null && activeRevision !== revision) entries.clear();
    activeRevision = revision;
  };
  return {
    get(key, revision) {
      invalidateIfNeeded(revision);
      const entry = entries.get(String(key));
      return entry?.revision === revision ? clone(entry.value) : undefined;
    },
    set(key, value, revision) {
      invalidateIfNeeded(revision);
      entries.set(String(key), { revision, value: clone(value) });
      return value;
    },
    delete(key) { return entries.delete(String(key)); },
    clear() { entries.clear(); activeRevision = null; },
    has(key, revision) { return this.get(key, revision) !== undefined; },
    get size() { return entries.size; },
    get revision() { return activeRevision; },
  };
}
