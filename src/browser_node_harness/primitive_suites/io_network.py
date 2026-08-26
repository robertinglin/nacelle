"""Expanded browser-native primitive contracts for data, I/O, and transport.

The suite is deliberately self-contained.  The existing primitive registry can
import ``expanded_specs`` and ``expanded_tests`` without changing this module.
Contracts use source overrides so they never depend on files in the Node source
checkout or on the host filesystem.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ..models import TestCase


@dataclass(frozen=True, slots=True)
class ExpandedPrimitiveSpec:
    name: str
    goal: str
    source: str
    boundaries: tuple[str, ...] = ()


_DATA_SOURCE = r'''const assert = require('node:assert');

const text = 'browser-native \u{1F30D} data';
const bytes = Buffer.from(text, 'utf8');
assert.strictEqual(bytes.toString('utf8'), text);
assert.strictEqual(Buffer.from(bytes.toString('base64'), 'base64').toString(), text);
assert.strictEqual(Buffer.from('ff00a5', 'hex').toString('hex'), 'ff00a5');
assert.strictEqual(Buffer.byteLength(text, 'utf8'), new TextEncoder().encode(text).byteLength);
assert.strictEqual(Buffer.from(new Uint8Array([1, 2, 255])).at(-1), 255);

const value = {
  map: new Map([['key', 7]]),
  set: new Set(['a', 'b']),
  typed: new Uint16Array([1, 65535]),
  undef: undefined,
};
const encoded = JSON.stringify(value, (key, item) => {
  if (item instanceof Map) return {__map: [...item]};
  if (item instanceof Set) return {__set: [...item]};
  return item;
});
const decoded = JSON.parse(encoded);
assert.deepStrictEqual(decoded.map.__map, [['key', 7]]);
assert.deepStrictEqual(decoded.set.__set, ['a', 'b']);
assert.deepStrictEqual([...value.typed], [1, 65535]);
assert.ok(encoded.includes('"undef"') === false);

const cloned = structuredClone({bytes, value: 42});
assert.deepStrictEqual([...cloned.bytes], [...bytes]);
assert.strictEqual(cloned.value, 42);
'''


_VFS_SOURCE = r'''const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {fileURLToPath, pathToFileURL} = require('node:url');

(async () => {
  const root = `.bnh-vfs-expanded-${process.pid}`;
  const nested = path.join(root, 'nested');
  const first = path.join(nested, 'first.txt');
  const second = path.join(nested, 'renamed.txt');
  const cleanup = async () => {
    await fsp.rm(root, {recursive: true, force: true});
  };

  await cleanup();
  await fsp.mkdir(nested, {recursive: true});
  const handle = await fsp.open(first, 'w+');
  try {
    await handle.writeFile('vfs-file-handle', 'utf8');
    assert.strictEqual((await handle.readFile({encoding: 'utf8'})), 'vfs-file-handle');
    const handleStat = await handle.stat();
    assert.strictEqual(handleStat.isFile(), true);
  } finally {
    await handle.close();
  }

  const directory = await fsp.opendir(nested);
  const names = [];
  for await (const entry of directory) names.push(entry.name);
  assert.deepStrictEqual(names, ['first.txt']);
  const stat = await fsp.stat(first);
  assert.strictEqual(stat.isFile(), true);
  assert.strictEqual((await fsp.stat(nested)).isDirectory(), true);

  const fileUrl = pathToFileURL(path.resolve(first));
  assert.strictEqual(fileURLToPath(fileUrl), path.resolve(first));
  assert.strictEqual((await fsp.readFile(fileUrl, 'utf8')), 'vfs-file-handle');
  await fsp.rename(first, second);
  assert.strictEqual(await fsp.readFile(second, 'utf8'), 'vfs-file-handle');

  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watch timeout')), 1000);
    const watcher = fs.watch(nested, (eventType, name) => {
      if (String(name) !== 'watched.txt') return;
      clearTimeout(timer);
      watcher.close();
      resolve(eventType);
    });
  });
  await fsp.writeFile(path.join(nested, 'watched.txt'), 'watch', 'utf8');
  assert.ok(['rename', 'change'].includes(await changed));
  await cleanup();
  assert.strictEqual(await fsp.rm(root, {recursive: true, force: true}), undefined);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'''


_NETWORK_SOURCE = r'''const assert = require('node:assert');

(async () => {
  const url = new URL('data:text/plain,bnh%20network');
  assert.strictEqual(url.protocol, 'data:');
  assert.strictEqual(url.pathname, 'text/plain,bnh%20network');
  url.searchParams.set('mode', 'browser');
  assert.strictEqual(url.searchParams.get('mode'), 'browser');

  const response = await fetch(url, {
    headers: {'X-BNH-Request': 'present'},
  });
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(await response.text(), 'bnh network');
  assert.strictEqual(response.headers.get('content-type'), 'text/plain');

  const headers = new Headers({'X-BNH-Header': 'value'});
  headers.append('X-BNH-Header', 'second');
  assert.strictEqual(headers.get('x-bnh-header'), 'value, second');
  const request = new Request(url, {redirect: 'manual', headers});
  assert.strictEqual(request.redirect, 'manual');
  assert.strictEqual(request.headers.get('x-bnh-header'), 'value, second');

  const redirect = Response.redirect('data:text/plain,redirected', 302);
  assert.strictEqual(redirect.status, 302);
  assert.strictEqual(redirect.headers.get('location'), 'data:text/plain,redirected');

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    fetch('data:text/plain,aborted', {signal: aborted.signal}),
    (error) => error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'),
  );

  assert.strictEqual(typeof WebSocket, 'function',
    'WebSocket requires a browser transport adapter; raw TCP is not a substitute');
  assert.strictEqual(WebSocket.OPEN, 1);
  assert.strictEqual(WebSocket.CLOSED, 3);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'''


_STREAMS_SOURCE = r'''const assert = require('node:assert');
const {Readable, Transform, Writable} = require('node:stream');

(async () => {
  const received = [];
  let writes = 0;
  const writable = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      writes += 1;
      received.push(chunk.toString());
      setTimeout(callback, 0);
    },
  });
  assert.strictEqual(writable.write('a'), false);
  await new Promise((resolve) => writable.once('drain', resolve));
  const readable = Readable.from(['b', 'c']);
  await new Promise((resolve, reject) => {
    writable.once('finish', resolve);
    writable.once('error', reject);
    readable.pipe(writable);
  });
  assert.deepStrictEqual(received, ['a', 'b', 'c']);
  assert.strictEqual(writes, 3);

  const transformed = Readable.from([1, 2, 3]).pipe(new Transform({
    objectMode: true,
    transform(value, encoding, callback) {
      callback(null, value * 2);
    },
  }));
  const values = [];
  for await (const value of transformed) values.push(value);
  assert.deepStrictEqual(values, [2, 4, 6]);

  const destroyed = new Readable({read() { this.push('one'); this.destroy(new Error('expected destroy')); }});
  await assert.rejects((async () => {
    for await (const ignored of destroyed) { /* consume until destroy */ }
  })(), /expected destroy/);
  assert.strictEqual(destroyed.destroyed, true);

  const failed = new Writable({write(chunk, encoding, callback) { callback(new Error('write failed')); }});
  await assert.rejects(new Promise((resolve, reject) => {
    failed.once('finish', resolve);
    failed.once('error', reject);
    failed.end('x');
  }), /write failed/);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'''


_WORKER_SOURCE = r'''const assert = require('node:assert');
const {
  Worker, MessageChannel, BroadcastChannel, isMainThread,
} = require('node:worker_threads');

assert.strictEqual(isMainThread, true);

(async () => {
  const workerSource = `
    const {parentPort} = require('node:worker_threads');
    parentPort.once('message', ({buffer, map}) => {
    parentPort.postMessage({
        kind: 'message',
        mapValue: map.get('value'),
        byteLength: buffer.byteLength,
      });
      setInterval(() => {}, 1000);
    });
  `;
  const worker = new Worker(workerSource, {eval: true});
  const buffer = new ArrayBuffer(8);
  const view = new Uint8Array(buffer);
  view[0] = 42;
  const result = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.postMessage({buffer, map: new Map([['value', 7]])}, [buffer]);
  });
  assert.deepStrictEqual(result, {kind: 'message', mapValue: 7, byteLength: 8});
  assert.strictEqual(buffer.byteLength, 0);
  assert.strictEqual(await worker.terminate(), 1);

  const channels = new MessageChannel();
  const channelMessage = new Promise((resolve) => channels.port1.once('message', resolve));
  channels.port2.postMessage({kind: 'channel', value: 9});
  assert.deepStrictEqual(await channelMessage, {kind: 'channel', value: 9});
  channels.port1.close();
  channels.port2.close();

  if (typeof BroadcastChannel === 'function') {
    const name = `bnh-broadcast-${Date.now()}`;
    const first = new BroadcastChannel(name);
    const second = new BroadcastChannel(name);
    const broadcast = new Promise((resolve) => second.onmessage = (event) => resolve(event.data));
    first.postMessage({kind: 'broadcast', value: 11});
    assert.deepStrictEqual(await broadcast, {kind: 'broadcast', value: 11});
    first.close();
    second.close();
  }

  if (typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object') {
    const shared = new SharedArrayBuffer(4);
    const cells = new Int32Array(shared);
    Atomics.store(cells, 0, 3);
    assert.strictEqual(Atomics.load(cells, 0), 3);
    assert.strictEqual(Atomics.add(cells, 0, 2), 3);
    assert.strictEqual(Atomics.load(cells, 0), 5);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'''


_SPECS = (
    ExpandedPrimitiveSpec(
        name="data-encoding-serialization",
        goal="Provide browser-native Buffer, encoding, structured clone, and serialization edge cases.",
        source=_DATA_SOURCE,
    ),
    ExpandedPrimitiveSpec(
        name="vfs-io",
        goal="Provide a coherent virtual filesystem with handles, directories, metadata, file URLs, watching, and cleanup.",
        source=_VFS_SOURCE,
        boundaries=(
            "The contract uses only the runtime's virtual filesystem; host filesystem access is out of scope.",
        ),
    ),
    ExpandedPrimitiveSpec(
        name="http-fetch",
        goal="Provide browser-native URL, Headers, Request, Response, fetch, redirect, and abort semantics.",
        source=_NETWORK_SOURCE,
        boundaries=(
            "Raw TCP, DNS sockets, and server-backed HTTP require a separate browser transport adapter.",
            "WebSocket is checked as a browser transport boundary; this contract does not open a host socket.",
        ),
    ),
    ExpandedPrimitiveSpec(
        name="streams-backpressure",
        goal="Provide readable, writable, transform, backpressure, error, destroy, and async-iteration semantics.",
        source=_STREAMS_SOURCE,
    ),
    ExpandedPrimitiveSpec(
        name="workers-communication",
        goal="Provide worker lifecycle, structured clone, transferables, message channels, broadcasts, and shared memory where browser-safe.",
        source=_WORKER_SOURCE,
        boundaries=(
            "Native child processes and host IPC are out of scope; communication must stay in browser worker primitives.",
        ),
    ),
)

_BY_NAME = {spec.name: spec for spec in _SPECS}
DEFAULT_NAMES = tuple(spec.name for spec in _SPECS)


def expanded_specs(names: tuple[str, ...] = DEFAULT_NAMES) -> tuple[ExpandedPrimitiveSpec, ...]:
    """Return the requested expanded contracts in caller-specified order."""

    unknown = [name for name in names if name not in _BY_NAME]
    if unknown:
        raise ValueError(f"unknown expanded primitive(s): {', '.join(unknown)}")
    return tuple(_BY_NAME[name] for name in names)


def expanded_tests(names: tuple[str, ...] = DEFAULT_NAMES) -> tuple[TestCase, ...]:
    """Create synthetic test cases whose source is entirely owned by this suite."""

    return tuple(
        TestCase(
            path=f".bnh/primitives/{spec.name}.js",
            suite="bnh-primitives-expanded",
            source_sha256=hashlib.sha256(spec.source.encode('utf-8')).hexdigest(),
            source_override=spec.source,
        )
        for spec in expanded_specs(names)
    )


def expanded_goal(path: str) -> str | None:
    """Return a contract goal for a synthetic expanded primitive path."""

    prefix = ".bnh/primitives/"
    if not path.startswith(prefix) or not path.endswith(".js"):
        return None
    spec = _BY_NAME.get(path[len(prefix) : -3])
    return None if spec is None else spec.goal


def expanded_boundaries(names: tuple[str, ...] = DEFAULT_NAMES) -> tuple[str, ...]:
    """Return explicit environment boundaries for documentation and scheduling."""

    return tuple(boundary for spec in expanded_specs(names) for boundary in spec.boundaries)
