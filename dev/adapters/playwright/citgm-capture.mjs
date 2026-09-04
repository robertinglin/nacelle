/**
 * Serialize host-binding capture calls without dropping any payload. Browser
 * bindings are asynchronous message boundaries; issuing one call per trace
 * event concurrently can exhaust the renderer while the host is still
 * persisting the same ordered stream.
 */
export function createSerializedCaptureQueue(bindings = globalThis) {
  const tails = new Map();
  const enqueue = (bindingName, payload) => {
    const name = String(bindingName || '');
    const previous = tails.get(name) || Promise.resolve();
    const next = previous
      .then(() => {
        const binding = bindings?.[name];
        return typeof binding === 'function' ? binding(payload) : undefined;
      })
      .catch(() => {
        // Capture is observational. A consumer/binding failure must not
        // change the guest command's output or exit semantics.
      });
    tails.set(name, next);
    return next;
  };
  enqueue.flush = () => Promise.all([...tails.values()]);
  return enqueue;
}
