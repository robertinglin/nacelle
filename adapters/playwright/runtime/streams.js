import { EventEmitter } from './events.js';
import { resolveEncodingOps } from './buffer.js';

const DEFAULT_READABLE_HIGH_WATER_MARK = 64 * 1024;
const DEFAULT_WRITABLE_HIGH_WATER_MARK = 16 * 1024;
const DEFAULT_HIGH_WATER_MARK = DEFAULT_READABLE_HIGH_WATER_MARK;
let defaultHighWaterMark = DEFAULT_READABLE_HIGH_WATER_MARK;
let defaultWritableHighWaterMark = DEFAULT_WRITABLE_HIGH_WATER_MARK;
let defaultObjectHighWaterMark = 16;

const kReadableStateDataEmitted = Symbol('readableStateDataEmitted');
const kReadableStateClosed = Symbol('readableStateClosed');
const kReadableStateConstructed = Symbol('readableStateConstructed');
const kReadableStateDestroyed = Symbol('readableStateDestroyed');
const kReadableStateEmitClose = Symbol('readableStateEmitClose');
const kReadableStateEmittedReadable = Symbol('readableStateEmittedReadable');
const kReadableStateObjectMode = Symbol('readableStateObjectMode');
const kReadableStateEnded = Symbol('readableStateEnded');
const kReadableStateErrored = Symbol('readableStateErrored');
const kReadableStateDefaultEncoding = Symbol('readableStateDefaultEncoding');
const kReadableStateDecoder = Symbol('readableStateDecoder');
const kReadableStateEncoding = Symbol('readableStateEncoding');
const kReadableStateFlowing = Symbol('readableStateFlowing');
const kReadableStateHasFlowing = Symbol('readableStateHasFlowing');
const kReadableStatePaused = Symbol('readableStatePaused');
const kReadableStateMultiAwaitDrain = Symbol('readableStateMultiAwaitDrain');
const kReadableStateNeedReadable = Symbol('readableStateNeedReadable');
const kReadableStateReadableListening = Symbol('readableStateReadableListening');
const kReadableStateReading = Symbol('readableStateReading');
const kReadableStateAutoDestroy = Symbol('readableStateAutoDestroy');
const kReadableStateCloseEmitted = Symbol('readableStateCloseEmitted');
const kReadableStateEndEmitted = Symbol('readableStateEndEmitted');
const kReadableStateErrorEmitted = Symbol('readableStateErrorEmitted');
const kReadableStateReadingMore = Symbol('readableStateReadingMore');
const kReadableStateResumeScheduled = Symbol('readableStateResumeScheduled');
const kReadableStateSync = Symbol('readableStateSync');

export function setDefaultHighWaterMark(objectMode, value) {
  if (typeof objectMode !== 'boolean') throw streamError('ERR_INVALID_ARG_TYPE', 'The "objectMode" argument must be of type boolean');
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw streamError('ERR_OUT_OF_RANGE', 'The "value" argument is out of range');
  }
  if (objectMode) defaultObjectHighWaterMark = value;
  else {
    defaultHighWaterMark = value;
    defaultWritableHighWaterMark = value;
  }
}

export function getDefaultHighWaterMark(objectMode) {
  if (typeof objectMode !== 'boolean') throw streamError('ERR_INVALID_ARG_TYPE', 'The "objectMode" argument must be of type boolean');
  return objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark;
}

function isNodeStream(value) {
  return Boolean(value && (value._readableState || value._writableState)
    && typeof value.on === 'function');
}

function hasReadableSide(value) {
  if (value?.readable === false || value?._readableState?.readable === false) return false;
  return Boolean(value && (typeof value.readable === 'boolean'
    || typeof value[Symbol.asyncIterator] === 'function'));
}

function hasWritableSide(value) {
  if (value?.writable === false || value?._writableState?.writable === false) return false;
  return Boolean(value && typeof value.write === 'function');
}

function isIterable(value) {
  return Boolean(value && (typeof value[Symbol.asyncIterator] === 'function'
    || typeof value[Symbol.iterator] === 'function'));
}

function invalidComposeStage() {
  return streamError(
    'ERR_INVALID_ARG_VALUE',
    'The argument must be a stream, an iterable, or an async function',
  );
}

function readableObjectMode(value) {
  return Boolean(value?.readableObjectMode ?? value?._readableState?.objectMode);
}

function writableObjectMode(value) {
  return Boolean(value?.writableObjectMode ?? value?._writableState?.objectMode);
}

function likelyReadableFunction(value) {
  const name = value?.constructor?.name;
  return name !== 'AsyncFunction';
}

function invalidComposeReturn(value) {
  const received = value === null ? 'null' : value?.constructor?.name || typeof value;
  return streamError(
    'ERR_INVALID_RETURN_VALUE',
    `Expected nully to be returned from the "body" function but got ${received}`,
  );
}

function asReadable(value) {
  if (isNodeStream(value)) return value;
  if (isIterable(value)) return Readable.from(value);
  throw invalidComposeStage();
}

function waitForWritable(stream) {
  if (stream?._writableState?.finished || stream?.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onFinish = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      stream.off?.('finish', onFinish);
      stream.off?.('error', onError);
    };
    stream.once('finish', onFinish);
    stream.once('error', onError);
  });
}

function pipeInto(source, destination) {
  asReadable(source).pipe(destination);
  return destination;
}

function consumeInto(output, source) {
  return (async () => {
    for await (const chunk of source) output.push(chunk);
    output.push(null);
  })();
}

// The browser runtime has one stream implementation, so the public state
// predicates can read the same state objects used by the stream classes.
export function isDestroyed(stream) {
  if (!isNodeStream(stream)) return null;
  return Boolean(stream.destroyed || stream._readableState?.destroyed || stream._writableState?.destroyed);
}

export function isDisturbed(stream) {
  return Boolean(stream && (
    stream.readableDidRead
    || stream.readableAborted
    || stream._readableState?.disturbed
  ));
}

export function isErrored(stream) {
  return Boolean(stream && (
    stream.readableErrored
    || stream.writableErrored
    || stream._readableState?.errored
    || stream._writableState?.errored
    || stream._readableState?.errorEmitted
    || stream._writableState?.errorEmitted
  ));
}

export function isReadable(stream) {
  if (!stream || typeof stream.readable !== 'boolean') return null;
  if (isDestroyed(stream)) return false;
  return Boolean(isNodeStream(stream) && stream.readable
    && !stream._readableState?.endEmitted);
}

export function isWritable(stream) {
  if (!stream || typeof stream.writable !== 'boolean') return null;
  if (isDestroyed(stream)) return false;
  return Boolean(isNodeStream(stream) && stream.writable
    && !stream._writableState?.ended);
}

class StreamChunk extends Uint8Array {
  toString(encoding = 'utf8') {
    if (encoding === 'hex') return Array.from(this, (value) => value.toString(16).padStart(2, '0')).join('');
    if (encoding === 'base64') {
      let binary = '';
      for (const value of this) binary += String.fromCharCode(value);
      return btoa(binary);
    }
    return new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(this);
  }
}

function streamChunk(value) {
  const chunk = new StreamChunk(value.byteLength);
  chunk.set(value);
  return chunk;
}

function bufferChunk(value) {
  const BufferClass = globalThis.Buffer;
  return typeof BufferClass?.from === 'function'
    ? BufferClass.from(value)
    : streamChunk(value);
}

function toBytes(value, encoding = 'utf8') {
  if (value instanceof StreamChunk) return bufferChunk(value);
  if (value.constructor?.isBuffer?.(value)) return value;
  if (value instanceof Uint8Array) return bufferChunk(value);
  if (typeof value === 'string') {
    const BufferClass = globalThis.Buffer;
    return typeof BufferClass?.from === 'function'
      ? BufferClass.from(value, encoding)
      : streamChunk(new TextEncoder().encode(value));
  }
  if (value instanceof ArrayBuffer) return bufferChunk(new Uint8Array(value.slice(0)));
  if (ArrayBuffer.isView(value)) {
    return bufferChunk(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  }
  throw new TypeError('stream chunks must be strings or Uint8Array values');
}

// These helpers are part of the legacy Stream surface and are still consumed
// by Node's internal readable/writable implementations. Keep the checks
// realm-safe and preserve the backing store when adapting a Uint8Array.
function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

function isUint8Array(value) {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function _uint8ArrayToBuffer(chunk) {
  const BufferClass = globalThis.Buffer;
  if (typeof BufferClass?.from === 'function') {
    return BufferClass.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return streamChunk(chunk);
}

function appendBytes(previous, next) {
  const result = new Uint8Array(previous.byteLength + next.byteLength);
  result.set(previous);
  result.set(next, previous.byteLength);
  return result;
}

function streamError(code, message) {
  // Node exposes the code separately; the code prefix belongs to formatting,
  // not to the observable Error#message used by callers and assertions.
  const ErrorClass = code === 'ERR_INVALID_ARG_TYPE'
    || code === 'ERR_INVALID_ARG_VALUE'
    || code === 'ERR_INVALID_RETURN_VALUE'
    || code === 'ERR_MISSING_ARGS'
    || code === 'ERR_STREAM_NULL_VALUES'
    || code === 'ERR_UNKNOWN_ENCODING'
    ? TypeError
    : code === 'ERR_OUT_OF_RANGE' ? RangeError : Error;
  const error = new ErrorClass(message);
  error.code = code;
  return error;
}

function emitStreamError(stream, error) {
  if (stream._errorEmitted) return;
  stream._errorEmitted = true;
  stream._readableState && (stream._readableState.errorEmitted = true);
  stream._writableState && (stream._writableState.errorEmitted = true);
  const handled = stream.emit('error', error);
  const listeners = stream.listeners?.('error') || [];
  const hasUserListener = listeners.some((listener) => !listener._bnhInternal);
  if (!handled || !hasUserListener) {
    const processObject = globalThis.process;
    if (typeof processObject?.emit === 'function') processObject.emit('uncaughtException', error);
  }
}

function streamReceivedValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `type ${typeof value} (${value})`;
  }
  return `an instance of ${value?.constructor?.name || typeof value}`;
}

function normalizeWritableEncoding(encoding) {
  if (typeof encoding !== 'string' || !resolveEncodingOps(encoding)) {
    throw streamError('ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`);
  }
  const normalized = encoding.toLowerCase();
  return normalized === 'utf-8' ? 'utf8' : normalized;
}

function readableEncodingName(encoding) {
  const normalized = `${encoding}`.toLowerCase();
  if (normalized === 'utf-8') return 'utf8';
  if (normalized === 'binary') return 'latin1';
  if (normalized === 'ucs2' || normalized === 'ucs-2' || normalized === 'utf-16le') return 'utf16le';
  return normalized;
}

const COMBINATOR_EMPTY = Symbol('stream-combinator-empty');
const COMBINATOR_EOF = Symbol('stream-combinator-eof');

const legacyStreamState = new WeakMap();

const kNodejsAsyncDispose = Symbol.for('nodejs.asyncDispose');
const kAsyncDispose = typeof Symbol.asyncDispose === 'symbol' ? Symbol.asyncDispose : null;

function streamAsyncDispose() {
  if (this.closed || this.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    this.once?.('close', resolve);
    this.destroy?.();
    if (!this.destroy) resolve();
  });
}

function defineAsyncDispose(prototype) {
  Object.defineProperty(prototype, kNodejsAsyncDispose, {
    configurable: true,
    enumerable: false,
    value: streamAsyncDispose,
    writable: true,
  });
  if (kAsyncDispose && kAsyncDispose !== kNodejsAsyncDispose) {
    Object.defineProperty(prototype, kAsyncDispose, {
      configurable: true,
      enumerable: false,
      value: streamAsyncDispose,
      writable: true,
    });
  }
}

function syncLegacyEvents(stream) {
  const state = legacyState(stream);
  const events = Object.create(null);
  for (const [name, listeners] of state.listeners) {
    if (listeners.size > 0) events[name] = listeners.size === 1 ? [...listeners][0] : [...listeners];
  }
  stream._events = events;
  stream._eventsCount = state.listeners.size;
}

function legacyState(stream) {
  let state = legacyStreamState.get(stream);
  if (!state) {
    state = { listeners: new Map() };
    legacyStreamState.set(stream, state);
  }
  return state;
}

// Node exposes Stream as a callable legacy base constructor. A separate
// state store keeps Stream.call(this) usable for old-style stream prototypes.
export function Stream() {
  legacyState(this);
  if (!Object.prototype.hasOwnProperty.call(this, '_events')) this._events = Object.create(null);
  if (!Object.prototype.hasOwnProperty.call(this, '_eventsCount')) this._eventsCount = 0;
  if (!Object.prototype.hasOwnProperty.call(this, '_maxListeners')) this._maxListeners = undefined;
}

Stream.prototype.on = function on(name, listener) {
  const listeners = legacyState(this).listeners.get(name) || new Set();
  listeners.add(listener);
  legacyState(this).listeners.set(name, listeners);
  syncLegacyEvents(this);
  return this;
};
Stream.prototype.addListener = Stream.prototype.on;
Stream.prototype.prependListener = function prependListener(name, listener) {
  if (typeof listener !== 'function') throw streamError('ERR_INVALID_ARG_TYPE', 'The "listener" argument must be of type function');
  const current = legacyState(this).listeners.get(name) || new Set();
  legacyState(this).listeners.set(name, new Set([listener, ...current]));
  syncLegacyEvents(this);
  return this;
};
Stream.prototype.once = function once(name, listener) {
  const wrapped = (...args) => {
    this.removeListener(name, wrapped);
    listener.apply(this, args);
  };
  wrapped.listener = listener;
  return this.on(name, wrapped);
};
Stream.prototype.prependOnceListener = function prependOnceListener(name, listener) {
  if (typeof listener !== 'function') throw streamError('ERR_INVALID_ARG_TYPE', 'The "listener" argument must be of type function');
  const wrapped = (...args) => {
    this.removeListener(name, wrapped);
    listener.apply(this, args);
  };
  wrapped.listener = listener;
  return this.prependListener(name, wrapped);
};
Stream.prototype.removeListener = function removeListener(name, listener) {
  if (typeof listener !== 'function') {
    throw streamError(
      'ERR_INVALID_ARG_TYPE',
      `The "listener" argument must be of type function. Received ${streamReceivedValue(listener)}`,
    );
  }
  const state = legacyState(this);
  const listeners = state.listeners.get(name);
  if (listeners) {
    const snapshot = [...listeners];
    for (let index = snapshot.length - 1; index >= 0; index -= 1) {
      const candidate = snapshot[index];
      if (candidate === listener || candidate.listener === listener) {
        listeners.delete(candidate);
        break;
      }
    }
  }
  if (listeners?.size === 0) state.listeners.delete(name);
  syncLegacyEvents(this);
  return this;
};
Stream.prototype.off = Stream.prototype.removeListener;
Stream.prototype.listenerCount = function listenerCount(name, listener) {
  const listeners = legacyState(this).listeners.get(name);
  if (!listeners) return 0;
  if (listener == null) return listeners.size;
  let count = 0;
  for (const candidate of listeners) {
    if (candidate === listener || candidate.listener === listener) count += 1;
  }
  return count;
};
Stream.prototype.listeners = function listeners(name) {
  return [...(legacyState(this).listeners.get(name) || [])]
    .map((listener) => listener.listener || listener);
};
Stream.prototype.rawListeners = function rawListeners(name) {
  return [...(legacyState(this).listeners.get(name) || [])];
};
Stream.prototype.removeAllListeners = function removeAllListeners(name) {
  const state = legacyState(this);
  if (arguments.length === 0) state.listeners.clear();
  else state.listeners.delete(name);
  syncLegacyEvents(this);
  return this;
};
Stream.prototype.emit = function emit(name, ...args) {
  const listeners = legacyState(this).listeners.get(name);
  if (!listeners) return false;
  const snapshot = [...listeners];
  for (let index = 0; index < snapshot.length; index += 1) snapshot[index].apply(this, args);
  return listeners.size > 0;
};
Stream.prototype.eventNames = function eventNames() {
  const events = Object.create(null);
  for (const [name, listeners] of legacyState(this).listeners) {
    if (listeners.size > 0) events[name] = true;
  }
  return Reflect.ownKeys(events);
};
Stream.prototype.pipe = function pipe(destination) {
  this.on('data', (chunk) => {
    if (!destination.write(chunk)) this.pause?.();
  });
  this.on('end', () => destination.end?.());
  destination.on?.('drain', () => this.resume?.());
  destination.emit?.('pipe', this);
  this.resume?.();
  return destination;
};

// Backwards-compatible hooks used by lib/internal/streams/*.
Stream._isArrayBufferView = isArrayBufferView;
Stream._isUint8Array = isUint8Array;
Stream._uint8ArrayToBuffer = _uint8ArrayToBuffer;
Stream.setMaxListeners = EventEmitter.setMaxListeners;
Stream.getMaxListeners = EventEmitter.getMaxListeners;
Stream.prototype.setMaxListeners = function setMaxListeners(value) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) throw streamError('ERR_OUT_OF_RANGE', 'The value of "n" is out of range. It must be >= 0');
  this._maxListeners = value;
  return this;
};
Stream.prototype.getMaxListeners = function getMaxListeners() {
  return this._maxListeners ?? EventEmitter.defaultMaxListeners ?? 10;
};
Object.setPrototypeOf(Stream, EventEmitter);
Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);
Stream.prototype._events = undefined;
Stream.prototype._eventsCount = 0;
Stream.prototype._maxListeners = undefined;

function validateCombinatorOptions(options) {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw streamError('ERR_INVALID_ARG_TYPE', 'options must be an object');
  }
  if (options.signal != null && (typeof options.signal !== 'object'
    || typeof options.signal.addEventListener !== 'function'
    || typeof options.signal.aborted !== 'boolean')) {
    throw streamError('ERR_INVALID_ARG_TYPE', 'options.signal must be an AbortSignal');
  }
  return options;
}

function validateCombinator(fn, options) {
  if (typeof fn !== 'function') throw streamError('ERR_INVALID_ARG_TYPE', 'fn must be a function');
  const validated = validateCombinatorOptions(options);
  const concurrency = options?.concurrency === undefined ? 1 : Math.floor(Number(options.concurrency));
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw streamError('ERR_OUT_OF_RANGE', 'options.concurrency must be an integer greater than 0');
  }
  const highWaterMark = options?.highWaterMark === undefined
    ? concurrency - 1
    : Math.floor(Number(options.highWaterMark));
  if (!Number.isInteger(highWaterMark) || highWaterMark < 0) {
    throw streamError('ERR_OUT_OF_RANGE', 'options.highWaterMark must be an integer greater than or equal to 0');
  }
  return {
    signal: validated.signal || new AbortController().signal,
    concurrency,
    highWaterMark: highWaterMark + concurrency,
  };
}

function abortError(signal) {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function toNonNegativeIntegerOrInfinity(value) {
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  if (number < 0) {
    throw streamError(
      'ERR_OUT_OF_RANGE',
      `The value of "number" is out of range. It must be >= 0. Received ${number}`,
    );
  }
  return number;
}

function filterValues(source, fn, options) {
  if (typeof fn !== 'function') throw streamError('ERR_INVALID_ARG_TYPE', 'fn must be a function');
  return mapValues(source, async (value, context) => (
    await fn(value, context) ? value : COMBINATOR_EMPTY
  ), options);
}

function mapValues(source, fn, options) {
  const { signal, concurrency, highWaterMark } = validateCombinator(fn, options);
  return (async function* map() {
    const queue = [];
    let active = 0;
    let done = false;
    let resume;
    let next;

    const wake = (callback) => {
      if (callback) callback();
    };
    const afterItemProcessed = () => {
      active -= 1;
      if (resume && !done && active < concurrency && queue.length < highWaterMark) {
        const callback = resume;
        resume = null;
        wake(callback);
      }
    };
    const onItemError = () => {
      done = true;
      afterItemProcessed();
    };
    const pump = (async () => {
      try {
        for await (const item of source) {
          if (done) return;
          throwIfAborted(signal);
          let mapped;
          try {
            mapped = fn(item, { signal });
          } catch (error) {
            mapped = Promise.reject(error);
          }
          active += 1;
          const result = Promise.resolve(mapped);
          result.then(afterItemProcessed, onItemError);
          queue.push(result);
          wake(next);
          next = null;
          if (!done && (active >= concurrency || queue.length >= highWaterMark)) {
            await new Promise((resolve) => { resume = resolve; });
          }
        }
        queue.push(COMBINATOR_EOF);
        wake(next);
        next = null;
      } catch (error) {
        const failure = Promise.reject(error);
        failure.then(afterItemProcessed, onItemError);
        queue.push(failure);
        wake(next);
        next = null;
      } finally {
        done = true;
        wake(next);
        next = null;
      }
    })();

    try {
      while (true) {
        while (queue.length) {
          const result = queue[0];
          if (result === COMBINATOR_EOF) return;
          const value = await result;
          if (signal.aborted) throw abortError(signal);
          queue.shift();
          if (value !== COMBINATOR_EMPTY) yield value;
          if (resume && !done && active < concurrency && queue.length < highWaterMark) {
            const callback = resume;
            resume = null;
            wake(callback);
          }
        }
        await new Promise((resolve) => { next = resolve; });
      }
    } finally {
      done = true;
      wake(resume);
      resume = null;
      if (source && typeof source.destroy === 'function' && !source._ended && !source._destroyed) source.destroy();
      await pump;
    }
  })();
}

export class Readable extends EventEmitter {
  constructor(options = {}) {
    super();
    const objectMode = Boolean(options.readableObjectMode ?? options.objectMode);
    this._buffer = [];
    this._bufferedBytes = 0;
    this._ended = false;
    this._endEmitted = false;
    this._destroyed = false;
    this._closeEmitted = false;
    this._error = null;
    const inheritedRead = this._read;
    const inheritedDestroy = this._destroy;
    if (typeof options.read === 'function') this._read = options.read;
    else if (typeof inheritedRead !== 'function') this._read = Readable.prototype._read;
    this._destroyHook = options.destroy || inheritedDestroy;
    this._preserveStrings = Boolean(options.preserveStrings);
    this._decoder = null;
    this._flowing = null;
    this._readableState = new ReadableState(options, this);
    Object.assign(this._readableState, {
      readable: true, destroyed: false,
      pipes: [], reading: false, ended: false, endEmitted: false,
      readableListening: false, needReadable: false, emittedReadable: false, readingMore: false,
      resumeScheduled: false, errorEmitted: false, closeEmitted: false, multiAwaitDrain: false,
      constructed: true, sync: true,
      objectMode,
      highWaterMark: options.highWaterMark
        ?? (objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark),
      buffer: this._buffer,
      length: 0,
      autoDestroy: options.autoDestroy !== false, emitClose: options.emitClose !== false,
      closeEmitted: false,
      closed: false, errorEmitted: false,
    });
    if (options.encoding) this.setEncoding(options.encoding);
    if (options.readable === false) {
      this._ended = true;
      this._endEmitted = true;
      this._readableState.readable = false;
      this._readableState.ended = true;
      this._readableState.endEmitted = true;
    }
    this._resumeScheduled = false;
    this._resumePending = false;
    this._reading = false;
    this._readProduced = false;
    this._pipes = new Map();
    this._blockedPipes = new Set();
    this._sourceWaiter = null;
    const autoDestroyOnError = (error) => {
      if (this._readableState.autoDestroy && !this._destroyed) this.destroy(error);
    };
    autoDestroyOnError._bnhInternal = true;
    this.on('error', autoDestroyOnError);
  }

  on(name, listener) {
    super.on(name, listener);
    if (name === 'readable') {
      this._readableState.readableListening = true;
      this._readableState.needReadable = true;
    }
    if (name === 'data') this._readableState.dataListening = true;
    if (name === 'data') this.resume();
    if (name === 'readable' && !this._flowing) {
      if (!this._ended && (this.readableHighWaterMark === 0
        || this._bufferedBytes < this.readableHighWaterMark)) this._readOnce();
      this._scheduleReadable();
    }
    if (name === 'end') this._maybeEmitEnd();
    return this;
  }

  addListener(name, listener) {
    return this.on(name, listener);
  }

  removeListener(name, listener) {
    const result = super.removeListener(name, listener);
    if (name === 'readable') {
      this._readableState.readableListening = this.listenerCount('readable') > 0;
    }
    if (name === 'data' && this.listenerCount('data') === 0) {
      this._readableState.dataListening = false;
    }
    return result;
  }

  off(name, listener) {
    return this.removeListener(name, listener);
  }

  removeAllListeners(name = undefined) {
    const result = super.removeAllListeners(name);
    if (name === undefined || name === 'readable') {
      this._readableState.readableListening = this.listenerCount('readable') > 0;
    }
    if (name === undefined || name === 'data') {
      this._readableState.dataListening = this.listenerCount('data') > 0;
    }
    return result;
  }

  static from(source, options = {}) {
    const fromOptions = options ?? {};

    // Strings and Buffers are iterable, but Readable.from() treats each as a
    // single value. This is important for both object mode and callers that
    // explicitly opt out of it.
    const isBuffer = typeof globalThis.Buffer?.isBuffer === 'function'
      && globalThis.Buffer.isBuffer(source);
    if (typeof source === 'string' || isBuffer) {
      return new Readable({
        objectMode: true,
        ...fromOptions,
        read() {
          this.push(source);
          this.push(null);
        },
      });
    }

    const asyncIteratorMethod = source?.[Symbol.asyncIterator];
    const iteratorMethod = typeof asyncIteratorMethod === 'function'
      ? asyncIteratorMethod
      : source?.[Symbol.iterator];
    if (typeof iteratorMethod !== 'function') {
      throw streamError(
        'ERR_INVALID_ARG_TYPE',
        `The "iterable" argument must be an instance of Iterable. Received ${streamReceivedValue(source)}`,
      );
    }

    // Acquire the iterator before constructing the stream so errors from a
    // user-supplied iterator method remain synchronous, as in Node.
    const iterator = iteratorMethod.call(source);
    if (!iterator || typeof iterator.next !== 'function') {
      throw streamError(
        'ERR_INVALID_ARG_TYPE',
        `The "iterable" argument must be an instance of Iterable. Received ${streamReceivedValue(source)}`,
      );
    }

    let reading = false;
    let finished = false;
    let closed = false;

    const close = async (error) => {
      if (closed) return;
      closed = true;
      if (error != null && typeof iterator.throw === 'function') {
        const thrown = await iterator.throw(error);
        if (thrown?.done) return;
      }
      if (typeof iterator.return === 'function') await iterator.return();
    };

    const readable = new Readable({
      objectMode: true,
      highWaterMark: 1,
      ...fromOptions,
      read() {
        if (reading || finished) return;
        reading = true;
        return (async () => {
          try {
            while (!finished) {
              const step = await iterator.next();
              if (step.done) {
                finished = true;
                this.push(null);
                return;
              }
              let value = step.value;
              if (value && typeof value.then === 'function') value = await value;
              if (value === null) throw streamError('ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
              if (!this.push(value)) return;
            }
          } finally {
            reading = false;
          }
        })();
      },
    });

    // destroy() invokes this hook asynchronously. Keep iterator cleanup here
    // so the browser-side stream owns the same cancellation boundary as the
    // native async iterator, without relying on a host-Node stream.
    readable._destroyHook = (error, callback) => {
      Promise.resolve(close(error)).then(
        () => callback(error),
        (closeError) => callback(closeError || error),
      );
    };
    return readable;
  }

  static wrap(source, options = {}) {
    const readable = new Readable({
      objectMode: source.readableObjectMode ?? source.objectMode ?? true,
      ...options,
      destroy(error, callback) {
        source.destroy?.(error);
        callback(error);
      },
    });
    return readable.wrap(source);
  }

  push(chunk, encoding) {
    if (this._destroyed) return false;
    if (this._ended) {
      if (chunk !== null && !this._errorEmitted) {
        const error = streamError('ERR_STREAM_PUSH_AFTER_EOF', 'stream.push() after EOF');
        queueMicrotask(() => {
          if (this._errorEmitted) return;
          this._errorEmitted = true;
          this._readableState.errorEmitted = true;
          this.emit('error', error);
        });
      }
      return false;
    }
    this._readProduced = true;
    if (chunk === null) {
      if (this._decoder) {
        const trailing = this._decoder.decode();
        this._decoder = null;
        if (trailing) this.push(trailing);
      }
      this._ended = true;
      this._readableState.ended = true;
      this._resolvePending?.();
      this._scheduleReadable();
      if (!this.listenerCount('readable')) this._maybeEmitEnd();
      return false;
    }
    if (this.readableObjectMode) {
      this._buffer.push(chunk);
      this._bufferedBytes += 1;
      this._readableState.length = this._bufferedBytes;
      if (this._flowing) this._scheduleFlowDrain();
      this._scheduleReadable();
      this._resolveSourceWaiter();
      this._resolvePending?.();
      this._scheduleFlowRead();
      return this._bufferedBytes < this.readableHighWaterMark;
    }
    if (this._decoder) {
      const bytes = typeof chunk === 'string'
        ? (globalThis.Buffer?.from
          ? globalThis.Buffer.from(chunk, encoding || 'utf8')
          : new TextEncoder().encode(chunk))
        : toBytes(chunk);
      chunk = this._decoder.decode(bytes, { stream: true });
    }
    if (typeof chunk === 'string' && this._preserveStrings) {
      this._buffer.push(chunk);
      this._bufferedBytes += chunk.length;
      this._readableState.length = this._bufferedBytes;
      if (this._flowing) this._scheduleFlowDrain();
      this._scheduleReadable();
      this._resolveSourceWaiter();
      this._resolvePending?.();
      this._scheduleFlowRead();
      return this._bufferedBytes < this.readableHighWaterMark;
    }
    const bytes = toBytes(chunk);
    this._buffer.push(bytes);
    this._bufferedBytes += bytes.byteLength;
    this._readableState.length = this._bufferedBytes;
    if (this._flowing) this._scheduleFlowDrain();
    this._scheduleReadable();
    this._resolveSourceWaiter();
    this._resolvePending?.();
    this._scheduleFlowRead();
    return this._bufferedBytes < this.readableHighWaterMark;
  }

  setEncoding(encoding = 'utf8') {
    encoding ??= 'utf8';
    if (typeof encoding !== 'string' || !resolveEncodingOps(encoding)) {
      throw streamError('ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`);
    }
    this._encoding = readableEncodingName(encoding);
    const ops = resolveEncodingOps(encoding);
    this._decoder = {
      encoding: this._encoding,
      decode: (bytes) => bytes === undefined ? '' : ops.decode(bytes),
    };
    this._readableState.decoder = this._decoder;
    this._readableState.encoding = this._encoding;
    this._preserveStrings = true;
    return this;
  }

  read(size = undefined) {
    if (!this._buffer.length) {
      if (this.listenerCount('readable') && !this._ended && !this._destroyed) {
        this._readableState.needReadable = true;
      }
      if (!this._ended && !this._destroyed) this._readOnce();
      return null;
    }
    let chunk;
    if (this.readableObjectMode) {
      chunk = this._buffer.shift();
      this._bufferedBytes -= 1;
    } else {
      chunk = readableFromList(size, this._readableState);
      this._bufferedBytes = Math.max(0, this._readableState.length);
    }
    if (chunk !== null) {
      this._readableState.dataEmitted = true;
      this._readableState.length = this._bufferedBytes;
    }
    if (chunk === null && !this._ended && !this._destroyed) this._readOnce();
    this._resolveSourceWaiter();
    return chunk;
  }

  unshift(chunk, encoding) {
    if (chunk === null) {
      if (this._ended) return false;
      this._ended = true;
      this._readableState.ended = true;
      this._scheduleFlowDrain();
      return false;
    }
    let value = chunk;
    if (!this.readableObjectMode) {
      const normalizedEncoding = encoding === undefined ? undefined : `${encoding}`.toLowerCase();
      if (typeof chunk === 'string' && this._decoder
        && normalizedEncoding && normalizedEncoding === this._encoding) {
        value = chunk;
      } else if (typeof chunk === 'string' && encoding && typeof globalThis.Buffer?.from === 'function') {
        value = globalThis.Buffer.from(chunk, encoding);
      } else {
        value = toBytes(chunk);
      }
      if (this._decoder && typeof value !== 'string') value = this._decoder.decode(value, { stream: true });
    }
    this._buffer.unshift(value);
    this._bufferedBytes += this.readableObjectMode
      ? 1
      : typeof value === 'string' ? value.length : value.byteLength;
    this._readableState.length = this._bufferedBytes;
    if (this._flowing) this._scheduleFlowDrain();
    else this._scheduleReadable();
    return this._bufferedBytes < this.readableHighWaterMark;
  }

  _resolveSourceWaiter() {
    if (!this._sourceWaiter || (!this._flowing
      && this._bufferedBytes >= this.readableHighWaterMark
      && !this._ended && !this._destroyed)) return;
    const resolve = this._sourceWaiter;
    this._sourceWaiter = null;
    resolve();
  }

  _readOnce() {
    if (this._ended || this._destroyed || this._reading
      || (this.readableHighWaterMark > 0 && this._bufferedBytes >= this.readableHighWaterMark)) return;
    this._reading = true;
    this._readableState.reading = true;
    this._readableState.sync = true;
    let pending = false;
    try {
      const result = this._read(this.readableHighWaterMark);
      if (result?.then) {
        pending = true;
        result.then(
          () => {
            this._reading = false;
            this._readableState.reading = false;
            if (this._flowing) this._scheduleFlowRead();
          },
          (error) => {
            this._reading = false;
            this._readableState.reading = false;
            this.destroy(error);
          },
        );
        return;
      }
    } catch (error) {
      this.destroy(error);
    } finally {
      this._readableState.sync = false;
      if (!pending) {
        this._reading = false;
        this._readableState.reading = false;
      }
    }
  }

  _scheduleReadable() {
    if (this._flowing || this._destroyed || this._readableScheduled
      || !this.listenerCount('readable')) return;
    this._readableScheduled = true;
    queueMicrotask(() => {
      this._readableScheduled = false;
      if (this._flowing || this._destroyed || this._endEmitted) return;
      if (this._buffer.length || this._ended) {
        this._readableState.needReadable = false;
        this._readableDispatching = true;
        try {
          this.emit('readable');
          this._maybeEmitEnd();
        } finally {
          this._readableDispatching = false;
        }
        if (!this._flowing && !this._ended && this.listenerCount('readable')) {
          this._readableState.needReadable = true;
        }
      }
    });
  }

  _scheduleFlowRead() {
    if (!this._flowing || this._destroyed || this._ended || this._reading || this._flowReadScheduled) return;
    this._flowReadScheduled = true;
    queueMicrotask(() => {
      this._flowReadScheduled = false;
      if (!this._flowing || this._destroyed || this._ended || this._reading) return;
      this._readProduced = false;
      this._readOnce();
      if (!this._readProduced && !this._reading) this._maybeEmitEnd();
    });
  }

  _scheduleFlowDrain() {
    if (this._flowDrainScheduled) return;
    this._flowDrainScheduled = true;
    queueMicrotask(() => {
      this._flowDrainScheduled = false;
      if (!this._flowing || (this._destroyed && !this._error)) return;
      while (this._flowing && this._buffer.length) {
        this.emit('data', this.read(this.readableHighWaterMark));
      }
      this._maybeEmitEnd();
      if (this._flowing && !this._ended && !this._reading) this._readOnce();
    });
  }

  resume() {
    if (this._destroyed) return this;
    if (!this._flowing) this._resumePending = true;
    this._flowing = true;
    this._readableState.flowing = true;
    this._readableState.paused = false;
    if (this._resumeScheduled) return this;
    this._resumeScheduled = true;
    this._readableState.resumeScheduled = true;
    queueMicrotask(() => {
      this._resumeScheduled = false;
      this._readableState.resumeScheduled = false;
      if (!this._flowing || this._destroyed) return;
      if (this._resumePending) {
        this._resumePending = false;
        this.emit('resume');
      }
      while (this._flowing && this._buffer.length) this.emit('data', this.read(this.readableHighWaterMark));
      this._maybeEmitEnd();
      while (this._flowing && !this._ended && !this._reading) {
        this._readProduced = false;
        this._readOnce();
        if (!this._readProduced) break;
      }
    });
    return this;
  }

  isPaused() {
    return this._readableState.paused || this._readableState.flowing === false;
  }

  get readableFlowing() { return this._readableState?.flowing ?? null; }
  get readableLength() { return this._bufferedBytes; }
  get readableObjectMode() { return Boolean(this._readableState?.objectMode); }
  get readableEncoding() { return this._readableState?.encoding ?? null; }
  get readable() {
    const state = this._readableState;
    return Boolean(state && state.readable !== false && !state.destroyed
      && !state.errorEmitted && !state.endEmitted);
  }
  set readable(value) {
    if (this._readableState) this._readableState.readable = Boolean(value);
  }
  get readableHighWaterMark() { return this._readableState?.highWaterMark; }
  get readableBuffer() { return this._readableState?.buffer; }
  get errored() { return this._readableState?.errored ?? null; }
  get closed() { return Boolean(this._readableState?.closed); }
  get destroyed() { return Boolean(this._readableState?.destroyed ?? this._destroyed); }
  get readableEnded() { return Boolean(this._readableState?.endEmitted); }
  get readableAborted() { return this._destroyed && !this._endEmitted; }
  get readableDidRead() { return Boolean(this._readableState?.dataEmitted); }
  get readableListening() { return this.listenerCount('readable') > 0; }

  _undestroy() {
    this._destroyed = false;
    this._closeEmitted = false;
    this._error = null;
    this._errorEmitted = false;
    this._readableState.destroyed = false;
    this._readableState.errored = null;
    this._readableState.closed = false;
    this._readableState.errorEmitted = false;
    this._reading = false;
    this._readableState.reading = false;
    this._ended = this.readable === false;
    this._endEmitted = this.readable === false;
    this._readableState.ended = this._ended;
    this._readableState.endEmitted = this._endEmitted;
  }

  _destroy(error, callback) {
    callback(error);
  }

  pause() {
    const wasFlowing = this._flowing;
    this._flowing = false;
    this._readableState.flowing = false;
    this._readableState.paused = true;
    if (wasFlowing || this.listenerCount('pause') > 0) this.emit('pause');
    return this;
  }

  pipe(destination) {
    const onData = (chunk) => {
      if (!destination.write(chunk)) {
        this._blockedPipes.add(destination);
        this.pause();
      }
    };
    const onEnd = () => destination.end();
    const onDrain = () => {
      this._blockedPipes.delete(destination);
      if (this._blockedPipes.size === 0) this.resume();
    };
    const onUnpipe = (source) => {
      if (source === this) this.unpipe(destination);
    };
    this._pipes.set(destination, { onData, onEnd, onDrain, onUnpipe });
    if (this._readableState.pipes.length === 1) this._readableState.multiAwaitDrain = true;
    this._readableState.pipes.push(destination);
    this.on('data', onData);
    this.on('end', onEnd);
    destination.on?.('drain', onDrain);
    destination.on?.('unpipe', onUnpipe);
    destination.emit?.('pipe', this);
    this.resume();
    return destination;
  }

  unpipe(destination) {
    if (destination) {
      const pipe = this._pipes.get(destination);
      if (pipe) {
        this.off('data', pipe.onData);
        this.off('end', pipe.onEnd);
        destination.off?.('drain', pipe.onDrain);
        destination.off?.('unpipe', pipe.onUnpipe);
        const wasBlocked = this._blockedPipes.delete(destination);
        this._pipes.delete(destination);
        const pipeIndex = this._readableState.pipes.indexOf(destination);
        if (pipeIndex >= 0) this._readableState.pipes.splice(pipeIndex, 1);
        this._readableState.multiAwaitDrain = this._readableState.pipes.length > 1;
        if (this._pipes.size === 0) this.pause();
        destination.emit?.('unpipe', this);
        if (wasBlocked && this._blockedPipes.size === 0
          && (this._pipes.size > 0 || this.listenerCount('data') > 0)) this.resume();
      }
    } else {
      for (const target of this._pipes.keys()) this.unpipe(target);
      if (this._pipes.size === 0) this.pause();
    }
    return this;
  }

  destroy(error) {
    if (this._destroyed) return this;
    this._destroyed = true;
    this._reading = false;
    this._readableState.reading = false;
    this.readable = false;
    this._readableState.readable = false;
    this._readableState.destroyed = true;
    this._readableState.errored = error || null;
    if (!error || !this._flowing) {
      this._buffer.length = 0;
      this._bufferedBytes = 0;
      this._readableState.length = 0;
    }
    this._error = error || null;
    this._resolveSourceWaiter();
    this._resolvePending?.();
    const iterator = this._sourceIterator;
    this._sourceIterator = null;
    if (iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
    const finalize = (destroyError = error) => {
      const finalError = destroyError || error;
      if (finalError && !this._errorEmitted) {
        emitStreamError(this, finalError);
      }
      this._emitClose();
    };
    if (typeof this._destroyHook !== 'function') {
      queueMicrotask(finalize);
      return this;
    }
    let callbackCalled = false;
    const completeDestroy = (destroyError) => {
      if (callbackCalled) return;
      callbackCalled = true;
      queueMicrotask(() => finalize(destroyError || error));
    };
    try {
      const result = this._destroyHook.call(this, error, completeDestroy);
      if (result?.then) result.then(() => completeDestroy(), completeDestroy);
    } catch (destroyError) {
      completeDestroy(destroyError);
    }
    return this;
  }

  _maybeEmitEnd() {
    if (this._ended && !this._buffer.length && !this._endEmitted && !this._destroyed) {
      if (!this._flowing && this.listenerCount('readable') && !this._readableDispatching) {
        this._scheduleReadable();
        return;
      }
      if (!this._flowing && !this.listenerCount('readable') && !this.listenerCount('end')) return;
      this._endEmitted = true;
      this._readableState.endEmitted = true;
      this.readable = false;
      this.emit('end');
      queueMicrotask(() => {
        if (this._destroyed) this._emitClose();
        else if (!this._writable || this._writableState?.finished) {
          if (this._readableState.autoDestroy) this.destroy();
          else this._emitClose();
        }
      });
    }
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._readableState.closeEmitted = true;
    this._readableState.closed = true;
    if (this._readableState.emitClose !== false) this.emit('close');
  }

  iterator(options = undefined) {
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
      throw streamError(
        'ERR_INVALID_ARG_TYPE',
        `The "options" argument must be of type object. Received ${streamReceivedValue(options)}`,
      );
    }
    const stream = this;
    const iterator = (async function* createReadableIterator() {
      const onError = (error) => {
        stream._error = error;
        stream._resolvePending?.();
      };
      const onEnd = () => {};
      stream.on('error', onError);
      stream.once('end', onEnd);
      try {
        while (true) {
          if (stream._buffer.length) {
            yield stream.read();
            continue;
          }
          if (stream._error) throw stream._error;
          if (stream._ended || stream._destroyed) {
            stream._maybeEmitEnd();
            return;
          }
          stream._readOnce();
          if (stream._buffer.length || stream._error || stream._ended || stream._destroyed) continue;
          await new Promise((resolve) => { stream._resolvePending = resolve; });
          stream._resolvePending = null;
        }
      } finally {
        stream.off('error', onError);
        stream.off('end', onEnd);
        if (!stream._ended && !stream._destroyed
          && options?.destroyOnReturn !== false
          && (!stream._error || stream._readableState.autoDestroy)) {
          stream.destroy(stream._error);
        }
      }
    })();
    iterator.stream = stream;
    return iterator;
  }

  [Symbol.asyncIterator]() {
    return this.iterator();
  }

  wrap(source) {
    let paused = false;

    source.on('data', (chunk) => {
      if (!this.push(chunk) && source.pause) {
        paused = true;
        source.pause();
      }
    });
    source.on('end', () => this.push(null));
    source.on('error', (error) => {
      if (this._readableState.autoDestroy) this.destroy(error);
      else this.emit('error', error);
    });
    source.on('close', () => this.destroy());
    source.on('destroy', () => this.destroy());

    this._read = () => {
      if (paused && source.resume) {
        paused = false;
        source.resume();
      }
    };

    for (const key of Object.keys(source)) {
      if (this[key] === undefined && typeof source[key] === 'function') {
        this[key] = source[key].bind(source);
      }
    }
    return this;
  }

  compose(stage, options) {
    if (stage === undefined || stage === null) {
      throw streamError('ERR_INVALID_ARG_TYPE', 'The "stream" argument must be a stream, iterable, or function');
    }
    const validated = validateCombinatorOptions(options);
    const composed = compose(this, stage);
    if (validated.signal) {
      const abort = () => composed.destroy(abortError(validated.signal));
      if (validated.signal.aborted) abort();
      else validated.signal.addEventListener('abort', abort, { once: true });
    }
    return composed;
  }

  map(fn, options) {
    return Readable.from(mapValues(this, fn, options), { objectMode: true });
  }

  filter(fn, options) {
    return Readable.from(filterValues(this, fn, options), { objectMode: true });
  }

  flatMap(fn, options) {
    const mapped = mapValues(this, fn, options);
    return Readable.from((async function* flatMap() {
      for await (const value of mapped) yield* value;
    })(), { objectMode: true });
  }

  drop(number, options = undefined) {
    const validated = validateCombinatorOptions(options);
    const count = toNonNegativeIntegerOrInfinity(number);
    const source = this;
    return Readable.from((async function* drop() {
      throwIfAborted(validated.signal);
      let remaining = count;
      for await (const value of source) {
        throwIfAborted(validated.signal);
        if (remaining-- <= 0) yield value;
      }
    })(), { objectMode: true });
  }

  take(number, options = undefined) {
    const validated = validateCombinatorOptions(options);
    const count = toNonNegativeIntegerOrInfinity(number);
    const source = this;
    return Readable.from((async function* take() {
      throwIfAborted(validated.signal);
      let remaining = count;
      for await (const value of source) {
        throwIfAborted(validated.signal);
        if (remaining-- > 0) yield value;
        if (remaining <= 0) return;
      }
    })(), { objectMode: true });
  }

  async every(fn, options = undefined) {
    if (typeof fn !== 'function') throw streamError('ERR_INVALID_ARG_TYPE', 'fn must be a function');
    for await (const unused of filterValues(this, async (...args) => !(await fn(...args)), options)) {
      return false;
    }
    return true;
  }

  async forEach(fn, options) {
    if (typeof fn !== 'function') throw streamError('ERR_INVALID_ARG_TYPE', 'fn must be a function');
    const mapped = mapValues(this, async (value, context) => {
      await fn(value, context);
      return COMBINATOR_EMPTY;
    }, options);
    for await (const unused of mapped) { /* consume */ }
  }

  async reduce(reducer, initialValue, options) {
    if (typeof reducer !== 'function') throw streamError('ERR_INVALID_ARG_TYPE', 'reducer must be a function');
    const validated = validateCombinatorOptions(options);
    let hasInitialValue = arguments.length > 1;
    if (validated.signal?.aborted) {
      const error = abortError(validated.signal);
      this.once('error', () => {});
      this.destroy(error);
      throw error;
    }

    const reducerController = new AbortController();
    const reducerSignal = reducerController.signal;
    let abortHandler;
    if (validated.signal) {
      abortHandler = () => reducerController.abort();
      validated.signal.addEventListener('abort', abortHandler, { once: true });
    }

    let gotAnyItem = false;
    try {
      for await (const value of this) {
        gotAnyItem = true;
        throwIfAborted(validated.signal || { aborted: false });
        if (!hasInitialValue) {
          initialValue = value;
          hasInitialValue = true;
        } else {
          initialValue = await reducer(initialValue, value, { signal: reducerSignal });
        }
      }
      if (!gotAnyItem && !hasInitialValue) {
        throw streamError('ERR_MISSING_ARGS', 'Reduce of an empty stream requires an initial value');
      }
      return initialValue;
    } finally {
      if (abortHandler) validated.signal.removeEventListener('abort', abortHandler);
      reducerController.abort();
    }
  }

  async some(fn, options = undefined) {
    for await (const unused of filterValues(this, fn, options)) return true;
    return false;
  }

  async find(fn, options) {
    for await (const value of filterValues(this, fn, options)) return value;
    return undefined;
  }

  async toArray() {
    const result = [];
    for await (const value of this) result.push(value);
    return result;
  }
}

// Node's default readable hook is deliberately abstract. Keeping it on the
// prototype lets subclasses inherit the public/internal method descriptor and
// makes a missing implementation fail with the standard stream error.
Readable.prototype._read = function _read(_size) {
  throw streamError('ERR_METHOD_NOT_IMPLEMENTED', 'The _read() method is not implemented');
};

for (const property of [
  'readable', 'readableHighWaterMark', 'readableBuffer',
  'readableFlowing', 'readableLength', 'readableObjectMode', 'readableEncoding',
  'errored', 'closed', 'destroyed', 'readableEnded', 'readableAborted', 'readableDidRead',
]) Object.defineProperty(Readable.prototype, property, { configurable: false });

function readableDefaultEncoding(options) {
  const encoding = options.defaultEncoding;
  if (encoding == null) return 'utf8';
  if (typeof encoding !== 'string' || !resolveEncodingOps(encoding)) {
    throw streamError('ERR_UNKNOWN_ENCODING', `Unknown encoding: ${encoding}`);
  }
  return encoding === 'utf-8' ? 'utf8' : encoding;
}

function ReadableState(options = {}, stream) {
  this.objectMode = Boolean(options.readableObjectMode ?? options.objectMode);
  this.buffer = stream?._buffer || [];
  this.highWaterMark = options.highWaterMark
    ?? (this.objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark);
  this.pipes = [];
  this.readable = true;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;
  this.constructed = true;
  this.sync = true;
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;
  this.errorEmitted = false;
  this.emitClose = options.emitClose !== false;
  this.autoDestroy = options.autoDestroy !== false;
  this.destroyed = false;
  this.closed = false;
  this.closeEmitted = false;
  this.multiAwaitDrain = false;
  this.readingMore = false;
  this.length = 0;
  this.dataEmitted = false;
  this.errored = null;
  this.defaultEncoding = readableDefaultEncoding(options);
  this.decoder = null;
  this.encoding = null;
}

Object.defineProperties(ReadableState.prototype, {
  autoDestroy: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateAutoDestroy]); },
    set(value) { this[kReadableStateAutoDestroy] = Boolean(value); },
  },
  closeEmitted: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateCloseEmitted]); },
    set(value) { this[kReadableStateCloseEmitted] = Boolean(value); },
  },
  closed: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateClosed]); },
    set(value) { this[kReadableStateClosed] = Boolean(value); },
  },
  constructed: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateConstructed]); },
    set(value) { this[kReadableStateConstructed] = Boolean(value); },
  },
  endEmitted: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateEndEmitted]); },
    set(value) { this[kReadableStateEndEmitted] = Boolean(value); },
  },
  errorEmitted: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateErrorEmitted]); },
    set(value) { this[kReadableStateErrorEmitted] = Boolean(value); },
  },
  objectMode: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateObjectMode]); },
    set(value) { this[kReadableStateObjectMode] = Boolean(value); },
  },
  ended: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateEnded]); },
    set(value) { this[kReadableStateEnded] = Boolean(value); },
  },
  dataEmitted: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateDataEmitted]); },
    set(value) { this[kReadableStateDataEmitted] = Boolean(value); },
  },
  destroyed: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateDestroyed]); },
    set(value) { this[kReadableStateDestroyed] = Boolean(value); },
  },
  emitClose: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateEmitClose]); },
    set(value) { this[kReadableStateEmitClose] = Boolean(value); },
  },
  emittedReadable: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateEmittedReadable]); },
    set(value) { this[kReadableStateEmittedReadable] = Boolean(value); },
  },
  errored: {
    configurable: false,
    enumerable: false,
    get() { return this[kReadableStateErrored] || null; },
    set(value) { this[kReadableStateErrored] = value || null; },
  },
  defaultEncoding: {
    configurable: false,
    enumerable: false,
    get() { return this[kReadableStateDefaultEncoding]; },
    set(value) {
      this[kReadableStateDefaultEncoding] = value === 'utf-8' ? 'utf8' : value;
    },
  },
  decoder: {
    configurable: false,
    enumerable: false,
    get() { return this[kReadableStateDecoder] || null; },
    set(value) { this[kReadableStateDecoder] = value || null; },
  },
  encoding: {
    configurable: false,
    enumerable: false,
    get() { return this[kReadableStateEncoding] || null; },
    set(value) { this[kReadableStateEncoding] = value || null; },
  },
  reading: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateReading]); },
    set(value) { this[kReadableStateReading] = Boolean(value); },
  },
  needReadable: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateNeedReadable]); },
    set(value) { this[kReadableStateNeedReadable] = Boolean(value); },
  },
  readableListening: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateReadableListening]); },
    set(value) { this[kReadableStateReadableListening] = Boolean(value); },
  },
  readingMore: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateReadingMore]); },
    set(value) { this[kReadableStateReadingMore] = Boolean(value); },
  },
  resumeScheduled: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateResumeScheduled]); },
    set(value) { this[kReadableStateResumeScheduled] = Boolean(value); },
  },
  sync: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateSync]); },
    set(value) { this[kReadableStateSync] = Boolean(value); },
  },
  multiAwaitDrain: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStateMultiAwaitDrain]); },
    set(value) { this[kReadableStateMultiAwaitDrain] = Boolean(value); },
  },
  flowing: {
    configurable: false,
    enumerable: false,
    get() {
      return this[kReadableStateHasFlowing] ? Boolean(this[kReadableStateFlowing]) : null;
    },
    set(value) {
      if (value == null) {
        this[kReadableStateHasFlowing] = false;
        this[kReadableStateFlowing] = false;
      } else {
        this[kReadableStateHasFlowing] = true;
        this[kReadableStateFlowing] = Boolean(value);
      }
    },
  },
  pipesCount: {
    configurable: false,
    enumerable: false,
    get() { return this.pipes?.length || 0; },
  },
  paused: {
    configurable: false,
    enumerable: false,
    get() { return Boolean(this[kReadableStatePaused]); },
    set(value) { this[kReadableStatePaused] = Boolean(value); },
  },
});

function readableFromList(n, state) {
  const buffer = state?.buffer;
  if (!buffer) return null;

  // Internal callers may provide Node's linked BufferList rather than the
  // browser runtime's array-backed queue. Preserve the public helper's
  // observable behavior for both representations.
  if (!Array.isArray(buffer)) {
    const bufferedLength = Number.isFinite(state.length) && state.length > 0
      ? state.length
      : buffer.length || 0;
    if (bufferedLength === 0) return null;
    if (state.objectMode) {
      const result = buffer.shift?.();
      state.length = Math.max(0, bufferedLength - 1);
      return result;
    }
    if (!n || n >= bufferedLength) {
      const result = state.decoder
        ? buffer.join('')
        : buffer.length === 1 ? buffer.head?.data : buffer.concat(bufferedLength);
      buffer.clear?.();
      state.length = 0;
      return result;
    }
    const head = buffer.head?.data;
    if (head == null) return null;
    const result = state.decoder
      ? String(head).slice(0, n)
      : bufferChunk(toBytes(head).slice(0, n));
    buffer.head.data = typeof head === 'string' ? head.slice(n) : head.slice(n);
    state.length = Math.max(0, bufferedLength - n);
    return result;
  }

  let index = Number.isInteger(state.bufferIndex) ? state.bufferIndex : 0;
  const availableChunks = () => buffer.slice(index).filter((value) => value != null);
  const values = availableChunks();
  const measuredLength = state.objectMode
    ? values.length
    : values.reduce((total, value) => total + (value?.byteLength ?? value?.length ?? 0), 0);
  const bufferedLength = Number.isFinite(state.length) && state.length > 0
    ? state.length
    : measuredLength;
  if (bufferedLength === 0 || values.length === 0) return null;

  const consume = (count) => {
    if (Number.isInteger(state.bufferIndex)) {
      let remaining = count;
      while (index < buffer.length && remaining > 0) {
        const value = buffer[index];
        if (value == null) {
          index += 1;
          continue;
        }
        const size = state.objectMode ? 1 : value.byteLength ?? value.length ?? 0;
        if (remaining >= size) {
          remaining -= size;
          buffer[index] = null;
          index += 1;
        } else {
          buffer[index] = typeof value === 'string'
            ? value.slice(remaining)
            : value.slice(remaining);
          remaining = 0;
          break;
        }
      }
      state.bufferIndex = index;
    } else {
      let remaining = count;
      while (buffer.length && remaining > 0) {
        const value = buffer[0];
        const size = state.objectMode ? 1 : value.byteLength ?? value.length ?? 0;
        if (remaining < size) {
          buffer[0] = typeof value === 'string'
            ? value.slice(remaining)
            : value.slice(remaining);
          break;
        }
        remaining -= size;
        buffer.shift();
      }
    }
    if (Number.isFinite(state.length)) state.length = Math.max(0, state.length - count);
  };

  if (state.objectMode) {
    const result = values[0];
    consume(1);
    return result;
  }

  const decoder = state.decoder;
  const all = !n || n >= bufferedLength;
  const target = all ? bufferedLength : n;
  if (decoder) {
    let result = '';
    let remaining = target;
    for (const value of values) {
      const text = String(value);
      if (all || text.length <= remaining) {
        result += text;
        remaining -= text.length;
        if (remaining === 0) break;
      } else {
        result += text.slice(0, remaining);
        remaining = 0;
        break;
      }
    }
    consume(target - remaining);
    return result;
  }

  if (all && values.length === 1) {
    const result = values[0];
    consume(target);
    return result;
  }

  let result = new Uint8Array(0);
  let remaining = target;
  for (const value of values) {
    const bytes = toBytes(value);
    const take = Math.min(bytes.byteLength, remaining);
    result = appendBytes(result, bytes.slice(0, take));
    remaining -= take;
    if (remaining === 0) break;
  }
  consume(target - remaining);
  return bufferChunk(result);
}

Readable.ReadableState = ReadableState;
Readable._fromList = readableFromList;
// Keep the legacy constructor graph intact for consumers that import Stream
// directly instead of going through runtime.js's callable wrapper.
Stream.Readable = Readable;
defineAsyncDispose(Readable.prototype);

const writableStateValues = new WeakMap();
function nop() {}

function WritableState(options = {}, stream) {
  writableStateValues.set(this, Object.create(null));
  Object.assign(this, {
    objectMode: Boolean(options.writableObjectMode ?? options.objectMode),
    finalCalled: false, needDrain: false, ending: false, ended: false, finished: false,
    destroyed: false, decodeStrings: options.decodeStrings !== false, writing: false,
    sync: true, bufferProcessing: false, constructed: true, prefinished: false,
    errorEmitted: false, emitClose: options.emitClose !== false,
    autoDestroy: options.autoDestroy !== false, closed: false, closeEmitted: false,
    allBuffers: true, allNoop: true, errored: null, writable: options.writable !== false,
    defaultEncoding: options.defaultEncoding == null
      ? 'utf8' : normalizeWritableEncoding(options.defaultEncoding),
    highWaterMark: options.highWaterMark
      ?? (options.writableObjectMode ?? options.objectMode
        ? defaultObjectHighWaterMark : defaultWritableHighWaterMark),
    writecb: nop, afterWriteTickInfo: null, buffered: stream?._queue || [],
    length: 0,
  });
}

function defineWritableStateBoolean(name) {
  Object.defineProperty(WritableState.prototype, name, {
    configurable: false,
    enumerable: false,
    get() { return Boolean(writableStateValues.get(this)?.[name]); },
    set(value) {
      const values = writableStateValues.get(this) || Object.create(null);
      values[name] = Boolean(value);
      writableStateValues.set(this, values);
    },
  });
}

for (const property of [
  'closeEmitted', 'closed', 'constructed', 'decodeStrings',
  'destroyed', 'emitClose', 'ended', 'autoDestroy', 'bufferProcessing',
  'ending', 'errorEmitted', 'allBuffers', 'allNoop', 'objectMode',
  'finalCalled', 'needDrain', 'finished', 'writing', 'sync', 'prefinished', 'writable',
]) defineWritableStateBoolean(property);

function defineWritableStateValue(name, fallback) {
  Object.defineProperty(WritableState.prototype, name, {
    configurable: false,
    enumerable: false,
    get() {
      const values = writableStateValues.get(this);
      if (values && Object.prototype.hasOwnProperty.call(values, name)) return values[name];
      return typeof fallback === 'function' ? fallback() : fallback;
    },
    set(value) {
      const values = writableStateValues.get(this) || Object.create(null);
      values[name] = value;
      writableStateValues.set(this, values);
    },
  });
}

// Node keeps these cold-path values off the instance and exposes them through
// non-enumerable accessors. This matters to internal stream users that inspect
// WritableState directly, in addition to keeping the browser state shape
// compatible with Node's WritableState.
defineWritableStateValue('afterWriteTickInfo', null);
defineWritableStateValue('buffered', () => []);
defineWritableStateValue('errored', null);
defineWritableStateValue('writecb', nop);

Object.defineProperty(WritableState.prototype, 'defaultEncoding', {
  configurable: false,
  enumerable: false,
  get() { return writableStateValues.get(this)?.defaultEncoding ?? 'utf8'; },
  set(value) {
    const values = writableStateValues.get(this) || Object.create(null);
    values.defaultEncoding = value === 'utf-8' ? 'utf8' : value;
    writableStateValues.set(this, values);
  },
});

class WritableImpl extends EventEmitter {
  constructor(options = {}) {
    super();
    this._writableFlag = true;
    // Browser output is never a terminal. Pseudo-TTY behavior is intentionally
    // not emulated because the browser has no safe terminal primitive.
    this.isTTY = false;
    this._writableObjectMode = Boolean(options.writableObjectMode ?? options.objectMode);
    this.decodeStrings = options.decodeStrings !== false;
    const inheritedDestroy = this._destroy;
    const inheritedFinal = this._final;
    if (options.write) this._write = options.write;
    if (options.writev) this._writev = options.writev;
    if (options.destroy) this._destroy = options.destroy;
    this._destroyHook = options.destroy || inheritedDestroy;
    this._final = options.final || inheritedFinal;
    this._owner = options.owner;
    this._queue = [];
    this._current = null;
    this._pendingBytes = 0;
    this._needDrain = false;
    this._ending = false;
    this._ended = false;
    this._finishEmitted = false;
    this._destroyed = false;
    this._closeEmitted = false;
    this._errorEmitted = false;
    this._writableFinished = false;
    this._endCallbacks = [];
    this._endCallbackCalled = false;
    this._corked = 0;
    this._writableState = new WritableState(options, this);
    if (options.writable === false) {
      this.writable = false;
      this._ending = true;
      this._ended = true;
      this._writableFinished = true;
      this._writableState.writable = false;
      this._writableState.ended = true;
      this._writableState.finished = true;
    }
    this._writableInitial = this._writableState.writable;
    const autoDestroyOnError = (error) => {
      if (this._writableState.autoDestroy && !this._destroyed) this.destroy(error);
    };
    autoDestroyOnError._bnhInternal = true;
    this.on('error', autoDestroyOnError);
  }

  get closed() { return Boolean(this._writableState?.closed); }
  get destroyed() { return Boolean(this._writableState?.destroyed ?? this._destroyed); }
  set destroyed(value) {
    this._destroyed = Boolean(value);
    if (this._writableState) this._writableState.destroyed = this._destroyed;
  }
  get writable() {
    const state = this._writableState;
    return Boolean(state && state.writable !== false
      && !this._ending && !this._ended && !this._destroyed && !state.errored);
  }
  set writable(value) {
    this._writableFlag = Boolean(value);
    if (this._writableState) this._writableState.writable = this._writableFlag;
  }
  get writableFinished() { return this._writableState?.finished ?? this._writableFinished; }
  get writableObjectMode() { return this._writableState?.objectMode ?? this._writableObjectMode; }
  get writableEnded() { return Boolean(this._ending); }
  get writableHighWaterMark() { return this._writableState?.highWaterMark; }
  get writableLength() { return this._writableState?.length; }
  get writableBuffer() {
    const queue = this._queue || this._writable?._queue || [];
    return queue.map(({ bytes: chunk, encoding, callback }) => ({ chunk, encoding, callback }));
  }
  get errored() { return this._writableState?.errored ?? null; }
  get writableAborted() { return this._destroyed && !this._finishEmitted; }
  get writableNeedDrain() { return this._needDrain; }
  get writableCorked() { return this._corked; }

  _undestroy() {
    const writable = this._writableInitial !== false;
    this._destroyed = false;
    this._closeEmitted = false;
    this._errorEmitted = false;
    this._current = null;
    this._queue.length = 0;
    this._pendingBytes = 0;
    this._needDrain = false;
    this._ending = !writable;
    this._ended = !writable;
    this._finishEmitted = !writable;
    this._finishScheduled = false;
    this._finalStarted = false;
    this._writableFinished = !writable;
    this._endCallbacks = [];
    this._endCallbackCalled = false;
    this._writableState.writable = writable;
    this._writableState.destroyed = false;
    this._writableState.errored = null;
    this._writableState.closed = false;
    this._writableState.closeEmitted = false;
    this._writableState.constructed = true;
    this._writableState.errorEmitted = false;
    this._writableState.finalCalled = false;
    this._writableState.needDrain = false;
    this._writableState.prefinished = false;
    this._writableState.ending = !writable;
    this._writableState.ended = !writable;
    this._writableState.finished = !writable;
    this._writableState.length = 0;
    this._writableFlag = writable;
  }

  _destroy(error, callback) {
    callback(error);
  }

  pipe() {
    const error = streamError('ERR_STREAM_CANNOT_PIPE', 'Cannot pipe, not readable');
    if (this._writableState?.autoDestroy !== false) {
      this.destroy(error);
    } else {
      this._writableState.errored = error;
      queueMicrotask(() => {
        if (this._errorEmitted) return;
        this._errorEmitted = true;
        this._writableState.errorEmitted = true;
        this.emit('error', error);
      });
    }
  }

  setDefaultEncoding(encoding) {
    this._writableState.defaultEncoding = normalizeWritableEncoding(encoding);
    return this;
  }

  write(chunk, encoding = undefined, callback = () => {}) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (typeof callback !== 'function') callback = () => {};
    if (this._ending || this._ended) {
      const error = streamError('ERR_STREAM_WRITE_AFTER_END', 'write after end');
      if (this._ended) {
        try {
          callback(error);
        } finally {
          queueMicrotask(() => {
            if (this._errorEmitted) return;
            emitStreamError(this, error);
          });
        }
      } else {
        this._rejectWrite(error, callback);
      }
      return false;
    }
    if (this._destroyed) {
      const error = streamError(
        'ERR_STREAM_DESTROYED',
        'Cannot call write after a stream was destroyed',
      );
      this._rejectWrite(error, callback);
      return false;
    }
    if (chunk === null) throw streamError('ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
    let bytes;
    let size;
    let requestEncoding = encoding;
    if (this.writableObjectMode) {
      bytes = chunk;
      size = 1;
    } else {
      try {
        const selectedEncoding = encoding === undefined || encoding === null
          ? this._writableState.defaultEncoding
          : encoding === 'buffer' ? encoding : normalizeWritableEncoding(encoding);
        if (typeof chunk === 'string' && !this.decodeStrings) {
          bytes = chunk;
          size = chunk.length;
          requestEncoding = selectedEncoding;
        } else {
          bytes = typeof chunk === 'string'
            ? toBytes(chunk, selectedEncoding)
            : toBytes(chunk);
          size = bytes.byteLength;
          requestEncoding = 'buffer';
        }
      } catch (error) {
        error.code ||= 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
    }
    const request = { bytes, size, encoding: requestEncoding, callback, settled: false };
    this._queue.push(request);
    this._pendingBytes += size;
    this._writableState.length = this._pendingBytes;
    if (this._pendingBytes >= this.writableHighWaterMark) {
      this._needDrain = true;
      this._writableState.needDrain = true;
    }
    this._processNext();
    return !this._destroyed && this._pendingBytes < this.writableHighWaterMark;
  }

  end(chunk, encoding = undefined, callback = () => {}) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    }
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (typeof callback !== 'function') callback = () => {};
    if (this._ending && !this._ended && !this._destroyed) {
      if (chunk !== undefined) {
        const error = streamError('ERR_STREAM_WRITE_AFTER_END', 'write after end');
        queueMicrotask(() => callback(error));
        this.destroy(error);
        return this;
      }
      this._endCallbacks.push(callback);
      return this;
    }
    if (this._ended || this._destroyed) {
      const error = this._ended
        ? streamError('ERR_STREAM_ALREADY_FINISHED', 'end called more than once')
        : streamError('ERR_STREAM_DESTROYED', 'end after destroy');
      queueMicrotask(() => callback(error));
      return this;
    }
    if (chunk !== undefined) this.write(chunk, encoding);
    this._ending = true;
    this._writableState.ending = true;
    this._endCallbacks.push(callback);
    this._finishIfReady();
    return this;
  }

  cork() {
    this._corked += 1;
    return this;
  }

  uncork() {
    if (this._corked > 0) this._corked -= 1;
    if (this._corked === 0) this._processNext();
    return this;
  }

  destroy(error) {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.destroyed = true;
    this.writable = false;
    this._writableState.destroyed = true;
    this._writableState.writable = false;
    this._writableState.errored = error || null;
    const reason = error || streamError('ERR_STREAM_DESTROYED', 'stream destroyed');
    const pending = this._queue.splice(0);
    if (this._current && !this._current.settled) pending.unshift(this._current);
    this._current = null;
    this._pendingBytes = 0;
    this._writableState.length = 0;
    for (const request of pending) this._complete(request, reason, false);
    if (this._ending && !this._endCallbackCalled) {
      this._endCallbackCalled = true;
      for (const callback of this._endCallbacks) callback(reason);
    }
    const finalize = (destroyError = error) => {
      const finalError = destroyError || error;
      if (finalError && !this._errorEmitted) {
        emitStreamError(this, finalError);
      }
      this._emitClose();
    };
    const destroyHook = this._destroyHook === WritableImpl.prototype._destroy
      ? this._destroy
      : this._destroyHook;
    if (typeof destroyHook !== 'function') {
      queueMicrotask(finalize);
      return this;
    }
    let callbackCalled = false;
    const completeDestroy = (destroyError) => {
      if (callbackCalled) return;
      callbackCalled = true;
      queueMicrotask(() => finalize(destroyError || error));
    };
    try {
      const result = destroyHook.call(this, error, completeDestroy);
      if (result?.then) result.then(() => completeDestroy(), completeDestroy);
    } catch (destroyError) {
      completeDestroy(destroyError);
    }
    return this;
  }

  _processNext() {
    if (this._corked > 0) return;
    if (this._destroyed || this._current || !this._queue.length) {
      this._finishIfReady();
      return;
    }
    const request = this._queue.shift();
    this._current = request;
    const writev = this._owner?._writev || this._writev;
    if (typeof writev === 'function' && this._queue.length) {
      const requests = [request, ...this._queue.splice(0)];
      const done = (error) => {
        this._writableState.writing = false;
        this._writableState.writecb = nop;
        if (requests.some((item) => item.settled)) {
          const duplicate = streamError('ERR_MULTIPLE_CALLBACK', 'Callback called multiple times');
          if (!this._destroyed) this.destroy(duplicate);
          return;
        }
        for (const item of requests) item.settled = true;
        this._current = null;
        this._pendingBytes = Math.max(0, this._pendingBytes - requests.reduce((total, item) => total + item.size, 0));
        this._writableState.length = this._pendingBytes;
        if (error) {
          for (const item of requests) item.callback(error);
          if (!this._destroyed) this.destroy(error);
          return;
        }
        for (const item of requests) item.callback();
        if (this._needDrain && this._pendingBytes === 0) {
          this._needDrain = false;
          this._writableState.needDrain = false;
          if (!this._ending && !this._ended) this.emit('drain');
        }
        queueMicrotask(() => this._processNext());
      };
      try {
        this._writableState.writing = true;
        this._writableState.writecb = done;
        writev.call(
          this._owner || this,
          requests.map((item) => ({ chunk: item.bytes, encoding: item.encoding })),
          done,
        );
      } catch (error) {
        done(error);
      }
      return;
    }
    const done = (error) => {
      this._writableState.writing = false;
      this._writableState.writecb = nop;
      if (request.settled) {
        const duplicate = new Error('Callback called multiple times');
        duplicate.code = 'ERR_MULTIPLE_CALLBACK';
        if (!this._destroyed) this.destroy(duplicate);
        else if (!this._errorEmitted) {
          this._errorEmitted = true;
          queueMicrotask(() => this.emit('error', duplicate));
        }
        return;
      }
      this._complete(request, error);
    };
    try {
      const write = this._owner?._write || this._write;
      this._writableState.writing = true;
      this._writableState.writecb = done;
      write.call(this._owner || this, request.bytes, request.encoding, done);
    } catch (error) {
      this._writableState.writing = false;
      this._writableState.writecb = nop;
      throw error;
    }
  }

  _complete(request, error, continueProcessing = true) {
    if (request.settled) return;
    request.settled = true;
    if (this._current === request) this._current = null;
    this._pendingBytes = Math.max(0, this._pendingBytes - request.size);
    this._writableState.length = this._pendingBytes;
    if (error) {
      try {
        request.callback(error);
      } finally {
        if (!this._destroyed) this.destroy(error);
      }
      return;
    }
    request.callback();
    if (this._needDrain && this._pendingBytes === 0) {
      this._needDrain = false;
      this._writableState.needDrain = false;
      if (!this._ending && !this._ended) this.emit('drain');
    }
    if (continueProcessing) queueMicrotask(() => this._processNext());
  }

  _rejectWrite(error, callback) {
    try {
      callback(error);
    } finally {
      if (!this._destroyed) this.destroy(error);
      else if (!this._resetDestroyed && !this._errorEmitted) {
        this._errorEmitted = true;
        this._writableState.errorEmitted = true;
        this.emit('error', error);
      }
    }
  }

  _finishIfReady() {
    if (!this._ending || this._current || this._queue.length || this._finishEmitted || this._destroyed) return;
    this._writableState.finalCalled = true;
    if (this._final && !this._finalStarted) {
      this._finalStarted = true;
      let called = false;
      const done = (error) => {
        if (called) return;
        called = true;
        if (error) this.destroy(error);
        else this._finishNow();
      };
      try {
        const final = this._owner?._final || this._final;
        final.call(this._owner || this, done);
      } catch (error) {
        done(error);
      }
      return;
    }
    if (!this._final) this._finishNow();
  }

  _finishNow() {
    if (this._finishEmitted || this._finishScheduled || this._destroyed) return;
    this.writable = false;
    this._writableState.writable = false;
    this._writableState.prefinished = true;
    this._writableState.ended = true;
    this._finishScheduled = true;
    this.emit('prefinish');
    queueMicrotask(() => {
      this._finishScheduled = false;
      if (this._finishEmitted || this._destroyed) return;
      this._finishEmitted = true;
      this._writableFinished = true;
      this._ended = true;
      this._writableState.finished = true;
      if (!this._endCallbackCalled) {
        this._endCallbackCalled = true;
        for (const callback of this._endCallbacks) callback(null);
      }
      this.emit('finish');
      queueMicrotask(() => {
        if (this._destroyed) this._emitClose();
        else if (this._writableState.autoDestroy) this.destroy();
      });
    });
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._writableState.closeEmitted = true;
    this._writableState.closed = true;
    this.emit('close');
  }
}

WritableImpl.prototype._write = function _write(chunk, encoding, callback) {
  if (this._writev) {
    this._writev([{ chunk, encoding }], callback);
    return;
  }
  throw streamError('ERR_METHOD_NOT_IMPLEMENTED', 'The _write() method is not implemented');
};
WritableImpl.prototype._writev = null;
for (const property of ['pipe', 'setDefaultEncoding']) {
  Object.defineProperty(WritableImpl.prototype, property, { enumerable: true, configurable: true });
}
for (const property of [
  'closed', 'destroyed', 'writable', 'writableFinished', 'writableObjectMode', 'writableBuffer',
  'writableEnded', 'writableHighWaterMark', 'writableLength', 'errored',
]) Object.defineProperty(WritableImpl.prototype, property, { configurable: false });

export function Writable(options = {}) {
  if (new.target) return Reflect.construct(WritableImpl, [options], new.target);
  const initialized = new WritableImpl(options);
  if (this === undefined || this === null) return initialized;
  Object.assign(this, initialized);
  return this;
}

Writable.prototype = WritableImpl.prototype;

Writable.WritableState = WritableState;
Writable.WritableState.prototype.getBuffer = function getBuffer() {
  return this.buffered?.slice?.() || [];
};
Object.defineProperty(Writable.WritableState.prototype, 'bufferedRequestCount', {
  configurable: true,
  get() { return this.buffered?.length || 0; },
});
Object.defineProperty(Writable, Symbol.hasInstance, {
  configurable: true,
  value(value) { return Boolean(value && value._writableState); },
});
defineAsyncDispose(Writable.prototype);

export function ensureOutputStream(stream) {
  if (stream && typeof stream.write === 'function' && typeof stream.on === 'function' && typeof stream.once === 'function') {
    return stream;
  }
  return new Writable({
    write(chunk, encoding, callback) {
      if (!stream || typeof stream.write !== 'function') {
        callback(new TypeError('output stream must provide write()'));
        return;
      }
      try {
        stream.write(chunk, encoding);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

class DuplexImpl extends Readable {
  constructor(options = {}) {
    super(options);
    this._writable = new Writable(options);
    this._writableState = this._writable._writableState;
    this._writable._owner = this;
    // Duplex owns one destroy lifecycle. The inner writable only drains its
    // pending writes; invoking the user hook on both layers would double-call
    // the Node _destroy contract.
    this._writable._destroyHook = null;
    const inheritedDestroy = this._destroyHook;
    if (options.write) this._write = options.write;
    if (options.writev) this._writev = options.writev;
    if (options.final) this._final = options.final;
    this._destroyHook = options.destroy || inheritedDestroy;
    // The writable side owns queueing and finish emission, but the public
    // Duplex subclass owns the _final hook. Keep the hook on the inner side
    // so end() waits for an async subclass finalizer before finishing.
    this._writable._final = this._final;
    this.allowHalfOpen = options.allowHalfOpen !== false;
    this.writable = this._writable.writable;
    this._writable.on('drain', () => this.emit('drain'));
    this._writable.on('finish', () => {
      this.writable = false;
      this.emit('finish');
      queueMicrotask(() => {
        if (this._destroyed) this._emitClose();
        else if (this._readableState.endEmitted && this._readableState.autoDestroy) this.destroy();
        else if (!this.readable) this._emitClose();
      });
    });
    this._writable.on('error', (error) => this.destroy(error));
    this._writable.on('close', () => queueMicrotask(() => {
      // Ending the writable side of a duplex stream is not the same as
      // closing the socket; the readable peer may still have responses.
      if (this._destroyed || !this.readable) this._emitClose();
    }));
  }

  get writableFinished() { return this._writable?.writableFinished ?? false; }
  get writableObjectMode() { return this._writable?.writableObjectMode ?? this._writableState?.objectMode ?? false; }
  get writableHighWaterMark() { return this._writable?.writableHighWaterMark ?? this._writableState?.highWaterMark; }
  get writableLength() { return this._writable?.writableLength ?? this._writableState?.length; }
  get writableCorked() { return this._writable?.writableCorked ?? 0; }
  get writableEnded() { return this._writable?.writableEnded ?? false; }
  get writableNeedDrain() { return this._writable?.writableNeedDrain ?? false; }
  get destroyed() {
    return Boolean(this._readableState?.destroyed && this._writableState?.destroyed);
  }
  set destroyed(value) {
    if (this._readableState && this._writableState) {
      this._readableState.destroyed = Boolean(value);
      this._writableState.destroyed = Boolean(value);
    }
  }

  write(...args) {
    const result = this._writable.write(...args);
    return result;
  }

  cork() { this._writable.cork(); return this; }

  uncork() { this._writable.uncork(); return this; }

  end(...args) {
    this._writable.end(...args);
    this.writable = this._writable.writable;
    return this;
  }

  destroy(error) {
    if (this._destroyed) return this;
    this._writable.destroy(error);
    return super.destroy(error);
  }

  _undestroy() {
    super._undestroy();
    this._writable._undestroy();
    this.writable = this._writable.writable;
  }
}

// Duplex parasitically inherits Writable's methods/accessors in Node. The
// inner writable owns the queue and state, so these members intentionally
// forward to it while retaining the public descriptors on Duplex.prototype.
for (const property of ['setDefaultEncoding', '_write', '_writev']) {
  Object.defineProperty(DuplexImpl.prototype, property, {
    ...Object.getOwnPropertyDescriptor(WritableImpl.prototype, property),
  });
}
Object.defineProperty(DuplexImpl.prototype, 'writable', {
  configurable: false,
  get() { return this._writable?.writable ?? false; },
  set(value) {
    this._writableFlag = Boolean(value);
    if (this._writableState) this._writableState.writable = this._writableFlag;
  },
});
for (const property of ['writableBuffer']) {
  Object.defineProperty(DuplexImpl.prototype, property, {
    ...Object.getOwnPropertyDescriptor(WritableImpl.prototype, property),
  });
}

export function Duplex(options = {}) {
  if (new.target) return Reflect.construct(DuplexImpl, [options], new.target);
  return new DuplexImpl(options);
}

Duplex.prototype = DuplexImpl.prototype;
Object.setPrototypeOf(Duplex, DuplexImpl);

function isReadableWebStream(value) {
  return Boolean(value && typeof value.getReader === 'function');
}

function isWritableWebStream(value) {
  return Boolean(value && typeof value.getWriter === 'function');
}

function isDuplexStream(value) {
  return isNodeStream(value) && hasReadableSide(value) && hasWritableSide(value);
}

function isThenable(value) {
  return Boolean(value && typeof value.then === 'function');
}

function readableFromIterable(value) {
  const readable = Readable.from(value);
  // Readable.from drives its iterator independently. It still needs a
  // concrete pull hook when a consumer switches it into flowing mode.
  if (readable._read === Readable.prototype._read) readable._read = () => {};
  return readable;
}

function duplexFromInvalidReturn(value) {
  const received = value === null
    ? 'null'
    : value === undefined
      ? 'undefined'
      : typeof value === 'number' || typeof value === 'boolean'
        ? `type ${typeof value} (${value})`
        : typeof value === 'string'
          ? `type string ('${value}')`
          : `an instance of ${value?.constructor?.name || typeof value}`;
  return streamError(
    'ERR_INVALID_RETURN_VALUE',
    `Expected Iterable, AsyncIterable or AsyncFunction to be returned from the "body" function but got ${received}.`,
  );
}

function readableSide(value) {
  if (value === undefined || value === null) return undefined;
  if (isNodeStream(value) || isReadableWebStream(value)) return value;
  return duplexFrom(value);
}

function writableSide(value) {
  if (value === undefined || value === null) return undefined;
  if (isNodeStream(value) || isWritableWebStream(value)) return value;
  return duplexFrom(value);
}

function createDuplexFromSides(readableSource, writableTarget, options = {}) {
  const hasCustomWrite = typeof options.write === 'function';
  const hasCustomFinal = typeof options.final === 'function';
  const writable = writableTarget !== undefined || hasCustomWrite;
  const readable = readableSource !== undefined;
  let readableCleanup = () => {};
  let writableCleanup = () => {};
  let reader;
  let writer;
  let pendingWrite;
  let pendingFinal;
  let d;

  const cleanup = () => {
    readableCleanup();
    writableCleanup();
    readableCleanup = () => {};
    writableCleanup = () => {};
    try { reader?.releaseLock?.(); } catch { /* ignore */ }
    try { writer?.releaseLock?.(); } catch { /* ignore */ }
    reader = null;
    writer = null;
  };

  const writeToTarget = (chunk, encoding, callback) => {
    if (isWritableWebStream(writableTarget)) {
      if (!writer) writer = writableTarget.getWriter();
      Promise.resolve(writer.write(chunk)).then(() => callback(), callback);
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (pendingWrite?.finish === finish) pendingWrite = null;
      writableTarget.off?.('drain', onDrain);
      callback(error);
    };
    const onDrain = () => finish();
    try {
      const accepted = writableTarget.write(chunk, encoding);
      if (accepted) finish();
      else pendingWrite = { finish };
    } catch (error) {
      finish(error);
    }
  };

  const finishTarget = (callback) => {
    if (isWritableWebStream(writableTarget)) {
      if (!writer) writer = writableTarget.getWriter();
      Promise.resolve(writer.close()).then(() => callback(), callback);
      return;
    }
    if (writableTarget.writableFinished || writableTarget._writableState?.finished) {
      callback();
      return;
    }
    const onFinish = () => {
      writableTarget.off?.('finish', onFinish);
      writableTarget.off?.('error', onError);
      pendingFinal = null;
      callback();
    };
    const onError = (error) => {
      writableTarget.off?.('finish', onFinish);
      writableTarget.off?.('error', onError);
      pendingFinal = null;
      callback(error);
    };
    pendingFinal = { onFinish, onError };
    writableTarget.once?.('finish', onFinish);
    writableTarget.once?.('error', onError);
    try {
      writableTarget.end();
    } catch (error) {
      onError(error);
    }
  };

  const destroyTarget = (error) => {
    if (isWritableWebStream(writableTarget)) {
      Promise.resolve(writer?.abort?.(error)).catch(() => {});
    } else {
      writableTarget?.destroy?.(error);
    }
  };

  const destroySource = (error) => {
    if (isReadableWebStream(readableSource)) {
      Promise.resolve(reader?.cancel?.(error)).catch(() => {});
    } else {
      readableSource?.destroy?.(error);
    }
  };

  const onDestroy = (error, callback) => {
    destroyTarget(error);
    destroySource(error);
    cleanup();
    if (typeof options.destroy !== 'function') {
      callback(error);
      return;
    }
    let called = false;
    const done = (destroyError) => {
      if (called) return;
      called = true;
      callback(destroyError || error);
    };
    try {
      const result = options.destroy(error, done);
      if (result?.then) result.then(() => done(), done);
    } catch (destroyError) {
      done(destroyError);
    }
  };

  const write = hasCustomWrite
    ? options.write
    : (chunk, encoding, callback) => writeToTarget(chunk, encoding, callback);
  const final = hasCustomFinal
    ? options.final
    : (callback) => finishTarget(callback);

  d = new Duplex({
    readable,
    writable,
    readableObjectMode: options.readableObjectMode ?? readableObjectMode(readableSource),
    writableObjectMode: options.writableObjectMode ?? writableObjectMode(writableTarget),
    read() {},
    write,
    final,
    destroy: onDestroy,
  });

  if (readable) {
    if (isReadableWebStream(readableSource)) {
      reader = readableSource.getReader();
      d._read = () => reader.read().then(({ done, value }) => {
        if (done) d.push(null);
        else {
          d.push(value);
          if (d._flowing) d._scheduleFlowRead();
        }
      }, (error) => d.destroy(error));
    } else {
      const onData = (chunk) => {
        if (!d.push(chunk)) readableSource.pause?.();
      };
      const onEnd = () => d.push(null);
      const onError = (error) => d.destroy(error);
      const onClose = () => {
        if (!d.readableEnded && !readableSource.readableEnded
          && !readableSource._ended && !d.destroyed) d.destroy();
      };
      readableSource.on?.('data', onData);
      readableSource.on?.('end', onEnd);
      readableSource.on?.('error', onError);
      readableSource.on?.('close', onClose);
      d._read = () => readableSource.resume?.();
      readableCleanup = () => {
        readableSource.off?.('data', onData);
        readableSource.off?.('end', onEnd);
        readableSource.off?.('error', onError);
        readableSource.off?.('close', onClose);
      };
    }
  }

  if (writable && writableTarget) {
    if (isWritableWebStream(writableTarget)) {
      // The writer promise is the backpressure signal for browser streams.
    } else {
      const onDrain = () => {
        const current = pendingWrite;
        if (current) current.finish();
      };
      const onError = (error) => {
        const current = pendingWrite;
        if (current) current.finish(error);
        d.destroy(error);
      };
      writableTarget.on?.('drain', onDrain);
      writableTarget.on?.('error', onError);
      writableCleanup = () => {
        writableTarget.off?.('drain', onDrain);
        writableTarget.off?.('error', onError);
        const current = pendingFinal;
        if (current) {
          writableTarget.off?.('finish', current.onFinish);
          writableTarget.off?.('error', current.onError);
        }
      };
    }
  }

  return d;
}

function duplexFromFunction(body) {
  let resolveInput;
  let inputPromise = new Promise((resolve) => { resolveInput = resolve; });
  const controller = new AbortController();
  const input = (async function* inputGenerator() {
    while (true) {
      const current = await inputPromise;
      inputPromise = new Promise((resolve) => { resolveInput = resolve; });
      queueMicrotask(() => current.callback?.());
      if (current.done) return;
      if (controller.signal.aborted) throw abortError(controller.signal);
      yield current.chunk;
    }
  }());

  let result;
  try {
    result = body(input, { signal: controller.signal });
  } catch (error) {
    throw error;
  }

  if (isDuplexStream(result)) return result;
  if (isIterable(result)) {
    const output = readableFromIterable(result);
    return createDuplexFromSides(output, undefined, {
      writableObjectMode: true,
      write(chunk, _encoding, callback) {
        const resolve = resolveInput;
        resolveInput = null;
        resolve?.({ chunk, done: false, callback });
      },
      final(callback) {
        const resolve = resolveInput;
        resolveInput = null;
        resolve?.({ done: true, callback });
      },
      destroy(error, callback) {
        controller.abort(error);
        const resolve = resolveInput;
        resolveInput = null;
        resolve?.({ done: true });
        callback(error);
      },
    });
  }

  if (isThenable(result)) {
    let d;
    let settled = false;
    let resolveFinal;
    const resultPromise = Promise.resolve(result).then((value) => {
      if (value != null) throw duplexFromInvalidReturn(value);
      settled = true;
      resolveFinal?.();
    }, (error) => {
      d?.destroy(error);
      resolveFinal?.(error);
    });
    return d = createDuplexFromSides(undefined, undefined, {
      writableObjectMode: true,
      write(chunk, _encoding, callback) {
        const resolve = resolveInput;
        resolveInput = null;
        resolve?.({ chunk, done: false, callback });
      },
      final(callback) {
        const resolve = resolveInput;
        resolveInput = null;
        resolve?.({ done: true });
        if (settled) callback();
        else {
          resolveFinal = (error) => callback(error);
          resultPromise.catch(() => {});
        }
      },
      destroy(error, callback) {
        controller.abort(error);
        const resolve = resolveInput;
        resolveInput = null;
        resolve?.({ done: true });
        callback(error);
      },
    });
  }

  throw duplexFromInvalidReturn(result);
}

function duplexFrom(body) {
  if (isDuplexStream(body)) return body;
  if (isNodeStream(body)) {
    if (hasReadableSide(body)) return createDuplexFromSides(body, undefined);
    if (hasWritableSide(body)) return createDuplexFromSides(undefined, body);
    return createDuplexFromSides(undefined, undefined);
  }
  if (isReadableWebStream(body)) return createDuplexFromSides(body, undefined);
  if (isWritableWebStream(body)) return createDuplexFromSides(undefined, body);
  if (typeof body === 'function') return duplexFromFunction(body);
  if (typeof Blob === 'function' && body instanceof Blob) return duplexFrom(body.arrayBuffer());
  if (isIterable(body)) {
    return createDuplexFromSides(readableFromIterable(body), undefined, { writableObjectMode: true });
  }
  if (body && (typeof body.readable === 'object' || typeof body.writable === 'object')) {
    const readable = body.readable ? readableSide(body.readable) : undefined;
    const writable = body.writable ? writableSide(body.writable) : undefined;
    return createDuplexFromSides(readable, writable);
  }
  if (isThenable(body)) {
    const output = readableFromIterable((async function* promiseOutput() {
      const value = await body;
      if (value != null) yield value;
    }()));
    return createDuplexFromSides(output, undefined, { writableObjectMode: true });
  }
  throw streamError(
    'ERR_INVALID_ARG_TYPE',
    `The "body" argument must be of type function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, AsyncIterable, or Promise or { readable, writable } pair. Received ${streamReceivedValue(body)}`,
  );
}

Duplex.from = duplexFrom;

export function duplexPair(options = {}) {
  let first;
  let second;
  const createSide = (getPeer) => new Duplex({
    ...options,
    read() {},
    write(chunk, _encoding, callback) {
      getPeer().push(chunk);
      callback();
    },
    final(callback) {
      getPeer().push(null);
      callback();
    },
  });
  first = createSide(() => second);
  second = createSide(() => first);
  Object.defineProperty(first, '_peer', { configurable: true, value: second });
  Object.defineProperty(second, '_peer', { configurable: true, value: first });
  return [first, second];
}

export class Transform extends Duplex {
  constructor(options = {}) {
    super(options);
    if (typeof options.transform === 'function') this._transform = options.transform;
    if (typeof options.flush === 'function') this._flush = options.flush;
    this.on('prefinish', () => {
      if (this._final !== Transform.prototype._final) Transform.prototype._final.call(this);
    });
  }

  _transform(value, _encoding, done) {
    throw streamError('ERR_METHOD_NOT_IMPLEMENTED', '_transform()');
  }

  _final(callback) {
    if (typeof this._flush === 'function' && !this.destroyed) {
      this._flush.call(this, (error, output) => {
        if (error) {
          callback(error);
          return;
        }
        if (output != null) this.push(output);
        this.push(null);
        callback();
      });
      return;
    }
    this.push(null);
    callback();
  }

  _write(chunk, encoding, callback) {
    const length = this._bufferedBytes;
    try {
      this._transform.call(this, chunk, encoding, (error, output) => {
        if (error) {
          callback(error);
          return;
        }
        if (output != null) this.push(output);
        if (this._ended) {
          queueMicrotask(callback);
        } else if (this._ending
          || length === this._bufferedBytes
          || this._bufferedBytes < this.readableHighWaterMark) {
          callback();
        } else {
          this._transformCallback = callback;
        }
      });
    } catch (error) {
      callback(error);
    }
  }

  _read() {
    if (this._transformCallback) {
      const callback = this._transformCallback;
      this._transformCallback = null;
      callback();
    }
  }
}

for (const property of ['_final', '_write', '_read']) {
  Object.defineProperty(Transform.prototype, property, { enumerable: true });
}

export class PassThrough extends Transform {
  _transform(chunk, _encoding, callback) { callback(null, chunk); }
}

export class OutputLimitError extends Error {
  constructor(stream, limit, actual) {
    super(`output limit exceeded for ${stream}`);
    this.name = 'OutputLimitError';
    this.code = 'ERR_OUTPUT_LIMIT';
    this.stream = stream;
    this.limit = limit;
    this.actual = actual;
  }
}

function outputLimits(options) {
  const limits = options.limits || {};
  const total = limits.total ?? options.totalLimit ?? options.maxOutputBytes ?? options.maxBytes ?? Infinity;
  return {
    total,
    stdout: limits.stdout ?? options.stdoutLimit ?? Infinity,
    stderr: limits.stderr ?? options.stderrLimit ?? Infinity,
  };
}

export class OutputCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.limits = outputLimits(options);
    this.transport = options.transport;
    this.highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this._nextSequence = 0;
    this._totalBytes = 0;
    this._bytes = { stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
    this._records = [];
    const makeStream = (name) => new Writable({
      highWaterMark: this.highWaterMark,
      write: (bytes, _encoding, callback) => this._write(name, bytes, callback),
    });
    this.stdout = makeStream('stdout');
    this.stderr = makeStream('stderr');
  }

  write(stream, chunk, encoding, callback) {
    const target = this._stream(stream);
    return target.write(chunk, encoding, callback);
  }

  bytes(stream) {
    return new Uint8Array(this._bytes[this._streamName(stream)]);
  }

  records() {
    return this._records.map((record) => ({
      stream: record.stream,
      sequence: record.sequence,
      bytes: new Uint8Array(record.bytes),
    }));
  }

  get stdoutBytes() {
    return this.bytes('stdout');
  }

  get stderrBytes() {
    return this.bytes('stderr');
  }

  get combined() {
    return this.records();
  }

  _streamName(stream) {
    if (stream === this.stdout || stream === 'stdout') return 'stdout';
    if (stream === this.stderr || stream === 'stderr') return 'stderr';
    throw new TypeError('output stream must be stdout or stderr');
  }

  _stream(stream) {
    return this._streamName(stream) === 'stdout' ? this.stdout : this.stderr;
  }

  _write(stream, bytes, callback) {
    const streamBytes = this._bytes[stream].byteLength + bytes.byteLength;
    const totalBytes = this._totalBytes + bytes.byteLength;
    const limit = Math.min(this.limits[stream], this.limits.total);
    const actual = this.limits[stream] <= this.limits.total ? streamBytes : totalBytes;
    if (streamBytes > this.limits[stream] || totalBytes > this.limits.total) {
      callback(new OutputLimitError(stream, limit, actual));
      return;
    }
    const record = {
      stream,
      sequence: this._nextSequence++,
      bytes: new Uint8Array(bytes),
    };
    this._records.push(record);
    this._bytes[stream] = appendBytes(this._bytes[stream], bytes);
    this._totalBytes = totalBytes;
    this._send(record, callback);
  }

  _send(record, callback) {
    if (!this.transport) {
      callback();
      return;
    }
    const acknowledge = (error) => callback(error);
    try {
      const write = typeof this.transport === 'function'
        ? this.transport
        : this.transport.write;
      if (typeof write !== 'function') throw new TypeError('output transport must provide write(record, acknowledge)');
      const result = write.call(this.transport, {
        stream: record.stream,
        sequence: record.sequence,
        bytes: new Uint8Array(record.bytes),
      }, acknowledge);
      if (result && typeof result.then === 'function') result.then(() => acknowledge(), acknowledge);
    } catch (error) {
      acknowledge(error);
    }
  }
}

export function createOutputCollector(options = {}) {
  return new OutputCollector(options);
}

export function compose(...stages) {
  if (stages.length === 0) throw streamError('ERR_MISSING_ARGS', 'At least one stream is required');
  for (const stage of stages) {
    if (typeof stage !== 'function' && !isNodeStream(stage) && !isIterable(stage)) {
      throw invalidComposeStage();
    }
  }

  const first = stages[0];
  const last = stages.at(-1);
  const firstWritable = typeof first === 'function' || hasWritableSide(first);
  const firstReadable = typeof first === 'function'
    || hasReadableSide(first) || isIterable(first);
  const lastWritable = typeof last === 'function' || hasWritableSide(last);
  const lastReadable = typeof last === 'function'
    ? likelyReadableFunction(last)
    : hasReadableSide(last) || isIterable(last);

  if (!firstReadable && stages.length > 1) throw invalidComposeStage();
  if (!lastWritable && !lastReadable) throw invalidComposeStage();
  for (let index = 0; index < stages.length - 1; index += 1) {
    const stage = stages[index];
    if (isNodeStream(stage) && !hasReadableSide(stage)) throw invalidComposeStage();
  }
  for (let index = 1; index < stages.length; index += 1) {
    const stage = stages[index];
    if (isNodeStream(stage) && !hasWritableSide(stage)) throw invalidComposeStage();
  }

  const input = new Readable({
    objectMode: firstWritable && (typeof first === 'function'
      ? true
      : writableObjectMode(first)),
    read() {},
  });
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  completion.catch(() => {});

  const output = new Duplex({
    readable: lastReadable,
    writable: firstWritable,
    readableObjectMode: lastReadable && (typeof last === 'function'
      ? true
      : readableObjectMode(last)),
    writableObjectMode: firstWritable && (typeof first === 'function'
      ? true
      : writableObjectMode(first)),
    read() {},
    write(chunk, encoding, callback) {
      try {
        input.push(chunk, encoding);
        callback();
      } catch (error) {
        callback(error);
      }
    },
    final(callback) {
      input.push(null);
      completion.then(() => callback(), callback);
    },
  });

  const stageErrors = [input];
  const onStageError = (error) => rejectCompletion(error);
  input.on('error', onStageError);
  for (const stage of stages) {
    if (isNodeStream(stage)) {
      stage.on('error', onStageError);
      stageErrors.push(stage);
    }
  }

  output._destroyHook = (error, callback) => {
    input.destroy(error);
    for (const stage of stages) if (typeof stage?.destroy === 'function') stage.destroy(error);
    callback(error);
  };

  const run = async () => {
    let current = input;
    let terminal;
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      if (typeof stage === 'function') {
        const returned = stage(current);
        const result = await returned;
        if (returned?.then && stage.constructor?.name === 'AsyncFunction' && result !== undefined) {
          throw invalidComposeReturn(result);
        }
        if (result === undefined || result === null) {
          terminal = true;
          current = null;
        } else if (isNodeStream(result) || isIterable(result)) {
          current = result;
          terminal = false;
        } else {
          throw invalidComposeStage();
        }
      } else if (isNodeStream(stage)) {
        if (index === 0 && !hasWritableSide(stage)) {
          current = stage;
        } else {
          if (!current || !hasWritableSide(stage)) throw invalidComposeStage();
          current = pipeInto(current, stage);
        }
        terminal = !hasReadableSide(stage);
      } else if (index === 0) {
        current = stage;
        terminal = false;
      } else {
        throw invalidComposeStage();
      }

      if (index < stages.length - 1 && (!current || terminal)) throw invalidComposeStage();
    }

    if (current && !terminal && (isNodeStream(current) || isIterable(current))) {
      await consumeInto(output, asReadable(current));
    } else if (terminal && stages.at(-1)?.on) {
      await waitForWritable(stages.at(-1));
    }
  };

  run().then(() => {
    for (const stage of stageErrors) stage.off?.('error', onStageError);
    resolveCompletion();
    if (!lastReadable && !firstWritable) output._emitClose();
  }, (error) => {
    rejectCompletion(error);
    if (!output.destroyed) output.destroy(error);
    queueMicrotask(() => {
      for (const stage of stageErrors) stage.off?.('error', onStageError);
    });
  });

  return output;
}

export const promises = {
  pipeline: (...streams) => new Promise((resolve, reject) => {
    pipeline(...streams, (error) => error ? reject(error) : resolve());
  }),
};

export function pipeline(...streams) {
  const callback = typeof streams.at(-1) === 'function' ? streams.pop() : () => {};
  streams = streams.map((stream) => {
    if (isNodeStream(stream) || typeof stream?.pipe === 'function') return stream;
    if (typeof stream === 'function') return Duplex.from(stream);
    return Readable.from(stream);
  });
  let completed = false;
  let failed = false;
  const finish = (error) => {
    if (completed) return;
    completed = true;
    callback(error);
  };
  for (let index = 0; index < streams.length - 1; index += 1) streams[index].pipe(streams[index + 1]);
  for (const stream of streams) stream.once?.('error', (error) => {
    if (failed) return;
    failed = true;
    for (const other of streams) if (other !== stream) other.destroy?.(error);
    finish(error);
  });
  for (const stream of streams) stream.once?.('close', () => {
    if (completed || stream._endEmitted || stream._finishEmitted) return;
    if (stream.destroyed || stream._readableState?.destroyed || stream._writableState?.destroyed) {
      const error = streamError('ERR_STREAM_PREMATURE_CLOSE', 'Premature close');
      failed = true;
      for (const other of streams) if (other !== stream) other.destroy?.(error);
      finish(error);
    }
  });
  streams.at(-1)?.once?.('finish', () => {
    if (failed) return;
    queueMicrotask(() => {
      if (completed || failed) return;
      const readablePending = streams.some((stream) => (
        stream._readableState
        && stream._readableState.readable !== false
        && !stream._readableState.endEmitted
      ));
      if (!readablePending) {
        finish();
        return;
      }
      const error = streamError('ERR_STREAM_PREMATURE_CLOSE', 'Premature close');
      failed = true;
      for (const stream of streams) stream.destroy?.(error);
      finish(error);
    });
  });
  return streams.at(-1);
}

export function destroy(stream, error) {
  if (!stream || typeof stream.destroy !== 'function' || stream.destroyed) return stream;
  let reason = error;
  const finished = Boolean(
    stream._ended
    || stream._finishEmitted
    || (stream.readable === false && stream.writable === false),
  );
  if (!reason && !finished) {
    reason = new Error('The operation was aborted');
    reason.name = 'AbortError';
    reason.code = 'ABORT_ERR';
  }
  stream.destroy(reason);
  return stream;
}
