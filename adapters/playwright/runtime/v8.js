const WIRE_FORMAT_VERSION = 0x0f;
const V8_HEADER = Uint8Array.of(0xff, WIRE_FORMAT_VERSION);

const TAG = Object.freeze({
  UNDEFINED: 0,
  NULL: 1,
  FALSE: 2,
  TRUE: 3,
  NUMBER: 4,
  BIGINT: 5,
  STRING: 6,
  OBJECT: 7,
  ARRAY: 8,
  DATE: 9,
  REGEXP: 10,
  MAP: 11,
  SET: 12,
  ARRAY_BUFFER: 13,
  HOST_OBJECT: 14,
});

const NODE_TAG = Object.freeze({
  UNDEFINED: 0x5f,
  NULL: 0x30,
  FALSE: 0x46,
  TRUE: 0x54,
  INT32: 0x49,
  UINT32: 0x55,
  DOUBLE: 0x4e,
  UTF8_STRING: 0x53,
  ONE_BYTE_STRING: 0x22,
  OBJECT_REFERENCE: 0x5e,
  BEGIN_OBJECT: 0x6f,
  END_OBJECT: 0x7b,
  HOST_OBJECT: 0x5c,
});

function hasFlag(processObject, flag) {
  return (processObject?.argv || []).some((value) => String(value) === flag || String(value).startsWith(`${flag}=`));
}

function requireCallback(callback, name) {
  if (typeof callback !== 'function') throw new TypeError(`${name} callback must be a function`);
}

function isObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isArrayBufferView(value, globalObject) {
  return isObject(value) && globalObject.ArrayBuffer?.isView(value) === true;
}

function bytesFor(value, globalObject) {
  if (!isArrayBufferView(value, globalObject)) {
    throw new TypeError('source must be a TypedArray or a DataView');
  }
  return new globalObject.Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function appendBytes(target, value) {
  const result = new Uint8Array(target.length + value.length);
  result.set(target);
  result.set(value, target.length);
  return result;
}

function isNodeWireTag(tag) {
  return Object.values(NODE_TAG).includes(tag);
}

function nodeVarint(value) {
  let remaining = Number(value) >>> 0;
  const bytes = [];
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Uint8Array.from(bytes);
}

function nodeString(value, globalObject) {
  const bytes = new globalObject.TextEncoder().encode(value);
  return appendBytes(Uint8Array.of(NODE_TAG.ONE_BYTE_STRING), appendBytes(nodeVarint(bytes.length), bytes));
}

function isSimpleNodeGraph(value, globalObject, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'boolean'
      || typeof value === 'string' || typeof value === 'number') return true;
  if (!isObject(value) || globalObject.Array.isArray(value)
      || globalObject.Object.getPrototypeOf(value) !== globalObject.Object.prototype) return false;
  if (seen.has(value)) return true;
  if (typeof globalObject.structuredClone === 'function') {
    try { globalObject.structuredClone(value); } catch { return false; }
  }
  seen.add(value);
  return globalObject.Object.keys(value).every((key) => isSimpleNodeGraph(value[key], globalObject, seen));
}

function encodeNodeValue(value, globalObject, seen) {
  if (value === undefined) return Uint8Array.of(NODE_TAG.UNDEFINED);
  if (value === null) return Uint8Array.of(NODE_TAG.NULL);
  if (value === false) return Uint8Array.of(NODE_TAG.FALSE);
  if (value === true) return Uint8Array.of(NODE_TAG.TRUE);
  if (typeof value === 'string') return nodeString(value, globalObject);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -0x40000000 && value <= 0x3fffffff) {
      const zigzag = value < 0 ? (-value * 2) - 1 : value * 2;
      return appendBytes(Uint8Array.of(NODE_TAG.INT32), nodeVarint(zigzag));
    }
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      return appendBytes(Uint8Array.of(NODE_TAG.UINT32), nodeVarint(value));
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return appendBytes(Uint8Array.of(NODE_TAG.DOUBLE), bytes);
  }
  if (seen.has(value)) return appendBytes(Uint8Array.of(NODE_TAG.OBJECT_REFERENCE), nodeVarint(seen.get(value)));
  const id = seen.size;
  seen.set(value, id);
  let result = Uint8Array.of(NODE_TAG.BEGIN_OBJECT);
  let propertyCount = 0;
  for (const key of globalObject.Object.keys(value)) {
    result = appendBytes(result, nodeString(key, globalObject));
    result = appendBytes(result, encodeNodeValue(value[key], globalObject, seen));
    propertyCount += 1;
  }
  result = appendBytes(result, Uint8Array.of(NODE_TAG.END_OBJECT));
  return appendBytes(result, nodeVarint(propertyCount));
}

function uint32Bytes(value) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, Number(value) >>> 0, true);
  return result;
}

function describeCloneFailure(value, globalObject) {
  if (typeof value === 'function') return `${String(value)} could not be cloned.`;
  if (value !== null && typeof value === 'object') {
    const tag = globalObject.Object?.prototype?.toString?.call(value) || 'Object';
    return `#<${tag.slice(8, -1)}> could not be cloned.`;
  }
  return `${String(value)} could not be cloned.`;
}

function unsupportedCapability(name, reason) {
  const error = new Error(`${name} is unavailable in this browser: ${reason}`);
  error.name = 'UnsupportedWebCapabilityError';
  error.code = 'ERR_UNSUPPORTED_WEB_CAPABILITY';
  error.capability = name;
  error.status = 'unsupported-capability';
  error.reason = reason;
  throw error;
}

function typeDescription(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an instance of Array';
  switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number': {
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (Object.is(value, -0)) return 'type number (-0)';
      if (value === Infinity || value === -Infinity) return `type number (${value})`;
      return `type number (${value})`;
    }
    case 'boolean': return `type boolean (${value})`;
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'string': {
      const text = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return text.includes("'") ? `type string (${JSON.stringify(text)})` : `type string ('${text}')`;
    }
    case 'object': {
      const constructorName = value.constructor?.name;
      return constructorName ? `an instance of ${constructorName}` : 'an instance of Object';
    }
    default: return `type ${typeof value} (${String(value)})`;
  }
}

function invalidArgumentType(name, expected, value) {
  const error = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${typeDescription(value)}`,
  );
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}

function invalidArgumentValue(name, value, reason) {
  const error = new TypeError(
    `The "${name}" argument is invalid. Received ${String(value)}${reason ? ` (${reason})` : ''}`,
  );
  error.code = 'ERR_INVALID_ARG_VALUE';
  return error;
}

function validateString(value, name) {
  if (typeof value !== 'string') throw invalidArgumentType(name, 'string', value);
}

function validateUint32(value, name, positive = false) {
  if (typeof value !== 'number') throw invalidArgumentType(name, 'number', value);
  if (!Number.isInteger(value)) {
    const error = new RangeError(
      `The "${name}" argument must be an integer. Received ${String(value)}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
  const min = positive ? 1 : 0;
  if (value < min || value > 0xffffffff) {
    const error = new RangeError(
      `The "${name}" argument must be >= ${min} && <= 4294967295. Received ${String(value)}`,
    );
    error.code = 'ERR_OUT_OF_RANGE';
    throw error;
  }
}

function validateOptionsObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArgumentType(name, 'object', value);
  }
}

function createUnsupportedPromiseHooks() {
  const unsupported = () => unsupportedCapability(
    'v8.promiseHooks',
    'native V8 promise instrumentation is unavailable in the browser runtime',
  );
  const validateHook = (hook, name) => {
    if (typeof hook !== 'function') throw invalidArgumentType(name, 'function', hook);
  };
  const validateCreateHookOptions = (options) => {
    validateOptionsObject(options, 'options');
    for (const name of ['init', 'before', 'after', 'settled']) {
      if (options[name] !== undefined) validateHook(options[name], `${name}Hook`);
    }
  };
  return Object.freeze({
    createHook(options = {}) {
      validateCreateHookOptions(options);
      return unsupported();
    },
    onInit(hook) {
      validateHook(hook, 'initHook');
      return unsupported();
    },
    onBefore(hook) {
      validateHook(hook, 'beforeHook');
      return unsupported();
    },
    onAfter(hook) {
      validateHook(hook, 'afterHook');
      return unsupported();
    },
    onSettled(hook) {
      validateHook(hook, 'settledHook');
      return unsupported();
    },
  });
}

function browserCppHeapStatistics(type, globalObject) {
  return {
    committed_size_bytes: 0,
    resident_size_bytes: 0,
    used_size_bytes: 0,
    detail_level: type,
    space_statistics: new globalObject.Array(),
    type_names: new globalObject.Array(),
  };
}

function makeDataCloneError(serializer, value, globalObject) {
  const message = describeCloneFailure(value, globalObject);
  const ErrorConstructor = serializer._getDataCloneError;
  if (typeof ErrorConstructor !== 'function') throw new TypeError('serializer data clone error must be a constructor');
  let error;
  try {
    error = new ErrorConstructor(message);
  } catch {
    error = ErrorConstructor.call(serializer, message);
  }
  throw error instanceof globalObject.Error ? error : new globalObject.Error(message);
}

function arrayBufferViewType(value, globalObject) {
  const tag = globalObject.Object.prototype.toString.call(value);
  const names = [
    '[object Int8Array]', '[object Uint8Array]', '[object Uint8ClampedArray]',
    '[object Int16Array]', '[object Uint16Array]', '[object Int32Array]',
    '[object Uint32Array]', '[object Float32Array]', '[object Float64Array]',
    '[object DataView]', null, '[object BigInt64Array]', '[object BigUint64Array]',
    '[object Float16Array]',
  ];
  const tagIndex = names.indexOf(tag);
  if (tagIndex >= 0) return tagIndex;
  const constructorName = value?.constructor?.name;
  return [
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'DataView',
    null, 'BigInt64Array', 'BigUint64Array', 'Float16Array',
  ].indexOf(constructorName);
}

function arrayBufferViewConstructor(index, globalObject) {
  const constructors = [
    globalObject.Int8Array,
    globalObject.Uint8Array,
    globalObject.Uint8ClampedArray,
    globalObject.Int16Array,
    globalObject.Uint16Array,
    globalObject.Int32Array,
    globalObject.Uint32Array,
    globalObject.Float32Array,
    globalObject.Float64Array,
    globalObject.DataView,
    null,
    globalObject.BigInt64Array,
    globalObject.BigUint64Array,
    globalObject.Float16Array,
  ];
  return constructors[index];
}

function hasOwnSymbolState(value, globalObject) {
  if (globalObject.Object.getOwnPropertySymbols(value).length > 0) return true;
  for (const key of globalObject.Object.keys(value)) {
    const child = value[key];
    if (child !== null && typeof child === 'object'
        && globalObject.Object.getOwnPropertySymbols(child).length > 0) return true;
  }
  return false;
}

function hasCustomPrototypeMethods(value, globalObject) {
  const prototype = globalObject.Object.getPrototypeOf(value);
  if (!prototype) return false;
  const constructorName = prototype.constructor?.name;
  if (constructorName === 'Object' || constructorName === 'Array') return false;
  if (value.constructor?.name && value.constructor.name !== 'Object' && value.constructor.name !== 'Array') return true;
  return globalObject.Object.getOwnPropertyNames(prototype).some((name) => (
    name !== 'constructor' && typeof prototype[name] === 'function'
  ));
}

class Serializer {
  constructor(globalObject) {
    this._globalObject = globalObject;
    this._bytes = new Uint8Array();
    this._activePayload = null;
    this._treatArrayBufferViewsAsHostObjects = false;
    this._transferredArrayBuffers = new Map();
  }

  writeHeader() {
    this._append(V8_HEADER);
    return undefined;
  }

  _append(value) {
    this._bytes = appendBytes(this._bytes, value);
  }

  _appendRaw(value) {
    if (this._activePayload) this._activePayload.push(value);
    else this._append(value);
  }

  _setTreatArrayBufferViewsAsHostObjects(value) {
    this._treatArrayBufferViewsAsHostObjects = Boolean(value);
  }

  _getDataCloneError(message) {
    return new this._globalObject.Error(message);
  }

  writeUint32(value) {
    this._appendRaw(uint32Bytes(value));
  }

  writeUint64(high, low) {
    const result = new Uint8Array(8);
    const view = new DataView(result.buffer);
    view.setUint32(0, Number(low) >>> 0, true);
    view.setUint32(4, Number(high) >>> 0, true);
    this._appendRaw(result);
  }

  writeDouble(value) {
    const result = new Uint8Array(8);
    new DataView(result.buffer).setFloat64(0, Number(value), true);
    this._appendRaw(result);
  }

  writeRawBytes(source) {
    this._appendRaw(new Uint8Array(bytesFor(source, this._globalObject)));
  }

  transferArrayBuffer(id, arrayBuffer) {
    if (!Number.isInteger(Number(id)) || Number(id) < 0 || Number(id) > 0xffffffff) {
      throw new TypeError('id must be a uint32');
    }
    if (!(arrayBuffer instanceof this._globalObject.ArrayBuffer)) {
      throw new TypeError('arrayBuffer must be an ArrayBuffer');
    }
    this._transferredArrayBuffers.set(Number(id) >>> 0, arrayBuffer);
  }

  _encodeHostObject(value) {
    const previousPayload = this._activePayload;
    const payload = [];
    this._activePayload = payload;
    try {
      this._writeHostObject(value);
    } finally {
      this._activePayload = previousPayload;
    }
    let encoded = Uint8Array.of(TAG.HOST_OBJECT);
    const payloadBytes = payload.reduce((result, chunk) => appendBytes(result, chunk), new Uint8Array());
    encoded = appendBytes(encoded, uint32Bytes(payloadBytes.length));
    return appendBytes(encoded, payloadBytes);
  }

  _encodeValue(value, seen) {
    const globalObject = this._globalObject;
    const clone = globalObject.structuredClone;
    if (value === undefined) return Uint8Array.of(TAG.UNDEFINED);
    if (value === null) return Uint8Array.of(TAG.NULL);
    if (value === false) return Uint8Array.of(TAG.FALSE);
    if (value === true) return Uint8Array.of(TAG.TRUE);
    if (typeof value === 'number') {
      return Uint8Array.of(TAG.NUMBER, ...new Uint8Array(new Float64Array([value]).buffer));
    }
    if (typeof value === 'bigint') {
      return appendBytes(Uint8Array.of(TAG.BIGINT), this._encodeString(String(value)));
    }
    if (typeof value === 'string') return appendBytes(Uint8Array.of(TAG.STRING), this._encodeString(value));
    if (typeof value === 'symbol' || typeof value === 'function') makeDataCloneError(this, value, globalObject);

    if (this._treatArrayBufferViewsAsHostObjects && isArrayBufferView(value, globalObject)) {
      return this._encodeHostObject(value);
    }
    if (clone && isObject(value) && hasOwnSymbolState(value, globalObject)) {
      return this._encodeHostObject(value);
    }
    if (isObject(value) && hasCustomPrototypeMethods(value, globalObject)) {
      return this._encodeHostObject(value);
    }
    if (clone && isObject(value)) {
      const prototype = globalObject.Object.getPrototypeOf(value);
      const standardPrototype = prototype === globalObject.Object.prototype
        || prototype === globalObject.Array.prototype;
      const builtIn = (globalObject.ArrayBuffer && value instanceof globalObject.ArrayBuffer)
        || (globalObject.Date && value instanceof globalObject.Date)
        || (globalObject.RegExp && value instanceof globalObject.RegExp)
        || (globalObject.Map && value instanceof globalObject.Map)
        || (globalObject.Set && value instanceof globalObject.Set);
      if (!standardPrototype && !builtIn) {
        try {
          clone.call(globalObject, value);
        } catch {
          return this._encodeHostObject(value);
        }
      }
    }
    if (seen.has(value)) return appendBytes(Uint8Array.of(0x15), uint32Bytes(seen.get(value)));
    const id = seen.size;
    seen.set(value, id);

    if (value instanceof globalObject.ArrayBuffer) {
      const bytes = new globalObject.Uint8Array(value);
      return appendBytes(appendBytes(Uint8Array.of(TAG.ARRAY_BUFFER), uint32Bytes(id)),
                         appendBytes(uint32Bytes(bytes.length), new Uint8Array(bytes)));
    }
    if (globalObject.Date && value instanceof globalObject.Date) {
      const result = appendBytes(Uint8Array.of(TAG.DATE), uint32Bytes(id));
      const number = new Uint8Array(8);
      new DataView(number.buffer).setFloat64(0, value.getTime(), true);
      return appendBytes(result, number);
    }
    if (globalObject.RegExp && value instanceof globalObject.RegExp) {
      return appendBytes(appendBytes(appendBytes(Uint8Array.of(TAG.REGEXP), uint32Bytes(id)),
        this._encodeString(value.source)), this._encodeString(value.flags));
    }
    if (globalObject.Map && value instanceof globalObject.Map) {
      let result = appendBytes(Uint8Array.of(TAG.MAP), uint32Bytes(id));
      result = appendBytes(result, uint32Bytes(value.size));
      for (const [key, entry] of value) {
        result = appendBytes(result, this._encodeValue(key, seen));
        result = appendBytes(result, this._encodeValue(entry, seen));
      }
      return result;
    }
    if (globalObject.Set && value instanceof globalObject.Set) {
      let result = appendBytes(Uint8Array.of(TAG.SET), uint32Bytes(id));
      result = appendBytes(result, uint32Bytes(value.size));
      for (const entry of value) result = appendBytes(result, this._encodeValue(entry, seen));
      return result;
    }

    // A proxy over an otherwise ordinary object is one of the browser-native
    // structured-clone cases that cannot be represented by property walking.
    // The empty-object check avoids rejecting ordinary objects containing a
    // host-only child, which the recursive encoder can handle explicitly.
    if (clone && globalObject.Object.getPrototypeOf(value) === globalObject.Object.prototype
        && globalObject.Object.keys(value).length === 0) {
      try {
        clone.call(globalObject, value);
      } catch {
        // A browser host object may present as an empty ordinary object but
        // still carry a non-Object constructor. Let the default hook report
        // that native-only boundary explicitly; genuine proxy objects retain
        // Node's configurable data-clone error behavior.
        if (this._getDataCloneError === globalObject.Error
            || (value.constructor?.name && value.constructor.name !== 'Object')) {
          return this._encodeHostObject(value);
        }
        makeDataCloneError(this, value, globalObject);
      }
    }

    const isArray = globalObject.Array.isArray(value);
    let result = appendBytes(Uint8Array.of(isArray ? TAG.ARRAY : TAG.OBJECT), uint32Bytes(id));
    const keys = globalObject.Object.keys(value);
    result = appendBytes(result, uint32Bytes(isArray ? value.length : keys.length));
    if (isArray) {
      for (let index = 0; index < value.length; index += 1) {
        result = appendBytes(result, this._encodeValue(value[index], seen));
      }
    } else {
      for (const key of keys) {
        result = appendBytes(result, this._encodeString(key));
        result = appendBytes(result, this._encodeValue(value[key], seen));
      }
    }
    return result;
  }

  _encodeString(value) {
    const bytes = new this._globalObject.TextEncoder().encode(String(value));
    return appendBytes(uint32Bytes(bytes.length), bytes);
  }

  writeValue(value) {
    if (isSimpleNodeGraph(value, this._globalObject)) {
      this._append(encodeNodeValue(value, this._globalObject, new Map()));
      return true;
    }
    this._append(this._encodeValue(value, new Map()));
    return true;
  }

  releaseBuffer() {
    let result;
    if (this._globalObject.Buffer?.alloc) {
      result = this._globalObject.Buffer.alloc(this._bytes.length);
      result.set(this._bytes);
    } else {
      result = new this._globalObject.Uint8Array(this._bytes);
    }
    this._bytes = new Uint8Array();
    return result;
  }

  _writeHostObject(value) {
    const error = new this._globalObject.Error(
      `Unserializable host object: ${value?.constructor?.name || 'Object'} {}`,
    );
    error.code = 'ERR_UNSUPPORTED_WEB_CAPABILITY';
    error.capability = 'v8 host objects';
    error.status = 'unsupported-capability';
    throw error;
  }
}

class Deserializer {
  constructor(buffer, globalObject) {
    this._globalObject = globalObject;
    if (!isArrayBufferView(buffer, globalObject)) {
      throw new TypeError('buffer must be a TypedArray or a DataView');
    }
    this.buffer = buffer;
    this._bytes = new globalObject.Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this._offset = 0;
    this._headerRead = false;
    this._transferredArrayBuffers = new Map();
  }

  readHeader() {
    if (this._bytes.length - this._offset < V8_HEADER.length
        || this._bytes[this._offset] !== V8_HEADER[0]
        || this._bytes[this._offset + 1] === 0
        || this._bytes[this._offset + 1] > WIRE_FORMAT_VERSION) {
      throw new this._globalObject.Error('Unable to deserialize cloned data.');
    }
    this._offset += V8_HEADER.length;
    this._wireFormatVersion = this._bytes[1];
    this._headerRead = true;
    return true;
  }

  getWireFormatVersion() {
    return this._wireFormatVersion ?? WIRE_FORMAT_VERSION;
  }

  _readVarint() {
    let result = 0;
    let shift = 0;
    while (shift < 35) {
      this._need(1);
      const byte = this._bytes[this._offset++];
      result += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    throw new this._globalObject.Error('Unable to deserialize cloned data.');
  }

  _readNodeString(tag) {
    const byteLength = this._readVarint();
    const bytes = this.readRawBytes(byteLength);
    if (tag === NODE_TAG.ONE_BYTE_STRING) {
      return String.fromCharCode(...bytes);
    }
    return new this._globalObject.TextDecoder().decode(bytes);
  }

  _readNodeValue(seen) {
    this._need(1);
    const tag = this._bytes[this._offset++];
    if (tag === NODE_TAG.UNDEFINED) return undefined;
    if (tag === NODE_TAG.NULL) return null;
    if (tag === NODE_TAG.FALSE) return false;
    if (tag === NODE_TAG.TRUE) return true;
    if (tag === NODE_TAG.INT32) {
      const encoded = this._readVarint();
      return (encoded >>> 1) ^ -(encoded & 1);
    }
    if (tag === NODE_TAG.UINT32) return this._readVarint() >>> 0;
    if (tag === NODE_TAG.DOUBLE) return this.readDouble();
    if (tag === NODE_TAG.UTF8_STRING || tag === NODE_TAG.ONE_BYTE_STRING) {
      return this._readNodeString(tag);
    }
    if (tag === NODE_TAG.OBJECT_REFERENCE) return seen[this._readVarint()];
    if (tag === NODE_TAG.HOST_OBJECT) {
      this._need(2);
      const typeIndex = this._bytes[this._offset++];
      const byteLength = this._bytes[this._offset++];
      const ctor = arrayBufferViewConstructor(typeIndex, this._globalObject);
      if (!ctor) throw new this._globalObject.Error('Unable to deserialize cloned data.');
      const offset = this._readRawBytes(byteLength);
      const absoluteOffset = this._bytes.byteOffset + offset;
      const bytesPerElement = ctor.BYTES_PER_ELEMENT || 1;
      if (absoluteOffset % bytesPerElement === 0) {
        return new ctor(this._bytes.buffer, absoluteOffset, byteLength / bytesPerElement);
      }
      const copy = new this._globalObject.ArrayBuffer(byteLength);
      new this._globalObject.Uint8Array(copy).set(
        new this._globalObject.Uint8Array(this._bytes.buffer, absoluteOffset, byteLength),
      );
      return new ctor(copy, 0, byteLength / bytesPerElement);
    }
    if (tag === NODE_TAG.BEGIN_OBJECT) {
      const result = {};
      const id = seen.length;
      seen.push(result);
      let propertyCount = 0;
      while (true) {
        this._need(1);
        if (this._bytes[this._offset] === NODE_TAG.END_OBJECT) {
          this._offset += 1;
          break;
        }
        const key = this._readNodeValue(seen);
        if (typeof key !== 'string') throw new this._globalObject.Error('Unable to deserialize cloned data.');
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: this._readNodeValue(seen),
        });
        propertyCount += 1;
      }
      if (this._readVarint() !== propertyCount) throw new this._globalObject.Error('Unable to deserialize cloned data.');
      seen[id] = result;
      return result;
    }
    throw new this._globalObject.Error('Unable to deserialize cloned data.');
  }

  transferArrayBuffer(id, arrayBuffer) {
    if (!Number.isInteger(Number(id)) || Number(id) < 0 || Number(id) > 0xffffffff) {
      throw new TypeError('id must be a uint32');
    }
    if (!(arrayBuffer instanceof this._globalObject.ArrayBuffer)
        && !(this._globalObject.SharedArrayBuffer && arrayBuffer instanceof this._globalObject.SharedArrayBuffer)) {
      throw new TypeError('arrayBuffer must be an ArrayBuffer or SharedArrayBuffer');
    }
    this._transferredArrayBuffers.set(Number(id) >>> 0, arrayBuffer);
  }

  _need(length) {
    if (length < 0 || this._offset + length > this._bytes.length) throw new this._globalObject.Error('Read failed');
  }

  readUint32() {
    this._need(4);
    const value = new DataView(this._bytes.buffer, this._bytes.byteOffset + this._offset, 4).getUint32(0, true);
    this._offset += 4;
    return value;
  }

  readUint64() {
    this._need(8);
    const view = new DataView(this._bytes.buffer, this._bytes.byteOffset + this._offset, 8);
    const low = view.getUint32(0, true);
    const high = view.getUint32(4, true);
    this._offset += 8;
    return [high, low];
  }

  readDouble() {
    if (this._offset + 8 > this._bytes.length) throw new this._globalObject.Error('ReadDouble() failed');
    const value = new DataView(this._bytes.buffer, this._bytes.byteOffset + this._offset, 8).getFloat64(0, true);
    this._offset += 8;
    return value;
  }

  _readRawBytes(length) {
    const size = Number(length);
    if (!Number.isInteger(size) || size < 0) throw new this._globalObject.Error('ReadRawBytes() failed');
    this._need(size);
    const offset = this._offset;
    this._offset += size;
    return offset;
  }

  readRawBytes(length) {
    const offset = this._readRawBytes(length);
    const bytes = new this._globalObject.Uint8Array(this._bytes.buffer, this._bytes.byteOffset + offset, Number(length));
    if (this._globalObject.Buffer?.alloc) {
      const result = this._globalObject.Buffer.alloc(bytes.length);
      result.set(bytes);
      return result;
    }
    return new this._globalObject.Uint8Array(bytes);
  }

  _readString() {
    const length = this.readUint32();
    const bytes = this.readRawBytes(length);
    return new this._globalObject.TextDecoder().decode(bytes);
  }

  _readValue(seen) {
    this._need(1);
    const tag = this._bytes[this._offset++];
    if (tag === 0x15) return seen[this.readUint32()];
    if (tag === TAG.UNDEFINED) return undefined;
    if (tag === TAG.NULL) return null;
    if (tag === TAG.FALSE) return false;
    if (tag === TAG.TRUE) return true;
    if (tag === TAG.NUMBER) return this.readDouble();
    if (tag === TAG.BIGINT) return BigInt(this._readString());
    if (tag === TAG.STRING) return this._readString();
    if (tag === TAG.HOST_OBJECT) {
      const length = this.readUint32();
      const end = this._offset + length;
      this._need(length);
      const value = this._readHostObject?.();
      if (!isObject(value)) throw new this._globalObject.TypeError('readHostObject must return an object');
      if (this._offset > end) throw new this._globalObject.Error('ReadHostObject() failed');
      this._offset = end;
      return value;
    }
    if (tag === TAG.ARRAY_BUFFER) {
      const id = this.readUint32();
      const length = this.readUint32();
      const bytes = this.readRawBytes(length);
      const result = new this._globalObject.ArrayBuffer(length);
      new this._globalObject.Uint8Array(result).set(bytes);
      seen[id] = result;
      return result;
    }
    if (tag === TAG.DATE) {
      const id = this.readUint32();
      const result = new this._globalObject.Date(this.readDouble());
      seen[id] = result;
      return result;
    }
    if (tag === TAG.REGEXP) {
      const id = this.readUint32();
      const result = new this._globalObject.RegExp(this._readString(), this._readString());
      seen[id] = result;
      return result;
    }
    if (tag === TAG.MAP) {
      const id = this.readUint32();
      const result = new this._globalObject.Map();
      seen[id] = result;
      const length = this.readUint32();
      for (let index = 0; index < length; index += 1) result.set(this._readValue(seen), this._readValue(seen));
      return result;
    }
    if (tag === TAG.SET) {
      const id = this.readUint32();
      const result = new this._globalObject.Set();
      seen[id] = result;
      const length = this.readUint32();
      for (let index = 0; index < length; index += 1) result.add(this._readValue(seen));
      return result;
    }
    if (tag === TAG.ARRAY || tag === TAG.OBJECT) {
      const id = this.readUint32();
      const length = this.readUint32();
      const result = tag === TAG.ARRAY ? [] : {};
      seen[id] = result;
      if (tag === TAG.ARRAY) {
        for (let index = 0; index < length; index += 1) result.push(this._readValue(seen));
      } else {
        for (let index = 0; index < length; index += 1) {
          const key = this._readString();
          Object.defineProperty(result, key, { configurable: true, enumerable: true, writable: true, value: this._readValue(seen) });
        }
      }
      return result;
    }
    throw new this._globalObject.Error('Unable to deserialize cloned data.');
  }

  readValue() {
    if (!this._headerRead) throw new this._globalObject.Error('Unable to deserialize cloned data.');
    if (this._wireFormatVersion < WIRE_FORMAT_VERSION || isNodeWireTag(this._bytes[this._offset])) {
      return this._readNodeValue([]);
    }
    return this._readValue([]);
  }

  _readHostObject() {
    unsupportedCapability('v8 host objects', 'deserializing native Node bindings is unavailable in the browser runtime');
  }
}

function createDefaultSerializerClass(globalObject) {
  return class DefaultSerializer extends Serializer {
    constructor() {
      super(globalObject);
      this._setTreatArrayBufferViewsAsHostObjects(true);
    }

    _writeHostObject(abView) {
      const BufferClass = globalObject.Buffer;
      let typeIndex = 10;
      if (abView.constructor !== BufferClass && abView.constructor?.name !== 'Buffer') {
        typeIndex = arrayBufferViewType(abView, globalObject);
      }
      if (typeIndex < 0 || (typeIndex === 10 && !BufferClass)) {
        const error = new globalObject.Error(
          `Unserializable host object: ${abView?.constructor?.name || 'Object'} {}`,
        );
        error.code = 'ERR_UNSUPPORTED_WEB_CAPABILITY';
        error.capability = 'v8 host objects';
        error.status = 'unsupported-capability';
        throw error;
      }
      this.writeUint32(typeIndex);
      this.writeUint32(abView.byteLength);
      this.writeRawBytes(abView);
    }
  };
}

function createDefaultDeserializerClass(globalObject) {
  return class DefaultDeserializer extends Deserializer {
    constructor(buffer) {
      super(buffer, globalObject);
    }

    _readHostObject() {
      const typeIndex = this.readUint32();
      const ctor = typeIndex === 10 ? globalObject.Buffer : arrayBufferViewConstructor(typeIndex, globalObject);
      const byteLength = this.readUint32();
      if (!ctor) throw new globalObject.Error('Unable to deserialize cloned data.');
      const offset = this._readRawBytes(byteLength);
      const source = new globalObject.Uint8Array(this._bytes.buffer, this._bytes.byteOffset + offset, byteLength);
      if (typeIndex === 10 && globalObject.Buffer?.from) return globalObject.Buffer.from(source);
      const bytesPerElement = ctor.BYTES_PER_ELEMENT || 1;
      const absoluteOffset = this._bytes.byteOffset + offset;
      if (absoluteOffset % bytesPerElement === 0) {
        return new ctor(this._bytes.buffer, absoluteOffset, byteLength / bytesPerElement);
      }
      const copy = new globalObject.ArrayBuffer(byteLength);
      new globalObject.Uint8Array(copy).set(source);
      return new ctor(copy, 0, byteLength / bytesPerElement);
    }
  };
}

function publicConstructor(name, create, prototype) {
  function PublicConstructor(...args) {
    if (!new.target) {
      const error = new TypeError(`Class constructor ${name} cannot be invoked without 'new'`);
      error.code = 'ERR_CONSTRUCT_CALL_REQUIRED';
      throw error;
    }
    return create(...args);
  }
  Object.defineProperty(PublicConstructor, 'name', { configurable: true, value: name });
  PublicConstructor.prototype = prototype;
  return PublicConstructor;
}

export function createV8Module(processObject, globalObject = globalThis) {
  const serializeCallbacks = [];
  const deserializeCallbacks = [];
  let deserializeMainFunction = null;
  const promiseHooks = createUnsupportedPromiseHooks();
  const DefaultSerializer = createDefaultSerializerClass(globalObject);
  const DefaultDeserializer = createDefaultDeserializerClass(globalObject);

  // Node exposes Error as the default data-clone-error factory. Keep the
  // property writable so callers can install a custom factory.
  Serializer.prototype._getDataCloneError = globalObject.Error;

  function serialize(value) {
    const serializer = new DefaultSerializer();
    serializer.writeHeader();
    serializer.writeValue(value);
    return serializer.releaseBuffer();
  }

  function deserialize(buffer) {
    const deserializer = new DefaultDeserializer(buffer);
    deserializer.readHeader();
    return deserializer.readValue();
  }

  function isStringOneByteRepresentation(content) {
    validateString(content, 'content');
    for (let index = 0; index < content.length; index += 1) {
      if (content.charCodeAt(index) > 0xff) return false;
    }
    return true;
  }

  function setFlagsFromString(flags) {
    validateString(flags, 'flags');
    return unsupportedCapability(
      'v8.setFlagsFromString',
      'changing native V8 flags is unavailable in the browser runtime',
    );
  }

  function setHeapSnapshotNearHeapLimit(limit) {
    validateUint32(limit, 'limit', true);
    return unsupportedCapability(
      'v8.setHeapSnapshotNearHeapLimit',
      'native heap-limit callbacks are unavailable in the browser runtime',
    );
  }

  function queryObjects(ctor, options = undefined) {
    if (typeof ctor !== 'function') throw invalidArgumentType('ctor', 'function', ctor);
    if (options !== undefined) validateOptionsObject(options, 'options');
    const format = options?.format ?? 'count';
    if (format !== 'count' && format !== 'summary') {
      throw invalidArgumentValue('options.format', format, 'must be one of "count" or "summary"');
    }
    return unsupportedCapability(
      'v8.queryObjects',
      'enumerating the native V8 heap is unavailable in the browser runtime',
    );
  }

  function writeHeapSnapshot(filename = undefined, options = undefined) {
    if (filename !== undefined) {
      const isURL = globalObject.URL && filename instanceof globalObject.URL;
      const isBuffer = globalObject.Buffer && filename instanceof globalObject.Buffer;
      if (typeof filename !== 'string' && !isURL && !isBuffer) {
        throw invalidArgumentType('path', 'string or an instance of Buffer or URL', filename);
      }
    }
    if (options !== undefined) validateOptionsObject(options, 'options');
    return unsupportedCapability(
      'v8.writeHeapSnapshot',
      'writing native V8 heap snapshots is unavailable in the browser runtime',
    );
  }

  function getCppHeapStatistics(type = 'detailed') {
    if (type !== 'brief' && type !== 'detailed') {
      throw invalidArgumentValue('type', type, 'must be "brief" or "detailed"');
    }
    return browserCppHeapStatistics(type, globalObject);
  }

  // Coverage collection is controlled by the browser's inspector rather than
  // NODE_V8_COVERAGE. Keep these calls harmless when no inspector adapter is
  // installed, matching Node's no-op behavior when coverage is disabled.
  function takeCoverage() {}
  function stopCoverage() {}

  const startupSnapshot = {
    addSerializeCallback(callback, ...args) {
      requireCallback(callback, 'serialize');
      serializeCallbacks.push({ callback, args });
    },
    addDeserializeCallback(callback, ...args) {
      requireCallback(callback, 'deserialize');
      deserializeCallbacks.push({ callback, args });
    },
    setDeserializeMainFunction(callback, ...args) {
      requireCallback(callback, 'deserialize main');
      deserializeMainFunction = { callback, args };
    },
    isBuildingSnapshot: () => hasFlag(processObject, '--build-snapshot'),
    isTakingSnapshot: () => hasFlag(processObject, '--snapshot-blob') && !hasFlag(processObject, '--build-snapshot'),
    _callbacks: { serializeCallbacks, deserializeCallbacks, get deserializeMainFunction() { return deserializeMainFunction; } },
  };

  return {
    startupSnapshot,
    Serializer: publicConstructor('Serializer', () => new Serializer(globalObject), Serializer.prototype),
    Deserializer: publicConstructor('Deserializer', (buffer) => new Deserializer(buffer, globalObject), Deserializer.prototype),
    DefaultSerializer,
    DefaultDeserializer,
    serialize,
    deserialize,
    getCppHeapStatistics,
    isStringOneByteRepresentation,
    promiseHooks,
    queryObjects,
    setFlagsFromString,
    setHeapSnapshotNearHeapLimit,
    stopCoverage,
    takeCoverage,
    writeHeapSnapshot,
  };
}
