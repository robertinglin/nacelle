import { inspect as nodeInspect } from './assert.js';

const inspectCustomSymbol = Symbol.for('nodejs.util.inspect.custom');

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

function parseQueryStringValue(value) {
  const result = Object.create(null);
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

const legacyProtocolPattern = /^[a-z0-9.+-]+:/i;
const legacySlashedProtocols = new Set(['http:', 'https:', 'ftp:', 'gopher:', 'file:', 'ws:', 'wss:']);
const legacyHostlessProtocols = new Set(['javascript:']);
const normalizedForbiddenHostChars = /[#%/:?@[\\\]^|]/;
const warnedInvalidPorts = new WeakSet();

function invalidLegacyUrl(input) {
  const error = new TypeError(`Invalid URL: ${input}`);
  error.code = 'ERR_INVALID_URL';
  error.input = input;
  return error;
}

function validateLegacyHost(scope, host, input) {
  const bracketMatch = /^\[([^\]]*)\](?::[0-9]*)?$/.exec(host);
  const hostname = bracketMatch ? bracketMatch[1] : (/:([0-9]*)$/.test(host) ? host.replace(/:[0-9]*$/, '') : host);
  if (hostname.includes('\0')) throw invalidLegacyUrl(input);
  const normalized = hostname.normalize('NFKD');
  if (normalized !== hostname && normalizedForbiddenHostChars.test(normalized)) {
    throw invalidLegacyUrl(input);
  }
  // WHATWG URL drops this IDNA-ignored character from the hostname, but
  // Node's legacy parser rejects the resulting empty ASCII hostname.
  if (/^\u00AD+$/.test(hostname)) throw invalidLegacyUrl(input);
  if (hostname) {
    try {
      if (!new scope.URL(`http://${hostname}`).hostname) throw invalidLegacyUrl(input);
    } catch (error) {
      if (error?.code === 'ERR_INVALID_URL') throw error;
    }
  }
}

function warnInvalidLegacyPort(scope, input, host) {
  if (!host || /^\[[^\]]*\](?::[0-9]*)?$/.test(host)) return;
  const port = /:([^:]*)$/.exec(host)?.[1];
  if (port === undefined || /^\d*$/.test(port)) return;
  const process = scope.process;
  if (!process || warnedInvalidPorts.has(process)) return;
  warnedInvalidPorts.add(process);
  process.emitWarning?.(
    `The URL ${input} is invalid. Future versions of Node.js will throw an error.`,
    { code: 'DEP0170', type: 'DeprecationWarning' },
  );
}

function legacyString(value, name) {
  if (typeof value !== 'string') {
    let received;
    if (value === null || value === undefined) {
      received = `Received ${value}`;
    } else if (typeof value === 'function') {
      received = `Received function ${value.name || ''}`;
    } else if (typeof value === 'object') {
      received = `Received an instance of ${value.constructor?.name || 'Object'}`;
    } else {
      received = `Received type ${typeof value} (${nodeInspect(value, { colors: false })})`;
    }
    const error = new TypeError(`The "${name}" argument must be of type string. ${received}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  return value;
}

function legacyUrlFields(urlObject) {
  urlObject.protocol = null;
  urlObject.slashes = null;
  urlObject.auth = null;
  urlObject.host = null;
  urlObject.port = null;
  urlObject.hostname = null;
  urlObject.hash = null;
  urlObject.search = null;
  urlObject.query = null;
  urlObject.pathname = null;
  urlObject.path = null;
  urlObject.href = null;
}

function Url() {
  legacyUrlFields(this);
}

function legacyNormalizeHost(scope, host) {
  if (!host) return { host: '', hostname: '' };
  const bracketMatch = /^\[([^\]]*)\](?::([0-9]*))?$/.exec(host);
  const bracketed = Boolean(bracketMatch);
  const portMatch = bracketed ? null : /:([0-9]*)$/.exec(host);
  let hostname = bracketMatch ? bracketMatch[1] : portMatch ? host.slice(0, -portMatch[0].length) : host;
  const port = bracketMatch?.[2] || (portMatch && portMatch[1]) || null;
  try {
    const native = new scope.URL(`http://${host}`);
    hostname = native.hostname;
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    return { host: `${bracketed ? `[${hostname}]` : hostname}${native.port ? `:${native.port}` : port ? `:${port}` : ''}`, hostname, port: native.port || port };
  } catch {
    return { host: `${bracketed ? `[${hostname}]` : hostname}${port ? `:${port}` : ''}`, hostname: hostname.toLowerCase(), port };
  }
}

function legacyAutoEscape(value) {
  return String(value).replace(/[\u0000-\u0020"'<>\\^`{|}]/g, (character) => {
    const code = character.charCodeAt(0);
    return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

function legacyParseUrl(scope, input, parseQueryString = false, slashesDenoteHost = false) {
  const url = legacyString(input, 'url');
  const result = new Url();
  let text = url.trim();
  if (!text) {
    result.href = '';
    return result;
  }

  const protocolMatch = legacyProtocolPattern.exec(text);
  const protocol = protocolMatch ? protocolMatch[0].toLowerCase() : null;
  if (protocol) {
    result.protocol = protocol;
    text = text.slice(protocolMatch[0].length);
  }

  const hasExplicitSlashes = text.startsWith('//');
  const shouldParseHost = !legacyHostlessProtocols.has(protocol)
    && ((slashesDenoteHost && hasExplicitSlashes) || (hasExplicitSlashes && Boolean(protocol))
      || Boolean(protocol && !legacySlashedProtocols.has(protocol))
      || Boolean(!protocol && /^\/\/[^@/]+@[^@/]+/.test(text)));
  if (shouldParseHost) {
    if (hasExplicitSlashes) {
      result.slashes = true;
      text = text.slice(2);
    }
    const delimiter = text.search(/[\/?#]/);
    const authorityText = delimiter < 0 ? text : text.slice(0, delimiter);
    text = delimiter < 0 ? '' : text.slice(delimiter);
    const at = authorityText.lastIndexOf('@');
    let hostText = authorityText;
    if (at >= 0) {
      result.auth = decodeURIComponent(authorityText.slice(0, at));
      hostText = authorityText.slice(at + 1);
    }
    warnInvalidLegacyPort(scope, url, hostText);
    validateLegacyHost(scope, hostText, url);
    const normalized = legacyNormalizeHost(scope, hostText);
    result.host = normalized.host;
    result.hostname = normalized.hostname;
    result.port = normalized.port || null;
    if (result.slashes === null && hasExplicitSlashes) result.slashes = true;
  }

  const split = text.search(/[?#]/);
  let pathPart = split < 0 ? text : text.slice(0, split);
  let suffix = split < 0 ? '' : text.slice(split);
  pathPart = legacyAutoEscape(pathPart.replaceAll('\\', '/'));
  suffix = legacyAutoEscape(suffix);
  const hashIndex = suffix.indexOf('#');
  if (hashIndex >= 0) {
    result.hash = suffix.slice(hashIndex);
    suffix = suffix.slice(0, hashIndex);
  }
  if (suffix.startsWith('?')) {
    result.search = suffix;
    const queryText = suffix.slice(1);
    result.query = parseQueryString ? parseQueryStringValue(queryText) : queryText;
  } else if (parseQueryString) {
    result.query = Object.create(null);
  }

  if (pathPart) result.pathname = pathPart;
  if (result.host !== null && result.hostname !== null && !result.pathname && legacySlashedProtocols.has(protocol)) result.pathname = '/';
  if (result.pathname || result.search) result.path = `${result.pathname || ''}${result.search || ''}`;
  result.href = legacyFormat(result);
  return result;
}

function legacyFormat(urlObject) {
  let auth = urlObject.auth || '';
  if (auth) auth = encodeAuth(auth) + '@';
  let protocol = urlObject.protocol || '';
  if (protocol && !protocol.endsWith(':')) protocol += ':';
  let pathname = urlObject.pathname || '';
  let hash = urlObject.hash || '';
  let host = '';
  if (urlObject.host) host = auth + urlObject.host;
  else if (urlObject.hostname) {
    const hostname = String(urlObject.hostname);
    host = auth + (hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname);
    if (urlObject.port) host += `:${urlObject.port}`;
  }
  let query = '';
  if (urlObject.query && typeof urlObject.query === 'object') {
    query = Object.entries(urlObject.query).flatMap(([key, value]) => (Array.isArray(value) ? value : [value])
      .map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(item ?? '')}`)).join('&');
  }
  let search = urlObject.search || (query ? `?${query}` : '');
  if (pathname.includes('#') || pathname.includes('?')) pathname = pathname.replaceAll('#', '%23').replaceAll('?', '%3F');
  if (urlObject.slashes || legacySlashedProtocols.has(protocol)) {
    if (urlObject.slashes || host) {
      if (pathname && !pathname.startsWith('/')) pathname = `/${pathname}`;
      host = `//${host}`;
    } else if (protocol === 'file:') host = '//';
  }
  if (search.includes('#')) search = search.replaceAll('#', '%23');
  if (search && !search.startsWith('?')) search = `?${search}`;
  if (hash && !hash.startsWith('#')) hash = `#${hash}`;
  return `${protocol}${host}${pathname}${search}${hash}`;
}

Url.prototype.parse = function parse(url, parseQueryString, slashesDenoteHost) {
  const parsed = legacyParseUrl(globalThis, url, parseQueryString, slashesDenoteHost);
  Object.assign(this, parsed);
  return this;
};

Url.prototype.format = function format() {
  return legacyFormat(this);
};

Url.prototype.resolve = function resolve(relative) {
  return this.resolveObject(typeof relative === 'string' ? legacyParseUrl(globalThis, relative, false, true) : relative).format();
};

Url.prototype.resolveObject = function resolveObject(relative) {
  if (typeof relative === 'string') relative = legacyParseUrl(globalThis, relative, false, true);
  if (!(relative instanceof Url)) relative = legacyParseUrl(globalThis, String(relative), false, true);
  const source = this.href || this.format();
  if (source.startsWith('mailto:') && !relative.protocol) return legacyParseUrl(globalThis, `mailto:${relative.href}`, false, true);
  if (!relative.href) {
    const result = legacyParseUrl(globalThis, source, false, true);
    result.hash = relative.hash;
    result.href = result.format();
    return result;
  }
  try {
    const resolved = new globalThis.URL(relative.href, source).href;
    return legacyParseUrl(globalThis, resolved, false, true);
  } catch {
    return legacyParseUrl(globalThis, relative.href, false, true);
  }
};

Url.prototype.parseHost = function parseHost() {
  const host = this.host || '';
  const port = /:([0-9]*)$/.exec(host);
  if (port) {
    if (port[1]) this.port = port[1];
    this.host = host.slice(0, -port[0].length);
  }
  if (this.host) this.hostname = this.host;
};

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

function urlContextInspection(url) {
  const href = url.href;
  const protocolEnd = href.indexOf(':') + 1;
  const hasAuthority = href.startsWith('//', protocolEnd);
  const authorityStart = hasAuthority ? protocolEnd + 2 : protocolEnd;
  const authorityEnd = hasAuthority ? href.slice(authorityStart).search(/[/?#]/) : 0;
  const authorityLimit = authorityEnd < 0 ? href.length : authorityStart + authorityEnd;
  const at = hasAuthority ? href.lastIndexOf('@', authorityLimit - 1) : -1;
  const hostStart = at >= authorityStart ? at : authorityStart;
  const usernameEnd = at >= authorityStart
    ? href.indexOf(':', authorityStart) >= 0 && href.indexOf(':', authorityStart) < at
      ? href.indexOf(':', authorityStart)
      : at
    : authorityStart;
  const hostnameStart = at >= authorityStart ? at + 1 : authorityStart;
  const hostname = String(url.hostname);
  const hostEnd = hostname ? href.indexOf(hostname, hostnameStart) + hostname.length : hostnameStart;
  const pathnameStart = hostEnd + (url.port ? String(url.port).length + 1 : 0);
  const searchStart = href.indexOf('?');
  const hashStart = href.indexOf('#');
  const missing = 0xFFFFFFFF;
  const schemeType = {
    'http:': 0,
    'https:': 2,
    'ws:': 3,
    'ftp:': 4,
    'wss:': 5,
    'file:': 6,
  }[url.protocol] ?? 1;
  const port = url.port ? Number(url.port) : missing;
  return `URLContext {\n` +
    `  href: ${nodeInspect(href)},\n` +
    `  protocol_end: ${protocolEnd},\n` +
    `  username_end: ${usernameEnd},\n` +
    `  host_start: ${hostStart},\n` +
    `  host_end: ${hostEnd},\n` +
    `  pathname_start: ${pathnameStart},\n` +
    `  search_start: ${searchStart < 0 ? missing : searchStart},\n` +
    `  hash_start: ${hashStart < 0 ? missing : hashStart},\n` +
    `  port: ${port},\n` +
    `  scheme_type: ${schemeType},\n` +
    `  [hasPort]: [Getter],\n` +
    `  [hasSearch]: [Getter],\n` +
    `  [hasHash]: [Getter]\n` +
    '}';
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

function missingUrlArgument() {
  return missingSearchParamsArguments('The "url" argument must be specified');
}

function invalidObjectUrlArgument(value) {
  let received;
  if (value === undefined) received = 'undefined';
  else if (value === null) received = 'null';
  else if (typeof value === 'object') received = `an instance of ${value?.constructor?.name || 'Object'}`;
  else received = `type ${typeof value} (${String(value)})`;
  const error = new TypeError(`The "obj" argument must be an instance of Blob. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
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
  const NativeURL = scope.URL;
  const NativeSearchParams = scope.URLSearchParams;
  const nativeSearchParamsGetter = Object.getOwnPropertyDescriptor(
    scope.URL.prototype,
    'searchParams',
  )?.get;
  const nativeByWrapper = new WeakMap();

  class NodeURLSearchParams {
    constructor(init) {
      nativeByWrapper.set(this, new NativeSearchParams(init));
    }

    [inspectCustomSymbol](depth, options) {
      const native = nativeByWrapper.get(this);
      if (!native) throw invalidSearchParamsThis();
      if (typeof depth === 'number' && depth < 0) return '[Object]';

      const inspectOptions = options || {};
      const innerOptions = { ...inspectOptions };
      if (depth !== null) innerOptions.depth = depth - 1;
      const entries = [];
      for (const [name, value] of native) {
        entries.push(`${nodeInspect(name, innerOptions)} => ${nodeInspect(value, innerOptions)}`);
      }
      const separator = ', ';
      const length = entries.reduce((total, entry) => total + entry.length + separator.length, -separator.length);
      const name = this.constructor === NodeURLSearchParams
        ? 'URLSearchParams'
        : this.constructor?.name || 'URLSearchParams';
      if (length > (inspectOptions.breakLength ?? 80)) {
        return `${name} {\n  ${entries.join(',\n  ')} }`;
      }
      if (entries.length) return `${name} { ${entries.join(separator)} }`;
      return `${name} {}`;
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

  class NodeURL extends NativeURL {
    static parse(input, base = undefined) {
      if (arguments.length === 0) throw missingUrlArgument();
      const url = stringValue(input);
      const baseUrl = base === undefined ? undefined : stringValue(base);
      try {
        return new NodeURL(url, baseUrl);
      } catch {
        return null;
      }
    }

    static canParse(input, base = undefined) {
      if (arguments.length === 0) throw missingUrlArgument();
      const url = stringValue(input);
      const baseUrl = base === undefined ? undefined : stringValue(base);
      try {
        new NodeURL(url, baseUrl);
        return true;
      } catch {
        return false;
      }
    }

    static createObjectURL(blob) {
      if (typeof scope.Blob !== 'function' || !(blob instanceof scope.Blob)) {
        throw invalidObjectUrlArgument(blob);
      }
      const nativeCreateObjectURL = NativeURL?.createObjectURL;
      if (typeof nativeCreateObjectURL !== 'function') {
        throw new TypeError('URL.createObjectURL is not available in this browser');
      }
      return nativeCreateObjectURL.call(NativeURL, blob);
    }

    static revokeObjectURL(url) {
      if (arguments.length === 0) throw missingUrlArgument();
      const nativeRevokeObjectURL = NativeURL?.revokeObjectURL;
      if (typeof nativeRevokeObjectURL === 'function') {
        nativeRevokeObjectURL.call(NativeURL, stringValue(url));
      }
    }

    [inspectCustomSymbol](depth, options) {
      if (typeof depth === 'number' && depth < 0) return this;

      const inspectOptions = options || {};
      const constructor = this.constructor === NodeURL ? { name: 'URL' } : this.constructor;
      const fields = [
        ['href', this.href],
        ['origin', this.origin],
        ['protocol', this.protocol],
        ['username', this.username],
        ['password', this.password],
        ['host', this.host],
        ['hostname', this.hostname],
        ['port', this.port],
        ['pathname', this.pathname],
        ['search', this.search],
        ['searchParams', this.searchParams],
        ['hash', this.hash],
      ].map(([key, value]) => `${key}: ${nodeInspect(value, inspectOptions)}`);
      if (inspectOptions.showHidden) fields.push(`[Symbol(context)]: ${urlContextInspection(this)}`);
      const indent = (value) => value.replaceAll('\n', '\n  ');
      const body = fields.join(', ');
      const name = constructor?.name || 'URL';
      if (body.length > (inspectOptions.breakLength ?? 80)) {
        return `${name} {\n  ${fields.map(indent).join(',\n  ')}\n}`;
      }
      return `${name} { ${body} }`;
    }

    get searchParams() {
      if (typeof nativeSearchParamsGetter !== 'function') return new NodeURLSearchParams();
      const native = nativeSearchParamsGetter.call(this);
      const existing = this.__bnhSearchParamsWrapper;
      if (existing?.native === native) return existing.wrapper;
      const wrapper = wrapNative(native);
      Object.defineProperty(this, '__bnhSearchParamsWrapper', {
        configurable: true,
        value: { native, wrapper },
      });
      return wrapper;
    }
  }

  const propertyNames = [
    'port', 'pathname', 'search', 'hash', 'href', 'origin', 'protocol',
    'username', 'password', 'host', 'hostname',
  ];
  for (const name of propertyNames) {
    const descriptor = Object.getOwnPropertyDescriptor(scope.URL.prototype, name);
    if (!descriptor?.get) continue;
    Object.defineProperty(NodeURL.prototype, name, {
      configurable: true,
      enumerable: true,
      get() { return descriptor.get.call(this); },
      ...(descriptor.set ? { set(value) { descriptor.set.call(this, value); } } : {}),
    });
  }
  const nativeToString = scope.URL.prototype.toString;
  Object.defineProperty(NodeURL.prototype, 'toString', {
    configurable: true,
    enumerable: true,
    writable: true,
    value() { return nativeToString.call(this); },
  });
  Object.defineProperty(NodeURL.prototype, 'toJSON', {
    configurable: true,
    enumerable: true,
    writable: true,
    value() {
      const nativeToJSON = NativeURL.prototype.toJSON;
      return typeof nativeToJSON === 'function' ? nativeToJSON.call(this) : this.href;
    },
  });

  for (const name of ['parse', 'canParse', 'createObjectURL', 'revokeObjectURL']) {
    const descriptor = Object.getOwnPropertyDescriptor(NodeURL, name);
    Object.defineProperty(NodeURL, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: descriptor.value,
    });
  }

  return { URL: NodeURL, URLSearchParams: NodeURLSearchParams };
}

function formatUrl(value, scope = globalThis) {
  if (typeof value === 'string') return value;
  if (value instanceof Url) return value.format();
  if (value && typeof value.href === 'string' && !value.protocol && !value.pathname) return value.href;
  if (value && typeof value === 'object') return legacyFormat(value);
  if (!value || typeof value !== 'object') {
    const error = new TypeError(`The "urlObject" argument must be one of type object or string. Received ${value === null ? 'null' : typeof value}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (!scope?.URL) return String(value);
  return String(new scope.URL(value));
}

function fileURLToPathBuffer(scope, value, options) {
  const windows = options?.windows === undefined ? false : Boolean(options.windows);
  let input;
  if (value instanceof scope.URL) input = value;
  else if (typeof value === 'string') input = new scope.URL(value);
  else {
    const error = new TypeError(`The "path" argument must be of type string or an instance of URL. Received ${value === null ? 'null' : typeof value === 'object' ? `an instance of ${value?.constructor?.name || 'Object'}` : `type ${typeof value} (${String(value)})`}`);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  if (input.protocol !== 'file:') {
    const error = new TypeError('The URL must be of scheme file');
    error.code = 'ERR_INVALID_URL_SCHEME';
    throw error;
  }
  if (!windows && input.hostname && input.hostname !== 'localhost') {
    const error = new TypeError('File URL host must be "localhost" or empty on linux');
    error.code = 'ERR_INVALID_FILE_URL_HOST';
    throw error;
  }
  const decodeBytes = (pathname) => {
    const bytes = [];
    for (let index = 0; index < pathname.length;) {
      if (pathname[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(pathname.slice(index + 1, index + 3))) {
        bytes.push(Number.parseInt(pathname.slice(index + 1, index + 3), 16));
        index += 3;
        continue;
      }
      const codePoint = pathname.codePointAt(index);
      const text = String.fromCodePoint(codePoint);
      bytes.push(...new TextEncoder().encode(text));
      index += text.length;
    }
    return new Uint8Array(bytes);
  };
  const decodedBytes = decodeBytes(input.pathname);
  if (decodedBytes[0] !== 0x2F) {
    const error = new TypeError('File URL path must be absolute');
    error.code = 'ERR_INVALID_FILE_URL_PATH';
    throw error;
  }
  let bytes = decodedBytes;
  if (windows) {
    if (input.hostname && input.hostname !== 'localhost') {
      const prefix = new TextEncoder().encode(`\\\\${input.hostname}`);
      const suffix = bytes.slice(0);
      for (let index = 0; index < suffix.length; index += 1) if (suffix[index] === 0x2F) suffix[index] = 0x5C;
      bytes = new Uint8Array(prefix.length + suffix.length);
      bytes.set(prefix);
      bytes.set(suffix, prefix.length);
    } else {
      if (bytes.length < 3 || !((bytes[1] >= 0x41 && bytes[1] <= 0x5A) || (bytes[1] >= 0x61 && bytes[1] <= 0x7A)) || bytes[2] !== 0x3A) {
        const error = new TypeError('File URL path must be absolute');
        error.code = 'ERR_INVALID_FILE_URL_PATH';
        throw error;
      }
      bytes = bytes.slice(1);
      for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0x2F) bytes[index] = 0x5C;
    }
  }
  return typeof scope.Buffer?.from === 'function' ? scope.Buffer.from(bytes) : bytes;
}

export function createUrlModule(scope, { pathToFileURL, fileURLToPath } = {}) {
  const { URL: URLClass, URLSearchParams } = createNodeUrlSearchParams(scope);
  const parse = (input, parseQueryString = false, slashesDenoteHost = false) =>
    input instanceof Url ? input : legacyParseUrl(scope, input, parseQueryString, slashesDenoteHost);
  const resolve = (from, to) => parse(from).resolve(to);
  const resolveObject = (from, to) => parse(from).resolveObject(to);
  return Object.freeze({
    URL: URLClass,
    URLSearchParams,
    Url,
    parse,
    format: (value) => formatUrl(value, scope),
    resolve,
    resolveObject,
    domainToASCII: (value) => String(value),
    domainToUnicode: (value) => String(value),
    pathToFileURL,
    fileURLToPath,
    fileURLToPathBuffer: (value, options) => fileURLToPathBuffer(scope, value, options),
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
