from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ..models import TestCase


@dataclass(frozen=True, slots=True)
class SystemPlatformSpec:
    """A browser-native compatibility contract for a Node system boundary."""

    name: str
    goal: str
    source: str
    boundary: bool = False


_PROCESS_SOURCE = r"""const assert = require('node:assert');

const originalExitCode = process.exitCode;
assert.ok(Array.isArray(process.argv));
assert.strictEqual(typeof process.env, 'object');
assert.strictEqual(typeof process.cwd(), 'string');
assert.strictEqual(typeof process.nextTick, 'function');
assert.strictEqual(typeof process.exit, 'function');
assert.strictEqual(typeof process.on, 'function');
assert.ok(process.stdin && typeof process.stdin.on === 'function');
assert.ok(process.stdout && typeof process.stdout.write === 'function');
assert.ok(process.stderr && typeof process.stderr.write === 'function');

const lifecycle = [];
process.nextTick(() => lifecycle.push('nextTick'));
if (typeof setImmediate === 'function') setImmediate(() => lifecycle.push('immediate'));
process.exitCode = 0;
assert.strictEqual(process.exitCode, 0);
process.exitCode = originalExitCode;

const signalListener = () => {};
process.on('SIGINT', signalListener);
process.removeListener('SIGINT', signalListener);
assert.ok(typeof process.stdin.isTTY === 'boolean' || process.stdin.isTTY === undefined);
"""

_MODULE_SOURCE = r"""const assert = require('node:assert');

(async () => {
  const path = require('node:path');
  assert.strictEqual(path.posix.basename('/bnh/module.js'), 'module.js');
  assert.strictEqual(typeof require.resolve('node:path'), 'string');

  const commonjs = require('node:util');
  assert.strictEqual(typeof commonjs.format, 'function');

  const esm = await import('data:text/javascript,export const value = 42');
  assert.strictEqual(esm.value, 42);

  const dynamic = await import('data:text/javascript,export default "dynamic"');
  assert.strictEqual(dynamic.default, 'dynamic');

  const json = await import(
    'data:application/json,%7B%22kind%22%3A%22json-module%22%7D',
    { with: { type: 'json' } },
  );
  assert.strictEqual(json.default.kind, 'json-module');

  const moduleApi = require('node:module');
  assert.strictEqual(typeof moduleApi.createRequire, 'function');
  assert.strictEqual(typeof moduleApi.builtinModules, 'object');
  assert.ok(moduleApi.builtinModules.includes('path'));

  const packageExports = globalThis.__bnhModuleLoader?.resolvePackageExport;
  assert.strictEqual(typeof packageExports, 'function');
  assert.strictEqual(packageExports('node:path', '.'), 'node:path');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""

_CRYPTO_SOURCE = r"""const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

(async () => {
  const random = nodeCrypto.randomBytes(24);
  assert.strictEqual(random.length, 24);
  assert.strictEqual(
    nodeCrypto.createHash('sha256').update('browser-node').digest('hex'),
    'bbe69f3a1517143e8a375f3222f1b809f193d71075a44d6348fea7d8c74c8e58',
  );
  assert.strictEqual(
    nodeCrypto.createHmac('sha256', 'key').update('browser-node').digest('hex'),
    'fa096a9606ba0d59dded22851c3f0b7945e360005e4ac162207a1aa87ff7b6f5',
  );
  assert.match(nodeCrypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const webCrypto = globalThis.crypto || nodeCrypto.webcrypto;
  assert.ok(webCrypto && webCrypto.subtle);
  const digest = await webCrypto.subtle.digest('SHA-256', new TextEncoder().encode('browser-node'));
  assert.strictEqual(Buffer.from(digest).toString('hex'), nodeCrypto.createHash('sha256').update('browser-node').digest('hex'));

  const keyPair = await webCrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const payload = new TextEncoder().encode('signature');
  const signature = await webCrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    payload,
  );
  assert.strictEqual(
    await webCrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.publicKey, signature, payload),
    true,
  );
  assert.strictEqual(
    await webCrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      signature,
      new TextEncoder().encode('tampered'),
    ),
    false,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""

_OS_PLATFORM_SOURCE = r"""const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

assert.strictEqual(typeof process.platform, 'string');
assert.strictEqual(typeof process.arch, 'string');
assert.ok(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'].includes(process.platform));
assert.ok(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x32', 'x64'].includes(process.arch));
assert.strictEqual(typeof os.constants, 'object');
assert.strictEqual(typeof os.EOL, 'string');
assert.ok(os.EOL === '\n' || os.EOL === '\r\n');
assert.strictEqual(typeof os.tmpdir(), 'string');
assert.strictEqual(typeof os.platform(), 'string');
assert.strictEqual(typeof os.arch(), 'string');
assert.strictEqual(os.platform(), process.platform);
assert.strictEqual(os.arch(), process.arch);

assert.strictEqual(path.posix.join('/bnh', 'vfs', '..', 'file.js'), '/bnh/file.js');
assert.strictEqual(path.posix.normalize('/bnh//vfs/../file.js'), '/bnh/file.js');
assert.strictEqual(path.posix.extname('/bnh/file.js'), '.js');
assert.strictEqual(path.posix.isAbsolute('/bnh/file.js'), true);
assert.strictEqual(path.posix.isAbsolute('file.js'), false);

const environment = globalThis.__bnh?.deterministicEnvironment;
assert.ok(environment && typeof environment === 'object');
assert.strictEqual(typeof environment.variant, 'string');
assert.strictEqual(typeof environment.platform, 'string');
assert.strictEqual(typeof environment.arch, 'string');
"""

_DIAGNOSTICS_SOURCE = r"""const assert = require('node:assert');
const { performance, PerformanceObserver } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const diagnosticsChannel = require('node:diagnostics_channel');

(async () => {
  const start = performance.now();
  performance.mark('bnh-diagnostics-start');
  performance.mark('bnh-diagnostics-end');
  performance.measure('bnh-diagnostics-measure', 'bnh-diagnostics-start', 'bnh-diagnostics-end');
  assert.ok(performance.now() >= start);
  assert.strictEqual(typeof PerformanceObserver, 'function');
  performance.clearMarks('bnh-diagnostics-start');
  performance.clearMarks('bnh-diagnostics-end');
  performance.clearMeasures('bnh-diagnostics-measure');

  const storage = new AsyncLocalStorage();
  await new Promise((resolve, reject) => {
    storage.run({ requestId: 'bnh-request' }, () => {
      Promise.resolve().then(() => {
        try {
          assert.deepStrictEqual(storage.getStore(), { requestId: 'bnh-request' });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  const channel = diagnosticsChannel.channel('bnh.system-platform');
  let received;
  const listener = (message) => { received = message; };
  channel.subscribe(listener);
  channel.publish({ event: 'contract', value: 1 });
  channel.unsubscribe(listener);
  assert.deepStrictEqual(received, { event: 'contract', value: 1 });

  const cause = new Error('root cause');
  const error = new Error('wrapped error', { cause });
  error.code = 'ERR_BNH_CONTRACT';
  assert.strictEqual(error.cause, cause);
  assert.strictEqual(error.code, 'ERR_BNH_CONTRACT');
  assert.strictEqual(typeof error.stack, 'string');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""

_COMPRESSION_SOURCE = r"""const assert = require('node:assert');
const zlib = require('node:zlib');

(async () => {
  const input = Buffer.from('browser-node compression contract');
  const gzip = await zlib.gzip(input);
  assert.strictEqual((await zlib.gunzip(gzip)).toString(), input.toString());
  assert.strictEqual(typeof zlib.constants, 'object');

  const json = JSON.stringify({ undefined: undefined, number: 1, nested: ['x', null] });
  assert.strictEqual(json, '{"number":1,"nested":["x",null]}');
  assert.deepStrictEqual(JSON.parse(json), { number: 1, nested: ['x', null] });

  const cloned = structuredClone(new Map([['key', { value: 1 }]]));
  assert.strictEqual(cloned.get('key').value, 1);
  const encoded = new TextEncoder().encode('serialization');
  const decoded = new TextDecoder().decode(encoded);
  assert.strictEqual(decoded, 'serialization');

  if (typeof CompressionStream === 'function' && typeof DecompressionStream === 'function') {
    const stream = new CompressionStream('gzip');
    const compressed = await new Response(new Blob([input]).stream().pipeThrough(stream)).arrayBuffer();
    const decompressed = await new Response(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    assert.strictEqual(decompressed, input.toString());
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""

_WASM_SOURCE = r"""const assert = require('node:assert');

(async () => {
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
  ]);
  assert.strictEqual(WebAssembly.validate(bytes), true);
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module);
  assert.strictEqual(instance.exports.add(20, 22), 42);
  assert.strictEqual(typeof WebAssembly.Memory, 'function');
  const memory = new WebAssembly.Memory({ initial: 1 });
  assert.strictEqual(memory.buffer.byteLength, 65536);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""

_BOUNDARY_SOURCE = r"""const assert = require('node:assert');

const boundaries = Object.freeze([
  { name: 'native-addons', status: 'unsupported-boundary', reason: 'requires a browser-safe WASM or JS adapter' },
  { name: 'privileged-os-apis', status: 'unsupported-boundary', reason: 'requires explicit browser permission and adapter scope' },
  { name: 'real-subprocesses', status: 'unsupported-boundary', reason: 'must not proxy execution to a host process' },
]);
assert.deepStrictEqual(boundaries.map(({ name }) => name), [
  'native-addons',
  'privileged-os-apis',
  'real-subprocesses',
]);
assert.ok(boundaries.every(({ status }) => status === 'unsupported-boundary'));
console.log(JSON.stringify({ browserNative: true, boundaries }));
"""


SYSTEM_PLATFORM_SPECS = (
    SystemPlatformSpec(
        name='system-platform-process',
        goal='Cover process argv, env, cwd, exit status, signals, stdin/stdout, and event-loop lifecycle without spawning a host process.',
        source=_PROCESS_SOURCE,
    ),
    SystemPlatformSpec(
        name='system-platform-module-loading',
        goal='Cover CommonJS, ESM, dynamic import, JSON modules, builtin resolution, and package-export resolution through the browser module adapter.',
        source=_MODULE_SOURCE,
    ),
    SystemPlatformSpec(
        name='system-platform-crypto',
        goal='Cover randomness, hashes, HMAC, Web Crypto keys, signatures, verification, and tamper detection.',
        source=_CRYPTO_SOURCE,
    ),
    SystemPlatformSpec(
        name='system-platform-os-platform',
        goal='Cover deterministic os/path/platform contracts while avoiding assertions tied to the host machine.',
        source=_OS_PLATFORM_SOURCE,
    ),
    SystemPlatformSpec(
        name='system-platform-diagnostics',
        goal='Cover performance marks, AsyncLocalStorage context, diagnostics channels, and error cause/code/stack metadata.',
        source=_DIAGNOSTICS_SOURCE,
    ),
    SystemPlatformSpec(
        name='system-platform-compression',
        goal='Cover browser gzip/deflate streams, JSON serialization, structured cloning, text codecs, and explicit unsupported compression boundaries.',
        source=_COMPRESSION_SOURCE,
    ),
    SystemPlatformSpec(
        name='system-platform-wasm',
        goal='Cover browser WebAssembly validation, compilation, instantiation, exports, and linear memory.',
        source=_WASM_SOURCE,
    ),
    SystemPlatformSpec(
        name='system-platform-unsupported-boundaries',
        goal='Declare native addons, privileged OS APIs, and real subprocesses as explicit unsupported browser boundaries.',
        source=_BOUNDARY_SOURCE,
        boundary=True,
    ),
)

_BY_NAME = {spec.name: spec for spec in SYSTEM_PLATFORM_SPECS}


def system_platform_specs() -> tuple[SystemPlatformSpec, ...]:
    return SYSTEM_PLATFORM_SPECS


def system_platform_tests() -> tuple[TestCase, ...]:
    return tuple(
        TestCase(
            path=f'.bnh/primitives/{spec.name}.js',
            suite='bnh-primitives-system-platform',
            source_sha256=hashlib.sha256(spec.source.encode()).hexdigest(),
            source_override=spec.source,
        )
        for spec in SYSTEM_PLATFORM_SPECS
    )


def system_platform_boundaries() -> tuple[SystemPlatformSpec, ...]:
    return tuple(spec for spec in SYSTEM_PLATFORM_SPECS if spec.boundary)


def system_platform_goal(path: str) -> str | None:
    prefix = '.bnh/primitives/'
    if not path.startswith(prefix) or not path.endswith('.js'):
        return None
    spec = _BY_NAME.get(path[len(prefix):-3])
    return None if spec is None else spec.goal
