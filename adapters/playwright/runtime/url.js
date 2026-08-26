function invalidUrl(scope, input) {
  try {
    return new scope.URL(String(input));
  } catch (error) {
    const wrapped = new TypeError(`Invalid URL: ${input}`);
    wrapped.code = 'ERR_INVALID_URL';
    wrapped.input = String(input);
    wrapped.cause = error;
    throw wrapped;
  }
}

function authority(url) {
  const auth = url.username || url.password
    ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`.replace(/:$/, '')
    : null;
  return {
    auth,
    host: url.host,
    hostname: url.hostname,
    port: url.port || null,
  };
}

function legacyUrlObject(scope, input, parseQueryString, slashesDenoteHost) {
  const text = String(input);
  const base = slashesDenoteHost && text.startsWith('//') ? 'http:' : 'http://localhost';
  const parsed = new scope.URL(text, base);
  const { auth, host, hostname, port } = authority(parsed);
  const search = parsed.search || null;
  const queryText = search ? search.slice(1) : '';
  const query = parseQueryString ? parseQueryStringValue(queryText) : (queryText || null);
  const pathname = parsed.pathname || (parsed.host ? '/' : null);
  const path = pathname === null ? null : `${pathname}${search || ''}`;
  const result = {
    protocol: parsed.protocol || null,
    slashes: Boolean(parsed.host || text.startsWith('//')),
    auth,
    host: host || null,
    port,
    hostname: hostname || null,
    hash: parsed.hash || null,
    search,
    query,
    pathname,
    path,
    href: parsed.href,
  };
  result.format = () => formatUrl(result);
  return result;
}

function parseQueryStringValue(value) {
  const result = {};
  for (const part of String(value || '').split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const rawKey = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? '' : part.slice(separator + 1);
    const key = decodeComponent(rawKey);
    const item = decodeComponent(rawValue);
    if (result[key] === undefined) result[key] = item;
    else if (Array.isArray(result[key])) result[key].push(item);
    else result[key] = [result[key], item];
  }
  return result;
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(String(value).replaceAll('+', ' '));
  } catch {
    return String(value);
  }
}

function encodeAuth(value) {
  return encodeURIComponent(String(value)).replace(/%3A/gi, ':');
}

function invalidSearchParamsThis(type = 'URLSearchParams') {
  const error = new TypeError(`Value of "this" must be of type ${type}`);
  error.code = 'ERR_INVALID_THIS';
  return error;
}

function stringValue(value) {
  if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(value);
}

function missingSearchParamsArguments(message) {
  const error = new TypeError(message);
  error.code = 'ERR_MISSING_ARGS';
  return error;
}

function createSearchParamsIterator(source, type) {
  const state = new WeakMap();
  const iterator = {
    next(...args) {
      const native = state.get(this);
      if (!native) throw invalidSearchParamsThis(type);
      return native.next(...args);
    },
    [Symbol.iterator]() {
      if (!state.has(this)) throw invalidSearchParamsThis(type);
      return this;
    },
  };
  state.set(iterator, source);
  return iterator;
}

function createNodeUrlSearchParams(scope) {
  const NativeSearchParams = scope.URLSearchParams;
  const nativeSearchParamsGetter = Object.getOwnPropertyDescriptor(
    scope.URL.prototype,
    'searchParams',
  )?.get;
  const nativeByWrapper = new WeakMap();
  const wrapperByUrl = new WeakMap();

  class NodeURLSearchParams {
    constructor(init) {
      nativeByWrapper.set(this, new NativeSearchParams(init));
    }

    append(name, value) {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      if (arguments.length < 2) {
        throw missingSearchParamsArguments('The "name" and "value" arguments must be specified');
      }
      native.append(stringValue(name), stringValue(value));
    }

    delete(name, value) {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      if (arguments.length < 1) throw missingSearchParamsArguments('The "name" argument must be specified');
      const key = stringValue(name);
      if (arguments.length < 2) native.delete(key);
      else native.delete(key, stringValue(value));
    }

    get(name) {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      if (arguments.length < 1) throw missingSearchParamsArguments('The "name" argument must be specified');
      return native.get(stringValue(name));
    }

    getAll(name) {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      if (arguments.length < 1) throw missingSearchParamsArguments('The "name" argument must be specified');
      return native.getAll(stringValue(name));
    }

    has(name, value) {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      if (arguments.length < 1) throw missingSearchParamsArguments('The "name" argument must be specified');
      const key = stringValue(name);
      return arguments.length < 2 ? native.has(key) : native.has(key, stringValue(value));
    }

    set(name, value) {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      if (arguments.length < 2) {
        throw missingSearchParamsArguments('The "name" and "value" arguments must be specified');
      }
      native.set(stringValue(name), stringValue(value));
    }

    sort() {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      native.sort();
    }

    forEach(callback, thisArg) {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      native.forEach((value, key) => callback.call(thisArg, value, key, this));
    }

    entries() {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      return createSearchParamsIterator(native.entries(), 'URLSearchParamsIterator');
    }

    keys() {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      return createSearchParamsIterator(native.keys(), 'URLSearchParamsIterator');
    }

    values() {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      return createSearchParamsIterator(native.values(), 'URLSearchParamsIterator');
    }

    toString() {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      return native.toString();
    }

    get size() {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      return native.size;
    }

    get [Symbol.toStringTag]() {
      return 'URLSearchParams';
    }

    [Symbol.iterator]() {
      return this.entries();
    }
  }

  function wrapNative(native) {
    const wrapper = Object.create(NodeURLSearchParams.prototype);
    nativeByWrapper.set(wrapper, native);
    return wrapper;
  }

  class NodeURL extends scope.URL {
    get searchParams() {
      if (typeof nativeSearchParamsGetter !== 'function') return new NodeURLSearchParams();
      const native = nativeSearchParamsGetter.call(this);
      const existing = wrapperByUrl.get(this);
      if (existing?.native === native) return existing.wrapper;
      const wrapper = wrapNative(native);
      wrapperByUrl.set(this, { native, wrapper });
      return wrapper;
    }
  }

  return { URL: NodeURL, URLSearchParams: NodeURLSearchParams };
}

function formatUrl(value, scope = globalThis) {
  if (typeof value === 'string') return value;
  if (value && typeof value.href === 'string' && !value.protocol && !value.pathname) return value.href;
  const protocol = value?.protocol ? `${String(value.protocol).replace(/:$/, '')}:` : '';
  const auth = value?.auth ? `${encodeAuth(value.auth)}@` : '';
  const host = value?.host || `${value?.hostname || ''}${value?.port ? `:${value.port}` : ''}`;
  const hasAuthority = Boolean(host || value?.slashes || auth);
  const pathname = value?.pathname || '';
  let search = value?.search || '';
  if (!search && value?.query && typeof value.query === 'object') {
    search = `?${Object.entries(value.query).flatMap(([key, item]) => (Array.isArray(item) ? item : [item])
      .map((entry) => `${encodeURIComponent(key)}=${encodeURIComponent(entry ?? '')}`)).join('&')}`;
  }
  if (search && !search.startsWith('?')) search = `?${search}`;
  const hash = value?.hash ? (String(value.hash).startsWith('#') ? String(value.hash) : `#${value.hash}`) : '';
  const separator = hasAuthority && pathname && !pathname.startsWith('/') ? '/' : '';
  const slashes = hasAuthority ? '//' : '';
  const formatted = `${protocol}${slashes}${auth}${host}${separator}${pathname}${search}${hash}`;
  if (formatted || !scope?.URL) return formatted;
  return String(new scope.URL(value));
}

export function createUrlModule(scope, { pathToFileURL, fileURLToPath } = {}) {
  const { URL: URLClass, URLSearchParams } = createNodeUrlSearchParams(scope);
  return Object.freeze({
    URL: URLClass,
    URLSearchParams,
    parse: (input, parseQueryString = false, slashesDenoteHost = false) => legacyUrlObject(scope, input, parseQueryString, slashesDenoteHost),
    format: (value) => formatUrl(value, scope),
    resolve: (from, to) => new URLClass(String(to), String(from)).href,
    resolveObject: (from, to) => legacyUrlObject(scope, new URLClass(String(to), String(from)).href, false, true),
    domainToASCII: (value) => String(value),
    domainToUnicode: (value) => String(value),
    pathToFileURL,
    fileURLToPath,
    urlToHttpOptions: (value) => {
      const parsed = value instanceof URLClass ? value : new URLClass(String(value));
      return {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        hash: parsed.hash,
        search: parsed.search,
        pathname: parsed.pathname,
        path: `${parsed.pathname}${parsed.search}`,
        href: parsed.href,
        auth: parsed.username || parsed.password ? `${parsed.username}:${parsed.password}` : undefined,
        port: parsed.port ? Number(parsed.port) : undefined,
      };
    },
  });
}
