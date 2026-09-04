/**
 * Serialize host-binding capture calls without dropping any payload. Browser
 * bindings are asynchronous message boundaries; issuing one call per trace
 * event concurrently can exhaust the renderer while the host is still
 * persisting the same ordered stream.
 */
export function createSerializedCaptureQueue(bindings = globalThis) {
  const states = new Map();
  const batchSize = 32;
  // A microtask is too narrow for browser activity: network events commonly
  // arrive one task at a time, which would turn the queue back into one host
  // binding call per event. A short task window batches adjacent activity
  // while keeping the queue bounded and retaining its order.
  const schedule = typeof bindings?.setTimeout === 'function'
    ? (callback) => bindings.setTimeout(callback, 4)
    : (callback) => Promise.resolve().then(callback);

  const stateFor = (name) => {
    let state = states.get(name);
    if (!state) {
      state = { pending: [], waiters: [], running: null, scheduled: false };
      states.set(name, state);
    }
    return state;
  };

  const drain = (name) => {
    const state = stateFor(name);
    state.scheduled = false;
    if (state.running || state.pending.length === 0) return state.running || Promise.resolve();
    const payloads = state.pending.splice(0);
    const waiters = state.waiters.splice(0);
    state.running = Promise.resolve().then(async () => {
      try {
        const binding = bindings?.[name];
        if (typeof binding === 'function') {
          await binding(payloads.length === 1 ? payloads[0] : { events: payloads });
        }
      } catch {
        // Capture is observational. A consumer/binding failure must not
        // change the guest command's output or exit semantics.
      } finally {
        for (const resolve of waiters) resolve();
      }
    }).finally(() => {
      state.running = null;
      if (state.pending.length > 0) scheduleDrain(name);
    });
    return state.running;
  };

  const scheduleDrain = (name) => {
    const state = stateFor(name);
    if (state.scheduled || state.running && state.pending.length < batchSize) return;
    state.scheduled = true;
    schedule(() => drain(name));
  };

  const enqueue = (bindingName, payload) => {
    const name = String(bindingName || '');
    const state = stateFor(name);
    const completion = new Promise((resolve) => state.waiters.push(resolve));
    state.pending.push(payload);
    if (state.pending.length >= batchSize) void drain(name);
    else scheduleDrain(name);
    return completion;
  };

  enqueue.flush = async () => {
    while (true) {
      const work = [];
      for (const name of states.keys()) work.push(drain(name));
      if (work.length) await Promise.all(work);
      if (![...states.values()].some((state) => (
        state.scheduled || state.running || state.pending.length > 0
      ))) return;
    }
  };
  return enqueue;
}
