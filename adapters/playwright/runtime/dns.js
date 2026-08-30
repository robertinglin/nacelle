import { AsyncResource } from './async-hooks.js';
import { sharedVirtualNetwork } from './virtual-network.js';

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

// These records keep the resolver surface useful in a browser without
// silently delegating DNS work to the host. They intentionally contain only
// the shapes exposed by the resolver methods implemented below.
const BUILTIN_DNS_RECORDS = Object.freeze({
  'nodejs.org': Object.freeze({
    MX: Object.freeze([{ exchange: 'mail.nodejs.org', priority: 10 }]),
    NS: Object.freeze(['ns1.nodejs.org']),
    SOA: Object.freeze({
      nsname: 'ns1.nodejs.org',
      hostmaster: 'hostmaster.nodejs.org',
      serial: 1,
      refresh: 3600,
      retry: 600,
      expire: 86400,
      minttl: 300,
    }),
  }),
  '_caldav._tcp.google.com': Object.freeze({
    SRV: Object.freeze([{ name: 'calendar.google.com', port: 443, priority: 10, weight: 10 }]),
  }),
  '8.8.8.8.in-addr.arpa': Object.freeze({ PTR: Object.freeze(['dns.google']) }),
  'sip2sip.info': Object.freeze({
    NAPTR: Object.freeze([{
      flags: 's', service: 'SIP+D2U', regexp: '', replacement: '_sip._udp.sip2sip.info', order: 10, preference: 10,
    }]),
  }),
  '_443._tcp.fedoraproject.org': Object.freeze({
    TLSA: Object.freeze([{ certUsage: 3, selector: 1, match: 1, data: new Uint8Array([0]).buffer }]),
  }),
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
  NODATA: 'ENODATA',
  FORMERR: 'EFORMERR',
  CONNREFUSED: 'ECONNREFUSED',
  EOF: 'EOF',
  FILE: 'EFILE',
  DESTRUCTION: 'EDESTRUCTION',
  LOADIPHLPAPI: 'ELOADIPHLPAPI',
  CANCELLED: 'ECANCELLED',
  NOMEM: 'ENOMEM',
  NONAME: 'ENONAME',
  NOTFOUND: 'ENOTFOUND',
  NOTIMP: 'ENOTIMP',
  NOTINITIALIZED: 'ENOTINITIALIZED',
  REFUSED: 'EREFUSED',
  TIMEOUT: 'ETIMEOUT',
  SERVFAIL: 'ESERVFAIL',
});

const RESOLVER_TYPES = Object.freeze({
  CAA: 'resolveCaa',
  CNAME: 'resolveCname',
  MX: 'resolveMx',
  NS: 'resolveNs',
  TLSA: 'resolveTlsa',
  SRV: 'resolveSrv',
  PTR: 'resolvePtr',
  NAPTR: 'resolveNaptr',
  SOA: 'resolveSoa',
});

const RESOLVE_TYPES = Object.freeze([
  'A', 'AAAA', 'ANY', 'TXT', ...Object.keys(RESOLVER_TYPES),
]);

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

function describeReceived(value) {
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'object') return `an instance of ${value.constructor?.name || 'Object'}`;
  if (typeof value === 'function') return `function ${value.name || ''}`.trim();
  const inspected = typeof value === 'string' ? `'${value}'` : String(value);
  return `type ${typeof value} (${inspected})`;
}

function validateLookupHostname(hostname) {
  if (typeof hostname !== 'string') {
    throw invalidArgumentError(
      `The "hostname" argument must be of type string. Received ${describeReceived(hostname)}`,
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
  if (Object.hasOwn(options, 'family')) {
    if (typeof options.family === 'string' && ['IPv4', 'IPv6'].includes(options.family)) {
      // Node accepts these string aliases and normalizes them before lookup.
    } else if (typeof options.family !== 'number') {
      throw invalidArgumentError('The "family" option must be of type number', 'ERR_INVALID_ARG_TYPE');
    } else if (!Number.isInteger(options.family) || ![0, 4, 6].includes(options.family)) {
      throw invalidArgumentError(
        `The property 'options.family' must be one of: 0, 4, 6. Received ${String(options.family)}`,
        'ERR_INVALID_ARG_VALUE',
      );
    }
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
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new RangeError('Port should be between 0 and 65535.');
    error.code = 'ERR_SOCKET_BAD_PORT';
    throw error;
  }
  return port;
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
    const addressValues = values.filter((record) => typeof record === 'string'
      || (record && typeof record === 'object' && (Object.hasOwn(record, 'address') || Object.hasOwn(record, 'family'))));
    if (addressValues.length) result.set(String(hostname), addressValues.map(normalizeRecord));
  }
  return result;
}

function normalizeQueryRecords(records) {
  const result = new Map();
  const supportedTypes = new Set(Object.keys(RESOLVER_TYPES));
  for (const [hostname, value] of Object.entries(records || {})) {
    const values = Array.isArray(value) ? value : [value];
    const byType = {};
    for (const item of values) {
      if (!item || typeof item !== 'object' || typeof item === 'function') continue;
      const explicitTypes = Object.keys(item).filter((key) => supportedTypes.has(key.toUpperCase()));
      if (explicitTypes.length) {
        for (const key of explicitTypes) {
          const type = key.toUpperCase();
          const entries = Array.isArray(item[key]) ? item[key] : [item[key]];
          byType[type] = [...(byType[type] || []), ...entries];
        }
        continue;
      }
      const type = item.exchange !== undefined || item.priority !== undefined
        ? 'MX'
        : item.critical !== undefined || item.issue !== undefined || item.issuewild !== undefined || item.iodef !== undefined
          ? 'CAA'
        : item.name !== undefined && item.port !== undefined
          ? 'SRV'
          : item.nsname !== undefined || item.hostmaster !== undefined
            ? 'SOA'
            : item.certUsage !== undefined || item.selector !== undefined || item.match !== undefined
              ? 'TLSA'
              : item.flags !== undefined || item.regexp !== undefined || item.preference !== undefined
                ? 'NAPTR'
                : item.address !== undefined || item.family !== undefined ? null : 'NS';
      if (type) byType[type] = [...(byType[type] || []), item];
    }
    if (Object.keys(byType).length) result.set(String(hostname), byType);
  }
  return result;
}

function cloneArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return new Uint8Array().buffer;
}

function normalizeQueryResult(type, value) {
  if (type === 'CAA') {
    const result = { critical: Number(value?.critical) };
    for (const property of ['issue', 'issuewild', 'iodef']) {
      if (value?.[property] !== undefined) result[property] = String(value[property]);
    }
    return result;
  }
  if (type === 'CNAME') {
    return String(typeof value === 'object' ? value.name || value.value || value.target : value);
  }
  if (type === 'MX') return { exchange: String(value.exchange), priority: Number(value.priority) };
  if (type === 'NS' || type === 'PTR') return String(typeof value === 'object' ? value.name || value.value || value.target : value);
  if (type === 'SRV') {
    return {
      name: String(value.name),
      port: Number(value.port),
      priority: Number(value.priority),
      weight: Number(value.weight),
    };
  }
  if (type === 'NAPTR') {
    return {
      flags: String(value.flags),
      service: String(value.service),
      regexp: String(value.regexp),
      replacement: String(value.replacement),
      order: Number(value.order),
      preference: Number(value.preference),
    };
  }
  if (type === 'SOA') {
    return {
      nsname: String(value.nsname),
      hostmaster: String(value.hostmaster),
      serial: Number(value.serial),
      refresh: Number(value.refresh),
      retry: Number(value.retry),
      expire: Number(value.expire),
      minttl: Number(value.minttl),
    };
  }
  if (type === 'TLSA') {
    return {
      certUsage: Number(value.certUsage),
      selector: Number(value.selector),
      match: Number(value.match),
      data: cloneArrayBuffer(value.data),
    };
  }
  return value;
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
    family: options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family || 0),
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
    3: 'ESERVFAIL',
    ESERVFAIL: 'ESERVFAIL',
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
export function createBrowserDns({ synchronous = false, records = {}, proxy, lookupHook, network = sharedVirtualNetwork } = {}) {
  const customRecords = normalizeRecords(records);
  const customQueryRecords = normalizeQueryRecords(records);
  let servers = ['127.0.0.1'];
  let resultOrder = 'verbatim';
  let defaultResolverHandle;
  let nextQueryId = 1;

  const queryTypes = Object.freeze({ A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, ANY: 255 });

  function writeDnsName(name) {
    const labels = String(name).split('.');
    const result = [];
    for (const label of labels) {
      result.push(label.length, ...new TextEncoder().encode(label));
    }
    result.push(0);
    return result;
  }

  function readDnsName(bytes, start) {
    const labels = [];
    let offset = start;
    let next = start;
    let jumped = false;
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (length === 0) {
        if (!jumped) next = offset;
        break;
      }
      if ((length & 0xc0) === 0xc0) {
        const pointer = ((length & 0x3f) << 8) | bytes[offset++];
        if (!jumped) next = offset;
        offset = pointer;
        jumped = true;
        continue;
      }
      labels.push(new TextDecoder().decode(bytes.slice(offset, offset + length)));
      offset += length;
    }
    return { name: labels.join('.'), next };
  }

  function readU16(bytes, offset) { return (bytes[offset] << 8) | bytes[offset + 1]; }
  function readU32(bytes, offset) {
    return (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  }

  function formatIpv6(bytes, offset) {
    const groups = [];
    for (let index = 0; index < 8; index += 1) groups.push(readU16(bytes, offset + index * 2).toString(16));
    let bestStart = -1;
    let bestLength = 0;
    for (let index = 0; index < groups.length;) {
      if (groups[index] !== '0') { index += 1; continue; }
      const start = index;
      while (index < groups.length && groups[index] === '0') index += 1;
      if (index - start > bestLength) { bestStart = start; bestLength = index - start; }
    }
    if (bestLength < 2) return groups.join(':');
    return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
  }

  function parseDnsResponse(bytes, type) {
    const count = readU16(bytes, 4);
    const answers = readU16(bytes, 6);
    let offset = 12;
    for (let index = 0; index < count; index += 1) {
      offset = readDnsName(bytes, offset).next + 4;
    }
    const records = [];
    for (let index = 0; index < answers; index += 1) {
      const domain = readDnsName(bytes, offset);
      offset = domain.next;
      const answerType = readU16(bytes, offset);
      const dataLength = readU16(bytes, offset + 8);
      const ttl = readU32(bytes, offset + 4);
      const dataOffset = offset + 10;
      offset = dataOffset + dataLength;
      const record = { type: Object.keys(queryTypes).find((key) => queryTypes[key] === answerType), ttl };
      if (answerType === queryTypes.A && dataLength === 4) {
        record.address = `${bytes[dataOffset]}.${bytes[dataOffset + 1]}.${bytes[dataOffset + 2]}.${bytes[dataOffset + 3]}`;
      } else if (answerType === queryTypes.AAAA && dataLength === 16) {
        record.address = formatIpv6(bytes, dataOffset);
      } else if ([queryTypes.NS, queryTypes.CNAME, queryTypes.PTR].includes(answerType)) {
        record.value = readDnsName(bytes, dataOffset).name;
      } else if (answerType === queryTypes.MX) {
        record.priority = readU16(bytes, dataOffset);
        record.exchange = readDnsName(bytes, dataOffset + 2).name;
      } else if (answerType === queryTypes.SOA) {
        const nsname = readDnsName(bytes, dataOffset);
        const hostmaster = readDnsName(bytes, dataOffset + nsname.next - dataOffset);
        const trailer = hostmaster.next;
        record.nsname = nsname.name;
        record.hostmaster = hostmaster.name;
        record.serial = readU32(bytes, trailer);
        record.refresh = readU32(bytes, trailer + 4);
        record.retry = readU32(bytes, trailer + 8);
        record.expire = readU32(bytes, trailer + 12);
        record.minttl = readU32(bytes, trailer + 16);
      }
      records.push(record);
    }
    return type === 'ANY' ? records : records.filter((record) => record.type === type);
  }

  function queryDnsServer(hostname, type, callback) {
    const server = servers[0];
    if (hasLocalRecord(customRecords, hostname)
      || customQueryRecords.get(hostname)?.[type] !== undefined
      || BUILTIN_DNS_RECORDS[hostname]?.[type] !== undefined) return false;
    if (!network || typeof server !== 'string' || !queryTypes[type]) return false;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(server);
    if (!match) return false;
    const address = match[1].replace(/^\[|\]$/g, '');
    const port = Number(match[2] || 53);
    const client = {
      boundAddress: address.includes(':') ? '::1' : '127.0.0.1',
      boundPort: 0,
      _closed: false,
      _receiveDatagram(bytes) {
        if (this._closed) return;
        this._closed = true;
        network.unbindUdp(client);
        try { callback(null, parseDnsResponse(new Uint8Array(bytes), type)); }
        catch (error) { callback(error); }
      },
    };
    let binding;
    try {
      binding = network.bindUdp(client, client.boundAddress, 0, {});
      client.boundPort = binding.port;
      const id = nextQueryId++ & 0xffff;
      const packet = new Uint8Array([
        id >> 8, id & 0xff, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0,
        ...writeDnsName(hostname), queryTypes[type] >> 8, queryTypes[type] & 0xff, 0, 1,
      ]);
      network.sendUdp({ source: client, address, port, bytes: packet });
    } catch (error) {
      client._closed = true;
      if (binding) network.unbindUdp(client);
      callback(error);
    }
    return true;
  }

  function receivedArgument(value) {
    if (value === undefined || value === null) return String(value);
    if (typeof value === 'object') {
      const constructorName = value.constructor?.name;
      return constructorName ? `an instance of ${constructorName}` : String(value);
    }
    if (typeof value === 'function') return `function ${value.name || ''}`.trim();
    const inspected = typeof value === 'string' ? `'${value}'` : String(value);
    return `type ${typeof value} (${inspected})`;
  }

  function normalizeDnsServer(server) {
    if (addressFamily(server)) return server;

    const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(server);
    if (bracketed && addressFamily(bracketed[1]) === 6) {
      const port = bracketed[2];
      return port && port !== '53' ? `[${bracketed[1]}]:${port}` : bracketed[1];
    }

    const separator = server.lastIndexOf(':');
    if (separator > 0 && server.indexOf(':') === separator) {
      const host = server.slice(0, separator);
      const port = server.slice(separator + 1);
      if (addressFamily(host) === 4 && /^\d+$/.test(port)) {
        return port === '53' ? host : `${host}:${port}`;
      }
    }

    throw invalidArgumentError(`Invalid IP address: ${server}`, 'ERR_INVALID_IP_ADDRESS');
  }

  function validateDnsServers(values) {
    if (!Array.isArray(values)) {
      throw invalidArgumentError(
        `The "servers" argument must be an instance of Array. Received ${receivedArgument(values)}`,
        'ERR_INVALID_ARG_TYPE',
      );
    }

    const normalized = [];
    const length = values.length;
    for (let index = 0; index < length; index += 1) {
      if (!(index in values)) continue;
      const server = values[index];
      if (typeof server !== 'string') {
        throw invalidArgumentError(
          `The "servers[${index}]" argument must be of type string. Received ${receivedArgument(server)}`,
          'ERR_INVALID_ARG_TYPE',
        );
      }
      normalized.push(normalizeDnsServer(server));
    }
    return normalized;
  }

  function getServers() {
    return [...servers];
  }

  function setServers(values) {
    servers = validateDnsServers(values);
    defaultResolverHandle = null;
  }

  function getDefaultResultOrder() {
    return resultOrder;
  }

  function setDefaultResultOrder(value) {
    if (!['verbatim', 'ipv4first', 'ipv6first'].includes(value)) {
      const received = typeof value === 'string' ? `'${value}'` : String(value);
      throw invalidArgumentError(
        `The argument 'dnsOrder' must be one of: 'verbatim', 'ipv4first', 'ipv6first'. Received ${received}`,
        'ERR_INVALID_ARG_VALUE',
      );
    }
    resultOrder = value;
  }

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
    if (hostname && hostname !== false) validateLookupHostname(hostname);
    const actualCallback = typeof options === 'function' ? options : callback;
    if (typeof actualCallback !== 'function') {
      throw invalidArgumentError('The "callback" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
    }
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
    if (!hostname || hostname === false) {
      const family = lookupOptions.family === 6 ? 6 : 4;
      const result = lookupOptions.all ? [] : null;
      const args = lookupOptions.all ? [null, result] : [null, result, family];
      if (synchronous) completeCallback(...args);
      else queueMicrotask(() => completeCallback(...args));
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

  function resolveFamily(hostname, family, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const includeTtl = Boolean(options?.ttl);
    const request = caresRequest('QUERYWRAP');
    const completeCallback = (...args) => {
      try { request.runInAsyncScope(callback, undefined, ...args); }
      finally { queueMicrotask(() => request.emitDestroy()); }
    };
    if (queryDnsServer(hostname, family === 4 ? 'A' : 'AAAA', (error, records) => {
      if (error) completeCallback(error);
      else completeCallback(null, records.map((record) => includeTtl
        ? { address: record.address, ttl: record.ttl }
        : record.address));
    })) return request;
    if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(hostname))) {
      Promise.resolve(proxy.resolve({ hostname: String(hostname), family, all: true }))
        .then((result) => completeCallback(null, normalizeProxyRecords(result, hostname, family).map((record) => includeTtl
          ? { address: record.address, ttl: record.ttl ?? 0 }
          : record.address)))
        .catch((error) => completeCallback(error));
      return request;
    }
    const complete = () => {
      try {
        const record = lookupAddress(hostname, family);
        completeCallback(null, [includeTtl ? { address: record.address, ttl: record.ttl ?? 0 } : record.address]);
      }
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
      try { request.runInAsyncScope(callback, undefined, ...args); }
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

  function resolve(hostname, rrtype, callback, resolverHandle) {
    let type;
    if (typeof rrtype === 'function') {
      type = 'A';
    } else if (typeof rrtype === 'string') {
      type = rrtype;
    } else {
      const received = rrtype === undefined
        ? 'undefined'
        : rrtype === null
          ? 'null'
          : typeof rrtype === 'number'
            ? `type number (${rrtype})`
            : typeof rrtype === 'object'
              ? `an instance of ${rrtype.constructor?.name || 'Object'}`
              : `type ${typeof rrtype}`;
      throw invalidArgumentError(
        `The "rrtype" argument must be of type string. Received ${describeReceived(rrtype)}`,
        'ERR_INVALID_ARG_TYPE',
      );
    }
    if (!RESOLVE_TYPES.includes(type)) {
      throw invalidArgumentError(`The argument 'rrtype' is invalid. Received '${rrtype}'`, 'ERR_INVALID_ARG_VALUE');
    }
    validateResolverName(hostname);
    const actualCallback = typeof rrtype === 'function' ? rrtype : callback;
    if (typeof actualCallback !== 'function') {
      throw invalidArgumentError('The "callback" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
    }
    if (RESOLVER_TYPES[type]) return queryRecords(hostname, type, actualCallback, resolverHandle);
    const request = caresRequest('QUERYWRAP');
    const completeCallback = (...args) => {
      try { request.runInAsyncScope(actualCallback, undefined, ...args); }
      finally { queueMicrotask(() => request.emitDestroy()); }
    };
    const queryName = {
      A: 'queryA',
      AAAA: 'queryAaaa',
      ANY: 'queryAny',
      TXT: 'queryTxt',
    }[type];
    if (queryDnsServer(hostname, type, (error, records) => {
      if (error) completeCallback(error);
      else if (type === 'ANY') completeCallback(null, records);
      else completeCallback(null, records.map((record) => record.address));
    })) return request;
    const channel = queryChannel(resolverHandle);
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
        if (type === 'ANY') {
          return completeCallback(null, lookupAddresses(hostname).map((record) => ({
            address: record.address,
            family: record.family,
          })));
        }
        if (type === 'TXT') return completeCallback(null, []);
        throw invalidArgumentError(`The argument 'rrtype' is invalid. Received '${rrtype}'`, 'ERR_INVALID_ARG_VALUE');
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

  function validateResolverQuery(hostname, callback) {
    validateResolverName(hostname);
    if (typeof callback !== 'function') {
      throw invalidArgumentError(
        'The "callback" argument must be of type function',
        'ERR_INVALID_ARG_TYPE',
      );
    }
  }

  function validateResolverName(hostname) {
    if (typeof hostname !== 'string') {
      throw invalidArgumentError(
        `The "name" argument must be of type string. Received ${describeReceived(hostname)}`,
        'ERR_INVALID_ARG_TYPE',
      );
    }
  }

  function queryError(type, hostname) {
    const bindingName = RESOLVER_TYPES[type];
    const error = new Error(`${bindingName === 'resolvePtr' ? 'queryPtr' : `query${bindingName.slice(7)}`} ENOTFOUND ${hostname}`);
    error.code = 'ENOTFOUND';
    error.errno = 'ENOTFOUND';
    error.syscall = bindingName === 'resolvePtr' ? 'queryPtr' : `query${bindingName.slice(7)}`;
    error.hostname = String(hostname);
    return error;
  }

  function queryChannel(resolverHandle) {
    if (resolverHandle) return resolverHandle;
    if (defaultResolverHandle) return defaultResolverHandle;
    const cares = globalThis.__BNH_VIRTUAL_CARES__;
    defaultResolverHandle = typeof cares?.ChannelWrap === 'function' ? new cares.ChannelWrap() : null;
    return defaultResolverHandle;
  }

  function normalizeQueryValues(type, value) {
    const values = Array.isArray(value) ? value : [value];
    if (type === 'SOA') return normalizeQueryResult(type, values[0]);
    return values.map((entry) => normalizeQueryResult(type, entry));
  }

  function queryRecords(hostname, type, callback, resolverHandle, options) {
    validateResolverQuery(hostname, callback);
    const request = caresRequest('QUERYWRAP');
    request.ttl = Boolean(options?.ttl);
    const metadata = {
      CAA: { binding: 'queryCaa' },
      CNAME: { binding: 'queryCname' },
      MX: { binding: 'queryMx' },
      NS: { binding: 'queryNs' },
      TLSA: { binding: 'queryTlsa' },
      SRV: { binding: 'querySrv' },
      PTR: { binding: 'queryPtr' },
      NAPTR: { binding: 'queryNaptr' },
      SOA: { binding: 'querySoa' },
    }[type];
    let completed = false;
    const completeCallback = (...args) => {
      if (completed) return;
      completed = true;
      try { request.runInAsyncScope(callback, undefined, ...args); }
      finally { queueMicrotask(() => request.emitDestroy()); }
    };
    request.oncomplete = (error, value) => {
      if (error) {
        completeCallback(error instanceof Error ? error : caresFailure(error, metadata.binding, hostname));
        return;
      }
      completeCallback(null, normalizeQueryValues(type, value));
    };
    const completeVirtual = () => {
      const custom = customQueryRecords.get(hostname)?.[type];
      const builtin = BUILTIN_DNS_RECORDS[hostname]?.[type];
      if (custom !== undefined || builtin !== undefined) {
        const values = custom ?? builtin;
        completeCallback(null, normalizeQueryValues(type, values));
      } else {
        completeCallback(queryError(type, hostname));
      }
    };
    if (queryDnsServer(hostname, type, (error, records) => {
      if (error) completeCallback(error);
      else completeCallback(null, type === 'SOA' ? normalizeQueryResult(type, records[0]) : records.map((record) => normalizeQueryResult(type, record)));
    })) return request;
    const channel = queryChannel(resolverHandle);
    const query = channel?.[metadata.binding];
    if (typeof query === 'function') {
      let result;
      try {
        result = query.call(channel, request, String(hostname));
      } catch (error) {
        completeCallback(error);
        return request;
      }
      if (result instanceof Error) {
        completeCallback(result);
        return request;
      }
      if (Number.isInteger(result) && result !== 0) {
        completeCallback(caresFailure(result, metadata.binding, hostname));
        return request;
      }
      // A zero return value means that the virtual channel accepted the query.
      // An undefined return is the no-egress stub; resolve it from virtual data.
      if (result === 0) return request;
    }
    if (synchronous) completeVirtual();
    else queueMicrotask(completeVirtual);
    return request;
  }

  function resolveMx(hostname, callback, resolverHandle) { return queryRecords(hostname, 'MX', callback, resolverHandle); }
  function resolveCaa(hostname, callback) {
    const options = arguments.length > 2 ? callback : undefined;
    const actualCallback = arguments.length > 2 ? arguments[2] : callback;
    return queryRecords(hostname, 'CAA', actualCallback, undefined, options);
  }
  function resolveCname(hostname, callback) {
    const options = arguments.length > 2 ? callback : undefined;
    const actualCallback = arguments.length > 2 ? arguments[2] : callback;
    return queryRecords(hostname, 'CNAME', actualCallback, undefined, options);
  }
  function resolveNs(hostname, callback, resolverHandle) { return queryRecords(hostname, 'NS', callback, resolverHandle); }
  function resolveTlsa(hostname, callback) {
    const options = arguments.length > 2 ? callback : undefined;
    const actualCallback = arguments.length > 2 ? arguments[2] : callback;
    return queryRecords(hostname, 'TLSA', actualCallback, undefined, options);
  }
  function resolveSrv(hostname, callback) {
    const options = arguments.length > 2 ? callback : undefined;
    const actualCallback = arguments.length > 2 ? arguments[2] : callback;
    return queryRecords(hostname, 'SRV', actualCallback, undefined, options);
  }
  function resolvePtr(hostname, callback, resolverHandle) { return queryRecords(hostname, 'PTR', callback, resolverHandle); }
  function resolveNaptr(hostname, callback, resolverHandle) { return queryRecords(hostname, 'NAPTR', callback, resolverHandle); }
  function resolveSoa(hostname, options, callback, resolverHandle) {
    if (typeof options === 'function') {
      resolverHandle = resolverHandle ?? callback;
      callback = options;
      options = undefined;
    }
    return queryRecords(hostname, 'SOA', callback, resolverHandle, options);
  }

  function queryPromise(hostname, type, resolverHandle, options) {
    validateResolverName(hostname);
    return new Promise((resolveValue, reject) => {
      queryRecords(hostname, type, (error, value) => error ? reject(error) : resolveValue(value), resolverHandle, options);
    });
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
      if (hostname && hostname !== false) validateLookupHostname(hostname);
      return new Promise((resolve, reject) => lookup(hostname, lookupOptions, (error, address, family) => {
        if (error) reject(error);
        else resolve(lookupOptions.all ? address : { address, family });
      }));
    },
    resolve4(hostname, options) {
      return new Promise((resolve, reject) => resolveFamily(hostname, 4, options, (error, values) => error ? reject(error) : resolve(values)));
    },
    resolve6(hostname, options) {
      return new Promise((resolve, reject) => resolveFamily(hostname, 6, options, (error, values) => error ? reject(error) : resolve(values)));
    },
    reverse(address) {
      if (proxyIsActive(proxy) && !hasLocalRecord(customRecords, String(address))) {
        return new Promise((resolve, reject) => reverse(address, (error, names) => error ? reject(error) : resolve(names)));
      }
      return promiseFor(() => new Promise((resolve, reject) => reverse(address, (error, names) => error ? reject(error) : resolve(names))), synchronous);
    },
    resolve(hostname, rrtype = 'A') {
      const type = rrtype;
      if (typeof type !== 'string') {
        throw invalidArgumentError(
          `The "rrtype" argument must be of type string. Received ${describeReceived(type)}`,
          'ERR_INVALID_ARG_TYPE',
        );
      }
      if (!RESOLVE_TYPES.includes(type)) {
        throw invalidArgumentError(`The argument 'rrtype' is invalid. Received '${type}'`, 'ERR_INVALID_ARG_VALUE');
      }
      validateResolverName(hostname);
      if (RESOLVER_TYPES[type]) return queryPromise(hostname, type);
      return new Promise((resolveValue, reject) => resolve(hostname, type, (error, value) => error ? reject(error) : resolveValue(value)));
    },
    resolve4(hostname, options) {
      return new Promise((resolve, reject) => resolveFamily(hostname, 4, options, (error, values) => error ? reject(error) : resolve(values)));
    },
    resolve6(hostname, options) {
      return new Promise((resolve, reject) => resolveFamily(hostname, 6, options, (error, values) => error ? reject(error) : resolve(values)));
    },
    resolveAny(hostname) { return new Promise((resolveValue, reject) => resolveAny(hostname, (error, value) => error ? reject(error) : resolveValue(value))); },
    resolveTxt(hostname) { return new Promise((resolveValue, reject) => resolveTxt(hostname, (error, value) => error ? reject(error) : resolveValue(value))); },
    resolveCaa(hostname, options) { return queryPromise(hostname, 'CAA', undefined, options); },
    resolveCname(hostname, options) { return queryPromise(hostname, 'CNAME', undefined, options); },
    resolveMx(hostname) { return queryPromise(hostname, 'MX'); },
    resolveNs(hostname) { return queryPromise(hostname, 'NS'); },
    resolveTlsa(hostname, options) { return queryPromise(hostname, 'TLSA', undefined, options); },
    resolveSrv(hostname, options) { return queryPromise(hostname, 'SRV', undefined, options); },
    resolvePtr(hostname) { return queryPromise(hostname, 'PTR'); },
    resolveNaptr(hostname) { return queryPromise(hostname, 'NAPTR'); },
    resolveSoa(hostname) { return queryPromise(hostname, 'SOA'); },
    lookupService(address, port) {
      if (arguments.length < 2) {
        throw invalidArgumentError('The "address" and "port" arguments must be specified', 'ERR_MISSING_ARGS');
      }
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
    getDefaultResultOrder,
    getServers,
    setDefaultResultOrder,
    setServers,
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
      this._servers = validateDnsServers(values);
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
    resolve(hostname, rrtype, callback) { return resolve(hostname, rrtype, callback, this._handle); }
    resolve4(...args) { return resolveFamily(args[0], 4, args[1], args[2]); }
    resolve6(...args) { return resolveFamily(args[0], 6, args[1], args[2]); }
    resolveAny(...args) { return resolveAny(...args); }
    resolveTxt(...args) { return resolveTxt(...args); }
    resolveCaa(hostname, callback) {
      const options = arguments.length > 2 ? callback : undefined;
      const actualCallback = arguments.length > 2 ? arguments[2] : callback;
      return queryRecords(hostname, 'CAA', actualCallback, this._handle, options);
    }
    resolveCname(hostname, callback) {
      const options = arguments.length > 2 ? callback : undefined;
      const actualCallback = arguments.length > 2 ? arguments[2] : callback;
      return queryRecords(hostname, 'CNAME', actualCallback, this._handle, options);
    }
    resolveMx(...args) { return resolveMx(...args, this._handle); }
    resolveNs(...args) { return resolveNs(...args, this._handle); }
    resolveTlsa(hostname, callback) {
      const options = arguments.length > 2 ? callback : undefined;
      const actualCallback = arguments.length > 2 ? arguments[2] : callback;
      return queryRecords(hostname, 'TLSA', actualCallback, this._handle, options);
    }
    resolveSrv(hostname, callback) {
      const options = arguments.length > 2 ? callback : undefined;
      const actualCallback = arguments.length > 2 ? arguments[2] : callback;
      return queryRecords(hostname, 'SRV', actualCallback, this._handle, options);
    }
    resolvePtr(...args) { return resolvePtr(...args, this._handle); }
    resolveNaptr(...args) { return resolveNaptr(...args, this._handle); }
    resolveSoa(hostname, options, callback) {
      return resolveSoa(hostname, options, callback, this._handle);
    }
    reverse(...args) { return reverse(...args); }
    lookupService(...args) { return lookupService(...args); }
  }

  class PromisesResolver extends Resolver {
    lookup(hostname, options) { return promises.lookup(hostname, options); }
    resolve(hostname, rrtype) {
      const type = rrtype === undefined ? 'A' : rrtype;
      if (typeof type !== 'string') {
        throw invalidArgumentError(
          `The "rrtype" argument must be of type string. Received ${describeReceived(type)}`,
          'ERR_INVALID_ARG_TYPE',
        );
      }
      if (!RESOLVE_TYPES.includes(type)) {
        throw invalidArgumentError(`The argument 'rrtype' is invalid. Received '${type}'`, 'ERR_INVALID_ARG_VALUE');
      }
      validateResolverName(hostname);
      if (RESOLVER_TYPES[type]) return queryPromise(hostname, type, this._handle);
      return new Promise((resolveValue, reject) => resolve(hostname, type, (error, value) => error ? reject(error) : resolveValue(value), this._handle));
    }
    resolve4(hostname, options) { return promises.resolve4(hostname, options); }
    resolve6(hostname, options) { return promises.resolve6(hostname, options); }
    resolveAny(hostname) { return promises.resolveAny(hostname); }
    resolveTxt(hostname) { return promises.resolveTxt(hostname); }
    resolveCaa(hostname, options) { return queryPromise(hostname, 'CAA', this._handle, options); }
    resolveCname(hostname, options) { return queryPromise(hostname, 'CNAME', this._handle, options); }
    resolveMx(hostname) { return queryPromise(hostname, 'MX', this._handle); }
    resolveNs(hostname) { return queryPromise(hostname, 'NS', this._handle); }
    resolveTlsa(hostname, options) { return queryPromise(hostname, 'TLSA', this._handle, options); }
    resolveSrv(hostname, options) { return queryPromise(hostname, 'SRV', this._handle, options); }
    resolvePtr(hostname) { return queryPromise(hostname, 'PTR', this._handle); }
    resolveNaptr(hostname) { return queryPromise(hostname, 'NAPTR', this._handle); }
    resolveSoa(hostname) { return queryPromise(hostname, 'SOA', this._handle); }
    reverse(address) { return promises.reverse(address); }
    lookupService(address, port) { return promises.lookupService(address, port); }
  }
  promises.Resolver = PromisesResolver;

  return {
    lookup,
    lookupService,
    resolve4: (hostname, options, callback) => resolveFamily(hostname, 4, options, callback),
    resolve6: (hostname, options, callback) => resolveFamily(hostname, 6, options, callback),
    reverse,
    resolve,
    resolveAny,
    resolveTxt,
    resolveCaa,
    resolveCname,
    resolveMx,
    resolveNs,
    resolveTlsa,
    resolveSrv,
    resolvePtr,
    resolveNaptr,
    resolveSoa,
    Resolver,
    getServers,
    setServers,
    getDefaultResultOrder,
    setDefaultResultOrder,
    ...DNS_HINTS,
    ...DNS_ERROR_CODES,
    promises,
  };
}
