import { EventEmitter } from './events.js';
import { Duplex, duplexPair } from './streams.js';
import { createBrowserNet } from './net.js';
import { AsyncResource } from './async-hooks.js';
import { createProxyCapability } from './proxy.js';
import { createHmacShim, hashSync } from './crypto.js';
import { UnsupportedWebCapabilityError } from './errors.js';

const DEFAULT_CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256';
const DEFAULT_ROOT_CERTIFICATES = Object.freeze([
  '-----BEGIN CERTIFICATE-----\nBROWSER-VIRTUAL-CA\n-----END CERTIFICATE-----',
]);
const CIPHERS = Object.freeze([
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
]);

const constants = Object.freeze({
  CLIENT_RENEG_LIMIT: 3,
  CLIENT_RENEG_WINDOW: 600,
  DEFAULT_ECDH_CURVE: 'auto',
  DEFAULT_MAX_VERSION: 'TLSv1.3',
  DEFAULT_MIN_VERSION: 'TLSv1.2',
  OPENSSL_VERSION_NUMBER: 0,
  SSL_OP_ALL: 0,
  TLS1_VERSION: 0x301,
  TLS1_1_VERSION: 0x302,
  TLS1_2_VERSION: 0x303,
  TLS1_3_VERSION: 0x304,
});

const tlsError = (code, message, details = {}) => {
  const error = code === 'ERR_INVALID_ARG_TYPE'
    ? new TypeError(message)
    : code === 'ERR_TLS_INVALID_CONTEXT' || code === 'ERR_TLS_INVALID_PROTOCOL_VERSION'
      ? new TypeError(message)
    : code === 'ERR_OUT_OF_RANGE' ? new RangeError(message) : new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
};

function localIssuerError() {
  return tlsError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate');
}

function verifyLeafError() {
  return tlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate');
}

function schedule(callback) {
  queueMicrotask(callback);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (!isRecord(value)) return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isRecord(item) ? clone(item) : item;
  }
  return result;
}

function hostFromCertificate(certificate) {
  const subject = certificate?.subject;
  if (typeof subject === 'string') return subject;
  return subject?.CN || subject?.commonName || '';
}

function certificateNames(certificate) {
  const names = [];
  const altNames = certificate?.subjectaltname || certificate?.subjectAltName;
  if (typeof altNames === 'string') {
    for (const value of altNames.split(/,\s*/)) {
      const match = value.match(/^(?:DNS|IP Address):(.+)$/i);
      if (match) names.push(match[1].trim());
    }
  }
  if (!names.length) {
    const commonName = hostFromCertificate(certificate);
    if (commonName) names.push(commonName);
  }
  return names;
}

function isIpAddress(value) {
  const text = String(value);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    return text.split('.').every((part) => Number(part) <= 255);
  }
  return /^[0-9a-f:]+$/i.test(text) && text.includes(':');
}

function matchesCertificateName(hostname, name) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  const candidate = String(name).toLowerCase().replace(/\.$/, '');
  if (isIpAddress(host) || isIpAddress(candidate)) return host === candidate;
  if (!candidate || /[^\x21-\x7f]/.test(host) || /[^\x21-\x7f]/.test(candidate)
    || candidate.includes('..')) return false;
  if (!candidate.includes('*')) return host === candidate;
  const candidateParts = candidate.split('.');
  const hostParts = host.split('.');
  if (candidateParts.length <= 2 || candidateParts.length !== hostParts.length) return false;
  const pattern = candidateParts[0];
  if ((pattern.match(/\*/g) || []).length !== 1) return false;
  if (pattern.includes('xn--')) return false;
  if (!candidateParts.slice(1).every((part, index) => part === hostParts[index + 1])) return false;
  const [prefix, suffix] = pattern.split('*');
  return hostParts[0].startsWith(prefix) && hostParts[0].endsWith(suffix)
    && hostParts[0].length >= prefix.length + suffix.length;
}

/** Validate a virtual peer certificate using Node's hostname-matching shape. */
export function checkServerIdentity(hostname, certificate = {}) {
  const host = String(hostname);
  const normalizedHost = host.replace(/\.$/, '');
  const altNames = certificate?.subjectaltname || certificate?.subjectAltName;
  const dnsNames = [];
  const ipNames = [];
  if (typeof altNames === 'string') {
    for (const value of altNames.split(/,\s*/)) {
      if (value.startsWith('DNS:')) dnsNames.push(value.slice(4));
      else if (value.startsWith('IP Address:') && isIpAddress(value.slice(11))) {
        ipNames.push(value.slice(11));
      }
    }
  }
  let valid = false;
  let reason;
  if (isIpAddress(normalizedHost)) {
    valid = ipNames.some((name) => matchesCertificateName(normalizedHost, name));
    if (!valid) reason = `IP: ${normalizedHost} is not in the cert's list: ${ipNames.join(', ')}`;
  } else if (dnsNames.length) {
    valid = dnsNames.some((name) => matchesCertificateName(normalizedHost, name));
    if (!valid) reason = `Host: ${normalizedHost}. is not in the cert's altnames: ${altNames}`;
  } else if (certificate?.subject?.CN) {
    const commonName = certificate?.subject?.CN;
    const names = Array.isArray(commonName) ? commonName : [commonName];
    valid = names.some((name) => matchesCertificateName(normalizedHost, name));
    if (!valid) reason = `Host: ${normalizedHost}. is not cert's CN: ${commonName}`;
  } else {
    reason = 'Cert does not contain a DNS name';
  }
  if (valid) return undefined;
  if (!reason) reason = 'Cert does not contain a DNS name';
  return tlsError('ERR_TLS_CERT_ALTNAME_INVALID', reason, {
    reason,
    host: normalizedHost,
    cert: certificate,
  });
}

function valueDescription(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'number') return `type number (${value})`;
  if (typeof value === 'boolean') return `type boolean (${value})`;
  return `an instance of ${value?.constructor?.name || typeof value}`;
}

function validateTlsOptions(options = {}) {
  if (!isRecord(options)) throw tlsError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be an object');
  const optionType = (name, expected, value) => {
    if (value !== undefined && typeof value !== expected) {
      throw tlsError(
        'ERR_INVALID_ARG_TYPE',
        `The "options.${name}" property must be of type ${expected}. Received ${valueDescription(value)}`,
      );
    }
  };
  optionType('ciphers', 'string', options.ciphers);
  optionType('passphrase', 'string', options.passphrase);
  optionType('ecdhCurve', 'string', options.ecdhCurve);
  optionType('handshakeTimeout', 'number', options.handshakeTimeout);
  optionType('sessionTimeout', 'number', options.sessionTimeout);
  for (const name of ['minVersion', 'maxVersion']) {
    optionType(name, 'string', options[name]);
    if (options[name] !== undefined && !/^TLSv(?:1|1\.1|1\.2|1\.3)$/.test(options[name])) {
      throw tlsError('ERR_TLS_INVALID_PROTOCOL_VERSION', `"${options[name]}" is not a valid TLS protocol version`);
    }
  }
  if (options.ticketKeys !== undefined) {
    const isBytes = ArrayBuffer.isView(options.ticketKeys) || options.ticketKeys instanceof ArrayBuffer;
    if (!isBytes) throw tlsError('ERR_INVALID_ARG_TYPE', 'The "options.ticketKeys" property must be an instance of Buffer');
    if (options.ticketKeys.byteLength !== 48) {
      throw tlsError('ERR_INVALID_ARG_VALUE', 'The property \'options.ticketKeys\' must be exactly 48 bytes');
    }
  }
}

function normalizeAuthority(options = {}) {
  const host = String(options.servername || options.hostname || options.host || 'localhost');
  const port = Number(options.port ?? 443);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw tlsError('ERR_SOCKET_BAD_PORT', `Port should be between 0 and 65535. Received ${options.port}.`);
  }
  return { host, port };
}

function isVirtualInternetBackingSocket(socket) {
  const options = socket?._connectOptions;
  const host = String(options?.host || options?.hostname || '').toLowerCase();
  return Boolean(options && Number(options.port) === 443
    && host && !['localhost', '127.0.0.1', '::1'].includes(host));
}

function validateCiphers(value) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    throw tlsError('ERR_INVALID_ARG_TYPE', 'The "ciphers" option must be a string');
  }
  const recognized = new Set([
    ...CIPHERS,
    ...DEFAULT_CIPHERS.split(':'),
    'ALL', 'DEFAULT', 'HIGH', 'MEDIUM', 'LOW', 'COMPLEMENTOFDEFAULT',
  ]);
  const candidates = value
    .split(':')
    .map((item) => item.replace(/^[!+\-]+/, '').split('@', 1)[0].toUpperCase())
    .filter(Boolean);
  if (candidates.length && !candidates.some((candidate) => recognized.has(candidate))) {
    throw tlsError('ERR_SSL_NO_CIPHER_MATCH', 'error:0A0000B9:SSL routines::no cipher match');
  }
}

function virtualCertificate(hostname) {
  const host = String(hostname || 'localhost');
  const certificate = {
    subject: { CN: host },
    issuer: { CN: 'Browser Virtual CA' },
    subjectaltname: isIpAddress(host) ? `IP Address:${host}` : `DNS:${host}`,
    valid_from: 'Jan 01 00:00:00 2020 GMT',
    valid_to: 'Jan 01 00:00:00 2099 GMT',
    fingerprint: '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
    fingerprint256: '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
    serialNumber: '00',
  };
  return certificate;
}

function certificateCommonNames(value) {
  if (typeof value !== 'string' || !value.includes('BEGIN CERTIFICATE')) return undefined;
  const body = value
    .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, '');
  let bytes;
  try {
    const binary = atob(body);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
  const oid = [0x06, 0x03, 0x55, 0x04, 0x03];
  const names = [];
  for (let index = 0; index <= bytes.length - oid.length; index += 1) {
    if (!oid.every((byte, offset) => bytes[index + offset] === byte)) continue;
    const tag = bytes[index + oid.length];
    const length = bytes[index + oid.length + 1];
    if (!tag || length === undefined || (length & 0x80) || index + oid.length + 2 + length > bytes.length) continue;
    const start = index + oid.length + 2;
    const text = new TextDecoder().decode(bytes.subarray(start, start + length));
    if (text) names.push(text);
  }
  return names;
}

function certificateCommonName(value) {
  return certificateCommonNames(value)[0];
}

function certificateDetails(value, fallbackHostname) {
  const commonName = certificateCommonName(value);
  if (!commonName) return virtualCertificate(fallbackHostname);
  return {
    ...virtualCertificate(commonName),
    subject: { CN: commonName },
    issuer: { CN: certificateCommonNames(value)[1] || commonName },
  };
}

function normalizeProxy(proxy, capability) {
  if (!proxy) return null;
  if (typeof proxy.tls === 'function' && typeof proxy.call === 'function') return proxy;
  return createProxyCapability({
    selection: proxy,
    capability: capability ?? proxy.capability,
    capabilities: capability ?? proxy.capabilities,
  });
}

function bytesFor(value, scope) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new (scope.TextEncoder || TextEncoder)().encode(value);
  if (value !== null && typeof value === 'object'
    && ['[object ArrayBuffer]', '[object SharedArrayBuffer]'].includes(Object.prototype.toString.call(value))) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new TypeError('TLS stream chunks must be strings or Uint8Array values');
}

function clientHelloServername(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.length < 9 || bytes[0] !== 0x16 || bytes[5] !== 0x01) return undefined;
  const handshakeLength = (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];
  if (bytes.length < 9 + handshakeLength) return undefined;
  let offset = 9 + 2 + 32;
  if (offset >= bytes.length) return undefined;
  const sessionLength = bytes[offset++];
  offset += sessionLength;
  if (offset + 2 > bytes.length) return undefined;
  offset += 2 + ((bytes[offset] << 8) | bytes[offset + 1]);
  if (offset >= bytes.length) return undefined;
  offset += 1 + bytes[offset];
  if (offset + 2 > bytes.length) return undefined;
  const extensionsEnd = offset + 2 + ((bytes[offset] << 8) | bytes[offset + 1]);
  offset += 2;
  if (extensionsEnd > bytes.length) return undefined;
  while (offset + 4 <= extensionsEnd) {
    const type = (bytes[offset] << 8) | bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;
    if (offset + length > extensionsEnd) return undefined;
    if (type === 0x0000 && length >= 5) {
      const namesEnd = offset + 2 + ((bytes[offset] << 8) | bytes[offset + 1]);
      let nameOffset = offset + 2;
      while (nameOffset + 3 <= namesEnd && namesEnd <= offset + length) {
        const nameType = bytes[nameOffset++];
        const nameLength = (bytes[nameOffset] << 8) | bytes[nameOffset + 1];
        nameOffset += 2;
        if (nameOffset + nameLength > namesEnd) return undefined;
        if (nameType === 0) return new TextDecoder().decode(bytes.subarray(nameOffset, nameOffset + nameLength));
        nameOffset += nameLength;
      }
    }
    offset += length;
  }
  return undefined;
}

function convertALPNProtocolsForBuffer(protocols, out, BufferClass) {
  if (Array.isArray(protocols)) {
    const lengths = new Array(protocols.length);
    const total = protocols.reduce((size, protocol, index) => {
      const length = BufferClass.byteLength(protocol);
      if (length > 255) {
        throw tlsError(
          'ERR_OUT_OF_RANGE',
          `The byte length of the protocol at index ${index} exceeds the maximum length. It must be <= 255. Received ${length}`,
        );
      }
      lengths[index] = length;
      return size + 1 + length;
    }, 0);
    const buffer = BufferClass.allocUnsafe(total);
    let offset = 0;
    for (let index = 0; index < protocols.length; index += 1) {
      buffer[offset++] = lengths[index];
      buffer.write(protocols[index], offset);
      offset += lengths[index];
    }
    out.ALPNProtocols = buffer;
  } else if (protocols instanceof Uint8Array) {
    out.ALPNProtocols = BufferClass.from(protocols);
  } else if (ArrayBuffer.isView(protocols)) {
    out.ALPNProtocols = BufferClass.from(
      protocols.buffer.slice(protocols.byteOffset, protocols.byteOffset + protocols.byteLength),
    );
  }
}

function tlsClientAuthError(serverOptions, clientOptions) {
  if (!serverOptions?.requestCert || clientOptions?.cert) return null;
  return tlsError(
    'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE',
    'tlsv13 alert certificate required',
  );
}

function tlsClientAuthPeerError(serverOptions, clientOptions) {
  const missingCertificate = tlsClientAuthError(serverOptions, clientOptions);
  if (missingCertificate) {
    return clientOptions?.maxVersion === 'TLSv1.2'
      ? tlsError('ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE', 'tlsv1 alert handshake failure')
      : tlsError('ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', 'tlsv13 alert certificate required');
  }
  if (serverOptions?.requestCert && clientOptions?.cert && !serverOptions.ca) {
    return tlsError('ECONNRESET', 'socket hang up');
  }
  return null;
}

const createHmac = createHmacShim(Uint8Array, null);
const PKCS12_DIGESTS = Object.freeze({
  '2b0e03021a': 'sha1',
  '608648016503040201': 'sha256',
  '608648016503040202': 'sha384',
  '608648016503040203': 'sha512',
  '608648016503040204': 'sha224',
});

function pfxError(message) {
  return new Error(message);
}

function readDerElement(bytes, offset) {
  if (offset >= bytes.length) throw pfxError('not enough data');
  const tag = bytes[offset++];
  if (offset >= bytes.length) throw pfxError('not enough data');
  const lengthByte = bytes[offset++];
  if ((lengthByte & 0x80) === 0) {
    const end = offset + lengthByte;
    if (end > bytes.length) throw pfxError('not enough data');
    return { tag, contentStart: offset, end };
  }
  const lengthBytes = lengthByte & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4 || offset + lengthBytes > bytes.length) {
    throw pfxError('not enough data');
  }
  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) length = length * 256 + bytes[offset++];
  const end = offset + length;
  if (end > bytes.length) throw pfxError('not enough data');
  return { tag, contentStart: offset, end };
}

function readDerChildren(bytes, element) {
  const children = [];
  for (let offset = element.contentStart; offset < element.end;) {
    const child = readDerElement(bytes, offset);
    children.push(child);
    offset = child.end;
  }
  return children;
}

function derContent(bytes, element) {
  return bytes.subarray(element.contentStart, element.end);
}

function expectDer(bytes, offset, tag) {
  const element = readDerElement(bytes, offset);
  if (element.tag !== tag) throw pfxError('not enough data');
  return element;
}

function derInteger(bytes, element) {
  const value = derContent(bytes, element);
  if (!value.length || value.length > 4) throw pfxError('not enough data');
  let result = 0;
  for (const byte of value) result = result * 256 + byte;
  return result;
}

function hexBytes(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pkcs12PasswordBytes(value) {
  const text = String(value ?? '');
  const codeUnits = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0xffff) codeUnits.push(codePoint);
    else {
      const scalar = codePoint - 0x10000;
      codeUnits.push(0xd800 + (scalar >> 10), 0xdc00 + (scalar & 0x3ff));
    }
  }
  const result = new Uint8Array(codeUnits.length * 2 + 2);
  codeUnits.forEach((codeUnit, index) => {
    result[index * 2] = codeUnit >> 8;
    result[index * 2 + 1] = codeUnit & 0xff;
  });
  return result;
}

function repeatToBlock(value, blockSize) {
  if (value.length === 0) return new Uint8Array();
  const result = new Uint8Array(Math.ceil(value.length / blockSize) * blockSize);
  for (let offset = 0; offset < result.length; offset += value.length) {
    result.set(value.subarray(0, Math.min(value.length, result.length - offset)), offset);
  }
  return result;
}

function concatenate(...values) {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function pkcs12DeriveKey(password, salt, id, iterations, digestName, length) {
  const digestSize = hashSync(digestName, new Uint8Array()).length;
  const blockSize = digestName === 'sha512' ? 128 : 64;
  const diversifier = new Uint8Array(blockSize).fill(id);
  const input = concatenate(
    repeatToBlock(salt, blockSize),
    repeatToBlock(pkcs12PasswordBytes(password), blockSize),
  );
  const result = new Uint8Array(length);
  for (let block = 0; block < Math.ceil(length / digestSize); block += 1) {
    let value = hashSync(digestName, concatenate(diversifier, input));
    for (let round = 1; round < iterations; round += 1) value = hashSync(digestName, value);
    const b = new Uint8Array(blockSize);
    for (let index = 0; index < b.length; index += 1) b[index] = value[index % value.length];
    for (let offset = 0; offset < input.length; offset += blockSize) {
      let carry = 1;
      for (let index = blockSize - 1; index >= 0; index -= 1) {
        const sum = input[offset + index] + b[index] + carry;
        input[offset + index] = sum & 0xff;
        carry = sum >> 8;
      }
    }
    result.set(value.subarray(0, Math.min(value.length, length - block * digestSize)), block * digestSize);
  }
  return result;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function readPfxMac(bytes) {
  const outer = expectDer(bytes, 0, 0x30);
  if (outer.end !== bytes.length) throw pfxError('not enough data');
  const outerChildren = readDerChildren(bytes, outer);
  if (outerChildren.length < 2) throw pfxError('not enough data');
  const authSafe = outerChildren[1];
  const authSafeChildren = readDerChildren(bytes, authSafe);
  if (authSafeChildren.length < 2) throw pfxError('not enough data');
  const authSafeContentWrapper = authSafeChildren[1];
  if (authSafeContentWrapper.tag !== 0xa0) throw pfxError('not enough data');
  const authSafeContent = expectDer(bytes, authSafeContentWrapper.contentStart, 0x04);
  if (outerChildren.length < 3) return null;

  const macData = outerChildren[2];
  const macDataChildren = readDerChildren(bytes, macData);
  if (macDataChildren.length < 2) throw pfxError('not enough data');
  const digestInfo = macDataChildren[0];
  const digestInfoChildren = readDerChildren(bytes, digestInfo);
  if (digestInfoChildren.length < 2) throw pfxError('not enough data');
  const digestAlgorithm = digestInfoChildren[0];
  const digestAlgorithmChildren = readDerChildren(bytes, digestAlgorithm);
  if (!digestAlgorithmChildren.length) throw pfxError('not enough data');
  const digestName = PKCS12_DIGESTS[hexBytes(derContent(bytes, digestAlgorithmChildren[0]))];
  if (!digestName) throw pfxError('unsupported PKCS#12 MAC digest');
  const expected = derContent(bytes, digestInfoChildren[1]);
  const salt = derContent(bytes, macDataChildren[1]);
  const iterations = macDataChildren[2] === undefined ? 1 : derInteger(bytes, macDataChildren[2]);
  if (!Number.isInteger(iterations) || iterations < 1) throw pfxError('not enough data');
  return { content: derContent(bytes, authSafeContent), digestName, expected, salt, iterations };
}

/** Check the authenticated envelope; certificate/key extraction remains virtual. */
function validatePfx(pfx, passphrase) {
  const values = Array.isArray(pfx) ? pfx : [pfx];
  for (const entry of values) {
    const value = entry?.buf ?? entry;
    const entryPassphrase = entry?.passphrase ?? passphrase;
    let bytes;
    if (typeof value === 'string') bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else throw pfxError('not enough data');
    const mac = readPfxMac(bytes);
    if (!mac) continue;
    const key = pkcs12DeriveKey(entryPassphrase, mac.salt, 3, mac.iterations, mac.digestName, mac.expected.length);
    const actual = createHmac(mac.digestName, key).update(mac.content).digest();
    if (!constantTimeEqual(actual, mac.expected)) throw pfxError('mac verify failure');
  }
}

class SecureContext {
  constructor(options = {}) {
    if (!isRecord(options)) throw new TypeError('secure context options must be an object');
    validateTlsOptions(options);
    const context = { ...options };
    const requireReceiver = (receiver) => {
      if (receiver !== context) throw new TypeError('Illegal invocation');
    };
    Object.defineProperties(context, {
      setOptions: {
        configurable: true,
        value(optionsToApply = {}) {
          requireReceiver(this);
          if (!isRecord(optionsToApply)) throw new TypeError('secure context options must be an object');
          validateTlsOptions(optionsToApply);
          Object.assign(context, optionsToApply);
        },
      },
      setCiphers: {
        configurable: true,
        value(ciphers) {
          requireReceiver(this);
          validateCiphers(ciphers);
          context.ciphers = ciphers;
        },
      },
      addCACert: {
        configurable: true,
        value(certificate) {
          requireReceiver(this);
          if (typeof certificate !== 'string' && !(certificate instanceof Uint8Array)) {
            throw new TypeError('certificate must be a string or Uint8Array');
          }
          const current = context.ca === undefined ? [] : [].concat(context.ca);
          current.push(certificate);
          context.ca = current;
        },
      },
      _external: {
        configurable: true,
        get() {
          requireReceiver(this);
          return undefined;
        },
      },
    });
    if (context.pfx !== undefined) validatePfx(context.pfx, context.passphrase);
    this.context = context;
    this.options = this.context;
  }

  getCertificate() {
    return this.options.cert || this.options.certificate || undefined;
  }

  getPrivateKey() {
    return this.options.key || this.options.privateKey || undefined;
  }
}

/** A Duplex whose TLS state and transport are browser-local and deterministic. */
export class TLSSocket extends Duplex {
  constructor(socket = undefined, options = {}, internal = {}) {
    super({ highWaterMark: options.highWaterMark });
    this._scope = internal.scope || globalThis;
    this._BufferClass = internal.BufferClass || this._scope.Buffer;
    this._proxy = internal.proxy;
    this._diagnostics = internal.diagnostics;
    this._socket = socket || null;
    this._handle = socket || null;
    this._resource = internal.resource || new AsyncResource('TLSWRAP');
    this._options = { ...options, _isServer: options._isServer ?? options.isServer ?? false };
    this._authority = normalizeAuthority(options);
    this.authorized = false;
    this.authorizationError = null;
    this.encrypted = true;
    this.connecting = true;
    this._pending = !socket;
    this._readyState = 'opening';
    this.alpnProtocol = options.ALPNProtocols?.[0] || options.alpnProtocol || false;
    this.servername = options.servername || this._authority.host;
    this.protocol = options.protocol || 'TLSv1.3';
    this._peerCertificate = clone(options.peerCertificate) || virtualCertificate(this.servername);
    this._secureContext = options.secureContext || new SecureContext(options);
    this._closed = false;
    this._handshakeStarted = false;
    this._controlReleased = false;
    this._renegotiationDisabled = false;
    this._bytesRead = 0;
    this._bytesWritten = 0;
    this._unrefed = false;
    this._virtualInternetBackingSocket = isVirtualInternetBackingSocket(socket);
    this._underlyingEnded = false;
    this._writable._write = (chunk, encoding, callback) => this._writeTransport(chunk, encoding, callback);
    this._writable._final = (callback) => this._endTransport(callback);
    this._attachSocket(socket);
  }

  _attachSocket(socket) {
    if (!socket) return;
    socket.on?.('data', (chunk) => {
      const bytes = bytesFor(chunk, this._scope);
      this._bytesRead += bytes.byteLength;
      this.push(chunk);
    });
    if (this._options._isServer && typeof this._options.SNICallback === 'function') {
      let pending = new Uint8Array();
      let invoked = false;
      socket.on('data', (chunk) => {
        if (invoked) return;
        const bytes = bytesFor(chunk, this._scope);
        const combined = new Uint8Array(pending.length + bytes.length);
        combined.set(pending);
        combined.set(bytes, pending.length);
        pending = combined;
        const servername = clientHelloServername(pending);
        if (servername === undefined) return;
        invoked = true;
        this._options.SNICallback(servername, (error, context) => {
          if (error) this.destroy(error);
          else if (context instanceof SecureContext) this._secureContext = context;
        });
      });
    }
    socket.on?.('end', () => {
      this._underlyingEnded = true;
      this.push(null);
    });
    socket.on?.('error', (error) => {
      const virtualInternetBackingSocket = this._virtualInternetBackingSocket
        || isVirtualInternetBackingSocket(socket);
      if (virtualInternetBackingSocket && error?.code === 'ECONNREFUSED') {
        this._socket = null;
        this.remoteAddress = this.servername;
        this.remotePort = this._authority.port;
        void this._handshake();
        return;
      }
      this.destroy(error);
    });
    socket.on?.('close', () => this._emitClose());
  }

  _emitClose() {
    if (this._closed) return;
    this._closed = true;
    this.connecting = false;
    this._pending = false;
    this._readyState = 'closed';
    this._resource.runInAsyncScope(() => super.destroy(), this);
    this._resource.emitDestroy();
  }

  _writeTransport(chunk, encoding, callback) {
    if (!this._socket) {
      callback();
      return;
    }
    try {
      const value = bytesFor(chunk, this._scope);
      this._bytesWritten += value.byteLength;
      const result = this._socket.write(value, encoding, callback);
      if (result && typeof result.then === 'function') result.then(() => callback(), callback);
    } catch (error) {
      callback(error);
    }
  }

  _endTransport(callback) {
    if (!this.destroyed && this.readyState === 'open') this._readyState = 'readOnly';
    if (this._socket?.end) {
      try { this._socket.end(callback); } catch (error) { callback(error); }
      return;
    }
    callback();
  }

  async _handshake() {
    if (this._handshakeStarted || this.destroyed) return;
    this._handshakeStarted = true;
    try {
      const serverOptions = this._socket?._tlsServerOptions;
      const clientOptions = this._socket?._tlsClientOptions || this._socket?._peer?._tlsClientOptions;
      if (this._options._isServer) {
        const error = tlsClientAuthError(this._options, clientOptions);
        if (error) {
          if (this._socket?._peer) {
            this._socket._peer._tlsHandshakeError = tlsClientAuthPeerError(this._options, clientOptions);
          }
          throw error;
        }
      } else if (this._socket?._tlsHandshakeError) {
        throw this._socket._tlsHandshakeError;
      }
      let result = {};
      if (this._proxy) {
        result = await this._proxy.tls({
          target: `${this._authority.host}:${this._authority.port}`,
          hostname: this._authority.host,
          port: this._authority.port,
          servername: this.servername,
          alpnProtocols: this._options.ALPNProtocols || [],
        });
      }
      if (result?.peerCertificate) this._peerCertificate = result.peerCertificate;
      else if (!this._options._isServer && serverOptions?.cert) {
        this._peerCertificate = certificateDetails(serverOptions.cert, this.servername);
      }
      if (result?.alpnProtocol !== undefined) this.alpnProtocol = result.alpnProtocol;
      if (result?.protocol) this.protocol = result.protocol;
      const identityError = typeof this._options.checkServerIdentity === 'function'
        ? this._options.checkServerIdentity(this.servername, this._peerCertificate)
        : (this._options.rejectUnauthorized === false ? undefined : checkServerIdentity(this.servername, this._peerCertificate));
      this.authorizationError = result?.authorized === false
        ? tlsError('ERR_TLS_CERT_ALTNAME_INVALID', 'virtual peer was not authorized')
        : identityError || null;
      if (this._options._isServer && this._options.requestCert) {
        const clientCertificate = certificateDetails(clientOptions?.cert, '');
        const issuers = [].concat(this._options.ca || [])
          .map((certificate) => certificateDetails(certificate, '').subject?.CN)
          .filter(Boolean);
        this.authorizationError = issuers.includes(clientCertificate.issuer?.CN)
          ? null
          : verifyLeafError();
      }
      // A direct `ca` option replaces the compiled-in roots. The browser
      // cannot perform OpenSSL validation, but it must preserve this visible
      // distinction from a default or SecureContext-backed connection.
      if (!this._options._isServer && this._options.secureContext
        && !this._options.secureContext.context?.ca) {
        this.authorizationError = verifyLeafError();
      }
      this.authorized = result?.authorized ?? !this.authorizationError;
      if (this._options._isServer) {
        // A server-side TLSSocket is not an authenticated peer unless the
        // server requested a client certificate and the presented chain was
        // accepted. Node exposes this independently from the server's own
        // certificate and hostname checks.
        this.authorized = this._options.requestCert
          ? this.authorizationError === null
          : false;
      }
      if (this.authorizationError && this._options.rejectUnauthorized !== false) throw this.authorizationError;
      this.connecting = false;
      this._pending = false;
      this._readyState = 'open';
      if (this._options._isServer) this._resource.runInAsyncScope(() => {}, this);
      this._resource.runInAsyncScope(() => {
        this.emit('secureConnect');
        this.emit('connect');
      }, this);
    } catch (error) {
      this.connecting = false;
      this._pending = false;
      this._readyState = 'closed';
      this.destroy(error);
    }
  }

  connect() {
    if (!this._options._isServer && !this._diagnosticPublished) {
      const channel = this._diagnostics?.channel?.('net.client.socket');
      if (channel?.hasSubscribers) channel.publish({ socket: this });
      this._diagnosticPublished = true;
    }
    if (this._socket?.connecting) {
      if (isVirtualInternetBackingSocket(this._socket)) {
        const backingSocket = this._socket;
        const options = backingSocket._connectOptions;
        const host = String(options.host || options.hostname);
        this._authority = { host, port: Number(options.port) };
        this.servername = String(options.servername || host);
        this._peerCertificate = virtualCertificate(this.servername);
        this._socket = null;
        backingSocket.destroy();
        this._authority = { host: this.servername, port: this._authority.port };
        schedule(() => void this._handshake());
        return this;
      }
      // The virtual network emits the client connect before it dispatches the
      // accepted socket to the server. Defer the handshake one microtask so
      // the server-side TLS wrapper can install its peer options first.
      this._socket.once('connect', () => {
        const start = () => void this._handshake();
        if (this._options.maxVersion === 'TLSv1.2') schedule(() => schedule(start));
        else schedule(start);
      });
      if (!(this._virtualInternetBackingSocket || isVirtualInternetBackingSocket(this._socket))) {
        this._socket.once('error', (error) => this.destroy(error));
      }
    } else {
      schedule(() => void this._handshake());
    }
    return this;
  }

  getCipher() {
    return { name: 'TLS_AES_128_GCM_SHA256', standardName: 'TLS_AES_128_GCM_SHA256', version: this.protocol };
  }

  getProtocol() { return this.protocol; }
  getCertificate() {
    return certificateDetails(
      this._options.cert || this._options.certificate,
      this.servername,
    );
  }
  getPeerCertificate() { return clone(this._peerCertificate); }
  getSession() {
    if (this._session !== undefined) return this._session;
    return new Uint8Array([0x42, 0x4e, 0x48, 0x2d, 0x54, 0x4c, 0x53]);
  }
  isSessionReused() { return Boolean(this._sessionReused); }
  setMaxSendFragment() { return true; }
  setServername(servername) {
    if (this._options._isServer) throw tlsError('ERR_TLS_SNI_FROM_SERVER', 'Cannot set SNI from a server');
    if (typeof servername !== 'string') throw tlsError('ERR_INVALID_ARG_TYPE', 'The "name" argument must be of type string');
    this.servername = servername;
    return this;
  }

  get _handle() { return this._tlsHandle ?? this._socket ?? null; }
  set _handle(value) { this._tlsHandle = value; }
  get _connecting() { return this.connecting; }
  get pending() { return this._pending ?? (!this._handle || this.connecting); }
  get readyState() {
    if (this.connecting) return 'opening';
    if (this._readyState === 'closed' || this.destroyed) return 'closed';
    if (this._readyState === 'readOnly' && this.readable) return 'readOnly';
    if (this._readyState === 'writeOnly' && this.writable) return 'writeOnly';
    return this.readable && this.writable ? 'open' : this.readable ? 'readOnly' : 'writeOnly';
  }
  get bufferSize() { return this.writableLength ?? 0; }
  get bytesRead() { return this._bytesRead; }
  get bytesWritten() { return this._bytesWritten + (this.writableLength ?? 0); }
  get _bytesDispatched() { return this._bytesWritten; }
  get remoteAddress() { return this._socket?.remoteAddress ?? this._authority.host; }
  get remotePort() { return this._socket?.remotePort ?? this._authority.port; }
  get remoteFamily() { return this._socket?.remoteFamily ?? (isIpAddress(this.remoteAddress) ? 'IPv4' : undefined); }
  get localAddress() { return this._socket?.localAddress; }
  get localPort() { return this._socket?.localPort; }
  get localFamily() { return this._socket?.localFamily; }
  address() {
    if (this._socket?.address) return this._socket.address();
    return this.localAddress === undefined ? {} : {
      address: this.localAddress,
      family: this.localFamily,
      port: this.localPort,
    };
  }

  _getpeername() {
    return { address: this.remoteAddress, family: this.remoteFamily, port: this.remotePort };
  }
  _getsockname() { return this.address(); }
  _wrapHandle(wrap, handle) { return handle || wrap || this._socket || null; }
  _init() { return this; }
  _start() { return this.connect(); }
  _final(callback) { return this._endTransport(callback); }
  _writeGeneric(_writev, data, encoding, callback) { return this._writeTransport(data, encoding, callback); }
  _handleTimeout() { this._emitTLSError(tlsError('ERR_TLS_HANDSHAKE_TIMEOUT', 'TLS handshake timeout')); }
  _tlsError(error) { this.emit('_tlsError', error); return this._controlReleased ? error : null; }
  _emitTLSError(error) { const value = this._tlsError(error); if (value) this.emit('error', value); }
  _finishInit() {
    if (this.destroyed) return;
    this._secureEstablished = true;
    if (this._timeout) this.setTimeout(0);
    this.emit('secure');
  }
  _releaseControl() {
    if (this._controlReleased) return false;
    this._controlReleased = true;
    return true;
  }
  _unrefTimer() { this._timeout?.refresh?.(); }
  _destroySSL() { return undefined; }
  _reset() { return this.resetAndDestroy(); }

  setNoDelay(enable) {
    const value = Boolean(enable === undefined ? true : enable);
    this._noDelay = value;
    this._socket?.setNoDelay?.(value);
    return this;
  }

  setKeepAlive(enable, initialDelayMsecs) {
    const value = Boolean(enable);
    const initialDelay = ~~(initialDelayMsecs / 1000);
    this._keepAlive = value;
    this._keepAliveInitialDelay = initialDelay;
    this._socket?.setKeepAlive?.(value, initialDelayMsecs);
    return this;
  }

  setSession(session) {
    if (session === undefined) return undefined;
    const value = typeof session === 'string' && this._BufferClass?.from
      ? this._BufferClass.from(session, 'latin1')
      : session;
    if (this._socket?.setSession) this._socket.setSession(value);
    else this._session = value;
    return undefined;
  }

  _onTimeout() { this.emit('timeout'); }

  setTimeout(milliseconds, callback) {
    if (this.destroyed) return this;
    if (typeof milliseconds !== 'number') {
      throw tlsError('ERR_INVALID_ARG_TYPE', 'The "msecs" argument must be of type number');
    }
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw tlsError(
        'ERR_OUT_OF_RANGE',
        `The value of "msecs" is out of range. It must be >= 0 && <= ${Number.MAX_SAFE_INTEGER}. Received ${milliseconds}`,
      );
    }
    if (callback !== undefined && typeof callback !== 'function') {
      throw tlsError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function');
    }
    this.timeout = milliseconds;
    if (this._timeout) clearTimeout(this._timeout);
    this._timeout = null;
    if (milliseconds === 0) {
      if (callback !== undefined) this.removeListener('timeout', callback);
      return this;
    }
    if (callback) this.once('timeout', callback);
    this._timeout = setTimeout(() => this._onTimeout(), milliseconds);
    this._timeout?.unref?.();
    return this;
  }

  unref() {
    this._unrefed = true;
    if (this._socket?.unref) this._socket.unref();
    else if (this.connecting) this.once('connect', this.unref);
    return this;
  }
  ref() {
    this._unrefed = false;
    this._socket?.ref?.();
    return this;
  }

  renegotiate(options, callback) {
    if (!isRecord(options)) throw tlsError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object');
    if (callback !== undefined && typeof callback !== 'function') {
      throw tlsError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function');
    }
    if (this.destroyed) return undefined;
    if (this._renegotiationDisabled) {
      const error = tlsError('ERR_TLS_RENEGOTIATION_DISABLED', 'TLS session renegotiation disabled for this socket');
      if (callback) schedule(() => callback(error));
      return true;
    }
    if (callback) schedule(() => callback(null));
    return true;
  }
  disableRenegotiation() { this._renegotiationDisabled = true; }
  destroySoon() {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
    else this.once('finish', () => this.destroy());
  }

  // Browser WebSocket/TLS does not expose the peer certificate as an X509
  // object. The legacy getPeerCertificate() metadata above is intentionally
  // not promoted to this API because it is not a parsed certificate.
  getX509Certificate() { return undefined; }
  getPeerX509Certificate() { return undefined; }

  // Browser TLS credentials are selected by the user agent before the
  // WebSocket handshake. There is no browser API to replace them on an open
  // connection, so do not pretend that changing the virtual options works.
  setKeyCert() {
    throw new UnsupportedWebCapabilityError(
      'tls.TLSSocket.setKeyCert',
      'WebSocket TLS credentials cannot be changed through a browser API',
    );
  }

  // These values come from the native TLS handle in Node. Browser WebSocket
  // and Web Crypto expose neither negotiated signature groups nor ephemeral
  // key details, TLS Finished messages, session tickets, or trace hooks.
  // Returning null matches Node's socket-method proxy when no native handle is
  // available and avoids fabricating protocol state.
  getSharedSigalgs() { return null; }
  getEphemeralKeyInfo() { return null; }
  getFinished() { return null; }
  getPeerFinished() { return null; }
  getTLSTicket() { return null; }
  enableTrace() { return null; }

  exportKeyingMaterial(length, label = '', context = undefined) {
    if (!Number.isInteger(length) || length < 0) throw new RangeError('length must be a non-negative integer');
    const seed = `${label}:${context ? String(context) : ''}:browser-virtual-tls`;
    const bytes = new (this._scope.TextEncoder || TextEncoder)().encode(seed);
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) result[index] = bytes[index % bytes.length];
    return typeof this._BufferClass?.from === 'function' ? this._BufferClass.from(result) : result;
  }

  destroy(error) {
    if (this._closed) return this;
    this._closed = true;
    this.connecting = false;
    this._pending = false;
    this._readyState = 'closed';
    if (this._socket && !this._socket.destroyed) this._socket.destroy(error);
    this._resource.emitDestroy();
    return super.destroy(error);
  }

  resetAndDestroy() {
    if (this.destroyed) return this;
    const error = tlsError('ECONNRESET', 'read ECONNRESET');
    if (this._socket?.resetAndDestroy) this._socket.resetAndDestroy();
    this.destroy(error);
    return this;
  }
}

class SecurePair extends EventEmitter {
  constructor(secureContext, isServer = false, requestCert = !isServer,
    rejectUnauthorized = false, options = {}, internal = {}) {
    super();
    if (secureContext === undefined) secureContext = internal.createSecureContext();
    if (secureContext !== null && !(secureContext instanceof SecureContext)) {
      throw tlsError('ERR_TLS_INVALID_CONTEXT', 'context must be a SecureContext');
    }
    const [encrypted, transport] = duplexPair();
    const tlsOptions = {
      secureContext,
      isServer,
      _isServer: isServer,
      requestCert,
      rejectUnauthorized,
      ...options,
    };
    this.server = options?.server;
    this.credentials = secureContext;
    this.encrypted = encrypted;
    this.cleartext = new TLSSocket(transport, tlsOptions, internal);
    this.cleartext.once('secureConnect', () => this.emit('secure'));
    this.cleartext.connect();
  }

  destroy() {
    this.cleartext.destroy();
    this.encrypted.destroy();
  }
}

class TLSServer extends EventEmitter {
  constructor(options = {}, listener, internal = {}) {
    super();
    if (typeof options === 'function') {
      listener = options;
      options = {};
    }
    validateTlsOptions(options);
    this._options = { ...options };
    this.options = this._options;
    this._BufferClass = internal.BufferClass || this._scope.Buffer;
    this.requestCert = options.requestCert === true;
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    this._ticketKeys = options.ticketKeys
      ? (options.ticketKeys instanceof ArrayBuffer
        ? new Uint8Array(options.ticketKeys).slice()
        : new Uint8Array(options.ticketKeys.buffer, options.ticketKeys.byteOffset, options.ticketKeys.byteLength).slice())
      : new Uint8Array(48);
    this._secureContext = new SecureContext(options);
    this._contexts = [];
    this._scope = internal.scope || globalThis;
    this._net = internal.net || createBrowserNet({ BufferClass: internal.BufferClass });
    this._proxy = internal.proxy;
    this._raw = this._net.createServer((socket) => {
      const clientOptions = socket._peer?._tlsClientOptions
        || socket._peer?._connectOptions
        || socket._tlsClientOptions;
      const selected = this._selectContext(clientOptions?.servername);
      const serverOptions = selected
        ? { ...this._options, ...selected, servername: clientOptions?.servername }
        : { ...this._options, servername: clientOptions?.servername };
      socket._tlsServerOptions = serverOptions;
      if (socket._peer) {
        socket._peer._tlsServerOptions = socket._tlsServerOptions;
        socket._peer._tlsHandshakeError = tlsClientAuthPeerError(
          this._options,
          socket._peer._tlsClientOptions,
        );
      }
      const tlsSocket = new TLSSocket(socket, { ...serverOptions, _isServer: true }, internal);
      tlsSocket.once('secureConnect', () => this.emit('secureConnection', tlsSocket));
      tlsSocket.once('error', (error) => this.emit('tlsClientError', error, tlsSocket));
      tlsSocket.connect();
    });
    this.listening = false;
    this._raw.on('listening', () => { this.listening = true; this.emit('listening'); });
    this._raw.on('error', (error) => this.emit('error', error));
    this._raw.on('close', () => { this.listening = false; this.emit('close'); });
    if (typeof listener === 'function') this.on('secureConnection', listener);
  }

  listen(...args) { this._raw.listen(...args); return this; }
  address() { return this._raw.address(); }
  close(callback) { if (callback) this.once('close', callback); this._raw.close(); return this; }
  getConnections(callback) { return this._raw.getConnections(callback); }
  ref() { this._raw.ref(); return this; }
  unref() { this._raw.unref(); return this; }
  _emitCloseIfDrained() { return this._raw._emitCloseIfDrained?.(); }
  _listen2(...args) { return this._raw._listen2?.(...args); }
  _setupWorker(...args) { return this._raw._setupWorker?.(...args); }

  setSecureContext(options) {
    validateTlsOptions(options);
    this._options = { ...this._options, ...options };
    this.options = this._options;
    this._secureContext = new SecureContext(this._options);
    if (options.ticketKeys !== undefined) this.setTicketKeys(options.ticketKeys);
    return this;
  }

  _getServerData() {
    return { ticketKeys: hexBytes(this._ticketKeys) };
  }

  _setServerData(data) {
    if (!isRecord(data) || typeof data.ticketKeys !== 'string') {
      throw tlsError('ERR_INVALID_ARG_TYPE', 'The "data" argument must contain ticketKeys');
    }
    const bytes = new Uint8Array(data.ticketKeys.match(/[\da-f]{2}/gi)?.map((value) => Number.parseInt(value, 16)) || []);
    this.setTicketKeys(bytes);
  }

  getTicketKeys() {
    return this._BufferClass?.from ? this._BufferClass.from(this._ticketKeys) : this._ticketKeys.slice();
  }

  setTicketKeys(keys) {
    const isBytes = ArrayBuffer.isView(keys) || keys instanceof ArrayBuffer;
    if (!isBytes) throw tlsError('ERR_INVALID_ARG_TYPE', 'The "keys" argument must be an instance of Buffer');
    if (keys.byteLength !== 48) {
      throw tlsError('ERR_INVALID_ARG_VALUE', 'Session ticket keys must be a 48-byte buffer');
    }
    const bytes = keys instanceof ArrayBuffer
      ? new Uint8Array(keys)
      : new Uint8Array(keys.buffer, keys.byteOffset, keys.byteLength);
    this._ticketKeys = bytes.slice();
  }

  setOptions(options) {
    validateTlsOptions(options);
    this.requestCert = options.requestCert === true;
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    return this.setSecureContext(options);
  }

  [Symbol.for('nodejs.asyncDispose')]() {
    return new Promise((resolve) => this.close(resolve));
  }

  addContext(servername, context) {
    if (typeof servername !== 'string' || servername.length === 0) {
      throw tlsError('ERR_INVALID_ARG_TYPE', 'The "servername" argument must be of type string');
    }
    const secureContext = context instanceof SecureContext ? context : new SecureContext(context);
    this._contexts.push({ servername: servername.toLowerCase(), options: secureContext.options });
    return this;
  }

  _selectContext(servername) {
    const host = String(servername || '').toLowerCase();
    for (let index = this._contexts.length - 1; index >= 0; index -= 1) {
      const context = this._contexts[index];
      if (context.servername === host) return context.options;
      if (context.servername.startsWith('*.')
        && host.endsWith(context.servername.slice(1))
        && host.split('.').length === context.servername.split('.').length) {
        return context.options;
      }
    }
    return undefined;
  }
}

export function createTlsModule(scope = globalThis, options = {}) {
  if (options === undefined || (options && Object.keys(options).length === 0 && isRecord(scope)
    && ['proxy', 'capability', 'transport', 'net', 'BufferClass'].some((key) => Object.hasOwn(scope, key)))) {
    options = scope;
    scope = globalThis;
  }
  const net = options.net || createBrowserNet({
    transport: options.transport,
    BufferClass: options.BufferClass || scope.Buffer,
  });
  const proxy = normalizeProxy(options.proxy, options.capability);
  const BufferClass = options.BufferClass || scope.Buffer;
  let defaultCaCertificates = [...DEFAULT_ROOT_CERTIFICATES];
  let defaultMaxVersion = constants.DEFAULT_MAX_VERSION;

  function normalizeCaCertificate(value, index) {
    if (typeof value === 'string') return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return new TextDecoder().decode(value);
    }
    throw tlsError(
      'ERR_INVALID_ARG_TYPE',
      `The "certs[${index}]" argument must be of type string or an instance of ArrayBufferView`,
    );
  }

  function setDefaultCACertificates(certificates) {
    if (!Array.isArray(certificates)) {
      throw tlsError('ERR_INVALID_ARG_TYPE', 'The "certs" argument must be an instance of Array');
    }
    const normalized = certificates.map(normalizeCaCertificate);
    defaultCaCertificates = [...new Set(normalized)];
  }

  function getCACertificates(type = 'default') {
    if (type === 'default') return [...defaultCaCertificates];
    if (type === 'bundled') return [...DEFAULT_ROOT_CERTIFICATES];
    if (type === 'system') return [];
    throw tlsError('ERR_INVALID_ARG_VALUE', `Unknown certificate type: ${type}`);
  }

  function createSecureContext(contextOptions = {}) {
    return new SecureContext(contextOptions);
  }

  let securePairWarned = false;
  function createSecurePair(...args) {
    const processObject = scope.process;
    if (!securePairWarned && !processObject?.noDeprecation) {
      securePairWarned = true;
      processObject?.emitWarning?.(
        'tls.createSecurePair() is deprecated. Please use tls.TLSSocket instead.',
        { code: 'DEP0064', type: 'DeprecationWarning' },
      );
    }
    return new SecurePair(args[0], args[1], args[2], args[3], args[4], {
      scope,
      net,
      BufferClass,
      proxy,
      diagnostics: options.diagnostics,
      createSecureContext,
    });
  }

  function connect(...args) {
    let callback;
    if (typeof args.at(-1) === 'function') callback = args.pop();
    let input = args[0];
    let connectOptions = isRecord(input) ? { ...input } : { port: input };
    if (typeof args[1] === 'object' && args[1] !== null && !isRecord(input)) connectOptions = { ...connectOptions, ...args[1] };
    if (Object.hasOwn(connectOptions, 'checkServerIdentity')
      && typeof connectOptions.checkServerIdentity !== 'function') {
      throw tlsError('ERR_INVALID_ARG_TYPE', 'The "checkServerIdentity" option must be a function');
    }
    const hasTransport = connectOptions.port !== undefined
      || connectOptions.socket !== undefined
      || connectOptions.path !== undefined
      || connectOptions.host !== undefined
      || connectOptions.hostname !== undefined
      || connectOptions.servername !== undefined;
    if (!hasTransport) throw tlsError('ERR_MISSING_ARGS', 'The "options" or "port" or "path" argument must be specified');
    if (connectOptions.lookup !== undefined && typeof connectOptions.lookup !== 'function') {
      throw tlsError('ERR_INVALID_ARG_TYPE', 'The "lookup" option must be a function');
    }
    validateCiphers(connectOptions.ciphers);
    connectOptions.maxVersion ??= defaultMaxVersion;
    connectOptions.port ??= 443;
    const targetProxy = normalizeProxy(connectOptions.proxy, connectOptions.capability) || proxy;
    let socket = connectOptions.socket;
    let pendingSocketOptions = null;
    let tlsResource = null;
    if (!socket && !targetProxy && connectOptions.host === undefined && connectOptions.hostname === undefined) {
      connectOptions.host = 'localhost';
    }
    if (!socket && !targetProxy && (connectOptions.host === 'localhost'
      || connectOptions.host === '127.0.0.1' || connectOptions.host === '::1')) {
      socket = new net.Socket();
      socket._tcpResource = new AsyncResource('TCPWRAP');
      pendingSocketOptions = {
        host: connectOptions.host,
        port: connectOptions.port,
          localAddress: connectOptions.localAddress,
          localPort: connectOptions.localPort,
          lookup: connectOptions.lookup,
          servername: connectOptions.servername,
          cert: connectOptions.cert,
          key: connectOptions.key,
          ca: connectOptions.ca,
        };
      socket._tlsClientOptions = connectOptions;
      tlsResource = new AsyncResource('TLSWRAP');
    }
    if (!socket && connectOptions.port !== undefined && connectOptions.virtualTransport !== false && !targetProxy) {
      // A virtual TLS endpoint can be observed without requiring a listening host.
      socket = null;
    } else if (!socket && connectOptions.socketPath) {
      throw tlsError('ERR_TLS_INVALID_CONTEXT', 'socketPath is not available in a browser virtual TLS context');
    }
    const tlsSocket = new TLSSocket(socket, connectOptions, {
      scope,
      BufferClass,
      proxy: targetProxy,
      resource: tlsResource,
    });
    if (callback) tlsSocket.once('secureConnect', callback);
    if (connectOptions.signal?.aborted) {
      const error = connectOptions.signal.reason instanceof Error
        ? connectOptions.signal.reason
        : tlsError('ABORT_ERR', 'The operation was aborted');
      schedule(() => tlsSocket.destroy(error));
    } else {
      connectOptions.signal?.addEventListener?.('abort', () => tlsSocket.destroy(connectOptions.signal.reason), { once: true });
      if (pendingSocketOptions) {
        tlsResource.runInAsyncScope(() => socket.connect(pendingSocketOptions), socket);
      }
      tlsSocket.connect();
    }
    return tlsSocket;
  }

  function createServer(serverOptions, listener) {
    return new TLSServer(
      { ...(serverOptions || {}), maxVersion: serverOptions?.maxVersion ?? defaultMaxVersion },
      listener,
      { scope, net, BufferClass, proxy, diagnostics: options.diagnostics },
    );
  }

  function CallableTLSServer(...args) {
    return new TLSServer(...args, { scope, net, BufferClass, proxy, diagnostics: options.diagnostics });
  }
  CallableTLSServer.prototype = TLSServer.prototype;

  const tlsModule = {
    connect,
    createConnection: connect,
    createSecureContext,
    createSecurePair,
    createServer,
    checkServerIdentity,
    convertALPNProtocols: (protocols, out) => convertALPNProtocolsForBuffer(protocols, out, BufferClass),
    getCiphers: () => [...CIPHERS],
    setDefaultCACertificates,
    getCACertificates,
    DEFAULT_CIPHERS,
    DEFAULT_MIN_VERSION: constants.DEFAULT_MIN_VERSION,
    DEFAULT_ECDH_CURVE: constants.DEFAULT_ECDH_CURVE,
    DEFAULT_MAX_VERSION: constants.DEFAULT_MAX_VERSION,
    CLIENT_RENEG_LIMIT: constants.CLIENT_RENEG_LIMIT,
    CLIENT_RENEG_WINDOW: constants.CLIENT_RENEG_WINDOW,
    rootCertificates: DEFAULT_ROOT_CERTIFICATES,
    constants,
    SecureContext,
    TLSSocket,
    Server: CallableTLSServer,
  };
  Object.defineProperty(tlsModule, 'DEFAULT_MAX_VERSION', {
    configurable: true,
    enumerable: true,
    get: () => defaultMaxVersion,
    set: (value) => { defaultMaxVersion = String(value); },
  });
  return tlsModule;
}

export const createTlsContract = createTlsModule;
export const createTLSContract = createTlsModule;

const defaultTls = createTlsModule();
export const connect = defaultTls.connect;
export const createConnection = defaultTls.createConnection;
export const createSecureContext = defaultTls.createSecureContext;
export const createSecurePair = defaultTls.createSecurePair;
export const createServer = defaultTls.createServer;
export const convertALPNProtocols = defaultTls.convertALPNProtocols;
export const getCiphers = defaultTls.getCiphers;
export const rootCertificates = defaultTls.rootCertificates;
export { DEFAULT_CIPHERS, constants, SecureContext };
export default defaultTls;
