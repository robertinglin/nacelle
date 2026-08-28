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
}

class StatementSync {
  constructor() {
    throw illegalConstructor('StatementSync');
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
}

export function createSqliteModule() {
  return Object.freeze({ DatabaseSync, StatementSync, constants });
}
