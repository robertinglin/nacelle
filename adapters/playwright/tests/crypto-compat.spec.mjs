import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { expect, test } from 'playwright/test';
import { createCryptoContract, digest } from '../runtime/crypto.js';

const scope = Object.freeze({ crypto: webcrypto, TextEncoder });

test.describe('browser-native crypto compatibility', () => {
  test('accepts ArrayBuffer and typed-array inputs from another realm', async () => {
    const context = vm.createContext({});
    const foreign = vm.runInContext(`(() => {
      const buffer = new ArrayBuffer(4);
      new Uint8Array(buffer).set([1, 2, 3, 4]);
      return { buffer, view: new Uint8Array(buffer) };
    })()`, context);

    await expect(digest('SHA-256', foreign.buffer, scope)).resolves.toHaveLength(32);
    await expect(digest('SHA-256', foreign.view, scope)).resolves.toHaveLength(32);
  });

  test('keeps the contract browser-native while using foreign-realm inputs', async () => {
    const contract = createCryptoContract(scope);
    const context = vm.createContext({});
    const foreignBuffer = vm.runInContext('new ArrayBuffer(3)', context);
    const result = await contract.digest('SHA-256', foreignBuffer);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBe(32);
  });
});
