import { EventEmitter } from './events.js';
import { Readable, Writable } from './streams.js';
import { resolveEncodingOps } from './buffer.js';
import { unsupportedNativeAddon } from './errors.js';
import { AsyncResource } from './async-hooks.js';
import { createGlob } from './fs-glob.js';

const textEncoder = new TextEncoder();
const READ_FILE_ASYNC_STAGES = 4;
const S_IFMT = 0o170000;
const S_IFIFO = 0o010000;
const S_IFCHR = 0o020000;
const S_IFDIR = 0o040000;
const S_IFBLK = 0o060000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;

function vfsError(code, path, operation, message = code) {
  const error = new Error(`${code}: ${message}${path ? `, ${operation} '${path}'` : ''}`);
  error.code = code;
  if (path) error.path = path;
  if (operation) error.syscall = operation;
  const errno = {
    EEXIST: -17,
    EBADF: -9,
    EISDIR: -21,
    ELOOP: -40,
    ENOENT: -2,
    ENOTDIR: -20,
    ENOTEMPTY: -39,
  }[code];
  if (errno !== undefined) error.errno = errno;
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

function loop(path, operation = 'realpath') {
  return vfsError('ELOOP', path, operation, 'too many levels of symbolic links');
}

function invalidCopy(path, message) {
  return vfsError('EINVAL', path, 'cp', message);
}

function closedHandle() {
  return vfsError('EBADF', undefined, undefined, 'file handle is closed');
}

function outOfRange(name, value, minimum, maximum) {
  const error = new RangeError(
    minimum === undefined
      ? `The value of "${name}" is out of range. It must be an integer. Received ${String(value)}`
      : `The value of "${name}" is out of range. It must be >= ${minimum} && <= ${maximum}. Received ${String(value)}`,
  );
  error.code = 'ERR_OUT_OF_RANGE';
  return error;
}

function receivedArgumentValue(value) {
  if (value === null || value === undefined) return `Received ${value}`;
  if (typeof value === 'function') return `Received function ${value.name || ''}`.trimEnd();
  if (typeof value === 'object') return `Received an instance of ${value.constructor?.name || 'Object'}`;
  if (typeof value === 'string') {
    const inspected = `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
    return `Received type string (${inspected})`;
  }
  return `Received type ${typeof value} (${String(value)})`;
}

function invalidArgumentType(name, value, expected) {
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. ${receivedArgumentValue(value)}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidArgumentValue(name, value, message = 'invalid value') {
  const error = new TypeError(`The "${name}" argument is invalid. ${message}. ${receivedArgumentValue(value)}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function validatePathArgument(value, name = 'path') {
  if (typeof value === 'string' || value instanceof Uint8Array || isFileUrl(value)) return;
  throw invalidArgumentType(name, value, 'string or an instance of Buffer or URL');
}

function validateCallback(callback) {
  if (typeof callback !== 'function') throw invalidArgumentType('callback', callback, 'function');
}

function methodNotImplemented(name) {
  const error = new Error(`The ${name} method is not implemented`);
  error.code = 'ERR_METHOD_NOT_IMPLEMENTED';
  return error;
}

function timestampValue(value, name = 'time') {
  const original = value;
  if (value instanceof Date) value = value.getTime() / 1000;
  else if (typeof value === 'string') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidArgumentType(name, original, 'an instance of Date or a number in seconds');
  }
  return value * 1000;
}

function watchOptions(optionsValue, allowBuffer = true) {
  if (optionsValue === undefined) return {};
  if (optionsValue === null || typeof optionsValue !== 'object' || Array.isArray(optionsValue)) {
    throw invalidArgumentType('options', optionsValue, 'Object');
  }
  const options = { ...optionsValue };
  for (const name of ['persistent', 'recursive']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') {
      throw invalidArgumentType(`options.${name}`, options[name], 'boolean');
    }
  }
  if (options.encoding !== undefined && options.encoding !== null
    && (typeof options.encoding !== 'string' || !resolveEncodingOps(options.encoding))) {
    if (!(allowBuffer && options.encoding === 'buffer')) {
      throw invalidArgumentValue('options.encoding', options.encoding, 'must be a valid encoding');
    }
  }
  if (options.signal !== undefined
    && (!options.signal || typeof options.signal.addEventListener !== 'function')) {
    throw invalidArgumentType('options.signal', options.signal, 'an AbortSignal');
  }
  if (options.maxQueue !== undefined
    && (!Number.isInteger(options.maxQueue) || options.maxQueue < 1)) {
    throw invalidArgumentType('options.maxQueue', options.maxQueue, 'number');
  }
  if (options.overflow !== undefined && !['ignore', 'error'].includes(options.overflow)) {
    throw invalidArgumentValue('options.overflow', options.overflow, 'must be one of "ignore" or "error"');
  }
  return options;
}

function abortError(reason) {
  if (reason instanceof Error && reason.name === 'AbortError' && reason.code === 'ABORT_ERR') return reason;
  const error = new Error(reason instanceof Error ? reason.message : 'The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (reason !== undefined) error.cause = reason;
  return error;
}

function watchFilename(filename, encoding) {
  if (encoding === 'buffer') return nodeBuffer(textEncoder.encode(filename));
  if (encoding === undefined || encoding === null || encoding === 'utf8') return filename;
  return resolveEncodingOps(encoding).decode(textEncoder.encode(filename));
}

function directoryClosedError() {
  const error = new Error('Directory handle was closed');
  error.code = 'ERR_DIR_CLOSED';
  return error;
}

function directoryConcurrentError() {
  const error = new Error('Directory cannot be read while another read operation is in progress');
  error.code = 'ERR_DIR_CONCURRENT_OPERATION';
  return error;
}

function missingDirectoryArgument(name) {
  const error = new TypeError(`The "${name}" argument must be specified`);
  error.code = 'ERR_MISSING_ARGS';
  return error;
}

function invalidDirectoryThis() {
  const error = new TypeError('Method called on incompatible receiver');
  error.code = 'ERR_INVALID_THIS';
  return error;
}

function directoryOptions(optionsValue) {
  if (optionsValue === undefined || optionsValue === null) return {};
  if (typeof optionsValue === 'string') return { encoding: optionsValue };
  if (typeof optionsValue !== 'object' || Array.isArray(optionsValue)) {
    throw invalidArgumentType('options', optionsValue, 'string or an instance of Object');
  }
  return optionsValue;
}

function directoryPathJoin(parent, name) {
  if (parent === '.') return name;
  if (parent.endsWith('/')) return `${parent}${name}`;
  return `${parent}/${name}`;
}

function validateDirectoryOptions(options) {
  const bufferSize = options.bufferSize;
  if (typeof bufferSize !== 'number') throw invalidArgumentType('options.bufferSize', bufferSize, 'number');
  if (!Number.isInteger(bufferSize) || bufferSize < 1 || bufferSize > 0xffffffff) {
    const error = outOfRange('options.bufferSize', bufferSize);
    error.message = `The value of "options.bufferSize" is out of range. It must be >= 1 and <= 4294967295. Received ${String(bufferSize)}`;
    throw error;
  }
  if (options.encoding !== undefined && options.encoding !== null
    && options.encoding !== 'buffer' && !resolveEncodingOps(options.encoding)) {
    throw invalidArgumentValue('options.encoding', options.encoding, 'must be a valid encoding');
  }
}

function truncateLength(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'number') throw invalidArgumentType('len', value, 'number');
  if (!Number.isInteger(value)) throw outOfRange('len', value);
  return Math.max(0, value);
}

function modeValue(value) {
  if (typeof value === 'string') {
    if (!/^[0-7]+$/.test(value)) {
      throw invalidArgumentValue('mode', value, 'must be a valid octal string');
    }
    value = Number.parseInt(value, 8);
  } else if (typeof value !== 'number') {
    throw invalidArgumentType('mode', value, 'number or string');
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw outOfRange('mode', value, 0, 0xffffffff);
  return value & 0o777;
}

function ownerId(value, name) {
  if (typeof value !== 'number') throw invalidArgumentType(name, value, 'number');
  if (!Number.isInteger(value) || value < -1 || value > 0xffffffff) throw outOfRange(name, value, -1, 0xffffffff);
  return value;
}

function unixTimestamp(value, name = 'time') {
  let timestamp;
  if (value instanceof globalThis.Date) timestamp = value.getTime() / 1000;
  else if (typeof value === 'number' || typeof value === 'string') timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    throw invalidArgumentType(name, value, 'an instance of Date or an Time in seconds');
  }
  return timestamp;
}

function truncateDescriptor(value) {
  if (typeof value !== 'number') throw invalidArgumentType('fd', value, 'number');
  return value;
}

function decode(value, encoding) {
  if (Array.isArray(value)) return Uint8Array.from(value);
  // Worker descriptors already arrive as isolated Uint8Arrays. Re-copying
  // the complete mounted Node tree here doubles the browser memory required
  // by every virtual child before its entry module can start.
  if (value instanceof Uint8Array) return value;
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
    if (value.protocol !== 'file:' || (value.hostname && value.hostname !== 'localhost')) {
      throw invalidPath('file URL host is not supported');
    }
    try {
      return decodeURIComponent(value.pathname);
    } catch {
      throw invalidPath('file URL contains malformed escaping');
    }
  }
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (typeof value !== 'string') {
    throw invalidArgumentType('path', value, 'string or an instance of Buffer or URL');
  }
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
  const symlinks = new Map();
  return {
    files,
    directories,
    symlinks,
    reset() {
      files.clear();
      directories.clear();
      symlinks.clear();
      directories.add('/');
    },
  };
}

export function createMemoryVfsBackend() {
  return createMemoryBackend();
}

class Stats {
  constructor(kind, size, attributes = {}) {
    this.size = size;
    const defaultPermissions = kind === 'file' ? 0o666 : kind === 'directory' ? 0o777 : 0o777;
    const typeBits = kind === 'file' ? 0o100000 : kind === 'directory' ? 0o40000 : 0o120000;
    this.mode = typeBits | (attributes.mode ?? defaultPermissions);
    this.dev = 0;
    this.ino = 0;
    this.nlink = attributes.nlink ?? 1;
    this.uid = attributes.uid ?? 0;
    this.gid = attributes.gid ?? 0;
    this.rdev = 0;
    this.blksize = 4096;
    this.blocks = Math.ceil(size / 512);
    this.atimeMs = attributes.atimeMs ?? Date.now();
    this.mtimeMs = attributes.mtimeMs ?? this.atimeMs;
    this.ctimeMs = attributes.ctimeMs ?? this.mtimeMs;
    this.birthtimeMs = attributes.birthtimeMs ?? this.ctimeMs;
    this._kind = kind;
  }

  _checkModeProperty(property) {
    return (this.mode & S_IFMT) === property;
  }
  isFile() { return this._checkModeProperty(S_IFREG); }
  isDirectory() { return this._checkModeProperty(S_IFDIR); }
  isSymbolicLink() { return this._checkModeProperty(S_IFLNK); }
  isBlockDevice() { return this._checkModeProperty(S_IFBLK); }
  isCharacterDevice() { return this._checkModeProperty(S_IFCHR); }
  isFIFO() { return this._checkModeProperty(S_IFIFO); }
  isSocket() { return this._checkModeProperty(S_IFSOCK); }
  get atime() { return new globalThis.Date(this.atimeMs); }
  get mtime() { return new globalThis.Date(this.mtimeMs); }
  get ctime() { return new globalThis.Date(this.ctimeMs); }
  get birthtime() { return new globalThis.Date(this.birthtimeMs); }
}

class Dirent {
  constructor(name, kind, parentPath = '') {
    this.name = name;
    this._kind = kind;
    this.path = parentPath;
    this.parentPath = parentPath;
  }

  isFile() { return this._kind === 'file'; }
  isDirectory() { return this._kind === 'directory'; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isSymbolicLink() { return this._kind === 'symlink'; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

class Dir {
  #handle;
  #path;
  #options;
  #bufferedEntries = [];
  #closed = false;
  #operationQueue = null;
  #handlerQueue = [];

  constructor(handle, path, options) {
    if (handle === undefined || handle === null) throw missingDirectoryArgument('handle');
    this.#handle = handle;
    this.#path = path;
    const normalizedOptions = directoryOptions(options);
    this.#options = { bufferSize: 32, encoding: 'utf8', ...normalizedOptions };
    try {
      validateDirectoryOptions(this.#options);
    } catch (error) {
      handle.close?.();
      throw error;
    }
  }

  get path() {
    if (!(#path in this)) throw invalidDirectoryThis();
    return this.#path;
  }

  #assertOpen() {
    if (this.#closed) throw directoryClosedError();
  }

  #processHandlerQueue() {
    while (this.#handlerQueue.length > 0) {
      const handler = this.#handlerQueue.shift();
      const result = handler.handle.read(this.#options.encoding, this.#options.bufferSize);
      if (result !== null) {
        this.processReadResult(handler.path, result);
        if (result.length > 0) this.#handlerQueue.push(handler);
      } else {
        handler.handle.close?.();
      }
      if (this.#bufferedEntries.length > 0) return true;
    }
    return this.#bufferedEntries.length > 0;
  }

  #readImpl(maybeSync, callback) {
    this.#assertOpen();
    if (callback === undefined) {
      return new Promise((resolve, reject) => {
        this.#readImpl(false, (error, entry) => error ? reject(error) : resolve(entry));
      });
    }
    if (typeof callback !== 'function') throw invalidArgumentType('callback', callback, 'function');
    if (this.#operationQueue !== null) {
      this.#operationQueue.push(() => this.#readImpl(maybeSync, callback));
      return;
    }
    if (this.#processHandlerQueue()) {
      try {
        const entry = this.#bufferedEntries.shift();
        if (maybeSync) queueMicrotask(() => callback(null, entry));
        else callback(null, entry);
      } catch (error) {
        callback(error);
      }
      return;
    }

    const request = {
      oncomplete: (error, result) => {
        queueMicrotask(() => {
          const queue = this.#operationQueue;
          this.#operationQueue = null;
          for (const operation of queue || []) operation();
        });
        if (error || result === null) {
          callback(error, result);
          return;
        }
        try {
          this.processReadResult(this.#path, result);
          callback(null, this.#bufferedEntries.shift() || null);
        } catch (readError) {
          callback(readError);
        }
      },
    };
    this.#operationQueue = [];
    try {
      this.#handle.read(this.#options.encoding, this.#options.bufferSize, request);
    } catch (error) {
      this.#operationQueue = null;
      callback(error);
    }
  }

  read(callback) {
    if (arguments.length === 0 || callback === undefined) return this.#readImpl(false);
    return this.#readImpl(true, callback);
  }

  processReadResult(path, result) {
    for (let index = 0; index < result.length; index += 2) {
      this.#bufferedEntries.push(new Dirent(result[index], result[index + 1], path));
    }
  }

  readSyncRecursive(dirent) {
    const path = directoryPathJoin(dirent.parentPath, String(dirent.name));
    const handle = this.#handle.openRecursive?.(path, this.#options.encoding);
    if (handle !== undefined) this.#handlerQueue.push({ handle, path });
  }

  readSync() {
    this.#assertOpen();
    if (this.#operationQueue !== null) throw directoryConcurrentError();
    if (this.#processHandlerQueue()) {
      const entry = this.#bufferedEntries.shift();
      if (entry?.isDirectory() && this.#options.recursive) this.readSyncRecursive(entry);
      return entry;
    }
    const result = this.#handle.read(this.#options.encoding, this.#options.bufferSize);
    if (result === null) return null;
    this.processReadResult(this.#path, result);
    const entry = this.#bufferedEntries.shift() || null;
    if (entry?.isDirectory() && this.#options.recursive) this.readSyncRecursive(entry);
    return entry;
  }

  close(callback) {
    if (callback === undefined) {
      if (this.#closed) return Promise.reject(directoryClosedError());
      return new Promise((resolve, reject) => {
        this.close((error) => error ? reject(error) : resolve());
      });
    }
    if (typeof callback !== 'function') throw invalidArgumentType('callback', callback, 'function');
    if (this.#closed) {
      queueMicrotask(() => callback(directoryClosedError()));
      return;
    }
    if (this.#operationQueue !== null) {
      this.#operationQueue.push(() => this.close(callback));
      return;
    }
    for (const handler of this.#handlerQueue) handler.handle.close?.();
    this.#handlerQueue = [];
    this.#closed = true;
    const request = { oncomplete: callback };
    try {
      this.#handle.close?.(request);
    } catch (error) {
      callback(error);
    }
  }

  closeSync() {
    this.#assertOpen();
    if (this.#operationQueue !== null) throw directoryConcurrentError();
    for (const handler of this.#handlerQueue) handler.handle.closeSync?.();
    this.#handlerQueue = [];
    this.#closed = true;
    this.#handle.closeSync?.();
  }

  async *entries() {
    try {
      while (true) {
        const entry = await this.read();
        if (entry === null) return;
        yield entry;
      }
    } finally {
      if (!this.#closed) await this.close();
    }
  }
}

Object.defineProperty(Dir.prototype, Symbol.asyncIterator, {
  configurable: true,
  value: Dir.prototype.entries,
  writable: true,
});

export function createVfs(options = {}) {
  const suppliedBackend = typeof options.backend === 'function' ? options.backend() : options.backend;
  const backend = suppliedBackend || createMemoryBackend();
  const files = backend.files instanceof Map ? backend.files : new Map();
  const directories = backend.directories instanceof Set ? backend.directories : new Set(['/']);
  const symlinks = backend.symlinks instanceof Map ? backend.symlinks : new Map();
  const metadata = new Map();
  let taskTracker = typeof options.trackTask === 'function' ? options.trackTask : null;
  let activeRequestTracker = null;
  if (!directories.has('/')) directories.add('/');
  const mounts = new Map();
  const watchers = new Map();
  const descriptors = new Map();
  const hardLinks = new Map();
  const fileHandleRecords = new Set();
  let nextDescriptor = 100;
  let nextTemporaryDirectory = 0;
  let mutationQueue = Promise.resolve();
  let warningEmitter = null;
  let nonPortableTemplateWarningEmitted = false;
  let recursiveRmdirWarningEmitted = false;
  let truncateDescriptorWarningEmitted = false;

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

  function symlinkTarget(linkPath, targetValue) {
    const target = sourcePath(targetValue);
    const absolute = target.startsWith('/') ? target : `${parentOf(linkPath)}/${target}`;
    return normalizePath(absolute, '/');
  }

  function resolvePath(path, followFinal = true, operation = 'access') {
    let current = path;
    const visited = new Set();
    for (let depth = 0; depth <= 40; depth += 1) {
      const parts = current.split('/').filter(Boolean);
      let prefix = '/';
      let replaced = false;
      for (let index = 0; index < parts.length; index += 1) {
        prefix = prefix === '/' ? `/${parts[index]}` : `${prefix}/${parts[index]}`;
        const final = index === parts.length - 1;
        if (!symlinks.has(prefix) || (!followFinal && final)) continue;
        if (visited.has(prefix)) throw loop(prefix);
        visited.add(prefix);
        const target = symlinkTarget(prefix, symlinks.get(prefix));
        const remainder = parts.slice(index + 1).join('/');
        current = remainder ? normalizePath(`${target}/${remainder}`, '/') : target;
        replaced = true;
        break;
      }
      if (!replaced) {
        for (let index = 1; index < parts.length; index += 1) {
          const prefix = `/${parts.slice(0, index).join('/')}`;
          if (files.has(prefix)) throw notDirectory(prefix, operation);
        }
        return current;
      }
    }
    throw loop(path);
  }

  function nodeExists(path) {
    return files.has(path) || directories.has(path) || symlinks.has(path);
  }

  function metadataFor(path) {
    let attributes = metadata.get(path);
    if (!attributes) {
      const now = Date.now();
      attributes = { atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now, nlink: 1 };
      metadata.set(path, attributes);
    }
    return attributes;
  }

  function removeMetadata(path) {
    const attributes = metadata.get(path);
    if (!attributes) return;
    if (attributes.nlink > 1) attributes.nlink -= 1;
    else metadata.delete(path);
  }

  function setFileBytes(path, bytes) {
    const attributes = metadataFor(path);
    if (files.has(path)) {
      attributes.mtimeMs = Date.now();
      attributes.ctimeMs = attributes.mtimeMs;
    }
    const group = hardLinks.get(path);
    if (!group) {
      files.set(path, bytes);
      return;
    }
    group.bytes = bytes;
    for (const linkPath of group.paths) files.set(linkPath, bytes);
  }

  function removeFileBytes(path) {
    const group = hardLinks.get(path);
    if (!group) {
      files.delete(path);
      return;
    }
    group.paths.delete(path);
    hardLinks.delete(path);
    files.delete(path);
    if (group.paths.size < 2) {
      for (const linkPath of group.paths) hardLinks.delete(linkPath);
    }
  }

  function addHardLink(source, destination) {
    const group = hardLinks.get(source) || { paths: new Set([source]), bytes: files.get(source) };
    group.paths.add(destination);
    hardLinks.set(source, group);
    hardLinks.set(destination, group);
    files.set(destination, group.bytes);
  }

  function moveFileNode(source, destination) {
    const group = hardLinks.get(source);
    if (!group) {
      files.set(destination, files.get(source));
      files.delete(source);
      return;
    }
    group.paths.delete(source);
    group.paths.add(destination);
    hardLinks.delete(source);
    hardLinks.set(destination, group);
    files.set(destination, group.bytes);
    files.delete(source);
  }

  function notify(path, eventType) {
    const parent = parentOf(path);
    for (const [watchPath, list] of watchers) {
      for (const watcher of [...list]) {
        if (!watcher._recursive && parent !== watchPath && path !== watchPath) continue;
        watcher._notify(eventType, path.split('/').at(-1));
      }
    }
  }

  function ensureParent(path, operation) {
    const parent = resolvePath(parentOf(path));
    access(parent, operation);
    if (files.has(parent)) throw notDirectory(parent, operation);
    if (!directories.has(parent)) throw missing(parent, operation);
  }

  function addDirectory(path, operation = 'mkdir') {
    path = resolvePath(path);
    access(path, operation, true);
    if (files.has(path) || symlinks.has(path)) throw notDirectory(path, operation);
    if (directories.has(path)) return false;
    ensureParent(path, operation);
    directories.add(path);
    metadataFor(path);
    notify(path, 'rename');
    return true;
  }

  function makeDirectory(path, recursive, operation = 'mkdir') {
    path = resolvePath(path);
    access(path, operation, true);
    if (files.has(path) || symlinks.has(path)) throw existsError(path, operation);
    if (directories.has(path)) {
      if (!recursive) throw existsError(path, operation);
      return undefined;
    }
    const parent = parentOf(path);
    access(parent, operation, true);
    if (files.has(parent)) throw notDirectory(parent, operation);
    if (!directories.has(parent)) {
      if (!recursive) throw missing(parent, operation);
      const createdParent = makeDirectory(parent, true, operation);
      directories.add(path);
      metadataFor(path);
      notify(path, 'rename');
      return createdParent || path;
    }
    directories.add(path);
    metadataFor(path);
    notify(path, 'rename');
    return recursive ? path : undefined;
  }

  function makeTemporaryDirectory(prefixValue, optionsValue) {
    const source = sourcePath(prefixValue);
    if (!source) throw invalidPath('mkdtemp prefix must not be empty');
    if (!nonPortableTemplateWarningEmitted && source.endsWith('X')) {
      nonPortableTemplateWarningEmitted = true;
      warningEmitter?.(
        'mkdtemp() templates ending with X are not portable. ' +
        'For details see: https://nodejs.org/api/fs.html',
      );
    }
    const hasTrailingSlash = source.endsWith('/');
    const prefix = normalizePath(source);
    const parent = hasTrailingSlash ? prefix : parentOf(prefix);
    access(parent, 'mkdtemp', true);
    if (!directories.has(parent)) throw missing(parent, 'mkdtemp');
    let path;
    do {
      const suffix = String(nextTemporaryDirectory++).padStart(6, '0');
      path = hasTrailingSlash ? `${prefix}/${suffix}` : `${prefix}${suffix}`;
    } while (nodeExists(path));
    makeDirectory(path, false, 'mkdtemp');
    const encoding = encodingOption(optionsValue);
    return encoding === 'buffer' ? nodeBuffer(textEncoder.encode(path)) : path;
  }

  function warnRecursiveRmdir() {
    if (recursiveRmdirWarningEmitted) return;
    recursiveRmdirWarningEmitted = true;
    warningEmitter?.(
      'In future versions of Node.js, fs.rmdir(path, { recursive: true }) ' +
      'will be removed. Use fs.rm(path, { recursive: true }) instead',
      { code: 'DEP0147', type: 'DeprecationWarning' },
    );
  }

  function setFile(path, value, append = false, operation = 'write', encoding) {
    path = resolvePath(path);
    const mount = access(path, operation, true);
    ensureParent(path, operation);
    if (directories.has(path) || symlinks.has(path)) throw isDirectory(path, operation);
    const previous = files.get(path);
    const bytes = decode(value, encoding);
    setFileBytes(path, append && previous ? new Uint8Array([...previous, ...bytes]) : bytes);
    metadataFor(path);
    notify(path, previous ? 'change' : 'rename');
    return mount;
  }

  function readBytes(path, operation = 'open') {
    path = resolvePath(path);
    access(path, operation);
    if (directories.has(path)) throw isDirectory(path, operation);
    const value = files.get(path);
    if (value === undefined) throw missing(path, operation);
    return new Uint8Array(value);
  }

  function removeFile(path, operation = 'unlink') {
    path = resolvePath(path, false);
    access(path, operation, true);
    if (directories.has(path)) throw isDirectory(path, operation);
    if (!files.has(path) && !symlinks.has(path)) throw missing(path, operation);
    removeFileBytes(path);
    symlinks.delete(path);
    removeMetadata(path);
    notify(path, 'rename');
  }

  function removeDirectory(path, recursive = false) {
    path = resolvePath(path, false);
    access(path, 'rmdir', true);
    if (files.has(path) || symlinks.has(path)) throw notDirectory(path, 'rmdir');
    if (!directories.has(path)) throw missing(path, 'rmdir');
    if (path === '/') throw denied(path, 'rmdir');
    const children = [...files.keys(), ...directories, ...symlinks.keys()]
      .filter((item) => item !== path && isWithin(item, path));
    if (children.length) {
      if (!recursive) throw notEmpty(path);
      for (const child of children) {
        if (files.has(child)) removeFileBytes(child);
        directories.delete(child);
        symlinks.delete(child);
        removeMetadata(child);
      }
    }
    directories.delete(path);
    notify(path, 'rename');
  }

  function removeTree(path, recursive = false, force = false) {
    path = resolvePath(path, false);
    access(path, 'rm', true);
    if (files.has(path) || symlinks.has(path)) {
      removeFileBytes(path);
      symlinks.delete(path);
      removeMetadata(path);
      notify(path, 'rename');
      return;
    }
    if (!directories.has(path)) {
      if (!force) throw missing(path, 'rm');
      return;
    }
    if (path === '/') throw denied(path, 'rm');
    const children = [...files.keys(), ...directories, ...symlinks.keys()]
      .filter((item) => item !== path && isWithin(item, path));
    if (children.length && !recursive) throw notEmpty(path);
    for (const child of children) {
      if (files.has(child)) removeFileBytes(child);
      directories.delete(child);
      symlinks.delete(child);
      removeMetadata(child);
    }
    directories.delete(path);
    notify(path, 'rename');
  }

  function directoryEntries(path) {
    path = resolvePath(path);
    access(path, 'scandir');
    if (files.has(path) || symlinks.has(path)) throw notDirectory(path, 'scandir');
    if (!directories.has(path)) throw missing(path, 'scandir');
    const names = new Map();
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const directory of directories) {
      if (directory.startsWith(prefix) && directory !== path) {
        const name = directory.slice(prefix.length).split('/')[0];
        names.set(name, 'directory');
      }
    }
    for (const file of files.keys()) {
      if (file.startsWith(prefix)) {
        const name = file.slice(prefix.length).split('/')[0];
        names.set(name, names.get(name) || 'file');
      }
    }
    for (const link of symlinks.keys()) {
      if (link.startsWith(prefix)) {
        const name = link.slice(prefix.length).split('/')[0];
        names.set(name, names.get(name) || 'symlink');
      }
    }
    return [...names].sort((left, right) => lexicalCompare(left[0], right[0]))
      .map(([name, kind]) => new Dirent(name, kind, path));
  }

  function recursiveDirectoryEntries(pathValue) {
    const root = resolvePath(pathValue);
    const result = [];
    const visit = (parent) => {
      for (const entry of directoryEntries(parent)) {
        result.push(entry);
        if (entry.isDirectory()) visit(normalizePath(`${parent}/${entry.name}`, '/'));
      }
    };
    visit(root);
    return result;
  }

  function directoryEntryName(rootValue, entry) {
    const root = resolvePath(rootValue);
    if (entry.path === root) return entry.name;
    return `${entry.path.slice(root.length + 1)}/${entry.name}`;
  }

  function entriesFor(pathValue, optionsValue = {}) {
    const entries = optionsValue?.recursive
      ? recursiveDirectoryEntries(pathValue)
      : directoryEntries(resolve(pathValue));
    if (optionsValue?.withFileTypes) return entries;
    return entries.map((entry) => directoryEntryName(pathValue, entry));
  }

  function createRawDirectoryHandle(pathValue) {
    const path = resolvePath(resolve(pathValue));
    const entries = directoryEntries(path);
    let index = 0;
    let closed = false;
    const assertOpen = () => { if (closed) throw closedHandle(); };
    const readResult = (encoding = 'utf8', bufferSize = 32) => {
      assertOpen();
      if (index >= entries.length) return null;
      const result = [];
      const count = Math.min(bufferSize, entries.length - index);
      for (let offset = 0; offset < count; offset += 1) {
        const entry = entries[index++];
        result.push(encoding === 'buffer' ? nodeBuffer(textEncoder.encode(entry.name)) : entry.name, entry._kind);
      }
      return result;
    };
    const completeRequest = (request, operation) => {
      const release = activeRequestTracker?.('FSReqCallback');
      scheduleFsCallback(() => {
        try {
          request.oncomplete(null, operation());
        } catch (error) {
          request.oncomplete(error);
        } finally {
          release?.();
        }
      });
    };
    return {
      read(encoding, bufferSize, request) {
        if (request && typeof request.oncomplete === 'function') {
          completeRequest(request, () => readResult(encoding, bufferSize));
          return;
        }
        return readResult(encoding, bufferSize);
      },
      close(request) {
        const closeNow = () => {
          assertOpen();
          closed = true;
        };
        if (request && typeof request.oncomplete === 'function') {
          completeRequest(request, () => { closeNow(); return undefined; });
          return;
        }
        closeNow();
      },
      closeSync() {
        assertOpen();
        closed = true;
      },
      openRecursive(childPath) {
        try {
          return createRawDirectoryHandle(childPath);
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
          throw error;
        }
      },
    };
  }

  function createDirectoryHandle(pathValue, optionsValue = {}) {
    const path = sourcePath(pathValue);
    const options = { recursive: false, ...directoryOptions(optionsValue) };
    return new Dir(createRawDirectoryHandle(path), path, options);
  }

  function statPath(path) {
    path = resolvePath(path);
    access(path, 'stat');
    if (files.has(path)) return new Stats('file', files.get(path).byteLength, metadataFor(path));
    if (directories.has(path)) return new Stats('directory', 0, metadataFor(path));
    throw missing(path, 'stat');
  }

  function statFsPath(pathValue, optionsValue) {
    const path = resolvePath(pathValue);
    access(path, 'statfs');
    if (!nodeExists(path)) throw missing(path, 'statfs');
    if (optionsValue !== undefined && (optionsValue === null || typeof optionsValue !== 'object')) {
      throw invalidArgumentType('options', optionsValue, 'Object');
    }
    const bigint = optionsValue?.bigint === true;
    const values = {
      type: 0,
      bsize: 4096,
      blocks: 1024 * 1024,
      bfree: 1024 * 1024,
      bavail: 1024 * 1024,
      files: files.size + directories.size + symlinks.size,
      ffree: 1024 * 1024,
    };
    if (!bigint) return values;
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, BigInt(value)]));
  }

  function lstatPath(path) {
    path = resolvePath(path, false);
    access(path, 'lstat');
    if (symlinks.has(path)) return new Stats('symlink', textEncoder.encode(symlinks.get(path)).byteLength, metadataFor(path));
    if (files.has(path)) return new Stats('file', files.get(path).byteLength, metadataFor(path));
    if (directories.has(path)) return new Stats('directory', 0, metadataFor(path));
    throw missing(path, 'lstat');
  }

  function updateMode(pathValue, mode, operation = 'chmod', followFinal = true) {
    const path = resolvePath(resolve(pathValue), followFinal, operation);
    access(path, operation, true);
    if (!nodeExists(path)) throw missing(path, operation);
    metadataFor(path).mode = modeValue(mode);
    notify(path, 'change');
  }

  function updateOwner(pathValue, uid, gid, operation = 'chown', followFinal = true) {
    const path = resolvePath(resolve(pathValue), followFinal, operation);
    access(path, operation, true);
    if (!nodeExists(path)) throw missing(path, operation);
    const current = metadataFor(path);
    current.uid = uid === -1 ? current.uid ?? 0 : uid;
    current.gid = gid === -1 ? current.gid ?? 0 : gid;
    notify(path, 'change');
  }

  function updateTimes(pathValue, atime, mtime, followFinal = true) {
    const path = resolvePath(resolve(pathValue), followFinal, followFinal ? 'utime' : 'lutime');
    const atimeMs = timestampValue(atime);
    const mtimeMs = timestampValue(mtime);
    access(path, followFinal ? 'utime' : 'lutime', true);
    if (!nodeExists(path)) throw missing(path, followFinal ? 'utime' : 'lutime');
    const current = metadata.get(path) || {};
    metadata.set(path, { ...current, atimeMs, mtimeMs });
    notify(path, 'change');
  }

  function updateDescriptorTimes(value, atime, mtime) {
    const record = syncDescriptor(value);
    updateTimes(record.path, atime, mtime);
  }

  function descriptorId(value) {
    if (typeof value !== 'number') throw invalidArgumentType('fd', value, 'number');
    if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
      throw outOfRange('fd', value, 0, 0x7fffffff);
    }
    return value;
  }

  function syncDescriptor(value) {
    return descriptor(descriptorId(value));
  }

  function updateDescriptorMode(value, mode) {
    const record = syncDescriptor(value);
    updateMode(record.path, mode, 'fchmod');
  }

  function updateDescriptorOwner(value, uid, gid) {
    const record = syncDescriptor(value);
    updateOwner(record.path, uid, gid, 'fchown');
  }

  function chmod(pathValue, mode, callback) {
    resolve(pathValue);
    const normalizedMode = modeValue(mode);
    asyncFsOperation(callback, () => updateMode(pathValue, normalizedMode));
  }

  function chown(pathValue, uid, gid, callback) {
    resolve(pathValue);
    const normalizedUid = ownerId(uid, 'uid');
    const normalizedGid = ownerId(gid, 'gid');
    asyncFsOperation(callback, () => updateOwner(pathValue, normalizedUid, normalizedGid));
  }

  function futimesSync(value, atime, mtime) {
    updateDescriptorTimes(value, atime, mtime);
  }

  function futimes(value, atime, mtime, callback) {
    validateCallback(callback);
    const normalizedAtime = timestampValue(atime);
    const normalizedMtime = timestampValue(mtime);
    syncDescriptor(value);
    asyncFsOperation(callback, () => updateDescriptorTimes(
      value,
      normalizedAtime,
      normalizedMtime,
    ));
  }

  function fchmod(value, mode, callback) {
    descriptorId(value);
    const normalizedMode = modeValue(mode);
    syncDescriptor(value);
    asyncFsOperation(callback, () => updateDescriptorMode(value, normalizedMode));
  }

  function fchown(value, uid, gid, callback) {
    descriptorId(value);
    const normalizedUid = ownerId(uid, 'uid');
    const normalizedGid = ownerId(gid, 'gid');
    syncDescriptor(value);
    asyncFsOperation(callback, () => updateDescriptorOwner(value, normalizedUid, normalizedGid));
  }

  function fdatasync(value, callback) {
    syncDescriptor(value);
    asyncFsOperation(callback, () => undefined);
  }

  function fsync(value, callback) {
    syncDescriptor(value);
    asyncFsOperation(callback, () => undefined);
  }

  function realpathPath(path) {
    const resolved = resolvePath(resolve(path));
    statPath(resolved);
    return resolved;
  }

  function readlinkValue(pathValue, optionsValue) {
    const path = resolvePath(resolve(pathValue), false);
    access(path, 'readlink');
    const target = symlinks.get(path);
    if (target === undefined) throw missing(path, 'readlink');
    const hasEncoding = typeof optionsValue === 'string' || optionsValue?.encoding !== undefined;
    const encoding = encodingOption(optionsValue);
    return hasEncoding && (encoding === 'buffer' || encoding === null)
      ? nodeBuffer(textEncoder.encode(target))
      : target;
  }

  function symlinkSync(targetValue, pathValue) {
    const path = resolve(pathValue);
    const target = sourcePath(targetValue);
    access(path, 'symlink', true);
    ensureParent(path, 'symlink');
    if (nodeExists(path)) throw existsError(path, 'symlink');
    symlinks.set(path, target);
    metadataFor(path);
    notify(path, 'rename');
  }

  function symlink(targetValue, pathValue, typeValue, callback) {
    const done = typeof typeValue === 'function' ? typeValue : callback;
    asyncFsOperation(done, () => symlinkSync(targetValue, pathValue));
  }

  function linkSync(existingPath, newPath) {
    const sourceValue = sourcePath(existingPath);
    const destinationValue = sourcePath(newPath);
    const source = sourceValue === '' ? null : resolvePath(resolve(sourceValue), false, 'link');
    const destination = destinationValue === '' ? null : resolvePath(resolve(destinationValue), false, 'link');
    if (source === null) throw missing('', 'link');
    if (destination === null) throw missing('', 'link');
    const sourceMount = access(source, 'link');
    const destinationMount = access(destination, 'link', true);
    if (sourceMount.path !== destinationMount.path) throw denied(destination, 'link');
    if (!nodeExists(source)) throw missing(source, 'link');
    ensureParent(destination, 'link');
    if (nodeExists(destination)) throw existsError(destination, 'link');
    if (directories.has(source)) throw vfsError('EPERM', source, 'link', 'operation not permitted');
    if (files.has(source)) {
      addHardLink(source, destination);
    } else {
      symlinks.set(destination, symlinks.get(source));
    }
    const attributes = metadataFor(source);
    attributes.nlink += 1;
    metadata.set(destination, attributes);
    notify(destination, 'rename');
  }

  function link(existingPath, newPath, callback) {
    if (typeof callback !== 'function') throw invalidArgumentType('cb', callback, 'function');
    const sourceValue = sourcePath(existingPath);
    const destinationValue = sourcePath(newPath);
    if (sourceValue !== '') resolve(sourceValue);
    if (destinationValue !== '') resolve(destinationValue);
    asyncFsOperation(callback, () => linkSync(existingPath, newPath));
  }

  function lchown(pathValue, uid, gid, callback) {
    if (typeof callback !== 'function') throw invalidArgumentType('cb', callback, 'function');
    resolve(pathValue);
    const normalizedUid = ownerId(uid, 'uid');
    const normalizedGid = ownerId(gid, 'gid');
    asyncFsOperation(callback, () => updateOwner(pathValue, normalizedUid, normalizedGid, 'lchown', false));
  }

  function lchownSync(pathValue, uid, gid) {
    resolve(pathValue);
    const normalizedUid = ownerId(uid, 'uid');
    const normalizedGid = ownerId(gid, 'gid');
    updateOwner(pathValue, normalizedUid, normalizedGid, 'lchown', false);
  }

  function lchmodSync(pathValue, mode) {
    resolve(pathValue);
    const normalizedMode = modeValue(mode);
    updateMode(pathValue, normalizedMode, 'lchmod', false);
  }

  function lchmod(pathValue, mode, callback) {
    if (typeof callback !== 'function') throw invalidArgumentType('cb', callback, 'function');
    resolve(pathValue);
    const normalizedMode = modeValue(mode);
    asyncFsOperation(callback, () => updateMode(pathValue, normalizedMode, 'lchmod', false));
  }

  function lutimes(pathValue, atime, mtime, callback) {
    if (typeof callback !== 'function') throw invalidArgumentType('cb', callback, 'function');
    resolve(pathValue);
    const normalizedAtime = timestampValue(atime);
    const normalizedMtime = timestampValue(mtime);
    asyncFsOperation(callback, () => updateTimes(pathValue, normalizedAtime, normalizedMtime, false));
  }

  function lutimesSync(pathValue, atime, mtime) {
    resolve(pathValue);
    const normalizedAtime = timestampValue(atime);
    const normalizedMtime = timestampValue(mtime);
    updateTimes(pathValue, normalizedAtime, normalizedMtime, false);
  }

  function utimes(pathValue, atime, mtime, callback) {
    if (typeof callback !== 'function') throw invalidArgumentType('cb', callback, 'function');
    resolve(pathValue);
    const normalizedAtime = timestampValue(atime);
    const normalizedMtime = timestampValue(mtime);
    asyncFsOperation(callback, () => updateTimes(pathValue, normalizedAtime, normalizedMtime, true));
  }

  function utimesSync(pathValue, atime, mtime) {
    resolve(pathValue);
    const normalizedAtime = timestampValue(atime);
    const normalizedMtime = timestampValue(mtime);
    updateTimes(pathValue, normalizedAtime, normalizedMtime, true);
  }

  function openAsBlob(pathValue, optionsValue = {}) {
    if (optionsValue === null || typeof optionsValue !== 'object' || Array.isArray(optionsValue)) {
      throw invalidArgumentType('options', optionsValue, 'object');
    }
    const type = optionsValue.type || '';
    if (typeof type !== 'string') throw invalidArgumentType('options.type', type, 'string');
    const path = resolve(pathValue);
    let bytes;
    try {
      bytes = readBytes(path);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') {
        const blobError = new TypeError('Unable to open file as blob');
        blobError.code = 'ERR_INVALID_ARG_VALUE';
        throw blobError;
      }
      throw error;
    }
    const stamp = metadataFor(path).mtimeMs;
    const readCurrent = () => {
      const current = readBytes(path);
      if (current.byteLength !== bytes.byteLength || metadataFor(path).mtimeMs !== stamp) {
        const error = typeof globalThis.DOMException === 'function'
          ? new globalThis.DOMException('The file has changed since the blob was opened', 'NotReadableError')
          : Object.assign(new Error('The file has changed since the blob was opened'), { name: 'NotReadableError' });
        throw error;
      }
      return current;
    };
    class FileBackedBlob extends globalThis.Blob {
      constructor(initialBytes, start, end, blobType) {
        super([initialBytes], { type: blobType });
        this._start = start;
        this._end = end;
      }

      _readBytes() {
        return readCurrent().slice(this._start, this._end);
      }

      arrayBuffer() {
        try { return Promise.resolve(this._readBytes().buffer); }
        catch (error) { return Promise.reject(error); }
      }

      text() {
        try { return Promise.resolve(new TextDecoder().decode(this._readBytes())); }
        catch (error) { return Promise.reject(error); }
      }

      stream() {
        const initialOffset = this._start;
        const end = this._end;
        let offset = initialOffset;
        if (typeof globalThis.ReadableStream !== 'function') return super.stream();
        return new globalThis.ReadableStream({
          pull(controller) {
            try {
              const current = readCurrent();
              if (offset >= end) {
                controller.close();
                return;
              }
              const next = Math.min(offset + 65536, end);
              controller.enqueue(current.slice(offset, next));
              offset = next;
            } catch (error) {
              controller.error(error);
            }
          },
        });
      }

      slice(start, end, blobType) {
        const size = this.size;
        const normalizeIndex = (value, fallback) => {
          if (value === undefined) return fallback;
          const number = Number(value);
          if (Number.isNaN(number)) return 0;
          if (number === Infinity) return size;
          if (number === -Infinity) return 0;
          return Math.max(0, Math.min(size, Math.trunc(number < 0 ? size + number : number)));
        };
        const relativeStart = normalizeIndex(start, 0);
        const relativeEnd = normalizeIndex(end, size);
        const nextStart = this._start + relativeStart;
        const nextEnd = this._start + Math.max(relativeStart, relativeEnd);
        const initial = bytes.slice(nextStart, nextEnd);
        return new FileBackedBlob(initial, nextStart, nextEnd, blobType);
      }
    }
    return Promise.resolve(new FileBackedBlob(bytes, 0, bytes.byteLength, type));
  }

  function encodingOption(optionsValue) {
    return typeof optionsValue === 'string' ? optionsValue : optionsValue?.encoding || null;
  }

  function decodeText(bytes, encoding) {
    if (!encoding || encoding === 'buffer') return nodeBuffer(bytes);
    const operations = resolveEncodingOps(encoding);
    if (operations) return operations.decode(bytes);
    return new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(bytes);
  }

  function validateEncoding(optionsValue) {
    const encoding = encodingOption(optionsValue);
    if (encoding && encoding !== 'buffer' && !resolveEncodingOps(encoding)) {
      throw invalidArgumentValue('encoding', encoding, 'must be a valid encoding');
    }
  }

  function scheduleFsCallback(callback) {
    const schedule = typeof globalThis.queueMicrotask === 'function'
      ? (next) => globalThis.queueMicrotask(next)
      : (next) => globalThis.setTimeout(next, 0);
    const resource = new AsyncResource('FSREQCALLBACK');
    const release = taskTracker?.();
    schedule(() => {
      try { resource.runInAsyncScope(callback); }
      finally {
        resource.emitDestroy();
        release?.();
      }
    });
  }

  function scheduleReadFile(callback, wrapReusedHandle = false) {
    let stagesRemaining = READ_FILE_ASYNC_STAGES;
    let previousResource;
    const schedule = typeof globalThis.queueMicrotask === 'function'
      ? (next) => globalThis.queueMicrotask(next)
      : (next) => globalThis.setTimeout(next, 0);
    const runStage = () => {
      const resource = new AsyncResource('FSREQCALLBACK');
      if (wrapReusedHandle) resource.handle = previousResource;
      previousResource = resource;
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
    resolve(pathValue);
    try {
      const path = resolve(pathValue);
      const flag = typeof optionsObject === 'string' ? optionsObject : optionsObject?.flag || 'w';
      if (flag.includes('x') && nodeExists(resolvePath(path, false))) throw existsError(path, 'write');
      setFile(path, data, flag.includes('a'), 'write', optionsObject?.encoding);
      if (typeof done === 'function') done(null);
    } catch (error) {
      if (typeof done === 'function') done(error);
      else throw error;
    }
  }

  function appendFile(pathValue, data, optionsValue, callback) {
    let done = callback;
    if (typeof optionsValue === 'function') done = optionsValue;
    resolve(pathValue);
    try {
      const path = resolve(pathValue);
      const flag = typeof optionsValue === 'string' ? optionsValue : optionsValue?.flag || 'a';
      if (flag.includes('x') && nodeExists(resolvePath(path, false))) throw existsError(path, 'append');
      setFile(path, data, true, 'append', optionsValue?.encoding);
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
    validateEncoding(optionsObject);
    resolve(pathValue);
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
    const path = resolvePath(resolve(pathValue));
    length = truncateLength(length);
    const current = readBytes(path, 'open');
    const next = new Uint8Array(length);
    next.set(current.subarray(0, length));
    access(path, 'truncate', true);
    setFileBytes(path, next);
    notify(path, 'change');
  }

  function ftruncateSync(handle, length = 0) {
    const record = descriptor(truncateDescriptor(handle));
    return truncate(record.path, truncateLength(length));
  }

  function truncateSync(pathValue, length = 0) {
    const size = truncateLength(length);
    if (typeof pathValue !== 'number') return truncate(pathValue, size);
    if (!truncateDescriptorWarningEmitted) {
      truncateDescriptorWarningEmitted = true;
      warningEmitter?.(
        'Using fs.truncate with a file descriptor is deprecated. Please use fs.ftruncate with a file descriptor instead.',
        { code: 'DEP0081', type: 'DeprecationWarning' },
      );
    }
    return ftruncateSync(pathValue, size);
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

  function copyOptions(optionsValue) {
    if (optionsValue === undefined) {
      return {
        dereference: false,
        errorOnExist: false,
        filter: undefined,
        force: true,
        mode: 0,
        preserveTimestamps: false,
        recursive: false,
        verbatimSymlinks: false,
      };
    }
    if (!optionsValue || typeof optionsValue !== 'object' || Array.isArray(optionsValue)) {
      throw invalidArgumentType('options', optionsValue, 'Object');
    }
    const options = {
      dereference: false,
      errorOnExist: false,
      filter: undefined,
      force: true,
      mode: 0,
      preserveTimestamps: false,
      recursive: false,
      verbatimSymlinks: false,
      ...optionsValue,
    };
    for (const name of ['dereference', 'errorOnExist', 'force', 'preserveTimestamps', 'recursive', 'verbatimSymlinks']) {
      if (typeof options[name] !== 'boolean') throw new TypeError(`The "options.${name}" argument must be of type boolean`);
    }
    if (options.dereference && options.verbatimSymlinks) {
      throw new TypeError('The "dereference" and "verbatimSymlinks" options cannot be used together');
    }
    if (options.filter !== undefined && typeof options.filter !== 'function') {
      throw invalidArgumentType('options.filter', options.filter, 'function');
    }
    if (typeof options.mode !== 'number') throw invalidArgumentType('options.mode', options.mode, 'number');
    if (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o777) {
      const error = outOfRange('options.mode', options.mode);
      error.message = `The value of "options.mode" is out of range. It must be >= 0 and <= 511. Received ${String(options.mode)}`;
      throw error;
    }
    return options;
  }

  function sourceNode(path, dereference) {
    const resolved = resolvePath(path, dereference, 'cp');
    if (files.has(resolved)) return { kind: 'file', path: resolved };
    if (directories.has(resolved)) return { kind: 'directory', path: resolved };
    if (!dereference && symlinks.has(path)) return { kind: 'symlink', path };
    throw missing(path, 'cp');
  }

  function destinationNode(path) {
    const resolved = resolvePath(path, false, 'cp');
    if (files.has(resolved)) return { kind: 'file', path: resolved };
    if (directories.has(resolved)) return { kind: 'directory', path: resolved };
    if (symlinks.has(resolved)) return { kind: 'symlink', path: resolved };
    return null;
  }

  function ensureCopyParent(path) {
    const parent = parentOf(path);
    if (!directories.has(resolvePath(parent))) makeDirectory(parent, true, 'cp');
  }

  function removeCopyDestination(node) {
    if (node.kind === 'directory') throw isDirectory(node.path, 'cp');
    removeFile(node.path, 'cp');
  }

  function filterResult(filter, source, destination) {
    if (!filter) return true;
    const result = filter(source, destination);
    if (result && typeof result.then === 'function') {
      throw vfsError('ERR_INVALID_RETURN_VALUE', undefined, undefined, 'Expected boolean to be returned from filter');
    }
    return Boolean(result);
  }

  function copyEntry(source, destination, options, filterChildren) {
    const sourceNodeValue = sourceNode(source, options.dereference);
    if (options.filter && !filterResult(options.filter, source, destination)) return;
    const destinationNodeValue = destinationNode(destination);
    if (sourceNodeValue.path === destinationNodeValue?.path) throw invalidCopy(destination, 'src and dest cannot be the same');

    if (sourceNodeValue.kind === 'directory') {
      if (!options.recursive) throw isDirectory(source, 'cp');
      if (destinationNodeValue && destinationNodeValue.kind !== 'directory') throw isDirectory(destination, 'cp');
      if (!destinationNodeValue) {
        ensureCopyParent(destination);
        makeDirectory(destination, false, 'cp');
      } else if (options.errorOnExist && !options.force) {
        throw existsError(destination, 'cp');
      }
      for (const entry of directoryEntries(sourceNodeValue.path)) {
        const childSource = `${sourceNodeValue.path}/${entry.name}`;
        const childDestination = `${destination}/${entry.name}`;
        if (filterChildren) copyEntry(childSource, childDestination, options, filterChildren);
        else copyEntryWithoutFilter(childSource, childDestination, options);
      }
      return;
    }

    if (destinationNodeValue) {
      if (destinationNodeValue.kind === 'directory') throw notDirectory(destination, 'cp');
      if (!options.force) return;
      if (options.errorOnExist) throw existsError(destination, 'cp');
      removeCopyDestination(destinationNodeValue);
    } else {
      ensureCopyParent(destination);
    }
    if (sourceNodeValue.kind === 'symlink') {
      let target = symlinks.get(sourceNodeValue.path);
      if (!options.verbatimSymlinks && !target.startsWith('/')) target = normalizePath(`${parentOf(sourceNodeValue.path)}/${target}`, '/');
      symlinkSync(target, destination);
      return;
    }
    setFile(destination, readBytes(sourceNodeValue.path, 'cp'), false, 'cp');
  }

  function copyEntryWithoutFilter(source, destination, options) {
    copyEntry(source, destination, { ...options, filter: undefined }, false);
  }

  function copyTree(sourceValue, destinationValue, optionsValue = {}) {
    const options = copyOptions(optionsValue);
    const source = resolve(sourceValue);
    const destination = resolve(destinationValue);
    const filterChildren = !(ArrayBuffer.isView(sourceValue) || sourceValue instanceof ArrayBuffer);
    copyEntry(source, destination, options, filterChildren);
  }

  async function copyEntryAsync(source, destination, options, filterChildren) {
    const sourceNodeValue = sourceNode(source, options.dereference);
    if (filterChildren && options.filter && !Boolean(await options.filter(source, destination))) return;
    const destinationNodeValue = destinationNode(destination);
    if (sourceNodeValue.path === destinationNodeValue?.path) throw invalidCopy(destination, 'src and dest cannot be the same');
    if (sourceNodeValue.kind === 'directory') {
      if (!options.recursive) throw isDirectory(source, 'cp');
      if (destinationNodeValue && destinationNodeValue.kind !== 'directory') throw isDirectory(destination, 'cp');
      if (!destinationNodeValue) {
        ensureCopyParent(destination);
        makeDirectory(destination, false, 'cp');
      } else if (options.errorOnExist && !options.force) {
        throw existsError(destination, 'cp');
      }
      for (const entry of directoryEntries(sourceNodeValue.path)) {
        const childSource = `${sourceNodeValue.path}/${entry.name}`;
        const childDestination = `${destination}/${entry.name}`;
        await copyEntryAsync(childSource, childDestination, options, filterChildren);
      }
      return;
    }
    if (destinationNodeValue) {
      if (destinationNodeValue.kind === 'directory') throw notDirectory(destination, 'cp');
      if (!options.force) return;
      if (options.errorOnExist) throw existsError(destination, 'cp');
      removeCopyDestination(destinationNodeValue);
    } else {
      ensureCopyParent(destination);
    }
    if (sourceNodeValue.kind === 'symlink') {
      let target = symlinks.get(sourceNodeValue.path);
      if (!options.verbatimSymlinks && !target.startsWith('/')) target = normalizePath(`${parentOf(sourceNodeValue.path)}/${target}`, '/');
      symlinkSync(target, destination);
      return;
    }
    setFile(destination, readBytes(sourceNodeValue.path, 'cp'), false, 'cp');
  }

  async function copyTreeAsync(sourceValue, destinationValue, optionsValue = {}) {
    const options = copyOptions(optionsValue);
    const source = resolve(sourceValue);
    const destination = resolve(destinationValue);
    await copyEntryAsync(source, destination, options, true);
  }

  function rename(sourceValue, destinationValue) {
    const source = resolvePath(resolve(sourceValue), false);
    const destination = resolvePath(resolve(destinationValue), false);
    const sourceMount = access(source, 'rename', true);
    const destinationMount = access(destination, 'rename', true);
    if (sourceMount.path !== destinationMount.path) throw denied(destination, 'rename');
    if (source === destination) return;
    if (!nodeExists(source)) throw missing(source, 'rename');
    ensureParent(destination, 'rename');
    if (files.has(destination) && directories.has(source)) throw notDirectory(destination, 'rename');
    if (directories.has(destination) && (files.has(source) || symlinks.has(source))) throw isDirectory(destination, 'rename');
    if (nodeExists(destination)) throw existsError(destination, 'rename');
    if (directories.has(source) && isWithin(destination, source)) throw invalidPath('rename target is inside source directory');

    if (files.has(source)) {
      moveFileNode(source, destination);
      if (metadata.has(source)) metadata.set(destination, metadata.get(source));
      metadata.delete(source);
    } else if (symlinks.has(source)) {
      symlinks.set(destination, symlinks.get(source));
      symlinks.delete(source);
      if (metadata.has(source)) metadata.set(destination, metadata.get(source));
      metadata.delete(source);
    } else {
      const childDirectories = [...directories].filter((item) => item === source || isWithin(item, source));
      const childFiles = [...files.keys()].filter((item) => isWithin(item, source));
      const childSymlinks = [...symlinks.keys()].filter((item) => isWithin(item, source));
      for (const item of childDirectories) directories.add(`${destination}${item.slice(source.length)}`);
      for (const item of childFiles) {
        moveFileNode(item, `${destination}${item.slice(source.length)}`);
      }
      for (const item of childSymlinks) symlinks.set(`${destination}${item.slice(source.length)}`, symlinks.get(item));
      for (const item of [...childDirectories, ...childFiles, ...childSymlinks]) {
        if (metadata.has(item)) metadata.set(`${destination}${item.slice(source.length)}`, metadata.get(item));
      }
      for (const item of childFiles) files.delete(item);
      for (const item of childDirectories) directories.delete(item);
      for (const item of childSymlinks) symlinks.delete(item);
      for (const item of [...childDirectories, ...childFiles, ...childSymlinks]) metadata.delete(item);
    }
    notify(source, 'rename');
    notify(destination, 'rename');
  }

  function openDescriptor(pathValue, flags = 'r') {
    flags = String(flags);
    const path = resolvePath(resolve(pathValue));
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

  function readDescriptorAsync(value, buffer, offset, length, position, callback) {
    scheduleReadFile(() => {
      try {
        callback(null, readDescriptor(value, buffer, offset, length, position));
      } catch (error) {
        callback(error);
      }
    }, true);
  }

  function validateVectorArguments(value, buffers) {
    if (typeof value !== 'number') throw invalidArgumentType('fd', value, 'number');
    descriptor(value);
    if (!Array.isArray(buffers) || buffers.some((buffer) => !ArrayBuffer.isView(buffer))) {
      throw invalidArgumentType('buffers', buffers, 'an Array of ArrayBufferView');
    }
  }

  function vectorPosition(position) {
    if (position === null || position === undefined) return null;
    if (!Number.isInteger(position) || position < 0) throw outOfRange('position', position);
    return position;
  }

  function readvSync(value, buffers, position) {
    validateVectorArguments(value, buffers);
    const start = vectorPosition(position);
    let total = 0;
    for (const buffer of buffers) {
      if (buffer.byteLength === 0) continue;
      const result = readDescriptor(
        value,
        buffer,
        0,
        buffer.byteLength,
        start === null ? null : start + total,
      );
      total += result.bytesRead;
      if (result.bytesRead < buffer.byteLength) break;
    }
    return total;
  }

  function writevSync(value, buffers, position) {
    validateVectorArguments(value, buffers);
    const start = vectorPosition(position);
    let total = 0;
    for (const buffer of buffers) {
      if (buffer.byteLength === 0) continue;
      const result = writeDescriptor(
        value,
        buffer,
        0,
        buffer.byteLength,
        start === null ? null : start + total,
      );
      total += result.bytesWritten;
    }
    return total;
  }

  function readv(value, buffers, position, callback) {
    const done = typeof position === 'function' ? position : callback;
    const at = typeof position === 'function' ? undefined : position;
    validateVectorArguments(value, buffers);
    vectorPosition(at);
    if (typeof done !== 'function') throw invalidPath('callback is required');
    scheduleFsCallback(() => {
      try { done(null, readvSync(value, buffers, at), buffers); }
      catch (error) { done(error); }
    });
  }

  function writev(value, buffers, position, callback) {
    const done = typeof position === 'function' ? position : callback;
    const at = typeof position === 'function' ? undefined : position;
    validateVectorArguments(value, buffers);
    vectorPosition(at);
    if (typeof done !== 'function') throw invalidPath('callback is required');
    scheduleFsCallback(() => {
      try { done(null, writevSync(value, buffers, at), buffers); }
      catch (error) { done(error); }
    });
  }

  function writeDescriptor(value, data, offset = 0, length, position) {
    const record = descriptor(value);
    assertWritable(record);
    if (!Number.isInteger(offset) || offset < 0) throw outOfRange('offset', offset);
    if (length !== undefined && (!Number.isInteger(length) || length < 0)) throw outOfRange('length', length);
    if (position !== null && position !== undefined && (!Number.isInteger(position) || position < 0)) {
      throw outOfRange('position', position);
    }
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
    fileHandleRecords.add(record);
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
      async datasync() { syncDescriptor(record.fd); },
      async sync() { syncDescriptor(record.fd); },
      async chmod(mode) { updateDescriptorMode(record.fd, mode); },
      async chown(uid, gid) { updateDescriptorOwner(record.fd, ownerId(uid, 'uid'), ownerId(gid, 'gid')); },
      async utimes(atime, mtime) { updateDescriptorTimes(record.fd, atime, mtime); },
      async close() { if (descriptors.has(record.fd)) closeDescriptor(record.fd); },
      async truncate(length = 0) { descriptor(record.fd); assertWritable(record); truncate(record.path, length); },
      async write(data, offset = 0, length, position) {
        return writeDescriptor(record.fd, data, offset, length, position);
      },
      async readv(buffers, position) {
        return { bytesRead: readvSync(record.fd, buffers, position), buffers };
      },
      async writev(buffers, position) {
        return { bytesWritten: writevSync(record.fd, buffers, position), buffers };
      },
      createReadStream(optionsValue = {}) {
        descriptor(record.fd);
        return createReadStream(null, { ...optionsValue, fd: record.fd, autoClose: false });
      },
      createWriteStream(optionsValue = {}) {
        descriptor(record.fd);
        return createWriteStream(null, { ...optionsValue, fd: record.fd, autoClose: false });
      },
      async read(buffer, offset = 0, length = buffer.length, position) {
        if (!ArrayBuffer.isView(offset) && offset && typeof offset === 'object') {
          const options = offset;
          offset = options.offset ?? 0;
          length = options.length ?? buffer.length - offset;
          position = options.position;
        }
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

  function closeStreamDescriptor(stream, callback = () => {}, force = false) {
    if ((!force && !stream.autoClose) || !stream._fsOwned || stream._fsClosed || stream.fd === null) {
      callback(stream._fsCloseError);
      return;
    }
    stream._fsClosed = true;
    const fd = stream.fd;
    let completed = false;
    const complete = (error) => {
      if (completed) return;
      completed = true;
      if (error) stream._fsCloseError = error;
      stream.closed = true;
      stream.fd = null;
      callback(error);
    };
    try {
      if (typeof stream._fsCloseWith === 'function') {
        const result = stream._fsCloseWith(fd, complete);
        if (result?.then) result.then(() => complete(), complete);
      } else {
        closeDescriptor(fd);
        complete();
      }
    } catch (error) {
      complete(error);
    }
  }

  function finishStreamIo(stream, error) {
    stream._fsPerformingIO = false;
    const waiters = stream._fsIoWaiters;
    stream._fsIoWaiters = [];
    for (const waiter of waiters || []) waiter(error);
  }

  function ReadStream(pathValue, optionsValue = {}) {
    const isTarget = new.target || (this && this instanceof ReadStream);
    const target = isTarget
      ? this
      : Object.create(ReadStream.prototype);
    return createReadStream(pathValue, optionsValue, target, isTarget ? null : this);
  }

  ReadStream.prototype = Object.create(Readable.prototype);
  ReadStream.prototype.constructor = ReadStream;
  Object.setPrototypeOf(ReadStream, Readable);
  ReadStream.prototype.open = function open() {
    this._fsOpenDefault();
  };

  Object.defineProperty(ReadStream.prototype, 'autoClose', {
    configurable: true,
    get() {
      if (!this?._readableState) throw invalidDirectoryThis();
      return this._readableState.autoDestroy;
    },
    set(value) { this._readableState.autoDestroy = value; },
  });

  ReadStream.prototype._construct = function _construct(callback) {
    if (typeof this.fd === 'number') {
      callback();
      return;
    }
    const opening = this._fsOpen();
    if (opening?.then) {
      opening.then(() => callback(this._fsOpenError), callback);
      return;
    }
    callback(this._fsOpenError);
  };

  ReadStream.prototype._read = function _read(size) {
    const stream = this;
    const options = stream._fsOptions || {};
    const n = size ?? stream.readableHighWaterMark ?? 16 * 1024;
    const position = stream._fsPosition === null ? undefined : stream._fsPosition;
    const remaining = position === undefined
      ? stream.end - stream.bytesRead + 1
      : stream.end - position + 1;
    const requested = Math.min(remaining, n);

    if (requested <= 0) {
      stream.push(null);
      return;
    }

    const readData = () => {
      if (stream.destroyed || stream._ended) return;
      if (stream._fsVirtualExecutable) {
        stream.push(stream._fsVirtualExecutable);
        stream.push(null);
        return;
      }

      try {
        const record = descriptor(stream.fd);
        const at = position === undefined ? record.position : position;
        const available = Math.max(0, Math.min(
          readBytes(record.path).length - at,
          stream.end - at + 1,
        ));
        if (!available) {
          stream.push(null);
          return;
        }
        const length = Math.max(1, Math.min(requested, available));
        const buffer = new Uint8Array(length);
        const finishRead = (result) => {
          finishStreamIo(stream);
          if (stream.destroyed) return;
          if (stream._fsPosition !== null) stream._fsPosition = at + result.bytesRead;
          stream.bytesRead += result.bytesRead;
          stream.push(buffer.subarray(0, result.bytesRead));
        };

        stream._fsPerformingIO = true;
        if (typeof stream._fsApi?.read === 'function'
          && (options.fs || stream._fsApi.read !== fs.read)) {
          return new Promise((resolve, reject) => {
            try {
              stream._fsApi.read(stream.fd, buffer, 0, length, position, (error, bytesRead) => {
                if (error) {
                  finishStreamIo(stream, error);
                  reject(error);
                } else {
                  finishRead({ bytesRead });
                  resolve();
                }
              });
            } catch (error) {
              finishStreamIo(stream, error);
              reject(error);
            }
          });
        }
        finishRead(readDescriptor(stream.fd, buffer, 0, length, position));
      } catch (error) {
        finishStreamIo(stream, error);
        if (stream.autoClose) {
          stream.destroy(error);
        } else {
          stream._error = error;
          if (!stream._errorEmitted) {
            stream._errorEmitted = true;
            stream._readableState.errorEmitted = true;
            stream.emit('error', error);
          }
        }
      }
    };

    const opening = stream._fsOpen();
    if (opening?.then) return opening.then(readData, (error) => stream.destroy(error));
    return readData();
  };

  ReadStream.prototype._destroy = function _destroy(error, callback) {
    const close = (ioError) => closeStreamDescriptor(
      this,
      (closeError) => callback(closeError || error || ioError),
      true,
    );
    if (this._fsPerformingIO) {
      (this._fsIoWaiters ||= []).push(close);
    } else {
      close();
    }
  };

  ReadStream.prototype.close = function close(callback) {
    if (typeof callback === 'function') {
      if (this._closeEmitted) queueMicrotask(callback);
      else this.once('close', callback);
    }
    this.destroy();
  };

  Object.defineProperty(ReadStream.prototype, 'pending', {
    configurable: true,
    get() { return this.fd === null; },
  });

  function normalizeStreamOptions(optionsValue) {
    if (optionsValue === undefined || optionsValue === null) return {};
    if (typeof optionsValue === 'string') return { encoding: optionsValue };
    if (typeof optionsValue !== 'object' || Array.isArray(optionsValue)) {
      throw invalidArgumentType('options', optionsValue, 'Object');
    }
    return optionsValue;
  }

  function validateStreamFunction(fsApi, name) {
    if (typeof fsApi?.[name] !== 'function') {
      const error = new TypeError(
        `The "options.fs.${name}" property must be of type function. ${receivedArgumentValue(fsApi?.[name])}`,
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
  }

  function validateStreamFd(options) {
    if (options.fd === undefined || options.fd === null) return;
    const fd = typeof options.fd === 'number' ? options.fd : options.fd?.fd;
    if (!Number.isInteger(fd)) throw invalidArgumentType('options.fd', options.fd, 'number');
  }

  function validateStreamPath(pathValue, options) {
    if (options.fd === undefined || options.fd === null) validatePathArgument(pathValue);
  }

  function validateReadStreamOptions(options) {
    if (options.start !== undefined && (!Number.isSafeInteger(options.start) || options.start < 0)) {
      throw outOfRange('start', options.start);
    }
    if (options.end !== undefined && options.end !== Infinity
      && (!Number.isSafeInteger(options.end) || options.end < 0)) {
      throw outOfRange('end', options.end);
    }
    if (options.start !== undefined && options.end !== undefined && options.start > options.end) {
      const error = outOfRange('start', options.start);
      error.message = `The value of "start" is out of range. It must be <= "end" (here: ${options.end}). Received ${options.start}`;
      throw error;
    }
  }

  function createReadStream(pathValue, optionsValue = {}, target = null, moduleFs = null) {
    const options = normalizeStreamOptions(optionsValue);
    validateReadStreamOptions(options);
    validateStreamFd(options);
    const fsApi = options.fs || moduleFs || fs;
    validateStreamPath(pathValue, options);
    validateStreamFunction(fsApi, 'read');
    if (options.fd === undefined || options.fd === null) validateStreamFunction(fsApi, 'open');
    if (options.autoClose !== false) validateStreamFunction(fsApi, 'close');
    const virtualExecutable = pathValue === '/browser/node';
    const virtualExecutableBytes = new TextEncoder().encode('browser-native-node-runtime\n');
    const highWaterMark = options.highWaterMark ?? options.bufferSize ?? 64 * 1024;
    const autoDestroy = options.autoClose !== false;
    const streamOptions = { highWaterMark, autoDestroy };
    const stream = target || new Readable(streamOptions);
    if (target) Object.assign(stream, new Readable(streamOptions));
    else Object.setPrototypeOf(stream, ReadStream.prototype);
    stream.path = pathValue ?? undefined;
    stream._fsApi = fsApi;
    stream._fsOptions = options;
    stream._fsVirtualExecutable = virtualExecutable ? virtualExecutableBytes : null;
    const hasFd = options.fd !== undefined && options.fd !== null;
    stream.fd = hasFd ? (typeof options.fd === 'number' ? options.fd : options.fd?.fd) : null;
    stream.flags = options.flags || 'r';
    stream.mode = options.mode ?? 0o666;
    stream.bytesRead = 0;
    stream.autoClose = options.autoClose !== false;
    stream.start = options.start;
    stream.end = options.end ?? Infinity;
    stream.closed = false;
    stream._fsPosition = stream.start === undefined ? null : stream.start;
    stream._fsStarted = hasFd;
    stream._fsOwned = hasFd;
    stream._fsClosed = false;
    stream._fsPerformingIO = false;
    stream._fsIoWaiters = [];
    stream._fsCloseWith = typeof fsApi?.close === 'function'
      ? (fd, callback) => {
        const closeFn = fsApi.close;
        if (options.fs || closeFn !== fs.close) return closeFn(fd, callback);
        closeDescriptor(fd);
        callback();
      }
      : null;
    stream._read = ReadStream.prototype._read;
    stream._destroyHook = ReadStream.prototype._destroy;
    if (options.encoding) stream.setEncoding(options.encoding);
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (error, callback) => {
      if (typeof error === 'function') {
        callback = error;
        error = undefined;
      }
      if (typeof callback === 'function') {
        if (stream._closeEmitted) queueMicrotask(callback);
        else stream.once('close', callback);
      }
      return destroy(error || stream._fsCloseError);
    };
    stream._fsOpenDefault = () => {
      if (stream._fsStarted) return;
      stream._fsStarted = true;
      if (virtualExecutable) {
        stream.emit('open', null);
        stream.emit('ready');
        return;
      }
      if (typeof fsApi?.open === 'function' && (options.fs || fsApi.open !== open)) {
        stream._fsOpening = new Promise((resolve) => {
          try {
            fsApi.open(pathValue, stream.flags, stream.mode, (error, fd) => {
              if (error) {
                stream._fsOpenError = error;
                stream.destroy(error);
                resolve(error);
                return;
              }
              stream.fd = fd;
              stream._fsOwned = true;
              stream.emit('open', stream.fd);
              stream.emit('ready');
              if (stream.destroyed) closeStreamDescriptor(stream, undefined, true);
              resolve(null);
            });
          } catch (error) {
            stream._fsOpenError = error;
            stream.destroy(error);
            resolve(error);
          }
        });
        return stream._fsOpening;
      }
      try {
        const opened = streamDescriptor(pathValue, options, 'r');
        stream.fd = opened.fd;
        stream._fsOwned = opened.owned;
        stream.emit('open', stream.fd);
        stream.emit('ready');
        if (stream.destroyed) closeStreamDescriptor(stream, undefined, true);
        return;
      } catch (error) {
        stream.destroy(error);
        return;
      }
    };
    stream._fsOpen = () => {
      if (stream._fsStarted) return stream._fsOpening;
      if (stream.open && stream.open !== ReadStream.prototype.open) {
        stream._fsStarted = true;
        try {
          const result = stream.open();
          stream._fsOpening = result?.then ? result : Promise.resolve();
        } catch (error) {
          stream.destroy(error);
          stream._fsOpening = Promise.reject(error);
        }
        return stream._fsOpening;
      }
      return stream._fsOpenDefault();
    };
    // Open eagerly like Node's fs.ReadStream, but wait for a data listener or
    // async iterator before switching into flowing mode so buffered bytes are
    // not discarded before a consumer attaches.
    queueMicrotask(() => stream._fsOpen());
    return stream;
  }

  function WriteStream(pathValue, optionsValue = {}) {
    const isTarget = new.target || (this && this instanceof WriteStream);
    const target = isTarget
      ? this
      : Object.create(WriteStream.prototype);
    return createWriteStream(pathValue, optionsValue, target, isTarget ? null : this);
  }

  WriteStream.prototype = Object.create(Writable.prototype);
  WriteStream.prototype.constructor = WriteStream;
  Object.setPrototypeOf(WriteStream, Writable);
  WriteStream.prototype.open = function open() {
    this._fsOpenDefault();
  };

  Object.defineProperty(WriteStream.prototype, 'autoClose', {
    configurable: true,
    get() {
      if (!this?._writableState) throw invalidDirectoryThis();
      return this._writableState.autoDestroy;
    },
    set(value) { this._writableState.autoDestroy = value; },
  });

  WriteStream.prototype._construct = function _construct(callback) {
    if (typeof this.fd === 'number') {
      callback();
      return;
    }
    const opening = this._fsOpen();
    if (opening?.then) {
      opening.then(() => callback(this._fsOpenError), callback);
      return;
    }
    callback(this._fsOpenError);
  };

  function writeStreamDestroyedError(operation) {
    const error = new Error(`Cannot call write after a stream was destroyed`);
    error.code = 'ERR_STREAM_DESTROYED';
    error.operation = operation;
    return error;
  }

  function writeAll(stream, data, size, position, callback, retries = 0) {
    let callbackCalled = false;
    const complete = (error, bytesWritten, buffer) => {
      callbackCalled = true;
      if (error?.code === 'EAGAIN') {
        error = null;
        bytesWritten = 0;
      }
      if (stream.destroyed || error) {
        callback(error || writeStreamDestroyedError('write'));
        return;
      }

      bytesWritten ??= 0;
      stream.bytesWritten += bytesWritten;
      retries = bytesWritten ? 0 : retries + 1;
      size -= bytesWritten;
      if (position !== undefined) position += bytesWritten;
      if (retries > 5) {
        const writeError = new Error('write failed');
        writeError.code = 'ERR_SYSTEM_ERROR';
        callback(writeError);
      } else if (size) {
        writeAll(stream, (buffer || data).slice(bytesWritten), size, position, callback, retries);
      } else {
        callback();
      }
    };
    try {
      stream._fsApi.write(stream.fd, data, 0, size, position, complete);
    } catch (error) {
      if (callbackCalled) throw error;
      callback(error);
    }
  }

  function remainingWritevBuffers(buffers, bytesWritten) {
    const remaining = [];
    let skip = bytesWritten;
    for (const buffer of buffers) {
      if (skip >= buffer.length) {
        skip -= buffer.length;
      } else {
        remaining.push(buffer.slice(skip));
        skip = 0;
      }
    }
    return remaining;
  }

  function writevAll(stream, buffers, size, position, callback, retries = 0) {
    let callbackCalled = false;
    const complete = (error, bytesWritten, writtenBuffers) => {
      callbackCalled = true;
      if (error?.code === 'EAGAIN') {
        error = null;
        bytesWritten = 0;
      }
      if (stream.destroyed || error) {
        callback(error || writeStreamDestroyedError('writev'));
        return;
      }

      bytesWritten ??= 0;
      stream.bytesWritten += bytesWritten;
      retries = bytesWritten ? 0 : retries + 1;
      size -= bytesWritten;
      if (position !== undefined) position += bytesWritten;
      if (retries > 5) {
        const writeError = new Error('writev failed');
        writeError.code = 'ERR_SYSTEM_ERROR';
        callback(writeError);
      } else if (size) {
        writevAll(
          stream,
          remainingWritevBuffers(writtenBuffers || buffers, bytesWritten),
          size,
          position,
          callback,
          retries,
        );
      } else {
        callback();
      }
    };
    try {
      stream._fsApi.writev(stream.fd, buffers, position, complete);
    } catch (error) {
      if (callbackCalled) throw error;
      callback(error);
    }
  }

  WriteStream.prototype._write = function _write(data, _encoding, callback) {
    this._fsPerformingIO = true;
    let completed = false;
    const complete = (error) => {
      if (completed) return;
      completed = true;
      finishStreamIo(this, error);
      callback(error);
    };
    const writeData = () => writeAll(
      this,
      data,
      data.length,
      this._fsPosition === null ? undefined : this._fsPosition,
      complete,
    );
    try {
      const opening = this._fsOpen();
      if (opening?.then) {
        opening.then((error) => error ? complete(error) : writeData(), complete);
      } else {
        writeData();
      }
    } catch (error) {
      complete(error);
    }
    if (this._fsPosition !== null) this._fsPosition += data.length;
  };

  WriteStream.prototype._writev = function _writev(data, callback) {
    const buffers = data.map((item) => item.chunk);
    const size = buffers.reduce((total, buffer) => total + buffer.length, 0);
    this._fsPerformingIO = true;
    let completed = false;
    const complete = (error) => {
      if (completed) return;
      completed = true;
      finishStreamIo(this, error);
      callback(error);
    };
    const writeData = () => writevAll(
      this,
      buffers,
      size,
      this._fsPosition === null ? undefined : this._fsPosition,
      complete,
    );
    try {
      const opening = this._fsOpen();
      if (opening?.then) {
        opening.then((error) => error ? complete(error) : writeData(), complete);
      } else {
        writeData();
      }
    } catch (error) {
      complete(error);
    }
    if (this._fsPosition !== null) this._fsPosition += size;
  };

  WriteStream.prototype._destroy = function _destroy(error, callback) {
    const close = (ioError) => closeStreamDescriptor(
      this,
      (closeError) => callback(closeError || error || ioError),
      true,
    );
    if (this._fsPerformingIO) {
      (this._fsIoWaiters ||= []).push(close);
    } else {
      close();
    }
  };

  WriteStream.prototype.close = function close(callback) {
    if (typeof callback === 'function') {
      if (this._closeEmitted) queueMicrotask(callback);
      else this.once('close', callback);
    }
    if (!this.autoClose) this.once('finish', () => this.destroy());
    this.end();
  };

  WriteStream.prototype.destroySoon = WriteStream.prototype.end;

  Object.defineProperty(WriteStream.prototype, 'pending', {
    configurable: true,
    get() { return this.fd === null; },
  });

  function validateWriteStreamOptions(options) {
    if (options.start !== undefined && (!Number.isSafeInteger(options.start) || options.start < 0)) {
      throw outOfRange('start', options.start);
    }
  }

  function createWriteStream(pathValue, optionsValue = {}, target = null, moduleFs = null) {
    const options = normalizeStreamOptions(optionsValue);
    validateWriteStreamOptions(options);
    validateStreamFd(options);
    const fsApi = options.fs || moduleFs || fs;
    validateStreamPath(pathValue, options);
    if (options.fd === undefined || options.fd === null) validateStreamFunction(fsApi, 'open');
    if (!fsApi || (typeof fsApi.write !== 'function' && typeof fsApi.writev !== 'function')) {
      validateStreamFunction(fsApi, 'write');
    }
    if (fsApi.write !== undefined) validateStreamFunction(fsApi, 'write');
    if (fsApi.writev !== undefined) validateStreamFunction(fsApi, 'writev');
    if (options.autoClose !== false) validateStreamFunction(fsApi, 'close');
    let stream = target;
    const autoDestroy = options.autoClose !== false;
    const streamOptions = {
      highWaterMark: options.highWaterMark,
      autoDestroy,
      decodeStrings: true,
      final(callback) {
        callback();
      },
    };
    if (target) Writable.call(stream, streamOptions);
    else stream = new Writable(streamOptions);
    if (!target) Object.setPrototypeOf(stream, WriteStream.prototype);
    if (!target) {
      stream._write = WriteStream.prototype._write;
      stream._writev = WriteStream.prototype._writev;
    }
    if (!fsApi.write) stream._write = null;
    if (!fsApi.writev) stream._writev = null;
    stream.path = pathValue ?? undefined;
    stream._fsApi = fsApi;
    stream._fsOptions = options;
    stream.fd = options.fd === undefined || options.fd === null
      ? null
      : typeof options.fd === 'number' ? options.fd : options.fd?.fd;
    stream.flags = options.flags || 'w';
    stream.mode = options.mode ?? 0o666;
    stream.bytesWritten = 0;
    stream.autoClose = options.autoClose !== false;
    stream.closed = false;
    stream._fsPosition = options.start === undefined ? null : options.start;
    const hasFd = options.fd !== undefined && options.fd !== null;
    stream._fsStarted = hasFd;
    stream._fsOwned = hasFd;
    stream._fsClosed = false;
    stream._fsPerformingIO = false;
    stream._fsIoWaiters = [];
    stream._fsCloseWith = typeof fsApi?.close === 'function'
      ? (fd, callback) => {
        const closeFn = fsApi.close;
        if (options.fs || closeFn !== fs.close) return closeFn(fd, callback);
        closeDescriptor(fd);
        callback();
      }
      : null;
    stream._destroyHook = WriteStream.prototype._destroy;
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (error, callback) => {
      if (typeof error === 'function') {
        callback = error;
        error = undefined;
      }
      if (typeof callback === 'function') {
        if (stream._closeEmitted) queueMicrotask(callback);
        else stream.once('close', callback);
      }
      return destroy(error || stream._fsCloseError);
    };
    stream._fsOpenDefault = () => {
      if (stream._fsStarted) return;
      stream._fsStarted = true;
      if (typeof fsApi?.open === 'function' && (options.fs || fsApi.open !== open)) {
        stream._fsOpening = new Promise((resolve) => {
          try {
            fsApi.open(pathValue, stream.flags, stream.mode, (error, fd) => {
              if (error) {
                stream._fsOpenError = error;
                stream.destroy(error);
                resolve(error);
                return;
              }
              stream.fd = fd;
              stream._fsOwned = true;
              stream.emit('open', stream.fd);
              stream.emit('ready');
              if (stream.destroyed) closeStreamDescriptor(stream, undefined, true);
              resolve(null);
            });
          } catch (error) {
            stream._fsOpenError = error;
            stream.destroy(error);
            resolve(error);
          }
        });
        return stream._fsOpening;
      }
      try {
        const opened = streamDescriptor(pathValue, options, stream.flags);
        stream.fd = opened.fd;
        stream._fsOwned = opened.owned;
        stream.emit('open', stream.fd);
        stream.emit('ready');
        if (stream.destroyed) closeStreamDescriptor(stream, undefined, true);
        return Promise.resolve();
      } catch (error) { stream.destroy(error); }
      return Promise.resolve(stream._fsOpenError);
    };
    stream._fsOpen = () => {
      if (stream._fsStarted) return stream._fsOpening;
      if (stream.open && stream.open !== WriteStream.prototype.open) {
        stream._fsStarted = true;
        try {
          const result = stream.open();
          stream._fsOpening = result?.then ? result : Promise.resolve();
        } catch (error) {
          stream.destroy(error);
          stream._fsOpening = Promise.reject(error);
        }
        return stream._fsOpening;
      }
      return stream._fsOpenDefault();
    };
    // The open request is already queued when destroy() races it. Node still
    // delivers the pending open event, allowing callers to observe the fd and
    // close it from that listener.
    queueMicrotask(() => stream._fsOpen());
    return stream;
  }

  function watch(pathValue, optionsValue, listener) {
    const callback = typeof optionsValue === 'function' ? optionsValue : typeof listener === 'function' ? listener : null;
    const options = watchOptions(typeof optionsValue === 'function' ? undefined : optionsValue);
    const path = resolve(pathValue);
    statPath(path);
    const emitter = new EventEmitter();
    const resource = new AsyncResource('FSEVENTWRAP');
    const queue = [];
    const waiters = [];
    const list = watchers.get(path) || [];
    let closed = false;
    let referenced = true;
    let failure;
    const onAbort = () => emitter._fail(abortError(options.signal.reason));
    if (callback) emitter.on('change', callback);
    if (options.persistent === false) referenced = false;
    emitter._notify = (eventType, filename) => {
      if (closed) return;
      const resultFilename = watchFilename(filename, options.encoding);
      emitter.emit('change', eventType, resultFilename);
      const item = { eventType, filename: resultFilename };
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value: item, done: false });
      else if (queue.length < (options.maxQueue ?? 2048)) queue.push(item);
      else if (options.overflow === 'error') emitter._fail(vfsError('ERR_FS_WATCH_QUEUE_OVERFLOW', path, 'watch'));
    };
    emitter.close = () => {
      if (closed) return;
      closed = true;
      const current = watchers.get(path) || [];
      const remaining = current.filter((item) => item !== emitter);
      if (remaining.length) watchers.set(path, remaining);
      else watchers.delete(path);
      options.signal?.removeEventListener?.('abort', onAbort);
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
      resource.emitDestroy();
      emitter.emit('close');
    };
    emitter._fail = (error) => {
      if (closed) return;
      failure = error;
      const pending = waiters.splice(0);
      emitter.close();
      for (const waiter of pending) waiter.reject(error);
    };
    emitter._recursive = options.recursive === true;
    emitter.ref = () => {
      referenced = true;
      return emitter;
    };
    emitter.unref = () => {
      referenced = false;
      return emitter;
    };
    emitter.hasRef = () => referenced;
    emitter[Symbol.asyncIterator] = () => ({
      next: () => closed
        ? failure ? Promise.reject(failure) : Promise.resolve({ value: undefined, done: true })
        : queue.length
          ? Promise.resolve({ value: queue.shift(), done: false })
          : new Promise((resolveNext, rejectNext) => waiters.push({ resolve: resolveNext, reject: rejectNext })),
      return: async () => { emitter.close(); return { value: undefined, done: true }; },
    });
    list.push(emitter);
    watchers.set(path, list);
    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) queueMicrotask(onAbort);
    }
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
    if (type === 'symlink') {
      const target = sourcePath(entryValue.target ?? entryValue.link ?? entryValue.data ?? '');
      ensureParent(path, 'mount');
      if (nodeExists(path)) throw existsError(path, 'mount');
      symlinks.set(path, target);
      return;
    }
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
    files.set(path, decode(entryValue.data ?? entryValue.bytes ?? entryValue.content ?? entryValue));
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

  function snapshot({ copy = true } = {}) {
    const artifactList = artifactPaths().filter((path) => files.has(path)).map((path) => {
      const bytes = files.get(path);
      return {
        path,
        bytes: copy ? new Uint8Array(bytes) : bytes,
        size: bytes.byteLength,
      };
    });
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
    symlinks.clear();
    hardLinks.clear();
    metadata.clear();
    descriptors.clear();
    for (const mountRecord of mounts.values()) directories.add(mountRecord.path);
    for (const list of watchers.values()) for (const watcher of list) watcher.close();
    watchers.clear();
  }

  function setWarningEmitter(emitter) {
    warningEmitter = typeof emitter === 'function' ? emitter : null;
  }

  function collectGarbage() {
    for (const record of fileHandleRecords) {
      if (!descriptors.has(record.fd)) continue;
      warningEmitter?.(`Closing file descriptor ${record.fd} on garbage collection`);
      warningEmitter?.(
        'Closing a FileHandle object on garbage collection is deprecated. '
        + 'Please close FileHandle objects explicitly using '
        + 'FileHandle.prototype.close(). In the future, an error will be '
        + 'thrown if a file descriptor is closed during garbage collection.',
        { code: 'DEP0137', type: 'DeprecationWarning' },
      );
      closeDescriptor(record.fd);
    }
  }

  function asyncFsOperation(callback, operation) {
    if (typeof callback !== 'function') throw invalidPath('callback is required');
    const releaseRequest = activeRequestTracker?.('FSReqCallback');
    scheduleFsCallback(() => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseRequest?.();
      };
      try {
        const result = operation();
        const complete = (value) => {
          try {
            if (value === undefined) callback(null);
            else callback(null, value);
          } finally {
            release();
          }
        };
        const fail = (error) => {
          try { callback(error); }
          finally { release(); }
        };
        if (result && typeof result.then === 'function') result.then(complete, fail);
        else complete(result);
      } catch (error) {
        try { callback(error); }
        finally { release(); }
      }
    });
  }

  function close(handle, callback) {
    asyncFsOperation(callback, () => closeDescriptor(handle));
  }

  function open(pathValue, flags, mode, callback) {
    const done = typeof flags === 'function' ? flags : typeof mode === 'function' ? mode : callback;
    const openFlags = typeof flags === 'function' ? 'r' : flags;
    resolve(pathValue);
    asyncFsOperation(done, () => openDescriptor(pathValue, openFlags));
  }

  function mkdir(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    const options = typeof optionsValue === 'object' && optionsValue !== null ? optionsValue : {};
    resolve(pathValue);
    asyncFsOperation(done, () => makeDirectory(resolve(pathValue), options.recursive));
  }

  function rmdir(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    const options = typeof optionsValue === 'object' && optionsValue !== null ? optionsValue : {};
    if (options.recursive) warnRecursiveRmdir();
    resolve(pathValue);
    asyncFsOperation(done, () => removeDirectory(resolve(pathValue), options.recursive));
  }

  function mkdtemp(prefixValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    const options = typeof optionsValue === 'string'
      || (typeof optionsValue === 'object' && optionsValue !== null) ? optionsValue : {};
    resolve(prefixValue);
    asyncFsOperation(done, () => makeTemporaryDirectory(prefixValue, options));
  }

  function stat(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    resolve(pathValue);
    asyncFsOperation(done, () => statPath(resolve(pathValue)));
  }

  function statfs(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    const options = typeof optionsValue === 'function' ? undefined : optionsValue;
    resolve(pathValue);
    asyncFsOperation(done, () => statFsPath(pathValue, options));
  }

  function lstat(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    resolve(pathValue);
    asyncFsOperation(done, () => lstatPath(resolve(pathValue)));
  }

  function readdir(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    resolve(pathValue);
    asyncFsOperation(done, () => fs.readdirSync(pathValue, optionsValue));
  }

  function unlink(pathValue, callback) {
    resolve(pathValue);
    asyncFsOperation(callback, () => removeFile(resolve(pathValue)));
  }

  function renameAsync(sourceValue, destinationValue, callback) {
    resolve(sourceValue);
    resolve(destinationValue);
    asyncFsOperation(callback, () => rename(sourceValue, destinationValue));
  }

  function realpath(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    resolve(pathValue);
    asyncFsOperation(done, () => realpathPath(resolve(pathValue)));
  }

  function copyFileAsync(sourceValue, destinationValue, flags, callback) {
    const done = typeof flags === 'function' ? flags : callback;
    const copyFlags = typeof flags === 'number' ? flags : 0;
    resolve(sourceValue);
    resolve(destinationValue);
    asyncFsOperation(done, () => copyFile(sourceValue, destinationValue, copyFlags));
  }

  function truncateAsync(pathValue, length, callback) {
    const done = typeof length === 'function' ? length : callback;
    const size = truncateLength(typeof length === 'function' ? 0 : length);
    resolve(pathValue);
    asyncFsOperation(done, () => truncateSync(pathValue, size));
  }

  function ftruncate(handle, length, callback) {
    const done = typeof length === 'function' ? length : callback;
    const size = truncateLength(typeof length === 'function' || length === undefined ? 0 : length);
    truncateDescriptor(handle);
    asyncFsOperation(done, () => ftruncateSync(handle, size));
  }

  function readlinkAsync(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    resolve(pathValue);
    asyncFsOperation(done, () => readlinkValue(pathValue, optionsValue));
  }

  function rm(pathValue, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    const options = typeof optionsValue === 'object' && optionsValue !== null ? optionsValue : {};
    resolve(pathValue);
    asyncFsOperation(done, () => removeTree(resolve(pathValue), options.recursive, options.force));
  }

  const globApi = createGlob({
    resolvePath: resolve,
    listEntries: directoryEntries,
    statPath,
    lstatPath,
    roots() {
      const result = new Set();
      for (const path of [...files.keys(), ...directories, ...symlinks.keys()]) {
        const first = path.split('/').filter(Boolean)[0];
        if (first) result.add(`/${first}`);
      }
      return result;
    },
    makeDirent(candidate, stats) {
      const separator = candidate.lastIndexOf('/');
      return new Dirent(
        candidate.slice(separator + 1),
        stats._kind,
        candidate.slice(0, separator) || '/',
      );
    },
    invalidType: invalidArgumentType,
    invalidValue: invalidArgumentValue,
  });

  function glob(pathPattern, optionsValue, callback) {
    const done = typeof optionsValue === 'function' ? optionsValue : callback;
    const options = typeof optionsValue === 'function' ? undefined : optionsValue;
    asyncFsOperation(done, () => globApi.globSync(pathPattern, options));
  }

  async function* promiseGlob(pathPattern, optionsValue) {
    await waitForMutations();
    yield* globApi.glob(pathPattern, optionsValue);
  }

  async function* promiseWatch(pathValue, optionsValue) {
    const options = watchOptions(optionsValue, false);
    const watcher = watch(pathValue, options);
    try {
      for await (const event of watcher) yield event;
    } finally {
      watcher.close();
    }
  }

  const fs = {
    Dir,
    Dirent,
    Stats,
    ReadStream,
    WriteStream,
    FileReadStream: ReadStream,
    FileWriteStream: WriteStream,
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    writeFileSync: writeFile,
    readFileSync: readFile,
    appendFileSync: appendFile,
    accessSync(pathValue) { statPath(resolve(pathValue)); },
    copyFileSync: copyFile,
    cpSync: copyTree,
    globSync: globApi.globSync,
    glob,
    chmodSync(pathValue, mode) { updateMode(pathValue, mode); },
    chownSync(pathValue, uid, gid) {
      updateOwner(pathValue, ownerId(uid, 'uid'), ownerId(gid, 'gid'));
    },
    lchownSync,
    lchmodSync,
    linkSync,
    utimesSync,
    lutimesSync,
    futimesSync,
    _toUnixTimestamp(value) { return timestampValue(value) / 1000; },
    fchmodSync(value, mode) { updateDescriptorMode(value, mode); },
    fchownSync(value, uid, gid) {
      updateDescriptorOwner(value, ownerId(uid, 'uid'), ownerId(gid, 'gid'));
    },
    fdatasyncSync(value) { syncDescriptor(value); },
    fsyncSync(value) { syncDescriptor(value); },
    realpathSync: realpathPath,
    truncateSync,
    ftruncateSync,
    mkdtempSync: makeTemporaryDirectory,
    symlinkSync,
    linkSync,
    readlinkSync: readlinkValue,
    existsSync(pathValue) {
      try { statPath(resolve(pathValue)); return true; } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ERR_CAPABILITY_DENIED'
          || error.code === 'ERR_INVALID_PATH' || error.code === 'ERR_INVALID_ARG_TYPE') return false;
        throw error;
      }
    },
    exists(pathValue, callback) {
      if (typeof callback !== 'function') {
        const received = callback === undefined ? 'undefined' : callback === null ? 'null' : typeof callback;
        const error = new TypeError(`The "callback" argument must be of type function. Received ${received}`);
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      scheduleFsCallback(() => {
        let result = false;
        try { result = fs.existsSync(pathValue); } catch { result = false; }
        callback(result);
      });
    },
    unlinkSync(pathValue) { removeFile(resolve(pathValue)); },
    rmSync(pathValue, optionsValue = {}) { removeTree(resolve(pathValue), optionsValue.recursive, optionsValue.force); },
    rmdirSync(pathValue, optionsValue = {}) {
      if (optionsValue.recursive) warnRecursiveRmdir();
      removeDirectory(resolve(pathValue), optionsValue.recursive);
    },
    mkdirSync(pathValue, optionsValue = {}) { return makeDirectory(resolve(pathValue), optionsValue.recursive); },
    statSync(pathValue) { return statPath(resolve(pathValue)); },
    lstatSync(pathValue) { return lstatPath(resolve(pathValue)); },
    statfsSync(pathValue, optionsValue) { return statFsPath(resolve(pathValue), optionsValue); },
    readdirSync(pathValue, optionsValue) {
      return entriesFor(pathValue, optionsValue);
    },
    opendirSync(pathValue, optionsValue = {}) {
      return createDirectoryHandle(pathValue, optionsValue);
    },
    renameSync: rename,
    symlink,
    openSync(pathValue, flags = 'r') { return openDescriptor(pathValue, flags); },
    open,
    closeSync(handle) { closeDescriptor(handle); },
    close,
    readSync(handle, buffer, offset, length, position) {
      return readDescriptor(handle, buffer, offset, length, position).bytesRead;
    },
    writeSync(handle, data, offset, length, position) {
      return writeDescriptor(handle, data, offset, length, position).bytesWritten;
    },
    readvSync,
    writevSync,
    readv,
    writev,
    read(handle, buffer, offset, length, position, callback) {
      if (!ArrayBuffer.isView(buffer) && buffer && typeof buffer === 'object') {
        const options = buffer;
        callback = offset;
        buffer = options.buffer;
        offset = options.offset ?? 0;
        length = options.length ?? buffer?.length - offset;
        position = options.position;
      } else if (!ArrayBuffer.isView(offset) && offset && typeof offset === 'object') {
        const options = offset;
        callback = length;
        offset = options.offset ?? 0;
        length = options.length ?? buffer?.length - offset;
        position = options.position;
      }
      const done = typeof position === 'function' ? position : callback;
      const at = typeof position === 'function' ? null : position;
      if (typeof done !== 'function') throw invalidPath('callback is required');
      scheduleFsCallback(() => {
        try {
          const result = readDescriptor(handle, buffer, offset, length, at);
          done(null, result.bytesRead, result.buffer);
        } catch (error) { done(error); }
      });
    },
    write(handle, data, offset, length, position, callback) {
      const dataLength = data?.byteLength ?? data?.length ?? 0;
      if (typeof offset === 'object' && offset !== null && !ArrayBuffer.isView(offset)) {
        const options = offset;
        callback = length;
        offset = options.offset ?? 0;
        length = options.length ?? dataLength - offset;
        position = options.position;
      } else if (typeof offset === 'function') {
        callback = offset;
        offset = 0;
        length = dataLength;
        position = null;
      } else if (typeof length === 'function') {
        callback = length;
        offset ??= 0;
        length = dataLength - (offset ?? 0);
        position = null;
      } else {
        offset ??= 0;
        length ??= dataLength - offset;
      }
      if (!Number.isInteger(offset) || offset < 0) throw outOfRange('offset', offset);
      if (length !== undefined && (!Number.isInteger(length) || length < 0)) throw outOfRange('length', length);
      if (typeof position !== 'function' && position !== null && position !== undefined
        && (!Number.isInteger(position) || position < 0)) throw outOfRange('position', position);
      const done = typeof position === 'function' ? position : callback;
      const at = typeof position === 'function' ? null : position;
      if (typeof done !== 'function') throw invalidPath('callback is required');
      scheduleFsCallback(() => {
        try {
          const result = writeDescriptor(handle, data, offset, length, at);
          done(null, result.bytesWritten, result.buffer);
        } catch (error) { done(error); }
      });
    },
    fstatSync(handle) { return statPath(descriptor(handle).path); },
    fstat(handle, callback) {
      asyncFsOperation(callback, () => fs.fstatSync(handle));
    },
    stat,
    statfs,
    lstat,
    readdir,
    opendir(pathValue, optionsValue, callback) {
      const done = typeof optionsValue === 'function' ? optionsValue : callback;
      const options = typeof optionsValue === 'object' && optionsValue !== null ? optionsValue : {};
      resolve(pathValue);
      asyncFsOperation(done, () => createDirectoryHandle(pathValue, options));
    },
    mkdir,
    rmdir,
    mkdtemp,
    unlink,
    rename: renameAsync,
    realpath,
    copyFile: copyFileAsync,
    cp(pathValue, destinationValue, optionsValue, callback) {
      const done = typeof optionsValue === 'function' ? optionsValue : callback;
      const options = typeof optionsValue === 'function' ? undefined : copyOptions(optionsValue);
      resolve(pathValue);
      resolve(destinationValue);
      asyncFsOperation(done, () => copyTreeAsync(pathValue, destinationValue, options));
    },
    rm,
    chmod,
    chown,
    lchown,
    lchmod,
    link,
    lutimes,
    utimes,
    futimes,
    fchmod,
    fchown,
    fdatasync,
    fsync,
    truncate: truncateAsync,
    ftruncate,
    readlink: readlinkAsync,
    openAsBlob,
    createReadStream,
    createWriteStream,
    readFile,
    writeFile,
    appendFile,
    access(pathValue, mode, callback) {
      const done = typeof mode === 'function' ? mode : callback;
      resolve(pathValue);
      if (typeof done !== 'function') {
        statPath(resolve(pathValue));
        return;
      }
      scheduleFsCallback(() => {
        try {
          statPath(resolve(pathValue));
          done();
        } catch (error) { done(error); }
      });
    },
    watch,
  };

  const promises = {
    async writeFile(...args) { return enqueueMutation(() => writeFile(...args)); },
    async readFile(...args) { await waitForMutations(); return readFile(...args); },
    async appendFile(...args) { return enqueueMutation(() => appendFile(...args)); },
    async exists(...args) { await waitForMutations(); return fs.existsSync(...args); },
    async access(...args) { await waitForMutations(); return fs.accessSync(...args); },
    async copyFile(...args) { return enqueueMutation(() => copyFile(...args)); },
    async cp(...args) { return enqueueMutation(() => copyTreeAsync(...args)); },
    glob: promiseGlob,
    async realpath(...args) { await waitForMutations(); return fs.realpathSync(...args); },
    async truncate(...args) { return enqueueMutation(() => truncate(...args)); },
    async chmod(...args) { return enqueueMutation(() => fs.chmodSync(...args)); },
    async chown(...args) { return enqueueMutation(() => fs.chownSync(...args)); },
    async lchown(...args) { return enqueueMutation(() => fs.lchownSync(...args)); },
    async lchmod(...args) { return enqueueMutation(() => lchmodSync(...args)); },
    async link(...args) { return enqueueMutation(() => fs.linkSync(...args)); },
    async lutimes(...args) { return enqueueMutation(() => fs.lutimesSync(...args)); },
    async utimes(...args) { return enqueueMutation(() => fs.utimesSync(...args)); },
    async readlink(...args) { await waitForMutations(); return fs.readlinkSync(...args); },
    async symlink(...args) { return enqueueMutation(() => fs.symlinkSync(...args)); },
    async rm(...args) { return enqueueMutation(() => fs.rmSync(...args)); },
    async rmdir(...args) { return enqueueMutation(() => fs.rmdirSync(...args)); },
    async mkdtemp(...args) { return enqueueMutation(() => fs.mkdtempSync(...args)); },
    async unlink(...args) { return enqueueMutation(() => fs.unlinkSync(...args)); },
    async mkdir(...args) { return enqueueMutation(() => fs.mkdirSync(...args)); },
    async stat(...args) { await waitForMutations(); return fs.statSync(...args); },
    async statfs(...args) { await waitForMutations(); return fs.statfsSync(...args); },
    async lstat(...args) { await waitForMutations(); return fs.lstatSync(...args); },
    async readdir(...args) { await waitForMutations(); return fs.readdirSync(...args); },
    async opendir(pathValue, optionsValue = {}) {
      await waitForMutations();
      return createDirectoryHandle(pathValue, optionsValue);
    },
    async rename(...args) { return enqueueMutation(() => fs.renameSync(...args)); },
    async open(pathValue, flags = 'r') {
      return enqueueMutation(() => fileHandle(openDescriptor(pathValue, flags)));
    },
    async readv(handle, buffers, position) {
      await waitForMutations();
      return { bytesRead: readvSync(handle, buffers, position), buffers };
    },
    async writev(handle, buffers, position) {
      await waitForMutations();
      return { bytesWritten: writevSync(handle, buffers, position), buffers };
    },
    watch: promiseWatch,
  };

  configureMounts(options.mounts);
  configureFixtures(options.fixtures);

  const fileIndex = Object.freeze({
    has(pathValue) {
      try { return files.has(resolvePath(resolve(pathValue))); } catch { return false; }
    },
  });

  return {
    setTaskTracker(tracker) {
      taskTracker = typeof tracker === 'function' ? tracker : null;
    },
    setActiveRequestTracker(tracker) {
      activeRequestTracker = typeof tracker === 'function' ? tracker : null;
    },
    setWarningEmitter,
    collectGarbage,
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
    readDescriptor: readDescriptorAsync,
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
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) {
    throw invalidPath('file URL host is not supported');
  }
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    throw invalidPath('file URL contains malformed escaping');
  }
}
