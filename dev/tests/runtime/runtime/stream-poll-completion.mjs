import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from '../../../../src/runtime/streams.js';

const HostPromise = Promise;
const hostSetTimeout = globalThis.setTimeout.bind(globalThis);

// Next.js's App Router render loop polls the flight stream exactly like
// this (next/dist/compiled/next-server/app-page.runtime.dev.js): it awaits
// a promise woken by 'readable'/'end', removes all three wait listeners in
// its cleanup, reads one chunk, and exits only when readableEnded turns
// true. A stream that is ended-with-empty-buffer must still surface 'end'
// to this consumer — deferring because only a 'readable' listener happens
// to be attached traps the loop in a microtask spin that starves timers.
async function nextStylePoll(stream, maxReads = 8) {
  let reads = 0;
  let chunks = 0;
  while (!stream.readableEnded) {
    if (!(stream.readableLength > 0 || stream.readableEnded)) {
      await new HostPromise((resolve, reject) => {
        const onDone = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        function cleanup() {
          stream.removeListener('readable', onDone);
          stream.removeListener('end', onDone);
          stream.removeListener('error', onError);
        }
        stream.on('readable', onDone);
        stream.on('end', onDone);
        stream.on('error', onError);
      });
    }
    if (stream.read() !== null) chunks += 1;
    reads += 1;
    if (reads > maxReads) throw new Error(`poll loop never terminated after ${reads} reads`);
  }
  return { reads, chunks };
}

test('a paused poll-loop consumer drains an ended stream and lets timers fire', async () => {
  const stream = new Readable({ read() {} });
  stream.push('chunk1');
  stream.push(null);

  const watchdog = new HostPromise((_, reject) => {
    hostSetTimeout(() => reject(new Error('event loop starved: poll never completed')), 3000);
  });
  const result = await HostPromise.race([nextStylePoll(stream), watchdog]);
  assert.equal(result.chunks, 1);
  assert.ok(result.reads <= 4, `expected a couple of reads, got ${result.reads}`);
  assert.equal(stream.readableEnded, true);
});

test('an ended stream with no data still completes the poll loop', async () => {
  const stream = new Readable({ read() {} });
  stream.push(null);

  const watchdog = new HostPromise((_, reject) => {
    hostSetTimeout(() => reject(new Error('event loop starved: empty stream poll never completed')), 3000);
  });
  const result = await HostPromise.race([nextStylePoll(stream), watchdog]);
  assert.equal(result.chunks, 0);
  assert.equal(stream.readableEnded, true);
});
