const installed = new WeakSet();

export function installWebCryptoLifecycle(scope) {
  const subtle = scope.crypto?.subtle;
  if (!subtle || installed.has(subtle)) return;
  for (const name of [
    'encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey',
    'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey',
  ]) {
    const operation = subtle[name];
    if (typeof operation !== 'function') continue;
    Object.defineProperty(subtle, name, {
      configurable: true,
      writable: true,
      value: function (...args) {
        const owner = scope.__bnhActiveProcess || scope.process;
        const release = owner?._bnhTaskTracker?.(`crypto.subtle.${name}`);
        try {
          const result = Reflect.apply(operation, this, args);
          // Native crypto jobs run outside the browser's microtask queue and
          // must keep their virtual process alive until they settle.
          return release ? Promise.resolve(result).finally(release) : result;
        } catch (error) {
          release?.();
          throw error;
        }
      },
    });
  }
  installed.add(subtle);
}
