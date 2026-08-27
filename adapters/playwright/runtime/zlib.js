import { AsyncResource } from './async-hooks.js';
import { Transform } from './streams.js';
import { UnsupportedWebCapabilityError } from './errors.js';

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
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_STREAM_ERROR: -2,
  Z_VERSION_ERROR: -6,
  Z_RLE: 3,
  ZLIB_VERNUM: 4897,
  ZSTD_CLEVEL_DEFAULT: 3,
  ZSTD_btlazy2: 6,
  ZSTD_btopt: 7,
  ZSTD_btultra: 8,
  ZSTD_btultra2: 9,
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_chainLog: 103,
  ZSTD_c_checksumFlag: 201,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_dictIDFlag: 202,
  ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_hashLog: 102,
  ZSTD_c_jobSize: 401,
  ZSTD_c_ldmBucketSizeLog: 163,
  ZSTD_c_ldmHashLog: 161,
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
  Z_DEFAULT_CHUNK: 16384,
  Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_LEVEL: -1,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_DEFAULT_STRATEGY: 0,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_ERRNO: -1,
  Z_FILTERED: 1,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,
  ZSTD_COMPRESS: 10,
  ZSTD_DECOMPRESS: 11,
});

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
  try {
    return new Constructor(format);
  } catch (error) {
    throw formatUnsupported(format, mode, error);
  }
}

function zlibDataError(error) {
  const result = new Error('incorrect header check');
  result.code = 'Z_DATA_ERROR';
  result.errno = -3;
  result.cause = error;
  return result;
}

class ZlibHandle {
  constructor() { this._resource = new AsyncResource('ZLIB'); }
  getAsyncId() { return this._resource.asyncId(); }
  asyncId() { return this.getAsyncId(); }
  triggerAsyncId() { return this._resource.triggerAsyncId(); }
  close() { this._resource.emitDestroy(); }
}

class ZlibStream extends Transform {
  constructor(format, mode, bufferClass, scope = globalThis) {
    const chunks = [];
    super({
      transform(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
      flush(callback) {
        let transformed;
        try {
          const streamFormat = typeof format === 'function' ? format(chunks) : format;
          const input = new scope.Blob(chunks).stream();
          transformed = input.pipeThrough(createWebTransform(scope, streamFormat, mode));
        } catch (error) {
          callback(mode === 'decompress' ? zlibDataError(error) : error);
          return;
        }
        new scope.Response(transformed).arrayBuffer().then(
          (output) => {
            this.push(bufferClass ? new bufferClass(output) : new Uint8Array(output));
            callback();
          },
          (error) => callback(mode === 'decompress' ? zlibDataError(error) : error),
        );
      },
    });
    this._handle = new ZlibHandle();
  }
}

class Inflate extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('deflate', 'decompress', bufferClass, scope); }
}

class InflateRaw extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('deflate-raw', 'decompress', bufferClass, scope); }
}

class Gunzip extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('gzip', 'decompress', bufferClass, scope); }
}

class Unzip extends ZlibStream {
  constructor(_options, bufferClass, scope) {
    super((chunks) => {
      const first = chunks[0] || [];
      return first[0] === 0x1f && first[1] === 0x8b ? 'gzip' : 'deflate';
    }, 'decompress', bufferClass, scope);
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
    super('gzip', 'compress', bufferClass, scope);
  }
}

class Deflate extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('deflate', 'compress', bufferClass, scope); }
}

class DeflateRaw extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('deflate-raw', 'compress', bufferClass, scope); }
}

class BrotliCompress extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('br', 'compress', bufferClass, scope); }
}

class BrotliDecompress extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('br', 'decompress', bufferClass, scope); }
}

class ZstdCompress extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('zstd', 'compress', bufferClass, scope); }
}

class ZstdDecompress extends ZlibStream {
  constructor(_options, bufferClass, scope) { super('zstd', 'decompress', bufferClass, scope); }
}

function operation(value, format, mode, BufferClass, scope, optionsOrCallback, callback) {
  const done = typeof callback === 'function'
    ? callback
    : typeof optionsOrCallback === 'function' ? optionsOrCallback : undefined;
  const result = (async () => {
    const input = new scope.Blob([value]).stream();
    const transformed = input.pipeThrough(createWebTransform(scope, format, mode));
    return new Uint8Array(await new scope.Response(transformed).arrayBuffer());
  })();
  if (typeof done !== 'function') return result.then((output) => new BufferClass(output));
  return result.then(
    (output) => done(null, new BufferClass(output)),
    (error) => done(mode === 'decompress' ? zlibDataError(error) : error),
  );
}

function syncUnavailable(kind, method) {
  throw new Error(`synchronous ${kind} is unavailable in a browser; use zlib.${method}`);
}

function createProperty(Constructor, bufferClass, scope) {
  return (options) => new Constructor(options, bufferClass, scope);
}

export function createZlibShim(scope, BufferClass) {
  const zlib = {
    constants,
    gzip: (value, callback) => operation(value, 'gzip', 'compress', BufferClass, scope, callback),
    gunzip: (value, callback) => operation(value, 'gzip', 'decompress', BufferClass, scope, callback),
    deflate: (value, callback) => operation(value, 'deflate', 'compress', BufferClass, scope, callback),
    inflate: (value, callback) => operation(value, 'deflate', 'decompress', BufferClass, scope, callback),
    deflateRaw: (value, callback) => operation(value, 'deflate-raw', 'compress', BufferClass, scope, callback),
    inflateRaw: (value, callback) => operation(value, 'deflate-raw', 'decompress', BufferClass, scope, callback),
    Inflate,
    createInflate: createProperty(Inflate, BufferClass, scope),
    Deflate,
    createDeflate: createProperty(Deflate, BufferClass, scope),
    Gunzip,
    createGunzip: createProperty(Gunzip, BufferClass, scope),
    Unzip,
    createUnzip: createProperty(Unzip, BufferClass, scope),
    Gzip,
    createGzip: createProperty(Gzip, BufferClass, scope),
    DeflateRaw,
    createDeflateRaw: createProperty(DeflateRaw, BufferClass, scope),
    InflateRaw,
    createInflateRaw: createProperty(InflateRaw, BufferClass, scope),
    BrotliCompress,
    BrotliDecompress,
    ZstdCompress,
    ZstdDecompress,
    createZstdCompress: createProperty(ZstdCompress, BufferClass, scope),
    createZstdDecompress: createProperty(ZstdDecompress, BufferClass, scope),
    gzipSync() { syncUnavailable('compression', 'gzip'); },
    gunzipSync() { syncUnavailable('decompression', 'gunzip'); },
    deflateSync() { syncUnavailable('compression', 'deflate'); },
    deflateRawSync() { syncUnavailable('compression', 'deflateRaw'); },
    inflateRawSync() { syncUnavailable('decompression', 'inflateRaw'); },
    brotliCompressSync() { syncUnavailable('Brotli compression', 'brotliCompress'); },
    brotliDecompressSync() { syncUnavailable('Brotli decompression', 'brotliDecompress'); },
    zstdCompress: (value, optionsOrCallback, callback) => operation(value, 'zstd', 'compress', BufferClass, scope, optionsOrCallback, callback),
    zstdDecompress: (value, optionsOrCallback, callback) => operation(value, 'zstd', 'decompress', BufferClass, scope, optionsOrCallback, callback),
    zstdCompressSync() { syncUnavailable('compression', 'zstdCompress'); },
    zstdDecompressSync() { syncUnavailable('decompression', 'zstdDecompress'); },
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
