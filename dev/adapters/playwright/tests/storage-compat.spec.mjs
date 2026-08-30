import { expect } from 'playwright/test';
import { browserRuntimeURL, test } from './harness-test-helpers.mjs';

test.skip(!browserRuntimeURL, 'set BNH_TEST_URL to a browser runtime harness page');

async function loadStorageModule(page) {
  await page.goto(browserRuntimeURL, { waitUntil: 'domcontentloaded' });
}

test.describe('browser-native storage capability adapters', () => {
  test('feature detection matches the browser objects without invoking them', async ({ page }) => {
    await loadStorageModule(page);
    const result = await page.evaluate(async () => {
      const { createStorageAdapters } = await import('/runtime/storage.js');
      const adapters = createStorageAdapters();
      const expected = {
        indexedDB: typeof globalThis.indexedDB?.open === 'function',
        cacheStorage: typeof globalThis.caches?.open === 'function',
        opfs: typeof globalThis.navigator?.storage?.getDirectory === 'function',
        storage: typeof globalThis.navigator?.storage?.estimate === 'function'
          || typeof globalThis.navigator?.storage?.persist === 'function'
          || typeof globalThis.navigator?.storage?.persisted === 'function',
        locks: typeof globalThis.navigator?.locks?.request === 'function',
      };
      return {
        features: adapters.features,
        expected,
        supported: {
          indexedDB: adapters.indexedDB.supported,
          cacheStorage: adapters.cacheStorage.supported,
          opfs: adapters.opfs.supported,
          storage: adapters.storage.supported,
          locks: adapters.locks.supported,
        },
        aliases: {
          caches: adapters.caches === adapters.cacheStorage,
          navigatorStorage: adapters.navigatorStorage === adapters.storage,
          webLocks: adapters.webLocks === adapters.locks,
        },
      };
    });

    expect(result.features).toEqual(result.expected);
    expect(result.supported).toEqual(result.expected);
    expect(result.aliases).toEqual({ caches: true, navigatorStorage: true, webLocks: true });
  });

  test('missing browser APIs produce explicit unsupported capability errors', async ({ page }) => {
    await loadStorageModule(page);
    const result = await page.evaluate(async () => {
      const { createStorageAdapters } = await import('/runtime/storage.js');
      const adapters = createStorageAdapters({ globalObject: { navigator: {} } });
      const operations = [
        ['indexedDB', () => adapters.indexedDB.open('missing')],
        ['cacheStorage', () => adapters.cacheStorage.open('missing')],
        ['opfs', () => adapters.opfs.getDirectory()],
        ['storage', () => adapters.storage.estimate()],
        ['locks', () => adapters.locks.request('missing', () => {})],
      ];
      const errors = [];
      for (const [name, operation] of operations) {
        try {
          await operation();
          errors.push({ name, unexpectedSuccess: true });
        } catch (error) {
          errors.push({
            name,
            errorName: error.name,
            code: error.code,
            capability: error.capability,
            status: error.status,
          });
        }
      }
      return { features: adapters.features, errors, hasMemoryFallback: adapters.memory !== undefined };
    });

    expect(result.features).toEqual({
      indexedDB: false,
      cacheStorage: false,
      opfs: false,
      storage: false,
      locks: false,
    });
    expect(result.hasMemoryFallback).toBe(false);
    expect(result.errors).toEqual([
      {
        name: 'indexedDB',
        errorName: 'UnsupportedWebCapabilityError',
        code: 'ERR_UNSUPPORTED_WEB_CAPABILITY',
        capability: 'IndexedDB',
        status: 'unsupported-capability',
      },
      {
        name: 'cacheStorage',
        errorName: 'UnsupportedWebCapabilityError',
        code: 'ERR_UNSUPPORTED_WEB_CAPABILITY',
        capability: 'Cache Storage',
        status: 'unsupported-capability',
      },
      {
        name: 'opfs',
        errorName: 'UnsupportedWebCapabilityError',
        code: 'ERR_UNSUPPORTED_WEB_CAPABILITY',
        capability: 'Origin Private File System',
        status: 'unsupported-capability',
      },
      {
        name: 'storage',
        errorName: 'UnsupportedWebCapabilityError',
        code: 'ERR_UNSUPPORTED_WEB_CAPABILITY',
        capability: 'navigator.storage',
        status: 'unsupported-capability',
      },
      {
        name: 'locks',
        errorName: 'UnsupportedWebCapabilityError',
        code: 'ERR_UNSUPPORTED_WEB_CAPABILITY',
        capability: 'Web Locks',
        status: 'unsupported-capability',
      },
    ]);
  });

  test('memory fallback is opt-in and isolated from native storage', async ({ page }) => {
    await loadStorageModule(page);
    const result = await page.evaluate(async () => {
      const { createStorageAdapters } = await import('/runtime/storage.js');
      const globalObject = { navigator: {}, structuredClone: globalThis.structuredClone };
      const nativeOnly = createStorageAdapters({ globalObject });
      const isolated = createStorageAdapters({ globalObject, fallback: 'memory' });
      isolated.memory.set('value', { answer: 42 });
      const firstRead = isolated.memory.get('value');
      firstRead.answer = 7;
      return {
        nativeOnlyHasMemory: nativeOnly.memory !== undefined,
        fallbackIsMemory: isolated.fallback === isolated.memory,
        inMemory: isolated.memory.inMemory,
        persistent: isolated.memory.persistent,
        storedValueIsCloned: isolated.memory.get('value').answer === 42,
        keys: isolated.memory.keys(),
      };
    });

    expect(result).toEqual({
      nativeOnlyHasMemory: false,
      fallbackIsMemory: true,
      inMemory: true,
      persistent: false,
      storedValueIsCloned: true,
      keys: ['value'],
    });
  });
});
