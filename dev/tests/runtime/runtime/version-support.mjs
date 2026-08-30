import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Nacelle,
  createRuntime,
  listNodeVersionProfiles,
  listSupportedNodeVersions,
  nodeVersionAliases,
  resolveNodeVersionProfile,
  resolveNodeVersionRecord,
} from '../../../../src/index.js';
import { BROWSER_NAPI_VERSION } from '../../../../src/runtime/addon-napi.js';

const node22Versions = {
  acorn: '8.16.0',
  ada: '2.9.2',
  amaro: '1.1.8',
  ares: '1.34.6',
  brotli: '1.1.0',
  cjs_module_lexer: '2.2.0',
  cldr: '48.0',
  icu: '78.2',
  llhttp: '9.4.3',
  modules: '127',
  napi: '10',
  nbytes: '0.1.3',
  ncrypto: '0.0.1',
  nghttp2: '1.69.0',
  simdjson: '4.5.0',
  simdutf: '6.4.2',
  sqlite: '3.51.3',
  tz: '2026a',
  undici: '6.28.0',
  unicode: '17.0',
  uv: '1.51.0',
  uvwasi: '0.0.23',
  v8: '12.4.254.21-node.56',
  zlib: '1.3.1-e00f703',
  zstd: '1.5.7',
  node: '22.23.2',
};

test('alpha support registry exposes only Node 22 and stable aliases', () => {
  const records = listSupportedNodeVersions();
  assert.deepEqual(records.map(({ id }) => id), ['v22']);
  assert.equal(records[0].maturity, 'alpha');
  assert.deepEqual(nodeVersionAliases(), { latest: 'v22', lts: 'v22' });
  assert.equal(Nacelle.supportedVersions, records);
  assert.equal(Object.isFrozen(records), true);
  assert.equal(Object.isFrozen(records[0]), true);
  assert.equal(Object.isFrozen(nodeVersionAliases()), true);
});

test('Node 22 selectors normalize while unshipped versions fail deterministically', () => {
  for (const selector of [22, '22', '22.23.2', 'v22', 'n22', 'node22', 'node@22', 'latest', 'lts']) {
    assert.equal(resolveNodeVersionRecord(selector).id, 'v22');
    assert.equal(resolveNodeVersionProfile(selector).id, 'v22');
  }
  assert.equal(Nacelle.resolveVersion('latest').id, 'v22');
  for (const selector of ['current', 'v20', 'v24', 'not-a-version']) {
    assert.throws(
      () => resolveNodeVersionRecord(selector),
      (error) => error.code === 'ERR_NACELLE_UNSUPPORTED_NODE_VERSION'
        && error.requested === selector
        && error.supported.length === 1
        && error.supported[0] === 'v22',
    );
  }
});

test('Node 22 profile matches the native 22.23.2 metadata snapshot', () => {
  const [profile] = listNodeVersionProfiles();
  assert.equal(profile.runtimeVersion, 'v22.23.2');
  assert.deepEqual(profile.versions, node22Versions);
  assert.deepEqual(profile.release, {
    name: 'node',
    lts: 'Jod',
    sourceUrl: 'https://nodejs.org/download/release/v22.23.2/node-v22.23.2.tar.gz',
    headersUrl: 'https://nodejs.org/download/release/v22.23.2/node-v22.23.2-headers.tar.gz',
  });
  assert.equal(profile.config.variables.node_module_version, 127);
  assert.equal(profile.config.variables.napi_build_version, '10');
  assert.equal(Number(profile.versions.napi), BROWSER_NAPI_VERSION);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.versions), true);
});

test('runtime, process metadata, and shell agree on the selected Node 22 profile', async () => {
  const runtime = createRuntime({ globalObject: globalThis, nodeVersion: 'latest' });
  assert.equal(runtime.version, 'v22.23.2');
  assert.equal(runtime.profile.id, 'v22');
  assert.equal(runtime.wasmBaseUrl, './v22/wasm/');

  const node = await Nacelle.create({ version: 'n22', gateway: false });
  assert.equal(node.nodeProfile.id, 'v22');
  assert.equal(node.rawRuntime.profile, node.nodeProfile);

  const processResult = await node.execute(`
    process.stdout.write(JSON.stringify({
      version: process.version,
      node: process.versions.node,
      modules: process.versions.modules,
      napi: process.versions.napi,
      lts: process.release.lts,
      moduleVersion: process.config.variables.node_module_version,
      napiBuildVersion: process.config.variables.napi_build_version,
    }));
  `);
  assert.equal(await processResult.exit, 0);
  assert.deepEqual(JSON.parse(await processResult.stdoutText()), {
    version: 'v22.23.2',
    node: '22.23.2',
    modules: '127',
    napi: '10',
    lts: 'Jod',
    moduleVersion: 127,
    napiBuildVersion: '10',
  });

  const shellResult = await node.bash('node --version');
  assert.equal(await shellResult.exit, 0);
  assert.equal((await shellResult.stdoutText()).trim(), 'v22.23.2');
  await assert.rejects(Nacelle.create({ version: 'v24', gateway: false }), {
    code: 'ERR_NACELLE_UNSUPPORTED_NODE_VERSION',
  });
});
