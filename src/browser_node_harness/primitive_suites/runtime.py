from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ..models import TestCase


@dataclass(frozen=True, slots=True)
class RuntimePrimitiveSpec:
    name: str
    goal: str
    source: str


_SPECS = (
    RuntimePrimitiveSpec(
        "globals",
        "Expose the browser-native runtime globals required by Node-compatible code.",
        """const assert = require('node:assert');
assert.strictEqual(typeof globalThis, 'object');
assert.strictEqual(globalThis.globalThis, globalThis);
assert.strictEqual(typeof global, 'object');
assert.strictEqual(typeof process, 'object');
assert.strictEqual(typeof console, 'object');
assert.strictEqual(typeof setTimeout, 'function');
assert.strictEqual(typeof clearTimeout, 'function');
assert.strictEqual(typeof queueMicrotask, 'function');
""",
    ),
    RuntimePrimitiveSpec(
        "console",
        "Provide callable console methods without changing their argument values or ordering.",
        """const assert = require('node:assert');
const originalLog = console.log;
const originalError = console.error;
const calls = [];
try {
  console.log = (...args) => calls.push(['log', args]);
  console.error = (...args) => calls.push(['error', args]);
  console.log('runtime', 7, { ok: true });
  console.error('problem', 3);
  assert.deepStrictEqual(calls, [
    ['log', ['runtime', 7, { ok: true }]],
    ['error', ['problem', 3]],
  ]);
} finally {
  console.log = originalLog;
  console.error = originalError;
}
""",
    ),
    RuntimePrimitiveSpec(
        "buffer-encoding",
        "Provide Buffer construction, UTF-8 encoding, byte length, and base64 conversion.",
        """const assert = require('node:assert');
const text = 'héllo';
const utf8 = Buffer.from(text, 'utf8');
assert.strictEqual(Buffer.isBuffer(utf8), true);
assert.strictEqual(utf8.toString('utf8'), text);
assert.strictEqual(Buffer.byteLength(text, 'utf8'), utf8.length);
const encoded = utf8.toString('base64');
assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf8'), text);
assert.deepStrictEqual([...Buffer.from([0, 127, 255])], [0, 127, 255]);
""",
    ),
    RuntimePrimitiveSpec(
        "assert",
        "Provide Node-compatible assertion failures, deep comparisons, and thrown-error checks.",
        """const assert = require('node:assert');
assert.strictEqual(2 + 2, 4);
assert.deepStrictEqual({ answer: [4] }, { answer: [4] });
assert.throws(
  () => { throw new TypeError('expected failure'); },
  (error) => error instanceof TypeError && error.message === 'expected failure',
);
assert.doesNotThrow(() => assert.ok(true));
""",
    ),
    RuntimePrimitiveSpec(
        "structured-clone",
        "Provide structuredClone with independent nested data and supported built-in values.",
        """const assert = require('node:assert');
const original = {
  nested: { values: [1, 2, 3] },
  bytes: new Uint8Array([4, 5, 6]),
  when: new Date('2024-01-02T03:04:05.000Z'),
};
const clone = structuredClone(original);
assert.notStrictEqual(clone, original);
assert.notStrictEqual(clone.nested, original.nested);
assert.deepStrictEqual([...clone.nested.values], [1, 2, 3]);
assert.deepStrictEqual([...clone.bytes], [4, 5, 6]);
assert.strictEqual(clone.when.toISOString(), original.when.toISOString());
clone.nested.values.push(4);
assert.deepStrictEqual(original.nested.values, [1, 2, 3]);
""",
    ),
    RuntimePrimitiveSpec(
        "promise-microtasks",
        "Preserve Promise, queueMicrotask, nextTick, and setImmediate ordering across the event loop.",
        """const assert = require('node:assert');
(async () => {
  const order = [];
  process.nextTick(() => order.push('nextTick'));
  Promise.resolve().then(() => order.push('promise'));
  queueMicrotask(() => order.push('queueMicrotask'));
  await new Promise((resolve) => {
    setImmediate(() => {
      order.push('setImmediate');
      resolve();
    });
  });
  assert.deepStrictEqual(order, ['nextTick', 'promise', 'queueMicrotask', 'setImmediate']);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
""",
    ),
    RuntimePrimitiveSpec(
        "abort-signal",
        "Provide AbortController state, abort reasons, and one-shot AbortSignal events.",
        """const assert = require('node:assert');
const controller = new AbortController();
const signal = controller.signal;
let events = 0;
let reason;
signal.addEventListener('abort', () => {
  events += 1;
  reason = signal.reason;
}, { once: true });
assert.strictEqual(signal.aborted, false);
controller.abort('cancelled');
controller.abort('ignored');
assert.strictEqual(signal.aborted, true);
assert.strictEqual(signal.reason, 'cancelled');
assert.strictEqual(reason, 'cancelled');
assert.strictEqual(events, 1);
""",
    ),
    RuntimePrimitiveSpec(
        "event-emitter",
        "Provide EventEmitter listener registration, ordered delivery, removal, and listener counts.",
        """const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const emitter = new EventEmitter();
const received = [];
const onValue = (value) => received.push(['value', value]);
emitter.on('value', onValue);
emitter.once('value', (value) => received.push(['once', value]));
assert.strictEqual(emitter.listenerCount('value'), 2);
assert.strictEqual(emitter.emit('value', 1), true);
assert.strictEqual(emitter.emit('value', 2), true);
emitter.off('value', onValue);
assert.strictEqual(emitter.listenerCount('value'), 0);
assert.deepStrictEqual(received, [['value', 1], ['once', 1], ['value', 2]]);
assert.strictEqual(emitter.emit('missing'), false);
""",
    ),
    RuntimePrimitiveSpec(
        "uncaught-exception",
        "Deliver uncaught exceptions to the process handler without requiring host-side execution.",
        """const assert = require('node:assert');
let handled = false;
const handler = (error) => {
  handled = true;
  assert.strictEqual(error.message, 'runtime uncaught exception');
  process.removeListener('uncaughtException', handler);
};
process.once('uncaughtException', handler);
setImmediate(() => { throw new Error('runtime uncaught exception'); });
setImmediate(() => {
  assert.strictEqual(handled, true);
});
""",
    ),
    RuntimePrimitiveSpec(
        "unhandled-rejection",
        "Deliver unhandled Promise rejections to the process handler and preserve a clean test exit.",
        """const assert = require('node:assert');
(async () => {
  let handled = false;
  const handler = (reason, promise) => {
    handled = true;
    assert.strictEqual(reason.message, 'runtime unhandled rejection');
    assert.strictEqual(typeof promise.then, 'function');
    process.removeListener('unhandledRejection', handler);
  };
  process.once('unhandledRejection', handler);
  Promise.reject(new Error('runtime unhandled rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(handled, true);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
""",
    ),
    RuntimePrimitiveSpec(
        "exit-behavior",
        "Expose process exit codes and emit the exit lifecycle event with the final code.",
        """const assert = require('node:assert');
assert.strictEqual(typeof process.exit, 'function');
process.once('exit', (code) => {
  assert.strictEqual(code, 0);
});
process.exitCode = 17;
assert.strictEqual(process.exitCode, 17);
process.exitCode = 0;
assert.strictEqual(process.exitCode, 0);
""",
    ),
)

_BY_NAME = {spec.name: spec for spec in _SPECS}


def runtime_specs(names: tuple[str, ...] | None = None) -> tuple[RuntimePrimitiveSpec, ...]:
    selected = tuple(_BY_NAME) if names is None else names
    unknown = [name for name in selected if name not in _BY_NAME]
    if unknown:
        raise ValueError(f"unknown runtime primitive work item(s): {', '.join(unknown)}")
    return tuple(_BY_NAME[name] for name in selected)


def runtime_tests(names: tuple[str, ...] | None = None) -> tuple[TestCase, ...]:
    return tuple(
        TestCase(
            path=f".bnh/primitives/runtime/{spec.name}.js",
            suite="bnh-primitives-runtime",
            source_sha256=hashlib.sha256(spec.source.encode()).hexdigest(),
            source_override=spec.source,
        )
        for spec in runtime_specs(names)
    )


def runtime_goal(path: str) -> str | None:
    prefix = ".bnh/primitives/runtime/"
    if not path.startswith(prefix) or not path.endswith(".js"):
        return None
    spec = _BY_NAME.get(path[len(prefix) : -3])
    return None if spec is None else spec.goal
