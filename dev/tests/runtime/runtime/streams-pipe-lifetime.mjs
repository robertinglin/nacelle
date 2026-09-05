import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Stream, Writable } from '../../../../src/runtime/streams.js';
import { Nacelle } from '../../../../src/index.js';

for (const legacy of [false, true]) {
  for (const mode of ['default', 'keep-open', 'stdio']) {
    test(`${legacy ? 'Stream' : 'Readable'}.pipe destination lifetime: ${mode}`, async () => {
      const chunks = [];
      const destination = new Writable({
        write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); },
      });
      if (mode === 'stdio') destination._isStdio = true;
      const source = legacy ? new Stream() : Readable.from(['first']);
      const ended = new Promise((resolve) => source.once('end', resolve));
      assert.equal(source.pipe(destination, mode === 'keep-open' ? { end: false } : undefined), destination);
      if (legacy) {
        source.emit('data', 'first');
        source.emit('end');
      }
      await ended;
      assert.equal(destination.writableEnded, mode === 'default');
      if (mode !== 'default') {
        destination.write('second');
        destination.end();
      }
      assert.deepEqual(chunks, mode === 'default' ? ['first'] : ['first', 'second']);
    });
  }
}

test('piping a completed producer into process output leaves it writable', async () => {
  const node = await Nacelle.create({ gateway: false });
  const child = await node.execute(`
    const { Readable } = require('node:stream');
    for (const stream of [process.stdout, process.stderr]) {
      const source = Readable.from(['first']);
      source.pipe(stream);
      source.on('end', () => stream.write('second'));
    }
  `);
  assert.equal(await child.exit, 0);
  assert.equal(await child.stdoutText(), 'firstsecond');
  assert.equal(await child.stderrText(), 'firstsecond');
});
