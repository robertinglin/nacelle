import assert from 'node:assert/strict';
import test from 'node:test';
import * as native from 'node:crypto';
import { generateKeyPairSync, generateKeyPair, createKeyObjectContract, sign, verify } from '../../../../src/runtime/crypto.js';

test('synchronous RSA exports retain odd-length integers and interoperate with native Node', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
  const pub = publicKey.export({ format: 'jwk' });
  assert.equal(pub.e, 'AQAB');
  assert.equal(publicKey._bnhRsaMaterial.privateExponent, undefined);
  const publicNative = native.createPublicKey({ key: pub, format: 'jwk' });
  const privateNative = native.createPrivateKey({ key: privateKey.export({ format: 'jwk' }), format: 'jwk' });
  const signature = native.sign('sha256', Buffer.from('rsa export regression'), privateNative);
  assert.equal(native.verify('sha256', Buffer.from('rsa export regression'), publicNative, signature), true);
  const der = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  assert.equal(native.createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyDetails.publicExponent, 65537n);
});

test('asynchronously generated RSA KeyObjects use RSA rather than ECDSA signing', async () => {
  const { publicKey, privateKey } = await new Promise((resolve, reject) => generateKeyPair('rsa', { modulusLength: 1024 }, (error, pub, priv) => error ? reject(error) : resolve({ publicKey: pub, privateKey: priv })));
  const signature = await sign('sha256', 'rsa algorithm regression', privateKey);
  assert.equal(await verify('sha256', 'rsa algorithm regression', publicKey, signature), true);
  assert.equal(await verify('sha256', 'wrong data', publicKey, signature), false);
  assert.equal(native.verify('sha256', Buffer.from('rsa algorithm regression'), native.createPublicKey({ key: publicKey.export({ format: 'jwk' }), format: 'jwk' }), signature), true);
});

test('derived public JWKs do not retain private key fields', () => {
  const { createPrivateKey, createPublicKey } = createKeyObjectContract(Buffer);
  const { privateKey } = native.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const input = privateKey.export({ format: 'jwk' });
  const key = createPrivateKey({ key: input, format: 'jwk' });
  for (const value of [{ key: input, format: 'jwk' }, key]) {
    const exported = createPublicKey(value).export({ format: 'jwk' });
    assert.equal(exported.d, undefined);
    assert.equal(exported.x, input.x);
    assert.ok(native.createPublicKey({ key: exported, format: 'jwk' }));
    assert.throws(() => createPrivateKey({ key: exported, format: 'jwk' }), TypeError);
  }
  assert.ok(input.d, 'conversion must not mutate the input');
});
