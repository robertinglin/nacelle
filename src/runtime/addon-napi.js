// WASM N-API addon layer: loads wasm32-compiled Node-API addons in the browser.
//
// Emscripten function pointers are wasm table indices, so JS can call addon
// callbacks directly through the module's exported indirect function table —
// no C trampoline is required. JS values cross the boundary through a handle
// table; typed arrays and buffers handed to C live inside wasm memory and are
// rebuilt when memory grows (the browser detaches views on growth).

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
export const BROWSER_NAPI_VERSION = 10;

// napi_status
const OK = 0;
const GENERIC_FAILURE = 1;
const INVALID_ARG = 2;
const PENDING_EXCEPTION = 10;

// napi_valuetype
const TYPE_UNDEFINED = 0;
const TYPE_NULL = 1;
const TYPE_BOOLEAN = 2;
const TYPE_NUMBER = 3;
const TYPE_STRING = 4;
const TYPE_SYMBOL = 5;
const TYPE_OBJECT = 6;
const TYPE_FUNCTION = 7;
const TYPE_EXTERNAL = 8;
const TYPE_BIGINT = 9;

const TYPEDARRAY_CTORS = [
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
];

export function isWasmModuleBytes(bytes) {
  return bytes instanceof Uint8Array
    && bytes.length >= 4
    && WASM_MAGIC.every((byte, index) => bytes[index] === byte);
}

function addonError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function encodeUtf8(value) {
  return new TextEncoder().encode(String(value));
}

class AddonState {
  constructor(options = {}) {
    this.name = options.name || 'wasm-addon';
    this.instance = null;
    this.memory = null;
    this.lastBuffer = null;
    this.view = null;
    this.nextHandle = 1;
    this.handles = new Map();
    this.deferreds = new Map();
    this.externalData = new Map();
    // {view, ptr, length} entries for wasm-backed typed arrays/buffers. When
    // memory grows the browser detaches every view; entries are rebuilt from
    // their recorded pointer and length so new accesses stay valid.
    this.wasmViews = new Set();
    this.instanceData = null;
    this.pendingException = null;
    this.cbInfo = null;
    // JS object -> { native, finalize, hint } for the object-wrap family.
    this.wrapped = new WeakMap();
    this.warnedImports = new Set();
    // Set by the node_module_register import for ctor-registered C++ addons.
    this.registeredModule = null;
    // node_api.h imports N-API symbols from the wasm module name "napi";
    // Emscripten runtime imports (abort, syscalls) come from "env", and its
    // libc maps a few calls to WASI. Serve the same table everywhere, with
    // the minimal v8 C++ surface merged in.
    const table = this.buildImports();
    this.imports = { env: table, napi: table, wasi_snapshot_preview1: table };
  }

  attach(instance) {
    this.instance = instance;
    this.memory = instance.exports.memory || null;
    this.refreshViews();
    // Persistent napi_extended_error_info scratch: { const char* message;
    // uint32_t engine_error_code; napi_status error_code }.
    this.errorInfo = 0;
    if (this.memory && typeof instance.exports.malloc === 'function') {
      const block = instance.exports.malloc(32) >>> 0;
      if (block) {
        this.errorInfo = block;
        this.writeBytes(block, new Uint8Array(32));
      }
    }
  }

  errorInfoPtr() {
    return this.errorInfo || 0;
  }

  refreshViews() {
    if (!this.memory || this.memory.buffer === this.lastBuffer) return;
    this.lastBuffer = this.memory.buffer;
    this.view = new DataView(this.memory.buffer);
    for (const entry of this.wasmViews) {
      entry.view = new entry.ctor(this.memory.buffer, entry.ptr, entry.length);
    }
  }

  callWasm(tableIndex, ...args) {
    this.refreshViews();
    const table = this.instance.exports.__indirect_function_table;
    const fn = table.get(tableIndex);
    if (typeof fn !== 'function') throw addonError('ERR_DLOPEN_FAILED', `invalid callback index ${tableIndex}`);
    return fn(...args);
  }

  readI32(ptr) { return this.view.getInt32(ptr >>> 0, true); }
  writeI32(ptr, value) { this.view.setInt32(ptr >>> 0, value | 0, true); return OK; }
  readU32(ptr) { return this.view.getUint32(ptr >>> 0, true); }
  writeU64(ptr, value) {
    const big = BigInt(value);
    this.view.setUint32(ptr >>> 0, Number(big & 0xffffffffn), true);
    this.view.setUint32((ptr >>> 0) + 4, Number((big >> 32n) & 0xffffffffn), true);
    return OK;
  }
  readU64(ptr) {
    const lo = BigInt(this.view.getUint32(ptr >>> 0, true));
    const hi = BigInt(this.view.getUint32((ptr >>> 0) + 4, true));
    return (hi << 32n) | lo;
  }
  writeF64(ptr, value) { this.view.setFloat64(ptr >>> 0, Number(value), true); return OK; }
  readCString(ptr) {
    if (!ptr) return '';
    const bytes = new Uint8Array(this.memory.buffer);
    let end = ptr;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    return new TextDecoder().decode(bytes.subarray(ptr, end));
  }
  readBytes(ptr, length) {
    return new Uint8Array(this.memory.buffer, ptr >>> 0, length >>> 0).slice();
  }
  writeBytes(ptr, bytes) {
    new Uint8Array(this.memory.buffer, ptr >>> 0, bytes.length).set(bytes);
    return OK;
  }

  registerWasmView(view, ptr, length, ctor = Uint8Array) {
    this.wasmViews.add({ view, ptr, length, ctor: view.constructor ?? ctor });
    return view;
  }

  handle(value) {
    const id = this.nextHandle++;
    this.handles.set(id, { value, refs: 0, isRef: false });
    return id;
  }

  deref(id) {
    const entry = this.handles.get(id >>> 0);
    return entry ? entry.value : undefined;
  }

  entry(id) {
    const entry = this.handles.get(id >>> 0);
    if (!entry) throw addonError('ERR_NAPI_INVALID_HANDLE', `unknown napi handle ${id}`);
    return entry;
  }

  result(ptr, value) {
    this.writeI32(ptr, this.handle(value));
    return OK;
  }

  status(check, failure) {
    return check ? OK : (failure ?? GENERIC_FAILURE);
  }

  callCallback(tableIndex, data, thisArg, args) {
    if (!tableIndex) return undefined;
    const cbInfoHandle = this.handle({ thisArg, args, data });
    this.cbInfo = cbInfoHandle;
    try {
      const result = this.callWasm(tableIndex, 1, cbInfoHandle);
      if (this.pendingException) {
        const thrown = this.pendingException;
        this.pendingException = null;
        throw thrown.value;
      }
      return this.deref(result);
    } finally {
      this.cbInfo = null;
    }
  }

  missingImport(name) {
    if (!this.warnedImports.has(name)) {
      this.warnedImports.add(name);
      console.warn(`[bnh addon ${this.name}] unimplemented N-API import '${name}' stubbed`);
    }
    return GENERIC_FAILURE;
  }

  /**
   * Minimal v8 C++ embedding surface, matching the exact mangled symbols
   * wasm addons import. v8::Local<T> values are this layer's handles and
   * the isolate/context are fixed identities; enough for node.h addon
   * registration (string/template/object) and wasm-side callback dispatch
   * through FunctionCallbackInfo.
   */
  buildV8Core() {
    const state = this;
    const FunctionTemplateNew = '_ZN2v816FunctionTemplate3NewEPNS_7IsolateEPFvRKNS_20FunctionCallbackInfoINS_5ValueEEEENS_5LocalIS4_EENSA_INS_9SignatureEEEiNS_19ConstructorBehaviorENS_14SideEffectTypeEPKNS_9CFunctionEttt';
    const callV8Callback = (callback, data, thisArg, args) => {
      const malloc = state.instance.exports.malloc;
      const implicit = malloc(6 * 4) >>> 0;
      const values = malloc((args.length + 1) * 4) >>> 0;
      const info = malloc(12) >>> 0;
      const holder = state.handle(thisArg);
      state.writeI32(implicit + 0, holder);
      state.writeI32(implicit + 1, 1); // isolate
      state.writeI32(implicit + 2, 0);
      // ReturnValue::Set overwrites this slot with the returned handle.
      state.writeI32(implicit + 3, state.handle(undefined));
      state.writeI32(implicit + 4, data | 0);
      state.writeI32(implicit + 5, 0); // newTarget
      // values_[-1] is the receiver; values_[i] are the arguments.
      state.writeI32(values, holder);
      for (let index = 0; index < args.length; index += 1) {
        state.writeI32(values + 4 * (index + 1), state.handle(args[index]));
      }
      state.writeI32(info + 0, implicit);
      state.writeI32(info + 4, values);
      state.writeI32(info + 8, args.length);
      state.callWasm(callback, info);
      return state.deref(state.readU32(implicit + 3));
    };
    return {
      _ZN2v87Context10GetIsolateEv: () => 1,
      _ZN2v87Isolate10GetCurrentEv: () => 1,
      _ZN2v811HandleScopeC1EPNS_7IsolateE: () => 0,
      _ZN2v811HandleScopeD1Ev: () => 0,
      _ZN2v86Object3NewEPNS_7IsolateE: (isolate) => state.handle({}),
      _ZN2v87Context6GlobalEv: (ctx) => state.handle(globalThis),
      _ZN2v88Function7SetNameENS_5LocalINS_6StringEEE: (self, name) => {
        Object.defineProperty(state.entry(self).value, 'name', {
          value: state.deref(name),
          configurable: true,
        });
        return 0;
      },
      _ZN2v86String11NewFromUtf8EPNS_7IsolateEPKcNS_13NewStringTypeEi: (isolate, data, type, length) =>
        state.handle(
          length < 0
            ? state.readCString(data)
            : new TextDecoder().decode(state.readBytes(data, length)),
        ),
      // v8::Object::Set returns Maybe<bool>, passed back through a hidden
      // sret pointer (first wasm argument); layout is two bools
      // {has_value, value}.
      _ZN2v86Object3SetENS_5LocalINS_7ContextEEENS1_INS_5ValueEEES5_: (sret, self, ctx, key, value) => {
        state.entry(self).value[state.deref(key)] = state.deref(value);
        state.writeI32(sret, 0x0101); // Maybe<bool>{true}
      },
      _ZNK2v85Value17IsArrayBufferViewEv: (self) => (ArrayBuffer.isView(state.deref(self)) ? 1 : 0),
      _ZN2v815ArrayBufferView10ByteOffsetEv: (self) => (state.deref(self)?.byteOffset ?? 0) | 0,
      _ZN2v815ArrayBufferView10ByteLengthEv: (self) => (state.deref(self)?.byteLength ?? 0) | 0,
      _ZNK2v815ArrayBufferView9HasBufferEv: () => 1,
      _ZN2v815ArrayBufferView6BufferEv: (self) => {
        const view = state.deref(self);
        return state.handle(view?.buffer ?? view);
      },
      // Returns std::shared_ptr<BackingStore> via sret: {ptr, refcount}.
      _ZN2v811ArrayBuffer15GetBackingStoreEv: (sret, self) => {
        const view = state.deref(self);
        state.writeI32(sret, state.handle(view?.buffer ?? view));
        state.writeI32(sret + 4, 1);
      },
      _ZNK2v812BackingStore4DataEv: (self) => (state.deref(self)?.byteOffset ?? 0) | 0,
      _ZN4node6Buffer4CopyEPN2v87IsolateEPKcm: (isolate, data, length) =>
        state.handle(new Uint8Array(state.readBytes(data, length))),
      [FunctionTemplateNew]: (isolate, callback, data, ...rest) =>
        state.handle({ __bnhTemplate: true, callback, data }),
      _ZN2v816FunctionTemplate11GetFunctionENS_5LocalINS_7ContextEEE: (self, ctx) => {
        const template_ = state.entry(self).value;
        if (!template_ || !template_.__bnhTemplate) return state.handle(undefined);
        const wrapper = (...args) => callV8Callback(template_.callback, template_.data, this, args);
        return state.handle(wrapper);
      },
      // WASI printf from C code (printf goes through fd_write).
      fd_write: (fd, iovs, iovcnt, written) => {
        let text = '';
        let total = 0;
        for (let index = 0; index < iovcnt; index += 1) {
          const base = state.readU32(iovs + index * 8);
          const length = state.readU32(iovs + index * 8 + 4);
          text += new TextDecoder().decode(state.readBytes(base, length));
          total += length;
        }
        if (text) (fd === 2 ? console.error : console.log)(text.trimEnd());
        state.writeI32(written, total);
        return 0;
      },
    };
  }

  typedarrayInfo(value) {
    if (!ArrayBuffer.isView(value)) return null;
    const bytes = value.byteLength;
    const length = 'length' in value ? value.length : bytes;
    return { bytes, length, offset: value.byteOffset, ctor: value.constructor };
  }

  buildImports() {
    const state = this;
    const api = {
      napi_get_undefined: (env, result) => state.result(result, undefined),
      // C++ node.h addons register through a constructor instead of an
      // exported N-API symbol. node_module layout (wasm32): {int version;
      // int flags; void* dso; char* filename; register_func* reg;
      // context_register_func* ctx_reg; char* modname; void* priv; link*}.
      node_module_register: (modPtr) => {
        state.registeredModule = {
          registerIndex: state.readU32(modPtr + 16),
          contextRegisterIndex: state.readU32(modPtr + 20),
          version: state.readU32(modPtr),
          name: state.readCString(state.readU32(modPtr + 24)),
          napi: false,
        };
      },
      // The N-API variant registers an napi_module (no dso_handle field):
      // {int version; int flags; char* filename; register_func* reg;
      // char* modname; void* priv; void* reserved[4]} with the two-argument
      // (env, exports) register signature.
      napi_module_register: (modPtr) => {
        state.registeredModule = {
          registerIndex: state.readU32(modPtr + 12),
          contextRegisterIndex: 0,
          version: state.readU32(modPtr),
          name: state.readCString(state.readU32(modPtr + 16)),
          napi: true,
        };
      },
      napi_create_symbol: (env, description, result) => {
        const label = state.deref(description);
        return state.result(result, typeof label === 'string' ? Symbol(label) : Symbol());
      },
      node_api_symbol_for: (env, data, length, result) => {
        const key = length < 0 ? state.readCString(data) : new TextDecoder().decode(state.readBytes(data, length));
        return state.result(result, Symbol.for(key));
      },
      napi_delete_reference: (env, reference) => (state.handles.delete(reference >>> 0), OK),
      napi_add_env_cleanup_hook: () => OK,
      napi_remove_env_cleanup_hook: () => OK,
      // Async cleanup hooks fire at env teardown; the browser runtime never
      // tears the env down, so registering them is a successful no-op.
      napi_add_async_cleanup_hook: (env, hook, arg, suppressRemove) => OK,
      napi_remove_async_cleanup_hook: (env, suppressRemove) => OK,
      napi_get_null: (env, result) => state.result(result, null),
      napi_get_global: (env, result) => state.result(result, globalThis),
      napi_get_boolean: (env, value, result) => state.result(result, Boolean(value)),
      napi_create_object: (env, result) => state.result(result, {}),
      napi_get_version: (env, result) => state.writeI32(result, BROWSER_NAPI_VERSION),
      napi_get_uv_event_loop: () => OK,

      napi_typeof: (env, value, result) => {
        const target = state.deref(value);
        const type = target === undefined ? TYPE_UNDEFINED
          : target === null ? TYPE_NULL
          : typeof target === 'boolean' ? TYPE_BOOLEAN
          : typeof target === 'number' ? TYPE_NUMBER
          : typeof target === 'string' ? TYPE_STRING
          : typeof target === 'symbol' ? TYPE_SYMBOL
          : typeof target === 'bigint' ? TYPE_BIGINT
          : typeof target === 'function' ? TYPE_FUNCTION
          : state.externalData.has(state.entry(value)) ? TYPE_EXTERNAL
          : TYPE_OBJECT;
        state.writeI32(result, type);
        return OK;
      },
      napi_is_array: (env, value, result) => state.writeI32(result, Array.isArray(state.deref(value)) ? 1 : 0),
      napi_is_error: (env, value, result) => state.writeI32(result, state.deref(value) instanceof Error ? 1 : 0),
      napi_is_promise: (env, value, result) => state.writeI32(result, state.deref(value) instanceof Promise ? 1 : 0),
      napi_is_typedarray: (env, value, result) => state.writeI32(result, ArrayBuffer.isView(state.deref(value)) ? 1 : 0),
      napi_is_dataview: (env, value, result) => state.writeI32(result, state.deref(value) instanceof DataView ? 1 : 0),
      napi_is_detached_arraybuffer: (env, value, result) => {
        const target = state.deref(value);
        const detached = target instanceof ArrayBuffer && target.byteLength === 0;
        state.writeI32(result, detached ? 1 : 0);
        return OK;
      },
      napi_instanceof: (env, object, constructor, result) => {
        const ctor = state.deref(constructor);
        try {
          state.writeI32(result, state.deref(object) instanceof ctor ? 1 : 0);
          return OK;
        } catch {
          return INVALID_ARG;
        }
      },
      napi_strict_equals: (env, left, right, result) => {
        state.writeI32(result, state.deref(left) === state.deref(right) ? 1 : 0);
        return OK;
      },

      napi_create_double: (env, value, result) => state.result(result, Number(value)),
      napi_create_int32: (env, value, result) => state.result(result, value | 0),
      napi_create_uint32: (env, value, result) => state.result(result, value >>> 0),
      napi_create_int64: (env, value, result) => state.result(result, BigInt(value)),
      napi_create_uint64: (env, value, result) => state.result(result, BigInt(value)),
      napi_create_bigint_int64: (env, value, result) => state.result(result, BigInt.asIntN(64, BigInt(value))),
      napi_create_bigint_uint64: (env, value, result) => state.result(result, BigInt.asUintN(64, BigInt(value))),
      napi_get_value_double: (env, value, result) => {
        const target = state.deref(value);
        if (typeof target !== 'number') return GENERIC_FAILURE;
        return state.writeF64(result, target);
      },
      napi_get_value_int32: (env, value, result) => {
        const target = state.deref(value);
        if (typeof target !== 'number') return GENERIC_FAILURE;
        return state.writeI32(result, target | 0);
      },
      napi_get_value_uint32: (env, value, result) => {
        const target = state.deref(value);
        if (typeof target !== 'number') return GENERIC_FAILURE;
        return state.writeI32(result, target >>> 0);
      },
      napi_get_value_int64: (env, value, result) => {
        const target = state.deref(value);
        if (typeof target !== 'number' && typeof target !== 'bigint') return GENERIC_FAILURE;
        return state.writeU64(result, target);
      },
      napi_get_value_uint64: (env, value, result) => {
        const target = state.deref(value);
        if (typeof target !== 'number' && typeof target !== 'bigint') return GENERIC_FAILURE;
        return state.writeU64(result, target);
      },
      napi_get_value_bool: (env, value, result) => {
        const target = state.deref(value);
        if (typeof target !== 'boolean') return GENERIC_FAILURE;
        return state.writeI32(result, target ? 1 : 0);
      },
      napi_get_value_bigint_int64: (env, value, lossless, result) => {
        const target = state.deref(value);
        if (typeof target !== 'bigint' && typeof target !== 'number') return GENERIC_FAILURE;
        const big = BigInt(target);
        state.writeI32(lossless, BigInt.asIntN(64, big) === big ? 1 : 0);
        return state.writeU64(result, big);
      },
      napi_get_value_bigint_uint64: (env, value, lossless, result) => {
        const target = state.deref(value);
        if (typeof target !== 'bigint' && typeof target !== 'number') return GENERIC_FAILURE;
        const big = BigInt(target);
        state.writeI32(lossless, BigInt.asUintN(64, big) === big ? 1 : 0);
        return state.writeU64(result, big);
      },

      napi_create_string_utf8: (env, buf, length, result) => {
        // length < 0 means NUL-terminated: readCString already yields a
        // string; do not decode it a second time.
        const value = length < 0 ? state.readCString(buf) : new TextDecoder().decode(state.readBytes(buf, length));
        return state.result(result, value);
      },
      napi_create_string_latin1: (env, buf, length, result) => {
        const bytes = length < 0 ? state.readBytes(buf, 0) : state.readBytes(buf, length);
        let text = '';
        for (const byte of bytes) text += String.fromCharCode(byte);
        return state.result(result, text);
      },
      napi_get_value_string_utf8: (env, value, buf, bufSize, written) => {
        const target = state.deref(value);
        if (typeof target !== 'string') return GENERIC_FAILURE;
        const bytes = encodeUtf8(target);
        if (!buf) {
          if (written) state.writeI32(written, bytes.length);
          return OK;
        }
        const capacity = Math.max(0, bufSize - 1);
        const copied = bytes.subarray(0, capacity);
        state.writeBytes(buf, copied);
        state.writeI32(buf + copied.length, 0);
        if (written) state.writeI32(written, copied.length);
        return OK;
      },
      napi_get_value_string_latin1: (env, value, buf, bufSize, written) => {
        const target = state.deref(value);
        if (typeof target !== 'string') return GENERIC_FAILURE;
        const bytes = encodeUtf8(target).subarray(0, Math.max(0, bufSize - 1));
        state.writeBytes(buf, bytes);
        state.writeI32(buf + bytes.length, 0);
        if (written) state.writeI32(written, bytes.length);
        return OK;
      },
      napi_coerce_to_number: (env, value, result) => state.result(result, Number(state.deref(value))),
      napi_coerce_to_string: (env, value, result) => state.result(result, String(state.deref(value))),
      napi_coerce_to_bool: (env, value, result) => state.result(result, Boolean(state.deref(value))),
      napi_coerce_to_object: (env, value, result) => state.result(result, Object(state.deref(value))),

      napi_set_named_property: (env, object, name, value) => {
        state.entry(object).value[state.readCString(name)] = state.deref(value);
        return OK;
      },
      napi_get_named_property: (env, object, name, result) => {
        const target = state.entry(object).value;
        const key = state.readCString(name);
        if (!(key in Object(target))) return GENERIC_FAILURE;
        return state.result(result, target[key]);
      },
      napi_has_named_property: (env, object, name, result) => {
        state.writeI32(result, state.readCString(name) in Object(state.entry(object).value) ? 1 : 0);
        return OK;
      },
      napi_set_property: (env, object, key, value) => {
        state.entry(object).value[state.deref(key)] = state.deref(value);
        return OK;
      },
      napi_get_property: (env, object, key, result) => state.result(result, state.entry(object).value[state.deref(key)]),
      napi_has_property: (env, object, key, result) => {
        state.writeI32(result, state.deref(key) in Object(state.entry(object).value) ? 1 : 0);
        return OK;
      },
      napi_delete_property: (env, object, key, result) => {
        delete state.entry(object).value[state.deref(key)];
        state.writeI32(result, 1);
        return OK;
      },
      napi_get_property_names: (env, object, result) => state.result(result, Object.keys(state.entry(object).value)),
      napi_define_properties: (env, object, count, descriptors) => {
        const target = state.entry(object).value;
        // wasm32 napi_property_descriptor layout: every field is 4 bytes.
        const FIELD = { utf8name: 0, name: 4, method: 8, getter: 12, setter: 16, value: 20, attributes: 24, data: 28 };
        const STRIDE = 32;
        const ATTR = { writable: 1, enumerable: 2, configurable: 4 };
        for (let index = 0; index < count; index += 1) {
          const base = descriptors + index * STRIDE;
          const utf8name = state.readU32(base + FIELD.utf8name);
          const nameHandle = state.readU32(base + FIELD.name);
          const method = state.readU32(base + FIELD.method);
          const getter = state.readU32(base + FIELD.getter);
          const setter = state.readU32(base + FIELD.setter);
          const valueHandle = state.readU32(base + FIELD.value);
          const attributes = state.readU32(base + FIELD.attributes);
          const data = state.readU32(base + FIELD.data);
          const key = utf8name ? state.readCString(utf8name) : state.deref(nameHandle);
          const flags = {
            writable: (attributes & ATTR.writable) !== 0,
            enumerable: (attributes & ATTR.enumerable) !== 0,
            configurable: (attributes & ATTR.configurable) !== 0,
          };
          if (method) {
            Object.defineProperty(target, key, {
              ...flags,
              value: (...args) => state.callCallback(method, data, this, args),
            });
          } else if (getter || setter) {
            // Accessor descriptors cannot carry writable/value.
            const descriptor = {
              enumerable: flags.enumerable,
              configurable: flags.configurable,
            };
            if (getter) descriptor.get = () => state.callCallback(getter, data, undefined, []);
            if (setter) descriptor.set = (value) => state.callCallback(setter, data, undefined, [value]);
            Object.defineProperty(target, key, descriptor);
          } else {
            Object.defineProperty(target, key, { ...flags, value: state.deref(valueHandle) });
          }
        }
        return OK;
      },
      napi_set_element: (env, object, index, value) => {
        state.entry(object).value[index >>> 0] = state.deref(value);
        return OK;
      },
      napi_get_element: (env, object, index, result) => state.result(result, state.entry(object).value[index >>> 0]),
      napi_has_element: (env, object, index, result) => {
        state.writeI32(result, (index >>> 0) in Object(state.entry(object).value) ? 1 : 0);
        return OK;
      },
      napi_delete_element: (env, object, index, result) => {
        delete state.entry(object).value[index >>> 0];
        state.writeI32(result, 1);
        return OK;
      },
      napi_get_prototype: (env, object, result) => state.result(result, Object.getPrototypeOf(state.entry(object).value)),
      napi_object_freeze: (env, object) => (Object.freeze(state.entry(object).value), OK),
      napi_object_seal: (env, object) => (Object.seal(state.entry(object).value), OK),

      napi_create_array: (env, result) => state.result(result, []),
      napi_create_array_with_length: (env, length, result) => state.result(result, new Array(length >>> 0)),
      napi_get_array_length: (env, array, result) => state.writeI32(result, state.entry(array).value.length),

      napi_create_arraybuffer: (env, length, data, result) => {
        const byteLength = length >>> 0;
        const ptr = state.instance.exports.malloc(byteLength || 1);
        if (!ptr) return GENERIC_FAILURE;
        const view = state.registerWasmView(new Uint8Array(state.memory.buffer, ptr, byteLength), ptr, byteLength);
        if (data) state.writeI32(data, ptr);
        return state.result(result, view);
      },
      napi_get_arraybuffer_info: (env, arraybuffer, data, length) => {
        const target = state.deref(arraybuffer);
        state.writeI32(data, target.byteOffset || 0);
        state.writeI32(length, target.byteLength ?? 0);
        return OK;
      },
      napi_create_typedarray: (env, type, length, arraybuffer, byteOffset, result) => {
        const Ctor = TYPEDARRAY_CTORS[type];
        if (!Ctor) return INVALID_ARG;
        const backing = state.deref(arraybuffer);
        const view = new Ctor(backing.buffer ?? backing, backing.byteOffset + (byteOffset >>> 0), length >>> 0);
        return state.result(result, view);
      },
      napi_get_typedarray_info: (env, typedarray, type, length, data, arraybuffer, byteOffset) => {
        const target = state.deref(typedarray);
        if (!ArrayBuffer.isView(target)) return GENERIC_FAILURE;
        const index = TYPEDARRAY_CTORS.indexOf(target.constructor);
        if (type) state.writeI32(type, index);
        if (length) state.writeI32(length, target.length);
        if (data) state.writeI32(data, target.byteOffset || 0);
        if (arraybuffer) state.result(arraybuffer, target);
        if (byteOffset) state.writeI32(byteOffset, target.byteOffset);
        return OK;
      },
      napi_create_dataview: (env, byteLength, arraybuffer, byteOffset, result) => {
        const backing = state.deref(arraybuffer);
        const view = new DataView(backing.buffer ?? backing, (backing.byteOffset || 0) + (byteOffset >>> 0), byteLength >>> 0);
        return state.result(result, view);
      },
      napi_get_dataview_info: (env, dataview, byteLength, data, byteOffset) => {
        const target = state.deref(dataview);
        if (!(target instanceof DataView)) return GENERIC_FAILURE;
        if (byteLength) state.writeI32(byteLength, target.byteLength);
        if (data) state.writeI32(data, target.byteOffset);
        if (byteOffset) state.writeI32(byteOffset, target.byteOffset);
        return OK;
      },
      napi_create_external_arraybuffer: (env, data, length, finalize, hint, result) => {
        const byteLength = length >>> 0;
        const view = state.registerWasmView(
          new Uint8Array(state.memory.buffer, data >>> 0, byteLength),
          data >>> 0,
          byteLength,
        );
        return state.result(result, view);
      },
      napi_create_external_buffer: (env, length, data, finalize, hint, result) => {
        const byteLength = length >>> 0;
        const view = state.registerWasmView(
          new Uint8Array(state.memory.buffer, data >>> 0, byteLength),
          data >>> 0,
          byteLength,
        );
        return state.result(result, view);
      },
      napi_detach_arraybuffer: (env, arraybuffer) => OK,
      napi_create_buffer: (env, length, data, result) => {
        const byteLength = length >>> 0;
        const ptr = state.instance.exports.malloc(byteLength || 1);
        if (!ptr) return GENERIC_FAILURE;
        const view = state.registerWasmView(new Uint8Array(state.memory.buffer, ptr, byteLength), ptr, byteLength);
        if (data) state.writeI32(data, ptr);
        return state.result(result, view);
      },
      napi_create_buffer_copy: (env, length, data, result) => {
        const bytes = state.readBytes(data, length);
        const ptr = state.instance.exports.malloc(bytes.length || 1);
        if (!ptr) return GENERIC_FAILURE;
        state.writeBytes(ptr, bytes);
        const view = state.registerWasmView(new Uint8Array(state.memory.buffer, ptr, bytes.length), ptr, bytes.length);
        return state.result(result, view);
      },
      napi_get_buffer_info: (env, buffer, data, length) => {
        const target = state.deref(buffer);
        if (data) state.writeI32(data, target.byteOffset || 0);
        if (length) state.writeI32(length, target.byteLength ?? 0);
        return OK;
      },

      napi_create_function: (env, name, nameLength, callback, data, result) => {
        const label = nameLength < 0 ? state.readCString(name) : new TextDecoder().decode(state.readBytes(name, nameLength));
        // A real function (not an arrow) so `this` is the actual receiver:
        // a plain call yields undefined, a method call yields the object.
        function wrapper(...args) {
          return state.callCallback(callback, data, this, args);
        }
        if (label) Object.defineProperty(wrapper, 'name', { value: label, configurable: true });
        wrapper.__bnhNapiData = data;
        return state.result(result, wrapper);
      },
      napi_get_cb_info: (env, cbInfo, argc, argv, thisArg, data) => {
        const info = state.deref(cbInfo);
        if (!info || typeof info !== 'object' || !Array.isArray(info.args)) return INVALID_ARG;
        if (argv && argc) {
          const wanted = state.readU32(argc);
          const provided = info.args.slice(0, wanted);
          for (let index = 0; index < provided.length; index += 1) {
            state.writeI32(argv + index * 4, state.handle(provided[index]));
          }
          state.writeI32(argc, provided.length);
        } else if (argc) {
          state.writeI32(argc, info.args.length);
        }
        if (thisArg) state.writeI32(thisArg, state.handle(info.thisArg ?? undefined));
        if (data) state.writeI32(data, info.data | 0);
        return OK;
      },
      napi_call_function: (env, recv, func, argc, argv, result) => {
        const args = [];
        for (let index = 0; index < argc; index += 1) args.push(state.deref(state.readU32(argv + index * 4)));
        const value = state.deref(func)(...args);
        if (result) return state.result(result, value);
        return OK;
      },
      napi_new_instance: (env, constructor, argc, argv, result) => {
        const args = [];
        for (let index = 0; index < argc; index += 1) args.push(state.deref(state.readU32(argv + index * 4)));
        return state.result(result, new (state.deref(constructor))(...args));
      },
      napi_get_new_target: (env, cbInfo, result) => state.result(result, undefined),

      // Object-wrap family: define a JS class whose constructor invokes the
      // wasm constructor callback, then let C attach native state via wrap.
      napi_define_class: (env, name, nameLength, constructor, data, count, descriptors, result) => {
        const label = nameLength < 0
          ? state.readCString(name)
          : new TextDecoder().decode(state.readBytes(name, nameLength));
        const cls = function (...args) {
          return state.callCallback(constructor, data, this, args);
        };
        if (label) Object.defineProperty(cls, 'name', { value: label, configurable: true });
        const FIELD = { utf8name: 0, name: 4, method: 8, getter: 12, setter: 16, value: 20, attributes: 24, data: 28 };
        const STRIDE = 32;
        for (let index = 0; index < count; index += 1) {
          const base = descriptors + index * STRIDE;
          const utf8name = state.readU32(base + FIELD.utf8name);
          const nameHandle = state.readU32(base + FIELD.name);
          const method = state.readU32(base + FIELD.method);
          const getter = state.readU32(base + FIELD.getter);
          const setter = state.readU32(base + FIELD.setter);
          const valueHandle = state.readU32(base + FIELD.value);
          const memberData = state.readU32(base + FIELD.data);
          const key = utf8name ? state.readCString(utf8name) : state.deref(nameHandle);
          if (method) {
            cls.prototype[key] = (...args) => state.callCallback(method, memberData, this, args);
          } else if (getter || setter) {
            const descriptor = { configurable: true };
            if (getter) descriptor.get = () => state.callCallback(getter, memberData, undefined, []);
            if (setter) descriptor.set = (value) => state.callCallback(setter, memberData, undefined, [value]);
            Object.defineProperty(cls.prototype, key, descriptor);
          } else {
            cls[key] = state.deref(valueHandle);
          }
        }
        return state.result(result, cls);
      },
      napi_wrap: (env, object, native, finalize, hint, result) => {
        const target = state.entry(object).value;
        state.wrapped.set(target, { native: native | 0, finalize, hint: hint | 0 });
        if (result) {
          // A non-NULL result receives an implicit reference to the wrapped
          // object (refcount 0, released with the wrap).
          const id = state.handle(target);
          state.handles.get(id).isRef = true;
          state.handles.get(id).refs = 0;
          state.writeI32(result, id);
        }
        return OK;
      },
      napi_unwrap: (env, object, result) => {
        const wrapped = state.wrapped.get(state.entry(object).value);
        if (!wrapped) return GENERIC_FAILURE;
        state.writeI32(result, wrapped.native);
        return OK;
      },
      napi_remove_wrap: (env, object, result) => {
        const wrapped = state.wrapped.get(state.entry(object).value);
        state.wrapped.delete(state.entry(object).value);
        if (result) state.writeI32(result, wrapped ? wrapped.native : 0);
        return OK;
      },

      napi_create_error: (env, code, message, result) => {
        const error = new Error(state.readCString(message));
        if (code) error.code = state.readCString(code);
        return state.result(result, error);
      },
      napi_create_type_error: (env, code, message, result) => {
        const error = new TypeError(state.readCString(message));
        if (code) error.code = state.readCString(code);
        return state.result(result, error);
      },
      napi_create_range_error: (env, code, message, result) => {
        const error = new RangeError(state.readCString(message));
        if (code) error.code = state.readCString(code);
        return state.result(result, error);
      },
      napi_throw: (env, value) => {
        state.pendingException = { value: state.deref(value) };
        return OK;
      },
      napi_throw_error: (env, code, message) => {
        const error = new Error(state.readCString(message));
        if (code) error.code = state.readCString(code);
        state.pendingException = { value: error };
        return OK;
      },
      napi_throw_type_error: (env, code, message) => {
        const error = new TypeError(state.readCString(message));
        if (code) error.code = state.readCString(code);
        state.pendingException = { value: error };
        return OK;
      },
      napi_throw_range_error: (env, code, message) => {
        const error = new RangeError(state.readCString(message));
        if (code) error.code = state.readCString(code);
        state.pendingException = { value: error };
        return OK;
      },
      napi_get_last_error_info: (env, result) => {
        // NODE_API_CALL macros read this before deciding to throw; an empty
        // message with napi_ok keeps them on the pending-exception path.
        state.writeI32(result, state.errorInfoPtr());
        return OK;
      },
      napi_is_exception_pending: (env, result) => state.writeI32(result, state.pendingException ? 1 : 0),
      napi_get_and_clear_last_exception: (env, result) => {
        const pending = state.pendingException;
        state.pendingException = null;
        return state.result(result, pending ? pending.value : undefined);
      },
      napi_fatal_error: (env, location, locationLength, message, messageLength) => {
        throw new Error(`napi_fatal_error: ${state.readCString(message)}`);
      },

      napi_create_reference: (env, value, refcount, result) => {
        const id = state.handle(state.deref(value));
        state.handles.get(id).isRef = true;
        state.handles.get(id).refs = refcount;
        return state.writeI32(result, id);
      },
      // Node 22 renamed napi_ref/napi_unref to reference_ref/reference_unref.
      // Legacy napi_ref/napi_unref RETURN the new count; the reference_ref /
      // reference_unref variants deliver it through an out-pointer.
      napi_ref: (env, reference) => {
        const entry = state.entry(reference);
        entry.refs += 1;
        return entry.refs;
      },
      napi_reference_ref: (env, reference, result) => {
        const entry = state.entry(reference);
        entry.refs += 1;
        if (result) state.writeI32(result, entry.refs);
        return OK;
      },
      napi_unref: (env, reference) => {
        const entry = state.entry(reference);
        entry.refs = Math.max(0, entry.refs - 1);
        return entry.refs;
      },
      napi_reference_unref: (env, reference, result) => {
        const entry = state.entry(reference);
        entry.refs = Math.max(0, entry.refs - 1);
        if (result) state.writeI32(result, entry.refs);
        return OK;
      },
      napi_get_reference_value: (env, reference, result) => state.result(result, state.entry(reference).value),
      napi_add_finalizer: () => OK,

      napi_create_promise: (env, deferred, promise) => {
        let controllers;
        const value = new Promise((resolve, reject) => { controllers = { resolve, reject }; });
        const deferredHandle = state.handle(controllers);
        state.deferreds.set(deferredHandle, controllers);
        state.writeI32(deferred, deferredHandle);
        return state.result(promise, value);
      },
      napi_resolve_deferred: (env, deferred, value) => {
        const controllers = state.deferreds.get(deferred >>> 0);
        if (!controllers) return INVALID_ARG;
        controllers.resolve(state.deref(value));
        return OK;
      },
      napi_reject_deferred: (env, deferred, value) => {
        const controllers = state.deferreds.get(deferred >>> 0);
        if (!controllers) return INVALID_ARG;
        controllers.reject(state.deref(value));
        return OK;
      },

      napi_create_async_work: (env, execute, complete, data, result) => {
        const work = { execute, complete, data, cancelled: false };
        return state.writeI32(result, state.handle(work));
      },
      napi_delete_async_work: (env, work) => {
        const entry = state.entry(work);
        if (entry && entry.value) entry.value.cancelled = true;
        return OK;
      },
      napi_queue_async_work: (env, work) => {
        const job = state.entry(work).value;
        queueMicrotask(() => {
          if (job.cancelled) return;
          state.callWasm(job.execute, 1, job.data | 0);
          if (!job.cancelled) state.callWasm(job.complete, 1, 0, job.data | 0);
          if (state.pendingException) {
            const thrown = state.pendingException;
            state.pendingException = null;
            throw thrown.value;
          }
        });
        return OK;
      },
      napi_async_init: (env, parent, resourceName, result) => state.result(result, {}),
      napi_async_destroy: () => OK,
      napi_make_callback: (env, asyncContext, func, recv, argc, argv, result) =>
        api.napi_call_function(env, recv, func, argc, argv, result),

      napi_open_handle_scope: () => OK,
      napi_close_handle_scope: () => OK,
      napi_open_escapable_handle_scope: () => OK,
      napi_close_escapable_handle_scope: () => OK,
      napi_escape_handle: (env, scope, object, result) => state.writeI32(result, object),
      napi_get_instance_data: (env, data) => {
        state.writeI32(data, state.instanceData?.data | 0);
        return state.instanceData ? OK : GENERIC_FAILURE;
      },
      napi_set_instance_data: (env, data, finalize, hint) => {
        state.instanceData = { data: data | 0 };
        return OK;
      },
      napi_adjust_external_memory: (env, change, adjusted) => (state.writeU64(adjusted, 0), OK),
      napi_run_script: (env, source, result) => {
        try {
          return state.result(result, (0, eval)(String(state.deref(source))));
        } catch {
          return GENERIC_FAILURE;
        }
      },
      napi_create_external: (env, data, finalize, hint, result) => {
        const id = state.result(result, { external: true });
        state.externalData.set(id, data | 0);
        return OK;
      },
      napi_get_value_external: (env, value) => state.externalData.get(value >>> 0) | 0,
      napi_create_date: (env, time, result) => state.result(result, new Date(Number(time))),
      napi_is_date: (env, value, result) => state.writeI32(result, state.deref(value) instanceof Date ? 1 : 0),
      napi_get_date_value: (env, value, result) => {
        const target = state.deref(value);
        if (!(target instanceof Date)) return GENERIC_FAILURE;
        return state.writeF64(result, target.getTime());
      },
      ...state.buildV8Core(),
    };
    return new Proxy(api, {
      get(target, property) {
        if (typeof property === 'string' && property in target) return target[property];
        return (...args) => {
          // Only N-API gaps are worth surfacing; reflection probes (toJSON,
          // inspect) and incidental property reads stay silent.
          if (typeof property === 'string' && property.startsWith('napi_')) {
            state.missingImport(property);
          }
          return GENERIC_FAILURE;
        };
      },
    });
  }
}

function findExport(instance, name) {
  if (typeof instance.exports[name] === 'function') return instance.exports[name];
  const underscored = instance.exports[`_${name}`];
  return typeof underscored === 'function' ? underscored : null;
}

// node_api.h names its initializer napi_register_wasm_v1 under __wasm__ and
// napi_register_module_v1 otherwise; try both spellings.
function findRegisterExport(instance) {
  for (const name of ['napi_register_wasm_v1', 'napi_register_module_v1']) {
    const found = findExport(instance, name);
    if (found) return { fn: found, name };
  }
  return null;
}

/**
 * Instantiate a wasm32 Node-API addon and run its registration entry point.
 *
 * Returns the addon's CommonJS exports object, exactly as `require()` of the
 * original .node file would. Compilation is synchronous so the CommonJS
 * loader can stay synchronous; the runtime executes entries inside workers,
 * where synchronous compilation is unrestricted.
 */
export function loadWasmAddon(bytes, options = {}) {
  if (!isWasmModuleBytes(bytes)) {
    throw addonError('ERR_DLOPEN_FAILED', 'addon bytes are not a WebAssembly module');
  }
  const state = new AddonState(options);
  let instance;
  try {
    const module = new WebAssembly.Module(bytes);
    instance = new WebAssembly.Instance(module, state.imports);
  } catch (cause) {
    const error = addonError('ERR_DLOPEN_FAILED', `failed to instantiate wasm addon '${state.name}'`);
    error.cause = cause;
    throw error;
  }
  state.attach(instance);
  const registration = findRegisterExport(instance);
  const exportsHandle = state.handle({});
  let returned = 0;
  if (registration) {
    returned = registration.fn(1, exportsHandle) | 0;
  } else {
    // Constructor-registered addon: run Emscripten's ctor runner (which calls
    // node_module_register), then invoke the recorded register function with
    // the N-API signature. v8-style 4-argument registrations receive zeros
    // for the extra arguments; full v8 embedding support is separate work.
    const initialize = findExport(instance, '_initialize') || findExport(instance, '__wasm_call_ctors');
    if (initialize) initialize();
    if (!initialize || !state.registeredModule) {
      throw addonError(
        'ERR_DLOPEN_FAILED',
        `wasm addon '${state.name}' exports no napi registration entry point`,
      );
    }
    // node.h's addon_register_func signature is (exports, module, context,
    // priv); the N-API variant is (env, exports). Context-aware modules
    // register through the context func and need a real context handle.
    const { registerIndex, contextRegisterIndex, napi } = state.registeredModule;
    if (!registerIndex && !contextRegisterIndex) {
      // A NULL register function is legal (node-api's test_null_init): the
      // module loads with no exports rather than crashing.
      return {};
    }
    if (napi) {
      returned = state.callWasm(registerIndex, 1, exportsHandle) | 0;
    } else {
      const initIndex = contextRegisterIndex || registerIndex;
      // node.h init functions return void; the exports object they were
      // handed (and mutated through Object::Set) is the module value.
      state.callWasm(initIndex, exportsHandle, exportsHandle, state.handle(globalThis), 0);
      returned = exportsHandle;
    }
  }
  if (state.pendingException) {
    const thrown = state.pendingException;
    state.pendingException = null;
    throw thrown.value;
  }
  const value = state.deref(returned);
  return value && typeof value === 'object' ? value : {};
}
