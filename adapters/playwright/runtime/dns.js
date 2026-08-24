import { AsyncResource } from './async-hooks.js';

const BUILTIN_RECORDS = Object.freeze({
  localhost: [{ address: '127.0.0.1', family: 4 }],
  '127.0.0.1': [{ address: '127.0.0.1', family: 4 }],
  '0.0.0.0': [{ address: '0.0.0.0', family: 4 }],
  '::1': [{ address: '::1', family: 6 }],
  '::': [{ address: '::', family: 6 }],
});

const SERVICE_NAMES = Object.freeze({
  22: 'ssh',
  53: 'domain',
  80: 'http',
  443: 'https',
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
  return { family: Number(options.family || 0), all: Boolean(options.all), verbatim: Boolean(options.verbatim) };
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
export function createBrowserDns({ synchronous = false, records = {}, proxy } = {}) {
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
    const actualCallback = typeof options === 'function' ? options : callback;
    if (typeof actualCallback !== 'function') throw new TypeError('callback must be a function');
    const lookupOptions = normalizeLookupOptions(typeof options === 'function' ? undefined : options);
    if (lookupThroughProxy(hostname, lookupOptions, actualCallback)) return;
    const complete = () => {
      try {
        const result = lookupAddress(hostname, lookupOptions.family);
        actualCallback(null, lookupOptions.all ? [result] : result.address, lookupOptions.all ? undefined : result.family);
      } catch (error) {
        actualCallback(error);
      }
    };
    if (synchronous) complete();
    else queueMicrotask(complete);
  }

  function resolveFamily(hostname, family, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(hostname))) {
      Promise.resolve(proxy.resolve({ hostname: String(hostname), family, all: true }))
        .then((result) => callback(null, normalizeProxyRecords(result, hostname, family).map((record) => record.address)))
        .catch((error) => callback(error));
      return;
    }
    const complete = () => {
      try { callback(null, [lookupAddress(hostname, family).address]); }
      catch (error) { callback(error); }
    };
    if (synchronous) complete();
    else queueMicrotask(complete);
  }

  function reverse(address, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(address))) {
      Promise.resolve(proxy.resolve({ address: String(address), reverse: true }))
        .then((result) => {
          const names = Array.isArray(result) ? result : result?.hostnames || result?.names || result?.host ? [result.host] : [];
          if (!names.length) throw dnsError(address);
          callback(null, names.map(String));
        })
        .catch((error) => callback(error));
      return;
    }
    const complete = () => {
      const hostname = Object.entries(BUILTIN_RECORDS).find(([, values]) => values.some((record) => record.address === address))?.[0];
      if (hostname) callback(null, [hostname]);
      else callback(dnsError(address));
    };
    if (synchronous) complete();
    else queueMicrotask(complete);
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

    const request = new AsyncResource('GETNAMEINFOREQWRAP');
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
    if (synchronous) complete();
    else queueMicrotask(complete);
    return request;
  }

  const promises = {
    lookup(hostname, options) {
      const lookupOptions = normalizeLookupOptions(options);
      if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(hostname))) {
        return new Promise((resolve, reject) => lookup(hostname, lookupOptions, (error, address, family) => {
          if (error) reject(error);
          else resolve(lookupOptions.all ? address : { address, family });
        }));
      }
      return promiseFor(() => {
        const result = lookupAddress(hostname, lookupOptions.family);
        return lookupOptions.all ? [result] : result;
      }, synchronous);
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
    lookupService(address, port) {
      return new Promise((resolve, reject) => lookupService(address, port, (error, hostname, service) => {
        if (error) reject(error);
        else resolve({ hostname, service });
      }));
    },
  };

  return {
    lookup,
    lookupService,
    resolve4: (hostname, callback) => resolveFamily(hostname, 4, callback),
    resolve6: (hostname, callback) => resolveFamily(hostname, 6, callback),
    reverse,
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
    promises,
  };
}
