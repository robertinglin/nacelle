/*
 * This source is intentionally self-contained. It is placed in a Blob URL by
 * the browser Worker adapter, so it cannot import the host runtime or a host
 * process implementation.
 */
export const PROCESS_WORKER_SOURCE = String.raw`(() => {
  const CONTROL = 'bnh-process-control';
  const USER = 'bnh-user-ipc';
  let control;
  let user;
  let key;
  let identity;
  let terminalSent = false;
  let disconnected = false;
  let userSequence = 0;
  let lastUserSequence = 0;
  let proxySequence = 0;
  let exitCode = 0;
  let signalCode = null;
  const processExitSignal = {};
  const remoteHandles = new Map();
  const proxyRequests = new Map();

  function errorRecord(error) {
    if (!error) return null;
    return { name: error.name || 'Error', message: String(error.message || error), stack: error.stack || null, code: error.code || null };
  }

  function uncaughtWorkerError(event) {
    if (terminalSent) return true;
    const error = event?.error || Object.assign(new Error(event?.message || 'worker failed'), {
      name: event?.name || 'Error',
      stack: event?.error?.stack || event?.stack || null,
    });
    error.code ||= 'ERR_WORKER_EXCEPTION';
    finish('uncaught-exception', 1, null, error);
    return true;
  }

  function outputText(value) {
    if (typeof value === 'string') return value;
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      return new TextDecoder().decode(Uint8Array.from(value));
    }
    return String(value);
  }

  function sendControl(type, fields = {}) {
    if (!control) return;
    control.postMessage({ channel: CONTROL, key, runId: identity.runId, childId: identity.childId, type, ...fields });
  }

  function sendUserFrame(type, payload) {
    user.postMessage({ channel: USER, runId: identity.runId, childId: identity.childId, direction: 'child-to-parent', sequence: ++userSequence, type, payload });
  }

  function requestProxy(operation, request) {
    const requestId = String(identity.childId) + '-proxy-' + (++proxySequence);
    return new Promise((resolve, reject) => {
      proxyRequests.set(requestId, { resolve, reject });
      sendUserFrame('message', { __bnhProxyRequest: { requestId, operation, request } });
    });
  }

  function createRemoteHandle(descriptor) {
    if (!descriptor?.id) return undefined;
    const existing = remoteHandles.get(descriptor.id);
    if (existing) return existing;
    const listeners = new Map();
    const request = (operation, fields = {}) => sendUserFrame('handle-request', { handleId: descriptor.id, operation, ...fields });
    const proxy = {
      on(name, listener) {
        const set = listeners.get(name) || new Set();
        if (!set.size) request('subscribe', { event: name });
        set.add(listener);
        listeners.set(name, set);
        return proxy;
      },
      once(name, listener) {
        const wrapped = (...args) => { proxy.off(name, wrapped); listener(...args); };
        return proxy.on(name, wrapped);
      },
      off(name, listener) {
        const set = listeners.get(name);
        if (!set) return proxy;
        set.delete(listener);
        if (!set.size) { listeners.delete(name); request('unsubscribe', { event: name }); }
        return proxy;
      },
      removeListener(name, listener) { return proxy.off(name, listener); },
      removeAllListeners(name) {
        if (name === undefined) {
          for (const event of listeners.keys()) request('unsubscribe', { event });
          listeners.clear();
        } else if (listeners.delete(name)) request('unsubscribe', { event: name });
        return proxy;
      },
      listenerCount(name) { return listeners.get(name)?.size || 0; },
      close(callback) {
        if (callback) proxy.once('close', callback);
        request('call', { method: 'close' });
        return proxy;
      },
      destroy(...args) { request('call', { method: 'destroy', args }); return proxy; },
      emit(name, ...args) {
        for (const listener of [...(listeners.get(name) || [])]) listener(...args);
        return listeners.has(name);
      },
    };
    Object.defineProperty(proxy, '__bnhHandleId', { value: descriptor.id });
    remoteHandles.set(descriptor.id, proxy);
    return proxy;
  }

  function createRemoteTransport(descriptor, handle) {
    const request = (action, fields = {}) => requestProxy('send', {
      transportId: descriptor.id,
      action,
      ...fields,
    });
    const transport = {
      virtualTls: Boolean(descriptor.virtualTls),
      on(name, listener) { handle.on(name, listener); return transport; },
      once(name, listener) { handle.once(name, listener); return transport; },
      off(name, listener) { handle.off(name, listener); return transport; },
      removeListener(name, listener) { handle.removeListener(name, listener); return transport; },
      write(bytes, callback) {
        const operation = request('write', { bytes });
        operation.then(() => callback?.(), (error) => callback?.(error));
        return true;
      },
      end(callback) {
        const operation = request('end');
        operation.then(() => callback?.(), (error) => callback?.(error));
        return transport;
      },
      destroy(error) {
        void request('destroy', { error: error ? { name: error.name, message: error.message, code: error.code } : undefined });
        handle.close?.();
        return transport;
      },
    };
    return transport;
  }

  function makeEmitter() {
    const listeners = new Map();
    const emitter = {
      on(name, listener) {
        if (name !== 'newListener') this.emit('newListener', name, listener);
        const set = listeners.get(name) || [];
        set.push(listener);
        listeners.set(name, set);
        return this;
      },
      addListener(name, listener) { return this.on(name, listener); },
      prependListener(name, listener) {
        const set = listeners.get(name) || [];
        set.unshift(listener);
        listeners.set(name, set);
        return this;
      },
      once(name, listener) {
        const wrapped = (...args) => { this.off(name, wrapped); listener(...args); };
        wrapped.listener = listener;
        return this.on(name, wrapped);
      },
      prependOnceListener(name, listener) {
        const wrapped = (...args) => { this.off(name, wrapped); listener(...args); };
        wrapped.listener = listener;
        return this.prependListener(name, wrapped);
      },
      off(name, listener) {
        const set = listeners.get(name);
        if (!set) return this;
        const index = [...set].reverse().findIndex((candidate) => candidate === listener || candidate.listener === listener);
        if (index >= 0) set.splice(set.length - 1 - index, 1);
        if (!set.length) listeners.delete(name);
        return this;
      },
      removeListener(name, listener) { return this.off(name, listener); },
      removeAllListeners(name) {
        if (name === undefined) listeners.clear();
        else listeners.delete(name);
        return this;
      },
      emit(name, ...args) {
        const set = listeners.get(name);
        if (!set?.length) return false;
        for (const listener of [...set]) listener(...args);
        return true;
      },
      listenerCount(name) { return listeners.get(name)?.length || 0; },
      listeners(name) { return (listeners.get(name) || []).map((listener) => listener.listener || listener); },
      rawListeners(name) { return [...(listeners.get(name) || [])]; },
      eventNames() { return [...listeners.keys()]; },
      getMaxListeners() { return 10; },
      setMaxListeners() { return this; },
    };
    emitter.off = emitter.removeListener;
    return emitter;
  }

  function installProcessContract(process) {
    let uid = 1000;
    let gid = 1000;
    let mask = 0o022;
    const invalidType = (value) => {
      const received = value === null ? 'null' : value?.constructor?.name || typeof value;
      const error = new TypeError('The "id" argument must be one of type number or string. Received ' +
        (received === 'Object' ? 'an instance of Object' : 'type ' + received));
      error.code = 'ERR_INVALID_ARG_TYPE';
      return error;
    };
    const credential = (kind, value) => {
      const error = new Error(kind + ' identifier does not exist: ' + value);
      error.code = 'ERR_UNKNOWN_CREDENTIAL';
      return error;
    };
    const normalize = (value, kind) => {
      if (typeof value !== 'number' && typeof value !== 'string') throw invalidType(value);
      if (typeof value === 'string' && !/^[0-9]+$/.test(value)) throw credential(kind, value);
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
        const error = new RangeError('invalid ' + kind.toLowerCase() + ' identifier: ' + value);
        error.code = 'ERR_INVALID_ARG_VALUE';
        throw error;
      }
      return numeric;
    };
    process.config ||= { variables: { v8_enable_i18n_support: 1, openssl_quic: false, asan: 0, node_module_version: 127, napi_build_version: '10', node_use_amaro: true }, target_defaults: { default_configuration: 'Release' } };
    process.features ||= {
      inspector: false,
      debug: false,
      uv: false,
      ipv6: true,
      openssl_is_boringssl: false,
      tls_alpn: true,
      tls_sni: true,
      tls_ocsp: true,
      tls: true,
      cached_builtins: false,
      require_module: true,
      typescript: 'strip',
    };
    process.execPath ||= '/browser/node';
    process.argv0 ||= 'node';
    process.version ||= 'v22.23.2';
    process.release ||= { name: 'node', lts: 'Jod' };
    process.versions ||= { node: '22.23.2', modules: '127', napi: '10', v8: '12.4.254.21-node.56', webcontainer: '1.0.0' };
    process.umask ||= (value) => {
      const previous = mask;
      if (value === undefined) return previous;
      if (typeof value === 'string' && !/^[0-7]+$/.test(value)) {
        const error = new TypeError('The "mask" argument must be a valid octal string');
        error.code = 'ERR_INVALID_ARG_VALUE';
        throw error;
      }
      if (typeof value !== 'number' && typeof value !== 'string') {
        const error = new TypeError('The "mask" argument must be a number or an octal string');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      const numeric = typeof value === 'string' ? Number.parseInt(value, 8) : value;
      if (!Number.isInteger(numeric) || numeric < 0) {
        const error = new RangeError('The "mask" argument must be a non-negative integer');
        error.code = 'ERR_INVALID_ARG_VALUE';
        throw error;
      }
      mask = numeric & 0o777;
      return previous;
    };
    process.dlopen ||= (_module, filename) => {
      if (process.execArgv?.some((argument) => String(argument) === '--no-addons')) {
        const error = new Error('Cannot load native addon because loading addons is disabled.');
        error.code = 'ERR_DLOPEN_DISABLED';
        throw error;
      }
      const error = new Error('Cannot load native addon ' + filename + ': native addons are unavailable in the browser runtime');
      error.code = 'ERR_DLOPEN_FAILED';
      error.path = String(filename);
      error.boundary = 'native-addons';
      error.status = 'unsupported-boundary';
      throw error;
    };
    for (const [name, kind] of [['uid', 'User'], ['euid', 'User'], ['gid', 'Group'], ['egid', 'Group']]) {
      process['get' + name] ||= () => name === 'uid' || name === 'euid' ? uid : gid;
      process['set' + name] ||= (value) => {
        const numeric = normalize(value, kind);
        if (name === 'uid' || name === 'euid') uid = numeric;
        else gid = numeric;
      };
    }
  }

  function finish(kind, code = exitCode, signal = signalCode, error = null, forced = false) {
    if (terminalSent) return;
    terminalSent = true;
    exitCode = code;
    signalCode = signal;
    sendControl('terminal', {
      status: kind === 'natural' || kind === 'exit' ? 'exited' : 'failed',
      kind,
      code,
      signal,
      forced,
      lastUserSequence: userSequence,
      error: errorRecord(error),
    });
    // Keep the user port alive for one turn. MessagePort has independent
    // delivery from the control port, so closing it synchronously can discard
    // user messages that were accepted before the terminal frame.
    setTimeout(() => { user?.close(); control?.close(); self.close(); }, 0);
  }

  function start(message) {
    control = message.controlPort;
    user = message.userPort;
    key = message.key;
    identity = message.identity;
    const process = makeEmitter();
    const pendingMessages = [];
    let pendingMessageFlushQueued = false;
    const flushPendingMessages = () => {
      pendingMessageFlushQueued = false;
      if (process.listenerCount('message') === 0) return;
      for (const [value, handle] of pendingMessages.splice(0)) emitProcess('message', value, handle);
    };
    process.on('newListener', (name) => {
      if (name !== 'message' || pendingMessageFlushQueued) return;
      pendingMessageFlushQueued = true;
      queueMicrotask(flushPendingMessages);
    });
    installProcessContract(process);
    const emitProcess = (name, ...args) => {
      try {
        return process.emit(name, ...args);
      } catch (error) {
        if (error === processExitSignal) return true;
        throw error;
      }
    };
    process.stdin = makeEmitter();
    process.stdin.readable = true;
    process.stdin.isTTY = false;
    process.stdin.push = (value) => {
      if (value === null) process.stdin.emit('end');
      else process.stdin.emit('data', value);
      return true;
    };
    process.stdin.resume = () => process.stdin;
    process.stdin.pause = () => process.stdin;
    process.stdin.pipe = (destination) => {
      process.stdin.on('data', (value) => destination.write?.(value));
      process.stdin.once('end', () => destination.end?.());
      process.stdin.resume();
      return destination;
    };
    if (typeof self.addEventListener === 'function') self.addEventListener('error', uncaughtWorkerError);
    else self.onerror = uncaughtWorkerError;
    Object.assign(process, {
      ...identity,
      execArgv: [...(message.execArgv || [])],
      env: { ...identity.env },
      argv: [...identity.argv],
      connected: true,
      exitCode: 0,
      __bnhProxyRequest: requestProxy,
      __bnhNetworkEvent(event) { sendControl('network', { event }); },
      cwd: () => identity.cwd,
      chdir: (value) => {
        const source = String(value);
        const base = String(identity.cwd || '/node');
        const absolute = source.startsWith('/') ? source : base.replace(/\/+$/, '') + '/' + source;
        const parts = [];
        for (const part of absolute.split('/')) {
          if (!part || part === '.') continue;
          if (part === '..') { parts.pop(); continue; }
          parts.push(part);
        }
        identity.cwd = '/' + parts.join('/');
      },
      send(value, transferList, callback) {
        if (typeof transferList === 'function') { callback = transferList; transferList = undefined; }
        if (disconnected) {
          const error = Object.assign(new Error('IPC channel is closed'), { code: 'ERR_IPC_CLOSED' });
          if (callback) { queueMicrotask(() => callback(error)); return false; }
          throw error;
        }
        let handle;
        if (transferList !== undefined && !Array.isArray(transferList)) {
          handle = transferList.__bnhHandleId ? { id: transferList.__bnhHandleId, kind: 'virtual' } : undefined;
          if (!handle) {
            const error = Object.assign(new Error('virtual process handles must originate from a browser-native IPC message'), { code: 'ERR_UNSUPPORTED_BROWSER_BOUNDARY' });
            if (callback) { queueMicrotask(() => callback(error)); return false; }
            throw error;
          }
          transferList = undefined;
        }
        const frame = { channel: USER, runId: identity.runId, childId: identity.childId, direction: 'child-to-parent', sequence: ++userSequence, type: 'message', payload: value, ...(handle ? { handle } : {}) };
        try { user.postMessage(frame, transferList); } catch (error) {
          const wrapped = Object.assign(new Error('message could not be structured-cloned'), { code: 'ERR_IPC_SERIALIZATION', cause: error });
          if (callback) { queueMicrotask(() => callback(wrapped)); return false; }
          throw wrapped;
        }
        callback?.(null);
        return true;
      },
      __bnhSendInternal(value) {
        if (disconnected) return false;
        try {
          user.postMessage({ channel: USER, runId: identity.runId, childId: identity.childId, direction: 'child-to-parent', type: 'message', internal: true, payload: value });
          return true;
        } catch {
          return false;
        }
      },
      disconnect() {
        if (disconnected) return false;
        disconnected = true;
        process.connected = false;
        sendControl('child-disconnect');
        emitProcess('disconnect');
        return true;
      },
      kill: (signal = 'SIGTERM') => { sendControl('child-signal-request', { signal }); return true; },
      exit(code = 0) {
        exitCode = Number(code) || 0;
        process.exitCode = exitCode;
        process.emit('exit', exitCode);
        finish('exit', exitCode);
        throw processExitSignal;
      },
    });
    // A child identity is structured-cloned into this worker. Preserve the
    // runtime marker even when a caller supplied an older identity object.
    process.versions ||= {};
    process.versions.webcontainer = '1.0.0';
    process.stdout = {
      isTTY: false,
      _host: null,
      _isStdio: true,
      _parent: null,
      _pendingData: null,
      _pendingEncoding: '',
      write(value, encoding, callback) {
        if (typeof encoding === 'function') callback = encoding;
        sendControl('output', { stream: 'stdout', value: outputText(value) });
        callback?.();
        return true;
      },
    };
    process.stderr = {
      isTTY: false,
      write(value, encoding, callback) {
        if (typeof encoding === 'function') callback = encoding;
        sendControl('output', { stream: 'stderr', value: outputText(value) });
        callback?.();
        return true;
      },
    };

    control.onmessage = (event) => {
      const frame = event.data;
      if (frame?.channel !== CONTROL || frame.key !== key || frame.runId !== identity.runId || frame.childId !== identity.childId) return;
      if (frame.type === 'disconnect') {
        if (!disconnected) { disconnected = true; process.connected = false; emitProcess('disconnect'); }
      } else if (frame.type === 'signal') {
        if (terminalSent) return;
        const handled = emitProcess(frame.signal);
        sendControl('signal-result', { signal: frame.signal, handled });
        if (!handled) finish('signal', null, frame.signal, null);
      }
    };
    user.onmessage = (event) => {
      const frame = event.data;
      if (frame?.channel !== USER || frame.runId !== identity.runId || frame.childId !== identity.childId || frame.direction !== 'parent-to-child') return;
      if (!Number.isInteger(frame.sequence) || frame.sequence <= lastUserSequence) return;
      lastUserSequence = frame.sequence;
      if (frame.type === 'handle-event') {
        const target = remoteHandles.get(frame.payload?.handleId);
        if (target) target.emit(frame.payload.event, ...(frame.payload.args || []).map((value) => value?.id ? createRemoteHandle(value) : value));
      } else if (frame.type === 'message') {
        if (frame.payload?.__bnhProxyResponse) {
          const response = frame.payload;
          const pending = proxyRequests.get(response.requestId);
          if (!pending) return;
          proxyRequests.delete(response.requestId);
          if (response.error) {
            pending.reject(Object.assign(new Error(response.error.message || 'proxy request failed'), response.error));
          } else {
            const result = response.result;
            if (result?.__bnhTransport && frame.handle) {
              result.transport = createRemoteTransport(result.__bnhTransport, createRemoteHandle(frame.handle));
              delete result.__bnhTransport;
            }
            if (result?.__bnhResponse && typeof Response === 'function') {
              pending.resolve(new Response(result.body || null, { status: result.status, statusText: result.statusText, headers: result.headers }));
            } else {
              pending.resolve(result);
            }
          }
        } else if (frame.payload?.__bnhWorkerStdin) {
          process.stdin.push(frame.payload.value);
        } else if (frame.payload?.__bnhWorkerStdinEnd) {
          process.stdin.push(null);
        } else {
          const value = frame.payload;
          const handle = createRemoteHandle(frame.handle);
          if (process.listenerCount('message') === 0) pendingMessages.push([value, handle]);
          else emitProcess('message', value, handle);
        }
      }
    };
    control.start?.();
    user.start?.();

    let run;
    try {
      run = (0, eval)('(' + message.runSource + ')');
      if (typeof run !== 'function') throw new TypeError('worker bootstrap did not produce a function');
    } catch (error) {
      error = Object.assign(new Error(error.message || String(error)), { name: error.name || 'Error', stack: error.stack, code: 'ERR_PROCESS_BOOTSTRAP' });
      finish('bootstrap', null, null, error);
      return;
    }
    sendControl('ready');
    const vfs = message.vfs;
    const output = {
      stdout: (value) => process.stdout.write(value),
      stderr: (value) => process.stderr.write(value),
    };
    const context = { process, ipc: process, stdout: output.stdout, stderr: output.stderr, vfs, signal: process, networkPort: message.networkPort };
    Promise.resolve().then(() => run(context)).then(() => {
      if (!terminalSent) finish('natural', process.exitCode || 0, null);
    }, (error) => {
      error.code ||= 'ERR_WORKER_EXCEPTION';
      finish('rejection', 1, null, error);
    });
  }

  self.onmessage = (event) => {
    if (event.data?.type !== 'bnh-process-init' || control) return;
    try { start(event.data); } catch (error) { finish('bootstrap', null, null, error); }
  };
})();`;

export function createProcessWorkerSource() {
  return PROCESS_WORKER_SOURCE;
}
