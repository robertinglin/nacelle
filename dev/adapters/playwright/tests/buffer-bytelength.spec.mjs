import { expect } from 'playwright/test';
import { browserRuntimeURL, expectPass, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

test('reproduces the v22 test-buffer-bytelength input and encoding cases', async ({ harnessPage }) => {
  const result = await harnessPage.run(`
    (() => {
      const assert = require('node:assert');
      const vm = require('node:vm');

      for (const value of [32, {}, [], undefined]) {
        assert.throws(
          () => Buffer.byteLength(value, 'latin1'),
          (error) => error.name === 'TypeError' && error.code === 'ERR_INVALID_ARG_TYPE',
        );
      }

      assert(ArrayBuffer.isView(Buffer.alloc(10)));
      assert(ArrayBuffer.isView(Buffer.allocUnsafe(10)));
      assert(ArrayBuffer.isView(Buffer.from('')));

      assert.strictEqual(Buffer.byteLength(Buffer.from([0xe4, 0xb8, 0xad, 0xe6, 0x96])), 5);
      assert.strictEqual(Buffer.byteLength(Buffer.from('abc')), 3);
      assert.strictEqual(Buffer.byteLength(new ArrayBuffer(8)), 8);
      assert.strictEqual(Buffer.byteLength(new Int8Array(8)), 8);
      assert.strictEqual(Buffer.byteLength(new Uint8Array(8)), 8);
      assert.strictEqual(Buffer.byteLength(new Uint8ClampedArray(2)), 2);
      assert.strictEqual(Buffer.byteLength(new Int16Array(8)), 16);
      assert.strictEqual(Buffer.byteLength(new Uint16Array(8)), 16);
      assert.strictEqual(Buffer.byteLength(new Int32Array(8)), 32);
      assert.strictEqual(Buffer.byteLength(new Uint32Array(8)), 32);
      assert.strictEqual(Buffer.byteLength(new Float32Array(8)), 32);
      assert.strictEqual(Buffer.byteLength(new Float64Array(8)), 64);
      assert.strictEqual(Buffer.byteLength(new DataView(new ArrayBuffer(2))), 2);

      assert.strictEqual(Buffer.byteLength('', 'ascii'), 0);
      assert.strictEqual(Buffer.byteLength('', 'HeX'), 0);
      assert.strictEqual(Buffer.byteLength('∑éllö wørl∂!', 'utf-8'), 19);
      assert.strictEqual(Buffer.byteLength('κλμνξο', 'utf8'), 12);
      assert.strictEqual(Buffer.byteLength('挵挶挷挸挹', 'utf-8'), 15);
      assert.strictEqual(Buffer.byteLength('𠝹𠱓𠱸', 'UTF8'), 12);
      assert.strictEqual(Buffer.byteLength('hey there'), 9);
      assert.strictEqual(Buffer.byteLength('𠱸挶νξ#xx :)'), 17);
      assert.strictEqual(Buffer.byteLength('hello world', ''), 11);
      assert.strictEqual(Buffer.byteLength('hello world', 'abc'), 11);
      assert.strictEqual(Buffer.byteLength('ßœ∑≈', 'unkn0wn enc0ding'), 10);
      assert.strictEqual(Buffer.byteLength('aGVsbG8gd29ybGQ=', 'base64'), 11);
      assert.strictEqual(Buffer.byteLength('aGVsbG8gd29ybGQ', 'BASE64URL'), 11);
      assert.strictEqual(Buffer.byteLength('aaa=', 'base64'), 2);
      assert.strictEqual(Buffer.byteLength('aaaa==', 'base64url'), 3);
      assert.strictEqual(Buffer.byteLength('Il était tué'), 14);
      assert.strictEqual(Buffer.byteLength('Il était tué', 'utf8'), 14);

      for (const encoding of ['ascii', 'ASCII', 'latin1', 'LATIN1', 'binary', 'BINARY']) {
        assert.strictEqual(Buffer.byteLength('Il était tué', encoding), 12);
      }
      for (const encoding of ['ucs2', 'UCS2', 'ucs-2', 'UCS-2', 'utf16le', 'UTF16LE', 'utf-16le', 'UTF-16LE']) {
        assert.strictEqual(Buffer.byteLength('Il était tué', encoding), 24);
      }

      const arrayBuffer = vm.runInNewContext('new ArrayBuffer()');
      assert.strictEqual(Buffer.byteLength(arrayBuffer), 0);
      for (let index = 1; index < 10; index += 1) {
        const encoding = String(index).repeat(index);
        assert.strictEqual(Buffer.byteLength('foo', encoding), Buffer.byteLength('foo', 'utf8'));
      }
    })();
  `);

  await expectPass(expect, result);
});
