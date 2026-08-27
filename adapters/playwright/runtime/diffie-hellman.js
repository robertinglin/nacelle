import { hex } from './binary.js';

const MODP_GROUPS = Object.freeze({
  modp1: 'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a3620ffffffffffffffff',
  modp2: 'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff',
  modp5: 'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca237327ffffffffffffffff',
  modp14: 'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aacaa68ffffffffffffffff',
});

function isByteView(value) {
  return value instanceof Uint8Array || (typeof ArrayBuffer?.isView === 'function' && ArrayBuffer.isView(value));
}

function toBytes(value, encoding) {
  if (isByteView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value !== 'string') {
    const error = new TypeError('The "key" argument must be a string or an instance of Buffer, TypedArray, or DataView');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const normalized = encoding ? String(encoding).toLowerCase() : '';
  if (normalized === 'hex') {
    if (value.length % 2 || /[^0-9a-f]/i.test(value)) throw new TypeError('Invalid hexadecimal string');
    const result = new Uint8Array(value.length / 2);
    for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    return result;
  }
  if (normalized === 'base64' || normalized === 'base64url') {
    const source = normalized === 'base64url' ? value.replaceAll('-', '+').replaceAll('_', '/') : value;
    const binary = atob(source.padEnd(Math.ceil(source.length / 4) * 4, '='));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (normalized === 'latin1' || normalized === 'binary') return Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff);
  return new TextEncoder().encode(value);
}

function bytesToBigInt(value) {
  let result = 0n;
  for (const byte of value) result = (result << 8n) | BigInt(byte);
  return result;
}

function bigIntToBytes(value, length = 0) {
  if (value < 0n) throw new RangeError('negative integer cannot be encoded');
  const minimum = value === 0n ? 1 : Math.ceil(value.toString(16).length / 2);
  const result = new Uint8Array(Math.max(length, minimum));
  let current = value;
  for (let index = result.length - 1; index >= 0; index -= 1) {
    result[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return result;
}

function modularPower(base, exponent, modulus) {
  let result = 1n;
  let factor = base % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    remaining >>= 1n;
  }
  return result;
}

function randomInteger(maximum, globalObject = globalThis) {
  const size = Math.ceil(maximum.toString(16).length / 2);
  const bytes = new Uint8Array(size);
  globalObject.crypto.getRandomValues(bytes);
  return (bytesToBigInt(bytes) % (maximum - 2n)) + 2n;
}

function invalidArgument(name, value, expected) {
  const received = value === undefined ? 'undefined' : value === null ? 'null' : `an instance of ${value.constructor?.name || 'Object'}`;
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function badGenerator() {
  const error = new Error('bad generator');
  error.code = 'ERR_OSSL_DH_BAD_GENERATOR';
  return error;
}

function normalizeGenerator(value, encoding) {
  if (value === undefined || value === 0) return 2n;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      const error = new RangeError(`The value of "generator" is out of range. It must be an integer. Received ${value}`);
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
    if (value < 2) throw badGenerator();
    return BigInt(value);
  }
  if (typeof value !== 'string' && !isByteView(value) && !(value instanceof ArrayBuffer)) throw invalidArgument('generator', value, 'number, string, or an instance of ArrayBufferView');
  const generator = bytesToBigInt(toBytes(value, encoding));
  if (generator < 2n) throw badGenerator();
  return generator;
}

function normalizePrime(value, encoding, globalObject) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      const error = new RangeError(`The value of "sizeOrKey" is out of range. It must be an integer. Received ${value}`);
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
    if (value < 2) {
      const error = new Error('modulus too small');
      error.code = 'ERR_OSSL_DH_MODULUS_TOO_SMALL';
      throw error;
    }
    const group = value <= 768 ? MODP_GROUPS.modp1 : value <= 1024 ? MODP_GROUPS.modp2 : MODP_GROUPS.modp14;
    return { bytes: toBytes(group, 'hex'), size: true };
  }
  const bytes = toBytes(value, encoding);
  return { bytes, size: false };
}

function outputBytes(bytes, encoding, globalObject) {
  const BufferClass = globalObject?.Buffer;
  const value = typeof BufferClass?.from === 'function' ? BufferClass.from(bytes) : new Uint8Array(bytes);
  if (encoding === undefined || encoding === 'buffer') return value;
  if (typeof value.toString === 'function') return value.toString(encoding);
  if (encoding === 'hex') return hex(bytes);
  return value;
}

function invalidState() {
  const error = new Error('Invalid state');
  error.code = 'ERR_CRYPTO_INVALID_STATE';
  return error;
}

export class BrowserDiffieHellman {
  constructor(prime, generator, globalObject = globalThis, BufferClass = globalObject?.Buffer) {
    this._prime = bytesToBigInt(prime);
    this._primeBytes = new Uint8Array(prime);
    this._generator = generator;
    this._globalObject = globalObject;
    this._BufferClass = BufferClass;
    this._private = null;
    this._public = null;
    this._publicStale = false;
    this.verifyError = this._prime > 3n ? 0 : 1;
  }

  getPrime(encoding) { return outputBytes(this._primeBytes, encoding, this._globalObject); }

  getGenerator(encoding) { return outputBytes(bigIntToBytes(this._generator), encoding, this._globalObject); }

  setPrivateKey(value, encoding) {
    this._private = bytesToBigInt(toBytes(value, encoding));
    if (this._public !== null) this._publicStale = true;
    return this;
  }

  setPublicKey(value, encoding) {
    this._public = bytesToBigInt(toBytes(value, encoding));
    this._publicStale = false;
    return this;
  }

  generateKeys(encoding) {
    if (this._private === null) this._private = randomInteger(this._prime, this._globalObject);
    if (this._public === null || this._publicStale) {
      this._public = modularPower(this._generator, this._private, this._prime);
      this._publicStale = false;
    }
    return outputBytes(bigIntToBytes(this._public, this._primeBytes.length), encoding, this._globalObject);
  }

  getPublicKey(encoding) {
    if (this._public === null) throw invalidState();
    return outputBytes(bigIntToBytes(this._public, this._primeBytes.length), encoding, this._globalObject);
  }

  getPrivateKey(encoding) {
    if (this._private === null) throw invalidState();
    return outputBytes(bigIntToBytes(this._private), encoding, this._globalObject);
  }

  computeSecret(value, inputEncoding, outputEncoding) {
    if (this._private === null) throw invalidState();
    const peer = bytesToBigInt(toBytes(value, inputEncoding));
    if (peer <= 1n || peer >= this._prime) {
      const error = new Error('Supplied key is too small');
      error.code = 'ERR_OSSL_DH_KEY_TOO_SMALL';
      throw error;
    }
    const secret = bigIntToBytes(modularPower(peer, this._private, this._prime), this._primeBytes.length);
    return outputBytes(secret, outputEncoding, this._globalObject);
  }
}

export class BrowserDiffieHellmanGroup extends BrowserDiffieHellman {
  setPrivateKey() { return undefined; }
  setPublicKey() { return undefined; }
}

function createDiffieHellmanInstance(
  primeValue,
  generatorValue,
  primeEncoding,
  globalObject = globalThis,
  GroupClass = BrowserDiffieHellman,
  generatorEncoding,
) {
  const { bytes: prime } = normalizePrime(primeValue, primeEncoding, globalObject);
  const generator = normalizeGenerator(generatorValue, generatorEncoding);
  return new GroupClass(prime, generator, globalObject, globalObject?.Buffer);
}

export function createDiffieHellman(primeOrSize, generatorOrEncoding, maybeGenerator) {
  const globalObject = globalThis;
  const isPrimeEncoding = typeof generatorOrEncoding === 'string'
    && ['buffer', 'hex', 'base64', 'base64url', 'latin1', 'binary', 'utf8', 'utf-8'].includes(generatorOrEncoding.toLowerCase());
  const primeEncoding = isPrimeEncoding ? generatorOrEncoding : undefined;
  const generator = isPrimeEncoding ? maybeGenerator : generatorOrEncoding;
  const generatorEncoding = !isPrimeEncoding && typeof maybeGenerator === 'string' ? maybeGenerator : undefined;
  return createDiffieHellmanInstance(
    primeOrSize,
    generator,
    primeEncoding,
    globalObject,
    BrowserDiffieHellman,
    generatorEncoding,
  );
}

export function createDiffieHellmanGroup(name) {
  const normalized = String(name).toLowerCase();
  const prime = MODP_GROUPS[normalized];
  if (!prime) {
    const error = new Error('Unknown DH group');
    error.code = 'ERR_CRYPTO_UNKNOWN_DH_GROUP';
    throw error;
  }
  return createDiffieHellmanInstance(prime, 2, 'hex', globalThis, BrowserDiffieHellmanGroup);
}

createDiffieHellman.prototype = BrowserDiffieHellman.prototype;
createDiffieHellmanGroup.prototype = BrowserDiffieHellmanGroup.prototype;
BrowserDiffieHellmanGroup.prototype.setPrivateKey = undefined;
BrowserDiffieHellmanGroup.prototype.setPublicKey = undefined;
Object.defineProperty(BrowserDiffieHellman.prototype, 'constructor', { value: createDiffieHellman });
Object.defineProperty(BrowserDiffieHellmanGroup.prototype, 'constructor', { value: createDiffieHellmanGroup });
