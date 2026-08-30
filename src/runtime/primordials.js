function uncurry(method) {
  return typeof method === 'function' ? Function.call.bind(method) : undefined;
}

function getter(target, property) {
  return uncurry(Object.getOwnPropertyDescriptor(target, property)?.get);
}

function prototypeMethods(primordials, constructor, prefix, names) {
  for (const name of names) {
    const method = constructor?.prototype?.[name];
    if (typeof method === 'function') primordials[`${prefix}Prototype${name[0].toUpperCase()}${name.slice(1)}`] = uncurry(method);
  }
}

function promiseHelpers(primordials) {
  primordials.SafePromiseAll = (iterable) => Promise.all(iterable);
  primordials.SafePromiseAllReturnArrayLike = (iterable) => Promise.all(iterable);
  primordials.SafePromiseAllReturnVoid = (iterable) => Promise.all(iterable).then(() => undefined);
  primordials.SafePromiseAllSettled = (iterable) => Promise.allSettled(iterable);
  primordials.SafePromiseAllSettledReturnVoid = (iterable) => Promise.allSettled(iterable).then(() => undefined);
  primordials.SafePromiseAny = (iterable) => Promise.any(iterable);
  primordials.SafePromiseRace = (iterable) => Promise.race(iterable);
  primordials.PromiseResolve = Promise.resolve.bind(Promise);
  primordials.PromiseReject = Promise.reject.bind(Promise);
  primordials.PromiseWithResolvers = Promise.withResolvers
    ? Promise.withResolvers.bind(Promise)
    : () => {
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    };
}

function regexpGetters(primordials) {
  const descriptors = {
    DotAll: 'dotAll', Global: 'global', HasIndices: 'hasIndices', IgnoreCase: 'ignoreCase',
    Multiline: 'multiline', Source: 'source', Sticky: 'sticky', Unicode: 'unicode',
    Flags: 'flags',
  };
  for (const [name, property] of Object.entries(descriptors)) {
    const get = getter(RegExp.prototype, property);
    if (get) primordials[`RegExpPrototypeGet${name}`] = get;
  }
}

export function createPrimordials(globalObject = globalThis) {
  const detachedArrayBuffers = new WeakSet();
  const arrayBufferTransfer = uncurry(ArrayBuffer.prototype.transfer)
    || (typeof globalObject?.structuredClone === 'function'
      ? uncurry(function transfer(newLength = this.byteLength) {
          const source = this;
          const moved = globalObject.structuredClone(source, { transfer: [source] });
          detachedArrayBuffers.add(source);
          if (newLength === moved.byteLength) return moved;
          const resized = new ArrayBuffer(newLength);
          new Uint8Array(resized).set(new Uint8Array(moved).subarray(0, newLength));
          return resized;
        })
      : undefined);
  const arrayBufferDetached = getter(ArrayBuffer.prototype, 'detached')
    || uncurry(function detached() { return detachedArrayBuffers.has(this); });
  const primordials = {
    Array, ArrayBuffer, ArrayBufferIsView: ArrayBuffer.isView, Boolean, DataView, Date, Error, EvalError,
    FinalizationRegistry, Float32Array, Float64Array, Function, Int8Array, Int16Array,
    Int32Array, Map, Number, Object, Promise, Proxy, RangeError, ReferenceError, Reflect,
    RegExp, Set, SharedArrayBuffer: globalObject.SharedArrayBuffer, String, Symbol, SyntaxError, TypeError, URIError,
    Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, WeakMap, WeakRef, WeakSet,
    AggregateError, BigInt, BigInt64Array, BigUint64Array, JSON, Math, WebAssembly,
    ArrayBufferPrototypeTransfer: arrayBufferTransfer,
    ArrayBufferPrototypeGetDetached: arrayBufferDetached,
    globalThis: globalObject,
    ObjectPrototype: Object.prototype,
    FunctionPrototype: Function.prototype,
    ArrayPrototype: Array.prototype,
    StringPrototype: String.prototype,
    NumberPrototype: Number.prototype,
    BooleanPrototype: Boolean.prototype,
    RegExpPrototype: RegExp.prototype,
    PromisePrototype: Promise.prototype,
    MapPrototype: Map.prototype,
    SetPrototype: Set.prototype,
    WeakMapPrototype: WeakMap.prototype,
    WeakSetPrototype: WeakSet.prototype,
    AggregateErrorPrototype: AggregateError.prototype,
    ArrayBufferPrototype: ArrayBuffer.prototype,
    DataViewPrototype: DataView.prototype,
    DatePrototype: Date.prototype,
    ErrorPrototype: Error.prototype,
    RangeErrorPrototype: RangeError.prototype,
    SyntaxErrorPrototype: SyntaxError.prototype,
    TypeErrorPrototype: TypeError.prototype,
    NumberPrototype: Number.prototype,
    BooleanPrototype: Boolean.prototype,
    TypedArray: Object.getPrototypeOf(Uint8Array),
    TypedArrayPrototype: Object.getPrototypeOf(Uint8Array).prototype,
    ArrayIteratorPrototype: Object.getPrototypeOf([][Symbol.iterator]()),
    StringIteratorPrototype: Object.getPrototypeOf(''[Symbol.iterator]()),
    IteratorPrototype: Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
    SafeMap: Map,
    SafeSet: Set,
    SafeWeakMap: WeakMap,
    SafeWeakSet: WeakSet,
    SafeWeakRef: WeakRef,
    SafeFinalizationRegistry: FinalizationRegistry,
    ObjectAssign: Object.assign,
    ObjectCreate: Object.create,
    ObjectDefineProperty: Object.defineProperty,
    ObjectDefineProperties: Object.defineProperties,
    ObjectEntries: Object.entries,
    ObjectFreeze: Object.freeze,
    ObjectFromEntries: Object.fromEntries,
    ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    ObjectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
    ObjectGetOwnPropertyNames: Object.getOwnPropertyNames,
    ObjectGetOwnPropertySymbols: Object.getOwnPropertySymbols,
    ObjectGetPrototypeOf: Object.getPrototypeOf,
    ObjectHasOwn: Object.hasOwn || ((value, key) => Object.prototype.hasOwnProperty.call(value, key)),
    ObjectIs: Object.is,
    ObjectIsExtensible: Object.isExtensible,
    ObjectKeys: Object.keys,
    ObjectSetPrototypeOf: Object.setPrototypeOf,
    ObjectValues: Object.values,
    ReflectApply: Reflect.apply,
    ReflectConstruct: Reflect.construct,
    ReflectDefineProperty: Reflect.defineProperty,
    ReflectGet: Reflect.get,
    ReflectGetOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
    ReflectGetPrototypeOf: Reflect.getPrototypeOf,
    ReflectOwnKeys: Reflect.ownKeys,
    ReflectSet: Reflect.set,
    ObjectSeal: Object.seal,
    FunctionPrototypeApply: Function.prototype.apply,
    FunctionPrototypeBind: Function.prototype.bind,
    FunctionPrototypeCall: Function.prototype.call,
    FunctionPrototypeToString: Function.prototype.toString,
    ErrorCaptureStackTrace: Error.captureStackTrace || (() => {}),
    ArrayFrom: Array.from,
    ArrayIsArray: Array.isArray,
    NumberIsFinite: Number.isFinite,
    NumberIsInteger: Number.isInteger,
    NumberIsNaN: Number.isNaN,
    NumberIsSafeInteger: Number.isSafeInteger,
    NumberMAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    NumberMIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
    NumberParseFloat: Number.parseFloat,
    NumberParseInt: Number.parseInt,
    JSONParse: JSON.parse,
    JSONStringify: JSON.stringify,
    SymbolFor: Symbol.for,
    SymbolAsyncIterator: Symbol.asyncIterator,
    SymbolIterator: Symbol.iterator,
    SymbolMatch: Symbol.match,
    SymbolMatchAll: Symbol.matchAll,
    SymbolReplace: Symbol.replace,
    SymbolSearch: Symbol.search,
    SymbolSpecies: Symbol.species,
    SymbolSplit: Symbol.split,
    SymbolToStringTag: Symbol.toStringTag,
    SymbolHasInstance: Symbol.hasInstance,
    MathAbs: Math.abs,
    MathCeil: Math.ceil,
    MathFloor: Math.floor,
    MathMax: Math.max,
    MathMin: Math.min,
    MathPow: Math.pow,
    MathRound: Math.round,
    MathSqrt: Math.sqrt,
    MathTrunc: Math.trunc,
    MathSign: Math.sign,
    DateNow: Date.now,
    StringFromCharCode: String.fromCharCode,
    StringFromCodePoint: String.fromCodePoint,
    decodeURI,
    decodeURIComponent,
    encodeURI,
    encodeURIComponent,
    uncurryThis: uncurry,
    SymbolToPrimitive: Symbol.toPrimitive,
  };
  prototypeMethods(primordials, Array, 'Array', ['at', 'concat', 'copyWithin', 'every', 'fill', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'lastIndexOf', 'map', 'pop', 'push', 'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort', 'splice', 'toReversed', 'toSorted', 'unshift', 'with']);
  prototypeMethods(primordials, String, 'String', ['at', 'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'localeCompare', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'search', 'slice', 'split', 'startsWith', 'substring', 'toLocaleLowerCase', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'valueOf']);
  prototypeMethods(primordials, RegExp, 'RegExp', ['exec', 'test', 'toString']);
  prototypeMethods(primordials, Function, 'Function', ['bind', 'call', 'apply', 'toString']);
  prototypeMethods(primordials, Map, 'Map', ['clear', 'entries', 'forEach', 'get', 'has', 'keys', 'set', 'values']);
  prototypeMethods(primordials, Set, 'Set', ['add', 'clear', 'entries', 'forEach', 'has', 'values']);
  prototypeMethods(primordials, Promise, 'Promise', ['then', 'catch', 'finally']);
  prototypeMethods(primordials, Number, 'Number', ['toString', 'valueOf']);
  prototypeMethods(primordials, Boolean, 'Boolean', ['valueOf']);
  prototypeMethods(primordials, BigInt, 'BigInt', ['toString', 'valueOf']);
  prototypeMethods(primordials, Date, 'Date', ['getTime', 'toISOString', 'toString']);
  prototypeMethods(primordials, Error, 'Error', ['toString']);
  prototypeMethods(primordials, Object, 'Object', ['hasOwnProperty', 'propertyIsEnumerable', 'toString']);
  prototypeMethods(primordials, Symbol, 'Symbol', ['toString', 'valueOf']);
  prototypeMethods(primordials, ArrayBuffer, 'ArrayBuffer', ['slice']);
  prototypeMethods(primordials, DataView, 'DataView', ['getInt8', 'getUint8', 'getInt16', 'getUint16', 'getInt32', 'getUint32']);
  prototypeMethods(primordials, Uint8Array, 'TypedArray', ['at', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find', 'findIndex', 'forEach', 'includes', 'indexOf', 'join', 'map', 'reduce', 'reverse', 'set', 'slice', 'some', 'sort', 'subarray', 'values']);
  regexpGetters(primordials);
  promiseHelpers(primordials);
  primordials.ArrayPrototypePushApply = (target, values) => Array.prototype.push.apply(target, values);
  primordials.ArrayPrototypeUnshiftApply = (target, values) => Array.prototype.unshift.apply(target, values);
  primordials.ArrayPrototypePush = uncurry(Array.prototype.push);
  primordials.ArrayPrototypeUnshift = uncurry(Array.prototype.unshift);
  primordials.StringPrototypeReplace = uncurry(String.prototype.replace);
  primordials.StringPrototypeReplaceAll = uncurry(String.prototype.replaceAll);
  primordials.ObjectPrototypeHasOwnProperty = uncurry(Object.prototype.hasOwnProperty);
  primordials.ObjectPrototypeIsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
  primordials.FunctionPrototypeSymbolHasInstance = uncurry(Function.prototype[Symbol.hasInstance]);
  primordials.RegExpPrototypeSymbolReplace = uncurry(RegExp.prototype[Symbol.replace]);
  primordials.RegExpPrototypeSymbolSplit = uncurry(RegExp.prototype[Symbol.split]);
  const mapSize = getter(Map.prototype, 'size');
  if (mapSize) primordials.MapPrototypeGetSize = mapSize;
  const setSize = getter(Set.prototype, 'size');
  if (setSize) primordials.SetPrototypeGetSize = setSize;
  primordials.SetPrototypeValues = uncurry(Set.prototype.values);
  primordials.SymbolPrototypeToString = uncurry(Symbol.prototype.toString);
  primordials.SymbolPrototypeValueOf = uncurry(Symbol.prototype.valueOf);
  const arrayBufferByteLength = getter(ArrayBuffer.prototype, 'byteLength');
  if (arrayBufferByteLength) primordials.ArrayBufferPrototypeGetByteLength = arrayBufferByteLength;
  const dataViewByteLength = getter(DataView.prototype, 'byteLength');
  if (dataViewByteLength) primordials.DataViewPrototypeGetByteLength = dataViewByteLength;
  const dataViewByteOffset = getter(DataView.prototype, 'byteOffset');
  if (dataViewByteOffset) primordials.DataViewPrototypeGetByteOffset = dataViewByteOffset;
  const dataViewBuffer = getter(DataView.prototype, 'buffer');
  if (dataViewBuffer) primordials.DataViewPrototypeGetBuffer = dataViewBuffer;
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayLength = getter(typedArrayPrototype, 'length');
  if (typedArrayLength) primordials.TypedArrayPrototypeGetLength = typedArrayLength;
  const typedArrayBuffer = getter(typedArrayPrototype, 'buffer');
  if (typedArrayBuffer) primordials.TypedArrayPrototypeGetBuffer = typedArrayBuffer;
  const typedArrayByteLength = getter(typedArrayPrototype, 'byteLength');
  if (typedArrayByteLength) primordials.TypedArrayPrototypeGetByteLength = typedArrayByteLength;
  const typedArrayByteOffset = getter(typedArrayPrototype, 'byteOffset');
  if (typedArrayByteOffset) primordials.TypedArrayPrototypeGetByteOffset = typedArrayByteOffset;
  const typedArrayToStringTag = getter(typedArrayPrototype, Symbol.toStringTag);
  if (typedArrayToStringTag) primordials.TypedArrayPrototypeGetSymbolToStringTag = typedArrayToStringTag;
  // Node's safe iterators are callable with `new`; iterator prototypes are
  // not constructors, so expose small wrappers that return fresh iterators.
  primordials.SafeArrayIterator = function SafeArrayIterator(iterable) {
    return Array.from(iterable)[Symbol.iterator]();
  };
  primordials.SafeStringIterator = function SafeStringIterator(iterable) {
    return String(iterable)[Symbol.iterator]();
  };
  const symbolDescription = getter(Symbol.prototype, 'description');
  if (symbolDescription) primordials.SymbolPrototypeGetDescription = symbolDescription;
  return Object.freeze(primordials);
}
