const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_BUFFER_LENGTH = 0x7fffffff;

// ---------------------------------------------------------------------------
// One byte/encoding layer shared by Buffer.from, Buffer#write,
// Buffer#toString and the indexOf/lastIndexOf byte search below.
// ---------------------------------------------------------------------------

function encodeLatin1(text, mask) {
  const bits = mask ? 0x7f : 0xff;
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & bits;
  return bytes;
}

function decodeSingleByte(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return text;
}

function decodeAscii(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    const units = new Array(chunk.length);
    for (let offset = 0; offset < chunk.length; offset += 1) units[offset] = chunk[offset] & 0x7f;
    text += String.fromCharCode(...units);
  }
  return text;
}

function encodeUcs2(text) {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes[index * 2] = unit & 0xff;
    bytes[(index * 2) + 1] = (unit >>> 8) & 0xff;
  }
  return bytes;
}

function decodeUcs2(bytes) {
  const end = bytes.length & ~1;
  let text = '';
  for (let index = 0; index < end; index += 0x4000) {
    const stop = Math.min(index + 0x4000, end);
    const units = new Array(stop - index >> 1);
    for (let cursor = index; cursor < stop; cursor += 2) units[(cursor - index) >> 1] = bytes[cursor] | (bytes[cursor + 1] << 8);
    text += String.fromCharCode.apply(null, units);
  }
  return text;
}

function hexValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

// Node's hex decoding stops at the first non-hex character and drops an odd
// trailing character instead of failing.
function decodeHex(text) {
  const result = new Uint8Array(Math.floor(text.length / 2));
  let size = 0;
  for (let index = 0; index + 1 < text.length; index += 2) {
    const high = hexValue(text.charCodeAt(index));
    if (high < 0) break;
    const low = hexValue(text.charCodeAt(index + 1));
    if (low < 0) break;
    result[size] = (high << 4) | low;
    size += 1;
  }
  return size === result.length ? result : result.subarray(0, size);
}

function encodeHex(bytes) {
  let text = '';
  for (const item of bytes) text += item.toString(16).padStart(2, '0');
  return text;
}

// Node's base64 decoding skips characters outside the (url-safe) alphabet,
// treats '=' as end-of-data and accepts unpadded input.
function decodeBase64(text) {
  const result = new Uint8Array(Math.floor(text.length / 4) * 3 + 3);
  let size = 0;
  let accumulator = 0;
  let bits = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 61) break;
    let value;
    if (code >= 65 && code <= 90) value = code - 65;
    else if (code >= 97 && code <= 122) value = code - 71;
    else if (code >= 48 && code <= 57) value = code + 4;
    else if (code === 43 || code === 45) value = 62;
    else if (code === 47 || code === 95) value = 63;
    else continue;
    accumulator = ((accumulator << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result[size] = (accumulator >> bits) & 0xff;
      size += 1;
    }
  }
  return size === result.length ? result : result.subarray(0, size);
}

function encodeBase64(bytes, urlSafe) {
  let binary = '';
  for (const item of bytes) binary += String.fromCharCode(item);
  const encodedText = btoa(binary);
  return urlSafe ? encodedText.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') : encodedText;
}

function sliceBytes(buffer, start, end) {
  const [first, last] = nativeSliceRange(buffer.length, start, end);
  return buffer.subarray(first, last);
}

function asciiSlice(start, end) {
  return decodeAscii(sliceBytes(this, start, end));
}

function base64Slice(start, end) {
  return encodeBase64(sliceBytes(this, start, end), false);
}

function base64urlSlice(start, end) {
  return encodeBase64(sliceBytes(this, start, end), true);
}

function latin1Slice(start, end) {
  return decodeSingleByte(sliceBytes(this, start, end));
}

function hexSlice(start, end) {
  return encodeHex(sliceBytes(this, start, end));
}

function ucs2Slice(start, end) {
  return decodeUcs2(sliceBytes(this, start, end));
}

const UTF8_OPS = Object.freeze({
  search: 'bytes',
  encode: (text) => textEncoder.encode(text),
  decode: (bytes) => textDecoder.decode(bytes),
});
const UCS2_OPS = Object.freeze({
  search: 'ucs2',
  encode: encodeUcs2,
  decode: decodeUcs2,
});
const LATIN1_OPS = Object.freeze({ search: 'bytes', encode: (text) => encodeLatin1(text, false), decode: decodeSingleByte });
// Node's ASCII encoder is an 8-bit write; only ASCII decoding masks the high
// bit.  This distinction matters for Buffer.from/write and transcode.
const ASCII_OPS = Object.freeze({ search: 'bytes', encode: (text) => encodeLatin1(text, false), decode: decodeAscii });
const HEX_OPS = Object.freeze({ search: 'bytes', encode: decodeHex, decode: encodeHex });
const BASE64_OPS = Object.freeze({ search: 'bytes', encode: (text) => decodeBase64(text), decode: (bytes) => encodeBase64(bytes, false) });
const BASE64URL_OPS = Object.freeze({ search: 'bytes', encode: (text) => decodeBase64(text), decode: (bytes) => encodeBase64(bytes, true) });

// Mirrors Node's getEncodingOps(): canonical names win, otherwise a fully
// lowercased name is accepted ("UTF8", "HEX", "Base64URL", ...).
export function resolveEncodingOps(encoding) {
  encoding = `${encoding}`;
  switch (encoding.length) {
    case 3: return encoding.toLowerCase() === 'hex' ? HEX_OPS : undefined;
    case 4:
      if (encoding === 'utf8') return UTF8_OPS;
      if (encoding === 'ucs2') return UCS2_OPS;
      encoding = encoding.toLowerCase();
      if (encoding === 'utf8') return UTF8_OPS;
      if (encoding === 'ucs2') return UCS2_OPS;
      return undefined;
    case 5:
      if (encoding === 'utf-8') return UTF8_OPS;
      if (encoding === 'ascii') return ASCII_OPS;
      if (encoding === 'ucs-2') return UCS2_OPS;
      encoding = encoding.toLowerCase();
      if (encoding === 'utf-8') return UTF8_OPS;
      if (encoding === 'ascii') return ASCII_OPS;
      if (encoding === 'ucs-2') return UCS2_OPS;
      return undefined;
    case 6:
      if (encoding === 'latin1' || encoding === 'binary') return LATIN1_OPS;
      if (encoding === 'base64') return BASE64_OPS;
      encoding = encoding.toLowerCase();
      if (encoding === 'latin1' || encoding === 'binary') return LATIN1_OPS;
      if (encoding === 'base64') return BASE64_OPS;
      return undefined;
    case 7:
      if (encoding === 'utf16le' || encoding.toLowerCase() === 'utf16le') return UCS2_OPS;
      return undefined;
    case 8:
      if (encoding === 'utf-16le' || encoding.toLowerCase() === 'utf-16le') return UCS2_OPS;
      return undefined;
    case 9:
      if (encoding === 'base64url' || encoding.toLowerCase() === 'base64url') return BASE64URL_OPS;
      return undefined;
    default: return undefined;
  }
}

function encodingOpsOrUtf8(encoding) {
  return (encoding === undefined || encoding === 'utf8' ? UTF8_OPS : resolveEncodingOps(encoding)) || UTF8_OPS;
}

function encodingOpsOrThrow(encoding) {
  if (encoding === undefined || encoding === null || encoding === '' || typeof encoding !== 'string' || encoding === 'utf8') return UTF8_OPS;
  const ops = resolveEncodingOps(encoding);
  if (ops !== undefined) return ops;
  throw unknownEncodingError(encoding);
}

function invalidArgumentValueError(name, value) {
  const error = new TypeError(`The argument '${name}' is invalid. Received ${determineSpecificType(value)}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function outOfRangeError(name, range, value) {
  const received = determineSpecificType(value).replace(/^type number \((.*)\)$/, '$1');
  const error = new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${received}`);
  error.code = 'ERR_OUT_OF_RANGE';
  return error;
}

function validateBufferSize(size) {
  if (typeof size !== 'number') throw invalidArgumentTypeError('size', ['number'], size);
  if (!Number.isFinite(size) || size < 0 || size > MAX_BUFFER_LENGTH) {
    throw outOfRangeError('size', `>= 0 && <= ${MAX_BUFFER_LENGTH}`, size);
  }
  return Math.trunc(size);
}

function bytesFrom(value, encoding = 'utf8') {
  if (typeof value === 'string') return encodingOpsOrThrow(encoding).encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (isAnyArrayBuffer(value)) return new Uint8Array(value.slice(0));
  if (isTypedArray(value)) return Uint8Array.from(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(0);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data);
    if (value.length !== undefined) return typeof value.length === 'number' ? Uint8Array.from(value) : new Uint8Array(0);
    if (isAnyArrayBuffer(value.buffer)) return new Uint8Array(0);
  }
  throw invalidArgumentTypeError('first argument', ['string', 'Buffer', 'ArrayBuffer', 'Array', 'Array-like Object'], value);
}

function encoded(bytes, encoding = 'utf8') {
  return encodingOpsOrThrow(encoding).decode(bytes);
}

function outOfRangeIndexError() {
  const error = new RangeError('Index out of range');
  error.code = 'ERR_OUT_OF_RANGE';
  return error;
}

function bufferBoundsError(name) {
  const error = new RangeError(`"${name}" is outside of buffer bounds`);
  error.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
  return error;
}

function nativeSliceRange(length, start, end) {
  const normalize = (value, fallback) => {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (Number.isNaN(number)) return 0;
    if (!Number.isFinite(number)) throw outOfRangeIndexError();
    const index = Math.trunc(number);
    if (index < 0 || index > length) throw outOfRangeIndexError();
    return index;
  };
  return [normalize(start, 0), normalize(end, length)];
}

function nativeWriteRange(buffer, offset, length, strictLength) {
  const numberOffset = offset === undefined ? 0 : Number(offset);
  if (Number.isNaN(numberOffset)) {
    offset = 0;
  } else {
    offset = Math.trunc(numberOffset);
  }
  if (!Number.isFinite(numberOffset) || offset < 0 || offset > buffer.length) {
    if (!strictLength && offset < 0) throw outOfRangeIndexError();
    throw bufferBoundsError('offset');
  }

  const numberLength = length === undefined ? buffer.length - offset : Number(length);
  if (Number.isNaN(numberLength)) length = 0;
  else length = Math.trunc(numberLength);
  if (!Number.isFinite(numberLength) || length < 0) {
    if (strictLength) throw bufferBoundsError('length');
    throw outOfRangeIndexError();
  }
  if (strictLength && offset + length > buffer.length) throw bufferBoundsError('length');
  return { offset, length: Math.min(length, buffer.length - offset) };
}

function completeUtf8Prefix(bytes, maximum) {
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end === 0 || end === bytes.length) return end;
  const lead = bytes[end - 1];
  const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return end - 1 + width <= maximum ? end - 1 + width : end - 1;
}

function nativeWrite(buffer, value, offset, length, operations, strictLength = true) {
  if (typeof value !== 'string') throw invalidArgumentTypeError('argument', ['string'], value);
  const range = nativeWriteRange(buffer, offset, length, strictLength);
  if (range.length === 0 || value.length === 0) return 0;
  const bytes = operations.encode(value);
  const written = operations === UTF8_OPS
    ? completeUtf8Prefix(bytes, range.length)
    : Math.min(bytes.length, range.length);
  buffer.set(bytes.subarray(0, written), range.offset);
  return written;
}

function transcodeEncoding(value) {
  if (value === undefined || value === null || value === '') return 'utf8';
  if (typeof value !== 'string') return undefined;
  switch (value.toLowerCase()) {
    case 'utf8':
    case 'utf-8': return 'utf8';
    case 'utf16le':
    case 'utf-16le':
    case 'ucs2':
    case 'ucs-2': return 'utf16le';
    case 'latin1':
    case 'binary': return 'latin1';
    case 'ascii': return 'ascii';
    default: return undefined;
  }
}

function transcodeError(code = 'U_ILLEGAL_ARGUMENT_ERROR') {
  const error = new Error(`Unable to transcode Buffer [${code}]`);
  error.code = code;
  error.errno = code === 'U_INVALID_CHAR_FOUND' ? 10 : 1;
  return error;
}

function decodeTranscode(bytes, encoding, target) {
  if (encoding === 'utf8') {
    try {
      return new TextDecoder('utf-8', { fatal: target === 'utf16le' }).decode(bytes);
    } catch {
      throw transcodeError('U_INVALID_CHAR_FOUND');
    }
  }
  if (encoding === 'utf16le') {
    try {
      // ICU ignores an incomplete trailing code unit, while its fatal mode
      // still rejects unpaired surrogates.
      const evenBytes = bytes.subarray(0, bytes.length & ~1);
      return new TextDecoder('utf-16le', { fatal: target === 'utf8' }).decode(evenBytes);
    } catch {
      throw transcodeError('U_INVALID_CHAR_FOUND');
    }
  }
  if (encoding === 'ascii' && target === 'utf16le') return decodeSingleByte(bytes);
  if (encoding === 'latin1') return decodeSingleByte(bytes);
  let text = '';
  for (const byte of bytes) text += byte <= 0x7f ? String.fromCharCode(byte) : '\\ufffd';
  return text;
}

function encodeTranscode(text, encoding) {
  if (encoding === 'utf8') return textEncoder.encode(text);
  if (encoding === 'utf16le') return encodeUcs2(text);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[index] = encoding === 'ascii'
      ? (code <= 0x7f ? code : 0x3f)
      : (code <= 0xff ? code : 0x3f);
  }
  return bytes;
}

export function createTranscode(BufferClass) {
  return function transcode(source, fromEncoding, toEncoding) {
    const isUint8Array = source instanceof Uint8Array
      || Object.prototype.toString.call(source) === '[object Uint8Array]';
    if (!isUint8Array) {
      throw invalidArgumentTypeError('source', ['Buffer', 'Uint8Array'], source);
    }
    const bytes = viewBytes(source);
    if (bytes.length === 0) return BufferClass.alloc(0);
    const from = transcodeEncoding(fromEncoding);
    const to = transcodeEncoding(toEncoding);
    if (from === undefined || to === undefined) throw transcodeError();
    return BufferClass.from(encodeTranscode(decodeTranscode(bytes, from, to), to));
  };
}

export function installBlobCompatibility(BlobClass) {
  if (typeof BlobClass !== 'function' || typeof BlobClass.prototype?.bytes === 'function') return BlobClass;
  Object.defineProperty(BlobClass.prototype, 'bytes', {
    configurable: true,
    writable: true,
    value() {
      return this.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    },
  });
  return BlobClass;
}

function missingArgumentError(name) {
  const error = new TypeError(`The "${name}" argument must be specified`);
  error.code = 'ERR_MISSING_ARGS';
  return error;
}

function inspectTypedArray(value) {
  const name = value.constructor?.name || 'TypedArray';
  const values = Array.from(value, (item) => String(item)).join(', ');
  return `${name}(${value.length}) [${values ? ` ${values} ` : ''}]`;
}

function bufferInspect(_recurseTimes, context = {}, inspectValue = null) {
  const max = this.constructor?.__bnhInspectMaxBytes ?? 50;
  const actualMax = Math.min(max, this.length);
  const byteCount = Number.isFinite(actualMax) ? Math.max(0, Math.trunc(actualMax)) : this.length;
  let text = encodeHex(this.subarray(0, byteCount)).replace(/(.{2})/g, '$1 ').trim();
  const remaining = this.length - max;
  if (remaining > 0) text += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;

  const keys = Reflect.ownKeys(this).filter((key) => {
    if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) return false;
    if (context.showHidden) return true;
    return Object.getOwnPropertyDescriptor(this, key)?.enumerable === true;
  });
  if (keys.length > 0) {
    const extras = keys.map((key) => {
      const label = typeof key === 'symbol'
        ? `[${String(key)}]`
        : /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
      let value;
      try { value = this[key]; } catch { value = '<unavailable>'; }
      let inspected;
      if (ArrayBuffer.isView(value) && !(value instanceof DataView)) inspected = inspectTypedArray(value);
      else if (typeof inspectValue === 'function') inspected = inspectValue(value, { ...context, breakLength: Infinity, compact: true });
      else inspected = String(value);
      return `${label}: ${inspected}`;
    });
    if (this.length !== 0) text += ', ';
    text += extras.join(', ');
  }
  let constructorName = 'Buffer';
  try {
    const constructor = this.constructor;
    if (typeof constructor === 'function' && Object.prototype.hasOwnProperty.call(constructor, 'name')) {
      constructorName = constructor.name;
    }
  } catch { /* Ignore errors and use the default name. */ }
  return `<${constructorName} ${text}>`;
}

export function createFileClass(scope = globalThis) {
  if (typeof scope.File === 'function') return scope.File;
  if (typeof scope.Blob !== 'function') return undefined;
  return class File extends scope.Blob {
    constructor(bits, name, options = {}) {
      super(bits, options);
      const lastModified = options?.lastModified === undefined ? Date.now() : Number(options.lastModified);
      Object.defineProperties(this, {
        name: { configurable: true, enumerable: true, value: String(name).replaceAll('/', ':') },
        lastModified: { configurable: true, enumerable: true, value: Number.isFinite(lastModified) ? lastModified : Date.now() },
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Bidirectional byte search with Node.js Buffer#indexOf/#lastIndexOf
// semantics: string needles are encoded through the registry above, number
// needles are truncated to one byte, offsets are clamped like String#indexOf,
// and ucs2 searches stay aligned to two-byte code units.
// ---------------------------------------------------------------------------

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean': return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'string': {
      const text = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return text.includes("'") ? `type string (${JSON.stringify(text)})` : `type string ('${text}')`;
    }
    case 'object': {
      if (value.constructor && typeof value.constructor.name === 'string') return `an instance of ${value.constructor.name}`;
      try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
    }
    default: return `type ${typeof value} (${String(value)})`;
  }
}

function formatList(items) {
  if (items.length <= 2) return items.join(' or ');
  return `${items.slice(0, -1).join(', ')}, or ${items.at(-1)}`;
}

function invalidArgumentTypeError(name, expected, value) {
  const kinds = [];
  const instances = [];
  const other = [];
  const className = /^[A-Z][a-zA-Z0-9]*$/;
  const typeNames = new Set(['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol']);
  for (const item of expected) {
    if (typeNames.has(item)) kinds.push(item.toLowerCase());
    else if (className.test(item)) instances.push(item);
    else other.push(item);
  }
  let message = 'The ';
  if (name.endsWith(' argument')) message += `${name} `;
  else message += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  message += 'must be ';
  if (kinds.length > 0) {
    message += `${kinds.length > 1 ? 'one of type' : 'of type'} ${formatList(kinds)}`;
    if (instances.length > 0 || other.length > 0) message += ' or ';
  }
  if (instances.length > 0) {
    message += `an instance of ${formatList(instances)}`;
    if (other.length > 0) message += ' or ';
  }
  if (other.length > 0) {
    message += other.length > 1 ? `one of ${formatList(other)}` : `${other[0][0] === other[0][0].toUpperCase() ? 'an ' : ''}${other[0]}`;
  }
  message += `. Received ${determineSpecificType(value)}`;
  const error = new TypeError(message);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function unknownEncodingError(encoding) {
  const error = new TypeError(`Unknown encoding: ${encoding}`);
  error.code = 'ERR_UNKNOWN_ENCODING';
  return error;
}

function viewBytes(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function normalizeInteger(value, name, { defaultValue = 0, minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number') throw invalidArgumentTypeError(name, ['number'], value);
  if (!Number.isInteger(value)) throw outOfRangeError(name, 'an integer', value);
  if (value < minimum || value > maximum) throw outOfRangeError(name, `>= ${minimum} && <= ${maximum}`, value);
  return value;
}

function compareRange(value, name, length, defaultValue, clampAbove = false) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number') throw invalidArgumentTypeError(name, ['number'], value);
  if (!Number.isInteger(value) || value < 0 || (!clampAbove && value > length)) throw outOfRangeError(name, `>= 0 && <= ${length}`, value);
  return clampAbove ? Math.min(value, length) : value;
}

function copyRange(value, name, length, defaultValue, clampAbove = false) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return defaultValue;
  if (!Number.isFinite(numeric) || numeric < 0 || (!clampAbove && numeric > length)) {
    throw outOfRangeError(name, '>= 0', value);
  }
  return clampAbove ? Math.min(Math.trunc(numeric), length) : Math.trunc(numeric);
}

function bufferOffset(buffer, offset, width) {
  const position = normalizeInteger(offset, 'offset', { maximum: Math.max(0, buffer.length - width) });
  if (position + width > buffer.length) {
    const error = new RangeError('Attempt to access memory outside buffer bounds');
    error.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
    throw error;
  }
  return position;
}

function variableBufferOffset(buffer, offset, byteLength) {
  const position = normalizeInteger(offset, 'offset', { maximum: Math.max(0, buffer.length - byteLength) });
  if (position + byteLength > buffer.length) {
    const error = new RangeError('Attempt to access memory outside buffer bounds');
    error.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
    throw error;
  }
  return position;
}

function normalizeByteLength(byteLength) {
  if (typeof byteLength !== 'number') throw invalidArgumentTypeError('byteLength', ['number'], byteLength);
  if (!Number.isInteger(byteLength)) throw outOfRangeError('byteLength', 'an integer', byteLength);
  if (byteLength < 1 || byteLength > 6) throw outOfRangeError('byteLength', '>= 1 and <= 6', byteLength);
  return byteLength;
}

function readUnsigned(buffer, offset, byteLength, littleEndian) {
  const position = variableBufferOffset(buffer, offset, byteLength);
  let value = 0;
  if (littleEndian) {
    for (let index = byteLength - 1; index >= 0; index -= 1) value = (value * 256) + buffer[position + index];
  } else {
    for (let index = 0; index < byteLength; index += 1) value = (value * 256) + buffer[position + index];
  }
  return value;
}

function readSigned(buffer, offset, byteLength, littleEndian) {
  const value = readUnsigned(buffer, offset, byteLength, littleEndian);
  const sign = 2 ** (byteLength * 8 - 1);
  return value >= sign ? value - (2 ** (byteLength * 8)) : value;
}

function writeUnsigned(buffer, value, offset, byteLength, littleEndian) {
  const position = variableBufferOffset(buffer, offset, byteLength);
  let numeric = Number(value);
  if (!Number.isFinite(numeric)) throw outOfRangeError('value', 'an integer', value);
  numeric = Math.trunc(numeric);
  const limit = 2 ** (byteLength * 8);
  if (numeric < 0 || numeric >= limit) throw outOfRangeError('value', `>= 0 and <= ${limit - 1}`, value);
  for (let index = 0; index < byteLength; index += 1) {
    const target = littleEndian ? position + index : position + byteLength - index - 1;
    buffer[target] = numeric & 0xff;
    numeric = Math.floor(numeric / 256);
  }
  return position + byteLength;
}

function writeSigned(buffer, value, offset, byteLength, littleEndian) {
  const numeric = Number(value);
  const minimum = -(2 ** (byteLength * 8 - 1));
  const maximum = (2 ** (byteLength * 8 - 1)) - 1;
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw outOfRangeError('value', `>= ${minimum} && <= ${maximum}`, value);
  }
  return writeUnsigned(buffer, numeric < 0 ? numeric + (2 ** (byteLength * 8)) : numeric, offset, byteLength, littleEndian);
}

function readFloat(buffer, offset, width, littleEndian) {
  const position = bufferOffset(buffer, offset, width);
  return new DataView(buffer.buffer, buffer.byteOffset + position, width)[width === 4 ? 'getFloat32' : 'getFloat64'](0, littleEndian);
}

function writeFloat(buffer, value, offset, width, littleEndian) {
  const position = bufferOffset(buffer, offset, width);
  const view = new DataView(buffer.buffer, buffer.byteOffset + position, width);
  view[width === 4 ? 'setFloat32' : 'setFloat64'](0, Number(value), littleEndian);
  return position + width;
}

function readBigInt(buffer, offset, littleEndian, signed) {
  const position = bufferOffset(buffer, offset, 8);
  return new DataView(buffer.buffer, buffer.byteOffset + position, 8)[signed ? 'getBigInt64' : 'getBigUint64'](0, littleEndian);
}

function writeBigInt(buffer, value, offset, littleEndian, signed) {
  if (typeof value !== 'bigint') throw invalidArgumentTypeError('value', ['bigint'], value);
  const position = bufferOffset(buffer, offset, 8);
  new DataView(buffer.buffer, buffer.byteOffset + position, 8)[signed ? 'setBigInt64' : 'setBigUint64'](0, value, littleEndian);
  return position + 8;
}

function swapBytes(buffer, width) {
  if (buffer.length % width !== 0) throw new RangeError(`Buffer size must be a multiple of ${width * 8}-bits`);
  for (let start = 0; start < buffer.length; start += width) {
    for (let left = 0; left < width / 2; left += 1) {
      const right = width - left - 1;
      [buffer[start + left], buffer[start + right]] = [buffer[start + right], buffer[start + left]];
    }
  }
  return buffer;
}

// Port of Node's IndexOfOffset(): maps any requested offset onto a valid
// starting index, or -1/-sentinel positions matching V8's search behaviour.
function searchStart(length, offset, needleLength, forward) {
  if (offset < 0) {
    if (offset + length >= 0) return length + offset;
    return forward || needleLength === 0 ? 0 : -1;
  }
  if (offset + needleLength <= length) return offset;
  if (needleLength === 0) return length;
  return forward ? -1 : length - 1;
}

function prefixTable(needle) {
  const table = new Int32Array(needle.length);
  let matched = 0;
  for (let index = 1; index < needle.length; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) matched = table[matched - 1];
    if (needle[index] === needle[matched]) matched += 1;
    table[index] = matched;
  }
  return table;
}

// Morris-Pratt scan: linear time regardless of how repetitive the inputs are
// (the upstream suite searches multi-megabyte Thue-Morse payloads).
function findForward(seq, needle, start) {
  if (needle.length === 1) {
    const byte = needle[0];
    for (let index = start; index < seq.length; index += 1) if (seq[index] === byte) return index;
    return -1;
  }
  const table = prefixTable(needle);
  let matched = 0;
  for (let index = start; index < seq.length; index += 1) {
    while (matched > 0 && seq[index] !== needle[matched]) matched = table[matched - 1];
    if (seq[index] === needle[matched]) matched += 1;
    if (matched === needle.length) return index - needle.length + 1;
  }
  return -1;
}

// Reverse scan implemented as a forward Morris-Pratt run over mirrored views,
// so the worst-case cost stays linear for lastIndexOf too.
function findBackward(seq, needle, start) {
  const limit = Math.min(start, seq.length - needle.length);
  if (needle.length === 1) {
    const byte = needle[0];
    for (let index = limit; index >= 0; index -= 1) if (seq[index] === byte) return index;
    return -1;
  }
  const window = limit + needle.length;
  const mirrored = new seq.constructor(window);
  for (let index = 0; index < window; index += 1) mirrored[index] = seq[window - 1 - index];
  const mirroredNeedle = new seq.constructor(needle.length);
  for (let index = 0; index < needle.length; index += 1) mirroredNeedle[index] = needle[needle.length - 1 - index];
  const found = findForward(mirrored, mirroredNeedle, 0);
  return found === -1 ? -1 : limit - found;
}

function indexOfBytes(haystack, needle, byteOffset, forward) {
  const needleLength = needle.length;
  const start = searchStart(haystack.length, byteOffset, needleLength, forward);
  if (needleLength === 0) return start;
  if (start <= -1 || haystack.length === 0) return -1;
  if ((forward && start + needleLength > haystack.length) || needleLength > haystack.length) return -1;
  return forward ? findForward(haystack, needle, start) : findBackward(haystack, needle, start);
}

function indexOfNumberByte(haystack, value, byteOffset, forward) {
  const start = searchStart(haystack.length, byteOffset, 1, forward);
  if (start <= -1 || haystack.length === 0) return -1;
  const byte = value & 0xff;
  if (forward) {
    for (let index = start; index < haystack.length; index += 1) if (haystack[index] === byte) return index;
  } else {
    for (let index = Math.min(start, haystack.length - 1); index >= 0; index -= 1) if (haystack[index] === byte) return index;
  }
  return -1;
}

function ucs2Units(bytes) {
  const units = new Uint16Array(bytes.length >>> 1);
  for (let index = 0; index < units.length; index += 1) units[index] = bytes[index * 2] | (bytes[(index * 2) + 1] << 8);
  return units;
}

// String needle: the haystack is rounded down to a whole number of code units
// before offsets are resolved, matching Node's IndexOfString().
function indexOfUcs2String(haystack, text, byteOffset, forward) {
  const length = haystack.length & ~1;
  const needleLength = text.length * 2;
  const start = searchStart(length, byteOffset, needleLength, forward);
  if (needleLength === 0) return start;
  if (start <= -1 || length === 0) return -1;
  if ((forward && start + needleLength > length) || needleLength > length) return -1;
  if (length < 2 || text.length < 1) return -1;
  const needleUnits = new Uint16Array(text.length);
  for (let index = 0; index < text.length; index += 1) needleUnits[index] = text.charCodeAt(index);
  const units = ucs2Units(haystack);
  const found = forward ? findForward(units, needleUnits, start >>> 1) : findBackward(units, needleUnits, start >>> 1);
  return found === -1 ? -1 : found * 2;
}

// Typed-array needle under ucs2: bounds are checked on raw byte lengths and
// only the aligned unit search runs afterwards, matching IndexOfBuffer().
function indexOfUcs2Buffer(haystack, needle, byteOffset, forward) {
  const start = searchStart(haystack.length, byteOffset, needle.length, forward);
  if (needle.length === 0) return start;
  if (start <= -1 || haystack.length === 0) return -1;
  if ((forward && start + needle.length > haystack.length) || needle.length > haystack.length) return -1;
  if (haystack.length < 2 || needle.length < 2) return -1;
  const units = ucs2Units(haystack);
  const needleUnits = ucs2Units(needle);
  const found = forward ? findForward(units, needleUnits, start >>> 1) : findBackward(units, needleUnits, start >>> 1);
  return found === -1 ? -1 : found * 2;
}

function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
  if (!ArrayBuffer.isView(buffer)) {
    throw invalidArgumentTypeError('buffer', ['Buffer', 'TypedArray', 'DataView'], buffer);
  }
  if (typeof byteOffset === 'string') {
    encoding = byteOffset;
    byteOffset = undefined;
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff;
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000;
  }
  byteOffset = +byteOffset;
  if (Number.isNaN(byteOffset)) byteOffset = dir ? 0 : (buffer.length || buffer.byteLength);

  const haystack = viewBytes(buffer);
  if (typeof val === 'number') return indexOfNumberByte(haystack, val >>> 0, byteOffset, dir);

  const ops = encoding === undefined ? UTF8_OPS : resolveEncodingOps(encoding);

  if (typeof val === 'string') {
    if (ops === undefined) throw unknownEncodingError(encoding);
    if (ops.search === 'ucs2') return indexOfUcs2String(haystack, val, byteOffset, dir);
    return indexOfBytes(haystack, ops.encode(val), byteOffset, dir);
  }

  if (val instanceof Uint8Array) {
    const needle = viewBytes(val);
    if (ops !== undefined && ops.search === 'ucs2') return indexOfUcs2Buffer(haystack, needle, byteOffset, dir);
    return indexOfBytes(haystack, needle, byteOffset, dir);
  }

  throw invalidArgumentTypeError('value', ['number', 'string', 'Buffer', 'Uint8Array'], val);
}

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function isAnyArrayBuffer(value) {
  try {
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(value);
    return true;
  } catch {
    if (typeof SharedArrayBuffer !== 'function') return false;
    try {
      Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get.call(value);
      return true;
    } catch {
      return false;
    }
  }
}

function isDetached(arrayBuffer) {
  try {
    arrayBuffer.slice(0);
    return false;
  } catch (e) {
    return /detached/i.test(e.message);
  }
}

function getBytes(value) {
  if (isTypedArray(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isAnyArrayBuffer(value)) {
    if (isDetached(value)) {
      const error = new TypeError('Cannot validate on a detached buffer');
      error.code = 'ERR_INVALID_STATE';
      throw error;
    }
    return new Uint8Array(value);
  }
  const error = new TypeError(`The "input" argument must be of type ArrayBuffer, Buffer, or TypedArray. Received ${value === null ? 'null' : typeof value}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  throw error;
}

export function isAscii(input) {
  const bytes = getBytes(input);
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 127) return false;
  }
  return true;
}

export function isUtf8(input) {
  const bytes = getBytes(input);
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function createBufferClass(scope = globalThis) {
  const internalBuffer = Symbol('internal buffer');
  const untransferableMarker = Symbol.for('nodejs.worker_threads.untransferable');
  const objectURLRegistryKey = Symbol.for('bnh.buffer.objectURLRegistry');
  const objectURLWrapperKey = Symbol.for('bnh.buffer.objectURLWrappers');
  const urlClass = scope?.URL;
  const objectURLRegistry = urlClass?.[objectURLRegistryKey] || new Map();
  if (urlClass && typeof urlClass.createObjectURL === 'function' && !urlClass[objectURLWrapperKey]) {
    const nativeCreateObjectURL = urlClass.createObjectURL;
    const nativeRevokeObjectURL = urlClass.revokeObjectURL;
    const wrappers = {
      registry: objectURLRegistry,
      createObjectURL(blob) {
        const url = nativeCreateObjectURL.call(urlClass, blob);
        objectURLRegistry.set(url, blob);
        return url;
      },
      revokeObjectURL(url) {
        objectURLRegistry.delete(url);
        return typeof nativeRevokeObjectURL === 'function'
          ? nativeRevokeObjectURL.call(urlClass, url)
          : undefined;
      },
    };
    try {
      Object.defineProperty(urlClass, objectURLRegistryKey, { configurable: true, value: objectURLRegistry });
      Object.defineProperty(urlClass, objectURLWrapperKey, { configurable: true, value: wrappers });
      Object.defineProperty(urlClass, 'createObjectURL', { configurable: true, writable: true, value: wrappers.createObjectURL });
      if (typeof nativeRevokeObjectURL === 'function') {
        Object.defineProperty(urlClass, 'revokeObjectURL', { configurable: true, writable: true, value: wrappers.revokeObjectURL });
      }
    } catch { /* URL implementations may expose immutable static methods. */ }
  }
  const nativeAtob = typeof scope?.atob === 'function' ? scope.atob.bind(scope) : null;
  const nativeBtoa = typeof scope?.btoa === 'function' ? scope.btoa.bind(scope) : null;
  const nodeAtob = function atob(input) {
    if (arguments.length === 0) throw missingArgumentError('input');
    if (!nativeAtob) throw new TypeError('atob is not available in this browser');
    return nativeAtob(`${input}`);
  };
  const nodeBtoa = function btoa(input) {
    if (arguments.length === 0) throw missingArgumentError('input');
    if (!nativeBtoa) throw new TypeError('btoa is not available in this browser');
    return nativeBtoa(`${input}`);
  };
  let poolBuffer = null;
  let poolOffset = 0;
  const pooledBytes = (size) => {
    if (size <= 0 || size > 4096) return null;
    if (!poolBuffer || poolOffset + size > 8192) {
      poolBuffer = new ArrayBuffer(8192);
      poolOffset = 0;
      try { Object.defineProperty(poolBuffer, untransferableMarker, { configurable: true, value: true }); } catch { /* host buffer may be sealed */ }
    }
    const view = new Uint8Array(poolBuffer, poolOffset, size);
    poolOffset += size;
    return view;
  };
  let warningEmitted = false;
  class NodeBuffer extends Uint8Array {
    // Typed-array slice/subarray consult species before our methods can wrap
    // the result with the internal marker. Returning Uint8Array here prevents
    // those internal operations from re-entering the public Buffer() wrapper.
    static get [Symbol.species]() { return Uint8Array; }

    constructor(...args) {
      const internal = args.at(-1) === internalBuffer;
      if (internal) args.pop();
      const processObj = typeof globalThis !== 'undefined' ? globalThis.process : undefined;
      const filename = globalThis.__bnhVmFilename || processObj?.mainModule?.filename || '';
      if (!internal && !filename.includes('node_modules') && !warningEmitted) {
        warningEmitted = true;
        processObj?.emitWarning?.(
          'Buffer() is deprecated due to security and usability issues. Please use the Buffer.alloc(), Buffer.allocUnsafe(), or Buffer.from() methods instead.',
          'DeprecationWarning',
          'DEP0005',
        );
      }
      const value = args[0];
      if (typeof value === 'string') {
        super(bytesFrom(value, args[1]));
      } else if (typeof value === 'number') {
        if (typeof args[1] === 'string') throw invalidArgumentTypeError('string', ['string'], value);
        super(validateBufferSize(value));
      } else if (value === null) {
        throw invalidArgumentTypeError('first argument', ['string', 'Buffer', 'ArrayBuffer', 'Array', 'Array-like Object'], value);
      } else {
        super(...args);
      }
    }
    static from(value, encodingOrOffset, length) {
      if (isAnyArrayBuffer(value)) {
        if (encodingOrOffset !== undefined && typeof encodingOrOffset === 'number' && !Number.isFinite(encodingOrOffset)) {
          throw outOfRangeError('offset', 'an integer', encodingOrOffset);
        }
        const offset = typeof encodingOrOffset === 'number' && Number.isFinite(encodingOrOffset)
          ? normalizeInteger(encodingOrOffset, 'byteOffset')
          : 0;
        const available = value.byteLength - offset;
        const size = length === undefined
          ? available
          : normalizeInteger(length, 'length', { maximum: value.byteLength });
        if (offset > value.byteLength) {
          const error = new RangeError('"offset" is outside of buffer bounds');
          error.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
          throw error;
        }
        if (size > available) {
          const error = new RangeError('"length" is outside of buffer bounds');
          error.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
          throw error;
        }
        return length === undefined
          ? new NodeBuffer(value, offset, internalBuffer)
          : new NodeBuffer(value, offset, size, internalBuffer);
      }
      const bytes = bytesFrom(value, encodingOrOffset);
      const pooled = pooledBytes(bytes.byteLength);
      if (pooled) {
        pooled.set(bytes);
        return new NodeBuffer(pooled.buffer, pooled.byteOffset, pooled.byteLength, internalBuffer);
      }
      return new NodeBuffer(bytes, internalBuffer);
    }
    static alloc(size, fill = 0, encoding) {
      const result = new NodeBuffer(validateBufferSize(size), internalBuffer);
      if (result.length === 0 || fill === 0 || fill === null || fill === undefined || fill === '') return result;
      if (typeof fill === 'number') {
        result.fill(fill);
        return result;
      }
      if (typeof fill === 'string' && encoding !== undefined && encoding !== null && typeof encoding !== 'string') {
        throw invalidArgumentTypeError('encoding', ['string'], encoding);
      }
      const bytes = bytesFrom(fill, encoding);
      if (bytes.length === 0) return result;
      for (let index = 0; index < result.length; index += 1) result[index] = bytes[index % bytes.length];
      return result;
    }
    static allocUnsafe(size) { return new NodeBuffer(validateBufferSize(size), internalBuffer); }
    static allocUnsafeSlow(size) { return new NodeBuffer(validateBufferSize(size), internalBuffer); }
    static isBuffer(value) { return value instanceof NodeBuffer; }
    static isEncoding(encoding) {
      return typeof encoding === 'string' && resolveEncodingOps(encoding) !== undefined;
    }
    static byteLength(value, encoding = 'utf8') {
      if (typeof value !== 'string') {
        if (ArrayBuffer.isView(value) || isAnyArrayBuffer(value)) return value.byteLength;
        throw invalidArgumentTypeError('string', ['string', 'Buffer', 'ArrayBuffer'], value);
      }
      return encodingOpsOrUtf8(encoding).encode(value).byteLength;
    }
    static concat(list, totalLength) {
      if (!Array.isArray(list)) throw invalidArgumentTypeError('list', ['Array'], list);
      const values = list.map((value) => bytesFrom(value));
      const size = totalLength === undefined
        ? values.reduce((sum, value) => sum + value.length, 0)
        : normalizeInteger(totalLength, 'length', { maximum: 0x7fffffff });
      const result = new NodeBuffer(size, internalBuffer);
      let offset = 0;
      for (const value of values) { result.set(value.subarray(0, size - offset), offset); offset += value.length; }
      return result;
    }
    static compare(left, right) {
      if (!(left instanceof Uint8Array)) throw invalidArgumentTypeError('buf1', ['Buffer', 'Uint8Array'], left);
      if (!(right instanceof Uint8Array)) throw invalidArgumentTypeError('buf2', ['Buffer', 'Uint8Array'], right);
      const a = bytesFrom(left); const b = bytesFrom(right);
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }
    static copyBytesFrom(view, offset = 0, length = view?.byteLength - offset) {
      if (!isTypedArray(view)) throw invalidArgumentTypeError('view', ['TypedArray'], view);
      const start = normalizeInteger(offset, 'offset', { maximum: view.byteLength });
      const size = normalizeInteger(length, 'length', { maximum: view.byteLength - start });
      return new NodeBuffer(new Uint8Array(view.buffer, view.byteOffset + start, size), internalBuffer);
    }
    toString(encoding, start, end) { return encoded(this.subarray(start, end), encoding); }
    utf8Slice(start, end) {
      const [first, last] = nativeSliceRange(this.length, start, end);
      return textDecoder.decode(this.subarray(first, last));
    }
    equals(other) {
      if (!(other instanceof Uint8Array)) throw invalidArgumentTypeError('otherBuffer', ['Buffer', 'Uint8Array'], other);
      return NodeBuffer.compare(this, other) === 0;
    }
    compare(other, targetStart, targetEnd, sourceStart, sourceEnd) {
      if (!(other instanceof Uint8Array)) throw invalidArgumentTypeError('target', ['Buffer', 'Uint8Array'], other);
      const targetFirst = compareRange(targetStart, 'targetStart', other.length, 0, true);
      const targetLast = compareRange(targetEnd, 'targetEnd', other.length, other.length);
      const sourceFirst = compareRange(sourceStart, 'sourceStart', this.length, 0, true);
      const sourceLast = compareRange(sourceEnd, 'sourceEnd', this.length, this.length);
      return NodeBuffer.compare(
        this.subarray(sourceFirst, Math.max(sourceFirst, sourceLast)),
        other.subarray(targetFirst, Math.max(targetFirst, targetLast)),
      );
    }
    slice(start, end) { return new NodeBuffer(super.slice(start, end), internalBuffer); }
    subarray(start, end) { return new NodeBuffer(super.subarray(start, end), internalBuffer); }
    fill(value, start, end, encoding) {
      if (this.length > this.byteLength) {
        const error = new RangeError('Attempt to access memory outside buffer bounds');
        error.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
        throw error;
      }
      if (typeof start === 'string') {
        encoding = start;
        start = 0;
        end = this.length;
      } else if (typeof end === 'string') {
        encoding = end;
        end = this.length;
      }
      const first = normalizeInteger(start, 'start', { maximum: this.length });
      const last = normalizeInteger(end, 'end', { defaultValue: this.length, maximum: this.length });
      if (encoding !== undefined && encoding !== null && typeof encoding !== 'string') {
        throw invalidArgumentTypeError('encoding', ['string'], encoding);
      }
      if (value === null || value === undefined) value = 0;
      if (typeof value === 'string') encodingOpsOrThrow(encoding);
      if (first >= last) return this;
      if (typeof value === 'number') {
        super.fill(value, first, last);
        return this;
      }
      const bytes = value instanceof Uint8Array
        ? viewBytes(value)
        : bytesFrom(String(value), encoding);
      if (bytes.length === 0) {
        if (encoding?.toLowerCase() === 'hex' && String(value).length > 0) {
          throw invalidArgumentValueError('value', value);
        }
        return this;
      }
      for (let index = first; index < last; index += 1) this[index] = bytes[(index - first) % bytes.length];
      return this;
    }
    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
      if (!ArrayBuffer.isView(this)) throw invalidArgumentTypeError('this', ['Buffer', 'Uint8Array'], this);
      if (!(target instanceof Uint8Array)) throw invalidArgumentTypeError('target', ['Buffer', 'Uint8Array'], target);
      const targetOffset = copyRange(targetStart, 'targetStart', target.length, 0, true);
      const sourceOffset = copyRange(sourceStart, 'sourceStart', this.length, 0);
      const sourceLimit = copyRange(sourceEnd, 'sourceEnd', this.length, this.length, true);
      if (targetOffset >= target.length || sourceOffset >= sourceLimit || sourceOffset >= this.length) return 0;
      const count = Math.min(sourceLimit - sourceOffset, target.length - targetOffset);
      target.set(this.subarray(sourceOffset, sourceOffset + count), targetOffset);
      return count;
    }
    readUInt8(offset) { return readUnsigned(this, offset, 1, false); }
    readUInt16LE(offset) { return readUnsigned(this, offset, 2, true); }
    readUInt16BE(offset) { return readUnsigned(this, offset, 2, false); }
    readUInt32LE(offset) { return readUnsigned(this, offset, 4, true); }
    readUInt32BE(offset) { return readUnsigned(this, offset, 4, false); }
    readInt8(offset) { return readSigned(this, offset, 1, false); }
    readInt16LE(offset) { return readSigned(this, offset, 2, true); }
    readInt16BE(offset) { return readSigned(this, offset, 2, false); }
    readInt32LE(offset) { return readSigned(this, offset, 4, true); }
    readInt32BE(offset) { return readSigned(this, offset, 4, false); }
    readUIntLE(offset, byteLength) { return readUnsigned(this, offset, normalizeByteLength(byteLength), true); }
    readUIntBE(offset, byteLength) { return readUnsigned(this, offset, normalizeByteLength(byteLength), false); }
    readIntLE(offset, byteLength) { return readSigned(this, offset, normalizeByteLength(byteLength), true); }
    readIntBE(offset, byteLength) { return readSigned(this, offset, normalizeByteLength(byteLength), false); }
    readFloatLE(offset) { return readFloat(this, offset, 4, true); }
    readFloatBE(offset) { return readFloat(this, offset, 4, false); }
    readDoubleLE(offset) { return readFloat(this, offset, 8, true); }
    readDoubleBE(offset) { return readFloat(this, offset, 8, false); }
    readBigUInt64LE(offset) { return readBigInt(this, offset, true, false); }
    readBigUInt64BE(offset) { return readBigInt(this, offset, false, false); }
    readBigInt64LE(offset) { return readBigInt(this, offset, true, true); }
    readBigInt64BE(offset) { return readBigInt(this, offset, false, true); }
    writeUInt8(value, offset) { return writeUnsigned(this, value, offset, 1, false); }
    writeUInt16LE(value, offset) { return writeUnsigned(this, value, offset, 2, true); }
    writeUInt16BE(value, offset) { return writeUnsigned(this, value, offset, 2, false); }
    writeUInt32LE(value, offset) { return writeUnsigned(this, value, offset, 4, true); }
    writeUInt32BE(value, offset) { return writeUnsigned(this, value, offset, 4, false); }
    writeInt8(value, offset) { return writeSigned(this, value, offset, 1, false); }
    writeInt16LE(value, offset) { return writeSigned(this, value, offset, 2, true); }
    writeInt16BE(value, offset) { return writeSigned(this, value, offset, 2, false); }
    writeInt32LE(value, offset) { return writeSigned(this, value, offset, 4, true); }
    writeInt32BE(value, offset) { return writeSigned(this, value, offset, 4, false); }
    writeUIntLE(value, offset, byteLength) { return writeUnsigned(this, value, offset, normalizeByteLength(byteLength), true); }
    writeUIntBE(value, offset, byteLength) { return writeUnsigned(this, value, offset, normalizeByteLength(byteLength), false); }
    writeIntLE(value, offset, byteLength) { return writeSigned(this, value, offset, normalizeByteLength(byteLength), true); }
    writeIntBE(value, offset, byteLength) { return writeSigned(this, value, offset, normalizeByteLength(byteLength), false); }
    writeFloatLE(value, offset) { return writeFloat(this, value, offset, 4, true); }
    writeFloatBE(value, offset) { return writeFloat(this, value, offset, 4, false); }
    writeDoubleLE(value, offset) { return writeFloat(this, value, offset, 8, true); }
    writeDoubleBE(value, offset) { return writeFloat(this, value, offset, 8, false); }
    writeBigUInt64LE(value, offset) { return writeBigInt(this, value, offset, true, false); }
    writeBigUInt64BE(value, offset) { return writeBigInt(this, value, offset, false, false); }
    writeBigInt64LE(value, offset) { return writeBigInt(this, value, offset, true, true); }
    writeBigInt64BE(value, offset) { return writeBigInt(this, value, offset, false, true); }
    swap16() { return swapBytes(this, 2); }
    swap32() { return swapBytes(this, 4); }
    swap64() { return swapBytes(this, 8); }
    write(value, offset, length, encoding) {
      if (typeof value !== 'string') throw invalidArgumentTypeError('argument', ['string'], value);
      if (offset === undefined) {
        offset = 0;
        length = this.length;
      } else if (length === undefined && typeof offset === 'string') {
        encoding = offset;
        offset = 0;
        length = this.length;
      } else {
        if (typeof offset !== 'number') throw invalidArgumentTypeError('offset', ['number'], offset);
        if (!Number.isInteger(offset) || offset < 0 || offset > this.length) {
          throw outOfRangeError('offset', `an integer between 0 and ${this.length}`, offset);
        }
        const remaining = this.length - offset;
        if (length === undefined) {
          length = remaining;
        } else if (typeof length === 'string') {
          encoding = length;
          length = remaining;
        } else {
          if (typeof length !== 'number') throw invalidArgumentTypeError('length', ['number'], length);
          if (!Number.isInteger(length) || length < 0 || length > this.length) {
            throw outOfRangeError('length', `an integer between 0 and ${this.length}`, length);
          }
          length = Math.min(length, remaining);
        }
      }
      if (encoding === undefined || encoding === 'utf8') return this.utf8Write(value, offset, length);
      if (encoding === 'ascii') return this.asciiWrite(value, offset, length);
      const operations = encodingOpsOrThrow(encoding);
      if (operations === BASE64_OPS) return this.base64Write(value, offset, length);
      if (operations === BASE64URL_OPS) return this.base64urlWrite(value, offset, length);
      if (operations === LATIN1_OPS) return this.latin1Write(value, offset, length);
      if (operations === HEX_OPS) return this.hexWrite(value, offset, length);
      if (operations === UCS2_OPS) return this.ucs2Write(value, offset, length);
      return this.utf8Write(value, offset, length);
    }
    asciiWrite(value, offset, length) { return nativeWrite(this, value, offset, length, ASCII_OPS); }
    base64Write(value, offset, length) { return nativeWrite(this, value, offset, length, BASE64_OPS, false); }
    base64urlWrite(value, offset, length) { return nativeWrite(this, value, offset, length, BASE64URL_OPS, false); }
    latin1Write(value, offset, length) { return nativeWrite(this, value, offset, length, LATIN1_OPS); }
    hexWrite(value, offset, length) { return nativeWrite(this, value, offset, length, HEX_OPS, false); }
    ucs2Write(value, offset, length) { return nativeWrite(this, value, offset, length, UCS2_OPS, false); }
    utf8Write(value, offset, length) { return nativeWrite(this, value, offset, length, UTF8_OPS); }
    toJSON() { return { type: 'Buffer', data: [...this] }; }
  }
  // Plain functions (not class methods): Buffer#lastIndexOf must remain
  // constructible so misuse reports ERR_INVALID_ARG_TYPE instead of failing
  // with a generic "not a constructor" error.
  NodeBuffer.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
    return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
  };
  NodeBuffer.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
    return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
  };
  Object.assign(NodeBuffer.prototype, {
    readBigUint64LE: NodeBuffer.prototype.readBigUInt64LE,
    readBigUint64BE: NodeBuffer.prototype.readBigUInt64BE,
    writeBigUint64LE: NodeBuffer.prototype.writeBigUInt64LE,
    writeBigUint64BE: NodeBuffer.prototype.writeBigUInt64BE,
    readUintLE: NodeBuffer.prototype.readUIntLE,
    readUint32LE: NodeBuffer.prototype.readUInt32LE,
    readUint16LE: NodeBuffer.prototype.readUInt16LE,
    readUint8: NodeBuffer.prototype.readUInt8,
    readUintBE: NodeBuffer.prototype.readUIntBE,
    readUint32BE: NodeBuffer.prototype.readUInt32BE,
    readUint16BE: NodeBuffer.prototype.readUInt16BE,
    writeUintLE: NodeBuffer.prototype.writeUIntLE,
    writeUint32LE: NodeBuffer.prototype.writeUInt32LE,
    writeUint16LE: NodeBuffer.prototype.writeUInt16LE,
    writeUint8: NodeBuffer.prototype.writeUInt8,
    writeUintBE: NodeBuffer.prototype.writeUIntBE,
    writeUint16BE: NodeBuffer.prototype.writeUInt16BE,
    writeUint32BE: NodeBuffer.prototype.writeUInt32BE,
    asciiSlice,
    base64Slice,
    base64urlSlice,
    latin1Slice,
    hexSlice,
    ucs2Slice,
  });
  NodeBuffer.prototype.includes = function includes(val, byteOffset, encoding) {
    return this.indexOf(val, byteOffset, encoding) !== -1;
  };
  Object.defineProperties(NodeBuffer.prototype, {
    parent: { enumerable: true, get() { return this instanceof NodeBuffer ? this.buffer : undefined; } },
    offset: { enumerable: true, get() { return this instanceof NodeBuffer ? this.byteOffset : undefined; } },
  });
  NodeBuffer.prototype.toLocaleString = NodeBuffer.prototype.toString;
  NodeBuffer.poolSize = 8192;
  function Buffer(...args) {
    return new NodeBuffer(...args);
  }
  Object.setPrototypeOf(Buffer, NodeBuffer);
  Buffer.prototype = NodeBuffer.prototype;
  Object.defineProperty(NodeBuffer.prototype, 'constructor', { value: Buffer, configurable: true, writable: true });
  const maxLength = MAX_BUFFER_LENGTH;
  const maxStringLength = 0x1fffffe8;
  const constants = Object.freeze({ MAX_LENGTH: maxLength, MAX_STRING_LENGTH: maxStringLength });
  Buffer.constants = constants;
  Buffer.kMaxLength = maxLength;
  Buffer.kStringMaxLength = maxStringLength;
  Buffer.SlowBuffer = function SlowBuffer(size) { return Buffer.alloc(size); };
  let inspectMaxBytes = 50;
  Object.defineProperty(Buffer, '__bnhInspectMaxBytes', { configurable: true, value: inspectMaxBytes });
  Object.defineProperty(NodeBuffer.prototype, 'inspect', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: bufferInspect,
  });
  Object.defineProperty(NodeBuffer.prototype, Symbol.for('nodejs.util.inspect.custom'), {
    configurable: true,
    writable: true,
    value: bufferInspect,
  });
  Object.defineProperty(Buffer, 'INSPECT_MAX_BYTES', {
    configurable: true,
    enumerable: true,
    get() { return inspectMaxBytes; },
    set(value) {
      if (typeof value !== 'number') throw invalidArgumentTypeError('INSPECT_MAX_BYTES', ['number'], value);
      if (Number.isNaN(value) || value < 0) throw outOfRangeError('INSPECT_MAX_BYTES', '>= 0', value);
      inspectMaxBytes = value;
      Object.defineProperty(Buffer, '__bnhInspectMaxBytes', { configurable: true, value });
    },
  });
  Buffer.atob = nodeAtob;
  Buffer.btoa = nodeBtoa;
  Buffer.resolveObjectURL = (url) => objectURLRegistry.get(url);
  return Buffer;
}
