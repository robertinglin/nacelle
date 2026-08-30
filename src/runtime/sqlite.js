import { unsupportedBoundary } from './errors.js';

const SQLITE_UNAVAILABLE_REASON = 'SQLite requires a browser-safe database adapter';

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

function unavailable() {
  unsupportedBoundary('sqlite', SQLITE_UNAVAILABLE_REASON);
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

function validateDatabaseReceiver(value) {
  if (!(value instanceof DatabaseSync) || !databaseInstances.has(value)) {
    throw invalidState('database is not open');
  }
}

function validateStatementReceiver(value) {
  if (!(value instanceof StatementSync) || !statementInstances.has(value)) {
    throw invalidState('statement has been finalized');
  }
}

function validateBackupOptions(options) {
  if (options === null || (typeof options !== 'object' && typeof options !== 'function')) {
    const error = new TypeError('The "options" argument must be an object.');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (options.rate !== undefined
    && (!Number.isInteger(options.rate) || options.rate < -2147483648 || options.rate > 2147483647)) {
    const error = new TypeError('The "options.rate" argument must be an integer.');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (options.source !== undefined && typeof options.source !== 'string') {
    const error = new TypeError('The "options.source" argument must be a string.');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (options.target !== undefined && typeof options.target !== 'string') {
    const error = new TypeError('The "options.target" argument must be a string.');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (options.progress !== undefined && typeof options.progress !== 'function') {
    const error = new TypeError('The "options.progress" argument must be a function.');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
}

const databaseInstances = new WeakSet();
const statementInstances = new WeakSet();

class DatabaseSync {
  constructor(path, options = {}) {
    validateDatabasePath(path);
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
    unavailable();
  }

  createSession(options = {}) {
    validateDatabaseReceiver(this);
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw invalidArgType('options', 'an object', options);
    }
    for (const name of ['table', 'db']) {
      if (options[name] !== undefined && typeof options[name] !== 'string') {
        throw invalidArgType(`options.${name}`, 'a string', options[name]);
      }
    }
    unavailable();
  }

  open() {
    validateDatabaseReceiver(this);
    unavailable();
  }

  close() {
    validateDatabaseReceiver(this);
    unavailable();
  }

  prepare(sql) {
    validateDatabaseReceiver(this);
    if (typeof sql !== 'string') throw invalidArgType('sql', 'a string', sql);
    unavailable();
  }

  exec(sql) {
    validateDatabaseReceiver(this);
    if (typeof sql !== 'string') throw invalidArgType('sql', 'a string', sql);
    unavailable();
  }

  function(name, optionsOrFunction, maybeFunction) {
    validateDatabaseReceiver(this);
    if (typeof name !== 'string') throw invalidArgType('name', 'a string', name);

    const functionIndex = arguments.length < 3 ? 1 : 2;
    if (functionIndex > 1) {
      const options = optionsOrFunction;
      if (options === null || (typeof options !== 'object' && typeof options !== 'function')) {
        throw invalidArgType('options', 'an object', options);
      }
      for (const option of ['useBigIntArguments', 'varargs', 'deterministic', 'directOnly']) {
        if (options[option] !== undefined && typeof options[option] !== 'boolean') {
          throw invalidArgType(`options.${option}`, 'a boolean', options[option]);
        }
      }
    }
    if (typeof arguments[functionIndex] !== 'function') {
      throw invalidArgType('function', 'a function', arguments[functionIndex]);
    }
    unavailable();
  }

  location(dbName) {
    validateDatabaseReceiver(this);
    if (dbName !== undefined && typeof dbName !== 'string') {
      throw invalidArgType('dbName', 'a string', dbName);
    }
    unavailable();
  }

  aggregate(name, options = undefined) {
    validateDatabaseReceiver(this);
    if (typeof name !== 'string') throw invalidArgType('name', 'a string', name);
    if (options === null || (typeof options !== 'object' && typeof options !== 'function')) {
      throw invalidArgType('options', 'an object', options);
    }
    if (options.start === undefined) {
      throw invalidArgType('options.start', 'a function or a primitive value', options.start);
    }
    if (typeof options.step !== 'function') {
      throw invalidArgType('options.step', 'a function', options.step);
    }
    for (const option of ['useBigIntArguments', 'varargs', 'directOnly']) {
      if (options[option] !== undefined && typeof options[option] !== 'boolean') {
        throw invalidArgType(`options.${option}`, 'a boolean', options[option]);
      }
    }
    if (options.inverse !== undefined && typeof options.inverse !== 'function') {
      throw invalidArgType('options.inverse', 'a function', options.inverse);
    }
    unavailable();
  }

  applyChangeset(changeset, options = {}) {
    validateDatabaseReceiver(this);
    if (!isByteArray(changeset)) throw invalidArgType('changeset', 'a Uint8Array', changeset);
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw invalidArgType('options', 'an object', options);
    }
    if (options.onConflict !== undefined && typeof options.onConflict !== 'function') {
      throw invalidArgType('options.onConflict', 'a function', options.onConflict);
    }
    unavailable();
  }

  enableLoadExtension(allow) {
    validateDatabaseReceiver(this);
    if (typeof allow !== 'boolean') throw invalidArgType('allow', 'a boolean', allow);
    unavailable();
  }

  loadExtension(path, entryPoint) {
    validateDatabaseReceiver(this);
    if (typeof path !== 'string') throw invalidArgType('path', 'a string', path);
    if (entryPoint !== undefined && entryPoint !== null && typeof entryPoint !== 'string') {
      throw invalidArgType('entryPoint', 'a string', entryPoint);
    }
    unavailable();
  }

  [Symbol.for('nodejs.dispose')]() {
    try {
      this.close();
    } catch {
      // Node's sqlite disposal hook ignores close errors.
    }
  }
}

if (Symbol.dispose && Symbol.dispose !== Symbol.for('nodejs.dispose')) {
  Object.defineProperty(DatabaseSync.prototype, Symbol.dispose, {
    configurable: true,
    value: DatabaseSync.prototype[Symbol.for('nodejs.dispose')],
    writable: true,
  });
}

class StatementSync {
  constructor() {
    throw illegalConstructor('StatementSync');
  }

  run() {
    validateStatementReceiver(this);
    unavailable();
  }

  iterate() {
    validateStatementReceiver(this);
    unavailable();
  }

  all() {
    validateStatementReceiver(this);
    unavailable();
  }

  get() {
    validateStatementReceiver(this);
    unavailable();
  }

  columns() {
    validateStatementReceiver(this);
    unavailable();
  }

  setAllowBareNamedParameters() {
    validateStatementReceiver(this);
    const enabled = arguments[0];
    if (typeof enabled !== 'boolean') throw invalidBooleanArg('allowBareNamedParameters');
    unavailable();
  }

  setAllowUnknownNamedParameters() {
    validateStatementReceiver(this);
    const enabled = arguments[0];
    if (typeof enabled !== 'boolean') throw invalidBooleanArg('enabled');
    unavailable();
  }

  setReadBigInts() {
    validateStatementReceiver(this);
    const enabled = arguments[0];
    if (typeof enabled !== 'boolean') throw invalidBooleanArg('readBigInts');
    unavailable();
  }

  setReturnArrays() {
    validateStatementReceiver(this);
    const enabled = arguments[0];
    if (typeof enabled !== 'boolean') throw invalidBooleanArg('returnArrays');
    unavailable();
  }
}

function backup(sourceDb, destination, options = undefined) {
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
  if (arguments.length > 2) validateBackupOptions(options);
  unavailable();
}

export function createSqliteModule() {
  return Object.freeze({ DatabaseSync, StatementSync, backup, constants });
}
