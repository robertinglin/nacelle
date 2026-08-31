const MODULE_NAMES = Object.freeze([
  'sqlite',
  'zlib',
  'node_addon_napi',
]);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function addonError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function canonicalName(value) {
  const name = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return name === 'napi' ? 'nodeaddonnapi' : name;
}

function filename(value) {
  return String(value || '').split('/').pop() || '';
}

function artifactFor(manifest, moduleName) {
  const requested = canonicalName(moduleName);
  return manifest.artifacts.find((artifact) => (
    canonicalName(filename(artifact.wasm).replace(/\.wasm$/i, '')) === requested
  )) || manifest.artifacts.find((artifact) => (
    canonicalName(filename(artifact.node).replace(/\.node$/i, '')) === requested
  )) || manifest.artifacts.find((artifact) => canonicalName(artifact.entry) === requested);
}

function virtualArtifactPath(value) {
  const relative = String(value || '');
  if (!relative || relative.startsWith('/') || relative.includes('\\')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw addonError('ERR_NACELLE_WASM_MANIFEST', `Invalid virtual addon path ${JSON.stringify(value)}`);
  }
  return `/node/${relative}`;
}

async function sha256(bytes, globalObject) {
  const subtle = globalObject.crypto?.subtle || globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function responseBytes(response, kind, maxBytes, url) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw addonError('ERR_NACELLE_WASM_SIZE', `${kind} exceeds ${maxBytes} bytes`, { url });
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw addonError('ERR_NACELLE_WASM_SIZE', `${kind} exceeds ${maxBytes} bytes`, { url });
    }
    return bytes;
  }

  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw addonError('ERR_NACELLE_WASM_SIZE', `${kind} exceeds ${maxBytes} bytes`, { url });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createWasmAddonManager({
  baseUrl,
  profile,
  globalObject = globalThis,
  writeFile,
  execute,
}) {
  const resolvedBaseUrl = new URL(String(baseUrl), globalObject.location?.href || import.meta.url);
  if (!resolvedBaseUrl.pathname.endsWith('/')) resolvedBaseUrl.pathname += '/';
  resolvedBaseUrl.search = '';
  resolvedBaseUrl.hash = '';
  const fetchResource = globalObject.fetch?.bind(globalObject) || globalThis.fetch?.bind(globalThis);
  let manifestPromise;

  async function fetchBytes(url, kind, maxBytes) {
    if (!fetchResource) throw addonError('ERR_NACELLE_WASM_FETCH', 'fetch is unavailable for WASM artifacts', { url: url.href });
    let response;
    try {
      response = await fetchResource(url.href);
    } catch (cause) {
      throw addonError('ERR_NACELLE_WASM_FETCH', `Unable to fetch ${kind} from ${url.href}`, { cause, url: url.href });
    }
    if (!response.ok) {
      throw addonError('ERR_NACELLE_WASM_FETCH', `${kind} returned HTTP ${response.status}`, {
        status: response.status,
        url: url.href,
      });
    }
    try {
      return await responseBytes(response, kind, maxBytes, url.href);
    } catch (cause) {
      if (cause?.code) throw cause;
      throw addonError('ERR_NACELLE_WASM_FETCH', `Unable to read ${kind} from ${url.href}`, {
        cause,
        url: url.href,
      });
    }
  }

  async function manifest() {
    manifestPromise ||= (async () => {
      if (!['http:', 'https:'].includes(resolvedBaseUrl.protocol)) {
        throw addonError('ERR_NACELLE_WASM_URL', `WASM base URL must use HTTP(S): ${resolvedBaseUrl.href}`);
      }
      const url = new URL(profile.wasm.manifest, resolvedBaseUrl);
      const bytes = await fetchBytes(url, 'WASM manifest', MAX_MANIFEST_BYTES);
      let parsed;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch (cause) {
        throw addonError('ERR_NACELLE_WASM_MANIFEST', 'WASM manifest is not valid JSON', { cause, url: url.href });
      }
      if (parsed.node_version !== profile.id
        || parsed.reference_version !== profile.referenceVersion
        || String(parsed.abi?.modules) !== profile.versions.modules
        || String(parsed.abi?.napi) !== profile.versions.napi
        || !Array.isArray(parsed.artifacts)
        || parsed.artifacts.length === 0) {
        throw addonError('ERR_NACELLE_WASM_MANIFEST', `WASM manifest does not match ${profile.id}`, { url: url.href });
      }
      const wasmFiles = new Set();
      const virtualPaths = new Set();
      const artifacts = Object.freeze(parsed.artifacts.map((artifact) => {
        const wasmFilename = filename(artifact?.wasm);
        if (typeof artifact?.wasm !== 'string'
          || artifact.wasm !== `./${wasmFilename}`
          || !wasmFilename.endsWith('.wasm')
          || typeof artifact.node !== 'string'
          || typeof artifact.entry !== 'string'
          || !artifact.entry
          || (artifact.bytes !== undefined && (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0))
          || (artifact.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(artifact.sha256))) {
          throw addonError('ERR_NACELLE_WASM_MANIFEST', 'WASM manifest contains an invalid artifact', {
            url: url.href,
          });
        }
        virtualArtifactPath(artifact.node);
        if (wasmFiles.has(wasmFilename) || virtualPaths.has(artifact.node)) {
          throw addonError('ERR_NACELLE_WASM_MANIFEST', 'WASM manifest contains duplicate artifact mappings', {
            url: url.href,
          });
        }
        wasmFiles.add(wasmFilename);
        virtualPaths.add(artifact.node);
        return Object.freeze({ ...artifact });
      }));
      return Object.freeze({
        ...parsed,
        abi: Object.freeze({ ...parsed.abi }),
        artifacts,
      });
    })();
    return manifestPromise;
  }

  async function load(moduleName) {
    const currentManifest = await manifest();
    const artifact = artifactFor(currentManifest, moduleName);
    if (!artifact) {
      throw addonError('ERR_NACELLE_WASM_MODULE', `Unknown WASM addon ${JSON.stringify(moduleName)}`, {
        moduleName,
      });
    }
    const url = new URL(filename(artifact.wasm), resolvedBaseUrl);
    const bytes = await fetchBytes(url, `WASM addon ${moduleName}`, MAX_ARTIFACT_BYTES);
    if (artifact.bytes !== undefined && bytes.byteLength !== artifact.bytes) {
      throw addonError('ERR_NACELLE_WASM_INTEGRITY', `${url.href} does not match its declared byte length`, {
        actualBytes: bytes.byteLength,
        expectedBytes: artifact.bytes,
        url: url.href,
      });
    }
    if (artifact.sha256) {
      let digest;
      try {
        digest = await sha256(bytes, globalObject);
      } catch (cause) {
        throw addonError('ERR_NACELLE_WASM_INTEGRITY', 'WASM SHA-256 verification failed', {
          cause,
          url: url.href,
        });
      }
      if (!digest) {
        throw addonError('ERR_NACELLE_WASM_INTEGRITY', 'SHA-256 is unavailable for WASM integrity verification', {
          url: url.href,
        });
      }
      if (digest !== artifact.sha256) {
        throw addonError('ERR_NACELLE_WASM_INTEGRITY', `${url.href} failed its SHA-256 check`, { url: url.href });
      }
    }
    const WebAssemblyApi = globalObject.WebAssembly || globalThis.WebAssembly;
    if (!WebAssemblyApi?.validate(bytes)) {
      throw addonError('ERR_NACELLE_WASM_ARTIFACT', `${url.href} is not valid WebAssembly`, { url: url.href });
    }
    const path = virtualArtifactPath(artifact.node);
    await writeFile(path, bytes);
    return Object.freeze({
      module: String(moduleName),
      path,
      url: url.href,
      bytes: bytes.byteLength,
      entry: artifact.entry,
    });
  }

  async function probe(moduleName) {
    const artifact = await load(moduleName);
    // Loading proves the artifact is present and has passed its integrity
    // contract. Runtime wiring is intentionally tested by subsystem-specific
    // parity suites, never by a self-consistent artifact round trip.
    const code = `console.log(${JSON.stringify(JSON.stringify({ status: 'artifact-loaded', module: String(moduleName), path: artifact.path }))});`;
    const child = await execute(code);
    child.wasmArtifact = artifact;
    return child;
  }

  return Object.freeze({
    baseUrl: resolvedBaseUrl.href,
    list: () => [...MODULE_NAMES],
    manifest,
    load,
    probe,
  });
}
