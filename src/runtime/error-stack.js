const installedConstructors = new WeakSet();

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
    getLineNumber: () => parsed.lineNumber,
    getColumnNumber: () => parsed.columnNumber,
    getFunctionName: () => functionName || null,
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
  return Object.freeze(site);
}

function parseCallSites(stack) {
  return String(stack || '')
    .split(/\r?\n/)
    .map(createCallSite)
    .filter(Boolean);
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
  ErrorConstructor.captureStackTrace = function captureStackTrace(target, constructorOpt) {
    const rawTarget = {};
    nativeCaptureStackTrace(rawTarget, constructorOpt);
    const rawStack = rawTarget.stack;
    const callSites = parseCallSites(rawStack);
    let evaluated = false;
    let value;

    Object.defineProperty(target, 'stack', {
      configurable: true,
      enumerable: false,
      get() {
        if (!evaluated) {
          evaluated = true;
          const prepareStackTrace = ErrorConstructor.prepareStackTrace;
          value = typeof prepareStackTrace === 'function'
            ? prepareStackTrace(target, callSites)
            : formatCallSites(target, callSites);
        }
        return value;
      },
      set(nextValue) {
        evaluated = true;
        value = nextValue;
      },
    });
    return target;
  };
}

export function installErrorStackCompatibility(globalObject = globalThis) {
  const ErrorConstructor = globalObject?.Error;
  if (typeof ErrorConstructor?.captureStackTrace !== 'function') return false;
  if (installedConstructors.has(ErrorConstructor)) return false;
  installedConstructors.add(ErrorConstructor);
  if (supportsStructuredCapture(ErrorConstructor)) return false;
  installCaptureStackTrace(ErrorConstructor);
  return true;
}
