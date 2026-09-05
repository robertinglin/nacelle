import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamAdapters } from '../../../../src/runtime/stream-adapters.js';

const adapters = createStreamAdapters({ ReadableStream, WritableStream });

test('readable adapters finish without cancelling a released reader', { timeout: 2000 }, async () => {
  let cancelled = false;
  const web = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('page'));
      controller.close();
    },
    cancel() { cancelled = true; },
  });
  const stream = adapters.newStreamReadableFromReadableStream(web);
  const errors = [];
  const chunks = [];
  stream.on('error', (error) => errors.push(error));
  stream.on('data', (chunk) => chunks.push(new TextDecoder().decode(chunk)));
  const closed = new Promise((resolve) => stream.once('close', resolve));
  stream.resume();
  await closed;
  assert.deepEqual(chunks, ['page']);
  assert.deepEqual(errors, []);
  assert.equal(cancelled, false);
  assert.equal(web.locked, false);
});

test('writable adapters finish without aborting a released writer', { timeout: 2000 }, async () => {
  let aborted = false;
  const chunks = [];
  const web = new WritableStream({
    write(chunk) { chunks.push(new TextDecoder().decode(chunk)); },
    abort() { aborted = true; },
  });
  const stream = adapters.newStreamWritableFromWritableStream(web, { autoDestroy: true });
  const errors = [];
  stream.on('error', (error) => errors.push(error));
  const closed = new Promise((resolve) => stream.once('close', resolve));
  stream.end('page');
  await closed;
  assert.deepEqual(chunks, ['page']);
  assert.deepEqual(errors, []);
  assert.equal(aborted, false);
  assert.equal(web.locked, false);
});

test('destroying unfinished adapters cancels their Web Streams with the original error', { timeout: 2000 }, async () => {
  for (const writable of [false, true]) {
    const reason = new Error('cancelled by caller');
    let received;
    const web = writable
      ? new WritableStream({ abort(error) { received = error; } })
      : new ReadableStream({ cancel(error) { received = error; } });
    const stream = writable
      ? adapters.newStreamWritableFromWritableStream(web)
      : adapters.newStreamReadableFromReadableStream(web);
    const errors = [];
    stream.on('error', (error) => errors.push(error));
    const closed = new Promise((resolve) => stream.once('close', resolve));
    stream.destroy(reason);
    await closed;
    assert.equal(received, reason);
    assert.deepEqual(errors, [reason]);
    assert.equal(web.locked, false);
  }
});
