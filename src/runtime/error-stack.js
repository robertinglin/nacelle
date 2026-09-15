const installedConstructors = new WeakSet();
function CallSite() {}

Object.defineProperties(CallSite.prototype, {
  constructor: { configurable: true, value: CallSite, writable: true },
  getFileName: { configurable: true, value() { return this.__bnhFileName; }, writable: true },
  getScriptNameOrSourceURL: {
    configurable: true,
    value() { return this.__bnhFileName; },
    writable: true,
  },
  getLineNumber: { configurable: true, value() { return this.__bnhLineNumber; }, writable: true },
  getColumnNumber: { configurable: true, value() { return this.__bnhColumnNumber; }, writable: true },
  getFunctionName: { configurable: true, value() { return this.__bnhFunctionName || null; }, writable: true },
  getFunction: { configurable: true, value() { return undefined; }, writable: true },
  getTypeName: { configurable: true, value() { return this.__bnhTypeName ?? null; }, writable: true },
  getMethodName: { configurable: true, value() { return null; }, writable: true },
  getEvalOrigin: { configurable: true, value() { return undefined; }, writable: true },
  isToplevel: { configurable: true, value() { return !this.__bnhFunctionName; }, writable: true },
  isEval: { configurable: true, value() { return false; }, writable: true },
  isNative: { configurable: true, value() { return false; }, writable: true },
  isConstructor: { configurable: true, value() { return false; }, writable: true },
  isAsync: { configurable: true, value() { return false; }, writable: true },
  getThis: { configurable: true, value() { return undefined; }, writable: true },
  toString: { configurable: true, value() { return this.__bnhLine; }, writable: true },
});

function parseLocation(location) {
  const match = String(location || '').match(/^(.*?)(?::(\d+))(?::(\d+))$/);
  if (!match) {
    return { fileName: String(location || '') || undefined, lineNumber: undefined, columnNumber: undefined };
  }
  return {
    fileName: match[1] || undefined,
    lineNumber: Number(match[2]),
    columnNumber: Number(match[3]),
  };
}

function createCallSite(line) {
  let text = String(line || '').trim();
  if (!text || text === 'Error') return null;
  if (text.startsWith('at ')) text = text.slice(3).trim();

  let functionName = '';
  let location = text;
  const chromeMatch = text.match(/^(.*?)\s+\((.*)\)$/);
  if (chromeMatch) {
    functionName = chromeMatch[1];
    location = chromeMatch[2];
  } else {
    const separator = text.lastIndexOf('@');
    if (separator >= 0) {
      functionName = text.slice(0, separator);
      location = text.slice(separator + 1);
    }
  }

  const parsed = parseLocation(location);
  // Firefox omits the receiver qualification that V8 includes for a
  // CommonJS export function.  caller-callsite uses that qualification to
  // locate a usable caller frame; preserve the useful Node contract for the
  // generated module export frame.
  const typeName = functionName === 'anonymous/</module.exports' ? 'Object' : null;
  const site = Object.create(CallSite.prototype);
  Object.defineProperties(site, {
    __bnhFileName: { configurable: true, value: parsed.fileName },
    __bnhLineNumber: { configurable: true, value: parsed.lineNumber },
    __bnhColumnNumber: { configurable: true, value: parsed.columnNumber },
    __bnhFunctionName: { configurable: true, value: functionName },
    __bnhTypeName: { configurable: true, value: typeName },
    __bnhLine: { configurable: true, value: line },
  });
  // @tapjs/stack and source-map-support recognize structured V8 call sites by
  // their constructor/prototype shape before wrapping them in richer objects.
  // Browser stack parsing therefore uses a real Node-shaped CallSite prototype.
  // Node's CallSite objects are extensible. Consumers such as @tapjs/stack
  // attach bounded metadata (for example, the owning cwd) while cleaning a
  // captured stack, so freezing the browser fallback breaks that contract.
  return site;
}

function parseCallSites(stack) {
  return String(stack || '')
    .split(/\r?\n/)
    .map(createCallSite)
    .filter(Boolean);
}

const nativeCallSiteMethods = [
  'getFunctionName',
  'getScriptNameOrSourceURL',
  'getFileName',
  'getLineNumber',
  'getColumnNumber',
  'getEnclosingLineNumber',
  'getEnclosingColumnNumber',
  'getEvalOrigin',
  'isToplevel',
  'isEval',
  'isNative',
  'isConstructor',
  'isAsync',
  'getThis',
  'getTypeName',
  'getMethodName',
  'getFunction',
  'getPosition',
  'getPromiseIndex',
  'isPromiseAll',
  'toString',
];

function wrapNativeCallSite(site, overrides = {}) {
  const wrapped = Object.create(CallSite.prototype);
  for (const methodName of nativeCallSiteMethods) {
    let method;
    try { method = site[methodName]; } catch { continue; }
    if (typeof method !== 'function') continue;
    Object.defineProperty(wrapped, methodName, {
      configurable: true,
      value: method.bind(site),
    });
  }
  for (const [methodName, method] of Object.entries(overrides)) {
    Object.defineProperty(wrapped, methodName, {
      configurable: true,
      value: method,
    });
  }
  return wrapped;
}

function normalizePrepareStackSites(callSites) {
  if (!Array.isArray(callSites)) return callSites;
  return callSites
    .filter((site) => site !== undefined && site !== null)
    .map(normalizeNativeCallSite);
}

function normalizeNativeCallSite(site) {
  if (!site || typeof site !== 'object' || typeof site.getFileName !== 'function') return site;
  let fileName;
  try { fileName = site.getFileName(); } catch { return site; }
  if (typeof fileName === 'string' && fileName) {
    const complete = nativeCallSiteMethods.every((methodName) => {
      try { return typeof site[methodName] === 'function'; } catch { return false; }
    });
    return complete && Object.isExtensible(site) ? site : wrapNativeCallSite(site);
  }

  // Chromium's structured CallSites report undefined for frames created by
  // eval-based module wrappers even though their toString() includes the
  // virtual module filename. Node callers such as resolve/lib/caller.js use
  // getFileName() directly, so recover that filename from the stable text
  // representation and layer the corrected method over the native site.
  let text;
  try { text = String(site); } catch { return site; }
  const parsed = parseCallSites(text)[0];
  const parsedFileName = parsed?.getFileName?.();
  if (typeof parsedFileName !== 'string' || !parsedFileName) return site;
  // V8's native CallSite methods validate their receiver. Bind every native
  // method back to the original object, not just toString: consumers such as
  // Next call getLineNumber/getColumnNumber on the normalized wrapper too.
  return wrapNativeCallSite(site, {
    getFileName: () => parsedFileName,
    getScriptNameOrSourceURL: () => parsedFileName,
  });
}

function supportsNativePreparedErrorStack(ErrorConstructor) {
  const previousPrepare = ErrorConstructor.prepareStackTrace;
  let invoked = false;
  try {
    ErrorConstructor.prepareStackTrace = (_error, callSites) => {
      invoked = true;
      return callSites;
    };
    const stack = new ErrorConstructor().stack;
    return invoked && Array.isArray(stack);
  } catch {
    return false;
  } finally {
    ErrorConstructor.prepareStackTrace = previousPrepare;
  }
}

function installPrepareStackTraceCompatibility(ErrorConstructor) {
  const descriptor = Object.getOwnPropertyDescriptor(ErrorConstructor, 'prepareStackTrace');
  if (descriptor && !descriptor.configurable && !descriptor.get && !descriptor.set) return false;
  let prepareStackTrace = descriptor?.get
    ? descriptor.get.call(ErrorConstructor)
    : descriptor?.value;
  const wrappedByOriginal = new WeakMap();
  const originalByWrapped = new WeakMap();
  const wrappedPrepareStackTrace = (original) => {
    if (typeof original !== 'function') return original;
    const existing = wrappedByOriginal.get(original);
    if (existing) return existing;
    const wrapped = (error, callSites) => original(error, normalizePrepareStackSites(callSites));
    wrappedByOriginal.set(original, wrapped);
    originalByWrapped.set(wrapped, original);
    return wrapped;
  };
  try {
    Object.defineProperty(ErrorConstructor, 'prepareStackTrace', {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      get: () => wrappedPrepareStackTrace(prepareStackTrace),
      set: (value) => {
        prepareStackTrace = originalByWrapped.get(value) || value;
      },
    });
    return true;
  } catch {
    return false;
  }
}

function installPreparedErrorStackGetter(ErrorConstructor) {
  if (supportsNativePreparedErrorStack(ErrorConstructor)) return false;
  const prototype = ErrorConstructor.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'stack');
  if (!descriptor?.get || !descriptor.configurable) return false;
  const nativeGet = descriptor.get;
  const nativeSet = descriptor.set;
  try {
    Object.defineProperty(prototype, 'stack', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        const rawStack = nativeGet.call(this);
        const prepareStackTrace = ErrorConstructor.prepareStackTrace;
        if (typeof prepareStackTrace !== 'function') return rawStack;
        const callSites = Array.isArray(rawStack) ? normalizePrepareStackSites(rawStack) : parseCallSites(rawStack);
        return prepareStackTrace(this, callSites);
      },
      set(value) {
        if (nativeSet) nativeSet.call(this, value);
      },
    });
    return true;
  } catch {
    return false;
  }
}

function formatCallSites(error, callSites) {
  const name = error?.name || 'Error';
  const message = error?.message ? `: ${error.message}` : '';
  const lines = callSites.map((site) => `    at ${site.toString()}`);
  return `${name}${message}${lines.length ? `\n${lines.join('\n')}` : ''}`;
}

function supportsStructuredCapture(ErrorConstructor) {
  const target = {};
  const previousPrepare = ErrorConstructor.prepareStackTrace;
  try {
    ErrorConstructor.prepareStackTrace = (_error, callSites) => callSites;
    ErrorConstructor.captureStackTrace(target);
    return Array.isArray(target.stack);
  } catch {
    return false;
  } finally {
    ErrorConstructor.prepareStackTrace = previousPrepare;
  }
}

function installCaptureStackTrace(ErrorConstructor) {
  const nativeCaptureStackTrace = ErrorConstructor.captureStackTrace;
  const captureRawStack = (target, constructorOpt) => {
    const previousPrepare = ErrorConstructor.prepareStackTrace;
    try {
      // Firefox may invoke prepareStackTrace from inside its native capture
      // implementation. Keep that engine-specific call-site representation
      // away from Node consumers such as @tapjs/stack; the formatter is
      // applied below after the raw stack has been normalized.
      ErrorConstructor.prepareStackTrace = undefined;
      nativeCaptureStackTrace(target, constructorOpt);
    } finally {
      ErrorConstructor.prepareStackTrace = previousPrepare;
    }
  };
  const captureStackTrace = function captureStackTrace(target, constructorOpt) {
    const rawTarget = {};
    captureRawStack(rawTarget, constructorOpt);
    let rawStack = rawTarget.stack;
    let callSites = parseCallSites(rawStack);
    if (constructorOpt !== undefined && callSites.length === 0) {
      const retryTarget = {};
      captureRawStack(retryTarget);
      rawStack = retryTarget.stack;
      callSites = parseCallSites(rawStack);
    }
    // Browser fallbacks need to preserve a structured formatter selected at
    // capture time. Consumers such as tap temporarily install
    // `prepareStackTrace`, capture the stack, and restore it before reading
    // the result.
    const prepareStackTrace = ErrorConstructor.prepareStackTrace;
    const value = typeof prepareStackTrace === 'function'
      ? prepareStackTrace(target, callSites)
      : formatCallSites(target, callSites);
    Object.defineProperty(target, 'stack', {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
    return target;
  };
  try {
    Object.defineProperty(ErrorConstructor, 'captureStackTrace', {
      configurable: true,
      writable: true,
      value: captureStackTrace,
    });
  } catch {
    ErrorConstructor.captureStackTrace = captureStackTrace;
  }
}

function installStructuredCaptureFallback(ErrorConstructor) {
  const nativeCaptureStackTrace = ErrorConstructor.captureStackTrace;
  const captureStackTrace = function captureStackTrace(target, constructorOpt) {
    // Capture into a disposable object first. Some browser implementations
    // install an unusable lazy `stack` property on the caller's object; if we
    // capture there first, that property can prevent the retry from being
    // installed even though a fresh target would work.
    const capturedTarget = {};
    nativeCaptureStackTrace(capturedTarget, constructorOpt);
    let capturedStack = capturedTarget.stack;
    // Chromium can return no stack at all when the optional constructor
    // filter is not present in the current rewritten call stack. Node's
    // consumers (notably @tapjs/stack) still expect a structured stack in
    // that case, so retry without the unusable filter.
    if (capturedStack === undefined || (Array.isArray(capturedStack) && capturedStack.length === 0)) {
      // Use a fresh object for the retry. V8 may have already installed and
      // evaluated a lazy `stack` property on the original target, in which
      // case calling captureStackTrace on that same object does not replace
      // the unusable value. This also covers callers that omit the optional
      // constructor filter; Node consumers still require an array there.
      const retryTarget = {};
      nativeCaptureStackTrace(retryTarget);
      const retryStack = retryTarget.stack;
      // A browser implementation may fail to materialize a stack in both
      // forms. Keep the V8 contract usable in that case: consumers such as
      // @tapjs/stack call Array.prototype methods on the result.
      capturedStack = retryStack === undefined ? [] : retryStack;
    }
    if (Array.isArray(capturedStack)) {
      if (capturedStack.some((site) => site && typeof site === 'object'
        && typeof site.getFileName !== 'function'
        && !('fileName' in site))) {
        // Firefox can expose an array from prepareStackTrace while its
        // entries are still browser-native strings/objects rather than Node
        // CallSites. Normalize those entries before returning the structured
        // contract.
        capturedStack = parseCallSites(capturedStack.join('\n'));
      } else {
        // Chromium can expose native-looking CallSites that are not
        // extensible. Node consumers are allowed to annotate CallSites (tap
        // records the owning cwd), so put those objects behind an extensible
        // wrapper while retaining their prototype methods and values.
        capturedStack = capturedStack.map((site) => {
          const normalized = normalizeNativeCallSite(site);
          return normalized && typeof normalized === 'object' && !Object.isExtensible(normalized)
            ? Object.create(normalized)
            : normalized;
        });
      }
    }
    try {
      Object.defineProperty(target, 'stack', {
        configurable: true,
        enumerable: false,
        value: capturedStack,
        writable: true,
      });
    } catch {
      try { target.stack = capturedStack; } catch { /* best effort */ }
    }
    return target;
  };
  try {
    Object.defineProperty(ErrorConstructor, 'captureStackTrace', {
      configurable: true,
      writable: true,
      value: captureStackTrace,
    });
  } catch {
    ErrorConstructor.captureStackTrace = captureStackTrace;
  }
}

export function installErrorStackCompatibility(globalObject = globalThis) {
  const ErrorConstructor = globalObject?.Error;
  if (typeof ErrorConstructor?.captureStackTrace !== 'function') return false;
  if (installedConstructors.has(ErrorConstructor)) return false;
  installedConstructors.add(ErrorConstructor);
  const structuredCapture = supportsStructuredCapture(ErrorConstructor);
  installPrepareStackTraceCompatibility(ErrorConstructor);
  installPreparedErrorStackGetter(ErrorConstructor);
  if (structuredCapture) {
    installStructuredCaptureFallback(ErrorConstructor);
    return false;
  }
  installCaptureStackTrace(ErrorConstructor);
  return true;
}
