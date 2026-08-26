import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('reproduces the v22 test-buffer-alloc argument and range cases', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (() => {
      const assert = require('node:assert');

      const outOfRange = (error) => error.name === 'RangeError' && error.code === 'ERR_OUT_OF_RANGE';
      const invalidType = (error) => error.name === 'TypeError' && error.code === 'ERR_INVALID_ARG_TYPE';
      const invalidValue = (error) => error.name === 'TypeError' && error.code === 'ERR_INVALID_ARG_VALUE';

      const unsafe = Buffer.allocUnsafe(1024);
      assert.strictEqual(unsafe.length, 1024);
      unsafe[0] = -1;
      assert.strictEqual(unsafe[0], 255);
      for (let index = 0; index < unsafe.length; index += 1) unsafe[index] = index;
      for (let index = 0; index < unsafe.length; index += 1) assert.strictEqual(unsafe[index], index % 256);

      assert.strictEqual(Buffer.alloc(128).byteOffset, 0);
      assert.strictEqual(Buffer.alloc(128).offset, 0);
      assert.strictEqual(Buffer.allocUnsafeSlow(10).buffer.byteLength, 10);
      assert.deepStrictEqual([...Buffer.from(new Uint8Array(4).fill(42))], [42, 42, 42, 42]);
      assert.deepStrictEqual([...Buffer.from(new Uint32Array(4).fill(42))], [42, 42, 42, 42]);
      assert.deepStrictEqual([...Buffer(new Uint8Array(4).fill(42))], [42, 42, 42, 42]);
      assert.strictEqual(Buffer(0).length, 0);
      assert.deepStrictEqual([...Buffer.from({ 0: '0', 1: '1', 2: '2', 3: '3', length: 4 })], [0, 1, 2, 3]);

      assert.throws(() => Buffer.from(), invalidType);
      assert.throws(() => Buffer.from(null), invalidType);
      assert.throws(() => Buffer.from('', 'buffer'), (error) => error.code === 'ERR_UNKNOWN_ENCODING');
      assert.throws(() => Buffer.alloc({ valueOf: () => 1 }), invalidType);
      assert.throws(() => Buffer.alloc(-1), outOfRange);
      assert.throws(() => Buffer.alloc(NaN), outOfRange);
      assert.throws(() => Buffer.alloc(Infinity), outOfRange);
      assert.strictEqual(Buffer.allocUnsafe(3.3).length, 3);
      assert.strictEqual(Buffer.alloc(3.3).length, 3);
      assert.strictEqual(Buffer.from({ length: 3.3 }).length, 3);
      assert.strictEqual(Buffer.from({ length: 'BAM' }).length, 0);
      const arrayBuffer = new ArrayBuffer(0);
      assert.strictEqual(Buffer.from({ buffer: arrayBuffer }).length, 0);
      assert.strictEqual(Buffer.from('99').length, 2);
      assert.strictEqual(Buffer.from('13.37').length, 5);

      for (const action of [
        () => Buffer.alloc(8, 'This is not correctly encoded', 'hex'),
        () => Buffer.alloc(8, 'c', 'hex'),
        () => Buffer.alloc(1, Buffer.alloc(0)),
      ]) assert.throws(action, invalidValue);
      assert.throws(() => Buffer.alloc(40, 'x', 20), invalidType);

      const buffer = Buffer.alloc(4);
      assert.throws(() => buffer.toString('invalid'), (error) => error.code === 'ERR_UNKNOWN_ENCODING');
      assert.throws(() => buffer.write('test', 0, 1, 'invalid'), (error) => error.code === 'ERR_UNKNOWN_ENCODING');
      assert.throws(() => buffer.write('test', 'utf8', 0), invalidType);
      assert.throws(() => buffer.write('', 2048), outOfRange);
      assert.throws(() => buffer.write('a', -1), outOfRange);
      assert.throws(() => buffer.write('a', 2048), outOfRange);

      const writeTest = Buffer.from('abcdes');
      writeTest.write('n', 'ascii');
      assert.throws(() => writeTest.write('o', '1', 'ascii'), invalidType);
      writeTest.write('o', 1, 'ascii');
      writeTest.write('d', 2, 'ascii');
      writeTest.write('e', 3, 'ascii');
      writeTest.write('j', 4, 'ascii');
      assert.strictEqual(writeTest.toString(), 'nodejs');
      assert.strictEqual(Buffer.alloc(1).write('', 1, 0), 0);

      const encoded = Buffer.alloc(16);
      assert.strictEqual(encoded.write('über', 0, 'utf8'), 5);
      assert.strictEqual(encoded.toString('utf8', 0, 5), 'über');
      assert.strictEqual(encoded.write('800A', 0, 'hex'), 2);
      assert.deepStrictEqual([...encoded.subarray(0, 2)], [0x80, 0x0a]);
      assert.strictEqual(Buffer.alloc(5, '800A', 'hex').toString('hex'), '800a800a80');
      assert.strictEqual(Buffer.alloc(4, 'x').toString(), 'xxxx');
    })();
  `);

  await expectPass(expect, result);
});
