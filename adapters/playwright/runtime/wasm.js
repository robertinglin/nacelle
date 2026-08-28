import { UnsupportedWebCapabilityError } from './errors.js';

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

function createStreamingMethod(wasm, globalObject, method) {
  const nativeMethod = wasm[method];
  if (typeof nativeMethod !== 'function') return undefined;
  const PromiseClass = globalObject.Promise || Promise;
  return (source, ...args) => {
    if (isResponse(source, globalObject)) return nativeMethod.call(wasm, source, ...args);
    if (!isPromiseLike(source)) return PromiseClass.reject(invalidStreamingSource(source));
    return PromiseClass.resolve(source).then((response) => {
      if (!isResponse(response, globalObject)) throw invalidStreamingSource(response);
      return nativeMethod.call(wasm, response, ...args);
    });
  };
}

export function createWasmContract(globalObject = globalThis) {
  const wasm = requireWebAssembly(globalObject);
  const contract = Object.create(wasm);
  Object.defineProperties(contract, {
    validate: { configurable: true, enumerable: true, writable: true, value: (bytes) => wasm.validate(bytes) },
    compile: { configurable: true, enumerable: true, writable: true, value: (bytes) => wasm.compile(bytes) },
    instantiate: { configurable: true, enumerable: true, writable: true, value: (source, imports) => wasm.instantiate(source, imports) },
    compileStreaming: { configurable: true, enumerable: true, writable: true, value: createStreamingMethod(wasm, globalObject, 'compileStreaming') },
    instantiateStreaming: { configurable: true, enumerable: true, writable: true, value: createStreamingMethod(wasm, globalObject, 'instantiateStreaming') },
  });
  return Object.freeze(contract);
}
