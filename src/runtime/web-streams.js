function requireConstructor(scope, name) {
  if (typeof scope[name] !== 'function') throw new TypeError(`${name} is unavailable in this browser context`);
  return scope[name];
}

function getIterator(value) {
  if (value?.[Symbol.asyncIterator]) return value[Symbol.asyncIterator]();
  if (value?.[Symbol.iterator]) return value[Symbol.iterator]();
  throw new TypeError('value is not iterable');
}

/** Turn an iterable into a pull-driven stream; the browser controls backpressure. */
export function readableStreamFrom(iterable, { scope = globalThis, ...options } = {}) {
  const ReadableStream = requireConstructor(scope, 'ReadableStream');
  const iterator = getIterator(iterable);
  let finished = false;
  return new ReadableStream({
    async pull(controller) {
      if (finished) return;
      const result = await iterator.next();
      if (result.done) {
        finished = true;
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
    async cancel(reason) {
      finished = true;
      if (typeof iterator.return === 'function') await iterator.return(reason);
    },
  }, options);
}

/** Wrap a sink in a WritableStream so every awaited write participates in backpressure. */
export function writableStreamFrom(sink, { scope = globalThis, ...options } = {}) {
  const WritableStream = requireConstructor(scope, 'WritableStream');
  if (!sink || typeof sink.write !== 'function') throw new TypeError('sink.write must be a function');
  return new WritableStream({
    write: (chunk) => sink.write(chunk),
    close: () => (typeof sink.close === 'function' ? sink.close() : undefined),
    abort: (reason) => (typeof sink.abort === 'function' ? sink.abort(reason) : undefined),
  }, options);
}

export function transformStream(transformer = {}, { scope = globalThis, ...options } = {}) {
  const TransformStream = requireConstructor(scope, 'TransformStream');
  return new TransformStream(transformer, options.writableStrategy, options.readableStrategy);
}

/** Consume a browser ReadableStream without buffering it in a second queue. */
export async function* streamAsAsyncIterable(stream) {
  if (!stream || typeof stream.getReader !== 'function') throw new TypeError('a ReadableStream is required');
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed) await reader.cancel();
    reader.releaseLock();
  }
}

export async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of streamAsAsyncIterable(stream)) chunks.push(chunk);
  return chunks;
}

export function pipeStreams(readable, writable, options = {}) {
  if (typeof readable?.pipeTo !== 'function') throw new TypeError('readable must be a ReadableStream');
  if (typeof writable?.getWriter !== 'function') throw new TypeError('writable must be a WritableStream');
  return readable.pipeTo(writable, options);
}

export function createStreamPrimitives(scope = globalThis) {
  return {
    ReadableStream: scope.ReadableStream,
    WritableStream: scope.WritableStream,
    TransformStream: scope.TransformStream,
    ByteLengthQueuingStrategy: scope.ByteLengthQueuingStrategy,
    CountQueuingStrategy: scope.CountQueuingStrategy,
    readableStreamFrom: (iterable, options) => readableStreamFrom(iterable, { scope, ...options }),
    writableStreamFrom: (sink, options) => writableStreamFrom(sink, { scope, ...options }),
    transformStream: (transformer, options) => transformStream(transformer, { scope, ...options }),
    streamAsAsyncIterable,
    collectStream,
    pipeStreams,
  };
}
