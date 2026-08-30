const records = [
  {
    id: 'v22',
    major: 22,
    nodeRef: 'v22.x',
    referenceVersion: '22.23.2',
    status: 'maintenance-lts',
    maturity: 'alpha',
    codename: 'Jod',
    endOfLife: '2027-04-30',
    npmTag: 'n22',
    wasmDirectory: 'src/wasm/v22',
  },
];

export const NODE_VERSION_ALIASES = Object.freeze({
  latest: 'v22',
  lts: 'v22',
});

export const NODE_VERSION_RECORDS = Object.freeze(records.map((record) => Object.freeze({ ...record })));

function requestedMajor(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const text = String(value ?? 'lts').trim().toLowerCase();
  const alias = NODE_VERSION_ALIASES[text];
  if (alias) return Number(alias.slice(1));
  const match = text.match(/^(?:node@?|n|v)?(\d+)(?:\..*)?$/);
  return match ? Number(match[1]) : null;
}

function unsupportedVersion(value) {
  const supported = NODE_VERSION_RECORDS.map((record) => record.id).join(', ');
  const aliases = Object.keys(NODE_VERSION_ALIASES).join(', ');
  const error = new RangeError(`Unsupported Node.js target ${JSON.stringify(value)}; supported targets are ${supported}, ${aliases}`);
  error.code = 'ERR_NACELLE_UNSUPPORTED_NODE_VERSION';
  error.requested = value;
  error.supported = NODE_VERSION_RECORDS.map((record) => record.id);
  return error;
}

export function resolveNodeVersionRecord(value = 'lts') {
  const major = requestedMajor(value);
  const record = NODE_VERSION_RECORDS.find((candidate) => candidate.major === major);
  if (!record) throw unsupportedVersion(value);
  return record;
}

export function listSupportedNodeVersions() {
  return NODE_VERSION_RECORDS;
}

export function nodeVersionAliases() {
  return NODE_VERSION_ALIASES;
}
