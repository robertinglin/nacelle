export function createCitgmProcessArgv(entry, module, args = []) {
  if (typeof entry !== 'string' || !entry) throw new TypeError('CITGM entry must be a non-empty string');
  if (typeof module !== 'string' || !module) throw new TypeError('CITGM module must be a non-empty string');
  if (!Array.isArray(args)) throw new TypeError('CITGM arguments must be an array');
  return ['node', entry, module, ...args];
}
