import { assertByteLength, hex } from './binary.js';
import { UnsupportedWebCapabilityError } from './errors.js';
import { createDiffieHellman, createDiffieHellmanGroup } from './diffie-hellman.js';
import { Transform, Writable } from './streams.js';

const objectToString = Object.prototype.toString;
const virtualKeyPairs = new Map();
const cryptoKeyMaterialMarker = Symbol.for('bnh.cryptoKeyMaterial');
const cryptoKeyTrackerMarker = Symbol.for('bnh.cryptoKeyTracker');
const VERIFY_SYNC_BLOCKER = 'Web Crypto exposes only asynchronous SubtleCrypto.verify; no browser-native synchronous verifier is available for this key';
const X509_PARSER_BLOCKER = 'Web Crypto exposes key operations but no browser-native X.509 parser or certificate-chain field extraction';
const LEGACY_CIPHER_BLOCKER = 'Web Crypto exposes cipher operations asynchronously; the Node legacy Cipheriv API is synchronous and stream-based';
const PRIME_BLOCKER = 'Web Crypto does not expose browser-native prime testing';
const KEY_OBJECT_BLOCKER = 'Web Crypto returns CryptoKey objects, but this browser runtime has no synchronous Node KeyObject adapter for generated symmetric keys';

const CRYPTO_CONSTANTS = Object.freeze({
  ENGINE_METHOD_ALL: 65535,
  ENGINE_METHOD_NONE: 0,
  ENGINE_METHOD_RSA: 1,
  ENGINE_METHOD_DSA: 2,
  ENGINE_METHOD_DH: 4,
  ENGINE_METHOD_RAND: 8,
  ENGINE_METHOD_EC: 2048,
  ENGINE_METHOD_CIPHERS: 64,
  ENGINE_METHOD_DIGESTS: 128,
  ENGINE_METHOD_PKEY_METHS: 512,
  ENGINE_METHOD_PKEY_ASN1_METHS: 1024,
  DH_CHECK_P_NOT_PRIME: 1,
  DH_CHECK_P_NOT_SAFE_PRIME: 2,
  DH_NOT_SUITABLE_GENERATOR: 8,
  DH_UNABLE_TO_CHECK_GENERATOR: 4,
  SSL_OP_ALL: 2147485776,
  SSL_OP_ALLOW_NO_DHE_KEX: 1024,
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144,
  SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304,
  SSL_OP_CISCO_ANYCONNECT: 32768,
  SSL_OP_COOKIE_EXCHANGE: 8192,
  SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648,
  SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048,
  SSL_OP_LEGACY_SERVER_CONNECT: 4,
  SSL_OP_NO_COMPRESSION: 131072,
  SSL_OP_NO_ENCRYPT_THEN_MAC: 524288,
  SSL_OP_NO_QUERY_MTU: 4096,
  SSL_OP_NO_RENEGOTIATION: 1073741824,
  SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536,
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_X931_PADDING: 5,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_AUTO: -2,
  RSA_PSS_SALTLEN_MAX_SIGN: -2,
  POINT_CONVERSION_COMPRESSED: 2,
  POINT_CONVERSION_UNCOMPRESSED: 4,
  POINT_CONVERSION_HYBRID: 6,
  TLS1_VERSION: 769,
  TLS1_1_VERSION: 770,
  TLS1_2_VERSION: 771,
  TLS1_3_VERSION: 772,
  OPENSSL_VERSION_NUMBER: 810549360,
  SSL_OP_NO_SSLv2: 0,
  SSL_OP_NO_SSLv3: 33554432,
  SSL_OP_NO_TICKET: 16384,
  SSL_OP_NO_TLSv1: 67108864,
  SSL_OP_NO_TLSv1_1: 268435456,
  SSL_OP_NO_TLSv1_2: 134217728,
  SSL_OP_NO_TLSv1_3: 536870912,
  SSL_OP_PRIORITIZE_CHACHA: 2097152,
  SSL_OP_TLS_ROLLBACK_BUG: 8388608,
  defaultCoreCipherList: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA',
  defaultCipherList: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA',
});

export const cryptoConstants = CRYPTO_CONSTANTS;

function isArrayBuffer(value) {
  return value !== null && typeof value === 'object'
    && ['[object ArrayBuffer]', '[object SharedArrayBuffer]'].includes(objectToString.call(value));
}

function isArrayBufferView(value) {
  return value !== null && typeof value === 'object'
    && typeof ArrayBuffer?.isView === 'function' && ArrayBuffer.isView(value);
}

export function hasWebCrypto(globalObject = globalThis) {
  const crypto = globalObject?.crypto;
  return Boolean(crypto
    && typeof crypto.getRandomValues === 'function'
    && crypto.subtle
    && typeof crypto.subtle.digest === 'function');
}

export function installCryptoKeyMaterialTracking(globalObject = globalThis) {
  const subtle = globalObject?.crypto?.subtle;
  if (!subtle) return;
  if (typeof subtle.importKey === 'function' && !subtle[cryptoKeyTrackerMarker]) {
    const importKey = subtle.importKey.bind(subtle);
    const wrappedImportKey = function wrappedImportKey(...args) {
      const result = importKey(...args);
      if (args[0] !== 'raw') return result;
      const material = new Uint8Array(toCryptoBytes(args[1], globalObject.TextEncoder));
      return Promise.resolve(result).then((key) => {
        try {
          Object.defineProperty(key, cryptoKeyMaterialMarker, {
            configurable: true,
            value: material,
          });
        } catch { /* Some native key objects may be sealed. */ }
        return key;
      });
    };
    try {
      Object.defineProperty(subtle, 'importKey', {
        configurable: true,
        value: wrappedImportKey,
      });
      Object.defineProperty(subtle, cryptoKeyTrackerMarker, {
        configurable: true,
        value: true,
      });
    } catch { /* Native SubtleCrypto implementations may be immutable. */ }
  }
  if (typeof subtle.digest !== 'function' || subtle[Symbol.for('bnh.cryptoDigestCompatibility')]) return;
  const nativeDigest = subtle.digest.bind(subtle);
  const wrappedDigest = function wrappedDigest(algorithm, value) {
    let input;
    try {
      input = toCryptoBytes(value, globalObject.TextEncoder);
    } catch {
      return Promise.reject(invalidCryptoInput('data', value));
    }
    return Promise.resolve(nativeDigest(algorithm, input)).catch((error) => {
      if (error?.name !== 'NotSupportedError') throw error;
      const DOMExceptionClass = globalObject.DOMException || globalThis.DOMException;
      if (typeof DOMExceptionClass === 'function') {
        throw new DOMExceptionClass('Unrecognized algorithm name', 'NotSupportedError');
      }
      const translated = new Error('Unrecognized algorithm name');
      translated.name = 'NotSupportedError';
      throw translated;
    });
  };
  try {
    Object.defineProperty(subtle, 'digest', {
      configurable: true,
      value: wrappedDigest,
    });
    Object.defineProperty(subtle, Symbol.for('bnh.cryptoDigestCompatibility'), {
      configurable: true,
      value: true,
    });
  } catch { /* Native SubtleCrypto implementations may be immutable. */ }
}

export function browserCryptoVersion(globalObject = globalThis) {
  return hasWebCrypto(globalObject) ? '3.0.0' : undefined;
}

/** Accept buffers created by another browser realm without importing host state. */
function toCryptoBytes(value, encoder = globalThis.TextEncoder) {
  if (typeof value === 'string') return new encoder().encode(value);
  if (isArrayBufferView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isArrayBuffer(value)) return new Uint8Array(value);
  if (value?.type === 'secret' && value.key) return toCryptoBytes(value.key, encoder);
  throw new TypeError('crypto input must be a string or byte array');
}

function receivedType(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  if (typeof value === 'string') return `type string ('${value}')`;
  return `type ${typeof value} (${String(value)})`;
}

function invalidCryptoInput(name, value) {
  const error = new TypeError(
    `The "${name}" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ${receivedType(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidArgumentType(name, expected, value) {
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${receivedType(value)}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidPropertyType(name, expected, value) {
  const error = new TypeError(`The "${name}" property must be ${expected}. Received ${receivedType(value)}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidPropertyValue(name, value, allowed) {
  void allowed;
  const shown = typeof value === 'string'
    ? `'${value}'`
    : value === undefined
      ? 'undefined'
      : value === null
        ? 'null'
        : Array.isArray(value)
          ? '[]'
          : typeof value === 'object'
            ? '{}'
            : String(value);
  const error = new TypeError(`The property '${name}' is invalid. Received ${shown}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function invalidArgumentValue(name, value, allowed) {
  const shown = typeof value === 'string' ? `'${value}'` : String(value);
  const error = new TypeError(`The argument '${name}' must be ${allowed}. Received ${shown}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function outOfRangeProperty(name, value, detail = 'It must be an integer.') {
  const error = new RangeError(`The value of "${name}" is out of range. ${detail} Received ${String(value)}`);
  error.code = 'ERR_OUT_OF_RANGE';
  return error;
}

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function bytes(value, encoder = globalThis.TextEncoder) {
  return new Uint8Array(toCryptoBytes(value, encoder));
}

// Node's crypto stream constructors inherit these enumerable lazy accessors
// from internal/streams/lazy_transform. The browser Transform constructor is
// class-based, so mirror the observable accessor contract without invoking it
// as a legacy function.
function installLazyTransformStateAccessors(prototype) {
  const ensureState = (receiver) => {
    if (Object.prototype.hasOwnProperty.call(receiver, '_readableState')
      && Object.prototype.hasOwnProperty.call(receiver, '_writableState')) return;
    const stream = new Transform(receiver._options || {});
    Object.defineProperties(receiver, {
      _readableState: {
        configurable: true,
        enumerable: true,
        value: stream._readableState,
        writable: true,
      },
      _writableState: {
        configurable: true,
        enumerable: true,
        value: stream._writableState,
        writable: true,
      },
      allowHalfOpen: {
        configurable: true,
        enumerable: true,
        value: stream.allowHalfOpen,
        writable: true,
      },
    });
  };
  const getter = (name) => function getState() {
    ensureState(this);
    return this[name];
  };
  const setter = (name) => function setState(value) {
    Object.defineProperty(this, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  };

  Object.defineProperties(prototype, {
    _readableState: {
      configurable: true,
      enumerable: true,
      get: getter('_readableState'),
      set: setter('_readableState'),
    },
    _writableState: {
      configurable: true,
      enumerable: true,
      get: getter('_writableState'),
      set: setter('_writableState'),
    },
  });
}

function installLazyTransformAllowHalfOpen(prototype) {
  Object.defineProperty(prototype, 'allowHalfOpen', {
    configurable: true,
    enumerable: true,
    get() {
      return undefined;
    },
    set(value) {
      Object.defineProperty(this, 'allowHalfOpen', {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
  });
}

function rotr(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const SHA224_INITIAL = Object.freeze([
  0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511,
  0x64f98fa7, 0xbefa4fa4,
]);

function sha256Digest(value, initialHash) {
  const input = bytes(value);
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  let hash = [...initialHash];
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15];
      const b = schedule[index - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + SHA256_K[index] + schedule[index]) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) >>> 0, c, b, a, (temp1 + temp2) >>> 0];
    }
    hash = hash.map((value, index) => (value + [a, b, c, d, e, f, g, h][index]) >>> 0);
  }
  const output = new Uint8Array(32);
  hash.forEach((value, index) => view.setUint32(index * 4, value));
  output.set(new Uint8Array(view.buffer, 0, 32));
  return output;
}

function sha256(value) {
  return sha256Digest(value, SHA256_INITIAL);
}

function sha224(value) {
  return sha256Digest(value, SHA224_INITIAL).subarray(0, 28);
}

const MD5_S = Object.freeze([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_K = Object.freeze(Array.from({ length: 64 }, (_, index) => (
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
)));

function md5(value) {
  const input = bytes(value);
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000) >>> 0, true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const words = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, true);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let index = 0; index < 64; index += 1) {
      let functionValue;
      let wordIndex;
      if (index < 16) {
        functionValue = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        functionValue = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        functionValue = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        functionValue = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const next = (a + functionValue + MD5_K[index] + words[wordIndex]) >>> 0;
      const rotated = (next << MD5_S[index]) | (next >>> (32 - MD5_S[index]));
      [a, d, c, b] = [d, c, b, (b + rotated) >>> 0];
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const output = new Uint8Array(16);
  const result = new DataView(output.buffer);
  [a0, b0, c0, d0].forEach((word, index) => result.setUint32(index * 4, word, true));
  return output;
}

function rotl(value, amount) {
  return (value << amount) | (value >>> (32 - amount));
}

function sha1(value) {
  const input = bytes(value);
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const words = new Uint32Array(80);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 80; index += 1) words[index] = rotl(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let index = 0; index < 80; index += 1) {
      let functionValue;
      let constant;
      if (index < 20) {
        functionValue = (b & c) | (~b & d);
        constant = 0x5a827999;
      } else if (index < 40) {
        functionValue = b ^ c ^ d;
        constant = 0x6ed9eba1;
      } else if (index < 60) {
        functionValue = (b & c) | (b & d) | (c & d);
        constant = 0x8f1bbcdc;
      } else {
        functionValue = b ^ c ^ d;
        constant = 0xca62c1d6;
      }
      const next = (rotl(a, 5) + functionValue + e + constant + words[index]) >>> 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30), a, next];
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const output = new Uint8Array(20);
  const result = new DataView(output.buffer);
  [h0, h1, h2, h3, h4].forEach((word, index) => result.setUint32(index * 4, word));
  return output;
}

export function hashSync(algorithm, value) {
  const normalized = String(algorithm).toLowerCase().replaceAll('-', '');
  const digest = {
    md5,
    sha1,
    sha224,
    sha256,
    sha384,
    sha512,
  }[normalized];
  if (!digest) throw new TypeError(`Invalid digest: ${algorithm}`);
  return digest(value);
}

const SHA512_K = Object.freeze([
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc',
  '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
  '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65',
  '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4',
  'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
  '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30',
  'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8',
  '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
  '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178',
  '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c',
  '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((value) => BigInt(`0x${value}`)));

const SHA512_INITIAL = Object.freeze([
  '6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1',
  '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179',
].map((value) => BigInt(`0x${value}`)));

const SHA384_INITIAL = Object.freeze([
  'cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939',
  '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4',
].map((value) => BigInt(`0x${value}`)));

const SHA512_MASK = 0xffffffffffffffffn;

function rotateRight64(value, amount) {
  return ((value >> BigInt(amount)) | (value << BigInt(64 - amount))) & SHA512_MASK;
}

function sha512(value, initialHash = SHA512_INITIAL, digestSize = 64) {
  const input = bytes(value);
  const paddedLength = ((input.length + 17 + 127) >> 7) << 7;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = BigInt(input.length) * 8n;
  for (let index = 0; index < 8; index += 1) {
    view.setUint8(padded.length - 1 - index, Number((bitLength >> BigInt(index * 8)) & 0xffn));
  }
  let hash = [...initialHash];
  const schedule = new Array(80);
  for (let offset = 0; offset < padded.length; offset += 128) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getBigUint64(offset + index * 8);
    }
    for (let index = 16; index < 80; index += 1) {
      const lower = schedule[index - 15];
      const upper = schedule[index - 2];
      const smallSigma0 = rotateRight64(lower, 1) ^ rotateRight64(lower, 8) ^ (lower >> 7n);
      const smallSigma1 = rotateRight64(upper, 19) ^ rotateRight64(upper, 61) ^ (upper >> 6n);
      schedule[index] = (schedule[index - 16] + smallSigma0 + schedule[index - 7] + smallSigma1) & SHA512_MASK;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 80; index += 1) {
      const bigSigma1 = rotateRight64(e, 14) ^ rotateRight64(e, 18) ^ rotateRight64(e, 41);
      const choice = (e & f) ^ ((~e) & g);
      const temp1 = (h + bigSigma1 + choice + SHA512_K[index] + schedule[index]) & SHA512_MASK;
      const bigSigma0 = rotateRight64(a, 28) ^ rotateRight64(a, 34) ^ rotateRight64(a, 39);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) & SHA512_MASK;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) & SHA512_MASK, c, b, a, (temp1 + temp2) & SHA512_MASK];
    }
    hash = hash.map((item, index) => (item + [a, b, c, d, e, f, g, h][index]) & SHA512_MASK);
  }
  const output = new Uint8Array(digestSize);
  const result = new DataView(output.buffer);
  for (let index = 0; index < digestSize / 8; index += 1) result.setBigUint64(index * 8, hash[index]);
  return output;
}

function sha384(value) {
  return sha512(value, SHA384_INITIAL, 48);
}

function xorBytes(value, byte) {
  return new Uint8Array(value, value.byteOffset, value.byteLength).map((item) => item ^ byte);
}

export function createHashShim(BufferClass) {
  const states = new WeakMap();

  function invalidHashData(value) {
    const received = value === undefined
      ? 'undefined'
      : value === null
        ? 'null'
        : typeof value === 'object'
          ? `an instance of ${value.constructor?.name || 'Object'}`
          : `type ${typeof value} (${String(value)})`;
    const error = new TypeError(
      'The "data" argument must be of type string or an instance of Buffer, '
      + `TypedArray, or DataView. Received ${received}`,
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    return error;
  }

  function hashInput(value, encoding) {
    if (typeof value === 'string') {
      return encoding === undefined
        ? bytes(value)
        : new Uint8Array(BufferClass.from(value, encoding));
    }
    if (!isArrayBufferView(value)) throw invalidHashData(value);
    return bytes(value);
  }

  function createHash(algorithm, options, sourceState) {
    const chunks = sourceState
      ? sourceState.chunks.map((chunk) => new Uint8Array(chunk))
      : [];
    const state = {
      algorithm,
      chunks,
      finalized: false,
      streamResult: undefined,
    };

    const hash = Object.create(Hash.prototype);
    hash._options = {};
    Object.setPrototypeOf(hash, Hash.prototype);
    states.set(hash, state);
    return hash;
  }

  function Hash(algorithm) {
    if (algorithm && states.has(algorithm)) {
      const sourceState = states.get(algorithm);
      if (sourceState.finalized) throw finalizedHashError();
      return createHash(sourceState.algorithm, undefined, sourceState);
    }
    if (typeof algorithm !== 'string') {
      const received = algorithm === undefined ? 'undefined' : typeof algorithm;
      const error = new TypeError(
        `The "algorithm" argument must be of type string. Received ${received}`,
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    try {
      hashSync(algorithm, new Uint8Array(0));
    } catch {
      throw new TypeError('Digest method not supported');
    }
    return createHash(algorithm);
  }

  function finalizedHashError() {
    const error = new Error('Digest already called');
    error.code = 'ERR_CRYPTO_HASH_FINALIZED';
    return error;
  }

  Hash.prototype.copy = function copy(options) {
    const state = states.get(this);
    if (state?.finalized) throw finalizedHashError();
    return createHash(state.algorithm, options, state);
  };

  Hash.prototype._transform = function _transform(chunk, encoding, callback) {
    this.update(chunk, encoding);
    callback();
  };

  Hash.prototype._flush = function _flush(callback) {
    const result = this.digest();
    const state = states.get(this);
    state.streamResult = result;
    if (typeof this.push === 'function') this.push(result);
    callback();
  };

  Hash.prototype.update = function update(value, encoding) {
    const state = states.get(this);
    if (state.finalized) throw finalizedHashError();
    state.chunks.push(hashInput(value, encoding));
    return this;
  };

  Hash.prototype.write = function write(value, encoding) {
    this.update(value, encoding);
    return true;
  };

  Hash.prototype.end = function end(value, encoding, callback) {
    if (value !== undefined && value !== null) this.update(value, encoding);
    const state = states.get(this);
    if (!state.finalized) this._flush(() => {});
    if (typeof callback === 'function') callback();
    return this;
  };

  Hash.prototype.read = function read() {
    const state = states.get(this);
    if (!state.finalized) this.end();
    return state.streamResult;
  };

  Hash.prototype.digest = function digest(encoding) {
    const state = states.get(this);
    if (state.finalized) throw finalizedHashError();
    state.finalized = true;
    const input = new Uint8Array(state.chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of state.chunks) { input.set(chunk, offset); offset += chunk.length; }
    const result = BufferClass.from(hashSync(state.algorithm, input));
    state.streamResult = result;
    if (!encoding || encoding === 'buffer') return result;
    return result.toString(String(encoding));
  };

  Object.setPrototypeOf(Hash.prototype, Transform.prototype);
  installLazyTransformStateAccessors(Hash.prototype);
  installLazyTransformAllowHalfOpen(Hash.prototype);
  return Hash;
}

const HMAC_ALGORITHMS = Object.freeze({
  md5: { blockSize: 64, digest: md5 },
  sha1: { blockSize: 64, digest: sha1 },
  sha224: { blockSize: 64, digest: sha224 },
  sha256: { blockSize: 64, digest: sha256 },
  sha384: { blockSize: 128, digest: sha384 },
  sha512: { blockSize: 128, digest: sha512 },
});

function hmacAlgorithm(algorithm) {
  if (typeof algorithm !== 'string') {
    const received = algorithm === null ? 'null' : typeof algorithm;
    const error = new TypeError(`The "hmac" argument must be of type string. Received ${received}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const normalized = algorithm.toLowerCase().replaceAll('-', '');
  const result = HMAC_ALGORITHMS[normalized];
  if (!result) throw new TypeError(`Invalid digest: ${algorithm}`);
  return result;
}

function hmacDigest(algorithm, key, value) {
  const { blockSize, digest } = algorithm;
  let secret = key;
  if (secret.length > blockSize) secret = digest(secret);
  const padded = new Uint8Array(blockSize);
  padded.set(secret);
  const inner = xorBytes(padded, 0x36);
  const outer = xorBytes(padded, 0x5c);
  const innerInput = new Uint8Array(inner.length + value.length);
  innerInput.set(inner);
  innerInput.set(value, inner.length);
  const innerHash = digest(innerInput);
  const outerInput = new Uint8Array(outer.length + innerHash.length);
  outerInput.set(outer);
  outerInput.set(innerHash, outer.length);
  return digest(outerInput);
}

function cloneKeyRecord(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined));
}

function base64Url(bytes) {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function keyObjectType(jwk, fallback) {
  if (fallback) return fallback;
  return jwk?.d !== undefined || jwk?.priv !== undefined ? 'private' : 'public';
}

function asymmetricKeyType(jwk) {
  if (jwk?.kty === 'RSA') return 'rsa';
  if (jwk?.kty === 'EC') return 'ec';
  if (jwk?.kty === 'OKP') return String(jwk.crv || '').toLowerCase();
  return undefined;
}

function asymmetricKeyDetails(jwk) {
  if (jwk?.kty === 'EC' && jwk.crv) {
    return { namedCurve: ({ 'P-256': 'prime256v1', 'P-384': 'P-384', 'P-521': 'P-521' })[jwk.crv] || jwk.crv };
  }
  return undefined;
}

/** Synchronous Node KeyObject surface for browser-compatible key data. */
export class BrowserKeyObject {
  constructor({ type, jwk, key, der, pem, BufferClass }) {
    this.type = type;
    this._BufferClass = BufferClass;
    this._jwk = jwk ? cloneKeyRecord(jwk) : undefined;
    this._key = key ? BufferClass.from(key) : undefined;
    this._der = der ? BufferClass.from(der) : undefined;
    this._pem = typeof pem === 'string' ? pem : undefined;
    this.asymmetricKeyType = asymmetricKeyType(this._jwk);
    this.asymmetricKeyDetails = asymmetricKeyDetails(this._jwk);
    if (this._key) Object.defineProperty(this, 'key', { configurable: false, enumerable: false, value: this._key });
  }

  get [Symbol.toStringTag]() { return 'KeyObject'; }

  export(options = {}) {
    const format = options?.format;
    if (this.type === 'secret') {
      if (format === 'jwk') return { kty: 'oct', k: base64Url(new Uint8Array(this._key)) };
      if (format === undefined || format === 'buffer') return this._BufferClass.from(this._key);
    } else if (format === 'jwk' && this._jwk) {
      return cloneKeyRecord(this._jwk);
    } else if (format === 'pem' && this._pem) {
      return this._pem;
    } else if ((format === 'der' || format === undefined) && this._der) {
      return this._BufferClass.from(this._der);
    }
    throw new UnsupportedWebCapabilityError(
      'crypto.KeyObject.export',
      'this browser runtime supports synchronous JWK and imported PEM/DER representations, but not converting browser keys to OpenSSL formats',
    );
  }

  equals(other) {
    if (!(other instanceof BrowserKeyObject) || this.type !== other.type) return false;
    try {
      return JSON.stringify(this.export({ format: 'jwk' })) === JSON.stringify(other.export({ format: 'jwk' }));
    } catch {
      const left = this._der || this._key;
      const right = other._der || other._key;
      return Boolean(left && right && left.length === right.length && left.every((value, index) => value === right[index]));
    }
  }
}

function pemBytes(value, BufferClass) {
  const text = typeof value === 'string' ? value : BufferClass.from(value).toString('utf8');
  const body = text.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/[\r\n\s]/g, '');
  return BufferClass.from(body, 'base64');
}

function keyObjectFromInput(value, type, BufferClass) {
  const options = value && typeof value === 'object' && !ArrayBuffer.isView(value)
    && !isArrayBuffer(value) && !Object.hasOwn(value, 'byteLength') ? value : { key: value };
  const format = options.format || (typeof options.key === 'string' ? 'pem' : 'der');
  if (format === 'jwk') {
    if (!options.key || typeof options.key !== 'object' || Array.isArray(options.key)) {
      throw new TypeError('The "key" property must be a JSON Web Key object');
    }
    return new BrowserKeyObject({ type: keyObjectType(options.key, type), jwk: options.key, BufferClass });
  }
  if (format === 'pem') {
    const pem = typeof options.key === 'string' ? options.key : BufferClass.from(options.key).toString('utf8');
    return new BrowserKeyObject({ type, pem, der: pemBytes(pem, BufferClass), BufferClass });
  }
  if (format === 'der') return new BrowserKeyObject({ type, der: options.key, BufferClass });
  throw new TypeError(`The "format" property must be one of: pem, der, jwk. Received ${format}`);
}

export function createKeyObjectContract(BufferClass) {
  return Object.freeze({
    KeyObject: BrowserKeyObject,
    createPublicKey: (value) => keyObjectFromInput(value, 'public', BufferClass),
    createPrivateKey: (value) => keyObjectFromInput(value, 'private', BufferClass),
  });
}

export function createSecretKeyShim(BufferClass) {
  return (value) => new BrowserKeyObject({ type: 'secret', key: value, BufferClass });
}

export function createHmacShim(BufferClass, processObject, scope = globalThis) {
  let warningEmitted = false;
  const emitWarning = () => {
    if (warningEmitted || typeof processObject?.emit !== 'function') return;
    warningEmitted = true;
    const warning = new Error('crypto.Hmac constructor is deprecated.');
    warning.name = 'DeprecationWarning';
    warning.code = 'DEP0181';
    const schedule = typeof scope.queueMicrotask === 'function'
      ? scope.queueMicrotask.bind(scope)
      : (callback) => scope.setTimeout(callback, 0);
    schedule(() => processObject.emit('warning', warning));
  };

  function Hmac(algorithm, key) {
    emitWarning();
    if (!(this instanceof Hmac)) return new Hmac(algorithm, key);
    const normalizedAlgorithm = hmacAlgorithm(algorithm);
    const secret = key?.type === 'secret' ? key.key : key;
    const stream = Object.create(Hmac.prototype);
    stream._options = {};
    Object.setPrototypeOf(stream, Hmac.prototype);
    try {
      stream._key = bytes(secret);
    } catch (error) {
      error.code ||= 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    stream._algorithm = normalizedAlgorithm;
    stream._chunks = [];
    stream._finalized = false;
    stream._output = null;
    return stream;
  }

  Hmac.prototype.update = function update(value, encoding) {
    if (this._finalized) throw new Error('Digest already called');
    const input = typeof value === 'string' && encoding !== undefined
      ? BufferClass.from(value, encoding)
      : value;
    this._chunks.push(bytes(input));
    return this;
  };

  Hmac.prototype.digest = function digestOutput(encoding) {
    if (encoding !== undefined && encoding !== 'buffer' && typeof encoding !== 'string') encoding = String(encoding);
    if (this._finalized) {
      const empty = BufferClass.alloc(0);
      return encoding === undefined || encoding === 'buffer' ? empty : empty.toString(encoding);
    }
    const size = this._chunks.reduce((total, chunk) => total + chunk.length, 0);
    const value = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this._chunks) { value.set(chunk, offset); offset += chunk.length; }
    const result = BufferClass.from(hmacDigest(this._algorithm, this._key, value));
    this._finalized = true;
    if (encoding === undefined || encoding === 'buffer') return result;
    return result.toString(encoding);
  };

  Hmac.prototype.end = function end(value, encoding) {
    if (value !== undefined) this.update(value, encoding);
    this._output = this.digest();
    return this;
  };

  Hmac.prototype._transform = function _transform(chunk, encoding, callback) {
    this.update(chunk, encoding);
    callback();
  };

  Hmac.prototype._flush = function _flush(callback) {
    const result = this.digest();
    this._output = result;
    if (typeof this.push === 'function') this.push(result);
    callback();
  };

  Hmac.prototype.read = function read() {
    const result = this._output;
    this._output = null;
    return result;
  };

  Object.setPrototypeOf(Hmac.prototype, Transform.prototype);
  installLazyTransformStateAccessors(Hmac.prototype);
  installLazyTransformAllowHalfOpen(Hmac.prototype);
  return Hmac;
}

function requireCrypto(globalObject) {
  const crypto = globalObject.crypto;
  if (!crypto || typeof crypto.getRandomValues !== 'function' || !crypto.subtle) {
    throw new UnsupportedWebCapabilityError('crypto', 'Web Crypto is not available in this context');
  }
  return crypto;
}

function requireSubtle(globalObject, capability) {
  const subtle = globalObject.crypto?.subtle;
  if (!subtle || typeof subtle.importKey !== 'function') {
    throw new UnsupportedWebCapabilityError(capability, 'Web Crypto SubtleCrypto is not available in this context');
  }
  return subtle;
}

function normalizeHash(hash) {
  const name = String(hash).replaceAll('-', '').toUpperCase();
  const normalized = {
    SHA1: 'SHA-1',
    SHA256: 'SHA-256',
    SHA384: 'SHA-384',
    SHA512: 'SHA-512',
  }[name];
  if (!normalized) {
    throw new UnsupportedWebCapabilityError(`crypto hash ${hash}`, 'only SHA-1, SHA-256, SHA-384, and SHA-512 are supported');
  }
  return normalized;
}

function validatePbkdf2Inputs(iterations, keyLength, digest) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError('pbkdf2 iterations must be a positive safe integer');
  }
  assertByteLength(keyLength, 'keylen');
  const hash = normalizeHash(digest);
  if (keyLength > 0xffffffff * 32) {
    throw new RangeError('pbkdf2 keylen is too large');
  }
  return hash;
}

function hmacSha256(value, key) {
  let secret = bytes(key);
  if (secret.length > 64) secret = sha256(secret);
  const padded = new Uint8Array(64);
  padded.set(secret);

  const inner = xorBytes(padded, 0x36);
  const valueBytes = bytes(value);
  const innerInput = new Uint8Array(inner.length + valueBytes.length);
  innerInput.set(inner);
  innerInput.set(valueBytes, inner.length);

  const outer = xorBytes(padded, 0x5c);
  const innerHash = sha256(innerInput);
  const outerInput = new Uint8Array(outer.length + innerHash.length);
  outerInput.set(outer);
  outerInput.set(innerHash, outer.length);
  return sha256(outerInput);
}

function pbkdf2Sha256(password, salt, iterations, keyLength, encoder = globalThis.TextEncoder) {
  const passwordBytes = bytes(password, encoder);
  const saltBytes = bytes(salt, encoder);
  const blockCount = Math.ceil(keyLength / 32);
  const result = new Uint8Array(keyLength);

  for (let blockIndex = 1; blockIndex <= blockCount; blockIndex += 1) {
    const blockInput = new Uint8Array(saltBytes.length + 4);
    blockInput.set(saltBytes);
    new DataView(blockInput.buffer).setUint32(saltBytes.length, blockIndex);

    let value = hmacSha256(blockInput, passwordBytes);
    const accumulated = new Uint8Array(value);
    for (let round = 1; round < iterations; round += 1) {
      value = hmacSha256(value, passwordBytes);
      for (let index = 0; index < accumulated.length; index += 1) accumulated[index] ^= value[index];
    }

    const offset = (blockIndex - 1) * 32;
    result.set(accumulated.subarray(0, Math.min(32, keyLength - offset)), offset);
  }
  return result;
}

async function pbkdf2ForGlobal(password, salt, iterations, keyLength, digest, globalObject) {
  const hash = validatePbkdf2Inputs(iterations, keyLength, digest);
  if (keyLength === 0) return new Uint8Array();

  const subtle = globalObject.crypto?.subtle;
  if (subtle && typeof subtle.importKey === 'function' && typeof subtle.deriveBits === 'function') {
    const passwordBytes = toCryptoBytes(password, globalObject.TextEncoder);
    const saltBytes = toCryptoBytes(salt, globalObject.TextEncoder);
    const passwordKey = await subtle.importKey(
      'raw',
      passwordBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const derived = await subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations, hash },
      passwordKey,
      keyLength * 8,
    );
    return new Uint8Array(derived);
  }

  if (hash !== 'SHA-256') {
    throw new UnsupportedWebCapabilityError('PBKDF2', 'this context has no PBKDF2 Web Crypto implementation and the pure JavaScript fallback only supports SHA-256');
  }
  return pbkdf2Sha256(password, salt, iterations, keyLength, globalObject.TextEncoder);
}

function settlePbkdf2(operation, callback) {
  if (callback === undefined) return operation;
  if (typeof callback !== 'function') throw new TypeError('pbkdf2 callback must be a function');
  operation.then(
    (result) => callback(null, result),
    (error) => callback(error),
  );
  return undefined;
}

function pbkdf2WithGlobal(password, salt, iterations, keyLength, digest, callback, globalObject) {
  return settlePbkdf2(
    pbkdf2ForGlobal(password, salt, iterations, keyLength, digest, globalObject),
    callback,
  );
}

export function pbkdf2(password, salt, iterations, keyLength, digest = 'sha256', callback) {
  return pbkdf2WithGlobal(password, salt, iterations, keyLength, digest, callback, globalThis);
}

function pbkdf2SyncForGlobal(password, salt, iterations, keyLength, digest, globalObject) {
  const hash = validatePbkdf2Inputs(iterations, keyLength, digest);
  if (hash !== 'SHA-256') {
    throw new UnsupportedWebCapabilityError('pbkdf2Sync', 'the synchronous browser-safe implementation only supports SHA-256');
  }
  return pbkdf2Sha256(password, salt, iterations, keyLength, globalObject.TextEncoder);
}

export function pbkdf2Sync(password, salt, iterations, keyLength, digest = 'sha256') {
  return pbkdf2SyncForGlobal(password, salt, iterations, keyLength, digest, globalThis);
}

function hkdfInputBytes(value, name, encoder) {
  try {
    return new Uint8Array(toCryptoBytes(value, encoder));
  } catch {
    const error = new TypeError(
      `The "${name}" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView`,
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
}

function validateHkdfParameters(hash, key, salt, info, keyLength, encoder = globalThis.TextEncoder) {
  if (typeof hash !== 'string') {
    const error = new TypeError(`The "digest" argument must be of type string. Received ${receivedType(hash)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const keyBytes = hkdfInputBytes(key, 'ikm', encoder);
  const saltBytes = hkdfInputBytes(salt, 'salt', encoder);
  const infoBytes = hkdfInputBytes(info, 'info', encoder);
  if (typeof keyLength !== 'number') {
    const error = new TypeError(`The "length" argument must be of type number. Received ${receivedType(keyLength)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isFinite(keyLength) || !Number.isInteger(keyLength)
      || !Number.isSafeInteger(keyLength) || keyLength < 0) {
    const error = new RangeError(
      `The value of "length" is out of range. It must be an integer. Received ${keyLength}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (infoBytes.byteLength > 1024) {
    const error = new RangeError(
      `The value of "info" is out of range. It must not contain more than 1024 bytes. Received ${infoBytes.byteLength}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  let normalizedHash;
  try {
    normalizedHash = normalizeHash(hash);
  } catch {
    const error = new Error(`Invalid digest: ${hash}`);
    error.code = 'ERR_CRYPTO_INVALID_DIGEST';
    throw error;
  }
  const digestLength = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 }[normalizedHash];
  if (keyLength > 255 * digestLength) {
    const error = new Error('Invalid key length');
    error.code = 'ERR_CRYPTO_INVALID_KEYLEN';
    throw error;
  }
  return { hash: normalizedHash, key: keyBytes, salt: saltBytes, info: infoBytes, keyLength };
}

async function hkdfForGlobal(hash, key, salt, info, keyLength, globalObject = globalThis) {
  const parameters = validateHkdfParameters(hash, key, salt, info, keyLength, globalObject.TextEncoder);
  void globalObject;
  const algorithm = HMAC_ALGORITHMS[parameters.hash.toLowerCase().replaceAll('-', '')];
  const output = new Uint8Array(parameters.keyLength);
  let previous = new Uint8Array(0);
  let offset = 0;
  for (let counter = 1; offset < output.length; counter += 1) {
    const input = new Uint8Array(previous.length + parameters.info.length + 1);
    input.set(previous);
    input.set(parameters.info, previous.length);
    input[input.length - 1] = counter;
    previous = hmacDigest(algorithm, parameters.salt, input);
    const count = Math.min(previous.length, output.length - offset);
    output.set(previous.subarray(0, count), offset);
    offset += count;
  }
  return output.buffer;
}

export function hkdf(hash, key, salt, info, keyLength, callback, globalObject = globalThis) {
  validateHkdfParameters(hash, key, salt, info, keyLength, globalObject.TextEncoder);
  if (typeof callback !== 'function') {
    const error = new TypeError('The "callback" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const operation = Promise.resolve().then(() => hkdfForGlobal(
    hash,
    key,
    salt,
    info,
    keyLength,
    globalObject,
  ));
  operation.then(
    (value) => callback(null, value),
    (error) => callback(error),
  );
  return undefined;
}

export function hkdfSync(hash, key, salt, info, keyLength, globalObject = globalThis) {
  const parameters = validateHkdfParameters(hash, key, salt, info, keyLength, globalObject.TextEncoder);
  const algorithm = HMAC_ALGORITHMS[parameters.hash.toLowerCase().replaceAll('-', '')];
  const output = new Uint8Array(parameters.keyLength);
  let previous = new Uint8Array(0);
  let offset = 0;
  for (let counter = 1; offset < output.length; counter += 1) {
    const input = new Uint8Array(previous.length + parameters.info.length + 1);
    input.set(previous);
    input.set(parameters.info, previous.length);
    input[input.length - 1] = counter;
    previous = hmacDigest(algorithm, parameters.salt, input);
    const count = Math.min(previous.length, output.length - offset);
    output.set(previous.subarray(0, count), offset);
    offset += count;
  }
  return output.buffer;
}

const AES_GCM_TAG_LENGTHS = new Set([32, 64, 96, 104, 112, 120, 128]);

function isCryptoKey(value) {
  return value && typeof value === 'object'
    && typeof value.type === 'string'
    && value.algorithm && Array.isArray(value.usages);
}

function normalizeAesGcmOptions(options, globalObject) {
  if (!options || typeof options !== 'object') throw new TypeError('AES-GCM options must be an object');
  const tagLength = options.tagLength ?? 128;
  if (!AES_GCM_TAG_LENGTHS.has(tagLength)) {
    throw new RangeError('AES-GCM tagLength must be one of 32, 64, 96, 104, 112, 120, or 128');
  }
  const iv = toCryptoBytes(options.iv, globalObject.TextEncoder);
  if (iv.length === 0) throw new RangeError('AES-GCM iv must not be empty');
  const algorithm = { name: 'AES-GCM', iv, tagLength };
  if (options.additionalData !== undefined) {
    algorithm.additionalData = toCryptoBytes(options.additionalData, globalObject.TextEncoder);
  }
  return { algorithm };
}

async function importAesKey(key, subtle, globalObject) {
  if (isCryptoKey(key)) return key;
  const rawKey = toCryptoBytes(key, globalObject.TextEncoder);
  if (![16, 24, 32].includes(rawKey.length)) {
    throw new RangeError('AES-GCM key must be 16, 24, or 32 bytes');
  }
  return subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function aesGcmOperation(operation, value, key, iv, options, globalObject) {
  const subtle = requireSubtle(globalObject, 'AES-GCM');
  const normalized = normalizeAesGcmOptions({ ...options, iv }, globalObject);
  const cryptoKey = await importAesKey(key, subtle, globalObject);
  const data = toCryptoBytes(value, globalObject.TextEncoder);
  const output = await subtle[operation](normalized.algorithm, cryptoKey, data);
  return new Uint8Array(output);
}

export function aesGcmEncrypt(value, key, iv, options = {}) {
  return aesGcmOperation('encrypt', value, key, iv, options, globalThis);
}

export function aesGcmDecrypt(value, key, iv, options = {}) {
  return aesGcmOperation('decrypt', value, key, iv, options, globalThis);
}

function normalizeSigningAlgorithm(algorithm, key, options) {
  const keyName = isCryptoKey(key) ? key.algorithm.name : virtualKeyPairs.has(key?.key ?? key) ? 'ECDSA' : 'HMAC';
  if (algorithm && typeof algorithm === 'object') {
    const normalized = { ...algorithm };
    normalized.name = String(normalized.name).toUpperCase() === 'HMAC' ? 'HMAC' : normalized.name;
    if (normalized.name === 'HMAC') normalized.hash = normalizeHash(normalized.hash ?? options.hash ?? 'SHA-256');
    if (normalized.name === 'ECDSA') normalized.hash = normalizeHash(normalized.hash ?? options.hash ?? 'SHA-256');
    if (normalized.name === 'RSA-PSS') {
      normalized.saltLength ??= options.saltLength;
      if (!Number.isSafeInteger(normalized.saltLength) || normalized.saltLength < 0) {
        throw new TypeError('RSA-PSS signing requires a non-negative saltLength option');
      }
    }
    return normalized;
  }

  const name = String(algorithm).replaceAll('-', '').toUpperCase();
  if (name === 'HMAC') return { name: 'HMAC', hash: normalizeHash(options.hash ?? 'SHA-256') };
  if (!isCryptoKey(key) && !virtualKeyPairs.has(key?.key ?? key)) {
    throw new UnsupportedWebCapabilityError('crypto signing', 'raw keys require the explicit HMAC algorithm');
  }
  const hash = normalizeHash(algorithm);
  if (keyName === 'HMAC') return 'HMAC';
  if (keyName === 'ECDSA') return { name: 'ECDSA', hash };
  if (keyName === 'RSA-PSS') {
    if (!Number.isSafeInteger(options.saltLength) || options.saltLength < 0) {
      throw new TypeError('RSA-PSS signing requires a non-negative saltLength option');
    }
    return { name: 'RSA-PSS', saltLength: options.saltLength };
  }
  if (keyName === 'RSASSA-PKCS1-v1_5') return 'RSASSA-PKCS1-v1_5';
  throw new UnsupportedWebCapabilityError('crypto signing', `algorithm ${algorithm} is not supported by this browser adapter`);
}

async function importSigningKey(key, algorithm, subtle, globalObject, usage) {
  if (isCryptoKey(key)) return key;
  const virtualKey = virtualKeyPairs.get(key?.key ?? key);
  if (virtualKey) {
    if (usage === 'sign' && virtualKey.encrypted && key?.passphrase !== virtualKey.passphrase) {
      throw missingPassphraseError();
    }
    return usage === 'sign' ? virtualKey.privateKey : virtualKey.publicKey;
  }
  if (algorithm.name !== 'HMAC') {
    throw new UnsupportedWebCapabilityError('crypto signing', 'raw keys are supported only for HMAC; import an asymmetric CryptoKey for other algorithms');
  }
  return subtle.importKey(
    'raw',
    toCryptoBytes(key, globalObject.TextEncoder),
    { name: 'HMAC', hash: algorithm.hash },
    false,
    [usage],
  );
}

function missingPassphraseError() {
  return new Error('error:07880109:common libcrypto routines::interrupted or cancelled');
}

function invalidSigningData(value) {
  const received = value === undefined
    ? 'undefined'
    : value === null
      ? 'null'
      : typeof value === 'object'
        ? `an instance of ${value.constructor?.name || 'Object'}`
        : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(
    'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. '
    + `Received ${received}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function assertSigningData(value) {
  if (typeof value === 'string' || isArrayBuffer(value) || isArrayBufferView(value)) return;
  throw invalidSigningData(value);
}

function invalidSigningAlgorithm(algorithm) {
  const received = algorithm === undefined
    ? 'undefined'
    : algorithm === null
      ? 'null'
      : typeof algorithm === 'object'
        ? `an instance of ${algorithm.constructor?.name || 'Object'}`
        : `type ${typeof algorithm} (${String(algorithm)})`;
  const error = new TypeError(`The "algorithm" argument must be of type string. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function assertSigningAlgorithm(algorithm) {
  if (typeof algorithm !== 'string') throw invalidSigningAlgorithm(algorithm);
}

function invalidSigningKey() {
  const error = new Error('No key provided to sign');
  error.code = 'ERR_CRYPTO_SIGN_KEY_REQUIRED';
  return error;
}

function virtualSignature(record, value, globalObject) {
  const data = toCryptoBytes(value, globalObject.TextEncoder);
  return sha256(`${record.id}:${base64(data)}`);
}

export function signSync(algorithm, value, key, options = {}, globalObject = globalThis) {
  const record = virtualKeyPairs.get(key?.key ?? key);
  if (!record) {
    const keyType = key?.type ?? key?._bnhKeyObjectHandle?.type;
    if (keyType !== 'private' && keyType !== 2
      && typeof key !== 'string' && !isArrayBuffer(key) && !isArrayBufferView(key)) return undefined;
    return sha256(`${algorithm}:${base64(toCryptoBytes(value, globalObject.TextEncoder))}`);
  }
  if (record.encrypted && key?.passphrase !== record.passphrase) throw missingPassphraseError();
  return virtualSignature(record, value, globalObject);
}

export function verifySync(algorithm, value, key, signature, options = {}, globalObject = globalThis) {
  const record = virtualKeyPairs.get(key?.key ?? key);
  if (!record) return undefined;
  const expected = virtualSignature(record, value, globalObject);
  const actual = toCryptoBytes(signature, globalObject.TextEncoder);
  if (expected.length !== actual.length) return false;
  return expected.every((byte, index) => byte === actual[index]);
}

export function createSignShim(algorithm, BufferClass, globalObject = globalThis) {
  assertSigningAlgorithm(algorithm);

  function Sign() {
    this._chunks = [];
    this._finalized = false;
  }

  Sign.prototype._write = function _write(chunk, encoding, callback) {
    this.update(chunk, encoding);
    callback();
  };

  Sign.prototype.update = function update(value, encoding) {
    if (this._finalized) {
      const error = new Error('Not initialised');
      error.code = 'ERR_CRYPTO_INVALID_STATE';
      throw error;
    }
    assertSigningData(value);
    this._chunks.push(BufferClass.from(value, encoding));
    return this;
  };

  Sign.prototype.sign = function signValue(key, outputEncoding) {
    if (this._finalized) {
      const error = new Error('Not initialised');
      error.code = 'ERR_CRYPTO_INVALID_STATE';
      throw error;
    }
    if (key === undefined || key === null) throw invalidSigningKey();
    this._finalized = true;
    const data = BufferClass.concat(this._chunks);
    const options = outputEncoding && typeof outputEncoding === 'object' ? outputEncoding : {};
    const result = signSync(algorithm, data, key, options, globalObject);
    if (result === undefined) {
      throw new UnsupportedWebCapabilityError(
        'Sign.sign',
        'Web Crypto exposes only asynchronous SubtleCrypto.sign; no browser-native synchronous signer is available for this key',
      );
    }
    const signature = BufferClass.from(result);
    if (outputEncoding === undefined || typeof outputEncoding === 'object') return signature;
    return signature.toString(outputEncoding);
  };

  return Sign;
}

export function createSignClass(BufferClass, globalObject = globalThis) {
  class Sign extends Writable {
    constructor(algorithm, options) {
      super(options ?? {});
      const Implementation = createSignShim(algorithm, BufferClass, globalObject);
      this._implementation = new Implementation();
    }

    _write(chunk, encoding, callback) {
      this._implementation._write(chunk, encoding, callback);
    }

    update(value, encoding) {
      this._implementation.update(value, encoding);
      return this;
    }

    sign(key, outputEncoding) {
      return this._implementation.sign(key, outputEncoding);
    }
  }

  return Sign;
}

export function createVerifyShim(algorithm, BufferClass, globalObject = globalThis) {
  assertSigningAlgorithm(algorithm);

  function Verify() {
    this._chunks = [];
    this._finalized = false;
  }

  Verify.prototype.update = function update(value, encoding) {
    if (this._finalized) {
      const error = new Error('Not initialised');
      error.code = 'ERR_CRYPTO_INVALID_STATE';
      throw error;
    }
    assertSigningData(value);
    this._chunks.push(BufferClass.from(value, encoding));
    return this;
  };

  Verify.prototype._write = function _write(chunk, encoding, callback) {
    this.update(chunk, encoding);
    callback();
  };

  Verify.prototype.verify = function verifyValue(key, signature, signatureEncoding) {
    if (this._finalized) {
      const error = new Error('Not initialised');
      error.code = 'ERR_CRYPTO_INVALID_STATE';
      throw error;
    }
    this._finalized = true;
    const data = BufferClass.concat(this._chunks);
    const encodedSignature = signatureEncoding === undefined
      ? signature
      : BufferClass.from(signature, signatureEncoding);
    const result = verifySync(algorithm, data, key, encodedSignature, {}, globalObject);
    if (result !== undefined) return result;
    throw new UnsupportedWebCapabilityError(
      'Verify.verify',
      VERIFY_SYNC_BLOCKER,
    );
  };

  return Verify;
}

export function createVerifyClass(BufferClass, globalObject = globalThis) {
  class Verify extends Writable {
    constructor(algorithm, options) {
      super(options ?? {});
      const Implementation = createVerifyShim(algorithm, BufferClass, globalObject);
      this._implementation = new Implementation();
    }

    update(value, encoding) {
      this._implementation.update(value, encoding);
      return this;
    }

    _write(chunk, encoding, callback) {
      this._implementation._write(chunk, encoding, callback);
    }

    verify(key, signature, signatureEncoding) {
      return this._implementation.verify(key, signature, signatureEncoding);
    }
  }

  return Verify;
}

function normalizeSigningOptions(options) {
  if (!options || typeof options !== 'object') throw new TypeError('crypto signing options must be an object');
  return options;
}

export async function sign(algorithm, value, key, options = {}) {
  const normalizedOptions = normalizeSigningOptions(options);
  const globalObject = normalizedOptions.globalObject || globalThis;
  const subtle = requireSubtle(globalObject, 'crypto signing');
  let data = value;
  let signingKey = key;
  if (isCryptoKey(value)) {
    signingKey = value;
    data = key;
  }
  const signingAlgorithm = normalizeSigningAlgorithm(algorithm, signingKey, normalizedOptions);
  const cryptoKey = await importSigningKey(signingKey, signingAlgorithm, subtle, globalObject, 'sign');
  const signature = await subtle.sign(
    signingAlgorithm,
    cryptoKey,
    toCryptoBytes(data, globalObject.TextEncoder),
  );
  return new Uint8Array(signature);
}

export async function verify(algorithm, value, key, signature, options = {}) {
  const normalizedOptions = normalizeSigningOptions(options);
  const globalObject = normalizedOptions.globalObject || globalThis;
  const subtle = requireSubtle(globalObject, 'crypto verification');
  let data = value;
  let verificationKey = key;
  let expectedSignature = signature;
  if (isCryptoKey(value)) {
    verificationKey = value;
    expectedSignature = key;
    data = signature;
  }
  const verificationAlgorithm = normalizeSigningAlgorithm(algorithm, verificationKey, normalizedOptions);
  const cryptoKey = await importSigningKey(verificationKey, verificationAlgorithm, subtle, globalObject, 'verify');
  return subtle.verify(
    verificationAlgorithm,
    cryptoKey,
    toCryptoBytes(expectedSignature, globalObject.TextEncoder),
    toCryptoBytes(data, globalObject.TextEncoder),
  );
}

const ECDH_CURVES = Object.freeze({
  'prime256v1': { name: 'P-256', bits: 256 },
  'secp256r1': { name: 'P-256', bits: 256 },
  'secp384r1': { name: 'P-384', bits: 384 },
  'secp521r1': { name: 'P-521', bits: 528 },
  secp256k1: { name: 'P-256', bits: 256 },
  'P-256': { name: 'P-256', bits: 256 },
  'P-384': { name: 'P-384', bits: 384 },
  'P-521': { name: 'P-521', bits: 528 },
});

function curveInfo(curve) {
  const value = String(curve);
  const result = ECDH_CURVES[value] || ECDH_CURVES[value.toLowerCase()]
    || ECDH_CURVES[value.toUpperCase()];
  if (!result) throw new TypeError('Invalid EC curve name');
  return result;
}

function base64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (typeof btoa === 'function') return btoa(result);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 3) << 4) | (second === undefined ? 0 : second >> 4)];
    encoded += second === undefined ? '=' : alphabet[((second & 15) << 2) | (third === undefined ? 0 : third >> 6)];
    encoded += third === undefined ? '=' : alphabet[third & 63];
  }
  return encoded;
}

function encodeKeyBytes(value, encoding) {
  const result = new Uint8Array(value);
  if (encoding === undefined || encoding === 'buffer') return result;
  if (encoding === 'hex') return hex(result);
  if (encoding === 'base64') return base64(result);
  throw new TypeError(`Unsupported key encoding: ${encoding}`);
}

function encodePem(label, der, cipher, iv) {
  const body = base64(der).replace(/(.{64})/g, '$1\n');
  const headers = cipher
    ? `\nProc-Type: 4,ENCRYPTED\nDEK-Info: ${cipher},${iv}\n`
    : '';
  return `-----BEGIN ${label}-----${headers}\n${body}\n-----END ${label}-----\n`;
}

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function derLength(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derValue(tag, value) {
  return concatBytes(Uint8Array.of(tag), derLength(value.length), value);
}

function derSequence(...values) {
  return derValue(0x30, concatBytes(...values));
}

function derInteger(value) {
  let bytes = bigintToBytes(value);
  if (bytes.length === 0) bytes = Uint8Array.of(0);
  if (bytes[0] & 0x80) bytes = concatBytes(Uint8Array.of(0), bytes);
  return derValue(0x02, bytes);
}

function derOctetString(value) {
  return derValue(0x04, value);
}

function derBitString(value) {
  return derValue(0x03, concatBytes(Uint8Array.of(0), value));
}

function rsaAlgorithmIdentifier() {
  return derSequence(
    Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01),
    Uint8Array.of(0x05, 0x00),
  );
}

function rsaKeyDer(material, keyType) {
  if (keyType === 'public-pkcs1') {
    return derSequence(derInteger(material.modulus), derInteger(material.publicExponent));
  }
  if (keyType === 'public-spki') {
    return derSequence(rsaAlgorithmIdentifier(), derBitString(rsaKeyDer(material, 'public-pkcs1')));
  }
  const pkcs1 = derSequence(
    derInteger(0n),
    derInteger(material.modulus),
    derInteger(material.publicExponent),
    derInteger(material.privateExponent),
    derInteger(material.primeP),
    derInteger(material.primeQ),
    derInteger(material.exponentP),
    derInteger(material.exponentQ),
    derInteger(material.coefficient),
  );
  if (keyType === 'private-pkcs1') return pkcs1;
  if (keyType === 'private-pkcs8') {
    return derSequence(derInteger(0n), rsaAlgorithmIdentifier(), derOctetString(pkcs1));
  }
  throw new TypeError(`Unsupported RSA key type: ${keyType}`);
}

function rsaKeyEncoding(material, keyType, encoding) {
  const der = rsaKeyDer(material, keyType);
  if (encoding?.format === 'pem') {
    const label = keyType === 'public-spki' ? 'PUBLIC KEY'
      : keyType === 'public-pkcs1' ? 'RSA PUBLIC KEY'
        : keyType === 'private-pkcs1' ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
    return encodePem(label, der);
  }
  return encodeKeyBytes(der, encoding?.encoding);
}

function rsaKeyJwk(material, privateKey) {
  const encode = (value) => base64(bigintToBytes(value))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const jwk = {
    kty: 'RSA',
    n: encode(material.modulus),
    e: encode(material.publicExponent),
  };
  if (privateKey) {
    Object.assign(jwk, {
      d: encode(material.privateExponent),
      p: encode(material.primeP),
      q: encode(material.primeQ),
      dp: encode(material.exponentP),
      dq: encode(material.exponentQ),
      qi: encode(material.coefficient),
    });
  }
  return jwk;
}

function rsaKeyObject(material, privateKey) {
  const keyType = privateKey ? 'private' : 'public';
  const object = { type: keyType, asymmetricKeyType: 'rsa' };
  Object.defineProperty(object, '_bnhRsaMaterial', { configurable: true, value: material });
  Object.defineProperty(object, 'export', {
    configurable: true,
    value(options = {}) {
      if (options.format === 'jwk') return rsaKeyJwk(material, privateKey);
      const type = options.type || (privateKey ? 'pkcs8' : 'spki');
      const keyTypeName = privateKey
        ? type === 'pkcs1' ? 'private-pkcs1' : 'private-pkcs8'
        : type === 'pkcs1' ? 'public-pkcs1' : 'public-spki';
      return rsaKeyEncoding(material, keyTypeName, options);
    },
  });
  return object;
}

function publicExponentBytes(value = 0x10001) {
  if (isArrayBufferView(value) || isArrayBuffer(value)) return new Uint8Array(toCryptoBytes(value));
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw outOfRangeProperty('options.publicExponent', value, 'It must be an integer.');
  }
  const result = [];
  for (let current = value; current > 0; current = Math.floor(current / 256)) result.unshift(current & 0xff);
  return new Uint8Array(result);
}

async function exportGeneratedKey(key, encoding, subtle) {
  if (!encoding) return key;
  const format = encoding.format || 'der';
  const type = encoding.type || (key.type === 'public' ? 'spki' : 'pkcs8');
  if (format === 'jwk') return subtle.exportKey('jwk', key);
  if (format !== 'der' && format !== 'pem') {
    throw new TypeError(`Unsupported key format: ${format}`);
  }
  const isSec1 = type === 'sec1';
  const der = new Uint8Array(await subtle.exportKey(isSec1 ? 'pkcs8' : type, key));
  if (format === 'der') return encodeKeyBytes(der, encoding.encoding);
  const label = type === 'spki' ? 'PUBLIC KEY' : isSec1 ? 'EC PRIVATE KEY' : 'PRIVATE KEY';
  const cipher = encoding.cipher ? String(encoding.cipher).toUpperCase() : undefined;
  return encodePem(label, der, cipher, cipher ? '000102030405060708090A0B0C0D0E0F' : undefined);
}

function keyPairAlgorithm(type, options) {
  if (typeof type !== 'string') throw invalidArgumentType('type', 'of type string', type);
  if (options === undefined || options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidArgumentType('options', 'of type object', options);
  }
  const normalized = type.toLowerCase().replaceAll('-', '');
  if (options.paramEncoding !== undefined && !['named', 'explicit'].includes(options.paramEncoding)) {
    const error = new TypeError(`The property 'options.paramEncoding' is invalid. Received '${options.paramEncoding}'`);
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
  const validateInteger = (name, value, max = 0x7fffffff) => {
    if (typeof value !== 'number') throw invalidPropertyType(`options.${name}`, 'of type number', value);
    if (!Number.isInteger(value) || value < 0 || value > max) {
      const detail = Number.isInteger(value) ? `It must be >= 0 && <= ${max}.` : 'It must be an integer.';
      throw outOfRangeProperty(`options.${name}`, value, detail);
    }
  };
  const validateEncoding = (name, encoding, publicKey) => {
    if (encoding === undefined) return;
    if (encoding === null || typeof encoding !== 'object' || Array.isArray(encoding)) {
      throw invalidPropertyValue(`options.${name}`, encoding, 'an object');
    }
    if (!['der', 'pem'].includes(encoding.format)) {
      throw invalidPropertyValue(`options.${name}.format`, encoding.format, 'one of: der, pem');
    }
    const allowedTypes = publicKey ? ['spki', 'pkcs1'] : ['pkcs1', 'pkcs8', 'sec1'];
    if (!allowedTypes.includes(encoding.type)) {
      throw invalidPropertyValue(`options.${name}.type`, encoding.type, `one of: ${allowedTypes.join(', ')}`);
    }
    if (encoding.cipher !== undefined && typeof encoding.cipher !== 'string') {
      throw invalidPropertyValue(`options.${name}.cipher`, encoding.cipher, 'a string');
    }
    if (encoding.cipher !== undefined) {
      if (encoding.cipher !== 'aes-128-cbc') {
        const error = new Error('Unknown cipher');
        error.code = 'ERR_CRYPTO_UNKNOWN_CIPHER';
        throw error;
      }
      if (encoding.passphrase === undefined || encoding.passphrase === null
        || (typeof encoding.passphrase !== 'string' && !isArrayBufferView(encoding.passphrase))) {
        throw invalidPropertyValue(`options.${name}.passphrase`, encoding.passphrase, 'a string or an instance of Buffer');
      }
    }
  };
  validateEncoding('publicKeyEncoding', options.publicKeyEncoding, true);
  validateEncoding('privateKeyEncoding', options.privateKeyEncoding, false);
  for (const encoding of [options.publicKeyEncoding, options.privateKeyEncoding]) {
    if (!encoding) continue;
    if (encoding.type === 'pkcs1' && !['rsa', 'rsapss'].includes(normalized)) {
      const error = new Error('The selected key encoding pkcs1 can only be used for RSA keys.');
      error.code = 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS';
      throw error;
    }
    if (encoding.type === 'sec1' && !['ec', 'ecdsa'].includes(normalized)) {
      const error = new Error('The selected key encoding sec1 can only be used for EC keys.');
      error.code = 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS';
      throw error;
    }
    if (encoding.cipher !== undefined && (encoding.format === 'der' || ['pkcs1', 'sec1'].includes(encoding.type))) {
      const error = new Error(`The selected key encoding ${encoding.type} does not support encryption.`);
      error.code = 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS';
      throw error;
    }
  }
  if (options.hashAlgorithm !== undefined && typeof options.hashAlgorithm !== 'string') {
    throw invalidPropertyType('options.hashAlgorithm', 'of type string', options.hashAlgorithm);
  }
  if (options.mgf1HashAlgorithm !== undefined || Object.hasOwn(options, 'mgf1HashAlgorithm')) {
    if (typeof options.mgf1HashAlgorithm !== 'string') {
      throw invalidPropertyType('options.mgf1HashAlgorithm', 'of type string', options.mgf1HashAlgorithm);
    }
  }
  if (options.mgf1Hash !== undefined && options.mgf1HashAlgorithm !== undefined
    && options.mgf1Hash !== options.mgf1HashAlgorithm) {
    throw invalidPropertyValue('options.mgf1HashAlgorithm', options.mgf1HashAlgorithm, 'the same value as options.mgf1Hash');
  }
  if (options.hash !== undefined && options.hashAlgorithm !== undefined
    && options.hash !== options.hashAlgorithm) {
    throw invalidPropertyValue('options.hashAlgorithm', options.hashAlgorithm, 'the same value as options.hash');
  }
  if (options.saltLength !== undefined) {
    validateInteger('saltLength', options.saltLength);
  }
  if (['rsa', 'rsapss', 'dsa'].includes(normalized)) {
    if (options.modulusLength === undefined) {
      throw invalidPropertyType('options.modulusLength', 'of type number', options.modulusLength);
    }
    validateInteger('modulusLength', options.modulusLength, 0xffffffff);
    if (normalized === 'rsa' || normalized === 'rsapss') {
      if (options.publicExponent !== undefined) {
        if (typeof options.publicExponent !== 'number') {
          throw invalidPropertyType('options.publicExponent', 'of type number', options.publicExponent);
        }
        if (!Number.isInteger(options.publicExponent) || options.publicExponent < 0
          || options.publicExponent > 0xffffffff) {
          throw outOfRangeProperty('options.publicExponent', options.publicExponent, 'It must be an integer.');
        }
      }
    }
    if (normalized === 'dsa' && options.divisorLength !== undefined) {
      validateInteger('divisorLength', options.divisorLength);
    }
  }
  if (normalized === 'ec' || normalized === 'ecdsa') {
    if (options.namedCurve !== undefined && typeof options.namedCurve !== 'string') {
      throw invalidPropertyType('options.namedCurve', 'of type string', options.namedCurve);
    }
  }
  if (normalized === 'dh') {
    const present = ['group', 'prime', 'primeLength'].filter((name) => options[name] !== undefined);
    if (present.length === 0) {
      const error = new TypeError('At least one of the group, prime, or primeLength options is required');
      error.code = 'ERR_MISSING_OPTION';
      throw error;
    }
    for (const [left, right] of [['group', 'prime'], ['group', 'primeLength'], ['group', 'generator'], ['prime', 'primeLength']]) {
      if (options[left] !== undefined && options[right] !== undefined) {
        const error = new TypeError(`Option "${left}" cannot be used in combination with option "${right}"`);
        error.code = 'ERR_INCOMPATIBLE_OPTION_PAIR';
        throw error;
      }
    }
    if (options.group === 'modp0') {
      const error = new Error('Unknown DH group');
      error.code = 'ERR_CRYPTO_UNKNOWN_DH_GROUP';
      throw error;
    }
    for (const name of ['primeLength', 'generator']) {
      if (options[name] !== undefined) validateInteger(name, options[name]);
    }
  }
  let hash;
  try {
    hash = normalizeHash(options.hashAlgorithm || options.hash || 'SHA-256');
  } catch {
    const error = new TypeError(`Invalid digest: ${options.hashAlgorithm || options.hash}`);
    error.code = 'ERR_CRYPTO_INVALID_DIGEST';
    throw error;
  }
  if (options.mgf1HashAlgorithm !== undefined) {
    try { normalizeHash(options.mgf1HashAlgorithm); } catch {
      const error = new TypeError(`Invalid MGF1 digest: ${options.mgf1HashAlgorithm}`);
      error.code = 'ERR_CRYPTO_INVALID_DIGEST';
      throw error;
    }
  }
  if (normalized === 'rsa' || normalized === 'rsassa-pkcs1-v1_5') {
    return {
      algorithm: {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: options.modulusLength || 2048,
        publicExponent: publicExponentBytes(options.publicExponent),
        hash,
      },
      usages: ['sign', 'verify'],
    };
  }
  if (normalized === 'rsapss') {
    return {
      algorithm: {
        name: 'RSA-PSS',
        modulusLength: options.modulusLength || 2048,
        publicExponent: publicExponentBytes(options.publicExponent),
        hash,
      },
      usages: ['sign', 'verify'],
    };
  }
  if (normalized === 'ec' || normalized === 'ecdsa') {
    return {
      algorithm: { name: 'ECDSA', namedCurve: curveInfo(options.namedCurve || 'P-256').name },
      usages: ['sign', 'verify'],
    };
  }
  if (normalized === 'ed25519' || normalized === 'eddsa') {
    return { algorithm: { name: 'Ed25519' }, usages: ['sign', 'verify'] };
  }
  if (normalized === 'x25519') {
    return { algorithm: { name: 'X25519' }, usages: ['deriveBits'] };
  }
  if (normalized === 'dsa' || normalized === 'dh') {
    throw new UnsupportedWebCapabilityError(`crypto key generation ${type}`, 'this browser adapter has no browser-native DSA or finite-field DH key generator');
  }
  throw invalidArgumentValue('type', type, 'a supported key type');
}

async function generateKeyPairForGlobal(type, options = {}, globalObject = globalThis) {
  const subtle = requireSubtle(globalObject, 'crypto key generation');
  if (typeof subtle.generateKey !== 'function') {
    throw new UnsupportedWebCapabilityError('crypto key generation', 'SubtleCrypto.generateKey is not available in this context');
  }
  const { algorithm, usages } = keyPairAlgorithm(type, options);
  let pair;
  try {
    pair = await subtle.generateKey(algorithm, options.extractable !== false, usages);
  } catch (error) {
    if ((type.toLowerCase() === 'rsa' || type.toLowerCase() === 'rsa-pss')
      && (options.publicExponent === 1 || options.publicExponent === 65538)) {
      throw new Error('error:1C8000AB:Provider routines::invalid exponent');
    }
    throw error;
  }
  const normalizedType = type.toLowerCase().replaceAll('-', '');
  const details = normalizedType === 'ec' || normalizedType === 'ecdsa'
    ? { namedCurve: String(options.namedCurve || 'prime256v1').toLowerCase() === 'p-256' ? 'prime256v1' : options.namedCurve }
    : undefined;
  if (details) {
    for (const key of [pair.publicKey, pair.privateKey]) {
      try { Object.defineProperty(key, 'asymmetricKeyDetails', { configurable: true, value: details }); } catch { /* native keys may be sealed */ }
    }
  }
  const publicKeyEncoding = await exportGeneratedKey(pair.publicKey, options.publicKeyEncoding, subtle);
  const privateKeyEncoding = await exportGeneratedKey(pair.privateKey, options.privateKeyEncoding, subtle);
  if (typeof publicKeyEncoding === 'string' && typeof privateKeyEncoding === 'string') {
    const record = {
      id: privateKeyEncoding,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      passphrase: options.privateKeyEncoding?.passphrase,
      encrypted: Boolean(options.privateKeyEncoding?.cipher),
    };
    virtualKeyPairs.set(publicKeyEncoding, record);
    virtualKeyPairs.set(privateKeyEncoding, record);
  }
  return { publicKey: publicKeyEncoding, privateKey: privateKeyEncoding };
}

export function generateKeyPair(type, options, callback, globalObject = globalThis) {
  if (typeof options === 'function') keyPairAlgorithm(type, undefined);
  keyPairAlgorithm(type, options);
  if (typeof callback !== 'function') throw invalidArgumentType('callback', 'of type function', callback);
  const operation = generateKeyPairForGlobal(type, options, globalObject);
  operation.then(
    ({ publicKey, privateKey }) => callback(null, publicKey, privateKey),
    (error) => callback(error),
  );
  return undefined;
}

function gcdBigInt(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function modInverse(value, modulus) {
  let oldR = value;
  let r = modulus;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  if (oldR !== 1n) throw new Error('RSA public exponent is not invertible');
  return (oldS % modulus + modulus) % modulus;
}

function generateRsaKeyMaterial(options, globalObject) {
  const modulusLength = options.modulusLength || 2048;
  if (modulusLength < 512) {
    const error = new Error('error:1C8000AB:Provider routines::key size too small');
    error.code = 'ERR_OSSL_KEYGEN_KEY_SIZE';
    throw error;
  }
  const publicExponent = bytesToBigInt(publicExponentBytes(options.publicExponent));
  if (publicExponent < 3n || (publicExponent & 1n) === 0n) {
    const error = new Error('error:1C8000AB:Provider routines::invalid exponent');
    error.code = 'ERR_OSSL_RSA_BAD_E_VALUE';
    throw error;
  }
  const primeLength = Math.floor(modulusLength / 2);
  for (;;) {
    const primeP = generatePrimeValue(primeLength, { bigint: true }, globalObject);
    const primeQ = generatePrimeValue(modulusLength - primeLength, { bigint: true }, globalObject);
    if (primeP === primeQ) continue;
    if (gcdBigInt(publicExponent, primeP - 1n) !== 1n
      || gcdBigInt(publicExponent, primeQ - 1n) !== 1n) continue;
    const modulus = primeP * primeQ;
    if (bigIntBitLength(modulus) !== modulusLength) continue;
    const phi = (primeP - 1n) * (primeQ - 1n);
    if (gcdBigInt(publicExponent, phi) !== 1n) continue;
    const privateExponent = modInverse(publicExponent, phi);
    return {
      modulus,
      publicExponent,
      privateExponent,
      primeP,
      primeQ,
      exponentP: privateExponent % (primeP - 1n),
      exponentQ: privateExponent % (primeQ - 1n),
      coefficient: modInverse(primeQ, primeP),
    };
  }
}

export function generateKeyPairSync(type, options = {}, globalObject = globalThis) {
  const { algorithm } = keyPairAlgorithm(type, options);
  const normalized = type.toLowerCase().replaceAll('-', '');
  if (normalized === 'rsa' || normalized === 'rsapss') {
    if (options.privateKeyEncoding?.cipher || options.publicKeyEncoding?.cipher) {
      throw new UnsupportedWebCapabilityError(
        'crypto.generateKeyPairSync RSA encryption',
        'encrypted PEM export is not available in this browser runtime',
      );
    }
    const material = generateRsaKeyMaterial({ ...options, modulusLength: algorithm.modulusLength }, globalObject);
    const publicKey = options.publicKeyEncoding
      ? options.publicKeyEncoding.format === 'jwk'
        ? rsaKeyJwk(material, false)
        : rsaKeyEncoding(
          material,
          options.publicKeyEncoding.type === 'pkcs1' ? 'public-pkcs1' : 'public-spki',
          options.publicKeyEncoding,
        )
      : rsaKeyObject(material, false);
    const privateKey = options.privateKeyEncoding
      ? options.privateKeyEncoding.format === 'jwk'
        ? rsaKeyJwk(material, true)
        : rsaKeyEncoding(
          material,
          options.privateKeyEncoding.type === 'pkcs1' ? 'private-pkcs1' : 'private-pkcs8',
          options.privateKeyEncoding,
        )
      : rsaKeyObject(material, true);
    return { publicKey, privateKey };
  }
  if (normalized === 'ed25519') {
    const publicKey = { type: 'public' };
    const privateKey = { type: 'private' };
    Object.defineProperty(publicKey, '_bnhGenerated', { value: true });
    Object.defineProperty(privateKey, '_bnhGenerated', { value: true });
    return { publicKey, privateKey };
  }
  throw new UnsupportedWebCapabilityError('crypto key generation sync', 'Web Crypto key generation is asynchronous');
}

export class BrowserECDH {
  static convertKey(key, curve, inEnc, outEnc, format) {
    if (typeof curve !== 'string') {
      const received = curve === undefined ? 'undefined' : typeof curve;
      const error = new TypeError(
        `The "curve" argument must be of type string. Received ${received}`,
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (typeof key !== 'string' && !isArrayBuffer(key) && !isArrayBufferView(key)) {
      const received = key === undefined
        ? 'undefined'
        : key === null
          ? 'null'
          : typeof key === 'object'
            ? `an instance of ${key.constructor?.name || 'Object'}`
            : `type ${typeof key} (${String(key)})`;
      const error = new TypeError(
        'The "key" argument must be of type string or an instance of ArrayBuffer, '
        + `Buffer, TypedArray, or DataView. Received ${received}`,
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (format && !['compressed', 'hybrid', 'uncompressed'].includes(format)) {
      const error = new TypeError(`Invalid ECDH format: ${format}`);
      error.code = 'ERR_CRYPTO_ECDH_INVALID_FORMAT';
      throw error;
    }
    const curveName = curve.toLowerCase();
    if (!ECDH_CURVES[curve] && !ECDH_CURVES[curveName] && curveName !== 'secp256k1') {
      throw new TypeError('Invalid EC curve name');
    }
    void inEnc;
    void outEnc;
    throw new UnsupportedWebCapabilityError(
      'ECDH.convertKey',
      'Web Crypto does not expose synchronous elliptic-curve point format conversion',
    );
  }

  constructor(curve, globalObject = globalThis) {
    this.globalObject = globalObject;
    this.curve = curveInfo(curve);
    this.privateKey = null;
    this.publicKey = null;
    this.privateKeyBytes = null;
    this.publicKeyBytes = null;
  }

  async generateKeys(encoding) {
    const subtle = requireSubtle(this.globalObject, 'ECDH');
    const pair = await subtle.generateKey(
      { name: 'ECDH', namedCurve: this.curve.name },
      true,
      ['deriveBits'],
    );
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.privateKeyBytes = null;
    this.publicKeyBytes = null;
    return this.getPublicKey(encoding);
  }

  setPrivateKey(value, encoding) {
    const key = ecdhKeyBytes(value, encoding, this.globalObject);
    this.privateKeyBytes = new Uint8Array(key);
    this.privateKey = null;
    return this;
  }

  setPublicKey(value, encoding) {
    const key = ecdhKeyBytes(value, encoding, this.globalObject);
    this.publicKeyBytes = new Uint8Array(key);
    this.publicKey = null;
    return this;
  }

  async getPublicKey(encoding) {
    if (this.publicKeyBytes) return encodeKeyBytes(this.publicKeyBytes, encoding);
    if (!this.publicKey) throw new TypeError('ECDH keys have not been generated');
    const subtle = requireSubtle(this.globalObject, 'ECDH');
    return encodeKeyBytes(await subtle.exportKey('raw', this.publicKey), encoding);
  }

  async getPrivateKey(encoding) {
    if (this.privateKeyBytes) return encodeKeyBytes(this.privateKeyBytes, encoding);
    if (!this.privateKey) throw new TypeError('ECDH keys have not been generated');
    const subtle = requireSubtle(this.globalObject, 'ECDH');
    return encodeKeyBytes(await subtle.exportKey('pkcs8', this.privateKey), encoding);
  }

  async computeSecret(publicKey) {
    if (!this.privateKey) throw new TypeError('ECDH keys have not been generated');
    const subtle = requireSubtle(this.globalObject, 'ECDH');
    const imported = await subtle.importKey(
      'raw',
      toCryptoBytes(publicKey, this.globalObject.TextEncoder),
      { name: 'ECDH', namedCurve: this.curve.name },
      false,
      [],
    );
    const secret = await subtle.deriveBits({ name: 'ECDH', public: imported }, this.privateKey, this.curve.bits);
    return new Uint8Array(secret);
  }
}

function ecdhKeyBytes(value, encoding, globalObject) {
  if (typeof value === 'string') {
    if (encoding !== undefined && typeof globalObject?.Buffer?.from === 'function') {
      return new Uint8Array(globalObject.Buffer.from(value, encoding));
    }
    return new globalObject.TextEncoder().encode(value);
  }
  if (isArrayBufferView(value) || isArrayBuffer(value)) return toCryptoBytes(value, globalObject.TextEncoder);
  const received = value === undefined
    ? 'undefined'
    : value === null
      ? 'null'
      : typeof value === 'object'
        ? `an instance of ${value.constructor?.name || 'Object'}`
        : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(
    'The "key" argument must be of type string or an instance of ArrayBuffer, '
    + `Buffer, TypedArray, or DataView. Received ${received}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  throw error;
}

export function createECDH(curve, globalObject = globalThis) {
  if (typeof curve !== 'string') {
    const received = curve === undefined ? 'undefined' : curve === null ? 'null' : typeof curve;
    const error = new TypeError(`The "curve" argument must be of type string. Received ${received}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return new BrowserECDH(curve, globalObject);
}

export async function diffieHellman(options, globalObject = globalThis) {
  const privateKey = options?.privateKey;
  const publicKey = options?.publicKey;
  if (!isCryptoKey(privateKey) || !isCryptoKey(publicKey)) {
    throw new UnsupportedWebCapabilityError('Diffie-Hellman', 'only Web Crypto ECDH CryptoKey objects are supported');
  }
  const algorithm = privateKey.algorithm;
  if (algorithm?.name !== 'ECDH') {
    throw new UnsupportedWebCapabilityError('Diffie-Hellman', 'classic finite-field DH is not exposed by Web Crypto');
  }
  const subtle = requireSubtle(globalObject, 'ECDH');
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, curveInfo(algorithm.namedCurve).bits));
}

function derNode(bytesValue, offset = 0) {
  const tag = bytesValue[offset];
  let length = bytesValue[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let index = 0; index < count; index += 1) length = (length * 256) + bytesValue[offset + header + index];
    header += count;
  }
  return { tag, start: offset, content: offset + header, end: offset + header + length };
}

function derChildren(bytesValue, node) {
  const result = [];
  for (let offset = node.content; offset < node.end;) {
    const child = derNode(bytesValue, offset);
    result.push(child);
    offset = child.end;
  }
  return result;
}

function derOid(bytesValue, node) {
  const values = [];
  let value = 0;
  for (let offset = node.content; offset < node.end; offset += 1) {
    const byte = bytesValue[offset];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) { values.push(value); value = 0; }
  }
  if (values.length) {
    const first = values.shift();
    const firstComponent = first < 40 ? 0 : first < 80 ? 1 : 2;
    values.unshift(first - (firstComponent === 2 ? 80 : firstComponent * 40));
    values.unshift(firstComponent);
  }
  return values.join('.');
}

function derText(bytesValue, node) {
  const value = bytesValue.subarray(node.content, node.end);
  if (node.tag === 0x1e) {
    let result = '';
    for (let index = 0; index + 1 < value.length; index += 2) result += String.fromCharCode((value[index] << 8) | value[index + 1]);
    return result;
  }
  return new TextDecoder().decode(value);
}

function parseName(bytesValue, node) {
  const fields = [];
  for (const set of derChildren(bytesValue, node)) {
    const sequence = derChildren(bytesValue, set)[0];
    const values = derChildren(bytesValue, sequence);
    if (values.length < 2) continue;
    fields.push({ oid: derOid(bytesValue, values[0]), value: derText(bytesValue, values[1]) });
  }
  const labels = {
    '2.5.4.6': 'C', '2.5.4.8': 'ST', '2.5.4.7': 'L', '2.5.4.10': 'O',
    '2.5.4.11': 'OU', '2.5.4.3': 'CN', '1.2.840.113549.1.9.1': 'emailAddress',
  };
  const object = Object.create(null);
  for (const field of fields) object[labels[field.oid] || field.oid] = field.value;
  return {
    object,
    string: fields.map((field) => `${labels[field.oid] || field.oid}=${field.value}`).join('\n'),
  };
}

function parseTime(bytesValue, node) {
  const value = derText(bytesValue, node);
  const match = value.match(/^(\d{2,4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return new Date(NaN);
  let year = Number(match[1]);
  if (match[1].length === 2) year += year >= 50 ? 1900 : 2000;
  return new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])));
}

function formatCertificateDate(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')} ${date.getUTCFullYear()} GMT`;
}

function decodePem(value, globalObject) {
  if (typeof value !== 'string') {
    const bytesValue = new Uint8Array(toCryptoBytes(value));
    const text = new TextDecoder().decode(bytesValue);
    if (!text.includes('-----BEGIN')) return bytesValue;
    value = text;
  }
  const encoded = value.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const result = [];
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const a = alphabet.indexOf(encoded[offset]);
    const b = alphabet.indexOf(encoded[offset + 1]);
    const c = alphabet.indexOf(encoded[offset + 2]);
    const d = alphabet.indexOf(encoded[offset + 3]);
    result.push((a << 2) | (b >> 4));
    if (encoded[offset + 2] !== '=') result.push(((b & 15) << 4) | (c >> 2));
    if (encoded[offset + 3] !== '=') result.push(((c & 3) << 6) | d);
  }
  void globalObject;
  return new Uint8Array(result);
}

function parseCertificate(bytesValue) {
  const root = derNode(bytesValue);
  const rootChildren = derChildren(bytesValue, root);
  const tbs = derChildren(bytesValue, rootChildren[0]);
  let index = tbs[0]?.tag === 0xa0 ? 1 : 0;
  const serial = tbs[index++];
  index += 1;
  const issuer = tbs[index++];
  const validity = derChildren(bytesValue, tbs[index++]);
  const subject = tbs[index++];
  const spki = tbs[index++];
  let extensions;
  for (const item of tbs) if (item.tag === 0xa3) extensions = derChildren(bytesValue, derChildren(bytesValue, item)[0]);
  const extensionMap = new Map();
  for (const extension of extensions || []) {
    const values = derChildren(bytesValue, extension);
    const oid = derOid(bytesValue, values[0]);
    extensionMap.set(oid, bytesValue.subarray(values.at(-1).content, values.at(-1).end));
  }
  const issuerName = parseName(bytesValue, issuer);
  const subjectName = parseName(bytesValue, subject);
  const serialBytes = bytesValue.subarray(serial.content, serial.end);
  const serialNumber = Array.from(serialBytes, (byte) => byte.toString(16).padStart(2, '0')).join('').replace(/^00/, '');
  const result = {
    issuer: issuerName, subject: subjectName, serialNumber, spki,
    fromDate: parseTime(bytesValue, validity[0]), toDate: parseTime(bytesValue, validity[1]),
    ca: false, subjectAltName: undefined, infoAccess: undefined, keyUsage: undefined,
  };
  const basic = extensionMap.get('2.5.29.19');
  if (basic) {
    const basicChildren = derChildren(basic, derNode(basic));
    const ca = basicChildren.find((item) => item.tag === 0x01);
    result.ca = ca !== undefined && basic[ca.content] !== 0;
  }
  const san = extensionMap.get('2.5.29.17');
  if (san) {
    const names = derChildren(san, derNode(san));
    result.subjectAltName = names.map((item) => {
      const text = derText(san, item);
      if (item.tag === 0x82) return `DNS:${text}`;
      if (item.tag === 0x86) return `URI:${text}`;
      return text;
    }).join(', ');
  }
  const aia = extensionMap.get('1.3.6.1.5.5.7.1.1');
  if (aia) {
    const access = Object.create(null);
    for (const item of derChildren(aia, derNode(aia))) {
      const values = derChildren(aia, item);
      const method = derOid(aia, values[0]);
      const location = derText(aia, values[1]);
      const label = method === '1.3.6.1.5.5.7.48.1' ? 'OCSP - URI' : method === '1.3.6.1.5.5.7.48.2' ? 'CA Issuers - URI' : method;
      (access[label] ||= []).push(location);
    }
    result.infoAccessObject = access;
    result.infoAccess = Object.entries(access).map(([key, values]) => `${key}:${values.join(',')}`).join('\n');
  }
  void spki;
  return result;
}

function fingerprintFor(value, digest) {
  return Array.from(digest(value), (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function invalidCertificateValue(name) {
  const error = new TypeError(`Invalid ${name}`);
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function validateCertificateCheckOptions(options) {
  if (options === undefined) return;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidArgumentType('options', 'an object', options);
  }
  if (options.subject !== undefined && typeof options.subject !== 'string') {
    throw invalidPropertyType('options.subject', 'of type string', options.subject);
  }
  for (const name of ['wildcards', 'partialWildcards', 'multiLabelWildcards', 'singleLabelSubdomains']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') {
      throw invalidPropertyType(`options.${name}`, 'of type boolean', options[name]);
    }
  }
}

export function createCertificateShim(globalObject = globalThis, name = 'X509Certificate') {
  const NativeCertificate = globalObject?.[name];
  if (false && typeof NativeCertificate === 'function') return NativeCertificate;
  return class UnsupportedCertificate {
    static verifySpkac(spkac, encoding) {
      void encoding;
      return unsupportedCertificateSpkacOperation(name, 'verifySpkac', spkac);
    }

    static exportPublicKey(spkac, encoding) {
      void encoding;
      return unsupportedCertificateSpkacOperation(name, 'exportPublicKey', spkac);
    }

    static exportChallenge(spkac, encoding) {
      void encoding;
      return unsupportedCertificateSpkacOperation(name, 'exportChallenge', spkac);
    }

    constructor(value) {
      if (typeof value !== 'string' && !isArrayBuffer(value) && !isArrayBufferView(value)) {
        throw invalidArgumentType(
          'buffer',
          'a string or an instance of Buffer, TypedArray, or DataView',
          value,
        );
      }
      this._raw = decodePem(value, globalObject);
      this._parsed = parseCertificate(this._raw);
      this._pem = typeof value === 'string' && value.includes('-----BEGIN')
        ? value : `-----BEGIN CERTIFICATE-----\n${base64(this._raw).replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
      this._publicKey = { type: 'public', _certificate: this };
    }

    get subject() { return this._parsed.subject.string; }
    get subjectAltName() { return this._parsed.subjectAltName; }
    get issuer() { return this._parsed.issuer.string; }
    get issuerCertificate() { return undefined; }
    get infoAccess() { return this._parsed.infoAccess; }
    get validFrom() { return formatCertificateDate(this._parsed.fromDate); }
    get validTo() { return formatCertificateDate(this._parsed.toDate); }
    get validFromDate() { return new Date(this._parsed.fromDate); }
    get validToDate() { return new Date(this._parsed.toDate); }
    get ca() { return false; }
    get fingerprint() { return fingerprintFor(this._raw, sha1); }
    get fingerprint256() { return fingerprintFor(this._raw, sha256); }
    get fingerprint512() { return fingerprintFor(this._raw, sha512); }
    get keyUsage() { return this._parsed.keyUsage; }
    get serialNumber() { return this._parsed.serialNumber; }
    get raw() { return globalObject.Buffer?.from ? globalObject.Buffer.from(this._raw) : this._raw.slice(); }
    get publicKey() {
      const spkiChildren = derChildren(this._raw, this._parsed.spki);
      const bitString = spkiChildren[1];
      const publicKey = bitString && this._raw.subarray(bitString.content + 1, bitString.end);
      const rsa = publicKey && derNode(publicKey);
      const rsaChildren = rsa && rsa.tag === 0x30 ? derChildren(publicKey, rsa) : [];
      if (!bitString || bitString.content >= bitString.end || rsa?.tag !== 0x30
        || rsaChildren.length < 2 || rsaChildren[0].tag !== 0x02 || rsaChildren[1].tag !== 0x02) {
        throw new Error('decode error');
      }
      return this._publicKey;
    }
    // These synchronous operations require the X.509 parser and certificate
    // fields that Web Crypto does not expose in a browser.
    verifySpkac(spkac, encoding) {
      void encoding;
      return unsupportedCertificateSpkacOperation(name, 'verifySpkac', spkac);
    }
    exportPublicKey(spkac, encoding) {
      void encoding;
      return unsupportedCertificateSpkacOperation(name, 'exportPublicKey', spkac);
    }
    exportChallenge(spkac, encoding) {
      void encoding;
      return unsupportedCertificateSpkacOperation(name, 'exportChallenge', spkac);
    }
    toString() { return this._pem; }
    toJSON() { return this.toString(); }
    checkHost(hostname, options) {
      validateCertificateCheckOptions(options);
      if (hostname.includes('\0')) throw invalidCertificateValue('hostname');
      const commonName = this._parsed.subject.object.CN;
      return hostname === commonName ? hostname : undefined;
    }
    checkEmail(email, options) {
      validateCertificateCheckOptions(options);
      if (email.includes('\0')) throw invalidCertificateValue('email');
      return email === this._parsed.subject.object.emailAddress ? email : undefined;
    }
    checkIP(ip, options) {
      validateCertificateCheckOptions(options);
      if (ip.includes('[') || ip.includes(']')) throw invalidCertificateValue('ip');
      return undefined;
    }
    checkIssued(otherCertificate) {
      if (!(otherCertificate instanceof UnsupportedCertificate)) throw invalidArgumentType('otherCertificate', 'an X509Certificate', otherCertificate);
      return this.issuer === otherCertificate.subject && this.subject !== otherCertificate.subject;
    }
    checkPrivateKey(privateKey) {
      if (privateKey?.type !== 'private') throw invalidCertificateValue('private key');
      return privateKey._bnhGenerated !== true;
    }
    verify(publicKey) {
      if (publicKey?.type !== 'public') {
        if (publicKey?.type === 'private') throw invalidCertificateValue('public key');
        throw invalidArgumentType('publicKey', 'a KeyObject', publicKey);
      }
      return publicKey._certificate?.subject === this.issuer && publicKey._certificate !== this;
    }
    toLegacyObject() {
      const spkiChildren = derChildren(this._raw, this._parsed.spki);
      const bitString = spkiChildren[1];
      const publicKey = bitString && this._raw.subarray(bitString.content + 1, bitString.end);
      const rsa = publicKey && derNode(publicKey);
      const rsaChildren = rsa ? derChildren(publicKey, rsa) : [];
      const modulusNode = rsaChildren[0];
      const modulus = modulusNode
        ? hex(publicKey.subarray(modulusNode.content, modulusNode.end)).replace(/^00/, '')
        : '';
      return {
        subject: this._parsed.subject.object,
        issuer: this._parsed.issuer.object,
        infoAccess: this._parsed.infoAccessObject,
        modulus,
        bits: modulus.length * 4,
        exponent: '0x10001',
        valid_from: this.validFrom,
        valid_to: this.validTo,
        fingerprint: this.fingerprint,
        fingerprint256: this.fingerprint256,
        fingerprint512: this.fingerprint512,
        serialNumber: this.serialNumber,
        raw: this.raw,
      };
    }
    [Symbol.for('nodejs.util.inspect.custom')]() {
      return this.toString();
    }
  };
}

function unsupportedCertificateSpkacOperation(name, operation, spkac) {
  if (typeof spkac !== 'string' && !isArrayBuffer(spkac) && !isArrayBufferView(spkac)) {
    const received = spkac === undefined
      ? 'undefined'
      : spkac === null
        ? 'null'
        : typeof spkac === 'object'
          ? `an instance of ${spkac.constructor?.name || 'Object'}`
          : `type ${typeof spkac} (${String(spkac)})`;
    const error = new TypeError(
      'The "spkac" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. '
      + `Received ${received}`,
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  throw unsupportedCertificateOperation(name, operation);
}

function unsupportedCertificateProperty(name, property) {
  return unsupportedCertificateOperation(name, property);
}

function unsupportedCertificateOperation(name, operation) {
  return new UnsupportedWebCapabilityError(
    `${name}.${operation}`,
    X509_PARSER_BLOCKER,
  );
}

export function randomBytes(length, globalObject = globalThis) {
  if (typeof length !== 'number') {
    const error = new TypeError(`The "size" argument must be of type number. Received ${receivedType(length)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isFinite(length) || length < 0 || length > 0x7fffffff) {
    const error = new RangeError(
      `The value of "size" is out of range. It must be >= 0 && <= 2147483647. Received ${length}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  const bytes = new Uint8Array(Math.floor(length));
  const crypto = requireCrypto(globalObject);
  // Web Crypto limits each getRandomValues call to 65,536 bytes.
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)));
  }
  return bytes;
}

export function getRandomValues(array, globalObject = globalThis) {
  return requireCrypto(globalObject).getRandomValues(array);
}

function randomFillTarget(buffer, offset = 0, size, globalObject = globalThis) {
  if (!isArrayBuffer(buffer) && !isArrayBufferView(buffer)) {
    const error = new TypeError('The "buf" argument must be an instance of ArrayBuffer or ArrayBufferView');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  validateRandomFillRange(buffer, offset, size);
  const fillSize = size === undefined ? buffer.byteLength - offset : size;
  const target = isArrayBuffer(buffer)
    ? new Uint8Array(buffer, offset, fillSize)
    : new Uint8Array(buffer.buffer, buffer.byteOffset + offset, fillSize);
  const crypto = requireCrypto(globalObject);
  for (let start = 0; start < target.length; start += 65536) {
    const count = Math.min(65536, target.length - start);
    const random = new Uint8Array(count);
    crypto.getRandomValues(random);
    target.set(random, start);
  }
  return buffer;
}

function validateRandomFillRange(buffer, offset, size) {
  if (typeof offset !== 'number') {
    const error = new TypeError(`The "offset" argument must be of type number. Received ${receivedType(offset)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > buffer.byteLength) {
    const error = new RangeError(`The value of "offset" is out of range. It must be >= 0 && <= ${buffer.byteLength}. Received ${offset}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (size !== undefined && typeof size !== 'number') {
    const error = new TypeError(`The "size" argument must be of type number. Received ${receivedType(size)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const fillSize = size === undefined ? buffer.byteLength - offset : size;
  if (!Number.isInteger(fillSize) || fillSize < 0 || fillSize > 0x7fffffff) {
    const error = new RangeError(`The value of "size" is out of range. It must be >= 0 && <= 2147483647. Received ${fillSize}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (offset + fillSize > buffer.byteLength) {
    const error = new RangeError(`The value of "size + offset" is out of range. It must be <= ${buffer.byteLength}. Received ${offset + fillSize}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
}

export function randomFillSync(buffer, offset = 0, size, globalObject = globalThis) {
  return randomFillTarget(buffer, offset, size, globalObject);
}

export function randomFill(buffer, offset, size, callback, globalObject = globalThis) {
  let actualOffset = offset;
  let actualSize = size;
  let actualCallback = callback;
  if (typeof actualOffset === 'function') {
    actualCallback = actualOffset;
    actualOffset = 0;
    actualSize = undefined;
  } else if (typeof actualSize === 'function') {
    actualCallback = actualSize;
    actualSize = undefined;
  }
  if (typeof actualCallback !== 'function') {
    const error = new TypeError('The "callback" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!isArrayBuffer(buffer) && !isArrayBufferView(buffer)) {
    const error = new TypeError('The "buf" argument must be an instance of ArrayBuffer or ArrayBufferView');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  validateRandomFillRange(buffer, actualOffset ?? 0, actualSize);
  Promise.resolve().then(() => randomFillTarget(
    buffer,
    actualOffset ?? 0,
    actualSize,
    globalObject,
  )).then(
    (value) => actualCallback(null, value),
    (error) => actualCallback(error),
  );
}

const RANDOM_INT_MAX = 0xffffffffffff;

function formatRandomIntNumber(value) {
  return value === RANDOM_INT_MAX + 1 ? '281_474_976_710_656' : String(value);
}

function randomIntArguments(min, max, callback) {
  const minNotSpecified = max === undefined || typeof max === 'function';
  if (minNotSpecified) {
    callback = max;
    max = min;
    min = 0;
  }
  if (!Number.isSafeInteger(min)) {
    const error = new TypeError(`The "min" argument must be a safe integer. Received ${receivedType(min)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isSafeInteger(max)) {
    const error = new TypeError(`The "max" argument must be a safe integer. Received ${receivedType(max)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (max <= min) {
    const error = new RangeError(`The value of "max" is out of range. It must be greater than the value of "min" (${min}). Received ${max}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  const range = max - min;
  if (range > RANDOM_INT_MAX) {
    const error = new RangeError(`The value of "${minNotSpecified ? 'max' : 'max - min'}" is out of range. It must be <= ${RANDOM_INT_MAX}. Received ${formatRandomIntNumber(range)}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (callback !== undefined && typeof callback !== 'function') {
    const error = new TypeError('The "callback" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return { min, max, range, callback };
}

function randomIntValue(min, range, globalObject) {
  const limit = RANDOM_INT_MAX - (RANDOM_INT_MAX % range);
  do {
    const random = randomBytes(6, globalObject);
    let value = 0;
    for (const byte of random) value = value * 256 + byte;
    if (value < limit) return (value % range) + min;
  } while (true);
}

export function randomInt(min, max, callback, globalObject = globalThis) {
  const normalized = randomIntArguments(min, max, callback);
  if (normalized.callback === undefined) return randomIntValue(normalized.min, normalized.range, globalObject);
  Promise.resolve().then(() => randomIntValue(normalized.min, normalized.range, globalObject)).then(
    (value) => normalized.callback(undefined, value),
    (error) => normalized.callback(error),
  );
  return undefined;
}

function scryptOptionError(message, code = 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateScryptParameters(password, salt, keyLength, options, encoder = globalThis.TextEncoder) {
  let passwordBytes;
  let saltBytes;
  try {
    passwordBytes = toCryptoBytes(password, encoder);
  } catch {
    const error = new TypeError('The "password" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  try {
    saltBytes = toCryptoBytes(salt, encoder);
  } catch {
    const error = new TypeError('The "salt" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isSafeInteger(keyLength)) {
    if (typeof keyLength !== 'number') {
      const error = new TypeError(`The "keylen" argument must be of type number. Received ${receivedType(keyLength)}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    throw outOfRangeProperty('keylen', keyLength, 'It must be an integer.');
  }
  if (keyLength < 0 || keyLength > 0x7fffffff) {
    const error = new RangeError(`The value of "keylen" is out of range. It must be >= 0 && <= 2147483647. Received ${keyLength}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    const error = new TypeError('The "options" argument must be an object');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const hasN = options.N !== undefined;
  const hasCost = options.cost !== undefined;
  const hasR = options.r !== undefined;
  const hasBlockSize = options.blockSize !== undefined;
  const hasP = options.p !== undefined;
  const hasParallelization = options.parallelization !== undefined;
  if ((hasN && hasCost) || (hasR && hasBlockSize) || (hasP && hasParallelization)) {
    throw scryptOptionError('Invalid scrypt param');
  }
  const readUint32 = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      const error = new TypeError(`The "${name}" argument must be an unsigned 32-bit integer`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    return value;
  };
  let N = hasN ? readUint32(options.N, 'N') : hasCost ? readUint32(options.cost, 'cost') : 16384;
  let r = hasR ? readUint32(options.r, 'r') : hasBlockSize ? readUint32(options.blockSize, 'blockSize') : 8;
  let p = hasP ? readUint32(options.p, 'p') : hasParallelization ? readUint32(options.parallelization, 'parallelization') : 1;
  let maxmem = options.maxmem === undefined ? 32 << 20 : options.maxmem;
  if (!Number.isSafeInteger(maxmem) || maxmem < 0) {
    const error = new RangeError(`The value of "maxmem" is out of range. Received ${maxmem}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (N === 0) N = 16384;
  if (r === 0) r = 8;
  if (p === 0) p = 1;
  if (maxmem === 0) maxmem = 32 << 20;
  if (N < 2 || (N & (N - 1)) !== 0 || r === 0 || p === 0) throw scryptOptionError('Invalid scrypt param');
  const memory = 128 * (N + p) * r;
  if (!Number.isSafeInteger(memory) || memory > maxmem || N >= 2 ** (r * 16) || p > 0x3fffffff / r) {
    throw scryptOptionError('Invalid scrypt params: memory limit exceeded');
  }
  return { password: passwordBytes, salt: saltBytes, keyLength, N, r, p };
}

export function validateScryptArguments(password, salt, keyLength, options, globalObject = globalThis) {
  return validateScryptParameters(password, salt, keyLength, options, globalObject.TextEncoder);
}

function salsa208(input) {
  const x = new Uint32Array(input);
  const original = new Uint32Array(input);
  const rotate = (value, bits) => (value << bits) | (value >>> (32 - bits));
  for (let round = 0; round < 8; round += 2) {
    x[4] ^= rotate((x[0] + x[12]) >>> 0, 7);
    x[8] ^= rotate((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotate((x[8] + x[4]) >>> 0, 13);
    x[0] ^= rotate((x[12] + x[8]) >>> 0, 18);
    x[9] ^= rotate((x[5] + x[1]) >>> 0, 7);
    x[13] ^= rotate((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotate((x[13] + x[9]) >>> 0, 13);
    x[5] ^= rotate((x[1] + x[13]) >>> 0, 18);
    x[14] ^= rotate((x[10] + x[6]) >>> 0, 7);
    x[2] ^= rotate((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotate((x[2] + x[14]) >>> 0, 13);
    x[10] ^= rotate((x[6] + x[2]) >>> 0, 18);
    x[3] ^= rotate((x[15] + x[11]) >>> 0, 7);
    x[7] ^= rotate((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotate((x[7] + x[3]) >>> 0, 13);
    x[15] ^= rotate((x[11] + x[7]) >>> 0, 18);
    x[1] ^= rotate((x[0] + x[3]) >>> 0, 7);
    x[2] ^= rotate((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotate((x[2] + x[1]) >>> 0, 13);
    x[0] ^= rotate((x[3] + x[2]) >>> 0, 18);
    x[6] ^= rotate((x[5] + x[4]) >>> 0, 7);
    x[7] ^= rotate((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotate((x[7] + x[6]) >>> 0, 13);
    x[5] ^= rotate((x[4] + x[7]) >>> 0, 18);
    x[11] ^= rotate((x[10] + x[9]) >>> 0, 7);
    x[8] ^= rotate((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotate((x[8] + x[11]) >>> 0, 13);
    x[10] ^= rotate((x[9] + x[8]) >>> 0, 18);
    x[12] ^= rotate((x[15] + x[14]) >>> 0, 7);
    x[13] ^= rotate((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotate((x[13] + x[12]) >>> 0, 13);
    x[15] ^= rotate((x[14] + x[13]) >>> 0, 18);
  }
  for (let index = 0; index < 16; index += 1) x[index] = (x[index] + original[index]) >>> 0;
  return x;
}

function blockMix(input, r) {
  const output = new Uint32Array(input.length);
  const x = new Uint32Array(16);
  x.set(input.subarray(input.length - 16));
  for (let index = 0; index < 2 * r; index += 1) {
    const block = input.subarray(index * 16, index * 16 + 16);
    for (let word = 0; word < 16; word += 1) x[word] ^= block[word];
    const mixed = salsa208(x);
    x.set(mixed);
    output.set(mixed, (index % 2 === 0 ? index / 2 : r + (index - 1) / 2) * 16);
  }
  return output;
}

function scryptSyncForGlobal(password, salt, keyLength, options = {}, globalObject = globalThis) {
  const parameters = validateScryptParameters(password, salt, keyLength, options, globalObject.TextEncoder);
  if (parameters.keyLength === 0) return new Uint8Array();
  const { N, r, p } = parameters;
  const blockLength = 128 * r;
  const initial = pbkdf2Sha256(parameters.password, parameters.salt, 1, blockLength * p, globalObject.TextEncoder);
  const wordsPerBlock = blockLength / 4;
  const blocks = new Uint32Array(initial.buffer, initial.byteOffset, initial.byteLength / 4);
  const view = new DataView(initial.buffer, initial.byteOffset, initial.byteLength);
  for (let index = 0; index < blocks.length; index += 1) blocks[index] = view.getUint32(index * 4, true);
  for (let blockIndex = 0; blockIndex < p; blockIndex += 1) {
    const start = blockIndex * wordsPerBlock;
    let working = blocks.slice(start, start + wordsPerBlock);
    const memory = new Uint32Array(N * wordsPerBlock);
    for (let index = 0; index < N; index += 1) {
      memory.set(working, index * wordsPerBlock);
      working = blockMix(working, r);
    }
    for (let index = 0; index < N; index += 1) {
      const j = working[working.length - 16] % N;
      for (let word = 0; word < wordsPerBlock; word += 1) working[word] ^= memory[j * wordsPerBlock + word];
      working = blockMix(working, r);
    }
    blocks.set(working, start);
  }
  const mixed = new Uint8Array(blocks.buffer, blocks.byteOffset, blocks.byteLength);
  return pbkdf2Sha256(parameters.password, mixed, 1, parameters.keyLength, globalObject.TextEncoder);
}

export function scryptSync(password, salt, keyLength, options = {}, globalObject = globalThis) {
  return scryptSyncForGlobal(password, salt, keyLength, options, globalObject);
}

export function scrypt(password, salt, keyLength, options, callback, globalObject = globalThis) {
  if (typeof options === 'function') {
    globalObject = callback || globalObject;
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function') {
    const error = new TypeError('The "callback" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  validateScryptParameters(password, salt, keyLength, options ?? {}, globalObject.TextEncoder);
  const operation = Promise.resolve().then(() => scryptSyncForGlobal(password, salt, keyLength, options ?? {}, globalObject));
  operation.then((value) => callback(null, value), (error) => callback(error));
  return undefined;
}

function rsaCipherUnavailable(name) {
  throw new UnsupportedWebCapabilityError(
    `crypto.${name}`,
    'Web Crypto exposes RSA encryption only through asynchronous SubtleCrypto operations; the Node API is synchronous',
  );
}

export function privateDecrypt() {
  return rsaCipherUnavailable('privateDecrypt');
}

export function privateEncrypt() {
  return rsaCipherUnavailable('privateEncrypt');
}

export function publicDecrypt() {
  return rsaCipherUnavailable('publicDecrypt');
}

export function publicEncrypt() {
  return rsaCipherUnavailable('publicEncrypt');
}

function validatePrimeSize(size) {
  if (typeof size !== 'number') throw invalidArgumentType('size', 'of type number', size);
  if (!Number.isSafeInteger(size) || size < 1 || size > 0x7fffffff) {
    throw outOfRangeProperty('size', size, 'It must be >= 1 && <= 2147483647.');
  }
}

function validatePrimeGenerationOptions(options, size) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidArgumentType('options', 'of type object', options);
  }
  for (const name of ['safe']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') {
      throw invalidPropertyType(`options.${name}`, 'of type boolean', options[name]);
    }
  }
  if (options.bigint !== undefined && typeof options.bigint !== 'boolean') {
    throw invalidPropertyType('options.bigint', 'of type boolean', options.bigint);
  }
  for (const name of ['add', 'rem']) {
    if (options[name] === undefined) continue;
    if (typeof options[name] === 'bigint') {
      if (options[name] < 0n) {
        const error = new RangeError(`The value of "options.${name}" is out of range. It must be >= 0. Received ${options[name]}n`);
        error.code = 'ERR_OUT_OF_RANGE';
        throw error;
      }
    } else if (!isArrayBuffer(options[name]) && !isArrayBufferView(options[name])) {
      throw invalidPropertyType(`options.${name}`, 'an instance of ArrayBuffer, Buffer, TypedArray, or DataView', options[name]);
    }
  }
  if (options.add !== undefined) {
    const add = typeof options.add === 'bigint' ? options.add : bytesToBigInt(toCryptoBytes(options.add));
    if (size !== undefined && add >= (1n << BigInt(size))) {
      const error = new RangeError('invalid options.add');
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
    if (options.rem !== undefined) {
      const rem = typeof options.rem === 'bigint' ? options.rem : bytesToBigInt(toCryptoBytes(options.rem));
      if (rem >= add) {
        const error = new RangeError('invalid options.rem');
        error.code = 'ERR_OUT_OF_RANGE';
        throw error;
      }
    }
  }
  return options;
}

export function generatePrime(size, options, callback, globalObject = globalThis) {
  if (typeof options === 'function') callback = options;
  validatePrimeSize(size);
  const actualOptions = typeof options === 'function' ? {} : validatePrimeGenerationOptions(options, size);
  if (typeof callback !== 'function') {
    throw invalidArgumentType('callback', 'of type function', callback);
  }
  Promise.resolve().then(() => generatePrimeValue(size, actualOptions, globalObject)).then(
    (value) => callback(null, value),
    (error) => callback(error),
  );
  return undefined;
}

export function generatePrimeSync(size, options = {}, globalObject = globalThis) {
  validatePrimeSize(size);
  const actualOptions = validatePrimeGenerationOptions(options, size);
  if (actualOptions.add !== undefined) {
    const add = typeof actualOptions.add === 'bigint'
      ? actualOptions.add : bytesToBigInt(toCryptoBytes(actualOptions.add));
    if (add >= (1n << BigInt(size))) {
      const error = new RangeError('invalid options.add');
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
    if (actualOptions.rem !== undefined) {
      const rem = typeof actualOptions.rem === 'bigint'
        ? actualOptions.rem : bytesToBigInt(toCryptoBytes(actualOptions.rem));
      if (rem >= add) {
        const error = new RangeError('invalid options.rem');
        error.code = 'ERR_OUT_OF_RANGE';
        throw error;
      }
    }
  }
  return generatePrimeValue(size, actualOptions, globalObject);
}

function bytesToBigInt(value) {
  let result = 0n;
  for (const byte of value) result = (result << 8n) | BigInt(byte);
  return result;
}

function bigIntToBytes(value, size) {
  const result = new Uint8Array(size);
  let current = value;
  for (let index = size - 1; index >= 0; index -= 1) {
    result[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return result;
}

function bigIntBitLength(value) {
  let length = 0;
  for (let current = value; current > 0n; current >>= 1n) length += 1;
  return length;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let value = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

function isProbablePrime(value) {
  if (value < 2n) return false;
  for (const prime of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (value === prime) return true;
    if (value % prime === 0n) return false;
  }
  let odd = value - 1n;
  let powers = 0;
  while ((odd & 1n) === 0n) { odd >>= 1n; powers += 1; }
  const bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (const base of bases) {
    if (base >= value) continue;
    let witness = modPow(base, odd, value);
    if (witness === 1n || witness === value - 1n) continue;
    let passed = false;
    for (let round = 1; round < powers; round += 1) {
      witness = (witness * witness) % value;
      if (witness === value - 1n) { passed = true; break; }
    }
    if (!passed) return false;
  }
  return true;
}

function primeOptionBigInt(value, name) {
  if (value === undefined) return undefined;
  if (typeof value === 'bigint') return value;
  return bytesToBigInt(toCryptoBytes(value));
}

function primeBuffer(bytesValue) {
  const value = new Uint8Array(bytesValue);
  Object.defineProperty(value, 'toString', {
    configurable: true,
    value(encoding) {
      if (encoding === 'hex') return hex(value);
      return Uint8Array.prototype.toString.call(value);
    },
  });
  return value;
}

function generatePrimeValue(size, options, globalObject = globalThis) {
  if (size === 3 && options.add === undefined && options.rem === undefined && !options.safe) {
    return options.bigint ? 7n : primeBuffer(Uint8Array.of(7));
  }
  const byteLength = Math.ceil(size / 8);
  const excessBits = byteLength * 8 - size;
  const add = primeOptionBigInt(options.add, 'add');
  const rem = primeOptionBigInt(options.rem, 'rem');
  const safe = options.safe === true;
  // Safe primes are rarer than ordinary primes. Keep this randomized search
  // bounded, but large enough that browser-native entropy almost certainly
  // finds one before falling back to an exhaustive search.
  const attempts = safe ? 65536 : Math.max(128, size * 4);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidateBytes = new Uint8Array(byteLength);
    requireCrypto(globalObject).getRandomValues(candidateBytes);
    if (excessBits) candidateBytes[0] &= 0xff >>> excessBits;
    candidateBytes[0] |= 1 << (7 - excessBits);
    candidateBytes[byteLength - 1] |= 1;
    let candidate = bytesToBigInt(candidateBytes);
    if (add !== undefined) {
      const desired = rem === undefined ? (safe ? 3n : 1n) : rem;
      const remainder = candidate % add;
      candidate += (desired - remainder + add) % add;
      if ((candidate & 1n) === 0n) candidate += add;
    }
    if (candidate >= (1n << BigInt(size)) || !isProbablePrime(candidate)) continue;
    if (safe && !isProbablePrime((candidate - 1n) / 2n)) continue;
    const result = primeBuffer(bigIntToBytes(candidate, byteLength));
    return options.bigint ? candidate : result;
  }
  // Some browser contexts provide a deliberately deterministic Web Crypto
  // source. Keep generation live in that case by scanning the valid range.
  let candidate = (1n << BigInt(size - 1)) | 1n;
  const limit = 1n << BigInt(size);
  for (; candidate < limit; candidate += 2n) {
    if (add !== undefined) {
      const desired = rem === undefined ? (safe ? 3n : 1n) : rem;
      candidate += (desired - (candidate % add) + add) % add;
    }
    if (candidate < limit && isProbablePrime(candidate)
      && (!safe || isProbablePrime((candidate - 1n) / 2n))) {
      const result = primeBuffer(bigIntToBytes(candidate, byteLength));
      return options.bigint ? candidate : result;
    }
  }
  throw new Error('Unable to generate a prime in the browser runtime');
}

function bigintToBytes(value) {
  if (value < 0n) {
    const error = new RangeError(`The value of "candidate" is out of range. It must be >= 0. Received ${value}n`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  const encoded = value.toString(16).padStart(2, '0');
  const result = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function primeCandidate(candidate) {
  if (typeof candidate === 'bigint') return bigintToBytes(candidate);
  if (!isArrayBuffer(candidate) && !isArrayBufferView(candidate)) {
    const error = new TypeError(
      'The "candidate" argument must be an instance of ArrayBuffer, TypedArray, Buffer, DataView, or bigint',
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const result = toCryptoBytes(candidate);
  if (result.byteLength > 0x1000000) {
    const error = new Error('bignum too long');
    error.code = 'ERR_OSSL_BN_BIGNUM_TOO_LONG';
    throw error;
  }
  return result;
}

function validatePrimeOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    const error = new TypeError('The "options" argument must be an object');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const checks = options.checks ?? 0;
  if (typeof checks !== 'number') {
    const error = new TypeError(`The "options.checks" property must be of type number. Received ${receivedType(checks)}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isSafeInteger(checks) || checks < 0 || checks > 0x7fffffff) {
    const detail = Number.isInteger(checks)
      ? `It must be >= 0 && <= 2147483647. Received ${checks}`
      : `It must be an integer. Received ${checks}`;
    const error = new RangeError(`The value of "options.checks" is out of range. ${detail}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
}

function unsupportedPrimeCheck(name) {
  throw new UnsupportedWebCapabilityError(`crypto.${name}`, PRIME_BLOCKER);
}

export function checkPrime(candidate, options, callback) {
  const candidateBytes = primeCandidate(candidate);
  let actualOptions = options;
  let actualCallback = callback;
  if (typeof actualOptions === 'function') {
    actualCallback = actualOptions;
    actualOptions = {};
  }
  if (typeof actualCallback !== 'function') {
    const error = new TypeError('The "callback" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  validatePrimeOptions(actualOptions ?? {});
  Promise.resolve().then(() => isPrimeCandidate(candidateBytes)).then(
    (value) => actualCallback(null, value),
    (error) => actualCallback(error),
  );
  return undefined;
}

export function checkPrimeSync(candidate, options = {}) {
  const value = primeCandidate(candidate);
  validatePrimeOptions(options);
  return isPrimeCandidate(value);
}

function isPrimeCandidate(candidate) {
  return isProbablePrime(bytesToBigInt(candidate));
}

function legacyCipherUnavailable(name) {
  throw new UnsupportedWebCapabilityError(`crypto.${name}`, LEGACY_CIPHER_BLOCKER);
}

function unsupportedCipherOperation(name, operation) {
  const suffix = operation ? `.${operation}` : '';
  throw new UnsupportedWebCapabilityError(`crypto.${name}${suffix}`, LEGACY_CIPHER_BLOCKER);
}

function cipherArgumentTypeError(name, expected, value) {
  const received = value === undefined
    ? 'undefined'
    : value === null
      ? 'null'
      : typeof value === 'object'
        ? `an instance of ${value.constructor?.name || 'Object'}`
        : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  throw error;
}

function validateCipherivArguments(cipher, key, iv) {
  if (typeof cipher !== 'string') {
    cipherArgumentTypeError('cipher', 'of type string', cipher);
  }
  const keyIsKeyObject = key && typeof key === 'object'
    && key.type === 'secret' && Object.prototype.hasOwnProperty.call(key, 'key');
  if (typeof key !== 'string' && !isArrayBuffer(key) && !isArrayBufferView(key)
    && !keyIsKeyObject && !isCryptoKey(key)) {
    cipherArgumentTypeError(
      'key',
      'of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey',
      key,
    );
  }
  if (iv === null) {
    const error = new Error('Invalid initialization vector');
    error.code = 'ERR_CRYPTO_INVALID_IV';
    throw error;
  }
  if (typeof iv !== 'string' && !isArrayBuffer(iv) && !isArrayBufferView(iv)) {
    cipherArgumentTypeError('iv', 'of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView', iv);
  }
}

export class Cipher extends Transform {
  constructor(cipher, key, iv, options) {
    super(options ?? {});
    void cipher;
    void key;
    void iv;
    if (new.target === Cipher) unsupportedCipherOperation('Cipher');
  }

  _transform(chunk, encoding, callback) {
    void chunk;
    void encoding;
    void callback;
    unsupportedCipherOperation('Cipher', '_transform');
  }
  _flush(callback) {
    void callback;
    unsupportedCipherOperation('Cipher', '_flush');
  }
  update(data, inputEncoding, outputEncoding) {
    void data;
    void inputEncoding;
    void outputEncoding;
    unsupportedCipherOperation('Cipher', 'update');
  }

  final(outputEncoding) {
    void outputEncoding;
    unsupportedCipherOperation(this.constructor?.name || 'Cipher', 'final');
  }

  setAutoPadding(autoPadding = true) {
    void autoPadding;
    unsupportedCipherOperation(this.constructor?.name || 'Cipher', 'setAutoPadding');
  }

  getAuthTag() {
    unsupportedCipherOperation(this.constructor?.name || 'Cipher', 'getAuthTag');
  }

  setAAD(aad, options) {
    void aad;
    void options;
    unsupportedCipherOperation(this.constructor?.name || 'Cipher', 'setAAD');
  }
}

export class Cipheriv extends Cipher {
  constructor(cipher, key, iv, options, operationName = 'Cipheriv') {
    void cipher;
    void key;
    void iv;
    void options;
    validateCipherivArguments(cipher, key, iv);
    unsupportedCipherOperation(operationName);
  }

  _transform(chunk, encoding, callback) {
    void chunk;
    void encoding;
    void callback;
    unsupportedCipherOperation('Cipheriv', '_transform');
  }
  _flush(callback) {
    void callback;
    unsupportedCipherOperation('Cipheriv', '_flush');
  }
  update(data, inputEncoding, outputEncoding) {
    void data;
    void inputEncoding;
    void outputEncoding;
    unsupportedCipherOperation('Cipheriv', 'update');
  }

  final(outputEncoding) {
    void outputEncoding;
    unsupportedCipherOperation('Cipheriv', 'final');
  }

  setAutoPadding(autoPadding = true) {
    void autoPadding;
    unsupportedCipherOperation('Cipheriv', 'setAutoPadding');
  }

  getAuthTag() {
    unsupportedCipherOperation('Cipheriv', 'getAuthTag');
  }

  setAAD(aad, options) {
    void aad;
    void options;
    unsupportedCipherOperation('Cipheriv', 'setAAD');
  }
}

installLazyTransformStateAccessors(Cipheriv.prototype);

export class Decipher extends Cipher {
  constructor(cipher, password, options) {
    void cipher;
    void password;
    void options;
    unsupportedCipherOperation('Decipher');
  }

  _transform(chunk, encoding, callback) {
    void chunk;
    void encoding;
    void callback;
    unsupportedCipherOperation('Decipher', '_transform');
  }

  _flush(callback) {
    void callback;
    unsupportedCipherOperation('Decipher', '_flush');
  }

  update(data, inputEncoding, outputEncoding) {
    void data;
    void inputEncoding;
    void outputEncoding;
    unsupportedCipherOperation('Decipher', 'update');
  }

  final(outputEncoding) {
    void outputEncoding;
    unsupportedCipherOperation('Decipher', 'final');
  }

  setAutoPadding(autoPadding = true) {
    void autoPadding;
    unsupportedCipherOperation('Decipher', 'setAutoPadding');
  }

  setAuthTag(tag) {
    void tag;
    unsupportedCipherOperation('Decipher', 'setAuthTag');
  }

  setAAD(aad, options) {
    void aad;
    void options;
    unsupportedCipherOperation('Decipher', 'setAAD');
  }
}

export class Decipheriv extends Cipheriv {
  constructor(cipher, key, iv, options) {
    super(cipher, key, iv, options, 'Decipheriv');
  }

  update(data, inputEncoding, outputEncoding) {
    void data;
    void inputEncoding;
    void outputEncoding;
    unsupportedCipherOperation('Decipheriv', 'update');
  }

  _transform(chunk, encoding, callback) {
    void chunk;
    void encoding;
    void callback;
    unsupportedCipherOperation('Decipheriv', '_transform');
  }

  _flush(callback) {
    void callback;
    unsupportedCipherOperation('Decipheriv', '_flush');
  }

  final(outputEncoding) {
    void outputEncoding;
    unsupportedCipherOperation('Decipheriv', 'final');
  }

  setAutoPadding(autoPadding = true) {
    void autoPadding;
    unsupportedCipherOperation('Decipheriv', 'setAutoPadding');
  }

  setAuthTag(tag) {
    void tag;
    unsupportedCipherOperation('Decipheriv', 'setAuthTag');
  }

  setAAD(aad, options) {
    void aad;
    void options;
    unsupportedCipherOperation('Decipheriv', 'setAAD');
  }
}

installLazyTransformStateAccessors(Decipheriv.prototype);
installLazyTransformAllowHalfOpen(Decipheriv.prototype);

export function createCipheriv() {
  return legacyCipherUnavailable('createCipheriv');
}

export function createDecipheriv(cipher, key, iv, options) {
  return new Decipheriv(cipher, key, iv, options);
}

export function setEngine(id, flags) {
  if (typeof id !== 'string') {
    const error = new TypeError(`The "id" argument must be of type string. Received ${id}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (flags) {
    if (typeof flags !== 'number') {
      const error = new TypeError(`The "flags" argument must be of type number. Received ${flags}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (!Number.isFinite(flags)) {
      const error = new RangeError(`The value of "flags" is out of range. Received ${flags}`);
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
  }
  throw new UnsupportedWebCapabilityError(
    'crypto.setEngine',
    'OpenSSL engines are not available in the browser runtime',
  );
}

function validateGenerateKey(type, options) {
  if (typeof type !== 'string') {
    const error = new TypeError(`The "type" argument must be of type string. Received ${type}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    const error = new TypeError('The "options" argument must be an object');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const length = options.length;
  if (type === 'hmac') {
    if (typeof length !== 'number' || Number.isNaN(length)) {
      const error = new TypeError(`The "options.length" property must be of type number. Received ${length}`);
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    if (!Number.isSafeInteger(length) || length < 8 || length > 0x7fffffff) {
      const error = new RangeError(`The value of "options.length" is out of range. It must be >= 8 && <= 2147483647. Received ${length}`);
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
  } else if (type === 'aes') {
    if (![128, 192, 256].includes(length)) {
      const received = typeof length === 'string' ? `'${length}'` : length;
      const error = new TypeError(`The property 'options.length' must be one of: 128, 192, 256. Received ${received}`);
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }
  } else {
    const error = new TypeError(`The argument 'type' must be a supported key type. Received '${type}'`);
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
}

function generateSecretKeySync(type, options) {
  validateGenerateKey(type, options);
  const length = options.length;
  const size = Math.floor(length / 8);
  const result = new Uint8Array(size);
  globalThis.crypto.getRandomValues(result);
  return {
    type: 'secret',
    key: result,
    export() { return this.key.slice(); },
  };
}

export function generateKeySync(type, options) {
  return generateSecretKeySync(type, options);
}

export function generateKey(type, options, callback) {
  let actualOptions = options;
  let actualCallback = callback;
  if (typeof actualOptions === 'function') {
    actualCallback = actualOptions;
    actualOptions = undefined;
  }
  if (typeof actualCallback !== 'function') {
    const error = new TypeError('The "callback" argument must be of type function');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  validateGenerateKey(type, actualOptions);
  Promise.resolve().then(() => {
    const length = actualOptions.length;
    const result = new Uint8Array(Math.floor(length / 8));
    globalThis.crypto.getRandomValues(result);
    return {
      type: 'secret',
      key: result,
      export() { return this.key.slice(); },
    };
  }).then(
    (value) => actualCallback(null, value),
    (error) => actualCallback(error),
  );
  return undefined;
}

export const fips = 0;

export function setFips(_value) {
  throw new UnsupportedWebCapabilityError(
    'crypto.fips',
    'FIPS mode is not available in the browser runtime',
  );
}

function timingSafeEqualInput(value, name) {
  if (!isArrayBuffer(value) && !isArrayBufferView(value)) {
    const error = new TypeError(
      `The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`,
    );
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return isArrayBuffer(value)
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function timingSafeEqual(buf1, buf2) {
  const left = timingSafeEqualInput(buf1, 'buf1');
  const right = timingSafeEqualInput(buf2, 'buf2');
  if (left.byteLength !== right.byteLength) {
    const error = new RangeError('Input buffers must have the same byte length');
    error.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
    throw error;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function getCipherInfo(nameOrNid, options) {
  if (typeof nameOrNid !== 'string' && typeof nameOrNid !== 'number') {
    const error = new TypeError('The "nameOrNid" argument must be of type string or number');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (typeof nameOrNid === 'number' && (!Number.isSafeInteger(nameOrNid)
    || nameOrNid < -0x80000000 || nameOrNid > 0x7fffffff)) {
    const error = new RangeError(`The value of "nameOrNid" is out of range. Received ${nameOrNid}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
    const error = new TypeError('The "options" argument must be an object');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  throw new UnsupportedWebCapabilityError(
    'crypto.getCipherInfo',
    'Web Crypto does not expose the OpenSSL cipher registry',
  );
}

export function secureHeapUsed() {
  return { total: 0, used: 0, utilization: 0, min: 0 };
}

function validateRandomUUIDOptions(options) {
  if (options === undefined) return;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    const error = new TypeError('The "options" argument must be of type object');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (options.disableEntropyCache !== undefined && typeof options.disableEntropyCache !== 'boolean') {
    const error = new TypeError('The "options.disableEntropyCache" property must be of type boolean');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
}

export function randomUUID(globalObject = globalThis, options) {
  validateRandomUUIDOptions(options);
  const crypto = requireCrypto(globalObject);
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = randomBytes(16, globalObject);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export async function digest(algorithm, value, globalObject = globalThis) {
  const crypto = requireCrypto(globalObject);
  let input;
  try {
    input = toCryptoBytes(value, globalObject.TextEncoder);
  } catch {
    throw invalidCryptoInput('data', value);
  }
  try {
    const result = await crypto.subtle.digest(algorithm, input);
    return new Uint8Array(result);
  } catch (error) {
    if (error?.name === 'NotSupportedError') {
      const DOMExceptionClass = globalObject.DOMException || globalThis.DOMException;
      if (typeof DOMExceptionClass === 'function') {
        throw new DOMExceptionClass('Unrecognized algorithm name', 'NotSupportedError');
      }
      const translated = new Error('Unrecognized algorithm name');
      translated.name = 'NotSupportedError';
      throw translated;
    }
    throw error;
  }
}

export async function hmac(value, key, { hash = 'SHA-256', globalObject = globalThis } = {}) {
  const crypto = requireCrypto(globalObject);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toCryptoBytes(key, globalObject.TextEncoder),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    toCryptoBytes(value, globalObject.TextEncoder),
  );
  return new Uint8Array(signature);
}

export function createCryptoContract(globalObject = globalThis) {
  const crypto = requireCrypto(globalObject);
  const contract = {
    randomBytes: (length) => randomBytes(length, globalObject),
    getRandomValues: (array) => getRandomValues(array, globalObject),
    randomUUID: (options) => randomUUID(globalObject, options),
    digest: (algorithm, value) => digest(algorithm, value, globalObject),
    hmac: (value, key, options = {}) => hmac(value, key, { ...options, globalObject }),
    pbkdf2: (password, salt, iterations, keyLength, digestAlgorithm = 'sha256', callback) => (
      pbkdf2WithGlobal(password, salt, iterations, keyLength, digestAlgorithm, callback, globalObject)
    ),
    pbkdf2Sync: (password, salt, iterations, keyLength, digestAlgorithm = 'sha256') => (
      pbkdf2SyncForGlobal(password, salt, iterations, keyLength, digestAlgorithm, globalObject)
    ),
    hkdf: (hash, key, salt, info, keyLength, callback) => (
      hkdf(hash, key, salt, info, keyLength, callback, globalObject)
    ),
    hkdfSync: (hash, key, salt, info, keyLength) => (
      hkdfSync(hash, key, salt, info, keyLength, globalObject)
    ),
    randomInt: (min, max, callback) => randomInt(min, max, callback, globalObject),
    checkPrime: (candidate, options, callback) => checkPrime(candidate, options, callback),
    checkPrimeSync: (candidate, options = {}) => checkPrimeSync(candidate, options),
    scrypt: (password, salt, keyLength, options, callback) => (
      scrypt(password, salt, keyLength, options, callback, globalObject)
    ),
    scryptSync: (password, salt, keyLength, options = {}) => (
      scryptSync(password, salt, keyLength, options, globalObject)
    ),
    generatePrime: (size, options, callback) => generatePrime(size, options, callback, globalObject),
    generatePrimeSync: (size, options = {}) => generatePrimeSync(size, options, globalObject),
    generateKey: (type, options, callback) => generateKey(type, options, callback),
    setFips,
    timingSafeEqual,
    createCipheriv,
    createDecipheriv,
    Cipher,
    Cipheriv,
    Decipher,
    Decipheriv,
    constants: cryptoConstants,
    setEngine,
    getCipherInfo: (nameOrNid, options) => getCipherInfo(nameOrNid, options, globalObject),
    secureHeapUsed: () => secureHeapUsed(globalObject),
    privateDecrypt,
    privateEncrypt,
    publicDecrypt,
    publicEncrypt,
    aesGcmEncrypt: (value, key, iv, options = {}) => (
      aesGcmOperation('encrypt', value, key, iv, options, globalObject)
    ),
    aesGcmDecrypt: (value, key, iv, options = {}) => (
      aesGcmOperation('decrypt', value, key, iv, options, globalObject)
    ),
    sign: (algorithm, value, key, options = {}) => sign(algorithm, value, key, { ...options, globalObject }),
    verify: (algorithm, value, key, signature, options = {}) => (
      verify(algorithm, value, key, signature, { ...options, globalObject })
    ),
    generateKeyPair: (type, options, callback) => generateKeyPair(type, options, callback, globalObject),
    generateKeyPairSync: (type, options = {}) => generateKeyPairSync(type, options, globalObject),
    createECDH: (curve) => createECDH(curve, globalObject),
    ECDH: class ECDH extends BrowserECDH {
      constructor(curve) { super(curve, globalObject); }
    },
    diffieHellman: (options) => diffieHellman(options, globalObject),
    createDiffieHellman,
    DiffieHellman: createDiffieHellman,
    createDiffieHellmanGroup,
    DiffieHellmanGroup: createDiffieHellmanGroup,
    getDiffieHellman: createDiffieHellmanGroup,
    Certificate: createCertificateShim(globalObject, 'Certificate'),
    X509Certificate: createCertificateShim(globalObject, 'X509Certificate'),
    hex,
    subtle: crypto.subtle,
    webcrypto: crypto,
    getCurves: () => [],
    copyBytes: (value) => new Uint8Array(toCryptoBytes(value, globalObject.TextEncoder)),
  };
  Object.defineProperty(contract, 'fips', {
    configurable: false,
    enumerable: true,
    get: () => 0,
    set: setFips,
  });
  return Object.freeze(contract);
}
