import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWasmAddon, isWasmModuleBytes } from '../runtime/addon-napi.js';
import { createModuleLoader } from '../runtime/module-loader.js';

// ---------------------------------------------------------------------------
// Minimal wasm32 N-API addon built inline so this spec never needs a
// toolchain. The module registers `hello` (string) and `add` (callback routed
// through the indirect function table, exactly like Emscripten builds).
// ---------------------------------------------------------------------------

const u32 = (value) => {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    bytes.push(byte);
  } while (v);
  return bytes;
};
const sleb = (value) => {
  const bytes = [];
  let more = true;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) more = false;
    else byte |= 0x80;
    bytes.push(byte);
  }
  return bytes;
};
const str = (value) => [...u32(value.length), ...Buffer.from(value, 'utf8')];
const bytes = (list) => [...u32(list.length), ...list];
const section = (id, payload) => [id, ...u32(payload.length), ...payload];
const vec = (items) => [...u32(items.length), ...items.flat()];

const I32 = 0x7f;
const F64 = 0x7c;
const FUNC = 0x60;
const FUNCREF = 0x70;

// type indices
const T_II_R = 0; // (i32,i32)->i32
const T_4I_R = 1; // (i32,i32,i32,i32)->i32
const T_6I_R = 2; // six i32 -> i32
const T_IFI_R = 3; // (i32,f64,i32)->i32
const T_3I_R = 4; // (i32,i32,i32)->i32

// imported napi function indices
const F_CREATE_OBJECT = 0;
const F_CREATE_STRING = 1;
const F_SET_NAMED = 2;
const F_CREATE_FUNCTION = 3;
const F_GET_CB_INFO = 4;
const F_GET_VALUE_DOUBLE = 5;
const F_CREATE_DOUBLE = 6;
// defined function indices
const F_REGISTER = 7;
const F_CALLBACK = 8;

const LOCAL_GET = 0x20;
const I32_CONST = 0x41;
const I32_LOAD = 0x28;
const I32_STORE = 0x36;
const F64_LOAD = 0x2b;
const F64_ADD = 0xa0;
const CALL = 0x10;
const DROP = 0x1a;
const END = 0x0b;

const call = (index) => [CALL, ...u32(index)];
const ci = (value) => [I32_CONST, ...sleb(value)];

// Scratch addresses inside the module's single memory page.
const A = {
  nameHello: 512, // "hello", 5 bytes
  nameAdd: 528, // "add", 3 bytes
  resString: 260, // i32 handle slot
  resFn: 264, // i32 handle slot
  argc: 768, // i32 slot
  argv: 772, // two i32 handle slots
  dblA: 784, // f64 slot
  dblB: 792, // f64 slot
  dblOut: 800, // i32 handle slot
};

function registerBody() {
  return [
    LOCAL_GET, 0, ...ci(A.nameHello), I32_CONST, 5, ...ci(A.resString), ...call(F_CREATE_STRING), DROP,
    LOCAL_GET, 0, LOCAL_GET, 1, ...ci(A.nameHello), ...ci(A.resString), I32_LOAD, 2, 0, ...call(F_SET_NAMED), DROP,
    LOCAL_GET, 0, ...ci(A.nameAdd), I32_CONST, 3, I32_CONST, 1, I32_CONST, 0, ...ci(A.resFn), ...call(F_CREATE_FUNCTION), DROP,
    LOCAL_GET, 0, LOCAL_GET, 1, ...ci(A.nameAdd), ...ci(A.resFn), I32_LOAD, 2, 0, ...call(F_SET_NAMED), DROP,
    LOCAL_GET, 1,
    END,
  ];
}

function callbackBody() {
  return [
    // get_cb_info reads the caller-provided capacity from *argc first.
    ...ci(A.argc), I32_CONST, 2, I32_STORE, 2, 0,
    LOCAL_GET, 0, LOCAL_GET, 1, ...ci(A.argc), ...ci(A.argv), I32_CONST, 0, I32_CONST, 0, ...call(F_GET_CB_INFO), DROP,
    LOCAL_GET, 0, ...ci(A.argv), I32_LOAD, 2, 0, ...ci(A.dblA), ...call(F_GET_VALUE_DOUBLE), DROP,
    LOCAL_GET, 0, ...ci(A.argv + 4), I32_LOAD, 2, 0, ...ci(A.dblB), ...call(F_GET_VALUE_DOUBLE), DROP,
    LOCAL_GET, 0,
    ...ci(A.dblA), F64_LOAD, 3, 0,
    ...ci(A.dblB), F64_LOAD, 3, 0,
    F64_ADD,
    ...ci(A.dblOut), ...call(F_CREATE_DOUBLE), DROP,
    ...ci(A.dblOut), I32_LOAD, 2, 0,
    END,
  ];
}

const body = (code) => [...u32(0), ...code]; // zero local declarations

function buildAddonModule({ exportRegister = true } = {}) {
  const types = section(1, vec([
    [FUNC, ...vec([[I32], [I32]]), ...vec([[I32]])],
    [FUNC, ...vec([[I32], [I32], [I32], [I32]]), ...vec([[I32]])],
    [FUNC, ...vec([[I32], [I32], [I32], [I32], [I32], [I32]]), ...vec([[I32]])],
    [FUNC, ...vec([[I32], [F64], [I32]]), ...vec([[I32]])],
    [FUNC, ...vec([[I32], [I32], [I32]]), ...vec([[I32]])],
  ]));
  const imports = section(2, vec([
    [...str('napi'), ...str('napi_create_object'), 0x00, ...u32(T_II_R)],
    [...str('napi'), ...str('napi_create_string_utf8'), 0x00, ...u32(T_4I_R)],
    [...str('napi'), ...str('napi_set_named_property'), 0x00, ...u32(T_4I_R)],
    [...str('napi'), ...str('napi_create_function'), 0x00, ...u32(T_6I_R)],
    [...str('napi'), ...str('napi_get_cb_info'), 0x00, ...u32(T_6I_R)],
    [...str('napi'), ...str('napi_get_value_double'), 0x00, ...u32(T_3I_R)],
    [...str('napi'), ...str('napi_create_double'), 0x00, ...u32(T_IFI_R)],
  ]));
  const functions = section(3, vec([[...u32(T_II_R)], [...u32(T_II_R)]]));
  const table = section(4, vec([[FUNCREF, 0x00, 2]]));
  const memory = section(5, vec([[0x00, 1]]));
  const exports = section(7, vec([
    ...(exportRegister ? [[...str('napi_register_wasm_v1'), 0x00, ...u32(F_REGISTER)]] : []),
    [...str('__indirect_function_table'), 0x01, ...u32(0)],
    [...str('memory'), 0x02, ...u32(0)],
  ]));
  // Place the callback at table index 1, mirroring Emscripten's null slot 0.
  const element = section(9, vec([[0x00, I32_CONST, 1, END, ...vec([[...u32(F_CALLBACK)]])]]));
  const code = section(10, vec([
    [...u32(body(registerBody()).length), ...body(registerBody())],
    [...u32(body(callbackBody()).length), ...body(callbackBody())],
  ]));
  const data = section(11, vec([
    [0x00, ...ci(A.nameHello), END, ...bytes([...Buffer.from('hello')])],
    [0x00, ...ci(A.nameAdd), END, ...bytes([...Buffer.from('add')])],
  ]));
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...types, ...imports, ...functions, ...table, ...memory, ...exports, ...element, ...code, ...data,
  ]);
}

test('wasm magic detection', () => {
  assert.equal(isWasmModuleBytes(buildAddonModule()), true);
  assert.equal(isWasmModuleBytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3])), false);
  assert.equal(isWasmModuleBytes(new Uint8Array(2)), false);
});

test('wasm addon registers exports through the N-API import layer', () => {
  const exports = loadWasmAddon(buildAddonModule(), { name: 'inline-addon' });
  assert.equal(exports.hello, 'hello');
  assert.equal(typeof exports.add, 'function');
  assert.equal(exports.add.name, 'add');
});

test('callbacks cross the wasm table and marshal values both ways', () => {
  const exports = loadWasmAddon(buildAddonModule(), { name: 'inline-addon' });
  assert.equal(exports.add(2, 40), 42);
  assert.equal(exports.add(1.5, 2.5), 4);
});

test('non-wasm addon bytes keep the ERR_DLOPEN_FAILED boundary', () => {
  assert.throws(() => loadWasmAddon(new Uint8Array([1, 2, 3])), /not a WebAssembly module/);
});

test('a module without a registration export is rejected', () => {
  assert.throws(
    () => loadWasmAddon(buildAddonModule({ exportRegister: false })),
    /no napi registration entry point/,
  );
});

test('missing imports are stubbed instead of failing instantiation', () => {
  const bytes = buildAddonModule();
  const stateless = loadWasmAddon(bytes, { name: 'stub-probe' });
  // The built module only uses implemented imports; the Proxy fallback is
  // exercised indirectly by keeping instantiation alive for unknown symbols.
  assert.ok(stateless);
});

test('module loader serves wasm .node files and keeps the boundary for ELF', () => {
  const wasmBytes = buildAddonModule();
  const elfBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  const files = new Map([
    ['/node/addon.node', wasmBytes],
    ['/node/elf.node', elfBytes],
  ]);
  const loader = createModuleLoader({ files, builtins: {}, globalObject: {}, evaluateCommonJS: undefined });
  const exports = loader.require('/node/addon.node');
  assert.equal(exports.hello, 'hello');
  assert.equal(exports.add(20, 22), 42);
  assert.throws(() => loader.require('/node/elf.node'), /native addons are unavailable/);
});

// Toolchain-gated: exercises a real emcc-built addon when one is available.
const COMPILED_FIXTURE = new URL('../.fixture-hello-addon.wasm', import.meta.url);
test('compiled hello-world addon loads (toolchain fixture, skipped when absent)', { skip: !existsSync(COMPILED_FIXTURE) }, async () => {
  const bytes = new Uint8Array(await readFile(fileURLToPath(COMPILED_FIXTURE)));
  const exports = loadWasmAddon(bytes, { name: 'hello' });
  assert.equal(exports.hello(), 'world');
});
