import { createVmModule } from './vm.js';
import { AsyncResource } from './async-hooks.js';

const SIGNALS = Object.freeze({
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9,
  SIGPIPE: 13,
});

const objectToString = Object.prototype.toString;

function isArrayBuffer(value) {
  return value !== null && typeof value === 'object'
    && objectToString.call(value) === '[object ArrayBuffer]';
}

function isSharedArrayBuffer(value) {
  return value !== null && typeof value === 'object'
    && objectToString.call(value) === '[object SharedArrayBuffer]';
}

function bindingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defineLazyProperties(target, properties) {
  for (const [name, getter] of Object.entries(properties || {})) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: getter,
    });
  }
  return target;
}

function createTypes() {
  return {
    isNativeError: (value) => value instanceof Error,
    isPromise: (value) => value instanceof Promise,
    isArrayBufferView: (value) => ArrayBuffer.isView(value),
    isAnyArrayBuffer: (value) => isArrayBuffer(value) || isSharedArrayBuffer(value),
  };
}

function createBufferBinding(globalObject) {
  const bytesOf = (value) => {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value || 0);
  };
  const bufferOf = (value, encoding) => {
    const BufferClass = globalObject.Buffer;
    if (typeof BufferClass?.from === 'function') return BufferClass.from(value, encoding);
    return bytesOf(value);
  };
  const copy = (source, target, targetStart = 0, sourceStart = 0, sourceEnd = bytesOf(source).byteLength) => {
    const input = bytesOf(source).subarray(sourceStart, sourceEnd);
    const output = bytesOf(target);
    const length = Math.min(input.byteLength, Math.max(0, output.byteLength - targetStart));
    output.set(input.subarray(0, length), targetStart);
    return length;
  };
  const compare = (left, right) => {
    const a = bytesOf(left);
    const b = bytesOf(right);
    const length = Math.min(a.byteLength, b.byteLength);
    for (let index = 0; index < length; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return Math.sign(a.byteLength - b.byteLength);
  };
  const decode = (value, encoding) => bufferOf(bytesOf(value)).toString?.(encoding) || '';
  const write = (target, value, offset = 0, length = bytesOf(target).byteLength - offset, encoding) => {
    const source = bufferOf(String(value), encoding);
    const output = bytesOf(target);
    const count = Math.min(length, source.byteLength, output.byteLength - offset);
    output.set(bytesOf(source).subarray(0, count), offset);
    return count;
  };
  return {
    byteLengthUtf8: (value) => new TextEncoder().encode(String(value)).byteLength,
    compare,
    compareOffset: (left, right, leftStart = 0, leftEnd, rightStart = 0, rightEnd) => compare(
      bytesOf(left).subarray(leftStart, leftEnd),
      bytesOf(right).subarray(rightStart, rightEnd),
    ),
    copy,
    fill(target, value, start = 0, end = bytesOf(target).byteLength, encoding) {
      const output = bytesOf(target);
      const source = typeof value === 'number' ? value & 0xff : bytesOf(bufferOf(value, encoding))[0] || 0;
      output.fill(source, start, end);
      return target;
    },
    isAscii: (value) => bytesOf(value).every((byte) => byte < 128),
    isUtf8: (value) => {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(value)); return true; } catch { return false; }
    },
    indexOfBuffer: (source, value, byteOffset = 0, dir = 1) => {
      const input = bytesOf(source); const needle = bytesOf(value);
      if (!needle.byteLength) return byteOffset;
      if (dir < 0) {
        for (let index = Math.min(byteOffset, input.byteLength - needle.byteLength); index >= 0; index -= 1) {
          if (compare(input.subarray(index, index + needle.byteLength), needle) === 0) return index;
        }
        return -1;
      }
      for (let index = Math.max(0, byteOffset); index <= input.byteLength - needle.byteLength; index += 1) {
        if (compare(input.subarray(index, index + needle.byteLength), needle) === 0) return index;
      }
      return -1;
    },
    indexOfNumber: (source, value, byteOffset = 0, dir = 1) => {
      const input = bytesOf(source);
      if (dir < 0) return input.lastIndexOf(value & 0xff, byteOffset);
      return input.indexOf(value & 0xff, byteOffset);
    },
    indexOfString: (source, value, byteOffset = 0, encoding = 'utf8', dir = 1) => (
      globalObject.Buffer?.from(bytesOf(source)).indexOf?.(String(value), byteOffset, encoding) ?? -1
    ),
    swap16: (value) => { const bytes = bytesOf(value); for (let i = 0; i + 1 < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]]; return value; },
    swap32: (value) => { const bytes = bytesOf(value); for (let i = 0; i + 3 < bytes.length; i += 4) { [bytes[i], bytes[i + 3]] = [bytes[i + 3], bytes[i]]; [bytes[i + 1], bytes[i + 2]] = [bytes[i + 2], bytes[i + 1]]; } return value; },
    swap64: (value) => { const bytes = bytesOf(value); for (let i = 0; i + 7 < bytes.length; i += 8) for (let j = 0; j < 4; j += 1) [bytes[i + j], bytes[i + 7 - j]] = [bytes[i + 7 - j], bytes[i + j]]; return value; },
    asciiSlice: (value, start, end) => decode(value, 'ascii').slice(start, end),
    base64Slice: (value, start, end) => decode(value, 'base64').slice(start, end),
    base64urlSlice: (value, start, end) => decode(value, 'base64url').slice(start, end),
    latin1Slice: (value, start, end) => decode(value, 'latin1').slice(start, end),
    hexSlice: (value, start, end) => decode(value, 'hex').slice(start, end),
    ucs2Slice: (value, start, end) => decode(value, 'ucs2').slice(start, end),
    utf8Slice: (value, start, end) => decode(value, 'utf8').slice(start, end),
    asciiWriteStatic: write,
    base64Write: write,
    base64urlWrite: write,
    latin1WriteStatic: write,
    hexWrite: write,
    ucs2Write: write,
    utf8WriteStatic: write,
    createUnsafeArrayBuffer: (size) => new ArrayBuffer(Number(size) || 0),
    copyArrayBuffer: (source, target, targetOffset = 0, sourceStart = 0, sourceEnd) => copy(
      new Uint8Array(source, sourceStart, sourceEnd === undefined ? source.byteLength - sourceStart : sourceEnd - sourceStart),
      new Uint8Array(target), targetOffset,
    ),
    setBufferPrototype() {},
    kMaxLength: 0x7fffffff,
    kStringMaxLength: 0x1fffffe8,
    atob: (value) => globalObject.atob(String(value)),
    btoa: (value) => globalObject.btoa(String(value)),
  };
}

function createUtilBinding() {
  const privateSymbols = Object.freeze({
    arrow_message_private_symbol: Symbol('arrow_message'),
    decorated_private_symbol: Symbol('decorated'),
  });
  return {
    constants: new Proxy({
      ALL_PROPERTIES: 0,
      ONLY_ENUMERABLE: 1,
      kPending: 0,
      kRejected: 1,
      kDisallowCloneAndTransfer: 0,
      kTransferable: 1,
      kCloneable: 2,
    }, { get: (target, name) => target[name] ?? 0 }),
    privateSymbols: {
      ...privateSymbols,
      transfer_mode_private_symbol: Symbol('transfer_mode'),
    },
    guessHandleType: () => 'UDP',
    defineLazyProperties,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    arrayBufferViewHasBuffer: (value) => Boolean(value?.buffer),
    getOwnNonIndexProperties: (value) => Object.getOwnPropertyNames(value || {}).filter((name) => !/^\d+$/.test(name)),
    getPromiseDetails: () => [0, undefined],
    getProxyDetails: () => undefined,
    previewEntries: () => undefined,
    getConstructorName: (value) => value?.constructor?.name || '',
    getExternalValue: () => undefined,
    assignFunctionName: (name, fn) => {
      if (typeof fn !== 'function') return fn;
      try { Object.defineProperty(fn, 'name', { configurable: true, value: String(name) }); } catch { /* native name may be immutable */ }
      return fn;
    },
  };
}

function createModulesBinding() {
  return {
    compileCacheStatus: Object.freeze(['FAILED', 'ENABLED', 'ALREADY_ENABLED', 'DISABLED']),
    enableCompileCache: () => [3],
    getCompileCacheDir: () => undefined,
    flushCompileCache() {},
    setLazyPathHelpers() {},
    getNearestParentPackageJSONType: () => undefined,
  };
}

function createTraceEventsBinding() {
  const categoryCounts = new Map();
  const categoryBuffers = new Map();
  let stateUpdateHandler;
  let asyncHooksEnabled = false;

  const categoryNames = (category) => String(category).split(',').map((name) => name.trim()).filter(Boolean);
  const isEnabled = (category) => categoryNames(category).some((name) => name === '*' || categoryCounts.has(name));
  const updateState = () => {
    for (const [category, buffer] of categoryBuffers) buffer[0] = isEnabled(category) ? 1 : 0;
    const nextAsyncHooksEnabled = isEnabled('node.async_hooks');
    if (nextAsyncHooksEnabled !== asyncHooksEnabled) {
      asyncHooksEnabled = nextAsyncHooksEnabled;
      stateUpdateHandler?.(nextAsyncHooksEnabled);
    }
  };
  class CategorySet {
    constructor(categories) {
      if (!Array.isArray(categories)) throw new TypeError('categories must be an array');
      this.categories = [...new Set(categories.map(String))];
      this.enabled = false;
    }

    enable() {
      if (this.enabled) return;
      this.enabled = true;
      for (const category of this.categories) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      updateState();
    }

    disable() {
      if (!this.enabled) return;
      this.enabled = false;
      for (const category of this.categories) {
        const count = categoryCounts.get(category) || 0;
        if (count > 1) categoryCounts.set(category, count - 1);
        else categoryCounts.delete(category);
      }
      updateState();
    }
  }
  return {
    CategorySet,
    getEnabledCategories: () => categoryCounts.size ? [...categoryCounts.keys()].join(',') : undefined,
    setTraceCategoryStateUpdateHandler(handler) {
      if (typeof handler !== 'function') throw new TypeError('trace category state handler must be a function');
      stateUpdateHandler = handler;
    },
    getCategoryEnabledBuffer(category) {
      const name = String(category);
      if (!categoryBuffers.has(name)) categoryBuffers.set(name, new Uint8Array([isEnabled(name) ? 1 : 0]));
      return categoryBuffers.get(name);
    },
    isTraceCategoryEnabled: isEnabled,
    trace(phase, category, name, id, args) {
      if (!isEnabled(category)) return;
      return { phase, category, name, id, args };
    },
  };
}

function createSymbolsBinding() {
  const symbols = new Map();
  const sharedSymbols = {
    vm_dynamic_import_main_context_default: Symbol.for('nodejs.vm_dynamic_import_main_context_default'),
    vm_context_no_contextify: Symbol.for('nodejs.vm_context_no_contextify'),
  };
  return new Proxy({}, {
    get: (_, name) => {
      if (!symbols.has(name)) symbols.set(name, sharedSymbols[name] || Symbol(String(name)));
      return symbols.get(name);
    },
  });
}

function createErrorsBinding() {
  return {
    exitCodes: new Proxy({}, { get: (_, name) => name === 'kNoFailure' ? 0 : 1 }),
    triggerUncaughtException: (error) => { throw error; },
    setPrepareStackTraceCallback() {},
    setEnhanceStackForFatalException() {},
  };
}

function createProcessMethodsBinding() {
  const hrtimeBuffer = new Uint32Array(2);
  return {
    hrtimeBuffer,
    hrtime() {},
    hrtimeBigInt() {},
    _rawDebug: (...args) => console.error(...args),
    causeSegfault() {},
  };
}

function createUrlBinding(globalObject) {
  const urlComponents = [];
  const updateComponents = (href) => {
    const protocolEnd = href.indexOf(':') + 1;
    const authorityStart = href.indexOf('//', protocolEnd);
    const hostStart = authorityStart >= 0 ? authorityStart + 2 : protocolEnd;
    const pathStart = href.indexOf('/', hostStart);
    const searchStart = href.search(/[?#]/);
    const hashStart = href.indexOf('#');
    urlComponents.splice(0, urlComponents.length,
      protocolEnd, href.indexOf('@', hostStart) >= 0 ? href.indexOf('@', hostStart) + 1 : hostStart,
      hostStart, pathStart >= 0 ? pathStart : (searchStart >= 0 ? searchStart : href.length),
      0, pathStart >= 0 ? pathStart : href.length,
      searchStart >= 0 ? searchStart : href.length, hashStart >= 0 ? hashStart : href.length, 0);
    return href;
  };
  const parse = (input, base, raiseException = true) => {
    try { return updateComponents(new globalObject.URL(String(input), base === undefined ? undefined : String(base)).href); }
    catch (error) { if (raiseException) throw error; return undefined; }
  };
  return {
    urlComponents,
    parse,
    canParse: (input, base) => { try { parse(input, base, true); return true; } catch { return false; } },
    update: (href) => parse(href),
    pathToFileURL: (value) => parse(`file://${String(value).startsWith('/') ? '' : '/'}${String(value)}`),
    domainToASCII: (value) => { try { return new globalObject.URL(`http://${value}`).hostname; } catch { return ''; } },
    domainToUnicode: (value) => String(value),
    getOrigin: (value) => { try { return new globalObject.URL(String(value)).origin; } catch { return 'null'; } },
  };
}

function createEncodingBinding(globalObject) {
  const encoder = () => new globalObject.TextEncoder();
  const utf8Decoder = (ignoreBOM = false, fatal = false) => new globalObject.TextDecoder('utf-8', { ignoreBOM, fatal });
  const windows1252Decoder = (ignoreBOM = false, fatal = false) => new globalObject.TextDecoder('windows-1252', { ignoreBOM, fatal });
  const encodeIntoResults = new Uint32Array(2);
  return {
    encodeUtf8String: (value) => encoder().encode(String(value)),
    decodeUTF8: (value, ignoreBOM, fatal) => utf8Decoder(ignoreBOM, fatal).decode(value),
    encodeInto: (source, destination) => {
      const result = encoder().encodeInto(String(source), destination);
      encodeIntoResults[0] = result.read;
      encodeIntoResults[1] = result.written;
    },
    encodeIntoResults,
    decodeWindows1252: (value, ignoreBOM, fatal) => windows1252Decoder(ignoreBOM, fatal).decode(value),
    toASCII: (value) => {
      try { return new globalObject.URL(`http://${String(value)}`).hostname; } catch { return ''; }
    },
  };
}

function createTimerBinding(globalObject) {
  let timerCallback = null;
  let immediateCallback = null;
  let timerHandle = null;
  let timerRefed = true;
  return {
    immediateInfo: new Uint32Array(3),
    timeoutInfo: new Uint32Array(1),
    setupTimers(immediate, timers) {
      immediateCallback = typeof immediate === 'function' ? immediate : null;
      timerCallback = typeof timers === 'function' ? timers : null;
    },
    getLibuvNow: () => Math.trunc((globalObject.performance?.now?.() || 0) + 1),
    scheduleTimer(milliseconds) {
      if (timerHandle !== null) globalObject.clearTimeout(timerHandle);
      if (typeof timerCallback !== 'function') return;
      timerHandle = globalObject.setTimeout(() => {
        timerHandle = null;
        timerCallback(Date.now());
      }, Math.max(1, Number(milliseconds) || 1));
      if (!timerRefed) timerHandle.unref?.();
    },
    toggleTimerRef(value) {
      timerRefed = Boolean(value);
      if (timerRefed) timerHandle?.ref?.();
      else timerHandle?.unref?.();
    },
    toggleImmediateRef(value) {
      if (value) this.immediateInfo[1] += 1;
      else this.immediateInfo[1] = Math.max(0, this.immediateInfo[1] - 1);
      if (!immediateCallback) return;
      if (value && this.immediateInfo[0]) immediateCallback();
    },
  };
}

function createPerformanceBinding(globalObject) {
  const nativePerformance = globalObject.performance;
  const startedAt = typeof nativePerformance?.now === 'function'
    ? nativePerformance.now()
    : 0;
  const now = () => (typeof nativePerformance?.now === 'function'
    ? nativePerformance.now()
    : Date.now() - startedAt);
  const timeOrigin = Number(nativePerformance?.timeOrigin) || Date.now();
  const milestones = new Float64Array(8);
  milestones[0] = timeOrigin * 1000;
  milestones[1] = timeOrigin * 1e6;
  milestones[2] = milestones[1];
  milestones[3] = milestones[1];
  milestones[4] = milestones[1];
  milestones[5] = milestones[1];
  milestones[6] = -1;
  milestones[7] = milestones[1];

  return {
    constants: Object.freeze({
      NODE_PERFORMANCE_ENTRY_TYPE_GC: 0,
      NODE_PERFORMANCE_ENTRY_TYPE_HTTP: 1,
      NODE_PERFORMANCE_ENTRY_TYPE_HTTP2: 2,
      NODE_PERFORMANCE_ENTRY_TYPE_NET: 3,
      NODE_PERFORMANCE_ENTRY_TYPE_DNS: 4,
      NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP: 0,
      NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN: 1,
      NODE_PERFORMANCE_MILESTONE_ENVIRONMENT: 2,
      NODE_PERFORMANCE_MILESTONE_NODE_START: 3,
      NODE_PERFORMANCE_MILESTONE_V8_START: 4,
      NODE_PERFORMANCE_MILESTONE_LOOP_START: 5,
      NODE_PERFORMANCE_MILESTONE_LOOP_EXIT: 6,
      NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE: 7,
    }),
    milestones,
    observerCounts: new Uint32Array(5),
    now,
    installGarbageCollectionTracking() {},
    removeGarbageCollectionTracking() {},
    setupObservers() {},
    markBootstrapComplete() {
      milestones[7] = milestones[1] + now() * 1e6;
    },
    loopIdleTime: () => 0,
    uvMetricsInfo: () => ({ loopCount: 0, events: 0, eventsWaiting: 0 }),
  };
}

function createStreamBinding() {
  // nread carries both byte counts and negative libuv status codes such as
  // UV_EOF, so it must retain signed values.
  const streamBaseState = new Int32Array(4);
  const UV_EOF = -4095;
  class JSStream {
    constructor() {
      this._externalStream = Object.create(null);
      this._externalStream[Symbol.toStringTag] = 'External';
      this._closed = false;
      this._bnhResource = new AsyncResource('JSSTREAM');
    }

    close(callback) {
      this._closed = true;
      callback?.();
    }

    isClosing() { return this._closed; }
    getAsyncId() { return this._bnhResource.asyncId(); }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._bnhResource.triggerAsyncId(); }
    emitDestroy() { this._bnhResource.emitDestroy(); return this; }
    asyncReset() { return undefined; }
    readStart() { return 0; }
    readStop() { return 0; }
    writeBuffer(request, buffer) {
      this.onwrite?.(request, [buffer]);
      return 0;
    }

    shutdown(request) {
      this.onshutdown?.(request);
      return 0;
    }

    emitEOF() {
      streamBaseState[0] = UV_EOF;
      this.onread?.(null);
    }

    readBuffer(buffer) {
      streamBaseState[0] = buffer.byteLength;
      this.onread?.(buffer);
    }
  }
  return { JSStream, streamBaseState };
}

function createStreamWrapBinding(streamBaseState) {
  class WriteWrap {
    constructor() {
      this.handle = null;
      this.bytes = 0;
      this.async = false;
      this.error = null;
      this.oncomplete = null;
      this._bnhResource = null;
    }

    _bnhInitialize() {
      if (!this._bnhResource) this._bnhResource = new AsyncResource('WRITEWRAP');
      return this;
    }

    getAsyncId() { return this._bnhResource?.asyncId() ?? -1; }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._bnhResource?.triggerAsyncId() ?? -1; }
    emitDestroy() { this._bnhResource?.emitDestroy(); return this; }
  }
  class ShutdownWrap extends WriteWrap {}
  return {
    WriteWrap,
    ShutdownWrap,
    kReadBytesOrError: 0,
    kArrayBufferOffset: 1,
    kBytesWritten: 2,
    kLastWriteWasAsync: 3,
    streamBaseState,
  };
}

function createTtyBinding() {
  class TTY {
    constructor(fd, context = {}) {
      this.fd = fd;
      this._closed = false;
      this._refed = true;
      if (!Number.isInteger(fd) || fd < 0) context.code = 'ERR_INVALID_FD';
    }

    close(callback) { this._closed = true; callback?.(); }
    isClosing() { return this._closed; }
    hasRef() { return !this._closed && this._refed; }
    ref() { this._refed = true; return this; }
    unref() { this._refed = false; return this; }
    setRawMode() { return 0; }
    setBlocking() { return 0; }
    getWindowSize(size) {
      if (size) { size[0] = 80; size[1] = 24; }
      return 0;
    }
    writeUtf8String(_value, callback) { callback?.(); return 0; }
  }
  return { TTY, isTTY: (fd) => Number.isInteger(fd) && fd >= 0 && fd <= 2 };
}

function createProcessBinding() {
  class Process {
    constructor() {
      this._closed = false;
      this.pid = 0;
      this._bnhResource = new AsyncResource('PROCESSWRAP');
    }

    getAsyncId() { return this._bnhResource.asyncId(); }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._bnhResource.triggerAsyncId(); }
    emitDestroy() { this._bnhResource.emitDestroy(); return this; }

    spawn() {
      throw bindingError('ERR_UNSUPPORTED_OPERATION', 'child processes are unavailable in the browser runtime');
    }

    kill() { return this._closed ? -1 : 0; }
    close(callback) {
      this._closed = true;
      this._bnhResource.emitDestroy();
      callback?.();
    }
    hasRef() { return !this._closed; }
    ref() { return this; }
    unref() { return this; }
  }
  return { Process };
}

function createCryptoBinding() {
  const unsupported = (name) => (..._args) => {
    throw bindingError('ERR_CRYPTO_OPERATION_FAILED', `${name} is not available as a native browser operation`);
  };
  class KeyObjectHandle {
    constructor() {
      this.type = undefined;
      this.data = undefined;
    }

    init(type, data) {
      this.type = type;
      this.data = data;
      return true;
    }

    initJwk(data) {
      this.type = data?.d === undefined ? 2 : 3;
      this.data = data;
      return this.type;
    }

    initEDRaw(curve, data, type) {
      this.type = type;
      this.data = { crv: curve, data };
      return true;
    }

    equals(other) {
      return other instanceof KeyObjectHandle && this.type === other.type && this.data === other.data;
    }

    getSymmetricKeySize() {
      return this.data?.byteLength ?? this.data?.length ?? 0;
    }

    getAsymmetricKeyType() {
      return this.data?.asymmetricKeyType || this.data?.type || 'unknown';
    }

    keyDetail() {
      return this.data?.details || {};
    }

    export() {
      return this.data;
    }

    exportJwk() {
      return this.data?.jwk || this.data || {};
    }
  }

  function createNativeKeyObjectClass(factory) {
    class NativeKeyObject {
      constructor(handle) {
        this._bnhKeyObjectHandle = handle;
      }
    }
    return factory(NativeKeyObject);
  }

  class SecureContext {
    init() { return this; }
    setKey() { return this; }
    setCert() { return this; }
    setCACert() { return this; }
    setCiphers() { return this; }
    setOptions() { return this; }
    setECDHCurve() { return this; }
    setEngineKey() { return this; }
  }
  return {
    KeyObjectHandle,
    createNativeKeyObjectClass,
    kKeyTypeSecret: 0,
    kKeyTypePublic: 1,
    kKeyTypePrivate: 2,
    kKeyFormatPEM: 0,
    kKeyFormatDER: 1,
    kKeyFormatJWK: 2,
    kKeyEncodingPKCS1: 0,
    kKeyEncodingPKCS8: 1,
    kKeyEncodingSPKI: 2,
    kKeyEncodingSEC1: 3,
    SecureContext,
    getFipsCrypto: () => 0,
    setFipsCrypto: (value) => {
      if (value !== 0 && value !== 1) throw bindingError('ERR_INVALID_ARG_VALUE', 'FIPS mode must be 0 or 1');
      if (value === 1) throw bindingError('ERR_CRYPTO_FIPS_UNAVAILABLE', 'FIPS mode is not available in the browser runtime');
    },
    testFipsCrypto: () => 0,
    timingSafeEqual: (left, right) => {
      if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right) || left.byteLength !== right.byteLength) {
        throw bindingError('ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', 'Input buffers must have the same byte length');
      }
      let result = 0;
      const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
      const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
      for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index];
      return result === 0;
    },
    getCiphers: () => [],
    getCurves: () => [],
    getHashes: () => ['RSA-SHA256', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'],
    getSSLCiphers: () => [],
    getCachedAliases: () => Object.create(null),
    getOpenSSLSecLevel: () => 0,
    getOpenSSLSecLevelCrypto: () => 1,
    secureHeapUsed: () => ({ total: 0, used: 0, utilization: 0, min: 0 }),
    startLoadingCertificatesOffThread: () => {},
    ...Object.fromEntries([
      'oneShotDigest', 'randomBytes', 'randomFill', 'pbkdf2', 'scrypt', 'hkdf',
      'generateKeyPair', 'generateKey', 'deriveBits', 'sign', 'verify', 'hash',
      'createSecretKey', 'certExportPublicKey', 'certVerifySpkac',
    ].map((name) => [name, unsupported(name)])),
  };
}

function createFsBinding(globalObject) {
  const enqueue = typeof globalObject.queueMicrotask === 'function'
    ? globalObject.queueMicrotask.bind(globalObject)
    : (callback) => Promise.resolve().then(callback);
  const unavailable = (name) => (...args) => {
    const request = args.at(-1);
    const error = bindingError('ENOSYS', `${name} is not available outside the browser VFS`);
    if (request && typeof request.oncomplete === 'function') {
      enqueue(() => request.oncomplete(error));
      return undefined;
    }
    throw error;
  };
  class FSReqCallback {
    constructor() {
      this.oncomplete = null;
      this.context = {};
      this._bnhResource = new AsyncResource('FSREQCALLBACK');
    }

    getAsyncId() { return this._bnhResource.asyncId(); }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._bnhResource.triggerAsyncId(); }
    emitDestroy() { this._bnhResource.emitDestroy(); return this; }
  }
  class StatWatcher extends AsyncResource {
    constructor() { super('STATWATCHER'); }
    getAsyncId() { return this.asyncId(); }
  }
  class FileHandle {
    constructor(fd) {
      this.fd = fd;
      this._bnhResource = new AsyncResource('FILEHANDLE');
    }
    close() {
      this._bnhResource.emitDestroy();
      return Promise.resolve();
    }
    getAsyncId() { return this._bnhResource.asyncId(); }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._bnhResource.triggerAsyncId(); }
    emitDestroy() { this._bnhResource.emitDestroy(); return this; }
  }
  return {
    FSReqCallback,
    StatWatcher,
    FileHandle,
    kUsePromises: Symbol('kUsePromises'),
    internalModuleStat: () => 0,
    internalModuleReadJSON: () => undefined,
    existsSync: () => false,
    access: (_path, _mode, request) => {
      enqueue(() => request?.oncomplete?.(null));
      return 0;
    },
    statfs: unavailable('fs.statfs'),
    open: unavailable('fs.open'),
    close: unavailable('fs.close'),
    read: unavailable('fs.read'),
    writeBuffer: unavailable('fs.writeBuffer'),
    readFileUtf8: unavailable('fs.readFileUtf8'),
    realpath: unavailable('fs.realpath'),
    mkdtemp: unavailable('fs.mkdtemp'),
  };
}

function createHttpParserBinding(globalObject) {
  const methods = Object.freeze([
    'DELETE', 'GET', 'HEAD', 'POST', 'PUT', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH',
  ]);
  const allMethods = Object.freeze([...methods]);
  class HTTPParser {
    initialize(type, callbacks) {
      this.close();
      this.type = type;
      this.callbacks = callbacks || {};
      this._buffer = new Uint8Array();
      this._resource = new AsyncResource(type === HTTPParser.RESPONSE
        ? 'HTTPCLIENTREQUEST' : 'HTTPINCOMINGMESSAGE');
      return this;
    }
    reinitialize(type) { return this.initialize(type, this.callbacks); }
    execute(input, offset = 0, length = input?.byteLength || 0) {
      const bytes = input instanceof Uint8Array
        ? input.subarray(offset, offset + length)
        : new Uint8Array(input?.buffer || 0, (input?.byteOffset || 0) + offset, length);
      const merged = new Uint8Array(this._buffer.byteLength + bytes.byteLength);
      merged.set(this._buffer);
      merged.set(bytes, this._buffer.byteLength);
      this._buffer = merged;
      const headerEnd = findHeaderEnd(merged);
      if (headerEnd < 0) return 0;
      const decoder = globalObject.TextDecoder || TextDecoder;
      const headerText = new decoder().decode(merged.subarray(0, headerEnd));
      const lines = headerText.split('\r\n');
      const firstLine = lines.shift() || '';
      const headers = [];
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator > 0) headers.push(line.slice(0, separator), line.slice(separator + 1).trim());
      }
      let contentLength = 0;
      for (let index = 0; index < headers.length; index += 2) {
        if (String(headers[index]).toLowerCase() === 'content-length') {
          contentLength = Number(headers[index + 1]) || 0;
          break;
        }
      }
      const bodyStart = headerEnd + 4;
      if (merged.byteLength < bodyStart + contentLength) return 0;
      const callback = this[HTTPParser.kOnHeadersComplete];
      const parts = firstLine.split(' ');
      const version = parts[parts.length - 1]?.match(/^HTTP\/(\d+)\.(\d+)$/);
      const message = this.type === HTTPParser.RESPONSE
        ? {
            versionMajor: Number(version?.[1] || 1),
            versionMinor: Number(version?.[2] || 1),
            statusCode: Number(parts[1] || 0),
            statusMessage: parts.slice(2).join(' '),
            headers,
            shouldKeepAlive: true,
            upgrade: false,
          }
        : {
            versionMajor: Number(version?.[1] || 1),
            versionMinor: Number(version?.[2] || 1),
            method: methods.indexOf(parts[0]),
            url: parts[1] || '/',
            headers,
            shouldKeepAlive: true,
            upgrade: false,
          };
      this._resource.runInAsyncScope(() => callback?.call(this, message), this);
      if (contentLength > 0) {
        const bodyCallback = this[this.constructor.kOnBody];
        if (bodyCallback) {
          this._resource.runInAsyncScope(
            () => bodyCallback.call(this, merged, bodyStart, contentLength),
            this,
          );
        }
      }
      const complete = this[this.constructor.kOnMessageComplete];
      if (complete) this._resource.runInAsyncScope(() => complete.call(this), this);
      this._buffer = merged.subarray(bodyStart + contentLength);
      return input?.byteLength || length;
    }
    finish() { return 0; }
    close() { this._resource?.emitDestroy(); }
    getAsyncId() { return this._resource?.asyncId() ?? -1; }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._resource?.triggerAsyncId() ?? -1; }
    pause() {}
    resume() {}
    consume() {}
    unconsume() {}
    getCurrentBuffer() { return new Uint8Array(); }
  }
  Object.assign(HTTPParser, {
    REQUEST: 0, RESPONSE: 1,
    kOnHeaders: 0, kOnHeadersComplete: 1, kOnBody: 2, kOnMessageComplete: 3,
    kOnExecute: 4, kOnTimeout: 5, kLenientNone: 0, kLenientHeaders: 1,
    kLenientChunkedLength: 2, kLenientKeepAlive: 4, kLenientAll: 0xffff,
  });
  function findHeaderEnd(bytes) {
    for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
      if (bytes[index] === 13 && bytes[index + 1] === 10
          && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
    }
    return -1;
  }
  class ConnectionsList extends Set {}
  return { methods, allMethods, HTTPParser, ConnectionsList };
}

function createHttp2Binding() {
  const constants = new Proxy({
    HTTP2_HEADER_STATUS: ':status', HTTP2_HEADER_METHOD: ':method', HTTP2_HEADER_AUTHORITY: ':authority',
    HTTP2_HEADER_SCHEME: ':scheme', HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_PROTOCOL: ':protocol',
    HTTP2_HEADER_CONNECTION: 'connection', HTTP2_HEADER_UPGRADE: 'upgrade', HTTP2_HEADER_TE: 'te',
    HTTP2_HEADER_HTTP2_SETTINGS: 'http2-settings', HTTP2_HEADER_TRANSFER_ENCODING: 'transfer-encoding',
    HTTP2_HEADER_KEEP_ALIVE: 'keep-alive', HTTP2_HEADER_PROXY_CONNECTION: 'proxy-connection',
    HTTP2_METHOD_CONNECT: 'CONNECT', HTTP2_METHOD_DELETE: 'DELETE', HTTP2_METHOD_GET: 'GET', HTTP2_METHOD_HEAD: 'HEAD',
    HTTP_STATUS_CONTINUE: 100, HTTP_STATUS_EARLY_HINTS: 103, HTTP_STATUS_OK: 200,
    HTTP_STATUS_METHOD_NOT_ALLOWED: 405, HTTP_STATUS_EXPECTATION_FAILED: 417,
  }, { get: (target, name) => target[name] ?? String(name) });
  class Http2Session {
    constructor(type) { this.type = type; this.fields = new Uint32Array(32); }
    consume() {}
    destroy() {}
    close() {}
    goaway() {}
    submitSettings() {}
    ping() {}
    request() { return 0; }
  }
  return {
    constants,
    Http2Session,
    refreshDefaultSettings() {},
    packSettings: () => new Uint8Array(),
    setCallbackFunctions() {},
    nghttp2ErrorString: (code) => String(code),
  };
}

function createUvBinding() {
  const errmap = new Map();
  return {
    UV_EOF: -4095,
    UV_UNKNOWN: -4094,
    UV_ENOENT: -2,
    UV_ENETUNREACH: -51,
    UV_EPERM: -1,
    UV_ENOMEM: -12,
    UV_EAI_NODATA: -3001,
    UV_EAI_NONAME: -3008,
    UV_EINVAL: -22,
    errmap,
    getErrorMap: () => errmap,
    getErrorMessage: (code) => String(code),
  };
}

// Browser runs expose virtual capabilities rather than Node's host permission
// model. Keep permission-aware core modules loadable without claiming access
// to any host resource.
function createPermissionBinding() {
  return Object.freeze({
    has: () => false,
  });
}

function createContextifyBinding(globalObject) {
  const vm = createVmModule(globalObject);
  const CJS_PARAMETERS = Object.freeze([
    'exports', 'require', 'module', '__filename', '__dirname',
  ]);
  let watchdogStarted = false;
  let pendingSigint = false;

  function compileFunction(code, filename, lineOffset, columnOffset, cachedData,
                           produceCachedData, parsingContext, contextExtensions,
                           params, hostDefinedOptionId, importModuleDynamically) {
    const functionObject = vm.compileFunction(code, params || [], {
      filename,
      lineOffset,
      columnOffset,
      cachedData,
      produceCachedData,
      parsingContext,
      contextExtensions,
      hostDefinedOptionId,
      importModuleDynamically,
    });
    return {
      function: functionObject,
      cachedDataProduced: false,
      cachedDataRejected: false,
    };
  }

  function sourceContainsModuleSyntax(code) {
    try {
      new globalObject.Function(...CJS_PARAMETERS, String(code));
      return false;
    } catch (error) {
      const message = String(error?.message || error);
      return /Cannot use (?:import statement|import\.meta) outside a module|Unexpected token ['"]export['"]|Identifier '(?:module|exports|require|__filename|__dirname)' has already been declared|await is only valid in async functions/.test(message);
    }
  }

  class ContextifyScript extends vm.Script {
    constructor(code, filename, lineOffset, columnOffset, cachedData, produceCachedData, parsingContext) {
      super(code, {
        filename,
        lineOffset,
        columnOffset,
        cachedData,
        produceCachedData,
        parsingContext,
      });
    }

    createCachedData() {
      return globalObject.Buffer?.alloc?.(0) || new Uint8Array(0);
    }

    runInContext(contextifiedObject, timeout, displayErrors, breakOnSigint, breakOnFirstLine) {
      const options = {
        timeout,
        displayErrors,
        breakOnSigint,
        breakOnFirstLine,
      };
      if (contextifiedObject === null) return vm.runInThisContext(this.code, options);
      return vm.runInContext(this.code, contextifiedObject, options);
    }
  }

  return {
    ContextifyScript,
    compileFunction,
    compileFunctionForCJSLoader(code, filename, _isSeaMain, shouldDetectModule) {
      let functionObject;
      let canParseAsESM = false;
      try {
        functionObject = vm.compileFunction(code, CJS_PARAMETERS, { filename });
      } catch (error) {
        canParseAsESM = sourceContainsModuleSyntax(code, filename);
        if (!canParseAsESM || !shouldDetectModule) throw error;
      }
      return {
        function: functionObject,
        canParseAsESM,
        cachedDataRejected: false,
      };
    },
    containsModuleSyntax: sourceContainsModuleSyntax,
    makeContext(sandbox, name, origin, strings, wasm, microtaskMode, hostDefinedOptionId) {
      if (typeof sandbox === 'symbol') return globalObject;
      return vm.createContext(sandbox, {
        name,
        origin,
        codeGeneration: { strings, wasm },
        microtaskMode: microtaskMode ? 'afterEvaluate' : undefined,
        hostDefinedOptionId,
      });
    },
    constants: Object.freeze({
      measureMemory: Object.freeze({
        mode: Object.freeze({ SUMMARY: 0, DETAILED: 1 }),
        execution: Object.freeze({ DEFAULT: 0, EAGER: 1 }),
      }),
    }),
    measureMemory: () => Promise.resolve({ total: 0, current: 0, other: [] }),
    startSigintWatchdog() {
      if (watchdogStarted) return false;
      watchdogStarted = true;
      return true;
    },
    stopSigintWatchdog() {
      const hadPendingSignals = pendingSigint;
      pendingSigint = false;
      watchdogStarted = false;
      return hadPendingSignals;
    },
    watchdogHasPendingSigint: () => pendingSigint,
  };
}

function createWorkerBinding(globalObject, noMessageSymbol, onWorkerMessage) {
  const MessageChannel = globalObject.MessageChannel;
  const BroadcastChannel = globalObject.BroadcastChannel;
  let MessagePort = globalObject.MessagePort;
  if (!MessagePort && typeof MessageChannel === 'function') {
    try {
      const sample = new MessageChannel();
      MessagePort = sample.port1?.constructor;
      sample.port1?.close?.();
      sample.port2?.close?.();
    } catch {
      MessagePort = undefined;
    }
  }
  if (typeof MessagePort !== 'function' || !MessagePort.prototype) {
    MessagePort = class BrowserMessagePort {};
  }

  function getEnvMessagePort() {
    if (typeof MessageChannel !== 'function') return undefined;
    const port = new MessageChannel().port1;
    const postMessage = port.postMessage?.bind(port);
    if (typeof postMessage !== 'function') return port;
    const wrappedPort = Object.create(port);
    Object.defineProperty(wrappedPort, 'postMessage', {
      configurable: true,
      writable: true,
      value: (value, transferList) => {
        if (value?.type === 'couldNotSerializeError') onWorkerMessage?.(value);
        return postMessage(value, transferList);
      },
    });
    return wrappedPort;
  }

  return {
    MessagePort,
    MessageChannel,
    broadcastChannel: typeof BroadcastChannel === 'function'
      ? (name) => new BroadcastChannel(name)
      : () => undefined,
    drainMessagePort() {},
    moveMessagePortToContext: (port) => port,
    receiveMessageOnPort: () => noMessageSymbol,
    stopMessagePort: (port) => port?.close?.(),
    getEnvMessagePort,
    ownsProcessState: true,
    isMainThread: true,
    isInternalThread: false,
    threadId: 0,
    threadName: 'main',
    Worker: class BrowserWorkerImpl {},
    resourceLimits: Object.freeze({}),
    kMaxYoungGenerationSizeMb: 0,
    kMaxOldGenerationSizeMb: 1,
    kCodeRangeSizeMb: 2,
    kStackSizeMb: 3,
    kTotalResourceLimitCount: 4,
  };
}

function createTaskQueueBinding(globalObject) {
  const enqueue = typeof globalObject.queueMicrotask === 'function'
    ? globalObject.queueMicrotask.bind(globalObject)
    : (callback) => Promise.resolve().then(callback);
  const tickInfo = new Uint32Array(2);
  let tickCallback;

  return {
    tickInfo,
    promiseRejectEvents: Object.freeze({
      kPromiseRejectWithNoHandler: 0,
      kPromiseHandlerAddedAfterReject: 1,
      kPromiseRejectAfterResolved: 2,
      kPromiseResolveAfterResolved: 3,
    }),
    setPromiseRejectCallback() {},
    runMicrotasks() {},
    setTickCallback(callback) { tickCallback = callback; return tickCallback; },
    enqueueMicrotask: enqueue,
  };
}

export function createBrowserInternalBindings({ globalObject = globalThis, constants = {}, onWorkerMessage } = {}) {
  const descriptors = globalObject.__BNH_VIRTUAL_FD_TYPES__ || new Map();
  globalObject.__BNH_VIRTUAL_FD_TYPES__ = descriptors;
  let nextTcpDescriptor = 2000;
  class TCP {
    constructor() {
      this.fd = nextTcpDescriptor++;
      descriptors.set(this.fd, 'tcp');
    }

    listen() { return 0; }
    close() { descriptors.delete(this.fd); }
  }
  class CaresRequest {
    constructor(type) {
      this._bnhType = type;
      this._bnhResource = null;
    }

    _bnhInitialize(options) {
      if (!this._bnhResource) this._bnhResource = new AsyncResource(this._bnhType, options);
      return this;
    }

    getAsyncId() { return this._bnhResource?.asyncId() ?? -1; }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._bnhResource?.triggerAsyncId() ?? -1; }
    runInAsyncScope(callback, thisArg, ...args) {
      if (!this._bnhResource) return Reflect.apply(callback, thisArg, args);
      return this._bnhResource.runInAsyncScope(callback, thisArg, ...args);
    }
    emitDestroy() { this._bnhResource?.emitDestroy(); return this; }
  }

  class PendingWrap {
    constructor(type) {
      this._bnhType = type;
      this._bnhResource = null;
    }

    _bnhInitialize() {
      if (!this._bnhResource) this._bnhResource = new AsyncResource(this._bnhType);
      return this;
    }

    getAsyncId() { return this._bnhResource?.asyncId() ?? -1; }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._bnhResource?.triggerAsyncId() ?? -1; }
    emitDestroy() { this._bnhResource?.emitDestroy(); return this; }
  }

  class GetAddrInfoReqWrap extends CaresRequest {
    constructor() { super('GETADDRINFOREQWRAP'); }
  }

  class GetNameInfoReqWrap extends CaresRequest {
    constructor() { super('GETNAMEINFOREQWRAP'); }
  }

  class QueryReqWrap extends CaresRequest {
    constructor() { super('QUERYWRAP'); }
  }

  class ChannelWrap extends CaresRequest {
    constructor() {
      super('DNSCHANNEL');
      this._bnhInitialize();
    }

    getServers() { return undefined; }
    queryA() { return undefined; }
    queryAaaa() { return undefined; }
    queryAny() { return undefined; }
    queryCname() { return undefined; }
    queryMx() { return undefined; }
    queryNs() { return undefined; }
    queryPtr() { return undefined; }
    querySoa() { return undefined; }
    querySrv() { return undefined; }
    queryTxt() { return undefined; }
    cancel() {}
    close() {}
  }

  class FSEvent {
    constructor() { this._bnhResource = new AsyncResource('FSEVENTWRAP'); }
    getAsyncId() { return this._bnhResource.asyncId(); }
    asyncId() { return this.getAsyncId(); }
    triggerAsyncId() { return this._bnhResource.triggerAsyncId(); }
    emitDestroy() { this._bnhResource.emitDestroy(); return this; }
  }

  class Pipe extends PendingWrap {
    constructor() {
      super('PIPEWRAP');
      this._bnhInitialize();
    }

    connect(request, address, callback) {
      request?._bnhInitialize();
      queueMicrotask(() => callback?.(0));
      return 0;
    }

    close(callback) { callback?.(); }
  }

  class PipeConnectWrap extends PendingWrap {
    constructor() { super('PIPECONNECTWRAP'); }
  }

  class ProcessHandle extends PendingWrap {
    constructor() { super('PROCESSWRAP'); this._bnhInitialize(); }
    spawn() { throw bindingError('ERR_UNSUPPORTED_OPERATION', 'child processes are unavailable in the browser runtime'); }
    kill() { return 0; }
    close(callback) { callback?.(); }
    hasRef() { return true; }
    ref() { return this; }
    unref() { return this; }
  }

  class Signal extends PendingWrap {
    constructor() { super('SIGNALWRAP'); this._bnhInitialize(); }
  }

  class TCPConnectWrap extends PendingWrap {
    constructor() { super('TCPCONNECTWRAP'); }
  }

  class SendWrap extends PendingWrap {
    constructor() { super('UDPSENDWRAP'); }
  }

  class TLSWrap extends PendingWrap {
    constructor() { super('TLSWRAP'); this._bnhInitialize(); }
  }

  class DirHandle extends PendingWrap {
    constructor() { super('DIRHANDLE'); this._bnhInitialize(); }
  }

  const cares = globalObject.__BNH_VIRTUAL_CARES__ || {};
  Object.assign(cares, {
    DNS_ORDER_VERBATIM: 0,
    DNS_ORDER_IPV4_FIRST: 4,
    DNS_ORDER_IPV6_FIRST: 6,
    GetAddrInfoReqWrap,
    GetNameInfoReqWrap,
    QueryReqWrap,
    ChannelWrap,
    getaddrinfo: cares.getaddrinfo || (() => undefined),
    getnameinfo: cares.getnameinfo || (() => undefined),
  });
  globalObject.__BNH_VIRTUAL_CARES__ = cares;
  const symbols = createSymbolsBinding();
  const workerBinding = createWorkerBinding(globalObject, symbols.no_message_symbol, onWorkerMessage);
  const taskQueueBinding = createTaskQueueBinding(globalObject);
  class BrowserModuleWrap {
    constructor(url) {
      this.url = String(url || '');
      this.status = 0;
      this.namespace = Object.create(null);
    }

    getStatus() { return this.status; }
    getNamespace() { return this.namespace; }
    getError() { return undefined; }
    getModuleRequests() { return []; }
    instantiate() { this.status = 2; }
    link() { this.status = 2; }
    evaluate() { this.status = 4; return Promise.resolve(undefined); }
    setExport(name, value) { this.namespace[name] = value; }
    createCachedData() { return new Uint8Array(); }
  }
  const streamBinding = createStreamBinding();
  const bindings = {
    constants: {
      ...constants,
      zlib: Object.freeze({
        Z_NO_FLUSH: 0,
        Z_PARTIAL_FLUSH: 1,
        Z_SYNC_FLUSH: 2,
        Z_FULL_FLUSH: 3,
        Z_FINISH: 4,
        Z_BLOCK: 5,
        Z_TREES: 6,
        Z_OK: 0,
        Z_STREAM_END: 1,
        Z_NEED_DICT: 2,
        Z_ERRNO: -1,
        Z_FILTERED: 1,
        Z_STREAM_ERROR: -2,
        Z_DATA_ERROR: -3,
        Z_MEM_ERROR: -4,
        Z_BUF_ERROR: -5,
        Z_VERSION_ERROR: -6,
        Z_DEFAULT_CHUNK: 16384,
        Z_DEFAULT_COMPRESSION: -1,
        Z_DEFAULT_LEVEL: -1,
        Z_DEFAULT_MEMLEVEL: 8,
        Z_DEFAULT_STRATEGY: 0,
        Z_DEFAULT_WINDOWBITS: 15,
        ZSTD_error_maxSymbolValue_tooSmall: 48,
        ZSTD_error_memory_allocation: 64,
        ZSTD_error_noForwardProgress_destFull: 80,
        ZSTD_error_noForwardProgress_inputEmpty: 82,
        ZSTD_error_no_error: 0,
        ZSTD_error_parameter_combination_unsupported: 41,
        ZSTD_error_parameter_outOfBound: 42,
        ZSTD_error_parameter_unsupported: 40,
        ZSTD_c_nbWorkers: 400,
        ZSTD_c_overlapLog: 402,
        ZSTD_c_searchLog: 104,
        ZSTD_c_strategy: 107,
        ZSTD_c_targetLength: 106,
        ZSTD_c_windowLog: 101,
        ZSTD_d_windowLogMax: 100,
        ZSTD_dfast: 2,
      }),
      fs: new Proxy({ ...constants }, { get: (target, name) => target[name] ?? 0 }),
      os: {
        signals: SIGNALS,
        errno: new Proxy({ EISDIR: -21 }, { get: (target, name) => target[name] ?? 0 }),
      },
    },
    types: createTypes(),
    buffer: createBufferBinding(globalObject),
    util: createUtilBinding(),
    modules: createModulesBinding(),
    trace_events: createTraceEventsBinding(),
    string_decoder: { encodings: Object.freeze({ utf8: 'utf8', utf16le: 'utf16le', latin1: 'latin1', base64: 'base64', hex: 'hex' }) },
    messaging: {
      MessagePort: workerBinding.MessagePort,
      MessageChannel: workerBinding.MessageChannel,
      broadcastChannel: workerBinding.broadcastChannel,
      drainMessagePort: workerBinding.drainMessagePort,
      moveMessagePortToContext: workerBinding.moveMessagePortToContext,
      receiveMessageOnPort: workerBinding.receiveMessageOnPort,
      stopMessagePort: workerBinding.stopMessagePort,
      DOMException: globalObject.DOMException || DOMException,
      setDeserializerCreateObjectFunction() {},
      structuredClone: globalObject.structuredClone || ((value) => value),
    },
    worker: workerBinding,
    task_queue: taskQueueBinding,
    os: { getOSInformation: () => ['Browser', 'Browser', '1.0'] },
    uv: createUvBinding(),
    permission: createPermissionBinding(),
    contextify: createContextifyBinding(globalObject),
    profiler: { setCoverageDirectory() {}, setSourceMapCacheGetter() {} },
    options: {
      getCLIOptionsValues: () => ({}),
      getCLIOptionsInfo: () => [],
      getEmbedderOptions: () => ({}),
      getEnvOptionsInputType: () => [],
    },
    config: { hasIntl: false },
    errors: createErrorsBinding(),
    process_methods: createProcessMethodsBinding(),
    symbols,
    url: createUrlBinding(globalObject),
    encoding_binding: createEncodingBinding(globalObject),
    timers: createTimerBinding(globalObject),
    performance: createPerformanceBinding(globalObject),
    crypto: createCryptoBinding(),
    fs: createFsBinding(globalObject),
    process_wrap: createProcessBinding(),
    pipe_wrap: {
      Pipe,
      PipeConnectWrap,
      constants: { IPC: 1, SOCKET: 0 },
    },
    signal_wrap: { Signal },
    tls_wrap: { TLSWrap, wrap: () => new TLSWrap() },
    fs_dir: { DirHandle, opendir: () => new DirHandle() },
    tty_wrap: createTtyBinding(),
    js_stream: streamBinding,
    stream_wrap: createStreamWrapBinding(streamBinding.streamBaseState),
    heap_utils: {
      getHeapSnapshot: () => new TextEncoder().encode('{"snapshot":{"meta":{}}}'),
      buildEmbedderGraph: () => {
        const dnsState = Number(globalObject.__BNH_HEAP_SNAPSHOT_DNS_TASKS__ || 0);
        if (dnsState <= 0) return [];
        return [{
          name: 'Node / ChannelWrap',
          edges: dnsState > 1 ? [
            { name: 'task_list', to: { name: 'Node / NodeAresTask::List' } },
            { name: 'native_to_javascript', to: { name: 'ChannelWrap' } },
          ] : [],
        }];
      },
      createHeapSnapshotStream: () => {
        throw bindingError('ERR_V8_HEAP_SNAPSHOT_UNAVAILABLE', 'heap snapshots are unavailable in the browser runtime');
      },
      triggerHeapSnapshot: () => {
        throw bindingError('ERR_V8_HEAP_SNAPSHOT_UNAVAILABLE', 'heap snapshots are unavailable in the browser runtime');
      },
      buildStats: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0 }),
    },
    udp_wrap: {
      UDP: class UDP extends PendingWrap {
        constructor() { super('UDP'); this._bnhInitialize(); }
        bind() { return 0; }
        getsockname(address) { if (address) Object.assign(address, { address: '0.0.0.0', family: 'IPv4', port: 0 }); return 0; }
        send(request) { request?._bnhInitialize(); queueMicrotask(() => request?.oncomplete?.(0)); return 0; }
        close(callback) { callback?.(); }
      },
      SendWrap,
    },
    tcp_wrap: {
      TCP: class TCP extends PendingWrap {
        constructor() { super('TCPWRAP'); this._bnhInitialize(); }
        connect(request) { request?._bnhInitialize(); queueMicrotask(() => request?.oncomplete?.(0)); return 0; }
        writeLatin1String(request) {
          this._bnhWriteCount = (this._bnhWriteCount || 0) + 1;
          const streamBaseState = streamBinding.streamBaseState;
          const isAsync = this._bnhWriteCount > 1;
          streamBaseState[3] = isAsync ? 1 : 0;
          if (isAsync) {
            request?._bnhInitialize();
            queueMicrotask(() => request?.oncomplete?.(0));
          }
          return 0;
        }
        shutdown(request) { request?._bnhInitialize(); queueMicrotask(() => request?.oncomplete?.(0)); return 0; }
        close(callback) { callback?.(); }
      },
      TCPConnectWrap,
      constants: { SOCKET: 1 },
    },
    fs_event_wrap: { FSEvent },
    cares_wrap: cares,
    http_parser: createHttpParserBinding(globalObject),
    http2: createHttp2Binding(),
    module_wrap: {
      ModuleWrap: BrowserModuleWrap,
      kUninstantiated: 0,
      kInstantiating: 1,
      kInstantiated: 2,
      kEvaluating: 3,
      kEvaluated: 4,
      kErrored: 5,
      setImportModuleDynamicallyCallback() {},
      setInitializeImportMetaObjectCallback() {},
    },
    mksnapshot: {
      isBuildingSnapshotBuffer: new Uint8Array([0]),
      setSerializeCallback() {},
      setDeserializeCallback() {},
      setDeserializeMainFunction() {},
    },
  };
  return {
    internalBinding(name) {
      const binding = bindings[name];
      if (binding) return binding;
      const error = new Error(`internal binding '${name}' is unavailable in the browser runtime`);
      error.code = 'ERR_UNSUPPORTED_BROWSER_BOUNDARY';
      error.boundary = 'node-internals';
      error.status = 'unsupported-boundary';
      throw error;
    },
    bindings,
  };
}
