import { EventEmitter } from './events.js';
import { resolveEncodingOps } from './buffer.js';

const DEFAULT_HIGH_WATER_MARK = 16 * 1024;
let defaultHighWaterMark = DEFAULT_HIGH_WATER_MARK;
let defaultObjectHighWaterMark = 16;

export function setDefaultHighWaterMark(objectMode, value) {
  if (typeof objectMode !== 'boolean') throw streamError('ERR_INVALID_ARG_TYPE', 'The "objectMode" argument must be of type boolean');
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw streamError('ERR_OUT_OF_RANGE', 'The "value" argument is out of range');
  }
  if (objectMode) defaultObjectHighWaterMark = value;
  else defaultHighWaterMark = value;
}

export function getDefaultHighWaterMark(objectMode) {
  if (typeof objectMode !== 'boolean') throw streamError('ERR_INVALID_ARG_TYPE', 'The "objectMode" argument must be of type boolean');
  return objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark;
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

function toBytes(value) {
  if (value instanceof StreamChunk) return bufferChunk(value);
  if (value.constructor?.isBuffer?.(value)) return value;
  if (value instanceof Uint8Array) return bufferChunk(value);
  if (typeof value === 'string') {
    const BufferClass = globalThis.Buffer;
    return typeof BufferClass?.from === 'function'
      ? BufferClass.from(value)
      : streamChunk(new TextEncoder().encode(value));
  }
  if (value instanceof ArrayBuffer) return bufferChunk(new Uint8Array(value.slice(0)));
  if (ArrayBuffer.isView(value)) {
    return bufferChunk(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  }
  throw new TypeError('stream chunks must be strings or Uint8Array values');
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
  const error = new Error(message);
  error.code = code;
  return error;
}

const COMBINATOR_EMPTY = Symbol('stream-combinator-empty');
const COMBINATOR_EOF = Symbol('stream-combinator-eof');

const legacyStreamState = new WeakMap();

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
}

Stream.prototype.on = function on(name, listener) {
  const listeners = legacyState(this).listeners.get(name) || new Set();
  listeners.add(listener);
  legacyState(this).listeners.set(name, listeners);
  return this;
};
Stream.prototype.addListener = Stream.prototype.on;
Stream.prototype.once = function once(name, listener) {
  const wrapped = (...args) => {
    this.removeListener(name, wrapped);
    listener.apply(this, args);
  };
  return this.on(name, wrapped);
};
Stream.prototype.removeListener = function removeListener(name, listener) {
  legacyState(this).listeners.get(name)?.delete(listener);
  return this;
};
Stream.prototype.off = Stream.prototype.removeListener;
Stream.prototype.listenerCount = function listenerCount(name) {
  return legacyState(this).listeners.get(name)?.size || 0;
};
Stream.prototype.listeners = function listeners(name) {
  return [...(legacyState(this).listeners.get(name) || [])];
};
Stream.prototype.removeAllListeners = function removeAllListeners(name = undefined) {
  const state = legacyState(this);
  if (name === undefined) state.listeners.clear();
  else state.listeners.delete(name);
  return this;
};
Stream.prototype.emit = function emit(name, ...args) {
  const listeners = legacyState(this).listeners.get(name);
  if (!listeners) return false;
  const snapshot = [...listeners];
  for (let index = 0; index < snapshot.length; index += 1) snapshot[index].apply(this, args);
  return listeners.size > 0;
};
Stream.prototype.pipe = function pipe(destination) {
  this.on('data', (chunk) => {
    if (!destination.write(chunk)) this.pause?.();
  });
  this.on('end', () => destination.end?.());
  destination.on?.('drain', () => this.resume?.());
  this.resume?.();
  return destination;
};

function validateCombinatorOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object') {
    throw streamError('ERR_INVALID_ARG_TYPE', 'options must be an object');
  }
  if (options.signal !== undefined && (options.signal === null
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
  if (signal.aborted) throw abortError(signal);
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
    this.readable = true;
    this.readableObjectMode = Boolean(options.readableObjectMode ?? options.objectMode);
    this.readableHighWaterMark = options.highWaterMark
      ?? (this.readableObjectMode ? defaultObjectHighWaterMark : defaultHighWaterMark);
    this._buffer = [];
    this._bufferedBytes = 0;
    this._ended = false;
    this._endEmitted = false;
    this._destroyed = false;
    this._closeEmitted = false;
    this._error = null;
    const inheritedRead = this._read;
    const inheritedDestroy = this._destroy;
    this._read = options.read || (typeof inheritedRead === 'function' ? inheritedRead : () => {});
    this._destroyHook = options.destroy || inheritedDestroy;
    this._preserveStrings = Boolean(options.preserveStrings);
    this._decoder = null;
    if (options.encoding) this.setEncoding(options.encoding);
    this._flowing = false;
    this._readableState = {
      readable: true, destroyed: false, errored: null,
      pipes: [], flowing: false, reading: false, ended: false, endEmitted: false,
      readableListening: false, needReadable: false, emittedReadable: false, readingMore: false,
      objectMode: this.readableObjectMode,
      autoDestroy: options.autoDestroy !== false, emitClose: options.emitClose !== false,
      closed: false, errorEmitted: false,
    };
    if (options.readable === false) {
      this.readable = false;
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
    this._readableDidRead = false;
    this._pipes = new Map();
    this._blockedPipes = new Set();
    this._sourceWaiter = null;
    this.destroyed = false;
    const autoDestroyOnError = (error) => {
      if (this._readableState.autoDestroy && !this._destroyed) this.destroy(error);
    };
    autoDestroyOnError._bnhInternal = true;
    this.on('error', autoDestroyOnError);
  }

  on(name, listener) {
    super.on(name, listener);
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

  static from(source, options = {}) {
    const readable = new Readable({ objectMode: true, highWaterMark: options.highWaterMark ?? 1, ...options });
    (async () => {
      const iterator = source?.[Symbol.asyncIterator]?.() || source?.[Symbol.iterator]?.();
      readable._sourceIterator = iterator;
      try {
        while (true) {
          const step = await iterator.next();
          if (step.done) break;
          readable.push(step.value);
          if (!readable._flowing && readable._bufferedBytes >= readable.readableHighWaterMark) {
            await new Promise((resolve) => { readable._sourceWaiter = resolve; });
          }
        }
        readable.push(null);
      } catch (error) {
        readable.destroy(error);
      } finally {
        if (readable._sourceIterator === iterator) readable._sourceIterator = null;
      }
    })();
    return readable;
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
    if (this._flowing) this._scheduleFlowDrain();
    this._scheduleReadable();
    this._resolveSourceWaiter();
    this._resolvePending?.();
    this._scheduleFlowRead();
    return this._bufferedBytes < this.readableHighWaterMark;
  }

  setEncoding(encoding = 'utf8') {
    this._encoding = `${encoding}`.toLowerCase();
    const ops = resolveEncodingOps(encoding);
    if (ops) this._decoder = { decode: (bytes) => bytes === undefined ? '' : ops.decode(bytes) };
    else {
      const normalized = encoding === 'utf8' ? 'utf-8' : encoding;
      this._decoder = new TextDecoder(normalized);
    }
    this._preserveStrings = true;
    return this;
  }

  read(size = undefined) {
    if (!this._buffer.length) {
      if (!this._ended && !this._destroyed) this._readOnce();
      return null;
    }
    const chunks = size === undefined && !this.readableObjectMode
      ? this._buffer.splice(0)
      : [this._buffer.shift()];
    let chunk = chunks.length === 1
      ? chunks[0]
      : typeof chunks[0] === 'string'
        ? chunks.join('')
        : toBytes(chunks.reduce((all, next) => appendBytes(all, toBytes(next)), new Uint8Array()));
    if (chunk !== null) {
      this._readableDidRead = true;
      this._bufferedBytes -= chunks.reduce(
        (total, value) => total + (this.readableObjectMode ? 1 : typeof value === 'string' ? value.length : value.byteLength),
        0,
      );
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
    let pending = false;
    try {
      const result = this._read(this.readableHighWaterMark);
      if (result?.then) {
        pending = true;
        result.then(
          () => { this._reading = false; },
          (error) => { this._reading = false; this.destroy(error); },
        );
        return;
      }
    } catch (error) {
      this.destroy(error);
    } finally {
      if (!pending) this._reading = false;
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
        this._readableDispatching = true;
        try {
          this.emit('readable');
          this._maybeEmitEnd();
        } finally {
          this._readableDispatching = false;
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
      if (!this._flowing || this._destroyed) return;
      while (this._flowing && this._buffer.length) {
        this._readableDidRead = true;
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
    if (this._resumeScheduled) return this;
    this._resumeScheduled = true;
    queueMicrotask(() => {
      this._resumeScheduled = false;
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
    return !this._flowing;
  }

  get readableAborted() { return this._destroyed && !this._endEmitted; }
  get readableDidRead() { return this._readableDidRead; }
  get readableListening() { return this.listenerCount('readable') > 0; }

  pause() {
    const wasFlowing = this._flowing;
    this._flowing = false;
    this._readableState.flowing = false;
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
    this.destroyed = true;
    this.readable = false;
    this._readableState.destroyed = true;
    this._readableState.errored = error || null;
    this._buffer.length = 0;
    this._bufferedBytes = 0;
    this._error = error || null;
    this._resolveSourceWaiter();
    this._resolvePending?.();
    const iterator = this._sourceIterator;
    this._sourceIterator = null;
    if (iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
    const finalize = (destroyError = error) => {
      const finalError = destroyError || error;
      if (finalError && !this._errorEmitted) {
        this._errorEmitted = true;
        this._readableState.errorEmitted = true;
        this.emit('error', finalError);
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
        else if (this._readableState.autoDestroy) this.destroy();
        else this._emitClose();
      });
    }
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._readableState.closed = true;
    this.emit('close');
  }

  async *[Symbol.asyncIterator]() {
    const onError = (error) => {
      this._error = error;
      this._resolvePending?.();
    };
    this.on('error', onError);
    try {
      while (true) {
        if (this._buffer.length) {
          yield this.read();
          continue;
        }
        if (this._error) throw this._error;
        if (this._ended || this._destroyed) return;
        this._readOnce();
        if (this._buffer.length || this._error || this._ended || this._destroyed) continue;
        await new Promise((resolve) => { this._resolvePending = resolve; });
        this._resolvePending = null;
      }
    } finally {
      this.off('error', onError);
      if (!this._ended && !this._destroyed) this.destroy(this._error);
    }
  }

  map(fn, options) {
    return Readable.from(mapValues(this, fn, options), { objectMode: true });
  }

  filter(fn, options) {
    if (typeof fn !== 'function') throw streamError('ERR_INVALID_ARG_TYPE', 'fn must be a function');
    return Readable.from(mapValues(this, async (value, context) => (
      await fn(value, context) ? value : COMBINATOR_EMPTY
    ), options), { objectMode: true });
  }

  flatMap(fn, options) {
    const mapped = mapValues(this, fn, options);
    return Readable.from((async function* flatMap() {
      for await (const value of mapped) yield* value;
    })(), { objectMode: true });
  }

  async toArray() {
    const result = [];
    for await (const value of this) result.push(value);
    return result;
  }
}

class WritableImpl extends EventEmitter {
  constructor(options = {}) {
    super();
    this.writable = true;
    // Browser output is never a terminal. Pseudo-TTY behavior is intentionally
    // not emulated because the browser has no safe terminal primitive.
    this.isTTY = false;
    this.writableObjectMode = Boolean(options.writableObjectMode ?? options.objectMode);
    this.decodeStrings = options.decodeStrings !== false;
    this.writableHighWaterMark = options.highWaterMark
      ?? (this.writableObjectMode ? defaultObjectHighWaterMark : defaultHighWaterMark);
    const inheritedWrite = this._write;
    const inheritedDestroy = this._destroy;
    const inheritedFinal = this._final;
    this._write = options.write || (typeof inheritedWrite === 'function'
      ? inheritedWrite
      : (_chunk, _encoding, callback) => callback());
    this._writev = options.writev || this._writev;
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
    this.destroyed = false;
    this.writableLength = 0;
    this.writableEnded = false;
    this.writableFinished = false;
    this._endCallbacks = [];
    this._endCallbackCalled = false;
    this._corked = 0;
    this._writableState = {
      writable: true,
      destroyed: false,
      errored: null,
      ended: false,
      finished: false,
      length: 0,
      objectMode: this.writableObjectMode,
      highWaterMark: this.writableHighWaterMark,
      autoDestroy: options.autoDestroy !== false, emitClose: options.emitClose !== false,
      closed: false, errorEmitted: false,
    };
    if (options.writable === false) {
      this.writable = false;
      this._ending = true;
      this._ended = true;
      this.writableEnded = true;
      this.writableFinished = true;
      this._writableState.writable = false;
      this._writableState.ended = true;
      this._writableState.finished = true;
    }
    const autoDestroyOnError = (error) => {
      if (this._writableState.autoDestroy && !this._destroyed) this.destroy(error);
    };
    autoDestroyOnError._bnhInternal = true;
    this.on('error', autoDestroyOnError);
  }

  get writableAborted() { return this._destroyed && !this._finishEmitted; }
  get writableNeedDrain() { return this._needDrain; }
  get writableCorked() { return this._corked; }

  write(chunk, encoding = 'utf8', callback = () => {}) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
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
            this._errorEmitted = true;
            this._writableState.errorEmitted = true;
            this.emit('error', error);
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
        if (typeof chunk === 'string' && !this.decodeStrings) {
          bytes = chunk;
          size = chunk.length;
        } else {
          bytes = toBytes(chunk);
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
    this.writableLength = this._pendingBytes;
    this._writableState.length = this.writableLength;
    if (this._pendingBytes >= this.writableHighWaterMark) this._needDrain = true;
    this._processNext();
    return !this._destroyed && this._pendingBytes < this.writableHighWaterMark;
  }

  end(chunk, encoding = 'utf8', callback = () => {}) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
      encoding = 'utf8';
    }
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
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
    this.writableEnded = true;
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
    this.writableLength = 0;
    this._writableState.length = 0;
    for (const request of pending) this._complete(request, reason, false);
    if (this._ending && !this._endCallbackCalled) {
      this._endCallbackCalled = true;
      for (const callback of this._endCallbacks) callback(reason);
    }
    const finalize = (destroyError = error) => {
      const finalError = destroyError || error;
      if (finalError && !this._errorEmitted) {
        this._errorEmitted = true;
        this._writableState.errorEmitted = true;
        this.emit('error', finalError);
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
        if (requests.some((item) => item.settled)) {
          const duplicate = streamError('ERR_MULTIPLE_CALLBACK', 'Callback called multiple times');
          if (!this._destroyed) this.destroy(duplicate);
          return;
        }
        for (const item of requests) item.settled = true;
        this._current = null;
        this._pendingBytes = Math.max(0, this._pendingBytes - requests.reduce((total, item) => total + item.size, 0));
        this.writableLength = this._pendingBytes;
        this._writableState.length = this.writableLength;
        if (error) {
          for (const item of requests) item.callback(error);
          if (!this._destroyed) this.destroy(error);
          return;
        }
        for (const item of requests) item.callback();
        if (this._needDrain && this._pendingBytes < this.writableHighWaterMark) {
          this._needDrain = false;
          this.emit('drain');
        }
        queueMicrotask(() => this._processNext());
      };
      try {
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
      write.call(this._owner || this, request.bytes, request.encoding, done);
    } catch (error) {
      if (!request.settled) done(error);
      else throw error;
    }
  }

  _complete(request, error, continueProcessing = true) {
    if (request.settled) return;
    request.settled = true;
    if (this._current === request) this._current = null;
    this._pendingBytes = Math.max(0, this._pendingBytes - request.size);
    this.writableLength = this._pendingBytes;
    this._writableState.length = this.writableLength;
    if (error) {
      try {
        request.callback(error);
      } finally {
        if (!this._destroyed) this.destroy(error);
      }
      return;
    }
    request.callback();
    if (this._needDrain && this._pendingBytes < this.writableHighWaterMark) {
      this._needDrain = false;
      this.emit('drain');
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
        this.emit('error', error);
      }
    }
  }

  _finishIfReady() {
    if (!this._ending || this._current || this._queue.length || this._finishEmitted || this._destroyed) return;
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
    this._writableState.ended = true;
    this._finishScheduled = true;
    this.emit('prefinish');
    queueMicrotask(() => {
      this._finishScheduled = false;
      if (this._finishEmitted || this._destroyed) return;
      this._finishEmitted = true;
      this.writableFinished = true;
      this._ended = true;
      this._writableState.finished = true;
      if (!this._endCallbackCalled) {
        this._endCallbackCalled = true;
        for (const callback of this._endCallbacks) callback(null);
      }
      this.emit('finish');
      queueMicrotask(() => {
        if (this._destroyed) this._emitClose();
        else this.destroy();
      });
    });
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._writableState.closed = true;
    this.emit('close');
  }
}

export function Writable(options = {}) {
  if (new.target) return Reflect.construct(WritableImpl, [options], new.target);
  const initialized = new WritableImpl(options);
  if (this === undefined || this === null) return initialized;
  Object.assign(this, initialized);
  return this;
}

Writable.prototype = WritableImpl.prototype;

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
    const inheritedWrite = this._write;
    const inheritedFinal = this._final;
    const inheritedDestroy = this._destroyHook;
    this._write = options.write || inheritedWrite;
    this._final = options.final || inheritedFinal;
    this._destroyHook = options.destroy || inheritedDestroy;
    // The writable side owns queueing and finish emission, but the public
    // Duplex subclass owns the _final hook. Keep the hook on the inner side
    // so end() waits for an async subclass finalizer before finishing.
    this._writable._final = this._final;
    this.allowHalfOpen = options.allowHalfOpen !== false;
    this.writable = this._writable.writable;
    this.writableHighWaterMark = this._writable.writableHighWaterMark;
    this.writableLength = 0;
    this._writable.on('drain', () => this.emit('drain'));
    this._writable.on('finish', () => {
      this.writable = false;
      this.emit('finish');
    });
    this._writable.on('error', (error) => this.destroy(error));
    this._writable.on('close', () => queueMicrotask(() => {
      // Ending the writable side of a duplex stream is not the same as
      // closing the socket; the readable peer may still have responses.
      if (this._destroyed || !this.readable) this._emitClose();
    }));
  }

  write(...args) {
    const result = this._writable.write(...args);
    this.writableLength = this._writable.writableLength;
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
}

export function Duplex(options = {}) {
  if (new.target) return Reflect.construct(DuplexImpl, [options], new.target);
  return new DuplexImpl(options);
}

Duplex.prototype = DuplexImpl.prototype;
Object.setPrototypeOf(Duplex, DuplexImpl);

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
  return [first, second];
}

export class Transform extends Duplex {
  constructor(options = {}) {
    const transform = options.transform || ((value, _encoding, done) => done(null, value));
    const flush = options.flush;
    super({
      ...options,
      write(chunk, encoding, callback) {
        try {
          transform.call(this, chunk, encoding, (error, output) => {
            if (!error && output !== undefined && output !== null) this.push(output);
            callback(error);
          });
        } catch (error) {
          callback(error);
        }
      },
      final(callback) {
        if (!flush) {
          callback();
          return;
        }
        flush.call(this, (error, output) => {
          if (!error && output !== undefined && output !== null) this.push(output);
          callback(error);
        });
      },
    });
    this._writable.once('finish', () => this.push(null));
  }
}

export class PassThrough extends Transform {
  constructor(options = {}) {
    super({
      ...options,
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
    });
  }
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

export function pipeline(...streams) {
  const callback = typeof streams.at(-1) === 'function' ? streams.pop() : () => {};
  streams = streams.map((stream) => typeof stream?.pipe === 'function' ? stream : Readable.from(stream));
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
  streams.at(-1)?.once?.('finish', () => {
    if (!failed) finish();
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
