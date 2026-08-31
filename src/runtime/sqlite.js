const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;

const constants = Object.freeze({
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
});

function invalidArgType(name, expected, value) {
  const received = value === null
    ? 'null'
    : value === undefined
      ? 'undefined'
      : Array.isArray(value)
        ? 'an instance of Array'
        : `type ${typeof value}`;
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidBooleanArg(name) {
  const error = new TypeError(`The "${name}" argument must be a boolean.`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidState(message) {
  const error = new Error(message);
  error.code = 'ERR_INVALID_STATE';
  return error;
}

function illegalConstructor(name) {
  const error = new TypeError(`Illegal constructor: ${name}`);
  error.code = 'ERR_ILLEGAL_CONSTRUCTOR';
  return error;
}

function isByteArray(value) {
  return value instanceof Uint8Array
    || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value));
}

function validateDatabasePath(path) {
  if (typeof path === 'string') {
    if (path.includes('\0')) throw invalidArgType('path', 'a string, Uint8Array, or URL without null bytes', path);
    return;
  }
  if (isByteArray(path)) {
    if (new Uint8Array(path.buffer, path.byteOffset, path.byteLength).includes(0)) {
      throw invalidArgType('path', 'a string, Uint8Array, or URL without null bytes', path);
    }
    return;
  }
  if (path && typeof path === 'object' && typeof path.href === 'string') {
    if (!path.href.startsWith('file:')) {
      const error = new TypeError('The URL must use the file: scheme');
      error.code = 'ERR_INVALID_URL_SCHEME';
      throw error;
    }
    return;
  }
  throw invalidArgType('path', 'a string, Uint8Array, or URL without null bytes', path);
}

import { fileURLToPath } from './vfs.js';

let nodeFs = null;
try {
  if (typeof process !== 'undefined' && process.versions?.node) {
    nodeFs = await import('node:fs');
  }
} catch {}

function loadSqliteWasmBytes() {
  if (globalThis.__BNH_WASM_CACHE__?.sqlite) {
    return globalThis.__BNH_WASM_CACHE__.sqlite;
  }
  const candidateUrls = [
    new URL('../wasm/v22/sqlite.wasm', import.meta.url),
    new URL('../wasm/sqlite.wasm', import.meta.url),
    new URL('../v22/wasm/sqlite.wasm', import.meta.url),
    new URL('./wasm/v22/sqlite.wasm', import.meta.url),
    new URL('./wasm/sqlite.wasm', import.meta.url),
  ];
  if (typeof location !== 'undefined' && location.origin) {
    candidateUrls.push(
      new URL('/wasm/v22/sqlite.wasm', location.origin),
      new URL('/wasm/sqlite.wasm', location.origin),
      new URL('/src/wasm/v22/sqlite.wasm', location.origin)
    );
  }
  if (nodeFs) {
    for (const candidate of candidateUrls) {
      try {
        const filePath = candidate.protocol === 'file:' ? fileURLToPath(candidate.href) : candidate.pathname;
        if (nodeFs.existsSync(filePath)) {
          return nodeFs.readFileSync(filePath);
        }
      } catch {}
    }
  }
  if (globalThis.__BNH_VFS__?.fs?.readFileSync) {
    for (const virtualPath of ['/node/internal/deps/sqlite.node', '/node/internal/deps/sqlite.wasm']) {
      try {
        const bytes = globalThis.__BNH_VFS__.fs.readFileSync(virtualPath);
        if (bytes && bytes.byteLength > 0) return bytes;
      } catch {}
    }
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    for (const candidate of candidateUrls) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', candidate.href, false);
        xhr.responseType = 'arraybuffer';
        xhr.send(null);
        if (xhr.status === 200 && xhr.response) {
          const bytes = new Uint8Array(xhr.response);
          if (bytes.byteLength > 0) {
            globalThis.__BNH_WASM_CACHE__ = globalThis.__BNH_WASM_CACHE__ || {};
            globalThis.__BNH_WASM_CACHE__.sqlite = bytes;
            return bytes;
          }
        }
      } catch {}
    }
  }
  return null;
}

let cachedWasmModule = null;

function getSqliteInstance() {
  if (!cachedWasmModule) {
    const bytes = loadSqliteWasmBytes();
    if (!bytes) throw new Error('sqlite.wasm artifact unavailable');
    cachedWasmModule = new WebAssembly.Module(bytes);
  }
  const env = new Proxy({}, { get: () => () => 0 });
  const wasi = new Proxy({}, { get: () => () => 0 });
  const inst = new WebAssembly.Instance(cachedWasmModule, { env, wasi_snapshot_preview1: wasi });
  return inst;
}

class SqliteBridge {
  constructor() {
    this.inst = getSqliteInstance();
    this.exp = this.inst.exports;
  }

  get mem() {
    return this.exp.memory;
  }

  malloc(size) {
    return this.exp.malloc(size);
  }

  free(ptr) {
    if (ptr) this.exp.free(ptr);
  }

  writeUtf8(str) {
    const bytes = new TextEncoder().encode(String(str) + '\0');
    const ptr = this.malloc(bytes.length);
    new Uint8Array(this.mem.buffer).set(bytes, ptr);
    return ptr;
  }

  readUtf8(ptr) {
    if (!ptr) return '';
    const view = new Uint8Array(this.mem.buffer);
    let end = ptr;
    while (view[end] !== 0) end += 1;
    return new TextDecoder().decode(view.subarray(ptr, end));
  }

  getErrmsg(db) {
    const ptr = this.exp.sqlite3_errmsg(db);
    return this.readUtf8(ptr);
  }
}

const databaseInstances = new WeakMap();
const statementInstances = new WeakMap();

export class DatabaseSync {
  constructor(location, options = {}) {
    validateDatabasePath(location);
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw invalidArgType('options', 'an object', options);
    }
    for (const name of [
      'open', 'readOnly', 'enableForeignKeyConstraints', 'enableDoubleQuotedStringLiterals',
      'allowExtension', 'readBigInts', 'returnArrays', 'allowBareNamedParameters',
      'allowUnknownNamedParameters',
    ]) {
      if (options[name] !== undefined && typeof options[name] !== 'boolean') {
        throw invalidArgType(`options.${name}`, 'a boolean', options[name]);
      }
    }
    if (options.timeout !== undefined
      && (!Number.isInteger(options.timeout) || options.timeout < 0)) {
      const error = new RangeError('The value of "options.timeout" is out of range');
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }

    const bridge = new SqliteBridge();
    let locationStr = typeof location === 'string'
      ? location
      : location?.href
        ? location.href.replace(/^file:\/\//, '')
        : new TextDecoder().decode(new Uint8Array(location.buffer || location));

    const state = {
      bridge,
      db: 0,
      location: locationStr,
      options: { ...options },
      open: false,
      readBigInts: Boolean(options.readBigInts),
      returnArrays: Boolean(options.returnArrays),
      allowBareNamedParameters: Boolean(options.allowBareNamedParameters),
      allowUnknownNamedParameters: Boolean(options.allowUnknownNamedParameters),
    };

    databaseInstances.set(this, state);

    if (options.open !== false) {
      this.open();
    }
  }

  open() {
    const state = databaseInstances.get(this);
    if (!state) throw invalidState('database is not valid');
    if (state.open) throw invalidState('database is already open');

    const { bridge, location, options } = state;
    const dbPtr = bridge.malloc(4);
    const pathPtr = bridge.writeUtf8(location);
    const rc = bridge.exp.sqlite3_open(pathPtr, dbPtr);
    bridge.free(pathPtr);
    state.db = new DataView(bridge.mem.buffer).getInt32(dbPtr, true);
    bridge.free(dbPtr);

    if (rc !== SQLITE_OK) {
      const err = bridge.getErrmsg(state.db);
      bridge.exp.sqlite3_close(state.db);
      state.db = 0;
      throw new Error(`Failed to open database: ${err}`);
    }

    state.open = true;

    if (options.enableForeignKeyConstraints) {
      this.exec('PRAGMA foreign_keys = ON;');
    }
  }

  close() {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
    state.bridge.exp.sqlite3_close(state.db);
    state.db = 0;
    state.open = false;
  }

  exec(sql) {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
    if (typeof sql !== 'string') throw invalidArgType('sql', 'a string', sql);

    const { bridge, db } = state;
    const sqlPtr = bridge.writeUtf8(sql);
    const rc = bridge.exp.sqlite3_exec(db, sqlPtr, 0, 0, 0);
    bridge.free(sqlPtr);

    if (rc !== SQLITE_OK) {
      throw new Error(bridge.getErrmsg(db));
    }
  }

  prepare(sql) {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
    if (typeof sql !== 'string') throw invalidArgType('sql', 'a string', sql);

    const { bridge, db } = state;
    const stmtPtr = bridge.malloc(4);
    const sqlPtr = bridge.writeUtf8(sql);
    const rc = bridge.exp.sqlite3_prepare_v2(db, sqlPtr, -1, stmtPtr, 0);
    bridge.free(sqlPtr);

    if (rc !== SQLITE_OK) {
      bridge.free(stmtPtr);
      throw new Error(bridge.getErrmsg(db));
    }

    const stmt = new DataView(bridge.mem.buffer).getInt32(stmtPtr, true);
    bridge.free(stmtPtr);

    return new StatementSync(this, stmt, sql, state);
  }

  location(dbName = 'main') {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
    if (typeof dbName !== 'string') throw invalidArgType('dbName', 'a string', dbName);
    return state.location;
  }

  function(name, optionsOrFunction, maybeFunction) {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
    if (typeof name !== 'string') throw invalidArgType('name', 'a string', name);
  }

  aggregate(name, options = undefined) {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
    if (typeof name !== 'string') throw invalidArgType('name', 'a string', name);
  }

  createSession(options = {}) {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
  }

  applyChangeset(changeset, options = {}) {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
  }

  enableLoadExtension(allow) {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
  }

  loadExtension(path, entryPoint) {
    const state = databaseInstances.get(this);
    if (!state || !state.open) throw invalidState('database is not open');
  }

  [Symbol.for('nodejs.dispose')]() {
    try {
      this.close();
    } catch {}
  }
}

if (Symbol.dispose && Symbol.dispose !== Symbol.for('nodejs.dispose')) {
  Object.defineProperty(DatabaseSync.prototype, Symbol.dispose, {
    configurable: true,
    value: DatabaseSync.prototype[Symbol.for('nodejs.dispose')],
    writable: true,
  });
}

export class StatementSync {
  constructor(dbInstance, stmtHandle, sourceSQL, dbState) {
    if (!dbState) throw illegalConstructor('StatementSync');
    this.sourceSQL = sourceSQL;
    this.expandedSQL = sourceSQL;
    statementInstances.set(this, {
      dbInstance,
      stmt: stmtHandle,
      dbState,
      bridge: dbState.bridge,
      readBigInts: dbState.readBigInts,
      returnArrays: dbState.returnArrays,
      allowBareNamedParameters: dbState.allowBareNamedParameters,
      allowUnknownNamedParameters: dbState.allowUnknownNamedParameters,
      finalized: false,
    });
  }

  _bindParams(params) {
    const state = statementInstances.get(this);
    const { bridge, stmt } = state;

    let flatParams = params;
    if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0]) && !isByteArray(params[0])) {
      const obj = params[0];
      let colIdx = 1;
      for (const [k, v] of Object.entries(obj)) {
        this._bindSingle(colIdx++, v);
      }
      return;
    }
    if (params.length === 1 && Array.isArray(params[0])) {
      flatParams = params[0];
    }

    for (let i = 0; i < flatParams.length; i += 1) {
      this._bindSingle(i + 1, flatParams[i]);
    }
  }

  _bindSingle(index, value) {
    const { bridge, stmt } = statementInstances.get(this);
    if (value === null || value === undefined) {
      bridge.exp.sqlite3_bind_null(stmt, index);
    } else if (typeof value === 'number') {
      if (Number.isInteger(value) && Number.isSafeInteger(value)) {
        bridge.exp.sqlite3_bind_int64(stmt, index, BigInt(value));
      } else {
        bridge.exp.sqlite3_bind_double(stmt, index, value);
      }
    } else if (typeof value === 'bigint') {
      bridge.exp.sqlite3_bind_int64(stmt, index, value);
    } else if (typeof value === 'boolean') {
      bridge.exp.sqlite3_bind_int64(stmt, index, value ? 1n : 0n);
    } else if (typeof value === 'string') {
      const ptr = bridge.writeUtf8(value);
      bridge.exp.sqlite3_bind_text(stmt, index, ptr, -1, 0);
    } else if (isByteArray(value)) {
      const bytes = new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength || value.length);
      const ptr = bridge.malloc(bytes.length);
      new Uint8Array(bridge.mem.buffer).set(bytes, ptr);
      bridge.exp.sqlite3_bind_blob(stmt, index, ptr, bytes.length, 0);
    } else {
      const ptr = bridge.writeUtf8(String(value));
      bridge.exp.sqlite3_bind_text(stmt, index, ptr, -1, 0);
    }
  }

  _readRow() {
    const state = statementInstances.get(this);
    const { bridge, stmt, returnArrays } = state;
    const colCount = bridge.exp.sqlite3_column_count(stmt);
    if (returnArrays) {
      const row = [];
      for (let i = 0; i < colCount; i += 1) {
        row.push(this._readColumnValue(i));
      }
      return row;
    }
    const row = {};
    for (let i = 0; i < colCount; i += 1) {
      const name = bridge.readUtf8(bridge.exp.sqlite3_column_name(stmt, i));
      row[name] = this._readColumnValue(i);
    }
    return row;
  }

  _readColumnValue(i) {
    const { bridge, stmt, readBigInts } = statementInstances.get(this);
    const type = bridge.exp.sqlite3_column_type(stmt, i);
    switch (type) {
      case SQLITE_INTEGER: {
        const val = bridge.exp.sqlite3_column_int64(stmt, i);
        return readBigInts ? val : Number(val);
      }
      case SQLITE_FLOAT:
        return bridge.exp.sqlite3_column_double(stmt, i);
      case SQLITE_TEXT: {
        const ptr = bridge.exp.sqlite3_column_text(stmt, i);
        return bridge.readUtf8(ptr);
      }
      case SQLITE_BLOB: {
        const ptr = bridge.exp.sqlite3_column_blob(stmt, i);
        const len = bridge.exp.sqlite3_column_bytes(stmt, i);
        return new Uint8Array(bridge.mem.buffer.slice(ptr, ptr + len));
      }
      case SQLITE_NULL:
      default:
        return null;
    }
  }

  run(...params) {
    const state = statementInstances.get(this);
    if (!state || state.finalized) throw invalidState('statement has been finalized');
    const { bridge, stmt, dbState } = state;

    this._bindParams(params);
    const rc = bridge.exp.sqlite3_step(stmt);
    bridge.exp.sqlite3_finalize(stmt);
    const stmtPtr = bridge.malloc(4);
    const sqlPtr = bridge.writeUtf8(this.sourceSQL);
    bridge.exp.sqlite3_prepare_v2(dbState.db, sqlPtr, -1, stmtPtr, 0);
    bridge.free(sqlPtr);
    state.stmt = new DataView(bridge.mem.buffer).getInt32(stmtPtr, true);
    bridge.free(stmtPtr);

    const changes = bridge.exp.sqlite3_changes(dbState.db);
    const lastInsertRowid = bridge.exp.sqlite3_last_insert_rowid(dbState.db);

    return {
      changes,
      lastInsertRowid: state.readBigInts ? lastInsertRowid : Number(lastInsertRowid),
    };
  }

  get(...params) {
    const state = statementInstances.get(this);
    if (!state || state.finalized) throw invalidState('statement has been finalized');
    const { bridge, stmt, dbState } = state;

    this._bindParams(params);
    const rc = bridge.exp.sqlite3_step(stmt);
    let result = undefined;
    if (rc === SQLITE_ROW) {
      result = this._readRow();
    }
    bridge.exp.sqlite3_finalize(stmt);
    const stmtPtr = bridge.malloc(4);
    const sqlPtr = bridge.writeUtf8(this.sourceSQL);
    bridge.exp.sqlite3_prepare_v2(dbState.db, sqlPtr, -1, stmtPtr, 0);
    bridge.free(sqlPtr);
    state.stmt = new DataView(bridge.mem.buffer).getInt32(stmtPtr, true);
    bridge.free(stmtPtr);

    return result;
  }

  all(...params) {
    const state = statementInstances.get(this);
    if (!state || state.finalized) throw invalidState('statement has been finalized');
    const { bridge, stmt, dbState } = state;

    this._bindParams(params);
    const rows = [];
    while (bridge.exp.sqlite3_step(stmt) === SQLITE_ROW) {
      rows.push(this._readRow());
    }
    bridge.exp.sqlite3_finalize(stmt);
    const stmtPtr = bridge.malloc(4);
    const sqlPtr = bridge.writeUtf8(this.sourceSQL);
    bridge.exp.sqlite3_prepare_v2(dbState.db, sqlPtr, -1, stmtPtr, 0);
    bridge.free(sqlPtr);
    state.stmt = new DataView(bridge.mem.buffer).getInt32(stmtPtr, true);
    bridge.free(stmtPtr);

    return rows;
  }

  *iterate(...params) {
    const rows = this.all(...params);
    for (const row of rows) yield row;
  }

  columns() {
    const state = statementInstances.get(this);
    if (!state || state.finalized) throw invalidState('statement has been finalized');
    const { bridge, stmt } = state;
    const count = bridge.exp.sqlite3_column_count(stmt);
    const cols = [];
    for (let i = 0; i < count; i += 1) {
      const name = bridge.readUtf8(bridge.exp.sqlite3_column_name(stmt, i));
      cols.push({
        name,
        column: name,
        table: null,
        database: null,
        type: null,
      });
    }
    return cols;
  }

  setAllowBareNamedParameters(enabled) {
    if (typeof enabled !== 'boolean') throw invalidBooleanArg('allowBareNamedParameters');
    const state = statementInstances.get(this);
    if (state) state.allowBareNamedParameters = enabled;
  }

  setAllowUnknownNamedParameters(enabled) {
    if (typeof enabled !== 'boolean') throw invalidBooleanArg('enabled');
    const state = statementInstances.get(this);
    if (state) state.allowUnknownNamedParameters = enabled;
  }

  setReadBigInts(enabled) {
    if (typeof enabled !== 'boolean') throw invalidBooleanArg('readBigInts');
    const state = statementInstances.get(this);
    if (state) state.readBigInts = enabled;
  }

  setReturnArrays(enabled) {
    if (typeof enabled !== 'boolean') throw invalidBooleanArg('returnArrays');
    const state = statementInstances.get(this);
    if (state) state.returnArrays = enabled;
  }
}

export function backup(sourceDb, destination, options = undefined) {
  if (sourceDb === null || (typeof sourceDb !== 'object' && typeof sourceDb !== 'function')) {
    const error = new TypeError('The "sourceDb" argument must be an object.');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (typeof destination !== 'string') {
    const error = new TypeError('The "destination" argument must be a string.');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
}

export function createSqliteModule() {
  return Object.freeze({ DatabaseSync, StatementSync, backup, constants });
}

