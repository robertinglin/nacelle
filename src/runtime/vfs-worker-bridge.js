export function connectVfsUpdates(vfs, port, enqueue = queueMicrotask) {
  let applyingRemote = false;
  let closed = false;
  let nextBarrier = 0;
  const barriers = new Map();
  const pendingBatches = [];
  let fullSyncPending = false;
  let flushScheduled = false;
  const queuePathBatch = (paths) => {
    const previous = pendingBatches.at(-1);
    if (previous?.kind === 'paths') {
      for (const pathValue of paths) previous.paths.add(pathValue);
      return;
    }
    pendingBatches.push({ kind: 'paths', paths: new Set(paths) });
  };
  const flush = () => {
    flushScheduled = false;
    if (closed) return;
    if (fullSyncPending) {
      fullSyncPending = false;
      pendingBatches.length = 0;
      port.postMessage({ action: 'sync', state: vfs.exportState?.() });
      return;
    }
    for (const batch of pendingBatches.splice(0)) {
      if (batch.kind === 'delta') {
        port.postMessage({
          action: 'delta',
          removed: batch.removed,
          changes: batch.changes,
        });
        continue;
      }
      const changes = [];
      for (const pathValue of batch.paths) {
        changes.push(vfs.describe?.(pathValue) || { path: pathValue, type: 'remove' });
      }
      if (changes.length) port.postMessage({ action: 'delta', changes });
    }
  };
  const schedule = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    enqueue(flush);
  };
  const unsubscribe = vfs.subscribeMutations((update) => {
    if (applyingRemote || closed) return;
    if (update.action === 'sync') {
      fullSyncPending = true;
      pendingBatches.length = 0;
      schedule();
      return;
    }
    if (update.action === 'change-set') {
      pendingBatches.push({
        kind: 'delta',
        removed: Array.isArray(update.removed) ? update.removed : [],
        changes: Array.isArray(update.changes) ? update.changes : [],
      });
      schedule();
      return;
    }
    const paths = [...(update.paths || [])];
    if (update.path) paths.push(update.path);
    if (paths.length) queuePathBatch(paths);
    schedule();
  });
  const onMessage = (event) => {
    const update = event?.data ?? event;
    if (update?.action === 'barrier') {
      port.postMessage({ action: 'ack', id: update.id });
      return;
    }
    if (update?.action === 'ack') {
      barriers.get(update.id)?.resolve();
      barriers.delete(update.id);
      return;
    }
    if (update?.action !== 'delta' && update?.action !== 'sync') return;
    // Suppress echoes on this connection while letting other connections
    // relay the mutation to sibling workers.
    applyingRemote = true;
    try { vfs.applyUpdate(update); } finally { applyingRemote = false; }
  };
  port.addEventListener('message', onMessage);
  port.start();
  return {
    drain() {
      if (closed) return Promise.reject(new Error('VFS connection is closed'));
      flush();
      const id = ++nextBarrier;
      const pending = new Promise((resolve, reject) => barriers.set(id, { resolve, reject }));
      // MessagePort ordering makes the acknowledgement a barrier for all
      // preceding writes, even when the process exits on a different port.
      port.postMessage({ action: 'barrier', id });
      return pending;
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      port.removeEventListener('message', onMessage);
      port.close();
      for (const barrier of barriers.values()) barrier.reject(new Error('VFS connection is closed'));
      barriers.clear();
    },
  };
}
