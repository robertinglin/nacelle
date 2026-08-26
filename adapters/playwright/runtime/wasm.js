import { UnsupportedWebCapabilityError } from './errors.js';

function requireWebAssembly(globalObject) {
  if (!globalObject.WebAssembly) {
    throw new UnsupportedWebCapabilityError('WebAssembly', 'the WebAssembly Web API is not available');
  }
  return globalObject.WebAssembly;
}

export function createWasmContract(globalObject = globalThis) {
  const wasm = requireWebAssembly(globalObject);
  return Object.freeze({
    validate: (bytes) => wasm.validate(bytes),
    compile: (bytes) => wasm.compile(bytes),
    instantiate: (source, imports) => wasm.instantiate(source, imports),
    compileStreaming: typeof wasm.compileStreaming === 'function'
      ? (source) => wasm.compileStreaming(source)
      : undefined,
    instantiateStreaming: typeof wasm.instantiateStreaming === 'function'
      ? (source, imports) => wasm.instantiateStreaming(source, imports)
      : undefined,
    Module: wasm.Module,
    Instance: wasm.Instance,
    Memory: wasm.Memory,
    Table: wasm.Table,
    Global: wasm.Global,
    Tag: wasm.Tag,
  });
}
