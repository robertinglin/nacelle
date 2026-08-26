import { assertByteLength, hex } from './binary.js';
import { UnsupportedWebCapabilityError } from './errors.js';

const objectToString = Object.prototype.toString;

function isArrayBuffer(value) {
  return value !== null && typeof value === 'object'
    && objectToString.call(value) === '[object ArrayBuffer]';
}

function isArrayBufferView(value) {
  return value !== null && typeof value === 'object'
    && typeof ArrayBuffer?.isView === 'function' && ArrayBuffer.isView(value);
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

function sha256(value) {
  const input = bytes(value);
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
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

function xorBytes(value, byte) {
  return new Uint8Array(value, value.byteOffset, value.byteLength).map((item) => item ^ byte);
}

export function createHashShim(BufferClass) {
  return () => {
    const chunks = [];
    return {
      update(value) { chunks.push(bytes(value)); return this; },
      digest(encoding) {
        const input = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
        const result = new BufferClass(sha256(input));
        return encoding ? result.toString(encoding) : result;
      },
    };
  };
}

export function createHmacShim(BufferClass) {
  return (_algorithm, key) => {
    let secret = bytes(key);
    if (secret.length > 64) secret = sha256(secret);
    const padded = new Uint8Array(64);
    padded.set(secret);
    const inner = xorBytes(padded, 0x36);
    const outer = xorBytes(padded, 0x5c);
    const chunks = [];
    return {
      update(value) { chunks.push(bytes(value)); return this; },
      digest(encoding) {
        const input = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, inner.length));
        input.set(inner);
        let offset = inner.length;
        for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
        const result = new BufferClass(sha256(new Uint8Array([...outer, ...sha256(input)])));
        return encoding ? result.toString(encoding) : result;
      },
    };
  };
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
  const keyName = isCryptoKey(key) ? key.algorithm.name : 'HMAC';
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
  if (!isCryptoKey(key)) {
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

export function randomBytes(length, globalObject = globalThis) {
  assertByteLength(length, 'length');
  const bytes = new Uint8Array(length);
  requireCrypto(globalObject).getRandomValues(bytes);
  return bytes;
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
    hex,
    subtle: crypto.subtle,
    webcrypto: crypto,
    copyBytes: (value) => new Uint8Array(toCryptoBytes(value, globalObject.TextEncoder)),
  });
}
