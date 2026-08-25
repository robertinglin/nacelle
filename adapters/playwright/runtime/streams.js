import { EventEmitter } from './events.js';

const DEFAULT_HIGH_WATER_MARK = 16 * 1024;

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

function toBytes(value) {
  if (value instanceof StreamChunk) return value;
  if (value instanceof Uint8Array) return streamChunk(value);
  if (typeof value === 'string') return streamChunk(new TextEncoder().encode(value));
  if (value instanceof ArrayBuffer) return streamChunk(new Uint8Array(value.slice(0)));
  if (ArrayBuffer.isView(value)) {
    return streamChunk(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
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
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

const COMBINATOR_EMPTY = Symbol('stream-combinator-empty');
const COMBINATOR_EOF = Symbol('stream-combinator-eof');

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
    this.readableHighWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this._buffer = [];
    this._bufferedBytes = 0;
    this._ended = false;
    this._endEmitted = false;
    this._destroyed = false;
    this._closeEmitted = false;
    this._error = null;
    this._read = options.read || (() => {});
    this._preserveStrings = Boolean(options.preserveStrings);
    this._decoder = null;
    this._flowing = false;
    this._readableState = { pipes: [], flowing: false };
    this._reading = false;
    this._pipes = new Map();
    this._sourceWaiter = null;
    this.destroyed = false;
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

  push(chunk) {
    if (this._destroyed || this._ended) return false;
    if (chunk === null) {
      if (this._decoder) {
        const trailing = this._decoder.decode();
        this._decoder = null;
        if (trailing) this.push(trailing);
      }
      this._ended = true;
      this._resolvePending?.();
      this._scheduleReadable();
      if (!this.listenerCount('readable')) this._maybeEmitEnd();
      return false;
    }
    if (this.readableObjectMode) {
      if (this._flowing) this.emit('data', chunk);
      else {
        this._buffer.push(chunk);
        this._bufferedBytes += 1;
      }
      this._scheduleReadable();
      this._resolveSourceWaiter();
      this._resolvePending?.();
      return this._bufferedBytes < this.readableHighWaterMark;
    }
    if (this._decoder && typeof chunk !== 'string') {
      const bytes = toBytes(chunk);
      chunk = this._decoder.decode(bytes, { stream: true });
    }
    if (typeof chunk === 'string' && this._preserveStrings) {
      if (this._flowing) this.emit('data', chunk);
      else {
        this._buffer.push(chunk);
        this._bufferedBytes += chunk.length;
      }
      this._scheduleReadable();
      this._resolveSourceWaiter();
      this._resolvePending?.();
      return this._bufferedBytes < this.readableHighWaterMark;
    }
    const bytes = toBytes(chunk);
    if (this._flowing) this.emit('data', bytes);
    else {
      this._buffer.push(bytes);
      this._bufferedBytes += bytes.byteLength;
    }
    this._scheduleReadable();
    this._resolveSourceWaiter();
    this._resolvePending?.();
    return this._bufferedBytes < this.readableHighWaterMark;
  }

  setEncoding(encoding = 'utf8') {
    const normalized = encoding === 'utf8' ? 'utf-8' : encoding;
    this._decoder = new TextDecoder(normalized);
    this._preserveStrings = true;
    return this;
  }

  read() {
    const chunk = this._buffer.length ? this._buffer.shift() : null;
    if (chunk !== null) this._bufferedBytes -= this.readableObjectMode
      ? 1
      : typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    if (chunk === null && !this._ended && !this._destroyed) this._readOnce();
    this._resolveSourceWaiter();
    return chunk;
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
      const result = this._read();
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

  resume() {
    if (this._destroyed) return this;
    this._flowing = true;
    this._readableState.flowing = true;
    while (this._buffer.length) this.emit('data', this.read());
    this._maybeEmitEnd();
    this._readOnce();
    return this;
  }

  pause() {
    this._flowing = false;
    this._readableState.flowing = false;
    return this;
  }

  pipe(destination) {
    const onData = (chunk) => {
      if (!destination.write(chunk)) this.pause();
    };
    const onEnd = () => destination.end();
    const onDrain = () => this.resume();
    const onUnpipe = (source) => {
      if (source === this) this.unpipe(destination);
    };
    this._pipes.set(destination, { onData, onEnd, onDrain, onUnpipe });
    this._readableState.pipes.push(destination);
    this.on('data', onData);
    this.on('end', onEnd);
    destination.on?.('drain', onDrain);
    destination.on?.('unpipe', onUnpipe);
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
        this._pipes.delete(destination);
        const index = this._readableState.pipes.indexOf(destination);
        if (index !== -1) this._readableState.pipes.splice(index, 1);
        destination.emit?.('unpipe', this);
      }
    } else {
      for (const target of this._pipes.keys()) this.unpipe(target);
    }
    return this;
  }

  destroy(error) {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.destroyed = true;
    this.readable = false;
    this._buffer.length = 0;
    this._bufferedBytes = 0;
    this._error = error || null;
    this._resolveSourceWaiter();
    this._resolvePending?.();
    const iterator = this._sourceIterator;
    this._sourceIterator = null;
    if (iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
    queueMicrotask(() => {
      if (error && !this._errorEmitted) {
        this._errorEmitted = true;
        this.emit('error', error);
      }
      this._emitClose();
    });
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
      this.readable = false;
      this.emit('end');
    }
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
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
    this.writableHighWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this._write = options.write || ((_chunk, _encoding, callback) => callback());
    this._final = options.final;
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
    this._endCallback = null;
    this._endCallbackCalled = false;
  }

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
          if (!this._errorEmitted) {
            this._errorEmitted = true;
            this.emit('error', error);
          }
        }
      } else {
        this._rejectWrite(error, callback);
      }
      return false;
    }
    if (this._destroyed) {
      const error = streamError('ERR_STREAM_DESTROYED', 'write after destroy');
      this._rejectWrite(error, callback);
      return false;
    }
    if (chunk === null) throw streamError('ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
    let bytes;
    let size;
    if (this.writableObjectMode) {
      bytes = chunk;
      size = 1;
    } else {
      try {
        bytes = toBytes(chunk);
      } catch (error) {
        error.code ||= 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      size = bytes.byteLength;
    }
    const request = { bytes, size, encoding, callback, settled: false };
    this._queue.push(request);
    this._pendingBytes += size;
    this.writableLength = this._pendingBytes;
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
    if (this._ending || this._ended || this._destroyed) {
      const error = this._destroyed
        ? streamError('ERR_STREAM_DESTROYED', 'end after destroy')
        : streamError('ERR_STREAM_ALREADY_FINISHED', 'end called more than once');
      try {
        callback(error);
      } finally {
        if (!this._destroyed) this.destroy(error);
      }
      return this;
    }
    if (chunk !== undefined) this.write(chunk, encoding);
    this._ending = true;
    this.writableEnded = true;
    this._endCallback = callback;
    this._finishIfReady();
    return this;
  }

  destroy(error) {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.destroyed = true;
    this.writable = false;
    const reason = error || streamError('ERR_STREAM_DESTROYED', 'stream destroyed');
    const pending = this._queue.splice(0);
    if (this._current && !this._current.settled) pending.unshift(this._current);
    this._current = null;
    this._pendingBytes = 0;
    this.writableLength = 0;
    for (const request of pending) this._complete(request, reason, false);
    if (this._ending && !this._endCallbackCalled) {
      this._endCallbackCalled = true;
      this._endCallback?.(reason);
    }
    queueMicrotask(() => {
      if (error && !this._errorEmitted) {
        this._errorEmitted = true;
        this.emit('error', error);
      }
      this._emitClose();
    });
    return this;
  }

  _processNext() {
    if (this._destroyed || this._current || !this._queue.length) {
      this._finishIfReady();
      return;
    }
    const request = this._queue.shift();
    this._current = request;
    const done = (error) => {
      if (request.settled) {
        const duplicate = streamError('ERR_MULTIPLE_CALLBACK', 'Callback called multiple times');
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
      this._write.call(this._owner || this, request.bytes, request.encoding, done);
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
    if (continueProcessing) this._processNext();
  }

  _rejectWrite(error, callback) {
    try {
      callback(error);
    } finally {
      if (!this._destroyed) this.destroy(error);
      else if (!this._errorEmitted) {
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
        this._final.call(this._owner || this, done);
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
    this._finishScheduled = true;
    this.emit('prefinish');
    queueMicrotask(() => {
      this._finishScheduled = false;
      if (this._finishEmitted || this._destroyed) return;
      this._finishEmitted = true;
      this.writableFinished = true;
      this._ended = true;
      this.emit('finish');
      if (!this._endCallbackCalled) {
        this._endCallbackCalled = true;
        this._endCallback?.();
      }
      queueMicrotask(() => this._emitClose());
    });
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit('close');
  }
}

export function Writable(options = {}) {
  if (new.target) return Reflect.construct(WritableImpl, [options], new.target);
  const initialized = new WritableImpl(options);
  Object.assign(this, initialized);
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

export class Duplex extends Readable {
  constructor(options = {}) {
    super(options);
    this._writable = new Writable(options);
    this._writable._owner = this;
    this.writable = true;
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
