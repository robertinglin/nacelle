import { Duplex, Readable, Writable } from './streams.js';

function invalidStream(value, name) {
  const error = new TypeError(`${name} must be a stream`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  error.value = value;
  return error;
}

function newStreamReadableFromReadableStream(readableStream, options = {}) {
  if (!readableStream || typeof readableStream.getReader !== 'function') {
    throw invalidStream(readableStream, 'readableStream');
  }
  const reader = readableStream.getReader();
  let reading = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { reader.releaseLock?.(); } catch { /* the stream may already be closed */ }
  };
  return new Readable({
    ...options,
    read() {
      if (reading || released) return;
      reading = true;
      Promise.resolve(reader.read()).then(({ value, done }) => {
        // push() may immediately request the next chunk in flowing mode.
        reading = false;
        if (done) {
          release();
          this.push(null);
        } else {
          this.push(value);
        }
      }, (error) => {
        reading = false;
        this.destroy(error);
      });
    },
    destroy(error, callback) {
      if (released) {
        callback(error);
        return;
      }
      Promise.resolve(reader.cancel(error)).then(() => {
        release();
        callback(error);
      }, (cancelError) => {
        release();
        callback(error || cancelError);
      });
    },
  });
}

function newReadableStreamFromStreamReadable(streamReadable, ReadableStreamClass, options = {}) {
  if (!streamReadable || typeof streamReadable.on !== 'function') {
    throw invalidStream(streamReadable, 'streamReadable');
  }
  let cleanup = () => {};
  const stream = new ReadableStreamClass({
    start(controller) {
      let ended = false;
      const onData = (chunk) => {
        if (ended) return;
        controller.enqueue(chunk);
        if (controller.desiredSize <= 0) streamReadable.pause?.();
      };
      const onEnd = () => {
        if (ended) return;
        ended = true;
        controller.close();
      };
      const onError = (error) => {
        if (ended) return;
        ended = true;
        controller.error(error);
      };
      const onClose = () => {
        if (!ended && streamReadable.readable === false) onEnd();
      };
      streamReadable.on('data', onData);
      streamReadable.once?.('end', onEnd);
      streamReadable.once?.('error', onError);
      streamReadable.once?.('close', onClose);
      streamReadable.resume?.();
      cleanup = () => {
        streamReadable.off?.('data', onData);
        streamReadable.off?.('end', onEnd);
        streamReadable.off?.('error', onError);
        streamReadable.off?.('close', onClose);
      };
    },
    pull() {
      streamReadable.resume?.();
    },
    cancel(reason) {
      cleanup();
      streamReadable.destroy?.(reason);
    },
  }, options);
  return stream;
}

function newStreamWritableFromWritableStream(writableStream, options = {}) {
  if (!writableStream || typeof writableStream.getWriter !== 'function') {
    throw invalidStream(writableStream, 'writableStream');
  }
  const writer = writableStream.getWriter();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { writer.releaseLock?.(); } catch { /* the stream may already be closed */ }
  };
  return new Writable({
    ...options,
    write(chunk, _encoding, callback) {
      Promise.resolve(writer.write(chunk)).then(() => callback(), callback);
    },
    final(callback) {
      Promise.resolve(writer.close()).then(() => {
        release();
        callback();
      }, (error) => {
        release();
        callback(error);
      });
    },
    destroy(error, callback) {
      if (released) {
        callback(error);
        return;
      }
      Promise.resolve(writer.abort(error)).then(() => {
        release();
        callback(error);
      }, (abortError) => {
        release();
        callback(error || abortError);
      });
    },
  });
}

function newWritableStreamFromStreamWritable(streamWritable, WritableStreamClass, options = {}) {
  if (!streamWritable || typeof streamWritable.write !== 'function') {
    throw invalidStream(streamWritable, 'streamWritable');
  }
  return new WritableStreamClass({
    ...options,
    write(chunk) {
      return new Promise((resolve, reject) => {
        const accepted = streamWritable.write(chunk, (error) => error ? reject(error) : resolve());
        if (!accepted) streamWritable.once?.('drain', resolve);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        streamWritable.once?.('finish', resolve);
        streamWritable.end?.((error) => error ? reject(error) : undefined);
      });
    },
    abort(reason) {
      streamWritable.destroy?.(reason);
    },
  });
}

function newReadableWritablePairFromDuplex(duplex, ReadableStreamClass, WritableStreamClass) {
  if (!duplex || typeof duplex.on !== 'function' || typeof duplex.write !== 'function') {
    throw invalidStream(duplex, 'duplex');
  }
  return {
    readable: newReadableStreamFromStreamReadable(duplex, ReadableStreamClass),
    writable: newWritableStreamFromStreamWritable(duplex, WritableStreamClass),
  };
}

function newStreamDuplexFromReadableWritablePair(pair, options = {}) {
  if (!pair || typeof pair !== 'object') throw invalidStream(pair, 'pair');
  const reader = pair.readable?.getReader?.();
  const writer = pair.writable?.getWriter?.();
  if (!reader || !writer) throw invalidStream(pair, 'pair');
  let reading = false;
  return new Duplex({
    ...options,
    read() {
      if (reading) return;
      reading = true;
      Promise.resolve(reader.read()).then(({ value, done }) => {
        if (done) this.push(null);
        else this.push(value);
      }, (error) => this.destroy(error)).finally(() => {
        reading = false;
      });
    },
    write(chunk, _encoding, callback) {
      Promise.resolve(writer.write(chunk)).then(() => callback(), callback);
    },
    final(callback) {
      Promise.resolve(writer.close()).then(() => callback(), callback);
    },
    destroy(error, callback) {
      Promise.allSettled([reader.cancel(error), writer.abort(error)]).then(() => callback(error));
    },
  });
}

export function createStreamAdapters({ ReadableStream, WritableStream }) {
  return {
    newStreamReadableFromReadableStream,
    newReadableStreamFromStreamReadable: (stream, options) => (
      newReadableStreamFromStreamReadable(stream, ReadableStream, options)
    ),
    newStreamWritableFromWritableStream,
    newWritableStreamFromStreamWritable: (stream, options) => (
      newWritableStreamFromStreamWritable(stream, WritableStream, options)
    ),
    newReadableWritablePairFromDuplex: (stream) => (
      newReadableWritablePairFromDuplex(stream, ReadableStream, WritableStream)
    ),
    newStreamDuplexFromReadableWritablePair,
  };
}
