const SHARED_BROWSER_FEATURES = Object.freeze({
  inspector: false,
  debug: false,
  uv: false,
  ipv6: true,
  openssl_is_boringssl: false,
  tls_alpn: true,
  tls_sni: true,
  tls_ocsp: true,
  tls: true,
  cached_builtins: false,
  require_module: true,
  typescript: 'strip',
});

export function defineNodeProfile(record, values) {
  const versions = Object.freeze({
    ...values.versions,
    node: record.referenceVersion,
  });
  const features = Object.freeze({ ...SHARED_BROWSER_FEATURES, ...values.features });
  const variables = Object.freeze({
    v8_enable_i18n_support: 1,
    openssl_quic: false,
    asan: 0,
    node_builtin_shareable_builtins: Object.freeze([]),
    node_module_version: Number(versions.modules),
    napi_build_version: versions.napi,
    node_use_amaro: true,
    node_shared_openssl: false,
    node_use_openssl: true,
  });
  return Object.freeze({
    ...record,
    runtimeVersion: `v${record.referenceVersion}`,
    release: Object.freeze({
      name: 'node',
      ...(record.codename ? { lts: record.codename } : {}),
      sourceUrl: `https://nodejs.org/download/release/v${record.referenceVersion}/node-v${record.referenceVersion}.tar.gz`,
      headersUrl: `https://nodejs.org/download/release/v${record.referenceVersion}/node-v${record.referenceVersion}-headers.tar.gz`,
    }),
    versions,
    features,
    config: Object.freeze({
      variables,
      target_defaults: Object.freeze({ default_configuration: 'Release' }),
    }),
    wasm: Object.freeze({
      directory: record.wasmDirectory,
      manifest: 'addon-manifest.json',
      modules: versions.modules,
      napi: versions.napi,
    }),
  });
}
