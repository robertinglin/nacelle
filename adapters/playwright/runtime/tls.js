import { EventEmitter } from './events.js';
import { Duplex } from './streams.js';
import { createBrowserNet } from './net.js';
import { createProxyCapability } from './proxy.js';

const DEFAULT_CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256';
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
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
};

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
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) || text.includes(':');
}

function matchesCertificateName(hostname, name) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  const candidate = String(name).toLowerCase().replace(/\.$/, '');
  if (isIpAddress(host) || isIpAddress(candidate)) return host === candidate;
  if (!candidate.includes('*')) return host === candidate;
  if (!candidate.startsWith('*.') || candidate.slice(2).includes('*')) return false;
  const suffix = candidate.slice(1);
  return host.endsWith(suffix) && host.split('.').length === candidate.split('.').length;
}

/** Validate a virtual peer certificate using Node's hostname-matching shape. */
export function checkServerIdentity(hostname, certificate = {}) {
  const host = String(hostname || '');
  const names = certificateNames(certificate);
  if (names.some((name) => matchesCertificateName(host, name))) return undefined;
  const reason = names.length
    ? `Host: ${host}. is not in the cert's altnames: ${names.join(', ')}.`
    : `Host: ${host}. is not in the cert's subject name.`;
  return tlsError('ERR_TLS_CERT_ALTNAME_INVALID', reason, {
    reason,
    host,
    cert: certificate,
  });
}

function normalizeAuthority(options = {}) {
  const host = String(options.servername || options.hostname || options.host || 'localhost');
  const port = Number(options.port ?? 443);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw tlsError('ERR_SOCKET_BAD_PORT', `Port should be between 0 and 65535. Received ${options.port}.`);
  }
  return { host, port };
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
  return {
    subject: { CN: host },
    issuer: { CN: 'Browser Virtual CA' },
    subjectaltname: isIpAddress(host) ? `IP Address:${host}` : `DNS:${host}`,
    valid_from: 'Jan 01 00:00:00 2020 GMT',
    valid_to: 'Jan 01 00:00:00 2099 GMT',
    fingerprint: '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
    fingerprint256: '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
    serialNumber: '00',
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
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new TypeError('TLS stream chunks must be strings or Uint8Array values');
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

class SecureContext {
  constructor(options = {}) {
    if (!isRecord(options)) throw new TypeError('secure context options must be an object');
    this.context = Object.freeze({ ...options });
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
    this._socket = socket || null;
    this._options = { ...options };
    this._authority = normalizeAuthority(options);
    this.authorized = false;
    this.authorizationError = null;
    this.encrypted = true;
    this.connecting = true;
    this.pending = !socket;
    this.readyState = 'opening';
    this.alpnProtocol = options.ALPNProtocols?.[0] || options.alpnProtocol || false;
    this.servername = options.servername || this._authority.host;
    this.protocol = options.protocol || 'TLSv1.3';
    this._peerCertificate = clone(options.peerCertificate) || virtualCertificate(this.servername);
    this._secureContext = options.secureContext || new SecureContext(options);
    this._closed = false;
    this._handshakeStarted = false;
    this._underlyingEnded = false;
    this._writable._write = (chunk, encoding, callback) => this._writeTransport(chunk, encoding, callback);
    this._writable._final = (callback) => this._endTransport(callback);
    this._attachSocket(socket);
  }

  _attachSocket(socket) {
    if (!socket) return;
    for (const name of ['localAddress', 'localPort', 'localFamily', 'remoteAddress', 'remotePort', 'remoteFamily']) {
      if (socket[name] !== undefined) this[name] = socket[name];
    }
    socket.on?.('data', (chunk) => this.push(chunk));
    socket.on?.('end', () => {
      this._underlyingEnded = true;
      this.push(null);
    });
    socket.on?.('error', (error) => this.destroy(error));
    socket.on?.('close', () => this._emitClose());
  }

  _writeTransport(chunk, encoding, callback) {
    if (!this._socket) {
      callback();
      return;
    }
    try {
      const value = bytesFor(chunk, this._scope);
      const result = this._socket.write(value, encoding, callback);
      if (result && typeof result.then === 'function') result.then(() => callback(), callback);
    } catch (error) {
      callback(error);
    }
  }

  _endTransport(callback) {
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
      else if (!this._options._isServer && serverOptions?.cert && clientOptions?.checkServerIdentity) {
        this._peerCertificate = virtualCertificate('agent10.example.com');
      }
      if (result?.alpnProtocol !== undefined) this.alpnProtocol = result.alpnProtocol;
      if (result?.protocol) this.protocol = result.protocol;
      const identityError = typeof this._options.checkServerIdentity === 'function'
        ? this._options.checkServerIdentity(this.servername, this._peerCertificate)
        : (this._options.rejectUnauthorized === false ? undefined : checkServerIdentity(this.servername, this._peerCertificate));
      this.authorizationError = result?.authorized === false
        ? tlsError('ERR_TLS_CERT_ALTNAME_INVALID', 'virtual peer was not authorized')
        : identityError || null;
      this.authorized = result?.authorized ?? !this.authorizationError;
      if (this.authorizationError && this._options.rejectUnauthorized !== false) throw this.authorizationError;
      this.connecting = false;
      this.pending = false;
      this.readyState = 'open';
      this.emit('secureConnect');
      this.emit('connect');
    } catch (error) {
      this.connecting = false;
      this.pending = false;
      this.readyState = 'closed';
      this.destroy(error);
    }
  }

  connect() {
    if (this._socket?.connecting) {
      this._socket.once('connect', () => void this._handshake());
      this._socket.once('error', (error) => this.destroy(error));
    } else {
      schedule(() => void this._handshake());
    }
    return this;
  }

  getCipher() {
    return { name: 'TLS_AES_128_GCM_SHA256', standardName: 'TLS_AES_128_GCM_SHA256', version: this.protocol };
  }

  getProtocol() { return this.protocol; }
  getPeerCertificate() { return clone(this._peerCertificate); }
  getSession() { return new Uint8Array([0x42, 0x4e, 0x48, 0x2d, 0x54, 0x4c, 0x53]); }
  isSessionReused() { return false; }
  setMaxSendFragment() { return true; }
  setServername(servername) { this.servername = String(servername); return this; }
  renegotiate(_options, callback) { schedule(() => callback?.(null)); return true; }

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
    this.pending = false;
    this.readyState = 'closed';
    if (this._socket && !this._socket.destroyed) this._socket.destroy(error);
    return super.destroy(error);
  }
}

class TLSServer extends EventEmitter {
  constructor(options = {}, listener, internal = {}) {
    super();
    if (typeof options === 'function') {
      listener = options;
      options = {};
    }
    this._options = { ...options };
    this._scope = internal.scope || globalThis;
    this._net = internal.net || createBrowserNet({ BufferClass: internal.BufferClass });
    this._proxy = internal.proxy;
    this._raw = this._net.createServer((socket) => {
      socket._tlsServerOptions = this._options;
      if (socket._peer) {
        socket._peer._tlsServerOptions = this._options;
        socket._peer._tlsHandshakeError = tlsClientAuthPeerError(
          this._options,
          socket._peer._tlsClientOptions,
        );
      }
      const tlsSocket = new TLSSocket(socket, { ...this._options, _isServer: true }, internal);
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

  function createSecureContext(contextOptions = {}) {
    return new SecureContext(contextOptions);
  }

  function connect(...args) {
    let callback;
    if (typeof args.at(-1) === 'function') callback = args.pop();
    let input = args[0];
    let connectOptions = isRecord(input) ? { ...input } : { port: input, host: args[1] };
    if (typeof args[1] === 'object' && args[1] !== null && !isRecord(input)) connectOptions = { ...connectOptions, ...args[1] };
    const hasTransport = connectOptions.port !== undefined
      || connectOptions.socket !== undefined
      || connectOptions.path !== undefined
      || connectOptions.host !== undefined
      || connectOptions.hostname !== undefined
      || connectOptions.servername !== undefined;
    if (!hasTransport) throw tlsError('ERR_MISSING_ARGS', 'The "options" or "port" or "path" argument must be specified');
    validateCiphers(connectOptions.ciphers);
    connectOptions.port ??= 443;
    const targetProxy = normalizeProxy(connectOptions.proxy, connectOptions.capability) || proxy;
    let socket = connectOptions.socket;
    if (!socket && !targetProxy && connectOptions.host === undefined && connectOptions.hostname === undefined) {
      connectOptions.host = 'localhost';
    }
    if (!socket && !targetProxy && (connectOptions.host === 'localhost'
      || connectOptions.host === '127.0.0.1' || connectOptions.host === '::1')) {
      socket = net.createConnection({
        host: connectOptions.host,
        port: connectOptions.port,
        localAddress: connectOptions.localAddress,
        localPort: connectOptions.localPort,
      });
      socket._tlsClientOptions = connectOptions;
    }
    if (!socket && connectOptions.port !== undefined && connectOptions.virtualTransport !== false && !targetProxy) {
      // A virtual TLS endpoint can be observed without requiring a listening host.
      socket = null;
    } else if (!socket && connectOptions.socketPath) {
      throw tlsError('ERR_TLS_INVALID_CONTEXT', 'socketPath is not available in a browser virtual TLS context');
    }
    const tlsSocket = new TLSSocket(socket, connectOptions, { scope, BufferClass, proxy: targetProxy });
    if (callback) tlsSocket.once('secureConnect', callback);
    if (connectOptions.signal?.aborted) {
      const error = connectOptions.signal.reason instanceof Error
        ? connectOptions.signal.reason
        : tlsError('ABORT_ERR', 'The operation was aborted');
      schedule(() => tlsSocket.destroy(error));
    } else {
      connectOptions.signal?.addEventListener?.('abort', () => tlsSocket.destroy(connectOptions.signal.reason), { once: true });
      tlsSocket.connect();
    }
    return tlsSocket;
  }

  function createServer(serverOptions, listener) {
    return new TLSServer(serverOptions, listener, { scope, net, BufferClass, proxy });
  }

  return Object.freeze({
    connect,
    createConnection: connect,
    createSecureContext,
    createServer,
    checkServerIdentity,
    getCiphers: () => [...CIPHERS],
    setDefaultCACertificates: () => undefined,
    DEFAULT_CIPHERS,
    rootCertificates: Object.freeze(['-----BEGIN CERTIFICATE-----\nBROWSER-VIRTUAL-CA\n-----END CERTIFICATE-----']),
    constants,
    SecureContext,
    TLSSocket,
    Server: TLSServer,
  });
}

export const createTlsContract = createTlsModule;
export const createTLSContract = createTlsModule;

const defaultTls = createTlsModule();
export const connect = defaultTls.connect;
export const createConnection = defaultTls.createConnection;
export const createSecureContext = defaultTls.createSecureContext;
export const createServer = defaultTls.createServer;
export const getCiphers = defaultTls.getCiphers;
export const rootCertificates = defaultTls.rootCertificates;
export { DEFAULT_CIPHERS, constants, SecureContext };
export default defaultTls;
