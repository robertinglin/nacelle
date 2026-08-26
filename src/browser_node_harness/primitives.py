from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .models import TestCase
from .primitive_suites.io_network import expanded_specs, expanded_tests
from .primitive_suites.runtime import runtime_goal, runtime_specs, runtime_tests
from .primitive_suites.system_platform import system_platform_goal, system_platform_specs, system_platform_tests


@dataclass(frozen=True, slots=True)
class PrimitiveSpec:
    name: str
    goal: str
    source: str


_SPECS = (
    PrimitiveSpec(
        "stdout-stderr",
        "Provide ordered, independently writable stdout and stderr streams with exact bytes and flushing.",
        """const assert = require('node:assert');
assert.strictEqual(typeof process.stdout.write, 'function');
assert.strictEqual(typeof process.stderr.write, 'function');
process.stdout.write('primitive-stdout\\n');
process.stderr.write('primitive-stderr\\n');
""",
    ),
    PrimitiveSpec(
        "vfs",
        "Provide a coherent virtual filesystem with file writes, reads, encodings, and cleanup.",
        """const assert = require('node:assert');
const fs = require('node:fs');
const path = '.bnh-vfs-probe';
fs.writeFileSync(path, 'vfs-ok', 'utf8');
assert.strictEqual(fs.readFileSync(path, 'utf8'), 'vfs-ok');
fs.unlinkSync(path);
""",
    ),
    PrimitiveSpec(
        "network",
        "Provide the browser network boundary through the Node-facing fetch contract.",
        """const assert = require('node:assert');
(async () => {
  const response = await fetch('data:text/plain,bnh-network');
  assert.strictEqual(await response.text(), 'bnh-network');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
""",
    ),
    PrimitiveSpec(
        "ipc",
        "Provide in-process message delivery and lifecycle cleanup for Node-facing IPC channels.",
        """const assert = require('node:assert');
const { MessageChannel } = require('node:worker_threads');
const { port1, port2 } = new MessageChannel();
port1.on('message', (value) => {
  assert.strictEqual(value, 'ipc-ok');
  port1.close();
  port2.close();
});
port2.postMessage('ipc-ok');
""",
    ),
    PrimitiveSpec(
        "streams",
        "Provide shared readable and writable stream behavior with backpressure-safe piping.",
        """const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');
const chunks = [];
const readable = Readable.from(['stream-', 'ok']);
const writable = new Writable({
  write(chunk, encoding, callback) {
    chunks.push(chunk.toString());
    callback();
  },
});
writable.on('finish', () => assert.strictEqual(chunks.join(''), 'stream-ok'));
readable.pipe(writable);
""",
    ),
    PrimitiveSpec(
        "process",
        "Provide process identity, argv, environment, exit status, and lifecycle state.",
        """const assert = require('node:assert');
assert.strictEqual(typeof process.pid, 'number');
assert.ok(Array.isArray(process.argv));
assert.strictEqual(typeof process.env, 'object');
""",
    ),
    PrimitiveSpec(
        "timers",
        "Provide timer scheduling and cancellation with event-loop-compatible ordering.",
        """const assert = require('node:assert');
(async () => {
  let called = false;
  const cancelled = setTimeout(() => { called = true; }, 10);
  clearTimeout(cancelled);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(called, false);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
""",
    ),
    PrimitiveSpec(
        "module-loader",
        "Provide Node-compatible builtin module resolution and stable module exports.",
        """const assert = require('node:assert');
const path = require('node:path');
assert.strictEqual(path.basename('/tmp/primitive.js'), 'primitive.js');
""",
    ),
)

_BY_NAME = {spec.name: spec for spec in _SPECS}
_RUNTIME_BY_NAME = {spec.name: spec for spec in runtime_specs()}
_IO_NETWORK_BY_NAME = {spec.name: spec for spec in expanded_specs()}
_SYSTEM_PLATFORM_BY_NAME = {spec.name: spec for spec in system_platform_specs()}
_RUNTIME_TESTS = runtime_tests()
_IO_NETWORK_TESTS = expanded_tests()
_SYSTEM_PLATFORM_TESTS = system_platform_tests()
_EXPANDED_NAMES = frozenset(
    (*_RUNTIME_BY_NAME, *_IO_NETWORK_BY_NAME, *_SYSTEM_PLATFORM_BY_NAME)
)


def primitive_specs(names: tuple[str, ...]) -> tuple[PrimitiveSpec, ...]:
    unknown = [name for name in names if name not in _BY_NAME]
    if unknown:
        raise ValueError(f"unknown primitive work item(s): {', '.join(unknown)}")
    return tuple(_BY_NAME[name] for name in names)


def primitive_tests(names: tuple[str, ...]) -> tuple[TestCase, ...]:
    unknown = [name for name in names if name not in _BY_NAME and name not in _EXPANDED_NAMES]
    if unknown:
        raise ValueError(f"unknown primitive work item(s): {', '.join(unknown)}")

    tests_by_name = {
        spec.name: TestCase(
            path=f".bnh/primitives/{spec.name}.js",
            suite="bnh-primitives",
            source_sha256=hashlib.sha256(spec.source.encode()).hexdigest(),
            source_override=spec.source,
        )
        for spec in _SPECS
    }
    for test in _RUNTIME_TESTS:
        path_name = test.path[len(".bnh/primitives/") : -3]
        tests_by_name[path_name] = test
        # Keep config names short while retaining the suite-specific path.
        tests_by_name[path_name.removeprefix("runtime/")] = test
    tests_by_name.update(
        {test.path[len(".bnh/primitives/") : -3]: test for test in _IO_NETWORK_TESTS}
    )
    tests_by_name.update(
        {test.path[len(".bnh/primitives/") : -3]: test for test in _SYSTEM_PLATFORM_TESTS}
    )
    return tuple(tests_by_name[name] for name in names)


def primitive_goal(path: str) -> str | None:
    for goal in (runtime_goal(path), system_platform_goal(path)):
        if goal is not None:
            return goal
    prefix = ".bnh/primitives/"
    if path.startswith(prefix) and path.endswith(".js"):
        name = path[len(prefix) : -3]
        spec = _IO_NETWORK_BY_NAME.get(name)
        if spec is not None:
            return spec.goal
    if not path.startswith(prefix) or not path.endswith(".js"):
        return None
    name = path[len(prefix) : -3]
    spec = _BY_NAME.get(name)
    return None if spec is None else spec.goal


def is_primitive_path(path: str) -> bool:
    return path.startswith(".bnh/primitives/")
