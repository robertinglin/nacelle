export const PROGRESS_PREFIX = 'BNH_PROGRESS ';
const DEFAULT_MAX_PENDING = 64;

function byteLength(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof Uint8Array) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return new TextEncoder().encode(String(value)).byteLength;
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Report bounded, machine-readable activity without putting candidate output
 * or a guessed completion percentage on the protocol.
 */
export function createProgressReporter({ binding, runId, maxPending = DEFAULT_MAX_PENDING } = {}) {
  const bindingName = typeof binding === 'string' ? binding : '';
  const limit = Math.max(1, safeInteger(maxPending, DEFAULT_MAX_PENDING));
  const queue = [];
  const pendingActivity = new Map();
  const activityTimers = new Set();
  let sequence = 0;
  let draining = null;

  function reportable() {
    return Boolean(bindingName && typeof globalThis[bindingName] === 'function');
  }

  function push(payload) {
    const previous = queue.at(-1);
    payload.sequence = ++sequence;
    if (payload.event === 'output-activity'
      && previous?.event === payload.event
      && previous.phase === payload.phase
      && previous.stream === payload.stream) {
      previous.bytes += payload.bytes;
      previous.chunks += payload.chunks;
      previous.sequence = payload.sequence;
    } else {
      if (queue.length >= limit) {
        const outputIndex = queue.findIndex((item) => item.event === 'output-activity');
        if (outputIndex >= 0) queue.splice(outputIndex, 1);
        else return;
      }
      queue.push(payload);
    }
    void drain();
  }

  function mergeActivity(previous, payload) {
    if (!previous) return payload;
    for (const key of ['bytes', 'chunks']) {
      if (Number.isFinite(payload[key])) previous[key] = (previous[key] || 0) + payload[key];
    }
    for (const key of ['events', 'files']) {
      if (Number.isFinite(payload[key])) previous[key] = Math.max(previous[key] || 0, payload[key]);
    }
    return previous;
  }

  function enqueue(phase, event, fields = {}) {
    if (!reportable() || typeof phase !== 'string' || typeof event !== 'string') return;
    const payload = {
      schemaVersion: 1,
      type: 'progress',
      runId: String(runId || ''),
      phase,
      event,
      ...fields,
    };
    const activity = event === 'output-activity' || event === 'network-activity' || event.startsWith('npm-');
    if (!activity) {
      push(payload);
      return;
    }
    const key = `${phase}:${event}:${payload.stream || ''}`;
    const merged = mergeActivity(pendingActivity.get(key), payload);
    pendingActivity.set(key, merged);
    if (activityTimers.has(key)) return;
    setTimeout(() => {
      activityTimers.delete(key);
      const pending = pendingActivity.get(key);
      pendingActivity.delete(key);
      if (pending) push(pending);
    }, 100);
    activityTimers.add(key);
  }

  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      while (queue.length) {
        const event = queue.shift();
        try {
          await globalThis[bindingName](event);
        } catch {
          // Progress must never change test execution or its exit semantics.
        }
      }
    })().finally(() => { draining = null; });
    return draining;
  }

  return {
    emit(phase, event, fields = {}) {
      enqueue(phase, event, fields);
    },
    output(stream, value) {
      enqueue('execution', 'output-activity', {
        stream: String(stream),
        bytes: byteLength(value),
        chunks: 1,
      });
    },
    async flush() {
      while (activityTimers.size || pendingActivity.size || draining) {
        if (activityTimers.size) await new Promise((resolve) => setTimeout(resolve, 110));
        if (draining) await draining;
      }
    },
  };
}

export function formatProgressLine(event) {
  return `${PROGRESS_PREFIX}${JSON.stringify(event)}\n`;
}
