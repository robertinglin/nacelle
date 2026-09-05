import assert from 'node:assert/strict';
import test from 'node:test';
import { installWebCryptoLifecycle } from '../../../../src/runtime/webcrypto-lifecycle.js';

test('Web Crypto jobs keep their calling process active through fulfillment and rejection', async () => {
  let finish;
  let pending = 0;
  const labels = [];
  const owner = {
    _bnhTaskTracker(label) {
      labels.push(label);
      pending += 1;
      return () => { pending -= 1; };
    },
  };
  const subtle = {
    generateKey(algorithm) {
      assert.equal(this, subtle);
      assert.equal(algorithm, 'AES-GCM');
      return new Promise(resolve => { finish = resolve; });
    },
    exportKey() { return Promise.reject(new Error('export failed')); },
    digest() { throw new TypeError('invalid receiver'); },
  };
  const scope = { crypto: { subtle }, __bnhActiveProcess: owner };
  installWebCryptoLifecycle(scope);
  installWebCryptoLifecycle(scope);
  const result = subtle.generateKey('AES-GCM');
  assert.equal(pending, 1);
  scope.__bnhActiveProcess = null;
  finish('key');
  assert.equal(await result, 'key');
  assert.equal(pending, 0);

  scope.process = owner;
  await assert.rejects(subtle.exportKey(), /export failed/);
  assert.equal(pending, 0);
  assert.throws(() => subtle.digest(), /invalid receiver/);
  assert.equal(pending, 0);
  assert.deepEqual(labels, ['crypto.subtle.generateKey', 'crypto.subtle.exportKey', 'crypto.subtle.digest']);
});

test('host Web Crypto calls preserve their result without a virtual process', async () => {
  installWebCryptoLifecycle({});
  const result = Promise.resolve('digest');
  const scope = { crypto: { subtle: { digest: () => result } } };
  installWebCryptoLifecycle(scope);
  assert.equal(scope.crypto.subtle.digest(), result);
  assert.equal(await result, 'digest');
});
