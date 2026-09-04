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
let nextLoaderId = 0;

function normalize(value) {
  return posix.normalize(value).replace(/^\.\//, '');
}

function isValidExportName(value) {
  return /^[$A-Z_a-z][$\w]*$/.test(value) && !RESERVED_EXPORT_NAMES.has(value);
}

function hasEsmSyntax(source) {
  return /(?:^|[;\n])\s*(?:export\s+(?:default\b|(?:const|let|var|function|class)\b|[*{])|import\s*(?:(?:[^'";]*?from\s*)?['"]))/m.test(source);
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
  defaultModuleType = 'commonjs',
} = {}) {
  const registeredHooks = sharedRunModuleHook ? [] : wrapSynchronousLoadHook(builtins?.module);
  const cache = Object.create(null);
  const moduleURLs = new Map();
  const importCache = new Map();
  const nativeSpecifierHints = new Map();
  const cycleModuleURLs = new Map();
  const cycleRegistrations = new Map();
  const builtinEsmSyncers = new Set();
  const syncBuiltinESMExports = () => {
    for (const sync of builtinEsmSyncers) sync();
  };
  let mainModule = null;
  let moduleSequence = 0;
  const registryName = `__bnhEsmRegistry_${Date.now()}_${nextLoaderId++}_${moduleSequence++}`;
  const registry = Object.create(null);
  globalObject[registryName] = registry;

  const hasFile = (path) => {
    // A package pattern keeps repeated separators in its substituted target.
    // The VFS intentionally normalizes ordinary filesystem paths, so guard
    // this resolver boundary before delegating to it; otherwise a missing
    // `sub//internal/test` target aliases an existing `sub/internal/test.js`.
    if (typeof path === 'string' && path.startsWith('/') && path.includes('//')) return false;
    return typeof files?.has === 'function' ? files.has(path) : Object.hasOwn(files || {}, path);
  };
  const readFile = (path) => (typeof files?.get === 'function' ? files.get(path) : files[path]);
  // Textual module reads can use the VFS source cache, while binary module
  // formats continue through the byte-oriented files seam below.
  const readTextFile = (path) => typeof readSource === 'function' ? readSource(path) : readFile(path);
  const hasBuiltin = (name) => Object.prototype.hasOwnProperty.call(builtins || {}, name)
    || Object.prototype.hasOwnProperty.call(builtins || {}, `node:${name}`);
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
    if (!hasBuiltin(name)) return undefined;
    const overridden = resolveBuiltin?.(name, processOverride);
    if (overridden !== undefined) return overridden;
    return builtins[name] ?? builtins[`node:${name}`];
  };
  const isBuiltinSpecifier = (specifier) => hasBuiltin(builtinName(specifier));

  const fileURL = (path) => `file://${path}`;
  const hookContext = (specifier, importer, conditions = ['node', 'import']) => ({
    conditions,
    importAttributes: {},
    parentURL: importer.startsWith('data:') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(importer)
      ? importer : fileURL(importer),
    source: specifier,
  });

  const defaultResolve = (specifier, importer, conditions = ['node', 'import']) => {
    const resolved = resolve(specifier, importer, conditions);
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

  const runResolveHooks = (specifier, importer, conditions = ['node', 'import']) => {
    const context = hookContext(specifier, importer, conditions);
    const fallback = (nextSpecifier, nextContext) => defaultResolve(
      nextSpecifier,
      nextContext?.parentURL?.startsWith('file:')
        ? fileURLToPath(nextContext.parentURL)
        : importer,
      nextContext?.conditions || ['node', 'import'],
    );
    if (sharedRunModuleHook) return sharedRunModuleHook('resolve', specifier, context, fallback);
    let next = (nextSpecifier, nextContext) => defaultResolve(
      nextSpecifier,
      nextContext?.parentURL?.startsWith('file:')
        ? fileURLToPath(nextContext.parentURL)
        : importer,
      nextContext?.conditions || ['node', 'import'],
    );
    for (let index = registeredHooks.length - 1; index >= 0; index -= 1) {
      const hook = registeredHooks[index]?.resolve;
      if (typeof hook !== 'function') continue;
      const previous = next;
      next = (nextSpecifier, nextContext) => hook(nextSpecifier, nextContext, previous);
    }
    const result = next(specifier, context);
    if (!result || typeof result !== 'object' || typeof result.url !== 'string') {
      throw new TypeError('module resolve hook must return an object with a string url');
    }
    return result;
  };

  const runResolveHooksAsync = async (specifier, importer, conditions = ['node', 'import']) => {
    if (!sharedRunModuleHook) return runResolveHooks(specifier, importer, conditions);
    const context = hookContext(specifier, importer, conditions);
    const fallback = (nextSpecifier, nextContext) => defaultResolve(
      nextSpecifier,
      nextContext?.parentURL?.startsWith('file:')
        ? fileURLToPath(nextContext.parentURL)
        : importer,
      nextContext?.conditions || ['node', 'import'],
    );
    const result = await sharedRunModuleHook('resolve', specifier, context, fallback);
    if (!result || typeof result !== 'object' || typeof result.url !== 'string') {
      throw new TypeError('module resolve hook must return an object with a string url');
    }
    return result;
  };

  const defaultLoad = (url, context = {}) => {
    if (url.startsWith('node:')) return { format: 'builtin', source: null };
    if (url.startsWith('data:')) return { format: 'module', source: null };
    const resolved = url.startsWith('file:') ? fileURLToPath(url) : url;
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved)) unsupportedNativeAddon(resolved);
    const value = resolved.endsWith('.wasm') || resolved.endsWith('.node')
      ? read(resolved, resolved).value
      : readTextFile(resolved);
    return {
      format: context?.format ?? (resolved.endsWith('.json') ? 'json' : moduleFormat(resolved)),
      source: value,
    };
  };

  const runLoadHooks = (resolved, format) => {
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
      const result = sharedRunModuleHook('load', url, context, (nextURL, nextContext) => defaultLoad(nextURL, nextContext));
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

  const hookURLToSpecifier = (url) => {
    if (url.startsWith('file:')) return fileURLToPath(url);
    if (url.startsWith('node:')) return url;
    return url;
  };

  const sourceText = (value) => typeof value === 'string'
    ? value
    : new TextDecoder().decode(value);

  const packageConfigCache = new Map();
  // npm's .bin directory contains executable shims rather than package
  // modules. Its owning project package scope remains relevant when a shim
  // is an extensionless ESM entry point.
  const isNpmBinShimPath = (pathname) => /\/node_modules\/\.bin(?:\/|$)/.test(String(pathname));

  const packageConfig = (base) => {
    const packagePath = posix.join(base, 'package.json');
    if (!hasFile(packagePath)) return undefined;
    if (packageConfigCache.has(packagePath)) return packageConfigCache.get(packagePath);
    try {
      const config = JSON.parse(sourceText(readTextFile(packagePath)));
      packageConfigCache.set(packagePath, config);
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
    if (resolved.endsWith('.mjs')) return 'module';
    if (resolved.endsWith('.cjs')) return 'commonjs';
    const extension = posix.extname(resolved);
    if (extension && !['.js', '.json', '.node'].includes(extension)) {
      throw packageError(
        'ERR_UNKNOWN_FILE_EXTENSION',
        `Unknown file extension "${extension}" for ${resolved}`,
      );
    }
    const type = packageScopeType(resolved);
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
      if (directory === '/') break;
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

  const resolvePackage = (specifier, importer, conditions = ['node', 'import']) => {
    const parts = specifier.split('/');
    const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = parts.slice(packageName.split('/').length).join('/');
    let directory = posix.dirname(importer);
    for (;;) {
      const packageRoot = posix.join(directory, 'node_modules', packageName);
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
        const exportsMap = typeof config.exports === 'string' || Array.isArray(config.exports)
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
        if (exported !== undefined) return exported;
        throw packageError('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${request}' is not defined`);
      }
      const base = subpath ? posix.join(packageRoot, subpath) : packageRoot;
      const resolved = resolveFileOrDirectory(base, false, fileCandidateList, directoryCandidateList);
      if (resolved) return resolved;
      if (directory === '/') break;
      directory = posix.dirname(directory);
    }
    return undefined;
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
    const rawValue = String(specifier);
    let value = rawValue;
    if (rawValue.startsWith('file:')) value = fileURLToPath(rawValue);
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
    if (hasBuiltin(name)) return value.startsWith('node:') ? `node:${name}` : name;
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
      return resolveInternalModule(value)
        || resolveNodeLibrary(value)
        || resolvePackage(value, importer, conditions)
        || value;
    }
    if ((importer.startsWith('http:') || importer.startsWith('https:'))
      && (value.startsWith('./') || value.startsWith('../') || value === '.' || value === '..')) {
      return new URL(value, importer).href;
    }
    const base = value.startsWith('/') ? value : posix.join(posix.dirname(importer), value);
    // ESM resolution does not add file extensions. CommonJS resolution keeps
    // the Node-style extension and index fallbacks through require conditions.
    if (conditions.includes('import') && !posix.extname(value)) return base;
    return resolveFileOrDirectory(base, false) || base;
  };

  const resolveRequire = (specifier, importer = '/node/index.js') => {
    const rawValue = String(specifier);
    const value = rawValue.startsWith('file:') ? fileURLToPath(rawValue) : rawValue;
    const name = builtinName(value);
    if (hasBuiltin(name)) return value.startsWith('node:') ? `node:${name}` : name;
    if (value.startsWith('node:')) {
      const libraryFile = resolveInternalModule(name) || resolveNodeLibrary(name);
      if (libraryFile) return libraryFile;
      throw packageError('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${name}`);
    }
    if (value.startsWith('#')) {
      const imported = resolvePackageImports(value, importer, ['node', 'require']);
      if (imported.startsWith('node:') || imported.startsWith('data:')
        || imported.startsWith('http:') || imported.startsWith('https:')) return imported;
      const candidate = resolveFileOrDirectory(imported, false, commonJsFileCandidates, commonJsDirectoryCandidates);
      if (candidate) return candidate;
      throw packageError('MODULE_NOT_FOUND', `Cannot find module '${value}'`);
    }
    if (value.startsWith('data:') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) return resolve(value, importer, ['node', 'require']);
    if (!isPathSpecifier(value)) {
      const resolved = resolvePackage(value, importer, ['node', 'require']);
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

  const read = (specifier, importer) => {
    const resolved = resolve(specifier, importer);
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
        const child = read(specifier, resolved);
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

  const esmExportNames = (source) => {
    const value = String(source);
    const names = new Set();
    const bindings = new Map();
    for (const match of value.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+([$A-Z_a-z][$\w]*)/g)) {
      if (isValidExportName(match[1])) {
        names.add(match[1]);
        bindings.set(match[1], match[1]);
      }
    }
    for (const match of value.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
      for (const part of match[1].split(',')) {
        const pieces = part.trim().split(/\s+as\s+/);
        const local = pieces[0].trim().replace(/^(['"])(.*?)\1$/, '$2');
        const name = (pieces[1] || pieces[0]).trim().replace(/^(['"])(.*?)\1$/, '$2');
        if (isValidExportName(name)) {
          names.add(name);
          if (!match[0].includes(' from ')) bindings.set(name, local);
        }
      }
    }
    const defaultDeclaration = value.match(/\bexport\s+default\s+(?:async\s+)?(?:function|class)\s+([$A-Z_a-z][$\w]*)/);
    return {
      defaultExport: /\bexport\s+default\b/.test(value),
      names,
      bindings,
      defaultBinding: defaultDeclaration?.[1],
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
    const analysis = esmExportNames(source);
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
    cycleRegistrations.set(key, { names: analysis.names, bindings: analysis.bindings, defaultBinding: analysis.defaultBinding, token });
    const access = `globalThis[${quote(registryName)}][${quote(token)}]()`;
    const namedExports = [...analysis.names].map((name) => {
      const local = `__bnhCycleExport_${name.replace(/[^$\w]/g, '_')}`;
      return `let ${local} = ${access}.values[${quote(name)}];\nexport { ${local} as ${quote(name)} };`;
    });
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
      return `${local} = values?.[${quote(name)}];`;
    }).join(' ');
    return [
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
    const url = `data:text/javascript;charset=utf-8,${encodeModuleSource(source)}#${registryName}_cycle_${moduleSequence++}${processKey(processOverride)}`;
    cycleModuleURLs.set(key, url);
    return url;
  };

  const invalidCjsModuleURL = (specifier, exportName) => {
    const message = `The requested module '${specifier}' does not provide an export named '${exportName}'`;
    const source = `export default undefined;\nthrow new SyntaxError(${quote(message)});`;
    return `data:text/javascript;charset=utf-8,${encodeModuleSource(source)}#${registryName}_${moduleSequence++}`;
  };

  const cjsHasEsmSyntax = (resolved) => {
    if (resolved.endsWith('.mjs') || resolved.endsWith('.json') || isBuiltinSpecifier(resolved)) return false;
    try {
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
      const first = clause.slice(1).split(',')[0].trim();
      return first.split(/\s+as\s+/)[0].trim().replace(/^(['"])(.*?)\1$/, '$2');
    }
    return isImport ? 'default' : clause.split(',')[0].trim();
  };

  function rewriteSpecifier(specifier, importer, exportName, processOverride) {
    specifier = decodeStaticString(specifier);
    const resolvedResult = runResolveHooks(specifier, importer);
    const resolved = hookURLToSpecifier(resolvedResult.url);
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
    const canStartRegex = (index) => {
      let cursor = index - 1;
      while (cursor >= 0 && /\s/.test(value[cursor])) cursor -= 1;
      if (cursor < 0) return true;
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

  const hasTopLevelProcessBinding = (source) => {
    const masked = maskJavaScriptLiterals(source);
    return /(?:^|[;\n])\s*(?:export\s+)?(?:const|let|var|function|class)\s+(?:process\b|[({[][^;\n}]*\bprocess\b)/m.test(masked)
      || /(?:^|[;\n])\s*import\s+(?:process\b|\*\s+as\s+process\b|[^;\n]*\bas\s+process\b|\{[^}\n]*\bprocess\b[^}\n]*\})/m.test(masked);
  };

  const bindProcess = (source, processOverride) => {
    if (!processOverride || hasTopLevelProcessBinding(source)) return source;
    const token = register(() => {
      return processOverride;
    });
    return `const process = globalThis[${quote(registryName)}][${quote(token)}]();\n${source}`;
  };

  function rewriteImports(source, importer, processOverride) {
    let rewritten = String(source);
    const rewriteStatic = (pattern, exportAware) => {
      const masked = maskJavaScriptLiterals(rewritten);
      const matches = [...masked.matchAll(pattern)];
      const originalPattern = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index];
        const original = rewritten.slice(match.index, match.index + match[0].length).match(originalPattern);
        if (!original) continue;
        const specifier = original[4];
        const prefix = original[2];
        const quoteOffset = original[0].indexOf(original[3], original[1].length + prefix.length);
        const start = match.index + quoteOffset;
        const replacement = quote(rewriteSpecifier(
          specifier,
          importer,
          exportAware ? requestedExportName(prefix) : undefined,
          processOverride,
        ));
        rewritten = `${rewritten.slice(0, start)}${replacement}${rewritten.slice(start + specifier.length + 2)}`;
      }
    };
    rewriteStatic(
      /(^|[;\n])([ \t]*(?:import|export)\s*[^;]*?\s*from\s*)(['"])((?:\\.|[^'"])*)\3/gm,
      true,
    );
    rewriteStatic(
      /(^|[;\n])([ \t]*import[ \t]*)(['"])((?:\\.|[^'"])*)\3/gm,
      false,
    );
    if (/\bimport\s*\(/.test(rewritten)) {
      const token = register((dynamicSpecifier, options) => importModule(
        dynamicSpecifier,
        importer,
        {},
        options,
        processOverride,
      ));
      rewritten = rewritten.replace(/\bimport\s*\(/g, `globalThis[${quote(registryName)}][${quote(token)}](`);
    }
    if (/\bimport\.meta\.resolve\b/.test(rewritten)) {
      const token = register((specifier) => {
        const hooked = runResolveHooks(specifier, importer);
        if (hooked && typeof hooked.then === 'function') hooked.catch(() => {});
        const resolved = hooked && typeof hooked.url === 'string'
          ? hookURLToSpecifier(hooked.url)
          : resolve(specifier, importer, ['node', 'import']);
        if (isBuiltinSpecifier(resolved) || resolved.startsWith('node:')) return `node:${builtinName(resolved)}`;
        return resolved.startsWith('data:') ? resolved : fileURL(resolved);
      });
      rewritten = rewritten.replace(
        /\bimport\.meta\.resolve\b/g,
        `globalThis[${quote(registryName)}][${quote(token)}]`,
      );
    }
    rewritten = rewritten.replace(/\s+with\s*\{\s*type\s*:\s*['"]json['"]\s*\}/g, '');
    // Native data modules do not have a file URL. Preserve the Node-facing
    // identity used by code that builds URLs relative to import.meta.url.
    rewritten = rewritten.replace(/\bimport\.meta\.filename\b/g, quote(importer));
    rewritten = rewritten.replace(/\bimport\.meta\.dirname\b/g, quote(posix.dirname(importer)));
    rewritten = rewritten.replace(/\bimport\.meta\.url\b/g, quote(importer.startsWith('data:') ? importer : `file://${importer}`));
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
    const loaded = runLoadHooks(resolved, format);
    const loadedResolved = loaded.url ? hookURLToSpecifier(loaded.url) : resolved;
    if (loaded.format === 'builtin' && isBuiltinSpecifier(loadedResolved)) {
      return builtinModuleSource(loadedResolved, builtin(loadedResolved, processOverride));
    }
    if (loaded.source !== undefined && loaded.source !== null) {
      if (isWasmBytes(loaded.source)) return wasmModuleSource(loaded.source, loadedResolved, processOverride);
      const loadedText = sourceText(loaded.source);
      if (loaded.format === 'json') return `export default ${JSON.stringify(JSON.parse(loadedText))};`;
      if (loaded.format === 'module' || hasEsmSyntax(loadedText)) {
        return `${bindProcess(rewriteImports(loadedText, loadedResolved, processOverride), processOverride)}\n//# sourceURL=${loadedResolved}`;
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
    const loadedText = sourceText(value);
    if (moduleFormat(resolved) !== 'module' && !hasEsmSyntax(loadedText)) return cjsModuleSource(resolved, loadedText, processOverride);
    return `${bindProcess(rewriteImports(loadedText, resolved, processOverride), processOverride)}\n//# sourceURL=${resolved}`;
  }

  function moduleURL(resolved, processOverride, formatHint = null) {
    const key = cacheKey(resolved, processOverride);
    if (moduleURLs.has(key)) return moduleURLs.get(key);
    const source = moduleSource(resolved, processOverride, formatHint);
    // Native ESM caches by URL for the lifetime of the browser realm. Give
    // each runtime loader a private fragment so a second virtual child using
    // the same VFS path executes its own module instance.
    const url = `data:text/javascript;charset=utf-8,${encodeModuleSource(source)}#${registryName}${processKey(processOverride)}`;
    moduleURLs.set(key, url);
    return url;
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
    const source = sourceText(rawSource);
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
      const transformed = source.replace(/\bimport\s*\(/g, '__bnhImport(');
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
        ? await sharedRunModuleHook('load', resolved, context, () => undefined)
        : undefined;
      if (!loaded || loaded.source === undefined || loaded.source === null) {
        throw packageError('ERR_UNSUPPORTED_ESM_URL_SCHEME', `No loader is registered for ${resolved}`);
      }
      const source = await rewriteRemoteImports(sourceText(loaded.source), resolved);
      const url = `data:text/javascript;charset=utf-8,${encodeModuleSource(source)}#${registryName}_${moduleSequence++}`;
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
  const runLoadHooksAsync = async (resolved, format) => {
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
      ? await sharedRunModuleHook('load', url, context, (nextURL, nextContext) => defaultLoad(nextURL, nextContext))
      : runLoadHooks(resolved, format);
    if (!result || typeof result !== 'object') throw new TypeError('module load hook must return an object');
    return { ...result, url: result.url || url };
  };

  const rewriteImportsAsync = async (source, importer, processOverride, ancestors) => {
    let rewritten = String(source);
    const patterns = [
      {
        pattern: /(^|[;\n])([ \t]*(?:import|export)\s*[^;]*?\s*from\s*)(['"])((?:\\.|[^'"])*)\3/gm,
        exportAware: true,
      },
      {
        pattern: /(^|[;\n])([ \t]*import[ \t]*)(['"])((?:\\.|[^'"])*)\3/gm,
        exportAware: false,
      },
    ];
    for (const { pattern, exportAware } of patterns) {
      const masked = maskJavaScriptLiterals(rewritten);
      const matches = [...masked.matchAll(pattern)];
      const originalPattern = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      const replacements = [];
      for (const match of matches) {
        const original = rewritten.slice(match.index, match.index + match[0].length).match(originalPattern);
        if (!original) continue;
        const specifier = original[4];
        const prefix = original[2];
        const quoteOffset = original[0].indexOf(original[3], original[1].length + prefix.length);
        const resolvedResult = await runResolveHooksAsync(specifier, importer);
        const resolved = hookURLToSpecifier(resolvedResult.url);
        const formatHint = Object.hasOwn(resolvedResult, 'format') ? resolvedResult.format : null;
        const url = await moduleURLAsync(resolved, processOverride, importer, ancestors, formatHint);
        nativeSpecifierHints.set(url, specifier);
        const exportName = exportAware ? requestedExportName(prefix) : undefined;
        // JSON modules expose one ESM binding: default. Preserve a default
        // import while retaining the native-style failure for named imports.
        if (exportName && exportName !== 'default' && resolved.endsWith('.json')) {
          replacements.push({
            start: match.index + quoteOffset,
            end: match.index + quoteOffset + specifier.length + 2,
            replacement: quote(invalidCjsModuleURL(specifier, exportName)),
            exportAware,
            prefix,
          });
          continue;
        }
        replacements.push({
          start: match.index + quoteOffset,
          end: match.index + quoteOffset + specifier.length + 2,
          replacement: quote(url),
          exportAware,
          prefix,
        });
      }
      for (const replacement of replacements.filter(Boolean).reverse()) {
        rewritten = `${rewritten.slice(0, replacement.start)}${replacement.replacement}${rewritten.slice(replacement.end)}`;
      }
    }
    if (/\bimport\s*\(/.test(rewritten)) {
      const token = register((dynamicSpecifier, options) => {
        const pending = globalObject.process?.__bnhModuleRegistrationPromises;
        const load = () => importModule(dynamicSpecifier, importer, {}, options, processOverride);
        return pending?.length ? Promise.all([...pending]).then(load) : load();
      });
      rewritten = rewritten.replace(/\bimport\s*\(/g, `globalThis[${quote(registryName)}][${quote(token)}](`);
    }
    if (/\bimport\.meta\.resolve\b/.test(rewritten)) {
      const token = register((specifier) => {
        const hooked = runResolveHooks(specifier, importer);
        if (hooked && typeof hooked.then === 'function') hooked.catch(() => {});
        const resolved = hooked && typeof hooked.url === 'string'
          ? hookURLToSpecifier(hooked.url)
          : resolve(specifier, importer, ['node', 'import']);
        if (isBuiltinSpecifier(resolved) || resolved.startsWith('node:')) return `node:${builtinName(resolved)}`;
        return resolved.startsWith('data:') ? resolved : fileURL(resolved);
      });
      rewritten = rewritten.replace(/\bimport\.meta\.resolve\b/g, `globalThis[${quote(registryName)}][${quote(token)}]`);
    }
    rewritten = rewritten.replace(/\s+with\s*\{\s*type\s*:\s*['"]json['"]\s*\}/g, '');
    rewritten = rewritten.replace(/\bimport\.meta\.filename\b/g, quote(importer));
    rewritten = rewritten.replace(/\bimport\.meta\.dirname\b/g, quote(posix.dirname(importer)));
    rewritten = rewritten.replace(/\bimport\.meta\.url\b/g, quote(importer.startsWith('data:') ? importer : `file://${importer}`));
    return rewritten;
  };

  const moduleSourceAsync = async (resolved, processOverride, ancestors, formatHint = null) => {
    const builtinValue = builtin(resolved, processOverride);
    const format = formatHint !== null ? formatHint
      : isBuiltinSpecifier(resolved) ? 'builtin'
      : /^[A-Za-z][A-Za-z\d+.-]*:/.test(resolved) ? 'module'
      : resolved.endsWith('.json') ? 'json' : moduleFormatForHook(resolved);
    const loaded = await runLoadHooksAsync(resolved, format);
    const loadedResolved = loaded.url ? hookURLToSpecifier(loaded.url) : resolved;
    if (loaded.format === 'builtin' && isBuiltinSpecifier(loadedResolved)) {
      return builtinModuleSource(loadedResolved, builtin(loadedResolved, processOverride));
    }
    if (loaded.source !== undefined && loaded.source !== null) {
      if (isWasmBytes(loaded.source)) return wasmModuleSource(loaded.source, loadedResolved, processOverride);
      const loadedText = sourceText(loaded.source);
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
    const loadedText = sourceText(value);
    if (moduleFormat(resolved) !== 'module' && !hasEsmSyntax(loadedText)) return cjsModuleSource(resolved, loadedText, processOverride);
    const moduleText = stripHashbang(loadedText);
    return `${bindProcess(await rewriteImportsAsync(moduleText, resolved, processOverride, ancestors), processOverride)}\n//# sourceURL=${resolved}`;
  };

  const moduleURLAsync = async (resolved, processOverride, importer = resolved, ancestors = new Set(), formatHint = null) => {
    const key = cacheKey(resolved, processOverride);
    if (moduleURLs.has(key)) return moduleURLs.get(key);
    if (isBuiltinSpecifier(resolved)) return moduleURL(resolved, processOverride);
    if (ancestors.has(key)) {
      return cycleModuleURL(resolved, importer, processOverride);
    }
    if (cycleModuleURLs.has(key)) return cycleModuleURLs.get(key);
    if (asyncModuleURLs.has(key)) return asyncModuleURLs.get(key);
    const promise = (async () => {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(key);
      const source = await moduleSourceAsync(resolved, processOverride, nextAncestors, formatHint);
      const registration = cycleRegistrations.get(key);
      const publishedSource = registration
        ? `${source}\n${registration.names.size || registration.defaultBinding ? `globalThis[${quote(registryName)}][${quote(registration.token)}]().publish({${[...registration.names].map((name) => {
          const binding = registration.bindings.get(name);
          return binding ? `${quote(name)}: ${binding}` : '';
        }).filter(Boolean).concat(registration.defaultBinding ? [`default: ${registration.defaultBinding}`] : []).join(',')}});` : ''}`
        : source;
      const finalSource = publishedSource;
      const url = `data:text/javascript;charset=utf-8,${encodeModuleSource(finalSource)}#${registryName}_${moduleSequence++}${processKey(processOverride)}`;
      moduleURLs.set(key, url);
      return url;
    })();
    asyncModuleURLs.set(key, promise);
    promise.catch(() => {
      if (asyncModuleURLs.get(key) === promise) asyncModuleURLs.delete(key);
    });
    return promise;
  };

  const importNative = async (resolved, processOverride, formatHint = null) => {
    const key = cacheKey(resolved, processOverride);
    if (!importCache.has(key)) {
      let url;
      try {
        url = await moduleURLAsync(resolved, processOverride, resolved, new Set(), formatHint);
      } catch (error) {
        if (error?.code === 'MODULE_NOT_FOUND') {
          error.code = 'ERR_MODULE_NOT_FOUND';
          error.name = 'Error [ERR_MODULE_NOT_FOUND]';
        }
        throw error;
      }
      importCache.set(key, import(url).then((namespace) => {
        storeSharedNamespace(resolved, processOverride, namespace);
        return namespace;
      }).catch((error) => {
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
        throw error;
      }));
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

  const importModule = async (specifier, importer, globals, options, processOverride) => {
    const resolvedResult = await runResolveHooksAsync(specifier, importer);
    const resolved = hookURLToSpecifier(resolvedResult.url);
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
    const key = cacheKey(resolved, processOverride);
    if (importCache.has(key)) return importCache.get(key);
    // Native ESM modules are materialized into data URLs before evaluation. Keep
    // using that captured graph on later imports: the backing virtual file may
    // have been removed or replaced after the static import was prepared, but
    // Node's ESM cache is keyed by the module URL rather than fresh file reads.
    // moduleURLs is the canonical cache; retaining the generated source beside
    // its encoded URL needlessly keeps a second copy of every ESM module alive.
    if (moduleURLs.has(key)) {
      return import(moduleURLs.get(key));
    }
    const resolvedFormat = Object.hasOwn(resolvedResult, 'format') ? resolvedResult.format : null;
    if (isBuiltinSpecifier(resolved)
      || resolvedFormat === 'module'
      || resolvedFormat === undefined
      || (resolvedFormat === null && moduleFormat(resolved) === 'module')) {
      return importNative(resolved, processOverride, resolvedFormat);
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
    dispose: () => { delete globalObject[registryName]; },
  };
}
