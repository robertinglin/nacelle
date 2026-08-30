import { copyBytes } from './binary.js';
import { UnsupportedWebCapabilityError } from './errors.js';

const STREAM_FORMATS = new Set(['gzip', 'deflate']);

function requireStream(globalObject, constructorName, format) {
  if (!STREAM_FORMATS.has(format)) {
    throw new UnsupportedWebCapabilityError(
      `compression format ${format}`,
      'CompressionStream does not standardize this format; use a browser-safe adapter',
    );
  }
  const Stream = globalObject[constructorName];
  if (typeof Stream !== 'function') {
    throw new UnsupportedWebCapabilityError(constructorName, 'the Compression Streams Web API is not available');
  }
  return Stream;
}

async function streamBytes(value, Stream, format, globalObject) {
  const input = new globalObject.Blob([copyBytes(value, globalObject.TextEncoder)]);
  const output = input.stream().pipeThrough(new Stream(format));
  return new Uint8Array(await new globalObject.Response(output).arrayBuffer());
}

export function compress(value, format = 'gzip', globalObject = globalThis) {
  return streamBytes(value, requireStream(globalObject, 'CompressionStream', format), format, globalObject);
}

export function decompress(value, format = 'gzip', globalObject = globalThis) {
  return streamBytes(value, requireStream(globalObject, 'DecompressionStream', format), format, globalObject);
}

export function createCompressionContract(globalObject = globalThis) {
  return Object.freeze({
    formats: Object.freeze([...STREAM_FORMATS]),
    compress: (value, format = 'gzip') => compress(value, format, globalObject),
    decompress: (value, format = 'gzip') => decompress(value, format, globalObject),
    encodeText: (value) => new globalObject.TextEncoder().encode(value),
    decodeText: (value) => new globalObject.TextDecoder().decode(value),
    clone: (value) => globalObject.structuredClone(value),
    stringify: JSON.stringify,
    parse: JSON.parse,
  });
}
