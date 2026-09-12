import { VFS_MUTATION_ORIGIN } from './vfs.js';

const SHARED_VFS_HEADER_BYTES = 24;
const SHARED_VFS_OFFSET_INDEX = 1;
const SHARED_VFS_OVERFLOW_INDEX = 4;

function isSharedArrayBuffer(value) {
  return value != null && Object.prototype.toString.call(value) === '[object SharedArrayBuffer]';
}

function encodeBytes(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let text = '';
  for (let index = 0; index < value.byteLength; index += 0x8000) {
    text += String.fromCharCode(...value.subarray(index, index + 0x8000));
  }
  if (typeof btoa === 'function') return btoa(text);
  return globalThis.Buffer.from(text, 'binary').toString('base64');
}

function decodeBytes(value) {
  const text = String(value || '');
  if (typeof atob === 'function') {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new Uint8Array(globalThis.Buffer.from(text, 'base64'));
}

function wireChange(change) {
  const result = { ...change };
  if (change?.bytes !== undefined) result.bytes = encodeBytes(change.bytes);
  return result;
}

function wireUpdate(update) {
  if (update?.action === 'delta') {
    return {
      action: 'delta',
      removed: Array.isArray(update.removed) ? update.removed : [],
      changes: Array.isArray(update.changes) ? update.changes.map(wireChange) : [],
    };
  }
  if (update?.action === 'sync') {
    const state = update.state || {};
    return {
      action: 'sync',
      state: {
        directories: Array.isArray(state.directories) ? state.directories : [],
        symlinks: Array.isArray(state.symlinks) ? state.symlinks : [],
        files: Object.fromEntries(Object.entries(state.files || {}).map(([path, bytes]) => [path, encodeBytes(bytes)])),
      },
    };
  }
  return null;
}

function unwireChange(change) {
  const result = { ...change };
  if (change?.bytes !== undefined) result.bytes = decodeBytes(change.bytes);
  return result;
}

function unwireUpdate(update) {
  if (update?.action === 'delta') {
    return {
      action: 'delta',
      removed: Array.isArray(update.removed) ? update.removed : [],
      changes: Array.isArray(update.changes) ? update.changes.map(unwireChange) : [],
    };
  }
  if (update?.action === 'sync') {
    const state = update.state || {};
    return {
      action: 'sync',
      state: {
        directories: Array.isArray(state.directories) ? state.directories : [],
        symlinks: Array.isArray(state.symlinks) ? state.symlinks : [],
        files: Object.fromEntries(Object.entries(state.files || {}).map(([path, bytes]) => [path, decodeBytes(bytes)])),
      },
    };
  }
  return null;
}

export function createSharedVfsUpdateBuffer(byteLength = 64 * 1024 * 1024) {
  if (typeof SharedArrayBuffer !== 'function') return null;
  const size = Math.max(SHARED_VFS_HEADER_BYTES + 4, Math.trunc(byteLength));
  return new SharedArrayBuffer(size);
}

export function appendSharedVfsRecord(buffer, record) {
  if (typeof SharedArrayBuffer !== 'function' || !isSharedArrayBuffer(buffer)) return false;
  const header = new Int32Array(buffer, 0, SHARED_VFS_HEADER_BYTES / 4);
  const payload = new TextEncoder().encode(JSON.stringify(record));
  const offset = Atomics.load(header, SHARED_VFS_OFFSET_INDEX);
  const next = offset + 4 + payload.byteLength;
  if (SHARED_VFS_HEADER_BYTES + next > buffer.byteLength) {
    Atomics.store(header, SHARED_VFS_OVERFLOW_INDEX, 1);
    return false;
  }
  const bytes = new Uint8Array(buffer, SHARED_VFS_HEADER_BYTES);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, payload.byteLength, true);
  bytes.set(payload, offset + 4);
  Atomics.store(header, SHARED_VFS_OFFSET_INDEX, next);
  return true;
}

export function readSharedVfsRecords(buffer) {
  if (typeof SharedArrayBuffer !== 'function' || !isSharedArrayBuffer(buffer)) return [];
  const header = new Int32Array(buffer, 0, SHARED_VFS_HEADER_BYTES / 4);
  const offset = Atomics.load(header, SHARED_VFS_OFFSET_INDEX);
  const bytes = new Uint8Array(buffer, SHARED_VFS_HEADER_BYTES, Math.max(0, offset));
  const decoder = new TextDecoder();
  const records = [];
  let position = 0;
  while (position + 4 <= bytes.byteLength) {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(position, true);
    position += 4;
    if (length > bytes.byteLength - position) break;
    try {
      const payload = new Uint8Array(length);
      payload.set(bytes.subarray(position, position + length));
      records.push(JSON.parse(decoder.decode(payload)));
    } catch { break; }
    position += length;
  }
  return records;
}

export function sharedVfsBufferOverflowed(buffer) {
  if (typeof SharedArrayBuffer !== 'function' || !isSharedArrayBuffer(buffer)) return false;
  return Atomics.load(new Int32Array(buffer, 0, SHARED_VFS_HEADER_BYTES / 4), SHARED_VFS_OVERFLOW_INDEX) !== 0;
}

export function createSharedVfsUpdatePort(buffer) {
  const listeners = new Set();
  return {
    postMessage(message) {
      if (message?.action === 'barrier') {
        for (const listener of listeners) listener({ data: { action: 'ack', id: message.id } });
        return;
      }
      const update = wireUpdate(message);
      if (update) appendSharedVfsRecord(buffer, { type: 'vfs', update });
    },
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') listeners.delete(listener); },
    start() {},
    close() { listeners.clear(); },
  };
}

export function decodeSharedVfsRecord(record) {
  return record?.type === 'vfs' ? unwireUpdate(record.update) : null;
}

export function connectVfsUpdates(vfs, port, enqueue = queueMicrotask) {
  const origin = {};
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
    if (closed || update?.[VFS_MUTATION_ORIGIN] === origin) return;
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
    // Tag mutations applied from this connection so its own listener skips
    // them while other connections on the same VFS relay them to siblings.
    // This preserves package trees installed two or more worker boundaries
    // below the process that will later snapshot them.
    vfs.applyUpdate(update, { origin });
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
