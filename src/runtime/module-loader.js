import { posix } from './path.js';
import { fileURLToPath } from './vfs.js';
import { unsupportedNativeAddon } from './errors.js';
import { loadWasmAddon, isWasmModuleBytes } from './addon-napi.js';

const RESERVED_EXPORT_NAMES = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

const NATIVE_ADDON_EXTENSION = '.node';
const SYNC_HOOKS_WRAPPED = Symbol('bnhSyncHooksWrapped');
const REGISTERED_HOOKS = Symbol('bnhRegisteredHooks');
const RUNTIME_PROCESS_MARKER = Symbol.for('bnh.runtime-process');
const SCHEME_ONLY_BUILTIN_NAMES = new Set(['test', 'sea', 'sqlite', 'test/reporters']);
let nextLoaderId = 0;
const GENERATED_OBJECT_IMPORTERS = new WeakMap();

function normalize(value) {
  return posix.normalize(value).replace(/^\.\//, '');
}

function isValidExportName(value) {
  return /^[$A-Z_a-z][$\w]*$/.test(value) && !RESERVED_EXPORT_NAMES.has(value);
}

function hasEsmSyntax(source) {
  const stripped = String(source)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
  return /(?:^|[;\n])\s*(?:export\s+(?:default\b|(?:const|let|var|function|class)\b|[*{])|import\s*(?:(?:[^'";]*?from\s*)?['"]))/m.test(stripped);
}

function decodeStaticString(value) {
  return value
    .replace(/\\u\{([0-9a-f]+)\}/gi, (_, codePoint) => String.fromCodePoint(parseInt(codePoint, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, codePoint) => String.fromCharCode(parseInt(codePoint, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, codePoint) => String.fromCharCode(parseInt(codePoint, 16)))
    .replace(/\\([\\'"`])/g, '$1');
}

function stripHashbang(source) {
  return String(source).replace(/^#![^\r\n]*(?:\r\n|\n|$)/, (hashbang) => (
    hashbang.endsWith('\n') ? '\n' : ''
  ));
}

// Node packages occasionally detect an ES class called without `new` by
// matching V8's TypeError wording. Browser engines use different wording for
// the same semantic error, so keep the Node-compatible spelling plus the
// portable browser spelling in package source loaded by the runtime.
function normalizeNodeClassCallErrorPatterns(source) {
  return String(source).replace(
    /\/Class constructor \.\* cannot be invoked without 'new'\/([dgimsuvy]*)/g,
    (_, flags) => `/Class constructor .* cannot be invoked without 'new'|class constructors must be invoked with 'new'/${flags}`,
  );
}

function stripPathIdentity(path) {
  const value = String(path);
  const query = value.indexOf('?');
  const hash = value.indexOf('#');
  const end = query < 0 ? hash : hash < 0 ? query : Math.min(query, hash);
  return end < 0 ? value : value.slice(0, end);
}

function isWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF || Number.isNaN(next)) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function cjsExportMetadata(source) {
  const names = [];
  const reexports = [];
  const addName = (name) => {
    if (typeof name === 'string' && isWellFormedString(name) && !names.includes(name)) names.push(name);
  };
  const addReexport = (specifier) => {
    if (typeof specifier === 'string' && !reexports.includes(specifier)) reexports.push(specifier);
  };

  if (hasEsmSyntax(source)) return { names, reexports, esmSyntax: true };

  const propertyPattern = /\b(?:exports|module\.exports)\s*\.\s*([$_\p{ID_Start}][$_\p{ID_Continue}]*)/gu;
  for (const match of source.matchAll(propertyPattern)) addName(match[1]);
  const bracketPattern = /\b(?:exports|module\.exports)\s*\[\s*(['"])(.*?)\1\s*\]/gs;
  for (const match of source.matchAll(bracketPattern)) addName(decodeStaticString(match[2]));
  const definePropertyPattern = /Object\.defineProperty\(\s*exports\s*,\s*(['"])(.*?)\1/g;
  for (const match of source.matchAll(definePropertyPattern)) addName(decodeStaticString(match[2]));

  const objectAssignment = /\bmodule\.exports\s*=\s*\{([\s\S]*?)\}/g;
  for (const match of source.matchAll(objectAssignment)) {
    const propertyPattern = /(?:^|,)\s*(?:(['"])(.*?)\1|([$_\p{ID_Start}][$_\p{ID_Continue}]*)|([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*:)/gu;
    for (const property of match[1].matchAll(propertyPattern)) {
      addName(property[2] === undefined ? property[3] || property[4] : decodeStaticString(property[2]));
    }
  }

  const moduleAssignmentPattern = /\bmodule\.exports\s*=\s*require\(\s*(['"])(.*?)\1\s*\)/g;
  for (const match of source.matchAll(moduleAssignmentPattern)) addReexport(match[2]);
  const exportStarPattern = /\b__exportStar\(\s*require\(\s*(['"])(.*?)\1\s*\)\s*,\s*exports\s*\)/g;
  for (const match of source.matchAll(exportStarPattern)) addReexport(match[2]);
  const requiredBindings = new Map();
  const requirePattern = /\b(?:var|let|const)\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*=\s*require\(\s*(['"])(.*?)\2\s*\)/gu;
  for (const match of source.matchAll(requirePattern)) requiredBindings.set(match[1], match[3]);
  const objectKeysPattern = /Object\.keys\(\s*([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*\)/gu;
  for (const match of source.matchAll(objectKeysPattern)) addReexport(requiredBindings.get(match[1]));
  return { names, reexports, esmSyntax: false };
}

function synchronousEsmSource(source) {
  let transformed = String(source);
  transformed = transformed.replace(
    /(^|[;\n])\s*export\s+(const|let|var)\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*=\s*([^;\n]+);?/gu,
    (_, prefix, declaration, name, value) => `${prefix}${declaration} ${name} = ${value};\nexports[${quote(name)}] = ${name};`,
  );
  return transformed;
}

function wrapSynchronousLoadHook(moduleApi) {
  if (!moduleApi || typeof moduleApi.registerHooks !== 'function') return [];
  if (moduleApi[SYNC_HOOKS_WRAPPED]) return moduleApi[REGISTERED_HOOKS] || [];
  const registerHooks = moduleApi.registerHooks;
  const hooksRegistry = [];
  const normalizeResult = (result) => {
    if (!result || typeof result !== 'object' || result.source === undefined) return result;
    const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
    if (!hasEsmSyntax(source)) return result;
    return { ...result, source: synchronousEsmSource(source) };
  };
  const wrapped = (hooks = {}) => {
    hooksRegistry.push(hooks);
    return registerHooks({
      ...hooks,
    load: typeof hooks.load === 'function'
      ? (url, context, nextLoad) => normalizeResult(hooks.load(url, context, (nextURL, nextContext) => (
        normalizeResult(nextLoad(nextURL, nextContext))
      )))
      : hooks.load,
    });
  };
  Object.defineProperty(moduleApi, 'registerHooks', { configurable: true, value: wrapped });
  Object.defineProperty(moduleApi, SYNC_HOOKS_WRAPPED, { configurable: true, value: true });
  Object.defineProperty(moduleApi, REGISTERED_HOOKS, { configurable: true, value: hooksRegistry });
  return hooksRegistry;
}

function quote(value) {
  return JSON.stringify(value);
}

function isPathSpecifier(value) {
  return value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../') || value.startsWith('/');
}

function fileCandidates(base) {
  return [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.json`,
    `${base}${NATIVE_ADDON_EXTENSION}`,
  ];
}

function commonJsFileCandidates(base) {
  return [base, `${base}.js`, `${base}.json`, `${base}${NATIVE_ADDON_EXTENSION}`];
}

function directoryCandidates(base) {
  return [
    posix.join(base, 'index.js'),
    posix.join(base, 'index.cjs'),
    posix.join(base, 'index.mjs'),
    posix.join(base, 'index.json'),
    posix.join(base, `index${NATIVE_ADDON_EXTENSION}`),
  ];
}

function commonJsDirectoryCandidates(base) {
  return [
    posix.join(base, 'index.js'),
    posix.join(base, 'index.json'),
    posix.join(base, `index${NATIVE_ADDON_EXTENSION}`),
  ];
}

function nativeAddonModuleSource(path) {
  const message = `Cannot load native addon '${path}': native addons are unavailable in the browser runtime`;
  return [
    `const error = new Error(${quote(message)});`,
    `error.name = 'Error';`,
    `error.code = 'ERR_DLOPEN_FAILED';`,
    `error.path = ${quote(path)};`,
    `error.boundary = 'native-addons';`,
    `error.status = 'unsupported-boundary';`,
    `error.reason = 'requires a browser-safe WASM or JavaScript adapter';`,
    'throw error;',
  ].join('\n');
}

function missingModuleSource(path) {
  return [
    `const error = new Error(${quote(`Cannot find module '${path}'`)});`,
    `error.code = 'MODULE_NOT_FOUND';`,
    `error.path = ${quote(path)};`,
    'throw error;',
  ].join('\n');
}

function encodeModuleSource(source) {
  // Slashes are valid in a data URL payload. Keeping them readable preserves
  // the VFS path in sourceURL comments instead of turning it into %2F segments.
  return encodeURIComponent(source).replace(/%2F/gi, '/');
}

function eventsOnce(emitter, eventName, options = {}) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      reject(error);
    };
    const cleanup = () => {
      emitter.removeListener?.(eventName, onEvent);
      if (eventName !== 'error') emitter.removeListener?.('error', onError);
      options.signal?.removeEventListener?.('abort', onAbort);
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    emitter.once(eventName, onEvent);
    if (eventName !== 'error') emitter.once('error', onError);
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Resolve and execute modules from the browser VFS.
 *
 * CommonJS remains synchronous. ESM is handed to the browser's native module
 * evaluator after its VFS specifiers have been converted to data-module URLs.
 * This preserves real ESM parsing (including top-level await) without giving
 * the browser a host filesystem URL to resolve.
 */
export function createModuleLoader({
  files,
  builtins,
  globalObject = globalThis,
  evaluateCommonJS,
  resolveBuiltin,
  runModuleHook: sharedRunModuleHook,
  readSource,
  fileVersion,
  fetchModule,
  defaultModuleType = 'commonjs',
  stripTypeScript,
} = {}) {
  const registeredHooks = sharedRunModuleHook ? [] : wrapSynchronousLoadHook(builtins?.module);
  const cache = Object.create(null);
  const moduleURLs = new Map();
  const buildingModuleKeys = new Set();
  const importCache = new Map();
  // Native dynamic imports from one module are prepared in request order,
  // even though their evaluations may overlap.  This matters to runners
  // such as tap that register tests from a series of unawaited imports: the
  // browser evaluator must see the same module-job order as Node.
  const dynamicImportLanes = new Map();
  const dynamicImportHandoffs = new WeakMap();
  const dynamicImportHandoffIdleTurns = 64;
  const nativeSpecifierHints = new Map();
  const cycleModuleURLs = new Map();
  const cycleRegistrations = new Map();
  const cycleReexportURLs = new Map();
  const builtinEsmSyncers = new Set();
  const syncBuiltinESMExports = () => {
    for (const sync of builtinEsmSyncers) sync();
  };
  let mainModule = null;
  let moduleSequence = 0;
  const registryName = `__bnhEsmRegistry_${Date.now()}_${nextLoaderId++}_${moduleSequence++}`;
  const registry = Object.create(null);
  const generatedObjectURLs = new Set();
  // Browser-native module evaluation reports a generated Blob URL as the
  // parent of imports that escape the source rewrite boundary. Keep the
  // virtual path that produced each Blob so those imports still resolve in
  // the VFS rather than being interpreted as browser URL paths.
  let generatedObjectImporters = GENERATED_OBJECT_IMPORTERS.get(globalObject);
  if (!generatedObjectImporters) {
    generatedObjectImporters = new Map();
    GENERATED_OBJECT_IMPORTERS.set(globalObject, generatedObjectImporters);
  }
  // The Node-compatible stack adapter uses this same ownership table to map
  // browser Blob call sites back to the VFS file that produced them. Keep it
  // off the enumerable global surface because it is an implementation detail.
  let blobVirtualPaths = globalObject?.__BNH_BLOB_VIRTUAL_PATHS__;
  if (!(blobVirtualPaths instanceof Map)) {
    blobVirtualPaths = new Map();
    try {
      Object.defineProperty(globalObject, '__BNH_BLOB_VIRTUAL_PATHS__', {
        configurable: true,
        enumerable: false,
        value: blobVirtualPaths,
        writable: true,
      });
    } catch {
      try { globalObject.__BNH_BLOB_VIRTUAL_PATHS__ = blobVirtualPaths; } catch { /* best effort */ }
    }
  }
  globalObject[registryName] = registry;

  const generatedModuleURL = (source, fragment, importer = null) => {
    const URLClass = globalObject?.URL;
    const BlobClass = globalObject?.Blob;
    const browserLocation = globalObject?.location;
    const browserRuntime = typeof browserLocation?.href === 'string'
      && /^(?:https?:|blob:)/i.test(browserLocation.href);
    if (browserRuntime && typeof URLClass?.createObjectURL === 'function' && typeof BlobClass === 'function') {
      try {
        const objectURL = URLClass.createObjectURL(new BlobClass([source], { type: 'text/javascript' }));
        generatedObjectURLs.add(objectURL);
        if (importer) {
          generatedObjectImporters.set(objectURL, importer);
          blobVirtualPaths.set(objectURL, importer);
        }
        return `${objectURL}#${fragment}`;
      } catch {
        // Some embedders expose URL but not a Blob implementation accepted by
        // createObjectURL. Preserve the portable data-URL fallback there.
      }
    }
    return `data:text/javascript;charset=utf-8,${encodeModuleSource(source)}#${fragment}`;
  };

  const hasFile = (path) => {
    // A package pattern keeps repeated separators in its substituted target.
    // The VFS intentionally normalizes ordinary filesystem paths, so guard
    // this resolver boundary before delegating to it; otherwise a missing
    // `sub//internal/test` target aliases an existing `sub/internal/test.js`.
    const filesystemPath = typeof path === 'string' && path.startsWith('/')
      ? stripPathIdentity(path)
      : path;
    if (typeof filesystemPath === 'string' && filesystemPath.startsWith('/') && filesystemPath.includes('//')) return false;
    return typeof files?.has === 'function'
      ? files.has(filesystemPath)
      : Object.hasOwn(files || {}, filesystemPath);
  };
  const readFile = (path) => {
    const filesystemPath = typeof path === 'string' && path.startsWith('/')
      ? stripPathIdentity(path)
      : path;
    return typeof files?.get === 'function' ? files.get(filesystemPath) : files[filesystemPath];
  };
  // Textual module reads can use the VFS source cache, while binary module
  // formats continue through the byte-oriented files seam below.
  const readTextFile = (path) => {
    const filesystemPath = typeof path === 'string' && path.startsWith('/')
      ? stripPathIdentity(path)
      : path;
    return typeof readSource === 'function' ? readSource(filesystemPath) : readFile(filesystemPath);
  };
  const fetchRemoteModule = async (url, context = {}) => {
    if (typeof fetchModule !== 'function') {
      const error = new Error(`No fetch capability is registered for ${url}`);
      error.code = 'ERR_UNSUPPORTED_ESM_URL_SCHEME';
      throw error;
    }
    const response = await fetchModule(url);
    if (!response?.ok) {
      const error = new Error(`Failed to fetch module '${url}'`);
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw error;
    }
    return {
      format: context.format || 'module',
      source: await response.text(),
    };
  };
  const hasBuiltin = (specifier) => {
    const raw = String(specifier);
    const name = builtinName(raw);
    if (SCHEME_ONLY_BUILTIN_NAMES.has(name) && !raw.startsWith('node:')) return false;
    return Object.prototype.hasOwnProperty.call(builtins || {}, name)
      || Object.prototype.hasOwnProperty.call(builtins || {}, `node:${name}`);
  };
  const builtinName = (specifier) => String(specifier).startsWith('node:')
    ? String(specifier).slice(5)
    : String(specifier);
  const processIds = new WeakMap();
  let nextProcessId = 1;
  const processKey = (processOverride) => {
    if (!processOverride || (typeof processOverride !== 'object' && typeof processOverride !== 'function')) return '';
    let id = processIds.get(processOverride);
    if (id === undefined) {
      id = nextProcessId++;
      processIds.set(processOverride, id);
    }
    return `-process-${id}`;
  };
  const cacheKey = (resolved, processOverride) => `${resolved}\u0000${processKey(processOverride)}`;
  const cycleReexportKey = (importer, specifier, processOverride) => (
    `${cacheKey(importer, processOverride)}\u0000${specifier}`
  );
  const sharedNamespace = (resolved, processOverride) => {
    const entry = globalObject.__BNH_ESM_NAMESPACE_CACHE__?.get?.(resolved);
    if (entry instanceof Map) return entry.get(processOverride || null);
    return processOverride ? undefined : entry;
  };
  const storeSharedNamespace = (resolved, processOverride, namespace) => {
    const namespaceCache = globalObject.__BNH_ESM_NAMESPACE_CACHE__;
    if (!namespaceCache?.set) return;
    const entry = namespaceCache.get(resolved);
    if (entry instanceof Map) {
      entry.set(processOverride || null, namespace);
      return;
    }
    if (!processOverride) {
      namespaceCache.set(resolved, namespace);
      return;
    }
    const perProcess = new Map();
    if (entry !== undefined) perProcess.set(null, entry);
    perProcess.set(processOverride, namespace);
    namespaceCache.set(resolved, perProcess);
  };
  const builtin = (specifier, processOverride) => {
    const name = builtinName(specifier);
    if (!hasBuiltin(specifier)) return undefined;
    const overridden = resolveBuiltin?.(name, processOverride);
    if (overridden !== undefined) return overridden;
    return builtins[name] ?? builtins[`node:${name}`];
  };
  const isBuiltinSpecifier = (specifier) => hasBuiltin(specifier);

  const fileURL = (path) => `file://${path}`;
  const importMetaURL = (importer) => (
    importer.startsWith('data:') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(importer)
      ? importer
      : fileURL(importer)
  );
  const importMetaObject = (importer) => `({ url: ${quote(importMetaURL(importer))} })`;
  const hookContext = (specifier, importer, conditions = ['node', 'import']) => ({
    conditions,
    importAttributes: {},
    parentURL: importer.startsWith('data:') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(importer)
      ? importer : fileURL(importer),
    source: specifier,
  });

  const defaultResolve = (specifier, importer, conditions = ['node', 'import']) => {
    const resolved = resolve(specifier, importer, conditions);
    // Node's default ESM resolver rejects a missing file before the load
    // phase and exposes the file URL on ERR_MODULE_NOT_FOUND. A resolve hook
    // can use that error to map a source spelling such as `./entry.js` to an
    // existing TypeScript file; returning the missing path would skip that
    // hook opportunity and turn the later load into an opaque VFS ENOENT.
    if (resolved.startsWith('/') && !hasFile(resolved)) {
      const error = packageError(
        'ERR_MODULE_NOT_FOUND',
        `Cannot find module '${resolved}' imported from '${importer}'`,
      );
      error.url = fileURL(resolved);
      throw error;
    }
    return {
      url: isBuiltinSpecifier(resolved) || resolved.startsWith('node:')
        ? `node:${builtinName(resolved)}`
        : resolved.startsWith('data:') || resolved.startsWith('http:') || resolved.startsWith('https:')
          ? resolved : fileURL(resolved),
      format: isBuiltinSpecifier(resolved)
        ? 'builtin'
        : resolved.startsWith('data:') ? 'module'
        : resolved.endsWith('.json') ? 'json' : moduleFormatForHook(resolved),
    };
  };

  const runResolveHooks = (specifier, importer, conditions = ['node', 'import'], processOverride) => {
    const context = hookContext(specifier, importer, conditions);
    const fallback = (nextSpecifier, nextContext) => defaultResolve(
      nextSpecifier,
      nextContext?.parentURL?.startsWith('file:')
        ? fileURLToPath(nextContext.parentURL)
      : importer,
      nextContext?.conditions || ['node', 'import'],
    );
    const resolveFallback = (nextSpecifier, nextContext) => (
      tapmockFallback(nextSpecifier, nextContext?.parentURL) || fallback(nextSpecifier, nextContext)
    );
    if (sharedRunModuleHook) {
      const result = sharedRunModuleHook('resolve', specifier, context, resolveFallback, processOverride);
      return tapmockFallback(specifier, context.parentURL) || result;
    }
    let next = resolveFallback;
    for (let index = registeredHooks.length - 1; index >= 0; index -= 1) {
      const hook = registeredHooks[index]?.resolve;
      if (typeof hook !== 'function') continue;
      const previous = next;
      next = (nextSpecifier, nextContext) => hook(nextSpecifier, nextContext, previous);
    }
    const result = next(specifier, context);
    const tapmockResult = tapmockFallback(specifier, context.parentURL);
    if (tapmockResult) return tapmockResult;
    if (!result || typeof result !== 'object' || typeof result.url !== 'string') {
      throw new TypeError('module resolve hook must return an object with a string url');
    }
    return result;
  };

  const runResolveHooksAsync = async (specifier, importer, conditions = ['node', 'import'], processOverride) => {
    if (!sharedRunModuleHook) return runResolveHooks(specifier, importer, conditions, processOverride);
    const context = hookContext(specifier, importer, conditions);
    const fallback = (nextSpecifier, nextContext) => defaultResolve(
      nextSpecifier,
      nextContext?.parentURL?.startsWith('file:')
        ? fileURLToPath(nextContext.parentURL)
        : importer,
      nextContext?.conditions || ['node', 'import'],
    );
    const resolveFallback = (nextSpecifier, nextContext) => (
      tapmockFallback(nextSpecifier, nextContext?.parentURL) || fallback(nextSpecifier, nextContext)
    );
    const result = await sharedRunModuleHook('resolve', specifier, context, resolveFallback, processOverride);
    const tapmockResult = tapmockFallback(specifier, context.parentURL);
    if (tapmockResult) return tapmockResult;
    if (!result || typeof result !== 'object' || typeof result.url !== 'string') {
      throw new TypeError('module resolve hook must return an object with a string url');
    }
    return result;
  };

  const defaultLoad = (url, context = {}) => {
    if (url.startsWith('node:')) return { format: 'builtin', source: null };
    if (url.startsWith('data:')) return { format: 'module', source: null };
    if (url.startsWith('http:') || url.startsWith('https:')) return fetchRemoteModule(url, context);
    const resolved = url.startsWith('file:') ? fileURLToPath(url) : url;
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved)) unsupportedNativeAddon(resolved);
    const value = read(resolved, resolved).value;
    // Node's default ESM loader exposes file source as a Buffer: it is still
    // the raw byte source, but its standard toString() decodes UTF-8.  Keep
    // that representation for load hooks.  A plain Uint8Array has different
    // public behavior (comma-joined numeric output), which breaks otherwise
    // Node-compatible hooks that consume result.source.toString().
    const source = value === undefined || value === null
      ? value
      : builtins?.buffer?.Buffer?.from
        ? builtins.buffer.Buffer.from(value)
        : value;
    return {
      format: context?.format ?? (resolved.endsWith('.json') ? 'json' : moduleFormat(resolved)),
      source,
    };
  };

  const runLoadHooks = (resolved, format, processOverride) => {
    const url = format === 'builtin'
      ? `node:${builtinName(resolved)}`
      : resolved.startsWith('custom-') ? resolved
      : resolved.startsWith('data:') ? resolved : fileURL(resolved);
    const context = {
      format,
      conditions: ['node', 'import'],
      importAttributes: {},
      parentURL: fileURL(resolved),
    };
    if (sharedRunModuleHook) {
      const result = sharedRunModuleHook('load', url, context, (nextURL, nextContext) => defaultLoad(nextURL, nextContext), processOverride);
      if (!result || typeof result !== 'object') throw new TypeError('module load hook must return an object');
      return { ...result, url: result.url || url };
    }
    let next = (nextURL, nextContext) => defaultLoad(nextURL, nextContext);
    for (let index = registeredHooks.length - 1; index >= 0; index -= 1) {
      const hook = registeredHooks[index]?.load;
      if (typeof hook !== 'function') continue;
      const previous = next;
      next = (nextURL, nextContext) => hook(nextURL, nextContext, previous);
    }
    const result = next(url, context);
    if (!result || typeof result !== 'object') throw new TypeError('module load hook must return an object');
    if (result.source === undefined && result.format !== 'builtin' && !result.shortCircuit) {
      return { ...defaultLoad(result.url || url, result), ...result };
    }
    return { ...result, url: result.url || url };
  };

  // tap's mock loader identifies a mock service by putting `tapmock=...` on
  // the importing module URL. A resolve hook is allowed to return a fresh
  // file URL for an ordinary child, but that child still belongs to the same
  // mock graph. Preserve the service identity at this boundary so a
  // transitive import cannot accidentally fall back to the shared module
  // cache or the unmocked VFS source.
  const inheritTapmockIdentity = (resolved, importer) => {
    if (typeof resolved !== 'string' || typeof importer !== 'string') return resolved;
    let parentURL;
    try {
      parentURL = new URL(importer.startsWith('file:') ? importer : fileURL(importer));
    } catch {
      return resolved;
    }
    const identity = parentURL.searchParams.get('tapmock');
    if (!identity || resolved.startsWith('tapmock:')) return resolved;
    let childURL;
    try {
      childURL = new URL(resolved.startsWith('file:') ? resolved : fileURL(resolved));
    } catch {
      return resolved;
    }
    if (childURL.protocol !== 'file:' || childURL.searchParams.has('tapmock')) return resolved;
    childURL.searchParams.set('tapmock', identity);
    return `${fileURLToPath(String(childURL))}${childURL.search}${childURL.hash}`;
  };

  const hookURLToSpecifier = (url, importer = null) => {
    if (url.startsWith('file:')) {
      // Queries are part of Node's module identity. tap's mock loader uses a
      // `?tapmock=...` query to force each mock service to get a fresh module
      // instance. Keep that identity when crossing the file-URL boundary;
      // VFS reads strip it at the filesystem seam above.
      const parsed = new URL(url);
      return inheritTapmockIdentity(
        `${fileURLToPath(url)}${parsed.search}${parsed.hash}`,
        importer,
      );
    }
    if (url.startsWith('node:')) return url;
    return inheritTapmockIdentity(url, importer);
  };

  // The published tap mock hook can delegate a transitive builtin to the
  // next resolver after its service has already established a mock graph.
  // Node's loader keeps that graph identity on the parent URL, so recover an
  // explicitly mapped mock at the fallback seam before normal builtin
  // resolution turns it into node:fs (or another real builtin).
  const tapmockFallback = (specifier, parentURL) => {
    if (typeof specifier !== 'string' || typeof parentURL !== 'string') return undefined;
    let parent;
    try {
      parent = new URL(parentURL);
    } catch {
      return undefined;
    }
    const identity = parent.searchParams.get('tapmock');
    if (!identity) return undefined;
    const separator = identity.indexOf('.');
    if (separator <= 0 || separator === identity.length - 1) return undefined;
    const serviceKey = identity.slice(0, separator);
    const instanceKey = identity.slice(separator + 1);
    const service = globalObject[Symbol.for(`__tapmock${serviceKey}$${instanceKey}`)];
    if (!service?.mocks || typeof service.mocks !== 'object') return undefined;
    let mockURL = specifier;
    if (!Object.prototype.hasOwnProperty.call(service.mocks, mockURL)) {
      try {
        if (isPathSpecifier(specifier)) mockURL = String(new URL(specifier, parent));
      } catch {
        return undefined;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(service.mocks, mockURL)) return undefined;
    const mock = new URL(`tapmock://${identity}/`);
    mock.searchParams.set('url', mockURL);
    return { url: String(mock), format: 'module', shortCircuit: true };
  };

  const tapmockLoad = (resolved) => {
    if (typeof resolved !== 'string' || !resolved.startsWith('tapmock:')) return undefined;
    let parsed;
    try {
      parsed = new URL(resolved);
    } catch {
      return undefined;
    }
    const identity = parsed.host;
    const separator = identity.indexOf('.');
    if (separator <= 0 || separator === identity.length - 1) return undefined;
    const service = globalObject[Symbol.for(`__tapmock${identity.slice(0, separator)}$${identity.slice(separator + 1)}`)];
    if (!service || typeof service.load !== 'function') return undefined;
    const source = service.load({ action: 'load', url: resolved });
    return source === undefined ? undefined : { format: 'module', source, url: resolved };
  };

  const sourceText = (value) => {
    if (typeof value === 'string') return value;
    // Async loader hooks can receive raw Buffer-like values from another
    // realm. Copy the byte view into this realm before decoding so browser
    // TextDecoder implementations accept SharedArrayBuffer-backed and
    // cross-realm sources consistently.
    let bytes;
    try {
      if (value && typeof value === 'object' && value.buffer !== undefined
          && typeof value.byteLength === 'number') {
        bytes = new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
      } else {
        bytes = new Uint8Array(value);
      }
    } catch {
      bytes = Uint8Array.from(value);
    }
    return new TextDecoder().decode(Uint8Array.from(bytes));
  };

  const packageConfigCache = new Map();
  // npm's .bin directory contains executable shims rather than package
  // modules. Its owning project package scope remains relevant when a shim
  // is an extensionless ESM entry point.
  const isNpmBinShimPath = (pathname) => /\/node_modules\/\.bin(?:\/|$)/.test(String(pathname));

  const packageConfig = (base) => {
    const packagePath = posix.join(base, 'package.json');
    if (!hasFile(packagePath)) return undefined;
    const version = fileVersion?.(packagePath);
    const cached = packageConfigCache.get(packagePath);
    if (version !== undefined && cached?.version === version) return cached.config;
    try {
      const source = sourceText(readTextFile(packagePath));
      if (cached?.source === source) return cached.config;
      const config = JSON.parse(source);
      packageConfigCache.set(packagePath, { version, source, config });
      return config;
    } catch (cause) {
      const error = new Error(`Invalid package config '${packagePath}'`);
      error.code = 'ERR_INVALID_PACKAGE_CONFIG';
      error.path = packagePath;
      error.cause = cause;
      throw error;
    }
  };

  const packageScopeType = (resolved) => {
    let directory = posix.dirname(resolved);
    while (true) {
      if (directory.endsWith('/node_modules') && !isNpmBinShimPath(resolved)) return undefined;
      const config = packageConfig(directory);
      if (config !== undefined) {
        if (config.type === 'module' || config.type === 'commonjs') return config.type;
        return 'untyped';
      }
      if (directory === '/' || directory === '.' || directory === '') return undefined;
      directory = posix.dirname(directory);
    }
  };

  const moduleFormat = (resolved) => {
    const filesystemPath = stripPathIdentity(resolved);
    if (filesystemPath.endsWith('.mjs')) return 'module';
    if (filesystemPath.endsWith('.cjs')) return 'commonjs';
    const extension = posix.extname(filesystemPath);
    if (extension === '.mts') {
      if (typeof stripTypeScript !== 'function') throw packageError(
        'ERR_UNKNOWN_FILE_EXTENSION',
        `Unknown file extension \"${extension}\" for ${resolved}`,
      );
      return 'module';
    }
    if (extension === '.cts') {
      if (typeof stripTypeScript !== 'function') throw packageError(
        'ERR_UNKNOWN_FILE_EXTENSION',
        `Unknown file extension \"${extension}\" for ${resolved}`,
      );
      return 'commonjs';
    }
    if (extension === '.ts') {
      if (typeof stripTypeScript !== 'function') throw packageError(
        'ERR_UNKNOWN_FILE_EXTENSION',
        `Unknown file extension \"${extension}\" for ${resolved}`,
      );
      // Node's native type stripping follows the surrounding module graph for
      // .ts. Source-tree tests commonly import ESM-flavoured .ts from .mjs;
      // classify this extension as ESM so the stripped source keeps its
      // imports/exports intact.
      return 'module';
    }
    if (extension && !['.js', '.json', '.node'].includes(extension)) {
      throw packageError(
        'ERR_UNKNOWN_FILE_EXTENSION',
        `Unknown file extension "${extension}" for ${resolved}`,
      );
    }
    const type = packageScopeType(filesystemPath);
    if (type === 'module' || type === 'commonjs') return type;
    if (resolved.includes('/node_modules/')) return 'commonjs';
    if (defaultModuleType === 'module') return 'module';
    return 'commonjs';
  };

  // A custom ESM loader may intentionally handle an otherwise unknown file
  // extension (for example a TypeScript source file). Resolve/load hooks must
  // see that URL before the default loader reports Node's unknown-extension
  // error. The default loader still calls moduleFormat() directly, so an
  // unhandled extension remains an ERR_UNKNOWN_FILE_EXTENSION.
  const moduleFormatForHook = (resolved) => {
    try {
      return moduleFormat(resolved);
    } catch (error) {
      if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') return undefined;
      throw error;
    }
  };

  const packageEntry = (base, useExports = true) => {
    const packagePath = posix.join(base, 'package.json');
    if (!hasFile(packagePath)) return undefined;
    const config = packageConfig(base);
    const exportsValue = useExports ? config.exports : undefined;
    const rootExport = typeof exportsValue === 'string'
      ? exportsValue
      : exportsValue && typeof exportsValue === 'object'
        ? (typeof exportsValue['.'] === 'string'
          ? exportsValue['.']
          : exportsValue['.']?.import || exportsValue['.']?.default || exportsValue['.']?.node)
        : undefined;
    return typeof rootExport === 'string' ? rootExport : config.main;
  };

  const packageError = (code, message) => {
    const error = new Error(message);
    error.code = code;
    error.name = `Error [${code}]`;
    return error;
  };

  const PACKAGE_TARGET_BLOCKED = Symbol('package-target-blocked');

  const invalidPackageTargetMessage = (kind, target) => (
    `Invalid "${kind}" target '${target}'`
  );

  const matchingPackageEntry = (map, request) => {
    if (Object.prototype.hasOwnProperty.call(map, request)) {
      return { key: request, target: map[request], match: '' };
    }
    const candidates = Object.keys(map)
      .filter((key) => key.includes('*'))
      .filter((key) => {
        const [prefix, suffix] = key.split('*');
        return request.startsWith(prefix) && request.endsWith(suffix) && request.length >= prefix.length + suffix.length;
      })
      .sort((left, right) => {
        const leftPrefix = left.slice(0, left.indexOf('*')).length;
        const rightPrefix = right.slice(0, right.indexOf('*')).length;
        return rightPrefix - leftPrefix || right.length - left.length;
      });
    if (!candidates.length) return undefined;
    const key = candidates[0];
    const prefixLength = key.indexOf('*');
    const suffixLength = key.length - prefixLength - 1;
    return {
      key,
      target: map[key],
      match: request.slice(prefixLength, request.length - suffixLength || undefined),
    };
  };

  const resolvePackageTarget = (target, packageRoot, match, conditions, kind) => {
    if (target === null) return PACKAGE_TARGET_BLOCKED;
    if (Array.isArray(target)) {
      for (const candidate of target) {
        try {
          const resolved = resolvePackageTarget(candidate, packageRoot, match, conditions, kind);
          if (resolved !== undefined && resolved !== PACKAGE_TARGET_BLOCKED) return resolved;
        } catch (error) {
          if (error.code !== 'ERR_PACKAGE_TARGET_NOT_FOUND') throw error;
        }
      }
      return undefined;
    }
    if (target && typeof target === 'object') {
      for (const [condition, candidate] of Object.entries(target)) {
        if (condition !== 'default' && !conditions.includes(condition)) continue;
        const resolved = resolvePackageTarget(candidate, packageRoot, match, conditions, kind);
        if (resolved === PACKAGE_TARGET_BLOCKED) return PACKAGE_TARGET_BLOCKED;
        if (resolved !== undefined) return resolved;
      }
      return undefined;
    }
    if (typeof target !== 'string') {
      throw packageError('ERR_INVALID_PACKAGE_TARGET', `Invalid "${kind}" target in '${packageRoot}/package.json'`);
    }
    const substituted = target.replace(/\*/g, match);
    if (substituted.includes('%2f') || substituted.includes('%2F')
      || substituted.includes('%5c') || substituted.includes('%5C')) {
      throw packageError(
        'ERR_INVALID_MODULE_SPECIFIER',
        `Invalid module specifier '${target}': must not include encoded "/" or "\\"`,
      );
    }
    if (substituted.startsWith('./')) {
      // Package pattern substitution preserves repeated separators. Collapsing
      // them here can turn a missing target such as `sub//internal/test` into
      // an existing file and incorrectly make the import succeed.
      const resolved = substituted.slice(2).includes('//')
        ? `${packageRoot}/${substituted.slice(2)}`
        : posix.normalize(posix.join(packageRoot, substituted));
      if (resolved !== packageRoot && !resolved.startsWith(`${packageRoot}/`)) {
        if (kind === 'imports') {
          throw packageError(
            'ERR_INVALID_MODULE_SPECIFIER',
            `Invalid module specifier '${target}': request is not a valid match in pattern`,
          );
        }
        throw packageError('ERR_INVALID_PACKAGE_TARGET', invalidPackageTargetMessage(kind, target));
      }
      if (substituted.includes('/node_modules/') || substituted.startsWith('./node_modules/')) {
        throw packageError('ERR_INVALID_PACKAGE_TARGET', invalidPackageTargetMessage(kind, target));
      }
      return resolved;
    }
    if (substituted.startsWith('.')) {
      throw packageError('ERR_INVALID_PACKAGE_TARGET', invalidPackageTargetMessage(kind, target));
    }
    if (kind === 'imports' && !substituted.startsWith('#') && !substituted.includes(':')) {
      return resolvePackage(substituted, packageRoot, conditions);
    }
    throw packageError('ERR_INVALID_PACKAGE_TARGET', invalidPackageTargetMessage(kind, target));
  };

  const resolvePackageSelfReference = (specifier, importer, conditions) => {
    const parts = String(specifier).split('/');
    const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = parts.slice(packageName.split('/').length).join('/');
    let directory = posix.dirname(importer);
    while (true) {
      const config = packageConfig(directory);
      if (config?.name === packageName && config.exports !== undefined) {
        const exportsMap = config.exports === null || typeof config.exports === 'string' || Array.isArray(config.exports)
          ? { '.': config.exports }
          : Object.keys(config.exports).some((key) => key === '.' || key.startsWith('./'))
            ? config.exports
            : { '.': config.exports };
        const request = subpath ? `./${subpath}` : '.';
        const entry = matchingPackageEntry(exportsMap, request);
        if (!entry) throw packageError('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${request}' is not defined`);
        const exported = resolvePackageTarget(entry.target, directory, entry.match, conditions, 'exports');
        if (exported === PACKAGE_TARGET_BLOCKED || exported === undefined) {
          throw packageError('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${request}' is not defined`);
        }
        return exported;
      }
      if (directory === '/' || directory === '.' || directory === '') break;
      directory = posix.dirname(directory);
    }
    return undefined;
  };

  const resolvePackageImports = (specifier, importer, conditions) => {
    if (!specifier.startsWith('#')) return undefined;
    if (specifier === '#' || specifier.startsWith('#/')) {
      throw packageError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module '${specifier}'`);
    }
    let directory = posix.dirname(importer);
    while (true) {
      const config = packageConfig(directory);
      if (config?.imports) {
        const entry = matchingPackageEntry(config.imports, specifier);
        if (!entry) break;
        try {
          const resolved = resolvePackageTarget(entry.target, directory, entry.match, conditions, 'imports');
          if (resolved === PACKAGE_TARGET_BLOCKED) break;
          if (resolved !== undefined) return resolved;
        } catch (error) {
          if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || error.code === 'MODULE_NOT_FOUND') {
            throw packageError('ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import '${specifier}' is not defined`);
          }
          error.message = `${error.message}; ${specifier}`;
          throw error;
        }
        break;
      }
      if (directory === '/' || directory === '.' || directory === '') break;
      directory = posix.dirname(directory);
    }
    const packageResolved = resolvePackage(specifier, importer, conditions);
    if (packageResolved !== undefined) return packageResolved;
    throw packageError('ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import '${specifier}' is not defined`);
  };

  const resolveFileOrDirectory = (
    base,
    useExports = true,
    fileCandidateList = fileCandidates,
    directoryCandidateList = directoryCandidates,
  ) => {
    const file = fileCandidateList(base).find((candidate) => hasFile(candidate));
    if (file) return file;
    const entry = packageEntry(base, useExports);
    if (typeof entry === 'string') {
      const target = posix.join(base, entry);
      const packageFile = fileCandidateList(target).find((candidate) => hasFile(candidate))
        || directoryCandidateList(target).find((candidate) => hasFile(candidate));
      if (packageFile) return packageFile;
    }
    return directoryCandidateList(base).find((candidate) => hasFile(candidate));
  };

  const globalModulePaths = () => {
    const configured = Array.isArray(builtins?.module?.globalPaths)
      ? builtins.module.globalPaths.filter((pathname) => typeof pathname === 'string')
      : [];
    if (configured.length > 0) return configured;
    const processObject = builtins?.process;
    const home = processObject?.platform === 'win32'
      ? processObject?.env?.USERPROFILE || builtins?.os?.homedir?.()
      : processObject?.env?.HOME || builtins?.os?.homedir?.();
    const nodePath = processObject?.env?.NODE_PATH;
    const delimiter = processObject?.platform === 'win32' ? ';' : ':';
    const paths = nodePath ? String(nodePath).split(delimiter).filter(Boolean) : [];
    if (home) {
      paths.push(posix.join(home, '.node_modules'));
      paths.push(posix.join(home, '.node_libraries'));
    }
    return paths;
  };

  const resolvePackage = (specifier, importer, conditions = ['node', 'import']) => {
    const parts = specifier.split('/');
    const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = parts.slice(packageName.split('/').length).join('/');
    const selfReference = resolvePackageSelfReference(specifier, importer, conditions);
    if (selfReference !== undefined) return selfReference;
    const resolutionTrace = [];
    const searchRoots = [];
    let directory = posix.dirname(importer);
    for (;;) {
      searchRoots.push(posix.join(directory, 'node_modules'));
      if (directory === '/' || directory === '.' || directory === '') break;
      directory = posix.dirname(directory);
    }
    searchRoots.push(...globalModulePaths());
    for (const searchRoot of searchRoots) {
      const packageRoot = posix.join(searchRoot, packageName);
      resolutionTrace.push(`${packageRoot}:${hasFile(posix.join(packageRoot, 'package.json')) ? 'present' : 'missing'}`);
      let config;
      try {
        config = packageConfig(packageRoot);
      } catch (error) {
        if (error?.code === 'ERR_INVALID_PACKAGE_CONFIG') {
          const packagePath = error.path || posix.join(packageRoot, 'package.json');
          error.message = `Invalid package config ${packagePath} while importing \"${specifier}\" from ${importer}.`;
          error.name = 'Error [ERR_INVALID_PACKAGE_CONFIG]';
          error.stack = `${error.name}: ${error.message}\ncode: '${error.code}'`;
        }
        throw error;
      }
      const requireConditions = conditions.includes('require') && !conditions.includes('import');
      const fileCandidateList = requireConditions ? commonJsFileCandidates : fileCandidates;
      const directoryCandidateList = requireConditions ? commonJsDirectoryCandidates : directoryCandidates;
      if (config?.exports !== undefined) {
        const request = subpath ? `./${subpath}` : '.';
        const exportsMap = config.exports === null || typeof config.exports === 'string' || Array.isArray(config.exports)
          ? { '.': config.exports }
          : Object.keys(config.exports).some((key) => key === '.' || key.startsWith('./'))
            ? config.exports
            : { '.': config.exports };
        const entry = matchingPackageEntry(exportsMap, request);
        if (!entry) throw packageError('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${request}' is not defined`);
        const exported = resolvePackageTarget(entry.target, packageRoot, entry.match, conditions, 'exports');
        if (exported === PACKAGE_TARGET_BLOCKED) {
          throw packageError('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${request}' is not defined`);
        }
        if (exported !== undefined) {
          if (requireConditions && !hasFile(exported)) {
            throw packageError('MODULE_NOT_FOUND', `Cannot find module '${exported}'`);
          }
          return exported;
        }
        throw packageError('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${request}' is not defined`);
      }
      const base = subpath ? posix.join(packageRoot, subpath) : packageRoot;
      const resolved = resolveFileOrDirectory(base, false, fileCandidateList, directoryCandidateList);
      if (resolved) return resolved;
    }
    const error = packageError(
      'MODULE_NOT_FOUND',
      `Cannot find package '${specifier}' imported from '${importer}' (searched ${resolutionTrace.join(', ')})`,
    );
    throw error;
  };

  const resolveInternalModule = (specifier) => {
    if (!specifier.startsWith('internal/')) return undefined;
    return resolveFileOrDirectory(posix.join('/node/lib', specifier));
  };

  const resolveNodeLibrary = (specifier) => {
    const name = builtinName(specifier);
    if (!name || name.startsWith('internal/')) return undefined;
    return resolveFileOrDirectory(posix.join('/node/lib', name));
  };

  const isInvalidPackageSpecifier = (specifier) => {
    if (/[\\]/.test(specifier) || /%(?:2f|5c)/i.test(specifier)) return true;
    return specifier.startsWith('@')
      && (!specifier.includes('/') || specifier.slice(1).includes('@'));
  };

  const resolve = (specifier, importer = '/node/index.js', conditions = ['node', 'import']) => {
    if (typeof importer === 'string' && importer.startsWith('blob:')) {
      const blobURL = importer.split('#', 1)[0];
      const virtualImporter = generatedObjectImporters.get(blobURL);
      if (virtualImporter) importer = virtualImporter;
      else if (blobVirtualPaths.has(blobURL)) importer = blobVirtualPaths.get(blobURL);
    }
    const rawValue = String(specifier);
    let value = rawValue;
    let identitySuffix = '';
    if (rawValue.startsWith('file:')) {
      const fileURL = new URL(rawValue);
      identitySuffix = `${fileURL.search}${fileURL.hash}`;
      value = fileURLToPath(rawValue);
    }
    else if (isPathSpecifier(rawValue)) {
      try {
        value = decodeURIComponent(rawValue);
      } catch (cause) {
        const error = new Error(`Invalid module specifier '${rawValue}'`);
        error.code = 'ERR_INVALID_MODULE_SPECIFIER';
        error.cause = cause;
        throw error;
      }
    }
    const name = builtinName(value);
    if (hasBuiltin(value)) return value.startsWith('node:') ? `node:${name}` : name;
    if (value.startsWith('node:')) {
      const libraryFile = resolveInternalModule(name) || resolveNodeLibrary(name);
      if (libraryFile) return libraryFile;
      throw packageError('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${name}`);
    }
    if (value.startsWith('data:')) return value;
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) {
      if (value.startsWith('http:') || value.startsWith('https:')) return value;
      throw packageError('ERR_UNSUPPORTED_ESM_URL_SCHEME', 'Only file, data, and node URLs are supported');
    }
    if (value.startsWith('#')) {
      return resolvePackageImports(value, importer, conditions);
    }
    if (!isPathSpecifier(value)) {
      if (isInvalidPackageSpecifier(value)) {
        throw packageError('ERR_INVALID_MODULE_SPECIFIER', `Invalid module specifier '${value}'`);
      }
      const resolvedPackage = resolveInternalModule(value)
        || resolveNodeLibrary(value)
        || resolvePackage(value, importer, conditions);
      if (resolvedPackage) return resolvedPackage;
      throw packageError('MODULE_NOT_FOUND', `Cannot find package '${value}' imported from '${importer}'`);
    }
    if ((importer.startsWith('http:') || importer.startsWith('https:'))
      && (value.startsWith('./') || value.startsWith('../') || value === '.' || value === '..')) {
      return new URL(value, importer).href;
    }
    const base = value.startsWith('/') ? value : posix.join(posix.dirname(importer), value);
    // ESM resolution does not add file extensions. CommonJS resolution keeps
    // the Node-style extension and index fallbacks through require conditions.
    if (conditions.includes('import') && !posix.extname(value)) return `${base}${identitySuffix}`;
    const requireConditions = conditions.includes('require') && !conditions.includes('import');
    const resolvedPath = resolveFileOrDirectory(
      base,
      false,
      requireConditions ? commonJsFileCandidates : fileCandidates,
      requireConditions ? commonJsDirectoryCandidates : directoryCandidates,
    ) || base;
    return `${resolvedPath}${identitySuffix}`;
  };

  const resolveRequire = (specifier, importer = '/node/index.js', conditions = ['node', 'require']) => {
    const rawValue = String(specifier);
    const value = rawValue.startsWith('file:') ? fileURLToPath(rawValue) : rawValue;
    const name = builtinName(value);
    if (hasBuiltin(value)) return value.startsWith('node:') ? `node:${name}` : name;
    if (value.startsWith('node:')) {
      const libraryFile = resolveInternalModule(name) || resolveNodeLibrary(name);
      if (libraryFile) return libraryFile;
      throw packageError('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${name}`);
    }
    if (value.startsWith('#')) {
      const imported = resolvePackageImports(value, importer, conditions);
      if (imported.startsWith('node:') || imported.startsWith('data:')
        || imported.startsWith('http:') || imported.startsWith('https:')) return imported;
      if (hasFile(imported)) return imported;
      throw packageError('MODULE_NOT_FOUND', `Cannot find module '${value}'`);
    }
    if (value.startsWith('data:') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) return resolve(value, importer, conditions);
    if (!isPathSpecifier(value)) {
      const resolved = resolvePackage(value, importer, conditions);
      if (resolved) {
        const candidate = resolveFileOrDirectory(resolved, false, commonJsFileCandidates, commonJsDirectoryCandidates);
        if (candidate) return candidate;
      }
      throw packageError('MODULE_NOT_FOUND', `Cannot find module '${value}'`);
    }
    const base = value.startsWith('/') ? value : posix.join(posix.dirname(importer), value);
    const resolved = resolveFileOrDirectory(base, false, commonJsFileCandidates, commonJsDirectoryCandidates);
    if (resolved) return resolved;
    throw packageError('MODULE_NOT_FOUND', `Cannot find module '${value}'`);
  };

  const read = (specifier, importer, conditions = ['node', 'import']) => {
    const resolved = resolve(specifier, importer, conditions);
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved)) unsupportedNativeAddon(resolved);
    let value;
    try {
      value = readFile(resolved);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (value === undefined) {
      const error = new Error(`Cannot find module '${specifier}' from '${importer}'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return { resolved, value };
  };

  const register = (factory) => {
    const token = String(moduleSequence++);
    registry[token] = factory;
    return token;
  };

  const cjsExportNames = (resolved, source, seen = new Set()) => {
    if (seen.has(resolved)) return { names: new Set(), esmSyntax: false };
    seen.add(resolved);
    const metadata = cjsExportMetadata(source);
    const names = new Set(metadata.names);
    for (const specifier of metadata.reexports) {
      try {
        const child = read(specifier, resolved, ['node', 'require']);
        if (child.resolved.endsWith('.mjs') || child.resolved.endsWith('.json')) continue;
        const childValue = child.resolved.endsWith('.wasm') || child.resolved.endsWith('.node')
          ? child.value : readTextFile(child.resolved);
        const childMetadata = cjsExportNames(child.resolved, sourceText(childValue), seen);
        for (const name of childMetadata.names) names.add(name);
      } catch {
        // Node keeps the statically detected names when a re-export cannot be resolved.
      }
    }
    return { names, esmSyntax: metadata.esmSyntax };
  };

  const esmExportNames = (source, resolved = null, seen = new Set()) => {
    if (resolved && seen.has(resolved)) {
      return {
        defaultExport: false,
        names: new Set(),
        bindings: new Map(),
        functionBindings: new Map(),
        reexports: [],
      };
    }
    if (resolved) seen.add(resolved);
    const value = String(source);
    const names = new Set();
    const bindings = new Map();
    const functionBindings = new Map();
    const reexports = [];
    // Function declarations are initialized during ESM module instantiation,
    // before dependency bodies run. Cycle proxies need the same early value
    // when a dependency calls an exported function before the real module can
    // publish its complete namespace.
    for (const match of value.matchAll(/(?:^|[;\n])([ \t]*(?:export\s+)?(?:async\s+)?function\s*\*?\s+([$A-Z_a-z][$\w]*)\s*\()/gm)) {
      const declarationStart = match.index + match[0].indexOf(match[1]);
      const bodyStart = value.indexOf('{', declarationStart + match[1].length);
      if (bodyStart < 0) continue;
      const masked = maskJavaScriptLiterals(value);
      let depth = 0;
      let bodyEnd = -1;
      for (let index = bodyStart; index < masked.length; index += 1) {
        if (masked[index] === '{') depth += 1;
        else if (masked[index] === '}' && --depth === 0) {
          bodyEnd = index + 1;
          break;
        }
      }
      if (bodyEnd > 0) {
        functionBindings.set(match[2], value.slice(declarationStart, bodyEnd).replace(/^export\s+/, ''));
      }
    }
    for (const match of value.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+([$A-Z_a-z][$\w]*)/g)) {
      if (isValidExportName(match[1])) {
        names.add(match[1]);
        bindings.set(match[1], match[1]);
      }
    }
    for (const match of value.matchAll(/\bexport\s*\{([^}]+)\}(?:\s*from\s*(['"])(.*?)\2)?/g)) {
      // Export lists commonly group names under comments. Strip those
      // comments before splitting so a name after a comment remains a valid
      // static export (for example terser's `_INLINE` annotation flags).
      const exportList = match[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
      const reexport = match[3] === undefined
        ? null
        : { specifier: decodeStaticString(match[3]), names: new Set() };
      for (const part of exportList.split(',')) {
        const pieces = part.trim().split(/\s+as\s+/);
        const local = pieces[0].trim().replace(/^(['"])(.*?)\1$/, '$2');
        const name = (pieces[1] || pieces[0]).trim().replace(/^(['"])(.*?)\1$/, '$2');
        if (isValidExportName(name)) {
          names.add(name);
          if (reexport) {
            reexport.names.add(name);
          } else {
            bindings.set(name, local);
            if (functionBindings.has(local)) functionBindings.set(name, functionBindings.get(local));
          }
        }
      }
      if (reexport) reexports.push(reexport);
    }
    const exportStarPattern = /\bexport\s*\*\s*from\s*(['"])(.*?)\1/g;
    for (const match of value.matchAll(exportStarPattern)) {
      const specifier = decodeStaticString(match[2]);
      const reexport = { specifier, names: new Set() };
      try {
        if (resolved) {
          const child = read(specifier, resolved);
          const childAnalysis = esmExportNames(sourceText(child.value), child.resolved, seen);
          for (const name of childAnalysis.names) {
            names.add(name);
            reexport.names.add(name);
          }
        }
      } catch {
        // Keep the names already discovered when a cycle child is unavailable.
      }
      reexports.push(reexport);
    }
    const defaultDeclaration = value.match(/\bexport\s+default\s+(?:async\s+)?(?:function|class)\s+([$A-Z_a-z][$\w]*)/);
    return {
      defaultExport: /\bexport\s+default\b/.test(value),
      names,
      bindings,
      functionBindings,
      defaultBinding: defaultDeclaration?.[1],
      reexports,
    };
  };

  const builtinModuleSource = (resolved, value) => {
    const names = Object.keys(value && (typeof value === 'object' || typeof value === 'function') ? value : {})
      .filter(isValidExportName)
      .filter((name) => name !== 'default');
    if (builtinName(resolved) === 'events' && !names.includes('once')) names.push('once');
    const token = register(() => value);
    const syncToken = register((sync) => {
      if (typeof sync === 'function') builtinEsmSyncers.add(sync);
    });
    const access = `globalThis[${quote(registryName)}][${quote(token)}]()`;
    const namedAccess = (name) => {
      const namedToken = register(() => resolved === 'events' && name === 'once' && typeof value?.once !== 'function'
        ? eventsOnce
        : value?.[name]);
      return `globalThis[${quote(registryName)}][${quote(namedToken)}]()`;
    };
    const syncAssignments = names.map((name) => `  ${name} = moduleValue?.[${quote(name)}];`).join('\n');
    return [
      `const moduleValue = ${access};`,
      'export default moduleValue;',
      ...names.map((name) => `export let ${name} = ${namedAccess(name)};`),
      `globalThis[${quote(registryName)}][${quote(syncToken)}](() => {\n${syncAssignments}\n});`,
    ].join('\n');
  };

  const cjsModuleSource = (resolved, source, processOverride) => {
    const analysis = cjsExportNames(resolved, source);
    if (analysis.esmSyntax) return `throw new SyntaxError(${quote("Unexpected token 'export'")});`;
    let evaluated = false;
    let exports;
    const load = () => {
      if (!evaluated) {
        if (resolved.startsWith('custom-')) {
          const module = { exports: {} };
          const require = (specifier) => evaluate(specifier, resolved, {}, processOverride);
          const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
          fn(module.exports, require, module, resolved, posix.dirname(resolved));
          exports = module.exports;
        } else {
          exports = evaluateCommonJS(resolved, resolved, processOverride);
        }
        evaluated = true;
      }
      return exports;
    };
    const token = register(load);
    const access = `globalThis[${quote(registryName)}][${quote(token)}]()`;
    load();
    const names = [...analysis.names].filter((name) => name !== 'default');
    const namedExports = names.map((name, index) => {
      const local = `__bnhCjsExport${index}`;
      return `const ${local} = moduleValue?.[${quote(name)}];\nexport { ${local} as ${quote(name)} };`;
    });
    return [
      `const moduleValue = ${access};`,
      'export default moduleValue;',
      ...namedExports,
    ].join('\n');
  };

  const cycleModuleSource = (resolved, importer, processOverride) => {
    const source = sourceText(read(resolved, importer).value);
    const analysis = esmExportNames(source, resolved);
    const state = {
      values: Object.create(null),
      listeners: [],
      publish(values) {
        this.values = values || Object.create(null);
        for (const listener of this.listeners) listener(this.values);
      },
    };
    const token = register(() => state);
    const key = cacheKey(resolved, processOverride);
    cycleRegistrations.set(key, {
      resolved,
      processOverride,
      names: analysis.names,
      bindings: analysis.bindings,
      defaultBinding: analysis.defaultBinding,
      reexports: analysis.reexports,
      token,
    });
    const access = `globalThis[${quote(registryName)}][${quote(token)}]()`;
    const reexportImports = [];
    const directReexports = new Set();
    const namedExports = [];
    const functionFallbacks = new Map();
    for (const [index, reexport] of analysis.reexports.entries()) {
      const reexportKey = cycleReexportKey(resolved, reexport.specifier, processOverride);
      let url = cycleReexportURLs.get(reexportKey);
      if (!url) {
        try {
          const child = read(reexport.specifier, resolved);
          const childKey = cacheKey(child.resolved, processOverride);
          // The async graph builder has already materialized non-cyclic
          // siblings before it reaches the back-edge that creates this proxy.
          // Reuse that URL so the proxy's bindings are initialized by the
          // browser's normal ESM dependency order instead of reading an empty
          // cycle-state snapshot during module evaluation.
          url = moduleURLs.get(childKey) || cycleModuleURLs.get(childKey) || null;
          if (url) cycleReexportURLs.set(reexportKey, url);
        } catch {
          // Preserve the existing cycle fallback when a re-export target is
          // unavailable while the graph is being prepared.
        }
      }
      if (!url) continue;
      const alias = `__bnhCycleReexport${index}`;
      reexportImports.push(`import * as ${alias} from ${quote(url)};`);
      for (const name of reexport.names) {
        if (directReexports.has(name)) continue;
        directReexports.add(name);
        const local = `__bnhCycleExport_${name.replace(/[^$\w]/g, '_')}`;
        namedExports.push(`let ${local} = ${alias}[${quote(name)}];\nexport { ${local} as ${quote(name)} };`);
      }
    }
    for (const name of analysis.names) {
      if (directReexports.has(name)) continue;
      const local = `__bnhCycleExport_${name.replace(/[^$\w]/g, '_')}`;
      const functionSource = analysis.functionBindings.get(name);
      if (functionSource) {
        namedExports.push(`let ${local} = (${functionSource});\nexport { ${local} as ${quote(name)} };`);
        functionFallbacks.set(name, local);
      } else {
        namedExports.push(`let ${local} = ${access}.values[${quote(name)}];\nexport { ${local} as ${quote(name)} };`);
      }
    }
    const defaultExport = analysis.defaultExport
      ? `let __bnhCycleDefault = ${access}.values.default;\nexport { __bnhCycleDefault as default };`
      : '';
    const updates = [
      ...analysis.names,
      ...(analysis.defaultExport ? ['default'] : []),
    ].map((name) => {
      const local = name === 'default'
        ? '__bnhCycleDefault'
        : `__bnhCycleExport_${name.replace(/[^$\w]/g, '_')}`;
      const fallback = functionFallbacks.get(name);
      return `${local} = values?.[${quote(name)}] ?? ${fallback || 'undefined'};`;
    }).join(' ');
    return [
      ...reexportImports,
      `const cycleState = ${access};`,
      ...namedExports,
      defaultExport,
      `cycleState.listeners.push((values) => { ${updates} });`,
    ].join('\n');
  };

  const cycleModuleURL = (resolved, importer, processOverride) => {
    const key = cacheKey(resolved, processOverride);
    if (cycleModuleURLs.has(key)) return cycleModuleURLs.get(key);
    const source = cycleModuleSource(resolved, importer, processOverride);
    const url = generatedModuleURL(
      source,
      `${registryName}_cycle_${moduleSequence++}${processKey(processOverride)}`,
      resolved,
    );
    cycleModuleURLs.set(key, url);
    return url;
  };

  const publishCycleModuleSource = (key, source) => {
    const registration = cycleRegistrations.get(key);
    if (!registration) return source;
    const publication = [];
    const publishedNames = new Set();
    for (const name of registration.names) {
      const binding = registration.bindings.get(name);
      if (binding) {
        publication.push(`${quote(name)}: ${binding}`);
        publishedNames.add(name);
      }
    }
    if (registration.defaultBinding) {
      publication.push(`default: ${registration.defaultBinding}`);
      publishedNames.add('default');
    }
    const reexportImports = [];
    for (const [index, reexport] of (registration.reexports || []).entries()) {
      const url = cycleReexportURLs.get(cycleReexportKey(
        registration.resolved,
        reexport.specifier,
        registration.processOverride,
      ));
      if (!url) continue;
      const alias = `__bnhCycleReexport${index}`;
      reexportImports.push(`import * as ${alias} from ${quote(url)};`);
      for (const name of reexport.names) {
        if (publishedNames.has(name)) continue;
        publication.push(`${quote(name)}: ${alias}[${quote(name)}]`);
        publishedNames.add(name);
      }
    }
    const publishSource = publication.length
      ? `globalThis[${quote(registryName)}][${quote(registration.token)}]().publish({${publication.join(',')}});`
      : '';
    return `${reexportImports.join('\n')}${reexportImports.length ? '\n' : ''}${source}${publishSource ? `\n${publishSource}` : ''}`;
  };

  const invalidCjsModuleURL = (specifier, exportName) => {
    const message = `The requested module '${specifier}' does not provide an export named '${exportName}'`;
    const source = `export default undefined;\nthrow new SyntaxError(${quote(message)});`;
    return generatedModuleURL(source, `${registryName}_${moduleSequence++}`);
  };

  const cjsHasEsmSyntax = (resolved) => {
    if (resolved.endsWith('.mjs') || resolved.endsWith('.json') || isBuiltinSpecifier(resolved)) return false;
    try {
      if (moduleFormat(resolved) === 'module') return false;
      const source = sourceText(read(resolved, resolved).value);
      return cjsExportNames(resolved, source).esmSyntax;
    } catch {
      return false;
    }
  };

  const requestedExportName = (prefix) => {
    const isImport = /^\s*import\b/.test(prefix);
    const clause = prefix
      .replace(/^\s*(?:import|export)\s*/, '')
      .replace(/\s*from\s*$/, '')
      .trim();
    if (!clause || clause.startsWith('*')) return undefined;
    if (clause.startsWith('{')) {
      const first = clause.slice(1).replace(/}\s*$/, '').split(',')[0].trim();
      return first.split(/\s+as\s+/)[0].trim().replace(/^(['"])(.*?)\1$/, '$2');
    }
    return isImport ? 'default' : clause.split(',')[0].trim();
  };

  function rewriteSpecifier(specifier, importer, exportName, processOverride) {
    specifier = decodeStaticString(specifier);
    const resolvedResult = runResolveHooks(specifier, importer, ['node', 'import'], processOverride);
    const resolved = hookURLToSpecifier(resolvedResult.url, importer);
    if (exportName && cjsHasEsmSyntax(resolved)) return invalidCjsModuleURL(specifier, exportName);
    const formatHint = Object.hasOwn(resolvedResult, 'format') ? resolvedResult.format : null;
    const url = moduleURL(resolved, processOverride, formatHint);
    nativeSpecifierHints.set(url, specifier);
    return url;
  }

  // The source being transformed can itself contain examples or template
  // strings that look like import declarations (the Node test suite does
  // this frequently). Keep string/comment contents masked while locating
  // declarations, then take the actual specifier from the original source.
  const maskJavaScriptLiterals = (source) => {
    const value = String(source);
    const masked = value.split('');
    let state = 'code';
    let quoteChar = '';
    let regexCharClass = false;
    const templateExpressionDepth = [];
    const canStartRegex = (index) => {
      let cursor = index - 1;
      let sawLineTerminator = false;
      while (cursor >= 0 && /\s/.test(value[cursor])) {
        if (value[cursor] === '\n' || value[cursor] === '\r') sawLineTerminator = true;
        cursor -= 1;
      }
      if (cursor < 0) return true;
      if (sawLineTerminator) return true;
      if ('([{,:;=!&|?+-*%^~<>'.includes(value[cursor])) return true;
      const end = cursor + 1;
      while (cursor >= 0 && /[$\w]/.test(value[cursor])) cursor -= 1;
      const previousWord = value.slice(cursor + 1, end);
      return ['case', 'delete', 'do', 'else', 'in', 'instanceof', 'of', 'return', 'throw', 'typeof', 'void', 'yield', 'await'].includes(previousWord);
    };
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      const next = value[index + 1];
      if (state === 'code') {
        if (char === String.fromCharCode(96)) {
          state = 'template';
          continue;
        }
        if (templateExpressionDepth.length && char === '{') {
          templateExpressionDepth[templateExpressionDepth.length - 1] += 1;
          continue;
        }
        if (templateExpressionDepth.length && char === '}') {
          const depth = templateExpressionDepth.length - 1;
          if (templateExpressionDepth[depth] > 0) templateExpressionDepth[depth] -= 1;
          else {
            templateExpressionDepth.pop();
            state = 'template';
          }
          continue;
        }
        if (char === '/' && next === '/') {
          masked[index] = ' ';
          masked[index + 1] = ' ';
          state = 'line-comment';
          index += 1;
        } else if (char === '/' && next === '*') {
          masked[index] = ' ';
          masked[index + 1] = ' ';
          state = 'block-comment';
          index += 1;
        } else if (char === '/' && canStartRegex(index)) {
          masked[index] = ' ';
          regexCharClass = false;
          state = 'regex';
        } else if (char === '\'' || char === '"' || char === '`') {
          quoteChar = char;
          state = 'string';
        }
        continue;
      }
      if (state === 'template') {
        if (char === String.fromCharCode(92)) {
          masked[index] = ' ';
          if (index + 1 < value.length && value[index + 1] !== String.fromCharCode(10) && value[index + 1] !== String.fromCharCode(13)) {
            masked[index + 1] = ' ';
            index += 1;
          }
        } else if (char === String.fromCharCode(96)) {
          state = 'code';
        } else if (char === '$' && next === '{') {
          templateExpressionDepth.push(0);
          state = 'code';
          index += 1;
        } else if (char !== String.fromCharCode(10) && char !== String.fromCharCode(13)) masked[index] = ' ';
        continue;
      }
      if (state === 'line-comment') {
        if (char === '\n' || char === '\r') state = 'code';
        else masked[index] = ' ';
        continue;
      }
      if (state === 'block-comment') {
        if (char === '*' && next === '/') {
          masked[index] = ' ';
          masked[index + 1] = ' ';
          state = 'code';
          index += 1;
        } else if (char !== '\n' && char !== '\r') masked[index] = ' ';
        continue;
      }
      if (state === 'regex') {
        if (char === '\\') {
          masked[index] = ' ';
          if (index + 1 < value.length && value[index + 1] !== '\n' && value[index + 1] !== '\r') {
            masked[index + 1] = ' ';
            index += 1;
          }
        } else if (char === '[') {
          masked[index] = ' ';
          regexCharClass = true;
        } else if (char === ']' && regexCharClass) {
          masked[index] = ' ';
          regexCharClass = false;
        } else if (char === '/' && !regexCharClass) {
          masked[index] = ' ';
          state = 'code';
        } else if (char !== '\n' && char !== '\r') masked[index] = ' ';
        continue;
      }
      if (char === '\\') {
        masked[index] = ' ';
        if (index + 1 < value.length && value[index + 1] !== '\n' && value[index + 1] !== '\r') {
          masked[index + 1] = ' ';
          index += 1;
        }
      } else if (char === quoteChar) {
        state = 'code';
      } else if (char !== '\n' && char !== '\r') {
        masked[index] = ' ';
      }
    }
    return masked.join('');
  };

  const replaceBareImportMeta = (source, importer) => {
    const masked = maskJavaScriptLiterals(source);
    const matches = [...masked.matchAll(/\bimport\.meta\b(?!\s*\.)/g)];
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      source = `${source.slice(0, match.index)}${importMetaObject(importer)}${source.slice(match.index + match[0].length)}`;
    }
    return source;
  };

  const replaceImportMetaProperty = (source, property, replacement) => {
    const masked = maskJavaScriptLiterals(source);
    const pattern = new RegExp(`\\bimport\\.meta\\.${property}\\b`, 'g');
    const matches = [...masked.matchAll(pattern)];
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      source = `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`;
    }
    return source;
  };

  const isImportMethodDefinition = (masked, match) => {
    let depth = 1;
    for (let index = match.index + match[0].length; index < masked.length; index += 1) {
      if (masked[index] === '(') depth += 1;
      else if (masked[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          let next = index + 1;
          while (next < masked.length && /\s/.test(masked[next])) next += 1;
          return masked[next] === '{';
        }
      }
    }
    return false;
  };

  const hasTopLevelProcessBinding = (source) => {
    const masked = maskJavaScriptLiterals(source);
    return /(?:^|[;\n])\s*(?:export\s+)?(?:const|let|var|function|class)\s+(?:process\b|[({[][^;\n}]*\bprocess\b)/m.test(masked)
      || /(?:^|[;\n])\s*import\s+(?:process\b|\*\s+as\s+process\b|[^;\n]*\bas\s+process\b|\{[^}\n]*\bprocess\b[^}\n]*\})/m.test(masked);
  };

  const bindProcess = (source, processOverride) => {
    if (!processOverride || hasTopLevelProcessBinding(source)) return source;
    // A package can intentionally replace the global process object while it
    // loads a fresh module (tap's t.intercept(global, 'process', ...) does
    // this for Minipass's stdio tests). The owner override is normally needed
    // to retain virtual-process context after an async boundary, but it must
    // not hide an explicit guest replacement. Runtime-owned process objects
    // carry a private marker; any other current global process is the guest's
    // observable binding.
    const currentProcess = globalObject.process;
    const boundProcess = currentProcess
      && currentProcess !== processOverride
      && !currentProcess[RUNTIME_PROCESS_MARKER]
      ? currentProcess
      : processOverride;
    const token = register(() => {
      return boundProcess;
    });
    return `const process = globalThis[${quote(registryName)}][${quote(token)}]();\n${source}`;
  };

  function rewriteImports(source, importer, processOverride) {
    let rewritten = String(source);
    const rewriteStatic = (pattern, exportAware) => {
      const masked = maskJavaScriptLiterals(rewritten);
      const matches = [...masked.matchAll(pattern)];
      const replacements = [];
      for (const match of matches) {
        const prefixStart = match.index + match[1].length;
        const prefix = rewritten.slice(prefixStart, prefixStart + match[2].length);
        const quoteOffset = match[0].indexOf(match[3], match[1].length + match[2].length);
        if (quoteOffset < 0) continue;
        const specifierStart = match.index + quoteOffset + 1;
        const specifier = rewritten.slice(specifierStart, specifierStart + match[4].length);
        replacements.push({
          start: match.index + quoteOffset,
          end: match.index + quoteOffset + specifier.length + 2,
          replacement: quote(rewriteSpecifier(
          specifier,
          importer,
          exportAware ? requestedExportName(prefix) : undefined,
          processOverride,
          )),
        });
      }
      for (const replacement of replacements.reverse()) {
        rewritten = `${rewritten.slice(0, replacement.start)}${replacement.replacement}${rewritten.slice(replacement.end)}`;
      }
    };
    rewriteStatic(
      /(^|[;\n}])([ \t]*(?:import|export)\s*[^;]*?\s*from\s*)(['"])((?:\\.|[^'"])*)\3/gm,
      true,
    );
    rewriteStatic(
      /(^|[;\n}])([ \t]*import[ \t]*)(['"])((?:\\.|[^'"])*)\3/gm,
      false,
    );
    const dynamicImportPattern = /\bimport\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\r|\n|$))\s*)*\(/g;
    const rewriteDynamicImports = (value, replacement) => {
      const masked = maskJavaScriptLiterals(value);
      dynamicImportPattern.lastIndex = 0;
      const matches = [...masked.matchAll(dynamicImportPattern)]
        .filter((match) => !isImportMethodDefinition(masked, match));
      dynamicImportPattern.lastIndex = 0;
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index];
        value = `${value.slice(0, match.index)}${replacement}${value.slice(match.index + match[0].length)}`;
      }
      return value;
    };
    const rewriteDirectEvalCalls = (value, replacement) => {
      const masked = maskJavaScriptLiterals(value);
      const evalPattern = /(?<![\w$?.])eval\s*\(/g;
      const matches = [...masked.matchAll(evalPattern)];
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index];
        value = `${value.slice(0, match.index)}${replacement}${value.slice(match.index + match[0].length)}`;
      }
      return value;
    };
    if (dynamicImportPattern.test(maskJavaScriptLiterals(rewritten))) {
      dynamicImportPattern.lastIndex = 0;
      const token = register((dynamicSpecifier, options) => {
        const result = importModule(
          dynamicSpecifier,
          importer,
          {},
          options,
          processOverride,
          importer,
        );
        const trackedResult = Promise.resolve(result);
        processOverride?._bnhTrackEsmImport?.(trackedResult, {
          waitForZeroTimer: isBuiltinSpecifier(dynamicSpecifier)
            || String(dynamicSpecifier).startsWith('node:'),
        });
        return trackedResult;
      });
      rewritten = rewriteDynamicImports(rewritten, `globalThis[${quote(registryName)}][${quote(token)}](`);
    }
    if (/(?<![\w$?.])eval\s*\(/.test(maskJavaScriptLiterals(rewritten))) {
      const token = register((value) => {
        if (typeof value !== 'string') return value;
        const dynamicToken = register((dynamicSpecifier, options) => importModule(
          dynamicSpecifier,
          importer,
          {},
          options,
          processOverride,
          importer,
        ));
        const evaluated = rewriteDynamicImports(
          value,
          `globalThis[${quote(registryName)}][${quote(dynamicToken)}](`,
        );
        return (0, globalObject.eval)(evaluated);
      });
      rewritten = rewriteDirectEvalCalls(rewritten, `globalThis[${quote(registryName)}][${quote(token)}](`);
    }
    if (/\bimport\.meta\.resolve\b/.test(maskJavaScriptLiterals(rewritten))) {
      const token = register((specifier) => {
        const hooked = runResolveHooks(specifier, importer, ['node', 'import'], processOverride);
        if (hooked && typeof hooked.then === 'function') hooked.catch(() => {});
        const resolved = hooked && typeof hooked.url === 'string'
          ? hookURLToSpecifier(hooked.url, importer)
          : resolve(specifier, importer, ['node', 'import']);
        if (isBuiltinSpecifier(resolved) || resolved.startsWith('node:')) return `node:${builtinName(resolved)}`;
        return resolved.startsWith('data:') ? resolved : fileURL(resolved);
      });
      rewritten = replaceImportMetaProperty(rewritten, 'resolve', `globalThis[${quote(registryName)}][${quote(token)}]`);
    }
    rewritten = rewritten.replace(/\s+with\s*\{\s*type\s*:\s*['"]json['"]\s*\}/g, '');
    // Native data modules do not have a file URL. Preserve the Node-facing
    // identity used by code that builds URLs relative to import.meta.url.
    rewritten = replaceImportMetaProperty(rewritten, 'filename', quote(importer));
    rewritten = replaceImportMetaProperty(rewritten, 'dirname', quote(posix.dirname(importer)));
    rewritten = replaceImportMetaProperty(rewritten, 'url', quote(importMetaURL(importer)));
    rewritten = replaceBareImportMeta(rewritten, importer);
    return rewritten;
  }

  const decodeDataBody = (value) => {
    const encoded = value.slice(value.indexOf(',') + 1).split('#', 1)[0];
    return value.includes(';base64,') ? atob(encoded) : decodeURIComponent(encoded);
  };

  const dataModuleSource = (value, processOverride) => {
    const mime = value.slice(5, value.indexOf(',')).split(';', 1)[0].toLowerCase();
    const source = decodeDataBody(value);
    if (mime === 'application/json') return `export default ${JSON.stringify(JSON.parse(source))};`;
    return `${bindProcess(rewriteImports(source, value, processOverride), processOverride)}\n//# sourceURL=${value}`;
  };

  const isWasmBytes = (value) => {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : null;
    return bytes && bytes.length >= 4
      && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
  };

  const wasmModuleSource = (value, resolved, processOverride) => {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
    const module = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(module)
      .map(({ name }) => name)
      .filter((name) => /^[$A-Z_a-z][$\w]*$/.test(name));
    const importedModules = new Map();
    for (const { module: moduleName, name } of WebAssembly.Module.imports(module)) {
      if (!importedModules.has(moduleName)) importedModules.set(moduleName, new Set());
      importedModules.get(moduleName).add(name);
    }
    const dependencies = [...importedModules.entries()].map(([moduleName, names], index) => {
      const dependency = resolve(moduleName, resolved, ['node', 'import']);
      return {
        alias: `__bnhWasmDependency${index}`,
        moduleName,
        names: [...names],
        url: moduleURL(dependency, processOverride),
      };
    });
    const importObject = dependencies.length === 0 ? 'undefined' : `{\n${dependencies.map(({ alias, moduleName, names }) => (
      `  ${quote(moduleName)}: { ${names.map((name) => `${quote(name)}: ${alias}[${quote(name)}]`).join(', ')} }`
    )).join(',\n')}\n}`;
    return [
      ...dependencies.map(({ alias, url }) => `import * as ${alias} from ${quote(url)};`),
      `const __bnhBytes = Uint8Array.from(atob(${quote(encoded)}), (value) => value.charCodeAt(0));`,
      `const __bnhInstance = new WebAssembly.Instance(new WebAssembly.Module(__bnhBytes), ${importObject});`,
      'export default __bnhInstance.exports;',
      ...exports.map((name) => `export const ${name} = __bnhInstance.exports[${quote(name)}];`),
      `//# sourceURL=${resolved}`,
    ].join('\n');
  };

  function moduleSource(resolved, processOverride, formatHint = null) {
    const builtinValue = builtin(resolved, processOverride);
    const format = formatHint !== null ? formatHint
      : isBuiltinSpecifier(resolved) ? 'builtin'
      : resolved.startsWith('data:') ? 'module'
      : resolved.endsWith('.json') ? 'json' : moduleFormatForHook(resolved);
    const loaded = tapmockLoad(resolved) || runLoadHooks(resolved, format, processOverride);
    const loadedResolved = loaded.url ? hookURLToSpecifier(loaded.url, resolved) : resolved;
    if (loaded.format === 'builtin' && isBuiltinSpecifier(loadedResolved)) {
      return builtinModuleSource(loadedResolved, builtin(loadedResolved, processOverride));
    }
    if (loaded.source !== undefined && loaded.source !== null) {
      if (isWasmBytes(loaded.source)) return wasmModuleSource(loaded.source, loadedResolved, processOverride);
      const loadedText = typeof stripTypeScript === 'function'
        && /\.(?:[cm]?ts)$/i.test(stripPathIdentity(loadedResolved))
        ? stripTypeScript(sourceText(loaded.source))
        : sourceText(loaded.source);
      if (loaded.format === 'json') return `export default ${JSON.stringify(JSON.parse(loadedText))};`;
      if (loaded.format === 'module' || hasEsmSyntax(loadedText)) {
        return `${bindProcess(rewriteImports(stripHashbang(loadedText), loadedResolved, processOverride), processOverride)}\n//# sourceURL=${loadedResolved}`;
      }
      return cjsModuleSource(loadedResolved, loadedText, processOverride);
    }
    if (isBuiltinSpecifier(resolved)) return builtinModuleSource(resolved, builtinValue);
    if (resolved.startsWith('node:')) {
      const error = new Error(`Cannot find builtin module '${resolved}'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    if (resolved.startsWith('data:')) return dataModuleSource(resolved);
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved)) {
      const fileBytes = readFile(resolved);
      const rawBytes = fileBytes instanceof Uint8Array
        ? fileBytes
        : fileBytes instanceof ArrayBuffer
          ? new Uint8Array(fileBytes)
          : (fileBytes && fileBytes.buffer)
            ? new Uint8Array(fileBytes.buffer, fileBytes.byteOffset || 0, fileBytes.byteLength)
            : new TextEncoder().encode(String(fileBytes || ''));
      if (isWasmModuleBytes(rawBytes)) {
        return wasmModuleSource(rawBytes, resolved, processOverride);
      }
      return nativeAddonModuleSource(resolved);
    }
    let value;
    try {
      value = resolved.endsWith('.wasm') || resolved.endsWith('.node')
        ? read(resolved, resolved).value
        : readTextFile(resolved);
    } catch (error) {
      if (error?.code === 'MODULE_NOT_FOUND') return missingModuleSource(resolved);
      throw error;
    }
    if (isWasmBytes(value)) return wasmModuleSource(value, resolved, processOverride);
    if (resolved.endsWith('.json')) {
      return `export default ${JSON.stringify(JSON.parse(sourceText(value)))};`;
    }
    const loadedText = typeof stripTypeScript === 'function'
      && /\.(?:[cm]?ts)$/i.test(stripPathIdentity(resolved))
      ? stripTypeScript(sourceText(value))
      : sourceText(value);
    if (moduleFormat(resolved) !== 'module' && !hasEsmSyntax(loadedText)) return cjsModuleSource(resolved, loadedText, processOverride);
    return `${bindProcess(rewriteImports(stripHashbang(loadedText), resolved, processOverride), processOverride)}\n//# sourceURL=${resolved}`;
  }

  function moduleURL(resolved, processOverride, formatHint = null) {
    const key = cacheKey(resolved, processOverride);
    if (moduleURLs.has(key)) return moduleURLs.get(key);
    if (buildingModuleKeys.has(key)) return cycleModuleURL(resolved, resolved, processOverride);
    buildingModuleKeys.add(key);
    try {
      const source = publishCycleModuleSource(
        key,
        moduleSource(resolved, processOverride, formatHint),
      );
      // Native ESM caches by URL for the lifetime of the browser realm. Give
      // each runtime loader a private fragment so a second virtual child using
      // the same VFS path executes its own module instance.
      const url = generatedModuleURL(source, `${registryName}${processKey(processOverride)}`, resolved);
      moduleURLs.set(key, url);
      return url;
    } finally {
      buildingModuleKeys.delete(key);
    }
  }

  const evaluate = (specifier, importer, globals, processOverride) => {
    const resolved = resolve(specifier, importer, ['node', 'require']);
    const moduleCacheKey = cacheKey(resolved, processOverride);
    const builtinValue = builtin(resolved, processOverride);
    if (isBuiltinSpecifier(resolved)) return builtinValue;
    if (resolved.startsWith('node:')) {
      const error = new Error(`Cannot find builtin module '${specifier}'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    if (resolved.startsWith('data:')) return importData(resolved, undefined, processOverride);
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved)) {
      const fileBytes = readFile(resolved);
      const rawBytes = fileBytes instanceof Uint8Array
        ? fileBytes
        : fileBytes instanceof ArrayBuffer
          ? new Uint8Array(fileBytes)
          : (fileBytes && fileBytes.buffer)
            ? new Uint8Array(fileBytes.buffer, fileBytes.byteOffset || 0, fileBytes.byteLength)
            : new TextEncoder().encode(String(fileBytes || ''));
      if (isWasmModuleBytes(rawBytes)) {
        const exports = loadWasmAddon(rawBytes, { name: posix.basename(resolved, NATIVE_ADDON_EXTENSION) });
        cache[moduleCacheKey] = { exports, id: resolved, filename: resolved, loaded: true };
        return exports;
      }
      unsupportedNativeAddon(resolved);
    }
    if (Object.hasOwn(cache, moduleCacheKey)) return cache[moduleCacheKey].exports;
    if (evaluateCommonJS && moduleFormat(resolved) !== 'module' && !resolved.endsWith('.json')) {
      const exports = evaluateCommonJS(resolved, importer, processOverride);
      cache[moduleCacheKey] = { exports, id: resolved, filename: resolved, loaded: true };
      return exports;
    }
    const rawSource = read(resolved, importer).value;
    const source = stripHashbang(sourceText(rawSource));
    const module = { exports: {}, id: resolved, filename: resolved, loaded: false, parent: null, children: [] };
    if (!mainModule) mainModule = module;
    cache[moduleCacheKey] = module;
    if (resolved.endsWith('.json')) module.exports = JSON.parse(source);
    else {
      const dirname = posix.dirname(resolved);
      const require = (child) => evaluate(child, resolved, globals, processOverride);
      require.resolve = (child) => resolve(child, resolved, ['node', 'require']);
      require.cache = cache;
      require.main = mainModule;
      module.require = require;
      const transformed = normalizeNodeClassCallErrorPatterns(source.replace(/\bimport\s*\(/g, '__bnhImport('));
      const names = Object.keys(globals || {});
      const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', '__bnhImport', ...names, transformed);
      const result = fn(module.exports, require, module, resolved, dirname,
        (child, options) => importModule(child, resolved, globals, options, processOverride),
        ...names.map((name) => globals[name]));
      module.promise = result && typeof result.then === 'function' ? result : null;
    }
    module.loaded = true;
    return module.exports;
  };

  const importData = async (value, options, processOverride) => {
    const comma = value.indexOf(',');
    const mime = value.slice(5, comma < 0 ? value.length : comma).split(';', 1)[0].toLowerCase();
    const attributes = options?.with;
    const attributeKeys = attributes && typeof attributes === 'object' ? Object.keys(attributes) : [];
    if (options?.assert !== undefined) throw packageError('ERR_IMPORT_ATTRIBUTE_MISSING', 'Import assertions are not supported');
    if (attributeKeys.some((key) => key !== 'type')) {
      throw packageError('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', 'Import attribute is not supported');
    }
    if (value.startsWith('data:application/json')) {
      if (!attributes || attributes.type === undefined) {
        throw packageError('ERR_IMPORT_ATTRIBUTE_MISSING', 'Module "type" attribute is required for JSON modules');
      }
      if (attributes.type !== 'json') {
        throw packageError('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute type "${attributes.type}" is not supported`);
      }
      const source = decodeDataBody(value);
      return { default: JSON.parse(source) };
    }
    if (mime !== 'text/javascript' && mime !== 'application/javascript') {
      throw packageError('ERR_UNKNOWN_MODULE_FORMAT', `Unknown module format for ${value}`);
    }
    if (attributes?.type !== undefined && attributes.type !== 'javascript') {
      if (attributes.type === 'json') {
        throw packageError('ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', 'Module type attribute is incompatible with JavaScript');
      }
      throw packageError('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute type "${attributes.type}" is not supported`);
    }
    const source = decodeDataBody(value);
    const staticAttribute = source.match(/\bimport\s*(['"])[^'"]+\1\s*with\s*\{([^}]*)\}/);
    if (staticAttribute) {
      const attributes = staticAttribute[2];
      if (!/\btype\s*:\s*['"]json['"]/.test(attributes)) {
        throw packageError('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', 'Import attribute is not supported');
      }
      throw packageError('ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', 'Module type attribute is incompatible with JavaScript');
    }
    return import(moduleURL(value, processOverride), options);
  };

  // Experimental loaders are allowed to provide an asynchronous `load` hook.
  // Browser-native ESM cannot ask the VFS reader to resolve an http(s) URL, so
  // fetch the hook result first and recursively turn its static remote imports
  // into data-module URLs before handing the graph to the browser evaluator.
  const remoteImportCache = new Map();
  const rewriteRemoteImports = async (source, importer) => {
    let rewritten = String(source);
    const replacements = [];
    const pattern = /(^|[;\n])([ \t]*(?:import|export)\s+[^;]*?\s+from\s+|[ \t]*import\s*)(['"])((?:\\.|[^'"])*)\3/gm;
    for (const match of rewritten.matchAll(pattern)) {
      const specifier = decodeStaticString(match[4]);
      if (!specifier.startsWith('./') && !specifier.startsWith('../')
        && specifier !== '.' && specifier !== '..') continue;
      const child = resolve(specifier, importer, ['node', 'import']);
      if (!child.startsWith('http:') && !child.startsWith('https:')) continue;
      replacements.push({ start: match.index + match[0].lastIndexOf(match[3]) + 1, end: match.index + match[0].lastIndexOf(match[3]) + 1 + match[3].length, url: await importRemote(child, importer) });
    }
    for (const replacement of replacements.reverse()) {
      rewritten = `${rewritten.slice(0, replacement.start)}${replacement.url}${rewritten.slice(replacement.end)}`;
    }
    return rewritten;
  };
  const importRemote = async (resolved, importer) => {
    if (remoteImportCache.has(resolved)) return remoteImportCache.get(resolved);
    const promise = (async () => {
      const context = hookContext(resolved, importer);
      const loaded = sharedRunModuleHook
        ? await sharedRunModuleHook('load', resolved, context, (nextURL, nextContext) => (
            defaultLoad(nextURL, nextContext)
          ))
        : await defaultLoad(resolved, context);
      if (!loaded || loaded.source === undefined || loaded.source === null) {
        throw packageError('ERR_UNSUPPORTED_ESM_URL_SCHEME', `No loader is registered for ${resolved}`);
      }
      const source = await rewriteRemoteImports(sourceText(loaded.source), resolved);
      const url = generatedModuleURL(source, `${registryName}_${moduleSequence++}`, resolved);
      return url;
    })();
    remoteImportCache.set(resolved, promise);
    return promise;
  };

  // Static imports are discovered while building a data module, but loader
  // hooks may fetch their source asynchronously. Build the complete graph
  // before invoking the browser evaluator so HTTP imports work from both
  // --import preloads and --input-type=module entry points.
  const asyncModuleURLs = new Map();
  const asyncModuleDependencies = new Map();
  const asyncModuleDependsOn = (key, ancestors, seen = new Set()) => {
    if (seen.has(key)) return false;
    seen.add(key);
    const dependencies = asyncModuleDependencies.get(key);
    if (!dependencies) return false;
    for (const dependency of dependencies) {
      if (ancestors.has(dependency) || asyncModuleDependsOn(dependency, ancestors, seen)) return true;
    }
    return false;
  };
  const runLoadHooksAsync = async (resolved, format, processOverride) => {
    const url = format === 'builtin'
      ? `node:${builtinName(resolved)}`
      : /^[A-Za-z][A-Za-z\d+.-]*:/.test(resolved)
        ? resolved : fileURL(resolved);
    const context = {
      format,
      conditions: ['node', 'import'],
      importAttributes: {},
      parentURL: resolved.startsWith('data:') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(resolved)
        ? resolved : fileURL(resolved),
    };
    const result = sharedRunModuleHook
      ? await sharedRunModuleHook('load', url, context, (nextURL, nextContext) => defaultLoad(nextURL, nextContext), processOverride)
      : runLoadHooks(resolved, format, processOverride);
    if (!result || typeof result !== 'object') throw new TypeError('module load hook must return an object');
    return { ...result, url: result.url || url };
  };

  const acquireDynamicImportHandoff = (processOverride, tracker) => {
    const owner = processOverride || globalObject.process;
    if ((typeof owner !== 'object' && typeof owner !== 'function') || typeof tracker !== 'function') return null;
    let state = dynamicImportHandoffs.get(owner);
    if (!state) {
      state = {
        active: 0,
        idleTurns: 0,
        timer: null,
        released: false,
        release: tracker('esm-dynamic-handoff'),
      };
      dynamicImportHandoffs.set(owner, state);
    }
    state.active += 1;
    state.idleTurns = 0;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      state.active -= 1;
      state.idleTurns = 0;
      if (state.active !== 0 || state.released || state.timer !== null) return;
      const pendingTaskCount = owner._bnhPendingTaskCount;
      // This is loader lifecycle bookkeeping, not guest-visible work. A
      // package may replace global setTimeout (test fake clocks are a common
      // example) before an awaited dynamic import settles; scheduling the
      // handoff probe through that replacement would leave the process alive
      // forever because the package clock never advances the probe.
      const lifecycleSetTimeout = globalObject.__BNH_NATIVE_TIMERS__?.setTimeout
        || globalObject.setTimeout;
      const schedule = typeof lifecycleSetTimeout === 'function'
        ? (callback) => lifecycleSetTimeout.call(globalObject, callback, 0)
        : (callback) => Promise.resolve().then(callback);
      const check = () => {
        state.timer = null;
        if (state.released) return;
        const count = typeof pendingTaskCount === 'function' ? pendingTaskCount() : undefined;
        if (state.active !== 0 || (count !== undefined && count > 1)) {
          state.idleTurns = 0;
          state.timer = schedule(check);
          return;
        }
        state.idleTurns += 1;
        if (state.idleTurns < dynamicImportHandoffIdleTurns) {
          state.timer = schedule(check);
          return;
        }
        state.released = true;
        dynamicImportHandoffs.delete(owner);
        state.release?.();
      };
      state.timer = schedule(check);
    };
  };

  const rewriteImportsAsync = async (source, importer, processOverride, ancestors) => {
    let rewritten = String(source);
    const patterns = [
      {
        pattern: /(^|[;\n}])([ \t]*(?:import|export)\s*[^;]*?\s*from\s*)(['"])((?:\\.|[^'"])*)\3/gm,
        exportAware: true,
      },
      {
        pattern: /(^|[;\n}])([ \t]*import[ \t]*)(['"])((?:\\.|[^'"])*)\3/gm,
        exportAware: false,
      },
    ];
    for (const { pattern, exportAware } of patterns) {
      const masked = maskJavaScriptLiterals(rewritten);
      const matches = [...masked.matchAll(pattern)];
      const replacements = [];
      const resolveReplacement = async (match) => {
        const prefixStart = match.index + match[1].length;
        const prefix = rewritten.slice(prefixStart, prefixStart + match[2].length);
        const quoteOffset = match[0].indexOf(match[3], match[1].length + match[2].length);
        if (quoteOffset < 0) return null;
        const specifierStart = match.index + quoteOffset + 1;
        const specifier = rewritten.slice(specifierStart, specifierStart + match[4].length);
        const resolvedResult = await runResolveHooksAsync(specifier, importer, ['node', 'import'], processOverride);
        const resolved = hookURLToSpecifier(resolvedResult.url, importer);
        const formatHint = Object.hasOwn(resolvedResult, 'format') ? resolvedResult.format : null;
        const url = await moduleURLAsync(resolved, processOverride, importer, ancestors, formatHint);
        nativeSpecifierHints.set(url, specifier);
        const exportName = exportAware ? requestedExportName(prefix) : undefined;
        // JSON modules expose one ESM binding: default. Preserve a default
        // import while retaining the native-style failure for named imports.
        if (exportName && exportName !== 'default' && resolved.endsWith('.json')) {
          return {
            start: match.index + quoteOffset,
            end: match.index + quoteOffset + specifier.length + 2,
            replacement: quote(invalidCjsModuleURL(specifier, exportName)),
            exportAware,
            prefix,
          };
        }
        return {
          start: match.index + quoteOffset,
          end: match.index + quoteOffset + specifier.length + 2,
          replacement: quote(url),
          exportAware,
          prefix,
        };
      };
      for (const match of matches) {
        const replacement = await resolveReplacement(match);
        if (replacement) replacements.push(replacement);
      }
      for (const replacement of replacements.filter(Boolean).reverse()) {
        rewritten = `${rewritten.slice(0, replacement.start)}${replacement.replacement}${rewritten.slice(replacement.end)}`;
      }
    }
    const dynamicImportPattern = /\bimport\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n|\r|\n|$))\s*)*\(/g;
    const rewriteDynamicImports = (value, replacement) => {
      const masked = maskJavaScriptLiterals(value);
      dynamicImportPattern.lastIndex = 0;
      const matches = [...masked.matchAll(dynamicImportPattern)]
        .filter((match) => !isImportMethodDefinition(masked, match));
      dynamicImportPattern.lastIndex = 0;
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index];
        value = `${value.slice(0, match.index)}${replacement}${value.slice(match.index + match[0].length)}`;
      }
      return value;
    };
    const rewriteDirectEvalCalls = (value, replacement) => {
      const masked = maskJavaScriptLiterals(value);
      const evalPattern = /(?<![\w$?.])eval\s*\(/g;
      const matches = [...masked.matchAll(evalPattern)];
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index];
        value = `${value.slice(0, match.index)}${replacement}${value.slice(match.index + match[0].length)}`;
      }
      return value;
    };
    if (dynamicImportPattern.test(maskJavaScriptLiterals(rewritten))) {
      dynamicImportPattern.lastIndex = 0;
      const token = register((dynamicSpecifier, options) => {
        const pending = globalObject.process?.__bnhModuleRegistrationPromises;
        const load = () => importModule(dynamicSpecifier, importer, {}, options, processOverride, importer);
        const tracker = processOverride?._bnhTaskTracker || globalObject.process?._bnhTaskTracker;
        const release = acquireDynamicImportHandoff(processOverride, tracker);
        let result;
        try {
          result = pending?.length ? Promise.all([...pending]).then(load) : load();
        } catch (error) {
          release?.();
          throw error;
        }
        const trackedResult = Promise.resolve(result).then(
          (value) => { release?.(); return value; },
          (error) => { release?.(); throw error; },
        );
        processOverride?._bnhTrackEsmImport?.(trackedResult, {
          waitForZeroTimer: isBuiltinSpecifier(dynamicSpecifier)
            || String(dynamicSpecifier).startsWith('node:'),
        });
        return trackedResult;
      });
      rewritten = rewriteDynamicImports(rewritten, `globalThis[${quote(registryName)}][${quote(token)}](`);
    }
    if (/(?<![\w$?.])eval\s*\(/.test(maskJavaScriptLiterals(rewritten))) {
      const token = register((value) => {
        if (typeof value !== 'string') return value;
        const dynamicToken = register((dynamicSpecifier, options) => importModule(
          dynamicSpecifier,
          importer,
          {},
          options,
          processOverride,
          importer,
        ));
        const evaluated = rewriteDynamicImports(
          value,
          `globalThis[${quote(registryName)}][${quote(dynamicToken)}](`,
        );
        return (0, globalObject.eval)(evaluated);
      });
      rewritten = rewriteDirectEvalCalls(rewritten, `globalThis[${quote(registryName)}][${quote(token)}](`);
    }
    if (/\bimport\.meta\.resolve\b/.test(maskJavaScriptLiterals(rewritten))) {
      const token = register((specifier) => {
        const hooked = runResolveHooks(specifier, importer, ['node', 'import'], processOverride);
        if (hooked && typeof hooked.then === 'function') hooked.catch(() => {});
        const resolved = hooked && typeof hooked.url === 'string'
          ? hookURLToSpecifier(hooked.url, importer)
          : resolve(specifier, importer, ['node', 'import']);
        if (isBuiltinSpecifier(resolved) || resolved.startsWith('node:')) return `node:${builtinName(resolved)}`;
        return resolved.startsWith('data:') ? resolved : fileURL(resolved);
      });
      rewritten = replaceImportMetaProperty(rewritten, 'resolve', `globalThis[${quote(registryName)}][${quote(token)}]`);
    }
    rewritten = rewritten.replace(/\s+with\s*\{\s*type\s*:\s*['"]json['"]\s*\}/g, '');
    rewritten = replaceImportMetaProperty(rewritten, 'filename', quote(importer));
    rewritten = replaceImportMetaProperty(rewritten, 'dirname', quote(posix.dirname(importer)));
    rewritten = replaceImportMetaProperty(rewritten, 'url', quote(importMetaURL(importer)));
    rewritten = replaceBareImportMeta(rewritten, importer);
    return rewritten;
  };

  const moduleSourceAsync = async (resolved, processOverride, ancestors, formatHint = null) => {
    const builtinValue = builtin(resolved, processOverride);
    const format = formatHint !== null ? formatHint
      : isBuiltinSpecifier(resolved) ? 'builtin'
      : /^[A-Za-z][A-Za-z\d+.-]*:/.test(resolved) ? 'module'
      : resolved.endsWith('.json') ? 'json' : moduleFormatForHook(resolved);
    let loaded = tapmockLoad(resolved) || await runLoadHooksAsync(resolved, format, processOverride);
    if (loaded?.source && typeof loaded.source.then === 'function') {
      loaded = { ...loaded, source: await loaded.source };
    }
    const loadedResolved = loaded.url ? hookURLToSpecifier(loaded.url, resolved) : resolved;
    if (loaded.format === 'builtin' && isBuiltinSpecifier(loadedResolved)) {
      return builtinModuleSource(loadedResolved, builtin(loadedResolved, processOverride));
    }
    if (loaded.source !== undefined && loaded.source !== null) {
      if (isWasmBytes(loaded.source)) return wasmModuleSource(loaded.source, loadedResolved, processOverride);
      const loadedText = typeof stripTypeScript === 'function'
        && /\.(?:[cm]?ts)$/i.test(stripPathIdentity(loadedResolved))
        ? stripTypeScript(sourceText(loaded.source))
        : sourceText(loaded.source);
      if (loaded.format === 'json') return `export default ${JSON.stringify(JSON.parse(loadedText))};`;
      const loadedFormat = hasEsmSyntax(loadedText) ? 'module' : loaded.format;
      if (loadedFormat === 'module') {
        const moduleText = stripHashbang(loadedText);
        return `${bindProcess(await rewriteImportsAsync(moduleText, loadedResolved, processOverride, ancestors), processOverride)}\n//# sourceURL=${loadedResolved}`;
      }
      return cjsModuleSource(loadedResolved, loadedText, processOverride);
    }
    if (isBuiltinSpecifier(resolved)) return builtinModuleSource(resolved, builtinValue);
    if (resolved.startsWith('node:')) {
      const error = new Error(`Cannot find builtin module '${resolved}'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    if (resolved.startsWith('data:')) {
      return `${bindProcess(await rewriteImportsAsync(decodeDataBody(resolved), resolved, processOverride, ancestors), processOverride)}\n//# sourceURL=${resolved}`;
    }
    const value = resolved.endsWith('.wasm') || resolved.endsWith('.node')
      ? read(resolved, resolved).value
      : readTextFile(resolved);
    if (isWasmBytes(value)) return wasmModuleSource(value, resolved, processOverride);
    if (resolved.endsWith('.json')) return `export default ${JSON.stringify(JSON.parse(sourceText(value)))};`;
    const loadedText = typeof stripTypeScript === 'function'
      && /\.(?:[cm]?ts)$/i.test(stripPathIdentity(resolved))
      ? stripTypeScript(sourceText(value))
      : sourceText(value);
    if (moduleFormat(resolved) !== 'module' && !hasEsmSyntax(loadedText)) return cjsModuleSource(resolved, loadedText, processOverride);
    const moduleText = stripHashbang(loadedText);
    return `${bindProcess(await rewriteImportsAsync(moduleText, resolved, processOverride, ancestors), processOverride)}\n//# sourceURL=${resolved}`;
  };

  const moduleURLAsync = async (resolved, processOverride, importer = resolved, ancestors = new Set(), formatHint = null) => {
    const key = cacheKey(resolved, processOverride);
    const parentKey = typeof importer === 'string' ? cacheKey(importer, processOverride) : null;
    if (parentKey && asyncModuleDependencies.has(parentKey)) asyncModuleDependencies.get(parentKey).add(key);
    if (moduleURLs.has(key)) return moduleURLs.get(key);
    if (isBuiltinSpecifier(resolved)) return moduleURL(resolved, processOverride);
    if (ancestors.has(key)) {
      return cycleModuleURL(resolved, importer, processOverride);
    }
    if (cycleModuleURLs.has(key)) return cycleModuleURLs.get(key);
    if (asyncModuleURLs.has(key)) {
      // Concurrent graph preparation can reach a module that is already being
      // built by a sibling branch. Awaiting that promise is safe for a root
      // import, but it can deadlock when the pending module's graph reaches
      // back into the current branch (dual-package CJS preloads make this
      // shape common). Use the same live cycle proxy as an explicit ancestor;
      // the owner graph will publish the real bindings when it completes.
      if (ancestors.size && asyncModuleDependsOn(key, ancestors)) return cycleModuleURL(resolved, importer, processOverride);
      return asyncModuleURLs.get(key);
    }
    const dependencies = new Set();
    asyncModuleDependencies.set(key, dependencies);
    const promise = (async () => {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(key);
      const source = await moduleSourceAsync(resolved, processOverride, nextAncestors, formatHint);
      const registration = cycleRegistrations.get(key);
      let publishedSource = source;
      if (registration) {
        const publication = [];
        const publishedNames = new Set();
        for (const name of registration.names) {
          const binding = registration.bindings.get(name);
          if (binding) {
            publication.push(`${quote(name)}: ${binding}`);
            publishedNames.add(name);
          }
        }
        if (registration.defaultBinding) {
          publication.push(`default: ${registration.defaultBinding}`);
          publishedNames.add('default');
        }
        const reexportImports = [];
        for (const [index, reexport] of (registration.reexports || []).entries()) {
          const url = cycleReexportURLs.get(cycleReexportKey(resolved, reexport.specifier, processOverride));
          if (!url) continue;
          const alias = `__bnhCycleReexport${index}`;
          reexportImports.push(`import * as ${alias} from ${quote(url)};`);
          for (const name of reexport.names) {
            if (publishedNames.has(name)) continue;
            publication.push(`${quote(name)}: ${alias}[${quote(name)}]`);
            publishedNames.add(name);
          }
        }
        const publishSource = publication.length
          ? `globalThis[${quote(registryName)}][${quote(registration.token)}]().publish({${publication.join(',')}});`
          : '';
        publishedSource = `${reexportImports.join('\n')}${reexportImports.length ? '\n' : ''}${source}${publishSource ? `\n${publishSource}` : ''}`;
      }
      const finalSource = publishedSource;
      const url = generatedModuleURL(
        finalSource,
        `${registryName}_${moduleSequence++}${processKey(processOverride)}`,
        resolved,
      );
      moduleURLs.set(key, url);
      return url;
    })();
    asyncModuleURLs.set(key, promise);
    promise.catch(() => {
      if (asyncModuleURLs.get(key) === promise) asyncModuleURLs.delete(key);
      if (asyncModuleDependencies.get(key) === dependencies) asyncModuleDependencies.delete(key);
    });
    return promise;
  };

  const importNative = async (resolved, processOverride, formatHint = null, dynamicLaneKey = null) => {
    const key = cacheKey(resolved, processOverride);
    if (!importCache.has(key)) {
      const laneId = dynamicLaneKey === null || dynamicLaneKey === undefined
        ? null
        : cacheKey(String(dynamicLaneKey), processOverride);
      const previousLane = laneId ? (dynamicImportLanes.get(laneId) || Promise.resolve()) : null;
      let releaseLane;
      const laneReady = laneId ? new Promise((resolve) => { releaseLane = resolve; }) : null;
      if (laneId) dynamicImportLanes.set(laneId, previousLane.then(() => laneReady));
      let pendingImport;
      pendingImport = (async () => {
        let url;
        try {
          if (previousLane) await previousLane;
          url = moduleURLs.has(key)
            ? moduleURLs.get(key)
            : await moduleURLAsync(resolved, processOverride, resolved, new Set(), formatHint);
          // Release the next request after graph preparation, immediately
          // before invoking the browser's native import job.
          releaseLane?.();
          releaseLane = null;
        } catch (error) {
          releaseLane?.();
          releaseLane = null;
          if (error?.code === 'MODULE_NOT_FOUND') {
            error.code = 'ERR_MODULE_NOT_FOUND';
            error.name = 'Error [ERR_MODULE_NOT_FOUND]';
          }
          throw error;
        }
        try {
          const namespace = await import(url);
          storeSharedNamespace(resolved, processOverride, namespace);
          return namespace;
        } catch (error) {
          if (error?.code === 'MODULE_NOT_FOUND') {
            error.code = 'ERR_MODULE_NOT_FOUND';
            error.name = 'Error [ERR_MODULE_NOT_FOUND]';
          }
          const message = String(error?.message || '');
          const hint = [...nativeSpecifierHints.entries()].find(([internalURL]) => message.includes(internalURL));
          if (hint) {
            const [internalURL, originalSpecifier] = hint;
            error.message = message.replaceAll(internalURL, originalSpecifier);
            if (typeof error.stack === 'string') error.stack = error.stack.replaceAll(internalURL, originalSpecifier);
          }
          // A failed native import must not poison this specifier forever.
          // Packages may be installed into the VFS after an initial lookup, so
          // a later import must be allowed to resolve and evaluate the module
          // again just as it would in a normal Node process after installation.
          if (importCache.get(key) === pendingImport) importCache.delete(key);
          throw error;
        }
      })();
      importCache.set(key, pendingImport);
    }
    return importCache.get(key);
  };

  const validateImportAttributes = (resolved, options) => {
    if (options?.assert !== undefined) {
      throw packageError('ERR_IMPORT_ATTRIBUTE_MISSING', 'Import assertions are not supported');
    }
    const attributes = options?.with;
    if (!attributes || typeof attributes !== 'object') return;
    if (Object.keys(attributes).some((key) => key !== 'type')) {
      throw packageError('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', 'Import attribute is not supported');
    }
    if (attributes.type === undefined) return;
    if (resolved.endsWith('.json')) {
      if (attributes.type !== 'json') {
        throw packageError('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute type "${attributes.type}" is not supported`);
      }
      return;
    }
    if (attributes.type === 'json') {
      throw packageError('ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', 'Module type attribute is incompatible with JavaScript');
    }
    throw packageError('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute type "${attributes.type}" is not supported`);
  };

  const importModule = async (specifier, importer, globals, options, processOverride, dynamicLaneKey = null) => {
    const resolvedResult = await runResolveHooksAsync(specifier, importer, ['node', 'import'], processOverride);
    const resolved = hookURLToSpecifier(resolvedResult.url, importer);
    if (resolved.startsWith('data:')) return importData(resolved, options, processOverride);
    if (resolved.startsWith('http:') || resolved.startsWith('https:')) {
      validateImportAttributes(resolved, options);
      const url = await moduleURLAsync(resolved, processOverride);
      return import(url);
    }
    if (!resolved.startsWith('node:') && /^[A-Za-z][A-Za-z\d+.-]*:/.test(resolved)) {
      validateImportAttributes(resolved, options);
      const url = await moduleURLAsync(resolved, processOverride);
      return import(url);
    }
    validateImportAttributes(resolved, options);
    if (resolved.endsWith('.json') && options?.with?.type !== 'json') {
      throw packageError('ERR_IMPORT_ATTRIBUTE_MISSING', 'Module import attribute "type" is required for JSON modules');
    }
    const moduleMocks = processOverride?.__bnhModuleMocks
      || globalObject.process?.__bnhModuleMocks
      || globalObject.__bnhModuleMocks;
    const moduleMock = moduleMocks?.get(resolved)
      || moduleMocks?.get(resolved.startsWith('node:') ? resolved.slice(5) : undefined);
    if (moduleMock?.active) return moduleMock.getNamespace();
    const shared = sharedNamespace(resolved, processOverride);
    if (shared) {
      if (!Object.hasOwn(shared, '__esModule')) return shared;
      const importNamespace = { ...shared };
      delete importNamespace.__esModule;
      Object.defineProperty(importNamespace, Symbol.toStringTag, { value: 'Module' });
      return importNamespace;
    }
    if (resolved.startsWith('node:') && !isBuiltinSpecifier(resolved)) {
      throw packageError('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${resolved.slice(5)}`);
    }
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved)) unsupportedNativeAddon(resolved);
    // A resolve hook may intentionally omit `format` and leave classification
    // to its load hook (ts-node does this for .ts files). Preserve that
    // distinction: `undefined` lets the load hook see the unknown extension,
    // while an explicit null remains a hook-provided value.
    const resolvedFormat = Object.hasOwn(resolvedResult, 'format') ? resolvedResult.format : undefined;
    const key = cacheKey(resolved, processOverride);
    if (importCache.has(key)) return importCache.get(key);
    // Native ESM modules are materialized into data URLs before evaluation. Keep
    // using that captured graph on later imports: the backing virtual file may
    // have been removed or replaced after the static import was prepared, but
    // Node's ESM cache is keyed by the module URL rather than fresh file reads.
    // moduleURLs is the canonical cache; retaining the generated source beside
    // its encoded URL needlessly keeps a second copy of every ESM module alive.
    if (moduleURLs.has(key)) return importNative(resolved, processOverride, resolvedFormat, dynamicLaneKey);
    if (isBuiltinSpecifier(resolved)
      || resolvedFormat === 'module'
      || resolvedFormat === undefined
      || (resolvedFormat === null && moduleFormat(resolved) === 'module')) {
      return importNative(resolved, processOverride, resolvedFormat, dynamicLaneKey);
    }
    let exports;
    try {
      exports = evaluate(resolved, importer, globals, processOverride);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'MODULE_NOT_FOUND') {
        const missing = new Error(`Cannot find module '${specifier}' imported from '${importer}'`);
        missing.code = 'ERR_MODULE_NOT_FOUND';
        missing.name = 'Error [ERR_MODULE_NOT_FOUND]';
        throw missing;
      }
      throw error;
    }
    const module = cache[key];
    if (module?.promise) await module.promise;
    const namespace = {
      default: exports,
      ...(exports && (typeof exports === 'object' || typeof exports === 'function') ? exports : {}),
    };
    importCache.set(key, namespace);
    return namespace;
  };

  return {
    cache,
    resolve,
    resolveRequire,
    resolveWithHooks: (specifier, importer, conditions = ['node', 'import']) => (
      runResolveHooks(specifier, importer, conditions)
    ),
    require: (specifier, importer, globals = {}, processOverride) => evaluate(specifier, importer, globals, processOverride),
    import: (specifier, importer = '/node/index.mjs', globals = {}, options, processOverride) => importModule(specifier, importer, globals, options, processOverride),
    syncBuiltinESMExports,
    normalize,
    moduleURL,
    dispose: () => {
      delete globalObject[registryName];
      packageConfigCache.clear();
      for (const objectURL of generatedObjectURLs) {
        try { globalObject.URL.revokeObjectURL(objectURL); } catch { /* already revoked */ }
        generatedObjectImporters.delete(objectURL);
        blobVirtualPaths.delete(objectURL);
      }
      generatedObjectURLs.clear();
      for (const collection of [moduleURLs, importCache, nativeSpecifierHints, cycleModuleURLs,
        cycleRegistrations, remoteImportCache, asyncModuleURLs, asyncModuleDependencies]) collection.clear();
      buildingModuleKeys.clear();
      for (const key of Object.keys(cache)) delete cache[key];
    },
  };
}
