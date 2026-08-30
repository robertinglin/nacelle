import { UnsupportedWebCapabilityError } from './errors.js';

const wasmModuleURLs = new WeakMap();

function requireWebAssembly(globalObject) {
  if (!globalObject.WebAssembly) {
    throw new UnsupportedWebCapabilityError('WebAssembly', 'the WebAssembly Web API is not available');
  }
  return globalObject.WebAssembly;
}

function receivedValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'number' || typeof value === 'boolean') return `type ${typeof value} (${value})`;
  if (typeof value === 'bigint') return `type bigint (${value}n)`;
  if (typeof value === 'symbol') return `type symbol (${String(value)})`;
  return `an instance of ${value?.constructor?.name || typeof value}`;
}

function invalidStreamingSource(value) {
  const error = new TypeError(
    'The "source" argument must be an instance of Response or an Promise resolving to Response. '
      + `Received ${receivedValue(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function isResponse(value, globalObject) {
  return typeof globalObject.Response === 'function' && value instanceof globalObject.Response;
}

function isPromiseLike(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function responseHeader(response, name) {
  if (typeof response.headers?.get === 'function') return response.headers.get(name);
  const headers = response.headers || {};
  return headers[name] ?? headers[name.toLowerCase()];
}

function webAssemblyResponseError(response) {
  const status = Number(response.status);
  if (Number.isFinite(status) && (status < 200 || status >= 300)) {
    const error = new TypeError(`WebAssembly response has status code ${status}`);
    error.code = 'ERR_WEBASSEMBLY_RESPONSE';
    return error;
  }
  const mimeType = responseHeader(response, 'Content-Type');
  if (mimeType !== 'application/wasm') {
    const error = new TypeError(
      `WebAssembly response has unsupported MIME type '${mimeType || ''}'`,
    );
    error.code = 'ERR_WEBASSEMBLY_RESPONSE';
    return error;
  }
  return null;
}

function streamingCompileError(wasm, error) {
  if (error?.name !== 'CompileError' || String(error.message).startsWith('WebAssembly.compileStreaming():')) {
    return error;
  }
  const message = `WebAssembly.compileStreaming(): ${error.message}`;
  try {
    Object.defineProperty(error, 'message', { configurable: true, value: message });
  } catch {
    const CompileError = wasm.CompileError || Error;
    return new CompileError(message);
  }
  return error;
}

function runtimePromise(promise, PromiseClass) {
  try {
    Object.defineProperty(promise, 'constructor', {
      configurable: true,
      value: PromiseClass,
    });
  } catch {
    // Native promises may be non-extensible in restricted browser realms.
  }
  if (promise.constructor === PromiseClass) return promise;
  return new Proxy(promise, {
    get(target, property, receiver) {
      if (property === 'constructor') return PromiseClass;
      if (property === 'then' || property === 'catch' || property === 'finally') {
        return target[property].bind(target);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function compileFromResponse(wasm, globalObject, method, response, args) {
  const PromiseClass = globalObject.Promise || Promise;
  const nativeMethod = wasm[method];
  const responseError = webAssemblyResponseError(response);
  if (responseError) return runtimePromise(PromiseClass.reject(responseError), PromiseClass);
  const contentLengthHeader = responseHeader(response, 'Content-Length');
  const hasContentLength = contentLengthHeader !== null && contentLengthHeader !== undefined
    && contentLengthHeader !== '';
  if (response.body?.[Symbol.for('bnh.filehandle.webstream')] !== true
    && response.__bnhTerminated !== true) {
    const result = PromiseClass.resolve(Reflect.apply(nativeMethod, wasm, [response, ...args])).then((value) => {
      if (method === 'compileStreaming' && response.__bnhURL && value && typeof value === 'object') {
        wasmModuleURLs.set(value, response.__bnhURL);
      }
      return value;
    });
    return runtimePromise(result, PromiseClass);
  }
  if (typeof response.arrayBuffer !== 'function') {
    return runtimePromise(PromiseClass.reject(new TypeError('WebAssembly response body is unavailable')), PromiseClass);
  }
  return runtimePromise(PromiseClass.resolve(response.arrayBuffer()).then((bytes) => {
    try {
      const contentLength = hasContentLength ? Number(contentLengthHeader) : null;
      if (Number.isInteger(contentLength) && contentLength >= 0 && bytes.byteLength !== contentLength) {
        throw new TypeError('terminated');
      }
      const module = new wasm.Module(bytes);
      if (method === 'compileStreaming' && response.__bnhURL) wasmModuleURLs.set(module, response.__bnhURL);
      const result = method === 'compileStreaming' ? module : new wasm.Instance(module, args[0]);
      return result;
    } catch (error) {
      throw streamingCompileError(wasm, error);
    }
  }).catch((error) => {
    throw streamingCompileError(wasm, error);
  }), PromiseClass);
}

function rewriteWasmStack(error, url) {
  if (!url || typeof error?.stack !== 'string') return error;
  const stack = error.stack.replace(
    /^(\s*)at wasm:\/\/wasm\/[^:\n]+:(wasm-function\[\d+\]:0x[0-9a-f]+)$/m,
    `$1at ${url}:$2`,
  );
  if (stack !== error.stack) {
    try { Object.defineProperty(error, 'stack', { configurable: true, value: stack }); } catch { /* ignore */ }
  }
  return error;
}

function createInstanceConstructor(wasm) {
  function Instance(module, imports) {
    const instance = new wasm.Instance(module, imports);
    const url = wasmModuleURLs.get(module);
    if (!url) return instance;
    const exports = {};
    for (const name of Object.keys(instance.exports)) {
      const value = instance.exports[name];
      Object.defineProperty(exports, name, {
        configurable: true,
        enumerable: true,
        value: typeof value === 'function'
          ? (...args) => {
              try { return Reflect.apply(value, instance, args); }
              catch (error) { throw rewriteWasmStack(error, url); }
            }
          : value,
      });
    }
    return { exports };
  }
  Object.defineProperty(Instance, 'prototype', { value: wasm.Instance.prototype });
  return Instance;
}

function createStreamingMethod(wasm, globalObject, method) {
  if (typeof wasm[method] !== 'function') return undefined;
  const PromiseClass = globalObject.Promise || Promise;
  return (source, ...args) => {
    if (isResponse(source, globalObject)) return compileFromResponse(wasm, globalObject, method, source, args);
    if (!isPromiseLike(source)) return PromiseClass.reject(invalidStreamingSource(source));
    return runtimePromise(PromiseClass.resolve(source).then((response) => {
      if (!isResponse(response, globalObject)) throw invalidStreamingSource(response);
      return compileFromResponse(wasm, globalObject, method, response, args);
    }), PromiseClass);
  };
}

export function createWasmContract(globalObject = globalThis) {
  const wasm = requireWebAssembly(globalObject);
  const contract = Object.create(wasm);
  Object.defineProperties(contract, {
    validate: { configurable: true, enumerable: true, writable: true, value: (bytes) => wasm.validate(bytes) },
    compile: { configurable: true, enumerable: true, writable: true, value: (bytes) => wasm.compile(bytes) },
    instantiate: { configurable: true, enumerable: true, writable: true, value: (source, imports) => wasm.instantiate(source, imports) },
    Instance: { configurable: true, enumerable: true, writable: true, value: createInstanceConstructor(wasm) },
    compileStreaming: { configurable: true, enumerable: true, writable: true, value: createStreamingMethod(wasm, globalObject, 'compileStreaming') },
    instantiateStreaming: { configurable: true, enumerable: true, writable: true, value: createStreamingMethod(wasm, globalObject, 'instantiateStreaming') },
  });
  return Object.freeze(contract);
}
