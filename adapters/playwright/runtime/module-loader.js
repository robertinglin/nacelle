import { posix } from './path.js';
import { fileURLToPath } from './vfs.js';
import { unsupportedNativeAddon } from './errors.js';
import { isWasmModuleBytes, loadWasmAddon } from './addon-napi.js';

const RESERVED_EXPORT_NAMES = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

const NATIVE_ADDON_EXTENSION = '.node';
let nextLoaderId = 0;

function normalize(value) {
  return posix.normalize(value).replace(/^\.\//, '');
}

function isValidExportName(value) {
  return /^[$A-Z_a-z][$\w]*$/.test(value) && !RESERVED_EXPORT_NAMES.has(value);
}

function quote(value) {
  return JSON.stringify(value);
}

function decodeStaticString(value) {
  return value.replace(/\\([\\'"`])/g, '$1');
}

function packageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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

function directoryCandidates(base) {
  return [
    posix.join(base, 'index.js'),
    posix.join(base, 'index.cjs'),
    posix.join(base, 'index.mjs'),
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
} = {}) {
  const cache = new Map();
  const moduleURLs = new Map();
  const importCache = new Map();
  let mainModule = null;
  let moduleSequence = 0;
  const registryName = `__bnhEsmRegistry_${Date.now()}_${nextLoaderId++}_${moduleSequence++}`;
  const registry = Object.create(null);
  globalObject[registryName] = registry;

  const hasFile = (path) => (typeof files?.has === 'function' ? files.has(path) : Object.hasOwn(files || {}, path));
  const readFile = (path) => (typeof files?.get === 'function' ? files.get(path) : files[path]);
  const hasBuiltin = (name) => Object.prototype.hasOwnProperty.call(builtins || {}, name)
    || Object.prototype.hasOwnProperty.call(builtins || {}, `node:${name}`);
  const builtinName = (specifier) => String(specifier).startsWith('node:')
    ? String(specifier).slice(5)
    : String(specifier);
  const builtin = (specifier) => {
    const name = builtinName(specifier);
    if (!hasBuiltin(name)) return undefined;
    return builtins[name] ?? builtins[`node:${name}`];
  };

  const sourceText = (value) => typeof value === 'string'
    ? value
    : new TextDecoder().decode(value);

  const packageEntry = (base) => {
    const packagePath = posix.join(base, 'package.json');
    if (!hasFile(packagePath)) return undefined;
    let packageConfig;
    try {
      packageConfig = JSON.parse(sourceText(readFile(packagePath)));
    } catch (cause) {
      const error = new Error(`Invalid package config '${packagePath}'`);
      error.code = 'ERR_INVALID_PACKAGE_CONFIG';
      error.path = packagePath;
      error.cause = cause;
      throw error;
    }
    const exportsValue = packageConfig.exports;
    const rootExport = typeof exportsValue === 'string'
      ? exportsValue
      : exportsValue && typeof exportsValue === 'object'
        ? (typeof exportsValue['.'] === 'string'
          ? exportsValue['.']
          : exportsValue['.']?.import || exportsValue['.']?.default || exportsValue['.']?.node)
        : undefined;
    return typeof rootExport === 'string' ? rootExport : packageConfig.main;
  };

  const resolveFileOrDirectory = (base) => {
    const file = fileCandidates(base).find((candidate) => hasFile(candidate));
    if (file) return file;
    const entry = packageEntry(base);
    if (typeof entry === 'string') {
      const packageFile = fileCandidates(posix.join(base, entry)).find((candidate) => hasFile(candidate));
      if (packageFile) return packageFile;
    }
    return directoryCandidates(base).find((candidate) => hasFile(candidate));
  };

  const resolvePackage = (specifier, importer) => {
    const parts = specifier.split('/');
    const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = parts.slice(packageName.split('/').length).join('/');
    let directory = posix.dirname(importer);
    for (;;) {
      const packageRoot = posix.join(directory, 'node_modules', packageName);
      const base = subpath ? posix.join(packageRoot, subpath) : packageRoot;
      const resolved = resolveFileOrDirectory(base);
      if (resolved) return resolved;
      if (directory === '/') break;
      directory = posix.dirname(directory);
    }
    return undefined;
  };

  const resolve = (specifier, importer = '/node/index.js') => {
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
    if (value.startsWith('node:')) return `node:${name}`;
    if (value.startsWith('data:')) return value;
    if (!isPathSpecifier(value)) return resolvePackage(value, importer) || value;
    const base = value.startsWith('/') ? value : posix.join(posix.dirname(importer), value);
    return resolveFileOrDirectory(base) || base;
  };

  // A .node file whose bytes carry the WASM magic is a wasm32 addon built by
  // the host pipeline; it loads through the N-API layer. Any other .node file
  // is a real native binary and keeps the unsupported-browser boundary.
  const addonBytes = (path) => {
    const value = readFile(path);
    if (value instanceof Uint8Array) return value;
    return new TextEncoder().encode(sourceText(value));
  };
  const isWasmAddon = (path) => isWasmModuleBytes(addonBytes(path));
  const wasmAddonExports = (path) => loadWasmAddon(addonBytes(path), { name: path });

  const read = (specifier, importer) => {
    const resolved = resolve(specifier, importer);
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved) && !isWasmAddon(resolved)) {
      unsupportedNativeAddon(resolved);
    }
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

  const builtinModuleSource = (resolved, value) => {
    const names = Object.keys(value && (typeof value === 'object' || typeof value === 'function') ? value : {})
      .filter(isValidExportName)
      .filter((name) => name !== 'default');
    if (builtinName(resolved) === 'events' && !names.includes('once')) names.push('once');
    const token = register(() => value);
    const access = `globalThis[${quote(registryName)}][${quote(token)}]()`;
    const namedAccess = (name) => {
      const namedToken = register(() => resolved === 'events' && name === 'once' && typeof value?.once !== 'function'
        ? eventsOnce
        : value?.[name]);
      return `globalThis[${quote(registryName)}][${quote(namedToken)}]()`;
    };
    return [
      `const moduleValue = ${access};`,
      'export default moduleValue;',
      ...names.map((name) => `export const ${name} = ${namedAccess(name)};`),
    ].join('\n');
  };

  const cjsModuleSource = (resolved, loadValue) => {
    let evaluated = false;
    let exports;
    const load = () => {
      if (!evaluated) {
        exports = loadValue ? loadValue() : evaluateCommonJS(resolved, resolved);
        evaluated = true;
      }
      return exports;
    };
    const token = register(load);
    const access = `globalThis[${quote(registryName)}][${quote(token)}]()`;
    const names = [];
    load();
    if (exports && (typeof exports === 'object' || typeof exports === 'function')) {
      names.push(...Object.keys(exports).filter(isValidExportName).filter((name) => name !== 'default'));
    }
    return [
      `const moduleValue = ${access};`,
      'export default moduleValue;',
      ...names.map((name) => `export const ${name} = moduleValue[${quote(name)}];`),
    ].join('\n');
  };

  function rewriteSpecifier(specifier, importer) {
    specifier = decodeStaticString(specifier);
    const resolved = resolve(specifier, importer);
    return moduleURL(resolved);
  }

  function rewriteImports(source, importer) {
    let rewritten = String(source);
    rewritten = rewritten.replace(
      /(\b(?:import|export)\s+(?:[^;\n]*?\s+from\s+))(['"])((?:\\.|[^'"])*)\2/g,
      (match, prefix, delimiter, specifier) => `${prefix}${quote(rewriteSpecifier(specifier, importer))}`,
    );
    rewritten = rewritten.replace(
      /(\bimport\s*)(['"])((?:\\.|[^'"])*)\2/g,
      (match, prefix, delimiter, specifier) => `${prefix}${quote(rewriteSpecifier(specifier, importer))}`,
    );
    rewritten = rewritten.replace(
      /(\bimport\s*\(\s*)(['"])((?:\\.|[^'"])*)\2(\s*\))/g,
      (match, prefix, delimiter, specifier, suffix) => `${prefix}${quote(rewriteSpecifier(specifier, importer))}${suffix}`,
    );
    // Native data modules do not have a file URL. Preserve the Node-facing
    // identity used by code that builds URLs relative to import.meta.url.
    rewritten = rewritten.replace(/\bimport\.meta\.url\b/g, quote(importer.startsWith('data:') ? importer : `file://${importer}`));
    return rewritten;
  }

  const decodeDataBody = (value) => {
    const encoded = value.slice(value.indexOf(',') + 1).split('#', 1)[0];
    return value.includes(';base64,') ? atob(encoded) : decodeURIComponent(encoded);
  };

  const dataModuleSource = (value) => {
    const mime = value.slice(5, value.indexOf(',')).split(';', 1)[0].toLowerCase();
    const source = decodeDataBody(value);
    if (mime === 'application/json') return `export default ${JSON.stringify(JSON.parse(source))};`;
    return `${rewriteImports(source, value)}\n//# sourceURL=${value}`;
  };

  function moduleSource(resolved) {
    const builtinValue = builtin(resolved);
    if (builtinValue !== undefined) return builtinModuleSource(resolved, builtinValue);
    if (resolved.startsWith('node:')) {
      const error = new Error(`Cannot find builtin module '${resolved}'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    if (resolved.startsWith('data:')) return dataModuleSource(resolved);
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved)) {
      return isWasmAddon(resolved)
        ? cjsModuleSource(resolved, () => wasmAddonExports(resolved))
        : nativeAddonModuleSource(resolved);
    }
    let value;
    try {
      value = read(resolved, resolved).value;
    } catch (error) {
      if (error?.code === 'MODULE_NOT_FOUND') return missingModuleSource(resolved);
      throw error;
    }
    if (resolved.endsWith('.json')) {
      return `export default ${JSON.stringify(JSON.parse(sourceText(value)))};`;
    }
    if (!resolved.endsWith('.mjs')) return cjsModuleSource(resolved);
    return `${rewriteImports(sourceText(value), resolved)}\n//# sourceURL=${resolved}`;
  }

  function moduleURL(resolved) {
    if (moduleURLs.has(resolved)) return moduleURLs.get(resolved);
    const source = moduleSource(resolved);
    // Native ESM caches by URL for the lifetime of the browser realm. Give
    // each runtime loader a private fragment so a second virtual child using
    // the same VFS path executes its own module instance.
    const url = `data:text/javascript;charset=utf-8,${encodeModuleSource(source)}#${registryName}`;
    moduleURLs.set(resolved, url);
    return url;
  }

  const evaluate = (specifier, importer, globals) => {
    const resolved = resolve(specifier, importer);
    const builtinValue = builtin(resolved);
    if (builtinValue !== undefined) return builtinValue;
    if (resolved.startsWith('node:')) {
      const error = new Error(`Cannot find builtin module '${specifier}'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    if (resolved.startsWith('data:')) return importData(resolved);
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved)) {
      if (isWasmAddon(resolved)) {
        if (cache.has(resolved)) return cache.get(resolved).exports;
        const wasmExports = wasmAddonExports(resolved);
        cache.set(resolved, { exports: wasmExports, id: resolved, filename: resolved, loaded: true });
        return wasmExports;
      }
      unsupportedNativeAddon(resolved);
    }
    if (cache.has(resolved)) return cache.get(resolved).exports;
    if (evaluateCommonJS && !resolved.endsWith('.mjs') && !resolved.endsWith('.json')) {
      const exports = evaluateCommonJS(resolved, importer);
      cache.set(resolved, { exports, id: resolved, filename: resolved, loaded: true });
      return exports;
    }
    const rawSource = read(resolved, importer).value;
    const source = sourceText(rawSource);
    const module = { exports: {}, id: resolved, filename: resolved, loaded: false, parent: null, children: [] };
    if (!mainModule) mainModule = module;
    cache.set(resolved, module);
    if (resolved.endsWith('.json')) module.exports = JSON.parse(source);
    else {
      const dirname = posix.dirname(resolved);
      const require = (child) => evaluate(child, resolved, globals);
      require.resolve = (child) => resolve(child, resolved);
      require.cache = cache;
      require.main = mainModule;
      module.require = require;
      const transformed = source.replace(/\bimport\s*\(/g, '__bnhImport(');
      const names = Object.keys(globals || {});
      const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', '__bnhImport', ...names, transformed);
      const result = fn(module.exports, require, module, resolved, dirname,
        (child, options) => importModule(child, resolved, globals, options),
        ...names.map((name) => globals[name]));
      module.promise = result && typeof result.then === 'function' ? result : null;
    }
    module.loaded = true;
    return module.exports;
  };

  const importData = async (value, options) => {
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
    return import(moduleURL(value), options);
  };

  const importNative = async (resolved) => {
    if (!importCache.has(resolved)) importCache.set(resolved, import(moduleURL(resolved)));
    return importCache.get(resolved);
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

  const importModule = async (specifier, importer, globals, options) => {
    const resolved = resolve(specifier, importer);
    if (resolved.startsWith('data:')) return importData(resolved, options);
    validateImportAttributes(resolved, options);
    if (resolved.endsWith(NATIVE_ADDON_EXTENSION) && hasFile(resolved) && !isWasmAddon(resolved)) {
      unsupportedNativeAddon(resolved);
    }
    if (resolved.endsWith('.mjs') || builtin(resolved) !== undefined) return importNative(resolved);
    const exports = evaluate(resolved, importer, globals);
    const module = cache.get(resolved);
    if (module?.promise) await module.promise;
    return exports;
  };

  return {
    cache,
    resolve,
    require: (specifier, importer, globals = {}) => evaluate(specifier, importer, globals),
    import: (specifier, importer = '/node/index.mjs', globals = {}, options) => importModule(specifier, importer, globals, options),
    normalize,
    moduleURL,
    dispose: () => { delete globalObject[registryName]; },
  };
}
