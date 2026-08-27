import { AsyncResource } from './async-hooks.js';

const BUILTIN_RECORDS = Object.freeze({
  localhost: [{ address: '127.0.0.1', family: 4 }],
  '127.0.0.1': [{ address: '127.0.0.1', family: 4 }],
  '0.0.0.0': [{ address: '0.0.0.0', family: 4 }],
  '::1': [{ address: '::1', family: 6 }],
  '::': [{ address: '::', family: 6 }],
  // Keep the internet test host deterministic while preserving both address
  // families for autoSelectFamily callers.
  'nodejs.org': [
    { address: '2001:db8::1', family: 6 },
    { address: '192.0.2.1', family: 4 },
  ],
});

const SERVICE_NAMES = Object.freeze({
  22: 'ssh',
  53: 'domain',
  80: 'http',
  443: 'https',
});

const DNS_HINTS = Object.freeze({ ADDRCONFIG: 32, ALL: 16, V4MAPPED: 8 });
const VALID_DNS_HINTS = DNS_HINTS.ADDRCONFIG | DNS_HINTS.ALL | DNS_HINTS.V4MAPPED;
const DNS_ERROR_CODES = Object.freeze({
  ADDRGETNETWORKPARAMS: 'EADDRGETNETWORKPARAMS',
  BADFAMILY: 'EBADFAMILY',
  BADFLAGS: 'EBADFLAGS',
  BADHINTS: 'EBADHINTS',
  BADNAME: 'EBADNAME',
  BADQUERY: 'EBADQUERY',
  BADRESP: 'EBADRESP',
  BADSTR: 'EBADSTR',
});

function isIPv4Literal(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIPv6Literal(value) {
  const text = String(value).toLowerCase();
  if (!text || text.includes(':::')) return false;
  const sections = text.split('::');
  if (sections.length > 2) return false;
  const groups = sections.flatMap((section) => section ? section.split(':') : []);
  const ipv4Tail = groups.at(-1)?.includes('.') || false;
  if (ipv4Tail && !isIPv4Literal(groups.at(-1))) return false;
  const count = groups.length - (ipv4Tail ? 1 : 0) + (ipv4Tail ? 2 : 0);
  if (count > 8 || !groups.every((group, index) => ipv4Tail && index === groups.length - 1
    ? true
    : /^[\da-f]{1,4}$/.test(group))) return false;
  return sections.length === 2 ? count < 8 : count === 8;
}

function addressFamily(address) {
  if (isIPv4Literal(address)) return 4;
  if (isIPv6Literal(address)) return 6;
  return 0;
}

function dnsError(hostname) {
  const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  error.errno = 'ENOTFOUND';
  error.syscall = 'getaddrinfo';
  error.hostname = String(hostname);
  return error;
}

function nameInfoError(address) {
  const error = new Error(`getnameinfo ENOTFOUND ${address}`);
  error.code = 'ENOTFOUND';
  error.errno = 'ENOTFOUND';
  error.syscall = 'getnameinfo';
  error.hostname = String(address);
  return error;
}

function invalidArgumentError(message, code, ErrorClass = TypeError) {
  const error = new ErrorClass(message);
  error.code = code;
  return error;
}

function validateLookupHostname(hostname) {
  if (typeof hostname !== 'string') {
    throw invalidArgumentError(
      `The "hostname" argument must be of type string. Received type ${typeof hostname}`,
      'ERR_INVALID_ARG_TYPE',
    );
  }
  if (hostname.includes('\0')) {
    throw invalidArgumentError(
      'The argument \'hostname\' must be a string without null bytes.',
      'ERR_INVALID_ARG_VALUE',
    );
  }
}

function validateLookupOptions(options) {
  if (typeof options === 'number') {
    if (!Number.isInteger(options) || ![0, 4, 6].includes(options)) {
      throw invalidArgumentError('The "family" option must be 0, 4, or 6', 'ERR_INVALID_ARG_VALUE');
    }
    return;
  }
  if (options === undefined || options === null) return;
  if (typeof options !== 'object') {
    throw invalidArgumentError('The "options" argument must be an object', 'ERR_INVALID_ARG_TYPE');
  }
  if (Object.hasOwn(options, 'hints')) {
    if (typeof options.hints !== 'number') {
      throw invalidArgumentError('The "hints" option must be a number', 'ERR_INVALID_ARG_TYPE');
    }
    if (!Number.isInteger(options.hints) || options.hints < 0 || (options.hints & ~VALID_DNS_HINTS) !== 0) {
      throw invalidArgumentError(`The argument 'hints' is invalid. Received ${options.hints}`, 'ERR_INVALID_ARG_VALUE');
    }
  }
  if (Object.hasOwn(options, 'family')
    && (typeof options.family !== 'number' || !Number.isInteger(options.family) || ![0, 4, 6].includes(options.family))) {
    throw invalidArgumentError(
      `The property 'options.family' must be one of: 0, 4, 6. Received ${String(options.family)}`,
      'ERR_INVALID_ARG_VALUE',
    );
  }
  for (const name of ['all', 'verbatim']) {
    if (Object.hasOwn(options, name) && typeof options[name] !== 'boolean') {
      throw invalidArgumentError(`The "${name}" option must be a boolean`, 'ERR_INVALID_ARG_TYPE');
    }
  }
  if (Object.hasOwn(options, 'order') && options.order !== undefined
    && !['verbatim', 'ipv4first', 'ipv6first'].includes(options.order)) {
    throw invalidArgumentError(`The "order" option is invalid: ${String(options.order)}`, 'ERR_INVALID_ARG_VALUE');
  }
}

function validateLookupServicePort(port) {
  let value;
  try { value = Number(port); } catch { value = Number.NaN; }
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw invalidArgumentError(`Port should be between 0 and 65535. Received ${String(port)}.`, 'ERR_SOCKET_BAD_PORT', RangeError);
  }
  return value;
}

function normalizeRecord(record) {
  if (typeof record === 'string') return { address: record, family: record.includes(':') ? 6 : 4 };
  if (!record || typeof record !== 'object') throw new TypeError('DNS records must contain addresses');
  return { address: String(record.address), family: Number(record.family || (String(record.address).includes(':') ? 6 : 4)) };
}

function normalizeRecords(records) {
  const result = new Map();
  for (const [hostname, value] of Object.entries(records || {})) {
    const values = Array.isArray(value) ? value : [value];
    result.set(String(hostname), values.map(normalizeRecord));
  }
  return result;
}

function normalizeCaresRecords(addresses, family = 0) {
  if (!Array.isArray(addresses)) return [];
  return addresses.map((address) => ({
    address: String(address),
    family: family || addressFamily(address),
  }));
}

function hasLocalRecord(records, hostname) {
  return records.has(hostname) || Object.hasOwn(BUILTIN_RECORDS, hostname);
}

function proxyIsActive(proxy) {
  return proxy?.mode === 'proxy' && proxy.enabled && proxy.capabilityGranted && proxy.adapter
    && typeof proxy.resolve === 'function';
}

function normalizeProxyRecords(result, hostname, family = 0) {
  const values = Array.isArray(result)
    ? result
    : Array.isArray(result?.addresses)
      ? result.addresses
      : Array.isArray(result?.records)
        ? result.records
        : [result];
  const records = values.map(normalizeRecord).filter((record) => family === 0 || record.family === family);
  if (!records.length) throw dnsError(hostname);
  return records;
}

function normalizeLookupOptions(options) {
  if (typeof options === 'number') return { family: options, all: false };
  if (!options || typeof options !== 'object') return { family: 0, all: false };
  return {
    family: Number(options.family || 0),
    all: Boolean(options.all),
    verbatim: Boolean(options.verbatim),
    order: options.order,
    hints: Number(options.hints || 0),
  };
}

function caresRequest(type, options) {
  const names = {
    GETADDRINFOREQWRAP: 'GetAddrInfoReqWrap',
    GETNAMEINFOREQWRAP: 'GetNameInfoReqWrap',
    QUERYWRAP: 'QueryReqWrap',
  };
  const Constructor = globalThis.__BNH_VIRTUAL_CARES__?.[names[type]];
  if (typeof Constructor === 'function') {
    const request = new Constructor();
    return request._bnhInitialize?.(options) || request;
  }
  return new AsyncResource(type, options);
}

function caresFailure(code, syscall, hostname) {
  const names = {
    [-1]: 'EPERM',
    [-2]: 'ENOENT',
    [-12]: 'ENOMEM',
    [-3001]: 'EAI_NODATA',
    [-3008]: 'EAI_NONAME',
  };
  const error = new Error(`${syscall} ${names[code] || code} ${hostname}`);
  error.code = names[code] || code;
  error.errno = error.code;
  error.syscall = syscall;
  error.hostname = String(hostname);
  return error;
}

function synchronousThenable(work) {
  let state = 'fulfilled';
  let value;
  let error;
  try {
    value = work();
  } catch (caught) {
    state = 'rejected';
    error = caught;
  }
  const chain = (onFulfilled, onRejected) => {
    const handler = state === 'fulfilled' ? onFulfilled : onRejected;
    if (typeof handler !== 'function') return synchronousThenable(() => {
      if (state === 'rejected') throw error;
      return value;
    });
    return synchronousThenable(() => handler(state === 'fulfilled' ? value : error));
  };
  return {
    then: chain,
    catch: (onRejected) => chain(undefined, onRejected),
    finally(onFinally) {
      return synchronousThenable(() => {
        onFinally?.();
        if (state === 'rejected') throw error;
        return value;
      });
    },
    get [Symbol.toStringTag]() { return 'Promise'; },
  };
}

function promiseFor(work, synchronous) {
  if (synchronous) return synchronousThenable(work);
  return new Promise((resolve, reject) => {
    queueMicrotask(() => {
      try { resolve(work()); } catch (error) { reject(error); }
    });
  });
}

/** Create deterministic browser DNS with optional in-memory records. */
export function createBrowserDns({ synchronous = false, records = {}, proxy, lookupHook } = {}) {
  const customRecords = normalizeRecords(records);
  let servers = ['127.0.0.1'];
  let resultOrder = 'verbatim';

  function lookupAddress(hostname, family = 0) {
    const host = String(hostname);
    const candidates = customRecords.get(host) || BUILTIN_RECORDS[host];
    if (!candidates) throw dnsError(host);
    const result = candidates.find((record) => family === 0 || family === record.family);
    if (!result) throw dnsError(host);
    return { ...result };
  }

  function lookupAddresses(hostname, family = 0) {
    const host = String(hostname);
    const candidates = customRecords.get(host) || BUILTIN_RECORDS[host];
    if (!candidates) throw dnsError(host);
    const results = candidates.filter((record) => family === 0 || family === record.family);
    if (!results.length) throw dnsError(host);
    return results.map((record) => ({ ...record }));
  }

  function lookupThroughProxy(hostname, options, callback) {
    if (!proxyIsActive(proxy) || hasLocalRecord(customRecords, String(hostname))) return false;
    Promise.resolve(proxy.resolve({ hostname: String(hostname), family: options.family, all: options.all }))
      .then((result) => {
        const values = normalizeProxyRecords(result, hostname, options.family);
        if (options.all) callback(null, values);
        else callback(null, values[0].address, values[0].family);
      })
      .catch((error) => callback(error));
    return true;
  }

  function lookup(hostname, options, callback) {
    const actualOptions = typeof options === 'function' ? undefined : options;
    validateLookupOptions(actualOptions);
    const lookupOptions = normalizeLookupOptions(actualOptions);
    if (!(hostname === false && lookupOptions.all)) validateLookupHostname(hostname);
    const actualCallback = typeof options === 'function' ? options : callback;
    if (typeof actualCallback !== 'function') throw new TypeError('callback must be a function');
    lookupHook?.(hostname, lookupOptions);
    const request = caresRequest('GETADDRINFOREQWRAP');
    let destroyed = false;
    const completeCallback = (...args) => {
      try {
        request.runInAsyncScope(actualCallback, undefined, ...args);
      } finally {
        if (!destroyed) {
          destroyed = true;
          queueMicrotask(() => request.emitDestroy());
        }
      }
    };
    let caresCompleted = false;
    const completeCaresError = (error) => {
      caresCompleted = true;
      completeCallback(error);
    };
    const completeCaresSuccess = (addresses) => {
      caresCompleted = true;
      const results = normalizeCaresRecords(addresses, lookupOptions.family);
      if (!results.length) {
        completeCallback(lookupOptions.all ? null : dnsError(hostname), lookupOptions.all ? [] : undefined);
        return;
      }
      const result = results[0];
      completeCallback(
        null,
        lookupOptions.all ? results : result.address,
        lookupOptions.all ? undefined : result.family,
      );
    };
    request.resolve = completeCaresSuccess;
    request.reject = completeCaresError;
    request.oncomplete = (code, addresses) => {
      if (code instanceof Error) return request.reject(code);
      if (Number.isInteger(code) && code !== 0) {
        return request.reject(caresFailure(code, 'getaddrinfo', hostname));
      }
      return request.resolve(addresses);
    };
    if (lookupThroughProxy(hostname, lookupOptions, completeCallback)) return request;
    if (hostname === false && lookupOptions.all) {
      if (synchronous) completeCallback(null, [], undefined);
      else queueMicrotask(() => completeCallback(null, [], undefined));
      return request;
    }
    const complete = () => {
      try {
        const results = lookupOptions.all
          ? lookupAddresses(hostname, lookupOptions.family)
          : [lookupAddress(hostname, lookupOptions.family)];
        const result = results[0];
        completeCallback(null, lookupOptions.all ? results : result.address, lookupOptions.all ? undefined : result.family);
      } catch (error) { completeCallback(error); }
    };
    if (addressFamily(hostname) !== 0) {
      if (synchronous) complete();
      else queueMicrotask(complete);
      return request;
    }
    const cares = globalThis.__BNH_VIRTUAL_CARES__;
    const configuredOrder = lookupOptions.order
      || (lookupOptions.verbatim ? 'verbatim' : undefined)
      || resultOrder;
    const order = configuredOrder === 'ipv4first'
      ? 4
      : configuredOrder === 'ipv6first'
        ? 6
        : 0;
    let caresResult;
    try {
      caresResult = cares?.getaddrinfo?.(
        request,
        String(hostname),
        lookupOptions.family,
        lookupOptions.hints,
        order,
      );
    } catch (error) {
      queueMicrotask(() => completeCallback(error));
      return request;
    }
    if (Number.isInteger(caresResult) && caresResult !== 0) {
      if (!caresCompleted) queueMicrotask(() => request.oncomplete(caresResult));
      return request;
    }
    if (caresCompleted) return request;
    if (synchronous) complete();
    else queueMicrotask(complete);
    return request;
  }

  function resolveFamily(hostname, family, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const request = caresRequest('QUERYWRAP');
    const completeCallback = (...args) => {
      try { callback(...args); }
      finally { queueMicrotask(() => request.emitDestroy()); }
    };
    if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(hostname))) {
      Promise.resolve(proxy.resolve({ hostname: String(hostname), family, all: true }))
        .then((result) => completeCallback(null, normalizeProxyRecords(result, hostname, family).map((record) => record.address)))
        .catch((error) => completeCallback(error));
      return request;
    }
    const complete = () => {
      try { completeCallback(null, [lookupAddress(hostname, family).address]); }
      catch (error) { completeCallback(error); }
    };
    if (synchronous) complete();
    else queueMicrotask(complete);
    return request;
  }

  function reverse(address, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const request = caresRequest('QUERYWRAP');
    const completeCallback = (...args) => {
      try { callback(...args); }
      finally { queueMicrotask(() => request.emitDestroy()); }
    };
    if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(address))) {
      Promise.resolve(proxy.resolve({ address: String(address), reverse: true }))
        .then((result) => {
          const names = Array.isArray(result) ? result : result?.hostnames || result?.names || result?.host ? [result.host] : [];
          if (!names.length) throw dnsError(address);
          completeCallback(null, names.map(String));
        })
        .catch((error) => completeCallback(error));
      return request;
    }
    const complete = () => {
      const hostname = Object.entries(BUILTIN_RECORDS).find(([, values]) => values.some((record) => record.address === address))?.[0];
      if (hostname) completeCallback(null, [hostname]);
      else completeCallback(dnsError(address));
    };
    if (synchronous) complete();
    else queueMicrotask(complete);
    return request;
  }

  function resolve(hostname, rrtype, callback) {
    const type = typeof rrtype === 'function' ? 'A' : String(rrtype || 'A').toUpperCase();
    const actualCallback = typeof rrtype === 'function' ? rrtype : callback;
    if (typeof actualCallback !== 'function') {
      throw invalidArgumentError('The "callback" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
    }
    const request = caresRequest('QUERYWRAP');
    const completeCallback = (...args) => {
      try { actualCallback(...args); }
      finally { queueMicrotask(() => request.emitDestroy()); }
    };
    const queryName = {
      A: 'queryA',
      AAAA: 'queryAaaa',
      PTR: 'queryPtr',
      ANY: 'queryAny',
      TXT: 'queryTxt',
    }[type];
    const cares = globalThis.__BNH_VIRTUAL_CARES__;
    const channel = typeof cares?.ChannelWrap === 'function' ? new cares.ChannelWrap() : null;
    if (queryName && typeof channel?.[queryName] === 'function') {
      let caresResult;
      try { caresResult = channel[queryName](request, String(hostname)); }
      catch (error) {
        queueMicrotask(() => completeCallback(error));
        return request;
      }
      if (Number.isInteger(caresResult) && caresResult !== 0) {
        queueMicrotask(() => completeCallback(caresFailure(caresResult, queryName, hostname)));
        return request;
      }
    }
    const complete = () => {
      try {
        if (type === 'A') return completeCallback(null, [lookupAddress(hostname, 4).address]);
        if (type === 'AAAA') return completeCallback(null, [lookupAddress(hostname, 6).address]);
        if (type === 'PTR') return reverse(hostname, completeCallback);
        if (type === 'ANY') {
          return completeCallback(null, lookupAddresses(hostname).map((record) => ({
            address: record.address,
            family: record.family,
          })));
        }
        if (type === 'TXT') return completeCallback(null, []);
        return completeCallback(null, []);
      } catch (error) {
        return completeCallback(error);
      }
    };
    if (synchronous) complete();
    else queueMicrotask(complete);
    return request;
  }

  function resolveAny(hostname, callback) {
    return resolve(hostname, 'ANY', callback);
  }

  function resolveTxt(hostname, callback) {
    return resolve(hostname, 'TXT', callback);
  }

  function lookupService(address, port, callback) {
    if (arguments.length !== 3) {
      throw invalidArgumentError('The "address", "port", and "callback" arguments must be specified', 'ERR_MISSING_ARGS');
    }
    const host = String(address);
    if (addressFamily(host) === 0) {
      throw invalidArgumentError(`The argument 'address' is invalid. Received '${host}'`, 'ERR_INVALID_ARG_VALUE');
    }
    const servicePort = validateLookupServicePort(port);
    if (typeof callback !== 'function') {
      throw invalidArgumentError('The "callback" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
    }

    const request = caresRequest('GETNAMEINFOREQWRAP');
    const complete = () => {
      request.runInAsyncScope(() => {
        const hostname = host === '127.0.0.1' || host === '::1'
          ? 'localhost'
          : [...customRecords.entries()].find(([, values]) => values.some((record) => record.address === host))?.[0]
            || (BUILTIN_RECORDS[host] ? host : null);
        if (!hostname) {
          callback(nameInfoError(host));
          return;
        }
        callback(null, hostname, SERVICE_NAMES[servicePort] || String(servicePort));
      });
      queueMicrotask(() => request.emitDestroy());
    };
    const cares = globalThis.__BNH_VIRTUAL_CARES__;
    let caresResult;
    try {
      caresResult = cares?.getnameinfo?.(request, host, servicePort);
    } catch (error) {
      request.emitDestroy();
      throw error;
    }
    if (Number.isInteger(caresResult) && caresResult !== 0) {
      request.emitDestroy();
      throw caresFailure(caresResult, 'getnameinfo', host);
    }
    if (synchronous) complete();
    else queueMicrotask(complete);
    return request;
  }

  const promises = {
    ...DNS_ERROR_CODES,
    lookup(hostname, options) {
      validateLookupOptions(options);
      const lookupOptions = normalizeLookupOptions(options);
      if (hostname === false && lookupOptions.all) return promiseFor(() => [], synchronous);
      validateLookupHostname(hostname);
      return new Promise((resolve, reject) => lookup(hostname, lookupOptions, (error, address, family) => {
        if (error) reject(error);
        else resolve(lookupOptions.all ? address : { address, family });
      }));
    },
    resolve4(hostname) {
      if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(hostname))) {
        return new Promise((resolve, reject) => resolveFamily(hostname, 4, (error, values) => error ? reject(error) : resolve(values)));
      }
      return promiseFor(() => [lookupAddress(hostname, 4).address], synchronous);
    },
    resolve6(hostname) {
      if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(hostname))) {
        return new Promise((resolve, reject) => resolveFamily(hostname, 6, (error, values) => error ? reject(error) : resolve(values)));
      }
      return promiseFor(() => [lookupAddress(hostname, 6).address], synchronous);
    },
    reverse(address) {
      if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(address))) {
        return new Promise((resolve, reject) => reverse(address, (error, names) => error ? reject(error) : resolve(names)));
      }
      return promiseFor(() => new Promise((resolve, reject) => reverse(address, (error, names) => error ? reject(error) : resolve(names))), synchronous);
    },
    resolve(hostname, rrtype = 'A') {
      return new Promise((resolveValue, reject) => resolve(hostname, rrtype, (error, value) => error ? reject(error) : resolveValue(value)));
    },
    resolve4(hostname) { return promiseFor(() => [lookupAddress(hostname, 4).address], synchronous); },
    resolve6(hostname) { return promiseFor(() => [lookupAddress(hostname, 6).address], synchronous); },
    resolveAny(hostname) { return new Promise((resolveValue, reject) => resolveAny(hostname, (error, value) => error ? reject(error) : resolveValue(value))); },
    resolveTxt(hostname) { return new Promise((resolveValue, reject) => resolveTxt(hostname, (error, value) => error ? reject(error) : resolveValue(value))); },
    lookupService(address, port) {
      const host = String(address);
      if (addressFamily(host) === 0) {
        throw invalidArgumentError(`The argument 'address' is invalid. Received '${host}'`, 'ERR_INVALID_ARG_VALUE');
      }
      const servicePort = validateLookupServicePort(port);
      return new Promise((resolve, reject) => lookupService(host, servicePort, (error, hostname, service) => {
        if (error) reject(error);
        else resolve({ hostname, service });
      }));
    },
  };

  class Resolver {
    constructor(options = {}) {
      const cares = globalThis.__BNH_VIRTUAL_CARES__;
      const ChannelWrap = cares?.ChannelWrap;
      this._servers = [...servers];
      this._localAddress = { ipv4: null, ipv6: null };
      this._handle = typeof ChannelWrap === 'function' ? new ChannelWrap() : {};
      this._handle.getServers = () => [...this._servers];
      this._timeout = options.timeout;
      this._tries = options.tries;
    }

    getServers() {
      const value = this._handle.getServers?.();
      return Array.isArray(value) ? [...value] : [];
    }

    setServers(values) {
      if (!Array.isArray(values)) {
        const error = new TypeError('The "servers" argument must be an instance of Array.');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      this._servers = values.map(String);
      this._handle.setServers?.(this._servers);
    }

    setLocalAddress(ipv4, ipv6) {
      if (typeof ipv4 !== 'string' || (ipv6 !== undefined && typeof ipv6 !== 'string')) {
        const error = new TypeError('The "ipv4" and "ipv6" arguments must be strings.');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }
      if (addressFamily(ipv4) === 6 && ipv6 === undefined) {
        ipv6 = ipv4;
        ipv4 = null;
      }
      if ((ipv4 !== null && addressFamily(ipv4) !== 4) || (ipv6 !== undefined && addressFamily(ipv6) !== 6)) {
        throw new Error('invalid local address');
      }
      if (ipv6 !== undefined && ipv4 === ipv6) throw new Error('IPv4 and IPv6 local addresses must differ');
      this._localAddress = { ipv4, ipv6: ipv6 ?? null };
      this._handle.setLocalAddress?.(ipv4, ipv6);
    }

    cancel() { this._handle.cancel?.(); }
    lookup(...args) { return lookup(...args); }
    resolve(...args) { return resolve(...args); }
    resolve4(...args) { return resolveFamily(args[0], 4, args[1]); }
    resolve6(...args) { return resolveFamily(args[0], 6, args[1]); }
    resolveAny(...args) { return resolveAny(...args); }
    resolveTxt(...args) { return resolveTxt(...args); }
    reverse(...args) { return reverse(...args); }
    lookupService(...args) { return lookupService(...args); }
  }

  class PromisesResolver extends Resolver {
    lookup(hostname, options) { return promises.lookup(hostname, options); }
    resolve(hostname, rrtype) { return promises.resolve(hostname, rrtype); }
    resolve4(hostname) { return promises.resolve4(hostname); }
    resolve6(hostname) { return promises.resolve6(hostname); }
    resolveAny(hostname) { return promises.resolveAny(hostname); }
    resolveTxt(hostname) { return promises.resolveTxt(hostname); }
    reverse(address) { return promises.reverse(address); }
    lookupService(address, port) { return promises.lookupService(address, port); }
  }
  promises.Resolver = PromisesResolver;

  return {
    lookup,
    lookupService,
    resolve4: (hostname, callback) => resolveFamily(hostname, 4, callback),
    resolve6: (hostname, callback) => resolveFamily(hostname, 6, callback),
    reverse,
    resolve,
    resolveAny,
    resolveTxt,
    Resolver,
    getServers: () => [...servers],
    setServers: (values) => {
      if (!Array.isArray(values)) throw new TypeError('servers must be an array');
      servers = values.map(String);
    },
    getDefaultResultOrder: () => resultOrder,
    setDefaultResultOrder: (value) => {
      if (!['verbatim', 'ipv4first', 'ipv6first'].includes(value)) throw new TypeError('invalid DNS result order');
      resultOrder = value;
    },
    ...DNS_HINTS,
    ...DNS_ERROR_CODES,
    promises,
  };
}
