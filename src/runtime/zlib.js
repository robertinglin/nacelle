import { AsyncResource } from './async-hooks.js';
import { Transform } from './streams.js';
import { UnsupportedWebCapabilityError } from './errors.js';
import { fileURLToPath } from './vfs.js';

let nodeFs = null;
try {
  if (typeof process !== 'undefined' && process.versions?.node) {
    nodeFs = await import('node:fs');
  }
} catch {}

function loadWasmBytes(name) {
  if (globalThis.__BNH_WASM_CACHE__?.[name]) {
    return globalThis.__BNH_WASM_CACHE__[name];
  }
  const candidateUrls = [
    new URL(`../wasm/v22/${name}.wasm`, import.meta.url),
    new URL(`../wasm/${name}.wasm`, import.meta.url),
    new URL(`../v22/wasm/${name}.wasm`, import.meta.url),
    new URL(`./wasm/v22/${name}.wasm`, import.meta.url),
    new URL(`./wasm/${name}.wasm`, import.meta.url),
  ];
  if (typeof location !== 'undefined' && location.origin) {
    candidateUrls.push(
      new URL(`/wasm/v22/${name}.wasm`, location.origin),
      new URL(`/wasm/${name}.wasm`, location.origin),
      new URL(`/src/wasm/v22/${name}.wasm`, location.origin)
    );
  }
  if (nodeFs) {
    for (const candidate of candidateUrls) {
      try {
        const filePath = candidate.protocol === 'file:' ? fileURLToPath(candidate.href) : candidate.pathname;
        if (nodeFs.existsSync(filePath)) {
          return nodeFs.readFileSync(filePath);
        }
      } catch {}
    }
  }
  if (globalThis.__BNH_VFS__?.fs?.readFileSync) {
    for (const virtualPath of [`/node/internal/deps/${name}.node`, `/node/internal/deps/${name}.wasm`]) {
      try {
        const bytes = globalThis.__BNH_VFS__.fs.readFileSync(virtualPath);
        if (bytes && bytes.byteLength > 0) return bytes;
      } catch {}
    }
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    for (const candidate of candidateUrls) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', candidate.href, false);
        xhr.responseType = 'arraybuffer';
        xhr.send(null);
        if (xhr.status === 200 && xhr.response) {
          const bytes = new Uint8Array(xhr.response);
          if (bytes.byteLength > 0) {
            globalThis.__BNH_WASM_CACHE__ = globalThis.__BNH_WASM_CACHE__ || {};
            globalThis.__BNH_WASM_CACHE__[name] = bytes;
            return bytes;
          }
        }
      } catch {}
    }
  }
  return null;
}

const wasmInstances = Object.create(null);
const wasmModules = Object.create(null);
const wasmImports = {
  env: { emscripten_notify_memory_growth() {} },
  // Brotli is built with WASI even though it only needs proc_exit from that
  // namespace. Keep this import available for every codec so the shared
  // loader has the same contract for all bundled WASM artifacts.
  wasi_snapshot_preview1: {
    proc_exit() {},
  },
};

function getWasmModule(name) {
  if (Object.hasOwn(wasmModules, name)) return wasmModules[name];
  const bytes = loadWasmBytes(name);
  wasmModules[name] = bytes
    ? new WebAssembly.Module(bytes)
    : null;
  return wasmModules[name];
}

function createWasmInstance(name) {
  const module = getWasmModule(name);
  return module ? new WebAssembly.Instance(module, wasmImports) : null;
}

function getWasmInstance(name) {
  if (!wasmInstances[name]) {
    wasmInstances[name] = createWasmInstance(name);
  }
  return wasmInstances[name];
}

const SymbolNodeAsyncDispose = Symbol.for('nodejs.asyncDispose');
const SymbolAsyncDispose = Symbol.asyncDispose || SymbolNodeAsyncDispose;

// The browser Compression Streams API currently standardizes gzip, deflate,
// and (in newer engines) deflate-raw. Brotli and zstd remain capability
// dependent, so their constructors are exposed with the same stream shape and
// fail when the browser cannot construct the requested format.
const constants = Object.freeze({
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_TREES: 6,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_FILTERED: 1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_HUFFMAN_ONLY: 2,
  Z_MAX_CHUNK: Infinity,
  Z_MAX_LEVEL: 9,
  Z_MAX_MEMLEVEL: 9,
  Z_MAX_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MIN_LEVEL: -1,
  Z_MIN_MEMLEVEL: 1,
  Z_MIN_WINDOWBITS: 8,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  ZLIB_VERNUM: 4897,
  ZSTD_CLEVEL_DEFAULT: 3,
  ZSTD_btlazy2: 6,
  ZSTD_btopt: 7,
  ZSTD_btultra: 8,
  ZSTD_btultra2: 9,
  ZSTD_e_continue: 0,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_chainLog: 103,
  ZSTD_c_checksumFlag: 201,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_dictIDFlag: 202,
  ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_hashLog: 102,
  ZSTD_c_jobSize: 401,
  ZSTD_c_ldmBucketSizeLog: 163,
  ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_ldmHashLog: 161,
  ZSTD_c_ldmMinMatch: 162,
  ZSTD_c_minMatch: 105,
  ZSTD_error_GENERIC: 1,
  ZSTD_error_checksum_wrong: 22,
  ZSTD_error_corruption_detected: 20,
  ZSTD_error_dictionaryCreation_failed: 34,
  ZSTD_error_dictionary_corrupted: 30,
  ZSTD_error_dictionary_wrong: 32,
  ZSTD_error_dstBuffer_null: 74,
  ZSTD_error_dstSize_tooSmall: 70,
  ZSTD_error_frameParameter_unsupported: 14,
  ZSTD_error_frameParameter_windowTooLarge: 16,
  ZSTD_error_init_missing: 62,
  ZSTD_error_literals_headerWrong: 24,
  ZSTD_error_maxSymbolValue_tooLarge: 46,
  ZSTD_error_maxSymbolValue_tooSmall: 48,
  ZSTD_error_memory_allocation: 64,
  ZSTD_error_noForwardProgress_destFull: 80,
  ZSTD_error_noForwardProgress_inputEmpty: 82,
  ZSTD_error_no_error: 0,
  ZSTD_error_parameter_combination_unsupported: 41,
  ZSTD_error_parameter_outOfBound: 42,
  ZSTD_error_parameter_unsupported: 40,
  ZSTD_error_prefix_unknown: 10,
  ZSTD_error_version_unsupported: 12,
  ZSTD_error_workSpace_tooSmall: 66,
  ZSTD_error_srcSize_wrong: 72,
  ZSTD_error_stabilityCondition_notRespected: 50,
  ZSTD_error_stage_wrong: 60,
  ZSTD_error_tableLog_tooLarge: 44,
  ZSTD_c_nbWorkers: 400,
  ZSTD_c_overlapLog: 402,
  ZSTD_c_searchLog: 104,
  ZSTD_c_strategy: 107,
  ZSTD_c_targetLength: 106,
  ZSTD_c_windowLog: 101,
  ZSTD_d_windowLogMax: 100,
  ZSTD_dfast: 2,
  ZSTD_fast: 1,
  ZSTD_greedy: 3,
  ZSTD_lazy: 4,
  ZSTD_lazy2: 5,
  Z_DEFAULT_CHUNK: 16384,
  Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_LEVEL: -1,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_DEFAULT_STRATEGY: 0,
  Z_DEFAULT_WINDOWBITS: 15,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_RESULT_SUCCESS: 1,
  BROTLI_DECODER_SUCCESS: 1,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
  BROTLI_DECODER_NO_ERROR: 0,
  BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
  BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
  BROTLI_DECODER_ERROR_UNREACHABLE: -31,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_DEFAULT_MODE: 0,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_DEFAULT_WINDOW: 22,
  BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
  BROTLI_PARAM_MODE: 0,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_PARAM_SIZE_HINT: 5,
  BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_NPOSTFIX: 7,
  BROTLI_PARAM_NDIRECT: 8,
  BROTLI_DECODER_RESULT_ERROR: 0,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
  ZSTD_COMPRESS: 10,
  ZSTD_DECOMPRESS: 11,
});

const codes = {
  Z_OK: constants.Z_OK,
  Z_STREAM_END: constants.Z_STREAM_END,
  Z_NEED_DICT: constants.Z_NEED_DICT,
  Z_ERRNO: constants.Z_ERRNO,
  Z_STREAM_ERROR: constants.Z_STREAM_ERROR,
  Z_DATA_ERROR: constants.Z_DATA_ERROR,
  Z_MEM_ERROR: constants.Z_MEM_ERROR,
  Z_BUF_ERROR: constants.Z_BUF_ERROR,
  Z_VERSION_ERROR: constants.Z_VERSION_ERROR,
};
for (const [name, value] of Object.entries(codes)) codes[value] = name;
Object.freeze(codes);

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  CRC32_TABLE[index] = value >>> 0;
}

function formatUnsupported(format, mode, error) {
  const result = new UnsupportedWebCapabilityError(
    `CompressionStream(${format})`,
    `${format} ${mode} is not supported by the browser Compression Streams API`,
  );
  result.cause = error;
  return result;
}

function createWebTransform(scope, format, mode) {
  const Constructor = mode === 'compress'
    ? scope.CompressionStream
    : scope.DecompressionStream;
  if (typeof Constructor !== 'function') {
    throw formatUnsupported(format, mode);
  }
  // zlib is created before the runtime installs Node-compatible web streams
  // on the page global. Keep compression on the browser-native stream graph;
  // otherwise the shim recursively constructs itself and mixes stream brands.
  // Never substitute a different wire format: mislabeled deflate is worse than
  // an explicit unsupported-boundary error for callers negotiating Brotli.
  const nativeFormat = format;
  try {
    return new Constructor(nativeFormat);
  } catch (error) {
    throw formatUnsupported(format, mode, error);
  }
}

class NativeZlibCodec {
  constructor(scope, format, mode, onOutput) {
    this._scope = scope;
    this._stream = createWebTransform(scope, format, mode);
    if (!this._stream?.writable?.getWriter || !this._stream?.readable?.getReader) {
      throw formatUnsupported(format, mode, new TypeError('compression stream lacks reader/writer access'));
    }
    this._writer = this._stream.writable.getWriter();
    this._reader = this._stream.readable.getReader();
    this._onOutput = onOutput;
    this._closed = false;
    this._firstOutputSent = false;
    this._pendingOutput = [];
    this._pendingOutputBytes = 0;
    this._pumpPromise = this._pump();
    this._pumpPromise.catch(() => {});
  }

  _emitOutput(value, force = false) {
    if (value?.byteLength) {
      if (!this._firstOutputSent) {
        this._firstOutputSent = true;
        this._onOutput(value);
        return;
      }
      this._pendingOutput.push(value);
      this._pendingOutputBytes += value.byteLength;
    }
    if (!force && this._pendingOutputBytes < 256 * 1024) return;
    if (!this._pendingOutputBytes) return;
    this._onOutput(concatenateBytes(this._pendingOutput));
    this._pendingOutput.length = 0;
    this._pendingOutputBytes = 0;
  }

  async _pump() {
    let bytesSinceYield = 0;
    try {
      while (true) {
        const { value, done } = await this._reader.read();
        if (done) {
          this._emitOutput(null, true);
          return;
        }
        if (value?.byteLength) {
          const output = toUint8Array(value);
          this._emitOutput(output);
          bytesSinceYield += output.byteLength;
          if (bytesSinceYield >= 1024 * 1024) {
            this._emitOutput(null, true);
            bytesSinceYield = 0;
            await new Promise((resolve) => (this._scope.setTimeout || setTimeout)(resolve, 0));
          }
        }
      }
    } finally {
      this._reader.releaseLock?.();
    }
  }

  write(value) {
    if (this._closed) return Promise.reject(new Error('compression stream is closed'));
    return this._writer.write(toUint8Array(value));
  }

  async finish() {
    if (this._closed) return;
    this._closed = true;
    await this._writer.close();
    await this._pumpPromise;
  }

  async abort(reason) {
    if (this._closed) return;
    this._closed = true;
    try { await this._writer.abort(reason); } catch {}
    try { await this._reader.cancel(reason); } catch {}
    await this._pumpPromise.catch(() => {});
  }
}

function zlibDataError(error) {
  const result = new Error('incorrect header check');
  result.code = 'Z_DATA_ERROR';
  result.errno = -3;
  result.cause = error;
  return result;
}

function receivedType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `type ${typeof value} (${value})`;
  }
  return `an instance of ${value?.constructor?.name || typeof value}`;
}

function invalidBufferType(value) {
  const error = new TypeError(
    'The "buffer" argument must be of type string or an instance of Buffer, ' +
    `TypedArray, DataView, or ArrayBuffer. Received ${receivedType(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function validateBuffer(value) {
  if (typeof value === 'string' || ArrayBuffer.isView(value) ||
      Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return;
  }
  throw invalidBufferType(value);
}

function validateBrotliOptions(options) {
  if (!options?.params) return;
  for (const origKey of Object.keys(options.params)) {
    const key = +origKey;
    if (!Number.isInteger(key) || key < 0 || key > constants.BROTLI_PARAM_NDIRECT) {
      const error = new Error(`Invalid Brotli parameter: ${origKey}`);
      error.code = 'ERR_BROTLI_INVALID_PARAM';
      throw error;
    }
    const value = options.params[origKey];
    if (typeof value !== 'number' && typeof value !== 'boolean') {
      const error = new TypeError(
        `The "options.params[key]" argument must be of type number. Received ${receivedType(value)}`,
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
  }
}

function checkZlibParam(value, name, lower, upper, defaultValue) {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  if (typeof value !== 'number') {
    const error = new TypeError(
      `The "${name}" argument must be of type number. Received ${receivedType(value)}`,
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isFinite(value)) {
    const error = new RangeError(
      `The value of "${name}" must be a finite number. Received ${value}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (value < lower || value > upper) {
    const error = new RangeError(
      `The value of "${name}" is out of range. It must be >= ${lower} and <= ${upper}. Received ${value}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  return value;
}

function zlibParams(level, strategy, callback) {
  checkZlibParam(level, 'level', constants.Z_MIN_LEVEL, constants.Z_MAX_LEVEL);
  checkZlibParam(strategy, 'strategy', constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED);

  const apply = () => queueMicrotask(() => {
    if (!this._handle) {
      const error = new Error(
        'zlib binding closed\n' +
        'This is caused by either a bug in Node.js or incorrect usage of Node.js internals.',
      );
      error.code = 'ERR_INTERNAL_ASSERTION';
      throw error;
    }
    this._level = level;
    this._strategy = strategy;
    if (callback) callback();
  });

  if (this._level !== level || this._strategy !== strategy) {
    this.flush(constants.Z_SYNC_FLUSH, apply);
  } else if (typeof callback === 'function') {
    queueMicrotask(callback);
  }
}

function zlibAbortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

async function zlibAsyncDispose() {
  let error;
  const completion = this.closed
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      const onClose = () => {
        this.off?.('error', onError);
        resolve();
      };
      const onError = (cause) => {
        if (cause !== error) {
          this.off?.('close', onClose);
          reject(cause);
        }
      };
      this.once('close', onClose);
      this.once('error', onError);
    });

  if (!this.destroyed) {
    error = this.readableEnded ? null : zlibAbortError();
    this.destroy(error);
  }
  await completion;
}

class ZlibHandle {
  constructor() { this._resource = new AsyncResource('ZLIB'); }
  getAsyncId() { return this._resource.asyncId(); }
  asyncId() { return this.getAsyncId(); }
  triggerAsyncId() { return this._resource.triggerAsyncId(); }
  close() { this._resource.emitDestroy(); }
}

const ZLIB_STREAM_SIZE = 56;
const ZLIB_INPUT_CHUNK_SIZE = 64 * 1024;
const ZLIB_OUTPUT_CHUNK_SIZE = 1024 * 1024;

function zlibStreamWindowBits(format) {
  if (format === 'gzip') return 31;
  if (format === 'deflate-raw') return -15;
  return 15;
}

function zlibWasmUnavailable(format, mode) {
  const error = new Error(`zlib.wasm cannot stream ${format} ${mode}`);
  error.code = 'ERR_ZLIB_WASM_UNAVAILABLE';
  return error;
}

class WasmZlibCodec {
  constructor(format, mode, options = {}) {
    if (!['gzip', 'deflate', 'deflate-raw'].includes(format)) {
      throw zlibWasmUnavailable(format, mode);
    }
    this._instance = createWasmInstance('zlib');
    if (!this._instance) throw zlibWasmUnavailable(format, mode);
    this._exports = this._instance.exports;
    this._memory = this._exports.memory;
    this._format = format;
    this._mode = mode;
    this._stream = this._exports.malloc(ZLIB_STREAM_SIZE);
    this._input = this._exports.malloc(ZLIB_INPUT_CHUNK_SIZE);
    this._output = this._exports.malloc(ZLIB_OUTPUT_CHUNK_SIZE);
    this._version = this._exports.malloc(16);
    this._initialized = false;
    try {
      new Uint8Array(this._memory.buffer, this._stream, ZLIB_STREAM_SIZE).fill(0);
      new Uint8Array(this._memory.buffer).set(new TextEncoder().encode('1.3.1\0'), this._version);
      const status = this._initialize(options);
      if (status !== constants.Z_OK) {
        const error = new Error(`zlib initialization failed with status ${status}`);
        error.code = 'ERR_ZLIB_INITIALIZATION_FAILED';
        throw error;
      }
      this._initialized = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  _initialize(options) {
    const windowBits = zlibStreamWindowBits(this._format);
    const level = options.level ?? constants.Z_DEFAULT_COMPRESSION;
    const strategy = options.strategy ?? constants.Z_DEFAULT_STRATEGY;
    if (this._mode === 'compress') {
      checkZlibParam(level, 'level', constants.Z_MIN_LEVEL, constants.Z_MAX_LEVEL);
      checkZlibParam(strategy, 'strategy', constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED);
      if (typeof this._exports.deflateInit2_ === 'function') {
        return this._exports.deflateInit2_(
          this._stream,
          level,
          8,
          windowBits,
          options.memLevel ?? constants.Z_DEFAULT_MEMLEVEL,
          strategy,
          this._version,
          ZLIB_STREAM_SIZE,
        );
      }
      if (this._format === 'deflate' && typeof this._exports.deflateInit_ === 'function') {
        return this._exports.deflateInit_(this._stream, level, this._version, ZLIB_STREAM_SIZE);
      }
    } else {
      if (typeof this._exports.inflateInit2_ === 'function') {
        return this._exports.inflateInit2_(this._stream, windowBits, this._version, ZLIB_STREAM_SIZE);
      }
      if (this._format === 'deflate' && typeof this._exports.inflateInit_ === 'function') {
        return this._exports.inflateInit_(this._stream, this._version, ZLIB_STREAM_SIZE);
      }
    }
    throw zlibWasmUnavailable(this._format, this._mode);
  }

  process(value, flush) {
    const input = toUint8Array(value);
    const output = [];
    let offset = 0;
    if (!input.byteLength) {
      this._processInput(input, flush, output);
      return output;
    }
    while (offset < input.byteLength) {
      const end = Math.min(offset + ZLIB_INPUT_CHUNK_SIZE, input.byteLength);
      const block = input.subarray(offset, end);
      this._processInput(block, flush, output);
      offset = end;
    }
    return output;
  }

  _processInput(input, flush, output) {
    const transform = this._mode === 'compress'
      ? this._exports.deflate
      : this._exports.inflate;
    const inputBytes = new Uint8Array(this._memory.buffer, this._input, input.byteLength);
    inputBytes.set(input);
    let offset = 0;
    let status = constants.Z_OK;
    let iterations = 0;
    do {
      iterations += 1;
      if (iterations > 10000) {
        const error = new Error('zlib.wasm made no bounded progress');
        error.code = 'ERR_ZLIB_PROCESSING_FAILED';
        throw error;
      }
      const view = new DataView(this._memory.buffer);
      view.setUint32(this._stream, this._input + offset, true);
      view.setUint32(this._stream + 4, input.byteLength - offset, true);
      view.setUint32(this._stream + 12, this._output, true);
      view.setUint32(this._stream + 16, ZLIB_OUTPUT_CHUNK_SIZE, true);
      status = transform(this._stream, flush);
      const remainingInput = view.getUint32(this._stream + 4, true);
      const availableOutput = view.getUint32(this._stream + 16, true);
      const consumed = input.byteLength - offset - remainingInput;
      const produced = ZLIB_OUTPUT_CHUNK_SIZE - availableOutput;
      if (consumed < 0 || consumed > input.byteLength - offset) {
        throw new Error('zlib.wasm reported an invalid input count');
      }
      if (produced) {
        output.push(new Uint8Array(this._memory.buffer, this._output, produced).slice());
      }
      offset += consumed;
      if (status === constants.Z_STREAM_END) return;
      if (status < 0 && status !== constants.Z_BUF_ERROR) {
        const error = new Error(`zlib processing failed with status ${status}`);
        error.code = this._mode === 'decompress' ? 'Z_DATA_ERROR' : 'ERR_ZLIB_PROCESSING_FAILED';
        throw error;
      }
      const inputRemaining = input.byteLength - offset;
      if (!inputRemaining && availableOutput > 0) return;
      if (!consumed && !produced) {
        if (flush === constants.Z_FINISH) {
          const error = new Error('zlib.wasm made no progress while finishing');
          error.code = this._mode === 'decompress' ? 'Z_DATA_ERROR' : 'ERR_ZLIB_PROCESSING_FAILED';
          throw error;
        }
        return;
      }
    } while (offset < input.byteLength || flush === constants.Z_FINISH);
  }

  close() {
    if (!this._instance) return;
    try {
      if (this._initialized) {
        const close = this._mode === 'compress'
          ? this._exports.deflateEnd
          : this._exports.inflateEnd;
        close?.(this._stream);
      }
    } finally {
      this._initialized = false;
      this._exports.free(this._stream);
      this._exports.free(this._input);
      this._exports.free(this._output);
      this._exports.free(this._version);
      this._instance = null;
    }
  }
}

class ZlibStream extends Transform {
  constructor(format, mode, bufferClass, scope = globalThis, options = {}) {
    const chunks = [];
    super({
      transform(chunk, _encoding, callback) {
        this.bytesWritten += chunk.byteLength ?? chunk.length ?? 0;
        const input = toUint8Array(chunk);
        try {
          if (!this._nativeCodec && !this._nativeCodecUnavailable
            && (input.byteLength || typeof this._zlibFormat !== 'function')) {
            const streamFormat = typeof this._zlibFormat === 'function'
              ? this._zlibFormat([input])
              : this._zlibFormat;
            try {
              this._nativeCodec = new NativeZlibCodec(
                this._zlibScope,
                streamFormat,
                this._zlibMode,
                (output) => this.push(this._zlibBufferClass ? new this._zlibBufferClass(output) : output),
              );
            } catch (error) {
              if (error?.code !== 'ERR_UNSUPPORTED_WEB_CAPABILITY') throw error;
              this._nativeCodecUnavailable = true;
            }
          }
          if (this._nativeCodec) {
            this._nativeCodec.write(input).then(
              () => callback(),
              (error) => callback(this._zlibMode === 'decompress' ? zlibDataError(error) : error),
            );
            return;
          }
          if (!this._zlibCodec && !this._zlibCodecUnavailable
            && (input.byteLength || typeof this._zlibFormat !== 'function')) {
            const streamFormat = typeof this._zlibFormat === 'function'
              ? this._zlibFormat([input])
              : this._zlibFormat;
            try {
              this._zlibCodec = new WasmZlibCodec(streamFormat, this._zlibMode, this._zlibOptions);
            } catch (error) {
              if (error?.code !== 'ERR_ZLIB_WASM_UNAVAILABLE') throw error;
              this._zlibCodecUnavailable = true;
            }
          }
          if (this._zlibCodec) {
            for (const output of this._zlibCodec.process(input, constants.Z_NO_FLUSH)) {
              this.push(this._zlibBufferClass ? new this._zlibBufferClass(output) : output);
            }
          } else {
            chunks.push(chunk);
          }
          callback();
        } catch (error) {
          callback(error);
        }
      },
    });
    this._zlibChunks = chunks;
    this._zlibFormat = format;
    this._zlibMode = mode;
    this._zlibBufferClass = bufferClass;
    this._zlibScope = scope;
    this._zlibOptions = options;
    this._nativeCodec = null;
    this._nativeCodecUnavailable = false;
    this._zlibCodec = null;
    this._zlibCodecUnavailable = false;
    this._syncChunks = [];
    this._zlibMaxFlushFlag = format === 'zstd' ? 2 : 5;
    this.bytesWritten = 0;
    this._handle = new ZlibHandle();
  }

  _flush(callback) {
    if (!this._nativeCodec && !this._nativeCodecUnavailable && typeof this._zlibFormat === 'string') {
      try {
        this._nativeCodec = new NativeZlibCodec(
          this._zlibScope,
          this._zlibFormat,
          this._zlibMode,
          (output) => this.push(this._zlibBufferClass ? new this._zlibBufferClass(output) : output),
        );
      } catch (error) {
        if (error?.code !== 'ERR_UNSUPPORTED_WEB_CAPABILITY') {
          callback(this._zlibMode === 'decompress' ? zlibDataError(error) : error);
          return;
        }
        this._nativeCodecUnavailable = true;
      }
    }
    if (this._nativeCodec) {
      this._nativeCodec.finish().then(
        () => {
          this._nativeCodec = null;
          callback();
        },
        (error) => callback(this._zlibMode === 'decompress' ? zlibDataError(error) : error),
      );
      return;
    }
    if (this._zlibCodec) {
      try {
        for (const output of this._zlibCodec.process(new Uint8Array(0), constants.Z_FINISH)) {
          this.push(this._zlibBufferClass ? new this._zlibBufferClass(output) : output);
        }
        this._zlibCodec.close();
        this._zlibCodec = null;
        callback();
      } catch (error) {
        callback(this._zlibMode === 'decompress' ? zlibDataError(error) : error);
      }
      return;
    }
    let transformed;
    try {
      const streamFormat = typeof this._zlibFormat === 'function'
        ? this._zlibFormat(this._zlibChunks)
        : this._zlibFormat;
      transformed = webTransform(this._zlibChunks, streamFormat, this._zlibMode, this._zlibScope);
    } catch (error) {
      callback(this._zlibMode === 'decompress' ? zlibDataError(error) : error);
      return;
    }
    Promise.resolve(transformed).then(
      (output) => {
        const BufferClass = this._zlibBufferClass;
        this.push(BufferClass ? new BufferClass(output) : new Uint8Array(output));
        callback();
      },
      (error) => callback(this._zlibMode === 'decompress' ? zlibDataError(error) : error),
    );
  }

  reset() {
    if (!this._handle) {
      const error = new Error(
        'zlib binding closed\n' +
        'This is caused by either a bug in Node.js or incorrect usage of Node.js internals.',
      );
      error.code = 'ERR_INTERNAL_ASSERTION';
      throw error;
    }
    this._zlibChunks.length = 0;
    this._nativeCodec?.abort();
    this._nativeCodec = null;
    this._nativeCodecUnavailable = false;
    this._zlibCodec?.close();
    this._zlibCodec = null;
    this._zlibCodecUnavailable = false;
    this.bytesWritten = 0;
  }

  flush(kind, callback) {
    if (typeof kind === 'function' || (kind === undefined && !callback)) {
      callback = kind;
      kind = this._zlibMode === 'compress' && this._zlibFormat === 'zstd' ? 1 : 3;
    }
    if (kind !== undefined && typeof kind !== 'number') {
      const error = new TypeError(
        `The "kind" argument must be of type number. Received ${kind === null ? 'null' : typeof kind}`,
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (kind !== undefined && (!Number.isInteger(kind) || kind < 0 || kind > this._zlibMaxFlushFlag)) {
      const error = new RangeError(
        `The value of "kind" is out of range. It must be >= 0 and <= ${this._zlibMaxFlushFlag}. Received ${kind}`,
      );
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
    if (this.writableFinished) {
      if (callback) queueMicrotask(callback);
    } else if (this.writableEnded) {
      if (callback) this.once('end', callback);
    } else {
      this.write(new Uint8Array(0), callback);
    }
  }

  close(callback) {
    if (callback !== undefined && typeof callback !== 'function') {
      const error = new TypeError(
        `The "callback" argument must be of type function. Received ${typeof callback}`,
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (callback) {
      if (this._closed) queueMicrotask(callback);
      else this.once('close', callback);
    }
    this.destroy();
  }

  _destroy(error, callback) {
    this._nativeCodec?.abort(error).catch(() => {});
    this._nativeCodec = null;
    this._zlibCodec?.close();
    this._zlibCodec = null;
    this._handle?.close();
    this._handle = null;
    callback(error);
  }

  _processChunk(chunk, _flushFlag, callback) {
    if (typeof callback === 'function') {
      queueMicrotask(() => {
        if (!this._handle) {
          callback();
          return;
        }
        try {
          this._transform.call(this, chunk, 'buffer', callback);
        } catch (error) {
          callback(error);
        }
      });
      return;
    }
    const bytes = toUint8Array(chunk);
    if (bytes.byteLength) this._syncChunks.push(bytes.slice());
    if (_flushFlag !== constants.Z_FINISH) {
      return this._zlibBufferClass?.alloc?.(0) || new Uint8Array(0);
    }

    const input = concatenateBytes(this._syncChunks);
    const format = typeof this._zlibFormat === 'function'
      ? this._zlibFormat([input])
      : this._zlibFormat;
    let output;
    if (this._zlibMode === 'decompress') {
      if (format === 'gzip') output = wasmGzipInflate(input);
      else if (format === 'deflate') output = wasmZlibInflate(input);
      else if (format === 'zstd') output = wasmZstdDecompress(input);
      else throw new Error(`synchronous ${format} decompression is unavailable`);
    } else if (format === 'deflate') {
      output = wasmZlibDeflate(input);
    } else if (format === 'zstd') {
      output = wasmZstdCompress(input);
    } else {
      throw new Error(`synchronous ${format} compression is unavailable`);
    }
    this._syncChunks.length = 0;
    return wrapBufferResult(output, this._zlibBufferClass);
  }
}

let bytesReadGetterWarned = false;
let bytesReadSetterWarned = false;

function warnBytesRead(scope, message) {
  const processObject = scope?.process || globalThis.process;
  processObject?.emitWarning?.(message, { code: 'DEP0108' });
}

Object.defineProperty(ZlibStream.prototype, '_closed', {
  configurable: true,
  enumerable: true,
  get() { return !this._handle; },
});

Object.defineProperty(ZlibStream.prototype, 'bytesRead', {
  configurable: true,
  enumerable: true,
  get() {
    if (!bytesReadGetterWarned) {
      bytesReadGetterWarned = true;
      warnBytesRead(
        this._zlibScope,
        'zlib.bytesRead is deprecated and will change its meaning in the future. Use zlib.bytesWritten instead.',
      );
    }
    return this.bytesWritten;
  },
  set(value) {
    if (!bytesReadSetterWarned) {
      bytesReadSetterWarned = true;
      warnBytesRead(
        this._zlibScope,
        'Setting zlib.bytesRead is deprecated. This feature will be removed in the future.',
      );
    }
    this.bytesWritten = value;
  },
});

for (const name of ['reset', '_flush', 'flush', 'close', '_processChunk', '_destroy']) {
  const descriptor = Object.getOwnPropertyDescriptor(ZlibStream.prototype, name);
  Object.defineProperty(ZlibStream.prototype, name, { ...descriptor, enumerable: true });
}

class Inflate extends ZlibStream {
  constructor(options, bufferClass, scope) { super('deflate', 'decompress', bufferClass, scope, options); }
}

class InflateRaw extends ZlibStream {
  constructor(options, bufferClass, scope) { super('deflate-raw', 'decompress', bufferClass, scope, options); }
}

class Gunzip extends ZlibStream {
  constructor(options, bufferClass, scope) { super('gzip', 'decompress', bufferClass, scope, options); }
}

class Unzip extends ZlibStream {
  constructor(options, bufferClass, scope) {
    super((chunks) => {
      const first = chunks[0] || [];
      return first[0] === 0x1f && first[1] === 0x8b ? 'gzip' : 'deflate';
    }, 'decompress', bufferClass, scope, options);
  }
}

class Gzip extends ZlibStream {
  constructor(options = {}, bufferClass, scope) {
    if (options.windowBits === 0) {
      const error = new RangeError(
        'The value of "options.windowBits" is out of range. ' +
        'It must be >= 9 and <= 15. Received 0',
      );
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
    for (const name of ['flush', 'finishFlush']) {
      const value = options[name];
      if (value === undefined) continue;
      if (typeof value !== 'number') {
        const received = typeof value === 'string'
          ? `type string ('${value}')`
          : `an instance of ${value?.constructor?.name || typeof value}`;
        const error = new TypeError(
          `The "options.${name}" property must be of type number. Received ${received}`,
        );
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      if (!Number.isInteger(value) || value < 0 || value > 5) {
        const error = new RangeError(
          `The value of "options.${name}" is out of range. It must be >= 0 and <= 5. Received ${value}`,
        );
        error.code = 'ERR_OUT_OF_RANGE';
        throw error;
      }
    }
    super('gzip', 'compress', bufferClass, scope, options);
  }
}

class Deflate extends ZlibStream {
  constructor(options, bufferClass, scope) {
    super('deflate', 'compress', bufferClass, scope, options);
  }
}

class DeflateRaw extends ZlibStream {
  constructor(options, bufferClass, scope) {
    super('deflate-raw', 'compress', bufferClass, scope, options);
  }
}

function BrotliCompress(options, bufferClass, scope) {
  validateBrotliOptions(options);
  return Reflect.construct(
    ZlibStream,
    ['br', 'compress', bufferClass, scope],
    new.target || BrotliCompress,
  );
}
Object.setPrototypeOf(BrotliCompress.prototype, ZlibStream.prototype);
Object.setPrototypeOf(BrotliCompress, ZlibStream);

function BrotliDecompress(options, bufferClass, scope) {
  validateBrotliOptions(options);
  return Reflect.construct(
    ZlibStream,
    ['br', 'decompress', bufferClass, scope],
    new.target || BrotliDecompress,
  );
}
Object.setPrototypeOf(BrotliDecompress.prototype, ZlibStream.prototype);
Object.setPrototypeOf(BrotliDecompress, ZlibStream);

for (const Constructor of [
  BrotliCompress,
  BrotliDecompress,
  Deflate,
  DeflateRaw,
  Gunzip,
  Gzip,
  Inflate,
  InflateRaw,
  Unzip,
]) {
  Constructor.prototype.params = zlibParams;
  Constructor.prototype[SymbolNodeAsyncDispose] = zlibAsyncDispose;
  if (SymbolAsyncDispose !== SymbolNodeAsyncDispose) {
    Constructor.prototype[SymbolAsyncDispose] = zlibAsyncDispose;
  }
}

class ZstdCompress extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('zstd', 'compress', bufferClass, scope); }
}

class ZstdDecompress extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('zstd', 'decompress', bufferClass, scope); }
}

for (const Constructor of [ZstdCompress, ZstdDecompress]) {
  Constructor.prototype[SymbolNodeAsyncDispose] = zlibAsyncDispose;
  if (SymbolAsyncDispose !== SymbolNodeAsyncDispose) {
    Constructor.prototype[SymbolAsyncDispose] = zlibAsyncDispose;
  }
}

function toUint8Array(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

function concatenateBytes(chunks) {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function webTransform(value, format, mode, scope) {
  const input = new scope.Blob([value]).stream();
  const transformed = input.pipeThrough(createWebTransform(scope, format, mode));
  return new Uint8Array(await new scope.Response(transformed).arrayBuffer());
}

function gzipPayload(bytes) {
  if (bytes.byteLength < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) {
    throw new Error('invalid gzip header');
  }
  const flags = bytes[3];
  if (flags & 0xe0) throw new Error('unsupported gzip flags');
  let offset = 10;
  if (flags & 4) {
    if (offset + 2 > bytes.byteLength - 8) throw new Error('invalid gzip extra field');
    const extraLength = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2 + extraLength;
  }
  for (const flag of [8, 16]) {
    if (flags & flag) {
      while (offset < bytes.byteLength - 8 && bytes[offset] !== 0) offset += 1;
      offset += 1;
    }
  }
  if (flags & 2) offset += 2;
  if (offset > bytes.byteLength - 8) throw new Error('invalid gzip payload');
  return bytes.subarray(offset, bytes.byteLength - 8);
}

function gzipUncompressedSize(bytes) {
  const offset = bytes.byteLength - 4;
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function wasmBrotliCompress(value, options = {}) {
  validateBrotliOptions(options);
  const inst = getWasmInstance('brotli');
  if (!inst) throw new Error('brotli.wasm artifact unavailable');
  const exp = inst.exports;
  const mem = exp.memory;
  const inputBytes = toUint8Array(value);

  const inPtr = exp.malloc(inputBytes.length);
  new Uint8Array(mem.buffer).set(inputBytes, inPtr);
  const maxOut = inputBytes.length * 2 + 1024;
  const outPtr = exp.malloc(maxOut);
  const enc = exp.BrotliEncoderCreateInstance(0, 0, 0);
  const stateBlock = exp.malloc(20);
  const dv = new DataView(mem.buffer);
  dv.setUint32(stateBlock, inputBytes.length, true);
  dv.setUint32(stateBlock + 4, inPtr, true);
  dv.setUint32(stateBlock + 8, maxOut, true);
  dv.setUint32(stateBlock + 12, outPtr, true);

  const res = exp.BrotliEncoderCompressStream(enc, 2, stateBlock, stateBlock + 4, stateBlock + 8, stateBlock + 12, 0);
  if (!res) {
    exp.BrotliEncoderDestroyInstance(enc);
    exp.free(inPtr); exp.free(outPtr); exp.free(stateBlock);
    throw new Error('Brotli compression failed');
  }
  const remainingOut = dv.getUint32(stateBlock + 8, true);
  const compressedLen = maxOut - remainingOut;
  const result = new Uint8Array(mem.buffer).slice(outPtr, outPtr + compressedLen);
  exp.BrotliEncoderDestroyInstance(enc);
  exp.free(inPtr); exp.free(outPtr); exp.free(stateBlock);
  return result;
}

function wasmBrotliDecompress(value, options = {}) {
  validateBrotliOptions(options);
  const inst = getWasmInstance('brotli');
  if (!inst) throw new Error('brotli.wasm artifact unavailable');
  const exp = inst.exports;
  const mem = exp.memory;
  const inputBytes = toUint8Array(value);

  const inPtr = exp.malloc(inputBytes.length);
  new Uint8Array(mem.buffer).set(inputBytes, inPtr);
  const maxOut = Math.max(inputBytes.length * 6, 4096);
  const outPtr = exp.malloc(maxOut);
  const dec = exp.BrotliDecoderCreateInstance(0, 0, 0);
  const stateBlock = exp.malloc(20);
  const dv = new DataView(mem.buffer);
  dv.setUint32(stateBlock, inputBytes.length, true);
  dv.setUint32(stateBlock + 4, inPtr, true);
  dv.setUint32(stateBlock + 8, maxOut, true);
  dv.setUint32(stateBlock + 12, outPtr, true);

  const res = exp.BrotliDecoderDecompressStream(dec, stateBlock, stateBlock + 4, stateBlock + 8, stateBlock + 12, 0);
  if (!res) {
    exp.BrotliDecoderDestroyInstance(dec);
    exp.free(inPtr); exp.free(outPtr); exp.free(stateBlock);
    const err = new Error('Decompression failed');
    err.code = 'ERR_BROTLI_DECOMPRESS_FAILED';
    throw err;
  }
  const remainingOut = dv.getUint32(stateBlock + 8, true);
  const decompressedLen = maxOut - remainingOut;
  const result = new Uint8Array(mem.buffer).slice(outPtr, outPtr + decompressedLen);
  exp.BrotliDecoderDestroyInstance(dec);
  exp.free(inPtr); exp.free(outPtr); exp.free(stateBlock);
  return result;
}

function wasmZstdCompress(value, options = {}) {
  const inst = getWasmInstance('zstd');
  if (!inst) throw new Error('zstd.wasm artifact unavailable');
  const exp = inst.exports;
  const inputBytes = toUint8Array(value);

  const inPtr = exp.malloc(inputBytes.length);
  new Uint8Array(exp.memory.buffer).set(inputBytes, inPtr);
  const maxOut = exp.ZSTD_compressBound(inputBytes.length);
  const outPtr = exp.malloc(maxOut);
  const level = options.level ?? 3;
  const compSize = exp.ZSTD_compress(outPtr, maxOut, inPtr, inputBytes.length, level);
  if (exp.ZSTD_isError(compSize)) {
    exp.free(inPtr); exp.free(outPtr);
    throw new Error('Zstd compression failed');
  }
  const result = new Uint8Array(exp.memory.buffer).slice(outPtr, outPtr + compSize);
  exp.free(inPtr); exp.free(outPtr);
  return result;
}

function wasmZstdDecompress(value, options = {}) {
  const inst = getWasmInstance('zstd');
  if (!inst) throw new Error('zstd.wasm artifact unavailable');
  const exp = inst.exports;
  const inputBytes = toUint8Array(value);

  const inPtr = exp.malloc(inputBytes.length);
  new Uint8Array(exp.memory.buffer).set(inputBytes, inPtr);
  const origSize = Number(exp.ZSTD_getFrameContentSize(inPtr, inputBytes.length));
  const maxOut = (origSize > 0 && origSize < 100 * 1024 * 1024) ? origSize : Math.max(inputBytes.length * 5, 4096);
  const outPtr = exp.malloc(maxOut);
  const decSize = exp.ZSTD_decompress(outPtr, maxOut, inPtr, inputBytes.length);
  if (exp.ZSTD_isError(decSize)) {
    exp.free(inPtr); exp.free(outPtr);
    throw new Error('Zstd decompression failed');
  }
  const result = new Uint8Array(exp.memory.buffer).slice(outPtr, outPtr + decSize);
  exp.free(inPtr); exp.free(outPtr);
  return result;
}

function wasmCodecTransform(value, format, mode, options = {}) {
  const codec = new WasmZlibCodec(format, mode, options);
  try {
    const output = codec.process(value, constants.Z_NO_FLUSH);
    output.push(...codec.process(new Uint8Array(0), constants.Z_FINISH));
    return concatenateBytes(output);
  } finally {
    codec.close();
  }
}

function wasmZlibDeflate(value, options = {}, format = 'deflate') {
  return wasmCodecTransform(value, format, 'compress', options);
}

function wasmZlibInflate(value, options = {}, format = 'deflate') {
  return wasmCodecTransform(value, format, 'decompress', options);
}

function wasmGzipInflate(value, options = {}) {
  const inputBytes = toUint8Array(value);
  try {
    return wasmZlibInflate(inputBytes, options, 'gzip');
  } catch (error) {
    if (error?.code !== 'ERR_ZLIB_WASM_UNAVAILABLE') throw error;
  }
  const rawDeflate = gzipPayload(inputBytes);
  // The bundled zlib WASM exposes inflateInit_ (zlib-wrapped DEFLATE), not
  // inflateInit2_ (gzip/raw modes). Preserve the gzip payload and add a
  // temporary zlib envelope; inflate emits decoded bytes before checking the
  // envelope checksum, so the gzip trailer remains authoritative here.
  const wrapped = new Uint8Array(rawDeflate.byteLength + 6);
  wrapped[0] = 0x78;
  wrapped[1] = 0x9c;
  wrapped.set(rawDeflate, 2);

  const expectedSize = gzipUncompressedSize(inputBytes);
  const maxOut = Math.max(
    inputBytes.byteLength * 6,
    Math.min(expectedSize || 0, 256 * 1024 * 1024),
    4096,
  );
  const inst = getWasmInstance('zlib');
  if (!inst) throw zlibWasmUnavailable('gzip', 'decompress');
  const exp = inst.exports;
  const mem = exp.memory;
  const inPtr = exp.malloc(wrapped.length);
  const outPtr = exp.malloc(maxOut);
  const strm = exp.malloc(64);
  const verPtr = exp.malloc(16);
  try {
    new Uint8Array(mem.buffer).set(wrapped, inPtr);
    new Uint8Array(mem.buffer, strm, 64).fill(0);
    const dv = new DataView(mem.buffer);
    dv.setUint32(strm, inPtr, true);
    dv.setUint32(strm + 4, wrapped.length, true);
    dv.setUint32(strm + 12, outPtr, true);
    dv.setUint32(strm + 16, maxOut, true);
    new Uint8Array(mem.buffer).set(new TextEncoder().encode('1.3.1\0'), verPtr);
    exp.inflateInit_(strm, verPtr, 56);
    exp.inflate(strm, 4);
    const decodedLength = maxOut - dv.getUint32(strm + 16, true);
    if (decodedLength === 0 && expectedSize !== 0) throw new Error('gzip decompression produced no output');
    return new Uint8Array(mem.buffer).slice(outPtr, outPtr + decodedLength);
  } finally {
    exp.inflateEnd(strm);
    exp.free(inPtr);
    exp.free(outPtr);
    exp.free(strm);
    exp.free(verPtr);
  }
}

function wrapBufferResult(uint8Arr, BufferClass) {
  if (BufferClass && typeof BufferClass.from === 'function') {
    return BufferClass.from(uint8Arr.buffer, uint8Arr.byteOffset, uint8Arr.byteLength);
  }
  return uint8Arr;
}

function operation(value, format, mode, BufferClass, scope, optionsOrCallback, callback) {
  const done = typeof callback === 'function'
    ? callback
    : typeof optionsOrCallback === 'function' ? optionsOrCallback : undefined;
  const options = typeof optionsOrCallback === 'object' && optionsOrCallback !== null ? optionsOrCallback : {};

  const execute = async () => {
    const streamFormat = typeof format === 'function' ? format(value, scope) : format;
    if (streamFormat === 'br') {
      return mode === 'compress' ? wasmBrotliCompress(value, options) : wasmBrotliDecompress(value, options);
    }
    if (streamFormat === 'zstd') {
      return mode === 'compress' ? wasmZstdCompress(value, options) : wasmZstdDecompress(value, options);
    }
    if (streamFormat === 'gzip' || streamFormat === 'deflate' || streamFormat === 'deflate-raw') {
      try {
        return await webTransform(value, streamFormat, mode, scope);
      } catch (nativeError) {
        if (nativeError?.code !== 'ERR_UNSUPPORTED_WEB_CAPABILITY') throw nativeError;
        return mode === 'compress'
          ? wasmZlibDeflate(value, options, streamFormat)
          : streamFormat === 'gzip'
            ? wasmGzipInflate(value, options)
            : wasmZlibInflate(value, options, streamFormat);
      }
    }
    return webTransform(value, streamFormat, mode, scope);
  };

  const result = execute();
  if (typeof done !== 'function') return result.then((output) => wrapBufferResult(output, BufferClass));
  return result.then(
    (output) => done(null, wrapBufferResult(output, BufferClass)),
    (error) => done(mode === 'decompress' ? zlibDataError(error) : error),
  );
}

function syncUnavailable(kind, method, value) {
  validateBuffer(value);
  throw new Error(`synchronous ${kind} is unavailable in a browser; use zlib.${method}`);
}

function unzipFormat(value, scope) {
  let bytes;
  if (typeof value === 'string') {
    bytes = new scope.TextEncoder().encode(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, Math.min(value.byteLength, 2));
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value, 0, Math.min(value.byteLength, 2));
  } else {
    bytes = [];
  }
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? 'gzip' : 'deflate';
}

function crc32(data, value = 0, scope = globalThis) {
  if (typeof data !== 'string' && !ArrayBuffer.isView(data)) {
    const error = new TypeError(
      'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received an invalid value',
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (typeof value !== 'number') {
    const error = new TypeError('The "value" argument must be of type number');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    const error = new RangeError(
      `The value of "value" is out of range. It must be an integer between 0 and 4294967295. Received ${value}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  const bytes = typeof data === 'string'
    ? new scope.TextEncoder().encode(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let crc = (value ^ 0xffffffff) >>> 0;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createProperty(Constructor, bufferClass, scope) {
  return (options) => new Constructor(options, bufferClass, scope);
}

export function createZlibShim(scope, BufferClass) {
  const nativeScope = Object.create(scope);
  Object.defineProperties(nativeScope, {
    Blob: { value: scope.Blob },
    Response: { value: scope.Response },
    CompressionStream: { value: scope.CompressionStream },
    DecompressionStream: { value: scope.DecompressionStream },
  });
  const zlib = {
    constants,
    codes,
    crc32: (data, value) => crc32(data, value, scope),
    gzip: (value, callback) => operation(value, 'gzip', 'compress', BufferClass, nativeScope, callback),
    gunzip: (value, callback) => operation(value, 'gzip', 'decompress', BufferClass, nativeScope, callback),
    deflate: (value, callback) => operation(value, 'deflate', 'compress', BufferClass, nativeScope, callback),
    inflate: (value, callback) => operation(value, 'deflate', 'decompress', BufferClass, nativeScope, callback),
    deflateRaw: (value, callback) => operation(value, 'deflate-raw', 'compress', BufferClass, nativeScope, callback),
    inflateRaw: (value, callback) => operation(value, 'deflate-raw', 'decompress', BufferClass, nativeScope, callback),
    Inflate,
    createInflate: createProperty(Inflate, BufferClass, nativeScope),
    Deflate,
    createDeflate: createProperty(Deflate, BufferClass, nativeScope),
    Gunzip,
    createGunzip: createProperty(Gunzip, BufferClass, nativeScope),
    Unzip,
    createUnzip: createProperty(Unzip, BufferClass, nativeScope),
    Gzip,
    createGzip: createProperty(Gzip, BufferClass, nativeScope),
    DeflateRaw,
    createDeflateRaw: createProperty(DeflateRaw, BufferClass, nativeScope),
    InflateRaw,
    createInflateRaw: createProperty(InflateRaw, BufferClass, nativeScope),
    BrotliCompress,
    BrotliDecompress,
    brotliCompress: (value, optionsOrCallback, callback) => operation(value, 'br', 'compress', BufferClass, nativeScope, optionsOrCallback, callback),
    brotliDecompress: (value, optionsOrCallback, callback) => operation(value, 'br', 'decompress', BufferClass, nativeScope, optionsOrCallback, callback),
    createBrotliCompress: createProperty(BrotliCompress, BufferClass, nativeScope),
    createBrotliDecompress: createProperty(BrotliDecompress, BufferClass, nativeScope),
    ZstdCompress,
    ZstdDecompress,
    createZstdCompress: createProperty(ZstdCompress, BufferClass, nativeScope),
    createZstdDecompress: createProperty(ZstdDecompress, BufferClass, nativeScope),
    gzipSync: (value, options) => wrapBufferResult(wasmZlibDeflate(value, options, 'gzip'), BufferClass),
    gunzipSync: (value, options) => wrapBufferResult(wasmGzipInflate(value, options), BufferClass),
    deflateSync: (value, options) => wrapBufferResult(wasmZlibDeflate(value, options), BufferClass),
    deflateRawSync: (value, options) => wrapBufferResult(wasmZlibDeflate(value, options, 'deflate-raw'), BufferClass),
    inflateRawSync: (value, options) => wrapBufferResult(wasmZlibInflate(value, options, 'deflate-raw'), BufferClass),
    inflateSync: (value, options) => wrapBufferResult(wasmZlibInflate(value, options), BufferClass),
    unzip: (value, optionsOrCallback, callback) => operation(value, (input, targetScope) => unzipFormat(input, targetScope), 'decompress', BufferClass, scope, optionsOrCallback, callback),
    unzipSync: (value, options) => {
      const input = toUint8Array(value);
      const output = input[0] === 0x1f && input[1] === 0x8b
        ? wasmGzipInflate(input, options)
        : wasmZlibInflate(input, options);
      return wrapBufferResult(output, BufferClass);
    },
    brotliCompressSync: (value, options) => wrapBufferResult(wasmBrotliCompress(value, options), BufferClass),
    brotliDecompressSync: (value, options) => wrapBufferResult(wasmBrotliDecompress(value, options), BufferClass),
    zstdCompress: (value, optionsOrCallback, callback) => operation(value, 'zstd', 'compress', BufferClass, nativeScope, optionsOrCallback, callback),
    zstdDecompress: (value, optionsOrCallback, callback) => operation(value, 'zstd', 'decompress', BufferClass, nativeScope, optionsOrCallback, callback),
    zstdCompressSync: (value, options) => wrapBufferResult(wasmZstdCompress(value, options), BufferClass),
    zstdDecompressSync: (value, options) => wrapBufferResult(wasmZstdDecompress(value, options), BufferClass),
  };
  for (const [name, value] of Object.entries(constants)) {
    if (name.startsWith('BROTLI')) continue;
    Object.defineProperty(zlib, name, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  return zlib;
}
