import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from '../../adapters/playwright/runtime/streams.js';

test('Writable supports legacy callable construction on an inherited object', () => {
  function LegacyWritable(options) {
    Writable.call(this, options);
  }

  LegacyWritable.prototype = Object.create(Writable.prototype);
  LegacyWritable.prototype.constructor = LegacyWritable;

  const received = [];
  const writable = new LegacyWritable({
    write(chunk, _encoding, callback) {
      received.push(chunk.toString());
      callback();
    },
  });

  writable.write('legacy');
  assert.deepEqual(received, ['legacy']);
  assert.equal(new Writable().writable, true);
});
