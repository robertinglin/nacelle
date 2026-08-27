import { assertByteLength, hex } from './binary.js';
import { UnsupportedWebCapabilityError } from './errors.js';
import { createDiffieHellman, createDiffieHellmanGroup } from './diffie-hellman.js';

const objectToString = Object.prototype.toString;
const virtualKeyPairs = new Map();

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
  throw new TypeError('crypto input must be a string or byte array');
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
  function Hash(algorithm) {
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
    const chunks = [];
    let finalized = false;
    let streamResult;
    const finalizedError = () => {
      const error = new Error('Digest already called');
      error.code = 'ERR_CRYPTO_HASH_FINALIZED';
      return error;
    };
    const hashValue = () => {
      const input = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
      return BufferClass.from(hashSync(algorithm, input));
    };
    const hash = {
      update(value, encoding) {
        if (finalized) throw finalizedError();
        if (value === undefined) {
          const error = new TypeError('The "data" argument must be of type string or an instance of Buffer');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
        const input = typeof value === 'string' && encoding !== undefined
          ? BufferClass.from(value, encoding)
          : value;
        chunks.push(bytes(input));
        return this;
      },
      write(value, encoding) {
        this.update(value, encoding);
        return true;
      },
      end(value, encoding, callback) {
        if (value !== undefined && value !== null) this.update(value, encoding);
        if (!finalized) {
          streamResult = this.digest();
        }
        if (typeof callback === 'function') callback();
        return this;
      },
      read() {
        if (!finalized) this.end();
        return streamResult;
      },
      digest(encoding) {
        if (finalized) throw finalizedError();
        finalized = true;
        const result = hashValue();
        streamResult = result;
        if (!encoding || encoding === 'buffer') return result;
        const encodingName = typeof encoding === 'string' ? encoding : encoding.toString();
        return result.toString(encodingName);
      },
    };
    // Node exposes Hash as both a factory and a callable constructor.
    Object.setPrototypeOf(hash, Hash.prototype);
    return hash;
  }
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

export function createSecretKeyShim(BufferClass) {
  return (value) => ({
    type: 'secret',
    key: BufferClass.from(value),
  });
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
    this._algorithm = hmacAlgorithm(algorithm);
    const secret = key?.type === 'secret' ? key.key : key;
    try {
      this._key = bytes(secret);
    } catch (error) {
      error.code ||= 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    this._chunks = [];
    this._finalized = false;
    this._output = null;
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

  Hmac.prototype.read = function read() {
    const result = this._output;
    this._output = null;
    return result;
  };

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

function virtualSignature(record, value, globalObject) {
  const data = toCryptoBytes(value, globalObject.TextEncoder);
  return sha256(`${record.id}:${base64(data)}`);
}

export function signSync(algorithm, value, key, options = {}, globalObject = globalThis) {
  const record = virtualKeyPairs.get(key?.key ?? key);
  if (!record) return undefined;
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
  'P-256': { name: 'P-256', bits: 256 },
  'P-384': { name: 'P-384', bits: 384 },
  'P-521': { name: 'P-521', bits: 528 },
});

function curveInfo(curve) {
  const value = String(curve);
  const result = ECDH_CURVES[value] || ECDH_CURVES[value.toLowerCase()]
    || ECDH_CURVES[value.toUpperCase()];
  if (!result) throw new UnsupportedWebCapabilityError('ECDH', `curve ${curve} is not supported by Web Crypto`);
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

function publicExponentBytes(value = 0x10001) {
  if (isArrayBufferView(value) || isArrayBuffer(value)) return new Uint8Array(toCryptoBytes(value));
  if (!Number.isSafeInteger(value) || value < 3 || value % 2 === 0) {
    throw new RangeError('RSA publicExponent must be an odd integer greater than 1');
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

function keyPairAlgorithm(type, options = {}) {
  const normalized = String(type).toLowerCase().replaceAll('-', '');
  const hash = normalizeHash(options.hashAlgorithm || options.hash || 'SHA-256');
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
  throw new UnsupportedWebCapabilityError(`crypto key generation ${type}`, 'this browser adapter supports RSA, ECDSA, Ed25519, and X25519 only');
}

async function generateKeyPairForGlobal(type, options = {}, globalObject = globalThis) {
  const subtle = requireSubtle(globalObject, 'crypto key generation');
  if (typeof subtle.generateKey !== 'function') {
    throw new UnsupportedWebCapabilityError('crypto key generation', 'SubtleCrypto.generateKey is not available in this context');
  }
  const { algorithm, usages } = keyPairAlgorithm(type, options);
  const pair = await subtle.generateKey(algorithm, options.extractable !== false, usages);
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
  if (typeof options === 'function') {
    globalObject = callback || globalObject;
    callback = options;
    options = {};
  }
  const operation = generateKeyPairForGlobal(type, options || {}, globalObject);
  if (callback === undefined) return operation;
  if (typeof callback !== 'function') throw new TypeError('generateKeyPair callback must be a function');
  operation.then(
    ({ publicKey, privateKey }) => callback(null, publicKey, privateKey),
    (error) => callback(error),
  );
  return undefined;
}

export function generateKeyPairSync(type, options = {}) {
  keyPairAlgorithm(type, options);
  throw new UnsupportedWebCapabilityError('crypto key generation sync', 'Web Crypto key generation is asynchronous');
}

export class BrowserECDH {
  constructor(curve, globalObject = globalThis) {
    this.globalObject = globalObject;
    this.curve = curveInfo(curve);
    this.privateKey = null;
    this.publicKey = null;
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
    return this.getPublicKey(encoding);
  }

  async getPublicKey(encoding) {
    if (!this.publicKey) throw new TypeError('ECDH keys have not been generated');
    const subtle = requireSubtle(this.globalObject, 'ECDH');
    return encodeKeyBytes(await subtle.exportKey('raw', this.publicKey), encoding);
  }

  async getPrivateKey(encoding) {
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

export function createCertificateShim(globalObject = globalThis, name = 'X509Certificate') {
  const NativeCertificate = globalObject?.[name];
  if (typeof NativeCertificate === 'function') return NativeCertificate;
  return class UnsupportedCertificate {
    constructor() {
      throw new UnsupportedWebCapabilityError(name, 'X.509 parsing is not exposed by Web Crypto');
    }
  };
}

export function randomBytes(length, globalObject = globalThis) {
  assertByteLength(length, 'length');
  const bytes = new Uint8Array(length);
  const crypto = requireCrypto(globalObject);
  // Web Crypto limits each getRandomValues call to 65,536 bytes.
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)));
  }
  return bytes;
}

function randomFillTarget(buffer, offset = 0, size, globalObject = globalThis) {
  if (!isArrayBuffer(buffer) && !isArrayBufferView(buffer)) {
    const error = new TypeError('The "buf" argument must be an instance of ArrayBuffer or ArrayBufferView');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > buffer.byteLength) {
    const error = new RangeError(`The value of "offset" is out of range. Received ${offset}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  const fillSize = size === undefined ? buffer.byteLength - offset : size;
  if (!Number.isInteger(fillSize) || fillSize < 0 || offset + fillSize > buffer.byteLength) {
    const error = new RangeError(`The value of "size" is out of range. Received ${fillSize}`);
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  const target = isArrayBuffer(buffer)
    ? new Uint8Array(buffer, offset, fillSize)
    : new Uint8Array(buffer.buffer, buffer.byteOffset + offset, fillSize);
  const crypto = requireCrypto(globalObject);
  for (let start = 0; start < target.length; start += 65536) {
    crypto.getRandomValues(target.subarray(start, Math.min(start + 65536, target.length)));
  }
  return buffer;
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
  const result = await crypto.subtle.digest(algorithm, toCryptoBytes(value, globalObject.TextEncoder));
  return new Uint8Array(result);
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
  return Object.freeze({
    randomBytes: (length) => randomBytes(length, globalObject),
    randomUUID: (options) => randomUUID(globalObject, options),
    digest: (algorithm, value) => digest(algorithm, value, globalObject),
    hmac: (value, key, options = {}) => hmac(value, key, { ...options, globalObject }),
    pbkdf2: (password, salt, iterations, keyLength, digestAlgorithm = 'sha256', callback) => (
      pbkdf2WithGlobal(password, salt, iterations, keyLength, digestAlgorithm, callback, globalObject)
    ),
    pbkdf2Sync: (password, salt, iterations, keyLength, digestAlgorithm = 'sha256') => (
      pbkdf2SyncForGlobal(password, salt, iterations, keyLength, digestAlgorithm, globalObject)
    ),
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
    generateKeyPairSync: (type, options = {}) => generateKeyPairSync(type, options),
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
  });
}
