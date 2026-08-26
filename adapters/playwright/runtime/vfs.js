import { EventEmitter } from './events.js';
import { Readable, Writable } from './streams.js';
import { resolveEncodingOps } from './buffer.js';
import { unsupportedNativeAddon } from './errors.js';
import { AsyncResource } from './async-hooks.js';

const textEncoder = new TextEncoder();
const READ_FILE_ASYNC_STAGES = 4;

function vfsError(code, path, operation, message = code) {
  const error = new Error(`${code}: ${message}${path ? `, ${operation} '${path}'` : ''}`);
  error.code = code;
  if (path) error.path = path;
  if (operation) error.syscall = operation;
  if (code === 'ENOENT') error.errno = -2;
  return error;
}

function invalidPath(message = 'path is not a valid logical POSIX path') {
  return vfsError('ERR_INVALID_PATH', undefined, undefined, message);
}

function denied(path, operation) {
  return vfsError('ERR_CAPABILITY_DENIED', path, operation, 'path is outside the granted VFS mounts');
}

function missing(path, operation = 'open') {
  return vfsError('ENOENT', path, operation, 'no such file or directory');
}

function existsError(path, operation = 'mkdir') {
  return vfsError('EEXIST', path, operation, 'file already exists');
}

function notDirectory(path, operation = 'access') {
  return vfsError('ENOTDIR', path, operation, 'not a directory');
}

function isDirectory(path, operation = 'open') {
  return vfsError('EISDIR', path, operation, 'is a directory');
}

function notEmpty(path, operation = 'rmdir') {
  return vfsError('ENOTEMPTY', path, operation, 'directory not empty');
}

function closedHandle() {
  return vfsError('EBADF', undefined, undefined, 'file handle is closed');
}

function decode(value, encoding, preserveUint8Array = false) {
  if (value instanceof Uint8Array) {
    // Worker-posted fixture bytes are already isolated from their sender. Keep
    // those exact Uint8Arrays in the backend, but continue copying Buffer
    // inputs so direct writes retain normal filesystem ownership semantics.
    if (preserveUint8Array && value.constructor === Uint8Array) return value;
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (encoding) return (resolveEncodingOps(encoding) || { encode: (text) => textEncoder.encode(text) }).encode(String(value));
  return textEncoder.encode(String(value));
}

function nodeBuffer(bytes) {
  const BufferClass = globalThis?.Buffer;
  return typeof BufferClass?.from === 'function' ? BufferClass.from(bytes) : bytes;
}

function isFileUrl(value) {
  return value instanceof URL || (value && typeof value === 'object' && value.protocol === 'file:');
}

function sourcePath(value) {
  if (isFileUrl(value)) {
    if (value.protocol !== 'file:' || value.hostname) throw invalidPath('file URL host is not supported');
    try {
      return decodeURIComponent(value.pathname);
    } catch {
      throw invalidPath('file URL contains malformed escaping');
    }
  }
  if (typeof value !== 'string') throw invalidPath();
  return value;
}

function normalizePath(value, cwd = '/node') {
  const source = sourcePath(value);
  if (!source || source.includes('\\') || source.includes('\0')) throw invalidPath();
  const absolute = source.startsWith('/');
  const base = absolute ? [] : cwd.split('/').filter(Boolean);
  const parts = source.split('/');
  const result = [...base];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length <= base.length) throw invalidPath('path escapes its logical mount');
      result.pop();
      continue;
    }
    result.push(part);
  }
  return `/${result.join('/')}` || '/';
}

function isWithin(path, root) {
  return path === root || root === '/' || path.startsWith(`${root}/`);
}

function modeFor(config = {}) {
  const mode = config.mode ?? config.permissions ?? (config.readOnly ? 'read-only' : 'read-write');
  if (mode === 'ro' || mode === 'read' || mode === 'read-only' || mode === 'readonly') return 'read-only';
  if (mode === 'rw' || mode === 'write' || mode === 'read-write' || mode === 'readwrite') return 'read-write';
  throw invalidPath('mount mode must be read-only or read-write');
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createMemoryBackend() {
  const files = new Map();
  const directories = new Set(['/']);
  return {
    files,
    directories,
    reset() {
      files.clear();
      directories.clear();
      directories.add('/');
    },
  };
}

export function createMemoryVfsBackend() {
  return createMemoryBackend();
}

class Stats {
  constructor(file, size) {
    this.size = size;
    this.mode = file ? 0o100666 : 0o40777;
    this.dev = 0;
    this.ino = 0;
    this.nlink = 1;
    this.uid = 0;
    this.gid = 0;
    this.rdev = 0;
    this.blksize = 4096;
    this.blocks = Math.ceil(size / 512);
    this.atimeMs = Date.now();
    this.mtimeMs = this.atimeMs;
    this.ctimeMs = this.mtimeMs;
    this.birthtimeMs = this.mtimeMs;
    this._file = file;
  }

  isFile() { return this._file; }
  isDirectory() { return !this._file; }
  isSymbolicLink() { return false; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
  get atime() { return new globalThis.Date(this.atimeMs); }
  get mtime() { return new globalThis.Date(this.mtimeMs); }
  get ctime() { return new globalThis.Date(this.ctimeMs); }
  get birthtime() { return new globalThis.Date(this.birthtimeMs); }
}

class Dirent {
  constructor(name, directory, parentPath) {
    this.name = name;
    this._directory = directory;
    this.parentPath = parentPath;
  }

  isFile() { return !this._directory; }
  isDirectory() { return this._directory; }
  isSymbolicLink() { return false; }
}

export function createVfs(options = {}) {
  const suppliedBackend = typeof options.backend === 'function' ? options.backend() : options.backend;
  const backend = suppliedBackend || createMemoryBackend();
  const files = backend.files instanceof Map ? backend.files : new Map();
  const directories = backend.directories instanceof Set ? backend.directories : new Set(['/']);
  let taskTracker = typeof options.trackTask === 'function' ? options.trackTask : null;
  if (!directories.has('/')) directories.add('/');
  const mounts = new Map();
  const watchers = new Map();
  const descriptors = new Map();
  let nextDescriptor = 100;
  let mutationQueue = Promise.resolve();

  function findMount(path) {
    let selected;
    for (const mount of mounts.values()) {
      if (isWithin(path, mount.path) && (!selected || mount.path.length > selected.path.length)) selected = mount;
    }
    return selected;
  }

  function resolve(value) {
    return normalizePath(value);
  }

  function access(path, operation, write = false) {
    const mount = findMount(path);
    if (!mount) throw denied(path, operation);
    if (write && mount.mode === 'read-only') throw denied(path, operation);
    return mount;
  }

  function parentOf(path) {
    return path.slice(0, path.lastIndexOf('/')) || '/';
  }

  function notify(path, eventType) {
    const parent = parentOf(path);
    for (const [watchPath, list] of watchers) {
      if (parent !== watchPath && path !== watchPath && !isWithin(path, watchPath)) continue;
      for (const watcher of [...list]) watcher._notify(eventType, path.split('/').at(-1));
    }
  }

  function ensureParent(path, operation) {
    const parent = parentOf(path);
    access(parent, operation);
    if (files.has(parent)) throw notDirectory(parent, operation);
    if (!directories.has(parent)) throw missing(parent, operation);
  }

  function addDirectory(path, operation = 'mkdir') {
    access(path, operation, true);
    if (files.has(path)) throw notDirectory(path, operation);
    if (directories.has(path)) return false;
    ensureParent(path, operation);
    directories.add(path);
    notify(path, 'rename');
    return true;
  }

  function makeDirectory(path, recursive, operation = 'mkdir') {
    access(path, operation, true);
    if (files.has(path)) throw existsError(path, operation);
    if (directories.has(path)) {
      if (!recursive) throw existsError(path, operation);
      return false;
    }
    const parent = parentOf(path);
    access(parent, operation, true);
    if (files.has(parent)) throw notDirectory(parent, operation);
    if (!directories.has(parent)) {
      if (!recursive) throw missing(parent, operation);
      makeDirectory(parent, true, operation);
    }
    directories.add(path);
    notify(path, 'rename');
    return true;
  }

  function setFile(path, value, append = false, operation = 'write') {
    const mount = access(path, operation, true);
    ensureParent(path, operation);
    if (directories.has(path)) throw isDirectory(path, operation);
    const previous = files.get(path);
    const bytes = decode(value);
    files.set(path, append && previous ? new Uint8Array([...previous, ...bytes]) : bytes);
    notify(path, previous ? 'change' : 'rename');
    return mount;
  }

  function readBytes(path, operation = 'open') {
    access(path, operation);
    if (directories.has(path)) throw isDirectory(path, operation);
    const value = files.get(path);
    if (value === undefined) throw missing(path, operation);
    return new Uint8Array(value);
  }

  function removeFile(path, operation = 'unlink') {
    access(path, operation, true);
    if (directories.has(path)) throw isDirectory(path, operation);
    if (!files.has(path)) throw missing(path, operation);
    files.delete(path);
    notify(path, 'rename');
  }

  function removeTree(path, recursive = false, force = false) {
    access(path, 'rm', true);
    if (files.has(path)) {
      files.delete(path);
      notify(path, 'rename');
      return;
    }
    if (!directories.has(path)) {
      if (!force) throw missing(path, 'rm');
      return;
    }
    if (path === '/') throw denied(path, 'rm');
    const children = [...files.keys(), ...directories].filter((item) => item !== path && isWithin(item, path));
    if (children.length && !recursive) throw notEmpty(path);
    for (const child of children) {
      files.delete(child);
      directories.delete(child);
    }
    directories.delete(path);
    notify(path, 'rename');
  }

  function directoryEntries(path) {
    access(path, 'scandir');
    if (files.has(path)) throw notDirectory(path, 'scandir');
    if (!directories.has(path)) throw missing(path, 'scandir');
    const names = new Map();
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const directory of directories) {
      if (directory.startsWith(prefix) && directory !== path) {
        const name = directory.slice(prefix.length).split('/')[0];
        names.set(name, true);
      }
    }
    for (const file of files.keys()) {
      if (file.startsWith(prefix)) {
        const name = file.slice(prefix.length).split('/')[0];
        names.set(name, names.get(name) || false);
      }
    }
    return [...names].sort((left, right) => lexicalCompare(left[0], right[0]))
      .map(([name, directory]) => new Dirent(name, directory, path));
  }

  function recursiveDirectoryEntries(path) {
    const result = [];
    const pending = [path];
    while (pending.length) {
      const parent = pending.shift();
      for (const entry of directoryEntries(parent)) {
        result.push(entry);
        if (entry.isDirectory()) pending.push(`${parent === '/' ? '' : parent}/${entry.name}` || '/');
      }
    }
    return result;
  }

  function statPath(path) {
    access(path, 'stat');
    if (files.has(path)) return new Stats(true, files.get(path).byteLength);
    if (directories.has(path)) return new Stats(false, 0);
    throw missing(path, 'stat');
  }

  function encodingOption(optionsValue) {
    return typeof optionsValue === 'string' ? optionsValue : optionsValue?.encoding || null;
  }

  function decodeText(bytes, encoding) {
    if (!encoding) return nodeBuffer(bytes);
    return new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(bytes);
  }

  function scheduleReadFile(callback) {
    let stagesRemaining = READ_FILE_ASYNC_STAGES;
    const schedule = typeof globalThis.queueMicrotask === 'function'
      ? (next) => globalThis.queueMicrotask(next)
      : (next) => globalThis.setTimeout(next, 0);
    const runStage = () => {
      const resource = new AsyncResource('FSREQCALLBACK');
      const release = taskTracker?.();
      schedule(() => {
        try {
          resource.runInAsyncScope(() => {
            stagesRemaining -= 1;
            if (stagesRemaining) runStage();
            else callback();
          });
        } finally {
          resource.emitDestroy();
          release?.();
        }
      });
    };
    runStage();
  }

  function writeFile(pathValue, data, optionsValue, callback) {
    let optionsObject = optionsValue;
    let done = callback;
    if (typeof optionsValue === 'function') {
      done = optionsValue;
      optionsObject = undefined;
    }
    try {
      const path = resolve(pathValue);
      const flag = typeof optionsObject === 'string' ? optionsObject : optionsObject?.flag || 'w';
      if (flag.includes('x') && (files.has(path) || directories.has(path))) throw existsError(path, 'write');
      setFile(path, data, flag.includes('a'), 'write');
      if (typeof done === 'function') done(null);
    } catch (error) {
      if (typeof done === 'function') done(error);
      else throw error;
    }
  }

  function appendFile(pathValue, data, optionsValue, callback) {
    let done = callback;
    if (typeof optionsValue === 'function') done = optionsValue;
    try {
      const path = resolve(pathValue);
      const flag = typeof optionsValue === 'string' ? optionsValue : optionsValue?.flag || 'a';
      if (flag.includes('x') && (files.has(path) || directories.has(path))) throw existsError(path, 'append');
      setFile(path, data, true, 'append');
      if (typeof done === 'function') done(null);
    } catch (error) {
      if (typeof done === 'function') done(error);
      else throw error;
    }
  }

  function readFile(pathValue, optionsValue, callback) {
    let optionsObject = optionsValue;
    let done = callback;
    if (typeof optionsValue === 'function') {
      done = optionsValue;
      optionsObject = undefined;
    }
    if (typeof done === 'function') {
      scheduleReadFile(() => {
        try {
          done(null, decodeText(readBytes(resolve(pathValue)), encodingOption(optionsObject)));
        } catch (error) {
          done(error);
        }
      });
      return;
    }
    try {
      const value = decodeText(readBytes(resolve(pathValue)), encodingOption(optionsObject));
      return value;
    } catch (error) {
      throw error;
    }
  }

  function truncate(pathValue, length = 0) {
    const path = resolve(pathValue);
    if (!Number.isInteger(length) || length < 0) throw invalidPath('truncate length must be a non-negative integer');
    const current = readBytes(path, 'truncate');
    const next = new Uint8Array(length);
    next.set(current.subarray(0, length));
    access(path, 'truncate', true);
    files.set(path, next);
    notify(path, 'change');
  }

  function copyFile(sourceValue, destinationValue, flags = 0) {
    const source = resolve(sourceValue);
    const destination = resolve(destinationValue);
    const sourceMount = access(source, 'copyFile');
    const destinationMount = access(destination, 'copyFile', true);
    if (sourceMount.path !== destinationMount.path) throw denied(destination, 'copyFile');
    if (flags & 1 && (files.has(destination) || directories.has(destination))) throw existsError(destination, 'copyFile');
    setFile(destination, readBytes(source, 'copyFile'), false, 'copyFile');
  }

  function copyTree(sourceValue, destinationValue, optionsValue = {}) {
    const source = resolve(sourceValue);
    const destination = resolve(destinationValue);
    if (files.has(source)) {
      copyFile(source, destination, optionsValue.errorOnExist ? 1 : 0);
      return;
    }
    access(source, 'cp');
    if (!directories.has(source)) throw missing(source, 'cp');
    makeDirectory(destination, true, 'cp');
    for (const entry of directoryEntries(source)) copyTree(`${source}/${entry.name}`, `${destination}/${entry.name}`, optionsValue);
  }

  function rename(sourceValue, destinationValue) {
    const source = resolve(sourceValue);
    const destination = resolve(destinationValue);
    const sourceMount = access(source, 'rename', true);
    const destinationMount = access(destination, 'rename', true);
    if (sourceMount.path !== destinationMount.path) throw denied(destination, 'rename');
    if (source === destination) return;
    if (!files.has(source) && !directories.has(source)) throw missing(source, 'rename');
    ensureParent(destination, 'rename');
    if (files.has(destination) && directories.has(source)) throw notDirectory(destination, 'rename');
    if (directories.has(destination) && files.has(source)) throw isDirectory(destination, 'rename');
    if (directories.has(destination)) throw existsError(destination, 'rename');
    if (directories.has(source) && isWithin(destination, source)) throw invalidPath('rename target is inside source directory');

    if (files.has(source)) {
      files.set(destination, files.get(source));
      files.delete(source);
    } else {
      const childDirectories = [...directories].filter((item) => item === source || isWithin(item, source));
      const childFiles = [...files.keys()].filter((item) => isWithin(item, source));
      for (const item of childDirectories) directories.add(`${destination}${item.slice(source.length)}`);
      for (const item of childFiles) files.set(`${destination}${item.slice(source.length)}`, files.get(item));
      for (const item of childFiles) files.delete(item);
      for (const item of childDirectories) directories.delete(item);
    }
    notify(source, 'rename');
    notify(destination, 'rename');
  }

  function openDescriptor(pathValue, flags = 'r') {
    flags = String(flags);
    const path = resolve(pathValue);
    const writable = flags.includes('w') || flags.includes('a') || flags.includes('+');
    access(path, 'open', writable);
    if (directories.has(path)) throw isDirectory(path, 'open');
    if (!files.has(path) && !flags.includes('w') && !flags.includes('a')) throw missing(path, 'open');
    if (flags.includes('x') && files.has(path)) throw existsError(path, 'open');
    if (!files.has(path)) setFile(path, new Uint8Array(), false, 'open');
    if (flags.includes('w')) setFile(path, new Uint8Array(), false, 'open');
    const fd = nextDescriptor++;
    descriptors.set(fd, {
      fd,
      path,
      flags,
      position: flags.includes('a') ? readBytes(path).length : 0,
    });
    return fd;
  }

  function descriptor(value) {
    const fd = typeof value === 'number' ? value : value?.fd;
    const record = descriptors.get(fd);
    if (!record || record.closed) throw closedHandle();
    return record;
  }

  function assertWritable(record) {
    if (!record.flags.includes('w') && !record.flags.includes('a') && !record.flags.includes('+')) {
      throw vfsError('EBADF', record.path, 'write', 'descriptor is not writable');
    }
  }

  function closeDescriptor(value) {
    const record = descriptor(value);
    record.closed = true;
    descriptors.delete(record.fd);
  }

  function readDescriptor(value, buffer, offset = 0, length = buffer.length - offset, position) {
    const record = descriptor(value);
    const source = readBytes(record.path, 'read');
    const at = position === null || position === undefined ? record.position : position;
    const chunk = source.subarray(at, at + length);
    buffer.set(chunk, offset);
    if (position === null || position === undefined) record.position = at + chunk.length;
    return { bytesRead: chunk.length, buffer };
  }

  function writeDescriptor(value, data, offset = 0, length, position) {
    const record = descriptor(value);
    assertWritable(record);
    const valueBytes = decode(data);
    const at = position === null || position === undefined ? record.position : position;
    const count = Math.min(length ?? valueBytes.length, valueBytes.length - offset);
    const target = readBytes(record.path, 'write');
    const result = new Uint8Array(Math.max(target.length, at + count));
    result.set(target);
    result.set(valueBytes.subarray(offset, offset + count), at);
    setFile(record.path, result, false, 'write');
    if (position === null || position === undefined) record.position = at + count;
    return { bytesWritten: count, buffer: data };
  }

  function fileHandle(fd) {
    const record = descriptor(fd);
    return {
      fd: record.fd,
      async writeFile(data, optionsValue) {
        descriptor(record.fd);
        assertWritable(record);
        const encoding = typeof optionsValue === 'string' ? optionsValue : optionsValue?.encoding;
        const bytes = decode(data, encoding);
        writeDescriptor(record.fd, bytes, 0, bytes.length, null);
      },
      async readFile(optionsValue) { descriptor(record.fd); return readFile(record.path, optionsValue); },
      async stat() { descriptor(record.fd); return statPath(record.path); },
      async close() { if (descriptors.has(record.fd)) closeDescriptor(record.fd); },
      async truncate(length = 0) { descriptor(record.fd); assertWritable(record); truncate(record.path, length); },
      async write(data, offset = 0, length, position) {
        return writeDescriptor(record.fd, data, offset, length, position);
      },
      async read(buffer, offset = 0, length = buffer.length, position) {
        return readDescriptor(record.fd, buffer, offset, length, position);
      },
    };
  }

  function streamDescriptor(pathValue, optionsValue, flags) {
    if (optionsValue.fd !== undefined) {
      return { fd: descriptor(optionsValue.fd).fd, owned: true };
    }
    if (pathValue === null || pathValue === undefined) throw invalidPath('path or file descriptor is required');
    return { fd: openDescriptor(pathValue, flags), owned: true };
  }

  function createReadStream(pathValue, optionsValue = {}) {
    const options = typeof optionsValue === 'string' ? { encoding: optionsValue } : optionsValue || {};
    const stream = new Readable({ highWaterMark: options.highWaterMark ?? options.bufferSize });
    stream.path = pathValue ?? undefined;
    stream.fd = typeof options.fd === 'number' ? options.fd : options.fd?.fd ?? null;
    stream.bytesRead = 0;
    stream.autoClose = options.autoClose !== false;
    stream.start = options.start ?? 0;
    stream.end = options.end ?? Infinity;
    stream.closed = false;
    stream._fsPosition = stream.start;
    stream._fsStarted = false;
    stream._fsOpen = () => {
      if (stream._fsStarted) return;
      stream._fsStarted = true;
      try {
        const opened = streamDescriptor(pathValue, options, 'r');
        stream.fd = opened.fd;
        stream._fsOwned = opened.owned;
        stream.emit('open', stream.fd);
        stream.emit('ready');
      } catch (error) {
        stream.destroy(error);
      }
    };
    stream._read = () => {
      stream._fsOpen();
      if (stream.destroyed || stream._ended) return;
      try {
        const record = descriptor(stream.fd);
        const available = Math.max(0, Math.min(
          readBytes(record.path).length - stream._fsPosition,
          stream.end - stream._fsPosition + 1,
        ));
        if (!available) {
          stream.push(null);
          if (stream.autoClose && stream._fsOwned) closeDescriptor(stream.fd);
          stream.closed = stream.autoClose && stream._fsOwned;
          queueMicrotask(() => stream._emitClose());
          return;
        }
        const size = Math.max(1, Math.min(options.highWaterMark ?? options.bufferSize ?? 16 * 1024, available));
        const buffer = new Uint8Array(size);
        const result = readDescriptor(stream.fd, buffer, 0, size, stream._fsPosition);
        stream._fsPosition += result.bytesRead;
        stream.bytesRead += result.bytesRead;
        stream.push(buffer.subarray(0, result.bytesRead));
        if (!stream._ended) queueMicrotask(() => { if (stream._flowing) stream.resume(); });
      } catch (error) {
        if (stream.autoClose && stream._fsOwned && stream.fd !== null) {
          try { closeDescriptor(stream.fd); } catch { /* preserve the read error */ }
        }
        stream.destroy(error);
      }
    };
    // Open eagerly like Node's fs.ReadStream, but wait for a data listener or
    // async iterator before switching into flowing mode so buffered bytes are
    // not discarded before a consumer attaches.
    queueMicrotask(() => stream._fsOpen());
    return stream;
  }

  function createWriteStream(pathValue, optionsValue = {}) {
    const options = typeof optionsValue === 'string' ? { encoding: optionsValue } : optionsValue || {};
    const stream = new Writable({
      highWaterMark: options.highWaterMark,
      write(bytes, _encoding, callback) {
        try {
          if (!stream._fsStarted) {
            const opened = streamDescriptor(pathValue, options, options.flags || 'w');
            stream.fd = opened.fd;
            stream._fsOwned = opened.owned;
            stream._fsStarted = true;
            stream.emit('open', stream.fd);
            stream.emit('ready');
          }
          writeDescriptor(stream.fd, bytes, 0, bytes.length, stream._fsPosition);
          stream._fsPosition += bytes.length;
          stream.bytesWritten += bytes.length;
          callback();
        } catch (error) { callback(error); }
      },
      final(callback) {
        if (stream.autoClose && stream._fsOwned && stream.fd !== null) closeDescriptor(stream.fd);
        stream.closed = stream.autoClose && stream._fsOwned;
        callback();
      },
    });
    stream.path = pathValue ?? undefined;
    stream.fd = typeof options.fd === 'number' ? options.fd : options.fd?.fd ?? null;
    stream.bytesWritten = 0;
    stream.autoClose = options.autoClose !== false;
    stream.closed = false;
    stream._fsPosition = options.start ?? 0;
    stream._fsStarted = false;
    stream._fsOwned = false;
    stream._fsOpen = () => {
      if (stream._fsStarted) return;
      try {
        const opened = streamDescriptor(pathValue, options, options.flags || 'w');
        stream.fd = opened.fd;
        stream._fsOwned = opened.owned;
        stream._fsStarted = true;
        stream.emit('open', stream.fd);
        stream.emit('ready');
      } catch (error) { stream.destroy(error); }
    };
    queueMicrotask(() => { if (!stream.destroyed) stream._fsOpen(); });
    return stream;
  }

  function watch(pathValue, optionsValue, listener) {
    const path = resolve(pathValue);
    statPath(path);
    const emitter = new EventEmitter();
    const callback = typeof optionsValue === 'function' ? optionsValue : typeof listener === 'function' ? listener : () => {};
    const queue = [];
    const waiters = [];
    const list = watchers.get(path) || [];
    let closed = false;
    emitter.on('change', callback);
    emitter._notify = (eventType, filename) => {
      emitter.emit('change', eventType, filename);
      const item = { eventType, filename };
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else queue.push(item);
    };
    emitter.close = () => {
      if (closed) return;
      closed = true;
      const current = watchers.get(path) || [];
      const remaining = current.filter((item) => item !== emitter);
      if (remaining.length) watchers.set(path, remaining);
      else watchers.delete(path);
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    };
    emitter[Symbol.asyncIterator] = () => ({
      next: () => closed
        ? Promise.resolve({ value: undefined, done: true })
        : queue.length
          ? Promise.resolve({ value: queue.shift(), done: false })
          : new Promise((resolveNext) => waiters.push(resolveNext)),
      return: async () => { emitter.close(); return { value: undefined, done: true }; },
    });
    list.push(emitter);
    watchers.set(path, list);
    return emitter;
  }

  function declareMount(config = {}) {
    const path = normalizePath(config.path ?? config.mount ?? '/node', '/');
    if (config.path !== undefined && !sourcePath(config.path).startsWith('/')) throw invalidPath('mount path must be absolute');
    const mount = { path, mode: modeFor(config), artifacts: new Set() };
    mounts.set(path, mount);
    let parent = parentOf(path);
    while (!directories.has(parent)) {
      directories.add(parent);
      parent = parentOf(parent);
    }
    directories.add(path);
    const declaredArtifacts = config.artifacts ?? config.declaredArtifacts ?? [];
    const artifacts = Array.isArray(declaredArtifacts) ? declaredArtifacts : [declaredArtifacts];
    for (const artifact of artifacts) {
      const artifactPath = normalizePath(artifact, path);
      if (!isWithin(artifactPath, path)) throw invalidPath('artifact is outside its mount');
      mount.artifacts.add(artifactPath);
    }
    return mount;
  }

  function seedEntry(root, entry, value) {
    const entryValue = value && typeof value === 'object' && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)
      ? value
      : { data: value };
    const entryPath = typeof entry === 'string' ? entry : String(entry);
    const path = resolve(entryPath.startsWith('/') ? entryPath : `${root}/${entryPath}`);
    if (!isWithin(path, root)) throw denied(path, 'mount');
    const type = entryValue.type ?? (entryValue.directory ? 'directory' : 'file');
    if (type === 'directory') {
      let current = root;
      for (const part of path.slice(root.length).split('/').filter(Boolean)) {
        current = `${current}/${part}`;
        if (files.has(current)) throw notDirectory(current, 'mount');
        directories.add(current);
      }
      return;
    }
    if (directories.has(path)) throw isDirectory(path, 'mount');
    let parent = parentOf(path);
    if (!directories.has(parent)) {
      const parts = parent.slice(root.length).split('/').filter(Boolean);
      parent = root;
      for (const part of parts) {
        parent = `${parent}/${part}`;
        if (files.has(parent)) throw notDirectory(parent, 'mount');
        directories.add(parent);
      }
    }
    if (files.has(path) && directories.has(path)) throw invalidPath();
    files.set(path, decode(entryValue.data ?? entryValue.bytes ?? entryValue.content ?? entryValue, undefined, true));
  }

  function seedTree(root, tree) {
    const entries = tree instanceof Map ? tree : Object.entries(tree || {});
    for (const [entry, value] of entries) seedEntry(root, entry, value);
  }

  function mount(tree, config = {}, thirdConfig) {
    let fixtureTree = tree;
    let mountConfig = config;
    if (typeof tree === 'string') {
      fixtureTree = config;
      mountConfig = { ...(thirdConfig || {}), path: tree };
    }
    if (tree && !Array.isArray(tree) && typeof tree === 'object' && ('files' in tree || 'tree' in tree || 'fixtures' in tree)) {
      mountConfig = tree;
      fixtureTree = tree.files ?? tree.tree ?? tree.fixtures ?? {};
    }
    const mountRecord = declareMount(mountConfig);
    seedTree(mountRecord.path, fixtureTree);
    return { path: mountRecord.path, mode: mountRecord.mode };
  }

  function configureMounts(declarations) {
    if (!declarations) return;
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) mount(declaration.files ?? declaration.tree ?? declaration.fixtures ?? {}, declaration);
      return;
    }
    for (const [path, declaration] of Object.entries(declarations)) {
      if (declaration && typeof declaration === 'object' && ('files' in declaration || 'tree' in declaration || 'fixtures' in declaration || 'mode' in declaration || 'permissions' in declaration)) {
        mount(declaration.files ?? declaration.tree ?? declaration.fixtures ?? {}, { ...declaration, path });
      } else {
        mount(declaration, { path });
      }
    }
  }

  function configureFixtures(fixtures) {
    if (!fixtures) return;
    if (Array.isArray(fixtures)) {
      configureMounts(fixtures);
      return;
    }
    const values = Object.values(fixtures);
    const isMountMap = values.some((declaration) => declaration && typeof declaration === 'object'
      && ('files' in declaration || 'tree' in declaration || 'fixtures' in declaration
        || 'mode' in declaration || 'permissions' in declaration));
    if (isMountMap) configureMounts(fixtures);
    else mount(fixtures, { path: '/node' });
  }

  function enqueueMutation(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  }

  async function waitForMutations() {
    await mutationQueue;
  }

  function artifactPaths() {
    const declared = [...mounts.values()].flatMap((mountRecord) => [...mountRecord.artifacts]);
    return (declared.length ? declared : [...files.keys()]).sort(lexicalCompare);
  }

  function snapshot() {
    const artifactList = artifactPaths().filter((path) => files.has(path)).map((path) => ({
      path,
      bytes: new Uint8Array(files.get(path)),
      size: files.get(path).byteLength,
    }));
    return {
      version: 1,
      mounts: [...mounts.values()].map((mountRecord) => ({
        path: mountRecord.path,
        mode: mountRecord.mode,
        artifacts: [...mountRecord.artifacts].sort(lexicalCompare),
      })),
      artifacts: artifactList,
      files: Object.fromEntries(artifactList.map(({ path, bytes }) => [path, bytes])),
    };
  }

  function reset() {
    if (typeof backend.reset === 'function') backend.reset();
    else {
      files.clear();
      directories.clear();
      directories.add('/');
    }
    descriptors.clear();
    for (const mountRecord of mounts.values()) directories.add(mountRecord.path);
    for (const list of watchers.values()) for (const watcher of list) watcher.close();
    watchers.clear();
  }

  const fs = {
    writeFileSync: writeFile,
    readFileSync: readFile,
    appendFileSync: appendFile,
    accessSync(pathValue) { statPath(resolve(pathValue)); },
    copyFileSync: copyFile,
    cpSync: copyTree,
    realpathSync(pathValue) { const path = resolve(pathValue); statPath(path); return path; },
    truncateSync: truncate,
    readlinkSync(pathValue) { throw vfsError('EINVAL', resolve(pathValue), 'readlink', 'symbolic links are not supported'); },
    existsSync(pathValue) {
      try { statPath(resolve(pathValue)); return true; } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ERR_CAPABILITY_DENIED') return false;
        throw error;
      }
    },
    unlinkSync(pathValue) { removeFile(resolve(pathValue)); },
    rmSync(pathValue, optionsValue = {}) { removeTree(resolve(pathValue), optionsValue.recursive, optionsValue.force); },
    mkdirSync(pathValue, optionsValue = {}) { return makeDirectory(resolve(pathValue), optionsValue.recursive); },
    statSync(pathValue) { return statPath(resolve(pathValue)); },
    lstatSync(pathValue) { return statPath(resolve(pathValue)); },
    readdirSync(pathValue, optionsValue) {
      const path = resolve(pathValue);
      const recursive = optionsValue?.recursive === true;
      const result = recursive ? recursiveDirectoryEntries(path) : directoryEntries(path);
      if (optionsValue?.withFileTypes) return result;
      return result.map((item) => {
        if (!recursive || item.parentPath === path) return item.name;
        const relativeParent = item.parentPath.slice(path === '/' ? 1 : path.length + 1);
        return `${relativeParent}/${item.name}`;
      });
    },
    renameSync: rename,
    openSync(pathValue, flags = 'r') { return openDescriptor(pathValue, flags); },
    open(pathValue, flags, mode, callback) {
      if (typeof mode === 'function') callback = mode;
      try {
        const fd = openDescriptor(pathValue, flags);
        if (callback) callback(null, fd);
        return fd;
      } catch (error) {
        if (callback) callback(error);
        else throw error;
      }
    },
    closeSync(handle) { closeDescriptor(handle); },
    readSync(handle, buffer, offset, length, position) {
      return readDescriptor(handle, buffer, offset, length, position).bytesRead;
    },
    writeSync(handle, data, offset, length, position) {
      return writeDescriptor(handle, data, offset, length, position).bytesWritten;
    },
    read(handle, buffer, offset, length, position, callback) {
      try {
        const result = readDescriptor(handle, buffer, offset, length, position);
        callback?.(null, result.bytesRead, result.buffer);
      } catch (error) { callback?.(error); }
    },
    write(handle, data, offset, length, position, callback) {
      try {
        const result = writeDescriptor(handle, data, offset, length, position);
        callback?.(null, result.bytesWritten, result.buffer);
      } catch (error) { callback?.(error); }
    },
    fstatSync(handle) { return statPath(descriptor(handle).path); },
    fstat(handle, callback) {
      try { callback?.(null, fs.fstatSync(handle)); } catch (error) { callback?.(error); }
    },
    createReadStream,
    createWriteStream,
    readFile,
    writeFile,
    appendFile,
    access(pathValue) { statPath(resolve(pathValue)); },
    copyFile,
    cp: copyTree,
    realpath(pathValue) { const path = resolve(pathValue); statPath(path); return path; },
    truncate,
    readlink(pathValue) { throw vfsError('EINVAL', resolve(pathValue), 'readlink', 'symbolic links are not supported'); },
    watch,
  };

  const promises = {
    async writeFile(...args) { return enqueueMutation(() => writeFile(...args)); },
    async readFile(...args) { await waitForMutations(); return readFile(...args); },
    async appendFile(...args) { return enqueueMutation(() => appendFile(...args)); },
    async exists(...args) { await waitForMutations(); return fs.existsSync(...args); },
    async access(...args) { await waitForMutations(); return fs.accessSync(...args); },
    async copyFile(...args) { return enqueueMutation(() => copyFile(...args)); },
    async cp(...args) { return enqueueMutation(() => copyTree(...args)); },
    async realpath(...args) { await waitForMutations(); return fs.realpathSync(...args); },
    async truncate(...args) { return enqueueMutation(() => truncate(...args)); },
    async readlink(...args) { await waitForMutations(); return fs.readlinkSync(...args); },
    async rm(...args) { return enqueueMutation(() => fs.rmSync(...args)); },
    async unlink(...args) { return enqueueMutation(() => fs.unlinkSync(...args)); },
    async mkdir(...args) { return enqueueMutation(() => fs.mkdirSync(...args)); },
    async stat(...args) { await waitForMutations(); return fs.statSync(...args); },
    async lstat(...args) { await waitForMutations(); return fs.lstatSync(...args); },
    async readdir(...args) { await waitForMutations(); return fs.readdirSync(...args); },
    async rename(...args) { return enqueueMutation(() => fs.renameSync(...args)); },
    async open(pathValue, flags = 'r') {
      return enqueueMutation(() => fileHandle(openDescriptor(pathValue, flags)));
    },
    async opendir(pathValue) {
      await waitForMutations();
      const items = directoryEntries(resolve(pathValue));
      let index = 0;
      let closed = false;
      const assertOpen = () => { if (closed) throw closedHandle(); };
      return {
        async read() { assertOpen(); return items[index++] || null; },
        async close() { closed = true; },
        async *[Symbol.asyncIterator]() { while (!closed && index < items.length) yield items[index++]; },
      };
    },
  };

  configureMounts(options.mounts);
  configureFixtures(options.fixtures);

  const fileIndex = Object.freeze({
    has(pathValue) {
      try { return files.has(resolve(pathValue)); } catch { return false; }
    },
  });

  return {
    setTaskTracker(tracker) {
      taskTracker = typeof tracker === 'function' ? tracker : null;
    },
    mount,
    seed: mount,
    reset,
    snapshot,
    exportArtifacts: snapshot,
    declareArtifact(pathValue) {
      const path = resolve(pathValue);
      const mountRecord = access(path, 'declareArtifact');
      mountRecord.artifacts.add(path);
    },
    files: fileIndex,
    fs: { ...fs, promises },
    path: resolve,
    read(pathValue) {
      const path = resolve(pathValue);
      // This raw read is the module-loader seam. fs.readFile* remains a byte
      // operation so callers can inspect or export an addon fixture safely.
      if (path.endsWith('.node') && files.has(path)) unsupportedNativeAddon(path);
      return readBytes(path);
    },
    readFile,
    writeFile,
    appendFile,
    stat(pathValue) { return statPath(resolve(pathValue)); },
    readdir(pathValue) { return directoryEntries(resolve(pathValue)).map((item) => item.name); },
    entries(pathValue) { return directoryEntries(resolve(pathValue)); },
    mkdir(pathValue, optionsValue) { return makeDirectory(resolve(pathValue), optionsValue?.recursive); },
    rename,
    unlink(pathValue) { return removeFile(resolve(pathValue)); },
  };
}

export function pathToFileURL(path) {
  const normalized = normalizePath(String(path), '/');
  const url = new URL('file:///');
  url.pathname = normalized;
  return url;
}

export function fileURLToPath(value) {
  const url = isFileUrl(value) ? value : new URL(value);
  if (url.protocol !== 'file:' || url.hostname) throw invalidPath('file URL host is not supported');
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    throw invalidPath('file URL contains malformed escaping');
  }
}
