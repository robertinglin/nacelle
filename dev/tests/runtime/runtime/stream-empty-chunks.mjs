import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from '../../../../src/runtime/streams.js';

for (const options of [{}, { encoding: 'utf8' }, { preserveStrings: true }]) {
  test(`empty byte and string chunks do not block flowing streams: ${JSON.stringify(options)}`, async () => {
    const stream = new Readable({ ...options, read() {} });
    const chunks = [];
    const ended = new Promise((resolve, reject) => {
      stream.once('end', resolve);
      stream.once('error', reject);
    });
    stream.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)));
    stream.push(new Uint8Array(0));
    stream.push('');
    stream.push('response');
    // Drain before EOF, matching the separate worker messages used by HTTP.
    await new Promise((resolve) => setImmediate(resolve));
    stream.push(new Uint8Array(0));
    await new Promise((resolve) => setImmediate(resolve));
    stream.push(null);
    await ended;
    assert.deepEqual(chunks, ['response']);
  });
}

test('object streams retain empty strings and byte arrays as objects', async () => {
  const bytes = new Uint8Array(0);
  const chunks = [];
  for await (const chunk of Readable.from(['', bytes])) chunks.push(chunk);
  assert.deepEqual(chunks, ['', bytes]);
});
