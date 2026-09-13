const installedConstructors = new WeakSet();
function CallSite() {}

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
  const site = {
    getFileName: () => parsed.fileName,
    getScriptNameOrSourceURL: () => parsed.fileName,
    getLineNumber: () => parsed.lineNumber,
    getColumnNumber: () => parsed.columnNumber,
    getFunctionName: () => functionName || null,
    getFunction: () => undefined,
    getTypeName: () => null,
    getMethodName: () => null,
    getEvalOrigin: () => undefined,
    isToplevel: () => !functionName,
    isEval: () => false,
    isNative: () => false,
    isConstructor: () => false,
    isAsync: () => false,
    getThis: () => undefined,
    toString: () => line,
  };
  // @tapjs/stack recognizes structured V8 call sites by their constructor
  // name before wrapping them in its richer CallSiteLike implementation.
  // Browser stack parsing produces ordinary objects, so preserve that small
  // observable part of the Node CallSite contract explicitly.
  Object.defineProperty(site, 'constructor', {
    configurable: true,
    value: CallSite,
  });
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

function normalizePrepareStackSites(callSites) {
  if (!Array.isArray(callSites)) return callSites;
  return callSites.filter((site) => site !== undefined && site !== null);
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
        capturedStack = capturedStack.map((site) => (
          site && typeof site === 'object' && !Object.isExtensible(site)
            ? Object.create(site)
            : site
        ));
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
