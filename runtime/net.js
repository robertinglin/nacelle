import { EventEmitter } from './events.js';

const servers = new Map();
const boundSockets = new Map();
let nextPort = 50000;

function getNextPort() {
  nextPort += 1;
  if (nextPort > 60000) nextPort = 50000;
  return nextPort;
}

export function isIP(input) {
  if (typeof input !== 'string') return 0;
  if (input.includes(':')) return isIP(input) === 4 ? 6 : 4; // rough
  return input === '127.0.0.1' || input === 'localhost' ? 4 : 0;
}

export function isIPv4(input) {
  return typeof input === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(input) ? input : false;
}

export function isIPv6(input) {
  return typeof input === 'string' && input.includes(':') ? input : false;
}

class Socket extends EventEmitter {
  constructor(options) {
    super();
    this.connecting = true;
    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    this.localPort = 0;
    this.localAddress = '127.0.0.1';
    this.remotePort = 0;
    this.remoteAddress = '127.0.0.1';
    this.remoteFamily = 'IPv4';
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._timeout = null;
    this._timeoutMs = 0;
    this._timer = null;
    this._buffer = [];
    this._endCalled = false;

    const self = this;
    // Emit lookup shortly
    setTimeout(() => {
      if (!self.destroyed) {
        self.emit('lookup', 0, 'localhost', 4);
      }
    }, 0);

    // Simulate connection shortly
    setTimeout(() => {
      if (self.destroyed) return;
      self.connecting = false;
      const targetPort = options?.port || 0;
      const server = servers.get(targetPort);
      if (server && !self.destroyed) {
        try {
          server.emit('connection', self);
        } catch (e) {
          // ignore server errors
        }
      }
      if (!self.destroyed) {
        self.emit('connect');
        self.emit('ready');
      }
    }, 10);
  }

  connect(options, connectListener) {
    if (typeof options === 'function') {
      connectListener = options;
      options = {};
    }
    if (connectListener) this.on('connect', connectListener);
    return this;
  }

  setTimeout(timeout, callback) {
    this.clearTimeout();
    this._timeoutMs = timeout || 0;
    if (this._timeoutMs > 0) {
      this._timeout = setTimeout(() => {
        this.emit('timeout');
        if (callback) callback.call(this);
      }, this._timeoutMs);
    }
    if (callback) this.on('timeout', callback);
    return this;
  }

  clearTimeout() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
    this._timeoutMs = 0;
    return this;
  }

  setEncoding() {
    return this;
  }

  resume() {
    return this;
  }

  pause() {
    return this;
  }

  end(data, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (data && typeof data !== 'string' && !(data instanceof Uint8Array) && !(data instanceof Buffer)) {
      data = String(data);
    }
    if (data) {
      this.write(data, encoding, callback);
    }
    this._endCalled = true;
    this.writable = false;
    const self = this;
    setTimeout(() => {
      if (!self.destroyed) {
        self.emit('end');
        self.emit('finish');
      }
    }, 0);
    return this;
  }

  write(data, encoding, callback) {
    if (this.destroyed || !this.writable) {
      const err = new Error('write after end');
      err.code = 'ERR_STREAM_WRITE_AFTER_END';
      setTimeout(() => this.emit('error', err), 0);
      return false;
    }
    if (data) this.bytesWritten += typeof data === 'string' ? data.length : (data.length || 1);
    if (callback) setTimeout(() => callback(), 0);
    return true;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.connecting = false;
    this.readable = false;
    this.writable = false;
    this.clearTimeout();
    if (error) {
      setTimeout(() => this.emit('error', error), 0);
    }
    setTimeout(() => this.emit('close', !!error), 0);
    return this;
  }

  address() {
    return {
      port: this.localPort || this.remotePort || 0,
      family: this.remoteFamily || 'IPv4',
      address: this.localAddress || this.remoteAddress || '127.0.0.1',
    };
  }

  setKeepAlive(enable, initialDelay) {
    return this;
  }

  setNoDelay(noDelay) {
    return this;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

class Server extends EventEmitter {
  constructor(connectionListener, connectionListener2) {
    super();
    if (typeof connectionListener === 'function') {
      this.on('connection', connectionListener);
    }
    if (typeof connectionListener2 === 'function') {
      this.on('connection', connectionListener2);
    }
    this.listening = false;
    this._port = 0;
  }

  listen(port, host, backlog, callback) {
    let targetPort = 0;
    let targetHost = '0.0.0.0';
    let cb = callback;

    if (typeof port === 'function') {
      cb = port;
      port = 0;
    } else if (typeof host === 'function') {
      cb = host;
      host = undefined;
    } else if (typeof backlog === 'function') {
      cb = backlog;
      backlog = undefined;
    }
    if (typeof port === 'object' && port !== null) {
      const opts = port;
      targetPort = opts.port || 0;
      targetHost = opts.host || opts.address || '0.0.0.0';
      targetPort = targetPort || opts.port || 0;
    } else {
      targetPort = Number(port) || 0;
      if (host) targetHost = String(host);
    }

    if (targetPort === 0) {
      targetPort = getNextPort();
    }
    this._port = targetPort;
    this.listening = true;
    servers.set(targetPort, this);

    const self = this;
    setTimeout(() => {
      if (self.listening && cb) cb.call(self);
      self.emit('listening');
    }, 0);
    return this;
  }

  address() {
    if (!this.listening) return null;
    return {
      port: this._port,
      family: 'IPv4',
      address: '0.0.0.0',
    };
  }

  close(callback) {
    if (!this.listening) return this;
    this.listening = false;
    servers.delete(this._port);
    const self = this;
    setTimeout(() => {
      self.emit('close');
      if (callback) callback.call(self);
    }, 0);
    return this;
  }

  getConnections(callback) {
    if (callback) callback(new Error('getConnections is simulated'), 0);
    return 0;
  }
}

function connect(options, connectListener) {
  if (typeof options === 'function') {
    connectListener = options;
    options = {};
  }
  options = options || {};
  const socket = new Socket(options);
  if (connectListener) socket.on('connect', connectListener);
  socket.connect(options, connectListener);
  return socket;
}

function createConnection(options, connectListener) {
  return connect(options, connectListener);
}

function createServer(connectionListener, connectionListener2) {
  return new Server(connectionListener, connectionListener2);
}

function setDefaultAutoSelectFamily(attemptTimeout, value) {
  // No-op in simulated environment
  return undefined;
}

function setDefaultAutoSelectFamilyAttemptTimeout(timeout) {
  // No-op
}

function getDefaultAutoSelectFamilyAttemptTimeout() {
  return 250;
}

export default {
  connect,
  createConnection,
  createServer,
  Socket,
  Server,
  isIP,
  isIPv4,
  isIPv6,
  BlockList: class BlockList { constructor() { throw new Error('BlockList is unavailable'); } },
  setDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout,
  getDefaultAutoSelectFamilyAttemptTimeout,
};

export {
  connect,
  createConnection,
  createServer,
  Socket,
  Server,
  isIP,
  isIPv4,
  isIPv6,
  BlockList,
  setDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout,
  getDefaultAutoSelectFamilyAttemptTimeout,
};
